# kypr を Nemo に統合する（Bitwarden 拡張を外す）

## 概要・やりたいこと

自作のパスワードマネージャー kypr（`~/kypr`。Web v1 は本番で稼働中）を Nemo に組み込み、**Bitwarden 拡張の代わりに Nemo の中で保管庫を使えるようにする**。

- ツールバーの右上に kypr のアイコンを置き、今のページに合うログインの件数をバッジで出す。押すとポップアップが開き、入力・検索・コピー・作成・編集・ゴミ箱の操作ができる（Bitwarden の Chrome 拡張と同じ使い心地）
- ログインの入力欄にフォーカスすると、欄のすぐ下に候補を出す（メインフレームだけ）
- ⌘⇧L で、このページに合うログインが 1 件ならそのまま入れる
- 解除は 2 回目から Touch ID

**Bitwarden 拡張は、この plan の最初に外す**。④（パスキー）ができるまで、Nemo ではパスキーでログインできない（`webauthn-shim.js` が即座に `NotAllowedError` を返し、多くのサイトはパスワードに落ちる）。Phase 4 のポップアップができるまでは、パスワードは Web の kypr からコピーして入れる。これは受け入れた。

全体の順番（kypr のセッションで決めたもの）: iOS アプリ → **Nemo 統合（この plan）** → パスキー（形式を仕様書に書く → Nemo → iOS → Web）。Nemo と iOS はどちらも他方を待たない。共通点は `~/kypr/docs/crypto-spec.md` だけ。
kypr の CLAUDE.md の「保留していること」（SSH キー）の 2 番目「Nemo の中で kypr の保管庫を解除できるようにする」は、この plan で済む。

コミットはリポジトリごとに分ける（kypr 側の作業は Phase 1）。

## 前提・わかっていること

### 決定事項（/dig で確定）

