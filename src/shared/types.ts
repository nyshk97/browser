/** UI（レンダラー）と main プロセスで共有する型。 */

/* ------------------------------------------------------------------ *
 * サイドバーの3層（Favorites / ピン留め / 一時タブ）
 *
 * 「定義」と「タブ実体」を必ず別 ID で扱う。
 * - 定義（Favorite / PinnedNode）は**全ウィンドウ共有**で永続化される
 * - タブ実体（TabState）は**必ず1つの windowId に所属**し、揮発する
 * ------------------------------------------------------------------ */

/** サイドバー上部のアイコングリッド。全ウィンドウ共有。 */
export interface FavoriteItem {
  id: string
  url: string
  title: string
}

/** ピン留め（フォルダで入れ子にできる）。全ウィンドウ共有。 */
export type PinnedNode = PinnedLink | PinnedFolder

export interface PinnedLink {
  id: string
  kind: 'link'
  title: string
  url: string
}

export interface PinnedFolder {
  id: string
  kind: 'folder'
  title: string
  collapsed: boolean
  children: PinnedNode[]
}

/* ------------------------------------------------------------------ *
 * タブ実体
 * ------------------------------------------------------------------ */

export interface TabState {
  /**
   * Nemo のタブ ID。**WebContents の id とは別**。
   * sleep / discard で WebContents を捨てても、ウィンドウを移しても不変。
   */
  key: string
  windowId: number
  /**
   * 対応する WebContents の id（= `chrome.tabs` の tabId）。
   * sleep 中は null。**Nemo のタブ ID は `key` の方**で、これは拡張との対応を見るためだけに出す。
   */
  webContentsId: number | null
  /** BaseWindow の id（= `chrome.windows` の windowId）。拡張との対応の検証に使う。 */
  chromeWindowId: number
  /** ピン留め定義に紐づいているタブなら、その定義 ID。一時タブなら null。 */
  pinnedId: string | null
  title: string
  url: string
  faviconUrl: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** メモリ解放済み（再訪時に読み直す）。 */
  asleep: boolean
  /** 直近でアクティブだった時刻（自動アーカイブの判定に使う）。 */
  lastActiveAt: number
  /** View が実際に表示されているか。activeTabKey と食い違っていたらバグ。 */
  visible: boolean
  /** renderer がクラッシュした状態か。 */
  crashed: boolean
  /** 音を鳴らしているか。 */
  audible: boolean
  /** 非アクティブのまま読み込みが終わった（サイドバーの未読表示に使う）。 */
  unread: boolean
  zoomFactor: number
}

export interface WindowState {
  windowId: number
  tabs: TabState[]
  activeTabKey: string | null
  sidebarVisible: boolean
  fullScreen: boolean
  find: FindState | null
}

export interface FindState {
  query: string
  activeMatch: number
  totalMatches: number
}

/** サイドバーに出す共有データ（全ウィンドウで同じ）。 */
export interface SharedState {
  favorites: FavoriteItem[]
  pinned: PinnedNode[]
  downloads: DownloadState[]
}

/* ------------------------------------------------------------------ *
 * ダウンロード
 * ------------------------------------------------------------------ */

export interface DownloadState {
  id: string
  filename: string
  savePath: string
  /** 受信済みバイト数 / 総バイト数（不明なら null）。 */
  receivedBytes: number
  totalBytes: number | null
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
  /** 表示用のホスト名だけ（フル URL は保持しない）。 */
  host: string
}

/* ------------------------------------------------------------------ *
 * ダイアログ（権限 / HTTP 認証 / 証明書）
 * ------------------------------------------------------------------ */

export type PermissionKind =
  | 'geolocation'
  | 'notifications'
  | 'media'
  | 'camera'
  | 'microphone'
  | 'clipboard-read'
  | 'midi'
  | 'pointerLock'
  | 'display-capture'
  | 'idle-detection'

export interface PermissionPrompt {
  type: 'permission'
  id: string
  origin: string
  permission: PermissionKind
}

export interface AuthPrompt {
  type: 'auth'
  id: string
  /** `host:port`。URL のパス以降は載せない。 */
  host: string
  realm: string
  isProxy: boolean
}

export interface CertificatePrompt {
  type: 'certificate'
  id: string
  host: string
  errorCode: string
  issuerName: string
  subjectName: string
  validStart: number
  validExpiry: number
}

export interface ExternalProtocolPrompt {
  type: 'external-protocol'
  id: string
  scheme: string
  /** 表示用に短縮した文字列（クエリは落とす）。 */
  display: string
}

export type Prompt = PermissionPrompt | AuthPrompt | CertificatePrompt | ExternalProtocolPrompt

/* ------------------------------------------------------------------ *
 * コマンドバーの候補
 * ------------------------------------------------------------------ */

export type SuggestionKind = 'tab' | 'pinned' | 'favorite' | 'history' | 'search' | 'url'

