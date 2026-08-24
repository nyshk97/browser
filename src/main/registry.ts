import { BaseWindow, WebContentsView, app, session, webFrameMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { PAGE_PARTITION, UI_INDEX_URL, UI_PARTITION } from './paths.js'
import {
  BLANK_URL,
  applySessionSecurityDefaults,
  applyWebContentsSecurityDefaults,
  isLoadedExtensionUrl,
  isUiUrl,
  redactUrl,
  resolveNavigationTarget
} from './security.js'
import { log, logError } from './log.js'
import { buildSwipeInjection } from '../shared/swipe-gesture.js'
import { cancelPrompts, currentPrompt, setPromptNotifier } from './prompts.js'
import { getSettings } from './store/settings.js'
import {
  findPinned,
  findPinnedByUrl,
  getFavorites,
  getPinned,
  movePinned,
  onPinsChanged,
  pinUrl,
  unpin as unpinDefinition
} from './store/pins.js'
import { recordVisit, updateTitle } from './store/history.js'
import { archiveTab, pruneArchive, type ArchiveReason } from './store/archive.js'
import { saveSession, type SavedWindow } from './store/session.js'
import {
  forgetDownloadsForScope,
  installDownloadHandler,
  listDownloads,
  onDownloadsChanged
} from './downloads.js'
import { forgetPermissionScope } from './store/permissions.js'
import { getUpdateState, onUpdateChanged } from './updater.js'
import type { FindState, Prompt, SharedState, TabState, WindowState } from '../shared/types.js'

/**
 * タブとウィンドウの所有モデル（計画 1-2）。
 *
 * - Favorites / ピン留めの**定義**は全ウィンドウ共有（`store/pins.ts` が持つ）
 * - **実体化したタブは必ず1つの windowId に所属する**
 * - **ピン留め定義（pinnedId）とタブ実体（key）は別 ID**
 * - 別ウィンドウへの移動は**所有権の移動**（`moveTabToWindow`）
 * - 各ウィンドウが自分の activeTabKey を持つ
 *
 * タブ ID に WebContents.id を使わないのが Phase 0 との一番の違い。
 * sleep / discard で WebContents を捨てても、ウィンドウを移しても
 * UI から見た ID が変わらないようにするため。
 */

/** サイドバーの幅。 */
const SIDEBAR_WIDTH = 260
/** サイドバーを隠しているときに残す掴みしろ（macOS の信号機ボタンぶん）。 */
const SIDEBAR_HIDDEN_WIDTH = 0
/** 信号機ボタンと重ならないようにする上端の余白。 */
const TRAFFIC_LIGHT_INSET = { x: 14, y: 18 }

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const uiPreloadPath = path.join(moduleDir, '..', 'preload', 'ui.cjs')

let extensions: ElectronChromeExtensions | null = null

export function setExtensions(instance: ElectronChromeExtensions): void {
  extensions = instance
}

/**
 * ウィンドウ間でタブを移すあいだ、拡張側からの `removeTab` を無視する。
 *
 * `extensions.removeTab(wc)` は impl の `removeTab` を呼び返すので、
 * ガードしないと**移動しようとしたタブが閉じられる**。
 */
const transferringWebContents = new Set<number>()

export function isTransferring(contents: WebContents): boolean {
  return transferringWebContents.has(contents.id)
}

/* ------------------------------------------------------------------ *
 * シークレットウィンドウ（計画 2-4）
 * ------------------------------------------------------------------ */

/**
 * シークレットウィンドウのセッション。
 *
 * `persist:` を付けない partition は**メモリ上だけ**に存在する。
 * ディスクに書かないので「消え残り」を自前で検証する必要がない
 * （終了時に消す方式＝擬似シークレットは Phase 3 に置いた）。
 *
 * **全シークレットウィンドウで1つを共有する**（Chrome と同じ）。
 * ウィンドウごとに分けると、シークレットのタブを別ウィンドウへ移せず
 * （partition が違うので `moveTabToWindow` が拒否する）、
 * 2枚目のシークレットウィンドウでログインし直す羽目になる。
 *
 * **最後のシークレットウィンドウが閉じたら中身を明示的に消す**。
 * Electron は `session.fromPartition` の返り値を内部でキャッシュするので、
 * 「参照が消えれば勝手に消える」に任せると、UI に出している
 * 「閉じると跡形もなく消える」が本当かどうかが Chromium の都合に依存してしまう。
 *
 * **拡張はロードしない**。`electron-chrome-extensions` は
 * non-persistent セッションに拡張を載せられない（README の Limitations）。
 * つまりシークレットウィンドウでは Bitwarden の自動入力が使えない。UI に必ず出す。
 */
const PRIVATE_PARTITION_PREFIX = 'nemo-private-'

/**
 * 今あいているシークレットセッションの partition。
 * 1つも開いていなければ null で、次に開くときは**別の番号**を採る。
 */
let currentPrivatePartition: string | null = null
let privateGeneration = 0

function ensurePrivateSession(): string {
  if (currentPrivatePartition) return currentPrivatePartition
  privateGeneration += 1
  const partition = `${PRIVATE_PARTITION_PREFIX}${privateGeneration}`
  const privateSession = session.fromPartition(partition)
  // 権限・デバイスの既定は通常セッションと同じ（ここを省くと自動許可され得る）。
  // ただし**記憶はこの partition の中だけ**（常用プロファイルに残さない）。
  applySessionSecurityDefaults(privateSession, 'page', findWindowIdForPageContents, partition)
  // ダウンロードもここで登録する。付けないと `will-download` に誰も応えず、
  // 保存先が決まらないまま失敗する（Nemo のダウンロード一覧にも出ない）。
  installDownloadHandler(privateSession, partition)
  currentPrivatePartition = partition
  log('window.private_session_created', { generation: privateGeneration })
  return partition
}

/**
 * シークレットウィンドウが1つも無くなったときの後始末。
 *
 * **次に開くシークレットは別の partition にする**。消去は非同期なので、
 * 同じ partition を即座に貼り直すと「遅れて終わった消去が、
 * 新しいウィンドウで書いたばかりの cookie まで消す」競合になる。
 * 番号を進めておけば、消している最中に開き直しても互いに干渉しない。
 *
 * 消すもの:
 * - storage（cookie / localStorage / IndexedDB / service worker …）と cache
 * - **HTTP 認証のキャッシュ**（`clearStorageData` では消えない。
 *   消し忘れると Basic 認証が閉じても残る）
 * - この partition で覚えた権限（メモリ上）
 * - この partition のダウンロード一覧（ファイル自体は残す）
 */
function endPrivateSessionIfUnused(): void {
  const partition = currentPrivatePartition
  if (!partition) return
  const stillOpen = [...windowsById.values()].some((win) => !win.isDestroyed && win.isPrivate)
  if (stillOpen) return

  currentPrivatePartition = null
  forgetPermissionScope(partition)
  forgetDownloadsForScope(partition)

  const privateSession = session.fromPartition(partition)
  void Promise.all([
    privateSession.clearStorageData(),
    privateSession.clearCache(),
    privateSession.clearAuthCache()
  ]).then(
    () => log('window.private_session_cleared', {}),
    (error: unknown) => logError('window.private_session_clear_failed', error)
  )
}

/* ------------------------------------------------------------------ *
 * オーバーレイ（コマンドバー / 検索バー / ダイアログ / ダウンロード）
 * ------------------------------------------------------------------ */

export type OverlayKind =
  'command-bar' | 'address-bar' | 'find' | 'prompt' | 'downloads' | 'library' | 'settings' | null

/** オーバーレイの種類ごとに、UI View が受け取る矩形を決める。 */
function overlayBounds(
  kind: Exclude<OverlayKind, null>,
  content: { width: number; height: number },
  sidebarWidth: number
): Electron.Rectangle {
  switch (kind) {
    case 'command-bar':
    case 'address-bar':
      // モーダル。背景を暗くするため全面を覆う
      return { x: 0, y: 0, width: content.width, height: content.height }
    case 'find': {
      const width = Math.min(460, Math.max(content.width - sidebarWidth - 24, 240))
      return { x: content.width - width - 12, y: 12, width, height: 68 }
    }
    case 'prompt': {
      const width = Math.min(560, Math.max(content.width - sidebarWidth - 24, 320))
      return { x: sidebarWidth + 12, y: 12, width, height: 220 }
    }
    case 'downloads': {
      const width = 380
      return {
        x: Math.max(content.width - width - 12, 0),
        y: 12,
        width,
        height: Math.min(460, content.height - 24)
      }
    }
    // ライブラリと設定はページの上に大きく重ねる（別ウィンドウにしない）。
    // 独立ウィンドウにすると、拡張のタブモデルとサイドバーの3層に
    // 「どのウィンドウにも属さない画面」が増えて所有関係が崩れる。
    case 'library':
    case 'settings': {
      const margin = 24
      const width = Math.min(920, Math.max(content.width - sidebarWidth - margin * 2, 360))
      const height = Math.max(content.height - margin * 2, 240)
      return { x: sidebarWidth + margin, y: margin, width, height }
    }
  }
}

/* ------------------------------------------------------------------ *
 * タブ
 * ------------------------------------------------------------------ */

export class NemoTab {
  /** Nemo のタブ ID。sleep / ウィンドウ移動をまたいで不変。 */
  readonly key = randomUUID()
  /** ピン留め定義に紐づいているなら、その ID。 */
  pinnedId: string | null = null

  view: WebContentsView | null = null
  url: string
  title: string
  faviconUrl: string | null = null
  lastActiveAt = Date.now()
  crashed = false
  unread = false
  zoomFactor = 1
  find: FindState | null = null
  /** 次に表示するときに読み込む URL（sleep からの復帰用）。 */
  private pendingUrl: string | null = null

  constructor(
    public window: NemoWindow,
    url: string,
    title = ''
  ) {
    this.url = url
    this.title = title || url
  }

  get webContents(): WebContents | null {
    const contents = this.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  get asleep(): boolean {
    return this.view === null
  }

  /** WebContents を作って表示できる状態にする。 */
  materialize(): WebContentsView {
    if (this.view) return this.view

    const view = new WebContentsView({
      webPreferences: {
        // シークレットウィンドウのタブは、そのウィンドウ専用のメモリ内セッションに置く
        session: session.fromPartition(this.window.partition),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // ページ側 preload には特権 API を一切載せない（そもそも指定しない）
        safeDialogs: true
      }
    })
    this.view = view
    this.crashed = false

    const wc = view.webContents
    applyWebContentsSecurityDefaults(
      wc,
      (contents) => findWindowIdForPageContents(contents),
      this.window.isPrivate ? this.window.partition : null
    )
    attachTabEvents(this, wc)

    // ここに来る時点でウィンドウは生きている前提だが、
    // 落ちると「エラーダイアログが出てアプリごと止まる」なので最後にもう一度見る
    if (this.window.isDestroyed || this.window.baseWindow.isDestroyed()) {
      log('tab.materialize_rejected', { key: this.key, reason: 'window_destroyed' })
      if (!wc.isDestroyed()) wc.close()
      this.view = null
      throw new Error('window has been destroyed')
    }
    this.window.baseWindow.contentView.addChildView(view)
    view.setVisible(false)

    const target = this.pendingUrl ?? this.url
    this.pendingUrl = null
    const resolved =
      resolveNavigationTarget(target, { allowExtensionPages: isLoadedExtensionUrl(target) }, 'materialize') ??
      BLANK_URL
    void wc.loadURL(resolved)
    // シークレットウィンドウのタブは拡張のタブモデルに載せない
    // （拡張がロードされていないセッションなので、載せても対応する tab が作れない）
    if (!this.window.isPrivate) extensions?.addTab(wc, this.window.baseWindow)
    if (this.zoomFactor !== 1) wc.setZoomFactor(this.zoomFactor)
    return view
  }

  /** メモリを解放する。URL / タイトルは残すので、選び直せば元に戻る。 */
  sleep(): void {
    const view = this.view
    if (!view) return
    const wc = view.webContents
    this.pendingUrl = this.url
    this.view = null
    this.find = null
    this.window.baseWindow.contentView.removeChildView(view)
    if (!wc.isDestroyed()) {
      if (!this.window.isPrivate) extensions?.removeTab(wc)
      wc.close()
    }
    log('tab.slept', { key: this.key, windowId: this.window.id })
  }

  toState(): TabState {
    const wc = this.webContents
    return {
      key: this.key,
      windowId: this.window.id,
      webContentsId: wc ? wc.id : null,
      chromeWindowId: this.window.baseWindow.isDestroyed() ? -1 : this.window.baseWindow.id,
      pinnedId: this.pinnedId,
      title: displayTitle(this.title, this.url),
      url: this.url,
      faviconUrl: this.faviconUrl,
      loading: wc ? wc.isLoading() : false,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      asleep: this.asleep,
      lastActiveAt: this.lastActiveAt,
      visible: this.view?.getVisible() ?? false,
      crashed: this.crashed,
      audible: wc ? wc.isCurrentlyAudible() : false,
      unread: this.unread,
      zoomFactor: this.zoomFactor
    }
  }
}

/** 空タブは URL をそのまま出さずに「新しいタブ」と表示する。 */
function displayTitle(title: string, url: string): string {
  if (title && title !== BLANK_URL) return title
  if (!url || url === BLANK_URL) return '新しいタブ'
  return url
}

function attachTabEvents(tab: NemoTab, wc: WebContents): void {
  const win = () => tab.window
  const notify = (): void => win().pushState()

  const syncUrl = (): void => {
    const current = wc.getURL()
    if (current && current !== BLANK_URL) tab.url = current
  }

  // シークレットウィンドウのタブは履歴に一切残さない
  const remember = (fn: () => void): void => {
    if (win().isPrivate) return
    fn()
  }

  wc.on('page-title-updated', (_event, title) => {
    tab.title = title
    remember(() => updateTitle(tab.url, title))
    notify()
  })
  wc.on('page-favicon-updated', (_event, favicons) => {
    tab.faviconUrl = favicons[0] ?? null
    notify()
  })
  wc.on('did-start-loading', notify)
  wc.on('did-stop-loading', () => {
    // 非アクティブのまま読み込みが終わったら未読にする
    if (win().activeTabKey !== tab.key) tab.unread = true
    notify()
  })
  wc.on('did-navigate', (_event, url) => {
    syncUrl()
    remember(() => recordVisit(url, tab.title))
    tab.find = null
    notify()
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    syncUrl()
    remember(() => recordVisit(url, tab.title))
    notify()
  })
  wc.on('did-finish-load', () => {
    syncUrl()
    notify()
  })
  wc.on('audio-state-changed', notify)
  wc.on('found-in-page', (_event, result) => {
    log('find.result', { matches: result.matches, active: result.activeMatchOrdinal })
    tab.find = {
      query: tab.find?.query ?? '',
      activeMatch: result.activeMatchOrdinal,
      totalMatches: result.matches
    }
    notify()
  })
  wc.on('render-process-gone', (_event, details) => {
    tab.crashed = true
    log('tab.crashed', { key: tab.key, windowId: win().id, reason: details.reason })
    notify()
    // クラッシュしたタブは自動で読み直す（1回だけ）。
    // ループを避けるため、読み直しても直後に落ちる場合は crashed のまま残す。
    if (details.reason === 'crashed' || details.reason === 'oom') {
      setTimeout(() => {
        if (tab.crashed && tab.webContents && !tab.webContents.isDestroyed()) {
          log('tab.crash_reload', { key: tab.key })
          tab.crashed = false
          tab.webContents.reload()
          notify()
        }
      }, 500)
    }
  })
  wc.on('unresponsive', () => log('tab.unresponsive', { key: tab.key }))

  attachSwipeNavigation(tab, wc)

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

    // ここは Electron のハンドラの中なので、投げると main プロセスまで届く。
    // 開き元のウィンドウが閉じかけているときに createTab が拒否することがあるので握る。
    try {
      if (disposition === 'new-window') {
        // シークレットのページから開いたウィンドウが通常セッションになると、
        // そこだけ履歴も cookie も残る。開き元の性質を引き継ぐ。
        const newWin = createWindow(popupTarget, { isPrivate: win().isPrivate })
        log('popup.window_created', { windowId: newWin.id, opener: tab.key })
      } else {
        const background = disposition === 'background-tab'
        const newTab = createTab(win(), popupTarget, { background })
        log('popup.tab_created', { key: newTab.key, opener: tab.key, background })
      }
    } catch (error) {
      logError('popup.create_failed', error, { opener: tab.key })
    }
    return { action: 'deny' }
  })
}

