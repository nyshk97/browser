// @ts-check
import { EXTENSION_ID_RE } from './ext-lock.js'

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
  askDownloadLocation: false,
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
    askDownloadLocation:
      typeof input['askDownloadLocation'] === 'boolean'
        ? input['askDownloadLocation']
        : DEFAULT_SETTINGS.askDownloadLocation,
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
 * - 2 … `customTitle`（ユーザーが付けた名前）を持ち、フォルダは1階層まで
 */
export const PINS_VERSION = 2

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
    customTitle: normalizeCustomTitle(raw['customTitle'])
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
      url
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
 * セッション復元
 * ------------------------------------------------------------------ */

/**
 * セッションのスキーマ版。
 * - 1 … タブごとの `lastActiveAt` を持たない
 * - 2 … `lastActiveAt` を持つ（**自動アーカイブの寿命を再起動でリセットしないため**）
 * - 3 … **一時タブだけ**を保存する（`pinnedId` を持たない）。`customTitle` を持つ
 * - 4 … 分割ビューの組み合わせ（`splits`）を持つ
 */
export const SESSION_VERSION = 4

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
 * @property {SavedTab[]} tabs
 * @property {number} activeIndex
 * @property {[number, number][]} splits 左右に並べた組（`tabs` の添字で `[左, 右]`）
 */

/**
 * @typedef {object} SessionData
 * @property {SavedWindow[]} windows
 * @property {boolean} cleanExit
 * @property {number} savedAt
 */

/**
 * 保存されたセッションを検査して正規化する。
 *
 * 版 1 には `lastActiveAt` が無い。**「たった今」に倒す**
 * （0 にすると、版を上げた直後の初回起動で古いタブが一斉に自動アーカイブされる）。
 *
 * 版 2 までは**ピン留めのタブもセッションに入っている**。版 3 はピン / Favorites の
 * タブを復元しない（枠をクリックした時点で作る）ので、`pinnedId` を持つレコードは
 * **丸ごと落とす**。フィールドだけ捨てると、旧データのピンタブが一時タブとして復活する。
 *
 * @param {unknown} raw
 * @returns {SessionData}
 */
export function normalizeSession(raw) {
  const input = isRecord(raw) ? raw : {}
  const windows = Array.isArray(input['windows'])
    ? input['windows'].flatMap((value) => {
        if (!isRecord(value)) return []
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
        if (tabs.length === 0) return []
        // 元の値を新しい長さに clamp するだけだと、先頭や中間のタブが落ちたときに
        // **別のタブが選択される**。元のアクティブタブが残っていればその新しい位置へ。
        const savedIndex =
          typeof value['activeIndex'] === 'number' && Number.isInteger(value['activeIndex'])
            ? value['activeIndex']
            : 0
        const activeIndex = moved.get(savedIndex) ?? 0
        const splits = normalizeSplits(value['splits'], moved, tabs.length)
        return [{ bounds: normalizeBounds(value['bounds']), tabs, activeIndex, splits }]
      })
    : []
  return {
    windows,
    cleanExit: input['cleanExit'] === true,
    savedAt: typeof input['savedAt'] === 'number' ? input['savedAt'] : 0
  }
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
