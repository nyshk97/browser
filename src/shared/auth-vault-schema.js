// @ts-check
/**
 * Basic 認証の保管庫（別の Mac へ持ち出すための 1 ファイル）のスキーマ。
 *
 * 中身は「その時点の**有効な**認証ルール全件」。パスワードが入るので、
 * `safeStorage`（端末鍵）ではなく**パスフレーズ由来の鍵で暗号化して**運ぶ。
 * 実際の暗号は `auth-vault-crypto.js` にあり、**このファイルは node 組み込みを引かない**
 * —— renderer も `MIN_PASSPHRASE` / `validatePassphrase` を読むので、
 * ここに `node:crypto` を混ぜると web バンドルに入る。
 *
 * ルールの不変条件（正規表現の安全性・長さ・件数）は `http-auth-rules.js` が既に持っているので
 * **ここでは書き直さず、`validateHttpAuthPattern` と `HTTP_AUTH_LIMITS` を呼ぶ**。
 * 二重に書くと、片方だけ直したときに静かに食い違う。
 */
import { isRecord } from './settings-schema.js'
import { HTTP_AUTH_LIMITS, validateHttpAuthPattern } from './http-auth-rules.js'

/** 保管庫ファイルのスキーマ版。 */
export const AUTH_VAULT_VERSION = 1

/**
 * パスフレーズの最小長。
 *
 * **UI と main が同じ値を使う**（入力欄の検証だけ緩いと、弾かれる値を打ててしまう）。
 * 忘れたときの回復手段が無いので、長さ以外の強度要求（記号を混ぜろ等）は課さない。
 */
export const MIN_PASSPHRASE = 8

/** パスフレーズの上限。KDF に渡す前に切る。 */
export const MAX_PASSPHRASE = 1024

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: 'empty' | 'too-short' | 'too-long' }}
 */
export function validatePassphrase(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'empty' }
  if (value.length < MIN_PASSPHRASE) return { ok: false, reason: 'too-short' }
  if (value.length > MAX_PASSPHRASE) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

/** 暗号文（base64）の上限。200 件 × ルール 1 件分に十分な余裕を取る。 */
const MAX_CIPHERTEXT = 2_000_000

/** 端末名・アプリ版の表示上限。 */
const MAX_META_TEXT = 200

/**
 * ファイルの封筒。
 *
 * **`version` はここで見ない** —— `readVersioned` が剥がしたあとの `data` を受ける
 * （未来の版の見分けは呼び出し側の責務。保管庫は全ての Mac が 1 ファイルを共有するので、
 * 古い Nemo が未来の版を「壊れている」と誤認して退避すると全員から消える）。
 *
 * @typedef {object} VaultFile
 * @property {VaultMeta} meta 平文のメタ。**写しが暗号の中にもある**ので、
 *   ここだけ書き換えると復号後の突き合わせで弾かれる
 *   （AAD にしない理由は `auth-vault-crypto.js` の冒頭）
 * @property {{ name: 'scrypt', N: number, r: number, p: number, salt: string }} kdf
 * @property {string} iv base64
 * @property {string} ciphertext base64
 * @property {string} tag base64（GCM の認証タグ）
 */

/**
 * @typedef {object} VaultMeta
 * @property {number} count 入っているルールの件数
 * @property {number} savedAt
 * @property {string} host 保存した端末名
 * @property {string} appVersion
 */

/**
 * 封筒を検査する。**復号する前に呼ぶ**（壊れたファイルを KDF に通さない）。
 *
 * @param {unknown} raw `readVersioned` が剥がしたあとの `data`
 * @returns {VaultFile | null}
 */
