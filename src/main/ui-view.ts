import { WebContentsView, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_INDEX_URL, UI_PARTITION } from './paths.js'
import { isUiUrl, redactUrl } from './security.js'
import { log } from './log.js'
import type { WebContents } from 'electron'

/**
 * ブラウザ UI の View を作る共通 factory。
 *
 * **`NemoWindow` の中に置かない**。会議の小窓（`call-window.ts`）は
 * `NemoWindow` ではないが、同じ `nemo://ui/` を同じ防御つきで出す必要がある。
 * メソッドとして隠したままだと防御を書き写すことになり、
 * 「小窓側だけ緩い」という食い違いが必ず生まれる。
 *
 * ブラウザ UI の View 種別。
 * - `sidebar` … 常時表示のサイドバー
 * - `toolbar` … ページ領域の上端に敷くアドレスバー（通常ウィンドウのみ・常時表示）
 * - `overlay` … コマンドバー等（必要なときだけ）
 * - `peek` … Peek の暗幕と ✕ / ⌘O ボタン（透明）
 * - `empty` … タブが 1 つも無いときにページ領域へ敷く画面
 * - `mini` … 小窓（Little Nemo）の上部バー
 * - `call` … 会議の小窓（他アプリの上に浮くバー）。**ウィンドウ全体がこれ1枚**
 */
export type UiViewKind = 'sidebar' | 'toolbar' | 'overlay' | 'peek' | 'empty' | 'mini' | 'call'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const uiPreloadPath = path.join(moduleDir, '..', 'preload', 'ui.cjs')

export interface CreateUiViewOptions {
  view: UiViewKind
  /**
   * `?window=` に載せる ID。UI 側が「どのウィンドウの UI か」を知るために使う。
   * 会議の小窓は `NemoWindow` を持たないので `0` を渡す。
   */
  windowId: number
  isPrivate?: boolean
  /** 読み込みが終わるたびに呼ぶ（`once` ではない。HMR や読み直しでも状態を送り直す）。 */
  onLoad?: (contents: WebContents) => void
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
function lockUiNavigation(contents: WebContents, view: UiViewKind, uiUrl: string): void {
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

export function createUiView(options: CreateUiViewOptions): WebContentsView {
  const { view, windowId, isPrivate = false, onLoad } = options
  // オーバーレイと Peek の暗幕は下のページを透かす必要がある
  const transparent = view === 'overlay' || view === 'peek'
  const contentsView = new WebContentsView({
    webPreferences: {
      // UI はページと別セッションに置く（拡張の content script を UI に入れない）
      session: session.fromPartition(UI_PARTITION),
      preload: uiPreloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      transparent
    }
  })
  if (transparent) contentsView.setBackgroundColor('#00000000')

  const uiUrl = `${UI_INDEX_URL}?view=${view}&window=${windowId}${isPrivate ? '&private=1' : ''}`
  lockUiNavigation(contentsView.webContents, view, uiUrl)

  void contentsView.webContents.loadURL(uiUrl)

  // `once` ではなく `on`。dev の HMR や、何らかの理由で読み直したときにも
  // 状態を送り直さないと、UI が空のまま復帰しない。
  if (onLoad) {
    contentsView.webContents.on('did-finish-load', () => onLoad(contentsView.webContents))
  }
  return contentsView
}

/**
 * UI View を確実に片付ける。
 *
 * **`win.destroy()` だけでは中の `webContents` が破棄されず、レンダラプロセスが残る**
 * （計測では 1 枚あたり 89MB）。`removeChildView` → `webContents.close()` の順を
 * 必ず通すために、閉じる処理はここ 1 か所へ寄せる。
 */
export function disposeUiView(parent: Electron.View, view: WebContentsView): void {
  try {
    parent.removeChildView(view)
  } catch {
    // 親が既に壊れている（ウィンドウごと破棄された）。close だけ通せばよい
  }
  if (!view.webContents.isDestroyed()) view.webContents.close()
}
