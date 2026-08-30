import type { Input, WebContents } from 'electron'
import type { NemoWindow } from './registry.js'
import { log } from './log.js'

/**
 * ⌘ の長押しで Favorites のタイルに ⌘1〜9 の番号を出す（Arc と同じ）。
 *
 * 判定は main で行う。サイドバーは別 View なので、ページ側にフォーカスがあると
 * renderer には keydown が来ない。各 WebContents の `before-input-event` で Meta を拾い、
 * サイドバーへ「出す / 消す」だけを送る。
 *
 * - **押した瞬間には出さない**。`HOLD_MS` 経ってから出す（⌘L / ⌘T / ⌘W のたびに一瞬光らせない）
 * - keyUp は取りこぼす（ネイティブメニューの展開・拡張ポップアップへのフォーカス移動・⌘⇥）ので、
 *   ウィンドウの blur・WebContents のフォーカス移動・表示から `AUTO_HIDE_MS` を安全弁にして必ず消す
 */
export const HOLD_MS = 350
export const AUTO_HIDE_MS = 5000

interface HintState {
  holdTimer: ReturnType<typeof setTimeout> | null
  hideTimer: ReturnType<typeof setTimeout> | null
  visible: boolean
}

const states = new WeakMap<NemoWindow, HintState>()

function stateOf(win: NemoWindow): HintState {
  let state = states.get(win)
  if (!state) {
    state = { holdTimer: null, hideTimer: null, visible: false }
    states.set(win, state)
  }
  return state
}

function send(win: NemoWindow, visible: boolean): void {
  if (win.isDestroyed) return
  const wc = win.chromeWebContents
  if (!wc.isDestroyed()) wc.send('nemo:shortcut-hint', visible)
}

/** ⌘ が押された（押しっぱなしの keyDown リピートは無視）。 */
export function shortcutHintDown(win: NemoWindow): void {
  const state = stateOf(win)
  if (state.visible || state.holdTimer) return
  state.holdTimer = setTimeout(() => {
    state.holdTimer = null
    if (win.isDestroyed) return
    state.visible = true
    send(win, true)
    log('shortcut_hint.shown', { windowId: win.id })
    state.hideTimer = setTimeout(() => shortcutHintHide(win, 'timeout'), AUTO_HIDE_MS)
  }, HOLD_MS)
}

/** ⌘ が離された / 取りこぼしの安全弁。出ていなければ何もしない（タイマーだけ捨てる）。 */
export function shortcutHintHide(win: NemoWindow, reason: 'keyup' | 'blur' | 'focus' | 'timeout'): void {
  const state = states.get(win)
  if (!state) return
  if (state.holdTimer) clearTimeout(state.holdTimer)
  state.holdTimer = null
  if (state.hideTimer) clearTimeout(state.hideTimer)
  state.hideTimer = null
  if (!state.visible) return
  state.visible = false
  send(win, false)
  log('shortcut_hint.hidden', { windowId: win.id, reason })
}

export function isShortcutHintVisible(win: NemoWindow): boolean {
  return states.get(win)?.visible === true
}

/** `before-input-event` から呼ぶ。Meta 以外は無視。 */
export function shortcutHintInput(win: NemoWindow, input: Input): void {
  if (input.key !== 'Meta') return
  if (input.type === 'keyDown') shortcutHintDown(win)
  else if (input.type === 'keyUp') shortcutHintHide(win, 'keyup')
}

/**
 * WebContents に張る。フォーカスが**移ってきた**ときも消す
 * （keyUp の届き先が変わった＝取りこぼす前提で、動いたら消す）。
 *
 * ウィンドウは**毎回引く**（`resolve`）。タブは `moveTabToWindow` で別ウィンドウへ移るので、
 * 張ったときのウィンドウを固定すると移送後のバッジが旧ウィンドウ側に出る。
 */
export function attachShortcutHint(resolve: () => NemoWindow, wc: WebContents): void {
  wc.on('before-input-event', (_event, input) => shortcutHintInput(resolve(), input))
  wc.on('focus', () => shortcutHintHide(resolve(), 'focus'))
}
