import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FAVICON_LENGTH,
  MAX_SLOT_ICONS,
  MAX_SLOT_NAME,
  UNNAMED_SLOT,
  buildSlot,
  collectIcons,
  countPinnedLinks,
  normalizeSlot,
  normalizeSlotName
} from '../src/shared/slots-schema.js'

const NOW = 1_756_000_000_000

/** 最小限の正しいスロット。 */
function slot(overrides = {}) {
  return {
    name: 'メイン環境',
    savedAt: NOW - 1000,
    host: 'TsubasanoMacBook-Pro',
    appVersion: '0.5.2',
    icons: [],
    favorites: [],
    pinned: [],
    ...overrides
  }
}

test('壊れた入力でも落ちず、既定のスロットになる', () => {
  for (const raw of [undefined, null, 42, 'x', [], { favorites: 'no', pinned: 3 }]) {
    const result = normalizeSlot(raw, NOW)
    assert.equal(result.name, UNNAMED_SLOT)
    assert.deepEqual(result.favorites, [])
    assert.deepEqual(result.pinned, [])
    assert.equal(result.savedAt, NOW)
  }
})

test('名前は 60 文字に丸め、空白だけなら名称未設定', () => {
  assert.equal(normalizeSlotName('  実験用  '), '実験用')
  assert.equal(normalizeSlotName('   '), UNNAMED_SLOT)
  assert.equal(normalizeSlotName(''), UNNAMED_SLOT)
  assert.equal(normalizeSlotName(null), UNNAMED_SLOT)
  assert.equal(normalizeSlotName('あ'.repeat(200)).length, MAX_SLOT_NAME)
})

test('未来の savedAt は「たった今」に倒す（並び順が壊れないため）', () => {
  assert.equal(normalizeSlot(slot({ savedAt: NOW + 999_999 }), NOW).savedAt, NOW)
  assert.equal(normalizeSlot(slot({ savedAt: -1 }), NOW).savedAt, NOW)
  assert.equal(normalizeSlot(slot({ savedAt: 'いつか' }), NOW).savedAt, NOW)
  assert.equal(normalizeSlot(slot({ savedAt: NOW - 5 }), NOW).savedAt, NOW - 5)
})

test('ピン留めの検査は normalizePins に任せる（不正 URL は落ちる）', () => {
  const result = normalizeSlot(
    slot({
      favorites: [
        { id: 'f1', url: 'https://example.com/', title: 'ok', customTitle: null },
        { id: 'f2', url: 'file:///etc/passwd', title: 'ng', customTitle: null }
      ],
      pinned: [
        { id: 'p1', kind: 'link', url: 'https://example.org/', title: 'ok', customTitle: null },
        { id: 'p2', kind: 'link', url: 'javascript:alert(1)', title: 'ng', customTitle: null }
      ]
    }),
    NOW
  )
  assert.deepEqual(
    result.favorites.map((item) => item.id),
    ['f1']
  )
  assert.deepEqual(
    result.pinned.map((node) => node.id),
    ['p1']
  )
})

test('2 階層のフォルダは中身が親へ平坦化される（ブックマークを黙って消さない）', () => {
  const result = normalizeSlot(
    slot({
      pinned: [
        {
          id: 'outer',
          kind: 'folder',
          title: '外',
          customTitle: null,
          collapsed: false,
          children: [
            {
              id: 'inner',
              kind: 'folder',
              title: '中',
              customTitle: null,
              collapsed: false,
              children: [
                { id: 'deep', kind: 'link', url: 'https://deep.example/', title: '奥', customTitle: null }
              ]
            }
          ]
        }
      ]
    }),
    NOW
  )
  const outer = result.pinned[0]
  assert.equal(outer.kind, 'folder')
  // 「中」フォルダは消え、その子は「外」の直下に残る
  assert.deepEqual(
    outer.children.map((node) => node.id),
    ['deep']
  )
})

test('icons は 6 件まで。url が不正なものは丸ごと捨てる', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    url: `https://site${i}.example/`,
    faviconUrl: `https://site${i}.example/favicon.ico`
  }))
  assert.equal(normalizeSlot(slot({ icons: many }), NOW).icons.length, MAX_SLOT_ICONS)

  const mixed = normalizeSlot(slot({ icons: [{ url: 'ftp://x.example/', faviconUrl: null }, many[0]] }), NOW)
  assert.deepEqual(mixed.icons, [many[0]])
})

test('faviconUrl は https と data: だけ。長すぎるものは落とすが url は残す', () => {
  const cases = [
    ['https://ok.example/i.png', 'https://ok.example/i.png'],
    ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ['http://insecure.example/i.png', null],
    ['javascript:alert(1)', null],
    [`data:image/png;base64,${'A'.repeat(MAX_FAVICON_LENGTH)}`, null],
    [null, null]
  ]
  for (const [input, expected] of cases) {
    const result = normalizeSlot(slot({ icons: [{ url: 'https://x.example/', faviconUrl: input }] }), NOW)
    assert.equal(result.icons.length, 1, `url は残る: ${input}`)
    assert.equal(result.icons[0].faviconUrl, expected, `faviconUrl: ${input}`)
  }
})

test('buildSlot は組み立てた中身をそのまま検査に通す', () => {
  const built = buildSlot({
    name: '  実験用  ',
    host: 'Tsubasa-Mac-mini',
    appVersion: '0.5.2',
    savedAt: NOW,
    favorites: [{ id: 'f1', url: 'https://example.com/', title: 'ok', customTitle: null }],
    pinned: [],
    icons: [{ url: 'https://example.com/', faviconUrl: 'http://ng.example/i.png' }]
  })
  assert.equal(built.name, '実験用')
  assert.equal(built.savedAt, NOW)
  assert.equal(built.favorites.length, 1)
  assert.equal(built.icons[0].faviconUrl, null)
})

test('collectIcons はお気に入り → ピン留めの順で、フォルダの中まで辿る', () => {
  const favorites = [{ id: 'f1', url: 'https://fav.example/', title: 'f', customTitle: null }]
  const pinned = [
    { id: 'p1', kind: 'link', url: 'https://pin.example/', title: 'p', customTitle: null },
    {
      id: 'folder',
      kind: 'folder',
      title: 'F',
      customTitle: null,
      collapsed: false,
      children: [{ id: 'p2', kind: 'link', url: 'https://in-folder.example/', title: 'i', customTitle: null }]
    }
  ]
  const icons = collectIcons(
    favorites,
    pinned,
    new Map([['https://pin.example/', 'https://pin.example/i.png']])
  )
  assert.deepEqual(
    icons.map((icon) => icon.url),
    ['https://fav.example/', 'https://pin.example/', 'https://in-folder.example/']
  )
  // favicon が引けなかったものも url は残す（頭文字で描くため）
  assert.equal(icons[0].faviconUrl, null)
  assert.equal(icons[1].faviconUrl, 'https://pin.example/i.png')
})

test('countPinnedLinks はフォルダを数えず、中のリンクを数える', () => {
  const pinned = [
    { id: 'p1', kind: 'link', url: 'https://a.example/', title: 'a', customTitle: null },
    {
      id: 'folder',
      kind: 'folder',
      title: 'F',
      customTitle: null,
      collapsed: false,
      children: [
        { id: 'p2', kind: 'link', url: 'https://b.example/', title: 'b', customTitle: null },
        { id: 'p3', kind: 'link', url: 'https://c.example/', title: 'c', customTitle: null }
      ]
    }
  ]
  assert.equal(countPinnedLinks(pinned), 3)
  assert.equal(countPinnedLinks([]), 0)
})
