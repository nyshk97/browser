review session: 2b6a4207-d68f-451d-bc94-de69e060584b

## 1回目

````text
プランと差分を読み、`extensions.ts` / `devtools-shim.ts` / preload / 検証スクリプトを突き合わせました。ビルド成果物（`out/preload/extension-shim.cjs`）も確認しています（typecheck / lint / verify はサンドボックスで実行できず未実行）。

## P0
- `scripts/verify-packaged.mjs:checkExtensionShim`（Phase 2 > ステップ 4） — `readLogLines()` は**パース済みオブジェクトではなく生の文字列行**を返す（`scripts/lib/harness.mjs:readLogLines`、同ファイルの `countLogEvents` も `line.includes(...)` で使っている）。`line.event === 'extension.shim_registered'` は常に false なので `events.length > 0` が成立せず、**同梱されていても必ず FAIL する**（`mise run verify:packaged` が 2 か所で落ちる）。同ファイル `:224` の `timings.resolved` と同じく `.filter((line) => line.includes('"event":"extension.shim_registered"'))` してから `JSON.parse` し、`exists === true` を見る形にする

## P1
- `src/main/devtools-shim.ts:attachDevToolsExtensionShim`（Phase 2 > ステップ 4） — `Target.setAutoAttach` で付いた**全**子 target に `Page.enable` を送っている。DevTools フロントエンドは worker target（formatter / heap snapshot など）を作り、そこでは Page ドメインが無いので reject → `devtools.shim_inject_failed` が logError で積まれる / スタブが要るのは拡張の frame だけなのに、DevTools を開くたびに error ログが増えて本物の障害を埋め、`waitForDebuggerOnStart: true` で無関係な target も一瞬止める / `Target.attachedToTarget` の `targetInfo.type` を見て `page` / `iframe` 以外は注入せず即 `Runtime.runIfWaitingForDebugger` で再開する
- `src/main/extensions.ts:setExtensionEnabled`（Phase 1 > ステップ 2） — `const current = getLoadedExtensions()` を **await の前**に取り、await 後にその配列を書き換えて `publish` している。設定画面のトグルは行ごとに `busy` なので、別々の拡張を続けて切り替えると 2 本目が 1 本目より後に publish して**1 本目の結果を消す** / `settings.json` は各呼び出しで読み直すので正しいが、メモリ上の一覧と `setLoadedExtensionIds`（allowlist）だけが再起動までズレる。ロード済みなのに allowlist から外れる／外したのに allowlist に残る、という状態になる / publish 直前に lock + `getSettings().extensions.disabled` + `session.extensions.getAllExtensions()` から一覧を組み立て直すか、トグル全体を 1 本の promise チェーンで直列化する
- `src/main/extensions.ts:loadLockedExtensions`（Phase 1 > ステップ 2） — doc コメントは「戻り値は **lock の全エントリ**」と書いているが、`loadLockedEntry` が null を返す行（treeSha256 不一致・artifact 欠落・id/version 不一致）は一覧から落ちる / ON なのにロードに失敗した拡張は設定画面に行ごと消え、ユーザーからは lock に無いのと区別が付かず、OFF→ON の「再起動ボタン」で復帰させる導線も無い（`extensions.length === 0` のとき「lock にある Chrome 拡張はありません」と嘘を出す経路もここ） / 失敗した行も `enabled: true, matchesLock: false, optionsUrl: null` で一覧に残し、Settings の既存の「lock 不一致」表示に載せる
- `scripts/verify-ext-smoke.mjs`（Phase 1 > ステップ 5、「OFF 中の chrome-extension:// ナビゲーションが拒否される」） — 「OFF の間は『設定を開く』で拡張ページが開かない」の検査は、`src/main/ipc.ts` の `nemo:open-extension-options` が `optionsUrl` が null の時点で return するので通る。**`setLoadedExtensionIds` を更新し忘れても緑になる**（allowlist を一度も通らない） / この plan で新しく生えた「OFF なら allowlist から外れる」保証に対する回帰検知がゼロ / OFF の前に控えておいた options URL を `window.nemo.createTab(url)` に渡し、`registry.ts` の `createTab`（`allowExtensionPages: isLoadedExtensionUrl(url)`）が BLANK に倒すこと＝拡張 target が増えないことを見る

