// @ts-check
/**
 * Arc の `StorableSidebar.json` を Nemo のデータモデルへ変換する（計画 2-2）。
 *
 * Arc の保存形式で押さえておくこと:
 * - `sidebar.containers[1]` に `items` / `spaces` / `topAppsContainerIDs` がある
 * - これらの配列は **`[id, オブジェクト, id, オブジェクト, ...]` の交互並び**。
 *   文字列だけ拾っても、オブジェクトだけ拾っても、片側の情報しか得られない
 * - `items` の1件は `data` の中身で種類が決まる:
 *   - `data.tab` … タブ（`savedURL` / `savedTitle`）
 *   - `data.list` … フォルダ
 *   - `data.itemContainer` … スペースの「ピン留め」「一時タブ」やお気に入りの入れ物
 *   - `data.splitView` … 分割ビュー（子がタブ）。Nemo に対応物が無いので**子を平らに展開する**
 * - スペースは**無視してフラット化する**（計画の決定事項）。複数スペースのピン留めは順に連結する
 *
 * Electron 非依存にして `scripts/arc-import.test.mjs` から直接テストする。
 */
import { MAX_PIN_DEPTH, normalizeStoredUrl } from './settings-schema.js'

/**
 * Arc の交互並び配列から、オブジェクトだけを取り出して id で引ける表にする。
 * @param {unknown} list
 * @returns {Map<string, any>}
 */
function indexById(list) {
  /** @type {Map<string, any>} */
  const map = new Map()
  if (!Array.isArray(list)) return map
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string') {
      map.set(entry.id, entry)
    }
  }
  return map
}

/**
 * 交互並び配列から「id 文字列」だけを取り出す。
 * `topAppsContainerIDs` は `[{ default: true }, "<id>"]` のように
 * **マーカーのオブジェクトと id が交互**に入っている。
 * @param {unknown} list
 * @returns {string[]}
 */
function idsOf(list) {
  if (!Array.isArray(list)) return []
  return list.filter((entry) => typeof entry === 'string')
}

/**
 * Arc のスペース定義から「ピン留めコンテナの id」を取り出す。
 * `containerIDs` は `['pinned', '<id>', 'unpinned', '<id>']` の並び。
 * @param {any} space
 * @returns {string | null}
 */
function pinnedContainerIdOf(space) {
  const ids = space?.containerIDs
  if (!Array.isArray(ids)) return null
  const index = ids.indexOf('pinned')
  if (index === -1) return null
  const value = ids[index + 1]
  return typeof value === 'string' ? value : null
}

/** @param {any} item */
function titleOf(item) {
  const own = typeof item?.title === 'string' ? item.title.trim() : ''
  if (own) return own
  const saved = item?.data?.tab?.savedTitle
  return typeof saved === 'string' ? saved.trim() : ''
}

/**
 * Arc の `StorableSidebar.json` を Nemo の Favorites / ピン留めに変換する。
 *
 * @param {unknown} raw パース済みの JSON
 * @returns {{
 *   favorites: import('./types.js').FavoriteItem[],
 *   pinned: import('./types.js').PinnedNode[],
 *   stats: { spaces: number, tabs: number, folders: number, skipped: number, flattened: number }
 * }}
 */
