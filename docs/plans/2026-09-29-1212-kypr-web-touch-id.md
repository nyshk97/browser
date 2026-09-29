# Nemo で kypr の Web 版を Touch ID で解除する

## 概要・やりたいこと

kypr の Web 版（`https://kypr.tools97.com`）は、Chrome や Safari では Touch ID でロックを解除できるが、Nemo ではできない（指紋のボタンが出ない）。
Nemo でも Web 版の kypr を Touch ID で解除できるようにする。**kypr 側のコードは変えない**。

Web 版の解除のしくみ（`~/kypr/apps/web/src/lib/device-unlock.ts`）:

- パスキー（WebAuthn）の PRF 拡張を使う。`create` / `get` で PRF の出力を受け取り、HKDF で鍵を作って `vaultKey` / `authKey` を包み、そのブラウザの IndexedDB に置く
- 署名・attestation はどこでも検証しない（サーバーは関わらない。PRF の出力が同じなら開ける）
- ボタンを出す条件は `isUserVerifyingPlatformAuthenticatorAvailable()` が true で、`getClientCapabilities()` が `extension:prf: false` を返さないこと

Nemo は Touch ID の認証器を持たない（`isUVPAA()` が false。`app.configureWebAuthn` 未設定）ので、ここで落ちる。

## 前提・わかっていること

### 決定事項

| 項目 | 決定 |
| --- | --- |
| 方式 | **kypr の Web の origin にだけ効く、Nemo 内蔵の小さな認証器**を main world の shim で用意する。PRF の秘密は main が持ち、`safeStorage` で暗号化して userData に置く。取り出すのは `promptTouchID` を通ったあとだけ |
| 対象 | **kypr の Web の origin のメインフレームだけ**（`resolveKyprServer` の `url`。常用版は `https://kypr.tools97.com`、自走検証は模擬サーバー）。**通常のページセッションだけ**で、シークレットとエージェント用のセッションでは動かさない（シークレットでは今までどおりボタンが出ない） |
| ほかのサイト | 今までどおり（`webauthn-shim.js` がプラットフォーム認証器向けの要求を即座に NotAllowedError で拒否する）。どのサイトでもパスキーを使えるようにするのは kypr のパスキーの段階（④）で別に扱う |
| 答える要求 | 厳密な判定は **main だけ**で行う（ページ側の shim は `publicKey.extensions.prf` があれば橋渡しに回すだけ。main が「kypr の形ではない」と返したら包む前の関数に渡し、その先は今までどおり `webauthn-shim` が拒否する）。kypr の形の要求だけ: `create` は `authenticatorAttachment: 'platform'` + `userVerification: 'required'` + `extensions.prf`、`get` は `allowCredentials` にこの Nemo が作ったクレデンシャルがあり、`extensions.prf.eval.first` があるもの。それ以外は NotAllowedError で拒否する（本物の認証器のふりはしない） |
| PRF の計算 | 仕様どおり `HMAC-SHA256(secret, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt))`（32 バイト）。secret はクレデンシャルごとに 32 バイトの乱数 |
| Touch ID の回数 | 有効にするとき 1 回（`create` の時点で `prf.results.first` を返すので、kypr は続けて `get` を呼ばない）、解除のとき 1 回 |
| Touch ID の関門 | `src/main/kypr/touch-id.ts` の `promptTouchId` を使う（自走検証は `NEMO_KYPR_TEST_TOUCHID` で差し替え済み）。通らなければ NotAllowedError を返す（kypr はマスターパスワードに回る） |
| 要求を受ける条件 | main で送り手を確かめる。preload 側の判定は信用しない。**全 IPC 共通**: `senderFrame` がメインフレームで、origin が kypr の origin、セッションが通常のページセッション。**`create` / `get` だけ追加で**: そのタブがウィンドウ内で表示中（アクティブタブ・分割の片側・Peek）で、ウィンドウが表示されていて最小化されていない（main の状態で判定し、OS のフォーカスは求めない。自走検証がターミナル前面でも揺れないように）。対象かの問い合わせと `forget` には表示中の条件を掛けない（裏で開いた・復元したタブにも認証器が入るように） |
| rpId・origin の照合 | rpId は main が「送り手の origin の host」に決める。要求の `rp.id` / `rpId` がそれと違えば拒否。`get` / `forget` は保存した行の origin が送り手と一致するものだけを対象にする |
| 返すオブジェクト | `rawId` / `id`（base64url）/ `type` / `authenticatorAttachment: 'platform'` / `getClientExtensionResults()`（`prf: { enabled: true, results: { first } }`）と、最小限の `response`（`clientDataJSON` は実物と同じ形の JSON。署名等は空）。`PublicKeyCredential` のインスタンスにはしない（kypr は型のキャストだけで `instanceof` を見ない） |
| 同時の要求 | main で処理中の要求があれば、後から来た要求はすぐ NotAllowedError（Chrome の "A request is already pending" と同じ扱い。Touch ID のダイアログを重ねない） |
| 後始末 | `PublicKeyCredential.signalUnknownCredential({ rpId, credentialId })`（kypr が鍵を作り直すとき・やめるときに呼ぶ）で保存した秘密を消す。取りこぼしに備えて origin ごとに**新しい順で 5 件まで**しか持たない |
| 保存先 | `userData/kypr/web-authenticator.json`（`{ version: 1, credentials: [{ id, rpId, origin, encrypted, createdAt }] }`。`encrypted` は secret を `getSecretBackend()` で暗号化したもの。自走検証は `NEMO_HTTP_AUTH_TEST_CRYPTO=memory` で実 Keychain に触らない） |
| Nemo の kypr のログアウト | この秘密は**消さない**（Web 版の IndexedDB の記録とは無関係に生きているので、消すと Web 版だけが「保存した鍵が開けない」になる） |

