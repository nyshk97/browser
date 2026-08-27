#!/usr/bin/env node
/**
 * `gg` / `G` の判定の回帰テスト。
 *
 * 見たいのは「発火すること」より **誤爆しないこと**（`g` を押して放置した後の `g` で飛ぶ、
 * `g` → 別のキー → `g` で飛ぶ）なので、そちら側を厚く書く。
 *
 * **注入コードの中のヘルパー（入力欄の除外・スクロール対象の選択）はここでは見られない。**
 * あちらの回帰は `scripts/verify-vim-scroll.mjs`（実アプリに CDP でキーを撃つ）が持つ。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIM_SCROLL_CONFIG,
  buildVimScrollInjection,
  createVimScrollState,
  feedVimKey
} from '../src/shared/vim-scroll.js'

const PENDING_MS = VIM_SCROLL_CONFIG.pendingMs

/** キーを順に流す。返り値は発火したアクションの列。 */
function press(state, keys) {
  const fired = []
  for (const { key, at } of keys) {
    const action = feedVimKey(state, { key, at }, VIM_SCROLL_CONFIG)
    if (action) fired.push(action)
  }
  return fired
}

test('猶予内の gg で最上部へ', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'g', at: 1000 + PENDING_MS - 100 }
    ]),
    ['top']
  )
})

test('猶予ちょうどは発火する（境界を含む）', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'g', at: 1000 + PENDING_MS }
    ]),
    ['top']
  )
})

test('猶予を超えた2打目では発火しない', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'g', at: 1000 + PENDING_MS + 1 }
    ]),
    []
  )
})

test('猶予切れの g は「1打目」に戻る（捨てない）', () => {
  const state = createVimScrollState()
  // 3打目は 2打目から見て猶予内なので、ここで初めて発火する。
  // 猶予切れを捨てる実装だと `g` を3回押しても飛ばない。
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'g', at: 1000 + PENDING_MS + 1 },
      { key: 'g', at: 1000 + PENDING_MS + 100 }
    ]),
    ['top']
  )
})

test('g のあいだに別のキーが入ると発火しない', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'x', at: 1010 },
      { key: 'g', at: 1020 }
    ]),
    []
  )
})

test('G 単体で最下部へ', () => {
  const state = createVimScrollState()
  assert.deepEqual(press(state, [{ key: 'G', at: 1000 }]), ['bottom'])
})

test('g → G は最下部へ飛び、保留の g を残さない', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'G', at: 1010 },
      // ここで飛ぶなら「G のあとに g の保留が残っていた」ことになる
      { key: 'g', at: 1020 }
    ]),
    ['bottom']
  )
})

test('gg のあと保留は消える（3打目の g で続けて飛ばない）', () => {
  const state = createVimScrollState()
  assert.deepEqual(
    press(state, [
      { key: 'g', at: 1000 },
      { key: 'g', at: 1010 },
      { key: 'g', at: 1020 }
    ]),
    ['top']
  )
})

test('注入コードは外の識別子を参照しない（判定の実体を埋め込んでいる）', () => {
  const source = buildVimScrollInjection()
  assert.match(source, /function feedVimKey/)
  assert.match(source, /__nemoVimScrollAttached/)
  // `preventDefault` を呼ばないことがこの機能の前提（ページの g プレフィックスを潰さない）
  assert.doesNotMatch(source, /preventDefault\(\)/)
})
