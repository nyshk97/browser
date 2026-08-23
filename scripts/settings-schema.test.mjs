import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  MAX_PIN_DEPTH,
  normalizePins,
  normalizeSettings,
  normalizeStoredUrl,
  readVersioned,
  normalizeSession
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

/* ------------------------------------------------------------------ *
 * セッション（自動アーカイブの寿命）
 * ------------------------------------------------------------------ */

test('セッションは lastActiveAt を保つ（自動アーカイブの寿命が再起動でリセットされない）', () => {
  const old = Date.now() - 40 * 60 * 60 * 1000
  const result = normalizeSession({
    windows: [
      {
        bounds: null,
        activeIndex: 0,
        tabs: [
          { url: 'https://example.com/', title: 'a', pinnedId: null, lastActiveAt: old },
          { url: 'https://example.org/', title: 'b', pinnedId: null, lastActiveAt: old }
        ]
      }
    ],
    cleanExit: true,
    savedAt: 1
  })
  assert.equal(result.windows[0].tabs[0].lastActiveAt, old)
  assert.equal(result.windows[0].tabs[1].lastActiveAt, old)
})

test('版 1（lastActiveAt なし）は「たった今」に倒す', () => {
  // 0 に倒すと、版を上げた直後の初回起動で古いタブが一斉に片付いてしまう
  const before = Date.now()
  const result = normalizeSession({
    windows: [{ bounds: null, activeIndex: 0, tabs: [{ url: 'https://example.com/', title: 'a' }] }],
    cleanExit: true,
    savedAt: 1
  })
  const value = result.windows[0].tabs[0].lastActiveAt
  assert.ok(value >= before && value <= Date.now(), `たった今になっていない: ${value}`)
})

test('壊れた / 未来の lastActiveAt は「たった今」に倒す', () => {
  const future = Date.now() + 10 * 24 * 60 * 60 * 1000
  const result = normalizeSession({
    windows: [
      {
        bounds: null,
        activeIndex: 0,
        tabs: [
          { url: 'https://a.example.com/', title: '', pinnedId: null, lastActiveAt: 'あ' },
          { url: 'https://b.example.com/', title: '', pinnedId: null, lastActiveAt: -1 },
          { url: 'https://c.example.com/', title: '', pinnedId: null, lastActiveAt: future }
        ]
      }
    ]
  })
  for (const tab of result.windows[0].tabs) {
    assert.ok(tab.lastActiveAt <= Date.now(), `未来の値が残っている: ${tab.lastActiveAt}`)
    assert.ok(tab.lastActiveAt > 0)
  }
})

test('セッションの URL も http/https 以外を落とす', () => {
  const result = normalizeSession({
    windows: [
      {
        bounds: null,
        activeIndex: 0,
        tabs: [
          { url: 'file:///etc/passwd', title: 'x', pinnedId: null, lastActiveAt: 1 },
          { url: 'https://ok.example.com/', title: 'y', pinnedId: null, lastActiveAt: 1 }
        ]
      }
    ]
  })
  assert.equal(result.windows[0].tabs.length, 1)
  assert.equal(result.windows[0].tabs[0].url, 'https://ok.example.com/')
})
