import { randomUUID } from 'node:crypto'
import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import {
  MAX_CUSTOM_ICON_LENGTH,
  PINS_VERSION,
  isImageIcon,
  normalizeCustomIcon,
  normalizeCustomTitle,
  normalizeDefinitionFaviconUrl,
  normalizeFavoriteSection,
  normalizePins,
  normalizeStoredUrl
} from '../../shared/settings-schema.js'
import { definitionsRemovedBySlot } from '../../shared/slot-apply.js'
import type {
  FavoriteItem,
  FavoriteSection,
  PinnedFolder,
  PinnedLink,
  PinnedNode,
  RemovedDefinition
} from '../../shared/types.js'

/**
 * Favorites / ピン留めの**定義**（全ウィンドウ共有・永続化）。
 *
 * ここにあるのは「定義」だけで、開いているタブ実体は registry 側が持つ。
 * 両者を同じ ID で扱うと、ピン留めタブを閉じた瞬間に定義まで消えてしまう。
 */

export interface PinsData {
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

/**
 * ピン留め定義を作る（同じ URL が既にあればそれを返す）。
 *
 * `customTitle` は**渡されたときだけ**入れる。常に null に倒すと、
 * リネーム済みの一時タブをピン留めしたときに付けた名前が消える。
 */
export function pinUrl(url: string, title: string, customTitle?: string | null): PinnedNode | null {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return null
  const existing = findPinnedByUrl(normalized)
  if (existing) return existing

  const node: PinnedNode = {
    id: randomUUID(),
    kind: 'link',
    title: title || normalized,
    customTitle: normalizeCustomTitle(customTitle),
    url: normalized,
    faviconUrl: null,
    customIcon: null
  }
  commit({ ...data(), pinned: [...data().pinned, node] })
  log('pin.added', { id: node.id })
  return node
}

/**
 * ピン留め定義を消す。
 *
 * **消えた定義を（フォルダなら子孫も含めて）名前ごと返す**のが肝。
 * 呼び出し側は「定義が消えたタブ」の紐付けを外し、**その定義に付いていた名前を
 * タブへ写す**必要がある。ID しか返さないと降格したタブの名前が消え、
 * 子孫を返さないとフォルダ削除の巻き添えぶんを取りこぼす。取りこぼしたタブは
 * サイドバーのどの層にも出なくなり、再起動しても直らない。
 */
export function unpin(id: string): RemovedDefinition[] {
  const result = removeNode(data().pinned, id)
  if (!result.node) return []
  const removed = collectDefinitions(result.node)
  commit({ ...data(), pinned: result.nodes })
  log('pin.removed', { id, removed: removed.length })
  return removed
}

/** ノードとその子孫の「ID と名前」をすべて集める。 */
function collectDefinitions(node: PinnedNode): RemovedDefinition[] {
  const self: RemovedDefinition = { id: node.id, title: node.title, customTitle: node.customTitle }
  if (node.kind !== 'folder') return [self]
  return [self, ...node.children.flatMap(collectDefinitions)]
}

/** フォルダは **root 直下だけ**（1階層）。 */
export function createFolder(title: string, customTitle?: string | null): PinnedFolder {
  const folder: PinnedFolder = {
    id: randomUUID(),
    kind: 'folder',
    title: title || '新しいフォルダ',
    customTitle: normalizeCustomTitle(customTitle),
    collapsed: false,
    children: []
  }
  commit({ ...data(), pinned: [...data().pinned, folder] })
  return folder
}

/**
 * ユーザーが付けた名前を書き換える（ピン / フォルダ / Favorite を同じ経路で扱う）。
 *
 * `null` / 空文字は**解除**で、表示は既定名（`title`）に戻る。
 * 既定名の側は触らない。ここを分けないと「解除したときに戻る先」が無くなる。
 */
export function renameNode(id: string, title: string | null): void {
  const custom = normalizeCustomTitle(title)
  const rename = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.id === id) return { ...node, customTitle: custom }
      if (node.kind === 'folder') return { ...node, children: rename(node.children) }
      return node
    })
  const favorites = data().favorites.map((item) => (item.id === id ? { ...item, customTitle: custom } : item))
  commit({ favorites, pinned: rename(data().pinned) })
  log('definition.renamed', { id, cleared: custom === null })
}

