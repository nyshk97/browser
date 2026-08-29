# 拡張の端末ごと ON/OFF と GraphQL Network Inspector の導入

## 概要・やりたいこと

1. **拡張を端末ごとに ON/OFF できるようにする**（設定画面のトグル。再起動なし）
   - lock は「アプリに何を同梱するか」（全端末共通）、設定は「この端末で何を動かすか」に役割を分ける
   - 新規 PC では**全部 ON**。OFF にしたい事情があった端末だけ OFF にする
   - 拡張が変な状態で止まったときの「再起動ボタン」としても使う（OFF→ON で service worker と
     `chrome.storage.session` が作り直される。ただし開いているページの content script は
     リロードしないと再注入されないので、その旨をトグル近くに出す）
2. **GraphQL Network Inspector**（`ndlbedplllcgconngcnfmkadhokfaaln`, Web Store のみ）を lock に載せる
   - DevTools パネルが起動時に `chrome.debugger.onEvent.addListener` を呼び、Electron に `chrome.debugger` が
     無いため真っ白になる（2026-08-29 に使い捨てインスタンスで実測）
   - `chrome.debugger` の**空実装**を `chrome-extension://` のページに生やせば描画され、HTTP 経由の GraphQL を
     捕捉する（`Q country 200 411 B 193ms` まで確認済み）。WebSocket（Subscriptions）タブは常に空のまま
   - そのために **Nemo 自前のページ側 preload を 1 本足す**。`registry.ts` の「ページ側 preload は
     そもそも指定しない」という方針の文言を、実態（`electron-chrome-extensions` の preload が既に
     session 全体で走っている）に合わせて書き換える

順番は **1 → 2**。GraphQL 拡張は半端さ（WebSocket が空）があるので、要らない端末で切れる状態を先に作る。
関心が独立しているので **2 コミットに分ける**。

### 決めたこと

- サイドバーのフッターには **ON の拡張だけ**出す（OFF は設定画面にしか出ない。`getExtensions` は lock 全件を
  `enabled` 付きで返し、フッター側で `enabled` を絞る。1回目で決定）
- `chrome.debugger` スタブは **`chrome-extension://` の全ページ**に配る（拡張 ID で絞らない。Electron が実装したら
  `chrome.debugger` が既にあるので自動的に退く。1回目で決定）
- lock から消えた ID が `settings.extensions.disabled` に残っても放置する（害が無く、lock に無い ID は
  `setExtensionEnabled` で拒否される。1回目で決定）
- OFF にした拡張の `chrome-extension://` タブが開きっぱなしでも閉じない（放置。1回目で決定）
- `webRequest.*.addListener` の filter から `tabId` を外す補完も **`chrome-extension://` の全ページ**に配る
  （拡張 ID で絞らない。service worker には配らない）。Bitwarden / Keepa は `{ tabId }` 付きの listener を
  持たず（Bitwarden の webRequest は background で使っており対象外）、影響が無い（実装レビュー 1 回目で決定）
- ON なのにロードに失敗した拡張は一覧に `enabled: true, matchesLock: false` で残す（「lock 不一致」表示に載せ、
  OFF→ON で再ロードを試せる。実装レビュー 1 回目で決定）

## 前提・わかっていること

### 拡張のロード経路（現状）

- `src/main/extensions.ts` `loadLockedExtensions`: lock の全エントリを `treeSha256` 照合 → `loadExtension`。
  有効/無効の概念は無い。`removeExtension` は lock 不一致のときの巻き戻しに既に使っている（`extensions.ts:128`）
- lock は `extensions.lock.json`（Bitwarden 2026.8.0 / Keepa 5.64 の 2 件）。`chrome-web-store` ソースは
  2026-08-29 に `ext-fetch` へ実装済み（CRX のヘッダを剥がし公開鍵を `manifestKey` に記録。版が違えば止める）
- 設定画面（`src/renderer/components/Settings.tsx:54-64`）は拡張の一覧と「オプション」リンクを出すだけ
- `settings.json`（`src/main/store/settings.ts` → `<userData>/settings.json`）は**端末ごと**。かつての端末間同期は
  廃止済み（`scripts/lib/nemo-data.mjs` 冒頭）。端末ローカルの ON/OFF を置く場所として適切
- `chrome.storage.local` は OFF にしても Chromium のプロファイルに残る（ON に戻せば設定は元どおり）。
  `chrome.storage.session` は消える（Bitwarden なら vault がロックされる）

### preload まわり

- Nemo の preload は UI（`nemo://ui/`）向けの `src/preload/ui.ts` だけ。**ページ側には無い**
  （`src/main/registry.ts:177` `PAGE_WEB_PREFERENCES` のコメント、`:952` スワイプ判定のコメント）