| 論点 | 決定 |
| --- | --- |
| Bitwarden 拡張 | **plan の最初に外す**。外す前に Bitwarden から kypr へ取り込み直す（Web の取り込みは Bitwarden の id が既にあるものを飛ばすので、前回より後に**作った**ものは拾える。前回より後に Bitwarden 側で**書き換えた**ものは拾えない） |
| kypr のコードの取り込み方 | **kypr の `packages/` を Nemo にコピーしてコミットする**（vendoring）。Nemo は public・kypr は private なので、git 依存にすると Nemo の CI と clone した人が取得できない。暗号のコードは Nemo のアプリの中身として結局外から見えるので、公開して失うものは無い。コピー元の kypr のコミットを記録し、テストベクタも一緒にコピーして Nemo の CI で回す |
| 同期のクライアント | **kypr 側でキャッシュ・KDF の実行場所・fetch（宛先）を差し替えられる形に切り出し、Web もそれを使うように移す**。解除の手順（prelogin → 前回より弱いパラメータなら止める → 導出 → login → 展開）と同期の規則（カーソルは `GET /api/items` でだけ進める・巻き戻ったら `since=0`・トゥームストーン・409）を 1 か所に保つため |
| 解除（Touch ID） | `vaultKey` と `authKey` を **`safeStorage` で暗号化して userData に保存し、`systemPreferences.promptTouchID` を通ったときだけ復号する**。Touch ID は復号前の関門であり、Keychain の鍵自体は生体認証に縛られない（自分専用のツールとして許容。ネイティブアドオン + 生体認証付き Keychain は data protection keychain の entitlement とプロビジョニングプロファイルが要るので見送った） |
| Touch ID が通らないとき | マスターパスワードで解除する（蓋を閉じて外部キーボードで使っているとき・失敗が続いたとき）。Mac のログインパスワードでの解除は許さない（iOS と同じ。Electron の API にもない） |
| 鍵の置き場所 | 解除した鍵は **main プロセスだけ**が持つ。renderer とページには渡さない |
| ロック | **Mac の画面ロック・スリープ・Nemo の終了**、または**自動入力・コピー・ポップアップの操作を 1 時間しなかったとき**。ロックで鍵と平文をメモリから捨てる |
| ツールバーのアイコン | 右上に置く。**このページ（トップの URL）に合うログインの件数**をバッジで出す。ロック中は鍵の印（URL も暗号化されているので件数が分からない） |
| ポップアップ | アイコンの下に開く（大きさは拡張のポップアップと同程度で固定）。**上にこのページに合うログイン（押すと入力。⌘⇧L と同じ「入れる先のフレーム」の URL で出す。トップの URL で数えるのはバッジだけ）、下に全件の検索**（カード・メモはコピー）。作成・編集・ゴミ箱への移動と復元・**完全削除（確認を挟む）**もここで行う。ロック中は解除の画面（Touch ID のボタンとマスターパスワードの欄） |
| 作成・編集できる種類 | **ログイン・カード・セキュアメモの 3 つ**。知らない `type` / `schema` は読み取り専用で表示する。知らないキーは保存し直すときも残す（共通のクライアントが守る） |
| 新規作成の中身 | `uris` は今のページのオリジン（`match` は null）、名前はホスト名から `www.` を除いたもの。加えて、**押した瞬間にメインフレームのログイン欄にいま入っているユーザー名とパスワードを 1 回だけ読んで入れておく**（新規登録の直後に打ち直さないため。常時の見張りはしない） |
| パスワードの生成 | **編集画面の中のボタンだけ**（Web の `lib/generator.ts` を共通化して使う）。入力欄の候補に「強いパスワードを生成」を出すのは後回し |
| 保存・更新の提案 | **作らない**。新しいログインはポップアップの「新規作成」で足す |
| 入力欄の下の候補 | **メインフレームだけ**。ユーザー名・メール・パスワードの欄に、**ユーザーの操作によるフォーカス**のときだけ出す。判定は「直前にその要素へ向いた trusted な `pointerdown` か `keydown`（Tab）があったか」で行う（`el.focus()` でも `focus` の `isTrusted` は true になるので、`isTrusted` だけでは見分けられない）。出た直後のクリックは短い間無視する（Chrome の自動入力と同じ誤クリック対策）。スクロール・リサイズ・フォーカスが外れたら閉じる。ロック中は「Touch ID で解除」の 1 行だけ |
| iframe の中のログイン欄 | 欄の下の候補は出さない。**⌘⇧L かポップアップから入れる**（`frame-runner.ts` の作りで、メインフレーム直下の iframe まで）。Apple ID のサインイン（`idmsa.apple.com` の iframe）などが該当する。すべてのフレームに広げるか（`nodeIntegrationInSubFrames`）はパスキーの段階以降で見直す |
| ⌘⇧L | **このページに合うログインが 1 件ならそのまま入れる。0 件か 2 件以上ならポップアップを開く**。キーは `keybindings.js` に足し、上書きできるようにする |
| 照合 | 候補は**入力欄のあるフレームの URL**で照合する（タブの URL ではない。別オリジンの iframe にトップ向けのパスワードを入れないため）。規則は `uris[].match`（Bitwarden の 0〜5。null は 0）。match 0 には Public Suffix List が要る。**入れる直前に**、欄が見えているか（`autofill-collect-source.js` の `isVisible` と同じ基準）とフレームの URL を確かめ直す。PSL は **private section も含める**（`a.github.io` と `b.github.io` を同じサイトとみなさない）。**https の項目は http のページに出さない・入れない**（Chrome と同じ） |
| 入れる先のフレーム（⌘⇧L・ポップアップ） | 対象のタブは `getForegroundTab()`（Peek・分割表示を考慮済み）。その中で **フォーカスのあるフレーム → メインフレームで見えているパスワード欄 → 直下の iframe で見えているパスワード欄** の順に探す。⌘⇧L の「1 件」はこのフレームの URL で数える（1 回目のレビューで決定） |
| クレジットカード | **自動入力はしない**。ポップアップからコピーするだけ |
| シークレットウィンドウ | **使える**（アイコン・候補・入力とも）。解除の状態はアプリ全体で 1 つ |
| エージェント用のウィンドウ | 使えない（アイコン・候補・入力とも出さない。`runAutofill` と同じく入口で閉じる） |
| TOTP | 範囲外（Bitwarden で使っていない） |
| コピーした kypr のコードのライセンス | Nemo と同じ **GPL-3.0-only** で置く（作者が同じなので再許諾できる）。同梱する PSL は MPL-2.0 のまま `docs/licenses.md` に載せる（1 回目のレビューで決定） |

### plan に書いた既定（/dig で提示し、異論が出なかった）

