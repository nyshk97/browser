import { randomUUID } from 'node:crypto'
import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import { PINS_VERSION, normalizePins, normalizeStoredUrl } from '../../shared/settings-schema.js'
import type { FavoriteItem, PinnedFolder, PinnedNode } from '../../shared/types.js'

/**
 * Favorites / ピン留めの**定義**（全ウィンドウ共有・永続化）。
 *
 * ここにあるのは「定義」だけで、開いているタブ実体は registry 側が持つ。
 * 両者を同じ ID で扱うと、ピン留めタブを閉じた瞬間に定義まで消えてしまう。
 */

interface PinsData {
  favorites: FavoriteItem[]
  pinned: PinnedNode[]
}

let store: JsonStore<PinsData> | null = null
const listeners = new Set<() => void>()

export function initPins(): void {
  store = new JsonStore<PinsData>(userDataPath('pins.json'), PINS_VERSION, normalizePins)
}

function data(): PinsData {
  return store?.get() ?? { favorites: [], pinned: [] }
}

function commit(next: PinsData): void {
  store?.set(next)
  for (const listener of listeners) listener()
}

export function onPinsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFavorites(): FavoriteItem[] {
  return data().favorites
}

export function getPinned(): PinnedNode[] {
  return data().pinned
}

/* ------------------------------------------------------------------ *
 * ツリー操作
 * ------------------------------------------------------------------ */

export function findPinned(id: string): PinnedNode | null {
  const walk = (nodes: PinnedNode[]): PinnedNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node
      if (node.kind === 'folder') {
        const found = walk(node.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(data().pinned)
}

/** URL からピン留め定義を引く（同じ URL を二重にピン留めしないため）。 */
export function findPinnedByUrl(url: string): PinnedNode | null {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return null
  const walk = (nodes: PinnedNode[]): PinnedNode | null => {
    for (const node of nodes) {
      if (node.kind === 'link' && node.url === normalized) return node
      if (node.kind === 'folder') {
        const found = walk(node.children)
        if (found) return found
      }
    }
    return null
  }
  return walk(data().pinned)
}

function removeNode(nodes: PinnedNode[], id: string): { node: PinnedNode | null; nodes: PinnedNode[] } {
  let removed: PinnedNode | null = null
  const next = nodes.flatMap<PinnedNode>((node) => {
    if (node.id === id) {
      removed = node
      return []
    }
    if (node.kind === 'folder') {
      const result = removeNode(node.children, id)
      if (result.node) removed = result.node
      return [{ ...node, children: result.nodes }]
    }
    return [node]
  })
  return { node: removed, nodes: next }
}

function insertNode(
  nodes: PinnedNode[],
  parentId: string | null,
  index: number,
  node: PinnedNode
): PinnedNode[] {
  if (parentId === null) {
    const next = [...nodes]
    next.splice(clampIndex(index, next.length), 0, node)
    return next
  }
  return nodes.map((current) => {
    if (current.kind !== 'folder') return current
    if (current.id === parentId) {
      const children = [...current.children]
      children.splice(clampIndex(index, children.length), 0, node)
      return { ...current, children }
    }
    return { ...current, children: insertNode(current.children, parentId, index, node) }
  })
}

function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0) return length
  return Math.min(index, length)
}

/** ノードの今の居場所（親と、その中での位置）。 */
function locate(
  nodes: PinnedNode[],
  id: string,
  parentId: string | null = null
): { parentId: string | null; index: number } | null {
  for (const [index, node] of nodes.entries()) {
    if (node.id === id) return { parentId, index }
    if (node.kind === 'folder') {
      const found = locate(node.children, id, node.id)
      if (found) return found
    }
  }
  return null
}

/** 自分自身 / 自分の子孫の中へは動かせない（動かすとツリーが消える）。 */
function isDescendant(node: PinnedNode, candidateId: string): boolean {
  if (node.id === candidateId) return true
  if (node.kind !== 'folder') return false
  return node.children.some((child) => isDescendant(child, candidateId))
}

export function pinUrl(url: string, title: string): PinnedNode | null {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return null
  const existing = findPinnedByUrl(normalized)
  if (existing) return existing

  const node: PinnedNode = { id: randomUUID(), kind: 'link', title: title || normalized, url: normalized }
  commit({ ...data(), pinned: [...data().pinned, node] })
  log('pin.added', { id: node.id })
  return node
}