### 見送った案

- **`app.configureWebAuthn({ touchID })`（本物の Touch ID 認証器）**: `keychain-access-groups` の entitlement と、Developer ID のプロビジョニングプロファイルが要る（Nemo の kypr の Touch ID を作ったときも同じ理由で見送った）。Chromium の Mac の Touch ID 認証器が PRF に対応しているかも未確認で、対応していなければ kypr は `unsupported` で落ちる
- **Nemo の kypr が解除済みなら、その鍵を Web のページに渡す**: `vaultKey` がページの JS から見えるようになり、kypr の Web 側に Nemo 専用の分岐が要る
- 守りの強さは Nemo の kypr の Touch ID 解除と同じ（Secure Enclave に縛られない。`safeStorage` + `promptTouchID` を関門にする）。自分専用のツールとして受け入れる

### コードベースの事実

- ページの main world の shim は `src/preload/extension-shim.ts`（`extension-shim.cjs`）が配る。**Node / IPC に触らない決まり**なので、ここには足さない
- `src/preload/kypr-page.ts`（`kypr-page.cjs`。isolated world。`ipcRenderer` を使う）が、通常のページセッションとシークレットに配られている（`index.ts:240-242` / `registry.ts:294`）。エージェント用のセッションには配られない。**今回の橋渡しはここに足す**
  - `contextBridge.executeInMainWorld({ func, args })` で main world に認証器を入れ、IPC を呼ぶ関数を `args` で渡す（ページにグローバルな名前を生やさない）
  - 登録は `extension-shim` → `kypr-page` の順なので、kypr の認証器は `webauthn-shim` の**外側**に入るはず。順序は実測して自走検証で担保する（`webauthn-shim` が内側にいると、kypr の要求がそこで NotAllowedError になる）
- preload はサンドボックスで env を読めないので、「この frame が kypr の origin か」は main に聞く（候補の origin のメインフレームでだけ 1 回 `sendSync`。main は `senderFrame` で判定する）
- `webauthn-shim.js` は isUVPAA の native の値を preload の時点で握る。kypr の認証器が後から isUVPAA を true に差し替えても、`webauthn-shim` の判定は変わらない（kypr 以外の要求はそもそも kypr の origin で出ない）
- kypr が渡す options（kypr `798c258` の `device-unlock.ts`）: `create` は `authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }`・`rp: { name: 'kypr' }`（`id` 無し）・`extensions.prf.eval.first`。`get` は `allowCredentials: [{ type, id }]`（transports 無し）・`userVerification: 'required'`・`extensions.prf.eval.first`。`create` で `prf.results.first` が返らなければ続けて `get` を呼ぶ。`signalUnknownCredential` は鍵を作り直したとき・作成直後の失敗で呼ぶ
- WebAuthn は secure context でしか使えない。模擬サーバーは `http://127.0.0.1` / `localhost` なので secure context 扱い
- 模擬サーバー（`scripts/lib/kypr-mock-server.mjs`）は `pages` でテストページを返せる。kypr の Web 版そのものは Nemo の CI に無い（private リポジトリ）ので、自走検証は `device-unlock.ts` と同じ呼び出しをするテストページで見る

