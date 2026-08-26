// @ts-check
/**
 * Live Folder（GitHub の PR 一覧）のキャッシュ JSON のスキーマ・正規化。
 *
 * このファイルは**手で編集できるファイルを読む側**なので、
 * 「知らない値は捨てる / 形が違えば落とす」を徹底する。
 * 特に `url` は**そのままタブで開かれる**ので、ここが最後の防波堤になる。
 *
 * Electron 非依存の純粋な関数だけを置き、`scripts/live-folder.test.mjs` から直接テストする。
 */

/** キャッシュファイルのスキーマ版。 */
export const LIVE_FOLDER_VERSION = 1

/**
 * 保持する PR の上限。
 * 取得側が 100 件 × 2 バケットで打ち切るので、それを超える JSON は壊れている。
 */
export const MAX_LIVE_PRS = 200

/** 文字列の上限（`log-redact.js` の MAX_STRING に合わせる）。 */
const MAX_STRING = 200

/** 状態バッジの4値。 */
const PR_STATES = ['approved', 'changes-requested', 'draft', 'waiting']

/** グループの2値。 */
const PR_BUCKETS = ['review', 'mine']

/** 資格情報の fingerprint（`sha256(token)` の先頭 16 文字）。 */
const CREDENTIAL_KEY_RE = /^[0-9a-f]{16}$/

/** PR の URL のパス（`/<owner>/<repo>/pull/<番号>`）。 */
const PR_PATH_RE = /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * PR の URL を正規化する。
 *
 * **`https://github.com/<owner>/<repo>/pull/<番号>` の形だけ**を通し、
 * クエリ・フラグメントは落として正準形にそろえる
 * （タブの URL との突き合わせに使うので、表記ゆれを残さない）。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePrUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.host !== 'github.com') return null
  if (!PR_PATH_RE.test(url.pathname)) return null
  return `https://github.com${url.pathname}`
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_STRING)
}

/**
 * ISO8601 として読めない日時は捨てる。
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeIsoDate(value) {
  if (typeof value !== 'string' || value.length > 64) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * PR 1件を正規化する。**必須項目が欠けていればその項目ごと捨てる**（null を返す）。
 *
 * @param {unknown} raw
 * @returns {import('./types.js').LivePullRequest | null}
 */
export function normalizeLivePullRequest(raw) {
  if (!isRecord(raw)) return null
  const url = normalizePrUrl(raw['url'])
  if (!url) return null
  const state = raw['state']
  if (typeof state !== 'string' || !PR_STATES.includes(state)) return null
  const bucket = raw['bucket']
  if (typeof bucket !== 'string' || !PR_BUCKETS.includes(bucket)) return null
  const updatedAt = normalizeIsoDate(raw['updatedAt'])
  if (!updatedAt) return null
  return {
    url,
    title: normalizeText(raw['title']),
    repo: normalizeText(raw['repo']),
    author: normalizeText(raw['author']),
    state: /** @type {import('./types.js').LivePrState} */ (state),
    bucket: /** @type {import('./types.js').LivePrBucket} */ (bucket),
    updatedAt,
    unread: raw['unread'] === true
  }
}

/**
 * 検索単位の打ち切り情報。`returned` / `total` が数として読めなければ null。
 * @param {unknown} raw
 * @returns {import('./types.js').LiveFolderTruncation | null}
 */
function normalizeTruncation(raw) {
  if (!isRecord(raw)) return null
  const returned = raw['returned']
  const total = raw['total']
  if (typeof returned !== 'number' || !Number.isInteger(returned) || returned < 0) return null
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null
  if (total <= returned) return null
  return { returned, total }
}

/**
 * キャッシュ全体を正規化する。
 *
 * @param {unknown} raw
 * @returns {import('./types.js').LiveFolderCache}
 */
export function normalizeLiveFolderCache(raw) {
  const input = isRecord(raw) ? raw : {}
  const credentialKey = input['credentialKey']
  const login = input['login']
  const updatedAt = input['updatedAt']
  /** @type {import('./types.js').LivePullRequest[]} */
  const items = []
  const seen = new Set()
  if (Array.isArray(input['items'])) {
    for (const entry of input['items']) {
      if (items.length >= MAX_LIVE_PRS) break
      const pr = normalizeLivePullRequest(entry)
      if (!pr) continue
      // 同じ PR が2行出ると、既読・タブ紐づけの対象がどちらか分からなくなる
      if (seen.has(pr.url)) continue
      seen.add(pr.url)
      items.push(pr)
    }
  }
  const truncation = isRecord(input['truncation']) ? input['truncation'] : {}
  return {
    credentialKey:
      typeof credentialKey === 'string' && CREDENTIAL_KEY_RE.test(credentialKey) ? credentialKey : null,
    login: typeof login === 'string' ? normalizeText(login) || null : null,
    items,
    truncation: {
      review: normalizeTruncation(truncation['review']),
      mine: normalizeTruncation(truncation['mine'])
    },
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null
  }
}
