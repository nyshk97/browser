review session: 8fe61c0d-db44-48b2-be0b-788a0bd85ed9

## 1回目

````text
## P0
- `Phase 0 > 2` — 付け替え対象に `scripts/verify-spike.mjs` が入っていない。このファイルは `mise run verify` の最初のスイート（`want('spike')` と、再起動をまたぐ `--storage-write` / `--storage-read`）で、`swSession()` の `TEST_EXTENSION_ID` に **Bitwarden の ID（`nngceckbapebfimnlniiiahkandclblb`）を直書き**している。ほかにも、`login.html` / `iframe.html` に拡張の isolated world があるかや、`chrome.tabs.create` / `chrome.windows.create` を Bitwarden で確かめている / Bitwarden を外すと、ローカルの `extensions/` に残るのは Keepa（content script は Amazon 向けだけ）と GraphQL Network Inspector だけになる。この 2 つでは代わりが務まらず、同じ Phase の手順 8「`mise run verify` を通す」が確実に落ちる。plan にある「残る拡張か」という選択肢は実際には成り立たない / 対象に verify-spike.mjs を加える。`verify-ext-smoke.mjs` と同じ作りで、`make-test-extension.mjs` と `NEMO_EXT_DIR` / `NEMO_EXT_LOCK` を使い、verify-all がテスト拡張を読み込むように切り替える。ID はテスト拡張のもの（`test-extension.key.json` から導いた値）にする。手順の書き方も「`test-extension/` で確かめ直す」の一本にする
- `Phase 7 > 3` — スイートの登録（`verify-targets.mjs`）と配線（`verify-all.mjs`）を最後にまとめている。ところが `verify-targets.test.mjs` の「`scripts/verify-*.mjs` はすべて分類されている」は、Phase 3 でスイートのファイルを作った時点で落ちる。しかも配線するまでは、Phase 3〜6 の検査が `mise run verify` で 1 件も回らない。さらに Phase 4 は `Toolbar.tsx`・`keybindings.js`・`registry.ts` など OWNERS に既に載っているファイルを触るので、そのエントリを広げるのを忘れると `--changed` でも回らない / 登録・配線と「配線を外すと 0 件になる」の確認は Phase 3 のスイートを作る手順に移す。Phase 4〜6 では、それぞれのステップに「このスイートを広げ、触った既存ファイルの OWNERS エントリにも足す」と書く。Phase 7 は最終確認だけにする

