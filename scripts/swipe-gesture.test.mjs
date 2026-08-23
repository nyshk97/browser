#!/usr/bin/env node
/**
 * 2本指スワイプ判定の回帰テスト。
 *
 * 見たいのは「発火すること」より **誤爆しないこと**（読んでいる最中に勝手に戻る、
 * 慣性スクロールで2ページ戻る）なので、そちら側を厚く書く。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SWIPE_CONFIG,
  buildSwipeInjection,
  createSwipeState,
  feedSwipe
} from '../src/shared/swipe-gesture.js'

const SWIPE_THRESHOLD_PX = SWIPE_CONFIG.thresholdPx
const SWIPE_IDLE_MS = SWIPE_CONFIG.idleMs
const SWIPE_COOLDOWN_MS = SWIPE_CONFIG.cooldownMs

/** 1回のスワイプを刻んで流す。返り値は発火したアクションの列。 */
function stroke(state, { x, y = 0, steps = 10, startAt = 1000, stepMs = 16 }) {
  const fired = []
  for (let i = 0; i < steps; i += 1) {
    const action = feedSwipe(state, { x: x / steps, y: y / steps, at: startAt + i * stepMs }, SWIPE_CONFIG)
    if (action) fired.push(action)
  }
  return fired
}

test('しきい値を超える水平スワイプで1回だけ発火する', () => {
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX + 40 }), ['back'])
})

test('逆向きは進む', () => {
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: -(SWIPE_THRESHOLD_PX + 40) }), ['forward'])
})

test('しきい値に届かない水平移動では発火しない', () => {
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX - 10 }), [])
})

test('縦に流れているジェスチャは無視する（ページの縦スクロール）', () => {
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX * 2, y: SWIPE_THRESHOLD_PX * 2 }), [])
})

test('縦だと判定したジェスチャは、途中から水平に伸びても発火しない', () => {
  const state = createSwipeState(0)
  // 先に縦へ流してからいくら横へ動かしても、指を離すまでは判定しない
  assert.deepEqual(stroke(state, { x: 10, y: 200, startAt: 1000 }), [])
  assert.deepEqual(stroke(state, { x: 400, startAt: 1200, stepMs: 8 }), [])
})

test('同じジェスチャの続き（慣性スクロール）では連発しない', () => {
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX * 3, steps: 30, startAt: 1000 }), ['back'])
  // 慣性ぶんが同じ間隔で流れ込んでも増えない
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX * 3, steps: 30, startAt: 1500 }), [])
})

test('指を離してから十分に間を空ければ次のスワイプが効く', () => {
  const state = createSwipeState(0)
  const first = 1000
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX + 40, startAt: first }), ['back'])
  const later = first + SWIPE_COOLDOWN_MS + SWIPE_IDLE_MS + 100
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX + 40, startAt: later }), ['back'])
})

test('細かい水平スクロールが積み上がって発火することはない', () => {
  const state = createSwipeState(0)
  // 1回ごとに指を離している（イベントの間隔が SWIPE_IDLE_MS より長い）
  let at = 1000
  for (let i = 0; i < 20; i += 1) {
    assert.equal(feedSwipe(state, { x: 40, y: 0, at }, SWIPE_CONFIG), null)
    at += SWIPE_IDLE_MS + 50
  }
})

test('ページを開いた直後（時刻が小さい）でも、指を置き直せば効く', () => {
  // 時刻にはページ内の経過 ms（wheel の timeStamp）が来る
  const state = createSwipeState(0)
  assert.deepEqual(stroke(state, { x: SWIPE_THRESHOLD_PX + 40, startAt: SWIPE_IDLE_MS + 10 }), ['back'])
})

test('ページが切り替わった直後に流れ込む慣性では動かない', () => {
  // 1つ前のページで払った指の慣性。イベントが途切れないまま新しいページへ続く
  const state = createSwipeState(1000)
  assert.deepEqual(stroke(state, { x: 400, startAt: 1010, steps: 20, stepMs: 12 }), [])
  // 指が離れて途切れたら、次のスワイプからは効く
  assert.deepEqual(stroke(state, { x: 400, startAt: 2000, steps: 20, stepMs: 12 }), ['back'])
})

test('注入コードは feedSwipe の実装をそのまま埋め込む（判定を二重に書かない）', () => {
  const code = buildSwipeInjection()
  assert.ok(code.includes('const feedSwipe = function feedSwipe'))
  assert.ok(code.includes(JSON.stringify(SWIPE_CONFIG)))
})

/**
 * 注入コードを最小のブラウザもどきで実際に動かす。
 *
 * 文字列を組み立てて別のワールドへ送るコードは、**外の識別子を参照した瞬間に注入先だけで壊れる**
 * （こちらのテストは通るのに実機で無反応）。ここで評価まで済ませておけばその形の壊れ方を捕まえられる。
 */
