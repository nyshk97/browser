review session: 923d8528-9ca9-4dae-a3b9-fefd43dc1406

## 1回目

````text
`docs/plans/2026-09-02-1812-local-file-open.md` をコードと突き合わせて確認した（`navigation-policy.js` / `open-url.ts` / `ipc.ts` / `registry.ts` / `security.ts` / `settings-schema.js` / 既存 verify スイート）。

## P0
- `Phase 4 > 5`（既存の拒否検査を回す） — `scripts/verify-phase1.mjs:211` と `scripts/verify-spike.mjs:220` が `window.nemo.navigate(key, 'file:///etc/passwd')` の **reject を PASS 条件にしている**。`resolveInput` に `allowFile: true` を入れた瞬間この 2 スイートが落ち、しかも `/etc/passwd` は実在するので spike の「拒否後も元の URL のまま」も同時に落ちる（`VERIFY.md:165 / 205 / 512` も同じ文言）/ 「既存の拒否検査を回す」だけ書いてあると、Phase 2 を書き終えた時点で赤になり原因追跡からやり直しになる / Phase 2 の中に「両スイートの `file:` ケースを『人間の入力からは通る・拡張/ページからは拒否』へ書き換え、VERIFY.md の 4 か所を直す」を明示ステップとして入れる（拒否側の代表は `javascript:` / `data:` / `nemo://ui/` に寄せる）
- `Phase 2 > 5`（`normalizeSession` のタブ URL だけ `file:` を通す） — 版 5 のセッションは**タブ URL を持たない**（`SavedWindow` は `bounds` / `activeEphemeralId` / `splits` だけ。`settings-schema.js:478`）。`normalizeSession` で file: が通るのは版 4 以前の `legacyWindows` だけで、そこを緩めると `scripts/verify-session-migration.mjs:337` と `scripts/settings-schema.test.mjs:239, 409`（「`https?:` 以外は落ちる」）を壊す / 対象ファイルが違うので、この手順は「効かない上に既存検査を壊す」変更になる / 実際の保存先は `ephemeral-tabs.json`（`src/main/store/ephemeral-tabs.ts` の `addEphemeralTab` / `updateEphemeralFromTab` が `normalizeStoredUrl` で http/https に閉じている）。ステップをそちらに差し替える（載せるかどうかは Q 参照）
- `決定表 > セッション復元・スリープ復帰` — 「セッション復元は許可」と「一時タブ定義の URL は http/https のまま」が同じ表の中で衝突している。実害は `syncEphemeralDefinition`（`registry.ts:3633`）: 既存の共有タブをアドレスバーから file: へ飛ばすと **url は弾かれるのに title だけ書き込まれる** → サイドバーの行が「ローカルファイルのタイトル ＋ 古い http の URL」になり、再起動で古いページに戻る / 実装後に静かに壊れる種類のズレで、検証項目にも無いので気づけない / 少なくとも「`normalizeStoredUrl` が弾いた patch では title / favicon も書かない、または `ephemeralId` を切り離してウィンドウローカルへ落とす」を Phase 2 に入れる

