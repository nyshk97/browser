import fs from 'node:fs'
import { isRecord } from '../../shared/settings-schema.js'
import { logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { getSecretBackend } from './secret-backend.js'

/**
 * Jev（TypeSafe AI）の API キーの**古い置き場所**（この Mac の userData に端末鍵で暗号化）。
 *
 * **いまの置き場所は自動入力の保管庫**（`autofill-vault.ts`。iCloud・パスフレーズ）で、ここは
 * 移す前のキーを読むためだけに残している。プロフィールかキーを保存したときに保管庫へ移して、ここは消す。
 *
 * 復号に失敗したら捨てて「未設定」に戻す（`github-token.ts` と同じ）。
 * 暗号は `secret-backend.ts` に相乗りする（自走検証が実 Keychain に触らずに回せる）。
 */

const FILE_NAME = 'jev-key.json'

function filePath(): string {
  return userDataPath(FILE_NAME)
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
