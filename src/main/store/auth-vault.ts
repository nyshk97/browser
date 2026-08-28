import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { isRecord, readVersioned, writeVersioned } from '../../shared/settings-schema.js'
import {
  AUTH_VAULT_VERSION,
  normalizeVaultFile,
  normalizeVaultPayload,
  type VaultMeta,
  type VaultRule
} from '../../shared/auth-vault-schema.js'
import { decryptVault, encryptVault } from '../../shared/auth-vault-crypto.js'
import { readWithTimeout, slotsDir, type SlotsDirKind } from './slots.js'
import { getSecretBackend } from './secret-backend.js'

/**
 * Basic 認証の保管庫（別の Mac へ持ち出すための 1 ファイル）。
 *
 * **セーブスロットと同じフォルダに置く**（`slotsDir()` をそのまま使う）。
 * パス解決・env の口・「保存先」の表示・フォルダを開く導線を二重に持たないため。
 * `slots.ts` の競合コピー検出は `^slot-(\d+) [^.]*\.json$` の厳密なパターンなので、
 * ここに `basic-auth.json` を置いても誤爆しない。
 *
 * **`JsonStore` を使わない。** `slots.ts` と同じ理由で、
 * iCloud 経由で別の Mac が書き換えるものをメモリにキャッシュしない。開くたびに読み直す。
 *
 * この層は**ファイル I/O と暗号だけに閉じる**（`store/http-auth.ts` を引かない）。
 * 中身は引数で受け取るので、検証の fixture 生成にも同じ関数が使える。
 */

const FILE_NAME = 'basic-auth.json'

/** パスフレーズの記憶。**iCloud ではなく `userData/`**（端末鍵の暗号文は持ち出せない）。 */
const PASSPHRASE_FILE = 'auth-vault-key.json'

export type VaultState = 'empty' | 'ok' | 'unreadable'

export interface VaultStatus {
  state: VaultState
  /** `ok` のときだけ入る平文メタ（**復号せずに読める**）。 */
  meta: VaultMeta | null
  /** `unreadable` のときの理由（画面にそのまま出す）。 */
  reason: string | null
  /**
   * 新しい版の Nemo が書いたもの。**この間は削除の導線を出さない**
   * （`readVaultFile` が退避しないのは「古い Nemo が新しい方の保管庫を全件消さない」ため。
   * UI が削除ボタンを出すと同じ結果への近道になる）。**文字列一致で判定させない**。
   */
  isFutureVersion: boolean
  /** iCloud の競合コピー（`basic-auth 2.json`）があるか。 */
  hasConflictCopy: boolean
  dir: string
  kind: SlotsDirKind
}

function vaultPath(): { dir: string; kind: SlotsDirKind; file: string } {
  const { dir, kind } = slotsDir()
  return { dir, kind, file: path.join(dir, FILE_NAME) }
}

/**
 * iCloud の競合コピー。`basic-auth 2.json` の形（拡張子の前に ` <数字>` が付く）。
 *
 * **勝手にリネームも削除もしない**（`slots.ts` と同じ）。気づける形で画面に出すだけ。
 */
async function hasConflictCopy(dir: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return false
  }
  return entries.some((name) => /^basic-auth [^.]*\.json$/.test(name))
}

/** 壊れた JSON は消さずに退避する（黙って消すと「消えた」原因が追えない）。 */
async function quarantine(file: string, reason: string, error: unknown): Promise<void> {
  const backup = `${file}.broken-${Date.now()}`
  try {
    await fsp.rename(file, backup)
    logError('auth_vault.quarantined', error, { file: path.basename(file), reason })
  } catch (renameError) {
    logError('auth_vault.quarantine_failed', renameError, { file: path.basename(file) })
  }
}

/**
 * 読み取りの結果。**`state` で分岐できる形にして、呼び出し側に例外を投げない。**
 */
type ReadResult =
  | { state: 'empty' }
  | { state: 'ok'; data: unknown; meta: VaultMeta }
  | { state: 'unreadable'; reason: string; future?: boolean }

/**
 * ファイルを読んで封筒まで解く。**復号はしない**（パスフレーズが要らない層）。
 */
async function readVaultFile(): Promise<ReadResult> {
  const { file } = vaultPath()

  let raw: string
  try {
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
    logError('auth_vault.read_failed', error, { code: code ?? 'unknown' })
    return { state: 'unreadable', reason }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    await quarantine(file, 'parse_failed', error)
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }

  const versioned = readVersioned(parsed, AUTH_VAULT_VERSION)
  if (!versioned) {
    /*
     * **未来の版は退避しない。** `readVersioned` は「未来の版」も「version が壊れている」も
     * 同じく null を返すので、自分で見分ける（`slots.ts` と同じ）。
     *
     * 保管庫は**全ての Mac が 1 ファイルを共有する**。片方の Mac を先に更新すると、
     * 古い方の Nemo が設定画面を開いた瞬間にリネームして退避し、
     * **新しい方からも保管庫が丸ごと消える**（スロットは枠 1 つの被害で済むが、ここは全件）。
     */
    const version = isRecord(parsed) ? parsed['version'] : undefined
    if (typeof version === 'number' && Number.isInteger(version) && version > AUTH_VAULT_VERSION) {
      return { state: 'unreadable', reason: '新しい版の Nemo で保存されています', future: true }
    }
    await quarantine(file, 'bad_version', new Error(`version=${String(version)}`))
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }

  /*
   * **封筒の検査は `normalizeVaultFile` の 1 本に寄せる。** meta だけ見る緩い検査を
   * ここに書くと、kdf の欠けた壊れたファイルがカード上は `ok`「N 件」に見えてしまう
   * （実際は `decryptVault` が必ず `malformed` を返す）。`host` の長さも切られない。
   */
  const envelope = normalizeVaultFile(versioned.data)
  if (!envelope) {
    await quarantine(file, 'bad_envelope', new Error('封筒を読めない'))
    return { state: 'unreadable', reason: '中身が壊れていました' }
  }
  return { state: 'ok', data: versioned.data, meta: envelope.meta }
}

