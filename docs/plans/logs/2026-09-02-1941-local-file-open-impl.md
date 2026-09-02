review session: de34c71c-3746-4dd3-81eb-a93e1139517b

## 1回目

````text
レビュー完了。差分（src / scripts / docs / test-pages）と plan の各ステップを突き合わせた。typecheck / test はサンドボックスで実行できなかったため、静的読みと plan のログ記載の結果に依っている。

## P0
- `src/main/suggest.ts:buildSuggestions`（plan 決定表「アドレスバー / コマンドバー入力（`nemo:navigate` / Toolbar の `createTab`）→ 許可」/ Phase 2 > `resolveInput` のステップ）— コマンドバー（⌘T / ⌘L の Overlay）だけ `file:` 解禁が入っていない。`normalizeNavigationInput(query, template)` を `allowFile` 無しで呼び、パス → `file://` の変換も通らないので、⌘L に `/private/tmp/x.html` を打つと Google 検索、`file:///…` を打つと「そのまま実行」行自体が出ずに無言で何も起きない（Overlay は `item.target.url` しか送らないので `resolveInput` の変換に届かない）/ ⌘L は URL を打つ主導線で、決定表が明示的に「許可」と決めた経路。しかも今回の差分で `docs/operations.md` に「アドレスバー / コマンドバーの入力」は通ると書いてしまったので、ドキュメントが実装と食い違っている / `ipc.ts` の `localPathToFileUrl` を main 側の共有ヘルパに出し、`suggest.ts` でも「パス → `file://` 変換 → `normalizeNavigationInput(..., { allowFile: true })`」を通す。行の `target.url` は `file://` になり、`nemo:navigate` 側の `resolveInput`（`allowFile: true`）がそのまま受ける

## P1
- `src/main/registry.ts:attachTabEvents`（`page-title-updated` / `page-favicon-updated`。plan Phase 2 > `registry.ts` の共通ガード）— ガードが `tab.ephemeralId` の枝にしか掛かっておらず、ピン / Favorites を持つタブ（`definitionId` の枝）はそのまま。`setPinnedTitle` に URL の検査が無いので、ピン留めタブのアドレスバーにローカルパスを打つと `pins.json` の題名がローカル HTML の題名に書き換わり、URL は http のまま残る / plan が一時タブ定義について挙げた「ローカルファイルの題名 ＋ 古い http の URL」と同じ状態で、しかも `pins.json` は永続なので再起動しても戻らない（favicon は `setFaviconForDefinition` の host 照合で偶然防がれている） / `canSyncEphemeralFromPage` を `canSyncDefinitionFromPage` に一般化し、`if (definitionId) setPinnedTitle(...)` にも同じ条件を掛ける
- `src/main/ipc.ts`（`nemo:create-tab` ハンドラ）— `allowFile: raw !== null` は常に true。`optionalString` は `null` を返さず `string | undefined` なので、この条件は一度も false にならない / 直前のコメントが謳う「`resolveInput` を通った URL だけが `file:` になりうる」という不変条件がコードとして成立しておらず、将来 `resolveInput` を経ない URL をここへ渡す変更が入っても型でも実行時でも止まらない（今は `raw` が偽値なら `BLANK_URL` なので実害は無い） / `allowFile: Boolean(raw)`（＝ `resolveInput` を実際に通したときだけ）にする
- `src/main/registry.ts:NemoTab.materialize` — `allowFile: true` の根拠コメントが「`this.url` / `pendingUrl` への代入は宣言・`materialize` の後始末・`sleep` の 3 箇所だけ」と書いているが、実際には `attachTabEvents` の `syncUrl`（`wc.getURL()` を `tab.url` に書く）という 4 つ目の代入元がある / このコメントが「file: がここに来ても安全」の唯一の監査記録なので、事実と違うまま残すと次に監査する人が代入元を見落とす（現状はページ由来の遷移が `will-navigate` / `will-redirect` / `setWindowOpenHandler` で塞がれているので結論は変わらない） / 「ページ由来の URL は `syncUrl` から入るが、それらは遷移ゲートを通った後の値」と書き直す
- `scripts/verify-local-file.mjs`（アドレスバーの拒否表示のブロック。plan Phase 4 > 「拒否された入力で入力欄に文字列が残る」）— toolbar の target をウィンドウで固定していない。直前の一時タブ定義のブロックで 2 枚目のウィンドウを開き、`uiB.close()` は CDP セッションを切るだけでウィンドウは残るため、`connectUi(CDP, 'toolbar', { exclude: 'pane=right' })` は `/json/list` の並び次第でウィンドウ B のツールバーを掴む。掴んだ場合でも赤枠は出るので PASS し、続く「拒否された入力でタブは遷移していない」はウィンドウ A の触っていないタブを見るだけで自明に PASS する / 実装を壊しても落ちない検査になりうる / `tabOf(ui, key)` の `windowId` を使って `urlPart: 'view=toolbar&window=<A>'` で選ぶか、この節を 2 枚目のウィンドウを開く前に移す

