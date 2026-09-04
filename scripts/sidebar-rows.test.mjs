import test from 'node:test'
import assert from 'node:assert/strict'
import { currentRow, rowMatchesTab, sameRow, sidebarRows, stepRow } from '../src/shared/sidebar-rows.js'

/**
 * ⌘⌥↑↓ の並び（`sidebar-rows.js`）のテスト。
 *
 * 「見えている行」だけを上から順に並べ、閉じたフォルダ・畳んだ小見出しの中身が入らないこと、
 * 両端の循環、実体化で行の形が変わっても同じ行として追えることを固定する。
 */

const link = (id) => ({
  id,
  kind: 'link',
  title: id,
  customTitle: null,
  url: `https://x/${id}`,
  faviconUrl: null,
  customIcon: null
})
const folder = (id, collapsed, children) => ({
  id,
  kind: 'folder',
  title: id,
  customTitle: null,
  collapsed,
  children
})
const tab = (over) => ({
  key: 'k',
  ephemeralId: null,
  pinnedId: null,
  favoriteId: null,
  url: 'about:blank',
  ...over
})

const base = {
  liveRows: [
    { url: 'https://github.com/acme/tools/pull/1' },
    { url: 'https://github.com/acme/tools/pull/2' }
  ],
  favorites: [
    { id: 'm1', section: 'messages' },
    { id: 't1', section: 'tools' },
    { id: 't2', section: 'tools' }
  ],
  pinned: [link('a'), folder('closed', true, [link('b')]), folder('open', false, [link('c')])],
  ephemeralRows: [
    { key: 'e0', defId: 'd0' },
    { key: 'e1', defId: 'd1' }
  ]
}

test('並びは Live Folder → tools → messages → ピン → 一時タブ', () => {
  const rows = sidebarRows(base)
  assert.deepEqual(rows, [
    { kind: 'live', url: 'https://github.com/acme/tools/pull/1' },
    { kind: 'live', url: 'https://github.com/acme/tools/pull/2' },
    { kind: 'favorite', id: 't1' },
    { kind: 'favorite', id: 't2' },
    { kind: 'favorite', id: 'm1' },
    { kind: 'pin', id: 'a' },
    { kind: 'pin', id: 'c' },
    { kind: 'ephemeral', key: 'e0', defId: 'd0' },
    { kind: 'ephemeral', key: 'e1', defId: 'd1' }
  ])
})

test('閉じたフォルダの中身は入らず、開いたフォルダの中身は入る（フォルダ行自体は入らない）', () => {
  const ids = sidebarRows(base)
    .filter((row) => row.kind === 'pin')
    .map((row) => row.id)
  assert.deepEqual(ids, ['a', 'c'])
  const opened = sidebarRows({ ...base, pinned: [link('a'), folder('closed', false, [link('b')])] })
    .filter((row) => row.kind === 'pin')
    .map((row) => row.id)
  assert.deepEqual(opened, ['a', 'b'])
})

test('畳んだ小見出しの行は呼び出し側が渡さない（liveRows が空なら Live 行は 0 本）', () => {
  const rows = sidebarRows({ ...base, liveRows: [] })
  assert.equal(rows.filter((row) => row.kind === 'live').length, 0)
  assert.equal(rows[0].kind, 'favorite')
})

test('分割ペアは呼び出し側が [left, right] の 2 行で渡し、そのまま 2 ステップになる', () => {
  const rows = sidebarRows({
    ...base,
    ephemeralRows: [
      { key: 'left', defId: 'dl' },
      { key: 'right', defId: 'dr' },
      { key: 'e2', defId: null }
    ]
  })
  const keys = rows.filter((row) => row.kind === 'ephemeral').map((row) => row.key)
  assert.deepEqual(keys, ['left', 'right', 'e2'])
})

test('stepRow: 両端で循環する', () => {
  const rows = sidebarRows(base)
  const last = rows[rows.length - 1]
  assert.deepEqual(stepRow(rows, last, 1), rows[0])
  assert.deepEqual(stepRow(rows, rows[0], -1), last)
  assert.deepEqual(stepRow(rows, rows[2], 1), rows[3])
  assert.deepEqual(stepRow(rows, rows[3], -1), rows[2])
})

test('stepRow: 現在位置が無ければ ↓ は先頭・↑ は末尾、rows が空なら null', () => {
  const rows = sidebarRows(base)
  assert.deepEqual(stepRow(rows, null, 1), rows[0])
  assert.deepEqual(stepRow(rows, null, -1), rows[rows.length - 1])
  // 行を閉じて rows から消えた `from` も「無い」扱い
  assert.deepEqual(stepRow(rows, { kind: 'ephemeral', key: 'gone', defId: null }, 1), rows[0])
  assert.equal(stepRow([], null, 1), null)
  assert.equal(stepRow([], { kind: 'pin', id: 'a' }, -1), null)
})

