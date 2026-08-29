import { contextBridge } from 'electron'
import { installChromeDebuggerStub } from '../shared/chrome-debugger-stub.js'

/**
 * 拡張ページ（`chrome-extension://`）向けの `chrome.*` 補完。中身は
 * `src/shared/chrome-debugger-stub.js` を参照。
 *
 * - **拡張ページ以外では何もしない**（素のページに `chrome.debugger` を漏らさない）
 * - `electron-chrome-extensions` の preload は最後に `Object.freeze(chrome)` するので、
 *   この preload は**それより先に登録**されている必要がある（`index.ts` の登録順を参照）
 * - **サブフレームには配られない**（Electron の preload はトップフレームだけ）。DevTools の中の
 *   拡張 frame は `src/main/devtools-shim.ts` が CDP で補う
 * - Node / IPC には一切触らない。特権 API は載せない
 */

// preload の tsconfig には DOM の型が無いので、location は globalThis 経由で読む
const href = (globalThis as { location?: { href: string } }).location?.href ?? ''
if (href.startsWith('chrome-extension://')) {
  try {
    contextBridge.executeInMainWorld({ func: installChromeDebuggerStub })
  } catch (error) {
    console.error(`[nemo] extension shim failed (${href})`, error)
  }
}
