// @ts-check
/**
 * DevTools の中の拡張 frame（devtools_page / パネル）に入れるスクリプトを 1 本に組み立てる（#2）。
 *
 * 本来は DevTools の画面が拡張ごとに `InspectorFrontendHost.setInjectedScriptForOrigin(origin, script)` を呼び、
 * Electron（`InspectableWebContents::DidFinishNavigation`）がその origin の frame で `script(id)` を実行して
 * `chrome.devtools` を生やす。**Electron 42 以降はこの frame の document が、`electron-chrome-extensions` の
 * preload が最後に `Object.freeze(chrome)` した状態で始まる**（2026-10-05 に 44.5.1 で実測: document の開始時点で
 * `Object.isFrozen(chrome) === true`、`window.chrome` 自体は writable / configurable）。
 * DevTools のスクリプトは strict mode なので `chrome.devtools` を足すところで TypeError になり、
 * Nemo の `chrome.debugger` の空実装も同じ理由で入らない。
 *
 * そこで `src/main/devtools-shim.ts` が `Page.addScriptToEvaluateOnNewDocument` でこのスクリプトを入れる:
 *
 * 1. `chrome` が凍っていたら、**同じ中身の凍っていない複製**に差し替える（プロパティ記述子と prototype ごと写す）
 * 2. 補完（`chrome.debugger` の空実装等）を 1 つずつ走らせる（1 つが落ちても残りは走る）
 * 3. DevTools の画面から横取りした `chrome.devtools` のスクリプトのうち、frame の origin に合うものを走らせる
 * 4. 1. で差し替えたなら freeze し直す（ece が凍らせた状態に戻す）
 *
 * - スクリプトは**文字列のまま埋め込む**（frame の中で `eval` すると拡張ページの CSP `script-src 'self'` に止められる）
 * - DevTools のスクリプトは `chrome.devtools` が既にあれば何もしないので、Electron 側の注入が後から走っても二重にならない
 * - 引数の `injectedScriptId` は Electron と同じく frame ごとの乱数（リモートオブジェクトの ID の接頭辞に使われる）
 * - 拡張ページ（`chrome-extension:`）以外では何もしない（CDP 経路は URL で絞れないので、ここで見る）
 *
 * @param {string[]} shims 補完のソース（それぞれ単独で実行できる文）
 * @param {Record<string, string>} scripts origin（`chrome-extension://<id>`。末尾の `/` なし）→ DevTools が渡したスクリプト
 * @returns {string}
 */
export function buildDevToolsFrameSource(shims, scripts) {
  const guarded = (/** @type {string} */ source, /** @type {string} */ what) =>
    `try {\n${source}\n} catch (error) { console.error(${JSON.stringify(`[nemo] ${what}に失敗した`)}, error); }`
  const branches = Object.entries(scripts)
    .filter(
      ([origin, script]) => origin.startsWith('chrome-extension://') && typeof script === 'string' && script
    )
    .map(
      ([origin, script]) =>
        `if (origin === ${JSON.stringify(origin)}) {\n${guarded(`(${script})(id);`, 'chrome.devtools の注入')}\n}`
    )
  return [
    `(() => {`,
    `if (globalThis.location?.protocol !== 'chrome-extension:') return;`,
    `const origin = globalThis.location.origin;`,
    `const id = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);`,
    `const frozen = Boolean(globalThis.chrome) && Object.isFrozen(globalThis.chrome);`,
    `if (frozen) {`,
    guarded(
      `const original = globalThis.chrome;\n` +
        `globalThis.chrome = Object.create(Object.getPrototypeOf(original), Object.getOwnPropertyDescriptors(original));\n` +
        // sloppy mode なので書き込めない `window.chrome` への代入は黙って失敗する。ここで落として原因の近くにログを残す
        `if (globalThis.chrome === original) throw new Error('window.chrome を差し替えられない');`,
      'chrome の複製'
    ),
    `}`,
    ...shims.map((source) => guarded(source, '拡張 frame の補完')),
    branches.join(' else '),
    `if (frozen) Object.freeze(globalThis.chrome);`,
    `})();`
  ].join('\n')
}
