# 互換性の記録（last-known-good）

Nemo は Electron と `electron-chrome-extensions` の組み合わせが壊れやすい。
**「最新版」で検証しない。ここに書いた組み合わせだけを正とする。**

## last-known-good

| 項目 | バージョン | 備考 |
|---|---|---|
| Electron | **44.5.1** | Chromium 152.0.7977.130 / Node 24.21.0。41.10.6 から上げた（2026-10-04、41 のサポート切れ）。拡張の DevTools パネルは Nemo 側の回避策で出している（下記・#2） |
| `electron-chrome-extensions` | **4.9.0** | GPL-3.0 + Patron License のデュアル |
| `electron-chrome-web-store` | **0.13.0** | MIT。Nemo では Web Store 経路を使わず、CRX の公開鍵取得のロジックだけ参考にしている |
| `electron-vite` | 5.0.0 | vite 7.3.6 |
| React | 19.2.8 | |
| `better-sqlite3` | **13.0.3** | prebuild が Node-API なので **Electron 向けの rebuild が不要**（下記） |
| `electron-builder` | 26.15.3 | fuses の書き換えも任せる |
| Keepa 拡張 | **5.64** | Chrome Web Store の CRX（`chrome-web-store` ソース）。Amazon 商品ページで価格推移グラフの iframe（`keepa.com/keepaBox.html`）が描画されるところまで確認（2026-08-29） |
| GraphQL Network Inspector 拡張 | **2.26.1** | Chrome Web Store の CRX。DevTools の「GraphQL Network」パネルに HTTP 経由の GraphQL（Query / Mutation）がステータス・サイズ付きで並ぶところまで確認（41 は 2026-08-29、44 は 2026-10-05。44 は Nemo 側の回避策が要る。下記「Electron 42 以降、拡張の DevTools パネルが出ない」・#2）。WebSocket（Subscriptions）タブは常に空（`chrome.debugger` が Nemo のスタブなので） |

検証日: 2026-08-23（拡張の ON/OFF・`chrome.debugger` / `webRequest` の補完は 2026-08-29〜30）/ 検証機: macOS 15（Darwin 25.5.0, arm64）

Electron 44.5.1 は 2026-10-04 に CI（macOS 15）の拡張 smoke・自走検証で確認。**実機での kypr の確認（Touch ID の解除・自動入力・コピー）はリリース前に行う**。

## Electron の追従

**最新は追わない。サポート中（新しい方から 3 つの major）に居続ける**のを条件にする。
Electron の major は約 8 週ごとに出て、N の EOL は N+3 が出た日（年末年始は間が延びる）。
日数は決め打ちせず、公開されている EOL 日で判断する。

| 何を | いつ | 誰が |
|---|---|---|
| 同じ major の中の更新（patch / minor。Chromium のセキュリティ修正） | 月 1 回 | Renovate が PR を立てる（`renovate.json`）。CI と自走検証が緑ならマージ |
| 新しい major を試す | 週 1 回 | workflow `Electron の追従`（`electron-track.yml`）が使い捨ての checkout で `verify-ext-smoke` と `verify-all` を回し、issue「Electron の追従」に通る版と EOL を書く |
| major を上げる | 今の major の EOL まで 45 日を切ったら（目安 3〜4 か月ごと） | 人。issue にコメントで知らせが来る |

major を上げるときは、**通る中でいちばん新しい major の最新版**にする（いちばん古いサポート中の版にすると、
上げた時点で残りが 8 週しかない）。手順:

1. issue「Electron の追従」で通る中でいちばん新しい版を見て、`package.json` の `electron` をその版にする PR を出す
2. CI 必須の拡張互換 smoke test と workflow `自走検証（Electron・依存の更新）` が緑なのを見る
3. 実機で kypr を確認する（Touch ID の解除・自動入力・コピー。VERIFY.md「kypr」）
4. 通ったら上の last-known-good の表を更新してマージし、`mise run release` する

