import { app, clipboard, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { PAGE_PARTITION, userDataPath } from './paths.js'
import { restartServiceWorkers } from './extensions.js'
import { log, logError } from './log.js'
import {
  addFavoriteFromTab,
  applySlot,
  createTab,
  createWindow,
  findWindowByUiWebContents,
  moveTabToWindow,
  openFavorite,
  openPinned,
  pinTabInto,
  removeFavoriteEverywhere,
  promoteForegroundView,
  removeTab,
  renameTab,
  selectTab,
  separateSplit,
  splitTabs,
  togglePin,
  openPrivateWindow,
  unpinEverywhere,
  updatePinnedUrlFromTab,
  type NemoTab,
  type NemoWindow,
  type OverlayKind
} from './registry.js'
import { isUiUrl, normalizeNavigationInput } from './security.js'
import { runCommandForWindow, selectTabByIndexIn } from './menu.js'
import { COMMANDS, SELECT_TAB_ACCELERATORS } from '../shared/keybindings.js'
import { answerPrompt, currentPrompt } from './prompts.js'
import { advanceSwitcher, cancelSwitcher, currentSwitcherState, pickSwitcherTab } from './tab-switcher.js'
import { suggest } from './suggest.js'
import { getSettings, updateSettings } from './store/settings.js'
import {
  createFolder,
  getFavorites,
  getPinned,
  moveFavorite,
  movePinned,
  renameNode,
  toggleFolder
} from './store/pins.js'
import {
  appVersion,
  defaultSlotName,
  deleteSlot,
  ensureSlotsDir,
  hostName,
  listSlots,
  readSlot,
  renameSlot,
  saveSlot
} from './store/slots.js'
import {
  buildSlot,
  collectIcons,
  countPinnedLinks,
  iconCandidates,
  MAX_SLOT_ICONS,
  SLOT_COUNT
} from '../shared/slots-schema.js'
import {
  deleteVault,
  forgetPassphrase,
  hasRememberedPassphrase,
  openVault,
  recallPassphrase,
  rememberPassphrase,
  saveVault,
  vaultStatus
} from './store/auth-vault.js'
import { diffAuthRules } from '../shared/auth-vault-diff.js'
import type { ImportEntry } from '../shared/http-auth-rules.js'
import { MAX_PASSPHRASE, MIN_PASSPHRASE, validatePassphrase } from '../shared/auth-vault-schema.js'
import { cancelDownload, clearDownloads, revealDownload } from './downloads.js'
import { clearHistory, getFavicons, queryHistory, removeHistory } from './store/history.js'
import { clearArchive, queryArchive, removeArchived } from './store/archive.js'
import { getAppStatus } from './app-status.js'
import { isCallWindowContents } from './call-window.js'
import { focusCallTarget, getCallState, toggleCallDevice } from './call-coordinator.js'
import { checkForUpdatesManually, promptRestart } from './updater.js'
import {
  isLiveFolderUrl,
  liveFolderCredentialsChanged,
  liveFolderKeyOf,
  liveFolderSettingChanged,
  refreshLiveFolderNow
} from './live-folders/index.js'
import { clearToken, hasToken, resolveToken, saveToken, tokenStorageAvailable } from './live-folders/token.js'
import { isGithubTestEndpoint } from './live-folders/github-pr.js'
import {
  deleteHttpAuthRule,
  httpAuthEncryptionAvailable,
  importHttpAuthRules,
  listHttpAuthRules,
  readAllCredentials,
  readAllForDiff,
  revealHttpAuthPassword,
  saveHttpAuthRule,
  setHttpAuthRuleEnabled
} from './store/http-auth.js'
import { httpAuthCredentialsChanged } from './http-auth-reset.js'
import { matchHttpAuthRules } from './http-auth-matcher.js'
import { getTimings } from './timings.js'
import { HTTP_AUTH_LIMITS, importMultipass, validateHttpAuthPattern } from '../shared/http-auth-rules.js'
import { windowsById } from './registry.js'
import type {
  AppStatus,
  AuthVaultFailure,
  AuthVaultLoadPreview,
  AuthVaultLoadResult,
  AuthVaultSavePreview,
  AuthVaultSaveResult,
  AuthVaultStatus,
  CallState,
  HttpAuthImportResult,
  HttpAuthRule,
  HttpAuthTestResult,
  HttpAuthWriteResult,
  LoadedExtensionInfo,
  PromptAnswer,
  SlotList,
  SharedState,
  SplitDiagnostics,
  WindowState
} from '../shared/types.js'

/**
 * IPC は必ず「送信元が登録済みウィンドウの UI WebContents か」と
 * 「対象タブがそのウィンドウのものか」を検証する。
 * これを省くと、悪意あるページが他タブを操作できる経路になる。
 *
 * 引数の型も1つずつ検査する（`unknown` で受けて narrow する）。
 */

let loadedExtensions: LoadedExtensionInfo[] = []

export function setLoadedExtensions(extensions: LoadedExtensionInfo[]): void {
  loadedExtensions = extensions
}

function requireWindow(event: IpcMainInvokeEvent): NemoWindow {
  const win = findWindowByUiWebContents(event.sender)
  if (!win) {
    log('ipc.rejected', { reason: 'unknown_sender', senderId: event.sender.id })
    throw new Error('sender is not a Nemo UI window')
  }
  // WebContents の同一性だけでは足りない。
  // その WebContents が **今どの origin にいるか** も見る。
  // UI View が何らかの経路で外部ページへ遷移していた場合、
  // ここを見ないと外部ページに特権 API を使わせてしまう
  // （遷移自体は registry の lockUiNavigation で塞いでいるが、二重にする）。
  if (!isUiUrl(senderFrameUrl(event))) {
    log('ipc.rejected', { reason: 'sender_not_ui_origin', windowId: win.id })
    throw new Error('sender is not on the Nemo UI origin')
  }
  return win
}

/**
 * 送信元フレームの URL。
 * メインフレーム以外からの IPC は受け付けない（UI に iframe は無い）。
 * 破棄済みフレームの `url` は投げることがあるので必ず包む。
 */
function senderFrameUrl(event: IpcMainInvokeEvent): string {
  try {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return ''
    return frame.url
  } catch {
    return ''
  }
}

/**
 * 会議の小窓（`?view=call`）からの IPC を検証する。
 *
 * `requireWindow` は通せない —— 会議の小窓は `NemoWindow` ではなく
 * `windowsById` にも居ないので、必ず `unknown_sender` で弾かれる。
 * **`windowsById` に無理に登録もしない**（`sweepSleep` など既存の全ループが
 * タブ前提で舐めており、タブを持たないウィンドウを混ぜると壊れる）。
 *
 * 検査は `requireWindow` と**同じ二段**にする。
 * 1. 送信元が coordinator が持っている小窓の UI WebContents 自身であること
 * 2. `isUiUrl(senderFrameUrl(event))` で origin を見ること
 */
function requireCallWindow(event: IpcMainInvokeEvent): void {
  if (!isCallWindowContents(event.sender)) {
    log('ipc.rejected', { reason: 'unknown_sender', senderId: event.sender.id })
    throw new Error('sender is not the Nemo call window')
  }
  if (!isUiUrl(senderFrameUrl(event))) {
    log('ipc.rejected', { reason: 'sender_not_ui_origin', channel: 'call' })
    throw new Error('sender is not on the Nemo UI origin')
  }
}

/**
 * `ui.error` 用の送信元検査。**throw しない**。
 *
 * `requireWindow` → 失敗なら `requireCallWindow` の二段で書くと、会議の小窓からの正常系で
 * 毎回 `ipc.rejected` が先に残る。診断ログを読みやすくするのが目的の経路なので、
 * 両方外れたときだけ 1 行書く。origin の検査は共通で 1 回。
 */
function isUiSender(event: IpcMainInvokeEvent): boolean {
  const known = findWindowByUiWebContents(event.sender) !== null || isCallWindowContents(event.sender)
  if (known && isUiUrl(senderFrameUrl(event))) return true
  log('ipc.rejected', {
    reason: known ? 'sender_not_ui_origin' : 'unknown_sender',
    senderId: event.sender.id
  })
  return false
}

function requireTab(event: IpcMainInvokeEvent, key: unknown): { win: NemoWindow; tab: NemoTab } {
  const win = requireWindow(event)
  const tab = win.findTab(requireString(key, 'tab key'))
  if (!tab) {
    log('ipc.rejected', { reason: 'tab_not_owned', windowId: win.id })
    throw new Error('tab does not belong to this window')
  }
  return { win, tab }
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`invalid ${what}`)
  }
  return value
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, what)
}