- Argon2id（64MiB）は main を止めないよう `utilityProcess` か `worker_threads` で回す（`hash-wasm` は Node でも動く）
- 同期は、解除したとき・候補やバッジを出す直前（前回から 1 分以上経っていれば）・書き込みの後に行う。オフラインのキャッシュは userData に置き、中身は**暗号文と包んだ鍵・KDF パラメータ・revision だけ**（Web の IndexedDB と同じ）。サーバーに届かなければキャッシュから読み取り専用で開く（Web と同じ）
- セッションのトークンはメモリだけ。切れたら保存した `authKey` でログインし直す（1 回だけ。それでも 401 なら鍵を捨ててマスターパスワードへ。iOS と同じ）
- サーバーは dev 版も常用版も本番（`https://kypr.tools97.com`）を向ける（dev 版を常用することもあるため）。自走検証だけ env で模擬サーバーに向ける。**env は `!app.isPackaged` のときだけ効かせる**（`NEMO_JEV_TEST_ENDPOINT` と同じ作法。env 付きで起動したパッケージ版から鍵を任意のサーバーへ送らせない）。**検証モード（`NEMO_VERIFY_DIAGNOSTICS=1`。kypr のスイートは必ず付ける）では宛先の env を必須にし、無ければ kypr の機能を起動しない**（渡し忘れた検証が本番に届かないように）
- 前回の KDF パラメータ（`weaker-params` の判定用）もキャッシュに持つ
- コピーは 30 秒でクリップボードを消す（Web と同じ）。ロック・終了のときも消す。消すのは中身がまだ自分の書いたもののときだけ。クリップボードの管理ツールに残らないよう `org.nspasteboard.ConcealedType` を付ける。Electron の API でテキストと一緒に置けなければ、付けるのを諦めてログに残す
- 平文は main が必要なときに 1 件ずつ renderer（Nemo の UI）に渡す。一覧に渡すのは名前・ユーザー名・ホスト・種類など表示に要る項目だけで、パスワード・カード番号・セキュリティコード・メモ本文は、表示・コピー・編集を開いたときだけ渡す（コピーは main が直接クリップボードに書き、renderer を通さない）
- 設定画面に「kypr」の節を置く: 初回のログイン（マスターパスワード）・Touch ID の有効化・ログアウト（キャッシュと保存した鍵を消す）・手動で同期・最後に同期した時刻
- 画面は Nemo の見た目で作る。Web の React の部品は持ち込まない（共有するのはロジックだけ）
- 自走検証は、Nemo のリポジトリの中の模擬サーバー（prelogin・login・items と書き込み系）に向ける。本物の Worker（kypr のローカル 8797 番）との突き合わせは手元の手順として VERIFY.md に書く（kypr が private なので、Nemo の CI では本物を立てられない）

### 調べてわかったこと（コード）

- **kypr**
  - 暗号: `packages/crypto`（Argon2id は hash-wasm、HKDF と AES-GCM は WebCrypto）。TypeScript のソースのまま import する。`exports` は `.`・`./encoding`・`./errors`・`./params`・`./ids`・`./envelope-shape`・`./export-format`
  - 同期: `apps/web/src/lib/vault.ts`（`VaultSession`。setup・unlock・unlockOffline・sync・create・update・trash・restore・purge・buildExport・lock）。`api.ts` は相対パスの `fetch`、`cache.ts` は IndexedDB、`kdf.ts` は Web Worker に直接依存している → この 3 つを差し替え口にする
  - ほかに共通化するもの: `lib/generator.ts`（パスワード生成）・`lib/card.ts`（カードのブランド判定など）・`lib/clipboard.ts` の方針
  - API の認証は `Authorization: Bearer` だけ（`apps/api/src/auth.ts`）。Origin・Cookie・CORS の検査は無いので、main の `fetch` からそのまま呼べる
  - `packages/crypto` の import は `.ts` 拡張子付き（Node 24 の型ストリップでそのまま読める）
  - 平文の形式: login / note / card（いずれも schema 1）が `docs/crypto-spec.md` にある。URL の照合の規則はまだ仕様書に無い（iOS の plan にだけある）
  - iOS の plan（`docs/plans/2026-09-28-2144-ios-autofill.md`）の URL の一致: match 0 は登録可能なドメイン（PSL が要る）、スキームが無ければ `http://` を補う、正規表現が不正なら一致しない、ゴミ箱・隔離・purged は出さない