## P1
- `調べてわかったこと（コード） > Nemo（Bitwarden が前提になっている箇所）` — 棚卸しから漏れている箇所がある: `.mise.toml`（`dev:nodebug` の説明）・`DESIGN.md:492`・`src/shared/types.ts:489`・`src/main/paths.ts:38`・`src/main/extension-console.ts:8`・`Toolbar.tsx:19`・`src/main/agent/keys.ts:7`・`src/shared/agent-page-source.js:12`・`src/shared/chrome-storage-onchanged.js`・`src/shared/navigation-policy.js:100`・`test-extension/*.js` のコメント・CLAUDE.md の SIGTRAP の記述（引き金が Bitwarden の OOPIF） / このまま進めると、古い前提の説明が残る / 「Bitwarden」と拡張 ID で grep した結果を一覧にし、「直す」「経緯として残す（`docs/plans/`・`phase0-report.md` など）」に振り分けるよう Phase 0 に書く
- `Phase 0 > 4` — `renovate.json` の Electron 更新 PR のチェックリスト（「実機で Bitwarden の Vault アンロックと自動入力」）と `extension-compat.yml` を「消す」とだけ書いていて、代わりに何を置くかが無い / これからは kypr が `safeStorage`・`promptTouchID`・`utilityProcess`・`powerMonitor`・クリップボードに頼るので、Electron の更新で壊れやすいのは kypr の方になる。見張りが何も無くなる / Phase 7 に「renovate のチェックリストを kypr の実機確認（Touch ID の解除・⌘⇧L・コピー）に差し替える」を足す。`extension-compat.yml` は、Keepa など実物の拡張の読み込みだけを見る形に縮めるか、廃止するかを Phase 0 で決めて書く
- `Phase 2 > 1` — vendored の TypeScript を Nemo がどう解決するかが決まっていない。Nemo には pnpm の workspace が無い。ユニットテストは `node --test scripts/*.test.mjs`（素の mjs）。`tsconfig.node.json` の `include` は `src/main`・`src/shared`・`src/preload` だけで、`noUnusedLocals`・`lib: ES2023`（DOM なし）の厳しい設定になっている。`link:` の依存にすると、electron-vite の main のビルドで外部依存として扱われ、パッケージ版が実行時に `.ts` を読みに行く恐れがある。lint と format から外すかも「決める」のまま / Phase 2 に入ってから迷うことになり、パッケージ版でだけ壊れるおそれもある / 解決は tsconfig の `paths` と electron-vite の `alias` で行い、main のバンドルに含める。テストベクタは Node 24 の型ストリップで読めるか（import に拡張子が要る）を Phase 1 の切り出しの条件にする。`src/vendor/` は `.prettierignore` と eslint の `ignores` に入れる（コピーし直すたびに整形の差分が出ないように）と、今決めてしまう。確認には `verify-packaged` で起動するのが含まれることも書く
- `Phase 1 > 3` — PSL をどう使うかと、スキームが違うときの扱いが書かれていない。PSL の private section（`github.io`・`vercel.app`・`pages.dev` など）を使わないと、match 0 で別の人のサブドメインどうしが一致し、パスワードが流れる（tldts などは private を既定で無効にしている）。また、https で登録したログインを http のページに入れてよいかも決まっていない / Web・iOS・Nemo で揃えるための仕様書の規則が、ここで緩いまま固まってしまう / 仕様には「private section を含める」と「https の項目は http のページに出さない・入れない」を書く（Chrome のパスワードマネージャーと同じ扱い）。テストに `a.github.io` と `b.github.io`、https と http のケースを足す
- `Phase 4 > 3` / `Phase 4 > 4` — ⌘⇧L とポップアップからの入力で、どのフレームに入れるかが決まっていない（Jev は右クリックしたフレームを使うが、ここにはそれが無い）。件数はトップの URL で数え、入れる直前はフレームの URL で照合し直すので、トップ `example.com` の中に `auth0.com` の iframe があるようなページでは「1 件」と出るのに入らない。分割表示では、どちらのペインが対象かも書かれていない / 実装するときにその場で決めることになり、自走検証の期待値も書けない / 対象フレームの選び方を決めて書く。案: フォーカスのあるフレーム → メインフレームで見えているパスワード欄 → 直下の iframe で見えているパスワード欄、の順に探す。⌘⇧L の「1 件」はその対象フレームの URL で数える。対象のタブは `getForegroundTab()`（Peek も分割も考慮済み）に揃える
- `Phase 4 > 1` — バッジを更新するきっかけを、既にある `syncForegroundTab` に相乗りさせると、`!win.usesMainProfile` で抜ける作りなのでシークレットウィンドウでは更新されない。また `Toolbar.tsx` は、`showInToolbar` の拡張が 0 件だと要素ごと畳む。Bitwarden を外すと 0 件になる / 決定事項の「シークレットウィンドウでも使える」を満たさず、アイコンが出ない恐れもある / バッジの更新はタブの切り替え・遷移・Peek の出し入れに自前でつなぎ、アイコンは拡張の並びとは別の要素にする、と明記する。自走検証にシークレットウィンドウでのバッジを足す
- `Phase 4 > 5` — Electron の `clipboard` には、テキストと `org.nspasteboard.ConcealedType` を 1 回の書き込みで一緒に置く API が無い。`write()` はテキスト・HTML などに限られ、`writeBuffer` は別の書き込みになるので、先に書いたテキストを消す可能性が高い。ここは要実測。また 30 秒のタイマーは、Nemo の終了やロックで消えてしまう / 手段が無いと分かった時点で手戻りになる。終了の直後に、パスワードがクリップボードに残る / Phase 2 に「ConcealedType を付けられるかの実測」を足し、付けられないときの扱い（諦めてログに残す）も書いておく。消すのはロック・終了のときにも行い、そのときクリップボードの中身がまだ自分の書いたもの（changeCount か内容で見る）のときだけ消す
- `Phase 5 > 1` — プログラムから `el.focus()` を呼んでも、`focus` / `focusin` の `isTrusted` は true になる。`isTrusted` だけでは「ユーザーの操作によるフォーカス」を見分けられない / この Phase の自走検証「スクリプトの `focus()` では出ない」で落ちてやり直しになる / 判定は「直前にその要素へ向いた、trusted な `pointerdown` か `keydown`（Tab）があったか」で行う、と書く。`isTrusted` は補助の条件にとどめる
- `Phase 3 > 6` — 宛先の既定値は本番で、自走検証も dev 版（`!app.isPackaged`）で回す。どこかのスイートで env を渡し忘れると、検証用の資格情報で本番に届いてしまう / secrets-in-apps の「実物に触らない」を、書き忘れ 1 つで破れる作りになっている / 検証モード（`NEMO_VERIFY_DIAGNOSTICS=1` など）では宛先の env を必須にし、無ければ kypr の機能を起動しない（fail-closed）。これをユニットテストにする
- `Phase 1 > 1` — kypr のサーバーが、ブラウザ以外のクライアント（main プロセスの `fetch`。`Origin` も Cookie も無い）を受け付けるかを確かめる手順が無い。`~/kypr` は今回読む権限が無く、こちらでは確認できていない / Web が Cookie 認証や `Origin` の検査をしていると、Phase 3 になってサーバーの変更が必要になる / Phase 1 の最初に「トークンをどう運ぶか・`Origin` や CSRF の検査・CORS」を確かめる項目を置く。変更が要るなら Phase 1 の作業とデプロイの手順に含める

