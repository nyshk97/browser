// @ts-check

/**
 * kypr のパスキーの認証器（`src/main/kypr/passkey-authenticator.ts`）の**純粋ロジック**
 * （plan `docs/plans/2026-09-30-1700-kypr-passkeys.md`）。
 *
 * Electron も node の組み込みも import しない（main と `scripts/kypr-passkey.test.mjs` の両方から読む）。
 * 鍵・署名・候補の選び方・rpId の検証は kypr の `client/passkey.ts`（vendored）が正で、ここは
 * ページ側の shim（`src/shared/kypr-passkey-shim.js`）が平たくした要求を読むところと、
 * 「kypr では答えない（包む前の関数に渡す）」の判定と、clientDataJSON の組み立てだけを持つ。
 */

/** 要求に載せてよい credentialId の数（`allowCredentials` / `excludeCredentials`）。 */
const MAX_CREDENTIALS = 64
/** base64url の文字列の長さの上限（challenge・user.id・credentialId）。 */
const MAX_B64URL = 2048
/** 名前（rp.name・user.name・user.displayName）の長さの上限。 */
const MAX_NAME = 512

const B64URL = /^[A-Za-z0-9_-]*$/

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** @param {unknown} v */
const isB64url = (v) => typeof v === 'string' && v.length <= MAX_B64URL && B64URL.test(v)

/** @param {unknown} v @returns {string | null} */
const optString = (v, max = MAX_NAME) => (typeof v === 'string' && v.length <= max ? v : null)
/** 名前は長ければ切り詰める（WebAuthn でも認証器が切り詰めてよい）。文字列でなければ null。 @param {unknown} v */
const nameOf = (v) => (typeof v === 'string' ? v.slice(0, MAX_NAME) : null)

/**
 * @typedef {{ id: string, transports: string[] | null }} CredentialDescriptor
 * @typedef {{
 *   op: 'create',
 *   rpId: string | null,
 *   rpName: string,
 *   userId: string,
 *   userName: string,
 *   userDisplayName: string,
 *   algs: number[],
 *   challenge: string,
 *   attachment: string | null,
 *   excludeCredentials: string[],
 *   prf: boolean,
 *   credProps: boolean
 * }} CreateRequest
 * @typedef {{
 *   op: 'get',
 *   rpId: string | null,
 *   challenge: string,
 *   allowCredentials: CredentialDescriptor[],
 *   prf: boolean
 * }} GetRequest
 */

/**
 * 認証器ではなくページ側の不正（型が違う）。WebAuthn の仕様ではブラウザが TypeError を投げるところ。
 * @typedef {{ ok: true, value: CreateRequest | GetRequest } | { ok: false, error: 'TypeError' }} ReadResult
 */

/**
 * @param {unknown} v
 * @returns {CredentialDescriptor[] | null}
 */
function readDescriptors(v) {
  if (v == null) return []
  if (!Array.isArray(v) || v.length > MAX_CREDENTIALS) return null
  /** @type {CredentialDescriptor[]} */
  const out = []
  for (const d of v) {
    if (!isRecord(d) || !isB64url(d['id']) || d['id'] === '') return null
    const t = d['transports']
    const transports = Array.isArray(t) ? t.filter((x) => typeof x === 'string').slice(0, 16) : null
    out.push({ id: /** @type {string} */ (d['id']), transports })
  }
  return out
}

/**
 * ページ側の shim が平たくした要求を読む。形が違えば TypeError。
 * @param {unknown} req
 * @returns {ReadResult}
 */