## 実装計画

### Phase 1: 認証器の main 側 [AI🤖]

- [x] `src/shared/kypr-webauthn.js`（Electron 非依存の純粋関数）: 要求の形の判定（kypr の `create` / `get` に当たるか）・PRF の計算・保存ファイルの正規化（形の違う行を捨てる・5 件で切る）
- [x] `scripts/kypr-webauthn.test.mjs`: 判定（platform でない・UV が required でない・PRF が無い・知らない credentialId → 拒否）、PRF の出力が同じ salt で一致し別の salt / 別の secret で変わること、正規化（壊れた行・6 件目）
- [x] `src/main/kypr/web-authenticator.ts`: 保存（`userData/kypr/web-authenticator.json`、`device-keys.ts` と同じ `getSecretBackend()` とファイルの権限）・IPC の口（`create` / `get` / `forget` / 「この frame は対象か」）・送り手の確認（メインフレーム・origin・通常のページセッション・前面で表示中）・Touch ID の関門。`log()` は件数と結果だけ（credentialId・PRF の値は出さない）
- [x] `src/main/index.ts` で IPC を登録する

### Phase 2: ページ側 [AI🤖]

- [x] `src/shared/kypr-webauthn-shim.js`: main world に入れる関数（文字列化して送るので外側を参照しない）。`navigator.credentials.create` / `get` を包み、kypr の形の要求だけ橋渡しの関数へ回す。それ以外は包む前の関数に渡す。`isUserVerifyingPlatformAuthenticatorAvailable` → true、`getClientCapabilities` → `extension:prf` / `userVerifyingPlatformAuthenticator` を true、`signalUnknownCredential` → 保存した秘密を消す。`AbortSignal` が abort されたら AbortError を返す
- [x] `scripts/kypr-webauthn-shim.test.mjs`: 偽の `globalThis` に `installWebAuthnShim` → kypr の shim の順で入れ、kypr の形の要求が橋渡しに回る・それ以外は内側に回って NotAllowedError・isUVPAA / `getClientCapabilities` の上書き・abort で AbortError・オフセット付きの TypedArray の salt が正しいバイト列で渡る・文字列化して評価しても動く、を見る（`webauthn-shim.test.mjs` と同じ方針）
- [x] `src/preload/kypr-page.ts`: 候補の origin（`KYPR_PRODUCTION_SERVER` か、hostname が `127.0.0.1` / `localhost`）のメインフレームでだけ main に対象かどうかを聞き（全サイトで同期 IPC を撃たない）、対象なら `executeInMainWorld` で入れる
- [x] `scripts/lib/verify-targets.mjs` の `OWNERS` に新規ファイルを `['kypr']` で足す。`kypr-page.ts` の既存エントリ（`['kypr']`）は、全ページの読み込みに効くので、ページを開くスイートまで広げるかを実装時に見る

### Phase 3: 自走検証 [AI🤖]

