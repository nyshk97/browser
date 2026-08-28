import {
  BaseWindow,
  View,
  WebContentsView,
  app,
  dialog,
  screen,
  session,
  webContents as webContentsModule,
  webFrameMain,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { PAGE_PARTITION } from './paths.js'
import { trackNavigationForHttpAuth } from './http-auth.js'
import {
  BLANK_URL,
  applySessionSecurityDefaults,
  applyWebContentsSecurityDefaults,
  isLoadedExtensionUrl,
  redactUrl,
  resolveNavigationTarget
} from './security.js'
import { log, logError } from './log.js'
import { createUiView, disposeUiView, type UiViewKind } from './ui-view.js'
import { buildSwipeInjection } from '../shared/swipe-gesture.js'
import { buildVimScrollInjection } from '../shared/vim-scroll.js'
import { cancelPrompts, currentPrompt, setPromptNotifier } from './prompts.js'
import { getSettings } from './store/settings.js'
import { getTimings } from './timings.js'
import {
  addFavorite as addFavoriteDefinition,
  convertFavoriteToPin,
  convertPinToFavorite,
  findFavorite,
  findPinned,
  findPinnedByUrl,
  getFavorites,
  getPinned,
  movePinned,
  onPinsChanged,
  pinUrl,
  removeFavorite as removeFavoriteDefinition,
  renameNode,
  replaceAll as replacePinsDefinition,
  setPinnedTitle,
  unpin as unpinDefinition,
  updatePinnedUrl as updatePinnedUrlDefinition,
  type ConversionResult
} from './store/pins.js'
import { recordFavicon, recordVisit, updateTitle } from './store/history.js'
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
import {
  getLiveFolderState,
  initLiveFolders,
  isLiveFolderTabUrl,
  markLiveFolderRead,
  onLiveFolderChanged,
  stopLiveFolders
} from './live-folders/index.js'
import { resolveReopen, resolveTabOwnership } from '../shared/tab-ownership.js'
import type {
  FavoriteItem,
  FindState,
  PinnedNode,
  Prompt,
  RemovedDefinition,
  SharedState,
  SplitDiagnostics,
  TabState,
  WindowState
} from '../shared/types.js'

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
/**
 * ページ領域の上に敷くツールバー（アドレスバー）の高さ。
 * **信号機ボタンと同じ行**にするため、`TRAFFIC_LIGHT_INSET` と辻褄を合わせる
 * （ボタンは 12px なので上端の余白は (40 - 12) / 2 = 14）。
 */
const TOOLBAR_HEIGHT = 40
/**
 * Peek（ウィンドウ内ポップアップ）の寸法。ページ領域に対する割合で固定する。
 * DESIGN.md「Peek」と一致させる。
 */
const PEEK_RATIO = 0.91
/** Peek の角丸（`WebContentsView.setBorderRadius`）。 */
const PEEK_RADIUS = 16
/**
 * Peek の中身が来るまで、View を出さずに待つ上限。
 *
 * 通常は `dom-ready` で切り替わる。**来ないページがある**（204 で終わる・
 * ダウンロードに化ける・開いた瞬間に `window.close()` する子）ので、
 * 保険が無いと Peek が永久に出ないままになる。
 */
const PEEK_PLACEHOLDER_TIMEOUT = 8000
/**
 * Peek の外側に ✕ / ⌘O を置くための帯。
 * **上下の余白をこれ以上に保つ**。割合だけで決めると小さいウィンドウでボタンが
 * Peek の下に潜り込み、押せなくなる（Peek は暗幕より前面にいる）。
 */
const PEEK_TOOL_BAND = 42
/** 小窓の上部バーの高さ（DESIGN.md「小窓」と一致させる）。 */
const MINI_BAR_HEIGHT = 38

/* 分割ビュー（DESIGN.md「分割ビュー」と一致させる）。 */
/** 左右のペインのあいだ。 */
const SPLIT_GAP = 8
/** ページ領域の外周の余白。**分割中だけ**空ける（単独表示は今までどおりベタ塗り）。 */
const SPLIT_INSET = 8
/**
 * ペインの角丸。
 *
 * **0 で確定している**。`View.setBorderRadius()` はその View 自身にしか効かず、
 * 子の `WebContentsView` はクリップされない（`scripts/spike-split-chrome.mjs` で実測）。
 * ページだけを丸めるとツールバーとの継ぎ目にえぐれが出るので、
 * **その見た目を取るくらいなら角丸を捨てる**という判断（DESIGN.md の決定表）。
 */
const SPLIT_RADIUS = 0
/** フォーカス中のペインの外周に出す枠の太さ。 */
const SPLIT_FOCUS_RING = 2
/** フォーカス枠の色（`--nemo-accent` の実値）。 */
const SPLIT_FOCUS_COLOR = '#5b9dff'
/**
 * ツールバーの地色（`--nemo-sidebar` の実値）。
 *
 * 右ペインのツールバーは**遅延生成して同じ `layout()` の中で表示する**ので、
 * `loadURL()` が終わるまでの数フレームは中身が無い。敷いておかないと
 * WebContents の既定色（白）が出て、初めて分割を作った瞬間だけ帯が白く光る。
 */
const TOOLBAR_GROUND_COLOR = '#1b1b20'

/**
 * ページ側 WebContents の設定。
 *
 * **popup（`window.open` / `target=_blank`）の子にも同じものを明示的に渡す**。
 * `setWindowOpenHandler` の `options.webPreferences` は
 * `window.open` の feature string 由来＝**ページが制御できる値**で、
 * Electron が「embedder より緩くできない」と保証しているのは
 * `contextIsolation` / `javascript` / `nodeIntegration` / `nodeIntegrationInWorker` /
 * `sandbox` / `nodeIntegrationInSubFrames` / `enableWebSQL` の7つだけ
 * （`webviewTag` / `experimentalFeatures` / `allowRunningInsecureContent` は入っていない）。
 * spread して個別に潰すのは「潰し忘れが素通りする」ブラックリストになるので、
 * **許可を列挙するこの定数を毎回そのまま渡す**（`security.ts` の方針と揃える）。
 * Electron の doc に「`options` を使え」とあるのに使っていないのはこのため。
 */
const PAGE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  // ページ側 preload には特権 API を一切載せない（そもそも指定しない）
  safeDialogs: true
} as const
/** サイドバーを隠しているときに残す掴みしろ（macOS の信号機ボタンぶん）。 */
const SIDEBAR_HIDDEN_WIDTH = 0
/** 信号機ボタンと重ならないようにする上端の余白。**ツールバーの中央に来るように置く**。 */
const TRAFFIC_LIGHT_INSET = { x: 14, y: 14 }
/** 小窓の信号機（バーが 38px なので通常より上に寄せる）。 */
const MINI_TRAFFIC_LIGHT_INSET = { x: 12, y: 13 }
/** 小窓の既定の寸法。**記憶しない**（常に同じ場所・同じ大きさで出す）。 */
const MINI_SIZE = { width: 460, height: 560 }
/** 2枚目以降のずらし幅。 */
const MINI_CASCADE_STEP = 30
/** 小窓の上限。**ソフト上限**で、opener チェーンを守っている間だけ超過を許す（計画 R10）。 */
const MINI_WINDOW_CAP = 4

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
const PRIVATE_PARTITION = 'nemo-private'

/** ハンドラを登録済みか（**セッションは1つだけ**作って使い回す）。 */
let privateSessionPrepared = false
/** 消去中なら、その Promise。終わるまで新しいシークレットウィンドウを開かない。 */
let privateClearing: Promise<void> | null = null
/** 前回の消去のあとに実際に使われたか（使われていないなら消し直さない）。 */
let privateUsedSinceClear = false
/**
 * 直近の消去が失敗したか。
 * **失敗したまま次を開かない**（cookie も Basic 認証も残ったセッションで
 * 「跡形もなく消える」と表示するのが一番まずい）。
 */
let privateClearFailed = false
/** 消去のやり直し回数の上限。 */
const PRIVATE_CLEAR_ATTEMPTS = 3

function ensurePrivateSession(): string {
  privateUsedSinceClear = true
  if (privateSessionPrepared) return PRIVATE_PARTITION
  const privateSession = session.fromPartition(PRIVATE_PARTITION)
  // 権限・デバイスの既定は通常セッションと同じ（ここを省くと自動許可され得る）。
  // ただし**記憶はこの partition の中だけ**（常用プロファイルに残さない）。
  applySessionSecurityDefaults(privateSession, 'page', findWindowIdForPageContents, PRIVATE_PARTITION)
  // ダウンロードもここで登録する。付けないと `will-download` に誰も応えず、
  // 保存先が決まらないまま失敗する（Nemo のダウンロード一覧にも出ない）。
  installDownloadHandler(privateSession, PRIVATE_PARTITION)
  privateSessionPrepared = true
  log('window.private_session_created', {})
  return PRIVATE_PARTITION
}

/**
 * 消去中なら終わるまで待つ。
 *
 * **シークレットウィンドウはこれを通してから作る**。待たずに同じ partition を貼り直すと、
 * 「遅れて終わった消去が、新しいウィンドウで書いたばかりの cookie まで消す」競合になる。
 * 世代ごとに別 partition を作る手もあるが、Session は `clearStorageData` では破棄されず
 * ハンドラごと積み上がるので、**1つを待って使い回す**。
 */
export async function whenPrivateSessionReady(): Promise<void> {
  while (privateClearing) await privateClearing

  // 前回の消去が失敗していたら、**開く前にやり直す**。
  // 失敗をログだけにして開くと、前のセッションの cookie / Basic 認証が残ったまま
  // 「跡形もなく消える」と表示することになる。
  for (let attempt = 0; privateClearFailed && attempt < PRIVATE_CLEAR_ATTEMPTS; attempt += 1) {
    log('window.private_session_clear_retry', { attempt: attempt + 1 })
    privateClearing = clearPrivateSession().finally(() => {
      privateClearing = null
    })
    await privateClearing
  }
  if (privateClearFailed) {
    throw new Error('前のシークレットセッションを消しきれなかった')
  }
}

/**
 * シークレットウィンドウを開く。消去中なら終わってから開く。
 * **消しきれていないときは開かない**（fail-closed）。開けなかったら null を返す。
 */
export async function openPrivateWindow(initialUrl?: string): Promise<NemoWindow | null> {
  try {
    await whenPrivateSessionReady()
  } catch (error) {
    logError('window.private_window_blocked', error)
    dialog.showErrorBox(
      'シークレットウィンドウを開けません',
      '前のシークレットセッションを消しきれませんでした。\n' +
        '前回の内容が残ったまま開くのを避けるため、開くのをやめます。\n' +
        'Nemo を再起動してからやり直してください。'
    )
    return null
  }
  return createWindow(initialUrl, { isPrivate: true })
}

/**
 * シークレットセッションの中身を消す。
 *
 * **`allSettled` で全部の完了を待つ**。`all` は最初の失敗で返るので、
 * 残りの消去が「開き直した後」まで走り続け、新しく書いた状態を消す競合になる。
 * 1つでも失敗したら `privateClearFailed` を立てて、次に開くときにやり直す。
 */
function clearPrivateSession(): Promise<void> {
  const privateSession = session.fromPartition(PRIVATE_PARTITION)
  return Promise.allSettled([
    privateSession.clearStorageData(),
    privateSession.clearCache(),
    privateSession.clearAuthCache()
  ]).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length === 0) {
      privateClearFailed = false
      log('window.private_session_cleared', {})
      return
    }
    privateClearFailed = true
    for (const failure of failures) {
      logError('window.private_session_clear_failed', failure.reason)
    }
  })
}

/**
 * シークレットウィンドウが1つも無くなったときの後始末。
 *
 * 消すもの:
 * - storage（cookie / localStorage / IndexedDB / service worker …）と cache
 * - **HTTP 認証のキャッシュ**（`clearStorageData` では消えない。
 *   消し忘れると Basic 認証が閉じても残る）
 * - この partition で覚えた権限（メモリ上）
 * - この partition のダウンロード一覧（ファイル自体は残す）
 */
function endPrivateSessionIfUnused(): void {
  if (!privateSessionPrepared || privateClearing || !privateUsedSinceClear) return
  const stillOpen = [...windowsById.values()].some((win) => !win.isDestroyed && win.isPrivate)
  if (stillOpen) return

  privateUsedSinceClear = false
  forgetPermissionScope(PRIVATE_PARTITION)
  forgetDownloadsForScope(PRIVATE_PARTITION)

  privateClearing = clearPrivateSession().finally(() => {
    privateClearing = null
    // 消している最中に開いて閉じられた分をここで拾う（使われていなければ何もしない）
    endPrivateSessionIfUnused()
  })
}

/* ------------------------------------------------------------------ *
 * オーバーレイ（コマンドバー / 検索バー / ダイアログ / ダウンロード）
 * ------------------------------------------------------------------ */

export type OverlayKind =
  | 'command-bar'
  | 'address-bar'
  | 'find'
  | 'prompt'
  | 'downloads'
  | 'library'
  | 'settings'
  | 'tab-switcher'
  | null

/**
 * オーバーレイの種類ごとに、UI View が受け取る矩形を決める。
 *
 * **`pageTop` は「ページ領域の上端」**（アドレスバーの下。ツールバーの高さそのものではない）。
 * モーダル以外はここより下に置く —— 上に重ねるとアドレスバーが隠れ、
 * 「今どのページか」が見えないままダイアログに答えることになる。
 * 小窓はツールバーを持たないので 0。**分割中は外周余白のぶん下がる**ので、
 * 呼び出し側が実際のペインの上端を渡す（渡さないと 8px 上へずれてツールバーに掛かる）。
 */
function overlayBounds(
  kind: Exclude<OverlayKind, null>,
  content: { width: number; height: number },
  sidebarWidth: number,
  pageTop: number
): Electron.Rectangle {
  switch (kind) {
    // モーダル。背景を暗くするため全面を覆う。
    // タブスイッチャーもカードのクリックを受けるので同じく全面に敷く
    case 'command-bar':
    case 'address-bar':
    case 'tab-switcher':
      return { x: 0, y: 0, width: content.width, height: content.height }
    case 'find': {
      const width = Math.min(460, Math.max(content.width - sidebarWidth - 24, 240))
      return { x: content.width - width - 12, y: pageTop + 12, width, height: 68 }
    }
    case 'prompt': {
      const width = Math.min(560, Math.max(content.width - sidebarWidth - 24, 320))
      return { x: sidebarWidth + 12, y: pageTop + 12, width, height: 220 }
    }
    case 'downloads': {
      const width = 380
      return {
        x: Math.max(content.width - width - 12, 0),
        y: pageTop + 12,
        width,
        height: Math.max(Math.min(460, content.height - pageTop - 24), 120)
      }
    }
    // ライブラリと設定はページの上に大きく重ねる（別ウィンドウにしない）。
    // 独立ウィンドウにすると、拡張のタブモデルとサイドバーの3層に
    // 「どのウィンドウにも属さない画面」が増えて所有関係が崩れる。
    case 'library':
    case 'settings': {
      const margin = 24
      const width = Math.min(920, Math.max(content.width - sidebarWidth - margin * 2, 360))
      const height = Math.max(content.height - pageTop - margin * 2, 240)
      return { x: sidebarWidth + margin, y: pageTop + margin, width, height }
    }
  }
}

/**
 * Peek の矩形。ページ領域の中央に `PEEK_RATIO` で置く。
 *
 * **上下は `PEEK_TOOL_BAND` ぶんの余白を必ず残す**。✕ / ⌘O は Peek の外側
 * （暗幕の上）に置くので、余白が足りないと Peek の下に隠れて押せなくなる。
 */