/**
 * トラックパッドの2本指スワイプで戻る / 進む（macOS の作法）。
 *
 * Electron は Chromium の overscroll history navigation を公開しておらず、
 * `BaseWindow` の `swipe` イベントは3本指スワイプにしか出ない。
 * `webContents.on('input-event')` も **ホイールの deltaX を渡してくれない**（Electron 41 で実測。
 * `type` と `modifiers` だけが入っている）ので、main 側だけでは方向すら判定できない。
 *
 * そこで判定コードを**隔離ワールド**へ入れ、ページの `wheel` から判定する。
 * ワールドが分かれているのでページからは覗けず、特権 API も渡らない
 * （ページ側 preload を持たない方針は崩さない）。履歴を動かすのはページ内の
 * `history.back()` で、Nemo 側の状態は既存の `did-navigate` が拾う。
 */
const SWIPE_WORLD_ID = 1729
const swipeInjection = buildSwipeInjection()

function attachSwipeNavigation(tab: NemoTab, wc: WebContents): void {
  const injectMain = (): void => {
    wc.executeJavaScriptInIsolatedWorld(SWIPE_WORLD_ID, [{ code: swipeInjection }]).catch((error) => {
      logError('tab.swipe_inject_failed', error, { key: tab.key })
    })
  }

  /**
   * 子フレーム。`wheel` は iframe の境界を越えて親へ伝わらないので、ここに入れないと
   * **埋め込み動画や広告の上でスワイプが死ぬ**。
   *
   * `WebFrameMain` には隔離ワールドで実行する API が無い（`executeJavaScript` だけ）ので、
   * 子フレームぶんはページと同じワールドに入る。渡しているのは
   * 「`wheel` を見て `history.back()` を呼ぶ」だけで、**ページが元から持っている能力の範囲**
   * （特権 API は載せない方針は変わらない）。見えて困るのはマーカー変数くらい。
   */
  const injectFrame = (frame: Electron.WebFrameMain | undefined | null): void => {
    if (!frame) return
    frame.executeJavaScript(swipeInjection, false).catch(() => {
      // 差し替わっている途中のフレームでは失敗する。次のナビゲーションで入り直す
    })
  }

  const injectAll = (): void => {
    try {
      injectMain()
      const main = wc.mainFrame
      for (const frame of main.framesInSubtree) {
        if (frame !== main) injectFrame(frame)
      }
    } catch {
      // WebContents が壊れている（破棄と競合した）。次のナビゲーションで入り直す
    }
  }

  // document が変わるたびに入れ直す。**戻る / 進むで戻ってきたページも入れ直す**
  // （bfcache から復元されると `dom-ready` は出ないので、それだけでは
  //  一度戻ったあと二度と効かない。検証で踏んだ）。
  // 注入コード自身が二重登録を弾くので、余分に呼んでも害はない。
  wc.on('dom-ready', injectAll)
  wc.on('did-navigate', injectAll)
  wc.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame) return
    injectFrame(webFrameMain.fromId(processId, routingId))
  })
}

