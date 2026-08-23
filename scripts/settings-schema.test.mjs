import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  MAX_PIN_DEPTH,
  normalizePins,
  normalizeSettings,
  normalizeStoredUrl,
  readVersioned
} from '../src/shared/settings-schema.js'

test('壊れた設定は既定値に落ちる', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings('nope'), DEFAULT_SETTINGS)
  assert.equal(normalizeSettings({ tabSleepMinutes: 'x' }).tabSleepMinutes, DEFAULT_SETTINGS.tabSleepMinutes)
})

test('知らないキーは捨てる', () => {
  const result = normalizeSettings({ evil: 1, sidebarVisible: false })
  assert.equal('evil' in result, false)
  assert.equal(result.sidebarVisible, false)
})

test('検索テンプレートは https と {q} を要求する', () => {
  assert.equal(
    normalizeSettings({ searchTemplate: 'ftp://x/{q}' }).searchTemplate,
    DEFAULT_SETTINGS.searchTemplate
  )
  assert.equal(
    normalizeSettings({ searchTemplate: 'https://x/?q=fixed' }).searchTemplate,
    DEFAULT_SETTINGS.searchTemplate
  )
  assert.equal(
    normalizeSettings({ searchTemplate: 'https://d.example/?q={q}' }).searchTemplate,
    'https://d.example/?q={q}'
  )
})

test('tabSleepMinutes は範囲に収める', () => {
  assert.equal(normalizeSettings({ tabSleepMinutes: -5 }).tabSleepMinutes, 0)
  assert.equal(normalizeSettings({ tabSleepMinutes: 99999 }).tabSleepMinutes, 24 * 60)
})

test('version の無い JSON / 未来の版は読まない', () => {
  assert.equal(readVersioned({ data: {} }, 1), null)
  assert.equal(readVersioned({ version: 2, data: {} }, 1), null)
  assert.deepEqual(readVersioned({ version: 1, data: { a: 1 } }, 1), { version: 1, data: { a: 1 } })
})

test('保存された URL は http / https だけ通す', () => {
  assert.equal(normalizeStoredUrl('https://example.com/'), 'https://example.com/')
  assert.equal(normalizeStoredUrl('file:///etc/passwd'), null)
  assert.equal(normalizeStoredUrl('javascript:alert(1)'), null)
  assert.equal(normalizeStoredUrl('chrome-extension://abc/x.html'), null)
  assert.equal(normalizeStoredUrl(123), null)
})

test('ピン留めは不正な項目を落として読む', () => {
  const { favorites, pinned } = normalizePins({
    favorites: [
      { id: 'f1', url: 'https://a.example/', title: 'A' },
      { id: 'f2', url: 'file:///x' },
      { id: 'f1', url: 'https://dup.example/' }
    ],
    pinned: [
      { id: 'p1', kind: 'link', url: 'https://b.example/', title: 'B' },
      {
        id: 'p2',
        kind: 'folder',
        title: 'F',
        children: [{ id: 'p3', kind: 'link', url: 'https://c.example/' }]
      },
      { id: 'p4', kind: 'link', url: 'javascript:alert(1)' }
    ]
  })
  assert.equal(favorites.length, 1, 'file: と ID 重複は落ちる')
  assert.equal(pinned.length, 2)
  assert.equal(pinned[1].children.length, 1)
})

test('ピン留めの入れ子は上限で打ち切る', () => {
  let node = { id: 'deep', kind: 'link', url: 'https://x.example/' }
  for (let i = 0; i < MAX_PIN_DEPTH + 3; i += 1) {
    node = { id: `f${i}`, kind: 'folder', title: 'f', children: [node] }
  }
  const { pinned } = normalizePins({ pinned: [node] })
  let depth = 0
  let current = pinned[0]
  while (current?.kind === 'folder' && current.children.length > 0) {
    depth += 1
    current = current.children[0]
  }
  assert.ok(depth <= MAX_PIN_DEPTH + 1, `depth=${depth}`)
})