function peekBounds(page: Electron.Rectangle): Electron.Rectangle {
  const width = Math.max(Math.round(page.width * PEEK_RATIO), 1)
  const height = Math.max(Math.round(Math.min(page.height * PEEK_RATIO, page.height - PEEK_TOOL_BAND * 2)), 1)
  return {
    x: page.x + Math.round((page.width - width) / 2),
    y: page.y + Math.round((page.height - height) / 2),
    width,
    height
  }
}

/* ------------------------------------------------------------------ *
 * 分割ビュー（2 ペイン）
 * ------------------------------------------------------------------ */

/**
 * 左右に並べた 2 本。
 *
 * **左右を別々のフィールドで持たない**。両方のタブが同じインスタンスを指し、
 * 「自分がどちら側か」はここから導出する。2 つのフィールドに分けると
 * 片方だけ更新して食い違う余地が生まれる（Peek の親子で踏んだのと同じ形）。
 *
 * 分割に入れるのは**一時タブだけ**（ピン留め / Favorites / Live Folder は対象外）で、
 * 1 本が入れるペアは 1 つまで。3 つ以上は作らない。
 */
export class SplitPair {
  constructor(
    readonly left: NemoTab,
    readonly right: NemoTab
  ) {}

  sideOf(tab: NemoTab): 'left' | 'right' | null {
    if (tab === this.left) return 'left'
    if (tab === this.right) return 'right'
    return null
  }

  partnerOf(tab: NemoTab): NemoTab | null {
    if (tab === this.left) return this.right
    if (tab === this.right) return this.left
    return null
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
  /** Favorite 定義に紐づいているなら、その ID（`pinnedId` とは排他）。 */
  favoriteId: string | null = null
  /**
   * ユーザーが付けた名前（一時タブぶん）。
   * **専用タブの表示名は定義側が正**で、ここは降格したときに引き継ぐための控え。
   */
  customTitle: string | null = null

  view: WebContentsView | null = null
  /**
   * このタブの上に浮いている Peek（ウィンドウ内ポップアップ）。1タブにつき1枚まで。
   * **Peek 自身も `NemoTab` で `win.tabs` に入る**（拡張のタブモデルに載せるため）。
   */
  peek: NemoTab | null = null
  /** 自分が Peek なら、その親タブ。通常タブなら `null`。 */
  peekOf: NemoTab | null = null
  /**
   * 左右に並べている相手との関係。分割していなければ `null`。
   * **相方と同じインスタンスを共有する**（`SplitPair` の JSDoc を参照）。
   * 解くのは `removeTab` / `separateSplit` の 2 か所だけ。
   */
  split: SplitPair | null = null
  /**
   * 「このタブをクリックしたらフォーカスを移す」ための購読の解除関数。
   * **見えている分割の 2 本にだけ付ける**（`applyVisibility()` が管理）。
   * `input-event` はマウス移動でも飛ぶので、常時付けっぱなしにはしない。
   */
  paneFocusOff: (() => void) | null = null
  /**
   * Peek で、**まだ中身のドキュメントが来ていない**。
   *
   * この間は View を出さず、暗幕側のプレースホルダーに任せる（DESIGN.md「Peek」）。
   * 採用済みの `WebContents` は `setBackgroundColor` を受け付けないので、
   * 「まだ描いていない View」を前に出したままにすると下の絵がそのまま透ける。
   */
  peekAwaitingDocument = false
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

  /**
   * WebContents を作って表示できる状態にする。
   *
   * `adopt` を渡すと **Electron が作った子の WebContents をそのまま抱える**。
   * `setWindowOpenHandler` の `createWindow` コールバックから使う経路で、
   * ここで自分から `loadURL` してはいけない（読み込みは Electron が
   * 「子の browsing context」として行う。自分で読み直すと POST body・
   * `window.opener`・referrer が全部落ちる。計画 R1）。
   */
  materialize(options: { adopt?: WebContents } = {}): WebContentsView {
    if (this.view) return this.view

    const view = options.adopt
      ? // Electron が用意した子を**採用する**。`createWindow` は
        // 「渡された WebContents に繋がったウィンドウを作る」契約で、
        // 自前で作った別の WebContents を返すと
        // `Invalid webContents. Created window should be connected to ...` で弾かれる。
        new WebContentsView({ webContents: options.adopt })
      : new WebContentsView({
          webPreferences: {
            // シークレットウィンドウのタブは、そのウィンドウ専用のメモリ内セッションに置く
            session: session.fromPartition(this.window.partition),
            ...PAGE_WEB_PREFERENCES
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
    attachTabEvents(this, wc, view)

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

    if (!options.adopt) {
      const target = this.pendingUrl ?? this.url
      this.pendingUrl = null
      const resolved =
        resolveNavigationTarget(
          target,
          { allowExtensionPages: isLoadedExtensionUrl(target) },
          'materialize'
        ) ?? BLANK_URL
      void wc.loadURL(resolved)
    } else {
      this.pendingUrl = null
    }
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
    // ペインのフォーカス購読は**この WebContents に張ってある**ので、ここで落とす。
    // 今は「見えていないと寝ない」ので、寝る前の非表示化で `syncPaneFocusWatchers` が
    // 既に外している（＝いまは踏まない）。ただし残ったまま起き直すと
    // 再購読条件（`!tab.paneFocusOff`）に引っかかって新しい WebContents へ張り直されず、
    // そのペインをクリックしてもフォーカスが移らなくなる。
    // `removeTab` / `moveTabToWindow` と同じ後始末をここにも置いて、
    // 寝る条件を将来触ったときに黙って壊れないようにする。
    this.paneFocusOff?.()
    this.paneFocusOff = null
    this.window.baseWindow.contentView.removeChildView(view)
    if (!wc.isDestroyed()) {
      if (!this.window.isPrivate) extensions?.removeTab(wc)
      wc.close()
    }
    log('tab.slept', { key: this.key, windowId: this.window.id })
    notifyCall()
  }

  toState(): TabState {
    const wc = this.webContents
    return {
      key: this.key,
      windowId: this.window.id,
      peekParentKey: this.peekOf?.key ?? null,
      webContentsId: wc ? wc.id : null,
      chromeWindowId: this.window.baseWindow.isDestroyed() ? -1 : this.window.baseWindow.id,
      pinnedId: this.pinnedId,
      favoriteId: this.favoriteId,
      title: displayTitle(this.title, this.url),
      customTitle: this.customTitle,
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
      zoomFactor: this.zoomFactor,
      splitPartnerKey: this.split?.partnerOf(this)?.key ?? null,
      splitSide: this.split?.sideOf(this) ?? null
    }
  }
}

/** 空タブは URL をそのまま出さずに「New Tab」と表示する（サイドバーの New Tab 行と揃える）。 */
function displayTitle(title: string, url: string): string {
  if (title && title !== BLANK_URL) return title
  if (!url || url === BLANK_URL) return 'New Tab'
  return url
}

function attachTabEvents(tab: NemoTab, wc: WebContents, view: WebContentsView): void {
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
    // 専用タブなら定義の**既定名**も追従させる（ユーザーが付けた名前は触らない）。
    // `remember` の中に置くのが肝で、**シークレットでは書かない**
    // （pins.json は永続なので、書くと「閉じたら跡形もなく消える」が破れる）。
    remember(() => {
      updateTitle(tab.url, title)
      const definitionId = tab.pinnedId ?? tab.favoriteId
      if (definitionId) setPinnedTitle(definitionId, title)
    })
    notify()
  })
  wc.on('page-favicon-updated', (_event, favicons) => {
    // **空で飛んできたら今の favicon を維持する**。読み込みの途中で一時的に空が来ることがあり、
    // そこで消しにいくとアイコンがちらつき、履歴側にも無駄な UPDATE を撃つ。
    // 「サイトが favicon をやめた」は、次に非空が来たときに上書きされる。
    const next = favicons[0]
    if (!next) return
    tab.faviconUrl = next
    // `remember` の中に置く（シークレットウィンドウでは履歴に一切書かない）
    remember(() => recordFavicon(tab.url, next))
    notify()
  })
  // HTTP 認証の自動入力は「遷移中の URL」を知らないと同一オリジン判定ができない
  // （`login` の時点で `getURL()` はまだ古いページを指している）
  trackNavigationForHttpAuth(wc)

  wc.on('did-start-loading', notify)
  wc.on('did-stop-loading', () => {
    // **見えていない**まま読み込みが終わったら未読にする。
    // `activeTabKey` で見ると、分割の相方は画面に出ているのに未読が付く
    // （落とす側だけ直しても、ここで付け直されて意味が無い）。
    if (!win().visibleTabKeys.has(tab.key)) tab.unread = true
    notify()
  })
  // 会議の検知は **`dom-ready` / `did-navigate` / `did-navigate-in-page` の3つ**で拾う。
  // **`did-navigate` を必ず入れる**（bfcache から復元されると `dom-ready` は出ない）。
  wc.on('dom-ready', () => notifyCall(tab))
  wc.on('did-navigate', (_event, url) => {
    syncUrl()
    remember(() => recordVisit(url, tab.title))
    tab.find = null
    notify()
    notifyCall(tab)
  })
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    syncUrl()
    remember(() => recordVisit(url, tab.title))
    notify()
    notifyCall(tab)
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

  // Peek が出ている間の Esc は Peek を閉じる。
  //
  // フォーカスは Peek のページ側にあることが多いので、**UI View の keydown では拾えない**。
  // ここで拾うのが唯一の経路になる。タブスイッチャー等のオーバーレイが出ている間は
  // そちらの Esc（取消）が優先なので手を出さない。
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    const current = win()
    if (current.isDestroyed || current.overlay !== null) return
    const peek = tab.peekOf ? tab : tab.peek
    if (!peek) return
    event.preventDefault()
    removeTab(current, peek.key)
  })

  attachSwipeNavigation(tab, wc)
  attachVimScroll(tab, wc)

  // ページが自分で閉じた（`window.close()`）ときの後始末。
  //
  // **sleep と removeTab を巻き込まない**。どちらも `wc.close()` を通るが、
  // その時点で `tab.view` は既に差し替わっている（sleep は null、removeTab も null）。
  // 「View がまだこの WebContents を指している」を条件にすると自分から閉じた場合だけ通る。
  wc.on('destroyed', () => {
    const current = win()
    if (current.isDestroyed) return
    if (!current.tabs.includes(tab)) return
    // **判定は View の同一性だけで行う**。`view.webContents` に触ると
    // 破棄済みで `Object has been destroyed` を投げ、main の未捕捉例外になる
    // （しかも投げた時点で以降の後始末が丸ごと飛ぶので、Peek が閉じ残る）。
    // sleep は `tab.view = null`、removeTab も `tab.view = null`、
    // 起こし直しは別の View になるので、この比較だけで自分から閉じた場合に絞れる。
    if (tab.view !== view) return
    log('tab.self_closed', { key: tab.key, windowId: current.id, peek: tab.peekOf !== null })
    removeTab(current, tab.key)
  })

  // popup（window.open / target=_blank / ⌘クリック）を Nemo のタブモデルに乗せる。
  //
  // **`deny` して URL だけ作り直す形はもう使わない**（計画 R1）。それをやると
  // 新しい browsing context に付随するもの（`<form target=_blank>` の POST body・
  // `window.opener` と `postMessage`・referrer・「開いた子だけが `window.close()` できる」
  // 関係）が全部落ちる。OAuth の戻りが閉じない・親に結果が返らない、が実害。
  //
  // 代わりに `action: 'allow'` + `createWindow` を返し、**自前の WebContents を
  // 子として使わせる**。`new BrowserWindow` は作られない。
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
      // ⌘クリック（背面タブ）だけは今までどおり背面タブ。
      // 検索結果から何本も背面に溜める操作を Peek で殺さない。
      //
      // **ただし小窓の中は例外**（計画 R8）。小窓はタブを増やせないので、
      // ここへ流すと `createTab` が例外になり、⌘クリックが黙って捨てられる。
      // 小窓の中の新規 browsing context 要求は**前面・背面を問わずもう1枚の小窓**にする。
      if (disposition === 'background-tab' && canHostAdditionalTabs(win())) {
        const newTab = createTab(win(), popupTarget, { background: true })
        log('popup.tab_created', { key: newTab.key, opener: tab.key, background: true })
        return { action: 'deny' }
      }

      // 受け皿は**ここで（同期に）決める**。`createWindow` の中で決めると、
      // そこで投げたときに `setWindowOpenHandler` の try/catch では受けられない。
      const host = preparePopupHost(tab)
      if (!host) return { action: 'deny' }
      // **`outlivesOpener: true` は必ず付ける**（計画 R11）。
      // Electron は既定で「opener が閉じたら child も閉じる」ので、
      // これが無いと**昇格して通常タブになった後でも、元の親タブを閉じると道連れで消える**。
      // 寿命は Nemo 側（`removeTab` / `destroy`）が全部持つ。
      return {
        action: 'allow',
        outlivesOpener: true,
        // 子の webPreferences は**許可の列挙をそのまま渡す**（`PAGE_WEB_PREFERENCES` の説明を見る）
        overrideBrowserWindowOptions: { webPreferences: { ...PAGE_WEB_PREFERENCES } },
        // `options.webContents` は Electron が用意した子。**型定義には載っていない**が
        // 実行時には必ず入っている（この仕組みの前提なので、無ければ例外にして気づく）。
        createWindow: (options) =>
          attachPopup(host, popupTarget, (options as { webContents?: WebContents }).webContents)
      }
    } catch (error) {
      logError('popup.create_failed', error, { opener: tab.key })
      return { action: 'deny' }
    }
  })
}

/**
 * 前面に出そうとする popup 要求の受け皿。
 *
 * | 開き元 | 受け皿 |
 * |---|---|
 * | 通常タブ | そのタブの Peek（先客がいれば閉じてから） |
 * | Peek | **その Peek を昇格させて通常タブにし**、新しい子を昇格後タブの Peek にする |
 * | 小窓 | **もう1枚の小窓**（カスケード） |
 *
 * Peek と小窓で「古いほうを閉じて器を使い回す」をやってはいけない（計画 R8）。
 * 古い WebContents こそが新しい子の `window.opener` なので、閉じると
 * `window.opener.closed === true` になり **OAuth の結果を受け取れない**。
 * どちらも「古いほうを生かしたまま器を1つ増やす」形にする。
 */
type PopupHost = { kind: 'peek'; parent: NemoTab } | { kind: 'mini'; win: NemoWindow }

function preparePopupHost(opener: NemoTab): PopupHost | null {
  const win = opener.window
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return null

  // 小窓の中から: もう1枚の小窓を開く（中身を差し替えると opener が死ぬ）
  if (!canHostAdditionalTabs(win)) {
    return { kind: 'mini', win: createWindow(undefined, { kind: 'mini', noInitialTab: true }) }
  }

  // Peek の中から: その Peek を先に昇格させて、新しい子を昇格後タブの Peek にする
  let parent = opener
  if (opener.peekOf) {
    promotePeek(win, opener)
    parent = opener
  }

  // 通常タブから: 先客の Peek は閉じる（1タブにつき1枚）
  if (parent.peek) removeTab(win, parent.peek.key)

  return { kind: 'peek', parent }
}

/**
 * Electron が用意した子の WebContents を受け皿に収める。
 *
 * **必ず渡された `guest` を返す**。`createWindow` は「渡された WebContents に
 * 繋がったウィンドウを作る」契約で、別のものを返すと Electron が
 * `Invalid webContents. Created window should be connected to webContents passed with options object.`
 * で弾く（弾かれても popup 自体は開くので、ログを見ないと気づけない）。
 */
