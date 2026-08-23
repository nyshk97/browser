import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type { LoadedExtensionInfo, NemoUiApi, WindowState } from '../shared/types.js'

// <browser-action-list> をブラウザ UI に注入する。
// この preload は UI 用 WebContentsView にしか付けないので、
// リモートページ側に特権 API が漏れることはない。
injectBrowserAction()

// 公開する API は個別に列挙する（オブジェクトを丸ごと渡さない）
const api: NemoUiApi = {
  getWindowState: () => ipcRenderer.invoke('nemo:get-window-state') as Promise<WindowState>,
  getVisibleTabIds: () => ipcRenderer.invoke('nemo:get-visible-tab-ids') as Promise<number[]>,
  getExtensions: () => ipcRenderer.invoke('nemo:get-extensions') as Promise<LoadedExtensionInfo[]>,
  createTab: (url) => ipcRenderer.invoke('nemo:create-tab', url) as Promise<number>,
  selectTab: (tabId) => ipcRenderer.invoke('nemo:select-tab', tabId) as Promise<void>,
  closeTab: (tabId) => ipcRenderer.invoke('nemo:close-tab', tabId) as Promise<void>,
  navigate: (tabId, input) => ipcRenderer.invoke('nemo:navigate', tabId, input) as Promise<void>,
  goBack: (tabId) => ipcRenderer.invoke('nemo:go-back', tabId) as Promise<void>,
  goForward: (tabId) => ipcRenderer.invoke('nemo:go-forward', tabId) as Promise<void>,
  reload: (tabId) => ipcRenderer.invoke('nemo:reload', tabId) as Promise<void>,
  stop: (tabId) => ipcRenderer.invoke('nemo:stop', tabId) as Promise<void>,
  createWindow: () => ipcRenderer.invoke('nemo:create-window') as Promise<void>,
  toggleDevTools: (tabId) => ipcRenderer.invoke('nemo:toggle-devtools', tabId) as Promise<void>,
  restartServiceWorkers: () =>
    ipcRenderer.invoke('nemo:restart-service-workers') as Promise<number>,
  onWindowState: (listener) => {
    const handler = (_event: unknown, state: WindowState): void => listener(state)
    ipcRenderer.on('nemo:window-state', handler)
    return () => ipcRenderer.removeListener('nemo:window-state', handler)
  }
}

contextBridge.exposeInMainWorld('nemo', api)
