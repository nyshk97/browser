import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../shared/settings-schema.js'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { getSecretBackend } from './secret-backend.js'

/**
 * Jev（TypeSafe AI）の API キーの置き場所（**Mac ごと**。この Mac の userData に端末鍵で暗号化）。
 *
 * 以前は自動入力の保管庫（iCloud・パスフレーズ）に入れていたが、値の元を kypr の個人情報に移したので
 * 保管庫ごとやめた（plan `2026-09-29-0934-kypr-identity-autofill.md`）。別の Mac ではそれぞれ保存する。
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

/** 保存できたかを返す（端末鍵が無ければ false）。**値はログに出さない**。 */
export function saveJevKey(key: string): boolean {
  const backend = getSecretBackend()
  const trimmed = key.trim()
  if (!backend.isAvailable() || !trimmed) return false
  try {
    const target = filePath()
    const tmp = `${target}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // 所有者だけが読める権限で置く（暗号文でも他ユーザーに配らない）
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

/**
 * やめた保管庫のパスフレーズの記憶（userData の `autofill-vault-key.json`）を消す。起動のたびに呼ぶ
 * （Mac ごとのファイルなので、各 Mac のそれぞれの起動で消える）。iCloud の `autofill.json` は触らない
 * （全 Mac を更新するまで古い版が読むので、消すのは人の手。plan「リリース後の片付け」）。
 */
export function removeRetiredAutofillPassphrase(): void {
  try {
    const file = userDataPath('autofill-vault-key.json')
    if (!fs.existsSync(file)) return
    fs.rmSync(file, { force: true })
    log('autofill.retired_passphrase_removed', {})
  } catch (error) {
    logError('autofill.retired_passphrase_remove_failed', error, {})
  }
}
