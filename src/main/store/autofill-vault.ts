import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { isRecord, readVersioned, writeVersioned } from '../../shared/settings-schema.js'
import { normalizeVaultFile, type VaultMeta } from '../../shared/auth-vault-schema.js'
import { decryptEnvelope, encryptEnvelope } from '../../shared/auth-vault-crypto.js'
import {
  AUTOFILL_VERSION,
  countFilled,
  normalizeProfile,
  type AutofillProfile
} from '../../shared/autofill-schema.js'
import { readWithTimeout, slotsDir, type SlotsDirKind } from './slots.js'
import { getSecretBackend } from './secret-backend.js'

/**
 * フォーム自動入力のプロフィールの保管庫。
 *
 * **Basic 認証の保管庫（`auth-vault.ts`）と同じ置き方**: セーブスロットのフォルダ（iCloud Drive）に
 * パスフレーズ由来の鍵で暗号化した 1 ファイルを置き、パスフレーズは `userData/` に端末鍵で覚える。
 * 暗号と封筒の検査も同じもの（`auth-vault-crypto.js` の `encryptEnvelope` / `normalizeVaultFile`）を使う。
 *
 * **違いはこのファイルが正であること。** Basic 認証の保管庫は持ち出し用の控えで、普段使う値は
 * 別（`store/http-auth.ts`）にある。こちらは自動入力のたびにこのファイルを読む。
 * 復号（scrypt）は数百 ms かかるので、**復号した中身を mtime とサイズで覚えておき**、
 * iCloud 経由で別の Mac が書き換えたら（mtime が変わったら）読み直す。
 */

const FILE_NAME = 'autofill.json'

/** パスフレーズの記憶。**iCloud ではなく `userData/`**（端末鍵の暗号文は持ち出せない）。 */
const PASSPHRASE_FILE = 'autofill-vault-key.json'

/** 暗号の中で中身を置くキー。 */
const FIELD = 'profile'

export type AutofillVaultState = 'empty' | 'ok' | 'unreadable'

export interface AutofillVaultStatus {
  state: AutofillVaultState
  meta: VaultMeta | null
  reason: string | null
  /** 新しい版の Nemo が書いたもの。**この間は削除も上書きもさせない**（`auth-vault.ts` と同じ理由）。 */
  isFutureVersion: boolean
  hasConflictCopy: boolean
  dir: string
  kind: SlotsDirKind
}

function vaultPath(): { dir: string; kind: SlotsDirKind; file: string } {
  const { dir, kind } = slotsDir()
  return { dir, kind, file: path.join(dir, FILE_NAME) }
}

/** iCloud の競合コピー（`autofill 2.json`）。**勝手にリネームも削除もしない**。 */
async function hasConflictCopy(dir: string): Promise<boolean> {
  try {
    return (await fsp.readdir(dir)).some((name) => /^autofill [^.]*\.json$/.test(name))
  } catch {
    return false
  }
}

async function quarantine(file: string, reason: string, error: unknown): Promise<void> {
  const backup = `${file}.broken-${Date.now()}`
  try {
    await fsp.rename(file, backup)
    logError('autofill_vault.quarantined', error, { file: path.basename(file), reason })
  } catch (renameError) {
    logError('autofill_vault.quarantine_failed', renameError, { file: path.basename(file) })
  }
}

type ReadResult =
  | { state: 'empty' }
  | { state: 'ok'; data: unknown; meta: VaultMeta; stamp: string }
  | { state: 'unreadable'; reason: string; future?: boolean }

/** ファイルを読んで封筒まで解く。**復号はしない**。 */
async function readVaultFile(): Promise<ReadResult> {
  const { file } = vaultPath()

  let raw: string
  let stamp: string
  try {
    const stat = await fsp.stat(file)
    stamp = `${stat.mtimeMs}:${stat.size}`
    raw = await readWithTimeout(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'empty' }
    const reason =
      code === 'ABORT_ERR' || (error as Error).name === 'AbortError'
        ? 'iCloud から取得できませんでした'
        : code === 'EPERM' || code === 'EACCES'
          ? '読み取りを許可されていません'
          : '読み込みに失敗しました'
    logError('autofill_vault.read_failed', error, { code: code ?? 'unknown' })
    return { state: 'unreadable', reason }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    await quarantine(file, 'parse_failed', error)
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }

  const versioned = readVersioned(parsed, AUTOFILL_VERSION)
  if (!versioned) {
    // **未来の版は退避しない**（全ての Mac が 1 ファイルを共有する。`auth-vault.ts` と同じ）
    const version = isRecord(parsed) ? parsed['version'] : undefined
    if (typeof version === 'number' && Number.isInteger(version) && version > AUTOFILL_VERSION) {
      return { state: 'unreadable', reason: '新しい版の Nemo で保存されています', future: true }
    }
    await quarantine(file, 'bad_version', new Error(`version=${String(version)}`))
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }

  const envelope = normalizeVaultFile(versioned.data)
  if (!envelope) {
    await quarantine(file, 'bad_envelope', new Error('封筒を読めない'))
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }
  return { state: 'ok', data: versioned.data, meta: envelope.meta, stamp }
}