## P2
- `Phase 7 > 1` — 目印の URL を自走検証で実際に開くと、履歴の DB に正当な理由で残るので、検査が偽の FAIL になる / 目印の URL は一度も開かないホストにする、と書く
- `Phase 0 > 1` — lock から外しても、プロファイルの中にある Bitwarden の拡張ストレージ（暗号化された保管庫・設定）は消えない / 消すかどうかを決め、消すなら手順を書く
- `Phase 5 > 2` — 候補の View の位置について、ページのズーム・Peek・分割表示での座標の換算や、遷移・タブの切り替えで閉じるかが書かれていない / 閉じる条件と、ズームしたときの自走検証を足す
- `Phase 1 > 5` — iOS のセッションも並行して `crypto-spec.md` の URL の照合の規則に触れる可能性がある / どちらのセッションがこの節を書くかを先に決めておき、衝突を避ける

## Q
- `決定事項 > kypr のコードの取り込み方` — Nemo は GPL-3.0-only の public リポジトリなので、vendored の kypr のコード（と同梱する PSL。MPL-2.0）をどのライセンスで置くかが決まっていない / 決めないと、公開されるコードの扱いがあいまいなままになる。`VENDORED.md` や `license-report` にも何を書けばよいかが決まらない

````

**対応**:
- P0 Phase 0 > 2: `verify-spike.mjs` を付け替えの対象に加え、題材は `test-extension/` 一本にした（残る実物の拡張は題材にならないことを「調べてわかったこと」に書いた）
- P0 Phase 7 > 3: 登録・配線と「配線を外すと 0 件」の確認を Phase 3 に移した。Phase 4〜6 の自走検証に「スイートと OWNERS を広げる」を書き、Phase 7 は `mise run verify` と件数の報告だけにした
- P1 棚卸し: Phase 0 の手順を「Bitwarden と拡張 ID で grep → 直す / 経緯として残す に振り分け」に書き換えた。verify-spike の事実を棚卸しの箇所に足した
- P1 renovate / extension-compat.yml: renovate のチェックリストを kypr の実機確認に差し替える、と Phase 0 の手順に書いた。extension-compat.yml は廃止に決めた（実物の Bitwarden を取ってくる workflow なので対象が無くなる）
- P1 Phase 2 > 1: tsconfig の paths と electron-vite の alias で解決して main のバンドルに含める、`src/vendor/` を prettier / eslint から外す、`verify-packaged` で確かめる、と決めて書いた。`.ts` の import は kypr 側で既に拡張子付きなので、切り出しの条件は足さなかった（事実として書いた）
- P1 Phase 1 > 3: PSL の private section を含める・https の項目を http のページに出さないを決定表・Phase 1 の手順・仕様書への追記に入れ、テストのケースも既存の列挙に足した
- P1 Phase 4 > 3/4: 入れる先のフレームの選び方を決定表に足した（フォーカスのあるフレーム → メインのパスワード欄 → 直下の iframe のパスワード欄。対象のタブは `getForegroundTab()`）
- P1 Phase 4 > 1: アイコンを拡張の並びと別の要素にする・`syncForegroundTab` に相乗りせず自前でつなぐ、と書き換え、自走検証にシークレットウィンドウのバッジを足した
- P1 Phase 4 > 5: 手順を足さず、「ConcealedType は付けられれば付ける。付けられなければログに残す」と、ロック・終了でも消す（自分の書いたもののときだけ）に書き換えた
- P1 Phase 5 > 1: 判定を「直前にその要素へ向いた trusted な pointerdown / keydown(Tab)」に書き換えた（決定表も）
- P1 Phase 3 > 6: 検証モードでは宛先の env を必須にし、無ければ kypr を起動しない（fail-closed）に書き換えた
- P1 Phase 1 > 1: 調べて解決した（手順は足していない）。`apps/api/src/auth.ts` は `Authorization: Bearer` だけで、Origin・Cookie・CORS の検査は無い。事実として書いた
- P2 Phase 7 > 1: 目印の URL は開かないホストにする、と書き換えた
- P2 Phase 1 > 5: 事前準備の iOS の行を書き換え、URL の照合の節はこの plan の Phase 1 で書く、と決めた
- P2 Phase 0 > 1（プロファイルに残る Bitwarden の拡張ストレージの掃除）・P2 Phase 5 > 2（ズーム・Peek・分割での座標、閉じる条件の追加）: ステップの追加になるので見送り、終了報告に回す
- Q ライセンス: GPL-3.0-only で置き、PSL は MPL-2.0 のまま `docs/licenses.md` に載せる、と決めた / 根拠: `package.json` の license が GPL-3.0-only で、kypr の作者も同じ。MPL-2.0 は GPL と両立する

