import { app } from 'electron'
import { log, logError } from './log.js'
import { selectTab, setCallWatcher, windowsById, type NemoTab } from './registry.js'
import {
  PROBE_SOURCE,
  buildToggleSource,
  isMeetUrl,
  meetDisplayHost,
  parseProbe,
  type CallProbe
} from './meet-adapter.js'
import {
  currentCallState,
  destroyCallWindow,
  ensureCallWindow,
  hasCallWindow,
  hideCallWindow,
  pushCallState,
  showCallWindow
} from './call-window.js'
import type { CallState } from '../shared/types.js'

/**
 * 会議の小窓の状態機械。
 *
 * ## 候補は「タブごと」に持つ（計画 R10）
 *
 * 小窓はアプリ全体で1枚だが、**1件だけ持つ設計にしてはいけない**。
 * 「`lastActiveAt` が最大のものを選ぶ」にはどのタブが参加中かを知っている必要があり、
 * 対象1件しかプローブしないと
 * **「直近の Meet は未参加、古い Meet が参加中」で参加中の会議を見失う**。
 *
 * ## プローブの頻度
 *
 * Meet は待機画面から会議へ**同じ URL・同じ document のまま**移るので、
 * ナビゲーションイベントでは参加の開始を拾えない（計画 R9）。
 * 入口はプローブしか無いので、Meet のタブがある間だけ低頻度で回す。
 *
 * | 状態 | 頻度 |
 * |---|---|
 * | Meet のタブが1つも無い | 走らせない |
 * | Meet のタブはあるが参加していない | 5 秒 |
 * | 参加中 | 2 秒 |
 *
 * 実測 0.035ms/回 なので、参加中でも CPU 0.0018%（測定限界以下）。
 */

/** 隔離ワールドの ID（スワイプ判定の 1729 とは別にする）。 */
const CALL_WORLD_ID = 1730
/** 見回りの間隔。実際にプローブを撃つかは候補ごとの間隔で決める。 */
const TICK_MS = 500
const PROBE_INTERVAL_JOINED = 2000
const PROBE_INTERVAL_CANDIDATE = 5000

/**
 * 候補タブの状態。
 *
 * `state` の意味:
 * - `candidate` … Meet のページだが**参加していない**（待機画面）
 * - `joined` … 参加中
 * - `unknown` … **プローブが読めなかった**（縮退）。作りたてはここに入れない
 *   （入れると、最初のプローブが返るまでの数百 ms だけ縮退バーが出る）
 */
interface CandidateState {
  tab: NemoTab
  /**
   * 世代。**タブが遷移する / 候補から外れて入り直すたびに新しい値**を採る。
   * プローブの往復中に対象が変わったとき、古い応答を捨てるために照合する。
   * 0 から数え直すと「外れて入り直したタブ」で衝突するので、全体で単調増加させる。
   */
  generation: number
  /** プローブが走っているか（**single-flight**。同じタブへ同時に2本投げない）。 */
  inFlight: boolean
  state: 'candidate' | 'joined' | 'unknown'
  /**
   * 参加を検知した時刻（経過時間の基点）。
   *
   * **`unknown` の間は消さない**。消すと `joined → unknown → joined` の
   * 一時的な失敗から復帰したときに、同じ会議なのに経過時間が 0 へ戻る
   * （DOM の読み込み途中で普通に起きる）。UI へ出すときだけ `null` にマスクする。
   */
  joinedAt: number | null
  micEnabled: boolean | null
  camEnabled: boolean | null
  /** 一度でもアクティブになったか（縮退時の誤爆よけ。計画 R5）。 */
  everActive: boolean
  /** 候補に入れた時点の URL。変わったら世代を上げて状態を捨てる。 */
  url: string
  lastProbeAt: number
  /** 背面スロットリングを外してあるか（下の `syncBackgroundThrottling` を見る）。 */
  throttlingDisabled: boolean
}