export async function autofillVaultStatus(): Promise<AutofillVaultStatus> {
  const { dir, kind } = vaultPath()
  const [result, conflict] = await Promise.all([readVaultFile(), hasConflictCopy(dir)])
  const base = { hasConflictCopy: conflict, dir, kind, isFutureVersion: false }
  if (result.state === 'ok') return { ...base, state: 'ok', meta: result.meta, reason: null }
  if (result.state === 'unreadable') {
    return {
      ...base,
      state: 'unreadable',
      meta: null,
      reason: result.reason,
      isFutureVersion: result.future === true
    }
  }
  return { ...base, state: 'empty', meta: null, reason: null }
}

export type OpenAutofillResult =
  | { ok: true; profile: AutofillProfile; meta: VaultMeta }
  | {
      ok: false
      reason: 'empty' | 'unreadable' | 'bad-passphrase' | 'tampered' | 'malformed'
      detail?: string
      future?: boolean
    }

/** 復号済みの中身。**同じファイル（mtime とサイズ）と同じパスフレーズのときだけ**使い回す。 */
let cache: { stamp: string; passphrase: string; profile: AutofillProfile; meta: VaultMeta } | null = null

/** パスフレーズで開く。 */
export async function openAutofillVault(passphrase: string): Promise<OpenAutofillResult> {
  const result = await readVaultFile()
  if (result.state === 'empty') {
    cache = null
    return { ok: false, reason: 'empty' }
  }
  if (result.state === 'unreadable') {
    cache = null
    return { ok: false, reason: 'unreadable', detail: result.reason, future: result.future === true }
  }
  if (cache && cache.stamp === result.stamp && cache.passphrase === passphrase) {
    return { ok: true, profile: { ...cache.profile }, meta: cache.meta }
  }
  const decrypted = await decryptEnvelope(result.data, FIELD, passphrase)
  if (!decrypted.ok) return { ok: false, reason: decrypted.reason }
  const profile = normalizeProfile(decrypted.payload)
  cache = { stamp: result.stamp, passphrase, profile, meta: result.meta }
  return { ok: true, profile: { ...profile }, meta: result.meta }
}

/** 書く（tmp + rename）。上書きしてよいかの判断（パスフレーズの一致）は呼び出し側。 */
export async function saveAutofillVault(
  profile: AutofillProfile,
  passphrase: string,
  meta: Omit<VaultMeta, 'count'>
): Promise<boolean> {
  const { dir, kind, file } = vaultPath()
  const tmp = `${file}.tmp-${process.pid}`
  const normalized = normalizeProfile(profile)
  try {
    const full: VaultMeta = { ...meta, count: countFilled(normalized) }
    const encrypted = await encryptEnvelope(normalized, FIELD, passphrase, full)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(tmp, `${JSON.stringify(writeVersioned(AUTOFILL_VERSION, encrypted), null, 2)}\n`)
    await fsp.rename(tmp, file)
    cache = null
    log('autofill_vault.saved', { kind, count: full.count })
    return true
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    logError('autofill_vault.save_failed', error, {})
    return false
  }
}

/** 消す。**パスフレーズを忘れたときの唯一の回復経路**。 */
export async function deleteAutofillVault(): Promise<boolean> {
  const { file } = vaultPath()
  try {
    await fsp.rm(file, { force: true })
    cache = null
    log('autofill_vault.deleted', {})
    return true
  } catch (error) {
    logError('autofill_vault.delete_failed', error, {})
    return false
  }
}

/* ---- パスフレーズの記憶（`auth-vault.ts` と同じ作法。ファイルは別） ---- */

export function rememberAutofillPassphrase(passphrase: string): boolean {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return false
  try {
    const encrypted = backend.encrypt(passphrase)
    fs.writeFileSync(userDataPath(PASSPHRASE_FILE), `${JSON.stringify({ encrypted })}\n`, { mode: 0o600 })
    log('autofill_vault.passphrase_remembered', {})
    return true
  } catch (error) {
    logError('autofill_vault.passphrase_remember_failed', error, {})
    return false
  }
}

export function recallAutofillPassphrase(): string | null {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return null
  let raw: string
  try {
    raw = fs.readFileSync(userDataPath(PASSPHRASE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      logError('autofill_vault.passphrase_read_failed', error, {})
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed['encrypted'] !== 'string') {
      forgetAutofillPassphrase()
      return null
    }
    return backend.decrypt(parsed['encrypted'])
  } catch (error) {
    logError('autofill_vault.passphrase_decrypt_failed', error, {})
    forgetAutofillPassphrase()
    return null
  }
}

export function forgetAutofillPassphrase(): void {
  try {
    fs.rmSync(userDataPath(PASSPHRASE_FILE), { force: true })
  } catch (error) {
    logError('autofill_vault.passphrase_forget_failed', error, {})
  }
}
