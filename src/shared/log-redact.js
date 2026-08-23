// @ts-check
/**
 * 診断ログに載せてよい値へ落とす。
 *
 * 計画 1-9 のルール:
 *   **URL（パス以降）・フォーム入力値・Vault 情報をログに出さない。**
 *
 * 「書くときに気をつける」だけでは必ず漏れるので、**ログの出口で必ず通す**
 * 変換をここに置いて、逸脱を構造的に起こせなくしている。
 * 逸脱の検出は `scripts/log-redact.test.mjs` が担う。
 */

/** 中身を一切出さないキー（部分一致・大文字小文字を無視）。 */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'auth',
  'credential',
  'session',
  'apikey',
  'api_key',
  'vault',
  'query',
  'search',
  'input',
  'value',
  'text',
  'title',
  'username',
  'email',
  'body'
]

const MAX_STRING = 200
const MAX_DEPTH = 4
const MAX_KEYS = 40

/** @param {string} key */
function isSecretKey(key) {
  const lower = key.toLowerCase()
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * URL は scheme とホストまでに落とす。
 * パス・クエリ・フラグメントにはトークンが載りうるので出さない。
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol
  } catch {
    const colon = url.indexOf(':')
    return colon > 0 ? `${url.slice(0, colon + 1)}…` : '(unparsable)'
  }
}

/**
 * 文字列が URL に見えるか（scheme:// を含む）。
 * @param {string} value
 */
function looksLikeUrl(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) || /^(about|mailto|tel|javascript|data):/i.test(value)
}

/**
 * ログに載せる値を安全な形に変換する。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'string') {
    if (looksLikeUrl(value)) return redactUrl(value)
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  }
  if (depth >= MAX_DEPTH) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((item) => sanitizeValue(item, depth + 1))
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const result = {}
    let count = 0
    for (const [key, item] of Object.entries(value)) {
      if (count >= MAX_KEYS) {
        result['…'] = 'truncated'
        break
      }
      count += 1
      result[key] = isSecretKey(key) ? '[redacted]' : sanitizeValue(item, depth + 1)
    }
    return result
  }
  return '[unsupported]'
}

/**
 * @param {Record<string, unknown>} detail
 * @returns {Record<string, unknown>}
 */
export function sanitizeDetail(detail) {
  const sanitized = sanitizeValue(detail ?? {}, 0)
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? /** @type {Record<string, unknown>} */ (sanitized)
    : {}
}
