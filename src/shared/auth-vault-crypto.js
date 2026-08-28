// @ts-check
/**
 * Basic 認証の保管庫の暗号。
 *
 * **renderer から import しない**（`node:crypto` が web バンドルに入る）。
 * 定数と検証は `auth-vault-schema.js` にあり、そちらは renderer も読む。
 * `src/shared/tree-hash.js` が同じ形（node 組み込みを引く shared モジュール）。
 *
 * `safeStorage` は端末鍵なので、暗号文をそのまま別の Mac へ運んでも復号できない。
 * ここはその代わりに**パスフレーズ由来の鍵**（scrypt）で AES-256-GCM を張る。
 *
 * **平文メタ（件数・保存日時・端末名）は AAD に入れず、写しを暗号の中に入れて
 * 復号後に突き合わせる。** AAD にすると改竄でも認証タグが落ちるだけなので、
 * 「パスフレーズが違う」と**原理的に区別できなくなる**（GCM は失敗の理由を返さない）。
 * 区別できないと、打ち間違いに対して「保管庫を削除して作り直す」を提示することになる。
 * 写しの突き合わせなら、鍵が正しいことを確かめた上で改竄だけを名指しできる。
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { normalizeVaultFile } from './auth-vault-schema.js'

/**
 * scrypt のパラメータ。
 *
 * **`N = 2 ** 17` にしない。** 1 回の派生が数百 ms〜1s かかり、
 * 保管庫は「パスフレーズ入力 → preview → 実行」で 1 フロー 2 回派生するので、
 * ダイアログの往復ごとに待たされる（自走検証も同じだけ伸びる）。
 */
export const KDF_PARAMS = { name: /** @type {const} */ ('scrypt'), N: 2 ** 16, r: 8, p: 1 }

/**
 * `scrypt` が要求するメモリ。既定の `maxmem`（32MB）では `N = 2 ** 16` が通らないので**明示する**。
 * 目安は `128 * N * r`（= 64MB）。余裕を見て倍を渡す。
 */
const MAXMEM = 128 * KDF_PARAMS.N * KDF_PARAMS.r * 2

const KEY_LENGTH = 32
const IV_LENGTH = 12
const SALT_LENGTH = 16

/**
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {{ N: number, r: number, p: number }} params
 * @returns {Promise<Buffer>}
 */
function deriveKey(passphrase, salt, params) {
  return new Promise((resolve, reject) => {
    /*
     * **同期版（`scryptSync`）を使わない。** main プロセスが数百 ms 固まると
     * 全ウィンドウの描画と IPC が止まる。
     */
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      }
    )
  })
}

/**
 * 平文メタと、暗号の中に入れた写しが一致するか。
 *
 * @param {import('./auth-vault-schema.js').VaultMeta} outer
 * @param {unknown} inner
 * @returns {boolean}
 */
function metaMatches(outer, inner) {
  if (typeof inner !== 'object' || inner === null) return false
  const copy = /** @type {Record<string, unknown>} */ (inner)
  return (
    copy['count'] === outer.count &&
    copy['savedAt'] === outer.savedAt &&
    copy['host'] === outer.host &&
    copy['appVersion'] === outer.appVersion
  )
}

/**
 * 保管庫のファイル本体（`{ version, data }` の `data`）を作る。
 *
 * @param {import('./auth-vault-schema.js').VaultRule[]} rules 平文のルール
 * @param {string} passphrase
 * @param {import('./auth-vault-schema.js').VaultMeta} meta
 * @returns {Promise<import('./auth-vault-schema.js').VaultFile>}
 */
export async function encryptVault(rules, passphrase, meta) {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(passphrase, salt, KDF_PARAMS)

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  // メタの写しを**暗号の中にも**入れる（外側だけ書き換えられたら復号後に気づける）
  const body = JSON.stringify({ meta, rules })
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(body, 'utf8')), cipher.final()])

  return {
    meta,
    kdf: { ...KDF_PARAMS, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  }
}

/**
 * 復号の失敗理由。
 *
 * - `bad-passphrase` … 鍵が違う（認証タグが通らない）。**やり直せば直る**
 * - `tampered` … 鍵は正しいが中身が食い違う。やり直しても直らない
 * - `malformed` … 封筒の形が違う（そもそも復号を試みていない）
 *
 * @typedef {'bad-passphrase' | 'tampered' | 'malformed'} VaultDecryptError
 */

/**
 * @typedef {{ ok: true, rules: unknown } | { ok: false, reason: VaultDecryptError }} VaultDecryptResult
 */

/**
 * 保管庫を復号する。ルールの検査は `normalizeVaultPayload` の仕事なので、
 * ここは**パースとメタの突き合わせまで**を返す。
 *
 * @param {unknown} raw `readVersioned` が剥がしたあとの `data`
 * @param {string} passphrase
 * @returns {Promise<VaultDecryptResult>}
 */
export async function decryptVault(raw, passphrase) {
  const file = normalizeVaultFile(raw)
  if (!file) return { ok: false, reason: 'malformed' }

  let plain
  try {
    const key = await deriveKey(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
    plain = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8')
  } catch {
    // 認証タグが通らない＝鍵が違うか暗号文が壊れている。**最も起きやすい方に倒す**
    return { ok: false, reason: 'bad-passphrase' }
  }

  let body
  try {
    body = JSON.parse(plain)
  } catch {
    // 認証タグが通ったのに JSON として読めない＝正しい鍵で書かれた壊れた中身
    return { ok: false, reason: 'tampered' }
  }

  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'tampered' }
  const inner = /** @type {Record<string, unknown>} */ (body)
  // **外側の平文メタが書き換えられていたらここで落ちる**
  if (!metaMatches(file.meta, inner['meta'])) return { ok: false, reason: 'tampered' }

  return { ok: true, rules: inner['rules'] }
}
