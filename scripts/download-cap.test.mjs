import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ENTRIES, idsOverCap } from '../src/shared/download-cap.js'

/** `n` 件ぶんの完了済みエントリを作る（startedAt は古い順に 1, 2, ...）。 */
function completed(scope, count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    scope,
    startedAt: index + 1,
    state: 'completed'
  }))
}

test('上限は scope ごとに掛ける（シークレットの大量ダウンロードで通常側が消えない）', () => {
  // 通常側 49 件 + シークレット側 50 件。混ぜて数えると通常側が押し出される
  const normal = completed(null, 49, 'normal')
  const priv = completed('nemo-private', 50, 'private')
  const all = [...normal, ...priv]

  assert.deepEqual(idsOverCap(all, null), [], '通常側は上限内なので1件も落とさない')

  const dropped = idsOverCap(all, 'nemo-private')
  assert.equal(dropped.length, 0, 'シークレット側もちょうど上限なら落とさない')

  // シークレット側が上限を1件超えたら、**シークレット側の最古だけ**が落ちる
  const overflowed = [
    ...all,
    { id: 'private-new', scope: 'nemo-private', startedAt: 999, state: 'completed' }
  ]
  assert.deepEqual(idsOverCap(overflowed, 'nemo-private'), ['private-0'])
  assert.deepEqual(idsOverCap(overflowed, null), [], '通常側は無傷')
})

test('新しい順に残す（落とすのは最古のぶん。返る順序は問わない）', () => {
  const entries = completed(null, MAX_ENTRIES + 3, 'x')
  const dropped = idsOverCap(entries, null)
  assert.deepEqual([...dropped].sort(), ['x-0', 'x-1', 'x-2'], '最古の3件が落ちる')
})

test('進行中 / 一時停止は落とさない', () => {
  const entries = [
    ...completed(null, MAX_ENTRIES, 'done'),
    { id: 'running', scope: null, startedAt: 0, state: 'progressing' },
    { id: 'paused', scope: null, startedAt: 0, state: 'paused' }
  ]
  // 一番古い2件が上限からあふれるが、終わっていないので消さない
  assert.deepEqual(idsOverCap(entries, null), [])
})

test('scope が違うものは数にも入れない', () => {
  const entries = [...completed(null, 3, 'n'), ...completed('nemo-private', 3, 'p')]
  assert.deepEqual([...idsOverCap(entries, null, 2)].sort(), ['n-0'])
  assert.deepEqual([...idsOverCap(entries, 'nemo-private', 2)].sort(), ['p-0'])
})

test('上限超過中に保護された進行中の項目は、完了した時点で落とせる', () => {
  // 「長く走っている1件（最古）」＋「新しい完了済み 50 件」
  const running = { id: 'long-running', scope: null, startedAt: 0, state: 'progressing' }
  const entries = [running, ...completed(null, MAX_ENTRIES, 'new')]

  // 走っている間は落とさない（＝上限を超えたまま 51 件残る）
  assert.deepEqual(idsOverCap(entries, null), [], '進行中は保護される')

  // 終わったら落とせるようになる。**この時点で trim を呼び直さないと残り続ける**
  const done = entries.map((entry) =>
    entry.id === 'long-running' ? { ...entry, state: 'completed' } : entry
  )
  assert.deepEqual(idsOverCap(done, null), ['long-running'], '完了後は最古として落ちる')
})
