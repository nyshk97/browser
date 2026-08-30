import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeIntoPins, parseArcSidebar } from '../src/shared/arc-import.js'
import { MAX_PIN_DEPTH, normalizePins } from '../src/shared/settings-schema.js'

/**
 * Arc の保存形式を模した fixture。
 * `items` / `spaces` / `topAppsContainerIDs` が **`[id, オブジェクト, ...]` の交互並び**
 * であることが再現の肝（片側だけ読むと必ず取りこぼす）。
 */
function fixture() {
  const tab = (id, url, title = null, savedTitle = '') => [
    id,
    { id, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle } } }
  ]
  const folder = (id, title, children) => [id, { id, title, childrenIds: children, data: { list: {} } }]
  const splitView = (id, children) => [
    id,
    { id, title: null, childrenIds: children, data: { splitView: {} } }
  ]
  const container = (id, children) => [
    id,
    { id, title: null, childrenIds: children, data: { itemContainer: { containerType: {} } } }
  ]

  return {
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, 'favs'],
          spaces: [
            'space1',
            { id: 'space1', containerIDs: ['pinned', 'pin1', 'unpinned', 'un1'] },
            'space2',
            { id: 'space2', containerIDs: ['pinned', 'pin2', 'unpinned', 'un2'] }
          ],
          items: [
            ...container('favs', ['fav1', 'fav2']),
            ...tab('fav1', 'https://calendar.example.com/', null, 'Calendar'),
            ...tab('fav2', 'https://chat.example.com/', 'Chat'),

            ...container('pin1', ['t1', 'f1', 'sv1', 'arcpage']),
            ...tab('t1', 'https://one.example.com/'),
            ...folder('f1', '仕事', ['t2', 'f2']),
            ...tab('t2', 'https://two.example.com/', 'Two'),
            ...folder('f2', '入れ子', ['t3']),
            ...tab('t3', 'https://three.example.com/'),
            // 分割ビューは Nemo に対応物が無いので子を平らに展開する
            ...splitView('sv1', ['t4']),
            ...tab('t4', 'https://four.example.com/'),
            // Arc の内部ページは取り込まない
            ...tab('arcpage', 'arc://library'),

            ...container('pin2', ['t5']),
            ...tab('t5', 'https://five.example.com/', 'Five'),

            ...container('un1', []),
            ...container('un2', [])
          ]
        }
      ]
    }
  }
}

test('Favorites は topAppsContainerIDs から取る', () => {
  const { favorites } = parseArcSidebar(fixture())
  assert.deepEqual(
    favorites.map((item) => [item.id, item.title, item.url]),
    [
      ['fav1', 'Calendar', 'https://calendar.example.com/'],
      ['fav2', 'Chat', 'https://chat.example.com/']
    ]
  )
})

test('スペースは無視してピン留めを連結する（フォルダは1階層に平坦化する）', () => {
  const { pinned, stats } = parseArcSidebar(fixture())
  assert.equal(stats.spaces, 2)
  assert.deepEqual(
    pinned.map((node) => node.id),
    ['t1', 'f1', 't4', 't5'],
    'space1 → space2 の順で連結し、分割ビューは子だけが残る'
  )
  const folder = pinned.find((node) => node.id === 'f1')
  assert.equal(folder.kind, 'folder')
  assert.equal(folder.title, '仕事')
  // 入れ子のフォルダ f2 は消えるが、その中身（t3）は親へ引き上がる
  assert.deepEqual(
    folder.children.map((node) => node.id),
    ['t2', 't3']
  )
  assert.ok(
    folder.children.every((node) => node.kind === 'link'),
    'フォルダの中にフォルダが残っている'
  )
})

test('取り込んだ定義は customTitle 未設定で入る', () => {
  const { favorites, pinned } = parseArcSidebar(fixture())
  assert.ok(favorites.every((item) => item.customTitle === null))
  const flat = (nodes) =>
    nodes.flatMap((node) => (node.kind === 'folder' ? [node, ...flat(node.children)] : [node]))
  assert.ok(flat(pinned).every((node) => node.customTitle === null))
})

