import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { createTab, createWindow, focusedOrFirstWindow, removeTab, selectTab } from './registry.js'

/** Phase 0 の最小メニュー。キーバインドの設定ファイル化は Phase 1-7。 */
export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = focusedOrFirstWindow()
            if (!win) return
            const tab = createTab(win)
            selectTab(win, tab.id)
          }
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const win = focusedOrFirstWindow()
            if (win?.activeTabId !== null && win) removeTab(win, win.activeTabId)
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const win = focusedOrFirstWindow()
            win?.getActiveTab()?.webContents.reload()
          }
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => {
            const win = focusedOrFirstWindow()
            const wc = win?.getActiveTab()?.webContents
            if (!wc) return
            if (wc.isDevToolsOpened()) wc.closeDevTools()
            else wc.openDevTools({ mode: 'right' })
          }
        },
        {
          label: 'Toggle Browser UI Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+Shift+I',
          click: () => {
            const win = focusedOrFirstWindow()
            if (!win) return
            if (win.uiWebContents.isDevToolsOpened()) win.uiWebContents.closeDevTools()
            else win.uiWebContents.openDevTools({ mode: 'detach' })
          }
        }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
