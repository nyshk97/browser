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
  /** 既定名（ピン時のページタイトル。読み込みのたびに更新される）。 */
  title: string
  /** ユーザーが付けた名前。null なら未設定で、表示は `title` に戻る。 */
  customTitle: string | null
}

/** ピン留め（フォルダで入れ子にできる）。全ウィンドウ共有。 */
export type PinnedNode = PinnedLink | PinnedFolder

export interface PinnedLink {
  id: string
  kind: 'link'
  /** 既定名（ピン時のページタイトル。読み込みのたびに更新される）。 */
  title: string
  /** ユーザーが付けた名前。null なら未設定で、表示は `title` に戻る。 */
  customTitle: string | null
  url: string
}

export interface PinnedFolder {
  id: string
  kind: 'folder'
  title: string
  customTitle: string | null
  collapsed: boolean
  /** フォルダは1階層まで。ここに入るのは必ず link だけ。 */
  children: PinnedNode[]
}

/**
 * 消えた（消える）定義の名前。
 *
 * 専用タブが一時タブへ降格するとき、**所属していた定義の名前をタブへ写す**必要がある。
 * ID だけ返すと、定義に付けていた名前がその瞬間に失われる。
 */
export interface RemovedDefinition {
  id: string
  title: string
  customTitle: string | null
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
   * 自分が Peek（ウィンドウ内ポップアップ）なら、その親タブの key。通常タブなら null。
   * **サイドバーの一覧には出さない**（親タブが1本出ているだけに見せる）。
   */
  peekParentKey: string | null
  /**
   * 対応する WebContents の id（= `chrome.tabs` の tabId）。
   * sleep 中は null。**Nemo のタブ ID は `key` の方**で、これは拡張との対応を見るためだけに出す。
   */
  webContentsId: number | null
  /** BaseWindow の id（= `chrome.windows` の windowId）。拡張との対応の検証に使う。 */
  chromeWindowId: number
  /** ピン留め定義に紐づいているタブなら、その定義 ID。一時タブなら null。 */
  pinnedId: string | null
  /**
   * Favorite 定義に紐づいているタブなら、その定義 ID。
   * `pinnedId` とは**排他**（両方 non-null にはしない）。
   */
  favoriteId: string | null
  title: string
  /**
   * ユーザーが付けた名前（一時タブぶん）。null なら未設定。
   * **専用タブ（pinnedId / favoriteId を持つ）の表示名は定義側が正**で、
   * ここは降格したときに名前を引き継ぐための控えとして持つ。
   */
  customTitle: string | null
  url: string
  faviconUrl: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** メモリ解放済み（再訪時に読み直す）。 */
  asleep: boolean
  /** 直近でアクティブだった時刻（自動アーカイブの判定に使う）。 */
  lastActiveAt: number
  /**
   * View が実際に表示されているか。
   * 正常なら「選択中の通常タブ」と、あれば「その Peek」の2つだけが true になる。
   */
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
  /**
   * シークレットウィンドウか。
   * ページは**メモリ上だけのセッション**に置かれ、拡張はロードされない
   * （＝ Bitwarden の自動入力が使えない）。UI にその旨を出すために持つ。
   */
  isPrivate: boolean
  /**
   * ウィンドウの種別。
   * `mini` は小窓（Little Nemo）。サイドバーを持たず、タブは常に1つ。
   */
  kind: 'normal' | 'mini'
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
  /** 動いているアプリのバージョン（`0.1.0`）。 */
  version: string
  /** アプリ内自動更新の状態。 */
  update: UpdateState
}

/**
 * アプリ内自動更新の状態。
 *
 * 更新は既定で自動的に落としてくるが、**適用は終了時**なので
 * 「落とし終えて再起動待ち」（`ready`）をユーザーに見せる必要がある。
 */
export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  /** 取得中 / 適用待ちのバージョン。 */
  version: string | null
  /** ダウンロードの進捗（%）。 */
  percent: number | null
  error: string | null
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

