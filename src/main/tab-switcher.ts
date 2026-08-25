import type { Input, WebContents } from 'electron'
import { holdModifiersFor, resolveKeybindings } from '../shared/keybindings.js'
import { log } from './log.js'
import {
  selectTab,
  setOverlayChangeListener,
  tabDisplayName,
  type NemoTab,
  type NemoWindow
} from './registry.js'
import { getSettings } from './store/settings.js'
import type { SwitcherState } from '../shared/types.js'

/**
 * 直近に使ったタブを ⌃M で辿る（TabTrace 拡張と同じ操作感）。
 *
 * - ⌃M を押すと直近のタブをハイライトした帯が出る
 * - ⌃ を押したまま ⌃M を繰り返すと MRU 順に1つずつ進み、末尾で先頭へ戻る
 * - **⌃ を離した瞬間に確定**する。Esc で取消、カードのクリックで直接そこへ
 *
 * 「押しっぱなし」を成立させるために、`before-input-event` で修飾キーの keyUp を拾う。
 * メニューのアクセラレータでは押し下げしか取れないため、ここだけ別経路になる。
 */

/** 帯に並べるタブの数。TabTrace と同じ 5 件に揃える。 */
const MRU_LIMIT = 5
/**
 * 修飾キーを持たない割り当て（`F5` など）のときに、押すのをやめたと見なすまでの時間。
 *
 * **修飾キーがある通常の割り当てでは時間で確定しない**。押しっぱなしの最中に
 * 時間切れで勝手に切り替わるのは「離した瞬間に確定」と食い違う（選んでいる途中で
 * 目的地が変わってしまう）。keyUp を取り逃す条件はウィンドウの blur で捕まえる。
 */
const FALLBACK_COMMIT_MS = 1500

interface SwitchSession {
  /** 押し始めた時点の MRU 順スナップショット。**途中で並べ替えない**。 */
  keys: string[]
  index: number
  /** 離したら確定する修飾キー（`KeyboardEvent.key`）。空なら時間で確定する。 */
  hold: string[]
  detach: (() => void)[]
  timer: NodeJS.Timeout | null
}

const sessions = new Map<number, SwitchSession>()

/** オーバーレイが横取りされたら畳む（ダイアログの割り込みなど）。 */
export function installTabSwitcher(): void {
  setOverlayChangeListener((win, kind) => {
    if (kind !== 'tab-switcher') cancelSwitcher(win)
  })
}

/**
 * MRU 順のタブ。
 *
 * **アクティブタブを先頭に固定し、残りを `lastActiveAt` の新しい順**に並べる。
 * 別の配列を持たずタブの状態から毎回導くので、タブの生成・破棄・ウィンドウ間の
 * 移動で並びが壊れない。背景で開いたタブは `lastActiveAt` が「今」になるが、
 * アクティブタブを先頭に固定してあるので 2 番目に入る（TabTrace と同じ位置）。
 */
function mruTabs(win: NemoWindow): NemoTab[] {
  const active = win.getActiveTab()
  // Peek は帯に並べない（サイドバーの一覧に出ないものへは飛ばさない）
  const rest = win.normalTabs.filter((tab) => tab !== active).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return (active ? [active, ...rest] : rest).slice(0, MRU_LIMIT)
}

/** 押している最中に閉じられたタブを落とし、ハイライト位置を詰める。 */
function prune(win: NemoWindow, session: SwitchSession): void {
  const alive = session.keys.filter((key) => win.findTab(key) !== null)
  if (alive.length === session.keys.length) return
  const highlighted = session.keys[session.index]
  session.keys = alive
  const moved = highlighted === undefined ? -1 : alive.indexOf(highlighted)
  session.index = moved >= 0 ? moved : 0
}

/**
 * UI へ渡す形にする。
 *
 * **必ず先に `prune` してから作る**。閉じたタブを落とした配列と、落とす前の位置を
 * 混ぜると「見えているハイライト」と「離したときの行き先」が食い違う。
 * ハイライト位置も**位置ではなく key から引き直す**ので、両者がずれようがない。
 */