/**
 * ユーザーが上書きするアイコンを書き換える（ピン / Favorite。フォルダには付かない）。
 *
 * **明示的な `null` だけが解除**。それ以外で `normalizeCustomIcon` を通らない値
 * （上限超え・PNG 以外・2 文字以上）は**既存のアイコンを消さずに** false を返す。
 * 不正値を null に倒して書くと「消えた」と「拒否した」が区別できず、
 * 上限を超えた画像を落としただけで前のアイコンが消える。
 */
export function setCustomIcon(id: string, icon: string | null): boolean {
  const custom = icon === null ? null : normalizeCustomIcon(icon)
  if (icon !== null && custom === null) {
    log('definition.icon_rejected', {
      id,
      reason: icon.length > MAX_CUSTOM_ICON_LENGTH ? 'too_long' : 'invalid'
    })
    return false
  }
  let found = false
  const apply = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.kind === 'folder') return { ...node, children: apply(node.children) }
      if (node.id !== id) return node
      found = true
      return { ...node, customIcon: custom }
    })
  const pinned = apply(data().pinned)
  const favorites = data().favorites.map((item) => {
    if (item.id !== id) return item
    found = true
    return { ...item, customIcon: custom }
  })
  if (!found) return false
  commit({ favorites, pinned })
  log('definition.icon_changed', {
    id,
    kind: custom === null ? null : isImageIcon(custom) ? 'image' : 'emoji'
  })
  return true
}

/**
 * ページタイトルが取れたときに**既定名だけ**を更新する（`customTitle` は触らない）。
 *
 * 中身が変わらないなら書かない。ピンのタブを開くたびに
 * `page-title-updated` が何度も飛ぶので、素通しにすると pins.json を書き続ける。
 */
export function setPinnedTitle(id: string, title: string): void {
  const next = title.trim().slice(0, 300)
  if (!next) return
  let changed = false
  const apply = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.id === id) {
        if (node.title === next) return node
        changed = true
        return { ...node, title: next }
      }
      if (node.kind === 'folder') return { ...node, children: apply(node.children) }
      return node
    })
  const pinned = apply(data().pinned)
  const favorites = data().favorites.map((item) => {
    if (item.id !== id || item.title === next) return item
    changed = true
    return { ...item, title: next }
  })
  if (!changed) return
  commit({ favorites, pinned })
}

/**
 * 定義（ピン / Favorite）の URL を差し替える
 * （コンテキストメニューの「このページに更新」と「URLを変更…」）。
 *
 * **別の定義（ピン・Favorite のどちらか）が既にその URL を持っていたら何もしない**。
 * 「同じ URL を二重に置かない」不変（`findPinnedByUrl` と registry の
 * `findFavoriteByUrl` が支えている）をここで壊すと、同じ URL の枠が2つ並んで
 * どちらから開いたかで別タブになる。
 *
 * host が変わったら `faviconUrl` を捨てる。`setFaviconForDefinition` は
 * 「ページの host = 定義の host」のときしか書かないので、残すと前のサイトの
 * アイコンのまま次にタブを開いても直らない。
 */
export function setDefinitionUrl(id: string, url: string): boolean {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return false
  const pin = findPinned(id)
  if (pin && pin.kind !== 'link') return false
  const target: PinnedLink | FavoriteItem | null = pin?.kind === 'link' ? pin : findFavorite(id)
  if (!target) return false
  if (target.url === normalized) return true
  const pinConflict = findPinnedByUrl(normalized)
  const favoriteConflict = data().favorites.find((item) => item.url === normalized)
  if ((pinConflict && pinConflict.id !== id) || (favoriteConflict && favoriteConflict.id !== id)) {
    log('definition.url_update_rejected', { id, reason: 'duplicate_url' })
    return false
  }
  const faviconUrl = hostOf(target.url) === hostOf(normalized) ? target.faviconUrl : null
  const apply = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.kind === 'folder') return { ...node, children: apply(node.children) }
      if (node.id !== id) return node
      return { ...node, url: normalized, faviconUrl }
    })
  const favorites = data().favorites.map((item) =>
    item.id === id ? { ...item, url: normalized, faviconUrl } : item
  )
  commit({ favorites, pinned: apply(data().pinned) })
  log('definition.url_updated', { id, kind: pin ? 'pin' : 'favorite' })
  return true
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
    // フォルダは1階層まで。フォルダをフォルダの中へは入れられない
    if (target.kind === 'folder') {
      log('pin.move_rejected', { id, reason: 'folder_into_folder' })
      return
    }
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

