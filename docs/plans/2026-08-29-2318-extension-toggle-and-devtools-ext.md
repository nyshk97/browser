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
- 登録（`scripts/lib/verify-targets.mjs` の `KNOWN_TARGETS` / `OWNERS`）と配線（`scripts/verify-all.mjs`）が分かれている。
  **登録だけして配線を忘れると 0 件で PASS する**（CLAUDE.md）。既存ファイルを触ったら `OWNERS` のエントリも広げる
- 常用の Nemo は検証で絶対に触らない（使い捨てプロファイルで別インスタンス）

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] なし（Web Store から CRX を取るだけ。資格情報不要）

### Phase 1: 拡張の端末ごと ON/OFF [AI🤖]

- [ ] 設定スキーマ: `NemoSettings.extensions.disabled: string[]`（拡張 ID の無効化リスト。既定 `[]`）。
      `src/shared/settings-schema.js` の `normalizeSettings` で「32 文字の `[a-p]`」以外は落とす
- [ ] `src/main/extensions.ts`
  - `loadLockedExtensions`: 無効化リストにある ID は整合性検証（`treeSha256`）だけして `loadExtension` を呼ばない。
    `LoadedExtensionInfo` に `enabled: boolean` を足し、無効なものも一覧に含める（設定画面に出すため）
  - `setExtensionEnabled(id, enabled)`: OFF → `removeExtension(id)`、ON → lock のエントリを再検証して `loadExtension`。
    どちらも `settings.extensions.disabled` を更新して保存。ログ `extension.enabled` / `extension.disabled`
  - lock に無い ID・検証に落ちるものは拒否（allowlist の性質を崩さない）
- [ ] IPC: `nemo:set-extension-enabled`（`src/main/ipc.ts` / `src/preload/ui.ts` / `src/shared/types.ts`）。
      `getExtensions` の戻りに `enabled` を含める
- [ ] 設定画面（`Settings.tsx`）: 拡張一覧の各行にトグル。OFF の行は名前を薄く。トグルの下に
      「OFF/ON したあと、開いているページはリロードが必要（DevTools は開き直し）」の一言
- [ ] 検証: `verify-ext-smoke.mjs` に追加
  - OFF にすると SW target が消え、content script がリロード後に入らない（**直前に入っていたこと**も示す）
  - ON に戻すと SW target が戻り、リロード後に content script が入る
  - `chrome.storage.local` の値が OFF→ON をまたいで残る
  - `settings.json` に `disabled` が書かれ、**再起動後も OFF のまま**（再起動をまたぐ検査は既存の枠に乗せる）
  - lock に無い ID を `setExtensionEnabled` に渡すと拒否される
- [ ] `verify-targets.mjs`: `src/main/extensions.ts` / `Settings.tsx` / `settings-schema.js` の `OWNERS` に `ext` を含める。
      **配線を外して 0 件になることを見てから**戻す
- [ ] `docs/CHANGELOG.md` `[Unreleased]` に追記。`VERIFY.md` に手順があれば追記
- [ ] コミット 1

### Phase 2: `chrome.debugger` スタブと GraphQL Network Inspector [AI🤖]

- [ ] 方針の書き換え: `src/main/registry.ts:177` / `:952` のコメントを「ページ側 preload に**特権 API は**載せない。
      拡張ページ（`chrome-extension://`）向けの `chrome.*` 補完だけ許す」に直す
- [ ] `src/preload/extension-shim.ts`（CJS で出す）: `location.href.startsWith('chrome-extension://')` のときだけ
      `contextBridge.executeInMainWorld` で `chrome.debugger` が無ければスタブを `defineProperty`。それ以外は即 return。
      Node / IPC には一切触らない
- [ ] `createExtensions()` の**前**に `session.registerPreloadScript({ id: 'nemo-extension-shim', type: 'frame', filePath })`。
      `electron.vite.config` の preload に `extension-shim` を追加。パッケージに含まれることを `mise run package` の
      既存検査（preload の同梱チェック）に足す
- [ ] `extensions.lock.json` に GraphQL Network Inspector を追加 → `mise run ext:fetch` → `ext:verify`
- [ ] 検証: `verify-ext-smoke.mjs` に追加
  - テスト拡張のページ（popup / options のどちらか既存のもの）で `typeof chrome.debugger === 'object'` かつ
    `chrome.debugger.onEvent.addListener` が呼べる（**ece の freeze より先に生えていること**の固定）
  - 素のページ（テストサーバの HTML）では `window.chrome?.debugger` が **無い**（漏れていない）
- [ ] 実機（使い捨てインスタンス）: 本物の GraphQL Network Inspector で DevTools パネルが描画され、
      `countries.trevorblades.com` への POST が一覧に出る（scratchpad の `_probe-gqli.mjs` を流用）
- [ ] `docs/compat.md`: 「`chrome.debugger` は Nemo のスタブ（呼んでも何も起きない）。WebSocket 捕捉は不可」を
      動かない API の表に追記。lock の表に GraphQL Network Inspector 2.26.1 の行
- [ ] `docs/CHANGELOG.md` `[Unreleased]` に追記
- [ ] コミット 2

### 動作確認 [人間👨‍💻]
- [ ] dev 版で設定画面を開き、Keepa を OFF → Amazon をリロードしてグラフが消える → ON → リロードで戻る
- [ ] Bitwarden を OFF→ON して、ログイン情報が残っている（vault はロックされる）
- [ ] GraphQL を使うサイトで DevTools → 「GraphQL Network」パネルに Query が並ぶ
- [ ] リリース（`mise run release`。個人 PC なのでセッションから叩いてもよいが、内容確認のうえ人間が実行）

## ログ
### 試したこと・わかったこと
（実装中に随時追記）

### 方針変更
（実装中に随時追記）