## P1
- `Phase 2 > 4`（`security.ts` の `policyForCurrentPage`） — `security.ts:57` の `NavigationPolicy` は shared の JSDoc typedef とは**別実体の TS interface**。`allowFile` / `fromFile` をここに足さないと、`accept(url, 'open-file', { allowFile: true })`（`open-url.ts` は `isNavigableUrl` を `./security.js` から取っている）も `fromFile` も typecheck で落ちる / Phase 1 は shared だけ触る建て付けなので、この 1 行が抜けると Phase 2 の頭で止まる / Phase 1 に「shared の typedef と `security.ts` の interface を同時に広げる」と書く
- `Phase 3 > 1`（拒否を Toolbar に返す） — `nemo:navigate` は `await tab.webContents?.loadURL(url)` まで待つ（`ipc.ts:440`）ので、catch で受けると **policy 拒否と `ERR_FILE_NOT_FOUND` / `ERR_ABORTED` が同じ赤枠になる** / この機能では「存在しないパスを打った」が最頻の失敗なのに、「拒否された」と区別が付かない表示になる / `resolveInput` の拒否だけ機械可読な理由（throw をやめて `{ ok: false, reason }` を返すか、`reason` を判別できる形で投げる）にして、loadURL 側の失敗は赤枠にしない
- `Phase 2 > 2`（`resolveInput` のパス変換） — `/` 始まりを無条件に `pathToFileURL` へ回すと、いま検索に流れている「`/` で始まる検索語」が全部 `ERR_FILE_NOT_FOUND` のエラーページになる / 既存挙動の劣化で、後から必ず戻す羽目になる / `fs.existsSync`（`~` 展開後）で**実在するときだけ** file: に変換し、無ければ従来どおり `normalizeNavigationInput` の検索経路へ落とす。`Phase 4 > 2` の「無ければ ERR_FILE_NOT_FOUND でも PASS」も実在パス前提に書き直せる
- `Phase 4 > 2`（http ページからの `file:` 遷移 / `window.open` の検査） — Chromium は renderer 発の http→file を renderer 内で止める（"Not allowed to load local resource"）ため、`will-navigate` にも `setWindowOpenHandler` にも到達せず `navigation.blocked` が**増えない可能性が高い** / ログ件数 +1 を必須条件にすると、実装が正しくても FAIL する検査になる / 主検査は「URL が変わっていない」「タブ・小窓が増えていない」に置き、`navigation.blocked` の有無は補助情報として記録するだけにする
- `Phase 4 > 3`（`KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS` 登録） — `verify-shared-tabs.mjs` 型（自分でアプリを起動する）にするなら `NEEDS_APP` に入れてはいけない（`verify-targets.mjs:78` が「入れると使わない共有アプリとページサーバが 1 つ余分に立つ」と明記。実際 `shared-tabs` は `NEEDS_APP` に無い）/ 登録先を誤るとフル実行が無駄に伸びるだけでなく、テストが通ってしまうので気づけない / ただし http→file の検査には共有ページサーバが要るので、「共有アプリに相乗り」か「自前起動＋自前でページサーバ」かを先に決めてから登録先を書く
- `Phase 2 > 3`（`createTab` に `allowFile` を足す） — `fillMiniWindow` は `createTab` を通らない（`new NemoTab` → `materialize()` を直接呼ぶ。`registry.ts:3227`）/ 渡す先を誤ると「小窓は動くはず」が実は materialize 側の `allowFile: true` だけで成立している、という取り違えのまま進む / `CreateTabOptions.allowFile` の唯一の呼び元は IPC の `nemo:create-tab` と書き直す（外部 URL の小窓は `materialize` の 1 か所で足りる）
- `動作確認 > 1`（Finder でダブルクリック） — `.html` の既定アプリは常用の `/Applications/Nemo.app`。ダブルクリックすると **dev 版ではなく未修正の常用 Nemo が受ける**（＝検証にならず、常用インスタンスを触ることになる）/ 手順どおりやると「直っていない」と誤判定する / 右クリック →「このアプリケーションで開く」→ dev 版、または `open -a <dev の .app> <file>` と書き換える

## P2
- `決定表 > file: ページ内のリンク` — サブフレームでは file: を拒否する方針なので、ローカル HTML の `<iframe src="./other.html">` は空になる / 実害が出るのはモック次第だが、後で「なぜか iframe だけ出ない」と悩む / CHANGELOG か `operations.md` に一行残す
- `Phase 4 > 2`（`open -a` で `open-file` を撃つ） — dev の `Electron.app` を引数無しで起動する形なので、届かなかったときは「素の Electron の welcome ウィンドウが増える」形で失敗しうる / 撃つ前後で `mini.open` のログ件数を見て判定し、増えた無関係プロセスを後始末する
- `決定表 > 履歴` — 記録しない判断は妥当だが、コマンドバーに出ないので「さっき見たローカルファイル」に戻る手段が毎回パス入力になる / 別件として plan の末尾に将来課題で 1 行残しておくと拾いやすい

## Q
- `決定表 > 一時タブ定義 / セッション復元` — file: タブを共有定義（`ephemeral-tabs.json`）に載せるか。載せない＝サイドバーにはウィンドウローカル行として出るが他ウィンドウに共有されず再起動で消える、載せる＝`normalizeStoredUrl` に file: 用の口を開けて `pins.json` 系と共通の入口を緩めることになる（`settings-schema.js:223` の意図に触れる）/ ここを決めないと `Phase 2 > 5` の差し替え先（ephemeral 側を広げるのか、弾かれたときの後始末を書くのか）が決まらず、`Phase 4` の「再起動後に file: タブがどうなっているべきか」も検査が書けない

````