- **Nemo**
  - Nemo は **public**、kypr は **private**（`gh repo view` で確認）。パッケージは pnpm、ビルドは electron-vite
  - ページ向けの preload は `session.registerPreloadScript({ type: 'frame' })` で配っている（`page-shim.ts`・`extensions.ts`）。**Electron の preload はサブフレームに届かない**（`devtools-shim.ts` に実測の記録）
  - ページの `webPreferences` は `registry.ts` の `PAGE_WEB_PREFERENCES`（sandbox・contextIsolation。popup の子にも同じものを渡す）
  - フォーム自動入力（Jev）: `src/main/autofill/`。iframe へは CDP で isolated world を作って入れる（`frame-runner.ts`。メインフレーム直下の iframe だけ・親で見えているかも確かめる）。右クリックのメニューは `context-menu.ts`。エージェント用のウィンドウは `isAgentContents` で弾いている
  - 秘密の保存: `store/secret-backend.ts`（`safeStorage` を interface で包み、`NEMO_HTTP_AUTH_TEST_CRYPTO` で差し替えられる。ゲートは `!app.isPackaged`）
  - オーバーレイ（コマンドバー等）は `Overlay.tsx`。ツールバーの拡張アイコンは `Toolbar.tsx`（`showInToolbar` の拡張が 0 件なら要素ごと畳む）
  - ショートカットは `src/shared/keybindings.js` の `COMMANDS`（上書きできる）。⌘⇧L は空いている
  - Nemo には Public Suffix List のライブラリが無い
  - **Bitwarden が前提になっている箇所**（外すときの棚卸しの対象。以下は一部で、全体は Phase 0 で grep して洗う）: `scripts/verify-spike.mjs`（`mise run verify` の最初のスイート。`TEST_EXTENSION_ID` に Bitwarden の ID を直書きし、拡張の isolated world・`chrome.tabs.create` 等を Bitwarden で確かめている）・`extensions.lock.json`・`.github/workflows/extension-compat.yml`（実物の Bitwarden での検証）・`ci.yml` のコメント・`scripts/verify-ext-smoke.mjs`・`verify-ext-update.mjs`・`verify-peek.mjs`・`scripts/dev.mjs`・`ext-outdated.mjs`・`lib/ext-version.mjs`・`test-server.mjs`・`renovate.json`・`VERIFY.md`・`docs/compat.md`・`docs/operations.md`・`README.md`・`src/main/extensions.ts`（ツールバーのアイコンの扱い）・`registry.ts`（シークレットウィンドウ・Peek での自動入力）・`Sidebar.tsx`（シークレットウィンドウの「拡張は動かない（Bitwarden の自動入力は使えない）」の表示）・`webauthn-shim.js` とそのテスト（Bitwarden の page script との兼ね合い）
  - `webauthn-shim.js` は Electron の宙吊りの対策なので、Bitwarden を外しても残す（外した後は、プラットフォーム認証器でしか答えられない要求を即座に拒否する働きだけになる）
  - Peek を出しているときは、自動入力は Peek のページに効かせる作り（`registry.ts`）。kypr の入力とバッジも同じ扱いにする
  - Bitwarden を外すと、手元の `extensions/` に残るのは Keepa（content script は Amazon 向けだけ）と GraphQL Network Inspector だけで、Bitwarden の代わりに検証の題材にはならない
  - 前面のタブの同期（`syncForegroundTab`）は `usesMainProfile` でないウィンドウでは抜ける。`Toolbar.tsx` は `showInToolbar` の拡張が 0 件なら要素ごと畳む（Bitwarden を外すと 0 件になる）

### 参照するもの（着手前に読む）

- `~/Library/CloudStorage/Dropbox/dotfiles/.claude/references/secrets-in-apps.md`（自走検証で実 Keychain に触らない・平文が無いことの検査・renderer に秘密を渡さない）
- `~/Library/CloudStorage/Dropbox/dotfiles/.claude/references/electron-mac-apps.md`
- `~/kypr/docs/crypto-spec.md`・`~/kypr/packages/crypto/test-vectors/v1.json`
- このリポジトリの CLAUDE.md「自走検証を足すとき」（登録と配線・`OWNERS`・検証件数の報告）

## 実装計画

### 事前準備 [人間👨‍💻]

- [ ] Bitwarden から暗号化なしの JSON をエクスポートし、kypr の Web で取り込み直す（前回より後に作ったものを拾う）。前回より後に Bitwarden 側で書き換えたアイテムに心当たりがあれば、kypr の Web で直す
- [x] ~/kypr の iOS の作業（未コミット）を、kypr のセッションで区切っておく。Phase 1 は iOS の作業と同じ作業ツリーを触らないよう、区切りの後に始めるか worktree を分ける。`crypto-spec.md` の URL の照合の節は、この plan の Phase 1 で書く（iOS 側はそれに合わせる）

### Phase 0: Bitwarden 拡張を外す [AI🤖]

- [x] `extensions.lock.json` から Bitwarden を消す（`extensions/` の実体の掃除は `ext-fetch` の作法に合わせる）
- [x] 拡張の互換性の検証を付け替える: `verify-spike.mjs`（`--storage-write` / `--storage-read` を含む）・`verify-ext-smoke.mjs`・`verify-ext-update.mjs`・`verify-peek.mjs` が Bitwarden で確かめていたこと（拡張の isolated world・`chrome.tabs.create` 等・popup・service worker・storage の onChanged・インラインの iframe・更新）を一覧にし、**`test-extension/` で確かめ直す**（`verify-ext-smoke.mjs` と同じく、`verify-all` がテスト拡張を読み込むように切り替える。残る実物の拡張は題材にならない）。確かめられなくなるものは理由を添えてログに残す
- [x] `extension-compat.yml` は廃止せず、「Electron の更新 PR で `verify-all` を回す workflow」として残す（`package.json`・`pnpm-lock.yaml` が変わる PR で本体の自走検証を回す唯一の CI のため）。`ext-fetch` で Bitwarden を取ってくる手順をテスト拡張の生成に置き換え、名前も改める。kypr のスイートも Phase 3 以降ここで回る
- [x] `webauthn-shim.js` は残す。コメントとテストの Bitwarden 前提の記述を直す
- [x] 「Bitwarden」と拡張 ID（`nngceckbapebfimnlniiiahkandclblb`）でリポジトリ全体を grep した一覧を作り、「直す」と「経緯として残す（`docs/plans/`・`phase0-report.md`・CHANGELOG の過去の版など）」に振り分けてから直す。`renovate.json` の Electron 更新のチェックリスト（「実機で Bitwarden の Vault アンロックと自動入力」）は、kypr の実機確認（Touch ID の解除・⌘⇧L・コピー）に差し替える（kypr が使えるようになるまでは項目だけ置く）
- [x] シークレットウィンドウの表示（`Sidebar.tsx`・`registry.ts` の「Bitwarden の自動入力は使えない」）を、この時点の実態（パスワードの自動入力は無い）に直す。Phase 3 以降で kypr の実態に合わせて書き直す
- [x] `docs/compat.md`・`docs/operations.md`・`README.md`・`VERIFY.md` を直す（パスキーは Nemo では使えないことを compat.md の WebAuthn の節に書く）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に書く（パスキーが使えなくなることを明記する）
- [ ] `mise run verify` と CI を通す（検査の件数を報告する）

