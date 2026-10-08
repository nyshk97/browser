import { app, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type { KyprInlineState, KyprSummary } from '../../shared/types.js'
import { log } from '../log.js'
import { findTabByWebContents, type NemoTab, type NemoWindow } from '../registry.js'
import { agentFillRefusal, agentUserAtWindow, isAgentContents } from '../agent/contents.js'
import type { KyprUnlockResult } from '../../shared/types.js'
import {
  kyprCardSummaries,
  kyprMatches,
  kyprState,
  syncKyprIfStale,
  unlockKyprWithTouchId,
  withKyprFavicons
} from './index.js'
import { kyprActiveFrame, kyprFrameGroupHasCard } from './card-fill.js'

/**
 * kypr: ログイン欄の下に出す候補（オーバーレイの `kypr-inline`）。
 *
 * ページの preload（`src/preload/kypr-page.ts`）が「ユーザーの操作でログイン欄にフォーカスした」と
 * 欄の位置を知らせてくる。**メインフレームからの知らせだけ**受ける。候補はページの外の Nemo の View に出すので、
 * ページからは見えず、重ねて押させることもできない。
 *
 * **カード**（plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`）:
 * - メインフレームのカードの欄: ログイン欄と同じく preload が知らせる（`kind: 'card'`）。候補はカード全部
 * - iframe（Stripe 等）の中の欄: preload は iframe に届かず、iframe の中のクリックも親に届かないので、
 *   **main の `before-mouse-event`（クリック）・`before-input-event`（Tab）**を起点に、メインフレームでフォーカスのある
 *   iframe を見る。クリックは**メインフレームの文書に届かなかった**（= iframe の中を押した）ときだけ数える
 *   （preload が trusted な pointerdown を `pointer` で知らせる。ページが `iframe.focus()` を呼んだだけでは出さない）。
 *   組に番号の欄があれば iframe の下に出す。中を覗くのは解除済みでカードが 1 件以上あるときだけ
 */

type Mode = 'login' | 'card' | 'card-frame'

interface Shown {
  win: NemoWindow
  tabKey: string
  /** 出した時点のメインフレームの URL（候補の照合に使った URL）。 */
  url: string
  mode: Mode
  /** `card-frame` のとき、出した iframe（document・何番目の iframe・src）。 */
  frame: string | null
  /** 欄（`card-frame` は iframe）の位置。解除の後に同じ場所へ出し直すのに使う。 */
  field: FieldRect
  state: KyprInlineState
}

let shown: Shown | null = null
/**
 * 候補の「ロックを解除」から Touch ID を出している間。**この間は blur で閉じない**: ダイアログが key を取ると
 * ページも候補の View もフォーカスを失い、閉じるとページへ `webContents.focus()` が走って Nemo が前面を取り返し、
 * ダイアログが指を受けなくなる（クリックし直すまで解除できなかった。2026-10-08）
 */
let unlocking = false
/**
 * タブごとの欄の知らせの通し番号（focus / blur / hide のたびに進める）。Claude のウィンドウでは候補を出す前に
 * 非同期の判定を待つので、その間に欄から外れていたら（番号が進んでいたら）出さない
 */
const fieldSeq = new WeakMap<NemoTab, number>()
let blurTimer: ReturnType<typeof setTimeout> | null = null
/** `card-frame` の候補を出している間だけ回す見張り（タブの切り替え・遷移で閉じる。iframe からは何も届かない）。 */
let frameWatch: ReturnType<typeof setInterval> | null = null
/** iframe の組を覗いた結果（同じ iframe でクリックのたびに CDP で付かない）。キーは document・位置・src。 */
const frameCache = new Map<string, { card: boolean; at: number }>()
/**
 * タブごとのクリック・Tab の通し番号（`fieldSeq` とは分ける。iframe に移ると preload から `blur` が来るので、
 * 同じ番号だとその知らせで iframe の判定が捨てられる）
 */
const frameSeq = new WeakMap<NemoTab, number>()
/** メインフレームの文書にクリックが届いた時刻（preload の trusted な pointerdown。iframe の中のクリックでは届かない）。 */
const mainPointerAt = new WeakMap<NemoTab, number>()
/**
 * preload の知らせは `before-mouse-event` より後に届く（ページがクリックを受けてから送る）。時計の誤差の分だけ前も数える。
 * 直前にメインフレームを押していても、それより前の知らせは数えない（続けて iframe を押したときに出なくなる）
 */
const MAIN_POINTER_SLACK_MS = 30
const FRAME_CACHE_HIT_MS = 5 * 60_000
/** 番号の欄が無かった結果は短く覚える（Stripe の iframe は中身が遅れて入る）。 */
const FRAME_CACHE_MISS_MS = 3_000
/** クリック・Tab からフォーカスが iframe に移るのを待つ時間。 */
const FRAME_FOCUS_DELAY_MS = 120

/** 候補の View の大きさ（行数で変わる）。 */
const ROW_HEIGHT = 44
const MAX_ROWS = 5
const WIDTH = 320

export function kyprInlineState(win: NemoWindow): KyprInlineState | null {
  return shown && shown.win === win ? shown.state : null
}

/** 出している候補の対象（選んだときに、同じタブ・同じページか確かめる）。 */
export function kyprInlineTarget(
  win: NemoWindow
): { tabKey: string; url: string; mode: Mode; frame: string | null } | null {
  return shown && shown.win === win
    ? { tabKey: shown.tabKey, url: shown.url, mode: shown.mode, frame: shown.frame }
    : null
}

/** iframe の候補の識別子（document・何番目の iframe・src）。選ぶときに、出したときと同じ iframe か比べる。 */
export function kyprFrameKey(active: { doc: string; index: number; src: string }): string {
  return `${active.doc}|${active.index}|${active.src}`
}

/**
 * 候補から選んだ時刻（タブごと）。選ぶと候補の View が閉じてページへフォーカスが戻り、直前のクリックがまだ新しいので、
 * 同じ欄へのフォーカスでまた候補が出てしまう。選んでからしばらくは、押し直していなければその知らせで出し直さない
 */
const pickedAt = new WeakMap<NemoTab, number>()
const AFTER_PICK_MS = 1500

/** 候補から選んだ（`nemo:kypr-inline-pick`）。閉じる前に呼ぶ。 */
export function noteKyprInlinePick(win: NemoWindow): void {
  const tab = shown && shown.win === win ? win.findTab(shown.tabKey) : null
  if (tab) pickedAt.set(tab, Date.now())
}

export function hideKyprInline(win?: NemoWindow): void {
  if (!shown || (win && shown.win !== win)) return
  const target = shown.win
  shown = null
  if (blurTimer) clearTimeout(blurTimer)
  blurTimer = null
  if (frameWatch) clearInterval(frameWatch)
  frameWatch = null
  target.kyprAnchor = null
  // ページへフォーカスを戻すのは窓が key のときだけ（`webContents.focus()` は Nemo を前面に戻すので、
  // Touch ID のダイアログや他のアプリからフォーカスを奪う）
  if (!target.isDestroyed && target.overlay === 'kypr-inline')
    target.setOverlay(null, { refocus: target.baseWindow.isFocused() })
}

/**
 * 候補の「kypr のロックを解除」（Touch ID）。通ったら**同じ欄の下に候補を出し直す**
 * （閉じるだけだと、フォーカスが欄に残ったままなので欄を押し直しても focus が来ず、候補が出ない）。
 * 通らなければ候補はそのまま（呼び出し側がポップアップへ回す）
 */
export async function unlockFromKyprInline(win: NemoWindow): Promise<KyprUnlockResult> {
  if (unlocking) return { ok: false, reason: 'touch-id-failed' }
  unlocking = true
  let result: KyprUnlockResult
  try {
    result = await unlockKyprWithTouchId()
  } finally {
    unlocking = false
  }
  if (result.ok) refreshKyprInline(win)
  return result
}

/** 出している候補を、いまの kypr の状態で出し直す（同じタブ・同じページのときだけ。違えば閉じる）。 */
function refreshKyprInline(win: NemoWindow): void {
  if (!shown || shown.win !== win || win.isDestroyed) return
  const tab = win.findTab(shown.tabKey)
  const wc = tab?.webContents
  if (!tab || !wc || wc.isDestroyed() || wc.getURL() !== shown.url || win.getForegroundTab() !== tab) {
    hideKyprInline(win)
    return
  }
  show(win, tab, wc, shown.field, shown.mode, shown.frame)
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
  if (msg['type'] === 'pointer') {
    mainPointerAt.set(tab, Date.now())
    return
  }
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
      if (unlocking) return
      if (!win.isDestroyed && win.overlayWebContents.isFocused()) return
      hideKyprInline(win)
    }, 200)
    return
  }
  if (msg['type'] !== 'focus') return
  // 選んだ後にページへフォーカスが戻っただけ（選んだ後に押し直していない）なら出し直さない
  const picked = pickedAt.get(tab) ?? 0
  if (Date.now() - picked < AFTER_PICK_MS && (mainPointerAt.get(tab) ?? 0) < picked) return

  const rect = msg['rect'] as Record<string, unknown> | undefined
  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(rect?.[k]))
  if (nums.some((n) => !Number.isFinite(n))) return
  const [x, y, , height] = nums as [number, number, number, number]

  const mode: Mode = msg['kind'] === 'card' ? 'card' : 'login'
  if (!isAgentContents(wc)) {
    show(win, tab, wc, { x, y, height }, mode)
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
    if (!win.isDestroyed && !wc.isDestroyed() && agentUserAtWindow(wc))
      show(win, tab, wc, { x, y, height }, mode)
  })
}