**対応**:
- P0 既存検査（phase1 / spike の `file:///etc/passwd` reject、VERIFY.md 4 箇所）の書き換えを Phase 2 の明示ステップに追加
- P0 `normalizeSession` を触るステップを削除。版 5 のセッションはタブ URL を持たないため効かない。代わりに `syncEphemeralDefinition` で「URL が http/https でなければ定義に何も書かない」を Phase 2 に追加
- P0 決定表の衝突を解消: 「セッション復元」行を「スリープ復帰（materialize）は許可」と「再起動後の復元・ウィンドウ間共有は載せない」に分離
- Q（一時タブ定義に載せるか）: **載せない**と決定。根拠: 版 5 セッションはタブ URL を持たず復元は定義側が担う / `normalizeStoredUrl` は Favorites・ピンと共通の入口で `file:` を通すと 223 行の意図が崩れる / 履歴に残さない判断と揃う。決定表と「今回の範囲に入れないもの」に反映
- P1 `security.ts` の `NavigationPolicy` interface を同時に広げる旨を Phase 1 に追記
- P1 Phase 3: ポリシー拒否だけを機械可読で返し、loadURL 失敗（ERR_FILE_NOT_FOUND 等）は赤枠にしないと修正
- P1 `resolveInput`: `/` `~/` 始まりは `fs.existsSync` で実在するときだけ `file:` に変換、無ければ検索へ。決定表と Phase 4（実在しないパスは検索 URL になる検査）も修正
- P1 Phase 4: http→file の検査は「URL が変わらない / タブ・小窓が増えない」を主検査にし、`navigation.blocked` 件数は補助情報に格下げ
- P1 登録先: 自前起動＋自前ページサーバ（shared-tabs 型）にし、`NEEDS_APP` には入れないと明記
- P1 `createTab` の `allowFile` の呼び元は IPC の `nemo:create-tab` だけ、小窓は `materialize` の 1 箇所で足りると修正
- P1 動作確認: Finder ダブルクリックは常用 Nemo に届くので「このアプリケーションで開く」/ `open -a <dev .app>` に書き換え、素のダブルクリックはリリース後に
- P2 iframe が空になる旨を決定表と CHANGELOG 行に追記。履歴は「今回の範囲に入れないもの」に 1 行
- P2 見送り: `open -a` が届かなかったときの後始末（welcome ウィンドウの掃除）は実装時に決める細部なので plan に書かない

## 2回目

````text
plan を読み直し、コード（`registry.ts` / `ephemeral-tabs.ts` / `verify-all.mjs` / `verify-targets.test.mjs` / `VERIFY.md`）と突き合わせた。前回の 12 点は反映を確認。新たに 1 件の手戻り確定と、周辺の詰めが残っている。

## P0
- `Phase 2 > 3`（`syncEphemeralDefinition` で file: なら定義に書かない） — `updateEphemeralFromTab` の呼び元は 4 箇所ある（`registry.ts:750` の `page-title-updated`、`767` の `page-favicon-updated`、`3636` の `syncEphemeralDefinition`、`3772` の rename）。`syncEphemeralDefinition` だけ塞いでも、**題名と favicon は 750 / 767 から古い http 定義に書き込まれ続ける** / 決定表が潰したかった「ローカルファイルの題名 ＋ 古い http の URL の行」がそのまま残るので、Phase 2 を終えても症状が消えず、原因を探し直しになる / 「タブの現 URL が http/https でなければ一時タブ定義に何も書かない」を 750 / 767 / 3636 の共通ガードにする（`remember(...)` の中で `tab.url` を見る小さな helper に寄せるのが素直。3772 の rename も同じ経路に載る）

## P1
- `Phase 2 > 6`（既存検査の書き換え） — `VERIFY.md:172` は「**拡張から**渡された URL … `file:` は拒否 / 自分の拡張ページは許可」で、拡張経路は今回も拒否のまま。ここを書き換えると、いま守っている性質の記述が消える（`204` の「UI は `file://` を使わない」も同様に無関係）/ 直す必要のない行を触ると「どこまで緩んだのか」が文書から読めなくなる / 対象を `165` / `205` / `512` の 3 箇所に絞り、`172` は据え置きと明記する
- `Phase 4 > 3`（`verify-all.mjs` への配線） — 自前でアプリを起動するスイートは、`shared-tabs` / `migration` と同じく **`await stopAll()` を先に呼ぶ**形で配線する必要がある（`verify-all.mjs:497-512`）。特に `open -a <Electron.app>` は**バンドル単位**の配送で宛先インスタンスを選べないため、共有アプリが生きていると `open-file` がそちらに届き、検査が落ちるか他スイートの窓を増やす / 配線位置を書かないまま実装すると、単体では通るのにフル実行で不安定に落ちるスイートになる / 「`if (want('local-file'))` の中で `stopAll()` を挟み、`shared-tabs` の後ろに置く」までステップに書く
- `Phase 4 > 2`（検査項目） — 決定表で新たに決めた「定義に載せない」側の検査が 1 つも無い / P0 の回帰（題名・favicon だけ古い定義に書かれる）を自走検証が二度と拾えない / 3 項目を足す: ①`file:` タブは `ephemeral-tabs.json` に現れない ②`file:` タブは自分のウィンドウのサイドバーにはローカル行として出る（`Sidebar.tsx:108` の経路）が他ウィンドウには出ない ③既存の共有タブをアドレスバーから `file:` へ飛ばしても、その定義の `url` / `title` / `faviconUrl` が変わらない

