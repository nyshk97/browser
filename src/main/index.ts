import { app, session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { APP_ID, PAGE_PARTITION, UI_PARTITION, applyUserDataDir, channel, isDevChannel } from './paths.js'
import { applySessionSecurityDefaults, installAuthHandler, installCertificateHandler } from './security.js'
import { registerUiScheme, handleUiScheme } from './protocol.js'
import {
  createExtensions,
  loadLockedExtensions,
  watchExtensionPopups,
  watchServiceWorkerStatus
} from './extensions.js'
import { registerIpcHandlers, setLoadedExtensions } from './ipc.js'
import {
  collectSession,
  createTab,
  createWindow,
  findWindowIdForPageContents,
  focusedOrFirstWindow,
  selectTab,
  setExtensions,
  startBackgroundWork,
  stopBackgroundWork,
  windowsById
} from './registry.js'
import { installApplicationMenu, watchKeybindingChanges } from './menu.js'
import { installRuntimeMarker } from './runtime-marker.js'
import { flushOpenUrls, handleSecondInstance, installOpenUrlHandler } from './open-url.js'
import { installDownloadHandler } from './downloads.js'
import { closeLogFile, log, logError, openLogFile } from './log.js'
import { closeSettings, getSettings, initSettings } from './store/settings.js'
import { closePins, initPins } from './store/pins.js'
import { closeDb, initDb } from './store/db.js'
import { pruneArchive } from './store/archive.js'
import { closePermissionStore, initPermissionStore } from './store/permissions.js'
import { closeSession, initSession, markCleanExit } from './store/session.js'
import { markReadyWhen, setExtensionCount } from './app-status.js'
import { initUpdater, stopUpdater } from './updater.js'
import { getDefaultBrowserStatus } from './default-browser.js'

applyUserDataDir()
app.setAppUserModelId(APP_ID)

/**
 * main プロセスの例外でブラウザごと止めない。
 *
 * 既定では Electron がエラーダイアログを出してアプリが使えなくなる。
 * 一日中開いているブラウザでそれをやられると、開いていたタブごと失う。
 * **握りつぶすのではなく診断ログに残す**（`app.uncaught_exception` で追える）。
 */
process.on('uncaughtException', (error) => {
  logError('app.uncaught_exception', error)
})
process.on('unhandledRejection', (reason) => {
  logError('app.unhandled_rejection', reason)
})

// custom protocol の登録は app.ready より前でなければならない
registerUiScheme()

// 外部アプリからの URL は **ready より前に**購読する。
// ready を待つと、未起動から開かれたときの URL を取りこぼす。
installOpenUrlHandler()

/**
 * dev 版でのみ remote debugging を開ける。
 * 明示的な env が無い限り開かない。**常用版（stable）では何があっても開かない**
 * （CDP に到達できるものは拡張の service worker で任意の JS を実行でき、
 * アンロック済み Vault の中身に手が届く）。
 */
const remoteDebuggingPort = process.env['NEMO_REMOTE_DEBUGGING_PORT']
if (remoteDebuggingPort && isDevChannel) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
} else if (remoteDebuggingPort) {
  console.error('[nemo] 常用版では remote debugging を開かない（NEMO_REMOTE_DEBUGGING_PORT を無視した）')
}

// 単一インスタンス（Phase 2-5 の既定ブラウザ対応の前提でもある）
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', (_event, argv) => {
  // macOS では外部 URL は open-url で来る。argv に乗るのは macOS 以外の経路。
  // URL が乗っていなければ「もう一度アプリを開いた」= 新規ウィンドウ。
  if (!handleSecondInstance(argv)) createWindow()
})

app
  .whenReady()
  .then(async () => {
    openLogFile()
    if (remoteDebuggingPort && isDevChannel) {
      log('app.remote_debugging_enabled', { port: remoteDebuggingPort })
    }

    // 起動中であることを外から確実に見つけられるようにする（検証スクリプトのガード用）
    installRuntimeMarker()

    initSettings()
    initPins()
    initPermissionStore()
    initDb()
    pruneArchive()
    const restored = initSession()

    const pageSession = session.fromPartition(PAGE_PARTITION)
    const uiSession = session.fromPartition(UI_PARTITION)

    applySessionSecurityDefaults(pageSession, 'page', findWindowIdForPageContents)
    applySessionSecurityDefaults(uiSession, 'ui', findWindowIdForPageContents)
    installCertificateHandler(findWindowIdForPageContents)
    installAuthHandler(findWindowIdForPageContents)
    installDownloadHandler(pageSession)

    // ブラウザ UI は nemo://ui/ から配信する（file:// を使わない）
    handleUiScheme(uiSession)

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
    watchKeybindingChanges()
    startBackgroundWork()
    initUpdater()

    try {
      const loaded = await loadLockedExtensions(pageSession)
      setLoadedExtensions(loaded)
      setExtensionCount(loaded.length)
    } catch (error) {
      logError('extension.lock_read_failed', error)
      setLoadedExtensions([])
      setExtensionCount(0)
    }

    // セッション復元（正常終了後もクラッシュ後も同じ経路で戻す）
    const shouldRestore = getSettings().restoreSession && restored.windows.length > 0
    const startupWindows: ReturnType<typeof createWindow>[] = []
    if (shouldRestore) {
      log('session.restoring', {
        windows: restored.windows.length,
        cleanExit: restored.cleanExit
      })
      for (const saved of restored.windows) {
        const win = createWindow(undefined, { bounds: saved.bounds, noInitialTab: true })
        startupWindows.push(win)
        win.whenUiReady(() => {
          saved.tabs.forEach((tab) => {
            // 復元直後は WebContents を作らない（数十タブを一斉に立ち上げない）。
            // 選んだ時点で読み込まれる。
            createTab(win, tab.url, {
              pinnedId: tab.pinnedId,
              title: tab.title,
              asleep: true
            })
          })
          const active = win.tabs[saved.activeIndex] ?? win.tabs[0]
          if (active) selectTab(win, active.key)
          win.layout()
        })
      }
    } else {
      startupWindows.push(createWindow())
    }

    // 起動時のタブが揃ってから ready にする。
    // 外（自走検証など）はこの合図を待ってから registry を見る。
    void markReadyWhen(startupWindows)

    // 溜まっていた外部 URL をここで流す。
    // ウィンドウが揃う前に開こうとすると createTab が拒否されて URL が消える。
    const openExternalUrl = (url: string): void => {
      const win = focusedOrFirstWindow()
      if (win) {
        createTab(win, url)
        win.baseWindow.focus()
      } else {
        createWindow(url)
      }
      app.focus({ steal: true })
    }
    if (startupWindows.length > 0) {
      startupWindows[0].whenUiSettled(() => flushOpenUrls(openExternalUrl))
    } else {
      flushOpenUrls(openExternalUrl)
    }

    const defaultBrowser = getDefaultBrowserStatus()
    log('default_browser.state', {
      isDefault: defaultBrowser.isDefault,
      canRequest: defaultBrowser.canRequest
    })

    log('app.ready', {
      channel,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      restored: shouldRestore
    })
  })
  .catch((error: unknown) => {
    logError('app.ready_failed', error)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (windowsById.size === 0) createWindow()
})

app.on('before-quit', () => {
  // 正常終了。ここで書き切っておくと、次の起動が確実に最新のタブから始まる。
  markCleanExit(collectSession())
  stopBackgroundWork()
  stopUpdater()
  closeSettings()
  closePins()
  closePermissionStore()
  closeSession()
  closeDb()
  log('app.quit', {})
  closeLogFile()
})