### Phase 1: kypr 側の切り出し（`~/kypr` で作業・kypr にコミット） [AI🤖]

- [x] `packages/client`（仮）を作る: `VaultSession` の解除・同期・書き込みを、差し替え口（`fetch` と宛先の URL・キャッシュのストア・KDF の実行）を受け取る形にする。IndexedDB・Web Worker・相対パスへの依存は Web 側の実装として外に出す
- [x] Web を `packages/client` に移す（振る舞いは変えない）。既存のユニットテストと e2e（`scripts/verify-e2e.sh`）を通す
- [x] URL の照合（Bitwarden の match 0〜5）と Public Suffix List を `packages/` に置く（PSL は同梱し、更新はスクリプトで行う）。PSL は private section も含める。テスト: サブドメイン・`co.jp` のような 2 段の接尾辞・`a.github.io` と `b.github.io`・https の項目と http のページ・IP アドレス・ポート付き・スキーム無し・http(s) 以外のスキーム・`match` が null・正規表現が不正・ゴミ箱と隔離が出ない。iOS の plan の規則と揃える
- [x] `lib/generator.ts`・`lib/card.ts` を `packages/` に移す（Web はそれを import する）
- [x] 新しい `packages/*` も `packages/crypto` と同じく **`.ts` 拡張子付きの import で、型ストリップで消せる構文だけ**にする（Nemo の素の Node のテスト・模擬サーバーから読むため）
- [x] `docs/crypto-spec.md` に URL の照合の規則を書く（Web・iOS・Nemo で揃えるため。PSL の private section・https の項目を http のページに出さない、を含む）
- [x] Nemo へのコピーのスクリプトを作る（`mise run export:nemo` など。コピー先・対象のパッケージ・テストベクタ・コピー元のコミットを書いた `VENDORED.md` を出す。コピー元に未コミットの変更があれば止める）
- [x] kypr の CLAUDE.md の構成に `packages/client` などを足す

### Phase 2: Nemo への取り込みと土台 [AI🤖]

- [x] Phase 1 のスクリプトで Nemo の `src/vendor/kypr/` にコピーする。`hash-wasm` を Nemo の依存に足す。~~解決は tsconfig の `paths` と electron-vite の `alias` で行い、~~ **main のバンドルに含める**（外部依存にするとパッケージ版が実行時に `.ts` を読みに行く）。→ コピーするときに `@kypr/crypto` の import を相対パスに書き換えるので、`paths` / `alias` は要らなくなった（ログ > 方針変更）。`.ts` 拡張子付きの import が通るよう tsconfig を合わせる。`src/vendor/` は `.prettierignore` と eslint の `ignores` に入れる（コピーし直すたびに整形の差分が出ないように）。パッケージ版でも動くことは `verify-packaged` で確かめる。素の Node（`scripts/` のテスト・模擬サーバー）からは `src/vendor/kypr/` を相対パスで import する（`paths` / `alias` は Node には効かない）
- [x] Nemo の CI で、コピーしたテストベクタを Node で回す（`@kypr/crypto` が Node の WebCrypto と hash-wasm で `v1.json` と一致すること）
- [x] 模擬サーバーを作る（`scripts/` の中。prelogin・login・items の取得と書き込み・409・410・401・429。暗号文は本物の `@kypr/crypto` で作った fixture を使う）
- [x] kypr の保管庫の置き場所を決める: 保存した鍵（`safeStorage` の暗号文）とキャッシュの userData のファイル名。`secret-backend.ts` の差し替えに乗せる
- [x] Argon2id を `utilityProcess` か `worker_threads` で回す口を作り、main が止まらないことを確かめる（実測を残す）

### Phase 3: 解除・同期・ロック・設定の「kypr」の節 [AI🤖]

