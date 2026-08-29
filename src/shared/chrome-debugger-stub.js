// @ts-check
/**
 * 拡張ページ向けの `chrome.*` 補完（Electron に無い・足りない API を埋める）。
 *
 * 1. **`chrome.debugger` の空実装**（呼んでも何も起きない）。
 *    Electron は `chrome.debugger` を実装していない。GraphQL Network Inspector のように
 *    DevTools パネルの起動時に `chrome.debugger.onEvent.addListener` を呼ぶ拡張は、
 *    名前空間が無いだけで真っ白になる（2026-08-29 に実測）
 * 2. **`chrome.webRequest.*.addListener` の filter から `tabId` を外す**。
 *    Electron の `chrome.webRequest` イベントは `tabId: -1` で来る（2026-08-30 に実測）ので、
 *    `{ tabId }` で絞った listener は**一度も発火しない**。外すと全タブぶんが来るが、
 *    何も来ないよりよい（GraphQL Network Inspector はこれで新しいリクエストがライブで並ぶ）
 *
 * 配る経路は 2 つ（どちらもこの 1 つの関数を使う。中身を二重に持たない）:
 * - 通常の拡張ページ（popup / options 等のトップフレーム）: `src/preload/extension-shim.ts`
 * - DevTools の中の拡張 frame（devtools_page / パネル）: `src/main/devtools-shim.ts`
 *   （preload はサブフレームに配られないので、CDP で新規ドキュメントに注入する）
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない。
 */
export function installChromeDebuggerStub() {
  const scope = /** @type {{ chrome?: Record<string, any>, location?: { protocol: string } }} */ (globalThis)
  // 拡張ページ以外には生やさない（CDP 経路は URL で絞れないので、ここで見る）
  if (scope.location?.protocol !== 'chrome-extension:') return
  // 拡張ページには Chromium が `chrome` を生やしているが、無ければここで作っておく。
  // electron-chrome-extensions は `globalThis.chrome || {}` で**作ったオブジェクトを戻さない**ので、
  // ここで作らないと注入先が別オブジェクトになりうる
  if (!scope.chrome) scope.chrome = {}
  const chrome = scope.chrome

  // 1. chrome.debugger（既にあれば触らない: Electron が将来実装しても衝突しない）
  if (!chrome['debugger']) {
    const event = () => ({
      addListener() {},
      removeListener() {},
      hasListener: () => false
    })
    // Chrome 流の callback も呼ぶ（呼ばないと拡張側が永遠に待つ / Promise 版は resolve）。
    // `runtime.lastError` は立てられないので「成功したが何も起きない」に倒す
    /** @param {unknown[]} args */
    const noop = (...args) => {
      const callback = args[args.length - 1]
      if (typeof callback === 'function') callback()
      return Promise.resolve()
    }
    Object.defineProperty(chrome, 'debugger', {
      value: Object.freeze({
        onEvent: event(),
        onDetach: event(),
        attach: noop,
        detach: noop,
        sendCommand: noop,
        getTargets: /** @param {unknown[]} args */ (...args) => {
          const callback = args[args.length - 1]
          if (typeof callback === 'function') callback([])
          return Promise.resolve([])
        }
      }),
      enumerable: true,
      configurable: true,
      writable: false
    })
  }

  // 2. chrome.webRequest の tabId フィルタ（ネイティブ束縛が書き換え不可でも 1. は生きたまま残す）
  try {
    const webRequest = chrome['webRequest']
    if (!webRequest || typeof webRequest !== 'object') return
    for (const name of Object.keys(webRequest)) {
      const ev = webRequest[name]
      if (!ev || typeof ev.addListener !== 'function' || ev.__nemoTabIdStripped) continue
      const original = ev.addListener.bind(ev)
      ev.addListener = /** @param {unknown[]} args */ (...args) => {
        const filter = args[1]
        if (filter && typeof filter === 'object' && 'tabId' in filter) {
          const stripped = { .../** @type {Record<string, unknown>} */ (filter) }
          delete stripped['tabId']
          args[1] = stripped
        }
        return original(...args)
      }
      Object.defineProperty(ev, '__nemoTabIdStripped', { value: true })
    }
  } catch (error) {
    console.error('[nemo] chrome.webRequest の tabId 補完に失敗した', error)
  }
}

/** CDP の `Page.addScriptToEvaluateOnNewDocument` に渡す形。 */
export const CHROME_DEBUGGER_STUB_SOURCE = `(${installChromeDebuggerStub.toString()})();`