const candidates = new Map<string, CandidateState>()
/** 世代の採番。**全体で単調増加**させる（0 から数え直さない）。 */
let nextGeneration = 1
let timer: NodeJS.Timeout | null = null
let started = false

/* ------------------------------------------------------------------ *
 * 述語
 * ------------------------------------------------------------------ */

/**
 * そのタブが「見えている」か。
 *
 * **フォーカスも見る**。他アプリで作業している間は、Nemo 側で会議タブを
 * 選んでいても「見えていない」（この機能はそのための機能なので）。
 */
function tabOnScreen(tab: NemoTab): boolean {
  const win = tab.window
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return false
  if (!win.baseWindow.isVisible() || win.baseWindow.isMinimized()) return false
  if (!win.baseWindow.isFocused()) return false
  return tab.view?.getVisible() === true
}

/**
 * 表示してよい候補か。**sleep / 自動アーカイブの除外条件も同じ**（計画 R3）。
 *
 * **`joined` だけに絞らない**。プローブが読めない（縮退）タブも、
 * URL が Meet なら「会議へ移動するボタンだけの小窓」を出す。
 *
 * 縮退（`unknown`）を通す条件が2つあるのが肝。
 * - `everActive` … 一度アクティブになったタブ（復元直後の誤爆よけ。計画 R5）
 * - `joinedAt !== null` … **参加中だと観測したあとでプローブが読めなくなった**タブ。
 *   ここを落とすと「プローブが一時的に読めなくなった直後に会議タブが寝る」
 *   （＝通話が切れる）。自走検証で実際に踏んだので、`everActive` だけにしない
 *
 * **「ユーザーが閉じたか」は持たない**。✕ を置いていないので閉じる操作が無い
 * （会議中はいつでも出ている、が仕様）。
 */
function isShowable(candidate: CandidateState): boolean {
  if (candidate.state === 'joined') return true
  if (candidate.state !== 'unknown') return false
  return candidate.everActive || candidate.joinedAt !== null
}

/**
 * 会議中のタブだけ**背面スロットリングを外す**。
 *
 * Chromium は隠れたページで `requestAnimationFrame` を止める。Meet は
 * ボタンを押した結果の反映を rAF 越しに行うので、素のままだと
 * **小窓からミュートを押しても、会議タブを前面に戻すまで実際には切り替わらない**
 * （押した本人は「効いていない」と思って何度も押すことになる）。実測:
 *
 * ```
 * 背面でクリック 3 秒後  vis=hidden  raf=1    clicks=1  muted=false  ← 効いていない
 * 前面へ戻したあと       vis=visible raf=74   clicks=1  muted=true   ← ここで初めて適用
 * ```
 *
 * 外すのは**会議中の対象タブだけ・会議中だけ**にする。
 * 増えるのは CPU だけで、通信量もメモリも増えない。会議が終われば元に戻す。
 */
function syncBackgroundThrottling(candidate: CandidateState): void {
  const wanted = isShowable(candidate)
  if (wanted === candidate.throttlingDisabled) return
  const wc = candidate.tab.webContents
  if (!wc) return
  wc.setBackgroundThrottling(!wanted)
  candidate.throttlingDisabled = wanted
  log('call.background_throttling', { key: candidate.tab.key, throttled: !wanted })
}

/** 候補から外れる / 会議が終わったタブのスロットリングを戻す。 */
function restoreBackgroundThrottling(candidate: CandidateState): void {
  if (!candidate.throttlingDisabled) return
  candidate.throttlingDisabled = false
  const wc = candidate.tab.webContents
  if (!wc) return
  wc.setBackgroundThrottling(true)
  log('call.background_throttling', { key: candidate.tab.key, throttled: true })
}

/** 表示対象（`showable` のうち `lastActiveAt` が最大のもの）。 */
function pickTarget(): CandidateState | null {
  let best: CandidateState | null = null
  for (const candidate of candidates.values()) {
    if (!isShowable(candidate)) continue
    if (best === null || candidate.tab.lastActiveAt > best.tab.lastActiveAt) best = candidate
  }
  return best
}

