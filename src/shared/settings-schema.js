// @ts-check
import { EXTENSION_ID_RE } from './ext-lock.js'
import { normalizeCustomIcon, normalizeFavoriteSection } from './favorites.js'

export {
  FAVORITE_SECTIONS,
  MAX_CUSTOM_ICON_LENGTH,
  favoritesInShortcutOrder,
  isImageIcon,
  normalizeCustomIcon,
  normalizeFavoriteSection
} from './favorites.js'

/**
 * 設定 JSON のスキーマ・既定値・マイグレーション。
 *
 * Electron に依存しない純粋な関数だけを置き、`scripts/store.test.mjs` から直接テストする。
 * 保存する JSON は必ず `{ version, data }` の形にして、**version を見てから読む**。
 * （version の無い JSON を読んだら「壊れている」と判定して既定値に倒す）
 */

/** 設定ファイルの現在のスキーマ版。 */
export const SETTINGS_VERSION = 1

/** @type {import('./types.js').NemoSettings} */
export const DEFAULT_SETTINGS = {
  tabSleepMinutes: 30,
  tabArchiveHours: 24,
  sidebarVisible: true,
  searchTemplate: 'https://www.google.com/search?q={q}',
  keybindings: {},
  restoreSession: true,
  liveFolderEnabled: true,
  extensions: { disabled: [] }
}

/**
 * 値を1つずつ型で検査して既定値に落とす。
 * 「知らないキーは捨てる / 型が違えば既定値」にすることで、
 * 手で編集された JSON や古い版が入っていてもアプリが壊れない。
 *
 * @param {unknown} raw
 * @returns {import('./types.js').NemoSettings}
 */
export function normalizeSettings(raw) {
  const input = isRecord(raw) ? raw : {}
  return {
    tabSleepMinutes: clampNumber(input['tabSleepMinutes'], DEFAULT_SETTINGS.tabSleepMinutes, 0, 24 * 60),
    // 上限は 30 日。これより長い設定は「事実上 OFF」なので 0 と変わらない
    tabArchiveHours: clampNumber(input['tabArchiveHours'], DEFAULT_SETTINGS.tabArchiveHours, 0, 24 * 30),
    sidebarVisible:
      typeof input['sidebarVisible'] === 'boolean'
        ? input['sidebarVisible']
        : DEFAULT_SETTINGS.sidebarVisible,
    searchTemplate: normalizeSearchTemplate(input['searchTemplate']),
    keybindings: normalizeKeybindingOverrides(input['keybindings']),
    restoreSession:
      typeof input['restoreSession'] === 'boolean'
        ? input['restoreSession']
        : DEFAULT_SETTINGS.restoreSession,
    // 保存先を毎回聞くかの設定（`askDownloadLocation`）は廃止した。**常に聞く**
    // （自走検証だけ `NEMO_DOWNLOAD_DIR` がダイアログを抑止する）。
    // 保存済みの値は「知らないキー」としてここで捨てられるので移行処理は要らない。
    // **`SETTINGS_VERSION` は上げない**。キーの追加はここが既定値で埋めるので、
    // 既存の `settings.json` をそのまま読める（版を上げると古い Nemo が読めなくなる）
    liveFolderEnabled:
      typeof input['liveFolderEnabled'] === 'boolean'
        ? input['liveFolderEnabled']
        : DEFAULT_SETTINGS.liveFolderEnabled,
    // ネストしたオブジェクトは**毎回ここで組み立て直す**。`updateSettings` の浅いマージで
    // `extensions` ごと置き換わっても、未指定のキーが既定値で埋まる
    extensions: normalizeExtensionSettings(input['extensions'])
  }
}

/**
 * 端末ごとの拡張の ON/OFF。lock は「何を同梱するか」、ここは「この端末で何を動かすか」。
 * 拡張 ID の形をしていないものは捨てる（`setExtensionEnabled` 側で lock との照合をする）。
 * @param {unknown} value
 * @returns {import('./types.js').NemoSettings['extensions']}
 */
function normalizeExtensionSettings(value) {
  const input = isRecord(value) ? value : {}
  const disabled = Array.isArray(input['disabled'])
    ? [...new Set(input['disabled'].filter((id) => typeof id === 'string' && EXTENSION_ID_RE.test(id)))]
    : []
  return { disabled }
}