/**
 * macOS 側（システム設定 > プライバシーとセキュリティ）でマイク / カメラが
 * 拒否されている、という案内。Nemo が許可してもページには何も渡らないので、
 * 「許可したのに映らない・聞こえない」で詰まらないように出す。
 */
export interface SystemMediaPrompt {
  type: 'system-media'
  id: string
  kind: 'microphone' | 'camera'
}

export type Prompt =
  PermissionPrompt | AuthPrompt | CertificatePrompt | ExternalProtocolPrompt | SystemMediaPrompt

/* ------------------------------------------------------------------ *
 * コマンドバーの候補
 * ------------------------------------------------------------------ */

export type SuggestionKind = 'tab' | 'pinned' | 'favorite' | 'history' | 'search' | 'url'

export interface Suggestion {
  kind: SuggestionKind
  title: string
  /**
   * 行頭に出すアイコン。**解決は main 側で完結させる**（renderer は DB を持たない）。
   * null ならホスト頭文字のレターアバターに落ちる。`kind: 'search'` は常に null で、
   * renderer が虫眼鏡を描く。
   */
  faviconUrl: string | null
  /** 表示用の副題（URL など）。 */
  subtitle: string
  /** 選択したときに実行する対象。 */
  target: { type: 'navigate'; url: string } | { type: 'select-tab'; key: string }
}

/* ------------------------------------------------------------------ *
 * タブスイッチャー（⌃M）
 * ------------------------------------------------------------------ */

export interface SwitcherTab {
  key: string
  title: string
  url: string
  faviconUrl: string | null
}

/**
 * ⌃M を押している間だけ出る、直近に使ったタブの並び。
 * 並びは main が握る（押している最中に順番が変わると狙ったタブに行けない）。
 */
export interface SwitcherState {
  /** MRU 順（先頭が今のタブ）。 */
  tabs: SwitcherTab[]
  /** 今ハイライトしている位置。 */
  index: number
}

/* ------------------------------------------------------------------ *
 * ライブラリ（履歴 / アーカイブ）
 * ------------------------------------------------------------------ */

export interface HistoryEntry {
  url: string
  title: string
  visitCount: number
  lastVisitedAt: number
  /** ページが申告した favicon。未記録なら null（ホスト頭文字で代用する）。 */
  faviconUrl: string | null
}

export interface ArchivedTab {
  url: string
  title: string
  archivedAt: number
  /** `auto`（放置して自動）/ `closed`（閉じた）/ `imported`（Arc から取り込み）。 */
  reason: string
}

/* ------------------------------------------------------------------ *
 * 既定ブラウザ
 * ------------------------------------------------------------------ */

export interface DefaultBrowserStatus {
  http: boolean
  https: boolean
  isDefault: boolean
  /** この起動では設定できるか（開発起動では false）。 */
  canRequest: boolean
  reason: string | null
}

/* ------------------------------------------------------------------ *
 * 設定
 * ------------------------------------------------------------------ */

