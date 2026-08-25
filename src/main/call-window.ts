import { BaseWindow, screen, type WebContents, type WebContentsView } from 'electron'
import { createUiView, disposeUiView } from './ui-view.js'
import { getCallWindowPosition, saveCallWindowPosition } from './store/call-window.js'
import { log } from './log.js'
import { fitsAnyWorkArea } from '../shared/settings-schema.js'
import type { CallState } from '../shared/types.js'

/**
 * 会議の小窓（Meet の通話コントロール）。
 *
 * **`NemoWindow` ではない**。タブを持たず `windowsById` にも登録しない。
 * 混ぜると `sweepSleep` / `collectSession` / タブスイッチャーなど、
 * 「タブがある前提」で全ウィンドウを舐めている既存のループが全部壊れる。
 *
 * ## 値段
 *
 * `WebContentsView` 1 枚でレンダラプロセスが 1 つ増える（実測 +89MB）。
 * ウィンドウの枠自体は誤差（+0.8MB）なので、**返せるのは View を閉じたときだけ**。
 * しかも **`win.destroy()` だけでは中の `webContents` が破棄されない**ので、
 * 閉じる経路を `destroyCallWindow()` の 1 本に絞り、
 * `removeChildView` → `webContents.close()` → `win.destroy()` を必ず通す。
 */

/** バーの寸法（DESIGN.md「会議の小窓」と一致させる）。**記憶しない**（位置だけ覚える）。 */
const CALL_SIZE = { width: 336, height: 60 }
/** 既定位置（画面右下）の余白。 */
const CALL_MARGIN = 24

interface CallWindowHandle {
  baseWindow: BaseWindow
  view: WebContentsView
}

let current: CallWindowHandle | null = null
/** 最後に push した状態。読み込み完了時に送り直すために持つ。 */
let lastState: CallState | null = null

/** 画面右下（既定位置）。対象タブが載っている display を優先する。 */
function defaultPosition(nearBounds: Electron.Rectangle | null): { x: number; y: number } {
  const display = nearBounds ? screen.getDisplayMatching(nearBounds) : screen.getPrimaryDisplay()
  const area = display.workArea
  return {
    x: Math.round(area.x + area.width - CALL_SIZE.width - CALL_MARGIN),
    y: Math.round(area.y + area.height - CALL_SIZE.height - CALL_MARGIN)
  }
}

/**
 * 保存した位置を使ってよいか。
 *
 * **どの display の `workArea` にも収まらない座標は捨てる**
 * （モニタを外した / 解像度が変わった後に、画面外へ出したまま復元しない）。
 */
function restorablePosition(): { x: number; y: number } | null {
  const saved = getCallWindowPosition()
  if (!saved) return null
  const fits = fitsAnyWorkArea(
    saved,
    CALL_SIZE,
    screen.getAllDisplays().map((display) => display.workArea)
  )
  if (!fits) {
    log('call.position_out_of_range', { x: saved.x, y: saved.y, displayId: saved.displayId })
    return null
  }
  return { x: saved.x, y: saved.y }
}

/**
 * 小窓を用意する（既にあればそれを返す）。
 *
 * `nearBounds` は対象タブが載っているウィンドウの矩形。
 * **保存位置が無いときだけ**、その display の右下を既定位置にするために使う。
 */