function stateOf(win: NemoWindow, session: SwitchSession): SwitcherState {
  prune(win, session)
  const highlighted = session.keys[session.index]
  const tabs = session.keys
    .map((key) => win.findTab(key))
    .filter((tab): tab is NemoTab => tab !== null)
    .map((tab) => ({
      key: tab.key,
      title: tabDisplayName(tab),
      url: tab.url,
      faviconUrl: tab.faviconUrl
    }))
  return {
    tabs,
    index: Math.max(
      tabs.findIndex((tab) => tab.key === highlighted),
      0
    )
  }
}

function push(win: NemoWindow, state: SwitcherState | null): void {
  if (win.isDestroyed) return
  const contents = win.overlayWebContents
  if (!contents.isDestroyed()) contents.send('nemo:switcher', state)
}

/** 今の設定で `switch-tab` に割り当たっている「押しっぱなしの修飾キー」。 */
function holdModifiers(): string[] {
  const { bindings } = resolveKeybindings(getSettings().keybindings)
  return holdModifiersFor(bindings['switch-tab'] ?? '')
}

/**
 * 修飾キーを押しっぱなしにできない割り当てのときだけ、押すのが止まったら確定する。
 * 修飾キーがあるなら何もしない（確定は keyUp だけが決める）。
 */
function armTimer(win: NemoWindow, session: SwitchSession): void {
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  if (session.hold.length > 0) return
  session.timer = setTimeout(() => commitSwitcher(win), FALLBACK_COMMIT_MS)
}

/**
 * キーを拾う先。
 *
 * オーバーレイを出すとフォーカスはそちらへ移るが、**押した瞬間にフォーカスが
 * どこにあったかで keyUp の届き先が変わる**ので、ウィンドウ内の UI とページを
 * まとめて張る。押している間だけ張り、確定・取消で必ず外す。
 */
function attachInput(win: NemoWindow, session: SwitchSession): void {
  const targets: WebContents[] = [win.overlayWebContents, win.chromeWebContents]
  // **Peek の暗幕にも張る**。暗幕をクリックするとフォーカスがそこへ移るので、
  // 張り忘れると ⌃ の keyUp を取り逃して**帯が出たまま残る**。
  const peekChrome = win.peekChromeView
  if (peekChrome) targets.push(peekChrome.webContents)
  // **ここは `normalTabs` に絞らない**。全 WebContents への入力監視なので、
  // Peek にフォーカスがあるときの keyUp / Esc も拾う必要がある。
  // 絞ると「Peek を見ている最中に ⌃M を離しても確定しない」で壊れる。
  for (const tab of win.tabs) {
    const wc = tab.webContents
    if (wc) targets.push(wc)
  }
  for (const wc of targets) {
    if (wc.isDestroyed()) continue
    const handler = (event: Electron.Event, input: Input): void => onInput(win, event, input)
    wc.on('before-input-event', handler)
    session.detach.push(() => {
      if (!wc.isDestroyed()) wc.removeListener('before-input-event', handler)
    })
  }

  // ウィンドウがフォーカスを失うと keyUp はもう届かない（⌘Tab で別アプリへ行った等）。
  // ここが**時間切れの代わりに置く後始末**で、押しっぱなしのまま帯が残るのを防ぐ。
  // 確定ではなく**取消**にする。見ていない間に勝手にタブが変わる方が困る。
  const onBlur = (): void => cancelSwitcher(win)
  win.baseWindow.on('blur', onBlur)
  session.detach.push(() => {
    if (!win.baseWindow.isDestroyed()) win.baseWindow.removeListener('blur', onBlur)
  })
}

function onInput(win: NemoWindow, event: Electron.Event, input: Input): void {
  const session = sessions.get(win.id)
  if (!session) return

  if (input.type === 'keyUp') {
    if (session.hold.includes(input.key)) commitSwitcher(win)
    return
  }
  if (input.type !== 'keyDown') return

  switch (input.key) {
    case 'Escape':
      event.preventDefault()
      cancelSwitcher(win)
      return
    case 'Enter':
      event.preventDefault()
      commitSwitcher(win)
      return
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      move(win, session, 1)
      return
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      move(win, session, -1)
      return
    default:
      return
  }
}

