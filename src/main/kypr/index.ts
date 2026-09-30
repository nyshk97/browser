import { app, clipboard, powerMonitor } from 'electron'
import {
  ApiError,
  ConflictError,
  createApi,
  NetworkError,
  SessionExpiredError,
  UnlockError,
  VaultSession,
  type ClientDeps,
  type VaultEntry
} from '../../vendor/kypr/client/index.ts'
import { generatePassword, type CharsetName } from '../../vendor/kypr/client/generator.ts'
import {
  detectBrand,
  digitsOf,
  last4,
  normalizeExpMonth,
  normalizeExpYear
} from '../../vendor/kypr/client/card.ts'
import { matchingLogins, matchingTotps, parseUri } from '../../vendor/kypr/client/url-match.ts'
import {
  compareTotp,
  parseOtpauthUri,
  sameTotp,
  TOTP_PROBLEM_TEXT,
  totpNow,
  totpTitle
} from '../../vendor/kypr/client/totp.ts'
import { IDENTITY_FIELDS, identitySummary, isValidIdentityDate } from '../../vendor/kypr/client/identity.ts'
import {
  IDENTITY_KEYS,
  newCardItem,
  newIdentityItem,
  newLoginItem,
  newNoteItem,
  newTotpItem,
  normalizeTotpSecret,
  nowIso,
  totpProblem,
  type IdentityKey,
  type TotpItem,
  type VaultItem
} from '../../vendor/kypr/crypto/index.ts'
import { pickAutofillIdentity } from '../../shared/kypr-identity.js'
import { MAX_PROFILE_VALUE } from '../../shared/autofill-schema.js'
import {
  KYPR_CLIPBOARD_CLEAR_MS,
  KYPR_IDLE_LOCK_MS,
  KYPR_SYNC_INTERVAL_MS,
  resolveKyprServer
} from '../../shared/kypr-config.js'
import type {
  KyprActionResult,
  KyprBadge,
  KyprItemDetail,
  KyprItemInput,
  KyprStatus,
  KyprSummary,
  KyprTotpCheck,
  KyprTotpCode,
  KyprTotpDraft,
  KyprUnlockResult
} from '../../shared/types.js'
import { log, logError } from '../log.js'
import fs from 'node:fs'
import path from 'node:path'
import { FileCacheStore, kyprDir } from './cache-store.js'
import { deriveInWorker, derivePassphraseInWorker } from './kdf.js'
import { forgetDeviceKeys, hasDeviceKeys, loadDeviceKeys, saveDeviceKeys } from './device-keys.js'
import { deviceTokenStore } from './device-token.js'
import { promptTouchId, touchIdAvailable } from './touch-id.js'

/**
 * kypr（自作のパスワードマネージャー）の保管庫を main で持つ（plan `2026-09-28-2232-kypr-integration.md`）。
 *
 * - **鍵と平文は main だけが持つ**。renderer（Nemo の UI）には一覧に要る項目と、開いたアイテムの分だけ渡す
 * - 解除はアプリ全体で 1 つ（シークレットウィンドウも同じ状態を使う）
 * - ロック: 画面ロック・スリープ・終了・1 時間使わなかったとき
 * - 同期のきっかけ: 解除・候補やバッジを出す直前（前回から 1 分以上）・書き込みの後（共通のクライアントが反映する）
 */

const cache = new FileCacheStore()
let server: { url: string; testing: boolean } | null = null
let disabledReason: string | null = 'not-initialized'
let session: VaultSession | null = null
let lastSyncAt: number | null = null
/** 最後に同期を試した時刻（失敗しても更新する。オフラインの間に push のたび撃ち直さないため）。 */
let lastSyncAttemptAt = 0
let lastUseAt = 0
let syncing: Promise<void> | null = null
/**
 * この Mac は kypr に登録されていない（合言葉が設定済みで、サーバーが device-required を返した）。
 * 解除の画面に合言葉の欄を出す。合言葉で入れたら（この Mac を登録したら）下ろす。
 */
let needsPassphrase = false
/** 一覧の世代（変わるたびに増やす。バッジの件数の覚えを捨てる）。 */
let generation = 0
const listeners = new Set<() => void>()

/** 使わないとロックするまで。自走検証だけ env で縮める（パッケージ版では無視する）。 */
function idleLockMs(): number {
  const override = Number(process.env['NEMO_KYPR_TEST_IDLE_MS'])
  if (!app.isPackaged && Number.isFinite(override) && override > 0) return override
  return KYPR_IDLE_LOCK_MS
}

