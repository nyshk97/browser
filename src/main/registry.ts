import { BaseWindow, WebContentsView, session, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { PAGE_PARTITION, UI_PARTITION } from './paths.js'
import {
  BLANK_URL,
  applyWebContentsSecurityDefaults,
  isLoadedExtensionUrl,
  redactUrl,
  resolveNavigationTarget
} from './security.js'
import { log } from './log.js'
import type { TabState, WindowState } from '../shared/types.js'

/**
 * Phase 0 の最小 registry。
 * Phase 1-2 で「ピン留め定義とタブ実体の分離」「所有権の移動」まで育てる想定なので、
 * ここでは所有関係（tab は必ず 1 window に属する）だけ先に固定しておく。
 */

const UI_HEIGHT = 80
const NEW_TAB_URL = BLANK_URL

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const uiPreloadPath = path.join(moduleDir, '..', 'preload', 'ui.cjs')

let extensions: ElectronChromeExtensions | null = null

export function setExtensions(instance: ElectronChromeExtensions): void {
  extensions = instance
}

export class NemoTab {
  /** タブ ID = WebContents の id。chrome.tabs の tabId と一致させる。 */
  readonly id: number
  readonly view: WebContentsView

  constructor(
    public window: NemoWindow,
    session_: Electron.Session
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        session: session_,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    this.id = this.view.webContents.id
  }

  get webContents(): WebContents {
    return this.view.webContents
  }

  toState(): TabState {
    const wc = this.webContents
    return {
      id: this.id,
      windowId: this.window.id,
      title: wc.getTitle() || wc.getURL() || 'New Tab',
      url: wc.getURL(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      visible: this.view.getVisible()
    }
  }
}

export class NemoWindow {
  static nextId = 1

  readonly id: number
  readonly baseWindow: BaseWindow
  readonly uiView: WebContentsView
  readonly tabs: NemoTab[] = []
  activeTabId: number | null = null
  private destroyed = false

  constructor() {
    this.id = NemoWindow.nextId++
    this.baseWindow = new BaseWindow({
      width: 1280,
      height: 860,
      title: 'Nemo (Spike)',
      backgroundColor: '#1b1b1f'
    })

    this.uiView = new WebContentsView({
      webPreferences: {
        // UI はページと別セッションに置く（拡張の content script を UI に入れない）
        session: session.fromPartition(UI_PARTITION),
        preload: uiPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.baseWindow.contentView.addChildView(this.uiView)

    this.baseWindow.on('resize', () => this.layout())
    this.baseWindow.on('close', () => this.destroy())

    void this.loadUi()
  }

  private loadUi(): Promise<void> {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) return this.uiWebContents.loadURL(devUrl)
    return this.uiWebContents.loadFile(path.join(moduleDir, '..', 'renderer', 'index.html'))
  }

  get uiWebContents(): WebContents {
    return this.uiView.webContents
  }

  layout(): void {
    if (this.destroyed) return
    const { width, height } = this.baseWindow.getContentBounds()
    this.uiView.setBounds({ x: 0, y: 0, width, height: UI_HEIGHT })
    // 表示・非表示は setVisible で制御し、bounds は全タブに与えておく。
    // バックグラウンドタブが 0x0 のままだと、選択した瞬間にレイアウトが走って
    // 一瞬崩れて見えるうえ、chrome.tabs のサイズも 0 になる。
    const tabBounds = { x: 0, y: UI_HEIGHT, width, height: Math.max(height - UI_HEIGHT, 0) }
    for (const tab of this.tabs) {
      tab.view.setBounds(tabBounds)
    }
  }

  /** 実際に表示されている View のタブ ID。activeTabId とズレていたらバグ。 */
  getVisibleTabIds(): number[] {
    return this.tabs.filter((t) => t.view.getVisible()).map((t) => t.id)
  }

  getActiveTab(): NemoTab | null {
    if (this.activeTabId === null) return null
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null
  }

  toState(): WindowState {
    return {
      windowId: this.id,
      tabs: this.tabs.map((t) => t.toState()),
      activeTabId: this.activeTabId
    }
  }

  pushState(): void {
    if (this.destroyed || this.uiWebContents.isDestroyed()) return
    this.uiWebContents.send('nemo:window-state', this.toState())
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    log('window.destroy', { windowId: this.id, tabs: this.tabs.length })

    // BaseWindow を閉じても子 WebContentsView の webContents は自動破棄されないため、
    // 明示的に破棄する（放置するとプロセスが残る）
    for (const tab of [...this.tabs]) {
      tabsById.delete(tab.id)
      extensions?.removeTab(tab.webContents)
      this.baseWindow.contentView.removeChildView(tab.view)
      if (!tab.webContents.isDestroyed()) tab.webContents.close()
    }
    this.tabs.length = 0
    this.activeTabId = null

    this.baseWindow.contentView.removeChildView(this.uiView)
    if (!this.uiWebContents.isDestroyed()) this.uiWebContents.close()

    windowsById.delete(this.id)
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }
}

export const windowsById = new Map<number, NemoWindow>()
export const tabsById = new Map<number, NemoTab>()

export function findWindowByUiWebContents(contents: WebContents): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.uiWebContents.id === contents.id) return win
  }
  return null
}

function pageSession(): Electron.Session {
  return session.fromPartition(PAGE_PARTITION)
}

export interface CreateTabOptions {
  /**
   * 背景で開く（アクティブタブを変えない）。
   *
   * electron-chrome-extensions は `addTab()` した時点で `tab-added` を emit し、
   * そこから `tabs.onActivated` → `store.setActiveTab` → `impl.selectTab` と流れて
   * **必ずそのタブをアクティブ扱いにする**（背景タブという概念が無い）。
   * そのため「選択しない」だけでは足りず、addTab の直後に元のタブへ戻す必要がある。
   */
  background?: boolean
}

export function createTab(
  win: NemoWindow,
  url: string = NEW_TAB_URL,
  options: CreateTabOptions = {}
): NemoTab {
  const previousActiveTabId = win.activeTabId
  // 呼び出し側が検証済みの URL を渡す前提だが、ここでも最後に必ず通す
  // （`loadURL` に生の文字列が渡る経路を1つも残さない）。
  const target =
    resolveNavigationTarget(url, { allowExtensionPages: isLoadedExtensionUrl(url) }, 'createTab') ??
    NEW_TAB_URL

  const tab = new NemoTab(win, pageSession())
  win.tabs.push(tab)
  tabsById.set(tab.id, tab)
  win.baseWindow.contentView.addChildView(tab.view)
  // 新規タブは既定で非表示にする。表示するのは selectTab だけ。
  // ここを表示のままにすると、バックグラウンドで作ったタブが
  // activeTabId と食い違って前面に描画される。
  tab.view.setVisible(false)

  const wc = tab.webContents
  applyWebContentsSecurityDefaults(wc)

  // popup（window.open / target=_blank / ⌘クリック）を Nemo のタブモデルに乗せる。
  // allow を返すと Electron が BaseWindow 外の BrowserWindow を作ってしまうため、
  // deny した上で自前で作る。
  wc.setWindowOpenHandler(({ url: popupUrl, disposition }) => {
    const popupTarget = resolveNavigationTarget(
      popupUrl,
      { allowExtensionPages: isLoadedExtensionUrl(wc.getURL()) },
      'popup'
    )
    if (popupTarget === null) return { action: 'deny' }

    if (disposition === 'new-window') {
      const newWin = createWindow(popupTarget)
      log('popup.window_created', { windowId: newWin.id, opener: tab.id })
    } else {
      const background = disposition === 'background-tab'
      const newTab = createTab(win, popupTarget, { background })
      if (!background) selectTab(win, newTab.id)
      log('popup.tab_created', {
        tabId: newTab.id,
        opener: tab.id,
        background: disposition === 'background-tab'
      })
    }
    return { action: 'deny' }
  })

  const notify = (): void => win.pushState()
  wc.on('page-title-updated', notify)
  wc.on('did-navigate', notify)
  wc.on('did-navigate-in-page', notify)
  wc.on('did-start-loading', notify)
  wc.on('did-stop-loading', notify)
  wc.on('did-finish-load', notify)
  wc.on('render-process-gone', (_e, details) => {
    log('tab.crashed', { tabId: tab.id, reason: details.reason })
    notify()
  })

  void wc.loadURL(target)
  extensions?.addTab(wc, win.baseWindow)

  // addTab がこのタブをアクティブにしてしまうので、背景指定なら元に戻す。
  if (options.background && previousActiveTabId !== null && previousActiveTabId !== tab.id) {
    selectTab(win, previousActiveTabId)
  }

  win.layout()
  log('tab.create', { tabId: tab.id, windowId: win.id, target: redactUrl(target) })
  win.pushState()
  return tab
}

export function selectTab(win: NemoWindow, tabId: number): void {
  const tab = win.tabs.find((t) => t.id === tabId)
  if (!tab) return

  // electron-chrome-extensions 側からも selectTab が飛んでくるため、
  // 既にアクティブなら通知を撃ち返さない（撃ち返すと相互再入で止まらなくなる）。
  if (win.activeTabId === tabId) {
    for (const other of win.tabs) {
      other.view.setVisible(other.id === tabId)
    }
    return
  }

  for (const other of win.tabs) {
    other.view.setVisible(other.id === tabId)
  }
  win.activeTabId = tabId
  win.layout()
  extensions?.selectTab(tab.webContents)
  log('tab.select', { tabId, windowId: win.id })
  win.pushState()
}

export function removeTab(win: NemoWindow, tabId: number): void {
  const index = win.tabs.findIndex((t) => t.id === tabId)
  if (index === -1) return
  const [tab] = win.tabs.splice(index, 1)
  tabsById.delete(tab.id)
  extensions?.removeTab(tab.webContents)
  win.baseWindow.contentView.removeChildView(tab.view)
  if (!tab.webContents.isDestroyed()) tab.webContents.close()
  log('tab.remove', { tabId, windowId: win.id })

  if (win.activeTabId === tabId) {
    const next = win.tabs[Math.min(index, win.tabs.length - 1)]
    if (next) {
      selectTab(win, next.id)
      return
    }
    win.activeTabId = null
  }
  win.pushState()
}

export function createWindow(initialUrl?: string): NemoWindow {
  const win = new NemoWindow()
  windowsById.set(win.id, win)
  log('window.create', { windowId: win.id })

  win.uiWebContents.once('did-finish-load', () => {
    const tab = createTab(win, initialUrl ?? NEW_TAB_URL)
    selectTab(win, tab.id)
    win.layout()
  })

  return win
}

export function removeWindow(win: NemoWindow): void {
  win.destroy()
  if (!win.baseWindow.isDestroyed()) win.baseWindow.close()
}

/** BaseWindow から NemoWindow を引く（extensions のコールバック用）。 */
export function findWindowByBaseWindow(baseWindow: Electron.BaseWindow): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.baseWindow.id === baseWindow.id) return win
  }
  return null
}

/** BaseWindow.id（= chrome.windows の windowId）から NemoWindow を引く。 */
export function findWindowByBaseWindowId(baseWindowId: number): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.baseWindow.id === baseWindowId) return win
  }
  return null
}

/** WebContents から所属タブを引く。 */
export function findTabByWebContents(contents: WebContents): NemoTab | null {
  return tabsById.get(contents.id) ?? null
}

export function focusedOrFirstWindow(): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.baseWindow.isFocused()) return win
  }
  for (const win of windowsById.values()) {
    if (!win.isDestroyed) return win
  }
  return null
}
