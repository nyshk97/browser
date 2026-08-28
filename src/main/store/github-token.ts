import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { userDataPath } from '../paths.js'
import { log, logError } from './../log.js'

/**
 * GitHub の PAT を置く専用ストア。
 *
 * **`settings.json` には置かない。** 設定は端末をまたいで持ち出される可能性がある一方、
 * `safeStorage` は端末鍵なので、持ち出し先では復号できない暗号文が配られるだけになる。
 * → 持ち出しの対象外にできる専用ファイル（`github-token.json`）に分ける。
 *
 * 決めごと:
 * - `safeStorage.isEncryptionAvailable()` が false なら**保存を断る**（平文では置かない）
 * - 復号に失敗したら**その場で捨てて「未設定」に戻す**（壊れた暗号文を握り続けない）
 * - **renderer へトークンを返す口は作らない**（IPC は保存 / 削除 / 種別だけを扱う）
 */

const FILE_NAME = 'github-token.json'

/** ファイルの形。`{ version, data }` は使わない（中身が1個の暗号文しか無い）。 */
interface StoredToken {
  /** base64 の暗号文。 */
  encrypted: string
}

function filePath(): string {
  return userDataPath(FILE_NAME)
}

/** 端末鍵が使えるか。false なら保存させない。 */
export function isTokenStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 保存されている PAT を読む。無ければ / 壊れていれば null。 */
export function readStoredToken(): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('github_token.read_failed', error, { file: FILE_NAME })
    }
    return null
  }
  let parsed: StoredToken
  try {
    parsed = JSON.parse(raw) as StoredToken
  } catch (error) {
    logError('github_token.parse_failed', error, { file: FILE_NAME })
    clearStoredToken()
    return null
  }
  if (typeof parsed?.encrypted !== 'string' || parsed.encrypted.length === 0) {
    clearStoredToken()
    return null
  }
  try {
    const token = safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'))
    return token.length > 0 ? token : null
  } catch (error) {
    // **壊れた暗号文を握り続けない**（別端末から同期された暗号文もここに来る）
    logError('github_token.decrypt_failed', error, { file: FILE_NAME })
    clearStoredToken()
    return null
  }
}

/**
 * PAT を保存する。**平文では絶対に置かない**ので、端末鍵が無ければ保存を断る。
 * @returns 保存できたか
 */
export function saveStoredToken(token: string): boolean {
  if (!isTokenStorageAvailable()) {
    log('github_token.save_refused', { reason: 'encryption_unavailable' })
    return false
  }
  const trimmed = token.trim()
  if (!trimmed) return false
  try {
    const encrypted = safeStorage.encryptString(trimmed).toString('base64')
    const target = filePath()
    const tmp = `${target}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // 所有者だけが読める権限で置く（暗号文でも他ユーザーに配らない）
    fs.writeFileSync(tmp, `${JSON.stringify({ encrypted })}\n`, { mode: 0o600 })
    fs.renameSync(tmp, target)
    log('github_token.saved', {})
    return true
  } catch (error) {
    logError('github_token.save_failed', error, { file: FILE_NAME })
    return false
  }
}

export function clearStoredToken(): void {
  try {
    fs.rmSync(filePath(), { force: true })
  } catch (error) {
    logError('github_token.clear_failed', error, { file: FILE_NAME })
  }
}

export function hasStoredToken(): boolean {
  try {
    fs.accessSync(filePath(), fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