**通る major が無いまま EOL が近いとき**は issue に「通る major が無い」と出る。
回避策を作る（Nemo 側で避ける・`electron-chrome-extensions` を直す）か、承知のうえで据え置くかを決める。
据え置くと Chromium のセキュリティ修正が来なくなるので、ブラウザとしては長く続けない。

### 過去に 42 以降を避けていた理由

`samuelmaddock/electron-browser-shell#184` に、Electron 42 以降で
`electron-chrome-extensions` のアイコン・popup が壊れるという未解決の報告がある。
Phase 0 では **41 系の最新（41.10.6）を採用**し、42 以降には上げていなかった。
44.5.1 で試した結果、アイコン・popup は拡張 smoke で通った（2026-10-04）。
今は週 1 の試しの結果で判断する。

## Electron 42 以降、拡張の DevTools パネルが出ない（#2）

拡張の `devtools_page`（`devtools.html`）は読み込まれるが、その frame に **`chrome.devtools` が入らない**
（`undefined`）。`chrome.devtools.panels.create` が TypeError で落ちて、パネルが作られない。
42.11.10 / 44.5.1 で起き、41.10.6 では起きない（2026-10-04、CI の macOS で実測）。

**原因**（2026-10-05 に 44.5.1 で実測）: DevTools の中の拡張 frame の document が、**`electron-chrome-extensions` の
preload が最後に `Object.freeze(chrome)` した状態で始まる**（document の開始時点で `Object.isFrozen(chrome) === true`）。
DevTools の画面が渡す `chrome.devtools` のスクリプト（Electron が `DidFinishNavigation` で frame に実行する）は
strict mode なので、凍った `chrome` に `devtools` を足すところで TypeError になる。Nemo の `chrome.debugger` の空実装も
同じ理由で入っていなかった。Electron の注入のコード（`InspectableWebContents`）も DevTools の画面が渡すスクリプトも
41 と 42 で変わっていない（Electron のソースと `resources.pak` を展開して確認）。41 ではこの frame に preload が
届いていなかった（2026-08-29 の実測）ので凍っておらず、表に出なかった。

**回避策**（`src/main/devtools-shim.ts` + `src/shared/devtools-extension-api.js`）:

1. DevTools の画面で `InspectorFrontendHost.setInjectedScriptForOrigin` を横取りし、拡張ごとのスクリプトを控える
   （元の呼び出しはそのまま通す）。DevTools の画面が拡張を登録するのは `devtools-opened` より後なので間に合う
   （間に合わないと `devtools.ext_api_hooked` の `late` が 1 以上になる）
2. 拡張 frame の新しい document に `Page.addScriptToEvaluateOnNewDocument` で、凍った `chrome` を同じ中身の
   凍っていない複製に差し替え → `chrome.debugger` 等の補完 → 控えたスクリプトで `chrome.devtools` → freeze し直す、を入れる

拡張 smoke の「devtools_page が足したパネルが DevTools に出る」とパネルの中の検査が見ている。
ece の preload が freeze しなくなる・Electron の注入が凍る前に走るようになれば回避策は要らなくなるが、
DevTools のスクリプトは `chrome.devtools` が既にあれば何もしないので、残したままでも二重にはならない。

## CDP のクリックが Chromium に捨てられる（42 以降）

Electron 42 以降の Chromium は、**描画前のページや出たばかり・透明な cross-origin の iframe への入力を黙って捨てる**
（paint holding・クリックジャッキング対策）。CI では遷移の直後に `Input.dispatchMouseEvent` で撃つクリックが消え、
kypr の検査が Nemo の判定より前で落ちていた（押下 0 件を実測）。ユーザーは描画されたページしか押せないので実害は無い。
検査は押下が届いたのを確かめて撃ち直す（`verify-kypr.mjs` の `clickUntilDelivered`、`verify-peek.mjs` のリンクのクリックは Peek が開くまで撃ち直す）。CDP のクリックを足すときは 1 回撃ちにしない。