export interface NemoSettings {
  /** 非アクティブタブを sleep させるまでの時間（分単位）。0 で無効。 */
  tabSleepMinutes: number
  /**
   * 触っていない一時タブを自動でアーカイブするまでの時間（時間単位）。0 で無効。
   * アーカイブされたタブは閉じるが、ライブラリから掘り返せる。
   */
  tabArchiveHours: number
  /**
   * サイドバーの表示状態。
   * **起動時は必ず true に戻す**（隠したまま起動すると、戻す手段が ⌘S だけになり、
   * 空タブと重なって手がかりの無い真っ黒な窓になる）。
   */
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

/** アプリの初期化状況。外から「もう見てよいか」を判断するために出す。 */
export interface AppStatus {
  /** 起動時のウィンドウとタブが揃ったか。 */
  ready: boolean
  windows: number
  tabs: number
  extensions: number
}

/* ------------------------------------------------------------------ *
 * 会議の小窓（Meet の通話コントロール）
 * ------------------------------------------------------------------ */

/**
 * 会議の小窓に出す状態。
 *
 * 真偽の向きは **`*Enabled` に統一**する（`micEnabled: true` = マイクが生きている
 * = UI の「ON」）。Meet の DOM は `data-is-muted="true"` が「切れている」で向きが逆なので、
 * **反転はアダプタ（`meet-adapter.ts`）の中の1か所だけ**で行う。
 * `mic` のような向きの分からない名前は使わない（反転事故が見た目では分からない）。
 *
 * **`null` は「不明」**で、`false`（切れている）とは別物。
 * プローブが読めないとき（縮退）は3つとも `null` にする。
 */
export interface CallState {
  /** 表示するホスト名（`meet.google.com`）。 */
  host: string
  /**
   * 参加を検知した時刻。**経過時間は renderer 側でここから数える**（毎秒 IPC を撃たない）。
   * 縮退中は `null`（経過時間を出さない）。
   */
  joinedAt: number | null
  micEnabled: boolean | null
  camEnabled: boolean | null
  /** プローブが読めていない（戻るボタンだけの小窓になる）。 */
  degraded: boolean
}

export interface NemoUiApi {
  /* 状態 */
  getAppStatus(): Promise<AppStatus>
  getWindowState(): Promise<WindowState>
  getSharedState(): Promise<SharedState>
  getSettings(): Promise<NemoSettings>
  getExtensions(): Promise<LoadedExtensionInfo[]>
  /**
   * 実際に表示されている View のタブ key。
   * 正常なら「選択中の通常タブ」と、あれば「その Peek」の最大2つ。
   */
  getVisibleTabKeys(): Promise<string[]>

  /* タブ */
  createTab(url?: string, options?: { background?: boolean }): Promise<string>
  selectTab(key: string): Promise<void>
  closeTab(key: string): Promise<void>
  moveTabToNewWindow(key: string): Promise<void>
  navigate(key: string, input: string): Promise<void>
  goBack(key: string): Promise<void>
  goForward(key: string): Promise<void>
  /** `ignoreCache` でキャッシュを無視して読み直す（スーパーリロード）。 */
  reload(key: string, options?: { ignoreCache?: boolean }): Promise<void>
  stop(key: string): Promise<void>
  setZoom(key: string, factor: number): Promise<number>

  /* サイドバー（定義） */
  openPinned(pinnedId: string): Promise<void>
  pinTab(key: string): Promise<void>
  /** タブをピン留めツリーの指定位置へ置く（サイドバーへのドラッグ & ドロップ）。 */
  pinTabAt(key: string, parentId: string | null, index: number): Promise<void>
  unpin(pinnedId: string): Promise<void>
  addFavorite(key: string): Promise<void>
  removeFavorite(favoriteId: string): Promise<void>
  openFavorite(favoriteId: string): Promise<void>
  createFolder(title: string): Promise<void>
  /** 定義（ピン / フォルダ / Favorite）の名前を変える。`null` で解除して既定名に戻す。 */
  renameNode(id: string, title: string | null): Promise<void>
  /** タブの名前を変える（専用タブなら所属定義を、一時タブならタブ自身を）。`null` で解除。 */
  renameTab(key: string, title: string | null): Promise<void>
  /**
   * そのタブが属するピン定義の URL を、今開いているページに差し替える。
   * **定義 ID は渡さない**（main 側でタブから導出する）。
   */
  updatePinnedUrl(key: string): Promise<void>
  toggleFolder(id: string): Promise<void>
  /** ドラッグ & ドロップの結果を反映する。 */
  movePinned(id: string, parentId: string | null, index: number): Promise<void>
  moveFavorite(id: string, index: number): Promise<void>

  /* Peek / 小窓 */
  /**
   * ⌘O と同じ。Peek なら同じウィンドウのタブへ、小窓なら直近の通常ウィンドウのタブへ。
   * **どちらもページは読み直さない**。
   */
  promoteForegroundView(): Promise<void>
  /** 選択中のタブに浮いている Peek を閉じる（✕）。 */
  closePeek(): Promise<void>