## P2
- `src/main/registry.ts:canSyncEphemeralFromPage` — 新関数を `syncEphemeralDefinition` の JSDoc と関数本体の間に挿入したため、既存の JSDoc（「ナビゲーション時の定義との同期」）が宙に浮いて新関数の直前に並んでいる / エディタのホバーと読み下しで対応が崩れる / 既存 JSDoc は `syncEphemeralDefinition` の直上へ戻す
- `src/renderer/components/Toolbar.tsx:Toolbar` — `rejectedTimer` を unmount で `clearTimeout` していない / タブ切り替えなどで Toolbar が消えた後にタイマーが残る（React 18 では警告も実害も無いが、他のタイマーの扱いと不揃い） / `useEffect(() => () => clearTimeout(...), [])` を足す
- `src/renderer/components/Toolbar.tsx:policyRejection` — `export` しているが import 元が無い / テストのための export に見えて、そのテストが無い / モジュール内に閉じるか、`scripts/` に 1 ケース足す
- `scripts/verify-phase1.mjs` / `scripts/verify-spike.mjs`（plan Phase 2 > 既存検査の書き換え）— 「人間の入力からは通る（URL が `file:` になる）」側を書き足さず、拒否リストから `file:` を消しただけ / 通る側の固定は `local-file` に一本化されており、`local-file` を回さない絞り込み実行では誰も見ない / どちらかに 1 行「アドレスバーからの `file:` は URL が `file:` になる」を足すか、コメントで「通る側は `local-file` 専任」と明記する
- `scripts/verify-local-file.mjs`（`open-file` のブロック）— LaunchServices が起動中インスタンスへ配送せず新規起動した場合、その Electron は `NEMO_USER_DATA_DIR` を持たず既定の `Nemo-dev` プロファイルで動き、`spawned` に入らないので `stopChildren` でも止まらない（検査は SKIP に落ちるので気づけない） / 後続スイートに余計なインスタンスが残る / SKIP に落ちる直前に `pkill -f 'Electron.app'` 相当ではなく、`listTargets` に自分の CDP ポート以外の生存が無いかを確認するか、SKIP メッセージに「残っていないか確認する」旨を書く

## Q
- `src/renderer/components/Toolbar.tsx`（拒否時の `title`）— 理由を内部識別子のまま（`開けない入力です（scheme_not_allowed:javascript:）`）出すか、ユーザー向けの日本語（「このアドレスは開けません」等）に落として識別子はログだけに残すかが未決 / 決めないと、ユーザーに出る唯一の説明文が実装内部の文字列のままリリースされる（`verify-local-file.mjs` の検査も `.rejected` クラスと入力値しか見ていないので、文言を変えても検査は追随しない）

````

**対応**:
- P0 `suggest.ts`: `localPathToFileUrl` を `src/main/local-path.ts` に切り出し、`suggest.ts` の「そのまま実行」行でもパス → `file://` 変換と `normalizeNavigationInput(..., { allowFile: true })` を通すようにした。plan の決定表にも `suggest.ts` を明記
- P1 pins のガード: `canSyncEphemeralFromPage` を `canSyncDefinitionFromPage` に一般化し、`page-title-updated` / `page-favicon-updated` で `file:` タブなら `setPinnedTitle` / `setFaviconForDefinition` にも書かないようにした（plan ログ > 方針変更に記録）
- P1 `nemo:create-tab`: `allowFile: Boolean(raw)` に修正
- P1 `materialize` のコメント: `syncUrl` からの代入系統を追記して事実に合わせた
- P1 `verify-local-file.mjs`: ツールバーの target を `view=toolbar&window=<A の windowId>` で名指しに変更
- P2 JSDoc の位置を `syncEphemeralDefinition` の直上へ戻した
- P2 Toolbar: unmount で `clearTimeout` する `useEffect` を足した / `policyRejection` の `export` を外した
- P2 verify-phase1 のコメントに「通る側は `local-file` 専任」を明記
- P2 open-file の SKIP 文言に「別の Electron が新規起動していないか確認する」を追記（検査の追加は見送り。SKIP に落ちた実績が無く、増やすと次の P0 の種になる）
- Q（title の文言）: ユーザー向けの日本語に決定。`rejectionMessage()` で `scheme_not_allowed:<scheme>` → 「このアドレスは開けません（<scheme> で始まるアドレスは開けない種類です）」、それ以外は「この入力は開けません」。識別子は main の `navigation.blocked` ログに残る。根拠: plan Phase 3「赤枠＋ title で理由を出す」はユーザー向け表示の意図で、内部識別子を見せる決定は無い。反映先: Toolbar.tsx と plan ログ > 方針変更