/**
 * ブラウザ UI の WebContents を `nemo://ui/` から出さない。
 *
 * UI の preload は `window.nemo`（タブ操作・ナビゲーション）を公開している。
 * もし UI View が外部ページへ遷移すると、**そのページに特権 API が渡る**。
 * UI に掛けた CSP は遷移先には効かないので、ここで塞ぐ必要がある。
 *
 * 現実の経路として一番ありうるのは「リンクやファイルをサイドバーに
 * ドラッグ & ドロップする」で、これは普通にナビゲーションを起こす。
 */
function lockUiNavigation(contents: WebContents, view: 'sidebar' | 'overlay', uiUrl: string): void {
  const guard = (phase: string, url: string, preventDefault: () => void): void => {
    if (isUiUrl(url)) return
    preventDefault()
    log('ui.navigation_blocked', { view, phase, target: redactUrl(url) })
  }

  contents.on('will-navigate', (event, url) => {
    guard('will-navigate', url, () => event.preventDefault())
  })
  contents.on('will-redirect', (event, url) => {
    guard('will-redirect', url, () => event.preventDefault())
  })
  contents.on('will-frame-navigate', (event) => {
    guard('will-frame-navigate', event.url, () => event.preventDefault())
  })

  // UI から新しいウィンドウは開かせない（開くのは Nemo 側の createWindow だけ）
  contents.setWindowOpenHandler(({ url }) => {
    log('ui.window_open_blocked', { view, target: redactUrl(url) })
    return { action: 'deny' }
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log('ui.webview_blocked', { view })
  })

  // 最後の砦。上のどれかをすり抜けて外部ページに着いてしまったら、
  // 特権つきのまま放置せず UI に戻す（戻り先は必ず UI なのでループしない）。
  contents.on('did-navigate', (_event, url) => {
    if (isUiUrl(url)) return
    log('ui.navigation_reverted', { view, target: redactUrl(url) })
    // 戻り先は自分の view の URL（`?view=` を落とすと別の UI になってしまう）
    void contents.loadURL(uiUrl)
  })
}