  /* ウィンドウ */
  createWindow(): Promise<void>
  /** シークレットウィンドウ（拡張なし・メモリ内セッション）。 */
  createPrivateWindow(): Promise<void>
  setSidebarVisible(visible: boolean): Promise<void>
  /** オーバーレイ（コマンドバー / 検索バー / ダウンロード）の表示切り替え。 */
  setOverlay(
    kind: 'command-bar' | 'address-bar' | 'find' | 'downloads' | 'library' | 'settings' | null
  ): Promise<void>
  toggleDevTools(key: string): Promise<void>
  copyUrl(key: string): Promise<void>

  /* コマンドバー */
  suggest(query: string): Promise<Suggestion[]>

  /* ページ内検索 */
  find(key: string, query: string, options?: { forward?: boolean; findNext?: boolean }): Promise<void>
  stopFind(key: string): Promise<void>

  /* ライブラリ（履歴 / アーカイブ） */
  queryHistory(query: string): Promise<HistoryEntry[]>
  removeHistory(url: string): Promise<void>
  clearHistory(): Promise<void>
  queryArchive(query: string): Promise<ArchivedTab[]>
  removeArchived(url: string): Promise<void>
  clearArchive(): Promise<void>

  /* 既定ブラウザ */
  getDefaultBrowserStatus(): Promise<DefaultBrowserStatus>
  /** 既定ブラウザにするよう OS に要求し、**確かめた結果**を返す。 */
  requestDefaultBrowser(): Promise<DefaultBrowserStatus>

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

  /* 更新 */
  checkForUpdates(): Promise<void>
  /** 落とし終えた更新を適用する（再起動の確認ダイアログを出す）。 */
  restartForUpdate(): Promise<void>

  /** オーバーレイの現在の状態（購読より前に起きた分を取りこぼさないため）。 */
  getOverlayState(): Promise<{
    kind: string | null
    prompt: Prompt | null
    switcher: SwitcherState | null
  }>

  /* 会議の小窓（`?view=call` からだけ呼べる。**引数は取らない**） */
  getCallState(): Promise<CallState | null>
  /** 会議タブへ戻る（ウィンドウを前面に + そのタブをアクティブに）。 */
  callFocusTab(): Promise<void>
  /** マイクを切り替える。**楽観更新しない**（結果は push を待つ）。 */
  callToggleMic(): Promise<void>
  /** カメラを切り替える。**楽観更新しない**。 */
  callToggleCam(): Promise<void>
  /** ✕。会議タブに一度戻るまで出さない。 */
  callDismiss(): Promise<void>
  onCallState(listener: (state: CallState) => void): () => void

  /* タブスイッチャー（⌃M） */
  /**
   * 帯を出す / 1つ先へ進める（⌃M と同じ）。
   * 確定・取消・ハイライトの移動と同じ面に置いて、経路を1本にまとめている。
   */
  switchTab(): Promise<void>
  /**
   * カードをクリックしてそのタブへ確定する。
   * **位置ではなく key で渡す**（帯の表示が1件ぶん古いときに別のタブへ飛ばさないため）。
   */
  pickSwitcherTab(key: string): Promise<void>
  /** 切り替えをやめる（背景クリック）。 */
  cancelSwitcher(): Promise<void>

  /* 購読 */
  onWindowState(listener: (state: WindowState) => void): () => void
  onSharedState(listener: (state: SharedState) => void): () => void
  onPrompt(listener: (prompt: Prompt | null) => void): () => void
  onCommand(listener: (command: string) => void): () => void
  onOverlay(listener: (kind: string | null) => void): () => void
  onSwitcher(listener: (state: SwitcherState | null) => void): () => void
}

export type PromptAnswer =
  | { kind: 'permission'; allow: boolean; remember: boolean }
  | { kind: 'auth'; username: string; password: string }
  | { kind: 'auth-cancel' }
  | { kind: 'certificate'; proceed: boolean }
  | { kind: 'external-protocol'; open: boolean; remember: boolean }
  | { kind: 'system-media'; openSettings: boolean }
