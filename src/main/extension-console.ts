import path from 'node:path'
import { log } from './log.js'
import { redactUrl } from './security.js'

/**
 * 拡張の SW / content script の console（warning / error）を診断ログに残す。
 * **`NEMO_EXT_CONSOLE=1` のときだけ**動く（本文には URL・メール等が載りうるので常用版では出さない。
 * 実 Vault で「Bitwarden の内部でどこが止まっているか」を追うための dev 用スイッチ）。
 * URL は `redactUrl` を行単位で通してから書く。
 */
export const extensionConsoleEnabled = process.env['NEMO_EXT_CONSOLE'] === '1'

function redactLines(text: string): string {
  return text
    .split('\n')
    .slice(0, 6)
    .map((line) => line.replace(/https?:\/\/\S+|chrome-extension:\/\/\S+/g, (u) => redactUrl(u)))
    .join(' | ')
    .slice(0, 200)
}

export function watchExtensionConsole(session: Electron.Session): void {
  if (!extensionConsoleEnabled) return
  session.serviceWorkers.on('console-message', (_event, details) => {
    // level: 0 verbose, 1 info, 2 warning, 3 error
    if (details.level < 2) return
    log('extension.sw_console', {
      versionId: details.versionId,
      level: details.level === 3 ? 'error' : 'warning',
      source: details.source,
      file: path.basename(details.sourceUrl ?? ''),
      line: details.lineNumber,
      message: redactLines(details.message)
    })
  })
  log('extension.console_watch_enabled', {})
}

/** ページ側の console のうち、拡張（content script）由来のものだけ残す。 */
export function watchPageExtensionConsole(contents: Electron.WebContents): void {
  if (!extensionConsoleEnabled) return
  contents.on('console-message', (event) => {
    if (event.level !== 'error' && event.level !== 'warning') return
    const src = event.sourceId ?? ''
    if (!src.startsWith('chrome-extension://')) return
    log('extension.page_console', {
      webContentsId: contents.id,
      level: event.level,
      source: path.basename(src),
      line: event.lineNumber,
      message: redactLines(event.message)
    })
  })
}
