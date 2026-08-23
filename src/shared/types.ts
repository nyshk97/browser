/** UI（レンダラー）と main プロセスで共有する型。 */

export interface TabState {
  /** タブ ID。実体は WebContents の id で、chrome.tabs の tabId と一致する。 */
  id: number
  windowId: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /**
   * View が実際に表示されているか。
   * `activeTabId` と食い違っていたらバックグラウンドタブが前面に出ている（バグ）。
   */
  visible: boolean
}

export interface WindowState {
  windowId: number
  tabs: TabState[]
  activeTabId: number | null
}

export interface ExtensionState {
  id: number
  /** lock に載っている拡張の実ロード結果。 */
  extensions: LoadedExtensionInfo[]
}

export interface LoadedExtensionInfo {
  id: string
  name: string
  version: string
  /** lock で期待していた ID / version と一致したか。 */
  matchesLock: boolean
  path: string
}

/** UI preload が contextBridge で公開する API（個別に列挙する。オブジェクトを丸ごと渡さない）。 */
export interface NemoUiApi {
  getWindowState(): Promise<WindowState>
  /** 実際に表示されている View のタブ ID（正常なら activeTabId ただ1つ）。 */
  getVisibleTabIds(): Promise<number[]>
  getExtensions(): Promise<LoadedExtensionInfo[]>
  createTab(url?: string): Promise<number>
  selectTab(tabId: number): Promise<void>
  closeTab(tabId: number): Promise<void>
  navigate(tabId: number, input: string): Promise<void>
  goBack(tabId: number): Promise<void>
  goForward(tabId: number): Promise<void>
  reload(tabId: number): Promise<void>
  stop(tabId: number): Promise<void>
  createWindow(): Promise<void>
  toggleDevTools(tabId: number): Promise<void>
  restartServiceWorkers(): Promise<number>
  onWindowState(listener: (state: WindowState) => void): () => void
}
