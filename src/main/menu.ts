import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { COMMANDS, SELECT_TAB_ACCELERATORS, resolveKeybindings } from '../shared/keybindings.js'
import { getSettings, onSettingsChanged } from './store/settings.js'
import { log } from './log.js'
import {
  createTab,
  createWindow,
  focusedOrFirstWindow,
  moveTabToWindow,
  openPrivateWindow,
  removeTab,
  removeWindow,
  reopenClosedTab,
  selectTab,
  togglePin,
  type NemoWindow
} from './registry.js'
import { addFavorite } from './store/pins.js'
import { checkForUpdatesManually } from './updater.js'

/**
 * メニューバーとキーバインド（計画 1-7）。
 *
 * アクセラレータは**メニュー項目として登録する**（`globalShortcut` は使わない）。
 * globalShortcut は Nemo が背面にいるときも奪ってしまい、他アプリの ⌘T が効かなくなる。
 *
 * 「UI 側で処理したいコマンド」（コマンドバーを開く等）は、main から
 * `nemo:command` を送って UI に処理させる。UI に無い操作は main で完結させる。
 */

/** UI（レンダラー）に投げるコマンド。main では処理しない。 */
const UI_COMMANDS = new Set([
  'command-bar',
  'focus-address',
  'find',
  'find-next',
  'find-previous',
  'show-downloads',
  'show-library',
  'show-settings'
])

function sendToUi(win: NemoWindow, command: string): void {
  for (const contents of [win.chromeWebContents, win.overlayWebContents]) {
    if (!contents.isDestroyed()) contents.send('nemo:command', command)
  }
}

function runCommand(command: string): void {
  const win = focusedOrFirstWindow()
  if (!win) {
    // ウィンドウが1つも無いときでも新規ウィンドウだけは作れるようにする
    if (command === 'new-window' || command === 'command-bar') createWindow()
    if (command === 'new-private-window') void openPrivateWindow()
    return
  }

  if (UI_COMMANDS.has(command)) {
    // 検索系はオーバーレイを開いてから UI に渡す
    if (command === 'find' || command === 'find-next' || command === 'find-previous') {
      if (!win.getActiveTab()) return
      win.setOverlay('find')
    }
    // ⌘T は新規タブ / ⌘L は現在のタブ。どちらで開いたかを kind で持たせる
    if (command === 'command-bar') win.setOverlay('command-bar')
    if (command === 'focus-address') win.setOverlay('address-bar')
    if (command === 'show-downloads') win.setOverlay(win.overlay === 'downloads' ? null : 'downloads')
    // ライブラリと設定は同じキーで開閉する（開いているのにもう一度押したら閉じる）
    if (command === 'show-library') win.setOverlay(win.overlay === 'library' ? null : 'library')
    if (command === 'show-settings') win.setOverlay(win.overlay === 'settings' ? null : 'settings')
    sendToUi(win, command)
    return
  }

  const tab = win.getActiveTab()

  switch (command) {
    case 'new-window':
      createWindow()
      return
    case 'new-private-window':
      // 直前まで開いていたシークレットの消去が終わってから開く
      void openPrivateWindow()
      return
    case 'close-tab':
      if (tab) removeTab(win, tab.key)
      else removeWindow(win)
      return
    case 'close-window':
      removeWindow(win)
      return
    case 'reopen-tab':
      reopenClosedTab(win)
      return
    case 'toggle-sidebar':
      win.setSidebarVisible(!win.sidebarVisible)
      return
    case 'reload':
      if (tab?.asleep) selectTab(win, tab.key)
      else tab?.webContents?.reload()
      return
    case 'reload-ignoring-cache':
      tab?.webContents?.reloadIgnoringCache()
      return
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset': {
      if (!tab) return
      const next =
        command === 'zoom-reset'
          ? 1
          : Math.min(Math.max(tab.zoomFactor + (command === 'zoom-in' ? 0.1 : -0.1), 0.25), 5)
      tab.zoomFactor = Number(next.toFixed(2))
      tab.webContents?.setZoomFactor(tab.zoomFactor)
      win.pushState()
      return
    }
    case 'toggle-fullscreen':
      win.baseWindow.setFullScreen(!win.baseWindow.isFullScreen())
      return
    case 'go-back':
      if (tab?.webContents?.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack()
      return
    case 'go-forward':
      if (tab?.webContents?.navigationHistory.canGoForward()) tab.webContents.navigationHistory.goForward()
      return
    case 'copy-url':
      if (tab) sendToUi(win, 'copy-url')
      return
    case 'pin-tab':
      // 実装は registry の togglePin に1本化する（解除は全ウィンドウに効かせる必要がある）
      if (tab) togglePin(tab)
      return
    case 'add-favorite':
      if (tab) addFavorite(tab.url, tab.title)
      return
    case 'next-tab':
    case 'previous-tab': {
      if (win.tabs.length === 0) return
      const index = win.tabs.findIndex((item) => item.key === win.activeTabKey)
      const delta = command === 'next-tab' ? 1 : -1
      const next = win.tabs[(index + delta + win.tabs.length) % win.tabs.length]
      selectTab(win, next.key)
      return
    }
    case 'move-tab-to-new-window': {
      if (!tab || win.tabs.length <= 1) return
      // 移動先も同じ性質にする（シークレットのタブは通常ウィンドウへは移せない）
      const target = createWindow(undefined, { isPrivate: win.isPrivate })
      target.whenUiReady(() => moveTabToWindow(tab, target))
      return
    }
    case 'toggle-devtools': {
      const wc = tab?.webContents
      if (!wc) return
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      else wc.openDevTools({ mode: 'right' })
      return
    }
    case 'toggle-ui-devtools': {
      const wc = win.chromeWebContents
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      else wc.openDevTools({ mode: 'detach' })
      return
    }
    default:
      log('command.unknown', { command })
  }
}