## 2回目

````text
## P0

## P1
- `Phase 0 > 3` — `extension-compat.yml` を「対象が無くなる」という理由で廃止している。しかし、この workflow は Bitwarden を取ってくるだけでなく、`package.json`・`pnpm-lock.yaml` が変わる PR（Electron の更新）で `node scripts/verify-all.mjs` を回す**唯一の CI** でもある。`ci.yml` が回しているのは lint・ユニットテスト・ext-smoke・パッケージだけ / 廃止すると、Electron の更新 PR で本体の自走検証が CI で一度も回らなくなる。kypr が頼る `safeStorage`・`utilityProcess`・`powerMonitor` の退行も CI では拾えない / Phase 0 > 2 で verify-all はテスト拡張を読むようになり、外からのダウンロードは不要になる。なので廃止はせず、「Electron 更新 PR で verify-all を回す workflow」として残す（`ext-fetch` の手順を `make-test-extension.mjs` に置き換え、名前も改める）。kypr のスイートも Phase 3 以降ここで回る
- `Phase 2 > 2` / `Phase 2 > 3` — tsconfig の `paths` と electron-vite の `alias` は、素の Node（`node --test scripts/*.test.mjs` と、`scripts/` の中の模擬サーバー）には効かない。テストベクタの検査と fixture 作りで `@kypr/crypto` を名前で import すると解決できない。vendored の `packages/client` などが `@kypr/crypto` を名前で import している場合も同じ。また「`.ts` 拡張子付き」と確かめたのは `packages/crypto` だけで、Phase 1 で `apps/web/src/lib/` から移す `vault.ts`・`generator.ts`・`card.ts` や照合のコードは、Vite 向けの拡張子なしの import である可能性がある（`~/kypr` は読む権限が無く、こちらでは未確認） / Phase 2 で Node から読めないと分かり、Phase 1 に戻ることになる / Phase 1 の切り出しの条件に「新しい `packages/*` も `.ts` 拡張子付きの import で、型ストリップで消せる構文だけにする（`erasableSyntaxOnly`）」を足す。Node から読む経路は Phase 2 の手順に 1 つ決めて書く（例: 相対パスで import する。または `devDependencies` に `link:src/vendor/kypr/crypto` を足して Node の解決に使い、バンドルは alias で行う。`dependencies` ではないので `externalizeDepsPlugin` には外されない）
- `決定事項 > ポップアップ` / `決定事項 > 入れる先のフレーム` — ポップアップの上の「このページに合うログイン」はトップの URL で出すのに、押したときは対象フレームの URL で照合し直す。たとえばトップが `example.com` で、ログイン欄が `auth0.com` の iframe にあるページだと、出ているのに押しても入らない行が並ぶ。逆に iframe 側に合うログインは上に出ない。⌘⇧L だけは対象フレームで数えると決めたので、同じ操作の中で 2 つの入口の基準がずれている / 自走検証の「別オリジンの iframe には入らない」は通っても、使うと「押しても何も起きない」になる / ポップアップの上の一覧も、⌘⇧L と同じ対象フレーム（`webContents.focusedFrame` → メインのパスワード欄 → 直下の iframe のパスワード欄）の URL で出すと決める。トップの URL を使うのはバッジだけ、と書き分ける
- `決定事項 > コピーした kypr のコードのライセンス` — ライセンスは決めたが、実装する手順がどの Phase にも無い。しかも `scripts/license-report.mjs --write` が成果物に同梱する notice は `node_modules/.pnpm` だけを走査するので、vendored の PSL（MPL-2.0）と kypr のコードは notice に載らない。`docs/licenses.md` はアプリに同梱されない / 配布物の notice に MPL-2.0 の表記が欠けたままになる / Phase 2 > 1 に「`src/vendor/kypr/` に LICENSE（GPL-3.0-only）を置く・`docs/licenses.md` に PSL を載せる・同梱する notice に vendored 分を足す（license-report に固定のエントリを追加する）」を足す