/* ------------------------------------------------------------------ *
 * ウィンドウ
 * ------------------------------------------------------------------ */

export class NemoWindow {
  static nextId = 1

  readonly id: number
  /** シークレットウィンドウか（拡張なし・メモリ内セッション・履歴に残さない）。 */
  readonly isPrivate: boolean
  /** このウィンドウのタブが使うセッション partition。 */
  readonly partition: string
  readonly baseWindow: BaseWindow
  /** サイドバー（常時表示）。 */
  readonly chromeView: WebContentsView
  /** コマンドバー・検索バー・ダイアログ用（必要なときだけ表示）。 */
  readonly overlayView: WebContentsView
  readonly tabs: NemoTab[] = []
  activeTabKey: string | null = null
  sidebarVisible: boolean
  overlay: OverlayKind = null
  private destroyed = false
  private uiReady = false
  private pendingAfterReady: (() => void)[] = []
  private pendingAfterSettled: (() => void)[] = []

  constructor(bounds?: SavedWindow['bounds'], isPrivate = false) {
    this.id = NemoWindow.nextId++
    this.isPrivate = isPrivate
    this.partition = isPrivate ? ensurePrivateSession() : PAGE_PARTITION
    this.sidebarVisible = getSettings().sidebarVisible

    this.baseWindow = new BaseWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 860,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 640,
      minHeight: 480,
      title: isPrivate ? 'Nemo（シークレット）' : 'Nemo',
      backgroundColor: isPrivate ? '#1b1524' : '#16161a',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHT_INSET
    })

    this.chromeView = this.createUiView('sidebar')
    this.overlayView = this.createUiView('overlay')
    this.baseWindow.contentView.addChildView(this.chromeView)
    this.baseWindow.contentView.addChildView(this.overlayView)
    this.overlayView.setVisible(false)

    this.baseWindow.on('resize', () => this.layout())
    this.baseWindow.on('enter-full-screen', () => {
      this.layout()
      this.pushState()
    })
    this.baseWindow.on('leave-full-screen', () => {
      this.layout()
      this.pushState()
    })
    this.baseWindow.on('close', () => this.destroy())
  }

  private createUiView(view: 'sidebar' | 'overlay'): WebContentsView {
    const contentsView = new WebContentsView({
      webPreferences: {
        // UI はページと別セッションに置く（拡張の content script を UI に入れない）
        session: session.fromPartition(UI_PARTITION),
        preload: uiPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        transparent: view === 'overlay'
      }
    })
    if (view === 'overlay') contentsView.setBackgroundColor('#00000000')

    const uiUrl = `${UI_INDEX_URL}?view=${view}&window=${this.id}${this.isPrivate ? '&private=1' : ''}`
    lockUiNavigation(contentsView.webContents, view, uiUrl)

    void contentsView.webContents.loadURL(uiUrl)

    // `once` ではなく `on`。dev の HMR や、何らかの理由で読み直したときにも
    // 状態を送り直さないと、UI が空のまま復帰しない。
    contentsView.webContents.on('did-finish-load', () => {
      if (view === 'sidebar') {
        this.uiReady = true
        const queued = this.pendingAfterReady
        this.pendingAfterReady = []
        // 破棄済みなら実行しない（ロード完了と close が競合する）
        if (!this.destroyed) for (const fn of queued) fn()
        this.settle()
      } else {
        // オーバーレイは購読しかしないので、読み込み直後に**今の状態を送り直す**。
        // ここが無いと、起動直後に出た権限・認証ダイアログが
        // 「購読前に送られて誰も受け取らない」状態になり、
        // ページ側の callback が永久に解決しない（実際に競合しうる）。
        this.overlayWebContents.send('nemo:overlay', this.overlay)
        this.pushPrompt(currentPrompt(this.id))
      }
      this.pushState()
      this.pushShared()
    })
    return contentsView
  }

  /**
   * UI の準備ができてから実行する。
   *
   * **ウィンドウが破棄済みなら実行しない**。
   * UI のロード完了前に閉じられたウィンドウでコールバック（初期タブの生成など）が走ると、
   * 破棄済みの `contentView` に触って main プロセスが
   * `TypeError: Object has been destroyed` で落ちる（エラーダイアログが出る）。
   * `window.open` で開いたウィンドウをすぐ閉じると実際に起きる。
   */
  whenUiReady(fn: () => void): void {
    if (this.destroyed) return
    if (this.uiReady) fn()
    else this.pendingAfterReady.push(fn)
  }

  /**
   * 「UI の準備ができた」か「破棄された」かのどちらかで必ず1回呼ぶ。
   * 起動完了の判定に使う（閉じられたウィンドウを待ち続けて ready にならない、を避ける）。
   */
  whenUiSettled(fn: () => void): void {
    if (this.uiReady || this.destroyed) {
      fn()
      return
    }
    this.pendingAfterSettled.push(fn)
  }

  private settle(): void {
    const queued = this.pendingAfterSettled
    this.pendingAfterSettled = []
    for (const fn of queued) fn()
  }

  get chromeWebContents(): WebContents {
    return this.chromeView.webContents
  }

  get overlayWebContents(): WebContents {
    return this.overlayView.webContents
  }

  get sidebarWidth(): number {
    return this.sidebarVisible ? SIDEBAR_WIDTH : SIDEBAR_HIDDEN_WIDTH
  }

  layout(): void {
    if (this.destroyed || this.baseWindow.isDestroyed()) return
    const { width, height } = this.baseWindow.getContentBounds()
    const sidebar = this.sidebarWidth

    this.chromeView.setBounds({ x: 0, y: 0, width: sidebar, height })
    this.chromeView.setVisible(this.sidebarVisible)

    // 表示・非表示は setVisible で制御し、bounds は全タブに与えておく。
    // バックグラウンドタブが 0x0 のままだと、選択した瞬間にレイアウトが走って
    // 一瞬崩れて見えるうえ、chrome.tabs のサイズも 0 になる。
    const pageBounds = {
      x: sidebar,
      y: 0,
      width: Math.max(width - sidebar, 0),
      height: Math.max(height, 0)
    }
    for (const tab of this.tabs) tab.view?.setBounds(pageBounds)

    if (this.overlay) {
      this.overlayView.setBounds(overlayBounds(this.overlay, { width, height }, sidebar))
      this.overlayView.setVisible(true)
      // オーバーレイは必ず最前面にする（タブを作ると子 View の順序が変わる）
      this.baseWindow.contentView.removeChildView(this.overlayView)
      this.baseWindow.contentView.addChildView(this.overlayView)
    } else {
      this.overlayView.setVisible(false)
    }
  }

  setOverlay(kind: OverlayKind): void {
    if (this.overlay === kind) return
    this.overlay = kind
    this.layout()
    if (kind) this.overlayWebContents.focus()
    else this.getActiveTab()?.webContents?.focus()
    this.overlayWebContents.send('nemo:overlay', kind)
    this.pushState()
  }

  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible
    this.layout()
    this.pushState()
  }

  /** 実際に表示されている View のタブ key。activeTabKey とズレていたらバグ。 */
  getVisibleTabKeys(): string[] {
    return this.tabs.filter((tab) => tab.view?.getVisible()).map((tab) => tab.key)
  }

  getActiveTab(): NemoTab | null {
    if (this.activeTabKey === null) return null
    return this.tabs.find((tab) => tab.key === this.activeTabKey) ?? null
  }

  findTab(key: string): NemoTab | null {
    return this.tabs.find((tab) => tab.key === key) ?? null
  }

  toState(): WindowState {
    const active = this.getActiveTab()
    return {
      windowId: this.id,
      tabs: this.tabs.map((tab) => tab.toState()),
      activeTabKey: this.activeTabKey,
      sidebarVisible: this.sidebarVisible,
      fullScreen: this.baseWindow.isDestroyed() ? false : this.baseWindow.isFullScreen(),
      find: active?.find ?? null,
      isPrivate: this.isPrivate
    }
  }

  pushState(): void {
    if (this.destroyed) return
    const state = this.toState()
    for (const contents of [this.chromeWebContents, this.overlayWebContents]) {
      if (!contents.isDestroyed()) contents.send('nemo:window-state', state)
    }
    scheduleSessionSave()
  }

  pushShared(): void {
    if (this.destroyed) return
    const shared: SharedState = {
      favorites: getFavorites(),
      pinned: getPinned(),
      downloads: listDownloads(),
      version: app.getVersion(),
      update: getUpdateState()
    }
    for (const contents of [this.chromeWebContents, this.overlayWebContents]) {
      if (!contents.isDestroyed()) contents.send('nemo:shared-state', shared)
    }
  }

  pushPrompt(prompt: Prompt | null): void {
    if (this.destroyed) return
    if (!this.overlayWebContents.isDestroyed()) {
      this.overlayWebContents.send('nemo:prompt', prompt)
    }
    // ダイアログが出ている間はオーバーレイを出しっぱなしにする
    if (prompt) this.setOverlay('prompt')
    else if (this.overlay === 'prompt') this.setOverlay(null)
  }

  /** UI の WebContents か（IPC の送信元検証に使う）。 */
  ownsUiContents(contents: WebContents): boolean {
    if (this.destroyed) return false
    return (
      (!this.chromeWebContents.isDestroyed() && this.chromeWebContents.id === contents.id) ||
      (!this.overlayWebContents.isDestroyed() && this.overlayWebContents.id === contents.id)
    )
  }

  toSaved(): SavedWindow {
    const bounds = this.baseWindow.isDestroyed() ? null : this.baseWindow.getBounds()
    const tabs = this.tabs
      .filter((tab) => /^https?:\/\//.test(tab.url))
      // lastActiveAt も保存する。落とすと自動アーカイブの寿命が再起動でリセットされる
      .map((tab) => ({
        url: tab.url,
        title: tab.title,
        pinnedId: tab.pinnedId,
        lastActiveAt: tab.lastActiveAt
      }))
    const activeIndex = Math.max(
      this.tabs
        .filter((tab) => /^https?:\/\//.test(tab.url))
        .findIndex((tab) => tab.key === this.activeTabKey),
      0
    )
    return { bounds, tabs, activeIndex }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    log('window.destroy', { windowId: this.id, tabs: this.tabs.length })

    // UI の準備待ちで積んであった処理は捨てる（破棄済みのウィンドウでは走らせない）。
    // 「準備できたか破棄されたか」を待っている側にはここで知らせる。
    this.pendingAfterReady = []
    this.settle()

    cancelPrompts(this.id)

    // BaseWindow を閉じても子 WebContentsView の webContents は自動破棄されないため、
    // 明示的に破棄する（放置するとプロセスが残る）
    for (const tab of [...this.tabs]) {
      const wc = tab.webContents
      if (tab.view) this.baseWindow.contentView.removeChildView(tab.view)
      if (wc) {
        if (!this.isPrivate) extensions?.removeTab(wc)
        wc.close()
      }
      tab.view = null
    }
    this.tabs.length = 0
    this.activeTabKey = null

    for (const view of [this.chromeView, this.overlayView]) {
      this.baseWindow.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }

    windowsById.delete(this.id)
    // 最後のシークレットウィンドウが閉じたら中身を消す（UI で約束している挙動）
    if (this.isPrivate) endPrivateSessionIfUnused()
    scheduleSessionSave()
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }
}

export const windowsById = new Map<number, NemoWindow>()

/* ------------------------------------------------------------------ *
 * 検索・参照
 * ------------------------------------------------------------------ */

export function findWindowByUiWebContents(contents: WebContents): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (win.ownsUiContents(contents)) return win
  }
  return null
}