export function initKypr(): void {
  const resolved = resolveKyprServer({
    testServer: process.env['NEMO_KYPR_TEST_SERVER'],
    isPackaged: app.isPackaged,
    verifyMode: process.env['NEMO_VERIFY_DIAGNOSTICS'] === '1'
  })
  if (!resolved.ok) {
    disabledReason = resolved.reason
    log('kypr.disabled', { reason: resolved.reason })
    return
  }
  server = { url: resolved.url, testing: resolved.testing }
  disabledReason = null
  log('kypr.init', { testing: resolved.testing, signedIn: cache.hasAccount() })
  powerMonitor.on('lock-screen', () => lockKypr('screen-lock'))
  powerMonitor.on('suspend', () => lockKypr('suspend'))
  const tick = Math.min(60_000, Math.max(1_000, Math.floor(idleLockMs() / 4)))
  setInterval(() => {
    if (session && Date.now() - lastUseAt >= idleLockMs()) lockKypr('idle')
  }, tick).unref()
}

/** kypr のサーバーの origin（Web 版もここから配られる）。kypr が無効なら null。 */
export function kyprServerOrigin(): string | null {
  return server?.url ?? null
}

export function onKyprChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  generation += 1
  badgeMemo.clear()
  for (const fn of listeners) {
    try {
      fn()
    } catch (error) {
      logError('kypr.listener_failed', error, {})
    }
  }
}

function deps(): ClientDeps {
  if (!server) throw new Error('kypr は使えない')
  return {
    api: createApi(server.url, (input, init) => fetch(input, init)),
    cache,
    derive: deriveInWorker,
    derivePassphrase: derivePassphraseInWorker,
    device: deviceTokenStore,
    reloginOnExpiry: true
  }
}

/** 使った（自動入力・コピー・ポップアップの操作）。1 時間の未使用のロックを延ばす。 */
export function touchKypr(): void {
  lastUseAt = Date.now()
}

export function kyprState(): KyprStatus['state'] {
  if (!server) return 'disabled'
  if (session) return 'unlocked'
  return cache.hasAccount() ? 'locked' : 'signed-out'
}

export function kyprStatus(): KyprStatus {
  return {
    state: kyprState(),
    readOnly: session?.readOnly ?? false,
    server: server?.url ?? null,
    disabledReason,
    touchIdAvailable: touchIdAvailable(),
    touchIdEnrolled: hasDeviceKeys(),
    lastSyncAt,
    itemCount: session ? session.entries.size : cache.itemCount(),
    needsPassphrase
  }
}

/**
 * 自走検証の対照（「平文で保存するように細工した版」）。`NEMO_KYPR_TEST_LEAK=1` のときだけ、
 * 解除したら一覧（名前・ユーザー名）を平文で userData に書く。**パッケージ版では効かない**。
 * 平文が無いことの検査が、この細工を実際に見つけられることを確かめるためだけにある。
 */
function leakForVerify(): void {
  if (process.env['NEMO_KYPR_TEST_LEAK'] !== '1' || app.isPackaged) return
  try {
    fs.mkdirSync(kyprDir(), { recursive: true })
    fs.writeFileSync(path.join(kyprDir(), 'leak-for-verify.json'), JSON.stringify(kyprSummaries()))
  } catch (error) {
    logError('kypr.leak_for_verify_failed', error, {})
  }
}

function attach(next: VaultSession): void {
  session = next
  next.subscribe(() => {
    // 他のところ（lock）で差し替わった古いセッションの通知は無視する
    if (session === next) notify()
  })
  if (!next.readOnly) lastSyncAt = Date.now()
  touchKypr()
  leakForVerify()
  notify()
}

function unlockFailure(error: unknown): KyprUnlockResult {
  if (error instanceof UnlockError) {
    const f = error.failure
    if (f.code === 'locked') return { ok: false, reason: 'locked', retryAfter: f.retryAfter }
    if (f.code === 'setup-rejected') return { ok: false, reason: 'no-account' }
    return { ok: false, reason: f.code }
  }
  logError('kypr.unlock_failed', error, {})
  return { ok: false, reason: 'temporary' }
}

/**
 * この Mac が登録されていなかった（device-required）。キャッシュと端末トークンは共通のクライアントが消している。
 * Touch ID の鍵も捨て、解除の画面に合言葉の欄を出す
 */
function onDeviceRequired(): void {
  forgetDeviceKeys()
  needsPassphrase = true
  notify()
}

/**
 * マスターパスワードで解除する（この Mac で初めてのログインも同じ）。
 * `passphrase` は、この Mac が登録されていないとき（`needsPassphrase`）だけ。Nemo は自分の Mac なので、合言葉で入ったら登録する
 */
