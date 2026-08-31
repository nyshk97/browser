import { app, session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { APP_ID, PAGE_PARTITION, UI_PARTITION, applyUserDataDir, channel, isDevChannel } from './paths.js'
import { applySessionSecurityDefaults, installAuthHandler, installCertificateHandler } from './security.js'
import { registerUiScheme, handleUiScheme } from './protocol.js'
import {
  createExtensions,
  registerExtensionShim,
  loadLockedExtensions,
  watchExtensionPopups,
  watchServiceWorkerStatus
} from './extensions.js'
import { watchExtensionConsole } from './extension-console.js'
import { registerIpcHandlers } from './ipc.js'
import { getLoadedOkExtensions, setLoadedExtensions } from './extension-state.js'
import {
  collectSession,
  createTab,
  linkSplit,
  createWindow,
  findTabByWebContents,
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
import { sampleMetrics } from './metrics.js'
import { initTimings } from './timings.js'
import { closeSettings, getSettings, initSettings, updateSettings } from './store/settings.js'
import { backfillFavicons, closePins, initPins } from './store/pins.js'
import {
  closeEphemeralTabs,
  findEphemeralTab,
  getEphemeralTabs,
  initEphemeralTabs
} from './store/ephemeral-tabs.js'
import { closeDb, initDb } from './store/db.js'
import { getFaviconsByUrlOrHost } from './store/history.js'
import { pruneArchive } from './store/archive.js'
import { closePermissionStore, initPermissionStore } from './store/permissions.js'
import { closeSession, initSession, markCleanExit } from './store/session.js'
import { closeCallWindowStore, initCallWindowStore } from './store/call-window.js'
import { closeHttpAuthStore, initHttpAuthStore } from './store/http-auth.js'
import { initSecretBackend } from './store/secret-backend.js'
import { stopHttpAuthMatcher } from './http-auth-matcher.js'
import { configureMeetTestUrlPrefix } from './meet-adapter.js'
import { configureGithubTestEndpoint } from './live-folders/github-pr.js'
import { configureTestAuth } from './live-folders/token.js'
import { startCallCoordinator, stopCallCoordinator } from './call-coordinator.js'
import { markReadyWhen, setExtensionCount } from './app-status.js'
import { initUpdater, stopUpdater } from './updater.js'

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

/**
 * ブラウザの言語を OS の言語に合わせる。
 *
 * Electron は起動時に自分の locale を bundle のローカライズから解決するので、
 * OS が日本語でも `app.getLocale()` が `en-US` になり、`navigator.language` と
 * `Accept-Language` が `en-US,ja-JP` の順で送られる（サイトが英語で出る）。
 * `--lang` は ready より前に積まないと効かない。外から明示されたときはそれを尊重する。
 */
if (!app.commandLine.hasSwitch('lang')) {
  const preferred = app.getPreferredSystemLanguages()[0]
  if (preferred) app.commandLine.appendSwitch('lang', toChromiumLocale(preferred))
}

/**
 * OS の言語タグ（`ja-JP`）を Chromium が持つ UI locale に丸める。
 * Chromium は `ja-JP` を知らず、知らない値は黙って `en-US` に倒す（実測）。
 * 地域付きで区別している locale だけそのまま通し、それ以外は言語サブタグにする。
 */
function toChromiumLocale(tag: string): string {
  const regional = new Set(['en-GB', 'en-US', 'es-419', 'pt-BR', 'pt-PT', 'zh-CN', 'zh-TW', 'zh-HK', 'fr-CA'])
  if (regional.has(tag)) return tag
  return tag.split('-')[0] ?? tag
}

/**
 * UA から `Electron/x.y.z` トークンを剥がす。
 *
 * このトークンを UA スニッフィングで弾くサイトがある。Teams はこれを
 * 「提供終了したクラシック Teams デスクトップアプリ」と誤判定して
 * 未ログインでも `/error/eoa` へ 302 する（実測。`Electron/` だけ除去すれば
 * `/v2` に通り、`nemo/x.y.z` は無害）。Google ログインの安全でないブラウザ判定も同類。
 */
app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/\S+/, '')

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
    // **ストアの初期化より前**。セッション保存のデバウンスは `initSession()` が
    // `JsonStore` を作る時点で確定するので、後に置くと片方だけ本番値のまま残る。
    initTimings()
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
    // **`initSession()` より前**。旧版セッションの移行（`initSession` の中で走る）が
    // 一時タブの共有定義ストアへ書き込むので、後だと移行が空振りする
    initEphemeralTabs()
    initPermissionStore()
    initCallWindowStore()
    // **認証ハンドラ・IPC 登録より前**（暗号化 backend の解決 → ストアの読み込みの順）
    initSecretBackend()
    initHttpAuthStore()
    initDb()
    // 定義の favicon を履歴から埋める（**DB を開いた後・ウィンドウ復元の前**に 1 回。
    // 開く前だと列の有無が分からず黙って no-op になる）
    backfillFavicons(getFaviconsByUrlOrHost)
    pruneArchive()
    const restored = initSession()

    const pageSession = session.fromPartition(PAGE_PARTITION)
    const uiSession = session.fromPartition(UI_PARTITION)

    applySessionSecurityDefaults(pageSession, 'page', findWindowIdForPageContents)
    applySessionSecurityDefaults(uiSession, 'ui', findWindowIdForPageContents)
    installCertificateHandler(findWindowIdForPageContents)
    installAuthHandler(findWindowIdForPageContents, (contents) => {
      // **strict な解決**。タブでない WebContents は自動入力の対象にしない
      const found = findTabByWebContents(contents)
      return found ? { isPrivate: found.win.isPrivate } : null
    })
    installDownloadHandler(pageSession)

    // ブラウザ UI は nemo://ui/ から配信する（file:// を使わない）
    handleUiScheme(uiSession)

    // <browser-action-list> のアイコンは UI セッションで表示されるので、
    // crx:// は UI セッション側で扱う
    ElectronChromeExtensions.handleCRXProtocol(uiSession)

    // 拡張ページ向けの `chrome.*` 補完（`chrome.debugger` の空実装）。
    // **`createExtensions()` より前に登録する**: preload は登録順に走り、
    // electron-chrome-extensions の preload が最後に `Object.freeze(chrome)` するので、
    // 後から登録すると生やせない（Electron に順序の明示的な保証は無いので smoke で固定している）
    registerExtensionShim(pageSession)

    // 拡張のロードより先に生成する（ロードイベントを取りこぼさないため）
    const extensions = createExtensions(pageSession)
    setExtensions(extensions)
    watchServiceWorkerStatus(pageSession)
    watchExtensionConsole(pageSession)
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

    let extensionCount = 0
    try {
      await loadLockedExtensions(pageSession)
      // 起動ステータスの件数はロードできたものだけ（OFF もロード失敗も含めない）
      extensionCount = getLoadedOkExtensions().length
    } catch (error) {
      logError('extension.lock_read_failed', error)
      setLoadedExtensions([])
    }
    setExtensionCount(extensionCount)

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
          /*
           * 版 5: 野良タブの正は共有定義ストアにある。ウィンドウには
           * **アクティブ定義と分割の構成員だけ**を `asleep` で実体化する
           * （それ以外の定義はサイドバーに出るだけで、クリック時に実体化される）。
           * 複数ウィンドウが同じ定義をアクティブにしていた場合はそのまま両方で実体化する
           * （Arc と同じ。plan の決定表参照）。
           */
          const wanted: string[] = []
          if (saved.activeEphemeralId) wanted.push(saved.activeEphemeralId)
          for (const [left, right] of saved.splits) wanted.push(left, right)
          const byDef = new Map<string, ReturnType<typeof createTab>>()
          const materialize = (defId: string): void => {
            const def = findEphemeralTab(defId)
            if (!def || byDef.has(def.id)) return
            // 復元直後は WebContents を作らない（選んだ時点で読み込まれる）。
            // `lastActiveAt` を引き継がないと自動アーカイブの寿命がリセットされる
            const tab = createTab(win, def.url, {
              ephemeralId: def.id,
              title: def.title,
              asleep: true,
              lastActiveAt: def.lastActiveAt
            })
            if (tab.ephemeralId === def.id) byDef.set(def.id, tab)
          }
          for (const defId of new Set(wanted)) materialize(defId)
          // アクティブがピン / Favorite だった（= null で保存）・定義が消えていたウィンドウは
          // **先頭定義へ倒す**（旧実装の `Math.max(findIndex, 0)` と同等。倒さないと
          // 再起動でそのウィンドウが空状態で立ち上がる）
          if (byDef.size === 0) {
            const first = getEphemeralTabs()[0]
            if (first) materialize(first.id)
          }
          /*
           * 分割の関係だけを繋ぐ。**通常の `splitTabs` は使わない** ——
           * あれは右を選択して `applyVisibility()` を通すので、組の数だけ
           * WebContents が起きてしまい、「復元直後は寝かせたまま」が壊れる
           * （`lastActiveAt` も現在時刻に上書きされる）。
           */
          for (const [leftId, rightId] of saved.splits) {
            const left = byDef.get(leftId)
            const right = byDef.get(rightId)
            if (left && right) linkSplit(win, left, right)
          }

          // 選択は**最後に一度だけ**。アクティブ定義が消えていたら先頭の実体へ倒す
          const active = (saved.activeEphemeralId ? byDef.get(saved.activeEphemeralId) : null) ?? null
          const chosen = active ?? win.normalTabs[0] ?? null
          if (chosen) selectTab(win, chosen.key)
          win.layout()
        })
      }
    } else if (!wokenByUrl) {
      // 復元するものが無くても空タブは作らない。起動直後は「タブなし」の
      // 空状態（EmptyState）で待ち、最初のタブは ⌘T やサイドバーから作る。
      startupWindows.push(createWindow(undefined, { noInitialTab: true }))
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

    // `readyMs` は**タブが揃う前**の値（復元は `whenUiReady` のコールバックで走る）。
    // 実体化されるのはアクティブ定義と分割の構成員だけなので、その数を保存データから数える
    log('app.ready', {
      channel,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      restored: shouldRestore,
      readyMs: Math.round(process.uptime() * 1000),
      restoredTabs: shouldRestore
        ? restored.windows.reduce(
            (n, w) =>
              n + new Set([...(w.activeEphemeralId ? [w.activeEphemeralId] : []), ...w.splits.flat()]).size,
            0
          )
        : 0,
      extensions: extensionCount
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
  // 終了時の負荷を 1 行残す（`metrics.sample` と同じ形。集計は両方を読む）。タイマーを止める前に取る。
  // **診断の 1 行が終了処理を人質に取らない**（投げたら DB とログが閉じないまま落ちる）
  let lastSample: ReturnType<typeof sampleMetrics> | null = null
  try {
    lastSample = sampleMetrics()
  } catch {
    /* 記録できなくても終了処理は続ける */
  }
  stopBackgroundWork()
  stopUpdater()
  // 会議の小窓は復元しない。**ここで必ず破棄する**（webContents を残さない）
  stopCallCoordinator()
  closeSettings()
  closePins()
  // `JsonStore` はデバウンス保存なので flush 必須（書き戻し・lastActiveAt の直近分が落ちる）
  closeEphemeralTabs()
  closePermissionStore()
  closeSession()
  // `JsonStore` はデバウンス保存なので、flush しないと直前の変更が落ちる
  closeHttpAuthStore()
  stopHttpAuthMatcher()
  closeCallWindowStore()
  closeDb()
  log('app.quit', lastSample ? { source: 'quit', ...lastSample } : {})
  closeLogFile()
})