/**
 * About パネル（Apple メニュー隣のアプリメニュー）。
 *
 * `version`（= CFBundleVersion）を空にしておかないと、
 * 表示用のバージョンと同じ数字が2行に分かれて出る。
 */
function installAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'Copyright (C) 2026 nyshk97\nGPL-3.0-only'
  })
}

export function installApplicationMenu(): void {
  installAboutPanel()
  const { bindings, problems } = resolveKeybindings(getSettings().keybindings)
  for (const problem of problems) log('keybinding.rejected', problem)

  const itemsFor = (section: (typeof COMMANDS)[number]['menu']): MenuItemConstructorOptions[] =>
    COMMANDS.filter((command) => command.menu === section).map((command) => ({
      label: command.label,
      accelerator: bindings[command.id] || undefined,
      click: () => runCommand(command.id)
    }))

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `${app.name} について` },
        { label: 'アップデートを確認…', click: () => checkForUpdatesManually() },
        { type: 'separator' },
        { role: 'services', label: 'サービス' },
        { type: 'separator' },
        { role: 'hide', label: `${app.name} を隠す` },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: `${app.name} を終了` }
      ]
    },
    {
      label: 'ファイル',
      submenu: itemsFor('file')
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべてを選択' },
        { type: 'separator' },
        ...itemsFor('edit')
      ]
    },
    { label: '表示', submenu: itemsFor('view') },
    { label: '移動', submenu: itemsFor('navigate') },
    {
      label: 'タブ',
      submenu: [
        ...itemsFor('tab'),
        { type: 'separator' },
        // ⌘1〜⌘9 はメニューに出さず、アクセラレータだけ効かせる
        ...SELECT_TAB_ACCELERATORS.map((entry) => ({
          label: `${entry.index} 番目のタブ`,
          accelerator: entry.accelerator,
          visible: false,
          click: () => selectTabByIndex(entry.index)
        }))
      ]
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { role: 'minimize', label: 'しまう' },
        { role: 'zoom', label: '拡大／縮小' },
        { type: 'separator' },
        ...itemsFor('window'),
        { type: 'separator' },
        { role: 'front', label: 'すべてを手前に移動' }
      ]
    },
    { label: '開発', submenu: itemsFor('develop') }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  log('menu.installed', { commands: Object.keys(bindings).length })
}

function selectTabByIndex(index: number): void {
  const win = focusedOrFirstWindow()
  if (!win) return
  // 9 は「最後のタブ」（Chrome / Arc と同じ）
  const tab = index === 9 ? win.tabs[win.tabs.length - 1] : win.tabs[index - 1]
  if (tab) selectTab(win, tab.key)
}

/** 設定でキーバインドが変わったらメニューを作り直す。 */
export function watchKeybindingChanges(): void {
  onSettingsChanged(() => installApplicationMenu())
}

/** 新規タブ（コマンドバー無しで直接開くとき）。 */
export function newTabInFocusedWindow(url?: string): void {
  const win = focusedOrFirstWindow()
  if (!win) {
    createWindow(url)
    return
  }
  createTab(win, url)
}