/** 欄（`card-frame` は iframe）の位置。ページの CSS px。 */
interface FieldRect {
  x: number
  y: number
  height: number
}

function show(
  win: NemoWindow,
  tab: NemoTab,
  wc: WebContents,
  { x, y, height }: FieldRect,
  mode: Mode,
  frame: string | null = null
): void {
  // 前面のタブでなければ出さない（裏のタブ・分割の相方から来たものは無視する）
  if (win.getForegroundTab() !== tab || (win.overlay !== null && win.overlay !== 'kypr-inline')) return
  // 前の欄の blur で始めた「閉じる」を止める（メインフレームの欄から iframe へ移ると、出したばかりの候補が消える）
  if (blurTimer) clearTimeout(blurTimer)
  blurTimer = null

  const state = kyprState()
  if (state === 'disabled' || state === 'signed-out') return
  // iframe の中はロック中だと覗けない（`card-frame` は解除済みのときだけ来る）
  if (mode === 'card-frame' && state !== 'unlocked') return
  const url = wc.getURL()
  // Claude のウィンドウの iframe の中は入れない（伏せ字が効かない）。候補の代わりに案内の 1 行を出す
  const notice = mode === 'card-frame' && isAgentContents(wc) ? ('agent-iframe' as const) : null
  const all: KyprSummary[] =
    state !== 'unlocked' || notice ? [] : mode === 'login' ? kyprMatches(url) : kyprCardSummaries()
  const rows = all.slice(0, MAX_ROWS)
  // 合うログイン・カードが無ければ出さない（ロック中は「解除」の 1 行を出す）
  if (state === 'unlocked' && rows.length === 0 && !notice) {
    hideKyprInline(win)
    return
  }
  if (state === 'unlocked') syncKyprIfStale()

  const view = tab.view?.getBounds()
  if (!view) return
  const zoom = wc.getZoomFactor() || 1
  // 案内は 2 行分の高さ（文が長い）
  const lines = notice ? 2 : state === 'unlocked' ? rows.length : 1
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
    mode,
    frame,
    field: { x, y, height },
    state: {
      locked: state !== 'unlocked',
      kind: mode === 'login' ? 'login' : 'card',
      notice,
      rows: withKyprFavicons(rows),
      shownAt: Date.now()
    }
  }
  win.kyprAnchor = anchor
  if (frameWatch) clearInterval(frameWatch)
  frameWatch = null
  if (mode === 'card-frame') {
    // iframe の中のフォーカスの移り・タブの切り替えは何も届かないので、出している間だけ見張る
    frameWatch = setInterval(() => {
      if (!shown || shown.mode !== 'card-frame') return
      if (win.isDestroyed || wc.isDestroyed() || win.getForegroundTab() !== tab || wc.getURL() !== url)
        hideKyprInline(win)
    }, 400)
  }
  log('kypr.inline_show', { rows: rows.length, locked: state !== 'unlocked', mode, notice })
  if (win.overlay === 'kypr-inline') {
    win.layout()
    win.overlayWebContents.send('nemo:kypr-inline')
  } else {
    win.setOverlay('kypr-inline')
  }
}

