// @ts-check
/**
 * Favorites のセクション（`messages` / `tools`）まわりの純粋関数。
 *
 * `settings-schema.js` は `ext-lock.js` 経由で Node 専用 API に触れるため renderer から
 * import できない。サイドバーと main の両方が使うものだけをここに分けて置く。
 * Electron 非依存。`scripts/settings-schema.test.mjs` からテストする。
 */

/** Favorites のセクション。**サイドバーの並び順でもある**（⌘1〜9 の通し番号もこの順）。 */
export const FAVORITE_SECTIONS = /** @type {const} */ (['messages', 'tools'])

/**
 * 欠損・不正は **`tools`** に倒す（Arc からの取り込み・新規追加も同じ既定）。
 * @param {unknown} value
 * @returns {import('./types.js').FavoriteSection}
 */
export function normalizeFavoriteSection(value) {
  return value === 'messages' ? 'messages' : 'tools'
}

/**
 * ⌘1〜9 に対応する並び（`messages` → `tools`。各セクション内は配列の順）。
 * サイドバーのグリッドと同じ順なので、見た目の N 番目と ⌘N が一致する。
 *
 * @template {{ section: import('./types.js').FavoriteSection }} T
 * @param {T[]} favorites
 * @returns {T[]}
 */
export function favoritesInShortcutOrder(favorites) {
  return FAVORITE_SECTIONS.flatMap((section) => favorites.filter((item) => item.section === section))
}