/* ------------------------------------------------------------------ *
 * 候補の出入り
 * ------------------------------------------------------------------ */

/** 今ある全タブ（Peek も含む。Peek で Meet を開くこともある）。 */
function allTabs(): NemoTab[] {
  const tabs: NemoTab[] = []
  for (const win of windowsById.values()) {
    if (win.isDestroyed) continue
    tabs.push(...win.tabs)
  }
  return tabs
}

/**
 * 候補と表示対象を計算し直す。**何度呼んでもよい**（冪等）。
 *
 * registry からタブの生成 / 遷移 / 破棄 / 選択 / ウィンドウのフォーカスで呼ばれる。
 */
export function refreshCallCoordinator(navigated?: NemoTab): void {
  if (!started) return

  const seen = new Set<string>()
  for (const tab of allTabs()) {
    if (!isMeetUrl(tab.url)) continue
    seen.add(tab.key)
    const existing = candidates.get(tab.key)
    if (!existing) {
      const created: CandidateState = {
        tab,
        generation: nextGeneration++,
        inFlight: false,
        state: 'candidate',
        joinedAt: null,
        micEnabled: null,
        camEnabled: null,
        everActive: false,
        url: tab.url,
        lastProbeAt: 0,
        throttlingDisabled: false
      }
      candidates.set(tab.key, created)
      log('call.candidate_added', { key: tab.key, windowId: tab.window.id })
      // 作りたては待たずに1回撃つ（次の tick を待つと参加の検知が遅れる）
      void probe(created)
    } else if (existing.url !== tab.url) {
      // 別の会議へ移った。**世代を上げて古い応答を無効化し、状態を捨てる**
      existing.generation = nextGeneration++
      existing.url = tab.url
      existing.state = 'candidate'
      existing.joinedAt = null
      existing.micEnabled = null
      existing.camEnabled = null
      existing.lastProbeAt = 0
      log('call.candidate_url_changed', { key: tab.key })
    }

    const candidate = candidates.get(tab.key)
    if (!candidate) continue
    if (tab.window.activeTabKey === tab.key) candidate.everActive = true
  }

  // Meet でなくなった / タブが破棄された候補は外す。
  // **世代は単調増加なので、外して入り直しても古い応答は照合で落ちる**
  for (const key of [...candidates.keys()]) {
    if (seen.has(key)) continue
    const removed = candidates.get(key)
    if (removed) restoreBackgroundThrottling(removed)
    candidates.delete(key)
    log('call.candidate_removed', { key })
  }

  // 今まさに document が変わったタブは、次の周期を待たずに撃ち直す。
  // Meet は待機画面から会議へ同じ document のまま移るので周期プローブが要るが、
  // **タブを開いた直後の1回**が遅いと、参加中の会議に気づくまで最大5秒かかる。
  if (navigated) {
    const candidate = candidates.get(navigated.key)
    if (candidate) {
      candidate.lastProbeAt = 0
      void probe(candidate)
    }
  }

  ensureTimer()
  applyWindow()
}

/* ------------------------------------------------------------------ *
 * プローブ
 * ------------------------------------------------------------------ */

function ensureTimer(): void {
  const needed = [...candidates.values()].some((candidate) => !candidate.tab.asleep)
  if (needed && !timer) {
    timer = setInterval(tick, TICK_MS)
    timer.unref?.()
  } else if (!needed && timer) {
    clearInterval(timer)
    timer = null
  }
}

function tick(): void {
  const now = Date.now()
  for (const candidate of candidates.values()) {
    const interval = candidate.state === 'joined' ? PROBE_INTERVAL_JOINED : PROBE_INTERVAL_CANDIDATE
    if (now - candidate.lastProbeAt < interval) continue
    void probe(candidate)
  }
}