## 2回目

````text
前回の指摘 6 件はすべて反映を確認した（`local-path.ts` への切り出しと `suggest.ts` の配線、`canSyncDefinitionFromPage` の pins 側への拡張、`Boolean(raw)`、`materialize` のコメント、toolbar target の名指し、JSDoc 位置、`clearTimeout` の `useEffect`、`policyRejection` の非 export、`rejectionMessage`）。今回の差分で新たに見えたものだけ挙げる。

## P0

## P1
- `scripts/verify-local-file.mjs`（plan Phase 4 > 自走検証の検査項目 / 決定表「⌘L の候補「そのまま実行」行 `suggest.ts`」）— 今回追加した コマンドバー経路（`suggest.ts`）を見る検査が 1 件も無い。suite は `window.nemo.navigate` / `createTab`（＝ `resolveInput`）だけを撃っており、`suggest` は呼んでいない。`VERIFY.md` の対応表の行も「アドレスバーのパス入力」までしか書いていない一方、`docs/operations.md` には「アドレスバー / コマンドバーの入力」は通ると書いた / 前回の P0 は「決定表にあるのに実装が無く、検査も無いので誰も気づかない」経路そのものだった。同じ形の穴が、今度は実装済み・検査無しで残る（`suggest.ts` の `allowFile` を落としても全 21 件 PASS する） / `window.nemo.suggest` は preload に出ていて他スイート（`verify-phase1` / `verify-pins`）も使っているので、アドレスバーの節の隣に 3 件足す: 絶対パス → 先頭行の `target.url` が `file://`、`file:///…` → 行が出て `kind === 'url'`、`/no/such/path` → 検索行のまま。`VERIFY.md` の「21 件」と対応表の説明（コマンドバー）も一緒に更新する

## P2
- `src/renderer/components/Toolbar.tsx:submit` — アドレスバーを空にして Enter を押すと `resolveInput` が `empty` で投げ、「この入力は開けません」の赤枠が出る（`rejectionMessage` の既定文言に落ちる） / Chrome を含む既存ブラウザは何もしないので、拒否表示の初出がこの誤爆になりうる。plan が赤枠の対象にしたのは「開けない scheme を打った」ケース / `if (!input.trim()) { setDraft(null); return }` で先に抜けるか、`reason === 'empty'` を赤枠の対象から外す
- `scripts/verify-local-file.mjs`（拒否表示の check）— check 名は「赤枠（.rejected）と理由の title が付く」だが、`title` は snapshot に出すだけで PASS 条件に入っていない（見ているのは `.rejected` と入力値だけ） / 今回「文言はユーザー向け日本語、識別子はログだけ」と決めた（plan ログ > 方針変更）のに、`title` を内部識別子に戻しても検査は緑のまま / `title` が `scheme_not_allowed` を含まないこと（あるいは「開けません」を含むこと）を条件に足す
- `src/main/local-path.ts:localPathToFileUrl` — `suggest` 経由で**キーストロークごとに** `existsSync`（main プロセスの同期 stat）が走るようになった。`/` `~` 始まりの入力に限られ 1 回の stat なので今は無視できるが、ネットワークボリューム上のパスを打つと UI スレッドが待つ / 気になったときは直近の入力 1 件ぶんをメモ化するか、`suggest` 側だけ変換を諦める

## Q

````

**対応**: P0 なしで収束。採用した P1/P2（未レビュー）:
- P1 `verify-local-file.mjs` にコマンドバー（`window.nemo.suggest`）の検査 3 件を追加（絶対パス → `target.url` が `file://` / `file:///…` → `kind === 'url'` / 実在しないパス → 検索行）。VERIFY.md の件数を 25 件に更新
- P2 Toolbar の `submit`: 空のまま Enter は何もしない（`empty` を赤枠にしない）
- P2 拒否表示の検査に「title がユーザー向け文言で `scheme_not_allowed` を含まない」を条件として追加
- P2 `localPathToFileUrl` のキーストロークごとの `existsSync` は見送り（`/` `~` 始まりに限られ 1 回の stat。実測で問題が出てから）
- 動作確認（収束後）: `mise run verify:only local-file` 25 件すべて PASS / `mise run verify:only pins restart` すべて PASS / typecheck・lint・test 通過。別セッションの dev Nemo（pid 37994）で一度ハーネスが止まったが、ユーザーの了承後に確認したら既に終了していた