/**
 * Favorite 定義を作る（同じ URL が既にあればそれを返す）。
 * `customTitle` は `pinUrl` と同じく**渡されたときだけ**入れる。
 */
export function addFavorite(url: string, title: string, customTitle?: string | null): FavoriteItem | null {
  const normalized = normalizeStoredUrl(url)
  if (!normalized) return null
  const current = data()
  const existing = current.favorites.find((item) => item.url === normalized)
  if (existing) return existing
  const item: FavoriteItem = {
    id: randomUUID(),
    url: normalized,
    title: title || normalized,
    customTitle: normalizeCustomTitle(customTitle),
    // 追加経路は全部 `tools`（グリッドへの明示的なドロップだけ `moveFavorite` で落とした側へ）
    section: 'tools',
    faviconUrl: null,
    customIcon: null
  }
  commit({ ...current, favorites: [...current.favorites, item] })
  log('favorite.added', { id: item.id })
  return item
}

/** Favorite 定義を消す。`unpin` と対称に**消えた定義を名前ごと**返す。 */
export function removeFavorite(id: string): RemovedDefinition[] {
  const current = data()
  const removed = current.favorites.find((item) => item.id === id)
  if (!removed) return []
  commit({ ...current, favorites: current.favorites.filter((item) => item.id !== id) })
  log('favorite.removed', { id })
  return [{ id: removed.id, title: removed.title, customTitle: removed.customTitle }]
}

export function findFavorite(id: string): FavoriteItem | null {
  return data().favorites.find((item) => item.id === id) ?? null
}

/**
 * Favorite を `section` の `index` 番目へ置く（グリッド間の D&D と右クリックの「◯◯ へ移動」）。
 *
 * `index` は**セクション内の相対位置**（グリッドが数えられるのはそれだけ）。
 * `favorites` はセクション混在のフラット配列なので、ここで実位置に解く。
 * 規則は「抜いてから、そのセクションの `index` 番目の要素の手前に挿す」。
 * 手前に置く相手が無ければ（末尾・省略・そのセクションが空）そのセクションの最後の要素の直後、
 * セクションが空なら配列の末尾。**他のセクションの並びは動かさない**。
 */
export function moveFavorite(id: string, section: FavoriteSection, index?: number): void {
  const current = data()
  const from = current.favorites.findIndex((item) => item.id === id)
  if (from === -1) return
  const rest = current.favorites.filter((item) => item.id !== id)
  const item = current.favorites[from]
  if (!item) return
  const moved: FavoriteItem = { ...item, section: normalizeFavoriteSection(section) }
  const peers = rest.filter((item) => item.section === moved.section)
  const target = index !== undefined && Number.isInteger(index) && index >= 0 ? peers[index] : undefined
  let insertAt: number
  if (target) insertAt = rest.indexOf(target)
  else if (peers.length > 0) insertAt = rest.lastIndexOf(peers[peers.length - 1]) + 1
  else insertAt = rest.length
  const favorites = [...rest]
  favorites.splice(insertAt, 0, moved)
  commit({ ...current, favorites })
  // `at` はフラット配列の位置（引数の `index` はセクション内相対。混同しないよう名前を分ける）
  log('favorite.moved', { id, section: moved.section, at: insertAt })
}

/**
 * ページが申告した favicon を、そのタブが属する定義（Favorite / ピン留め）へ写す。
 *
 * **ページの host が定義の host と違うときは書かない**。ピン留めのタブで別サイトへ
 * 遷移しただけで、ブックマークのアイコンが別サイトのものに化けるのを防ぐ
 * （タイトルの `setPinnedTitle` は追従させているが、アイコンは「どのサイトか」の目印なので別扱い）。
 *
 * 値が同じなら書かない（`page-favicon-updated` はタブを開くたびに何度も飛ぶ）。
 */