## P2
- `src/shared/chrome-debugger-stub.js:installChromeDebuggerStub` — `webRequest` の `addListener` 差し替えが素の代入・`defineProperty` で、ネイティブ束縛が書き換え不可だった場合に例外で関数ごと中断する（`chrome.debugger` は先に入るので実害は小さいが、CDP 経路では例外が握り潰されて原因が残らない）。この節だけ try/catch で囲み、失敗を DOM でなくコンソールに残す
- `src/shared/chrome-debugger-stub.js` / `src/main/devtools-shim.ts:attachDevToolsExtensionShim` — ファイル名・関数名・ログ名（`chrome-debugger-stub` / `installChromeDebuggerStub` / `devtools.shim_*`）が `chrome.debugger` 専用に見えるのに、実体は `webRequest` の filter 補正も含む。`chrome-api-shim` 系に寄せると compat.md の記述とも揃う
- `docs/compat.md` — 動かない API の表に 2 行足したが、冒頭の「検証日: 2026-08-23」は据え置き。今回の実測（2026-08-29 / 08-30）が読み手から見えない
- `src/renderer/components/Settings.tsx:Settings` — 「ON/OFF はこの端末だけに効きます…」の注記が、拡張 0 件のときも出る。一覧がある分岐に入れる
- `src/renderer/components/Settings.tsx:ExtensionRow` — `ipcMain.handle` が投げた例外はレンダラー側で `Error invoking remote method 'nemo:set-extension-enabled': …` になる。行に出す前に prefix を落とすか、main 側で理由コードを返す
- `src/main/devtools-shim.ts:attachDevToolsExtensionShim` — `log('devtools.shim_injected', {})` が target ごとに出て detail が空。target 数か type を載せないと、届いたのか届いていないのかログから判断できない

## Q
- `src/shared/chrome-debugger-stub.js:installChromeDebuggerStub`（`webRequest` の tabId 除去の適用範囲） — この補正は `chrome-extension://` の**全ページ・全拡張**に効く。`chrome.debugger` スタブを全拡張に配るのは 1 回目のレビューで決定済みだが、`webRequest` の filter を書き換える方は実装中に出てきたもので範囲を決めていない。Bitwarden / Keepa が `{ tabId }` で絞って登録した listener も全タブぶんを受け取るようになる（host_permissions の範囲内ではあるが、拡張が「このタブだけ」と思って書いた処理が別タブのリクエストで走る） / 決めないと compat.md の「Nemo のスタブが tabId を外している」という説明の射程と、今後 lock に拡張を足したときの調査範囲が定まらない

````

**対応**:
- P0 verify-packaged: `readLogLines` の文字列行を `includes` で絞って `JSON.parse` する形に修正
- P1 devtools-shim: `targetInfo.type` が page / iframe 以外は注入せず即再開。ログに target type を載せる
- P1 setExtensionEnabled: promise チェーンで直列化（`toggleExtension` に分離）。ロード失敗行は `session.extensions.getExtension` を見て再ロードできるように
- P1 loadLockedExtensions: ロード失敗行を `enabled: true, matchesLock: false, optionsUrl: null` で一覧に残す（plan の決めたことに追記）
- P1 smoke の allowlist 回帰検知（OFF 中の options URL を createTab に渡して拡張 target が増えないことを見る）: 検査の追加なのでループ中は見送り、終了報告へ
- P2: webRequest 補完を try/catch で囲む / Settings の注記を一覧がある分岐へ / エラー文言の prefix を落とす / compat.md の検証日 / shim_injected に target type、いずれも反映
- P2 ファイル名・関数名の改名（chrome-api-shim 系）: 参照箇所が多く差分が膨らむので見送り（終了報告へ）
- Q webRequest の tabId 除去の範囲: 全 `chrome-extension://` ページ（SW には配らない）と決定。根拠: Bitwarden / Keepa の展開ツリーを grep し `{ tabId }` 付き listener が無い（Bitwarden の webRequest は background のみ）。plan の「決めたこと」に追記

## 2回目

````text
プランの「決めたこと」追記と、`extensions.ts` / `devtools-shim.ts` / `verify-packaged.mjs` / `Settings.tsx` / `chrome-debugger-stub.js` の現状を読み直しました。前回の P0（`readLogLines` の扱い）と P1 3 件・P2 5 件は直っています。ロード失敗行を一覧に残した副作用が 1 つ残っています。