/**
 * 検索テンプレートは https のみ許可し、`{q}` を含むことを要求する。
 * ここを緩めると、設定ファイルの1行で任意 scheme のナビゲーションが作れてしまう。
 * @param {unknown} value
 */
function normalizeSearchTemplate(value) {
  if (typeof value !== 'string' || !value.includes('{q}')) return DEFAULT_SETTINGS.searchTemplate
  try {
    const url = new URL(value.replace('{q}', 'x'))
    if (url.protocol !== 'https:') return DEFAULT_SETTINGS.searchTemplate
  } catch {
    return DEFAULT_SETTINGS.searchTemplate
  }
  return value
}

/** @param {unknown} value */
function normalizeKeybindingOverrides(value) {
  /** @type {Record<string, string>} */
  const result = {}
  if (!isRecord(value)) return result
  for (const [command, accelerator] of Object.entries(value)) {
    if (typeof accelerator !== 'string') continue
    if (accelerator.length > 64) continue
    result[command] = accelerator
  }
  return result
}

/**
 * `{ version, data }` を読む。version が未来 / 不正なら null を返す。
 * 呼び出し側は null を「既定値で作り直す」に倒す。
 *
 * @param {unknown} raw
 * @param {number} currentVersion
 * @returns {{ version: number, data: unknown } | null}
 */
