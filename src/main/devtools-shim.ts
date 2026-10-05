import type { Debugger, WebContents } from 'electron'
import { CHROME_DEBUGGER_STUB_SOURCE } from '../shared/chrome-debugger-stub.js'
import { CHROME_STORAGE_ONCHANGED_SOURCE } from '../shared/chrome-storage-onchanged.js'
import { buildDevToolsFrameSource } from '../shared/devtools-extension-api.js'
import { log, logError } from './log.js'

/**
 * DevTools の画面（`devtools://`）で `InspectorFrontendHost.setInjectedScriptForOrigin` を横取りし、
 * 渡された拡張 API のスクリプトを origin ごとに `globalThis.__nemoExtensionApis` に控える（#2）。
 * 元の呼び出しはそのまま通す（Electron 側が直れば、そちらも効く）。
 *
 * DevTools の画面が拡張を登録するのは inspected のページに繋がってから（`devtools-opened` より後）なので、
 * attach の直後に入れれば間に合う（2026-10-05 に実測: 横取りを入れたのが 170ms、登録が 270ms）。
 * 間に合わなかったときは `late` に数が出る（その拡張にはパネルが出ない）。
 */
const HOOK_EXTENSION_APIS_SOURCE = `(() => {
  const host = globalThis.InspectorFrontendHost
  if (!host || typeof host.setInjectedScriptForOrigin !== 'function') return JSON.stringify({ hooked: false, late: 0 })
  const store = (globalThis.__nemoExtensionApis ??= {})
  if (!host.__nemoHooked) {
    const original = host.setInjectedScriptForOrigin
    host.setInjectedScriptForOrigin = function (origin, script) {
      store[origin] = script
      return original.call(this, origin, script)
    }
    Object.defineProperty(host, '__nemoHooked', { value: true })
  }
  const late = [...document.querySelectorAll('iframe')]
    .map((frame) => { try { return new URL(frame.src).origin } catch { return '' } })
    .filter((origin) => origin.startsWith('chrome-extension://') && !(origin in store)).length
  return JSON.stringify({ hooked: true, late })
})()`

const READ_EXTENSION_APIS_SOURCE = 'JSON.stringify(globalThis.__nemoExtensionApis ?? {})'

/**
 * DevTools の中の拡張 frame（devtools_page / パネル）に、Electron が配らない・配れなくなった API を入れる。
 *
 * - `chrome.debugger` の空実装・`chrome.storage.onChanged` の補完（`src/shared/` の 2 つ）
 * - `chrome.devtools.*`（Electron 42 以降は Electron の注入が効かない。#2）
 *
 * 組み立ては `src/shared/devtools-extension-api.js`（ece の preload が凍らせた `chrome` の差し替えもそこ）。
 *
 * 拡張の DevTools パネルは DevTools フロントエンドの中の `chrome-extension://` iframe で、
 * **Nemo の preload（`src/preload/extension-shim.ts`）はこの frame で効かない**（Electron 41 では届かなかった。
 * 2026-08-29 に自作テスト拡張で実測: options ページには届き、パネルには届かない。44 では ece の preload が
 * 先に `chrome` を凍らせている）。そこで DevTools の webContents に `webContents.debugger` で付き、
 * 子 target（別プロセスの iframe は別 target になる）へ `Page.addScriptToEvaluateOnNewDocument`
 * で入れる。
 *
 * - attach 時点の target の URL は空（初期ドキュメント）なので、**URL では絞れない**。
 *   frame（page / iframe）の target すべてに入れ、各スクリプトの側で origin を見て拡張ページ以外では何もしない。
 *   worker 等の frame でない target は Page ドメインが無いので注入せず即再開する
 * - `chrome.devtools.*` のスクリプトは、子 target が付いた時点で DevTools の画面に控えてあるものを読む
 *   （DevTools の画面は `setInjectedScriptForOrigin` を呼んでから iframe を作るので、その時点で揃っている）
 * - `waitForDebuggerOnStart` で「スクリプトが走る前」に入れ、すぐ再開する
 * - DevTools を閉じれば webContents ごと消えるので、明示的な後片付けは不要
 * - `devtools-opened` がもう一度来たら（DevTools の画面の読み直しを想定。来るかは未確認）、debugger は付いたままなので
 *   横取りだけ入れ直す。読み直しで横取りが登録に間に合わないと、その DevTools では拡張のパネルが出ない
 * - frame に入れる `chrome.devtools` のスクリプトは、子 target が付いた時点の写し（その後 DevTools の画面が
 *   同じ origin に渡し直しても、そのセッションの注入は差し替えない）
 */
