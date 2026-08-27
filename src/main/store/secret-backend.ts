import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { app, safeStorage } from 'electron'
import { resolveSecretBackendMode } from '../../shared/http-auth-rules.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'

/**
 * 暗号化・復号・利用可否判定を閉じ込める小さな backend。
 *
 * **自走検証が実 `safeStorage` に触ってはいけない。** macOS の `safeStorage` は
 * Keychain の許可ダイアログ（`SecurityAgent`）を上げるので、
 * 触った瞬間に**検証が永久に止まる**（このリポジトリで既に踏んでいる。
 * `VERIFY.md` と `docs/plans/2026-08-25-1924-github-pr-live-folder.md` に記録がある）。
 * `live-folders/token.ts` の `NEMO_GITHUB_TEST_AUTH` と同じ作法で、
 * **暗号化そのものを差し替えられるようにする**。
 *
 * ゲートは **`!app.isPackaged`**（`resolveSecretBackendMode` が判定し、
 * `scripts/http-auth-rules.test.mjs` が「パッケージ版では env を無視する」を固定している）。
 * このリポジトリはパッケージ済みの dev 版も配っているので、
 * env だけを条件にすると実運用のパスワードが Keychain を使わない形式で保存されうる。
 */

export interface SecretBackend {
  /** 端末鍵が使えるか。false なら**保存を断る**。 */
  isAvailable(): boolean
  /** base64 の暗号文を返す。 */
  encrypt(plain: string): string
  /** 復号する。**失敗は必ず投げる**（壊れた暗号文を握り続けない）。 */
  decrypt(cipher: string): string
}

const realBackend: SecretBackend = {
  isAvailable() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  encrypt(plain) {
    return safeStorage.encryptString(plain).toString('base64')
  },
  decrypt(cipher) {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
}

/**
 * Keychain に触らない差し替え backend。
 *
 * 形式は **固定ヘッダ + checksum**。base64 や XOR だと暗号文を 1 文字壊しても
 * 例外にならず、「1 件だけ無効化」の検査が**空振りしたまま PASS** してしまう。
 */
const TEST_PREFIX = 'NEMOTEST1:'

const memoryBackend: SecretBackend = {
  isAvailable() {
    return true
  },
  encrypt(plain) {
    const checksum = createHash('sha256').update(plain).digest('hex').slice(0, 16)
    return TEST_PREFIX + Buffer.from(`${checksum}:${plain}`, 'utf8').toString('base64')
  },
  decrypt(cipher) {
    if (!cipher.startsWith(TEST_PREFIX)) throw new Error('test backend: 形式が違う')
    const decoded = Buffer.from(cipher.slice(TEST_PREFIX.length), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator === -1) throw new Error('test backend: checksum が無い')
    const checksum = decoded.slice(0, separator)
    const plain = decoded.slice(separator + 1)
    if (createHash('sha256').update(plain).digest('hex').slice(0, 16) !== checksum) {
      throw new Error('test backend: checksum 不一致')
    }
    return plain
  }
}

/** 「この端末では暗号化できない」を模す backend。 */
const unavailableBackend: SecretBackend = {
  isAvailable() {
    return false
  },
  encrypt() {
    throw new Error('test backend: 暗号化は使えない')
  },
  decrypt() {
    throw new Error('test backend: 復号は使えない')
  }
}

let backend: SecretBackend = realBackend
let testing = false

/**
 * 検証中に「この端末では暗号化が使えない」へ切り替えるマーカー。
 *
 * **env ではなくファイルにする。** env だと起動から終了まで効きっぱなしになり、
 * 同じ起動で回している他の検査が全部「保存できない」に倒れる。
 * 差し替え backend が有効なときだけ見る（実運用では絶対に効かない）。
 */
export const UNAVAILABLE_MARKER = '.nemo-crypto-unavailable'

/** 起動時に 1 回だけ呼ぶ（ストアの初期化より前）。 */
export function initSecretBackend(): void {
  const mode = resolveSecretBackendMode(process.env['NEMO_HTTP_AUTH_TEST_CRYPTO'], app.isPackaged)
  backend = mode === 'memory' ? memoryBackend : mode === 'unavailable' ? unavailableBackend : realBackend
  testing = mode !== 'real'
  if (testing) log('http_auth.test_crypto', { mode })
  else if (process.env['NEMO_HTTP_AUTH_TEST_CRYPTO']) {
    console.error('[nemo] パッケージ版では NEMO_HTTP_AUTH_TEST_CRYPTO を無視した')
  }
}

export function getSecretBackend(): SecretBackend {
  if (testing) {
    try {
      fs.accessSync(userDataPath(UNAVAILABLE_MARKER))
      return unavailableBackend
    } catch {
      // マーカーが無ければ通常の差し替え backend
    }
  }
  return backend
}