export function ensureCallWindow(nearBounds: Electron.Rectangle | null): CallWindowHandle {
  if (current && !current.baseWindow.isDestroyed()) return current

  const position = restorablePosition() ?? defaultPosition(nearBounds)
  const baseWindow = new BaseWindow({
    ...position,
    ...CALL_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    backgroundColor: '#1b1b20',
    title: 'Nemo — 会議',
    // **NSPanel にするのが肝**（小窓と同じ理由）。通常ウィンドウだとキーフォーカスを
    // 渡すのに `app.focus({ steal: true })` が要り、撃つとメインウィンドウの Space へ
    // 画面ごと切り替わる。panel（nonactivating panel）なら
    // 「アプリを前面に出さずに押せる」が成立し、フルスクリーンの Space の上にも出る。
    //
    // `setVisibleOnAllWorkspaces` は**呼ばない**。呼ぶと process type が変換されて
    // Dock アイコンが消える（全 Space 追従は panel の性質として付いてくる）。
    type: 'panel'
  })
  // 他アプリの上に浮かせる。`floating` は通常のウィンドウより上・
  // OS の UI（メニュー・Dock）より下という並び。
  baseWindow.setAlwaysOnTop(true, 'floating')

  const view = createUiView({
    view: 'call',
    windowId: 0,
    onLoad: (contents) => {
      // renderer は購読しかしないので、読み込み直後に**今の状態を送り直す**。
      // ここが無いと、購読より前に送った分を取りこぼして空のバーになる。
      if (lastState) contents.send('call:state', lastState)
    }
  })
  baseWindow.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: CALL_SIZE.width, height: CALL_SIZE.height })

  // 位置は**ドラッグの終了時**にだけ書く（ドラッグ中に書き続けない）。
  baseWindow.on('moved', () => {
    if (baseWindow.isDestroyed()) return
    const bounds = baseWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    saveCallWindowPosition({ x: bounds.x, y: bounds.y, displayId: display.id })
    log('call.position_saved', { x: bounds.x, y: bounds.y, displayId: display.id })
  })

  // ネイティブの経路（何かの拍子に close が来る）でも View を置き去りにしない。
  baseWindow.on('close', () => destroyCallWindow('native_close'))

  current = { baseWindow, view }
  log('call.window_created', { x: position.x, y: position.y })
  return current
}

/**
 * 小窓を出す。
 *
 * **`show()` も `app.focus({ steal: true })` も撃たない**。
 * 撃つと会議タブのある Space へ画面ごと切り替わり、この機能の意味が消える
 * （他アプリで作業しながらミュートする、が目的なので）。
 */
export function showCallWindow(): void {
  const handle = current
  if (!handle || handle.baseWindow.isDestroyed()) return
  if (handle.baseWindow.isVisible()) return
  handle.baseWindow.showInactive()
  log('call.window_shown', {})
}

export function hideCallWindow(): void {
  const handle = current
  if (!handle || handle.baseWindow.isDestroyed()) return
  if (!handle.baseWindow.isVisible()) return
  handle.baseWindow.hide()
  log('call.window_hidden', {})
}

export function isCallWindowVisible(): boolean {
  const handle = current
  return Boolean(handle && !handle.baseWindow.isDestroyed() && handle.baseWindow.isVisible())
}

export function hasCallWindow(): boolean {
  return Boolean(current && !current.baseWindow.isDestroyed())
}

/** 小窓の UI WebContents か（IPC の送信元検証に使う）。 */
export function isCallWindowContents(contents: WebContents): boolean {
  const handle = current
  if (!handle) return false
  const owned = handle.view.webContents
  return !owned.isDestroyed() && owned.id === contents.id
}

/** 状態を push する。**変化したときだけ**呼ぶ（呼び出し側で差分を見る）。 */
export function pushCallState(state: CallState): void {
  lastState = state
  const handle = current
  if (!handle || handle.baseWindow.isDestroyed()) return
  const contents = handle.view.webContents
  if (!contents.isDestroyed()) contents.send('call:state', state)
}

/** 最後に push した状態（`call:getState` が返すもの）。 */
export function currentCallState(): CallState | null {
  return lastState
}

/**
 * 小窓を破棄して 89MB を返す。**閉じる経路はここ 1 本**。
 *
 * `win.destroy()` だけでは中の `webContents` が破棄されずレンダラが残るので、
 * `removeChildView` → `webContents.close()` を必ず先に通す。
 */
export function destroyCallWindow(reason: string): void {
  const handle = current
  if (!handle) return
  current = null
  lastState = null
  if (!handle.baseWindow.isDestroyed()) {
    disposeUiView(handle.baseWindow.contentView, handle.view)
    handle.baseWindow.destroy()
  } else if (!handle.view.webContents.isDestroyed()) {
    // ウィンドウだけ先に壊れた場合でも WebContents は必ず閉じる
    handle.view.webContents.close()
  }
  log('call.window_destroyed', { reason })
}