export async function signInKypr(
  password: string,
  rememberTouchId: boolean,
  passphrase?: string
): Promise<KyprUnlockResult> {
  if (!server) return { ok: false, reason: 'disabled' }
  if (typeof password !== 'string' || password === '' || password.length > 1024) {
    return { ok: false, reason: 'bad-password' }
  }
  if (passphrase !== undefined && (passphrase === '' || passphrase.length > 1024)) {
    return { ok: false, reason: 'bad-password' }
  }
  let next: VaultSession
  try {
    next = await VaultSession.unlock(
      deps(),
      password,
      passphrase === undefined ? undefined : { passphrase, register: true }
    )
  } catch (error) {
    const result = unlockFailure(error)
    if (!result.ok && result.reason === 'device-required') onDeviceRequired()
    log('kypr.sign_in', { ok: false, reason: result.ok ? null : result.reason })
    return result
  }
  needsPassphrase = false
  // 導出を待つ間に別の経路（Touch ID）で解除されていたら、そちらを残して今回のものは捨てる
  if (session) {
    next.lock()
    return { ok: true }
  }
  attach(next)
  if (rememberTouchId && touchIdAvailable()) saveDeviceKeys(next.deviceKeys())
  log('kypr.sign_in', { ok: true, readOnly: next.readOnly, touchId: rememberTouchId && touchIdAvailable() })
  notify()
  return { ok: true }
}

/** Touch ID で解除する。覚えた鍵をサーバーが認めなければ捨てて、マスターパスワードに回す。 */
export async function unlockKyprWithTouchId(): Promise<KyprUnlockResult> {
  if (!server) return { ok: false, reason: 'disabled' }
  if (session) return { ok: true }
  if (!hasDeviceKeys()) return { ok: false, reason: 'no-device-keys' }
  if (!(await promptTouchId('kypr のロックを解除'))) {
    log('kypr.touch_id', { ok: false })
    return { ok: false, reason: 'touch-id-failed' }
  }
  const keys = loadDeviceKeys()
  if (!keys) return { ok: false, reason: 'no-device-keys' }
  try {
    const next = await VaultSession.unlockWithDeviceKeys(deps(), keys)
    // 待つ間に別の経路で解除されていたら、置き去りにせず今回のものを捨てる（鍵を 0 で埋め、トークンも返す）
    if (session) {
      next.lock()
      return { ok: true }
    }
    attach(next)
    log('kypr.touch_id', { ok: true, readOnly: next.readOnly })
    return { ok: true }
  } catch (error) {
    const result = unlockFailure(error)
    if (!result.ok && result.reason === 'bad-password') forgetDeviceKeys()
    if (!result.ok && result.reason === 'device-required') onDeviceRequired()
    log('kypr.touch_id', { ok: false, reason: result.ok ? null : result.reason })
    return result
  } finally {
    keys.vaultKey.fill(0)
    keys.authKey.fill(0)
  }
}

export function lockKypr(reason: string): void {
  if (!session) return
  const current = session
  session = null
  current.lock()
  clearOurClipboard()
  log('kypr.lock', { reason })
  notify()
}

export async function signOutKypr(): Promise<void> {
  lockKypr('sign-out')
  await cache.clear()
  forgetDeviceKeys()
  lastSyncAt = null
  log('kypr.sign_out', {})
  notify()
}

/** 同期する。読み取り専用で開いていたら、サーバーに届くようになったかも見る。 */
export async function syncKypr(): Promise<KyprActionResult> {
  const current = session
  if (!current) return { ok: false, reason: 'locked' }
  try {
    if (current.readOnly) await current.goOnline()
    else await current.sync()
    lastSyncAt = Date.now()
    notify()
    return { ok: true }
  } catch (error) {
    return actionFailure(error, 'sync')
  }
}

/** 前回の同期から時間が経っていれば、裏で同期する（待たない）。 */
export function syncKyprIfStale(): void {
  if (!session || syncing) return
  if (Date.now() - Math.max(lastSyncAt ?? 0, lastSyncAttemptAt) < KYPR_SYNC_INTERVAL_MS) return
  lastSyncAttemptAt = Date.now()
  syncing = syncKypr()
    .then(() => {})
    .finally(() => {
      syncing = null
    })
}

