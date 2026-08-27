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
  linkSplit,
  createWindow,
  findWindowIdForPageContents,
  markQuitting,
  openMiniWindow,
  selectTab,
  setExtensions,
  startBackgroundWork,
  stopBackgroundWork,
  windowsById
} from './registry.js'
import { installApplicationMenu, watchKeybindingChanges } from './menu.js'
import { installTabSwitcher } from './tab-switcher.js'
import { installRuntimeMarker } from './runtime-marker.js'
import { flushOpenUrls, handleSecondInstance, hasPendingOpenUrls, installOpenUrlHandler } from './open-url.js'
import { installDownloadHandler } from './downloads.js'
import { closeLogFile, log, logError, openLogFile } from './log.js'
import { closeSettings, getSettings, initSettings, updateSettings } from './store/settings.js'
import { closePins, initPins } from './store/pins.js'
import { closeDb, initDb } from './store/db.js'
import { pruneArchive } from './store/archive.js'
import { closePermissionStore, initPermissionStore } from './store/permissions.js'
import { closeSession, initSession, markCleanExit } from './store/session.js'
import { closeCallWindowStore, initCallWindowStore } from './store/call-window.js'
import { configureMeetTestUrlPrefix } from './meet-adapter.js'
import { configureGithubTestEndpoint } from './live-folders/github-pr.js'
import { configureTestAuth } from './live-folders/token.js'
import { startCallCoordinator, stopCallCoordinator } from './call-coordinator.js'
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
    // **隠した状態は再起動に持ち越さない**。
    // サイドバーを隠すと戻す手段が ⌘S だけになり（掴みしろを残していない）、
    // 空タブと重なると「操作の手がかりが何も無い真っ黒な窓」で起動する。
    // 設定ファイルの側も true に直しておく（実際の表示と食い違わせない）。
    if (!getSettings().sidebarVisible) {
      updateSettings({ sidebarVisible: true })
      log('sidebar.restored_on_launch', {})
    }
    initPins()
    initPermissionStore()
    initCallWindowStore()
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
    installTabSwitcher()
    // GitHub の endpoint の差し替え口（Live Folder の自走検証用）。
    // **ゲートは会議と同じ `!app.isPackaged`**。
    //
    // **差し替えが有効なあいだは、`token.ts` が実トークンを一切読まない**
    // （PAT も `gh auth token` も参照しない）。これをやらないと
    // 「環境変数1つで本物の PAT を任意のホストへ送れる」経路になる。
    const githubTestEndpoint = process.env['NEMO_GITHUB_TEST_ENDPOINT']
    if (githubTestEndpoint && !app.isPackaged) {
      configureGithubTestEndpoint(githubTestEndpoint)
      // 認証状態も注入できるようにする。差し替え中を常に「トークンあり」に固定すると、
      // `Connect GitHub` に到達する経路が無くなる
      configureTestAuth(process.env['NEMO_GITHUB_TEST_AUTH'] ?? 'dummy')
      log('live_folder.test_endpoint', { endpoint: githubTestEndpoint })
    } else if (githubTestEndpoint) {
      console.error('[nemo] パッケージ版では NEMO_GITHUB_TEST_ENDPOINT を無視した')
    }

    // **差し替えの設定は `startBackgroundWork()` より前**。
    // Live Folder は起動直後に1回取得しに行くので、後に置くと
    // その1回だけ本物の api.github.com へ実トークンで飛ぶ。
    startBackgroundWork()
    initUpdater()

    // 会議の判定 URL の差し替え口（自走検証用）。
    // **ゲートは `!app.isPackaged`**。`isDevChannel` では塞げない
    // （`paths.ts` は `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので、
    //  **dev パッケージでも `isDevChannel === true`** になり裏口が残る）。
    const meetTestPrefix = process.env['NEMO_MEET_TEST_URL_PREFIX']
    if (meetTestPrefix && !app.isPackaged) {
      configureMeetTestUrlPrefix(meetTestPrefix)
      log('call.test_url_prefix', { prefix: meetTestPrefix })
    } else if (meetTestPrefix) {
      console.error('[nemo] パッケージ版では NEMO_MEET_TEST_URL_PREFIX を無視した')
    }
    startCallCoordinator()

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
    //
    // **外部 URL で叩き起こされたかを先に見る**（計画 R6）。
    // 通常ウィンドウを作り終えてから外部 URL を流すと、その時点で
    // 「未起動から Slack のリンクを踏んだら Nemo が画面ごと前面に出る」になる。
    // pending があるなら通常ウィンドウは**背面で**復元し、小窓だけを出す。
    const wokenByUrl = hasPendingOpenUrls()
    const shouldRestore = getSettings().restoreSession && restored.windows.length > 0
    const startupWindows: ReturnType<typeof createWindow>[] = []
    if (shouldRestore) {
      log('session.restoring', {
        windows: restored.windows.length,
        cleanExit: restored.cleanExit,
        hidden: wokenByUrl
      })
      for (const saved of restored.windows) {
        const win = createWindow(undefined, {
          bounds: saved.bounds,
          noInitialTab: true,
          hidden: wokenByUrl
        })
        startupWindows.push(win)
        win.whenUiReady(() => {
          saved.tabs.forEach((tab) => {
            // 復元直後は WebContents を作らない（数十タブを一斉に立ち上げない）。
            // 選んだ時点で読み込まれる。
            //
            // ピン留め / Favorites のタブは**そもそもセッションに入っていない**
            // （枠をクリックした時点で作る）。ここで作るのは一時タブだけ。
            createTab(win, tab.url, {
              title: tab.title,
              // 渡し忘れると一時タブに付けた名前が再起動で消える
              customTitle: tab.customTitle,
              asleep: true,
              // 引き継がないと自動アーカイブの寿命が再起動のたびにリセットされる
              lastActiveAt: tab.lastActiveAt
            })
          })
          /*
           * 分割の関係だけを繋ぐ。**通常の `splitTabs` は使わない** ——
           * あれは右を選択して `applyVisibility()` を通すので、組の数だけ
           * WebContents が起きてしまい、「復元直後は寝かせたまま」が壊れる
           * （`lastActiveAt` も現在時刻に上書きされる）。
           *
           * **添字は全部まとめて先に解決してから繋ぐ**。1 組ずつ
           * 「添字を引く → 並べ替える」で処理すると、最初の並べ替えで
           * 後続の組の添字が別のタブを指す（`[[0,2],[1,3]]` のような
           * 交差する組で壊れる。`normalizeSession` は非隣接の組も通す）。
           * アクティブタブも並べ替えの前に控えておく。
           */
          const activeBefore = win.tabs[saved.activeIndex] ?? win.tabs[0] ?? null
          const pairs = saved.splits.flatMap(([leftIndex, rightIndex]) => {
            const left = win.tabs[leftIndex]
            const right = win.tabs[rightIndex]
            return left && right ? [[left, right] as const] : []
          })
          for (const [left, right] of pairs) linkSplit(win, left, right)

          // 選択は**最後に一度だけ**
          if (activeBefore) selectTab(win, activeBefore.key)
          win.layout()
        })
      }
    } else if (!wokenByUrl) {
      startupWindows.push(createWindow())
    } else {
      // 復元するセッションが無いなら、空の通常ウィンドウを前に出さない。
      // 小窓だけを出して、通常ウィンドウは必要になったときに作る。
      log('session.skipped_for_open_url', {})
    }

    // 起動時のタブが揃ってから ready にする。
    // 外（自走検証など）はこの合図を待ってから registry を見る。
    void markReadyWhen(startupWindows)

    // 溜まっていた外部 URL をここで流す。
    // ウィンドウが揃う前に開こうとすると createTab が拒否されて URL が消える。
    // 外部アプリからの URL は**必ず小窓**で開く（Nemo が前面にいても同じ）。
    //
    // **`app.focus({ steal: true })` は撃たない**。Phase 0 の実測で、撃つと
    // メインウィンドウの Space へ画面ごと切り替わることが分かっている
    // （＝「ちょっとだけ確認したい」が毎回作業の中断になる）。
    // 小窓は NSPanel なので、アプリを前面に出さずにキーフォーカスだけを受け取れる。
    const openExternalUrl = (url: string): void => {
      openMiniWindow(url)
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
  // **終了で閉じたぶんは ⌘⇧T に積まない**。積むと次の起動で
  // 「閉じたタブ」の先頭が前回終了時の小窓になる。
  markQuitting()
  // 正常終了。ここで書き切っておくと、次の起動が確実に最新のタブから始まる。
  markCleanExit(collectSession())
  stopBackgroundWork()
  stopUpdater()
  // 会議の小窓は復元しない。**ここで必ず破棄する**（webContents を残さない）
  stopCallCoordinator()
  closeSettings()
  closePins()
  closePermissionStore()
  closeSession()
  closeCallWindowStore()
  closeDb()
  log('app.quit', {})
  closeLogFile()
})