## P2
- `Phase 2 > 4` — `src/main/security.ts` に `installNavigationGuard` という関数は無い。実体は `applyWebContentsSecurityDefaults` の中の `policyForCurrentPage` / `guard` / 名前で grep しても当たらないだけなので実害は小さいが、直しておくと迷わない
- `Phase 4 > 2`（`~/` 始まりの検査） — 「`~/` から `test-pages` へ届く実在の相対パス」はリポジトリが `os.homedir()` 配下にあることが前提 / `path.relative(os.homedir(), projectRoot)` が `..` を含むときは検査を skip する、と 1 行添えておくと環境依存で落ちない

## Q

````

**対応**:
- P0 `updateEphemeralFromTab` の呼び元 4 箇所（title / favicon / syncEphemeralDefinition / rename）に効く共通ガード「現 URL が http/https でなければ定義に何も書かない」に書き換え
- P1 VERIFY.md の書き換え対象を 165 / 205 / 512 に絞り、172（拡張からの file: は拒否）と 204 は据え置きと明記
- P1 verify-all の配線位置: `shared-tabs` の後ろに置き `if (want('local-file'))` の中で先に `await stopAll()` を呼ぶ、と理由（`open -a` はバンドル単位の配送）込みで追記
- P1 見送り: 「定義に載せない」側の検査 3 項目（ephemeral-tabs.json に現れない / 他ウィンドウに出ない / 既存定義の url・title・favicon が変わらない）の追加はループ中は足さず終了報告に回す（足すと次の P0 の種になる）。実装時に Phase 4 へ入れる
- P2 `installNavigationGuard` → `applyWebContentsSecurityDefaults` の中の `policyForCurrentPage` / `guard` に修正
- P2 `~/` の検査は `path.relative(os.homedir(), projectRoot)` が `..` を含む環境では skip と明記

## 3回目

````text
plan を読み直し、新しく入った「共通ガード」の 4 呼び元と、`verify-targets` / `verify-all` 側の記述をコードと突き合わせた。P0 は解消済み。

## P0

## P1
- `Phase 2 > 3`（一時タブ定義への共通ガード） — 呼び元 4 箇所のうち `renameTab`（3772 付近）だけ性質が違う。`renameTab` は `tab.ephemeralId` があれば定義へ書いて **early return する**ので、ガードを一律に効かせると「共有タブを `file:` に飛ばした状態で名前を変えると、定義にも `tab.customTitle` にも書かれず**黙って何も起きない**」になる（ローカルタブ側の分岐にも落ちない）/ 塞ぎたいのは「ページ由来の値（url / title / favicon）が古い http 定義を汚す」ことで、ユーザーが明示的に打った名前はその行を見ながらの入力なので書いてよい / ガードの対象を `page-title-updated` / `page-favicon-updated` / `syncEphemeralDefinition` の 3 箇所に絞り、`renameTab` は対象外（従来どおり定義へ書く）と plan に明記する

## P2
- `Phase 4 > 3`（`OWNERS` 登録） — `OWNERS` のキーは実在するファイルパスで、`verify-targets.test.mjs` が `fs.existsSync` で全キーを検査する。`test-pages/local-*.html` のワイルドカード表記のままだと落ちる / `test-pages/local-a.html` と `test-pages/local-b.html` の 2 エントリに展開すると書いておく（`test-pages/` は今まで `OWNERS` に 1 件も無く、この 2 つが最初の登録になる点も一言あると迷わない）
- `Phase 2 > 3`（`materialize` の `allowFile: true`） — 無条件 true の根拠は「`this.url` / `pendingUrl` にゲート済みの値しか入らない」こと。いま代入は宣言・`materialize` の後始末・`sleep` の 3 箇所しかないので、その事実をコメントに残しておくと、将来ここに外部由来の値を入れる経路が増えたときに気づける

## Q

````

**対応**: P0 なしで収束。採用した P1/P2:
- P1 共通ガードの対象を title / favicon / syncEphemeralDefinition の 3 箇所に絞り、`renameTab` は対象外と明記
- P2 `OWNERS` は `test-pages/local-a.html` / `local-b.html` の 2 エントリに展開（ワイルドカード不可、`test-pages/` の登録は初）
- P2 `materialize` の `allowFile: true` の根拠（`this.url` / `pendingUrl` の代入は 3 箇所だけ）をコメントに残す旨を追記