- `electron-chrome-extensions` 4.9.0 は `prependPreload` で `session.registerPreloadScript({ type: 'frame' })` と
  `{ type: 'service-worker' }` を登録し、preload 内で `location.href.startsWith('chrome-extension://')` のときだけ
  `chrome.*` を main world に生やす（`contextBridge.executeInMainWorld`）。**最後に `Object.freeze(chrome)`** する
  → Nemo のスタブは ece の preload より**先に**登録し、`Object.defineProperty(chrome, 'debugger', ...)` で
  生やす（後から足すと freeze で失敗する）。ece の構築は `createExtensions()`（`extensions.ts:353`）
- `sandbox: true` の preload は ESM 不可・`node_modules` require 不可 → CJS で出す（`electron.vite.config` に
  ui preload の同じ設定がある）

### GraphQL Network Inspector 2.26.1 の実測（使い捨てインスタンス、Electron 41.10.6 + ece 4.9.0）

| 項目 | 結果 |
|---|---|
| ロード / SW 起動 | OK |
| `devtools_page` | OK。`chrome.devtools.panels.create` のコールバックが発火し、DevTools のパネル一覧 10 番目に「GraphQL Network」が出る（⌘] で順送りして到達） |
| パネル描画 | NG: `Cannot read properties of undefined (reading 'onEvent')`。バンドル内で `chrome.debugger.onEvent.addListener` / `onDetach` を参照 |
| `chrome.debugger` スタブ注入後 | 描画 OK。`chrome.devtools.network.getHAR` / `onRequestFinished` で HTTP の GraphQL を捕捉 |
| SW 内の `chrome.debugger` | `MISSING`（manifest に `debugger` permission はあるが Electron は生やさない） |

スタブの中身（実測で足りた最小）:
`onEvent` / `onDetach` = `{ addListener, removeListener, hasListener }`、`attach` / `sendCommand` = reject、
`detach` = resolve、`getTargets` = `[]`。**`chrome.debugger` が無いときだけ**生やす（Electron が将来実装しても衝突しない）

### 検証ハーネス

- `mise run verify:ext`（`scripts/verify-ext-smoke.mjs`）: 自作テスト拡張（`test-extension/`）で CI 必須の smoke。
  使い捨ての userData / ext dir で回す。`connectUi` → `window.nemo.*`、`listTargets` で SW / iframe を拾える
- `verify-ext-smoke.mjs` は `UNMAPPED_VERIFY_SCRIPTS`（`verify-all.mjs` の**外**、CI は `ci.yml` の別ジョブ）。
  `KNOWN_TARGETS` に `ext` は無く、`OWNERS` は「フル実行から 1 スイートへ絞る」仕掛けなので**今回は触らない**
  （`extensions.ts` / `Settings.tsx` / `settings-schema.js` の変更は今どおりフル実行に倒れる）
- 常用の Nemo は検証で絶対に触らない（使い捨てプロファイルで別インスタンス）

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] なし（Web Store から CRX を取るだけ。資格情報不要）

### Phase 1: 拡張の端末ごと ON/OFF [AI🤖]

- [x] 設定スキーマ: `NemoSettings.extensions.disabled: string[]`（拡張 ID の無効化リスト。既定 `[]`）。
      `src/shared/settings-schema.js` の `normalizeSettings` で `EXTENSION_ID_RE`（`src/shared/ext-lock.js`）に
      合わないものは落とす。`extensions` はネストなので `normalizeSettings` で毎回組み立て直す（`updateSettings` の
      浅いマージで消えないよう未指定キーは既定で埋める）。同じ場所の「版を上げると同期先の古い Nemo が拒否する」
      コメントは同期廃止に合わせて直す
- [x] `src/main/extensions.ts`
  - `loadLockedExtensions`: 無効化リストにある ID は `treeSha256` 照合も `loadExtension` も**しない**（OFF の間は
    コストゼロ。検証は ON に戻すときだけ）。`LoadedExtensionInfo` に `enabled: boolean` を足し、OFF の行も一覧に
    含める。OFF の行は `name` / `version` を lock から取り、`optionsUrl: null`（「設定を開く」は ON のときだけ）、
    `matchesLock: true`（照合していないので警告を出さない。型のコメントに書く）
  - **UI 用の一覧（OFF 込み）と allowlist 用の ID（ON のみ）は別の値**として返す。`setLoadedExtensionIds`
    （`chrome-extension://` ナビゲーション許可）と `setExtensionCount`（起動ステータス）には ON の分だけ流す
  - 1 エントリぶんの「整合性照合 → `loadExtension` → id/version 照合 → SW 起動（遅延リトライ込み）→
    `LoadedExtensionInfo`」を関数に切り出し、起動時とトグルの両方が同じものを通す（SW 起動が抜けると
    「再起動ボタン」にならない）
  - `setExtensionEnabled(id, enabled)`: OFF → `removeExtension(id)`、ON → 上の関数を通す。
    どちらも `settings.extensions.disabled` を更新して保存し、**一覧を作り直して `setLoadedExtensions` と
    `setLoadedExtensionIds` を更新**。ログ `extension.enabled` / `extension.disabled`
  - lock に無い ID・検証に落ちるものは拒否（allowlist の性質を崩さない）