/** ページ側 WebContents から所属ウィンドウの ID を引く（権限ダイアログの宛先決定に使う）。 */
export function findWindowIdForPageContents(contents: WebContents): number | null {
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    for (const tab of win.tabs) {
      if (tab.webContents?.id === contents.id) return win.id
    }
  }
  // popup（拡張のブラウザアクション）など、タブでない WebContents はフォーカス中のウィンドウに出す
  return focusedOrFirstWindow()?.id ?? null
}

export function findTabByWebContents(contents: WebContents): { win: NemoWindow; tab: NemoTab } | null {
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    for (const tab of win.tabs) {
      if (tab.webContents?.id === contents.id) return { win, tab }
    }
  }
  return null
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

export function focusedOrFirstWindow(): NemoWindow | null {
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.baseWindow.isFocused()) return win
  }
  for (const win of windowsById.values()) {
    if (!win.isDestroyed) return win
  }
  return null
}

/* ------------------------------------------------------------------ *
 * タブ操作
 * ------------------------------------------------------------------ */

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
  /** ピン留め定義に紐づくタブとして作る。 */
  pinnedId?: string | null
  title?: string
  /** 直後に selectTab しない（セッション復元でまとめて作るとき）。 */
  deferSelect?: boolean
  /**
   * WebContents を作らずに枠だけ用意する（sleep 状態で生成）。
   * セッション復元で数十タブを一気に立ち上げないために使う。
   * 選択された時点で `materialize()` される。
   */
  asleep?: boolean
  /**
   * 最後にアクティブだった時刻を引き継ぐ（セッション復元）。
   * 省略すると「たった今」になり、**自動アーカイブの寿命がリセットされる**。
   */
  lastActiveAt?: number
}