export interface Suggestion {
  kind: SuggestionKind
  title: string
  /** 表示用の副題（URL など）。 */
  subtitle: string
  /** 選択したときに実行する対象。 */
  target: { type: 'navigate'; url: string } | { type: 'select-tab'; key: string }
}

/* ------------------------------------------------------------------ *
 * 設定
 * ------------------------------------------------------------------ */

export interface NemoSettings {
  /** 非アクティブタブを sleep させるまでの時間（分単位）。0 で無効。 */
  tabSleepMinutes: number
  sidebarVisible: boolean
  /** 検索エンジンの URL テンプレート（`{q}` を置換する）。 */
  searchTemplate: string
  /** キーバインドの上書き（`command` → アクセラレータ）。 */
  keybindings: Record<string, string>
  /** 起動時にセッションを復元する。 */
  restoreSession: boolean
  /** ダウンロード先を毎回聞く。 */
  askDownloadLocation: boolean
}

/* ------------------------------------------------------------------ *
 * 拡張
 * ------------------------------------------------------------------ */

export interface LoadedExtensionInfo {
  id: string
  name: string
  version: string
  /** lock で期待していた ID / version と一致したか。 */
  matchesLock: boolean
  path: string
  /** オプションページを持っているか。 */
  optionsUrl: string | null
}

/* ------------------------------------------------------------------ *
 * preload が公開する API
 * ------------------------------------------------------------------ */

export interface NemoUiApi {
  /* 状態 */
  getWindowState(): Promise<WindowState>
  getSharedState(): Promise<SharedState>
  getSettings(): Promise<NemoSettings>
  getExtensions(): Promise<LoadedExtensionInfo[]>
  /** 実際に表示されている View のタブ key（正常なら activeTabKey ただ1つ）。 */
  getVisibleTabKeys(): Promise<string[]>

  /* タブ */
  createTab(url?: string, options?: { background?: boolean }): Promise<string>
  selectTab(key: string): Promise<void>
  closeTab(key: string): Promise<void>
  moveTabToNewWindow(key: string): Promise<void>
  navigate(key: string, input: string): Promise<void>
  goBack(key: string): Promise<void>
  goForward(key: string): Promise<void>
  reload(key: string): Promise<void>
  stop(key: string): Promise<void>
  setZoom(key: string, factor: number): Promise<number>

  /* サイドバー（定義） */
  openPinned(pinnedId: string): Promise<void>
  pinTab(key: string): Promise<void>
  unpin(pinnedId: string): Promise<void>
  addFavorite(key: string): Promise<void>
  removeFavorite(favoriteId: string): Promise<void>
  openFavorite(favoriteId: string): Promise<void>
  createFolder(title: string): Promise<void>
  renameNode(id: string, title: string): Promise<void>
  toggleFolder(id: string): Promise<void>
  /** ドラッグ & ドロップの結果を反映する。 */
  movePinned(id: string, parentId: string | null, index: number): Promise<void>
  moveFavorite(id: string, index: number): Promise<void>

  /* ウィンドウ */
  createWindow(): Promise<void>
  setSidebarVisible(visible: boolean): Promise<void>
  /** オーバーレイ（コマンドバー / 検索バー / ダウンロード）の表示切り替え。 */
  setOverlay(kind: 'command-bar' | 'find' | 'downloads' | null): Promise<void>
  toggleDevTools(key: string): Promise<void>
  copyUrl(key: string): Promise<void>

  /* コマンドバー */
  suggest(query: string): Promise<Suggestion[]>

  /* ページ内検索 */
  find(key: string, query: string, options?: { forward?: boolean; findNext?: boolean }): Promise<void>
  stopFind(key: string): Promise<void>

  /* ダウンロード */
  cancelDownload(id: string): Promise<void>
  revealDownload(id: string): Promise<void>
  clearDownloads(): Promise<void>

  /* ダイアログ */
  resolvePrompt(id: string, answer: PromptAnswer): Promise<void>

  /* 設定 */
  updateSettings(patch: Partial<NemoSettings>): Promise<NemoSettings>

  /* 拡張 */
  openExtensionOptions(extensionId: string): Promise<void>
  restartServiceWorkers(): Promise<number>
  /** 診断ログのフォルダを Finder で開く。 */
  openLogFolder(): Promise<void>

  /** オーバーレイの現在の状態（購読より前に起きた分を取りこぼさないため）。 */
  getOverlayState(): Promise<{ kind: string | null; prompt: Prompt | null }>

  /* 購読 */
  onWindowState(listener: (state: WindowState) => void): () => void
  onSharedState(listener: (state: SharedState) => void): () => void
  onPrompt(listener: (prompt: Prompt | null) => void): () => void
  onCommand(listener: (command: string) => void): () => void
  onOverlay(listener: (kind: string | null) => void): () => void
}

export type PromptAnswer =
  | { kind: 'permission'; allow: boolean; remember: boolean }
  | { kind: 'auth'; username: string; password: string }
  | { kind: 'auth-cancel' }
  | { kind: 'certificate'; proceed: boolean }
  | { kind: 'external-protocol'; open: boolean; remember: boolean }