- [x] main に kypr のセッションを置く（アプリ全体で 1 つ。鍵は main だけ）。初回のログイン（マスターパスワード）→ 同期 → Touch ID の有効化で `vaultKey` と `authKey` を `safeStorage` に保存する
- [x] 2 回目からの解除: `promptTouchID` → 復号 → 必要なら `authKey` でログイン → 同期。Touch ID が使えない・失敗したらマスターパスワード。マスターパスワードで解除したら保存し直す
- [x] ロック: 画面ロック・スリープ（`powerMonitor` の `lock-screen` / `suspend`）・終了・1 時間の未使用で鍵と平文を捨てる
- [x] 同期のきっかけ（解除・候補やバッジの前に 1 分以上経っていれば・書き込みの後）。オフラインならキャッシュから読み取り専用で開く
- [x] 設定画面の「kypr」の節（初回のログイン・Touch ID の有効化・ログアウト・手動で同期・最後に同期した時刻）
- [x] サーバーの宛先の env（`!app.isPackaged` のときだけ効く。検証モードでは必須）と、そのユニットテスト（パッケージ版では env を無視する・検証モードで env が無ければ起動しない）
- [x] 自走検証のスイート（模擬サーバー・差し替えた `secret-backend`・Touch ID の差し替え）: 初回のログイン → 同期 → ロック → 解除、`weaker-params` で止まる、サーバーの巻き戻しで取り直す、オフラインで読み取り専用、401 → `authKey` でログインし直し → それでも 401 ならマスターパスワードへ、検証モードで宛先の env が無ければ起動しない
- [x] スイートを作ったこの時点で、`scripts/lib/verify-targets.mjs` への登録と `verify-all.mjs` への配線を行い、新しいファイルを `OWNERS` に載せる。配線を外すと検査 0 件になることを確かめてから戻す（CLAUDE.md「自走検証を足すとき」）

### Phase 4: ツールバーのアイコン・ポップアップ・⌘⇧L [AI🤖]

- [x] ツールバーの右上に kypr のアイコン（拡張のアイコンの並びとは別の要素にする。拡張が 0 件でも畳まれないように）。トップの URL に合うログインの件数をバッジに出す（タブの切り替え・遷移・Peek の出し入れ・同期で更新する。`syncForegroundTab` に相乗りするとシークレットウィンドウで更新されないので、自前でつなぐ。ロック中は鍵の印。Peek を出しているときは Peek のページ）
- [x] ポップアップ: このページに合うログイン（押すと入力）・全件の検索（名前・ユーザー名・URL。種類で絞れる）・詳細（パスワードとカード番号は伏せて出し、表示の切り替えとコピー）。ロック中は解除の画面
- [x] 入力の経路: 入れる先のフレームは決定表の順で選ぶ。メインフレームは isolated world、iframe の中は `frame-runner.ts` の作り（メインフレーム直下まで）。**入力欄のあるフレームの URL で照合し直してから**入れる。欄が見えていなければ入れない
- [x] ⌘⇧L（`keybindings.js` に足す）: 合うログインが 1 件なら入力、それ以外はポップアップ
- [x] コピー: main がクリップボードに書き、30 秒・ロック・終了で消す（中身がまだ自分の書いたもののときだけ）。`org.nspasteboard.ConcealedType` は付けられれば付ける（付けられなければログに残す）
- [x] エージェント用のウィンドウでは出さない。シークレットウィンドウでは出す。シークレットウィンドウの表示（Phase 0 で直したもの）を kypr の実態に合わせる
- [x] 自走検証（Phase 3 のスイートを広げ、触った既存ファイル（`Toolbar.tsx`・`keybindings.js`・`registry.ts` など）の `OWNERS` エントリにも足す）: バッジの件数（合う・合わない・サブドメイン・match の種類・シークレットウィンドウ）、ポップアップから入力（メインフレーム・直下の iframe・別オリジンの iframe には入らない・見えない欄には入らない）、⌘⇧L の 1 件 / 複数、エージェント用のウィンドウでは出ない

### Phase 5: 入力欄の下の候補（メインフレーム） [AI🤖]

- [x] メインフレーム向けの preload（isolated world）で、ユーザー名・メール・パスワードの欄へのユーザーの操作によるフォーカス（決定表の判定）を検出し、欄の位置を main に知らせる（**値は送らない**）。シークレットウィンドウのセッションにも配る
- [x] 候補の表示: ページの外の Nemo の View を欄の直下に出す。出た直後のクリックを無視する。スクロール・リサイズ・フォーカスが外れたら閉じる。ロック中は「Touch ID で解除」だけ
- [x] 候補を選んだら Phase 4 と同じ入力の経路で入れる（直前の照合と可視判定を含む）
- [x] 自走検証（スイートと `OWNERS` を広げる）: ユーザーの操作のフォーカスで出る・スクリプトの `focus()` では出ない・出た直後のクリックは効かない・スクロールで閉じる・ロック中の表示

### Phase 6: 作成・編集・ゴミ箱・完全削除 [AI🤖]