export function createTab(win: NemoWindow, url: string = BLANK_URL, options: CreateTabOptions = {}): NemoTab {
  // 破棄済みのウィンドウにタブを足さない。
  // 足すと `contentView.addChildView` が投げ、main プロセスが落ちる。
  if (win.isDestroyed || win.baseWindow.isDestroyed()) {
    log('tab.create_rejected', { windowId: win.id, reason: 'window_destroyed' })
    throw new Error('window has been destroyed')
  }

  const previousActiveKey = win.activeTabKey
  // 呼び出し側が検証済みの URL を渡す前提だが、ここでも最後に必ず通す
  // （`loadURL` に生の文字列が渡る経路を1つも残さない）。
  const target =
    resolveNavigationTarget(url, { allowExtensionPages: isLoadedExtensionUrl(url) }, 'createTab') ?? BLANK_URL

  const tab = new NemoTab(win, target, options.title)
  if (typeof options.lastActiveAt === 'number' && Number.isFinite(options.lastActiveAt)) {
    tab.lastActiveAt = Math.min(options.lastActiveAt, Date.now())
  }
  // 消えた定義への紐付けを持ち込ませない（セッション復元で古い pinnedId が来る）。
  // 紐付いたままだと、サイドバーのどの層にも出ないタブになる。
  tab.pinnedId = options.pinnedId && findPinned(options.pinnedId) ? options.pinnedId : null
  win.tabs.push(tab)
  if (!options.asleep) tab.materialize()
  win.layout()

  log('tab.create', {
    key: tab.key,
    windowId: win.id,
    target: redactUrl(target),
    asleep: options.asleep === true
  })

  if (options.asleep) {
    // 何も表示しないし選択もしない。選ばれた時点で materialize される。
  } else if (options.background) {
    // addTab がこのタブをアクティブにしてしまうので、背景指定なら元に戻す。
    if (previousActiveKey !== null && previousActiveKey !== tab.key) selectTab(win, previousActiveKey)
    else tab.view?.setVisible(false)
  } else if (!options.deferSelect) {
    selectTab(win, tab.key)
  }

  win.pushState()
  return tab
}