- [x] IPC: `nemo:set-extension-enabled`（`src/main/ipc.ts` / `src/preload/ui.ts` / `src/shared/types.ts`）。
      一覧は新チャンネルでなく **`SharedState` に `extensions` を足して `pushShared()` に相乗り**させる
      （`onPinsChanged` 等と同じ形）。`Settings.tsx` / `Sidebar.tsx` の mount 時 `getExtensions()` も
      `useSharedState()` に寄せる（二重経路を残さない）
- [x] 設定画面（`Settings.tsx`）: 拡張一覧の各行にトグル。OFF の行は名前を薄く、「オプション」リンクを出さない。
      トグルの下に「OFF/ON したあと、開いているページはリロードが必要（DevTools は開き直し）」の一言。
      `Sidebar.tsx` のフッターは先に `enabled` で絞った配列を作り、「拡張なし」判定も lock 不一致バッジも
      その配列で出す（描画だけ絞ると全部 OFF の端末で空フッターになる）
- [x] 検証: `verify-ext-smoke.mjs` に追加
  - OFF にすると SW target が消え（`removeExtension` 直後は止まっていない可能性があるので `waitFor` で消失を待つ）、
    content script がリロード後に入らない（**直前に入っていたこと**も示す）
  - OFF 中の `chrome-extension://<id>/` へのナビゲーションが拒否される（allowlist から外れていること）
  - ON に戻すと SW target が戻り、リロード後に content script が入る
  - `chrome.storage.local` の値が OFF→ON をまたいで残る
  - `settings.json` に `disabled` が書かれ、**再起動後も OFF のまま**（再起動をまたぐ検査は既存の枠に乗せる）
  - lock に無い ID を `setExtensionEnabled` に渡すと拒否される
- [ ] ~~`verify-targets.mjs` の `OWNERS` を広げる~~（`verify-ext-smoke` は `verify-all` の外。「前提 > 検証ハーネス」参照）
- [x] `docs/CHANGELOG.md` `[Unreleased]` に追記。`VERIFY.md` に手順があれば追記
- [ ] コミット 1

### Phase 2: `chrome.debugger` スタブと GraphQL Network Inspector [AI🤖]

- [x] 方針の書き換え: `src/main/registry.ts:177` / `:952` のコメントを「ページ側 preload に**特権 API は**載せない。
      拡張ページ（`chrome-extension://`）向けの `chrome.*` 補完だけ許す」に直す
- [x] **先にプローブ**: 使い捨てインスタンスで、DevTools パネルの frame（`chrome-extension://` の iframe）で
      `registerPreloadScript({ type: 'frame' })` の preload が実際に走ることを 1 本で確かめる（既存の実測は
      「スタブ注入後に描画 OK」であって preload 経由の確認ではない）。走らなければ shim を書く前に
      配送方式を変える（DevTools 側の webContents にフックする案）
- [x] `src/preload/extension-shim.ts`（CJS で出す）: `location.href.startsWith('chrome-extension://')` のときだけ
      `contextBridge.executeInMainWorld` で、`globalThis.chrome` が無ければ `globalThis.chrome = {}` を作ってから
      `chrome.debugger` が無ければスタブを `defineProperty`（ece は `globalThis.chrome || {}` で作ったオブジェクトを
      globalThis に戻さないので、ここで作っておかないと注入先が別オブジェクトになりうる）。それ以外は即 return。
      Node / IPC には一切触らない
- [x] `createExtensions()` の**前**に `session.registerPreloadScript({ id: 'nemo-extension-shim', type: 'frame', filePath })`。
      登録順＝実行順に依存しているので、その理由をコードのコメントに残す。
      `electron.vite.config` の preload に `extension-shim` を追加。パッケージに含まれることを `mise run package` の
      既存検査（preload の同梱チェック）に足す
- [x] `extensions.lock.json` に GraphQL Network Inspector を追加（`id` / `name` / `version` / `source.url` だけ書き、
      hash は `ext:fetch` に埋めさせる）→ `mise run ext:fetch` → `ext:verify`。Store の配信版が 2.26.1 でなく
      版違いで止まったら `ext-fetch.mjs --update <version> --id <id>`