- [x] 新規作成（ログイン・カード・メモ）。ログインは、押した瞬間にメインフレームのログイン欄からユーザー名とパスワードを 1 回読んで入れておく。`uris` はオリジン（`match` は null）、名前はホスト名から `www.` を除いたもの
- [x] 編集（3 種類。知らないキーを残す。知らない種類は読み取り専用）。編集画面にパスワード生成のボタン
- [x] ゴミ箱への移動・ゴミ箱の一覧と復元・完全削除（~~確認のダイアログを挟む~~ → 2 段階のボタン: 押すと「本当に完全に削除する（取り消せません）」に変わり、もう一度押すと削除する。取り消せないことを出す）
- [x] 409 のときは取り直して「他の端末で更新されました」と出す。410（purged）も扱う
- [x] 自走検証（スイートと `OWNERS` を広げる）: 作成 → 模擬サーバーに届いた暗号文を `@kypr/crypto` で復号して中身を照合、知らないキー（真偽値と小数を含む）が編集後も残る、409、ゴミ箱 → 復元、完全削除

### Phase 7: 仕上げ [AI🤖]

- [x] **平文が無いことの検査**: 目印の文字列を入れたアイテムを作ったあと（目印の URL は一度も開かないホストにする。開くと履歴に正当に残る）、userData の中身を全部読み、パスワード・名前・メモ・URL の目印が現れないことを確かめる。先に、平文で保存するように細工した版で FAIL することを確かめる
- [x] 診断ログに値・URL・名前が載らないことを確かめる（`sanitizeDetail` を通したときに `[deep]` 等が出ない形にする。CLAUDE.md「`log()` に新しいイベントを足すとき」）
- [x] `mise run verify` を通し、kypr のスイートの検査件数を報告する（登録と配線は Phase 3 で済ませている）
- [x] VERIFY.md に手順を足す（模擬サーバーでの自走・手元の kypr の Worker（8797 番）との突き合わせ）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に書く

### 動作確認 [人間👨‍💻]

- [ ] 常用版に入れ、設定の「kypr」の節で本番の保管庫にマスターパスワードでログインし、Touch ID を有効にする（マスターパスワードは自分で入力する。Claude には渡さない）
- [ ] よく使うサイトで: バッジの件数・欄の下の候補・⌘⇧L・ポップアップからの入力。iframe のログイン（Apple ID のサインイン等）を ⌘⇧L で入れる
- [ ] 実際の Touch ID: 解除できる・失敗が続くとマスターパスワードに回る・蓋を閉じて外部キーボードのときはマスターパスワードになる（画面が 1 枚のときと 2 枚のときの両方）
- [ ] 画面ロック・スリープのあとにロックされている
- [ ] Nemo で作ったアイテム・編集したアイテムが Web の kypr（と iOS ができていれば iOS）で開ける。Web で変えたものが Nemo に反映される
- [ ] カードの番号・期限・セキュリティコードをコピーして決済フォームに貼れる。30 秒でクリップボードから消える
- [ ] シークレットウィンドウで使える

## ログ

### 試したこと・わかったこと

- Phase 0 のフル検証（2026-09-28）: 1086 PASS / 9 FAIL。**HEAD（変更前）でもフルで同じ 8 件が落ちる**（Phase 1 の画面共有 5 件 = ディスプレイが 2 枚つながっている環境依存、Live Folder 3 件 = フル実行のときだけ前のスイートの一時タブが残る順序依存）。残る 1 件（分割ビューの ⌃M）は揺れで、`--only phase1 split live-folder` で回し直すと PASS（代わりに別の検査が 1 件揺れた。HEAD の `--only` では揺れなし）。Bitwarden を外したことによる後退は無い
- `verify-spike` をテスト拡張に向けると 33 件すべて PASS（`chrome.storage` の再起動またぎも PASS）。API の検査のため、テスト拡張の manifest に `alarms` / `notifications` の権限を足した
- `ext-verify` はテスト拡張の lock（`source.type: local`・manifestKey 無し）に合わない（`cachePath` が `new URL(undefined)` で落ちる）。verify-all では照合をやめ、起動時の main のツリー hash の照合に任せた（`verify-ext-smoke` と同じ）
- Electron 41 の `worker_threads` は asar の中の ESM を読める（小さな asar で `new Worker(new URL('./worker.mjs', import.meta.url))` → `WORKER_OK 42 true`）。保険として、worker を起動できなければ main で導出してログ（`kypr.kdf_worker_fallback`）に残す
- 鍵の導出（Argon2id m=64MiB t=3）の実測（Node 24・この Mac）: main で回すと 99ms・event loop の最大の止まり 89ms / worker で回すと main の止まりは最大 2ms
- Electron の `clipboard` は、テキストと独自の型（`org.nspasteboard.ConcealedType`）を 1 回の書き込みで置けない（`writeBuffer` は書き込みのたびに中身を置き換える）。plan の決定どおり付けるのを諦めた
- kypr の e2e（`scripts/verify-e2e.sh`）は、Web を `packages/client` に移したあとも 43 件すべて PASS
- 最後のフル検証（全 Phase と /polish-impl の修正を入れた状態）: 1155 PASS / 8 FAIL。FAIL は HEAD と同じ 8 件（画面共有 5・Live Folder 3）で、kypr は 68 件すべて PASS。CI は push していないので未確認
- kypr の自走検証（`verify-kypr.mjs`）は 63 件すべて PASS（/polish-impl で検査を足したあとは 68 件すべて PASS。起動は 4 回。平文の対照を「細工した起動で見つける」に置き換え、巻き戻し・再ログインの 401・match の種類・メインのメール欄と iframe・URI の中の知らないキーを足した）。配線を外すと検査 0 件のまま「すべて PASS」になることを確かめてから戻した。エージェント窓に出ないことは `verify-agent.mjs` に 1 件足した（PASS）

