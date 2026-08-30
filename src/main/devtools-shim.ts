import type { WebContents } from 'electron'
import { CHROME_DEBUGGER_STUB_SOURCE } from '../shared/chrome-debugger-stub.js'
import { CHROME_STORAGE_ONCHANGED_SOURCE } from '../shared/chrome-storage-onchanged.js'
import { log, logError } from './log.js'

/**
 * DevTools の中の拡張 frame（devtools_page / パネル）に `chrome.debugger` の空実装を配る。
 *
 * 拡張の DevTools パネルは DevTools フロントエンドの中の `chrome-extension://` iframe で、
 * **Electron の preload はサブフレームに配られない**（`session.registerPreloadScript` の
 * `type: 'frame'` でも同じ。2026-08-29 に自作テスト拡張で実測: options ページには届き、
 * パネルには届かない）。そこで DevTools の webContents に `webContents.debugger` で付き、
 * 子 target（別プロセスの iframe は別 target になる）へ `Page.addScriptToEvaluateOnNewDocument`
 * で同じスタブを入れる。
 *
 * - attach 時点の target の URL は空（初期ドキュメント）なので、**URL では絞れない**。
 *   frame（page / iframe）の target すべてに入れ、スタブ側で `location.protocol === 'chrome-extension:'` を
 *   見て拡張ページ以外では何もしない（`CHROME_DEBUGGER_STUB_SOURCE`）。worker 等の frame でない target は
 *   Page ドメインが無いので注入せず即再開する
 * - `waitForDebuggerOnStart` で「スクリプトが走る前」に入れ、すぐ再開する
 * - DevTools を閉じれば webContents ごと消えるので、明示的な後片付けは不要
 */
export function attachDevToolsExtensionShim(pageContents: WebContents): void {
  const contents = pageContents.devToolsWebContents
  if (!contents || contents.isDestroyed()) return
  const dbg = contents.debugger
  if (dbg.isAttached()) return

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
    // **`Page.enable` が要る**: これ無しで `addScriptToEvaluateOnNewDocument` を送っても、
    // 初期ドキュメント（about:blank、DevTools のプロセス）から拡張のプロセスへ移るときに
    // 失われ、パネルの document では走らない（2026-08-30 に実測）
    dbg
      .sendCommand('Page.enable', {}, sessionId)
      .then(() =>
        dbg.sendCommand(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: `${CHROME_DEBUGGER_STUB_SOURCE}\n${CHROME_STORAGE_ONCHANGED_SOURCE}` },
          sessionId
        )
      )
      .then(() => log('devtools.shim_injected', { target: targetInfo.type }))
      .catch((error) => logError('devtools.shim_inject_failed', error, { target: targetInfo.type }))
      .finally(resume)
  })

  dbg
    .sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    .then(() => log('devtools.shim_attached', {}))
    .catch((error) => logError('devtools.shim_auto_attach_failed', error))
}