- [x] 検証: `verify-ext-smoke.mjs` に追加
  - テスト拡張のページ（popup / options のどちらか既存のもの）で `typeof chrome.debugger === 'object'` かつ
    `chrome.debugger.onEvent.addListener` が呼べ、**同時に `chrome.runtime.id` も生きている**（ece の注入先が
    ずれていないこと・**ece の freeze より先に生えていること**の固定）
  - 素のページ（テストサーバの HTML）では `window.chrome?.debugger` が **無い**（漏れていない）
  - `test-extension` に `devtools_page` を 1 枚足し、smoke で DevTools を開いて**パネル frame** に `chrome.debugger` が
    生えていることまで見る（Electron / ece 更新でパネルへの preload 配送が壊れたとき CI で気づくため。
    「先にプローブ」のコードを昇格させる。ユーザー決定）
- [x] 実機（使い捨てインスタンス）: 本物の GraphQL Network Inspector で DevTools パネルが描画され、
      `countries.trevorblades.com` への POST が一覧に出る（scratchpad の `_probe-gqli.mjs` を流用）
- [x] `docs/compat.md`: 「`chrome.debugger` は Nemo のスタブ（呼んでも何も起きない）。WebSocket 捕捉は不可」を
      動かない API の表に追記。lock の表に GraphQL Network Inspector 2.26.1 の行
- [x] `docs/CHANGELOG.md` `[Unreleased]` に追記
- [ ] コミット 2

### 動作確認 [人間👨‍💻]
- [ ] dev 版で設定画面を開き、Keepa を OFF → Amazon をリロードしてグラフが消える → ON → リロードで戻る
- [ ] Bitwarden を OFF→ON して、ログイン情報が残っている（vault はロックされる）
- [ ] GraphQL を使うサイトで DevTools → 「GraphQL Network」パネルに Query が並ぶ
- [ ] リリース（`mise run release`。個人 PC なのでセッションから叩いてもよいが、内容確認のうえ人間が実行）

## ログ
### 試したこと・わかったこと
- 2026-08-29: ページから `chrome-extension://` へのトップレベル遷移は ON でも既存方針（3c）で拒否されるので、
  「OFF で allowlist から外れる」の検査は `openExtensionOptions` が開かないことで見る（chrome.tabs.create も同じ allowlist）
- 2026-08-29: **`registerPreloadScript({ type: 'frame' })` の preload は DevTools パネルの frame に届かない**
  （options ページには届く。Electron の preload はサブフレームに配られない）。プローブで判明したので、
  DevTools の webContents に `webContents.debugger` で付いて `Target.setAutoAttach` → 拡張 target に
  `Page.addScriptToEvaluateOnNewDocument` で同じスタブを入れる方式（`src/main/devtools-shim.ts`）に切り替え。
  スタブ本体は `src/shared/chrome-debugger-stub.js` の 1 関数に寄せ、preload と CDP の両方がそれを使う
- 2026-08-29: **Web Store の CRX に入っている `_metadata/` を Chromium が初回ロード時に消す**ため、
  treeSha256 に含めると 2 回目以降の起動で `extension.integrity_failed` になる（Keepa も同じ。既存バグ）。
  `ext-fetch` で展開時に `_metadata/` を落とすようにし、Keepa / GraphQL の lock の treeSha256 を更新
- 2026-08-30: CDP 経路は **`Page.enable` してから `addScriptToEvaluateOnNewDocument`** でないと、初期ドキュメント
  （about:blank）から拡張プロセスへ移るときに消える。attach 時点の target URL は空なので URL で絞れず、
  全 target に入れてスタブ側で `location.protocol === 'chrome-extension:'` を見る
- 2026-08-30: パネルは描画されても新しいリクエストがライブで並ばなかった。原因は **Electron の `chrome.webRequest`
  イベントが `tabId: -1`** で来ること（拡張は `{ tabId }` で filter していて一度も発火しない）。スタブで
  `webRequest.*.addListener` の filter から `tabId` を外したらライブで並んだ（実機: `Q LiveQuery 200 494 B`）。
  `chrome.debugger.attach` は reject でなく callback を呼ぶ no-op にした（拡張側の `Uncaught (in promise)` を消す）
- 2026-08-30: 実機（使い捨てインスタンス、lock の 3 拡張をロード）で DevTools の GraphQL Network パネルに
  `Q ProbeQuery` / `Q LiveQuery` が並ぶことを確認。main の error ログ 0 件、パネルの例外 0 件

### 方針変更
- 2026-08-29: `verify-targets.mjs` の OWNERS ステップは plan レビュー時に取り消し（`verify-ext-smoke` は verify-all の外）
- 2026-08-29: DevTools パネルへのスタブ配送は preload でなく CDP（上記「試したこと」参照）。通常の拡張ページ向けの
  preload はそのまま残す（popup / options では preload が効く）
