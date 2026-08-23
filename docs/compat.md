# 互換性の記録（last-known-good）

Nemo は Electron と `electron-chrome-extensions` の組み合わせが壊れやすい。
**「最新版」で検証しない。ここに書いた組み合わせだけを正とする。**

## last-known-good

| 項目 | バージョン | 備考 |
|---|---|---|
| Electron | **41.10.6** | Chromium 146.0.7680.216 / Node 22.22.1 |
| `electron-chrome-extensions` | **4.9.0** | GPL-3.0 + Patron License のデュアル |
| `electron-chrome-web-store` | **0.13.0** | MIT。Nemo では Web Store 経路を使わず、CRX の公開鍵取得のロジックだけ参考にしている |
| `electron-vite` | 5.0.0 | vite 7.3.6 |
| React | 19.2.8 | |
| Bitwarden 拡張 | **2026.8.0** | `bitwarden/clients` の `dist-chrome-2026.8.0.zip` |

検証日: 2026-08-23 / 検証機: macOS 15（Darwin 25.5.0, arm64）

## Electron 42 以降を避けている理由

`samuelmaddock/electron-browser-shell#184` に、Electron 42 以降で
`electron-chrome-extensions` のアイコン・popup が壊れるという未解決の報告がある。
Phase 0 では **41 系の最新（41.10.6）を採用**し、42 以降には上げていない。

Electron を上げる PR では次を必ず通す（Phase 1-10 / Phase 2-6）:

1. CI 必須の拡張互換 smoke test（資格情報なし・決定的）
2. Bitwarden での最終確認（保護 workflow）
3. 通ったらこの表を更新する。**落ちたら Electron は据え置く**

## 検証済みの動作（Electron 41.10.6 + ece 4.9.0 + Bitwarden 2026.8.0）

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
| `chrome.declarativeNetRequest` | **名前空間ごと存在しない**。広告ブロックを内蔵するなら `webRequest` に寄せるか拡張に任せる（Phase 3） |
| `chrome.sidePanel` | 名前空間はあるが `setOptions` が無い |
| `chrome.commands` | `getAll()` は返るが **shortcut がすべて空文字**。`electron-chrome-extensions` の `CommandsAPI` は manifest を一覧にするだけで、**アクセラレータを登録せず `onCommand` も dispatch しない**（`globalShortcut` / `commands.onCommand` の呼び出しがソースに1つも無い）。`onCommand.addListener` は呼べてしまうが**永久に発火しない** → 拡張のキーボードショートカット（Bitwarden の ⌘⇧L 自動入力・⌘⇧Y popup など）は動かない |

`chrome.storage` は `local` / `session` / `sync` のいずれも読み書きできた
（Electron 公式ドキュメントは `local` のみと書いているが、`electron-chrome-extensions` が補っている）。

## 更新のたびに要る作業

- `better-sqlite3` を対象 Electron の ABI 向けに rebuild する（Phase 1 以降）
- 両拡張ライブラリの preload script が成果物に含まれることを検査する（Phase 1-1）
