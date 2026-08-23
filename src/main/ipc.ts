import { ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { PAGE_PARTITION } from './paths.js'
import { restartServiceWorkers } from './extensions.js'
import { log } from './log.js'
import {
  createTab,
  createWindow,
  findWindowByUiWebContents,
  removeTab,
  selectTab,
  type NemoTab,
  type NemoWindow
} from './registry.js'
import { normalizeNavigationInput } from './security.js'
import type { LoadedExtensionInfo, WindowState } from '../shared/types.js'

/**
 * IPC は必ず「送信元が登録済みウィンドウの UI WebContents か」と
 * 「対象タブがそのウィンドウのものか」を検証する。
 * これを省くと、悪意あるページが他タブを操作できる経路になる。
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
  return win
}

function requireTab(event: IpcMainInvokeEvent, tabId: unknown): { win: NemoWindow; tab: NemoTab } {
  const win = requireWindow(event)
  if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
    throw new Error('invalid tabId')
  }
  const tab = win.tabs.find((t) => t.id === tabId)
  if (!tab) {
    log('ipc.rejected', { reason: 'tab_not_owned', tabId, windowId: win.id })
    throw new Error('tab does not belong to this window')
  }
  return { win, tab }
}

function assertOptionalUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('invalid url')
  return value
}

export function registerIpcHandlers(): void {
  ipcMain.handle('nemo:get-window-state', (event): WindowState => requireWindow(event).toState())

  ipcMain.handle('nemo:get-visible-tab-ids', (event): number[] =>
    requireWindow(event).getVisibleTabIds()
  )

  ipcMain.handle('nemo:get-extensions', (event): LoadedExtensionInfo[] => {
    requireWindow(event)
    return loadedExtensions
  })

  ipcMain.handle('nemo:create-tab', (event, url: unknown): number => {
    const win = requireWindow(event)
    const raw = assertOptionalUrl(url)
    let target: string | undefined
    if (raw) {
      const decision = normalizeNavigationInput(raw)
      if (!decision.allowed) throw new Error(`navigation rejected: ${decision.reason}`)
      target = decision.url
    }
    const tab = createTab(win, target)
    selectTab(win, tab.id)
    return tab.id
  })

  ipcMain.handle('nemo:select-tab', (event, tabId: unknown) => {
    const { win, tab } = requireTab(event, tabId)
    selectTab(win, tab.id)
  })

  ipcMain.handle('nemo:close-tab', (event, tabId: unknown) => {
    const { win, tab } = requireTab(event, tabId)
    removeTab(win, tab.id)
  })

  ipcMain.handle('nemo:navigate', async (event, tabId: unknown, input: unknown) => {
    const { tab } = requireTab(event, tabId)
    if (typeof input !== 'string') throw new Error('invalid input')
    const decision = normalizeNavigationInput(input)
    if (!decision.allowed) {
      log('navigation.blocked', { phase: 'command-bar', reason: decision.reason })
      throw new Error(`navigation rejected: ${decision.reason}`)
    }
    await tab.webContents.loadURL(decision.url)
  })

  ipcMain.handle('nemo:go-back', (event, tabId: unknown) => {
    const { tab } = requireTab(event, tabId)
    if (tab.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack()
  })

  ipcMain.handle('nemo:go-forward', (event, tabId: unknown) => {
    const { tab } = requireTab(event, tabId)
    if (tab.webContents.navigationHistory.canGoForward()) tab.webContents.navigationHistory.goForward()
  })

  ipcMain.handle('nemo:reload', (event, tabId: unknown) => {
    const { tab } = requireTab(event, tabId)
    tab.webContents.reload()
  })

  ipcMain.handle('nemo:stop', (event, tabId: unknown) => {
    const { tab } = requireTab(event, tabId)
    tab.webContents.stop()
  })

  ipcMain.handle('nemo:create-window', (event) => {
    requireWindow(event)
    createWindow()
  })

  ipcMain.handle('nemo:toggle-devtools', (event, tabId: unknown) => {
    const { tab } = requireTab(event, tabId)
    if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools()
    else tab.webContents.openDevTools({ mode: 'right' })
  })

  ipcMain.handle('nemo:restart-service-workers', async (event) => {
    requireWindow(event)
    return restartServiceWorkers(session.fromPartition(PAGE_PARTITION))
  })
}
