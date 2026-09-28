import fs from 'node:fs'
import path from 'node:path'
import { b64Decode, b64Encode } from '../../vendor/kypr/crypto/index.ts'
import type { DeviceKeys } from '../../vendor/kypr/client/index.ts'
import { isRecord } from '../../shared/settings-schema.js'
import { log, logError } from '../log.js'
import { getSecretBackend } from '../store/secret-backend.js'
import { kyprDir } from './cache-store.js'

/**
 * Touch ID で解除するための鍵（`vaultKey` と `authKey`）を、この Mac の端末鍵（`safeStorage`）で暗号化して
 * `userData/kypr/device-keys.json` に置く。**取り出すのは Touch ID を通したあとだけ**（呼び出し側が守る）。
 *
 * 端末鍵の暗号文は持ち出せない（別の Mac では開けない）ので iCloud には置かない。
 * 自走検証は `secret-backend.ts` の差し替え（`NEMO_HTTP_AUTH_TEST_CRYPTO=memory`）で実 Keychain に触らない。
 */

function keysFile(): string {
  return path.join(kyprDir(), 'device-keys.json')
}

export function hasDeviceKeys(): boolean {
  return fs.existsSync(keysFile())
}

export function saveDeviceKeys(keys: DeviceKeys): boolean {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return false
  try {
    const encrypted = backend.encrypt(
      JSON.stringify({ vaultKey: b64Encode(keys.vaultKey), authKey: b64Encode(keys.authKey) })
    )
    fs.mkdirSync(kyprDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(keysFile(), `${JSON.stringify({ version: 1, encrypted })}\n`, { mode: 0o600 })
    log('kypr.device_keys_saved', {})
    return true
  } catch (error) {
    logError('kypr.device_keys_save_failed', error, {})
    return false
  } finally {
    keys.vaultKey.fill(0)
    keys.authKey.fill(0)
  }
}

export function loadDeviceKeys(): DeviceKeys | null {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return null
  let raw: string
  try {
    raw = fs.readFileSync(keysFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      logError('kypr.device_keys_read_failed', error, {})
    return null
  }
  try {
    const file: unknown = JSON.parse(raw)
    if (!isRecord(file) || typeof file['encrypted'] !== 'string') throw new Error('形が違う')
    const inner: unknown = JSON.parse(backend.decrypt(file['encrypted']))
    if (!isRecord(inner)) throw new Error('形が違う')
    const vaultKey = b64Decode(inner['vaultKey'])
    const authKey = b64Decode(inner['authKey'])
    if (vaultKey.length !== 32 || authKey.length !== 32) throw new Error('鍵の長さが違う')
    return { vaultKey, authKey }
  } catch (error) {
    // 読めない鍵は握り続けない（マスターパスワードで入れ直せば作り直される）
    logError('kypr.device_keys_unreadable', error, {})
    forgetDeviceKeys()
    return null
  }
}

export function forgetDeviceKeys(): void {
  try {
    fs.rmSync(keysFile(), { force: true })
  } catch (error) {
    logError('kypr.device_keys_forget_failed', error, {})
  }
}