/**
 * カードに出す状態。
 *
 * **`locked`（復号できない）をここに混ぜない。** 混ぜるとカードを出すたびに scrypt を回すうえ、
 * パスフレーズを記憶していない Mac では常に `locked` に落ちて
 * **保存の入口が永久に塞がる**（「覚える」を OFF にした人と、読み込み直後の新しい Mac が該当）。
 * パスフレーズの成否は preview（`openVault`）が返す。
 */
export async function vaultStatus(): Promise<VaultStatus> {
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

/** 保管庫を開いた結果。**失敗の理由を畳まない**（打ち間違いに削除を勧めないため）。 */
export type OpenVaultResult =
  | { ok: true; rules: VaultRule[]; meta: VaultMeta; dropped: number }
  | {
      ok: false
      reason: 'empty' | 'unreadable' | 'bad-passphrase' | 'tampered' | 'malformed'
      detail?: string
    }

/**
 * パスフレーズで開く。preview と実行の**両方がこれを呼ぶ**
 * （実行時に読み直すので、間に別の Mac が書き換えていたら気づける）。
 */
export async function openVault(passphrase: string): Promise<OpenVaultResult> {
  const result = await readVaultFile()
  if (result.state === 'empty') return { ok: false, reason: 'empty' }
  if (result.state === 'unreadable') return { ok: false, reason: 'unreadable', detail: result.reason }

  const decrypted = await decryptVault(result.data, passphrase)
  if (!decrypted.ok) return { ok: false, reason: decrypted.reason }

  const { rules, dropped } = normalizeVaultPayload(decrypted.rules)
  if (dropped > 0) log('auth_vault.payload_dropped', { dropped })
  return { ok: true, rules, meta: result.meta, dropped }
}

/**
 * 保管庫を書く。**中身は引数で受ける**（この層は `store/http-auth.ts` を引かない）。
 *
 * tmp + rename。`slots.ts` の `saveSlot` と違って**既存ファイルの有無では弾かない**
 * —— 保管庫は上書きが前提で、「消えるもの」は呼び出し側が preview で見せている。
 */
export async function saveVault(
  rules: VaultRule[],
  passphrase: string,
  meta: Omit<VaultMeta, 'count'>
): Promise<boolean> {
  const { dir, kind, file } = vaultPath()
  const tmp = `${file}.tmp-${process.pid}`
  try {
    const full: VaultMeta = { ...meta, count: rules.length }
    const encrypted = await encryptVault(rules, passphrase, full)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(tmp, `${JSON.stringify(writeVersioned(AUTH_VAULT_VERSION, encrypted), null, 2)}\n`)
    await fsp.rename(tmp, file)
    log('auth_vault.saved', { kind, count: rules.length })
    return true
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    logError('auth_vault.save_failed', error, {})
    return false
  }
}

/** 保管庫を消す。**パスフレーズを忘れたときの唯一の回復経路**なので、失敗させない。 */
export async function deleteVault(): Promise<boolean> {
  const { file } = vaultPath()
  try {
    await fsp.rm(file, { force: true })
    log('auth_vault.deleted', {})
    return true
  } catch (error) {
    logError('auth_vault.delete_failed', error, {})
    return false
  }
}

/* ------------------------------------------------------------------ *
 * パスフレーズの記憶
 * ------------------------------------------------------------------ */

/**
 * この Mac にパスフレーズを覚える。
 *
 * **`userData/` に置く**（保管庫と同じフォルダに置いたら、パスフレーズを暗号文の隣に
 * 配ることになる）。暗号は `secret-backend.ts` に相乗りするので、
 * 自走検証は差し替え backend で Keychain に触らずに回せる。
 */
export function rememberPassphrase(passphrase: string): boolean {
  const backend = getSecretBackend()
  // **端末鍵が使えないなら黙って平文で書かない。** 記憶を諦めて毎回入力に倒す
  if (!backend.isAvailable()) return false
  try {
    const encrypted = backend.encrypt(passphrase)
    fs.writeFileSync(userDataPath(PASSPHRASE_FILE), `${JSON.stringify({ encrypted })}\n`)
    log('auth_vault.passphrase_remembered', {})
    return true
  } catch (error) {
    logError('auth_vault.passphrase_remember_failed', error, {})
    return false
  }
}

/** 覚えているパスフレーズ。無ければ / 壊れていれば null。 */
export function recallPassphrase(): string | null {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return null
  let raw: string
  try {
    raw = fs.readFileSync(userDataPath(PASSPHRASE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('auth_vault.passphrase_read_failed', error, {})
    }
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed['encrypted'] !== 'string') {
      forgetPassphrase()
      return null
    }
    return backend.decrypt(parsed['encrypted'])
  } catch (error) {
    // 壊れた暗号文を握り続けない（`github-token.ts` と同じ作法）
    logError('auth_vault.passphrase_decrypt_failed', error, {})
    forgetPassphrase()
    return null
  }
}

/** 記憶を消す。**保管庫を削除するときにも呼ぶ**（古い記憶が次の初期値にならないように）。 */
export function forgetPassphrase(): void {
  try {
    fs.rmSync(userDataPath(PASSPHRASE_FILE), { force: true })
  } catch (error) {
    logError('auth_vault.passphrase_forget_failed', error, {})
  }
}

/** 記憶があるか（値そのものは renderer に渡さない）。 */
export function hasRememberedPassphrase(): boolean {
  return recallPassphrase() !== null
}