function move(win: NemoWindow, session: SwitchSession, delta: number): void {
  prune(win, session)
  if (session.keys.length === 0) {
    cancelSwitcher(win)
    return
  }
  session.index = (session.index + delta + session.keys.length) % session.keys.length
  push(win, stateOf(win, session))
  armTimer(win, session)
}

/**
 * ⌃M を押したとき。初回は帯を出し、2回目以降は1つ進める。
 *
 * ほかのオーバーレイ（コマンドバー・ダイアログ）が出ている間は割り込まない。
 */
export function advanceSwitcher(win: NemoWindow): void {
  if (win.isDestroyed) return

  const session = sessions.get(win.id)
  if (session) {
    move(win, session, 1)
    return
  }

  if (win.overlay !== null) return
  const tabs = mruTabs(win)
  // 1枚しか無いなら辿る先がない
  if (tabs.length < 2) return

  const next: SwitchSession = {
    keys: tabs.map((tab) => tab.key),
    // 押した時点で「直前のタブ」を指す（⌘Tab と同じ。1回押して離せば行き来できる）
    index: 1,
    hold: holdModifiers(),
    detach: [],
    timer: null
  }
  sessions.set(win.id, next)
  attachInput(win, next)
  push(win, stateOf(win, next))
  win.setOverlay('tab-switcher')
  armTimer(win, next)
  log('switcher.start', { windowId: win.id, tabs: next.keys.length, hold: next.hold.join('+') })
}

/**
 * カードのクリック。
 *
 * **位置（index）ではなくタブの key で受ける**。押している最中にタブが閉じると
 * main 側の並びだけが詰まり、UI が持っている位置は古いままになる。位置で受けると
 * その1件ぶんずれて**別のタブへ飛ぶ**（[A,B,C] の A が消えた後に B を押すと C に行く）。
 */
export function pickSwitcherTab(win: NemoWindow, key: string): void {
  const session = sessions.get(win.id)
  if (!session) return
  prune(win, session)
  const index = session.keys.indexOf(key)
  // 押した瞬間に閉じられていたら何もしない（勝手に別のタブへ飛ばさない）
  if (index === -1) return
  session.index = index
  commitSwitcher(win)
}

/** ハイライトしているタブへ移る。 */
export function commitSwitcher(win: NemoWindow): void {
  const session = sessions.get(win.id)
  if (!session) return
  prune(win, session)
  const key = session.keys[session.index]
  const index = session.index
  finish(win, session)
  // 先にタブを選んでから畳む。順番を逆にすると、閉じるときのフォーカス復帰が
  // **切り替える前のタブ**に入ってしまう。
  if (key !== undefined && win.findTab(key)) selectTab(win, key)
  closeOverlay(win)
  log('switcher.commit', { windowId: win.id, index })
}

/** 切り替えずに畳む。 */
export function cancelSwitcher(win: NemoWindow): void {
  const session = sessions.get(win.id)
  if (!session) return
  finish(win, session)
  closeOverlay(win)
}

function closeOverlay(win: NemoWindow): void {
  if (win.isDestroyed) return
  if (win.overlay === 'tab-switcher') win.setOverlay(null)
}

function finish(win: NemoWindow, session: SwitchSession): void {
  // 先に登録を外す。`setOverlay` から戻ってくる通知で再入しないようにする。
  sessions.delete(win.id)
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  for (const off of session.detach) off()
  session.detach.length = 0
  push(win, null)
}

/**
 * 購読より前に開いた場合に、オーバーレイが自分から取りに来るためのもの。
 * 押している最中に読み直されることがあるので、`stateOf` の中で必ず prune される。
 */
export function currentSwitcherState(win: NemoWindow): SwitcherState | null {
  const session = sessions.get(win.id)
  return session ? stateOf(win, session) : null
}