function runInjection({ scrollRoom = false } = {}) {
  const calls = []
  const listeners = []
  const element = {
    scrollWidth: scrollRoom ? 2000 : 100,
    clientWidth: 100,
    scrollLeft: 500,
    parentElement: null
  }
  const scope = {
    window: {},
    document: { scrollingElement: element },
    Element: class NotMatching {},
    getComputedStyle: () => ({ overflowX: 'auto' }),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    history: { back: () => calls.push('back'), forward: () => calls.push('forward') }
  }
  const factory = new Function(
    'window',
    'document',
    'Element',
    'getComputedStyle',
    'addEventListener',
    'history',
    'performance',
    `return ${buildSwipeInjection()}`
  )
  const result = factory(
    scope.window,
    scope.document,
    scope.Element,
    scope.getComputedStyle,
    scope.addEventListener,
    scope.history,
    { now: () => 0 }
  )
  const wheel = listeners.find(([type]) => type === 'wheel')?.[1]
  return {
    result,
    calls,
    listeners,
    element,
    fire: (deltaX, at, deltaY = 0) => wheel({ deltaX, deltaY, timeStamp: at, target: {} })
  }
}

test('注入コード: 指を右に払う（deltaX 負）と戻る', () => {
  const run = runInjection()
  assert.equal(run.result, 'attached')
  // 注入されてから指を置き直したところ（イベントが途切れている）
  for (let i = 0; i < 10; i += 1) run.fire(-20, 1000 + i * 16)
  assert.deepEqual(run.calls, ['back'])
})

test('注入コード: 指を左に払う（deltaX 正）と進む', () => {
  const run = runInjection()
  for (let i = 0; i < 10; i += 1) run.fire(20, 1000 + i * 16)
  assert.deepEqual(run.calls, ['forward'])
})

test('注入コード: まだ横スクロールできる場所では履歴を動かさない', () => {
  const run = runInjection({ scrollRoom: true })
  for (let i = 0; i < 10; i += 1) run.fire(-20, 1000 + i * 16)
  assert.deepEqual(run.calls, [])
})

test('注入コード: 二重に入れても2回目は何もしない', () => {
  const code = buildSwipeInjection()
  const window = {}
  const factory = new Function('window', 'addEventListener', 'performance', `return ${code}`)
  const added = []
  const now = { now: () => 0 }
  assert.equal(
    factory(window, (type) => added.push(type), now),
    'attached'
  )
  assert.equal(
    factory(window, (type) => added.push(type), now),
    'already'
  )
  assert.deepEqual(added, ['wheel'])
})

test('注入コード: 横スクロールの端に着いたら、同じジェスチャの続きでも履歴が動く', () => {
  // 幅の広い表などを払っている最中。端に着くまではスクロールしたいだけで、
  // 着いてからは「これ以上動かない」＝ 履歴を戻したい
  const run = runInjection({ scrollRoom: true })
  let at = 1000
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, [], '端に着くまでは動かない')

  // 左端まで来た（これ以上 dx < 0 方向へは動けない）
  run.element.scrollLeft = 0
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, ['back'], '端に着いた後は同じジェスチャの続きでも動く')
})

test('注入コード: 遷移直後の慣性は、横スクロール領域を通り抜けても抑止されたまま', () => {
  // 1つ前のページで払った指の慣性が、横スクロールできる領域を通って端に着く流れ。
  // resetSwipe() がロックを外すだけだと、ここで2ページ目に戻ってしまう
  const run = runInjection({ scrollRoom: true })
  let at = 10 // 注入（performance.now() = 0）からの経過。途切れずに続いている
  for (let i = 0; i < 8; i += 1) run.fire(-20, (at += 16))
  run.element.scrollLeft = 0 // 端に着いた
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, [], '遷移直後の慣性では動かない')
  assert.ok(at < 300, `慣性が途切れないうちに端へ着いている前提（at=${at}）`)

  // 指を離してから改めて払えば効く
  at += SWIPE_IDLE_MS + 50
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, ['back'], '指を置き直せば効く')
})

test('注入コード: 縦に流れていると判断した後は、横スクロール領域を抜けて端に着いても動かない', () => {
  // ページを読みながら斜めに払っている流れ。途中で横スクロールできる領域に入り、
  // その端に着いても、同じイベント列である以上は履歴を動かしてはいけない
  const run = runInjection({ scrollRoom: true })
  let at = 1000
  run.fire(0, (at += 16), 60) // 指を置いて縦に払い始める（ここで「縦」と判定される）
  for (let i = 0; i < 5; i += 1) run.fire(-10, (at += 16), 60)

  run.element.scrollLeft = 0 // 横スクロール領域を抜けて端に着いた
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, [], '縦だと判断したジェスチャの続きでは動かない')

  // 指を置き直せば、いつもどおり効く
  at += SWIPE_IDLE_MS + 50
  for (let i = 0; i < 10; i += 1) run.fire(-20, (at += 16))
  assert.deepEqual(run.calls, ['back'])
})
