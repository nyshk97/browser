import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  MAX_PIN_DEPTH,
  normalizePins,
  normalizeSettings,
  normalizeStoredUrl,
  readVersioned,
  normalizeSession,
  normalizeCallWindow,
  fitsAnyWorkArea
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

test('2階層以上のフォルダは中身を親へ平坦化する（捨てない）', () => {
  const { pinned } = normalizePins({
    pinned: [
      {
        id: 'outer',
        kind: 'folder',
        title: '外',
        children: [
          { id: 'a', kind: 'link', url: 'https://a.example/', title: 'A' },
          {
            id: 'inner',
            kind: 'folder',
            title: '中',
            children: [
              { id: 'b', kind: 'link', url: 'https://b.example/', title: 'B' },
              {
                id: 'inner2',
                kind: 'folder',
                title: '奥',
                children: [{ id: 'c', kind: 'link', url: 'https://c.example/', title: 'C' }]
              }
            ]
          }
        ]
      }
    ]
  })
  assert.equal(MAX_PIN_DEPTH, 1)
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].kind, 'folder')
  // 中身は1件も落ちず、すべて root 直下のフォルダの子になる
  assert.deepEqual(
    pinned[0].children.map((node) => node.id),
    ['a', 'b', 'c']
  )
  assert.ok(
    pinned[0].children.every((node) => node.kind === 'link'),
    'フォルダの中にフォルダが残っている'
  )
})

test('customTitle は往復する（空文字と非文字列は未設定に倒す）', () => {
  const { favorites, pinned } = normalizePins({
    favorites: [{ id: 'f1', url: 'https://a.example/', title: 'A', customTitle: '  あだ名  ' }],
    pinned: [
      { id: 'p1', kind: 'link', url: 'https://b.example/', title: 'B', customTitle: 'B の別名' },
      { id: 'p2', kind: 'link', url: 'https://c.example/', title: 'C', customTitle: '   ' },
      { id: 'p3', kind: 'link', url: 'https://d.example/', title: 'D', customTitle: 123 },
      { id: 'p4', kind: 'link', url: 'https://e.example/', title: 'E' },
      { id: 'p5', kind: 'folder', title: 'F', customTitle: 'フォルダの別名', children: [] }
    ]
  })
  assert.equal(favorites[0].customTitle, 'あだ名')
  assert.equal(pinned[0].customTitle, 'B の別名')
  assert.equal(pinned[1].customTitle, null, '空白だけは未設定')
  assert.equal(pinned[2].customTitle, null, '非文字列は未設定')
  assert.equal(pinned[3].customTitle, null, '無ければ未設定')
  assert.equal(pinned[4].customTitle, 'フォルダの別名')
})

test('版 1 の pins.json（customTitle なし）がそのまま読める', () => {
  const { favorites, pinned } = normalizePins({
    favorites: [{ id: 'f1', url: 'https://a.example/', title: 'A' }],
    pinned: [
      { id: 'p1', kind: 'link', url: 'https://b.example/', title: 'B' },
      { id: 'p2', kind: 'folder', title: 'F', collapsed: true, children: [] }
    ]
  })
  assert.equal(favorites.length, 1)
  assert.equal(favorites[0].customTitle, null)
  assert.equal(pinned.length, 2)
  assert.equal(pinned[0].customTitle, null)
  assert.equal(pinned[1].collapsed, true)
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

/* ------------------------------------------------------------------ *
 * セッション（版 3 への移行 — ピン留めのタブを復元しない）
 * ------------------------------------------------------------------ */

/** 版 2 のウィンドウ1枚ぶんを組み立てる。 */
function v2Window(tabs, activeIndex) {
  return { bounds: null, activeIndex, tabs }
}

test('版 2 のピン留めタブはレコードごと落ちる（一時タブとして復活しない）', () => {
  const result = normalizeSession({
    windows: [
      v2Window(
        [
          { url: 'https://pin.example/', title: 'pin', pinnedId: 'p1', lastActiveAt: 1 },
          { url: 'https://tmp.example/', title: 'tmp', pinnedId: null, lastActiveAt: 1 }
        ],
        1
      )
    ]
  })
  assert.equal(result.windows[0].tabs.length, 1)
  assert.equal(result.windows[0].tabs[0].url, 'https://tmp.example/')
  assert.equal('pinnedId' in result.windows[0].tabs[0], false, 'pinnedId は版 3 では持たない')
})

test('ピン留めタブしか無かったウィンドウは丸ごと落ちる', () => {
  const result = normalizeSession({
    windows: [
      v2Window([{ url: 'https://pin.example/', title: 'pin', pinnedId: 'p1', lastActiveAt: 1 }], 0),
      v2Window([{ url: 'https://tmp.example/', title: 'tmp', pinnedId: null, lastActiveAt: 1 }], 0)
    ]
  })
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].tabs[0].url, 'https://tmp.example/')
})

