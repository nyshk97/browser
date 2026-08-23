import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type {
  LoadedExtensionInfo,
  NemoSettings,
  NemoUiApi,
  Prompt,
  PromptAnswer,
  SharedState,
  Suggestion,
  WindowState
} from '../shared/types.js'

// <browser-action-list> をブラウザ UI に注入する。
// この preload は UI 用 WebContentsView にしか付けないので、
// リモートページ側に特権 API が漏れることはない。
injectBrowserAction()

/** 公開する API は個別に列挙する（オブジェクトを丸ごと渡さない）。 */
const api: NemoUiApi = {
  getWindowState: () => ipcRenderer.invoke('nemo:get-window-state') as Promise<WindowState>,
  getSharedState: () => ipcRenderer.invoke('nemo:get-shared-state') as Promise<SharedState>,
  getSettings: () => ipcRenderer.invoke('nemo:get-settings') as Promise<NemoSettings>,
  getExtensions: () => ipcRenderer.invoke('nemo:get-extensions') as Promise<LoadedExtensionInfo[]>,
  getVisibleTabKeys: () => ipcRenderer.invoke('nemo:get-visible-tab-keys') as Promise<string[]>,

  createTab: (url, options) => ipcRenderer.invoke('nemo:create-tab', url, options) as Promise<string>,
  selectTab: (key) => ipcRenderer.invoke('nemo:select-tab', key) as Promise<void>,
  closeTab: (key) => ipcRenderer.invoke('nemo:close-tab', key) as Promise<void>,
  moveTabToNewWindow: (key) => ipcRenderer.invoke('nemo:move-tab-to-new-window', key) as Promise<void>,
  navigate: (key, input) => ipcRenderer.invoke('nemo:navigate', key, input) as Promise<void>,
  goBack: (key) => ipcRenderer.invoke('nemo:go-back', key) as Promise<void>,
  goForward: (key) => ipcRenderer.invoke('nemo:go-forward', key) as Promise<void>,
  reload: (key) => ipcRenderer.invoke('nemo:reload', key) as Promise<void>,
  stop: (key) => ipcRenderer.invoke('nemo:stop', key) as Promise<void>,
  setZoom: (key, factor) => ipcRenderer.invoke('nemo:set-zoom', key, factor) as Promise<number>,

  openPinned: (pinnedId) => ipcRenderer.invoke('nemo:open-pinned', pinnedId) as Promise<void>,
  pinTab: (key) => ipcRenderer.invoke('nemo:pin-tab', key) as Promise<void>,
  unpin: (pinnedId) => ipcRenderer.invoke('nemo:unpin', pinnedId) as Promise<void>,
  addFavorite: (key) => ipcRenderer.invoke('nemo:add-favorite', key) as Promise<void>,
  removeFavorite: (favoriteId) => ipcRenderer.invoke('nemo:remove-favorite', favoriteId) as Promise<void>,
  openFavorite: (favoriteId) => ipcRenderer.invoke('nemo:open-favorite', favoriteId) as Promise<void>,
  createFolder: (title) => ipcRenderer.invoke('nemo:create-folder', title) as Promise<void>,
  renameNode: (id, title) => ipcRenderer.invoke('nemo:rename-node', id, title) as Promise<void>,
  toggleFolder: (id) => ipcRenderer.invoke('nemo:toggle-folder', id) as Promise<void>,
  movePinned: (id, parentId, index) =>
    ipcRenderer.invoke('nemo:move-pinned', id, parentId, index) as Promise<void>,
  moveFavorite: (id, index) => ipcRenderer.invoke('nemo:move-favorite', id, index) as Promise<void>,

  createWindow: () => ipcRenderer.invoke('nemo:create-window') as Promise<void>,
  setSidebarVisible: (visible) => ipcRenderer.invoke('nemo:set-sidebar-visible', visible) as Promise<void>,
  setOverlay: (kind) => ipcRenderer.invoke('nemo:set-overlay', kind) as Promise<void>,
  toggleDevTools: (key) => ipcRenderer.invoke('nemo:toggle-devtools', key) as Promise<void>,
  copyUrl: (key) => ipcRenderer.invoke('nemo:copy-url', key) as Promise<void>,

  suggest: (query) => ipcRenderer.invoke('nemo:suggest', query) as Promise<Suggestion[]>,

  find: (key, query, options) => ipcRenderer.invoke('nemo:find', key, query, options) as Promise<void>,
  stopFind: (key) => ipcRenderer.invoke('nemo:stop-find', key) as Promise<void>,

  cancelDownload: (id) => ipcRenderer.invoke('nemo:cancel-download', id) as Promise<void>,
  revealDownload: (id) => ipcRenderer.invoke('nemo:reveal-download', id) as Promise<void>,
  clearDownloads: () => ipcRenderer.invoke('nemo:clear-downloads') as Promise<void>,

  resolvePrompt: (id, answer: PromptAnswer) =>
    ipcRenderer.invoke('nemo:resolve-prompt', id, answer) as Promise<void>,

  updateSettings: (patch) => ipcRenderer.invoke('nemo:update-settings', patch) as Promise<NemoSettings>,

  openExtensionOptions: (extensionId) =>
    ipcRenderer.invoke('nemo:open-extension-options', extensionId) as Promise<void>,
  restartServiceWorkers: () => ipcRenderer.invoke('nemo:restart-service-workers') as Promise<number>,
  openLogFolder: () => ipcRenderer.invoke('nemo:open-log-folder') as Promise<void>,

  onWindowState: (listener) => subscribe<WindowState>('nemo:window-state', listener),
  onSharedState: (listener) => subscribe<SharedState>('nemo:shared-state', listener),
  onPrompt: (listener) => subscribe<Prompt | null>('nemo:prompt', listener),
  onCommand: (listener) => subscribe<string>('nemo:command', listener),
  onOverlay: (listener) => subscribe<string | null>('nemo:overlay', listener)
}

function subscribe<T>(eventName: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(eventName, handler)
  return () => ipcRenderer.removeListener(eventName, handler)
}

contextBridge.exposeInMainWorld('nemo', api)
