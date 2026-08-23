import { app, session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { PAGE_PARTITION, UI_PARTITION, applyUserDataDir } from './paths.js'
import { applySessionSecurityDefaults } from './security.js'
import {
  createExtensions,
  loadLockedExtensions,
  watchExtensionPopups,
  watchServiceWorkerStatus
} from './extensions.js'
import { registerIpcHandlers, setLoadedExtensions } from './ipc.js'
import { createWindow, setExtensions, windowsById } from './registry.js'
import { installApplicationMenu } from './menu.js'
import { installRuntimeMarker } from './runtime-marker.js'
import { log, logError } from './log.js'

applyUserDataDir()

/**
 * dev 版でのみ remote debugging を開ける（Phase 1-10 でビルド種別に紐付ける）。
 * 明示的な env が無い限り開かない。packaged なアプリでは何があっても開かない。
 */
const remoteDebuggingPort = process.env['NEMO_REMOTE_DEBUGGING_PORT']
if (remoteDebuggingPort && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
  log('app.remote_debugging_enabled', { port: remoteDebuggingPort })
}

// 単一インスタンス（Phase 2-5 の既定ブラウザ対応の前提でもある）
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  createWindow()
})

app.whenReady().then(async () => {
  // 起動中であることを外から確実に見つけられるようにする（検証スクリプトのガード用）
  installRuntimeMarker()

  const pageSession = session.fromPartition(PAGE_PARTITION)
  const uiSession = session.fromPartition(UI_PARTITION)

  applySessionSecurityDefaults(pageSession, 'page')
  applySessionSecurityDefaults(uiSession, 'ui')

  // <browser-action-list> のアイコンは UI セッションで表示されるので、
  // crx:// は UI セッション側で扱う
  ElectronChromeExtensions.handleCRXProtocol(uiSession)

  // 拡張のロードより先に生成する（ロードイベントを取りこぼさないため）
  const extensions = createExtensions(pageSession)
  setExtensions(extensions)
  watchServiceWorkerStatus(pageSession)
  watchExtensionPopups(extensions)

  registerIpcHandlers()
  installApplicationMenu()

  try {
    const loaded = await loadLockedExtensions(pageSession)
    setLoadedExtensions(loaded)
  } catch (error) {
    logError('extension.lock_read_failed', error)
    setLoadedExtensions([])
  }

  createWindow()
  log('app.ready', {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: app.getPath('userData')
  })
}).catch((error: unknown) => {
  logError('app.ready_failed', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (windowsById.size === 0) createWindow()
})