/** リネームの引数。`null` / 空文字は「解除」なので通す。 */
function optionalTitle(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid title')
  return value
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${what}`)
  }
  return value as Record<string, unknown>
}

/** コマンドバー・拡張以外から来た URL は必ずここを通す。 */
function resolveInput(input: unknown): string {
  const decision = normalizeNavigationInput(requireString(input, 'input'), getSettings().searchTemplate)
  if (!decision.allowed) {
    log('navigation.blocked', { phase: 'ipc', reason: decision.reason })
    throw new Error(`navigation rejected: ${decision.reason}`)
  }
  return decision.url
}

export function registerIpcHandlers(): void {
  /* ---- 診断 ---- */
  // UI で起きた例外を診断ログへ。URL は preload 側で潰してから来る（`src/shared/ui-error.js`）
  ipcMain.handle('nemo:report-ui-error', (event, detail: unknown): void => {
    if (!isUiSender(event)) return
    if (typeof detail !== 'object' || detail === null) return
    const { error, frames, view } = detail as { error?: unknown; frames?: unknown; view?: unknown }
    logError('ui.error', typeof error === 'string' ? error : 'unknown', {
      view: typeof view === 'string' ? view.slice(0, 32) : 'unknown',
      frames: Array.isArray(frames)
        ? frames.filter((f): f is string => typeof f === 'string').slice(0, 10)
        : []
    })
  })

  /* ---- 状態 ---- */
  // 起動時のタブは UI のロード完了後に作られるので、
  // 「UI が出た」だけでは registry が空に見える。外はこれを待ってから読む。
  ipcMain.handle('nemo:get-app-status', (event): AppStatus => {
    requireWindow(event)
    return getAppStatus([...windowsById.values()].filter((win) => !win.isDestroyed))
  })

  ipcMain.handle('nemo:get-window-state', (event): WindowState => requireWindow(event).toState())
  // **組み立ては `NemoWindow.sharedState()` の1か所だけ**（push 側と食い違わせない）
  ipcMain.handle('nemo:get-shared-state', (event): SharedState => requireWindow(event).sharedState())
  ipcMain.handle('nemo:get-settings', (event) => {
    requireWindow(event)
    return getSettings()
  })
  ipcMain.handle('nemo:get-visible-tab-keys', (event): string[] => requireWindow(event).getVisibleTabKeys())
  ipcMain.handle('nemo:get-extensions', (event): LoadedExtensionInfo[] => {
    requireWindow(event)
    return loadedExtensions
  })

  /* ---- タブ ---- */
  ipcMain.handle('nemo:create-tab', (event, url: unknown, options: unknown): string => {
    const win = requireWindow(event)
    const raw = optionalString(url, 'url')
    const background = options !== undefined && requireRecord(options, 'options')['background'] === true
    const tab = createTab(win, raw ? resolveInput(raw) : undefined, { background })
    return tab.key
  })

  ipcMain.handle('nemo:select-tab', (event, key: unknown) => {
    const { win, tab } = requireTab(event, key)
    selectTab(win, tab.key)
  })

  ipcMain.handle('nemo:close-tab', (event, key: unknown) => {
    const { win, tab } = requireTab(event, key)
    removeTab(win, tab.key)
  })

  ipcMain.handle('nemo:move-tab-to-new-window', (event, key: unknown) => {
    const { win, tab } = requireTab(event, key)
    // 1枚しか無いタブを別ウィンドウへ動かしても意味がないので何もしない
    if (win.normalTabs.length <= 1) return
    // 移動先も同じ性質にする。通常ウィンドウを作ると partition が違って
    // registry が移動を拒否し、**空のウィンドウだけが増える**
    const target = createWindow(undefined, { isPrivate: win.isPrivate })
    target.whenUiReady(() => moveTabToWindow(tab, target))
  })

  /* ---- 分割ビュー（2 ペイン） ---- */
  ipcMain.handle('nemo:split-tabs', (event, leftKey: unknown, rightKey: unknown) => {
    // **両方とも送信元のウィンドウのタブか**を main で照合する
    // （renderer から任意の key を渡せないようにする）
    const { win, tab: left } = requireTab(event, leftKey)
    const right = typeof rightKey === 'string' ? win.findTab(rightKey) : null
    if (!right) return
    splitTabs(win, left.key, right.key)
  })

  ipcMain.handle('nemo:separate-split', (event, key: unknown) => {
    const { win, tab } = requireTab(event, key)
    separateSplit(win, tab.key)
  })

  /*
   * 自走検証専用の口。**`NEMO_VERIFY_DIAGNOSTICS=1` かつ未パッケージのときだけ生やす**
   * （既存の `NEMO_GITHUB_TEST_ENDPOINT` / `NEMO_MEET_TEST_URL_PREFIX` と同じゲート。
   * env だけだと、環境変数を付けて起動したパッケージ版にも診断 API が生える）。
   * 生やさないときは**ハンドラごと登録しない** —— 本番の renderer から呼べる面を増やさない。
   */
  if (process.env['NEMO_VERIFY_DIAGNOSTICS'] === '1' && !app.isPackaged) {
    log('ipc.verify_diagnostics_enabled', {})
    ipcMain.handle('nemo:split-diagnostics', (event): SplitDiagnostics => {
      return requireWindow(event).splitDiagnostics()
    })
    ipcMain.handle('nemo:run-command-for-verify', (event, command: unknown): boolean => {
      const win = requireWindow(event)
      if (typeof command !== 'string') return false
      // ⌘1〜9 は別経路（コマンド表に載っていない）
      const numbered = SELECT_TAB_ACCELERATORS.find((entry) => entry.id === command)
      if (numbered) {
        selectTabByIndexIn(win, numbered.index)
        return true
      }
      // **知らない名前は実行しない**（任意の文字列で main を動かせないようにする）
      if (!COMMANDS.some((entry) => entry.id === command)) return false
      runCommandForWindow(win, command)
      return true
    })
  }

  /* ---- Peek / 小窓 ---- */
  // ⌘O と同じ経路に乗せる（展開ボタンとキーで挙動が分かれないようにする）
  ipcMain.handle('nemo:promote-foreground-view', (event) => {
    promoteForegroundView(requireWindow(event))
  })

  ipcMain.handle('nemo:close-peek', (event) => {
    const win = requireWindow(event)
    const peek = win.getActiveTab()?.peek
    if (peek) removeTab(win, peek.key)
  })

  ipcMain.handle('nemo:navigate', async (event, key: unknown, input: unknown) => {
    const { tab } = requireTab(event, key)
    const url = resolveInput(input)
    if (tab.asleep) tab.materialize()
    await tab.webContents?.loadURL(url)
  })

  ipcMain.handle('nemo:go-back', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    const wc = tab.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })

  ipcMain.handle('nemo:go-forward', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    const wc = tab.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  })

  ipcMain.handle('nemo:reload', (event, key: unknown, options: unknown) => {
    const { win, tab } = requireTab(event, key)
    // キャッシュ無視（サイドバーの再読み込みボタンを右クリック / ⌘⇧R）
    const ignoreCache = options !== undefined && requireRecord(options, 'options')['ignoreCache'] === true
    if (tab.asleep) {
      selectTab(win, tab.key)
      return
    }
    tab.crashed = false
    if (ignoreCache) tab.webContents?.reloadIgnoringCache()
    else tab.webContents?.reload()
  })

  ipcMain.handle('nemo:stop', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    tab.webContents?.stop()
  })

  ipcMain.handle('nemo:set-zoom', (event, key: unknown, factor: unknown): number => {
    const { tab } = requireTab(event, key)
    if (typeof factor !== 'number' || !Number.isFinite(factor)) throw new Error('invalid factor')
    const clamped = Math.min(Math.max(factor, 0.25), 5)
    tab.zoomFactor = clamped
    tab.webContents?.setZoomFactor(clamped)
    tab.window.pushState()
    return clamped
  })

  /* ---- サイドバー（定義） ---- */
  ipcMain.handle('nemo:open-pinned', (event, pinnedId: unknown) => {
    const win = requireWindow(event)
    openPinned(win, requireString(pinnedId, 'pinnedId'))
  })

  ipcMain.handle('nemo:pin-tab', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    togglePin(tab)
  })

  // タブ行をピン留めツリーへドラッグしたとき。位置まで指定できる点が ⌘D と違う
  ipcMain.handle('nemo:pin-tab-at', (event, key: unknown, parentId: unknown, index: unknown) => {
    const { tab } = requireTab(event, key)
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('invalid index')
    pinTabInto(tab, optionalString(parentId, 'parentId') ?? null, index)
  })

  ipcMain.handle('nemo:unpin', (event, pinnedId: unknown) => {
    requireWindow(event)
    // 定義は全ウィンドウ共有なので、紐付けを外すのも全ウィンドウに効かせる
    unpinEverywhere(requireString(pinnedId, 'pinnedId'))
  })

  ipcMain.handle('nemo:add-favorite', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    // ピン留めとの排他（定義ごと移す）を registry の1経路に寄せる
    addFavoriteFromTab(tab)
  })

  ipcMain.handle('nemo:remove-favorite', (event, favoriteId: unknown) => {
    requireWindow(event)
    // 定義は全ウィンドウ共有なので、紐付けを外すのも全ウィンドウに効かせる
    removeFavoriteEverywhere(requireString(favoriteId, 'favoriteId'))
  })

  ipcMain.handle('nemo:open-favorite', (event, favoriteId: unknown) => {
    const win = requireWindow(event)
    openFavorite(win, requireString(favoriteId, 'favoriteId'))
  })

  ipcMain.handle('nemo:create-folder', (event, title: unknown) => {
    requireWindow(event)
    createFolder(optionalString(title, 'title') ?? '新しいフォルダ')
  })

  // 名前は null / 空文字で「解除」（既定名に戻す）なので、非空を要求しない
  ipcMain.handle('nemo:rename-node', (event, id: unknown, title: unknown) => {
    requireWindow(event)
    renameNode(requireString(id, 'id'), optionalTitle(title))
  })

  ipcMain.handle('nemo:rename-tab', (event, key: unknown, title: unknown) => {
    const { tab } = requireTab(event, key)
    renameTab(tab, optionalTitle(title))
  })

  // 引数はタブの key だけ。定義 ID は main 側でタブから導出する
  // （renderer から無関係な定義を書き換えられる口を作らない）。
  ipcMain.handle('nemo:update-pinned-url', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    updatePinnedUrlFromTab(tab)
  })

  ipcMain.handle('nemo:toggle-folder', (event, id: unknown) => {
    requireWindow(event)
    toggleFolder(requireString(id, 'id'))
  })

  ipcMain.handle('nemo:move-pinned', (event, id: unknown, parentId: unknown, index: unknown) => {
    requireWindow(event)
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('invalid index')
    movePinned(requireString(id, 'id'), optionalString(parentId, 'parentId') ?? null, index)
  })

  ipcMain.handle('nemo:move-favorite', (event, id: unknown, index: unknown) => {
    requireWindow(event)
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('invalid index')
    moveFavorite(requireString(id, 'id'), index)
  })

  /* ---- ウィンドウ / オーバーレイ ---- */
  ipcMain.handle('nemo:create-window', (event) => {
    requireWindow(event)
    createWindow()
  })

  ipcMain.handle('nemo:create-private-window', async (event) => {
    requireWindow(event)
    // 直前まで開いていたシークレットの消去が終わってから開く
    await openPrivateWindow()
  })

  ipcMain.handle('nemo:set-sidebar-visible', (event, visible: unknown) => {
    const win = requireWindow(event)
    if (typeof visible !== 'boolean') throw new Error('invalid visible')
    win.setSidebarVisible(visible)
    updateSettings({ sidebarVisible: visible })
  })

  // オーバーレイは購読しかしないので、読み込み直後に自分から取りに来られるようにする。
  // push だけに頼ると、購読より前に出たダイアログを取りこぼし、
  // ページ側の callback（権限・認証）が永久に解決しないまま残る。
  ipcMain.handle('nemo:get-overlay-state', (event) => {
    const win = requireWindow(event)
    return { kind: win.overlay, prompt: currentPrompt(win.id), switcher: currentSwitcherState(win) }
  })

  // タブスイッチャーは main が並びとハイライト位置を握る（`set-overlay` では開けない）。
  // UI から来るのは「進める」「カードを押した」「背景を押した」の3つだけで、
  // どれもキーボードでできることと同じ。
  ipcMain.handle('nemo:switch-tab', (event) => {
    advanceSwitcher(requireWindow(event))
  })

  ipcMain.handle('nemo:pick-switcher-tab', (event, key: unknown) => {
    // 位置ではなく key で受ける（帯の表示が1件ぶん古いときに別のタブへ飛ばさない）。
    //
    // **ここで `requireTab` を使わない**。帯を出したままタブが閉じられると、
    // UI には既に無いタブのカードが残る。それを押したときに投げると
    // renderer 側で unhandled rejection になり、帯も出たまま残る。
    // 「今のセッションに載っている key か」は `pickSwitcherTab` が見るので、
    // ここは送信元と型だけ検証して渡し、載っていなければ何もしない。
    const win = requireWindow(event)
    pickSwitcherTab(win, requireString(key, 'tab key'))
  })

  ipcMain.handle('nemo:cancel-switcher', (event) => {
    cancelSwitcher(requireWindow(event))
  })

  ipcMain.handle('nemo:set-overlay', (event, kind: unknown) => {
    const win = requireWindow(event)
    const allowed = ['command-bar', 'address-bar', 'find', 'downloads', 'library', 'settings'] as const
    if (kind !== null && !allowed.includes(kind as (typeof allowed)[number])) {
      throw new Error('invalid overlay')
    }
    win.setOverlay(kind as OverlayKind)
  })

  ipcMain.handle('nemo:toggle-devtools', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    const wc = tab.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'right' })
  })

  ipcMain.handle('nemo:copy-url', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    clipboard.writeText(tab.url)
  })

  /* ---- コマンドバー ---- */
  ipcMain.handle('nemo:suggest', (event, query: unknown) => {
    const win = requireWindow(event)
    return suggest(win, typeof query === 'string' ? query.slice(0, 512) : '')
  })

  /* ---- ページ内検索 ---- */
  ipcMain.handle('nemo:find', (event, key: unknown, query: unknown, options: unknown) => {
    const { tab } = requireTab(event, key)
    const text = requireString(query, 'query').slice(0, 512)
    const opts = options === undefined ? {} : requireRecord(options, 'options')
    tab.find = {
      query: text,
      activeMatch: tab.find?.activeMatch ?? 0,
      totalMatches: tab.find?.totalMatches ?? 0
    }
    const wc = tab.webContents
    // 検索語そのものはログに出さない（長さだけ）
    log('find.requested', { attached: Boolean(wc), length: text.length })
    // Electron 41 では `findNext: false` を**明示すると `found-in-page` が飛んでこない**
    // （省略時＝既定値 false と挙動が違う）。新規検索のときは指定しない。
    // docs/compat.md「既知の癖」参照。
    const findOptions: Electron.FindInPageOptions = { forward: opts['forward'] !== false }
    if (opts['findNext'] === true) findOptions.findNext = true
    wc?.findInPage(text, findOptions)
  })

  ipcMain.handle('nemo:stop-find', (event, key: unknown) => {
    const { tab } = requireTab(event, key)
    tab.find = null
    tab.webContents?.stopFindInPage('clearSelection')
    tab.window.pushState()
  })

  /* ---- ダウンロード ---- */
  // 一覧に出していなくても id を知っていれば叩けるので、操作も scope で絞る
  ipcMain.handle('nemo:cancel-download', (event, id: unknown) => {
    const win = requireWindow(event)
    cancelDownload(requireString(id, 'id'), win.downloadScope)
  })
  ipcMain.handle('nemo:reveal-download', (event, id: unknown) => {
    const win = requireWindow(event)
    revealDownload(requireString(id, 'id'), win.downloadScope)
  })
  ipcMain.handle('nemo:clear-downloads', (event) => {
    const win = requireWindow(event)
    clearDownloads(win.downloadScope)
  })

  /* ---- ライブラリ（履歴 / アーカイブ） ---- */
  ipcMain.handle('nemo:query-history', (event, query: unknown) => {
    requireWindow(event)
    return queryHistory(typeof query === 'string' ? query.slice(0, 512) : '')
  })
  ipcMain.handle('nemo:remove-history', (event, url: unknown) => {
    requireWindow(event)
    removeHistory(requireString(url, 'url'))
  })
  ipcMain.handle('nemo:clear-history', (event) => {
    requireWindow(event)
    clearHistory()
    log('history.cleared', {})
  })
  ipcMain.handle('nemo:query-archive', (event, query: unknown) => {
    requireWindow(event)
    return queryArchive(typeof query === 'string' ? query.slice(0, 512) : '')
  })
  ipcMain.handle('nemo:remove-archived', (event, url: unknown) => {
    requireWindow(event)
    removeArchived(requireString(url, 'url'))
  })
  ipcMain.handle('nemo:clear-archive', (event) => {
    requireWindow(event)
    clearArchive()
    log('archive.cleared', {})
  })

  /* ---- ダイアログ ---- */
  ipcMain.handle('nemo:resolve-prompt', (event, id: unknown, answer: unknown) => {
    const win = requireWindow(event)
    answerPrompt(win.id, requireString(id, 'id'), validateAnswer(answer))
  })

  /* ---- 設定 ---- */
  ipcMain.handle('nemo:update-settings', (event, patch: unknown) => {
    requireWindow(event)
    const before = getSettings().liveFolderEnabled
    const next = updateSettings(requireRecord(patch, 'patch'))
    // **設定の変更も即時に反映する。** push の契機が `onLiveFolderChanged` だけだと、
    // トグルを戻しても最大 60 秒何も起きず、壊れているように見える。
    // false にしたら push だけ、true に戻したら push + 即時に1回取得。
    if (before !== next.liveFolderEnabled) liveFolderSettingChanged(next.liveFolderEnabled)
    return next
  })

  /* ---- 拡張 ---- */
  ipcMain.handle('nemo:open-extension-options', (event, extensionId: unknown) => {
    const win = requireWindow(event)
    const id = requireString(extensionId, 'extensionId')
    const extension = loadedExtensions.find((item) => item.id === id)
    if (!extension?.optionsUrl) return
    // 拡張ページなので通常のナビゲーション検証（http/https のみ）は通らない。
    // ロード済み拡張の自分のページに限って createTab 側の allowExtensionPages が通す。
    createTab(win, extension.optionsUrl)
  })

  ipcMain.handle('nemo:restart-service-workers', async (event) => {
    requireWindow(event)
    return restartServiceWorkers(session.fromPartition(PAGE_PARTITION))
  })

  ipcMain.handle('nemo:open-log-folder', (event) => {
    requireWindow(event)
    void shell.openPath(userDataPath('logs'))
  })

  /* ---- ブックマークのセーブスロット ---- */

  /** 枠の番号は 0〜2 だけ。範囲外を通すとファイル名を組み立てる層まで届く。 */
  const isSlotIndex = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SLOT_COUNT

  ipcMain.handle('nemo:list-slots', async (event): Promise<SlotList> => {
    requireWindow(event)
    // 保存先はログに出さない（フルパスにユーザー名が載る）。UI と検証はここでだけ受け取る
    const list = await listSlots()
    return {
      ...list,
      current: { pins: countPinnedLinks(getPinned()), favs: getFavorites().length }
    }
  })

  ipcMain.handle('nemo:save-slot', async (event, index: unknown, name: unknown): Promise<boolean> => {
    requireWindow(event)
    if (!isSlotIndex(index)) return false
    const favorites = getFavorites()
    const pinned = getPinned()
    // favicon は履歴からまとめて引く（別の Mac には履歴が無いので焼き込む）。
    // 並べる URL は `iconCandidates`（重複を落として打ち切る前）から取る
    const urls = iconCandidates(favorites, pinned).slice(0, MAX_SLOT_ICONS)
    const icons = collectIcons(favorites, pinned, getFavicons(urls))
    return saveSlot(
      index,
      buildSlot({
        name: typeof name === 'string' && name.trim() ? name : defaultSlotName(),
        host: hostName(),
        appVersion: appVersion(),
        savedAt: Date.now(),
        favorites,
        pinned,
        icons
      })
    )
  })

  ipcMain.handle('nemo:apply-slot', async (event, index: unknown): Promise<boolean> => {
    requireWindow(event)
    if (!isSlotIndex(index)) return false
    const data = await readSlot(index)
    if (!data) return false
    return applySlot(index, data)
  })

  ipcMain.handle('nemo:delete-slot', (event, index: unknown): Promise<boolean> => {
    requireWindow(event)
    if (!isSlotIndex(index)) return Promise.resolve(false)
    return deleteSlot(index)
  })

  ipcMain.handle('nemo:rename-slot', (event, index: unknown, name: unknown): Promise<boolean> => {
    requireWindow(event)
    if (!isSlotIndex(index) || typeof name !== 'string') return Promise.resolve(false)
    return renameSlot(index, name)
  })

  ipcMain.handle('nemo:open-slots-folder', async (event) => {
    requireWindow(event)
    // 無ければ作ってから開く（初回は Finder が「存在しない」と言うだけになる）
    void shell.openPath(await ensureSlotsDir())
  })

  /* ---- Basic 認証の保管庫（別の Mac への持ち出し） ---- */

  /**
   * パスフレーズを決める。
   *
   * `null` は「覚えているものを使う」。**renderer に値を返す口は作らない**ので、
   * 記憶を使いたいときは値ではなく `null` を渡してもらう。
   */
  function resolvePassphrase(
    value: unknown
  ): { ok: true; passphrase: string; entered: boolean } | { ok: false; reason: AuthVaultFailure } {
    if (value === null || value === undefined) {
      const remembered = recallPassphrase()
      if (!remembered) return { ok: false, reason: 'no-passphrase' }
      return { ok: true, passphrase: remembered, entered: false }
    }
    const passphrase = credential(value, MAX_PASSPHRASE)
    // **長さの規則は `auth-vault-schema.js` の 1 本**（UI の入力欄と同じ値を使う）
    if (!validatePassphrase(passphrase).ok) return { ok: false, reason: 'weak-passphrase' }
    return { ok: true, passphrase, entered: true }
  }

  ipcMain.handle('nemo:auth-vault-status', async (event): Promise<AuthVaultStatus> => {
    requireWindow(event)
    const status = await vaultStatus()
    return {
      ...status,
      // **renderer で数え直さない**（「有効なものだけ」の規則を二重に持たない）
      localCount: readAllCredentials().rules.length,
      hasPassphrase: hasRememberedPassphrase(),
      encryptionAvailable: httpAuthEncryptionAvailable(),
      minPassphrase: MIN_PASSPHRASE
    }
  })

  ipcMain.handle(
    'nemo:auth-vault-preview-save',
    async (event, passphrase: unknown): Promise<AuthVaultSavePreview> => {
      requireWindow(event)
      const resolved = resolvePassphrase(passphrase)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }

      const local = readAllCredentials()
      const opened = await openVault(resolved.passphrase)
      // まだ保管庫が無い＝初回。消えるものは無い
      if (!opened.ok && opened.reason === 'empty') {
        return { ok: true, disappearing: [], count: local.rules.length, skipped: local.skipped, first: true }
      }
      if (!opened.ok) return { ok: false, reason: opened.reason, detail: opened.detail }

      /*
       * **向きを間違えない。** 第 1 引数は常に保管庫。
       * 逆にすると「これから追加されるもの」を「消えます」として出す。
       */
      const { missing } = diffAuthRules(
        opened.rules,
        local.rules.map((rule) => ({ ...rule, enabled: true }))
      )
      return {
        ok: true,
        disappearing: missing,
        count: local.rules.length,
        skipped: local.skipped,
        first: false
      }
    }
  )

  ipcMain.handle(
    'nemo:auth-vault-save',
    async (event, passphrase: unknown, remember: unknown): Promise<AuthVaultSaveResult> => {
      requireWindow(event)
      const resolved = resolvePassphrase(passphrase)
      if (!resolved.ok) return { ok: false, reason: resolved.reason, saved: 0, skipped: 0 }
      if (!httpAuthEncryptionAvailable()) {
        return { ok: false, reason: 'no-encryption', saved: 0, skipped: 0 }
      }

      const local = readAllCredentials()
      const written = await saveVault(local.rules, resolved.passphrase, {
        savedAt: Date.now(),
        host: hostName(),
        appVersion: appVersion()
      })
      if (!written) return { ok: false, reason: 'write-failed', saved: 0, skipped: local.skipped }
      // **書けたときだけ覚える**（開けない保管庫のパスフレーズを覚えても害しかない）
      if (remember === true && resolved.entered) rememberPassphrase(resolved.passphrase)
      return { ok: true, saved: local.rules.length, skipped: local.skipped }
    }
  )

  ipcMain.handle(
    'nemo:auth-vault-preview-load',
    async (event, passphrase: unknown): Promise<AuthVaultLoadPreview> => {
      requireWindow(event)
      const resolved = resolvePassphrase(passphrase)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }

      const opened = await openVault(resolved.passphrase)
      if (!opened.ok) return { ok: false, reason: opened.reason, detail: opened.detail }

      // **無効なルールも突き合わせる**（落とすと読み込みで黙って有効に戻る）
      const diff = diffAuthRules(opened.rules, readAllForDiff())
      return { ok: true, ...diff, meta: opened.meta, dropped: opened.dropped }
    }
  )

  ipcMain.handle(
    'nemo:auth-vault-load',
    async (
      event,
      passphrase: unknown,
      patterns: unknown,
      remember: unknown
    ): Promise<AuthVaultLoadResult> => {
      requireWindow(event)
      const base = { imported: 0, stale: 0, authCacheCleared: false }
      const resolved = resolvePassphrase(passphrase)
      if (!resolved.ok) return { ok: false, reason: resolved.reason, ...base }
      if (!Array.isArray(patterns)) return { ok: false, reason: 'malformed', ...base }

      const wanted = new Set(patterns.filter((value): value is string => typeof value === 'string'))
      // **消していないのに消したと言わない**（UI では 0 件を押せないが、戻り値は嘘をつかない）
      if (wanted.size === 0) return { ok: true, ...base }

      /*
       * **保管庫を読み直して分類し直す。** 下見と実行の間に別の Mac が書き換えたり、
       * 手元のルールが変わったりしうる。再分類しないと、下見で見ていない中身が入る。
       */
      const opened = await openVault(resolved.passphrase)
      if (!opened.ok) return { ok: false, reason: opened.reason, ...base }

      const local = readAllForDiff()
      const { missing, differing } = diffAuthRules(opened.rules, local)
      const importable = new Set([...missing, ...differing].map((entry) => entry.pattern))
      const inVault = new Set(opened.rules.map((rule) => rule.pattern))
      const existing = new Map(listHttpAuthRules().map((rule) => [rule.pattern, rule.id]))

      const entries: ImportEntry[] = []
      for (const rule of opened.rules) {
        if (!wanted.has(rule.pattern) || !importable.has(rule.pattern)) continue
        entries.push({
          // 同じパターンの既存ルールがあればその ID を使う（無ければ新規採番）
          id: existing.get(rule.pattern) ?? null,
          pattern: rule.pattern,
          username: rule.username,
          password: rule.password,
          importedFrom: null,
          ...(rule.updatedAt === undefined ? {} : { updatedAt: rule.updatedAt })
        })
      }
      /*
       * **`stale` は「保管庫から消えたもの」だけ数える。** 単純に
       * `wanted.size - entries.length` にすると、下見のあとに**手元が保管庫と同じ内容に
       * 追いついた**場合まで「保管庫が更新されていたため」に数えてしまい、文言と原因がずれる。
       */
      const stale = [...wanted].filter((pattern) => !inVault.has(pattern)).length

      const before = listHttpAuthRules().length
      const persisted = await importHttpAuthRules(entries)
      if (!persisted) return { ok: false, reason: 'write-failed', ...base, stale }
      if (remember === true && resolved.entered) rememberPassphrase(resolved.passphrase)

      /*
       * **入った件数は commit 後に数え直す。** `normalizeRules` が黙って落とす分
       * （件数上限など）と食い違わせない。既存を置き換えた分は増えないので、
       * 「entries のうち実際に残ったもの」を数える。
       */
      const after = listHttpAuthRules()
      const landed = new Set(after.map((rule) => rule.pattern))
      const imported = entries.filter((entry) => landed.has(entry.pattern)).length
      log('auth_vault.loaded', { requested: wanted.size, imported, stale, before, after: after.length })

      return {
        ok: true,
        imported,
        stale,
        authCacheCleared: await httpAuthCredentialsChanged('vault-loaded')
      }
    }
  )

  ipcMain.handle('nemo:auth-vault-delete', async (event): Promise<boolean> => {
    requireWindow(event)
    const ok = await deleteVault()
    // **記憶も一緒に消す**（別のパスフレーズで作り直したときに古い記憶が初期値になる）
    if (ok) forgetPassphrase()
    return ok
  })

  /* ---- Live Folder（GitHub の PR） ---- */
  ipcMain.handle('nemo:live-folder-refresh', (event) => {
    requireWindow(event)
    refreshLiveFolderNow()
  })

  // **renderer から渡された URL をそのまま開かない。**
  // いま Live Folder に載っている項目と一致するものだけ開く
  // （renderer の入力を信じて任意 URL を開く口にしない）。
  ipcMain.handle('nemo:live-folder-open', (event, url: unknown) => {
    const win = requireWindow(event)
    const target = requireString(url, 'url')
    if (!isLiveFolderUrl(target)) {
      log('live_folder.open_rejected', { reason: 'not_listed' })
      return
    }
    // URL 一致のタブがあればそれをアクティブ化、無ければ開く。
    // **照合は正準形どうしで行う**（renderer 側の一時タブの除外と同じ規則にする）。
    // 文字列の完全一致にすると、通知から開いた
    // `.../pull/12?notification_referrer_id=…` のタブが「今日のタブ」から隠れているのに
    // 行を押すと**正準 URL の別タブがもう1枚作られる**。
    const existing = win.normalTabs.find((tab) => liveFolderKeyOf(tab.url) === target)
    if (existing) {
      selectTab(win, existing.key)
      return
    }
    createTab(win, target)
  })

  ipcMain.handle('nemo:github-token-save', (event, token: unknown) => {
    requireWindow(event)
    // 中身はログに出さない（長さも出さない）
    const saved = saveToken(credential(token, 512), isGithubTestEndpoint())
    if (saved) liveFolderCredentialsChanged('pat-saved')
    return saved
  })

  ipcMain.handle('nemo:github-token-clear', (event) => {
    requireWindow(event)
    clearToken(isGithubTestEndpoint())
    // 消したら gh へフォールバックして即時取得、無ければ `Connect GitHub` へ即時に切り替わる
    liveFolderCredentialsChanged('pat-cleared')
  })

  // **トークンそのものを renderer へ返す IPC は作らない。**
  ipcMain.handle('nemo:github-token-source', async (event) => {
    requireWindow(event)
    const useTest = isGithubTestEndpoint()
    const resolved = await resolveToken(useTest)
    return {
      source: resolved.source,
      hasStoredPat: hasToken(useTest),
      encryptionAvailable: tokenStorageAvailable(useTest)
    }
  })

  /* ---- HTTP 認証の自動入力 ---- */
  /*
   * **パスワードを返す口は `reveal` の 1 件取得だけ**にする。
   * 一覧に載せると Settings を開いた瞬間に全資格情報が renderer に渡ることになる。
   * `github-token.ts` の「返す口は作らない」と意図的に分けているのは、
   * PAT が広いスコープの bearer token なのに対し、こちらはサイト個別のパスワードで
   * 「あのサイトのパスワード何だっけ」を引ける価値が上回るため（#15）。
   */
  ipcMain.handle(
    'nemo:list-http-auth-rules',
    (event): { rules: HttpAuthRule[]; encryptionAvailable: boolean } => {
      requireWindow(event)
      // 端末鍵が使えるかも一緒に返す（renderer が保存を試す前に案内を出せるように）
      return { rules: listHttpAuthRules(), encryptionAvailable: httpAuthEncryptionAvailable() }
    }
  )

  ipcMain.handle('nemo:reveal-http-auth-password', async (event, id: unknown) => {
    requireWindow(event)
    const ruleId = requireString(id, 'id')
    log('auth_rule.revealed', { id: ruleId })
    return revealHttpAuthPassword(ruleId)
  })

  /**
   * ルールの保存。**`password` を省略したら既存の暗号文を保持する**（patch semantics）。
   * 一覧は password を持たないので、これが無いと「pattern だけ編集したら空パスワードで上書き」か
   * 「編集のために renderer へ平文を返す」のどちらかになる。
   */
  ipcMain.handle('nemo:save-http-auth-rule', async (event, input: unknown): Promise<HttpAuthWriteResult> => {
    requireWindow(event)
    const patch = requireRecord(input, 'input')
    const id = typeof patch['id'] === 'string' ? patch['id'] : null
    const enabled = typeof patch['enabled'] === 'boolean' ? patch['enabled'] : undefined

    // 有効トグルだけの変更（`disabledReason` がある間は main が拒否する）
    if (id !== null && patch['pattern'] === undefined) {
      const ok = enabled === undefined ? false : await setHttpAuthRuleEnabled(id, enabled)
      if (!ok) return { saved: false, authCacheCleared: false, reason: 'refused' }
      return { saved: true, id, authCacheCleared: await httpAuthCredentialsChanged('rule-toggled') }
    }

    /*
     * **上限超過は切り詰めずに拒否する。** `credential()` の `slice` で黙って詰めると、
     * 入力した値と実際に保存される値が食い違ううえ、store 側の `too-long` は
     * 切り詰め済みの値しか見ないので永久に真にならない（＝入口ごとに挙動が割れる）。
     */
    const pattern = credential(patch['pattern'], Number.MAX_SAFE_INTEGER)
    const username = credential(patch['username'], Number.MAX_SAFE_INTEGER)
    // **省略と空文字を区別する**（空文字は有効な新パスワード）
    const password =
      patch['password'] === undefined || patch['password'] === null
        ? null
        : credential(patch['password'], Number.MAX_SAFE_INTEGER)
    if (
      pattern.length > HTTP_AUTH_LIMITS.MAX_PATTERN ||
      username.length > HTTP_AUTH_LIMITS.MAX_USERNAME ||
      (password !== null && password.length > HTTP_AUTH_LIMITS.MAX_PASSWORD)
    ) {
      return { saved: false, authCacheCleared: false, reason: 'too-long' }
    }
    if (!validateHttpAuthPattern(pattern).ok) {
      return { saved: false, authCacheCleared: false, reason: 'invalid-pattern' }
    }
    const result = await saveHttpAuthRule({
      id,
      pattern,
      username,
      password,
      ...(enabled === undefined ? {} : { enabled })
    })
    // IPC がエラーになるのは**永続化そのものが失敗したとき**だけ
    if (!result.ok) return { saved: false, authCacheCleared: false, reason: result.reason }
    // **採番された ID を返す**（renderer と検証が「今保存したルール」を指せるように）
    return { saved: true, id: result.id, authCacheCleared: await httpAuthCredentialsChanged('rule-saved') }
  })

  ipcMain.handle('nemo:delete-http-auth-rule', async (event, id: unknown): Promise<HttpAuthWriteResult> => {
    requireWindow(event)
    const ok = await deleteHttpAuthRule(requireString(id, 'id'))
    if (!ok) return { saved: false, authCacheCleared: false, reason: 'write-failed' }
    return { saved: true, authCacheCleared: await httpAuthCredentialsChanged('rule-deleted') }
  })

  /**
   * MultiPass の JSON テキストを取り込む。
   * **取り込み全体を 1 回のトランザクションで永続化し、そのあと共通の後始末を通す**
   * （通さないと HttpAuthCache が古い資格情報を送り続け、同一セッションに反映されない）。
   */
  ipcMain.handle('nemo:import-multipass', async (event, text: unknown): Promise<HttpAuthImportResult> => {
    requireWindow(event)
    const json = credential(text, 1_000_000)
    const existing = listHttpAuthRules().map((rule) => ({ id: rule.id, pattern: rule.pattern }))
    const parsed = importMultipass(json, existing)
    const persisted = await importHttpAuthRules(parsed.entries)
    if (!persisted) {
      return {
        imported: 0,
        rejected: parsed.rejected,
        priorityWarning: parsed.priorityWarning,
        authCacheCleared: false,
        failed: true
      }
    }
    return {
      imported: parsed.entries.length,
      rejected: parsed.rejected,
      priorityWarning: parsed.priorityWarning,
      authCacheCleared: await httpAuthCredentialsChanged('imported'),
      failed: false
    }
  })

  /**
   * 正規表現テスター。**URL ごとに「マッチした ID 群」と「勝者」を返す**。
   * 優先順位のロジックを renderer に再実装させないための形で、正規表現の実行は main に閉じる。
   */
  ipcMain.handle(
    'nemo:test-http-auth-pattern',
    async (event, urls: unknown, draftPattern: unknown): Promise<HttpAuthTestResult[]> => {
      requireWindow(event)
      if (!Array.isArray(urls)) throw new Error('invalid urls')
      const draft = typeof draftPattern === 'string' && draftPattern.length > 0 ? draftPattern : null
      const rules = listHttpAuthRules()
      if (draft !== null) {
        // 未保存の下書きも**同じ関門を通す**
        if (!validateHttpAuthPattern(draft).ok) throw new Error('invalid pattern')
        rules.push({ id: 'draft', pattern: draft, username: '', enabled: true })
      }
      const results: HttpAuthTestResult[] = []
      for (const raw of urls.slice(0, 20)) {
        const url = credential(raw, HTTP_AUTH_LIMITS.MAX_URL)
        // **`tester` として撃つ**（タイムアウトしても保存済みルールを無効化しない）
        const matched = await matchHttpAuthRules(rules, url, 'tester')
        results.push({
          url,
          matchedIds: matched.matchedIds,
          winnerId: matched.winner?.id ?? null,
          timedOutIds: matched.timedOutIds
        })
      }
      return results
    }
  )

  /** 「表示」したパスワードを再マスクするまで（検証から短縮できる）。 */
  ipcMain.handle('nemo:http-auth-reveal-ms', (event): number => {
    requireWindow(event)
    return getTimings().httpAuthRevealMs
  })

  ipcMain.handle('nemo:check-for-updates', (event) => {
    requireWindow(event)
    checkForUpdatesManually()
  })

  ipcMain.handle('nemo:restart-for-update', (event) => {
    requireWindow(event)
    promptRestart()
  })

  /* ---- 会議の小窓 ---- */
  // **どれも引数を取らない**。renderer に tab key を持たせず、
  // 対象は main 側の coordinator が解決する
  // （renderer から任意のタブを触れる経路を作らない）。
  ipcMain.handle('call:getState', (event): CallState | null => {
    requireCallWindow(event)
    return getCallState()
  })
  ipcMain.handle('call:focusTab', (event) => {
    requireCallWindow(event)
    focusCallTarget()
  })
  ipcMain.handle('call:toggleMic', async (event) => {
    requireCallWindow(event)
    await toggleCallDevice('mic')
  })
  ipcMain.handle('call:toggleCam', async (event) => {
    requireCallWindow(event)
    await toggleCallDevice('cam')
  })
}

/** 資格情報の文字列（空も許す。中身はログに出さない）。 */
function credential(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('invalid credential')
  return value.slice(0, max)
}

function validateAnswer(value: unknown): PromptAnswer {
  const answer = requireRecord(value, 'answer')
  switch (answer['kind']) {
    case 'permission':
      return {
        kind: 'permission',
        allow: answer['allow'] === true,
        remember: answer['remember'] === true
      }
    case 'auth':
      // 資格情報は空文字もありうるので requireString（非空を要求）は使わない
      return {
        kind: 'auth',
        username: credential(answer['username'], HTTP_AUTH_LIMITS.MAX_USERNAME),
        password: credential(answer['password'], HTTP_AUTH_LIMITS.MAX_PASSWORD),
        // **保存してよいかを決めるのは main**（`answer.save` は「押したか」でしかない）
        save: answer['save'] === true
      }
    case 'auth-cancel':
      return { kind: 'auth-cancel' }
    case 'notice':
      return { kind: 'notice' }
    case 'certificate':
      return { kind: 'certificate', proceed: answer['proceed'] === true }
    case 'external-protocol':
      return {
        kind: 'external-protocol',
        open: answer['open'] === true,
        remember: answer['remember'] === true
      }
    case 'system-media':
      return { kind: 'system-media', openSettings: answer['openSettings'] === true }
    default:
      throw new Error('invalid answer')
  }
}