function actionFailure(error: unknown, action: string): KyprActionResult & { ok: false } {
  if (error instanceof ConflictError) return { ok: false, reason: 'conflict' }
  if (error instanceof NetworkError) return { ok: false, reason: 'offline' }
  if (error instanceof SessionExpiredError) {
    // authKey でもログインし直せない（マスターパスワードが変わった等）。覚えた鍵は使えないので捨てる
    forgetDeviceKeys()
    lockKypr('session-expired')
    return { ok: false, reason: 'session-expired' }
  }
  if (error instanceof ApiError && error.status === 410) return { ok: false, reason: 'purged' }
  if (error instanceof Error && error.message === '読み取り専用で開いています')
    return { ok: false, reason: 'read-only' }
  logError('kypr.action_failed', error, { action })
  return { ok: false, reason: 'failed' }
}

/* ---------------- 一覧・照合 ---------------- */

function summaryOf(entry: VaultEntry): KyprSummary {
  const base = { id: entry.id, deleted: entry.deletedAt !== null }
  const s = entry.state
  if (s.kind === 'login') {
    const first = s.item.uris[0]?.uri
    return {
      ...base,
      kind: 'login',
      name: s.item.name,
      subtitle: s.item.username,
      host: first ? (parseUri(first)?.host ?? null) : null
    }
  }
  if (s.kind === 'card') {
    const brand = s.item.brand || detectBrand(s.item.number)
    const tail = last4(s.item.number)
    return {
      ...base,
      kind: 'card',
      name: s.item.name,
      subtitle: [brand, tail ? `•••• ${tail}` : ''].filter(Boolean).join(' '),
      host: null
    }
  }
  if (s.kind === 'note') return { ...base, kind: 'note', name: s.item.name, subtitle: '', host: null }
  // 身分証の番号は一覧に出さない（氏名かメールだけ）
  if (s.kind === 'identity')
    return { ...base, kind: 'identity', name: s.item.name, subtitle: identitySummary(s.item), host: null }
  // ワンタイムコードの名前は「発行元: ラベル」。秘密鍵もコードも入れない（コードは kyprTotpCodes で別に渡す）
  if (s.kind === 'totp') {
    const first = s.item.uris[0]?.uri
    return {
      ...base,
      kind: 'totp',
      name: totpTitle(s.item),
      subtitle: '',
      host: first ? (parseUri(first)?.host ?? null) : null
    }
  }
  if (s.kind === 'unknown') {
    const name = typeof s.raw['name'] === 'string' ? s.raw['name'] : ''
    return {
      ...base,
      kind: 'unknown',
      name,
      subtitle: typeof s.raw['type'] === 'string' ? s.raw['type'] : '',
      host: null
    }
  }
  return { ...base, kind: 'error', name: '（開けないアイテム）', subtitle: s.code, host: null }
}

const byName = (a: KyprSummary, b: KyprSummary): number => a.name.localeCompare(b.name, 'ja')

/**
 * 一覧。ワンタイムコード以外は名前の順、ワンタイムコードはその後ろに発行元 → ラベルの順（発行元が空のものは末尾）。
 * 比べ方が違うものを 1 つの sort に混ぜると並びが揺れるので、分けて並べてからつなぐ
 */
export function kyprSummaries(): KyprSummary[] {
  if (!session) return []
  const entries = [...session.entries.values()]
  const totps = entries.flatMap((e) => (e.state.kind === 'totp' ? [{ entry: e, item: e.state.item }] : []))
  totps.sort((a, b) => compareTotp(a.item, b.item))
  return [
    ...entries
      .filter((e) => e.state.kind !== 'totp')
      .map(summaryOf)
      .sort(byName),
    ...totps.map((t) => summaryOf(t.entry))
  ]
}

/** そのページに合うログイン（ゴミ箱の中・隔離したもの・ログイン以外は出さない。kypr の共通の関数で弾く）。 */
export function kyprMatches(pageUrl: string): KyprSummary[] {
  if (!session) return []
  return matchingLogins(session.entries.values(), pageUrl).map(summaryOf).sort(byName)
}

/** そのページに合うワンタイムコード（URL を足したものだけ。ゴミ箱の中・隔離したものは出さない）。 */
export function kyprTotpMatches(pageUrl: string): KyprSummary[] {
  if (!session) return []
  return matchingTotps(session.entries.values(), pageUrl)
    .map((entry) => ({ entry, item: (entry.state as { kind: 'totp'; item: TotpItem }).item }))
    .sort((a, b) => compareTotp(a.item, b.item))
    .map((t) => summaryOf(t.entry))
}

/** 入力・コピーに使うワンタイムコード（ゴミ箱の中・ワンタイムコード以外は null）。 */
function totpEntry(id: string): TotpItem | null {
  const entry = session?.entries.get(id)
  if (!entry || entry.deletedAt !== null || entry.state.kind !== 'totp') return null
  return entry.state.item
}