test('http/https でない URL は取り込まない', () => {
  const { pinned, stats } = parseArcSidebar(fixture())
  const urls = JSON.stringify(pinned)
  assert.equal(urls.includes('arc://'), false)
  assert.ok(stats.skipped >= 1)
})

test('タイトルは title → savedTitle → URL の順に落とす', () => {
  const { pinned } = parseArcSidebar(fixture())
  const noTitle = pinned.find((node) => node.id === 't1')
  assert.equal(noTitle.title, 'https://one.example.com/')
})

test('1階層を超えるフォルダは切り捨てずに親へ展開する', () => {
  // MAX_PIN_DEPTH より深いフォルダの連鎖を作る
  const depth = MAX_PIN_DEPTH + 3
  const items = ['root', { id: 'root', title: null, childrenIds: ['d0'], data: { itemContainer: {} } }]
  for (let i = 0; i < depth; i += 1) {
    items.push(`d${i}`, {
      id: `d${i}`,
      title: `階層${i}`,
      childrenIds: i === depth - 1 ? ['leaf'] : [`d${i + 1}`],
      data: { list: {} }
    })
  }
  items.push('leaf', {
    id: 'leaf',
    title: '奥のタブ',
    childrenIds: [],
    data: { tab: { savedURL: 'https://deep.example.com/' } }
  })

  const parsed = parseArcSidebar({
    sidebar: {
      containers: [
        {
          topAppsContainerIDs: [],
          spaces: ['s', { id: 's', containerIDs: ['pinned', 'root'] }],
          items
        }
      ]
    }
  })

  // 正規化（アプリが実際に読む形）まで通しても、奥のタブが残っていること
  const normalized = normalizePins({ favorites: [], pinned: parsed.pinned })
  assert.equal(JSON.stringify(normalized).includes('https://deep.example.com/'), true)
  assert.ok(parsed.stats.flattened >= 1)
  // 正規化後もフォルダは1階層まで（root 直下のフォルダの子は必ず link）
  for (const node of normalized.pinned) {
    if (node.kind !== 'folder') continue
    assert.ok(
      node.children.every((child) => child.kind === 'link'),
      'フォルダの中にフォルダが残っている'
    )
  }
})

test('2回取り込んでも増えない（冪等）', () => {
  const imported = parseArcSidebar(fixture())
  const once = mergeIntoPins({ favorites: [], pinned: [] }, imported)
  const twice = mergeIntoPins(once, parseArcSidebar(fixture()))
  assert.deepEqual(twice, once)
})

test('Nemo で自分でピン留めしたものは残る', () => {
  const mine = {
    favorites: [{ id: 'mine-f', url: 'https://mine.example.com/', title: '自分', customTitle: null }],
    pinned: [
      {
        id: 'mine-p',
        kind: 'link',
        url: 'https://mine.example.com/p',
        title: '自分のピン',
        customTitle: null
      }
    ]
  }
  const merged = mergeIntoPins(mine, parseArcSidebar(fixture()))
  assert.ok(merged.favorites.some((item) => item.id === 'mine-f'))
  assert.equal(merged.pinned[0].id, 'mine-p', '既存が先、取り込んだ分が後ろ')
  assert.ok(merged.pinned.some((node) => node.id === 't1'))
})

test('Arc の JSON でなければ分かる形で失敗する', () => {
  assert.throws(() => parseArcSidebar({}), /sidebar\.containers/)
  assert.throws(() => parseArcSidebar({ sidebar: { containers: [{ global: {} }] } }), /items \/ spaces/)
})

test('取り込んだ Favorites は全部 tools に入り、faviconUrl は空', () => {
  const { favorites, pinned } = parseArcSidebar(fixture())
  assert.ok(favorites.length > 0)
  assert.ok(favorites.every((item) => item.section === 'tools' && item.faviconUrl === null))
  const links = pinned.flatMap((node) => (node.kind === 'folder' ? node.children : [node]))
  assert.ok(links.every((node) => node.faviconUrl === null))
})