test('currentRow: key → ephemeralId → pinnedId → favoriteId → PR URL の順で先勝ち', () => {
  const rows = sidebarRows(base)
  assert.deepEqual(currentRow(rows, tab({ key: 'e1' })), { kind: 'ephemeral', key: 'e1', defId: 'd1' })
  assert.deepEqual(currentRow(rows, tab({ key: 'other', ephemeralId: 'd0' })), {
    kind: 'ephemeral',
    key: 'e0',
    defId: 'd0'
  })
  assert.deepEqual(currentRow(rows, tab({ pinnedId: 'c' })), { kind: 'pin', id: 'c' })
  assert.deepEqual(currentRow(rows, tab({ favoriteId: 'm1' })), { kind: 'favorite', id: 'm1' })
  assert.deepEqual(currentRow(rows, tab({ url: 'https://github.com/acme/tools/pull/2?x=1#c' })), {
    kind: 'live',
    url: 'https://github.com/acme/tools/pull/2'
  })
  // 閉じたフォルダの中のピンは行が無い
  assert.equal(currentRow(rows, tab({ pinnedId: 'b' })), null)
  assert.equal(currentRow(rows, null), null)
})

test('currentRow: 分割の相方が PR の URL でも結合行側（ephemeral 行）が勝つ', () => {
  const rows = sidebarRows({
    ...base,
    ephemeralRows: [
      { key: 'left', defId: 'dl' },
      { key: 'right', defId: 'dr' }
    ]
  })
  const right = tab({ key: 'right', ephemeralId: 'dr', url: 'https://github.com/acme/tools/pull/1' })
  assert.deepEqual(currentRow(rows, right), { kind: 'ephemeral', key: 'right', defId: 'dr' })
  assert.equal(rowMatchesTab(rows[0], right), true)
})

test('sameRow: def 行が実体化しても、ローカル行が定義を得ても同じ行として追える', () => {
  // 閉じた共有定義の行（実体なし）→ 実体化（key が付く）
  assert.equal(
    sameRow({ kind: 'ephemeral', key: null, defId: 'd' }, { kind: 'ephemeral', key: 'k', defId: 'd' }),
    true
  )
  // ローカルの about:blank（定義なし）→ 定義を得る（defId が付く）
  assert.equal(
    sameRow({ kind: 'ephemeral', key: 'k', defId: null }, { kind: 'ephemeral', key: 'k', defId: 'd' }),
    true
  )
  // 両方 null 同士は一致にしない
  assert.equal(
    sameRow({ kind: 'ephemeral', key: null, defId: null }, { kind: 'ephemeral', key: null, defId: null }),
    false
  )
  assert.equal(
    sameRow({ kind: 'ephemeral', key: 'a', defId: null }, { kind: 'ephemeral', key: 'b', defId: null }),
    false
  )
  // 種類が違えば ID が同じでも別
  assert.equal(sameRow({ kind: 'pin', id: 'x' }, { kind: 'favorite', id: 'x' }), false)
  assert.equal(sameRow({ kind: 'live', url: 'u' }, { kind: 'live', url: 'u' }), true)
})

test('stepRow: 実体化で形が変わった from からでも次の行へ進む（先頭へ飛ばない）', () => {
  const before = sidebarRows({
    ...base,
    ephemeralRows: [
      { key: 'e0', defId: 'd0' },
      { key: null, defId: 'remote' },
      { key: 'e2', defId: 'd2' }
    ]
  })
  const target = stepRow(before, { kind: 'ephemeral', key: 'e0', defId: 'd0' }, 1)
  assert.deepEqual(target, { kind: 'ephemeral', key: null, defId: 'remote' })
  // 実体化後の rows（remote に key が付いた）
  const after = sidebarRows({
    ...base,
    ephemeralRows: [
      { key: 'e0', defId: 'd0' },
      { key: 'e1', defId: 'remote' },
      { key: 'e2', defId: 'd2' }
    ]
  })
  assert.deepEqual(stepRow(after, target, 1), { kind: 'ephemeral', key: 'e2', defId: 'd2' })
  // ローカル行が定義を得た場合も同様
  const local = stepRow(after, { kind: 'ephemeral', key: 'e1', defId: null }, 1)
  assert.deepEqual(local, { kind: 'ephemeral', key: 'e2', defId: 'd2' })
})