export function readVersioned(raw, currentVersion) {
  if (!isRecord(raw)) return null
  const version = raw['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  // 未来の版は読まない（新しい Nemo が書いた JSON を古い Nemo が壊さないため）
  if (version > currentVersion) return null
  return { version, data: raw['data'] }
}

/**
 * @param {number} version
 * @param {unknown} data
 */
export function writeVersioned(version, data) {
  return { version, data }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/* ------------------------------------------------------------------ *
 * ピン留め / Favorites
 * ------------------------------------------------------------------ */

/**
 * ピン留め / Favorites のスキーマ版。
 * - 1 … `title` だけ
 * - 2 … `customTitle`（ユーザーが付けた名前）を持ち、フォルダは1階層まで。
 *        **`section` / `faviconUrl` / `customIcon` は版を上げずに足した**（欠損は既定値に倒すだけで、
 *        旧データを読む側の分岐が要らない）
 */
export const PINS_VERSION = 2

/**
 * 定義（Favorite / ピン留め）に持たせる favicon の `data:` の上限。
 *
 * スロットのカード用（`MAX_FAVICON_LENGTH` = 8KB × 6 件）とは別に小さく持つ。
 * pins.json はタイトル更新のたびに**全体を書き直す**ストアで、こちらは全件に付くため。
 * `https:` は URL なので `normalizeStoredUrl` と同じ 4096 文字まで。
 */
export const MAX_DEFINITION_DATA_FAVICON_LENGTH = 2048

/**
 * favicon の URL。**https と data:image/ だけ**許す（UI の CSP が `img-src 'self' crx: data: https:`）。
 * ここを緩めると、設定ファイル1つで任意 scheme の読み込みが作れる。
 *
 * @param {unknown} value
 * @param {{ maxDataLength: number, maxUrlLength?: number }} limits
 * @returns {string | null}
 */
export function normalizeFaviconUrl(value, limits) {
  if (typeof value !== 'string') return null
  if (value.startsWith('data:image/')) {
    return value.length <= limits.maxDataLength ? value : null
  }
  if (value.length > (limits.maxUrlLength ?? 4096)) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/**
 * 定義に持たせる favicon（上限は定義用）。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeDefinitionFaviconUrl(value) {
  return normalizeFaviconUrl(value, { maxDataLength: MAX_DEFINITION_DATA_FAVICON_LENGTH })
}

/**
 * ピン留めツリーの入れ子の上限。
 *
 * **1 = フォルダの中にフォルダを作れない**（root 直下のフォルダだけ）。
 * 既存データや Arc の取り込みで2階層以上が来たら、**中身を親へ平坦化する**
 * （切り捨てるとブックマークが黙って消える）。
 */
export const MAX_PIN_DEPTH = 1

/**
 * 保存されたピン留め・Favorites を検査して正規化する。
 * URL は http / https のみ（ここを緩めると設定ファイル経由で `file:` が開ける）。
 *
 * @param {unknown} raw
 * @returns {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }}
 */
export function normalizePins(raw) {
  const input = isRecord(raw) ? raw : {}
  const seen = new Set()
  return {
    favorites: Array.isArray(input['favorites'])
      ? input['favorites'].flatMap((item) => {
          const normalized = normalizeFavorite(item, seen)
          return normalized ? [normalized] : []
        })
      : [],
    pinned: normalizePinnedList(input['pinned'], seen, 0)
  }
}

/**
 * @param {unknown} raw
 * @param {Set<string>} seen
 * @returns {import('./types.js').FavoriteItem | null}
 */
function normalizeFavorite(raw, seen) {
  if (!isRecord(raw)) return null
  const id = normalizeId(raw['id'], seen)
  const url = normalizeStoredUrl(raw['url'])
  if (!id || !url) return null
  return {
    id,
    url,
    title: normalizeTitle(raw['title'], url),
    customTitle: normalizeCustomTitle(raw['customTitle']),
    section: normalizeFavoriteSection(raw['section']),
    faviconUrl: normalizeDefinitionFaviconUrl(raw['faviconUrl']),
    customIcon: normalizeCustomIcon(raw['customIcon'])
  }
}

/**
 * @param {unknown} raw
 * @param {Set<string>} seen
 * @param {number} depth
 * @returns {import('./types.js').PinnedNode[]}
 */
function normalizePinnedList(raw, seen, depth) {
  if (!Array.isArray(raw)) return []
  /** @type {import('./types.js').PinnedNode[]} */
  const result = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    if (item['kind'] === 'folder') {
      // 上限を超えたフォルダは**自分だけ消えて中身は親に残る**。
      // ID は使わないので seen にも入れない（平坦化した子の ID はそのまま生きる）。
      if (depth >= MAX_PIN_DEPTH) {
        result.push(...normalizePinnedList(item['children'], seen, depth))
        continue
      }
      const folderId = normalizeId(item['id'], seen)
      if (!folderId) continue
      result.push({
        id: folderId,
        kind: 'folder',
        title: normalizeTitle(item['title'], 'フォルダ'),
        customTitle: normalizeCustomTitle(item['customTitle']),
        collapsed: item['collapsed'] === true,
        children: normalizePinnedList(item['children'], seen, depth + 1)
      })
      continue
    }
    const id = normalizeId(item['id'], seen)
    if (!id) continue
    const url = normalizeStoredUrl(item['url'])
    if (!url) continue
    result.push({
      id,
      kind: 'link',
      title: normalizeTitle(item['title'], url),
      customTitle: normalizeCustomTitle(item['customTitle']),
      url,
      faviconUrl: normalizeDefinitionFaviconUrl(item['faviconUrl']),
      customIcon: normalizeCustomIcon(item['customIcon'])
    })
  }
  return result
}

/**
 * 保存済み URL は http / https だけ通す。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeStoredUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * ID は重複を許さない（重複すると DnD の移動先が定まらない）。
 * @param {unknown} value
 * @param {Set<string>} seen
 */
function normalizeId(value, seen) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  if (seen.has(value)) return null
  seen.add(value)
  return value
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function normalizeTitle(value, fallback) {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  return value.slice(0, 300)
}

/**
 * ユーザーが付けた名前。**空文字は「未設定」に倒す**（リネームの解除と同じ扱い）。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeCustomTitle(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 300) : null
}

/* ------------------------------------------------------------------ *
 * 一時タブの共有定義（全ウィンドウ横断）
 * ------------------------------------------------------------------ */

/** 一時タブの共有定義（`ephemeral-tabs.json`）のスキーマ版。 */
export const EPHEMERAL_TABS_VERSION = 1

/**
 * @typedef {object} EphemeralTabDef
 * @property {string} id
 * @property {string} url 実体のナビゲーションに追随する（ピン留めの「登録 URL」とは逆の規則）
 * @property {string} title 既定名（ページタイトルに追随）
 * @property {string | null} customTitle ユーザーが付けた名前（無ければ null）
 * @property {string | null} faviconUrl
 * @property {number} lastActiveAt どのウィンドウの実体でもよいので、最後に使われた時刻
 */

/**
 * 一時タブの共有定義を検査して正規化する。
 *
 * ピン留めと同じく URL は http / https だけ（`about:blank` や拡張ページは
 * **定義を持たないウィンドウローカルのタブ**として扱い、ここには入れない）。
 * 並び順は配列順（追加順）で、並べ替え API は持たない。
 *
 * @param {unknown} raw
 * @returns {{ tabs: EphemeralTabDef[] }}
 */
export function normalizeEphemeralTabs(raw) {
  const input = isRecord(raw) ? raw : {}
  const seen = new Set()
  const tabs = Array.isArray(input['tabs'])
    ? input['tabs'].flatMap((item) => {
        if (!isRecord(item)) return []
        const id = normalizeId(item['id'], seen)
        const url = normalizeStoredUrl(item['url'])
        if (!id || !url) return []
        return [
          {
            id,
            url,
            title: normalizeTitle(item['title'], url),
            customTitle: normalizeCustomTitle(item['customTitle']),
            faviconUrl: normalizeDefinitionFaviconUrl(item['faviconUrl']),
            lastActiveAt: normalizeTimestamp(item['lastActiveAt'])
          }
        ]
      })
    : []
  return { tabs }
}

/* ------------------------------------------------------------------ *
 * セッション復元
 * ------------------------------------------------------------------ */

/**
 * セッションのスキーマ版。
 * - 1 … タブごとの `lastActiveAt` を持たない
 * - 2 … `lastActiveAt` を持つ（**自動アーカイブの寿命を再起動でリセットしないため**）
 * - 3 … **一時タブだけ**を保存する（`pinnedId` を持たない）。`customTitle` を持つ
 * - 4 … 分割ビューの組み合わせ（`splits`）を持つ
 * - 5 … 野良タブの正が共有定義ストア（`ephemeral-tabs.json`）へ移った。
 *        ウィンドウは `tabs` を持たず、`activeEphemeralId` と定義 ID の `splits` だけ持つ
 */
export const SESSION_VERSION = 5

/**
 * @typedef {object} SavedTab
 * @property {string} url
 * @property {string} title
 * @property {string | null} customTitle ユーザーが付けた名前（無ければ null）
 * @property {number} lastActiveAt 最後にアクティブだった時刻
 */

/**
 * @typedef {object} SavedWindow
 * @property {{ x: number, y: number, width: number, height: number } | null} bounds
 * @property {string | null} activeEphemeralId 選択していた一時タブ定義（ピン / Favorite なら null）
 * @property {[string, string][]} splits 左右に並べた組（一時タブ定義 ID で `[左, 右]`）
 */

/**
 * @typedef {object} LegacySavedWindow 版 4 以前のウィンドウ（移行の入力にだけ使う）
 * @property {{ x: number, y: number, width: number, height: number } | null} bounds
 * @property {SavedTab[]} tabs
 * @property {number} activeIndex
 * @property {[number, number][]} splits 左右に並べた組（`tabs` の添字で `[左, 右]`）
 */

/**
 * @typedef {object} SessionData
 * @property {SavedWindow[]} windows
 * @property {boolean} cleanExit
 * @property {number} savedAt
 * @property {LegacySavedWindow[] | null} legacyWindows
 *   版 4 以前のウィンドウを読んだときだけ入る（共有ストアへの一度きりの移行の入力）。
 *   **正規化で捨ててはいけない** —— `initSession` は読み込み直後に正規化後の値を
 *   書き戻すので、ここで落とすと移行コードが走る前に旧タブが session.json から消える。
 *   移行の冪等判定もこのフィールドの有無で行う（`JsonStore` は normalize に版番号を渡さない）
 */

/**
 * 保存されたセッションを検査して正規化する。
 *
 * 版 4 以前のウィンドウ（`tabs` を持つ）と版 5 のウィンドウ（持たない）を
 * **形で見分ける**。旧形式は `legacyWindows` に退避して返し、共有ストアへの移行は
 * `initSession` 側で行う。
 *
 * 旧形式の規則（移行の入力を壊さないためにそのまま維持する）:
 * - 版 1 には `lastActiveAt` が無い。**「たった今」に倒す**
 *   （0 にすると、版を上げた直後の初回起動で古いタブが一斉に自動アーカイブされる）
 * - 版 2 までは**ピン留めのタブもセッションに入っている**。`pinnedId` を持つレコードは
 *   **丸ごと落とす**。フィールドだけ捨てると、旧データのピンタブが一時タブとして復活する
 * - タブが 1 本も残らないウィンドウは丸ごと落とす（版 5 のウィンドウは逆で、
 *   実体を持たないウィンドウも共有一覧のビューとして正常なので bounds があれば残す）
 *
 * @param {unknown} raw
 * @returns {SessionData}
 */
export function normalizeSession(raw) {
  const input = isRecord(raw) ? raw : {}
  /** @type {SavedWindow[]} */
  const windows = []
  /** @type {LegacySavedWindow[]} */
  const legacyWindows = []
  if (Array.isArray(input['windows'])) {
    for (const value of input['windows']) {
      if (!isRecord(value)) continue
      if (Array.isArray(value['tabs'])) {
        const legacy = normalizeLegacyWindow(value)
        if (legacy) legacyWindows.push(legacy)
        continue
      }
      windows.push({
        bounds: normalizeBounds(value['bounds']),
        activeEphemeralId: normalizeDefinitionRef(value['activeEphemeralId']),
        splits: normalizeIdSplits(value['splits'])
      })
    }
  }
  return {
    windows,
    cleanExit: input['cleanExit'] === true,
    savedAt: typeof input['savedAt'] === 'number' ? input['savedAt'] : 0,
    legacyWindows: legacyWindows.length > 0 ? legacyWindows : null
  }
}

/**
 * 版 4 以前のウィンドウ 1 枚ぶん。
 * @param {Record<string, unknown>} value
 * @returns {LegacySavedWindow | null}
 */
function normalizeLegacyWindow(value) {
  const rawTabs = Array.isArray(value['tabs']) ? value['tabs'] : []
  /** @type {SavedTab[]} */
  const tabs = []
  /** 元の添字 → 除外後の添字。**選択タブがずれないため**に持つ。 */
  const moved = new Map()
  for (const [index, tab] of rawTabs.entries()) {
    if (!isRecord(tab)) continue
    // 版 2 以前のピン留めタブ（枠の側から作り直されるので復元しない）
    if (typeof tab['pinnedId'] === 'string') continue
    const url = normalizeStoredUrl(tab['url'])
    if (!url) continue
    moved.set(index, tabs.length)
    tabs.push({
      url,
      title: typeof tab['title'] === 'string' ? tab['title'].slice(0, 300) : '',
      customTitle: normalizeCustomTitle(tab['customTitle']),
      lastActiveAt: normalizeTimestamp(tab['lastActiveAt'])
    })
  }
  if (tabs.length === 0) return null
  // 元の値を新しい長さに clamp するだけだと、先頭や中間のタブが落ちたときに
  // **別のタブが選択される**。元のアクティブタブが残っていればその新しい位置へ。
  const savedIndex =
    typeof value['activeIndex'] === 'number' && Number.isInteger(value['activeIndex'])
      ? value['activeIndex']
      : 0
  const activeIndex = moved.get(savedIndex) ?? 0
  const splits = normalizeSplits(value['splits'], moved, tabs.length)
  return { bounds: normalizeBounds(value['bounds']), tabs, activeIndex, splits }
}

/**
 * 一時タブ定義への参照（`activeEphemeralId`）。ID の形だけ見る
 * （実在の検査は復元側。定義が消えていたら復元側が先頭定義へ倒す）。
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeDefinitionRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null
  return value
}

/**
 * 版 5 の分割の組（一時タブ定義 ID の対）。
 *
 * 捨てる規則は添字版（`normalizeSplits`）と同じ:
 * 形が違う・左右が同じ・**同じ定義が 2 つ以上の組に現れたら競合した組を全部落とす**。
 *
 * @param {unknown} raw
 * @returns {[string, string][]}
 */
function normalizeIdSplits(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {[string, string][]} */
  const pairs = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const left = normalizeDefinitionRef(entry[0])
    const right = normalizeDefinitionRef(entry[1])
    if (!left || !right || left === right) continue
    pairs.push([left, right])
  }
  const seen = new Map()
  for (const [left, right] of pairs) {
    for (const id of [left, right]) seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  return pairs.filter(([left, right]) => seen.get(left) === 1 && seen.get(right) === 1)
}

/**
 * 分割の組を検査する。
 *
 * 捨てる条件:
 * - 整数でない / 2 要素でない / 左右が同じ
 * - 除外されたタブを指している（`moved` に無い）か、読み替えた先が範囲外
 * - **同じタブが 2 つ以上の組に現れる → 競合した組を全部落とす**。
 *   先着を残すと結果が記述順に依存し、壊れたデータを読み直したときの
 *   期待値（冪等性）が決まらなくなる
 *
 * 版 3 以前には `splits` が無いので、その場合は空配列（＝分割なし）に倒す。
 *
 * @param {unknown} raw
 * @param {Map<number, number>} moved 元の添字 → 除外後の添字
 * @param {number} length 除外後のタブ数
 * @returns {[number, number][]}
 */
function normalizeSplits(raw, moved, length) {
  if (!Array.isArray(raw)) return []
  /** @type {[number, number][]} */
  const pairs = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [rawLeft, rawRight] = entry
    if (!Number.isInteger(rawLeft) || !Number.isInteger(rawRight)) continue
    const left = moved.get(rawLeft)
    const right = moved.get(rawRight)
    if (left === undefined || right === undefined) continue
    if (left === right) continue
    if (left < 0 || left >= length || right < 0 || right >= length) continue
    pairs.push([left, right])
  }
  // 同じ添字に触れる組は**全部**落とす
  const seen = new Map()
  for (const [left, right] of pairs) {
    for (const index of [left, right]) seen.set(index, (seen.get(index) ?? 0) + 1)
  }
  return pairs.filter(([left, right]) => seen.get(left) === 1 && seen.get(right) === 1)
}

/**
 * 保存された時刻。無い / 壊れている / 未来の値は「たった今」に倒す。
 * @param {unknown} raw
 */
function normalizeTimestamp(raw) {
  const now = Date.now()
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return now
  return Math.min(raw, now)
}

/** @param {unknown} raw @returns {SavedWindow['bounds']} */
function normalizeBounds(raw) {
  if (!isRecord(raw)) return null
  const values = ['x', 'y', 'width', 'height'].map((key) => raw[key])
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [x, y, width, height] = /** @type {number[]} */ (values)
  if (width < 200 || height < 200) return null
  return { x, y, width, height }
}

/* ------------------------------------------------------------------ *
 * 会議の小窓の位置
 * ------------------------------------------------------------------ */

/** 会議の小窓の位置ファイルのスキーマ版。 */
export const CALL_WINDOW_VERSION = 1

/**
 * @typedef {object} CallWindowPosition
 * @property {number} x
 * @property {number} y
 * @property {number} displayId 保存したときに載っていた display の ID
 */

/**
 * @typedef {object} CallWindowData
 * @property {CallWindowPosition | null} position
 */

/**
 * 会議の小窓の位置。**サイズは保存しない**（固定なので覚える意味がない）。
 *
 * `displayId` まで持つのは、モニタ構成が変わったときに
 * 「保存した座標がどの display の workArea にも収まらない」を検出して
 * 既定位置へ戻すため（画面外に出したまま復元しない）。
 *
 * @param {unknown} raw
 * @returns {CallWindowData}
 */
export function normalizeCallWindow(raw) {
  const input = isRecord(raw) ? raw : {}
  const position = input['position']
  if (!isRecord(position)) return { position: null }
  const values = ['x', 'y', 'displayId'].map((key) => position[key])
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return { position: null }
  const [x, y, displayId] = /** @type {number[]} */ (values)
  return { position: { x: Math.round(x), y: Math.round(y), displayId } }
}

/**
 * 保存した位置を復元してよいか。
 *
 * **どの workArea にも収まらない座標は捨てる**（モニタを外した / 解像度が変わった後に、
 * 画面外へ出したまま復元しない）。Electron の `screen` に触らない純粋関数にしてあるので、
 * 表示環境に依らず両方の分岐をユニットテストで確かめられる。
 *
 * @param {{ x: number, y: number }} position
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number, width: number, height: number }[]} workAreas
 * @returns {boolean}
 */
export function fitsAnyWorkArea(position, size, workAreas) {
  return workAreas.some(
    (area) =>
      position.x >= area.x &&
      position.y >= area.y &&
      position.x + size.width <= area.x + area.width &&
      position.y + size.height <= area.y + area.height
  )
}