/**
 * 1タブぶんのプローブ。**single-flight**（走っている間は撃ち足さない）。
 *
 * 停止条件は「sleep / 破棄 / Meet 以外へ遷移」。
 * `refresh()` が候補から外すので、ここでは WebContents の有無だけ見ればよい。
 */
async function probe(candidate: CandidateState): Promise<void> {
  if (candidate.inFlight) return
  const wc = candidate.tab.webContents
  if (!wc || candidate.tab.asleep) return

  candidate.inFlight = true
  candidate.lastProbeAt = Date.now()
  // 撃つ前に控える。**結果を反映する前に照合する**（ずれていたら捨てる）
  const key = candidate.tab.key
  const generation = candidate.generation

  let raw: unknown
  try {
    raw = await wc.executeJavaScriptInIsolatedWorld(CALL_WORLD_ID, [{ code: PROBE_SOURCE }])
  } catch {
    // 遷移中 / 破棄と競合した。読めなかった扱いにする
    raw = null
  }

  const live = candidates.get(key)
  if (!live) return
  live.inFlight = false
  if (live.generation !== generation) {
    log('call.probe_stale', { key, generation })
    return
  }

  applyProbe(live, parseProbe(raw))
  // 参加 / 退出が確定したこの時点で、背面スロットリングの要否も更新する
  syncBackgroundThrottling(live)
  applyWindow()
}

/** プローブの結果を候補の状態へ落とす。 */
function applyProbe(candidate: CandidateState, probed: CallProbe | null): void {
  const before = candidate.state

  if (probed === null) {
    // **一時的な失敗で縮退へ固定しない**。正常値が返れば下で復帰する。
    // `joinedAt` は**保つ**（復帰したときに経過時間を 0 へ戻さないため）
    candidate.state = 'unknown'
    candidate.micEnabled = null
    candidate.camEnabled = null
    if (before !== 'unknown') {
      log('call.probe_failed', { key: candidate.tab.key, windowId: candidate.tab.window.id })
    }
    return
  }

  if (probed.inCall) {
    candidate.state = 'joined'
    // 再参加（`inCall` が false → true）のときだけ数え直す。
    // 縮退から戻ってきただけなら保っていた時刻をそのまま使う
    if (candidate.joinedAt === null) {
      candidate.joinedAt = Date.now()
      log('call.joined', { key: candidate.tab.key, windowId: candidate.tab.window.id })
    }
    candidate.micEnabled = probed.micEnabled
    candidate.camEnabled = probed.camEnabled
    return
  }

  candidate.state = 'candidate'
  if (candidate.joinedAt !== null) log('call.left', { key: candidate.tab.key })
  candidate.joinedAt = null
  candidate.micEnabled = null
  candidate.camEnabled = null
}

/* ------------------------------------------------------------------ *
 * 小窓の出し入れ
 * ------------------------------------------------------------------ */

function buildState(candidate: CandidateState): CallState {
  const degraded = candidate.state === 'unknown'
  return {
    host: meetDisplayHost(candidate.url),
    // **縮退中は経過時間を出さない**（内部の `joinedAt` は保ったままマスクする）。
    // 戻るボタンだけの見た目なので、0:00 で止まって見える誤解も生まない
    joinedAt: degraded ? null : candidate.joinedAt,
    micEnabled: degraded ? null : candidate.micEnabled,
    camEnabled: degraded ? null : candidate.camEnabled,
    degraded
  }
}

function pushIfChanged(state: CallState): void {
  const before = currentCallState()
  if (before && JSON.stringify(before) === JSON.stringify(state)) return
  pushCallState(state)
}

/**
 * 小窓の生成 / 表示 / 非表示 / retarget / 破棄を決める。
 *
 * | 遷移 | 小窓 |
 * |---|---|
 * | 対象タブが見える → 見えない | 表示（無ければ生成） |
 * | 見えない → 見える（戻った） | **hide のみ**（破棄しない。会議中は行き来が頻繁） |
 * | 対象が `showable` から外れた・他に候補あり | **retarget**（同じ小窓のまま対象を差し替える） |
 * | **`showable` が 0 件になった** | **destroy**（89MB を返す） |
 */