test('セッションの customTitle は往復する', () => {
  const result = normalizeSession({
    windows: [
      v2Window(
        [
          { url: 'https://a.example/', title: 'a', customTitle: '作業用', lastActiveAt: 1 },
          { url: 'https://b.example/', title: 'b', customTitle: '  ', lastActiveAt: 1 }
        ],
        0
      )
    ]
  })
  assert.equal(result.windows[0].tabs[0].customTitle, '作業用')
  assert.equal(result.windows[0].tabs[1].customTitle, null)
})

test('移行後の activeIndex は「元のアクティブタブの新しい位置」になる', () => {
  const pin = (id) => ({ url: `https://pin${id}.example/`, title: 'pin', pinnedId: id, lastActiveAt: 1 })
  const tmp = (n) => ({ url: `https://tmp${n}.example/`, title: `tmp${n}`, pinnedId: null, lastActiveAt: 1 })

  // 先頭がピンタブ: 元 index 1（tmp1）→ 新 index 0
  const head = normalizeSession({ windows: [v2Window([pin('p1'), tmp(1), tmp(2)], 1)] })
  assert.equal(head.windows[0].tabs[head.windows[0].activeIndex].url, 'https://tmp1.example/')

  // 中間がピンタブ: 元 index 2（tmp2）→ 新 index 1
  const middle = normalizeSession({ windows: [v2Window([tmp(1), pin('p1'), tmp(2)], 2)] })
  assert.equal(middle.windows[0].tabs[middle.windows[0].activeIndex].url, 'https://tmp2.example/')

  // アクティブだったタブ自体がピンタブ: 残った先頭に倒す
  const gone = normalizeSession({ windows: [v2Window([tmp(1), pin('p1'), tmp(2)], 1)] })
  assert.equal(gone.windows[0].activeIndex, 0)
  assert.equal(gone.windows[0].tabs[0].url, 'https://tmp1.example/')
})

/* ------------------------------------------------------------------ *
 * 会議の小窓の位置
 * ------------------------------------------------------------------ */

test('会議の小窓の位置は壊れていれば null に落ちる', () => {
  assert.deepEqual(normalizeCallWindow(null), { position: null })
  assert.deepEqual(normalizeCallWindow({}), { position: null })
  assert.deepEqual(normalizeCallWindow({ position: { x: 10 } }), { position: null })
  assert.deepEqual(normalizeCallWindow({ position: { x: 'a', y: 1, displayId: 1 } }), { position: null })
})

test('会議の小窓の位置は整数へ丸めて読む', () => {
  assert.deepEqual(normalizeCallWindow({ position: { x: 10.4, y: 20.6, displayId: 7 } }), {
    position: { x: 10, y: 21, displayId: 7 }
  })
})

test('保存位置は workArea に収まるときだけ使う（画面外なら捨てる）', () => {
  const size = { width: 304, height: 52 }
  const laptop = { x: 0, y: 25, width: 1440, height: 875 }
  const external = { x: 1440, y: 0, width: 1920, height: 1080 }

  // 収まる
  assert.equal(fitsAnyWorkArea({ x: 1100, y: 800 }, size, [laptop]), true)
  // 右端をわずかにはみ出す（幅ぶんを見ていない実装だとここが通ってしまう）
  assert.equal(fitsAnyWorkArea({ x: 1200, y: 800 }, size, [laptop]), false)
  // 下端をはみ出す
  assert.equal(fitsAnyWorkArea({ x: 100, y: 870 }, size, [laptop]), false)
  // メニューバーぶん上にはみ出す
  assert.equal(fitsAnyWorkArea({ x: 100, y: 0 }, size, [laptop]), false)
  // 外部モニタを外したあと（そのモニタの座標にはもう収まらない）
  assert.equal(fitsAnyWorkArea({ x: 3000, y: 500 }, size, [laptop, external]), true)
  assert.equal(fitsAnyWorkArea({ x: 3000, y: 500 }, size, [laptop]), false)
  // モニタが1枚も無い（起動直後の異常系）
  assert.equal(fitsAnyWorkArea({ x: 0, y: 0 }, size, []), false)
})
