import { clipboard, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { PAGE_PARTITION, userDataPath } from './paths.js'
import { restartServiceWorkers } from './extensions.js'
import { log } from './log.js'
import {
  createTab,
  createWindow,
  findWindowByUiWebContents,
  moveTabToWindow,
  openPinned,
  pinTabInto,
  removeTab,
  selectTab,
  togglePin,
  unpinEverywhere,
  type NemoTab,
  type NemoWindow
} from './registry.js'
import { isUiUrl, normalizeNavigationInput } from './security.js'
import { answerPrompt, currentPrompt } from './prompts.js'
import { suggest } from './suggest.js'
import { getSettings, updateSettings } from './store/settings.js'
import {
  addFavorite,
  createFolder,
  findFavorite,
  getFavorites,
  getPinned,
  moveFavorite,
  movePinned,
  removeFavorite,
  renameNode,
  toggleFolder
} from './store/pins.js'
import { cancelDownload, clearDownloads, listDownloads, revealDownload } from './downloads.js'
import { getAppStatus } from './app-status.js'
import { windowsById } from './registry.js'
import type {
  AppStatus,
  LoadedExtensionInfo,
  PromptAnswer,
  SharedState,
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

function sharedState(): SharedState {
  return { favorites: getFavorites(), pinned: getPinned(), downloads: listDownloads() }
}

export function registerIpcHandlers(): void {
  /* ---- 状態 ---- */
  // 起動時のタブは UI のロード完了後に作られるので、
  // 「UI が出た」だけでは registry が空に見える。外はこれを待ってから読む。
  ipcMain.handle('nemo:get-app-status', (event): AppStatus => {
    requireWindow(event)
    return getAppStatus([...windowsById.values()].filter((win) => !win.isDestroyed))
  })

  ipcMain.handle('nemo:get-window-state', (event): WindowState => requireWindow(event).toState())
  ipcMain.handle('nemo:get-shared-state', (event): SharedState => {
    requireWindow(event)
    return sharedState()
  })
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
    if (win.tabs.length <= 1) return
    const target = createWindow()
    target.whenUiReady(() => moveTabToWindow(tab, target))
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
    addFavorite(tab.url, tab.title)
  })

  ipcMain.handle('nemo:remove-favorite', (event, favoriteId: unknown) => {
    requireWindow(event)
    removeFavorite(requireString(favoriteId, 'favoriteId'))
  })

  ipcMain.handle('nemo:open-favorite', (event, favoriteId: unknown) => {
    const win = requireWindow(event)
    const favorite = findFavorite(requireString(favoriteId, 'favoriteId'))
    if (!favorite) return
    const existing = win.tabs.find((tab) => tab.url === favorite.url)
    if (existing) selectTab(win, existing.key)
    else createTab(win, favorite.url, { title: favorite.title })
  })

  ipcMain.handle('nemo:create-folder', (event, title: unknown) => {
    requireWindow(event)
    createFolder(optionalString(title, 'title') ?? '新しいフォルダ')
  })

  ipcMain.handle('nemo:rename-node', (event, id: unknown, title: unknown) => {
    requireWindow(event)
    renameNode(requireString(id, 'id'), requireString(title, 'title'))
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
    return { kind: win.overlay, prompt: currentPrompt(win.id) }
  })

  ipcMain.handle('nemo:set-overlay', (event, kind: unknown) => {
    const win = requireWindow(event)
    if (
      kind !== null &&
      kind !== 'command-bar' &&
      kind !== 'address-bar' &&
      kind !== 'find' &&
      kind !== 'downloads'
    ) {
      throw new Error('invalid overlay')
    }
    win.setOverlay(kind)
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
  ipcMain.handle('nemo:cancel-download', (event, id: unknown) => {
    requireWindow(event)
    cancelDownload(requireString(id, 'id'))
  })
  ipcMain.handle('nemo:reveal-download', (event, id: unknown) => {
    requireWindow(event)
    revealDownload(requireString(id, 'id'))
  })
  ipcMain.handle('nemo:clear-downloads', (event) => {
    requireWindow(event)
    clearDownloads()
  })

  /* ---- ダイアログ ---- */
  ipcMain.handle('nemo:resolve-prompt', (event, id: unknown, answer: unknown) => {
    const win = requireWindow(event)
    answerPrompt(win.id, requireString(id, 'id'), validateAnswer(answer))
  })

  /* ---- 設定 ---- */
  ipcMain.handle('nemo:update-settings', (event, patch: unknown) => {
    requireWindow(event)
    return updateSettings(requireRecord(patch, 'patch'))
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
        username: credential(answer['username'], 256),
        password: credential(answer['password'], 512)
      }
    case 'auth-cancel':
      return { kind: 'auth-cancel' }
    case 'certificate':
      return { kind: 'certificate', proceed: answer['proceed'] === true }
    case 'external-protocol':
      return {
        kind: 'external-protocol',
        open: answer['open'] === true,
        remember: answer['remember'] === true
      }
    default:
      throw new Error('invalid answer')
  }
}