/** 今のコード（ポップアップが 1 秒ごとに聞く）。知らない id・ゴミ箱の中は返さない。 */
export async function kyprTotpCodes(ids: string[]): Promise<Record<string, KyprTotpCode>> {
  const out: Record<string, KyprTotpCode> = {}
  for (const id of ids.slice(0, 500)) {
    const item = totpEntry(id)
    if (!item) continue
    const now = await totpNow(item)
    out[id] = 'code' in now ? now : { problem: now.problem, text: TOTP_PROBLEM_TEXT[now.problem] }
  }
  return out
}

/** 入れる先の URL とコード（入力の直前に照合し直すため URL も返す）。出せなければ null。 */
export async function kyprTotpForFill(
  id: string
): Promise<{ code: string; uris: { uri: string; match?: number | null }[] } | null> {
  const item = totpEntry(id)
  if (!item) return null
  const now = await totpNow(item)
  if (!('code' in now)) return null
  touchKypr()
  return { code: now.code, uris: item.uris }
}

/** バッジの件数は push のたびに聞かれるので、URL ごとに覚えておく（一覧が変わったら捨てる）。 */
const badgeMemo = new Map<string, number>()

export function kyprBadge(pageUrl: string | null): KyprBadge {
  const state = kyprState()
  if (state !== 'unlocked' || !pageUrl) return { state, count: 0 }
  syncKyprIfStale()
  let count = badgeMemo.get(pageUrl)
  if (count === undefined) {
    count = kyprMatches(pageUrl).length
    if (badgeMemo.size > 200) badgeMemo.clear()
    badgeMemo.set(pageUrl, count)
  }
  return { state, count }
}

export function kyprGeneration(): number {
  return generation
}

/** 入力に使うログイン（ゴミ箱の中・ログイン以外は null）。 */
export function kyprLoginForFill(
  id: string
): { username: string; password: string; uris: { uri: string; match?: number | null }[] } | null {
  const entry = session?.entries.get(id)
  if (!entry || entry.deletedAt !== null || entry.state.kind !== 'login') return null
  const { username, password, uris } = entry.state.item
  return { username, password, uris }
}

/**
 * フォーム自動入力に使う個人情報（`preferredId` は設定で選んだもの）。ロック中・0 件なら null。
 * 平文は main の中だけで使う（renderer には渡さない）。
 */
export function kyprIdentityForFill(
  preferredId: string | null
): { id: string; values: Record<IdentityKey, string> } | null {
  if (!session) return null
  const id = kyprAutofillIdentityId(preferredId)
  const entry = id ? session.entries.get(id) : undefined
  if (!entry || entry.state.kind !== 'identity') return null
  const item = entry.state.item
  touchKypr()
  return {
    id: entry.id,
    values: Object.fromEntries(IDENTITY_KEYS.map((k) => [k, item[k]])) as Record<IdentityKey, string>
  }
}

/** フォーム自動入力に使う個人情報の ID（設定で選んだもの → 一番古いもの）。 */
export function kyprAutofillIdentityId(preferredId: string | null): string | null {
  if (!session) return null
  const candidates = [...session.entries.values()].map((entry) => ({
    id: entry.id,
    kind: entry.state.kind,
    deleted: entry.deletedAt !== null,
    createdAt: entry.state.kind === 'identity' ? entry.state.item.createdAt : ''
  }))
  return pickAutofillIdentity(candidates, preferredId)
}

/** 詳細では渡さない秘密の項目（「表示」を押したとき・編集を開いたときだけ渡す）。 */
const SECRET_FIELDS: Record<string, readonly string[]> = {
  login: ['password'],
  card: ['number', 'code'],
  note: [],
  // 身分証の番号（伏せる項目は kypr の `identity.ts` が正）
  identity: IDENTITY_FIELDS.filter((f) => f.secret).map((f) => f.key),
  totp: ['secret']
}

/**
 * 詳細・編集に渡す平文。`withSecrets` が false なら秘密の項目を空にして、名前だけ `secrets` に入れる
 * （plan の既定「パスワード・カード番号・セキュリティコードは表示・コピー・編集を開いたときだけ渡す」）。
 */
