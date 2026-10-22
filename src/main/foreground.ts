import { app, screen, webContents as webContentsModule, type BaseWindow, type WebContents } from 'electron'
import { log } from './log.js'

/**
 * 自走検証を**背面で**回すモード（`NEMO_VERIFY_BACKGROUND=1`。`mise run verify` が既定で立てる）。
 *
 * 検証用に起動した Nemo が前面に来ると、その数分間ユーザーの打鍵が検証ウィンドウに吸われる。
 * このモードでは起動時に自動でアクティブ化されず（accessory）、ウィンドウは `showInactive()` で
 * 「見える位置にあるが key でも前面でもない」状態に留める。スクショ（`screencapture -l`）は遮蔽されていても撮れる。
 *
 * 裏口なので **`!app.isPackaged`** で塞ぐ（`NEMO_VERIFY_DIAGNOSTICS` / `NEMO_VERIFY_TIMINGS` と同じ流儀）。
 */
export function isVerifyBackground(): boolean {
  return process.env['NEMO_VERIFY_BACKGROUND'] === '1' && !app.isPackaged
}

/**
 * 背面モードの下ごしらえ。`app.ready` より前（`applyUserDataDir()` の直後）に呼ぶ。
 *
 * - `accessory`: Dock に出さず、起動時に自動でアクティブ化されない（macOS）
 * - `did-become-active`: それでもアプリがアクティブになった回数を `app.did_become_active` で残す。
 *   verify-all が最後に件数を読み、**0 でなければ FAIL** にする（奪っていないことを実測で示す）
 */
export function installVerifyBackgroundMode(): void {
  if (!isVerifyBackground()) return
  app.setActivationPolicy('accessory')
  // 窓は最背面に置く（`presentInBackground`）のでユーザーの窓に隠れるのが普通。Chromium は完全に遮蔽された窓の
  // ページを `visibilityState: hidden` にして rAF とタイマーを止める（描画待ちの検査が止まる）ので、全 WebContents で切る
  app.on('web-contents-created', (_event, wc) => {
    wc.setBackgroundThrottling(false)
  })
  app.on('did-become-active', () => {
    log('app.did_become_active', {})
  })
  log('verify.background_mode', {})
}

/**
 * 背面モードの窓の出し方。**前面でも key でもなく、実マウスの下にも無い**。
 *
 * - `setIgnoreMouseEvents(true)`: 実クリックを受けない（出す前に）。**ホバーは止まらない**: Chromium は窓の下にある
 *   実ポインタの位置を知っていて（`document.querySelector(':hover')` が立つ。実測）、コマンドバーの候補行は
 *   `onMouseEnter` で選択が動くので、実マウスが乗っただけで上下移動の検査が狂った
 * - `showInactive()`: 前面アプリも key も動かさない（出していない窓だけ）
 * - `blur()`（= orderBack）: 最背面へ。`showInactive()` のままだと他アプリの窓の上に被る
 * - `park`: 全ディスプレイの右下の外へ押し出す。AppKit は**左上の 40×116px だけ画面内に残して**押し戻す（素の Electron で実測。
 *   hiddenInset / frameless / movable:false でも同じ）ので「ほぼ画面外」になり、実ポインタが乗ることがなくなる。
 *   画面外でも `visibilityState` は visible・rAF は回る・`capturePage` と `screencapture -l` も撮れる
 *   （遮蔽の throttling は `installVerifyBackgroundMode` で切ってある）。通常窓だけ。小窓は位置の検査があるので動かさない
 *
 * CDP の `Input.*` と `sendInputEvent` は RenderWidgetHost に直接届くので、どれにも影響しない。
 */
export function presentInBackground(win: BaseWindow, options: { park?: boolean } = {}): void {
  if (win.isDestroyed()) return
  win.setIgnoreMouseEvents(true)
  if (!win.isVisible()) win.showInactive()
  win.blur()
  if (options.park) parkOffscreen(win)
}

