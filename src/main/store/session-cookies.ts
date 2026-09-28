import fs from 'node:fs'
import { session } from 'electron'
import {
  applyCookieChange,
  parseSavedCookies,
  toSavedCookie,
  toSetDetails
} from '../../shared/session-cookies.js'
import { log, logError } from '../log.js'
import { AGENT_PARTITION, PAGE_PARTITION, userDataPath } from '../paths.js'
import { getSecretBackend } from './secret-backend.js'
import { getSettings, onSettingsChanged } from './settings.js'

/**
 * セッション cookie（有効期限の無い cookie = 多くのサイトのログイン）を再起動をまたいで引き継ぐ。
 *
 * Chromium は終了でセッション cookie を捨てるので、更新のたびにログアウトされていた。
 * Chrome の「前回のページを開く」と同じく、**タブの復元（`restoreSession`、既定 ON）が有効なら戻す**。
 * 更新・クラッシュ・⌘Q のどれで終わっても引き継ぐ（期限は設けない）。
 *
 * - 対象は常用（`PAGE_PARTITION`）と Claude の窓（`AGENT_PARTITION`）。プライベートは対象外（メモリだけの partition）
 * - 中身はログインのトークンそのものなので、**`secret-backend`（`safeStorage` = Keychain の鍵）で暗号化**する。
 *   使えないときは保存しない（平文では置かない）
 * - 終了処理（`before-quit`）は同期なので `cookies.get` を待てない。**`changed` イベントで写しを持ち**、
 *   変わるたびに数秒まとめて書く（ログイン直後に main が落ちても残るように）。終了時は写しを同期で書く
 * - 戻すのは起動時、**ページを読み込む前**（`index.ts`）
 */

type SavedCookie = NonNullable<ReturnType<typeof toSavedCookie>>

const FILE = 'session-cookies.json'
const FORMAT_VERSION = 1
const SAVE_DELAY_MS = 2000
/** 戻すのに時間がかかっても起動を人質に取らない。 */
const RESTORE_TIMEOUT_MS = 5000

const PROFILES = [
  { label: 'page', partition: PAGE_PARTITION },
  { label: 'agent', partition: AGENT_PARTITION }
] as const

type ProfileLabel = (typeof PROFILES)[number]['label']

interface SavedFile {
  version: number
  profiles: Partial<Record<ProfileLabel, string>>
}

const mirrors = new Map<ProfileLabel, Map<string, SavedCookie>>()
/** 起動時の復元が終わったか。終わる前に書くと、戻す前の空の写しで保存を上書きする。 */
let ready = false
let dirty = false
let timer: NodeJS.Timeout | null = null
let enabled = true
let unavailableLogged = false

function filePath(): string {
  return userDataPath(FILE)
}

/** 起動時に 1 回（`initSecretBackend()` と設定の読み込みの後、ウィンドウの復元より前）。 */
export async function initSessionCookies(): Promise<void> {
  for (const profile of PROFILES) {
    const mirror = new Map<string, SavedCookie>()
    mirrors.set(profile.label, mirror)
    session.fromPartition(profile.partition).cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (applyCookieChange(mirror, cookie as unknown as Record<string, unknown>, removed)) scheduleSave()
    })
  }
  enabled = getSettings().restoreSession
  onSettingsChanged((settings) => {
    if (settings.restoreSession === enabled) return
    enabled = settings.restoreSession
    if (enabled) scheduleSave()
    else removeFile()
  })
  if (enabled) await restore()
  else removeFile()
  ready = true
  if (dirty) scheduleSave()
}

async function restore(): Promise<void> {
  let saved: SavedFile
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('形式が違う')
    saved = parsed as SavedFile
    if (saved.version !== FORMAT_VERSION || !saved.profiles || typeof saved.profiles !== 'object') {
      throw new Error('形式が違う')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError('session_cookies.unreadable', error)
    return
  }
  const backend = getSecretBackend()
  if (!backend.isAvailable()) {
    log('session_cookies.crypto_unavailable', { phase: 'restore' })
    return
  }
  await Promise.all(
    PROFILES.map(async (profile) => {
      const cipher = saved.profiles[profile.label]
      if (typeof cipher !== 'string') return
      let cookies: SavedCookie[]
      try {
        cookies = parseSavedCookies(JSON.parse(backend.decrypt(cipher)))
      } catch (error) {
        logError('session_cookies.decrypt_failed', error, { profile: profile.label })
        return
      }
      const ses = session.fromPartition(profile.partition)
      const started = Date.now()
      let failed = 0
      const all = Promise.all(
        cookies.map((cookie) =>
          ses.cookies.set(toSetDetails(cookie)).catch(() => {
            failed += 1
          })
        )
      )
      const timedOut = await Promise.race([
        all.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), RESTORE_TIMEOUT_MS))
      ])
      log('session_cookies.restored', {
        profile: profile.label,
        count: cookies.length,
        failed,
        timedOut,
        ms: Date.now() - started
      })
    })
  )
}

function scheduleSave(): void {
  dirty = true
  if (!ready || !enabled || timer) return
  timer = setTimeout(() => {
    timer = null
    save()
  }, SAVE_DELAY_MS)
}

function save(): void {
  if (!ready || !enabled || !dirty) return
  const backend = getSecretBackend()
  if (!backend.isAvailable()) {
    if (!unavailableLogged) log('session_cookies.crypto_unavailable', { phase: 'save' })
    unavailableLogged = true
    return
  }
  try {
    const out: SavedFile = { version: FORMAT_VERSION, profiles: {} }
    for (const profile of PROFILES) {
      const cookies = [...(mirrors.get(profile.label)?.values() ?? [])]
      out.profiles[profile.label] = backend.encrypt(JSON.stringify(cookies))
    }
    const target = filePath()
    const temp = `${target}.tmp`
    fs.writeFileSync(temp, JSON.stringify(out), { mode: 0o600 })
    fs.renameSync(temp, target)
    dirty = false
  } catch (error) {
    logError('session_cookies.save_failed', error)
  }
}

function removeFile(): void {
  dirty = false
  if (timer) clearTimeout(timer)
  timer = null
  // 消せなくても起動・設定の更新を止めない（force で黙るのは ENOENT だけ）
  try {
    fs.rmSync(filePath(), { force: true })
  } catch (error) {
    logError('session_cookies.remove_failed', error)
  }
}

/** そのプロファイルの写しを空にして保存し直す（Claude in Nemo の全消去）。 */
export function forgetSessionCookies(label: ProfileLabel): void {
  mirrors.get(label)?.clear()
  scheduleSave()
}

/** 終了時（`before-quit`）。溜まっている変更を同期で書き切る。 */
export function closeSessionCookies(): void {
  if (timer) clearTimeout(timer)
  timer = null
  save()
}