export function setFaviconForDefinition(id: string, faviconUrl: string, pageUrl: string): void {
  const next = normalizeDefinitionFaviconUrl(faviconUrl)
  if (!next) return
  const pageHost = hostOf(pageUrl)
  if (!pageHost) return
  let changed = false
  const apply = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.kind === 'folder') return { ...node, children: apply(node.children) }
      if (node.id !== id || node.faviconUrl === next || hostOf(node.url) !== pageHost) return node
      changed = true
      return { ...node, faviconUrl: next }
    })
  const pinned = apply(data().pinned)
  const favorites = data().favorites.map((item) => {
    if (item.id !== id || item.faviconUrl === next || hostOf(item.url) !== pageHost) return item
    changed = true
    return { ...item, faviconUrl: next }
  })
  if (!changed) return
  commit({ favorites, pinned })
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/**
 * favicon を持たない定義を履歴から埋める（起動時に 1 回）。
 *
 * `section` / `faviconUrl` を足す前から使っていたデータは全部 null で来る。タブを開けば
 * `setFaviconForDefinition` で入るが、「開くまで頭文字」を直したいのがそもそもの動機なので、
 * 履歴 DB に残っている favicon で先に埋める。`lookup` は URL → favicon（完全一致か同 host）。
 *
 * @returns 埋めた件数
 */
export function backfillFavicons(lookup: (urls: string[]) => Map<string, string>): number {
  const current = data()
  const urls: string[] = []
  current.favorites.forEach((item) => {
    if (!item.faviconUrl) urls.push(item.url)
  })
  const collect = (nodes: PinnedNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'folder') collect(node.children)
      else if (!node.faviconUrl) urls.push(node.url)
    }
  }
  collect(current.pinned)
  if (urls.length === 0) return 0
  const found = lookup([...new Set(urls)])
  if (found.size === 0) return 0
  let filled = 0
  const pick = (url: string): string | null => {
    const value = normalizeDefinitionFaviconUrl(found.get(url))
    if (value) filled += 1
    return value
  }
  const apply = (nodes: PinnedNode[]): PinnedNode[] =>
    nodes.map((node) => {
      if (node.kind === 'folder') return { ...node, children: apply(node.children) }
      if (node.faviconUrl) return node
      const faviconUrl = pick(node.url)
      return faviconUrl ? { ...node, faviconUrl } : node
    })
  const pinned = apply(current.pinned)
  const favorites = current.favorites.map((item) => {
    if (item.faviconUrl) return item
    const faviconUrl = pick(item.url)
    return faviconUrl ? { ...item, faviconUrl } : item
  })
  if (filled === 0) return 0
  commit({ favorites, pinned })
  log('pins.favicons_backfilled', { filled, missing: urls.length - filled })
  return filled
}

/**
 * 旧形式（`section` を持たない）スロットの Favorites に、**今の振り分けを引き継ぐ**。
 * 同じ URL の Favorite が今あればその section、無ければ `tools`（正規化の既定のまま）。
 */
export function inheritSections(favorites: FavoriteItem[]): FavoriteItem[] {
  const current = new Map(data().favorites.map((item) => [item.url, item.section] as const))
  return favorites.map((item) => {
    const section = current.get(item.url)
    return section && section !== item.section ? { ...item, section } : item
  })
}

/**
 * ピン留めとお気に入りを**丸ごと差し替える**（セーブスロットの読み込み）。
 *
 * - **`JsonStore.commit()` を使う。** `set()` は 400ms デバウンスで書き込み失敗を握り潰すので、
 *   「元に戻せません」と言って実行する操作には向かない（IPC が成功を返したあとに落ちうる）
 * - **旧定義のスナップショットは `commit(mutate)` の中で取る。** `commit()` はキューで
 *   直列化され、常に直前の commit 済み値から次を作る。外で読んでから渡すと、
 *   間に入った更新（ピン追加など）を降格判定が取りこぼす
 * - **書けたときだけ `listeners` を叩く。** ここはローカルの `commit()` を通らないので、
 *   忘れると `onPinsChanged` が発火せず、差し替えたのにサイドバーが古いまま残る
 *   （`demoteEverywhere` はタブが変わったウィンドウしか `pushState()` しない）
 *
 * @returns 消えた定義（＝降格させるタブの名前の出どころ）。書き込みに失敗したら null
 */