- [x] 模擬サーバーの `pages` に、`device-unlock.ts` と同じ呼び出しをするテストページを置く（`touchIdAvailable` の判定 → `create`（PRF の結果を受け取る）→ `get` → 2 つの出力が一致する、を画面に出す）
- [x] `scripts/verify-kypr.mjs` に足す検査:
  - kypr の origin: isUVPAA が true・`create` → `get` で PRF の出力が一致する・Touch ID を `fail` にすると NotAllowedError・`signalUnknownCredential` のあとは `get` が NotAllowedError・保存ファイルの `encrypted` が memory backend の形式で想定外のキーが無く、ページで得た PRF の出力が userData のどのファイルにも、credentialId がログに（hex / base64 / base64url のどれでも）出ない（credentialId は保存ファイルの `id` に置くので、ファイルは対象にしない）
  - **kypr 以外の origin**（kypr の origin が `127.0.0.1` なら同じポートの `localhost`）: isUVPAA が false のまま・platform の `create` が即 NotAllowedError（今までどおり）
  - 裏のタブから `get` を撃っても Touch ID を求めずに NotAllowedError
  - シークレットウィンドウの kypr の origin: isUVPAA が false
  - 同時に 2 件撃つと、2 件目はすぐ NotAllowedError
  - 再起動をまたぐ: 既存の `NEMO_KYPR_TEST_TOUCHID=fail` の起動（同じ userData）に相乗りし、1 回目の起動で作ったクレデンシャルで `get` → NotAllowedError で、ファイルの件数が変わらない（Touch ID の失敗で秘密を消さない）
- [x] 実行件数を報告に出す。Phase 2 の preload の足し込みを外して回し、kypr の origin の検査が FAIL することを見てから戻す

### Phase 4: ドキュメント [AI🤖]

- [x] `docs/compat.md` の WebAuthn の節と `webauthn-shim.js` の冒頭コメント: kypr の origin だけは外側に Nemo の認証器が入って答えることを書く
- [x] `docs/operations.md`「kypr」・`VERIFY.md`「kypr」（自走検証が見るもの・手で見るもの）
- [x] `docs/CHANGELOG.md` の `[Unreleased]`
- [x] kypr のリポジトリ: `VERIFY.md:123`（「Nemo で開くと指紋のボタンが出ない」）と `docs/plans/2026-09-29-1200-web-touch-id-unlock.md:19` を直し、`VERIFY.md` に「`device-unlock.ts` の options を変えたら Nemo の `kypr-webauthn` の判定も直す」と書く（kypr 側で別コミット）

### 動作確認 [人間👨‍💻]

- [ ] 常用版で `https://kypr.tools97.com` を開き、マスターパスワードで解除 → Touch ID を有効にする（Touch ID が 1 回だけ出る）
- [ ] ロックして Touch ID で解除できる。Touch ID のダイアログを閉じるとマスターパスワードに回る
- [ ] Touch ID を無効にする・有効にし直したあとも解除できる（古い秘密が消えていることは `userData/kypr/web-authenticator.json` の件数で見る）

## ログ

### 試したこと・わかったこと

- 自走検証（`node scripts/verify-kypr.mjs`）: 91 件中 91 件 PASS（Web 版の検査は 11 件）。preload の足し込みを外した版では kypr の origin の 7 件が FAIL（isUVPAA が false・create が NotAllowedError 等）、kypr 以外の origin とシークレットの 2 件は「今までどおり」を見る検査なので PASS のまま。認証器が `webauthn-shim` の外側に入ることは、kypr の origin の create / get が通ることで実物で確かめた
- ユニットテスト: `kypr-webauthn.test.mjs` / `kypr-webauthn-shim.test.mjs` の 22 件を含め 543 件 PASS。`mise run verify:only phase1` も PASS（テストページ `127.0.0.1` を開くたびに今回の同期の問い合わせを通る）
- 同時要求の検査を作るため、Touch ID の差し替えに時間をかける `NEMO_KYPR_TEST_TOUCHID_MS` を足した（`touch-id.ts`。パッケージ版では効かない）。差し替えの `ok` は即座に返るので、そのままでは main が 1 件目を処理し終えてから 2 件目を受け取り、「処理中」を作れない

### 方針変更

- 「credentialId が userData のファイルに出ない」は検査できない（保存ファイルの `id` に置くのが仕様）。PRF の出力は userData のどこにも、credentialId はログにだけ出ないことを見る形に変えた
- 再起動後に `ok` で同じ PRF が返ることは見ない（同じ userData で `ok` の再起動が無い。起動を増やさない方針）。再起動後も秘密が残り、`fail` で消えないことは 2 回目の起動で見ている
- `kypr-page.ts` の OWNERS を `['kypr', 'phase1']` に広げた（テストページ `127.0.0.1` を開くたびに同期 IPC を撃つので、ページを開く基本の検査も回す）