export function readPasskeyRequest(req) {
  const bad = /** @type {const} */ ({ ok: false, error: 'TypeError' })
  if (!isRecord(req)) return bad
  const rpId = req['rpId'] == null ? null : optString(req['rpId'], 253)
  if (req['rpId'] != null && rpId === null) return bad
  const challenge = req['challenge']
  if (!isB64url(challenge) || challenge === '') return bad
  const prf = req['prf'] === true
  if (req['op'] === 'create') {
    const userId = req['userId']
    if (!isB64url(userId)) return bad
    const rpName = nameOf(req['rpName'] ?? '')
    const userName = nameOf(req['userName'] ?? '')
    const userDisplayName = nameOf(req['userDisplayName'] ?? '')
    if (rpName === null || userName === null || userDisplayName === null) return bad
    // 整数でない alg（知らない形）は捨てる。ES256 が残るかは main が見る
    const rawAlgs = req['algs']
    if (!Array.isArray(rawAlgs)) return bad
    const algs = rawAlgs.filter((a) => Number.isInteger(a)).slice(0, 32)
    const exclude = readDescriptors(req['excludeCredentials'])
    if (!exclude) return bad
    const attachment = req['attachment'] == null ? null : optString(req['attachment'], 32)
    return {
      ok: true,
      value: {
        op: 'create',
        rpId,
        rpName,
        userId: /** @type {string} */ (userId),
        userName,
        userDisplayName,
        algs,
        challenge: /** @type {string} */ (challenge),
        attachment,
        excludeCredentials: exclude.map((d) => d.id),
        prf,
        credProps: req['credProps'] === true
      }
    }
  }
  if (req['op'] === 'get') {
    const allow = readDescriptors(req['allowCredentials'])
    if (!allow) return bad
    return {
      ok: true,
      value: { op: 'get', rpId, challenge: /** @type {string} */ (challenge), allowCredentials: allow, prf }
    }
  }
  return bad
}

/** 端末内蔵・スマホ（QR）以外の transport。これだけの `allowCredentials` はセキュリティキー向け。 */
const PASSKEY_TRANSPORTS = new Set(['internal', 'hybrid'])

/**
 * `get` の `allowCredentials` がセキュリティキー（USB / NFC / BLE）向けだけか。
 * 全部に transports があり、どれも internal / hybrid を含まないときだけ true（不明なものがあればパスキーかもしれない）
 * @param {CredentialDescriptor[]} allow
 */
export function securityKeyOnly(allow) {
  if (allow.length === 0) return false
  return allow.every(
    (d) =>
      d.transports !== null && d.transports.length > 0 && !d.transports.some((t) => PASSKEY_TRANSPORTS.has(t))
  )
}

/**
 * 保管庫を見ずに決まる「kypr では答えない（包む前の関数に渡す）」。
 * - kypr の Web の origin（PRF の認証器の持ち場。シークレットで kypr の Web 版にパスキーを作らない）
 * - `authenticatorAttachment: 'cross-platform'` の create・セキュリティキー向けだけの get（キーの経路を消さない）
 * @param {CreateRequest | GetRequest} req
 * @param {string} origin 送り手の frame の origin
 * @param {string | null} kyprOrigin kypr のサーバーの origin（無効なら null）
 * @returns {string | null} 渡す理由（答えるなら null）
 */
export function passBeforeVault(req, origin, kyprOrigin) {
  if (kyprOrigin !== null && origin === kyprOrigin) return 'kypr-origin'
  if (req.op === 'create' && req.attachment === 'cross-platform') return 'cross-platform'
  if (req.op === 'get' && securityKeyOnly(req.allowCredentials)) return 'security-key'
  return null
}

/**
 * rpId を決める（要求に無ければ origin のホスト）。
 * @param {string | null} requested
 * @param {string} origin
 */
export function effectiveRpId(requested, origin) {
  return requested ?? new URL(origin).hostname
}

/**
 * clientDataJSON（WebAuthn の「JSON-compatible serialization」の並び: type → challenge → origin → crossOrigin）。
 * origin はページの申告でなく main が frame の URL から取ったもの。
 * @param {'webauthn.create' | 'webauthn.get'} type
 * @param {string} challenge base64url（パディングなし）
 * @param {string} origin
 */
export function clientDataJSON(type, challenge, origin) {
  return JSON.stringify({ type, challenge, origin, crossOrigin: false })
}

/**
 * Touch ID のダイアログの文言（rpId とユーザー名を入れる）。
 * @param {'create' | 'get' | 'unlock-create' | 'unlock-get'} kind
 * @param {string} rpId
 * @param {string} userName 分からなければ ''
 */
export function passkeyTouchIdReason(kind, rpId, userName) {
  const who = userName ? `（${userName}）` : ''
  if (kind === 'create') return `${rpId} のパスキーを作る${who}`
  if (kind === 'get') return `${rpId} にパスキーでサインイン${who}`
  if (kind === 'unlock-create') return `${rpId} のパスキーを作る${who}（kypr のロックを解除）`
  return `${rpId} にパスキーでサインイン${who}（kypr のロックを解除）`
}
