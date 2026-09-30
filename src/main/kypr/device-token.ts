import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DeviceStore } from '../../vendor/kypr/client/index.ts'
import { isRecord } from '../../shared/settings-schema.js'
import { log, logError } from '../log.js'
import { getSecretBackend } from '../store/secret-backend.js'
import { kyprDir } from './cache-store.js'

/**
 * この Mac の Nemo を kypr に登録したしるし（サーバーが発行した端末トークン。kypr の `docs/crypto-spec.md`
 * 「端末の登録と合言葉」）。合言葉を設定したあとは、これが無いとマスターパスワードに加えて合言葉が要る。
 *
 * `device-keys.json` と同じく端末鍵（`safeStorage`）で暗号化して `userData/kypr/device-token.json` に置く
 * （別の Mac に持ち出しても開けない = その Mac では登録し直しになる）。**ログアウトでは消さない**
 * （端末の登録はアカウントと別に残す。取り消しは kypr の Web の「端末と合言葉」で行う）。
 * 自走検証は `secret-backend.ts` の差し替え（`NEMO_HTTP_AUTH_TEST_CRYPTO=memory`）で実 Keychain に触らない。
 */

function tokenFile(): string {
  return path.join(kyprDir(), 'device-token.json')
}

/** 端末の一覧に出す名前。Mac が複数あっても見分けられるよう、コンピューター名を添える。 */
function deviceName(): string {
  const host = os.hostname().replace(/\.local$/, '')
  return host ? `Nemo（${host}）` : 'Nemo'
}

async function load(): Promise<string | null> {
  let raw: string
  try {
    raw = fs.readFileSync(tokenFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // 読めないのを「トークン無し」と取り違えると、サーバーの device-required でキャッシュまで消える
    throw error
  }
  const backend = getSecretBackend()
  if (!backend.isAvailable()) throw new Error('safeStorage が使えないので端末トークンを読めない')
  try {
    const file: unknown = JSON.parse(raw)
    if (!isRecord(file) || typeof file['encrypted'] !== 'string') throw new Error('形が違う')
    const token = backend.decrypt(file['encrypted'])
    if (token === '') throw new Error('空')
    return token
  } catch (error) {
    // 壊れた・この Mac の端末鍵で開けないファイルは握り続けない（合言葉で入れば登録し直される）
    logError('kypr.device_token_unreadable', error, {})
    await clear()
    return null
  }
}

async function save(token: string): Promise<void> {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) {
    log('kypr.device_token_unavailable', {})
    return
  }
  fs.mkdirSync(kyprDir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile(), `${JSON.stringify({ version: 1, encrypted: backend.encrypt(token) })}\n`, {
    mode: 0o600
  })
  log('kypr.device_token_saved', {})
}

async function clear(): Promise<void> {
  try {
    fs.rmSync(tokenFile(), { force: true })
  } catch (error) {
    logError('kypr.device_token_forget_failed', error, {})
  }
}

export function hasDeviceToken(): boolean {
  return fs.existsSync(tokenFile())
}

export const deviceTokenStore: DeviceStore = {
  get name() {
    return deviceName()
  },
  load,
  save,
  clear
}
