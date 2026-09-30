import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type { KyprInlineState } from '../../shared/types.js'
import { log } from '../log.js'
import { findTabByWebContents, type NemoTab, type NemoWindow } from '../registry.js'
import { agentFillRefusal, agentUserAtWindow, isAgentContents } from '../agent/contents.js'
import { kyprMatches, kyprState, syncKyprIfStale, withKyprFavicons } from './index.js'

/**
 * kypr: ログイン欄の下に出す候補（オーバーレイの `kypr-inline`）。
 *
 * ページの preload（`src/preload/kypr-page.ts`）が「ユーザーの操作でログイン欄にフォーカスした」と
 * 欄の位置を知らせてくる。**メインフレームからの知らせだけ**受ける。候補はページの外の Nemo の View に出すので、
 * ページからは見えず、重ねて押させることもできない。
 */

interface Shown {
  win: NemoWindow
  tabKey: string
  /** 出した時点のメインフレームの URL（候補の照合に使った URL）。 */
  url: string
  state: KyprInlineState
}

let shown: Shown | null = null
/**
 * タブごとの欄の知らせの通し番号（focus / blur / hide のたびに進める）。Claude のウィンドウでは候補を出す前に
 * 非同期の判定を待つので、その間に欄から外れていたら（番号が進んでいたら）出さない
 */
const fieldSeq = new WeakMap<NemoTab, number>()
let blurTimer: ReturnType<typeof setTimeout> | null = null

/** 候補の View の大きさ（行数で変わる）。 */
const ROW_HEIGHT = 44
const MAX_ROWS = 5
const WIDTH = 320

export function kyprInlineState(win: NemoWindow): KyprInlineState | null {
  return shown && shown.win === win ? shown.state : null
}

/** 出している候補の対象（選んだときに、同じタブ・同じページか確かめる）。 */
export function kyprInlineTarget(win: NemoWindow): { tabKey: string; url: string } | null {
  return shown && shown.win === win ? { tabKey: shown.tabKey, url: shown.url } : null
}

export function hideKyprInline(win?: NemoWindow): void {
  if (!shown || (win && shown.win !== win)) return
  const target = shown.win
  shown = null
  if (blurTimer) clearTimeout(blurTimer)
  blurTimer = null
  target.kyprAnchor = null
  if (!target.isDestroyed && target.overlay === 'kypr-inline') target.setOverlay(null)
}

function onField(event: IpcMainEvent, message: unknown): void {
  const wc = event.sender
  // メインフレームからの知らせだけ（preload はメインフレームにしか配っていないが、念のため）
  if (event.senderFrame !== wc.mainFrame) return
  if (typeof message !== 'object' || message === null) return
  const msg = message as Record<string, unknown>
  const found = findTabByWebContents(wc)
  if (!found) return
  const { win, tab } = found
  const seq = (fieldSeq.get(tab) ?? 0) + 1
  fieldSeq.set(tab, seq)

  if (msg['type'] === 'hide') {
    if (shown?.tabKey === tab.key) hideKyprInline(win)
    return
  }
  if (msg['type'] === 'blur') {
    if (shown?.tabKey !== tab.key) return
    // 候補を押したときもページの欄はフォーカスを失う。少し待って、フォーカスが候補の View に移っていたら閉じない
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      blurTimer = null
      if (!shown || shown.tabKey !== tab.key) return
      if (!win.isDestroyed && win.overlayWebContents.isFocused()) return
      hideKyprInline(win)
    }, 200)
    return
  }
  if (msg['type'] !== 'focus') return

  const rect = msg['rect'] as Record<string, unknown> | undefined
  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(rect?.[k]))
  if (nums.some((n) => !Number.isFinite(n))) return
  const [x, y, , height] = nums as [number, number, number, number]

  if (!isAgentContents(wc)) {
    show(win, tab, wc, x, y, height)
    return
  }
  // Claude のウィンドウ: **窓が key のとき**（ユーザーが操作している）だけ出す。Claude の CDP のクリックでも
  // trusted な pointerdown になるので、key を見ないと Claude の操作で候補が出る。
  // Claude が JS を実行したページでも出さない（選んでも入れないので）
  if (!agentUserAtWindow(wc)) return
  void agentFillRefusal(wc).then((refused) => {
    if (refused) {
      log('kypr.inline_skipped', { reason: refused })
      return
    }
    if (fieldSeq.get(tab) !== seq) return
    if (!win.isDestroyed && !wc.isDestroyed() && agentUserAtWindow(wc)) show(win, tab, wc, x, y, height)
  })
}

function show(win: NemoWindow, tab: NemoTab, wc: WebContents, x: number, y: number, height: number): void {
  // 前面のタブでなければ出さない（裏のタブ・分割の相方から来たものは無視する）
  if (win.getForegroundTab() !== tab || (win.overlay !== null && win.overlay !== 'kypr-inline')) return

  const state = kyprState()
  if (state === 'disabled' || state === 'signed-out') return
  const url = wc.getURL()
  const rows = state === 'unlocked' ? kyprMatches(url).slice(0, MAX_ROWS) : []
  // 合うログインが無ければ出さない（ロック中は「解除」の 1 行を出す）
  if (state === 'unlocked' && rows.length === 0) {
    hideKyprInline(win)
    return
  }
  if (state === 'unlocked') syncKyprIfStale()

  const view = tab.view?.getBounds()
  if (!view) return
  const zoom = wc.getZoomFactor() || 1
  const lines = state === 'unlocked' ? rows.length : 1
  const anchor = {
    x: Math.round(view.x + x * zoom),
    y: Math.round(view.y + (y + height) * zoom + 2),
    width: WIDTH,
    height: lines * ROW_HEIGHT + 8
  }
  // 画面の下にはみ出すなら欄の上に出す
  const content = win.contentSize()
  if (anchor.y + anchor.height > content.height - 8) {
    anchor.y = Math.max(Math.round(view.y + y * zoom - anchor.height - 2), 0)
  }
  anchor.x = Math.min(Math.max(anchor.x, 0), Math.max(content.width - WIDTH - 8, 0))

  shown = {
    win,
    tabKey: tab.key,
    url,
    state: { locked: state !== 'unlocked', rows: withKyprFavicons(rows), shownAt: Date.now() }
  }
  win.kyprAnchor = anchor
  log('kypr.inline_show', { rows: rows.length, locked: state !== 'unlocked' })
  if (win.overlay === 'kypr-inline') {
    win.layout()
    win.overlayWebContents.send('nemo:kypr-inline')
  } else {
    win.setOverlay('kypr-inline')
  }
}

export function installKyprInline(): void {
  ipcMain.on('nemo:kypr-field', onField)
}