## 検証済みの動作（Electron 41.10.6 + ece 4.9.0。当時は Bitwarden 2026.8.0 で確認。Bitwarden は 2026-09-28 に外した）

- 拡張の読み込み（lock された unpacked artifact に `manifest.key` を注入した状態）
- MV3 service worker の起動
- `<browser-action-list>` のアイコン表示と popup の起動
- content script の注入（トップフレーム / 同一オリジン iframe の両方）
- `chrome.storage.local` の再起動をまたいだ永続化
- `chrome.tabs.query` / `chrome.windows.getAll` が Nemo のタブ・ウィンドウを返す
- `chrome.tabs.create` / `chrome.windows.create` / `chrome.tabs.remove` / `chrome.windows.remove`
- DevTools の起動

## 実装側で必ず要る回避策

| 事象 | 回避策 |
|---|---|
| `store.addTab()` が追加したタブを無条件でアクティブにする（バックグラウンドタブの概念が無い） | `addTab` の直後に元のアクティブタブへ戻す。戻すときに `impl.selectTab` が再入するので、`selectTab` は「既にアクティブなら通知を撃ち返さない」形にする |
| `sandbox: true` の preload は ESM をロードできない | preload だけ CJS で出す |
| sandbox 下の preload は `node_modules` を require できない | `electron-chrome-extensions/browser-action` は preload にバンドルする |
| Vite の HMR は inline script と ws を使う | ブラウザ UI の CSP を dev と本番で分ける（緩めるのは dev server 経由のときだけ） |

## 動かない / 使えない chrome API（実測）

| API | 状態 |
|---|---|
| `chrome.declarativeNetRequest` | **manifest で `declarativeNetRequest*` の permission を宣言していない拡張からは名前空間ごと見えない**（Phase 0 の自作テスト拡張で「存在しない」と記録したのはこれ）。宣言していれば Chromium が生やし、Keepa（`declarativeNetRequestWithHostAccess`）は `getSessionRules` / `updateSessionRules` を呼んで動いている。`offscreen` / `alarms` / `cookies` / `contextMenus` も同様に permission 宣言があれば使えた（Keepa 5.64 で実測） |
| `chrome.sidePanel` | 名前空間はあるが `setOptions` が無い |
| `chrome.debugger` | Electron は生やさない（service worker でも拡張ページでも `undefined`）。**Nemo が拡張ページ（`chrome-extension://`）にだけ空実装を生やしている**（`src/shared/chrome-debugger-stub.js`。`onEvent` / `onDetach` の `addListener` は呼べるが発火しない、`attach` / `detach` / `sendCommand` は callback を呼んで成功扱い、`getTargets` は `[]`）。GraphQL Network Inspector が起動時に `chrome.debugger.onEvent.addListener` を呼んで真っ白になるのを避けるためで、**`chrome.debugger` に依存する機能（WebSocket の捕捉など）は動かない**。Electron が実装したら shim は自動的に退く（既にあれば触らない）。配り方は 2 経路: 通常の拡張ページは preload（`src/preload/extension-shim.ts`）、**DevTools の中の拡張 frame（devtools_page / パネル）には Nemo の preload が効かない**ので `src/main/devtools-shim.ts` が DevTools の webContents に CDP で付いて `Page.addScriptToEvaluateOnNewDocument` で入れる（`Page.enable` が無いとプロセスまたぎで消える。42 以降は凍った `chrome` を差し替えてから入れる。上の #2） |
| `chrome.webRequest` の `tabId` | イベント自体は来るが **`details.tabId` が常に `-1`**（Electron が webContents を拡張の tabId に対応付けない）。`{ tabId }` で filter した listener は一度も発火しない → Nemo のスタブが `addListener` の filter から `tabId` を外している（全タブぶんが来る。GraphQL Network Inspector は `devtools.network.onRequestFinished` と突き合わせるので inspected tab 以外は一覧に出ない） |
| `chrome.commands` | `getAll()` は返るが **shortcut がすべて空文字**。`electron-chrome-extensions` の `CommandsAPI` は manifest を一覧にするだけで、**アクセラレータを登録せず `onCommand` も dispatch しない**（`globalShortcut` / `commands.onCommand` の呼び出しがソースに1つも無い）。`onCommand.addListener` は呼べてしまうが**永久に発火しない** → 拡張のキーボードショートカット（Bitwarden の ⌘⇧L 自動入力・⌘⇧Y popup など）は動かない |