### 方針変更

- **Bitwarden 拡張は plan の最初に外した**（/dig の決定）。手元の `extensions/nngceckbapebfimnlniiiahkandclblb/` の実体は消していない（`extensions/` は dev 版と共有。lock から外したので読み込まれない。消すかどうかは人が決める）。プロファイルに残る Bitwarden の拡張ストレージも消していない
- **`verify-ext-update.mjs` を消した**。版の上げ下げを実物で確かめるには `github-release` の拡張が要るが、残る実物の拡張（Keepa・GraphQL Network Inspector）は Chrome Web Store の最新版しか取れない。拡張 ID が版をまたいで変わらないことは `ext-verify` の manifest.key → ID の照合で見ている
- **vendoring の import の解決**: tsconfig の `paths` と electron-vite の `alias` をやめ、コピーするときに `@kypr/crypto` の import を相対パス（`../crypto/index.ts`）に書き換えた。バンドルにも素の Node にも同じ形で効き、設定が要らない。tsconfig.node.json には `allowImportingTsExtensions` と `src/vendor/**` の include だけ足した
- **Public Suffix List** は kypr の `apps/ios/KyprCore/Resources/public_suffix_list.dat` を正とし、TypeScript 向けには `packages/client/src/psl-data.ts` を生成する（`mise run psl`。規則は punycode に直して入れる）。iOS と同じリストを使うため
- kypr の `VaultSession` に足したもの: `unlockWithDeviceKeys`（Touch ID の解除）・`deviceKeys()`・`goOnline()`（読み取り専用から戻る）・`reloginOnExpiry`（セッション切れで authKey でログインし直す。Web は既定の false のまま）。Touch ID の鍵での解除は、サーバーが返す包んだ保管庫鍵がキャッシュと違えば開かない（作り直された保管庫に古い鍵で入らない）
- ログイン欄の下の候補は、解除中に合うログインが 0 件なら出さない（Chrome と同じ）。ロック中は「解除」の 1 行を出す
- 完全削除の確認は、ネイティブのダイアログではなく 2 段階のボタンにした（押すと文言が「本当に完全に削除する（取り消せません）」に変わり、もう一度押すと削除する。ダウンロードや設定の削除と同じ作法で、ポップアップの中で完結させるため）
- Phase 0 の「Bitwarden」の grep の振り分け: 直したもの = ワークフロー・mise のタスクの説明・dev.mjs・ext-outdated・test-server・verify-spike / verify-peek のコメント・renovate・README・operations・compat（手順と現在形の記述）・VERIFY（手順）・CLAUDE.md（SIGTRAP の注記に追記）・registry / Sidebar / types / paths / extensions / extension-console / agent の文言。経緯として残したもの = `docs/plans/`・`phase0-report.md`・CHANGELOG の過去の版・互換対応を入れた理由のコメント（`chrome-storage-onchanged.js`・`navigation-policy.js`・`extensions.ts` のアイコンの回避策・`webauthn-shim.js` とそのテスト・`test-extension/` のコメント・`verify-ext-smoke.mjs`・`ext-version.mjs`）
- ポップアップは、フォーカスが外れても閉じない（Touch ID のダイアログで閉じてしまうため）。× / Esc / 入力したときに閉じる
- kypr のスイートはフル（`mise run verify`）の既定に入れた（`OPT_IN_ONLY` にしない）。Electron 更新 PR の workflow でも回すため
- コピーの確認のため、自走検証ではクリップボードをメモリ上のものに差し替える（`NEMO_KYPR_TEST_CLIPBOARD=memory`。実物のクリップボードを検証が書き換えない）
- ライセンス: notice に PSL（MPL-2.0）を固定で載せる口（`license-report.mjs` の `EMBEDDED`）を足し、`docs/licenses.md` にも書いた。kypr のコードは GPL-3.0-only（`VENDORED.md`）
- 保留にしていた「プロファイルに残る Bitwarden のデータの掃除」はやらない（ユーザーのデータを消すため）。「候補の表示位置（ズーム・Peek・分割）」は、タブの View の位置 + 欄の位置 × ズーム率で出す形で実装した（実機の確認は VERIFY.md「kypr」の人が見る分）