export function kyprItem(id: string, withSecrets = false): KyprItemDetail | null {
  const entry = session?.entries.get(id)
  if (!entry) return null
  touchKypr()
  const s = entry.state
  const base = { id: entry.id, deleted: entry.deletedAt !== null }
  if (
    s.kind === 'login' ||
    s.kind === 'card' ||
    s.kind === 'note' ||
    s.kind === 'identity' ||
    s.kind === 'totp'
  ) {
    const item = structuredClone(s.item) as Record<string, unknown>
    const secrets: string[] = []
    for (const field of SECRET_FIELDS[s.kind] ?? []) {
      if (typeof item[field] === 'string' && item[field] !== '') secrets.push(field)
      if (!withSecrets) item[field] = ''
    }
    return { ...base, kind: s.kind, editable: true, item, secrets, error: null }
  }
  if (s.kind === 'unknown')
    return { ...base, kind: 'unknown', editable: false, item: null, secrets: [], error: null }
  return { ...base, kind: 'error', editable: false, item: null, secrets: [], error: s.code }
}

/** 秘密の項目を 1 つだけ取る（詳細で「表示」を押したとき）。 */
export function revealKyprField(id: string, field: string): string | null {
  const entry = session?.entries.get(id)
  if (!entry) return null
  const s = entry.state
  if (s.kind !== 'login' && s.kind !== 'card' && s.kind !== 'identity' && s.kind !== 'totp') return null
  if (!SECRET_FIELDS[s.kind]?.includes(field)) return null
  const value = (s.item as Record<string, unknown>)[field]
  touchKypr()
  return typeof value === 'string' ? value : null
}

/* ---------------- コピー ---------------- */

let clipboardValue: string | null = null
let clipboardTimer: ReturnType<typeof setTimeout> | null = null

/**
 * クリップボード。**自走検証は `NEMO_KYPR_TEST_CLIPBOARD=memory` でメモリ上のものに差し替える**
 * （実物のクリップボードを検証が書き換えない。パッケージ版では env を無視する）。
 */
const memoryClipboard = { text: '' }
const clip =
  process.env['NEMO_KYPR_TEST_CLIPBOARD'] === 'memory' && !app.isPackaged
    ? {
        readText: () => memoryClipboard.text,
        writeText: (value: string) => void (memoryClipboard.text = value),
        clear: () => void (memoryClipboard.text = '')
      }
    : {
        readText: () => clipboard.readText(),
        writeText: (value: string) => clipboard.writeText(value),
        clear: () => clipboard.clear()
      }

/** 自走検証の口（診断 API が生えているときだけ ipc.ts が呼ぶ）。差し替えていなければ null。 */
export function kyprClipboardForVerify(): string | null {
  return process.env['NEMO_KYPR_TEST_CLIPBOARD'] === 'memory' && !app.isPackaged ? memoryClipboard.text : null
}

/** 消すまでの時間。自走検証だけ env で縮める（パッケージ版では無視する）。 */
function clipboardClearMs(): number {
  const override = Number(process.env['NEMO_KYPR_TEST_CLIPBOARD_MS'])
  if (!app.isPackaged && Number.isFinite(override) && override > 0) return override
  return KYPR_CLIPBOARD_CLEAR_MS
}

/** 自分が書いたものがまだ残っていれば消す（他のアプリでコピーし直したものは消さない）。 */
function clearOurClipboard(): void {
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = null
  if (clipboardValue !== null && clip.readText() === clipboardValue) clip.clear()
  clipboardValue = null
}

const COPYABLE: Record<string, readonly string[]> = {
  login: ['username', 'password'],
  card: ['number', 'code', 'expiry', 'cardholderName'],
  note: ['notes'],
  // 性別は内部の値（male など）なのでコピーさせない
  identity: IDENTITY_KEYS.filter((key) => key !== 'gender'),
  totp: ['secret']
}

export function copyKyprField(id: string, field: string): boolean {
  const entry = session?.entries.get(id)
  if (!entry) return false
  const s = entry.state
  if (
    s.kind !== 'login' &&
    s.kind !== 'card' &&
    s.kind !== 'note' &&
    s.kind !== 'identity' &&
    s.kind !== 'totp'
  )
    return false
  if (!COPYABLE[s.kind]?.includes(field)) return false
  let value: string
  if (s.kind === 'card' && field === 'expiry') {
    const m = /^\d{1,2}$/.test(s.item.expMonth) ? s.item.expMonth.padStart(2, '0') : s.item.expMonth
    const y = /^\d{4}$/.test(s.item.expYear) ? s.item.expYear.slice(2) : s.item.expYear
    value = [m, y].filter(Boolean).join('/')
  } else if (s.kind === 'card' && field === 'number') {
    value = digitsOf(s.item.number)
  } else {
    const raw = (s.item as Record<string, unknown>)[field]
    value = typeof raw === 'string' ? raw : ''
  }
  if (value === '') return false
  writeOurClipboard(value)
  log('kypr.copy', { kind: s.kind, field })
  return true
}