function attachPopup(host: PopupHost, url: string, guest: WebContents | undefined): WebContents {
  if (!guest) throw new Error('window open handler did not provide a webContents')
  try {
    if (host.kind === 'mini') {
      adoptMiniTab(host.win, url, guest)
    } else {
      openPeek(host.parent, url, guest)
    }
  } catch (error) {
    logError('popup.attach_failed', error, { kind: host.kind })
  }
  return guest
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
 * ページの `gg` / `G` で縦方向の端へ飛ぶ（vim の作法）。
 *
 * 判定を main の `before-input-event` に置けない。あそこには `input.key` しか渡ってこないので、
 * **ページの入力欄にフォーカスがあるかを判別できず**、検索ボックスに `G` と打った瞬間に
 * 最下部へ飛ぶ。そこで swipe と同じく**隔離ワールド**へ判定コードを入れる。
 *
 * **子フレームには入れない**（swipe との違い）。swipe が全フレームに入れているのは
 * 「`wheel` が iframe の境界を越えて親へ伝わらない」ためだが、**キーはフォーカスに付いて回る**
 * ので、iframe をクリックしていない限りメインフレームで受けられる。
 * 広告・トラッキング iframe にまで入れずに済む。
 */
// **1729 はスワイプ判定・1730 は会議のプローブ（`call-coordinator.ts`）が使っている。**
// 同じワールドに同居させると、どちらかがグローバルを1つ増やした瞬間に
// **その機能を使うタブでだけ静かに壊れる**（再現条件が機能横断で切り分けが高くつく）。
const VIM_SCROLL_WORLD_ID = 1731
const vimScrollInjection = buildVimScrollInjection()

function attachVimScroll(tab: NemoTab, wc: WebContents): void {
  const inject = (): void => {
    wc.executeJavaScriptInIsolatedWorld(VIM_SCROLL_WORLD_ID, [{ code: vimScrollInjection }]).catch(
      (error) => {
        logError('tab.vim_scroll_inject_failed', error, { key: tab.key })
      }
    )
  }

  // swipe と同じ理由で**両方に張る**。bfcache から復元されると `dom-ready` は出ないので、
  // それだけでは一度戻ったあと二度と効かない。
  // 注入コード自身が二重登録を弾くので、余分に呼んでも害はない。
  wc.on('dom-ready', inject)
  wc.on('did-navigate', inject)
}

/* ------------------------------------------------------------------ *
 * ウィンドウ
 * ------------------------------------------------------------------ */

/**
 * オーバーレイが変わったときに呼ぶ。タブスイッチャーが**別のオーバーレイに
 * 差し替えられたら畳む**ために使う（ダイアログが割り込んできたときなど）。
 *
 * registry から `tab-switcher.ts` を import すると循環するので、注入で受ける。
 */
let overlayChangeListener: ((win: NemoWindow, kind: OverlayKind) => void) | null = null

export function setOverlayChangeListener(fn: (win: NemoWindow, kind: OverlayKind) => void): void {
  overlayChangeListener = fn
}

/**
 * 会議の小窓の coordinator（`call-coordinator.ts`）。
 *
 * registry から import すると循環するので**注入で受ける**（`overlayChangeListener` と同じ形）。
 * - `refresh` … 候補・表示対象を計算し直す。**何度呼んでもよい**（冪等）
 * - `isSleepExempt` … そのタブを sleep / 自動アーカイブの対象から外すか（計画 R3）
 */
interface CallWatcher {
  refresh(navigated?: NemoTab): void
  isSleepExempt(tab: NemoTab): boolean
}

let callWatcher: CallWatcher | null = null

export function setCallWatcher(watcher: CallWatcher): void {
  callWatcher = watcher
}

/**
 * 「会議タブの候補・見え方が変わったかもしれない」を coordinator へ知らせる。
 *
 * `navigated` を渡すと「そのタブは今 document が変わった」の合図になり、
 * coordinator は次の周期を待たずにプローブし直す。
 * これが無いと、**タブを開いてから参加が検知されるまで最大5秒かかる**。
 */
function notifyCall(navigated?: NemoTab): void {
  callWatcher?.refresh(navigated)
}

/**
 * ウィンドウの種別。
 *
 * - `normal` … サイドバーを持つ通常のブラウザウィンドウ
 * - `mini` … 小窓（Little Nemo）。**タブは常に1つだけ**で、サイドバーを持たない。
 *   外部アプリから踏んだ URL を「メインウィンドウを前面に出さずに」出すための器
 */
export type WindowKind = 'normal' | 'mini'

export class NemoWindow {
  static nextId = 1

  readonly id: number
  /** ウィンドウの種別（通常 / 小窓）。 */
  readonly kind: WindowKind
  /** シークレットウィンドウか（拡張なし・メモリ内セッション・履歴に残さない）。 */
  readonly isPrivate: boolean
  /** このウィンドウのタブが使うセッション partition。 */
  readonly partition: string
  readonly baseWindow: BaseWindow
  /** サイドバー（常時表示）。 */
  readonly chromeView: WebContentsView
  /**
   * ページ領域の上端に敷くアドレスバー（常時表示）。
   * **小窓は持たない**（小窓の上部バーは `chromeView` の側で描く）。
   */
  readonly toolbarView: WebContentsView | null
  /** コマンドバー・検索バー・ダイアログ用（必要なときだけ表示）。 */
  readonly overlayView: WebContentsView
  /**
   * Peek の暗幕と ✕ / ⌘O ボタン（透明 View）。**Peek を初めて出すときに作る**。
   * Peek を一度も使わないウィンドウで WebContents を1つ増やさないため。
   */
  private peekChromeViewRef: WebContentsView | null = null
  private emptyViewRef: WebContentsView | null = null
  /**
   * 右ペインのツールバー。**分割を初めて作るときに作る**。
   * 一度作ったら捨てず、分割していない間は隠すだけにする。
   */
  private splitToolbarViewRef: WebContentsView | null = null
  /**
   * フォーカス中ペインの外周に出す枠。`WebContents` を持たない素の `View`。
   * ページの**後ろ**に敷いて 2px はみ出させる（前面に置くとクリックを遮る）。
   */
  private focusRingViewRef: View | null = null
  readonly tabs: NemoTab[] = []
  activeTabKey: string | null = null
  sidebarVisible: boolean
  overlay: OverlayKind = null
  private destroyed = false
  private uiReady = false
  private pendingAfterReady: (() => void)[] = []
  private pendingAfterSettled: (() => void)[] = []

  constructor(
    bounds?: SavedWindow['bounds'],
    isPrivate = false,
    kind: WindowKind = 'normal',
    hidden = false
  ) {
    this.id = NemoWindow.nextId++
    this.kind = kind
    this.isPrivate = isPrivate
    this.partition = isPrivate ? ensurePrivateSession() : PAGE_PARTITION
    this.sidebarVisible = getSettings().sidebarVisible

    this.baseWindow =
      kind === 'mini'
        ? new BaseWindow({
            ...miniWindowBounds(),
            minWidth: 320,
            minHeight: 240,
            show: false,
            title: 'Nemo',
            backgroundColor: '#16161a',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: MINI_TRAFFIC_LIGHT_INSET,
            // **NSPanel にするのが肝**（Phase 0 の実測）。
            // 通常ウィンドウだと、キーフォーカスを渡すのに `app.focus({ steal: true })` が要り、
            // それを撃つと**メインウィンドウの Space へ画面ごと切り替わる**。
            // panel（nonactivating panel）なら「アプリを前面に出さずにキーを受け取る」が成立し、
            // フルスクリーンの Space の上にも出る。メニューのアクセラレータも届く。
            //
            // `setVisibleOnAllWorkspaces` は**呼ばない**。呼ぶと process type が変換されて
            // **Dock アイコンが消える**うえ、panel には不要（全 Space 追従は panel の性質として付いてくる）。
            type: 'panel'
          })
        : new BaseWindow({
            width: bounds?.width ?? 1280,
            height: bounds?.height ?? 860,
            ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
            // 外部 URL で叩き起こされたときは**背面で**復元する。
            // `show: false` で作って後から `showInactive()` する
            // （最初から見せると、その時点で Space が切り替わる）。
            show: !hidden,
            minWidth: 640,
            minHeight: 480,
            title: isPrivate ? 'Nemo（シークレット）' : 'Nemo',
            backgroundColor: isPrivate ? '#1b1524' : '#16161a',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: TRAFFIC_LIGHT_INSET
          })

    // 小窓はサイドバーの代わりに上部バーを持つ（同じ `chromeView` の枠を使う）
    this.chromeView = this.createUiView(kind === 'mini' ? 'mini' : 'sidebar')
    // アドレスバーはページ領域の上（サイドバーの右）に別 View で敷く。
    // サイドバーの View を L 字には広げられないので、View を分けるしかない。
    this.toolbarView = kind === 'mini' ? null : this.createUiView('toolbar')
    this.overlayView = this.createUiView('overlay')
    this.baseWindow.contentView.addChildView(this.chromeView)
    if (this.toolbarView) this.baseWindow.contentView.addChildView(this.toolbarView)
    this.baseWindow.contentView.addChildView(this.overlayView)
    this.overlayView.setVisible(false)

    // 通常ウィンドウの MRU を記録する（小窓の昇格先を決めるのに使う）。
    // **小窓は記録しない**。記録すると小窓から小窓へ昇格しようとする。
    this.baseWindow.on('focus', () => {
      rememberNormalWindowFocus(this)
      // 「会議タブが見えているか」は**フォーカスにも依る**（他アプリへ移ったら出す）。
      // ここを拾わないと、アプリを行き来しても小窓が出入りしない。
      notifyCall()
    })
    this.baseWindow.on('blur', () => notifyCall())

    this.baseWindow.on('resize', () => this.layout())
    this.baseWindow.on('enter-full-screen', () => {
      this.layout()
      this.pushState()
    })
    this.baseWindow.on('leave-full-screen', () => {
      this.layout()
      this.pushState()
    })
    // **閉じる経路をここ1本に絞る**（計画 R5）。⌘⇧W・macOS の赤いボタン・
    // `removeWindow()`・`window.close()` のどれもここを通る。
    // 終了 API を用意しただけでは、ネイティブの閉じるボタンが素通りして
    // 小窓の中身が ⌘⇧T にもアーカイブにも残らない。
    this.baseWindow.on('close', () => {
      captureClosingWindow(this, 'user')
      this.destroy()
    })
  }

  /** UI View を作る（生成とナビゲーション防御は `ui-view.ts` に寄せてある）。 */
  private createUiView(view: UiViewKind, pane?: 'right'): WebContentsView {
    return createUiView({
      view,
      windowId: this.id,
      isPrivate: this.isPrivate,
      ...(pane ? { pane } : {}),
      onLoad: () => this.onUiViewLoaded(view)
    })
  }

  /** UI View の読み込みが終わるたびに呼ばれる（`once` ではない。HMR や読み直しでも通る）。 */
  private onUiViewLoaded(view: UiViewKind): void {
    if (view === 'sidebar' || view === 'mini') {
      // 小窓はサイドバーを持たないので、上部バーの読み込み完了を「UI が揃った」とみなす
      this.uiReady = true
      const queued = this.pendingAfterReady
      this.pendingAfterReady = []
      // 破棄済みなら実行しない（ロード完了と close が競合する）
      if (!this.destroyed) for (const fn of queued) fn()
      this.settle()
    } else if (view === 'overlay') {
      // オーバーレイは購読しかしないので、読み込み直後に**今の状態を送り直す**。
      // ここが無いと、起動直後に出た権限・認証ダイアログが
      // 「購読前に送られて誰も受け取らない」状態になり、
      // ページ側の callback が永久に解決しない（実際に競合しうる）。
      this.overlayWebContents.send('nemo:overlay', this.overlay)
      this.pushPrompt(currentPrompt(this.id))
    }
    this.pushState()
    this.pushShared()
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

  /** Peek 用の UI View（無ければ作る）。 */
  ensurePeekChrome(): WebContentsView {
    if (this.peekChromeViewRef && !this.peekChromeViewRef.webContents.isDestroyed()) {
      return this.peekChromeViewRef
    }
    const view = this.createUiView('peek')
    this.peekChromeViewRef = view
    this.baseWindow.contentView.addChildView(view)
    view.setVisible(false)
    return view
  }

  /** 既に作ってあれば Peek 用の UI View。無ければ null（作らない）。 */
  get peekChromeView(): WebContentsView | null {
    if (!this.peekChromeViewRef) return null
    if (this.peekChromeViewRef.webContents.isDestroyed()) return null
    return this.peekChromeViewRef
  }

  /**
   * 空状態（タブが 1 つも無いとき）の UI View（無ければ作る）。
   *
   * **起動時には作らない**。起動直後は必ずタブが 1 つ以上あるので、
   * ここで作ると「枠が何十個あっても起動が重くならない」方針に穴を開けるだけになる。
   */
  ensureEmptyView(): WebContentsView {
    if (this.emptyViewRef && !this.emptyViewRef.webContents.isDestroyed()) {
      return this.emptyViewRef
    }
    const view = this.createUiView('empty')
    this.emptyViewRef = view
    this.baseWindow.contentView.addChildView(view)
    view.setVisible(false)
    return view
  }

  /**
   * 右ペインのツールバー（`?view=toolbar&pane=right`）。
   * 分割を使わないウィンドウで WebContents を1つ増やさないよう、遅延生成する。
   */
  ensureSplitToolbar(): WebContentsView {
    if (this.splitToolbarViewRef && !this.splitToolbarViewRef.webContents.isDestroyed()) {
      return this.splitToolbarViewRef
    }
    const view = this.createUiView('toolbar', 'right')
    view.setBackgroundColor(TOOLBAR_GROUND_COLOR)
    this.splitToolbarViewRef = view
    this.baseWindow.contentView.addChildView(view)
    view.setVisible(false)
    return view
  }

  /** 既に作ってあれば右ペインのツールバー。無ければ null（作らない）。 */
  get splitToolbarView(): WebContentsView | null {
    const view = this.splitToolbarViewRef
    return view && !view.webContents.isDestroyed() ? view : null
  }

  /** フォーカス枠。角丸は `SPLIT_RADIUS` より枠のぶん大きくする（角だけ太って見えないように）。 */
  ensureFocusRing(): View {
    if (this.focusRingViewRef) return this.focusRingViewRef
    const view = new View()
    view.setBackgroundColor(SPLIT_FOCUS_COLOR)
    view.setBorderRadius(SPLIT_RADIUS + SPLIT_FOCUS_RING)
    this.focusRingViewRef = view
    this.baseWindow.contentView.addChildView(view)
    view.setVisible(false)
    return view
  }

  /** 既に作ってあればフォーカス枠。無ければ null（作らない）。 */
  get focusRingView(): View | null {
    return this.focusRingViewRef
  }

  /** 既に作ってあれば空状態の UI View。無ければ null（作らない）。 */
  get emptyView(): WebContentsView | null {
    if (!this.emptyViewRef) return null
    if (this.emptyViewRef.webContents.isDestroyed()) return null
    return this.emptyViewRef
  }

  /** この UI View 群（IPC の宛先・送信元検証に使う）。 */
  private get uiContents(): WebContents[] {
    const list = [this.chromeWebContents, this.overlayWebContents]
    if (this.toolbarView) list.push(this.toolbarView.webContents)
    // **右ペインのツールバーを忘れない**（忘れると ✕ や戻るの IPC が拒否される。
    // Peek の暗幕で踏んだのと同じ罠）
    const splitToolbar = this.splitToolbarView
    if (splitToolbar) list.push(splitToolbar.webContents)
    const peek = this.peekChromeView
    if (peek) list.push(peek.webContents)
    return list.filter((contents) => !contents.isDestroyed())
  }

  /**
   * このウィンドウが見てよいダウンロードの scope。
   * 常用は `null`、シークレットは自分の partition。
   */
  get downloadScope(): string | null {
    return this.isPrivate ? this.partition : null
  }

  get sidebarWidth(): number {
    return this.sidebarVisible ? SIDEBAR_WIDTH : SIDEBAR_HIDDEN_WIDTH
  }

  /**
   * 拡張アイコンが載っているツールバー View の**左端の絶対 x**。
   *
   * popup は「その View のクライアント座標 + ウィンドウの左上」に置かれるので、
   * View のオフセットを足し戻す必要がある（`extensions.ts` の `popupAnchorOffset`）。
   * **分割中は左ペインの外周余白ぶんさらに右にいる**ので、
   * `sidebarWidth` を返すと popup が 8px 左にずれる。
   */
  get toolbarOriginX(): number {
    if (this.kind === 'mini') return 0
    const sidebar = this.sidebarWidth
    return this.visibleSplit ? sidebar + SPLIT_INSET : sidebar
  }

  layout(): void {
    if (this.destroyed || this.baseWindow.isDestroyed()) return
    const { width, height } = this.baseWindow.getContentBounds()

    // 小窓はサイドバーの代わりに上部バーを敷く（ページはその下）
    if (this.kind === 'mini') {
      this.layoutMini(width, height)
      return
    }

    const sidebar = this.sidebarWidth

    this.chromeView.setBounds({ x: 0, y: 0, width: sidebar, height })
    this.chromeView.setVisible(this.sidebarVisible)

    /** サイドバーの右側すべて（ツールバーの行を含む）。ペインの外枠はここから割る。 */
    const area = {
      x: sidebar,
      y: 0,
      width: Math.max(width - sidebar, 0),
      height: Math.max(height, 0)
    }
    const toolbarHeight = this.toolbarView ? TOOLBAR_HEIGHT : 0
    const pair = this.visibleSplit
    const active = this.getActiveTab()

    /*
     * 分割していないときの矩形（今までどおり）。
     * アドレスバーはページ領域の上端いっぱい、ページはその下いっぱい。
     * **サイドバーを隠したら左端まで伸ばす** —— サイドバーを隠すボタンも
     * ここにあるので、伸ばさないと戻す導線ごと消える。
     */
    const singleToolbar = { x: area.x, y: 0, width: area.width, height: toolbarHeight }
    const singlePage = {
      x: area.x,
      y: toolbarHeight,
      width: area.width,
      height: Math.max(height - toolbarHeight, 0)
    }

    /** ペインごとの矩形。分割していなければ null。 */
    const panes = pair
      ? {
          left: paneInnerBounds(paneOuterBounds(area, 'left')),
          right: paneInnerBounds(paneOuterBounds(area, 'right'))
        }
      : null
    const outers = pair
      ? { left: paneOuterBounds(area, 'left'), right: paneOuterBounds(area, 'right') }
      : null

    /** そのタブが載るページの矩形。分割に関係ないタブは単独表示と同じ場所へ置く。 */
    const pageBoundsFor = (tab: NemoTab): Electron.Rectangle => {
      if (!pair || !panes) return singlePage
      if (tab === pair.left) return panes.left.page
      if (tab === pair.right) return panes.right.page
      return singlePage
    }

    if (this.toolbarView) {
      this.toolbarView.setBounds(panes ? panes.left.toolbar : singleToolbar)
      this.toolbarView.setVisible(true)
    }
    // 右ペインのツールバーは分割中だけ。**遅延生成したものを隠すだけ**にして捨てない
    if (panes) {
      const right = this.ensureSplitToolbar()
      right.setBounds(panes.right.toolbar)
      right.setVisible(true)
    } else {
      this.splitToolbarView?.setVisible(false)
    }

    // フォーカス中ペインの外周に枠を出す。**ページの後ろに敷く**
    // （前面に置くとページのクリックを遮る）。分割していなければ必ず隠す。
    if (pair && outers && active) {
      const outer = active === pair.right ? outers.right : outers.left
      const ring = this.ensureFocusRing()
      ring.setBounds({
        x: outer.x - SPLIT_FOCUS_RING,
        y: outer.y - SPLIT_FOCUS_RING,
        width: outer.width + SPLIT_FOCUS_RING * 2,
        height: outer.height + SPLIT_FOCUS_RING * 2
      })
      ring.setVisible(true)
      this.baseWindow.contentView.removeChildView(ring)
      this.baseWindow.contentView.addChildView(ring)
    } else {
      this.focusRingView?.setVisible(false)
    }

    // 表示・非表示は setVisible で制御し、bounds は全タブに与えておく。
    // バックグラウンドタブが 0x0 のままだと、選択した瞬間にレイアウトが走って
    // 一瞬崩れて見えるうえ、chrome.tabs のサイズも 0 になる。
    const pageBounds = panes && active ? pageBoundsFor(active) : singlePage
    for (const tab of this.tabs) {
      // Peek は**親が載っているペインの**ページ領域の中央に小さく置く
      const host = tab.peekOf ?? tab
      tab.view?.setBounds(tab.peekOf ? peekBounds(pageBoundsFor(host)) : pageBoundsFor(tab))
    }

    // 分割中のツールバーとページは z 順を組み直す（タブを作ると子の順序が変わる）
    if (pair && panes) {
      for (const tab of [pair.left, pair.right]) {
        const view = tab.view
        if (!view) continue
        this.baseWindow.contentView.removeChildView(view)
        this.baseWindow.contentView.addChildView(view)
      }
      if (this.toolbarView) {
        this.baseWindow.contentView.removeChildView(this.toolbarView)
        this.baseWindow.contentView.addChildView(this.toolbarView)
      }
      const right = this.splitToolbarView
      if (right) {
        this.baseWindow.contentView.removeChildView(right)
        this.baseWindow.contentView.addChildView(right)
      }
    }

    // タブが 1 つも無いときだけ、ページ領域に空状態を敷く（DESIGN.md「空状態」）。
    // **タブがあるときは必ず隠す**。ページの上に残るとクリックを丸ごと遮る
    // （Peek の暗幕で踏んだのと同じ罠）。
    if (this.normalTabs.length === 0) {
      const empty = this.ensureEmptyView()
      empty.setBounds(pageBounds)
      empty.setVisible(true)
      this.baseWindow.contentView.removeChildView(empty)
      this.baseWindow.contentView.addChildView(empty)
    } else {
      this.emptyView?.setVisible(false)
    }

    // z 順は毎回作り直す。**タブを作ると子 View の順序が変わる**ので、
    // 「一度並べれば済む」ようには書けない。
    // 下から: ページ → Peek の暗幕 → Peek 本体 → オーバーレイ。
    const activePeek = active?.peek ?? null
    const peekChrome = this.peekChromeView
    if (activePeek) {
      const chrome = this.ensurePeekChrome()
      // 暗幕は**そのペインのページ領域だけ**を覆う（外枠を使うとツールバーまで隠れる）
      chrome.setBounds(active ? pageBoundsFor(active) : singlePage)
      chrome.setVisible(true)
      this.baseWindow.contentView.removeChildView(chrome)
      this.baseWindow.contentView.addChildView(chrome)
      const view = activePeek.view
      if (view) {
        view.setBorderRadius(PEEK_RADIUS)
        this.baseWindow.contentView.removeChildView(view)
        this.baseWindow.contentView.addChildView(view)
      }
    } else if (peekChrome) {
      peekChrome.setVisible(false)
    }

    if (this.overlay) {
      // 第4引数は**ページの上端**。分割中は外周余白のぶん下がるので、そのぶんを渡す
      // （渡さないと検索バー・ダイアログ・ダウンロードがツールバーに掛かる）。
      this.overlayView.setBounds(overlayBounds(this.overlay, { width, height }, sidebar, pageBounds.y))
      this.overlayView.setVisible(true)
      // オーバーレイは必ず最前面にする（タブを作ると子 View の順序が変わる）
      this.baseWindow.contentView.removeChildView(this.overlayView)
      this.baseWindow.contentView.addChildView(this.overlayView)
    } else {
      this.overlayView.setVisible(false)
    }
  }

  /**
   * レイアウトの実測値（**自走検証専用**）。
   *
   * View の bounds は外から測れないので、機械検証はここが唯一の情報源。
   * ハンドラを生やすかどうかは `ipc.ts` 側のゲートが決める（ここは値を作るだけ）。
   */
  splitDiagnostics(): SplitDiagnostics {
    const { width, height } = this.baseWindow.getContentBounds()
    const sidebar = this.sidebarWidth
    // ペインを置いた領域。**ウィンドウの実寸とサイドバーの実幅から出す**
    // （`paneOuterBounds()` は通さない。通すと外周余白の検算が自己参照になる）
    const area = { x: sidebar, y: 0, width: Math.max(width - sidebar, 0), height }
    const pair = this.visibleSplit
    const active = this.getActiveTab()

    const panes: SplitDiagnostics['panes'] = []
    let focusRing: SplitDiagnostics['focusRing'] = null
    if (pair) {
      for (const side of ['left', 'right'] as const) {
        const tab = side === 'left' ? pair.left : pair.right
        /*
         * **View から実測で読む**。`paneOuterBounds()` / `paneInnerBounds()` を
         * ここで呼び直すと、`layout()` が `setBounds` を 1 度も呼ばなくても
         * 自走検証の「隔間 8px」「外周余白 8px」「ツールバーとページの幅が外枠と一致」が
         * 全部 PASS してしまう（同じ純関数を 2 回呼んで比べているだけになる）。
         */
        const toolbarView = side === 'left' ? this.toolbarView : this.splitToolbarView
        const toolbar = toolbarView?.getBounds() ?? null
        const page = tab.view?.getBounds() ?? null
        // 外枠は実測のツールバーとページの和（＝ 2 つが縦に積まれている前提そのものを検算できる）
        const outer =
          toolbar && page
            ? {
                x: Math.min(toolbar.x, page.x),
                y: Math.min(toolbar.y, page.y),
                width: Math.max(toolbar.x + toolbar.width, page.x + page.width) - Math.min(toolbar.x, page.x),
                height:
                  Math.max(toolbar.y + toolbar.height, page.y + page.height) - Math.min(toolbar.y, page.y)
              }
            : (toolbar ?? page)
        if (!outer || !toolbar || !page) continue
        panes.push({ side, tabKey: tab.key, outer, toolbar, page })
      }
      const ring = this.focusRingView
      if (ring && ring.getVisible()) focusRing = ring.getBounds()
    }

    const peekTab = active?.peek ?? null
    const scrim = this.peekChromeView
    return {
      mediaSourceId: this.baseWindow.getMediaSourceId(),
      area,
      panes,
      focusRing,
      focusRingVisible: this.focusRingView?.getVisible() ?? false,
      peek: peekTab?.view?.getVisible() ? peekTab.view.getBounds() : null,
      peekScrim: scrim?.getVisible() ? scrim.getBounds() : null,
      overlay: this.overlayView.getVisible() ? this.overlayView.getBounds() : null
    }
  }

  /** 小窓のレイアウト。上部バー + ページ。サイドバーもオーバーレイも出さない。 */
  private layoutMini(width: number, height: number): void {
    this.chromeView.setBounds({ x: 0, y: 0, width, height: MINI_BAR_HEIGHT })
    this.chromeView.setVisible(true)
    this.baseWindow.contentView.removeChildView(this.chromeView)
    this.baseWindow.contentView.addChildView(this.chromeView)

    const pageBounds = {
      x: 0,
      y: MINI_BAR_HEIGHT,
      width: Math.max(width, 0),
      height: Math.max(height - MINI_BAR_HEIGHT, 0)
    }
    for (const tab of this.tabs) tab.view?.setBounds(pageBounds)

    // **オーバーレイは小窓でも出す**。コマンドバーは開けないが、
    // 権限・認証・証明書のダイアログはページ側から出る。
    // ここを塞ぐと callback が永久に解決せず、小窓のページが黙って止まる。
    if (this.overlay) {
      this.overlayView.setBounds(overlayBounds(this.overlay, { width, height }, 0, 0))
      this.overlayView.setVisible(true)
      this.baseWindow.contentView.removeChildView(this.overlayView)
      this.baseWindow.contentView.addChildView(this.overlayView)
    } else {
      this.overlayView.setVisible(false)
    }
  }

  setOverlay(kind: OverlayKind): void {
    // 小窓が出せるのはダイアログだけ（コマンドバー・ライブラリ・設定は持たない）
    if (this.kind === 'mini' && kind !== null && kind !== 'prompt') return
    if (this.overlay === kind) return
    this.overlay = kind
    this.layout()
    if (kind) this.overlayWebContents.focus()
    else this.getActiveTab()?.webContents?.focus()
    this.overlayWebContents.send('nemo:overlay', kind)
    this.pushState()
    overlayChangeListener?.(this, kind)
  }

  setSidebarVisible(visible: boolean): void {
    // 小窓はサイドバーを持たない
    if (this.kind === 'mini') return
    this.sidebarVisible = visible
    this.layout()
    this.pushState()
  }

  /**
   * 一覧・選択の対象になるタブ（= Peek でないタブ）。
   *
   * **「一覧に出す」「次に選ぶ」系だけをここに向ける**。
   * 監視系（`layout()` / `destroy()` / `findTab()` / タブスイッチャーの入力フック）は
   * **`tabs`（全タブ）のまま**にする。実在する View 全部を相手にする必要があるので、
   * ここに絞ると Peek の View が置き去りになったり、Peek にフォーカスがあるときの
   * キー入力を取りこぼしたりする。
   */
  get normalTabs(): NemoTab[] {
    return this.tabs.filter((tab) => tab.peekOf === null)
  }

  /**
   * 実際に表示する View のタブ key。**見えるものを決める唯一の述語**。
   *
   * 中身は「選択中の通常タブ」＋「分割していればその相方」＋
   * 「あればフォーカス中タブの Peek」の**最大3つ**。`activeTabKey` ただ1つではない。
   *
   * **相方の Peek は出さない**。Peek の暗幕はウィンドウに 1 枚しかないので、
   * 2 つ同時に出すと片方が暗幕を持てない。相方の Peek はフォーカスを移したときに出る
   * （破棄はしないので、行き来しても消えない）。
   */
  get visibleTabKeys(): Set<string> {
    const keys = new Set<string>()
    const active = this.getActiveTab()
    if (!active) return keys
    keys.add(active.key)
    const partner = active.split?.partnerOf(active)
    if (partner) keys.add(partner.key)
    // 中身がまだ来ていない Peek は出さない（プレースホルダーに任せる）
    if (active.peek && !active.peek.peekAwaitingDocument) keys.add(active.peek.key)
    return keys
  }

  /** いま見えている分割（アクティブタブが入っているペア）。無ければ null。 */
  get visibleSplit(): SplitPair | null {
    return this.getActiveTab()?.split ?? null
  }

  /**
   * `visibleTabKeys` を実際の View へ反映する。**可視状態を変える経路はここ 1 本**。
   *
   * 以前は `selectTab` の中に直書きされていて、`selectTab` を通らない経路
   * （分割の生成 / 解除・Peek だけを閉じる `removeTab`）で可視状態が取り残されていた。
   *
   * やること:
   * - 見えるのに寝ているタブを起こす（相方が寝ていると片側が真っ白になる）
   * - 全タブへ `setVisible`
   * - **`lastActiveAt` はフォーカス中のタブだけ**更新する。両方に同じ値を書くと
   *   ⌃M の MRU 順（`lastActiveAt` の降順）で左右が同着になり、
   *   「右ペインから別タブへ行って ⌃M」で左へ戻ってしまう。
   *   相方が先に自動アーカイブされる問題は sweep 側（`pairLastActiveAt`）で塞ぐ
   * - **見えているタブ全部の未読を落とす**（相方に未読ドットが残らないように）
   * - ペインのクリックでフォーカスが移るよう、見えている分割の 2 本にだけ購読を張る
   */
  applyVisibility(): void {
    if (this.destroyed) return
    const visible = this.visibleTabKeys
    const active = this.getActiveTab()

    for (const key of visible) {
      const tab = this.findTab(key)
      if (tab?.asleep) {
        tab.materialize()
        log('tab.woke', { key: tab.key, windowId: this.id })
      }
    }
    for (const tab of this.tabs) tab.view?.setVisible(visible.has(tab.key))

    if (active) active.lastActiveAt = Date.now()

    for (const key of visible) {
      const tab = this.findTab(key)
      if (!tab) continue
      tab.unread = false
      // **Live Folder の未読も同じ経路で落とす。** 行のクリックだけで消すと、
      // コマンドバー・履歴・⌘数字・タブ切替から同じ URL を開いても未読が残る
      markLiveFolderRead(tab.url)
    }

    this.syncPaneFocusWatchers()
  }

  /**
   * ペインのクリックでフォーカスを移すための購読を張り直す。
   *
   * **`webContents.on('focus')` は使えない**。合成クリック（`sendInputEvent` / CDP）では
   * native のフォーカスが移らず飛ばないので、自走検証から撃てない（スパイクで実測）。
   * `input-event` は WebContents の入力パイプラインを通るので実クリックでも合成でも飛ぶ。
   *
   * ただし `input-event` は**マウス移動でも飛ぶ**ので、
   * **見えている分割の 2 本にだけ**付けて、それ以外からは必ず外す。
   */
  private syncPaneFocusWatchers(): void {
    const pair = this.visibleSplit
    const watched = new Set(pair ? [pair.left.key, pair.right.key] : [])
    for (const tab of this.tabs) {
      const wc = tab.webContents
      const wants = watched.has(tab.key) && wc !== null
      if (wants && !tab.paneFocusOff && wc) {
        const onInput = (_event: Electron.Event, input: Electron.InputEvent): void => {
          if (input.type !== 'mouseDown') return
          // 既にフォーカスがあるなら何もしない（毎クリックで再選択しない）
          if (this.activeTabKey === tab.key) return
          // 見えていないタブからのイベントは無視する（背面で勝手に切り替わらないように）
          if (!this.visibleTabKeys.has(tab.key)) return
          selectTab(this, tab.key)
        }
        wc.on('input-event', onInput)
        tab.paneFocusOff = () => {
          if (!wc.isDestroyed()) wc.off('input-event', onInput)
        }
      } else if (!wants && tab.paneFocusOff) {
        tab.paneFocusOff()
        tab.paneFocusOff = null
      }
    }
  }

  /**
   * 実際に表示されている View のタブ key。
   * 正常なら「選択中の通常タブ」「分割中ならその相方」「あればフォーカス中タブの Peek」の最大3つ。
   */
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
      isPrivate: this.isPrivate,
      kind: this.kind
    }
  }

  pushState(): void {
    if (this.destroyed) return
    const state = this.toState()
    for (const contents of this.uiContents) contents.send('nemo:window-state', state)
    scheduleSessionSave()
  }

  /**
   * サイドバーに渡す共有データ。
   *
   * **組み立てはここ1か所だけ**にする（以前は `ipc.ts` の `sharedState()` と
   * この push 側の2箇所で別々に組み立てており、片方に足しても push に乗らなかった）。
   *
   * ダウンロードは呼び出し元ウィンドウの scope で絞り、
   * **シークレットウィンドウには `liveFolder` を渡さない**
   * （GitHub の Cookie が無いので、行を押しても private な PR はログイン画面になる。
   * 出さないのではなく**データごと渡さない**）。
   */
  sharedState(): SharedState {
    return {
      favorites: getFavorites(),
      pinned: getPinned(),
      downloads: listDownloads(this.downloadScope),
      version: app.getVersion(),
      update: getUpdateState(),
      liveFolder: this.isPrivate ? null : getLiveFolderState()
    }
  }

  pushShared(): void {
    if (this.destroyed) return
    const shared = this.sharedState()
    for (const contents of this.uiContents) contents.send('nemo:shared-state', shared)
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

  /**
   * UI の WebContents か（IPC の送信元検証に使う）。
   * **Peek 用の View もここに含める**。忘れると ✕ / ⌘O ボタンの IPC が拒否される。
   */
  ownsUiContents(contents: WebContents): boolean {
    if (this.destroyed) return false
    return this.uiContents.some((owned) => owned.id === contents.id)
  }

  /**
   * セッションに残すぶん。
   *
   * **一時タブだけ**を保存する。ピン / Favorites のタブは枠（定義）の側から
   * 作り直すので保存しない（起動時にタブ実体を1つも作らないための肝）。
   * 絞り込みは `activeIndex` の算出とも**同じ配列**で行う。条件がズレると
   * 復元後に別のタブが選択される。
   */
  toSaved(): SavedWindow {
    const bounds = this.baseWindow.isDestroyed() ? null : this.baseWindow.getBounds()
    // Peek は保存しない（再起動では復元しない仕様）
    const saved = this.normalTabs.filter(
      (tab) => /^https?:\/\//.test(tab.url) && tab.pinnedId === null && tab.favoriteId === null
    )
    // lastActiveAt も保存する。落とすと自動アーカイブの寿命が再起動でリセットされる
    const tabs = saved.map((tab) => ({
      url: tab.url,
      title: tab.title,
      customTitle: tab.customTitle,
      lastActiveAt: tab.lastActiveAt
    }))
    const activeIndex = Math.max(
      saved.findIndex((tab) => tab.key === this.activeTabKey),
      0
    )
    /*
     * 分割の組。**`saved` と同じ配列の添字**で表す（`activeIndex` と揃える）。
     *
     * - **左右の両方が保存対象に入っている組だけ**書く。`saved` は `https?:` 以外を
     *   落とすので、片方が `about:blank` の組をそのまま書くと `-1` を含む値を自分で作る
     * - **`tab === pair.left` のときだけ**出す。左右の両タブが同じ `SplitPair` を
     *   指しているので、素朴に走査すると同じ組が 2 回出て、次の起動で
     *   自分が書いた `splits` を「添字の重複」として捨てることになる
     */
    const splits: [number, number][] = []
    for (const [index, tab] of saved.entries()) {
      const pair = tab.split
      if (!pair || pair.left !== tab) continue
      const rightIndex = saved.indexOf(pair.right)
      if (rightIndex === -1) continue
      splits.push([index, rightIndex])
    }
    return { bounds, tabs, activeIndex, splits }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    log('window.destroy', { windowId: this.id, tabs: this.tabs.length })

    // 押しっぱなしの最中に閉じられた場合に、タイマーと入力フックを残さない。
    // `destroyed` を立てた後に呼ぶので、受け手は View に触らずに畳む。
    overlayChangeListener?.(this, null)

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

    for (const view of [
      this.chromeView,
      this.toolbarView,
      this.overlayView,
      this.peekChromeViewRef,
      this.emptyViewRef,
      // **足し忘れるとウィンドウを閉じてもレンダラプロセスが残る**（1 枚 89MB）
      this.splitToolbarViewRef
    ]) {
      if (!view) continue
      disposeUiView(this.baseWindow.contentView, view)
    }
    // フォーカス枠は `WebContents` を持たないので外すだけ
    if (this.focusRingViewRef) {
      try {
        this.baseWindow.contentView.removeChildView(this.focusRingViewRef)
      } catch {
        // 親が既に壊れている（ウィンドウごと破棄された）
      }
    }
    this.peekChromeViewRef = null
    this.emptyViewRef = null
    this.splitToolbarViewRef = null
    this.focusRingViewRef = null

    windowsById.delete(this.id)
    // 会議タブごと消えた可能性があるので、候補と表示対象を見直す
    notifyCall()
    // 覚えている「chrome から見た active」を捨てる。
    // WebContents の id は再利用されるので、残すと別ウィンドウの同期を握り潰しうる。
    lastForegroundContentsId.delete(this.id)
    normalWindowMru = normalWindowMru.filter((id) => id !== this.id)
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

/**
 * 直近にフォーカスした**通常ウィンドウ**の ID（新しい順）。
 *
 * `focusedOrFirstWindow()` は使えない。小窓にフォーカスがあるときは小窓を返すので、
 * 「小窓の中身をどこへ昇格させるか」の答えにならない。
 */
let normalWindowMru: number[] = []

function rememberNormalWindowFocus(win: NemoWindow): void {
  if (win.kind !== 'normal') return
  normalWindowMru = [win.id, ...normalWindowMru.filter((id) => id !== win.id)]
}

/**
 * 小窓の中身を移す先の通常ウィンドウ。**3段で解決する**。
 *
 * 1. 同じ partition の MRU 先頭
 * 2. 同じ partition の既存の通常ウィンドウ（MRU に入っていないものも含む）
 * 3. 無ければ null（呼び出し側が新規に作る）
 *
 * 2 が要る理由が2つある:
 * - 直近がシークレットウィンドウだと partition 違いで `moveTabToWindow` が拒否される
 * - **コールドスタートで `show: false` 復元した通常ウィンドウは `focus` が来ないので
 *   MRU に入らない**。1 だけだと「背面に復元済みのウィンドウがあるのにもう1枚増える」
 */
export function mostRecentNormalWindow(partition: string): NemoWindow | null {
  for (const id of normalWindowMru) {
    const win = windowsById.get(id)
    if (win && !win.isDestroyed && win.kind === 'normal' && win.partition === partition) return win
  }
  for (const win of windowsById.values()) {
    if (!win.isDestroyed && win.kind === 'normal' && win.partition === partition) return win
  }
  return null
}

/**
 * そのウィンドウがタブをもう1枚持てるか。
 *
 * **小窓は常に1タブ**。「メニューを塞ぐ」だけでは
 * `chrome.tabs.create` / ⌘⇧T / IPC / ページ内の `target=_blank` から増えてしまうので、
 * 全経路をこの述語1つに寄せる。
 */
export function canHostAdditionalTabs(win: NemoWindow): boolean {
  return win.kind === 'normal'
}

/**
 * 新しいタブを置くべきウィンドウ。
 * 小窓は自分では持てないので、通常ウィンドウの MRU 先頭へ回す（無ければ作る）。
 */
export function windowForNewTab(win: NemoWindow): NemoWindow {
  if (canHostAdditionalTabs(win)) return win
  const target = mostRecentNormalWindow(win.partition)
  if (target) return target
  return createWindow(undefined, { isPrivate: win.isPrivate, noInitialTab: true })
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
  /** Favorite 定義に紐づくタブとして作る（`pinnedId` とは排他）。 */
  favoriteId?: string | null
  title?: string
  /** ユーザーが付けた名前（一時タブの復元・降格の引き継ぎ用）。 */
  customTitle?: string | null
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
  // 小窓は常に1タブ。**呼び出し口ごとに塞ぐのではなく、ここで最後に必ず弾く**
  // （メニュー・IPC・拡張・ページ内 popup と入口が多く、どれかで必ず漏れる）。
  if (!canHostAdditionalTabs(win) && win.tabs.length > 0) {
    log('tab.create_rejected', { windowId: win.id, reason: 'window_cannot_host' })
    throw new Error('window cannot host additional tabs')
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
  tab.customTitle = options.customTitle ?? null
  // 所属の不変条件（排他 / 実在 / 1 ウィンドウ 1 定義 1 タブ）は**ここで1度だけ**保証する。
  // 呼び出し口が多いので、経路ごとに書くと必ずどれかで漏れる。
  const ownership = resolveTabOwnership(
    { pinnedId: options.pinnedId, favoriteId: options.favoriteId },
    {
      pinnedExists: (id) => findPinned(id) !== null,
      favoriteExists: (id) => findFavorite(id) !== null,
      windowTabs: win.tabs
    }
  )
  if (ownership.dropped.length > 0) {
    log('tab.ownership_dropped', { windowId: win.id, reasons: ownership.dropped.join(',') })
  }
  tab.pinnedId = ownership.pinnedId
  tab.favoriteId = ownership.favoriteId
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
  notifyCall()
  return tab
}

/**
 * 拡張から見た「今いるページ」を最後に同期した WebContents id（ウィンドウ ID ごと）。
 *
 * **同じ id なら撃ち返さない**。これが無いと
 * `syncForegroundTab → extensions.selectTab → extensions.ts の callback → selectTab → …`
 * が無限に回る（`selectTab` 側の再入ガードは `activeTabKey` しか見ていないので、
 * Peek を active にする経路ではすり抜ける）。
 */
const lastForegroundContentsId = new Map<number, number>()
/** 読み替えの途中で再入しても止める。 */
let syncingExtensionSelection = false

/**
 * 拡張（chrome.tabs）から見た active タブを計算し直して反映する。
 *
 * **Nemo のサイドバーで選択されているタブ**（`activeTabKey`）と
 * **chrome から見た active タブ**は意図的に別物にする。Peek が出ているなら
 * 「今いるページ」は Peek なので、Bitwarden の自動入力はそちらに効いてほしい。
 *
 * 「開いた瞬間に1回撃つ」では足りない。別タブへ行って戻る・拡張から `selectTab` が
 * 呼び返される、といった経路で静かにズレるので、**毎回ここで再計算する**。
 */
export function syncForegroundTab(win: NemoWindow): void {
  if (win.isDestroyed || win.isPrivate) return
  if (syncingExtensionSelection) return
  const active = win.getActiveTab()
  const foreground = active?.peek ?? active
  const wc = foreground?.webContents
  if (!wc) return
  if (lastForegroundContentsId.get(win.id) === wc.id) return
  lastForegroundContentsId.set(win.id, wc.id)
  syncingExtensionSelection = true
  try {
    extensions?.selectTab(wc)
  } finally {
    syncingExtensionSelection = false
  }
  // 拡張を積まずに「chrome から見た active」を外から確かめられるようにする。
  // 自走検証はこのログを読む（拡張の有無に依存しない判定にするため）。
  log('tab.foreground', {
    windowId: win.id,
    key: foreground.key,
    peek: foreground.peekOf !== null,
    webContentsId: wc.id
  })
}

export function selectTab(win: NemoWindow, key: string): void {
  let tab = win.findTab(key)
  if (!tab) return

  // **Peek の key が渡されたら親を選んだものとして扱う**。
  // `activeTabKey` に Peek が入ると、サイドバーの一覧・⌘1〜9・セッションの
  // activeIndex が全部おかしくなる。拡張からの呼び返しがここに来る。
  if (tab.peekOf) tab = tab.peekOf

  const already = win.activeTabKey === tab.key
  win.activeTabKey = tab.key
  // 見えるものの決定と反映は `applyVisibility()` に一本化してある
  // （sleep からの復帰・未読落とし・ペインのフォーカス購読も全部そこ）。
  win.applyVisibility()
  // **`already` でも必ずレイアウトし直す**。`applyVisibility()` が寝ていたタブを
  // 起こしていることがあり、新しい View に bounds を配らないと 0x0 のまま出る。
  win.layout()

  if (already) {
    // 既に選択済みでも、Peek の出入りで前面のページが変わっていることがある
    syncForegroundTab(win)
    notifyCall()
    return
  }

  syncForegroundTab(win)
  log('tab.select', { key: tab.key, windowId: win.id })
  win.pushState()
  notifyCall()
}

/**
 * ペインの外枠（**ツールバーの行を含む**）。
 *
 * 今までの `pageBounds` は「共有ツールバーより下」だったので、それを左右に割っても
 * ツールバー込みのペインにならない（左のツールバーが全幅のまま残る）。
 * **先に外枠を 2 つ出し、その中でツールバーとページを積む**という順にする。
 *
 * 幅は**左が `floor`・右が残り全部**。割り切れないときの 1px は必ず右へ寄せる
 * （丸め方を決めておかないと 1px の隙間や重なりが出る）。
 *
 * @param area サイドバーの右側すべて（ウィンドウ座標）
 */
function paneOuterBounds(area: Electron.Rectangle, side: 'left' | 'right'): Electron.Rectangle {
  const usable = Math.max(area.width - SPLIT_INSET * 2 - SPLIT_GAP, 0)
  const leftWidth = Math.floor(usable / 2)
  const y = area.y + SPLIT_INSET
  const height = Math.max(area.height - SPLIT_INSET * 2, 0)
  if (side === 'left') {
    return { x: area.x + SPLIT_INSET, y, width: leftWidth, height }
  }
  return {
    x: area.x + SPLIT_INSET + leftWidth + SPLIT_GAP,
    y,
    width: Math.max(usable - leftWidth, 0),
    height
  }
}

/**
 * ペインの外枠の中の内訳。**返す矩形はウィンドウ座標**
 * （器 View を挟まないので、そのまま `contentView` の子に渡せる）。
 */
function paneInnerBounds(outer: Electron.Rectangle): {
  toolbar: Electron.Rectangle
  page: Electron.Rectangle
} {
  return {
    toolbar: { x: outer.x, y: outer.y, width: outer.width, height: TOOLBAR_HEIGHT },
    page: {
      x: outer.x,
      y: outer.y + TOOLBAR_HEIGHT,
      width: outer.width,
      height: Math.max(outer.height - TOOLBAR_HEIGHT, 0)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 分割ビュー（2 ペイン）
 * ------------------------------------------------------------------ */

/**
 * 分割に入れてよいタブか。**受け付ける条件はここ 1 つ**（renderer 側の受け皿と揃える）。
 *
 * 対象は**野良の一時タブだけ**。ピン留め / Favorites は「枠」に属していて、
 * 枠の行と結合行の two-place 問題が出る。Live Folder は自動生成の層で、
 * 行の並べ替えもドラッグもできない。
 */
function canJoinSplit(win: NemoWindow, tab: NemoTab): { ok: true } | { ok: false; reason: string } {
  if (tab.peekOf) return { ok: false, reason: 'peek' }
  if (tab.pinnedId) return { ok: false, reason: 'pinned' }
  if (tab.favoriteId) return { ok: false, reason: 'favorite' }
  if (tab.split) return { ok: false, reason: 'already_split' }
  // **作るときだけ**弾く。作った後に PR の URL へ遷移しても分割は解かない
  // （勝手に解けるより、結合行が残って自分で解除できる方がよい。DESIGN.md 参照）。
  // **そのウィンドウのサイドバーに実際に出ている一覧**で照合する
  // （シークレット・設定で無効・照合前は行が出ないので、ここでも弾かない）。
  if (isLiveFolderTabUrl(tab.url, win.isPrivate)) return { ok: false, reason: 'live_folder' }
  return { ok: true }
}

/**
 * 関係の構築だけを行う（選択も materialize もしない）。
 *
 * **セッション復元はここだけを使う。** `splitTabs` を使うとペアの数だけ
 * 選択と `applyVisibility()` が走り、寝かせたまま復元するはずのタブが
 * 全部起きてしまう（`lastActiveAt` も現在時刻に上書きされる）。
 *
 * **右のタブを左の直後へ移す**。これで ⌘1〜9 / ⌃Tab / セッション保存の並びが
 * サイドバーの見た目（左が上・右が下）と自動的に一致し、解除時の並べ替えが要らなくなる。
 */
export function linkSplit(win: NemoWindow, left: NemoTab, right: NemoTab): SplitPair {
  const pair = new SplitPair(left, right)
  left.split = pair
  right.split = pair
  const from = win.tabs.indexOf(right)
  if (from !== -1) win.tabs.splice(from, 1)
  const leftIndex = win.tabs.indexOf(left)
  win.tabs.splice(leftIndex + 1, 0, right)
  return pair
}

/**
 * 2 本のタブを左右に並べる。**左 → 右の順**（サイドバーのドロップ先が左）。
 *
 * 受け付けない組み合わせは黙って捨てる（理由はログに出す）。
 * renderer 側でも受け皿を出さないが、**IPC を直接叩かれても通さない**
 * （`liveFolderOpen` が一覧との照合を main でやっているのと同じ作法）。
 */
export function splitTabs(win: NemoWindow, leftKey: string, rightKey: string): void {
  const reject = (reason: string): void => {
    log('split.rejected', { reason, windowId: win.id, left: leftKey, right: rightKey })
  }
  if (leftKey === rightKey) return reject('same_tab')
  // 小窓はタブを1つしか持てない
  if (!canHostAdditionalTabs(win)) return reject('window_kind')
  const left = win.findTab(leftKey)
  const right = win.findTab(rightKey)
  if (!left || !right) return reject('not_in_window')
  const leftOk = canJoinSplit(win, left)
  if (!leftOk.ok) return reject(`left_${leftOk.reason}`)
  const rightOk = canJoinSplit(win, right)
  if (!rightOk.ok) return reject(`right_${rightOk.reason}`)

  linkSplit(win, left, right)
  // **右にフォーカス**（持ってきた方を今見たいはず）。
  // `applyVisibility()` が両方を起こして見せる。
  selectTab(win, right.key)
  win.pushState()
  log('split.created', { windowId: win.id, left: left.key, right: right.key })
}

/**
 * 分割を解く（左右どちらの key でもよい）。
 *
 * **可視の再適用を省かない**。省くと、解除前に見えていた 2 枚が
 * 同じ全画面 bounds のまま重なって残る（`layout()` は bounds を配るだけで
 * `setVisible` を触らない）。
 *
 * **タブの並びは触らない**。既に「左 → 右」の順に並んでいるので、
 * そのまま 2 行になれば「左だったタブが上・右だったタブが下」になる。
 */
export function separateSplit(win: NemoWindow, key: string): void {
  const tab = win.findTab(key)
  const pair = tab?.split
  if (!tab || !pair) return
  pair.left.split = null
  pair.right.split = null
  win.applyVisibility()
  win.layout()
  win.pushState()
  log('split.separated', { windowId: win.id, left: pair.left.key, right: pair.right.key })
}

/* ------------------------------------------------------------------ *
 * Peek（ウィンドウ内ポップアップ）
 * ------------------------------------------------------------------ */

/**
 * Peek の中身が来たら View を出す。
 *
 * `dom-ready` まで待つのは、**採用済みの `WebContents` には背景色を敷けない**ため
 * （実測済み。`setBackgroundColor` も `overrideBrowserWindowOptions.backgroundColor` も効かない）。
 * 何も描いていない View を前に出したままにすると、暗幕側のプレースホルダーがその下で
 * くすんで見える。View を後から出せば、待っている間に見えるのは暗幕と
 * プレースホルダーだけになる。
 *
 * **印を落とす経路はこの関数1か所にまとめる**。取りこぼすと Peek が永久に出ない。
 */
function waitForPeekDocument(peek: NemoTab, wc: WebContents): void {
  let done = false
  let timer: NodeJS.Timeout | null = null

  const onDomReady = (): void => reveal('dom-ready')
  /**
   * **トップフレームの失敗だけを見る**。`did-fail-load` は iframe でも出るので、
   * フレームを見ないと「本文より先に落ちた広告の iframe」で待機が解けて、
   * まだ何も描いていない View が前に出る。
   */
  const onFailLoad = (
    _event: Electron.Event,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) reveal('failed')
  }
  const stop = (): void => {
    done = true
    if (timer) clearTimeout(timer)
    timer = null
    wc.off('dom-ready', onDomReady)
    wc.off('did-fail-load', onFailLoad)
  }

  const reveal = (reason: string): void => {
    if (done) return
    stop()
    if (!peek.peekAwaitingDocument) return
    peek.peekAwaitingDocument = false
    const win = peek.window
    if (win.isDestroyed || win.baseWindow.isDestroyed()) return
    // 親が選択中のときだけ出す（別タブへ行っていれば隠れたままにする）
    if (win.activeTabKey === peek.peekOf?.key) selectTab(win, win.activeTabKey)
    win.pushState()
    log('peek.revealed', { key: peek.key, windowId: win.id, reason })
  }

  timer = setTimeout(() => reveal('timeout'), PEEK_PLACEHOLDER_TIMEOUT)
  wc.on('dom-ready', onDomReady)
  wc.on('did-fail-load', onFailLoad)
  wc.once('destroyed', stop)
}

/**
 * 親タブの上に Peek を作る。
 *
 * **`loadURL` は呼ばない**。`setWindowOpenHandler` の `createWindow` から
 * 同期で使われ、読み込みは Electron が「子の browsing context」として行う（計画 R1）。
 */
function openPeek(parent: NemoTab, url: string, adopt: WebContents): NemoTab | null {
  const win = parent.window
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return null

  const peek = new NemoTab(win, url)
  peek.peekOf = parent
  parent.peek = peek
  win.tabs.push(peek)
  peek.peekAwaitingDocument = true
  peek.materialize({ adopt })
  waitForPeekDocument(peek, adopt)

  // 親が選択中なら Peek もそのまま見せる。選択中でなければ隠れたまま
  // （タブを切り替えて戻ってきたときに出る）。
  if (win.activeTabKey === parent.key) selectTab(win, parent.key)
  win.layout()
  syncForegroundTab(win)
  win.pushState()
  log('peek.open', { key: peek.key, parent: parent.key, windowId: win.id, target: redactUrl(url) })
  return peek
}

/**
 * Peek を通常タブへ昇格させる（⌘O / 展開ボタン / 入れ子 popup の受け皿づくり）。
 *
 * **ページは読み直さない**（WebContents をそのまま使う）。
 * 昇格後は**タブ配列の末尾**へ移す。Peek を開いた後に背面タブが増えていることがあり、
 * 親の隣に置くと「末尾に来る」という仕様と食い違う。
 */
export function promotePeek(win: NemoWindow, peek: NemoTab): void {
  const parent = peek.peekOf
  if (!parent) return
  parent.peek = null
  peek.peekOf = null
  // 通常タブになったら中身待ちは関係ない。落とさないと View が出ないまま残る
  peek.peekAwaitingDocument = false

  const index = win.tabs.indexOf(peek)
  if (index !== -1) {
    win.tabs.splice(index, 1)
    win.tabs.push(peek)
  }
  win.layout()
  selectTab(win, peek.key)
  log('peek.promote', { key: peek.key, parent: parent.key, windowId: win.id })
}

/**
 * ⌘O。「今前面に出ている一時的なビュー」を腰を据えて読む場所へ移す。
 *
 * - Peek → **同じウィンドウ**の一時タブ（末尾）にしてアクティブに
 * - 小窓 → **直近に使っていた通常ウィンドウ**の一時タブ（末尾）へ移し、小窓は閉じる
 *
 * どちらもページは読み直さない（WebContents をそのまま運ぶ）。
 */
export function promoteForegroundView(win: NemoWindow): void {
  if (win.isDestroyed) return

  if (win.kind === 'mini') {
    const tab = win.tabs[0]
    if (!tab) return
    // 外部 URL の小窓は常に通常セッションなので、同じ partition の通常ウィンドウへ移せる
    const target = mostRecentNormalWindow(win.partition) ?? createWindow(undefined, { noInitialTab: true })
    const moved = moveTabToWindow(tab, target)
    // **移せたときだけ**小窓を閉じる。失敗したまま閉じるとページごと消える。
    if (!moved) {
      log('mini.promote_rejected', { windowId: win.id, target: target.id })
      return
    }
    // ここでは Space が切り替わってよい（「腰を据えて読む」と言っている操作なので）
    target.baseWindow.show()
    target.baseWindow.focus()
    app.focus({ steal: true })
    // 中身は移した後なので、閉じても ⌘⇧T には積まない
    removeWindow(win)
    log('mini.promoted', { from: win.id, to: target.id })
    return
  }

  const peek = win.getActiveTab()?.peek
  if (peek) promotePeek(win, peek)
}

/**
 * 閉じたタブ（⌘⇧T で開き直す）。ウィンドウをまたいで1本のスタックにする。
 *
 * **閉じた瞬間の URL / 名前 / 所属をそのまま持つ**。「登録 URL に戻る」のは
 * サイドバーの枠をクリックしたときの規則で、⌘⇧T には適用しない。
 */
const closedTabs: {
  url: string
  title: string
  pinnedId: string | null
  favoriteId: string | null
  customTitle: string | null
}[] = []
const CLOSED_TAB_LIMIT = 25

/**
 * 閉じたタブを ⌘⇧T のスタックとアーカイブに積む。
 *
 * **`removeTab` を通らない経路（小窓ごと閉じる）からも呼ぶ**ので関数に切り出してある。
 * ここを通さないと「小窓の ✕ で閉じた URL がどこにも残らない」になる。
 */
function rememberClosedTab(win: NemoWindow, tab: NemoTab, archiveReason: ArchiveReason): void {
  // シークレットのタブは ⌘⇧T の対象にしない（閉じたら跡形もなく消えるのが約束）
  if (!/^https?:\/\//.test(tab.url) || win.isPrivate) return
  closedTabs.push({
    url: tab.url,
    title: tab.title,
    // Peek / 小窓は**普通のタブとして**戻す（枠には紐づけない）
    pinnedId: tab.pinnedId,
    favoriteId: tab.favoriteId,
    // 専用タブの名前は**定義から実効値を読む**。タブ側のフィールドだけ見ると、
    // 定義を消した後に ⌘⇧T で戻したとき名前が失われる。
    customTitle: effectiveCustomTitle(tab)
  })
  if (closedTabs.length > CLOSED_TAB_LIMIT) closedTabs.shift()
  // 一時タブを閉じたらアーカイブに残す（Arc と同じで、閉じても掘り返せる）。
  // Favorite のタブもピン留めと同じ扱いで、アーカイブには載せない。
  if (tab.pinnedId === null && tab.favoriteId === null) {
    archiveTab(tab.url, tab.title, archiveReason)
  }
}

export function removeTab(
  win: NemoWindow,
  key: string,
  options: { archiveReason?: ArchiveReason } = {}
): void {
  // タブを1つしか持てない器（小窓）では「タブを閉じる」＝「ウィンドウを閉じる」。
  // ここで読み替えないと**空の小窓が残る**（⌘W で中身だけ消えた抜け殻になる）。
  if (!canHostAdditionalTabs(win) && win.findTab(key) !== null) {
    closeTemporaryWindow(win, 'user')
    return
  }

  const index = win.tabs.findIndex((tab) => tab.key === key)
  if (index === -1) return
  const [tab] = win.tabs.splice(index, 1)

  // Peek の親子を解く。**ここ1か所でやる**（呼び出し口ごとに書くと必ずどれかで漏れ、
  // `peekOf.window` と実際の所属が食い違ったまま残る）。
  if (tab.peekOf) {
    tab.peekOf.peek = null
    tab.peekOf = null
  }
  // 分割も**同じ場所で解く**（規則を1か所に揃える）。
  // 相方は後で「次に選ぶタブ」にも使うので、解く前に控えておく。
  // **`tab.split` を消しながら読まない** —— 自分が左だと 1 行目で `tab.split` が
  // null になり、2 行目が null 参照で落ちる（右を閉じるときだけ無事なので気づきにくい）。
  const pair = tab.split
  const splitPartner = pair?.partnerOf(tab) ?? null
  if (pair) {
    pair.left.split = null
    pair.right.split = null
  }
  // ペインのフォーカス購読も必ず外す（WebContents ごと消えるが、参照を残さない）
  tab.paneFocusOff?.()
  tab.paneFocusOff = null
  // 親タブを閉じるなら、その上に浮いている Peek も閉じる
  if (tab.peek) {
    const peek = tab.peek
    tab.peek = null
    peek.peekOf = null
    removeTab(win, peek.key, options)
  }

  rememberClosedTab(win, tab, options.archiveReason ?? 'closed')

  const wc = tab.webContents
  if (tab.view) win.baseWindow.contentView.removeChildView(tab.view)
  if (wc) {
    if (!win.isPrivate) extensions?.removeTab(wc)
    wc.close()
  }
  tab.view = null
  log('tab.remove', { key, windowId: win.id })

  if (win.activeTabKey === key) {
    // **分割の相方が居たらそれを選ぶ**。位置で選ぶ既定の規則だと、
    // ペアの右を閉じたときに「ペアの後ろにいたタブ」が選ばれ、
    // 左ではない無関係なページが全画面になる。
    // **通常タブから選ぶ**。全タブから選ぶと「別の親の Peek」を選びかねない
    const candidates = win.normalTabs
    const next =
      splitPartner && candidates.includes(splitPartner)
        ? splitPartner
        : candidates[Math.min(index, candidates.length - 1)]
    win.activeTabKey = null
    if (next) {
      selectTab(win, next.key)
      return
    }
  }
  // **必ず可視の再適用とレイアウトを通す**。Peek だけを閉じた経路や、
  // アクティブでない分割の相方を閉じた経路では `activeTabKey` が変わらないので
  // 上の `selectTab` を通らず、`applyVisibility()` も `layout()` も一度も走らない。
  // Peek 用の透明 View を隠すのは `layout()` の中だけなので、省くと
  // **✕ / Esc / ⌘W のあとも暗幕の View が最前面に残り、ページのクリックを丸ごと遮る**。
  win.applyVisibility()
  win.layout()
  syncForegroundTab(win)
  win.pushState()
  notifyCall()
}

/**
 * 専用タブなら定義側、一時タブならタブ側の名前（表示の唯一の正）。
 *
 * **専用タブのリネームは定義だけを書き換える**（`renameTab`）ので、
 * タブ側の `customTitle` を見ると古い名前のままになる。名前を読む側は必ずここを通す。
 */
export function effectiveCustomTitle(tab: NemoTab): string | null {
  if (tab.pinnedId) return findPinned(tab.pinnedId)?.customTitle ?? null
  if (tab.favoriteId) return findFavorite(tab.favoriteId)?.customTitle ?? null
  return tab.customTitle
}

/** サイドバー・コマンドバーに出すタブの名前。 */
export function tabDisplayName(tab: NemoTab): string {
  return effectiveCustomTitle(tab) ?? displayTitle(tab.title, tab.url)
}

/**
 * ⌘⇧T。閉じた瞬間の状態（URL / 名前 / 所属）に戻す。
 *
 * 不変条件が優先なので、例外が2つある。
 * - **同じ定義のタブが既に開いている**（閉じた後にサイドバーから開き直した）
 *   → 新しく作らず、そのタブを選ぶだけ。作ると同じ枠に2つぶら下がる
 * - **定義が既に消えている**（閉じた後に解除した）→ 所属を外して一時タブとして戻す。
 *   消えた ID のまま戻すと、どの層にも出ない不可視タブになる
 */
export function reopenClosedTab(target: NemoWindow): void {
  const entry = closedTabs.pop()
  if (!entry) return
  // 小窓では ⌘⇧T を受けても自分にタブを足せない。通常ウィンドウへ回す。
  const win = windowForNewTab(target)

  // 判定は純粋関数に寄せてある。この経路はメニューのアクセラレータからしか叩けず
  // CDP から合成できないので、**規則そのもの**を `scripts/tab-ownership.test.mjs` で確かめる。
  const decision = resolveReopen(entry, {
    pinnedExists: (id) => findPinned(id) !== null,
    favoriteExists: (id) => findFavorite(id) !== null,
    windowTabs: win.tabs
  })

  if (decision.action === 'select') {
    log('tab.reopen_selected_existing', { key: decision.key, windowId: win.id })
    selectTab(win, decision.key)
    return
  }
  createTab(win, decision.url, {
    pinnedId: decision.pinnedId,
    favoriteId: decision.favoriteId,
    title: decision.title,
    customTitle: decision.customTitle
  })
}

/**
 * タブの所有権を別ウィンドウへ移す。
 * WebContents は作り直さない（ログイン状態やスクロール位置を保つ）。
 *
 * **Peek を持つタブは Peek も一緒に運ぶ**（R9）。ここで完結させるのが肝で、
 * 呼び出し側に「Peek も忘れずに」と書かせると、呼び出し口が複数あるので必ず漏れる。
 * 漏れると `peekOf.window` と実際の所属が食い違い、View と拡張の window 対応が分裂する。
 *
 * @returns 移せたか。**partition 違いで拒否したことを呼び出し側が知る必要がある**
 *   （小窓の昇格は、移せたときだけ小窓を閉じないとページごと消える）。
 */
export function moveTabToWindow(tab: NemoTab, target: NemoWindow): boolean {
  const source = tab.window
  if (source === target) return false
  // シークレットと通常はセッションが違う。View を作り直さずに移すと、
  // 移した先で「シークレットのはずのタブが通常セッションのまま」になる。
  //
  // **検査は先に1回だけ**やる。親を移した後に Peek で弾かれると分裂する。
  if (source.partition !== target.partition) {
    log('tab.move_rejected', { key: tab.key, reason: 'different_session' })
    return false
  }
  if (source.tabs.indexOf(tab) === -1) return false
  // 移す先がタブを増やせない器（小窓）なら受け付けない
  if (!canHostAdditionalTabs(target) && target.tabs.length > 0) {
    log('tab.move_rejected', { key: tab.key, reason: 'target_cannot_host' })
    return false
  }

  const index = source.tabs.indexOf(tab)
  // 分割はウィンドウをまたげないので、移す前に解く。
  // **相方は控えておく**（`removeTab` と同じ罠。控えないと、右ペインを移したときに
  // 元のウィンドウで「ペアの後ろにいたタブ」が選ばれる）。
  // **ペアを控えてから消す**（`removeTab` と同じ罠）
  const pair = tab.split
  const splitPartner = pair?.partnerOf(tab) ?? null
  if (pair) {
    pair.left.split = null
    pair.right.split = null
  }
  tab.paneFocusOff?.()
  tab.paneFocusOff = null

  const moving = tab.peek ? [tab, tab.peek] : [tab]
  for (const item of moving) transferOne(item, source, target)

  if (source.activeTabKey === tab.key) {
    source.activeTabKey = null
    // **通常タブから選ぶ**（別の親の Peek を選ばない）
    const candidates = source.normalTabs
    const next =
      splitPartner && candidates.includes(splitPartner)
        ? splitPartner
        : candidates[Math.min(index, candidates.length - 1)]
    if (next) selectTab(source, next.key)
  }
  source.applyVisibility()
  source.layout()
  syncForegroundTab(source)
  source.pushState()

  selectTab(target, tab.key)
  target.layout()
  syncForegroundTab(target)
  log('tab.moved', { key: tab.key, from: source.id, to: target.id, withPeek: tab.peek !== null })
  return true
}

/** `moveTabToWindow` の1タブぶん。partition の検査は呼び出し側で済ませてある。 */
function transferOne(tab: NemoTab, source: NemoWindow, target: NemoWindow): void {
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
  /** 種別。`mini` は小窓（サイドバー無し・タブ1つ・NSPanel）。 */
  kind?: WindowKind
  /** 表示せずに作る（コールドスタートで通常ウィンドウを背面に復元するとき）。 */
  hidden?: boolean
}

export function createWindow(initialUrl?: string, options: CreateWindowOptions = {}): NemoWindow {
  const win = new NemoWindow(
    options.bounds,
    options.isPrivate === true,
    options.kind ?? 'normal',
    options.hidden === true
  )
  windowsById.set(win.id, win)
  log('window.create', {
    windowId: win.id,
    private: win.isPrivate,
    kind: win.kind,
    hidden: options.hidden === true
  })

  win.whenUiReady(() => {
    if (!options.noInitialTab && win.tabs.length === 0) createTab(win, initialUrl ?? BLANK_URL)
    win.layout()
    // 背面で復元したぶんはここで出す。**`show()` ではなく `showInactive()`**
    // （`show()` は前面に出てフォーカスと Space を奪う）。
    if (options.hidden === true && win.kind === 'normal' && !win.baseWindow.isDestroyed()) {
      win.baseWindow.showInactive()
    }
  })

  return win
}

export function removeWindow(win: NemoWindow): void {
  // `destroy()` → `baseWindow.close()` の順なので、`close` ハンドラから
  // 終了処理が撃ち返される。`captureClosingWindow` の再入ガードが受け止める。
  captureClosingWindow(win, 'user')
  win.destroy()
  if (!win.baseWindow.isDestroyed()) win.baseWindow.close()
}

/**
 * ユーザー操作で一時的なウィンドウ（小窓）を閉じる。
 *
 * 理由を持たせるのは、**アプリ終了時には ⌘⇧T に積まない**ため。
 * 終了時に積むと、次の起動で「閉じたタブ」の先頭が前回終了時の小窓になる。
 */
export function closeTemporaryWindow(win: NemoWindow, reason: 'user' | 'replaced'): void {
  captureClosingWindow(win, reason)
  removeWindow(win)
}

/** アプリ終了中か（終了で閉じたぶんは ⌘⇧T に積まない）。 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

/** 既に積んだウィンドウ（`removeWindow` → `close` の撃ち返しで二重に積まない）。 */
const capturedWindows = new Set<number>()

/**
 * 閉じようとしているウィンドウの中身を `closedTabs` に積む。
 *
 * 対象は**小窓だけ**。通常ウィンドウは `removeTab` を通らずに閉じても
 * セッション復元で戻るが、小窓は復元しないのでここで拾わないと消えてなくなる。
 */
function captureClosingWindow(win: NemoWindow, reason: 'user' | 'replaced'): void {
  if (win.kind !== 'mini') return
  if (quitting) return
  if (capturedWindows.has(win.id)) return
  capturedWindows.add(win.id)
  for (const tab of win.tabs) rememberClosedTab(win, tab, 'closed')
  log('mini.closed', { windowId: win.id, reason, remaining: miniWindows().length - 1 })
  // 上限を超えたまま残っていたぶんをここで詰める（超過を放置しない）
  setImmediate(() => trimMiniWindows())
}

/* ------------------------------------------------------------------ *
 * 小窓（Little Nemo）
 * ------------------------------------------------------------------ */

/** 今ある小窓（作った順）。 */
function miniWindows(): NemoWindow[] {
  return [...windowsById.values()].filter((win) => !win.isDestroyed && win.kind === 'mini')
}

/** 小窓の位置。常に同じ場所に出し、既にある枚数ぶんだけカスケードする。 */
function miniWindowBounds(): { x: number; y: number; width: number; height: number } {
  const step = miniWindows().length * MINI_CASCADE_STEP
  const display = screen.getPrimaryDisplay().workArea
  const x = Math.round(display.x + display.width - MINI_SIZE.width - 64) + step
  const y = Math.round(display.y + 72) + step
  return { x, y, ...MINI_SIZE }
}

/**
 * その WebContents を `window.opener` にしている生きた小窓があるか。
 *
 * **自前のマップは持たない**。`webContents.opener`（`WebFrameMain`）と
 * `WebContents.fromFrame()` で Electron に聞けば分かるし、破棄時の解除漏れが
 * 構造的に起きない。opener が死んでいれば `fromFrame` が undefined を返すので、
 * 「もう守る相手がいない」の判定としても正しい。
 */
function isOpenerOfLiveMini(candidate: NemoWindow): boolean {
  const target = candidate.tabs[0]?.webContents
  if (!target) return false
  for (const win of miniWindows()) {
    if (win === candidate) continue
    const wc = win.tabs[0]?.webContents
    if (!wc) continue
    let openerContents: WebContents | undefined
    try {
      const frame = wc.opener
      openerContents = frame ? webContentsModule.fromFrame(frame) : undefined
    } catch {
      // opener のフレームが既に壊れている＝守る相手がいない
      openerContents = undefined
    }
    if (openerContents?.id === target.id) return true
  }
  return false
}

/**
 * 小窓を上限まで減らす。
 *
 * **生きた小窓の opener になっているものは飛ばす**（計画 R8）。
 * 閉じると子の `window.opener` が死に、`postMessage` で OAuth の結果を受け取れなくなる。
 * 閉じられる候補が無ければ**上限を超えたまま開く**（計画 R10）。
 * 超過は放置せず、子が閉じたときにもう一度ここを通して詰める。
 */
function trimMiniWindows(protect?: NemoWindow): void {
  let windows = miniWindows()
  while (windows.length > MINI_WINDOW_CAP) {
    // **今開いたばかりの小窓は候補から外す**。opener チェーンが 5 段になると
    // 既存 4 枚はすべて誰かの opener なので保護され、**まだ誰の opener でもない
    // 5 枚目（＝たった今開いたもの）が victim に選ばれて即座に閉じる**。
    // R10 で守りたいのは逆（既存を保護して一時的に上限を超える）。
    const victim = windows.find((win) => win !== protect && !isOpenerOfLiveMini(win))
    if (!victim) {
      log('mini.cap_exceeded', { count: windows.length, cap: MINI_WINDOW_CAP })
      return
    }
    closeTemporaryWindow(victim, 'replaced')
    windows = miniWindows()
  }
}

/**
 * 小窓を1枚開く（外部アプリから URL を踏んだとき）。
 */
export function openMiniWindow(url: string): NemoTab | null {
  const win = createWindow(undefined, { kind: 'mini', noInitialTab: true })
  return fillMiniWindow(win, url, undefined)
}

/**
 * 既に用意した小窓に、Electron が作った子の WebContents を収める（入れ子 popup）。
 */
function adoptMiniTab(win: NemoWindow, url: string, guest: WebContents): NemoTab | null {
  return fillMiniWindow(win, url, guest)
}

/**
 * 小窓に中身を入れて画面に出す。
 *
 * **UI（上部バー）の準備は待たない**。`createWindow` の初期タブは `whenUiReady` 越しなので、
 * `setWindowOpenHandler` の `createWindow` コールバックから同期で使えない。
 */
function fillMiniWindow(win: NemoWindow, url: string, adopt: WebContents | undefined): NemoTab | null {
  let tab: NemoTab
  try {
    tab = new NemoTab(win, url)
    win.tabs.push(tab)
    tab.materialize(adopt ? { adopt } : {})
  } catch (error) {
    logError('mini.create_failed', error, { windowId: win.id })
    removeWindow(win)
    return null
  }
  win.activeTabKey = tab.key
  tab.view?.setVisible(true)
  win.layout()
  win.whenUiReady(() => {
    win.layout()
    win.pushState()
  })

  presentMiniWindow(win)
  trimMiniWindows(win)
  log('mini.open', {
    windowId: win.id,
    adopted: adopt !== undefined,
    target: redactUrl(url),
    count: miniWindows().length
  })
  return tab
}

/**
 * 小窓を画面に出してキーフォーカスを渡す。
 *
 * **`app.focus({ steal: true })` は絶対に撃たない**（Phase 0 の実測）。
 * 撃つとメインウィンドウの Space へ画面ごと切り替わり、この機能の意味が消える。
 * NSPanel なら `showInactive()` → `focus()` でアプリを前面に出さずにキーが来る。
 */
function presentMiniWindow(win: NemoWindow): void {
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return
  win.baseWindow.showInactive()
  win.baseWindow.focus()
  // ウィンドウが key になっても、中の WebContents に入れないと
  // `document.hasFocus()` が false のままでスクロールもキーも効かない。
  win.tabs[0]?.webContents?.focus()
}

/* ------------------------------------------------------------------ *
 * ピン留めとタブ実体の対応
 * ------------------------------------------------------------------ */

/**
 * 専用タブを一時タブへ降格させる。
 *
 * **降格が起きる経路は必ずここを通す**（解除 / フォルダ削除の巻き添え /
 * 変換の写像で null に倒れる2種類）。経路ごとに書くと、必ずどれかで名前が消える。
 *
 * 定義の `customTitle` は **null も含めて常に代入する**（タブ側の古い値を優先しない）。
 * 専用タブの表示名は定義が唯一の正なので、タブ側を優先すると
 * 「A でピン留め → B にリネーム → 解除」で A に戻る、といった食い違いが出る。
 */
function demoteTab(tab: NemoTab, definition: RemovedDefinition | null): void {
  tab.customTitle = definition?.customTitle ?? null
  tab.pinnedId = null
  tab.favoriteId = null
  log('tab.demoted', { key: tab.key, windowId: tab.window.id, definition: definition?.id ?? null })
}

/**
 * タブを定義に所属させる。
 * **同じウィンドウの先客は降格させる**（1 ウィンドウ 1 定義 1 タブ）。
 */
function assignDefinition(tab: NemoTab, kind: 'pinned' | 'favorite', definition: RemovedDefinition): void {
  for (const other of tab.window.tabs) {
    if (other === tab) continue
    const owned = kind === 'pinned' ? other.pinnedId : other.favoriteId
    if (owned === definition.id) demoteTab(other, definition)
  }
  tab.pinnedId = kind === 'pinned' ? definition.id : null
  tab.favoriteId = kind === 'favorite' ? definition.id : null
}

/**
 * 消えた定義に属していたタブを、**全ウィンドウ**で降格させる。
 *
 * 戻りは**降格したタブの本数**（消えた定義の数ではない）。スロットの読み込みは
 * 「何本のタブが今日のタブに移ったか」をログで追えないと後から誤診する。
 */
function demoteEverywhere(removed: RemovedDefinition[], skip?: NemoTab): number {
  if (removed.length === 0) return 0
  const byId = new Map(removed.map((definition) => [definition.id, definition]))
  let demoted = 0
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    let changed = false
    for (const tab of win.tabs) {
      if (tab === skip) continue
      const owned = tab.pinnedId ?? tab.favoriteId
      if (!owned) continue
      const definition = byId.get(owned)
      if (!definition) continue
      demoteTab(tab, definition)
      demoted += 1
      changed = true
    }
    if (changed) win.pushState()
  }
  return demoted
}

/**
 * セーブスロットを読み込む（ピン留め + お気に入りを丸ごと差し替える）。
 *
 * **降格は `demoteEverywhere` に通す**（新しい降格経路を作らない）。
 * どのタブを降格させるかは `replaceAll` が `definitionsRemovedBySlot` で決める
 * ——「同じ ID・同じ種別・同じ URL」で残らなかった定義だけ。
 * 全部降格させると、自分の Mac の枠を読み直したときに
 * 定義はサイドバーに残ったまま同じ URL の一時タブが並ぶ。
 *
 * **書き込みに失敗したら何も変えずに false を返す**（`replaceAll` が
 * 書けたときだけメモリへ反映するので、ここで巻き戻す必要はない）。
 */
export async function applySlot(
  index: number,
  data: { favorites: FavoriteItem[]; pinned: PinnedNode[] }
): Promise<boolean> {
  const removed = await replacePinsDefinition({ favorites: data.favorites, pinned: data.pinned })
  if (removed === null) return false
  const demoted = demoteEverywhere(removed)
  log('slot.applied', {
    index,
    favorites: data.favorites.length,
    pinned: data.pinned.length,
    // **降格したタブの本数**と**消えた定義の数**は別物。名前を取り違えると後から誤診する
    demoted,
    definitions: removed.length
  })
  return true
}

/**
 * ピン留め定義を消し、**全ウィンドウ**のタブから紐付けを外す。
 *
 * 定義は全ウィンドウ共有なので、操作したウィンドウのタブだけ外すのでは足りない。
 * フォルダを消したときは子孫の定義も一緒に消えるため、その分も外す。
 * ここを1か所に寄せておかないと、解除の経路（サイドバー / メニュー）ごとに漏れが出る。
 *
 * **変換（ピン ⇄ Favorite）からは呼ばない**。呼ぶと操作中のタブの所属まで外れる。
 */
export function unpinEverywhere(pinnedId: string): void {
  demoteEverywhere(unpinDefinition(pinnedId))
}

/** `unpinEverywhere` と対称。Favorite 定義を消して全ウィンドウの紐付けを外す。 */
export function removeFavoriteEverywhere(favoriteId: string): void {
  demoteEverywhere(removeFavoriteDefinition(favoriteId))
}

/**
 * 変換（ピン ⇄ Favorite）の結果を全ウィンドウのタブへ1度に反映する。
 *
 * 適用する写像は次の4つだけ:
 * - 操作中のタブ … 変換元 ID → **変換先 ID**
 * - 同じウィンドウで先に開いていた変換先のタブ … → **null**（降格）
 * - その他のウィンドウの変換元のタブ … → **null**（降格）
 * - その他のウィンドウの変換先のタブ … **変更なし**
 */
function applyConversion(tab: NemoTab, result: ConversionResult, kind: 'pinned' | 'favorite'): void {
  // 操作中のタブは飛ばす（変換元 ID を持っているので、外すと写像の1行目が壊れる）
  demoteEverywhere(result.removedDefinitions, tab)
  assignDefinition(tab, kind, result.target)
  tab.window.pushState()
}

/**
 * ⌘D。留めていなければ留め、留めていれば解除する（解除は全ウィンドウに効く）。
 *
 * Favorite に属しているタブ（や、同じ URL の Favorite がある一時タブ）は
 * **定義ごとピン留めへ移す**。所属だけ付け替えると同じ URL が両方の枠に残る。
 */
export function togglePin(tab: NemoTab): void {
  if (tab.pinnedId) {
    // **降格（unpin）は分割と無関係**なので触らない
    unpinEverywhere(tab.pinnedId)
    return
  }
  // **ピン留めは分割に入れない**ので、昇格の手前で解く（⌘D / 右クリック / ピン留めツリーへの D&D）。
  // `pinTabInto` はここを通るので、経路はこの1か所で足りる。
  separateSplit(tab.window, tab.key)
  const favoriteId = tab.favoriteId ?? findFavoriteByUrl(tab.url)?.id ?? null
  if (favoriteId) {
    const result = convertFavoriteToPin(favoriteId)
    if (result) applyConversion(tab, result, 'pinned')
    return
  }
  const node = findPinnedByUrl(tab.url) ?? pinUrl(tab.url, tab.title, tab.customTitle)
  if (!node) return
  assignDefinition(tab, 'pinned', { id: node.id, title: node.title, customTitle: node.customTitle })
  tab.window.pushState()
}

/**
 * タブを Favorites に入れる（メニュー / サイドバーへの D&D）。
 * `togglePin` と対称に、ピン留めに属していれば**定義ごと**移す。
 */
export function addFavoriteFromTab(tab: NemoTab): void {
  // **既に Favorites なら何もしない**（降格・付け替えは分割と無関係）
  if (tab.favoriteId) return
  // Favorites も分割に入れない（`togglePin` と同じ規則）。昇格の手前で解く
  separateSplit(tab.window, tab.key)
  const pinnedId = tab.pinnedId ?? findPinnedByUrl(tab.url)?.id ?? null
  if (pinnedId) {
    const result = convertPinToFavorite(pinnedId)
    if (result) applyConversion(tab, result, 'favorite')
    return
  }
  const item = addFavoriteDefinition(tab.url, tab.title, tab.customTitle)
  if (!item) return
  assignDefinition(tab, 'favorite', { id: item.id, title: item.title, customTitle: item.customTitle })
  tab.window.pushState()
}

/** URL から Favorite 定義を引く（同じ URL を両方の枠に置かないため）。 */
function findFavoriteByUrl(url: string): { id: string } | null {
  return getFavorites().find((item) => item.url === url) ?? null
}

/**
 * タブをピン留めツリーの**指定した位置**へ置く（サイドバーへのドラッグ & ドロップ）。
 *
 * すでにピン留め済みのタブを掴んだときは、定義を作り直さず場所だけ動かす。
 * 作り直すと ID が変わり、他ウィンドウで開いている同じピン留めの紐付けが切れる。
 */
export function pinTabInto(tab: NemoTab, parentId: string | null, index: number): void {
  if (!tab.pinnedId) togglePin(tab)
  const pinnedId = tab.pinnedId
  if (!pinnedId) return
  movePinned(pinnedId, parentId, index)
}

/**
 * ピン留め定義を、そのウィンドウで開く（既に開いていればそれを選ぶ）。
 *
 * **常に登録 URL を開く**（前回そのピンで見ていた URL は覚えない）。
 */
export function openPinned(win: NemoWindow, pinnedId: string): void {
  const node = findPinned(pinnedId)
  if (!node || node.kind !== 'link') return
  const existing = win.normalTabs.find((tab) => tab.pinnedId === pinnedId)
  if (existing) {
    selectTab(win, existing.key)
    return
  }
  createTab(win, node.url, { pinnedId, title: node.title, customTitle: node.customTitle })
}

/** `openPinned` と対称。Favorite 定義をそのウィンドウで開く。 */
export function openFavorite(win: NemoWindow, favoriteId: string): void {
  const item = findFavorite(favoriteId)
  if (!item) return
  const existing = win.normalTabs.find((tab) => tab.favoriteId === favoriteId)
  if (existing) {
    selectTab(win, existing.key)
    return
  }
  createTab(win, item.url, { favoriteId, title: item.title, customTitle: item.customTitle })
}

/**
 * タブの名前を変える。専用タブなら**所属定義**を、一時タブならタブ自身を書き換える。
 * `null` / 空文字で解除して実タイトルに戻る。
 */
export function renameTab(tab: NemoTab, title: string | null): void {
  const definitionId = tab.pinnedId ?? tab.favoriteId
  if (definitionId) {
    renameNode(definitionId, title)
    return
  }
  const trimmed = typeof title === 'string' ? title.trim().slice(0, 300) : ''
  tab.customTitle = trimmed || null
  tab.window.pushState()
}

/**
 * そのタブが属するピン定義の URL を、今開いているページに差し替える。
 * 定義 ID は**タブから導出する**（renderer に任意の定義 ID を指定させない）。
 */
export function updatePinnedUrlFromTab(tab: NemoTab): void {
  if (!tab.pinnedId) return
  updatePinnedUrlDefinition(tab.pinnedId, tab.url)
}

/* ------------------------------------------------------------------ *
 * sleep タイマー / セッション保存
 * ------------------------------------------------------------------ */

let sleepTimer: NodeJS.Timeout | null = null
let sessionSaveTimer: NodeJS.Timeout | null = null

export function startBackgroundWork(): void {
  /*
   * sleep 判定の間隔。既定は 5 秒（`src/shared/timings.js`）。
   * 設定より短い周期で見に行かないと「30分後に寝る」が最大1分ずれる。
   * 5秒なら短い設定（自走検証で使う 0.05 分など）でも実際に効く。
   *
   * 自走検証のときだけ `NEMO_VERIFY_TIMINGS` でさらに短くできる。
   * 変わるのは**いつ判定するか**だけで、`sweepSleep()` / `sweepArchive()` の中身は不変。
   */
  sleepTimer = setInterval(() => {
    sweepSleep()
    sweepArchive()
  }, getTimings().sleepSweepMs)
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
  // Live Folder（GitHub の PR）。**契機を足さないと、取得しても誰にも届かない**
  onLiveFolderChanged(() => {
    for (const win of windowsById.values()) win.pushShared()
  })
  // 未読の判定に「いま見られているタブ」が要るので、registry から借りる形で渡す
  // （live-folders 側から registry を import すると循環する）
  initLiveFolders({
    // **「見えている」で見る**（`activeTabKey` だけだと分割の相方の PR が未読のまま残る）
    activeUrls: () =>
      [...windowsById.values()]
        .filter((win) => !win.isDestroyed && !win.isPrivate && win.kind === 'normal')
        .flatMap((win) =>
          [...win.visibleTabKeys].flatMap((key) => {
            const tab = win.findTab(key)
            return tab ? [tab.url] : []
          })
        )
  })

  // ダイアログの表示先はウィンドウ
  setPromptNotifier((windowId, prompt) => {
    windowsById.get(windowId)?.pushPrompt(prompt)
  })
}

/**
 * 自動 sleep / 自動アーカイブが見る「最後に使った時刻」。
 *
 * 分割に入っているタブは**ペアの新しい方**を使う。`lastActiveAt` はフォーカスを
 * 持っていた側だけが更新されるので（⌃M の MRU 順を素直に保つため）、素の値で判定すると
 * **見ていない間に片側だけ先に閉じられてペアが解ける**。
 */
function pairLastActiveAt(tab: NemoTab): number {
  const partner = tab.split?.partnerOf(tab)
  return partner ? Math.max(tab.lastActiveAt, partner.lastActiveAt) : tab.lastActiveAt
}

/** 触っていないタブのメモリを解放する。 */
function sweepSleep(): void {
  const minutes = getSettings().tabSleepMinutes
  if (minutes <= 0) return
  const threshold = Date.now() - minutes * 60_000
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    let slept = false
    const visible = win.visibleTabKeys
    for (const tab of win.normalTabs) {
      // **見えているタブは触らない**（分割の相方は `activeTabKey` ではないが画面に出ている）
      if (visible.has(tab.key)) continue
      // **Peek を持つ親タブは寝かせない**（親を捨てると Peek の置き場所が無くなる）
      if (tab.peek) continue
      if (tab.asleep) continue
      if (pairLastActiveAt(tab) > threshold) continue
      // 音が出ているタブは寝かせない
      if (tab.webContents?.isCurrentlyAudible()) continue
      // 会議中のタブは寝かせない（計画 R3）。全員ミュートの静かな瞬間は
      // `isCurrentlyAudible()` が false なので、これが無いと会議中に切れる
      if (callWatcher?.isSleepExempt(tab)) continue
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
 * 対象は**一時タブだけ**。ピン留め / Favorites のタブは触らない（Arc と同じ）。
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
    const visible = win.visibleTabKeys
    for (const tab of [...win.normalTabs]) {
      // ピン留め / Favorites の専用タブは触らない（Arc と同じ）
      if (tab.pinnedId !== null || tab.favoriteId !== null) continue
      // **見えているタブは触らない**（分割の相方も画面に出ている）
      if (visible.has(tab.key)) continue
      // Peek を持つ親タブは触らない（見ている最中の Peek ごと消えるのは事故）
      if (tab.peek) continue
      if (pairLastActiveAt(tab) > threshold) continue
      if (tab.webContents?.isCurrentlyAudible()) continue
      // 会議中のタブは閉じない（sleep と同じ除外。計画 R3）
      if (callWatcher?.isSleepExempt(tab)) continue
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
  stopLiveFolders()
  if (sleepTimer) clearInterval(sleepTimer)
  sleepTimer = null
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
  sessionSaveTimer = null
}

/**
 * セッションは頻繁に変わるのでデバウンスして書く。
 *
 * **これは 2 段あるデバウンスの 1 段目**（2 段目は `store/session.ts` が `JsonStore` に
 * 渡す値）。自走検証のときだけ両方を `timings` 経由で縮める —— 片方だけ縮めても
 * 下限がもう片方に張り付く。書かれる中身は変わらない。
 */
function scheduleSessionSave(): void {
  if (sessionSaveTimer) return
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null
    saveSession(collectSession())
  }, getTimings().sessionSaveDebounceMs)
  sessionSaveTimer.unref?.()
}

export function collectSession(): SavedWindow[] {
  // シークレットウィンドウはディスクに残さない（復元もしない）
  // 小窓は復元しない（`toSaved()` を空にするだけでは「空の通常ウィンドウ」として復元される）
  return [...windowsById.values()]
    .filter((win) => !win.isDestroyed && !win.isPrivate && win.kind === 'normal')
    .map((win) => win.toSaved())
}

/** 起動時にダイアログ待ちの状態を UI に送り直す（ウィンドウを作り直したとき用）。 */
export function refreshPrompt(win: NemoWindow): void {
  win.pushPrompt(currentPrompt(win.id))
}