`chrome.storage` は `local` / `session` / `sync` のいずれも読み書きできた
（Electron 公式ドキュメントは `local` のみと書いているが、`electron-chrome-extensions` が補っている）。

## WebAuthn（パスキー）は modal 要求が宙吊りになる（Electron 41.10.6、2026-09-02 実測）

`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` は false（Touch ID /
iCloud キーチェーンのプラットフォーム認証器が無い。`app.configureWebAuthn` 未設定）。それ自体は
正しいが、**modal の `navigator.credentials.get({ publicKey })` / `create({ publicKey })` は
`timeout` を過ぎても解決も拒否もされず永久に pending** になる（Chrome なら timeout で
エラー表示 → 閉じると NotAllowedError。Electron には表示する UI が無いので閉じる契機が来ない）。
`mediation: 'conditional'` も pending だが、こちらは Chrome でも待たせ続ける仕様なので問題ない。
同じ frame で 2 件目を投げると "already pending" で即拒否されるので、**同時に撃つ実測では
「2 件目以降は即拒否」に見える**（1 件ずつ別タブで撃つと全部宙吊り）。

Nemo は `src/shared/webauthn-shim.js` でプラットフォーム認証器でしか答えられない要求を
NotAllowedError で即拒否し、それ以外は timeout で打ち切っている（Electron が直ったら
isUVPAA() が true になった時点でシムは自動的に素通しになる）。版上げのときは使い捨て
プロファイルで `https://example.com` を開き、CDP から
`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'example.com', timeout: 8000 } })`
を isolated world（シムが見えない）で撃って 12 秒後も pending かを見れば再確認できる。
**パスキーは kypr が答える**（2026-09-30。Bitwarden 拡張は 2026-09-28 に外した）: `src/preload/kypr-page.ts` が
このシムの**外側**に kypr のパスキーの認証器（`src/shared/kypr-passkey-shim.js`。答えるのは main の
`src/main/kypr/passkey-authenticator.ts`。計画は `docs/plans/2026-09-30-1700-kypr-passkeys.md`）を入れ、
modal の `create` / `get` を kypr の保管庫の鍵で登録・署名する（毎回 Touch ID。ES256・attestation none）。
kypr で答えないもの（サインアウト中・kypr に無いパスキー・`cross-platform` の create・セキュリティキー向けだけの get・
http の localhost 以外・Claude のウィンドウ）は main が `pass` を返し、このシムが今までどおり扱う。
isUVPAA は kypr にログインしていて Touch ID が使えるときだけ true（呼ばれるたびに main に聞く）。
`mediation: 'conditional'`（ユーザー名欄の自動補完）は今までどおり素通し。
**kypr の Web 版の origin だけは、さらに外側に** PRF を返す kypr 用の認証器
（`src/shared/kypr-webauthn-shim.js`。答えるのは main の `src/main/kypr/web-authenticator.ts`）を入れ、
isUVPAA を true にして PRF 付きの `create` / `get` に答える（Web 版の Touch ID 解除用。署名は作らない）。
外側に入るのは preload の登録順（extension-shim → kypr-page）による。逆になると kypr の要求がこのシムで
NotAllowedError になる（`mise run verify:only kypr` が実物で見ている）。
拡張のパスキー（`registerContentScripts` の world MAIN で page script を注入する形）はこの件と無関係に動く。

## Phase 1 で分かった癖