export function attachDevToolsExtensionShim(pageContents: WebContents): void {
  const contents = pageContents.devToolsWebContents
  if (!contents || contents.isDestroyed()) return
  const dbg = contents.debugger
  if (dbg.isAttached()) {
    hookExtensionApis(dbg)
    return
  }

  try {
    dbg.attach('1.3')
  } catch (error) {
    logError('devtools.shim_attach_failed', error)
    return
  }

  dbg.on('message', (_event, method, params: unknown) => {
    if (method !== 'Target.attachedToTarget') return
    const { sessionId, waitingForDebugger, targetInfo } = params as {
      sessionId: string
      waitingForDebugger: boolean
      targetInfo: { type: string; url: string }
    }
    const resume = (): void => {
      if (!waitingForDebugger) return
      dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
    }
    // DevTools フロントエンドは worker target（formatter / heap snapshot 等）も作る。Page ドメインが無いので
    // 送ると reject → error ログが積まれるだけ。スタブが要るのは frame だけなので、それ以外は即再開する
    if (targetInfo.type !== 'page' && targetInfo.type !== 'iframe') {
      resume()
      return
    }
    let extensionApis = 0
    readExtensionApis(dbg)
      .then((apis) => {
        extensionApis = Object.keys(apis).length
        // **`Page.enable` が要る**: これ無しで `addScriptToEvaluateOnNewDocument` を送っても、
        // 初期ドキュメント（about:blank、DevTools のプロセス）から拡張のプロセスへ移るときに
        // 失われ、パネルの document では走らない（2026-08-30 に実測）
        return dbg.sendCommand('Page.enable', {}, sessionId).then(() =>
          dbg.sendCommand(
            'Page.addScriptToEvaluateOnNewDocument',
            {
              source: buildDevToolsFrameSource(
                [CHROME_DEBUGGER_STUB_SOURCE, CHROME_STORAGE_ONCHANGED_SOURCE],
                apis
              )
            },
            sessionId
          )
        )
      })
      .then(() => log('devtools.shim_injected', { target: targetInfo.type, extensionApis }))
      .catch((error) => logError('devtools.shim_inject_failed', error, { target: targetInfo.type }))
      .finally(resume)
  })

  // 横取りは子 target の自動 attach より先に送る（同じセッションのコマンドは順に処理される）
  hookExtensionApis(dbg)
  dbg
    .sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    .then(() => log('devtools.shim_attached', {}))
    .catch((error) => logError('devtools.shim_auto_attach_failed', error))
}

function hookExtensionApis(dbg: Debugger): void {
  evaluateJson(dbg, HOOK_EXTENSION_APIS_SOURCE)
    .then((value) => {
      const { hooked, late } = (value ?? {}) as { hooked?: boolean; late?: number }
      log('devtools.ext_api_hooked', { hooked: hooked === true, late: late ?? 0 })
    })
    .catch((error) => logError('devtools.ext_api_hook_failed', error))
}

/** DevTools の画面に控えた拡張 API のスクリプト（origin → script）。読めなければ空（パネルは出ないが他の補完は入れる） */
async function readExtensionApis(dbg: Debugger): Promise<Record<string, string>> {
  try {
    const value = await evaluateJson(dbg, READ_EXTENSION_APIS_SOURCE)
    return value && typeof value === 'object' ? (value as Record<string, string>) : {}
  } catch (error) {
    logError('devtools.ext_api_read_failed', error)
    return {}
  }
}

/** DevTools の画面（root セッション）で式を評価し、JSON 文字列の結果を読む */
async function evaluateJson(dbg: Debugger, expression: string): Promise<unknown> {
  const { result } = (await dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { value?: unknown }
  }
  return typeof result?.value === 'string' ? (JSON.parse(result.value) as unknown) : null
}