export function selectTab(win: NemoWindow, key: string): void {
  const tab = win.findTab(key)
  if (!tab) return

  // sleep していたら起こす
  if (tab.asleep) {
    tab.materialize()
    win.layout()
    log('tab.woke', { key: tab.key, windowId: win.id })
  }

  const already = win.activeTabKey === key
  for (const other of win.tabs) other.view?.setVisible(other.key === key)
  tab.lastActiveAt = Date.now()
  tab.unread = false

  if (already) return

  win.activeTabKey = key
  win.layout()
  const wc = tab.webContents
  // electron-chrome-extensions 側からも selectTab が飛んでくるため、
  // 既にアクティブなら通知を撃ち返さない（撃ち返すと相互再入で止まらなくなる）。
  if (wc && !win.isPrivate) extensions?.selectTab(wc)
  log('tab.select', { key, windowId: win.id })
  win.pushState()
}

/** 閉じたタブ（⌘⇧T で開き直す）。ウィンドウをまたいで1本のスタックにする。 */
const closedTabs: { url: string; title: string; pinnedId: string | null }[] = []
const CLOSED_TAB_LIMIT = 25

export function removeTab(
  win: NemoWindow,
  key: string,
  options: { archiveReason?: ArchiveReason } = {}
): void {
  const index = win.tabs.findIndex((tab) => tab.key === key)
  if (index === -1) return
  const [tab] = win.tabs.splice(index, 1)

  // シークレットのタブは ⌘⇧T の対象にしない（閉じたら跡形もなく消えるのが約束）
  if (/^https?:\/\//.test(tab.url) && !win.isPrivate) {
    closedTabs.push({ url: tab.url, title: tab.title, pinnedId: tab.pinnedId })
    if (closedTabs.length > CLOSED_TAB_LIMIT) closedTabs.shift()
    // 一時タブを閉じたらアーカイブに残す（Arc と同じで、閉じても掘り返せる）
    if (tab.pinnedId === null) archiveTab(tab.url, tab.title, options.archiveReason ?? 'closed')
  }

  const wc = tab.webContents
  if (tab.view) win.baseWindow.contentView.removeChildView(tab.view)
  if (wc) {
    if (!win.isPrivate) extensions?.removeTab(wc)
    wc.close()
  }
  tab.view = null
  log('tab.remove', { key, windowId: win.id })

  if (win.activeTabKey === key) {
    const next = win.tabs[Math.min(index, win.tabs.length - 1)]
    win.activeTabKey = null
    if (next) {
      selectTab(win, next.key)
      return
    }
  }
  win.pushState()
}

export function reopenClosedTab(win: NemoWindow): void {
  const entry = closedTabs.pop()
  if (!entry) return
  createTab(win, entry.url, { pinnedId: entry.pinnedId, title: entry.title })
}

/**
 * タブの所有権を別ウィンドウへ移す。
 * WebContents は作り直さない（ログイン状態やスクロール位置を保つ）。
 */
export function moveTabToWindow(tab: NemoTab, target: NemoWindow): void {
  const source = tab.window
  if (source === target) return
  // シークレットと通常はセッションが違う。View を作り直さずに移すと、
  // 移した先で「シークレットのはずのタブが通常セッションのまま」になる。
  if (source.partition !== target.partition) {
    log('tab.move_rejected', { key: tab.key, reason: 'different_session' })
    return
  }
  const index = source.tabs.indexOf(tab)
  if (index === -1) return
  source.tabs.splice(index, 1)

  const view = tab.view
  const wc = tab.webContents
  if (view) source.baseWindow.contentView.removeChildView(view)

  tab.window = target
  target.tabs.push(tab)

  if (view && wc) {
    target.baseWindow.contentView.addChildView(view)
    // 拡張側の tab → window 対応を貼り替える。
    // removeTab は impl.removeTab を呼び返してタブを閉じるので、その間だけ無視する。
    //
    // **シークレットのタブは拡張のタブモデルに載っていない**ので触らない。
    // 渡すと `Invalid WebContents argument. Its session must match ...` で投げる
    // （main の例外ハンドラに落ちるだけで移動自体は済むため、気づきにくい）。
    if (!target.isPrivate) {
      transferringWebContents.add(wc.id)
      try {
        extensions?.removeTab(wc)
        extensions?.addTab(wc, target.baseWindow)
      } finally {
        transferringWebContents.delete(wc.id)
      }
    }
  }

  if (source.activeTabKey === tab.key) {
    source.activeTabKey = null
    const next = source.tabs[Math.min(index, source.tabs.length - 1)]
    if (next) selectTab(source, next.key)
  }
  source.layout()
  source.pushState()

  selectTab(target, tab.key)
  target.layout()
  log('tab.moved', { key: tab.key, from: source.id, to: target.id })
}

/* ------------------------------------------------------------------ *
 * ウィンドウ生成 / 破棄
 * ------------------------------------------------------------------ */

export interface CreateWindowOptions {
  bounds?: SavedWindow['bounds']
  /** セッション復元のように、呼び出し側が自分でタブを入れる場合。 */
  noInitialTab?: boolean
  /** シークレットウィンドウとして作る（拡張なし・メモリ内セッション）。 */
  isPrivate?: boolean
}

export function createWindow(initialUrl?: string, options: CreateWindowOptions = {}): NemoWindow {
  const win = new NemoWindow(options.bounds, options.isPrivate === true)
  windowsById.set(win.id, win)
  log('window.create', { windowId: win.id, private: win.isPrivate })

  win.whenUiReady(() => {
    if (!options.noInitialTab && win.tabs.length === 0) createTab(win, initialUrl ?? BLANK_URL)
    win.layout()
  })

  return win
}

export function removeWindow(win: NemoWindow): void {
  win.destroy()
  if (!win.baseWindow.isDestroyed()) win.baseWindow.close()
}

/* ------------------------------------------------------------------ *
 * ピン留めとタブ実体の対応
 * ------------------------------------------------------------------ */

/**
 * ピン留め定義を消し、**全ウィンドウ**のタブから紐付けを外す。
 *
 * 定義は全ウィンドウ共有なので、操作したウィンドウのタブだけ外すのでは足りない。
 * フォルダを消したときは子孫の定義も一緒に消えるため、その ID も外す。
 * ここを1か所に寄せておかないと、解除の経路（サイドバー / メニュー）ごとに漏れが出る。
 */
export function unpinEverywhere(pinnedId: string): void {
  const removed = unpinDefinition(pinnedId)
  if (removed.length === 0) return
  const removedIds = new Set(removed)
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    let changed = false
    for (const tab of win.tabs) {
      if (tab.pinnedId && removedIds.has(tab.pinnedId)) {
        tab.pinnedId = null
        changed = true
      }
    }
    if (changed) win.pushState()
  }
}