## P2
- `plan に書いた既定 > サーバーの宛先` — 「検証モード（`NEMO_VERIFY_DIAGNOSTICS=1` など）」の「など」が具体的でない。しかも `NEMO_VERIFY_DIAGNOSTICS` を付けているのは verify-all・ext-smoke・agent・autofill・shared-tabs など一部のスクリプトだけ / 自分でアプリを起動するスイートが宛先の env もこの env も付け忘れると、fail-closed の網をすり抜けて本番に向く / 判定に使う env を 1 つに決めて書く。kypr のスイートはそれを必ず付ける、とする

## Q

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P1 Phase 0 > 3: extension-compat.yml は廃止せず「Electron 更新 PR で verify-all を回す workflow」として残し、Bitwarden の取得をテスト拡張の生成に置き換える、に書き換えた（`paths:` に package.json があり verify-all を回していることを確認）
- P1 Phase 2 > 2/3: Phase 1 に「新しい packages も .ts 拡張子付き・型ストリップで消せる構文だけ」を、Phase 2 に「素の Node からは相対パスで import する」を書いた
- P1 決定事項 > ポップアップ: 上の一覧も ⌘⇧L と同じ「入れる先のフレーム」の URL で出し、トップの URL はバッジだけ、に書き換えた
- P2 サーバーの宛先: 検証モードの env を `NEMO_VERIFY_DIAGNOSTICS=1` の 1 つに決め、kypr のスイートは必ず付ける、と書いた
- 見送り: P1 ライセンスの実装手順（vendored に LICENSE を置く・notice に vendored の PSL を足す）は手順の追加なので終了報告に回す