/**
 * ピン留め定義を消す。
 *
 * **消えた ID を（フォルダなら子孫も含めて）返す**のが肝。
 * 呼び出し側は「定義が消えたタブ」の紐付けを外す必要があり、
 * 返さないと子孫のぶんを取りこぼす。取りこぼしたタブは
 * サイドバーのどの層にも出なくなり、再起動しても直らない。
 */
export function unpin(id: string): string[] {
  const result = removeNode(data().pinned, id)
  if (!result.node) return []
  const removed = collectIds(result.node)
  commit({ ...data(), pinned: result.nodes })
  log('pin.removed', { id, removed: removed.length })
  return removed
}

/** ノードとその子孫の ID をすべて集める。 */
function collectIds(node: PinnedNode): string[] {
  if (node.kind !== 'folder') return [node.id]
  return [node.id, ...node.children.flatMap(collectIds)]
}

export function createFolder(title: string): PinnedFolder {
  const folder: PinnedFolder = {
    id: randomUUID(),
    kind: 'folder',
    title: title || '新しいフォルダ',
    collapsed: false,
    children: []
  }
  commit({ ...data(), pinned: [...data().pinned, folder] })
  return folder
}

export function renameNode(id: string, title: string): void {
  const trimmed = title.trim().slice(0, 300)
  if (!trimmed) return
  const rename = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.id === id) return { ...node, title: trimmed }
      if (node.kind === 'folder') return { ...node, children: rename(node.children) }
      return node
    })
  const favorites = data().favorites.map((item) => (item.id === id ? { ...item, title: trimmed } : item))
  commit({ favorites, pinned: rename(data().pinned) })
}

export function toggleFolder(id: string): void {
  const toggle = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.kind !== 'folder') return node
      if (node.id === id) return { ...node, collapsed: !node.collapsed }
      return { ...node, children: toggle(node.children) }
    })
  commit({ ...data(), pinned: toggle(data().pinned) })
}

/**
 * ドラッグ & ドロップの結果を反映する。
 *
 * `index` は「**動かす前**のツリーで見た挿入位置」= その位置にある行の**手前**に入る。
 * 実装は「抜いてから挿す」なので、同じ親の中で下へ動かすときは抜いたぶん詰める。
 * 補正しないと、掴んだ場所によって落とし先が1つ前後する
 * （上から動かすと対象の後ろ・下や一時タブから動かすと対象の前になり、
 *  ドロップ線の見た目とも食い違う）。
 */
export function movePinned(id: string, parentId: string | null, index: number): void {
  const current = data()
  const target = findPinned(id)
  if (!target) return
  if (parentId !== null) {
    if (isDescendant(target, parentId)) {
      log('pin.move_rejected', { id, reason: 'into_descendant' })
      return
    }
    const parent = findPinned(parentId)
    if (!parent || parent.kind !== 'folder') return
  }
  const from = locate(current.pinned, id)
  const removed = removeNode(current.pinned, id)
  if (!removed.node) return
  const insertAt = from && from.parentId === parentId && from.index < index ? index - 1 : index
  commit({ ...current, pinned: insertNode(removed.nodes, parentId, insertAt, removed.node) })
  log('pin.moved', { id, parentId, index: insertAt })
}

/* ------------------------------------------------------------------ *
 * Favorites
 * ------------------------------------------------------------------ */

export function addFavorite(url: string, title: string): FavoriteItem | null {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return null
  const current = data()
  const existing = current.favorites.find((item) => item.url === normalized)
  if (existing) return existing
  const item: FavoriteItem = { id: randomUUID(), url: normalized, title: title || normalized }
  commit({ ...current, favorites: [...current.favorites, item] })
  log('favorite.added', { id: item.id })
  return item
}

export function removeFavorite(id: string): void {
  const current = data()
  const favorites = current.favorites.filter((item) => item.id !== id)
  if (favorites.length === current.favorites.length) return
  commit({ ...current, favorites })
  log('favorite.removed', { id })
}

export function findFavorite(id: string): FavoriteItem | null {
  return data().favorites.find((item) => item.id === id) ?? null
}

export function moveFavorite(id: string, index: number): void {
  const current = data()
  const from = current.favorites.findIndex((item) => item.id === id)
  if (from === -1) return
  const favorites = [...current.favorites]
  const [item] = favorites.splice(from, 1)
  favorites.splice(clampIndex(index, favorites.length), 0, item)
  commit({ ...current, favorites })
}

export function closePins(): void {
  store?.close()
  store = null
}