/** ⌘D。留めていなければ留め、留めていれば解除する（解除は全ウィンドウに効く）。 */
export function togglePin(tab: NemoTab): void {
  if (tab.pinnedId) {
    unpinEverywhere(tab.pinnedId)
    return
  }
  const node = findPinnedByUrl(tab.url) ?? pinUrl(tab.url, tab.title)
  if (!node) return
  tab.pinnedId = node.id
  tab.window.pushState()
}

/**
 * タブをピン留めツリーの**指定した位置**へ置く（サイドバーへのドラッグ & ドロップ）。
 *
 * すでにピン留め済みのタブを掴んだときは、定義を作り直さず場所だけ動かす。
 * 作り直すと ID が変わり、他ウィンドウで開いている同じピン留めの紐付けが切れる。
 */
export function pinTabInto(tab: NemoTab, parentId: string | null, index: number): void {
  let pinnedId = tab.pinnedId
  if (!pinnedId) {
    const node = findPinnedByUrl(tab.url) ?? pinUrl(tab.url, tab.title)
    if (!node) return
    pinnedId = node.id
    tab.pinnedId = pinnedId
    tab.window.pushState()
  }
  movePinned(pinnedId, parentId, index)
}

/** ピン留め定義を、そのウィンドウで開く（既に開いていればそれを選ぶ）。 */
export function openPinned(win: NemoWindow, pinnedId: string): void {
  const node = findPinned(pinnedId)
  if (!node || node.kind !== 'link') return
  const existing = win.tabs.find((tab) => tab.pinnedId === pinnedId)
  if (existing) {
    selectTab(win, existing.key)
    return
  }
  createTab(win, node.url, { pinnedId, title: node.title })
}

/* ------------------------------------------------------------------ *
 * sleep タイマー / セッション保存
 * ------------------------------------------------------------------ */

let sleepTimer: NodeJS.Timeout | null = null
let sessionSaveTimer: NodeJS.Timeout | null = null

/**
 * sleep 判定の間隔。
 * 設定より短い周期で見に行かないと「30分後に寝る」が最大1分ずれる。
 * 5秒なら短い設定（自走検証で使う 0.05 分など）でも実際に効く。
 */
const SLEEP_SWEEP_MS = 5_000

export function startBackgroundWork(): void {
  sleepTimer = setInterval(() => {
    sweepSleep()
    sweepArchive()
  }, SLEEP_SWEEP_MS)
  sleepTimer.unref?.()

  // ピン留め定義が変わったら全ウィンドウのサイドバーを更新する
  onPinsChanged(() => {
    for (const win of windowsById.values()) win.pushShared()
  })
  onDownloadsChanged(() => {
    for (const win of windowsById.values()) win.pushShared()
  })
  // 更新の進捗はサイドバーに出す（適用は終了時なので「再起動待ち」を見せる必要がある）
  onUpdateChanged(() => {
    for (const win of windowsById.values()) win.pushShared()
  })

  // ダイアログの表示先はウィンドウ
  setPromptNotifier((windowId, prompt) => {
    windowsById.get(windowId)?.pushPrompt(prompt)
  })
}

/** 触っていないタブのメモリを解放する。 */
function sweepSleep(): void {
  const minutes = getSettings().tabSleepMinutes
  if (minutes <= 0) return
  const threshold = Date.now() - minutes * 60_000
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    let slept = false
    for (const tab of win.tabs) {
      if (tab.key === win.activeTabKey) continue
      if (tab.asleep) continue
      if (tab.lastActiveAt > threshold) continue
      // 音が出ているタブは寝かせない
      if (tab.webContents?.isCurrentlyAudible()) continue
      tab.sleep()
      slept = true
    }
    // 何も寝ていないなら通知しない（5秒ごとに UI を再描画しない）
    if (slept) win.pushState()
  }
}

/**
 * 放置された一時タブを自動でアーカイブする（計画 2-4。既定 24 時間）。
 *
 * 対象は**一時タブだけ**。ピン留めしたタブは触らない（Arc と同じ）。
 * アーカイブは「閉じる」だが**消さない**。ライブラリから掘り返せる。
 *
 * 触らないもの:
 * - アクティブなタブ（見ている最中に消えたら事故）
 * - 音が出ているタブ（裏で再生中）
 * - シークレットウィンドウのタブ（そもそも記録に残さない）
 */
function sweepArchive(): void {
  const hours = getSettings().tabArchiveHours
  if (hours <= 0) return
  const threshold = Date.now() - hours * 3_600_000
  let archived = 0
  for (const win of [...windowsById.values()]) {
    if (win.isDestroyed || win.isPrivate) continue
    for (const tab of [...win.tabs]) {
      if (tab.pinnedId !== null) continue
      if (tab.key === win.activeTabKey) continue
      if (tab.lastActiveAt > threshold) continue
      if (tab.webContents?.isCurrentlyAudible()) continue
      if (!/^https?:\/\//.test(tab.url)) {
        // 空タブは残しても意味が無いので、記録せずに閉じるだけ
        removeTab(win, tab.key)
        continue
      }
      // アーカイブは removeTab に任せる（経路を1本にしておかないと理由がズレる）
      removeTab(win, tab.key, { archiveReason: 'auto' })
      archived += 1
      log('tab.auto_archived', { key: tab.key, windowId: win.id })
    }
  }
  if (archived > 0) pruneArchive()
}

export function stopBackgroundWork(): void {
  if (sleepTimer) clearInterval(sleepTimer)
  sleepTimer = null
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
  sessionSaveTimer = null
}

/** セッションは頻繁に変わるのでデバウンスして書く。 */
function scheduleSessionSave(): void {
  if (sessionSaveTimer) return
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null
    saveSession(collectSession())
  }, 2000)
  sessionSaveTimer.unref?.()
}

export function collectSession(): SavedWindow[] {
  // シークレットウィンドウはディスクに残さない（復元もしない）
  return [...windowsById.values()]
    .filter((win) => !win.isDestroyed && !win.isPrivate)
    .map((win) => win.toSaved())
}

/** 起動時にダイアログ待ちの状態を UI に送り直す（ウィンドウを作り直したとき用）。 */
export function refreshPrompt(win: NemoWindow): void {
  win.pushPrompt(currentPrompt(win.id))
}