/** クリップボードに置き、30 秒で消す（自分の書いたものがまだ残っているときだけ）。 */
function writeOurClipboard(value: string): void {
  clearOurClipboard()
  // `org.nspasteboard.ConcealedType` は付けない: Electron の clipboard はテキストと独自の型を 1 回の書き込みで
  // 置けない（writeBuffer は書き込みのたびに中身を置き換える）。plan の決定どおり、付けられないので諦める
  clip.writeText(value)
  clipboardValue = value
  clipboardTimer = setTimeout(clearOurClipboard, clipboardClearMs())
  touchKypr()
}

/** ワンタイムコードの今のコードをコピーする。 */
export async function copyKyprTotp(
  id: string,
  reason: 'user' | 'after-login' | 'fallback' = 'user'
): Promise<boolean> {
  const item = totpEntry(id)
  if (!item) return false
  const now = await totpNow(item)
  if (!('code' in now)) return false
  writeOurClipboard(now.code)
  log('kypr.copy', { kind: 'totp', field: 'code', reason })
  return true
}

app.on('will-quit', () => {
  clearOurClipboard()
  if (session) {
    const current = session
    session = null
    current.lock()
  }
})

/* ---------------- 作成・編集・ゴミ箱 ---------------- */

const str = (v: unknown, max = 10_000): string | null => (typeof v === 'string' && v.length <= max ? v : null)

/** renderer から来た項目を検査して、知っている項目だけ取り出す（無ければ null = 不正）。 */
function pickFields(
  type: KyprItemInput['type'],
  fields: Record<string, unknown>
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  const keys =
    type === 'login'
      ? ['name', 'username', 'password', 'notes']
      : type === 'card'
        ? ['name', 'cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code', 'notes']
        : type === 'identity'
          ? ['name', ...IDENTITY_KEYS, 'notes']
          : type === 'totp'
            ? ['name', 'account', 'secret', 'algorithm', 'notes']
            : ['name', 'notes']
  for (const key of keys) {
    const value = fields[key] ?? ''
    // 個人情報の項目は自動入力の上限（`MAX_PROFILE_VALUE`）まで。超えると自動入力で黙って空になる
    const max = key === 'notes' ? 100_000 : type === 'identity' && key !== 'name' ? MAX_PROFILE_VALUE : 10_000
    const s = str(value, max)
    if (s === null) return null
    out[key] = s
  }
  if (type === 'login' || type === 'totp') {
    const uris = fields['uris'] ?? []
    if (!Array.isArray(uris) || uris.length > 50) return null
    const clean: Record<string, unknown>[] = []
    for (const u of uris) {
      if (typeof u !== 'object' || u === null || Array.isArray(u)) return null
      const element = u as Record<string, unknown>
      const uri = str(element['uri'], 2_000)
      const match = element['match']
      if (uri === null) return null
      // match は整数か null（知らない方式の整数も、そのまま保存し直せるように通す。照合では一致しない）
      if (match !== undefined && match !== null && !Number.isInteger(match)) return null
      if (uri.trim() === '') continue
      // **要素の中の知らないキーは残す**（Web・iOS が足したキーを Nemo で編集して消さない）。
      // renderer は main が渡した要素をそのまま返してくるので、uri と match だけ検査して上書きする
      clean.push({ ...structuredClone(element), uri: uri.trim() })
    }
    out['uris'] = clean
  }
  if (type === 'identity') {
    // 日付は YYYY-MM-DD で実在する日・性別は決まった値だけ（自動入力が形を当てにする）
    for (const f of IDENTITY_FIELDS) {
      const value = (out[f.key] as string).trim()
      if (f.kind === 'date' && !isValidIdentityDate(value)) return null
      if (f.kind === 'gender' && !['', 'male', 'female', 'other'].includes(value)) return null
      out[f.key] = value
    }
  }
  if (type === 'totp') {
    // 保存できるのはコードを出せる値だけ（kypr の Web・iOS の編集画面と同じ）。発行元かラベルのどちらかは要る
    const digits = fields['digits']
    const period = fields['period']
    if (!Number.isInteger(digits) || !Number.isInteger(period)) return null
    out['name'] = (out['name'] as string).trim()
    out['account'] = (out['account'] as string).trim()
    out['secret'] = normalizeTotpSecret(out['secret'] as string)
    out['digits'] = digits
    out['period'] = period
    if (out['name'] === '' && out['account'] === '') return null
    if (totpProblem(out as { secret: string; algorithm: string; digits: number; period: number }) !== null)
      return null
  }
  if (type === 'card') {
    out['number'] = digitsOf(out['number'] as string)
    out['expMonth'] = normalizeExpMonth(out['expMonth'] as string)
    out['expYear'] = normalizeExpYear(out['expYear'] as string)
  }
  return out
}