### `better-sqlite3` は Electron 向けの rebuild が要らない（13.0.3 時点）

計画では「Electron を上げるたびに ABI 向け rebuild が要る」としていたが、
**13.0.3 の prebuild は Node-API なので Electron 41 でそのままロードできる**。
`electron-rebuild` を走らせても `binding.gyp` が prebuild を検出してビルドをスキップするため、
`build/Release/better_sqlite3.node` は生成されない（「rebuild したつもり」になりやすい）。

代わりに必要なのは **asar の外に出すこと**（`asarUnpack`）。
実際に動くかは `mise run verify:packaged` が**パッケージした .app を起動して**確認する。

### `findInPage` に `findNext: false` を明示すると結果が返らない

`webContents.findInPage(text, { forward: true, findNext: false })` は
**`found-in-page` イベントが1度も飛んでこない**。
`findNext` を省略（＝既定値 false）すれば正常に返る。ドキュメント上は同じはずなので、
Electron 41 側の癖として扱う。Nemo は新規検索のとき `findNext` を渡さない（`src/main/ipc.ts`）。

再現: `wc.findInPage('Nemo')` → `FOUND` / `wc.findInPage('Nemo', { findNext: false })` → イベントなし。

### Chromium の拡張ローダーは asar の中を読めない

`fs` は asar を透過的に読めるので `manifest.json` の存在チェックは通るが、
`session.extensions.loadExtension()` はネイティブ側でパスを開くため失敗する。
lock された artifact は `extraResources` で `Contents/Resources/` に置き、
`app.isPackaged` のときは `process.resourcesPath` を見る（`src/main/paths.ts`）。

### fuses を書き換えると ad-hoc 署名が必要になる

`electronFuses` で fuse を書き換えると Electron 本体の linker 署名が無効になり、
macOS が起動時に **SIGKILL する（出力も残らない）**。
配布用の署名をしないビルドでも `codesign --force --deep --sign -` を掛ける必要がある。

### `@electron/fuses` の `getCurrentFuseWire` は文字コードを返す

値は `'0'` / `'1'` ではなく **48 / 49**（文字コード）。
文字列や真偽値で比較すると全部 false になり、
「false を期待している fuse だけたまたま PASS する」という質の悪い誤判定になる。

### `chrome.runtime.onInstalled` が発火しない

自作のテスト拡張で確認した。初回セットアップを `onInstalled` に置いている拡張は
その処理が走らない。当時使っていた Bitwarden（2026-09-28 に外した）では実害は出ていなかったが、既知の欠落として記録する。

### 権限要求は「アクティブなタブから」でないとダイアログまで届かない

背景タブから `navigator.geolocation.getCurrentPosition()` を呼んでも
`setPermissionRequestHandler` まで来ない（Chromium 側で保留される）。
自走検証で権限ダイアログを試すときは、対象タブを必ずアクティブにする。

## 拡張のインライン UI（`web_accessible_resources` の iframe）

Bitwarden のインラインオートフィル候補（入力欄の下に出るログイン候補）は、
content script がページに **`chrome-extension://` の iframe を挿す**ことで出来ている
（`overlay/menu-button.html` / `overlay/menu-list.html`）。
拡張のインライン UI はだいたいこの形なので、ここが通らないと何も出ない。

### ページ側の `will-frame-navigate` / `will-redirect` で切ってはいけない

Nemo はページ側 WebContents で `chrome-extension:` へのナビゲーションを拒否しているが、
**サブフレームまで拒否すると拡張のインライン UI が出せなくなる**。
サブフレームに限ってホストを照合せずに通す（`shared/navigation-policy.js` の `subframe`）。

緩めてよい根拠は **`web_accessible_resources` に無いページは Chromium 自身が
`net::ERR_BLOCKED_BY_CLIENT` で拒否する**こと（実測）。`verify:ext` が
「公開したページは iframe の中で走る」「公開していないページは Chromium に拒否される」の
両方を固定しているので、この前提が崩れたら CI で落ちる。

