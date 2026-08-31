import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveReopen, resolveTabOwnership } from '../src/shared/tab-ownership.js'

/** 何でも実在することにする既定のコンテキスト。 */
function context(overrides = {}) {
  return {
    pinnedExists: () => true,
    favoriteExists: () => true,
    ephemeralExists: () => true,
    windowTabs: [],
    ...overrides
  }
}

test('所属なしはそのまま', () => {
  const result = resolveTabOwnership({}, context())
  assert.deepEqual(result, { pinnedId: null, favoriteId: null, ephemeralId: null, dropped: [] })
})

test('消えた定義の ID は落とす（どの層にも出ないタブを作らない）', () => {
  const pinned = resolveTabOwnership({ pinnedId: 'gone' }, context({ pinnedExists: () => false }))
  assert.equal(pinned.pinnedId, null)
  assert.ok(pinned.dropped.includes('missing_pinned'))

  const favorite = resolveTabOwnership({ favoriteId: 'gone' }, context({ favoriteExists: () => false }))
  assert.equal(favorite.favoriteId, null)
  assert.ok(favorite.dropped.includes('missing_favorite'))

  const ephemeral = resolveTabOwnership({ ephemeralId: 'gone' }, context({ ephemeralExists: () => false }))
  assert.equal(ephemeral.ephemeralId, null)
  assert.ok(ephemeral.dropped.includes('missing_ephemeral'))
})

test('両方の ID を同時に渡したらピン留めだけ残す', () => {
  const result = resolveTabOwnership({ pinnedId: 'p1', favoriteId: 'f1' }, context())
  assert.equal(result.pinnedId, 'p1')
  assert.equal(result.favoriteId, null)
  assert.ok(result.dropped.includes('both_ids'))
})

test('ephemeralId は pinned / favorite と排他（定義側が勝つ）', () => {
  const withPin = resolveTabOwnership({ pinnedId: 'p1', ephemeralId: 'e1' }, context())
  assert.equal(withPin.pinnedId, 'p1')
  assert.equal(withPin.ephemeralId, null)
  assert.ok(withPin.dropped.includes('ephemeral_with_definition'))

  const withFav = resolveTabOwnership({ favoriteId: 'f1', ephemeralId: 'e1' }, context())
  assert.equal(withFav.favoriteId, 'f1')
  assert.equal(withFav.ephemeralId, null)
  assert.ok(withFav.dropped.includes('ephemeral_with_definition'))

  const alone = resolveTabOwnership({ ephemeralId: 'e1' }, context())
  assert.equal(alone.ephemeralId, 'e1')
  assert.deepEqual(alone.dropped, [])
})

test('同じ定義のタブが同じウィンドウに既にあれば所属を付けない', () => {
  const pinned = resolveTabOwnership(
    { pinnedId: 'p1' },
    context({ windowTabs: [{ pinnedId: 'p1', favoriteId: null }] })
  )
  assert.equal(pinned.pinnedId, null)
  assert.ok(pinned.dropped.includes('duplicate_pinned'))

  const favorite = resolveTabOwnership(
    { favoriteId: 'f1' },
    context({ windowTabs: [{ pinnedId: null, favoriteId: 'f1' }] })
  )
  assert.equal(favorite.favoriteId, null)
  assert.ok(favorite.dropped.includes('duplicate_favorite'))

  // 同じ共有定義の実体は 1 ウィンドウ 1 本（復元・openEphemeral の競合をここで止める）
  const ephemeral = resolveTabOwnership(
    { ephemeralId: 'e1' },
    context({ windowTabs: [{ pinnedId: null, favoriteId: null, ephemeralId: 'e1' }] })
  )
  assert.equal(ephemeral.ephemeralId, null)
  assert.ok(ephemeral.dropped.includes('duplicate_ephemeral'))
})

test('別の定義のタブが並んでいるだけなら所属は付く', () => {
  const result = resolveTabOwnership(
    { pinnedId: 'p1' },
    context({
      windowTabs: [
        { pinnedId: 'p2', favoriteId: null },
        { pinnedId: null, favoriteId: 'p1' }
      ]
    })
  )
  assert.equal(result.pinnedId, 'p1', '別の枠（Favorite）に同じ ID は無いので通す')
  assert.deepEqual(result.dropped, [])
})

test('空文字や非文字列の ID は所属なしに倒す', () => {
  assert.equal(resolveTabOwnership({ pinnedId: '' }, context()).pinnedId, null)
  assert.equal(resolveTabOwnership({ favoriteId: undefined }, context()).favoriteId, null)
  assert.equal(resolveTabOwnership({ pinnedId: null }, context()).pinnedId, null)
})

/* ------------------------------------------------------------------ *
 * ⌘⇧T（閉じたタブを開き直す）
 * ------------------------------------------------------------------ */

function entry(overrides = {}) {
  return {
    url: 'https://example.com/',
    title: 'Example',
    pinnedId: null,
    favoriteId: null,
    customTitle: null,
    ...overrides
  }
}

test('⌘⇧T は閉じた瞬間の URL / 名前 / 所属をそのまま戻す', () => {
  const result = resolveReopen(
    entry({ pinnedId: 'p1', url: 'https://example.com/deep', customTitle: '作業用' }),
    context()
  )
  assert.deepEqual(result, {
    action: 'create',
    url: 'https://example.com/deep',
    title: 'Example',
    customTitle: '作業用',
    pinnedId: 'p1',
    favoriteId: null
  })
})

test('⌘⇧T: 同じ定義のタブが既に開いていれば、作らず選ぶだけ', () => {
  const result = resolveReopen(
    entry({ pinnedId: 'p1' }),
    context({ windowTabs: [{ key: 'tab-1', pinnedId: 'p1', favoriteId: null }] })
  )
  assert.deepEqual(result, { action: 'select', key: 'tab-1' })

  const favorite = resolveReopen(
    entry({ favoriteId: 'f1' }),
    context({ windowTabs: [{ key: 'tab-2', pinnedId: null, favoriteId: 'f1' }] })
  )
  assert.deepEqual(favorite, { action: 'select', key: 'tab-2' })
})

test('⌘⇧T: 定義が消えていれば一時タブとして戻す（URL と名前は保つ）', () => {
  const result = resolveReopen(
    entry({ pinnedId: 'gone', customTitle: '消えた枠の名前' }),
    context({ pinnedExists: () => false })
  )
  assert.equal(result.action, 'create')
  assert.equal(result.pinnedId, null, '消えた ID のまま戻すと不可視タブになる')
  assert.equal(result.url, 'https://example.com/')
  assert.equal(result.customTitle, '消えた枠の名前')
})

test('⌘⇧T: 定義が消えていれば、同じ ID のタブが開いていても選ばない', () => {
  const result = resolveReopen(
    entry({ favoriteId: 'gone' }),
    context({
      favoriteExists: () => false,
      windowTabs: [{ key: 'tab-1', pinnedId: null, favoriteId: 'gone' }]
    })
  )
  assert.equal(result.action, 'create')
  assert.equal(result.favoriteId, null)
})