/* ---------------- iframe の中のカードの欄 ---------------- */

function onInput(
  wc: WebContents,
  input: { type: 'mouseDown'; x: number; y: number } | { type: 'keyDown'; key: string }
): void {
  const isClick = input.type === 'mouseDown'
  const key = input.type === 'keyDown' ? input.key : ''
  if (!isClick && key !== 'Tab' && key !== 'Escape') return
  const found = findTabByWebContents(wc)
  if (!found) return
  const { win, tab } = found
  const showingFrame = shown?.mode === 'card-frame' && shown.tabKey === tab.key ? shown : null
  if (key === 'Escape') {
    if (showingFrame) hideKyprInline(win)
    return
  }
  if (kyprState() !== 'unlocked' || kyprCardSummaries().length === 0) {
    if (showingFrame) hideKyprInline(win)
    return
  }
  // Claude のウィンドウ: ユーザーが操作しているとき（key）だけ（Claude の CDP のクリックで出さない）
  if (!agentUserAtWindow(wc)) return
  const seq = (frameSeq.get(tab) ?? 0) + 1
  frameSeq.set(tab, seq)
  const at = Date.now()
  setTimeout(() => {
    void onFrameFocus(win, tab, wc, seq, isClick ? at : null)
  }, FRAME_FOCUS_DELAY_MS)
}