## P0
- `src/main/extensions.ts:publish` / `src/main/extension-state.ts:getEnabledExtensions`（Phase 1 > ステップ 2） — ロード失敗行が `failedInfo` で `enabled: true` になったのに、allowlist と起動ステータスの件数は `enabled` だけで絞り続けている。結果、**一度もロードしていない拡張 ID が `setLoadedExtensionIds` に入り**、`AppStatus.extensions`（`app-status.ts` のコメントは「ロードできた拡張の数」）も失敗分を数える / `publish` 自身のコメント「実際にロードできたものだけに絞る」・`security.ts` の `loadedExtensionIds`「ロード済み拡張の ID」・plan Phase 1 > ステップ 2 の「allowlist の性質を崩さない」がいずれも成り立たなくなる。treeSha256 が合わなかった（＝改竄を検知した）artifact の ID まで `isLoadedExtensionUrl` が true を返す（実体が無いのでページは出ないが、判定を信じている `registry.ts` の `createTab` / `security.ts` の `allowExtensionPages` の前提が崩れる）。起動ステータスは「N 件ロード済み」と嘘を出す / ロード成功 ⇔ `enabled && matchesLock` なので、`publish` の filter と `getEnabledExtensions` を `enabled && matchesLock` にする（あるいは `LoadedExtensionInfo` に `loaded: boolean` を足して allowlist・件数はそれで絞り、`enabled` は「この端末で ON にしているか」だけの意味に保つ）

## P1
- `scripts/verify-ext-smoke.mjs`（「1. ロード」の検査、Phase 1 > ステップ 5） — `failedInfo` が lock の `id` / `version` をそのまま載せるようになったので、`loaded.length === 1 && loaded[0].id === expected.id && loaded[0].version === expected.version` は**拡張が 1 つもロードできていなくても通る** / 「lock どおりの ID / version でロードされる」という CI の一次防波堤が、今回の変更で意味を失った（実際の検知は次行の `optionsUrl` 検査に暗黙で依存している） / 条件に `loaded[0].enabled && loaded[0].matchesLock`（P0 で `loaded` を足すならそれ）を加える

## P2
- `src/shared/types.ts:LoadedExtensionInfo` — `enabled` / `matchesLock` の 2 つで「ロード済み」「OFF」「ON だがロード失敗」の 3 状態を表すようになったが、型のコメントは「OFF の行は照合していないので常に true」しか書いていない。失敗行の意味（`enabled: true` + `matchesLock: false` + `optionsUrl: null`）を型側にも 1 行足すと、次に読む人が allowlist の絞り方を間違えない
- `src/main/devtools-shim.ts:attachDevToolsExtensionShim` — 先頭コメントは「URL では絞れないので**全 target** に入れ、スタブ側で `location.protocol` を見る」のままだが、実装は `targetInfo.type` が page / iframe のときだけ注入する。「frame 以外は即再開する」ことをコメントにも反映させる

## Q

````

**対応**:
- P0 publish / getEnabledExtensions: allowlist と起動ステータスの件数を `enabled && matchesLock` で絞る（`getLoadedOkExtensions` に改名）
- P1 smoke「lock どおりの ID / version でロードされる」: `enabled && matchesLock` まで条件に加えた
- P2 types.ts の `matchesLock` コメント / devtools-shim の先頭コメント: いずれも反映

## 3回目

````text
前回の 3 点（`publish` / `getLoadedOkExtensions` の絞り込み、smoke のロード判定、型と devtools-shim のコメント）はいずれも入っており、`getEnabledExtensions` への参照は `index.ts` から消えています（コード上の残存参照なし）。残るのはコメントの追随漏れだけです。

## P0

## P1

## P2
- `src/main/extensions.ts:loadLockedExtensions`（Phase 1 > ステップ 2） — 関数の doc コメントが「allowlist と起動ステータスの件数には **ON のものだけ**を流す（`extension-state.ts` の `getEnabledExtensions`）」のまま。実際は `enabled && matchesLock`（ロードできたものだけ）で絞っており、`getEnabledExtensions` という関数はもう存在しない（`getLoadedOkExtensions` に改名済み） / 唯一の残存参照が実在しない symbol なので、grep で辿った次の読み手が「ON なら allowlist に入る」と誤読する。ちょうど今回直した不整合そのものを再生産しかねない / 「ON かつロードできたものだけを流す（`getLoadedOkExtensions` / `publish`）」に直す
- `src/main/index.ts`（拡張ロード直後の `extensionCount` 代入部） — 同じく「起動ステータスの件数は ON のものだけ（OFF は一覧に載るがロードしていない）」というコメントが残っている。実際に数えているのは `getLoadedOkExtensions()`（ロード失敗行は除外）/ コメントと呼び出しが食い違い、`AppStatus.extensions`（「ロードできた拡張の数」）の意味が読み取りにくい / 「ロードできたものだけ（OFF もロード失敗も含めない）」に直す

## Q

````

**対応**: 収束（P0 なし）。反映した P2: `loadLockedExtensions` の doc コメントと `index.ts` の extensionCount のコメントを実装（`enabled && matchesLock` / `getLoadedOkExtensions`）に合わせた