export async function replaceAll(next: PinsData): Promise<RemovedDefinition[] | null> {
  if (!store) return null
  /** @see definitionsRemovedBySlot 「同じ ID・同じ種別・同じ URL」で残らないものが消えた扱い */
  let removed: RemovedDefinition[] = []
  const written = await store.commit((current) => {
    removed = definitionsRemovedBySlot(current, next)
    return next
  })
  if (!written) {
    log('pins.replace_failed', {})
    return null
  }
  for (const listener of listeners) listener()
  log('pins.replaced', {
    favorites: next.favorites.length,
    pinned: next.pinned.length,
    removed: removed.length
  })
  return removed
}

export function closePins(): void {
  store?.close()
  store = null
}

/* ------------------------------------------------------------------ *
 * ピン留め ⇄ Favorites の変換
 *
 * 「定義ごと移す」。所属だけ付け替えると同じ URL が両方の枠に残り、
 * どちらから開いたかで別タブになる。
 *
 * **名前を読む → 移動先を作る or 再利用する → 元定義を消す**までを1つの関数で行い、
 * 「消えた定義（名前つき）」と「移動先の定義」を返す。呼び出し側（registry）は
 * その戻り値だけで全ウィンドウのタブの所属を1度に付け替えられる。
 * 先に `unpin` / `removeFavorite` を呼ぶと名前を読む前に定義が消え、
 * 逆順にすると削除が 0 件になって他ウィンドウの所属が外れない。
 * ------------------------------------------------------------------ */

export interface ConversionResult {
  /** 変換で消えた定義（＝他ウィンドウのタブを降格させるときの名前の出どころ）。 */
  removedDefinitions: RemovedDefinition[]
  /** 変換先の定義。 */
  target: RemovedDefinition
}

/** ピン留め → Favorites。 */
export function convertPinToFavorite(id: string): ConversionResult | null {
  const node = findPinned(id)
  if (!node || node.kind !== 'link') return null
  const current = data()
  const removal = removeNode(current.pinned, id)
  const removedDefinitions = removal.node ? collectDefinitions(removal.node) : []

  // 同じ URL の Favorite が既にあれば再利用し、名前は**既存側を優先**する
  // （明示的に付けた名前を、変換のついでに上書きしない）。
  const existing = current.favorites.find((item) => item.url === node.url)
  const target: FavoriteItem = existing ?? {
    id: randomUUID(),
    url: node.url,
    title: node.title,
    customTitle: node.customTitle,
    section: 'tools',
    // アイコンも名前と同じく移す（`null` で埋めると右クリック 1 回で頭文字に戻り、次の起動まで直らない）
    faviconUrl: node.faviconUrl,
    customIcon: node.customIcon
  }
  const favorites = existing ? current.favorites : [...current.favorites, target]
  commit({ favorites, pinned: removal.nodes })
  log('pin.converted_to_favorite', { from: id, to: target.id, reused: Boolean(existing) })
  return {
    removedDefinitions,
    target: { id: target.id, title: target.title, customTitle: target.customTitle }
  }
}

/** Favorites → ピン留め。 */
export function convertFavoriteToPin(id: string): ConversionResult | null {
  const item = findFavorite(id)
  if (!item) return null
  const current = data()
  const favorites = current.favorites.filter((favorite) => favorite.id !== id)

  const existing = findPinnedByUrl(item.url)
  const target: PinnedLink =
    existing && existing.kind === 'link'
      ? existing
      : {
          id: randomUUID(),
          kind: 'link',
          title: item.title,
          customTitle: item.customTitle,
          url: item.url,
          faviconUrl: item.faviconUrl,
          customIcon: item.customIcon
        }
  const reused = existing?.kind === 'link'
  const pinned = reused ? current.pinned : [...current.pinned, target]
  commit({ favorites, pinned })
  log('favorite.converted_to_pin', { from: id, to: target.id, reused })
  return {
    removedDefinitions: [{ id: item.id, title: item.title, customTitle: item.customTitle }],
    target: { id: target.id, title: target.title, customTitle: target.customTitle }
  }
}