/** 全ディスプレイの右下の外へ。AppKit の押し戻しで左上の角だけが画面の右下に残る。 */
function parkOffscreen(win: BaseWindow): void {
  const displays = screen.getAllDisplays().map((d) => d.bounds)
  const right = Math.max(...displays.map((d) => d.x + d.width))
  const bottom = Math.max(...displays.map((d) => d.y + d.height))
  const { width, height } = win.getBounds()
  win.setBounds({ x: right + width, y: bottom + height, width, height })
}

/**
 * `baseWindow.showInactive()` の代わり（背面で復元する通常窓・小窓・エージェント窓の出し方）。
 * 通常はそのまま `showInactive()`。背面モードでは `presentInBackground`。
 */
export function showWindowInactive(win: BaseWindow, options: { park?: boolean } = {}): void {
  if (win.isDestroyed()) return
  if (isVerifyBackground()) presentInBackground(win, options)
  else win.showInactive()
}

/**
 * ウィンドウを前面に出し、アプリをアクティブにする（**Space が切り替わってよい操作**だけが呼ぶ:
 * 小窓の ⌘O 昇格・会議タブへ戻る・参加中の実体へ戻る）。
 *
 * 小窓・エージェント窓・会議の小窓は前面を奪わない設計なので、ここは通らない
 * （`presentMiniWindow` / `presentAgentWindow` / `call-window.ts`）。
 *
 * 背面モードでは `showInactive()` だけにして `foreground.suppressed` を残す。
 * 呼び出し側に分岐を持たせない（規則は 1 つ、抑止もここだけ）。
 */
export function bringToFront(win: BaseWindow, reason: string): void {
  if (win.isDestroyed()) return
  if (isVerifyBackground()) {
    presentInBackground(win)
    log('foreground.suppressed', { reason })
    return
  }
  if (!win.isVisible()) win.show()
  win.focus()
  app.focus({ steal: true })
}

/**
 * `baseWindow.focus()` の代わり。窓を key にする（小窓・エージェント窓など「前面を奪わずに key だけ渡す」窓も通る）。
 *
 * Electron の `focus()` は `activateIgnoringOtherApps:NO` + `makeKeyAndOrderFront` で、他アプリが
 * active のときも Nemo がアクティブになることがある（背面モードの実測）。背面モードでは撃たない
 * （出ていない窓だけ `showInactive()` で出す）。
 */
export function focusWindow(win: BaseWindow): void {
  if (win.isDestroyed()) return
  if (isVerifyBackground()) {
    presentInBackground(win)
    return
  }
  win.focus()
}

/**
 * `webContents.focus()` の代わり。
 *
 * Electron の `WebContents.focus()` は macOS では**所属する窓の `Focus(true)` を伴う**ので、
 * タブを選ぶ・Peek を開く・オーバーレイを出すたびに Nemo がアクティブになりうる
 * （背面モードの実測: アクティブ化 6 回のすべてが直前の `tab.select` / `peek.open` だった）。
 * 背面モードでは撃たない。CDP の入力は WebContents 単位で届くので、first responder に依らない。
 */
export function focusContents(wc: WebContents | null | undefined): void {
  if (!wc || wc.isDestroyed()) return
  if (isVerifyBackground()) {
    intendedFocus = wc
    return
  }
  wc.focus()
}

/** 背面モードで main が最後にフォーカスを入れようとした WebContents（撃っていないので OS は知らない）。 */
let intendedFocus: WebContents | null = null

/**
 * 診断（`splitDiagnostics().focusedWebContentsId`）に出す「フォーカスのある WebContents」。
 *
 * 通常は OS の実状態（`webContents.getFocusedWebContents()`）。背面モードでは窓が key にならず常に null になるので、
 * main が `focusContents` で**入れようとした先**を返す。Peek の開閉でフォーカスを正しい WebContents へ渡しているか
 * （渡し忘れると Esc が responder chain に落ちる実バグがあった）は、背面でも「意図」で検査できる。
 * 「意図したが効かなかった」は前面モード（`mise run verify:foreground`）で見る。
 */
export function focusedContentsForDiagnostics(): WebContents | null {
  if (isVerifyBackground()) return intendedFocus && !intendedFocus.isDestroyed() ? intendedFocus : null
  return webContentsModule.getFocusedWebContents()
}