async function onFrameFocus(
  win: NemoWindow,
  tab: NemoTab,
  wc: WebContents,
  seq: number,
  clickAt: number | null
): Promise<void> {
  if (win.isDestroyed || wc.isDestroyed() || frameSeq.get(tab) !== seq) return
  const showingFrame = (): boolean => shown?.mode === 'card-frame' && shown.tabKey === tab.key
  // クリックがメインフレームの文書に届いた（iframe の外を押した）。ページがそのクリックで iframe.focus() を
  // 呼んでいても出さない
  if (clickAt !== null && (mainPointerAt.get(tab) ?? 0) >= clickAt - MAIN_POINTER_SLACK_MS) {
    if (showingFrame()) hideKyprInline(win)
    return
  }
  const active = await kyprActiveFrame(wc)
  // フォーカスが iframe に無い
  if (!active) {
    if (showingFrame()) hideKyprInline(win)
    return
  }
  const frameKey = kyprFrameKey(active)
  if (showingFrame() && shown?.frame === frameKey) return
  if (win.getForegroundTab() !== tab) return
  const cached = frameCache.get(frameKey)
  const fresh =
    cached && Date.now() - cached.at < (cached.card ? FRAME_CACHE_HIT_MS : FRAME_CACHE_MISS_MS)
      ? cached
      : null
  const card = fresh ? fresh.card : await kyprFrameGroupHasCard(wc)
  if (!fresh) {
    if (frameCache.size > 200) frameCache.clear()
    frameCache.set(frameKey, { card, at: Date.now() })
  }
  if (frameSeq.get(tab) !== seq || win.isDestroyed || wc.isDestroyed()) return
  if (!card) {
    if (showingFrame()) hideKyprInline(win)
    return
  }
  if (!agentUserAtWindow(wc)) return
  show(
    win,
    tab,
    wc,
    { x: active.rect.x, y: active.rect.y, height: active.rect.height },
    'card-frame',
    frameKey
  )
}

export function installKyprInline(): void {
  ipcMain.on('nemo:kypr-field', onField)
  // iframe の中のカードの欄（`onInput`）。タブかどうかはイベントのときに引く（UI の View は素通りする）。
  // **クリックは `before-mouse-event`**: `input-event` は別プロセスの iframe（OOPIF）の中のクリックでは飛ばない
  // （2026-10-04 に実測。メインフレームのクリックでは飛ぶ）。キーは `before-input-event`（iframe の中でも飛ぶ）
  app.on('web-contents-created', (_event, contents) => {
    contents.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type === 'mouseDown') onInput(contents, { type: 'mouseDown', x: mouse.x, y: mouse.y })
    })
    contents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'Tab' || input.key === 'Escape'))
        onInput(contents, { type: 'keyDown', key: input.key })
    })
  })
}