export function parseArcSidebar(raw) {
  const containers = /** @type {any} */ (raw)?.sidebar?.containers
  if (!Array.isArray(containers)) {
    throw new Error('sidebar.containers が無い。Arc の StorableSidebar.json ではない可能性がある')
  }
  // items / spaces を持つコンテナを探す（先頭は `global` なので添字を決め打ちにしない）
  const container = containers.find(
    (entry) => entry && typeof entry === 'object' && Array.isArray(entry.items) && Array.isArray(entry.spaces)
  )
  if (!container) throw new Error('items / spaces を持つコンテナが見つからない')

  const items = indexById(container.items)
  const spaces = indexById(container.spaces)
  const stats = { spaces: 0, tabs: 0, folders: 0, skipped: 0, flattened: 0 }
  /** 同じ Arc アイテムを2回出さない（分割ビューの展開などで起こりうる）。 */
  const emitted = new Set()

  /**
   * 子 id の並びをノード列に変換する。
   * @param {unknown} childrenIds
   * @param {number} depth
   * @returns {import('./types.js').PinnedNode[]}
   */
  const walk = (childrenIds, depth) => {
    /** @type {import('./types.js').PinnedNode[]} */
    const result = []
    if (!Array.isArray(childrenIds)) return result
    for (const childId of childrenIds) {
      if (typeof childId !== 'string') continue
      const item = items.get(childId)
      if (!item) {
        stats.skipped += 1
        continue
      }
      if (emitted.has(childId)) continue
      const data = item.data ?? {}

      if (data.tab) {
        const url = normalizeStoredUrl(data.tab.savedURL)
        if (!url) {
          // Arc の内部ページ（`arc://` など）は Nemo では開けないので落とす
          stats.skipped += 1
          continue
        }
        emitted.add(childId)
        stats.tabs += 1
        result.push({ id: childId, kind: 'link', title: titleOf(item) || url, url })
        continue
      }

      if (data.list) {
        emitted.add(childId)
        // Nemo のツリーには深さの上限がある。超える分は**親に平らに展開する**
        // （切り捨てるとブックマークが黙って消える）。
        if (depth >= MAX_PIN_DEPTH) {
          stats.flattened += 1
          result.push(...walk(item.childrenIds, depth))
          continue
        }
        stats.folders += 1
        result.push({
          id: childId,
          kind: 'folder',
          title: titleOf(item) || '（無題のフォルダ）',
          collapsed: true,
          children: walk(item.childrenIds, depth + 1)
        })
        continue
      }

      // 分割ビュー・入れ子のコンテナは Nemo に対応物が無いので中身だけ引き上げる
      if (data.splitView || data.itemContainer) {
        emitted.add(childId)
        stats.flattened += 1
        result.push(...walk(item.childrenIds, depth))
        continue
      }

      // easel / 未知の種類
      stats.skipped += 1
    }
    return result
  }

  /* ---- Favorites（サイドバー上部のアイコングリッド） ---- */
  /** @type {import('./types.js').FavoriteItem[]} */
  const favorites = []
  for (const containerId of idsOf(container.topAppsContainerIDs)) {
    const node = items.get(containerId)
    if (!node) continue
    for (const child of walk(node.childrenIds, 0)) {
      if (child.kind !== 'link') continue
      favorites.push({ id: child.id, url: child.url, title: child.title })
    }
  }

  /* ---- ピン留め（スペースは無視してフラット化する） ---- */
  /** @type {import('./types.js').PinnedNode[]} */
  const pinned = []
  for (const spaceId of idsOf(container.spaces)) {
    const space = spaces.get(spaceId)
    if (!space) continue
    stats.spaces += 1
    const pinnedContainerId = pinnedContainerIdOf(space)
    if (!pinnedContainerId) continue
    const node = items.get(pinnedContainerId)
    if (!node) continue
    pinned.push(...walk(node.childrenIds, 0))
  }

  return { favorites, pinned, stats }
}

/**
 * 取り込んだ内容を既存の pins データへ**冪等に**重ねる。
 *
 * 同じ Arc アイテムを2回取り込んでも増えないよう、
 * **取り込み対象の ID を既存ツリーから先に取り除いてから**末尾に足す。
 * Arc 由来でないノード（Nemo で自分でピン留めしたもの）はそのまま残る。
 *
 * @param {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }} existing
 * @param {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }} imported
 * @returns {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }}
 */
export function mergeIntoPins(existing, imported) {
  const incoming = new Set([...imported.favorites.map((item) => item.id), ...collectIds(imported.pinned)])

  /**
   * @param {import('./types.js').PinnedNode[]} nodes
   * @returns {import('./types.js').PinnedNode[]}
   */
  const strip = (nodes) => {
    /** @type {import('./types.js').PinnedNode[]} */
    const result = []
    for (const node of nodes) {
      if (incoming.has(node.id)) continue
      if (node.kind === 'folder') result.push({ ...node, children: strip(node.children) })
      else result.push(node)
    }
    return result
  }

  return {
    favorites: [...existing.favorites.filter((item) => !incoming.has(item.id)), ...imported.favorites],
    pinned: [...strip(existing.pinned), ...imported.pinned]
  }
}

/** @param {import('./types.js').PinnedNode[]} nodes @returns {string[]} */
function collectIds(nodes) {
  return nodes.flatMap((node) =>
    node.kind === 'folder' ? [node.id, ...collectIds(node.children)] : [node.id]
  )
}