function applyWindow(): void {
  const target = pickTarget()
  if (!target) {
    // **破棄の条件は「対象が終わった」ではなく「`showable` が 0 件」**。
    // 対象が終わっても別の候補が残っていれば同じ小窓を使い回す
    if (hasCallWindow()) destroyCallWindow('no_showable')
    return
  }

  const state = buildState(target)
  if (tabOnScreen(target.tab)) {
    // 破棄しない（会議中は行き来が頻繁で、毎回 89MB を作り直すと出るのが遅れる）
    if (hasCallWindow()) {
      pushIfChanged(state)
      hideCallWindow()
    }
    return
  }

  const win = target.tab.window
  const near = win.baseWindow.isDestroyed() ? null : win.baseWindow.getBounds()
  ensureCallWindow(near)
  pushIfChanged(state)
  showCallWindow()
}

/* ------------------------------------------------------------------ *
 * IPC から呼ばれる操作（引数は取らない。対象は main 側で解決する）
 * ------------------------------------------------------------------ */

export function getCallState(): CallState | null {
  return currentCallState()
}

/** 会議タブへ戻る（別ウィンドウ / 別 Space も辿る）。 */
export function focusCallTarget(): void {
  const target = pickTarget()
  if (!target) return
  const win = target.tab.window
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return
  // ここでは Space が切り替わってよい（「会議タブへ戻る」と言っている操作なので）
  if (!win.baseWindow.isVisible()) win.baseWindow.show()
  win.baseWindow.focus()
  app.focus({ steal: true })
  selectTab(win, target.tab.key)
  log('call.focus_tab', { key: target.tab.key, windowId: win.id })
  refreshCallCoordinator()
}

/**
 * マイク / カメラを切り替える。
 *
 * **楽観更新しない**（Meet 側で弾かれることがある）。押したあとは
 * 次のプローブを前倒しして、実際の結果が返ってから UI を書き換える。
 */
export async function toggleCallDevice(kind: 'mic' | 'cam'): Promise<void> {
  const target = pickTarget()
  if (!target) return
  const wc = target.tab.webContents
  if (!wc) return
  try {
    await wc.executeJavaScriptInIsolatedWorld(CALL_WORLD_ID, [{ code: buildToggleSource(kind) }], true)
    log('call.toggle', { kind, key: target.tab.key })
  } catch (error) {
    logError('call.toggle_failed', error, { kind })
    return
  }
  // 結果は push を待つ（Meet の DOM に反映されるまで少しかかる）
  target.lastProbeAt = 0
}

/* ------------------------------------------------------------------ *
 * 起動 / 終了
 * ------------------------------------------------------------------ */

export function startCallCoordinator(): void {
  if (started) return
  started = true
  setCallWatcher({
    refresh: (navigated) => refreshCallCoordinator(navigated),
    isSleepExempt: (tab) => {
      const candidate = candidates.get(tab.key)
      return candidate ? isShowable(candidate) : false
    },
    // 共有タブの二重実体化ガード用。`isShowable` より狭く「参加中」だけを見る
    // （縮退（unknown）でも `joinedAt` が残っていれば参加中の可能性があるので守る）
    isJoined: (tab) => {
      const candidate = candidates.get(tab.key)
      return candidate ? candidate.state === 'joined' || candidate.joinedAt !== null : false
    }
  })
  refreshCallCoordinator()
  log('call.coordinator_started', {})
}

export function stopCallCoordinator(): void {
  started = false
  if (timer) clearInterval(timer)
  timer = null
  for (const candidate of candidates.values()) restoreBackgroundThrottling(candidate)
  candidates.clear()
  destroyCallWindow('shutdown')
}
