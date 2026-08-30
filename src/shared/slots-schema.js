// @ts-check
/**
 * ブックマークのセーブスロットのスキーマ。
 *
 * 1 スロット = 「ある時点のピン留め + お気に入り」＋ カードに出すメタ（名前・日時・端末名・アイコン）。
 * 設定（`settings.json`）は入れない —— ブックマークを戻したらキーバインドまで変わる、を避ける。
 *
 * ピン留めの不変条件は `normalizePins` が既に持っているので**ここでは書き直さない**
 * （URL は http/https のみ・ID 重複は落とす・フォルダは1階層・超えた分は親へ平坦化）。
 * 二重に書くと、片方だけ直したときに静かに食い違う。
 *
 * Electron 非依存にして `scripts/slots-schema.test.mjs` から直接テストする。
 * **`node:os` などの Node 専用 API を持ち込まない**（`src/shared/*` は renderer からも import される）。
 */
import { isRecord, normalizeFaviconUrl, normalizePins, normalizeStoredUrl } from './settings-schema.js'

/** スロット1枚のスキーマ版。 */
export const SLOTS_VERSION = 1

/** 枠の数。増減の UI は作らない。 */
export const SLOT_COUNT = 3

/** カードに並べるアイコンの数。**表示に使うぶんだけ**焼き込む（スロットを肥らせない）。 */
export const MAX_SLOT_ICONS = 6

/**
 * カードの `icons` に焼き込む `faviconUrl` の長さの上限。
 *
 * `data:` の favicon は数十 KB になることがあり、6 件ぶんがそのままスロットの容量になる。
 * 超えたものは **`faviconUrl` だけ落として `url` は残す**（ホスト名の頭文字で描ける）。
 *
 * **定義側（`favorites[].faviconUrl` / ピン留めの `faviconUrl`）は別の上限**
 * （`MAX_DEFINITION_DATA_FAVICON_LENGTH`、`normalizePins` が掛ける）。`icons` は定義の値を
 * 優先して作るので、この 8KB が効くのは**履歴から補完した分**だけ。
 */
export const MAX_FAVICON_LENGTH = 8192

/** 名前の上限。 */
export const MAX_SLOT_NAME = 60

/** 名前が無いときの表示名。 */
export const UNNAMED_SLOT = '名称未設定'

/**
 * スロットの名前。空白だけ / 空文字は「名称未設定」に倒す。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSlotName(value) {
  if (typeof value !== 'string') return UNNAMED_SLOT
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_SLOT_NAME) : UNNAMED_SLOT
}

/**
 * カードに出すアイコン。
 *
 * `url` は「どのサイトか」を表す本体で、**`faviconUrl` が無くても残す**
 * （受け取る側がホスト名の頭文字で描ける）。逆に `url` が不正なものは丸ごと捨てる。
 *
 * `faviconUrl` は https と data: だけ許す（UI の CSP が `img-src 'self' crx: data: https:`）。
 * ここを緩めると、スロットのファイル1つで任意 scheme の読み込みが作れる。
 *
 * @param {unknown} raw
 * @returns {{ url: string, faviconUrl: string | null }[]}
 */
function normalizeIcons(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {{ url: string, faviconUrl: string | null }[]} */
  const result = []
  const seen = new Set()
  for (const item of raw) {
    if (result.length >= MAX_SLOT_ICONS) break
    if (!isRecord(item)) continue
    const url = normalizeStoredUrl(item['url'])
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push({ url, faviconUrl: normalizeIconFaviconUrl(item['faviconUrl']) })
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeIconFaviconUrl(value) {
  return normalizeFaviconUrl(value, { maxDataLength: MAX_FAVICON_LENGTH, maxUrlLength: MAX_FAVICON_LENGTH })
}

/**
 * 旧形式（`section` を持たない）のスロットか。**正規化の前の raw で見る**。
 *
 * `normalizePins` は欠損を `tools` に倒すので、正規化後には「明示的に tools」と
 * 「そもそも無かった」が区別できない。適用時に「手作業で `messages` に振り分けた
 * Favorite を旧スロットで黙って `tools` に戻さない」ために、スロット単位で判定する。
 *
 * Favorites が 0 件のスロットは `section` を持ちようがないので「新形式」扱い
 * （引き継ぐ相手も居ない）。
 *
 * @param {unknown} raw `{ version, data }` の `data`
 * @returns {boolean}
 */
export function slotHasSections(raw) {
  if (!isRecord(raw) || !Array.isArray(raw['favorites'])) return true
  const items = raw['favorites'].filter(isRecord)
  if (items.length === 0) return true
  return items.some((item) => 'section' in item)
}

/**
 * 保存された時刻。無い / 壊れている / 未来の値は「たった今」に倒す。
 * @param {unknown} raw
 * @param {number} now
 */
function normalizeSavedAt(raw, now) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > now) return now
  return raw
}

