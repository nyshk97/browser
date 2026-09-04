// @ts-check
/**
 * ⌘⌥↑ / ⌘⌥↓ でサイドバーの行を縦に渡るための純粋関数。
 *
 * **見た目の並びを知っているのは renderer だけ**（Live Folder の小見出しの開閉は renderer の state、
 * Favorites はグリッド、分割は左タブの位置に結合行 1 つ）なので、main の `next-tab`
 * （`win.normalTabs` の内部配列順）とは別にここで「見えている行」を並べ、Sidebar が行き先を決める。
 *
 * Electron 非依存。`scripts/sidebar-rows.test.mjs` から直接テストする。
 * `settings-schema.js` は `node:fs` に届くので import しない（renderer から読める範囲に留める）。
 */
import { FAVORITE_SECTIONS } from './favorites.js'
import { normalizePrUrl } from './live-folder-schema.js'

/**
 * サイドバーの 1 行。
 *
 * 一時タブ由来の行は 1 種類にまとめ、`key`（このウィンドウの実体）と `defId`（全ウィンドウ共有の定義）を
 * **両方**持つ。閉じた共有定義の行を通過して実体化した瞬間に `key` が付き、ローカルの `about:blank` が
 * 定義を得た瞬間に `defId` が付くが、どちらか一致で同じ行として追える（`sameRow`）。
 *
 * @typedef {{ kind: 'live', url: string }
 *   | { kind: 'favorite', id: string }
 *   | { kind: 'pin', id: string }
 *   | { kind: 'ephemeral', key: string | null, defId: string | null }} SidebarRow
 */

/**
 * @typedef {object} SidebarRowsInput
 * @property {{ url: string }[]} liveRows 描画されている Live Folder の行（開いている小見出しの項目だけ。
 *   `liveFolderView(state).kind === 'list'` でなければ空を渡す）
 * @property {{ id: string, section: string }[]} favorites
 * @property {import('./types.js').PinnedNode[]} pinned
 * @property {{ key: string | null, defId: string | null }[]} ephemeralRows 一時タブの行（分割ペアは
 *   呼び出し側が `[left, right]` の 2 行に展開して渡す）
 */

/**
 * 見えている行を上から順に並べる。
 *
 * Live Folder → Favorites（`FAVORITE_SECTIONS` の順、グリッドは読み順）→ ピン留め（閉じたフォルダは
 * 中身ごとスキップ。フォルダ行自体は対象外）→ 一時タブ。「New Tab」行と Peek は入らない。
 *
 * @param {SidebarRowsInput} input
 * @returns {SidebarRow[]}
 */
export function sidebarRows({ liveRows, favorites, pinned, ephemeralRows }) {
  /** @type {SidebarRow[]} */
  const rows = []
  for (const item of liveRows) rows.push({ kind: 'live', url: item.url })
  for (const section of FAVORITE_SECTIONS) {
    for (const item of favorites) {
      if (item.section === section) rows.push({ kind: 'favorite', id: item.id })
    }
  }
  for (const node of pinned) {
    if (node.kind === 'link') {
      rows.push({ kind: 'pin', id: node.id })
      continue
    }
    if (node.collapsed) continue
    for (const child of node.children) {
      if (child.kind === 'link') rows.push({ kind: 'pin', id: child.id })
    }
  }
  for (const row of ephemeralRows) rows.push({ kind: 'ephemeral', key: row.key, defId: row.defId })
  return rows
}

/**
 * 同じ行か。一時タブ由来の行は `key` か `defId` の**どちらか一致**で同一
 * （両方 null 同士は一致にしない —— 実体も定義も無い行は無い）。
 *
 * @param {SidebarRow} a
 * @param {SidebarRow} b
 * @returns {boolean}
 */
export function sameRow(a, b) {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'live':
      return b.kind === 'live' && a.url === b.url
    case 'favorite':
    case 'pin':
      return (b.kind === 'favorite' || b.kind === 'pin') && a.id === b.id
    case 'ephemeral':
      if (b.kind !== 'ephemeral') return false
      if (a.key !== null && a.key === b.key) return true
      if (a.defId !== null && a.defId === b.defId) return true
      return false
    default:
      return false
  }
}

/**
 * 行とタブの照合の段階。**この順に強い**（`currentRow` は段階ごとに rows 全体を見る）。
 *
 * `key` → `ephemeralId` → `pinnedId` → `favoriteId` → PR の URL。分割に入っている実体が
 * Live Folder の URL に居ても、結合行側（ephemeral 行）が勝つ。行の並び順で先勝ちにすると
 * Live 行が最上段にあるぶん URL 一致が勝ってしまうので、段階を分けて見る。
 *
 * @typedef {{ key: string, ephemeralId: string | null, pinnedId: string | null, favoriteId: string | null, url: string }} RowTab
 * @type {((row: SidebarRow, tab: RowTab) => boolean)[]}
 */
const MATCHERS = [
  (row, tab) => row.kind === 'ephemeral' && row.key !== null && row.key === tab.key,
  (row, tab) => row.kind === 'ephemeral' && row.defId !== null && row.defId === tab.ephemeralId,
  (row, tab) => row.kind === 'pin' && row.id === tab.pinnedId,
  (row, tab) => row.kind === 'favorite' && row.id === tab.favoriteId,
  (row, tab) => row.kind === 'live' && row.url === normalizePrUrl(tab.url)
]

/**
 * 行にそのタブが載っているか（段階を問わない）。
 *
 * @param {SidebarRow} row
 * @param {RowTab} tab
 * @returns {boolean}
 */
export function rowMatchesTab(row, tab) {
  return MATCHERS.some((matches) => matches(row, tab))
}

/**
 * いまアクティブなタブが載っている行。強い照合から順に rows 全体を見て、最初に当たった行。
 * 行が無ければ null（Live Folder 由来のタブで小見出しを畳んでいるとき）。
 *
 * @param {SidebarRow[]} rows
 * @param {RowTab | null} tab
 * @returns {SidebarRow | null}
 */
export function currentRow(rows, tab) {
  if (!tab) return null
  for (const matches of MATCHERS) {
    const row = rows.find((candidate) => matches(candidate, tab))
    if (row) return row
  }
  return null
}

/**
 * `from` から `delta`（+1 = 下 / -1 = 上）だけ進んだ行。両端は循環する。
 *
 * `from` は index ではなく**行**で受ける（連打対策で renderer が持つ「自分が指した行のトレイル」の末尾を
 * そのまま渡せる。実体化で行の形が変わっても `sameRow` で追う）。`from` が rows に無ければ
 * ↓ は先頭・↑ は末尾へ。rows が空なら null。
 *
 * @param {SidebarRow[]} rows
 * @param {SidebarRow | null} from
 * @param {1 | -1} delta
 * @returns {SidebarRow | null}
 */
export function stepRow(rows, from, delta) {
  if (rows.length === 0) return null
  const index = from === null ? -1 : rows.findIndex((row) => sameRow(row, from))
  if (index < 0) return rows[delta > 0 ? 0 : rows.length - 1] ?? null
  return rows[(index + delta + rows.length) % rows.length] ?? null
}