export function normalizeVaultFile(raw) {
  if (!isRecord(raw)) return null

  const meta = normalizeVaultMeta(raw['meta'])
  if (!meta) return null

  const kdf = raw['kdf']
  if (!isRecord(kdf) || kdf['name'] !== 'scrypt') return null
  const N = kdf['N']
  const r = kdf['r']
  const p = kdf['p']
  const salt = kdf['salt']
  if (!isPositiveInteger(N) || !isPositiveInteger(r) || !isPositiveInteger(p)) return null
  /*
   * **KDF のパラメータに上限を課す。** ファイルの言い値でメモリを確保するので、
   * `N` に巨大な値を書かれると `scrypt` が確保しようとして落ちる（or 固まる）。
   * 復号できないことより、開いた瞬間にアプリが死ぬ方が困る。
   */
  if (N > 2 ** 20 || r > 32 || p > 16) return null
  if (!isBase64(salt, 4096)) return null

  const iv = raw['iv']
  const tag = raw['tag']
  const ciphertext = raw['ciphertext']
  if (!isBase64(iv, 128) || !isBase64(tag, 128) || !isBase64(ciphertext, MAX_CIPHERTEXT)) return null

  return {
    meta,
    kdf: { name: 'scrypt', N, r, p, salt },
    iv,
    ciphertext,
    tag
  }
}

/**
 * @param {unknown} raw
 * @returns {VaultMeta | null}
 */
function normalizeVaultMeta(raw) {
  if (!isRecord(raw)) return null
  const count = raw['count']
  const savedAt = raw['savedAt']
  const host = raw['host']
  const appVersion = raw['appVersion']
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null
  if (!isPositiveInteger(savedAt)) return null
  if (typeof host !== 'string' || typeof appVersion !== 'string') return null
  return {
    count,
    savedAt,
    host: host.slice(0, MAX_META_TEXT),
    appVersion: appVersion.slice(0, MAX_META_TEXT)
  }
}

/**
 * 保管庫に入れるルール 1 件。**パスワードは平文**（暗号の中にしか置かない）。
 *
 * `enabled` は持たない —— 保管庫には**有効なものしか入れない**と決めているので、
 * フィールドがあると「無効なものも運べる」と読めてしまう。
 *
 * @typedef {object} VaultRule
 * @property {string} pattern
 * @property {string} username
 * @property {string} password 平文
 * @property {number} [updatedAt]
 */

/**
 * 復号したあとの中身を検査する。
 *
 * **これが無いと `commitRules` 内の `normalizeRules` が黙って落とす**
 * （不正なパターン・長さ超過・200 件超）。落ちた件数が分からないと
 * 「N 件読み込みました」と実際の件数が食い違う。
 *
 * @param {unknown} raw
 * @returns {{ rules: VaultRule[], dropped: number }}
 */
export function normalizeVaultPayload(raw) {
  if (!Array.isArray(raw)) return { rules: [], dropped: 0 }

  /** @type {VaultRule[]} */
  const rules = []
  let dropped = 0
  const seen = new Set()

  for (const item of raw) {
    if (rules.length >= HTTP_AUTH_LIMITS.MAX_RULES) {
      dropped += 1
      continue
    }
    if (!isRecord(item)) {
      dropped += 1
      continue
    }
    const pattern = item['pattern']
    const username = item['username']
    const password = item['password']
    if (!validateHttpAuthPattern(pattern).ok) {
      dropped += 1
      continue
    }
    // 同じパターンが 2 件あると、取り込んだ側で片方が黙って消える（`normalizeRules` が落とす）
    if (seen.has(pattern)) {
      dropped += 1
      continue
    }
    if (typeof username !== 'string' || username.length > HTTP_AUTH_LIMITS.MAX_USERNAME) {
      dropped += 1
      continue
    }
    if (typeof password !== 'string' || password.length > HTTP_AUTH_LIMITS.MAX_PASSWORD) {
      dropped += 1
      continue
    }
    /** @type {VaultRule} */
    const rule = { pattern: /** @type {string} */ (pattern), username, password }
    const updatedAt = item['updatedAt']
    if (isPositiveInteger(updatedAt)) rule.updatedAt = updatedAt
    seen.add(pattern)
    rules.push(rule)
  }

  return { rules, dropped }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * base64 らしさの検査。**長さの上限もここで見る**（巨大な文字列を Buffer に流さない）。
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {value is string}
 */
function isBase64(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}