/**
 * 端末名。カードの「どの Mac で保存したか」にしか使わないので、緩く丸めるだけ。
 * @param {unknown} value
 */
function normalizeHost(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 100)
}

/**
 * 保存されたスロットを検査して正規化する。
 *
 * @param {unknown} raw
 * @param {number} [now] 未来の savedAt を倒す基準（テストから固定できるように引数で受ける）
 * @returns {import('./types.js').SlotData}
 */
export function normalizeSlot(raw, now = Date.now()) {
  const input = isRecord(raw) ? raw : {}
  const pins = normalizePins(input)
  return {
    name: normalizeSlotName(input['name']),
    savedAt: normalizeSavedAt(input['savedAt'], now),
    host: normalizeHost(input['host']),
    appVersion: typeof input['appVersion'] === 'string' ? input['appVersion'].slice(0, 40) : '',
    icons: normalizeIcons(input['icons']),
    favorites: pins.favorites,
    pinned: pins.pinned
  }
}

/**
 * 保存する中身を組み立てる（ファイルには書かない）。
 *
 * `host` は**引数で受ける**。ここで `node:os` を引くと、renderer 側のビルドに
 * Node 専用 API が混ざる。
 *
 * @param {object} payload
 * @param {string} payload.name
 * @param {string} payload.host
 * @param {string} payload.appVersion
 * @param {number} payload.savedAt
 * @param {import('./types.js').FavoriteItem[]} payload.favorites
 * @param {import('./types.js').PinnedNode[]} payload.pinned
 * @param {{ url: string, faviconUrl: string | null }[]} payload.icons
 * @returns {import('./types.js').SlotData}
 */
export function buildSlot(payload) {
  return normalizeSlot(payload, payload.savedAt)
}

/**
 * ピン留め / お気に入りから、カードに並べるアイコンの元を作る。
 *
 * **お気に入り → ピン留めの順**（サイドバーの並びと同じ）で、フォルダの中まで辿る。
 * `favicons` に無い URL も `faviconUrl: null` で残す（頭文字で描く）。
 *
 * @param {import('./types.js').FavoriteItem[]} favorites
 * @param {import('./types.js').PinnedNode[]} pinned
 * @param {Map<string, string>} favicons URL → favicon の URL
 * @returns {{ url: string, faviconUrl: string | null }[]}
 */
export function collectIcons(favorites, pinned, favicons) {
  return iconCandidates(favorites, pinned)
    .slice(0, MAX_SLOT_ICONS)
    .map((url) => ({ url, faviconUrl: normalizeIconFaviconUrl(favicons.get(url)) }))
}

/**
 * アイコンに並べうる URL（重複を落としたもの、打ち切る前）。
 *
 * **同じ URL を落とす**。お気に入りとピン留めの両方に同じサイトを入れているのは普通に
 * ありうるが、そのまま並べると受け取り側の React の key が衝突し、6 枠も重複で潰れる。
 *
 * カードの `+N` は「この総数 − 並べた数」。**件数（`pins` + `favs`）から引くと、
 * 重複を落とした分まで数えて打ち切っていないのに `+N` が出る**。
 *
 * @param {import('./types.js').FavoriteItem[]} favorites
 * @param {import('./types.js').PinnedNode[]} pinned
 * @returns {string[]}
 */
export function iconCandidates(favorites, pinned) {
  /** @type {string[]} */
  const urls = favorites.map((item) => item.url)
  /** @param {import('./types.js').PinnedNode[]} nodes */
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'link') urls.push(node.url)
      else walk(node.children)
    }
  }
  walk(pinned)
  return [...new Set(urls)]
}

/**
 * ピン留めの件数（フォルダは数えず、中のリンクを数える）。
 * カードの「ピン N 件」はユーザーから見た**ブックマークの数**なので、器は数えない。
 *
 * @param {import('./types.js').PinnedNode[]} nodes
 * @returns {number}
 */
export function countPinnedLinks(nodes) {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'link') count += 1
    else count += countPinnedLinks(node.children)
  }
  return count
}
