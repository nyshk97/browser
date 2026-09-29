// @ts-check
import { createHash, createHmac } from 'node:crypto'

/**
 * kypr の Web 版の Touch ID 解除に答える認証器（`src/main/kypr/web-authenticator.ts`）の**純粋ロジック**。
 *
 * Electron を import しない（main と `scripts/kypr-webauthn.test.mjs` の両方から読む）。
 * renderer からは読まない（`node:crypto` に触る）。
 *
 * kypr の Web 版（`apps/web/src/lib/device-unlock.ts`）が渡す要求の形だけに答える。
 * **本物の認証器のふりはしない**（署名・attestation は作らない。kypr は PRF の出力しか使わない）。
 * - `create`: `authenticatorAttachment: 'platform'` + `userVerification: 'required'` + `extensions.prf`
 * - `get`: `userVerification: 'required'` + `extensions.prf.eval.first` + `allowCredentials` に
 *   この Nemo が作ったクレデンシャル
 *
 * 要求の形が kypr のものでなければ `not-kypr`（ページ側は包む前の関数に渡し、`webauthn-shim.js` が今までどおり扱う）。
 * kypr の形なのに答えられないもの（rpId が違う・知らないクレデンシャル）は `not-allowed`（NotAllowedError）。
 */

/** origin ごとに持つクレデンシャルの上限（`signalUnknownCredential` の取りこぼしに備える）。 */
export const KYPR_WEBAUTHN_MAX_PER_ORIGIN = 5

const B64URL = /^[A-Za-z0-9_-]+$/
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * ページ側の shim から届いた base64 を読む。形が違えば null。
 * @param {unknown} v
 * @returns {Buffer | null}
 */
function readB64(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 1024 || !B64.test(v)) return null
  return Buffer.from(v, 'base64')
}

/**
 * @typedef {{ ok: true, salt: Buffer | null } | { ok: false, reason: 'not-kypr' | 'not-allowed' }} CreateDecision
 * @typedef {{ ok: true, id: string, salt: Buffer } | { ok: false, reason: 'not-kypr' | 'not-allowed' }} GetDecision
 */

/**
 * `create` の要求を判定する。
 * @param {unknown} req ページ側の shim が平たくした要求
 * @param {string} host 送り手の origin の host（rpId はこれに決める）
 * @returns {CreateDecision}
 */
export function decideCreate(req, host) {
  if (!isRecord(req)) return { ok: false, reason: 'not-kypr' }
  if (req['attachment'] !== 'platform' || req['userVerification'] !== 'required' || req['prf'] !== true) {
    return { ok: false, reason: 'not-kypr' }
  }
  if (req['rpId'] != null && req['rpId'] !== host) return { ok: false, reason: 'not-allowed' }
  if (req['prfFirst'] == null) return { ok: true, salt: null }
  const salt = readB64(req['prfFirst'])
  if (!salt) return { ok: false, reason: 'not-allowed' }
  return { ok: true, salt }
}

/**
 * `get` の要求を判定する。
 * @param {unknown} req ページ側の shim が平たくした要求
 * @param {string} host 送り手の origin の host
 * @param {ReadonlySet<string>} knownIds この origin で持っているクレデンシャルの id（base64url）
 * @returns {GetDecision}
 */
export function decideGet(req, host, knownIds) {
  if (!isRecord(req)) return { ok: false, reason: 'not-kypr' }
  if (req['userVerification'] !== 'required' || req['prfFirst'] == null)
    return { ok: false, reason: 'not-kypr' }
  const allow = req['allowCredentials']
  if (!Array.isArray(allow) || allow.length === 0) return { ok: false, reason: 'not-kypr' }
  if (req['rpId'] != null && req['rpId'] !== host) return { ok: false, reason: 'not-allowed' }
  const salt = readB64(req['prfFirst'])
  if (!salt) return { ok: false, reason: 'not-allowed' }
  const id = allow.find((v) => typeof v === 'string' && knownIds.has(v))
  if (typeof id !== 'string') return { ok: false, reason: 'not-allowed' }
  return { ok: true, id, salt }
}

/**
 * WebAuthn の PRF 拡張の出力（仕様どおり: `HMAC-SHA256(secret, SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt))`）。
 * @param {Uint8Array} secret クレデンシャルごとの秘密（32 バイト）
 * @param {Uint8Array} salt ページが渡した `prf.eval.first`
 * @returns {Buffer} 32 バイト
 */
export function prfOutput(secret, salt) {
  const prefixed = createHash('sha256')
    .update(Buffer.from('WebAuthn PRF', 'utf8'))
    .update(Buffer.from([0]))
    .update(salt)
    .digest()
  return createHmac('sha256', secret).update(prefixed).digest()
}

/**
 * @typedef {{ id: string, rpId: string, origin: string, encrypted: string, createdAt: string }} StoredCredential
 * @typedef {{ version: 1, credentials: StoredCredential[] }} WebAuthnStore
 */

/**
 * 保存ファイルを正規化する（形の違う行を捨て、origin ごとに新しい順で上限まで残す）。
 * @param {unknown} raw
 * @returns {WebAuthnStore}
 */
export function normalizeWebAuthnStore(raw) {
  /** @type {StoredCredential[]} */
  const rows = []
  const list = isRecord(raw) && Array.isArray(raw['credentials']) ? raw['credentials'] : []
  const seen = new Set()
  for (const row of list) {
    if (!isRecord(row)) continue
    const { id, rpId, origin, encrypted, createdAt } = row
    if (typeof id !== 'string' || !B64URL.test(id) || seen.has(id)) continue
    if (typeof rpId !== 'string' || rpId === '') continue
    if (typeof origin !== 'string' || origin === '') continue
    if (typeof encrypted !== 'string' || encrypted === '') continue
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) continue
    seen.add(id)
    rows.push({ id, rpId, origin, encrypted, createdAt })
  }
  return { version: 1, credentials: capPerOrigin(rows) }
}

/**
 * origin ごとに新しい順で上限まで残す（順番は新しい順に並べ直す）。
 * @param {StoredCredential[]} rows
 * @returns {StoredCredential[]}
 */
export function capPerOrigin(rows) {
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  /** @type {Map<string, number>} */
  const counts = new Map()
  return sorted.filter((row) => {
    const n = counts.get(row.origin) ?? 0
    counts.set(row.origin, n + 1)
    return n < KYPR_WEBAUTHN_MAX_PER_ORIGIN
  })
}
