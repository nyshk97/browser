import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../shared/settings-schema.js'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { getSecretBackend } from './secret-backend.js'

/**
 * Jev（TypeSafe AI）の API キーを置く専用ストア。
 *
 * `github-token.ts` と同じ決めごと:
 * - `settings.json` には置かない（端末鍵の暗号文は持ち出せない）
 * - 端末鍵が使えなければ**保存を断る**（平文では置かない）
 * - 復号に失敗したら捨てて「未設定」に戻す
 * - **renderer へキーを返す口は作らない**（IPC は保存 / 削除 / 有無だけ）
 *
 * 暗号は `secret-backend.ts` に相乗りする（自走検証が実 Keychain に触らずに回せる）。
 */

const FILE_NAME = 'jev-key.json'

function filePath(): string {
  return userDataPath(FILE_NAME)
}

export function jevKeyStorageAvailable(): boolean {
  return getSecretBackend().isAvailable()
}

export function readJevKey(): string | null {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return null
  let raw: string
  try {
    raw = fs.readFileSync(filePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError('jev_key.read_failed', error, {})
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed['encrypted'] !== 'string') {
      clearJevKey()
      return null
    }
    const key = backend.decrypt(parsed['encrypted'])
    return key.length > 0 ? key : null
  } catch (error) {
    logError('jev_key.decrypt_failed', error, {})
    clearJevKey()
    return null
  }
}

/** @returns 保存できたか */
export function saveJevKey(key: string): boolean {
  const backend = getSecretBackend()
  const trimmed = key.trim()
  if (!trimmed) return false
  if (!backend.isAvailable()) {
    log('jev_key.save_refused', { reason: 'encryption_unavailable' })
    return false
  }
  try {
    const target = filePath()
    const tmp = `${target}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify({ encrypted: backend.encrypt(trimmed) })}\n`, { mode: 0o600 })
    fs.renameSync(tmp, target)
    log('jev_key.saved', {})
    return true
  } catch (error) {
    logError('jev_key.save_failed', error, {})
    return false
  }
}

export function clearJevKey(): void {
  try {
    fs.rmSync(filePath(), { force: true })
  } catch (error) {
    logError('jev_key.clear_failed', error, {})
  }
}

export function hasJevKey(): boolean {
  return readJevKey() !== null
}
