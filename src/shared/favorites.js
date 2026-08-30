// @ts-check
/**
 * Favorites の表示まわり（セクション `messages` / `tools`、カスタムアイコン）の純粋関数。
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

/**
 * ユーザーが定義に上書きするアイコン（`customIcon`）の画像の上限。
 *
 * 既定 favicon（`MAX_DEFINITION_DATA_FAVICON_LENGTH` = 2KB）は全件に付くので小さいが、
 * こちらは手で付けた数件にしか付かないので緩い。renderer は 64×64 の PNG に縮めて送る。
 */
export const MAX_CUSTOM_ICON_LENGTH = 16 * 1024

/** 絵文字アイコンの UTF-16 長の上限（👨🏻‍❤️‍💋‍👨🏻 が 15 単位）。 */
const MAX_EMOJI_ICON_LENGTH = 32

const CUSTOM_ICON_IMAGE_PREFIX = 'data:image/png;base64,'

/**
 * `customIcon` が画像（PNG の data URL）か。絵文字なら false。
 * @param {unknown} icon
 */
export function isImageIcon(icon) {
  return typeof icon === 'string' && icon.startsWith(CUSTOM_ICON_IMAGE_PREFIX)
}

/**
 * `customIcon` の正規化。通るのは次の 2 種だけで、他は null（＝未設定）。
 *
 * - **絵文字 1 個**: `trim()` 後に grapheme が 1 つで、空白（`\p{White_Space}`）と
 *   制御文字（`\p{Cc}`）を含まない。`\p{Cf}`（ZWJ U+200D）は grapheme の中にいる限り通す
 *   （落とすと 👨‍👩‍👧 / 🏳️‍🌈 のような結合絵文字が全滅する）
 * - **PNG の data URL**: `data:image/png;base64,` 始まりで `MAX_CUSTOM_ICON_LENGTH` 以下
 *   （renderer が必ず PNG に変換して送るので受け口を広げない）
 *
 * 空白 1 文字を通すと「保存されているのにセルが空」で消えたように見えるので落とす。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeCustomIcon(value) {
  if (typeof value !== 'string') return null
  if (value.startsWith('data:')) {
    return isImageIcon(value) && value.length <= MAX_CUSTOM_ICON_LENGTH ? value : null
  }
  const text = value.trim()
  if (!text || text.length > MAX_EMOJI_ICON_LENGTH) return null
  if (/[\p{White_Space}\p{Cc}]/u.test(text)) return null
  return countGraphemes(text) === 1 ? text : null
}

const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' })

/** @param {string} text */
function countGraphemes(text) {
  let count = 0
  const segments = GRAPHEMES.segment(text)[Symbol.iterator]()
  while (!segments.next().done) {
    count += 1
    if (count > 1) break
  }
  return count
}