export async function saveKyprItem(input: KyprItemInput): Promise<KyprActionResult> {
  const current = session
  if (!current) return { ok: false, reason: 'locked' }
  if (current.readOnly) return { ok: false, reason: 'read-only' }
  if (
    !input ||
    !['login', 'card', 'note', 'identity', 'totp'].includes(input.type) ||
    typeof input.fields !== 'object' ||
    input.fields === null
  )
    return { ok: false, reason: 'invalid' }
  const fields = pickFields(input.type, input.fields)
  if (!fields) return { ok: false, reason: 'invalid' }
  touchKypr()
  try {
    if (input.id === null) {
      const item: VaultItem =
        input.type === 'login'
          ? newLoginItem(fields)
          : input.type === 'card'
            ? newCardItem(fields)
            : input.type === 'identity'
              ? newIdentityItem(fields)
              : input.type === 'totp'
                ? newTotpItem(fields)
                : newNoteItem(fields)
      await current.create([item])
      log('kypr.create', { kind: input.type })
      return { ok: true, id: item.id }
    }
    const entry = current.entries.get(input.id)
    if (!entry) return { ok: false, reason: 'not-found' }
    const s = entry.state
    if (s.kind !== input.type) return { ok: false, reason: 'invalid' }
    // 既存の平文に重ねる（知らないキー・extra はそのまま残る）
    const next = { ...s.item, ...fields, updatedAt: nowIso() } as VaultItem
    await current.update(next, entry.revision)
    log('kypr.update', { kind: input.type })
    return { ok: true, id: entry.id }
  } catch (error) {
    return actionFailure(error, 'save')
  }
}

export async function kyprItemAction(
  id: string,
  action: 'trash' | 'restore' | 'purge'
): Promise<KyprActionResult> {
  const current = session
  if (!current) return { ok: false, reason: 'locked' }
  if (current.readOnly) return { ok: false, reason: 'read-only' }
  const entry = current.entries.get(id)
  if (!entry) return { ok: false, reason: 'not-found' }
  // 完全削除はゴミ箱の中のものだけ（サーバーも同じ条件）
  if (action === 'purge' && entry.deletedAt === null) return { ok: false, reason: 'invalid' }
  touchKypr()
  try {
    await current[action](id)
    log('kypr.item_action', { action })
    return { ok: true, id }
  } catch (error) {
    return actionFailure(error, action)
  }
}

/* ---------------- ワンタイムコードの登録 ---------------- */

/** otpauth URI を下書きにする（読めなければ null）。URL は呼び出し側が入れる。 */
export function kyprParseOtpauth(text: string, uri = ''): KyprTotpDraft | null {
  const p = parseOtpauthUri(text)
  if (!p) return null
  return {
    name: p.issuer,
    account: p.account,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: p.digits,
    period: p.period,
    uri
  }
}

/** 編集中の値の検査（コードを出せるか・同じものがあるか・今のコード）。 */
export async function kyprTotpCheck(input: {
  id: string | null
  secret: string
  algorithm: string
  digits: number
  period: number
}): Promise<KyprTotpCheck> {
  const params = { ...input, secret: normalizeTotpSecret(input.secret) }
  const problem = totpProblem(params)
  const empty = { code: null, remaining: 0, period: params.period }
  if (problem) return { problem: TOTP_PROBLEM_TEXT[problem], duplicateOf: null, ...empty }
  let duplicateOf: string | null = null
  for (const entry of session?.entries.values() ?? []) {
    if (entry.id === input.id || entry.deletedAt !== null || entry.state.kind !== 'totp') continue
    if (sameTotp(entry.state.item, params)) {
      duplicateOf = totpTitle(entry.state.item) || '（名前なし）'
      break
    }
  }
  const now = await totpNow(params)
  return 'code' in now
    ? { problem: null, duplicateOf, code: now.code, remaining: now.remaining, period: now.period }
    : { problem: TOTP_PROBLEM_TEXT[now.problem], duplicateOf, ...empty }
}

export function generateKyprPassword(length: number, sets: string[]): string {
  const allowed: CharsetName[] = ['lower', 'upper', 'digits', 'symbols']
  const picked = sets.filter((s): s is CharsetName => allowed.includes(s as CharsetName))
  return generatePassword({ length: Number.isFinite(length) ? length : 20, sets: picked })
}