### `use_dynamic_url: true` は**リダイレクトを1回挟む**

`use_dynamic_url: true` の resource は `chrome.runtime.getURL()` が
**拡張 ID ではなくセッションごとの UUID** を返す（Bitwarden はこれを使っている）。

```
chrome.runtime.getURL('overlay/menu-button.html')
→ chrome-extension://f151be5b-c075-47f1-b21e-953bd2cf8b06/overlay/menu-button.html
```

この UUID の URL へのリクエストは、Chromium が**静的 ID の URL へリダイレクト**して解決する。
そのため **`will-frame-navigate` だけ通しても足りない**。`will-redirect` を素通しで
拒否していると、iframe が `net::ERR_ABORTED` で落ちる
（「フレームのナビゲーションは通ったのにリダイレクトで切られる」という分かりにくい壊れ方をする）。

`will-redirect` は `will-frame-navigate` と同じく**イベント本体から `event.url` /
`event.isMainFrame` を読む**。位置引数の `(event, url, isInPlace, isMainFrame, ...)` でも
同じ値が取れるが、型定義で `@deprecated` になっているので使わない。

なお UUID からロード済み拡張 ID を引く手段は Electron 側に無いので、
**ホストでの allowlist はそもそも成立しない**。

## 拡張の service worker は 45〜50 秒で idle 停止する

実測（Electron 41.10.6 + Bitwarden 2026.8.0）:

- `running` から `stopping` まで **ちょうど 50 秒**。Chrome の MV3（30 秒）より少し長い
- 停止後も、タブ切り替えやページ遷移で**起き直す**（`electron-chrome-extensions` の
  `sendEvent` が `startWorkerForScope` で起こしてからイベントを送るため）
- **`startWorkerForScope` を running 中に呼んでも idle タイマーはリセットされない**。
  20 秒おきに叩いても 50 秒で落ちる（起こし続けたいなら
  `running-status-changed` の `stopped` を見て起こし直すしかない）
- `chrome.storage.session` は **SW の再起動をまたいで残る**（vault のアンロック状態は保たれる）

拡張アイコンの popup を開いたときの数秒のローディングは、この停止から復帰して
拡張が初期化をやり直しているぶん。

## `webNavigation.onCommitted` の `transitionType` は空文字

`electron-chrome-extensions` は `transitionType` を埋めない。
`details.transitionType === 'reload'` でリロードを見分ける実装（Bitwarden のバッジ更新の
経路のひとつ）は**永久に一致しない**。

## Web Store にしか無い拡張（`chrome-web-store` ソース）

Web Store の CRX 取得 URL は**常に最新版**を返す（版の指定はできない）。Nemo は次の形で lock と両立させている:

- `ext:fetch` は取った CRX の `manifest.version` が lock と違えば**止める**（黙って別の版を入れない）。
  一致した CRX だけ `.ext-cache/<id>/<version>/<id>-<version>.crx` に残すので、以後は Web Store が先へ進んでも復元できる
- 別の端末で lock の版が取れない（Web Store が先へ進んだ）ときは `mise run ext:update <新しい版> --id <id>` で張り替えるか、
  `.ext-cache` を持っている端末から CRX を持ってくる
- CRX ヘッダの公開鍵を `manifestKey` として lock に記録し、2 回目以降は**鍵が同じこと**まで見る（ID が同じでも鍵の差し替えを検知する）
- `ext:outdated` は本体を落とさず、リダイレクト先のファイル名（`<ID>_5_64_0_0.crx`）から版を読む

## 更新のたびに要る作業

- 両拡張ライブラリの preload script が成果物に含まれることを検査する → `mise run package` が自動で見る
- `mise run verify:ext`（CI 必須・資格情報なし）を通す
- `mise run verify:packaged` でパッケージ成果物の起動確認をする
- workflow `自走検証（Electron・依存の更新）` と、実機での kypr の確認
