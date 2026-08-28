import test from 'node:test'
import assert from 'node:assert/strict'
import { definitionsRemovedBySlot, flattenDefinitions } from '../src/shared/slot-apply.js'

const fav = (id, url, title = id, customTitle = null) => ({ id, url, title, customTitle })
const link = (id, url, title = id, customTitle = null) => ({
  id,
  kind: 'link',
  url,
  title,
  customTitle
})
const folder = (id, children, title = id, customTitle = null) => ({
  id,
  kind: 'folder',
  title,
  customTitle,
  collapsed: false,
  children
})

/** 典型的な「今の状態」。フォルダの中にもリンクを入れておく。 */
function current() {
  return {
    favorites: [fav('f1', 'https://fav1.example/'), fav('f2', 'https://fav2.example/')],
    pinned: [
      link('p1', 'https://pin1.example/'),
      folder('dir', [link('p2', 'https://pin2.example/', 'ピン2', '私の名前')])
    ]
  }
}

const ids = (removed) => removed.map((item) => item.id).sort()

test('同じ内容を読み込んだら降格対象は 0 件', () => {
  // 自分の Mac で保存した枠を読み直したケース。ID がそのまま一致する。
  // ここで全部降格させると「定義は残ったまま同じ URL の一時タブが並ぶ」になる。
  assert.deepEqual(definitionsRemovedBySlot(current(), current()), [])
})

test('別 Mac のスロット（ID の総入れ替え）は全件が対象', () => {
  const after = {
    favorites: [fav('x1', 'https://fav1.example/')],
    pinned: [link('x2', 'https://pin1.example/')]
  }
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), after)), ['dir', 'f1', 'f2', 'p1', 'p2'])
})

test('フォルダごと消えると子孫も対象になり、名前を保つ', () => {
  const after = { favorites: current().favorites, pinned: [link('p1', 'https://pin1.example/')] }
  const removed = definitionsRemovedBySlot(current(), after)
  assert.deepEqual(ids(removed), ['dir', 'p2'])
  // 降格したタブに写す名前の出どころはここしかない
  const child = removed.find((item) => item.id === 'p2')
  assert.equal(child.title, 'ピン2')
  assert.equal(child.customTitle, '私の名前')
})

test('同じ ID がピン留め ⇄ お気に入りに移ったら対象になる', () => {
  const after = {
    favorites: [...current().favorites, fav('p1', 'https://pin1.example/')],
    pinned: [folder('dir', [link('p2', 'https://pin2.example/')])]
  }
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), after)), ['p1'])
})

test('同じ ID で URL が変わったら対象になる', () => {
  const after = {
    favorites: current().favorites,
    pinned: [link('p1', 'https://changed.example/'), folder('dir', [link('p2', 'https://pin2.example/')])]
  }
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), after)), ['p1'])
})

test('同じ ID で link が folder になったら対象になる', () => {
  const after = {
    favorites: current().favorites,
    pinned: [folder('p1', []), folder('dir', [link('p2', 'https://pin2.example/')])]
  }
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), after)), ['p1'])
})

test('お気に入りの URL が変わっても対象になる', () => {
  const after = {
    favorites: [fav('f1', 'https://moved.example/'), fav('f2', 'https://fav2.example/')],
    pinned: current().pinned
  }
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), after)), ['f1'])
})

test('空のスロットを読み込んだら全件が対象', () => {
  assert.deepEqual(ids(definitionsRemovedBySlot(current(), { favorites: [], pinned: [] })), [
    'dir',
    'f1',
    'f2',
    'p1',
    'p2'
  ])
})

test('何も無いところへ読み込んでも落ちない', () => {
  assert.deepEqual(definitionsRemovedBySlot({ favorites: [], pinned: [] }, current()), [])
})

test('flattenDefinitions はフォルダ自身も子孫も拾う', () => {
  const entries = flattenDefinitions(current().favorites, current().pinned)
  assert.deepEqual([...entries.keys()].sort(), ['dir', 'f1', 'f2', 'p1', 'p2'])
  assert.equal(entries.get('dir').kind, 'pinned-folder')
  assert.equal(entries.get('dir').url, null)
  assert.equal(entries.get('f1').kind, 'favorite')
  assert.equal(entries.get('p2').kind, 'pinned-link')
})
