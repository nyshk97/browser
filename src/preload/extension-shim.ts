import { contextBridge } from 'electron'
import { installChromeDebuggerStub } from '../shared/chrome-debugger-stub.js'
import { installStorageOnChangedPolyfill } from '../shared/chrome-storage-onchanged.js'
import { installPermissionsQueryShim } from '../shared/permissions-query-shim.js'

/**
 * ページ・拡張コンテキスト向けの main world 補完。**frame と service worker の両方に
 * この 1 ファイルを配る**（`extensions.ts` の `registerExtensionShim` が `type: 'frame'` /
 * `'service-worker'` で 2 回登録する。シークレットセッションへは `src/main/page-shim.ts` が
 * frame だけ登録する。2 ファイルに分けると共有モジュールが chunk に割られ、
 * sandbox の preload は chunk を require できない）。
 *
 * - 拡張ページ（`chrome-extension://` のトップフレーム）: `chrome.debugger` の空実装
 *   （`src/shared/chrome-debugger-stub.js`）と `chrome.storage.*.onChanged` の補完
 * - 拡張の service worker: `chrome.storage.*.onChanged` の補完（`src/shared/chrome-storage-onchanged.js`。
 *   Electron 41 は SW 側で onChanged を鳴らさない）
 * - http / https のページ: `navigator.permissions.query` の「未決定 = prompt」読み替え
 *   （`src/shared/permissions-query-shim.js`。Google Meet の初回詰み対策）
 * - **それ以外では何もしない**（素のページに `chrome.debugger` を漏らさず、
 *   拡張ページの query には触らない）
 * - `electron-chrome-extensions` の preload は最後に `Object.freeze(chrome)` するので、
 *   この preload は**それより先に登録**されている必要がある（`index.ts` の登録順を参照）
 * - **サブフレームには配られない**（Electron の preload はトップフレームだけ）。DevTools の中の
 *   拡張 frame は `src/main/devtools-shim.ts` が CDP で補う
 * - Node / IPC には一切触らない。特権 API は載せない
 */

// preload の tsconfig には DOM の型が無いので、location は globalThis 経由で読む
const href = (globalThis as { location?: { href: string } }).location?.href ?? ''
const isServiceWorker = process.type === 'service-worker'
if (isServiceWorker || href.startsWith('chrome-extension://')) {
  try {
    if (!isServiceWorker) contextBridge.executeInMainWorld({ func: installChromeDebuggerStub })
    contextBridge.executeInMainWorld({ func: installStorageOnChangedPolyfill })
  } catch (error) {
    console.error(`[nemo] extension shim failed (${isServiceWorker ? 'service worker' : href})`, error)
  }
} else if (href.startsWith('http://') || href.startsWith('https://')) {
  try {
    contextBridge.executeInMainWorld({ func: installPermissionsQueryShim })
  } catch (error) {
    console.error(`[nemo] permissions query shim failed (${href})`, error)
  }
}
