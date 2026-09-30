import { createHash } from 'node:crypto'
import {
  ipcMain,
  session as electronSession,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { ConflictError, type VaultEntry, type VaultSession } from '../../vendor/kypr/client/index.ts'
import {
  assertPasskey,
  createPasskey,
  ES256,
  hasExcludedPasskey,
  newPasskeyLogin,
  PasskeyError,
  passkeyCandidates,
  passkeyTargets,
  rpIdAllowed,
  withPasskey,
  type PasskeyMatch
} from '../../vendor/kypr/client/passkey.ts'
import { b64urlDecode, b64urlEncode, type Passkey } from '../../vendor/kypr/crypto/index.ts'
import {
  clientDataJSON,
  effectiveRpId,
  passBeforeVault,
  passkeyTouchIdReason,
  readPasskeyRequest,
  type CreateRequest,
  type GetRequest
} from '../../shared/kypr-passkey.js'
import { isAgentContents } from '../agent/contents.js'
import { log, logError } from '../log.js'
import { PAGE_PARTITION } from '../paths.js'
import { ask } from '../prompts.js'
import { findTabByWebContents, type NemoTab, type NemoWindow } from '../registry.js'
import { hasDeviceKeys } from './device-keys.js'
import {
  kyprServerOrigin,
  kyprSessionForPasskeys,
  kyprState,
  touchKypr,
  unlockKyprWithTouchId
} from './index.js'
import { holdWebAuthnRequest, promptTouchId, touchIdAvailable } from './touch-id.js'

/**
 * Nemo を kypr のパスキーの認証器にする（plan `docs/plans/2026-09-30-1700-kypr-passkeys.md`）。
 *
 * ページ側の shim（`src/shared/kypr-passkey-shim.js`。`src/preload/kypr-page.ts` が入れる）から
 * `navigator.credentials.create` / `get` を受け、kypr の保管庫の鍵で登録・署名する。鍵・署名・候補の選び方・
 * rpId の検証は kypr の `client/passkey.ts`（vendored）が正。
 *
 * - 送り手は main で確かめる: メインフレーム・Claude のウィンドウでない・通常かシークレットのセッション。
 *   origin はページの申告を信用せず frame から取る。create / get は表示中のタブだけ
 * - **kypr では答えない要求は `pass`**（ページ側が包む前の関数 = `webauthn-shim.js` に渡す）:
 *   kypr の Web の origin・cross-platform の create・セキュリティキー向けだけの get・サインアウト中・
 *   kypr が扱えない origin（http の localhost 以外・IP アドレス）・get の候補が 0 件・
 *   送り手が対象外（Claude のウィンドウなど）
 * - 本人確認は毎回 Touch ID（Touch ID が使えなければ断る）。ロック中は Touch ID で解除し、それを本人確認にする。
 *   端末の鍵が無い（マスターパスワードだけ）なら kypr のポップアップを開いて断る（解除してからもう一度押してもらう）
 * - 候補が 2 件以上ならブラウザ UI のダイアログ（`prompts.ts`）で選ばせてから Touch ID
 * - 同時の要求は PRF の認証器と共通のロック（`holdWebAuthnRequest`）で断る
 * - **ログに rpId・credentialId・秘密鍵を出さない**
 */

type ErrorName = 'NotAllowedError' | 'InvalidStateError' | 'NotSupportedError' | 'SecurityError' | 'TypeError'

type Reply =
  | { ok: true; available: boolean }
  | {
      ok: true
      op: 'create'
      credentialId: string
      clientDataJSON: string
      attestationObject: string
      authenticatorData: string
      publicKey: string
      publicKeyAlgorithm: number
      credProps: boolean
    }
  | {
      ok: true
      op: 'get'
      credentialId: string
      clientDataJSON: string
      authenticatorData: string
      signature: string
      userHandle: string
    }
  | { ok: false; pass: true }
  | { ok: false; error: ErrorName }

const PASS: Reply = { ok: false, pass: true }
const fail = (error: ErrorName): Reply => ({ ok: false, error })

interface Sender {
  wc: WebContents
  frame: WebFrameMain
  origin: string
  win: NemoWindow
  tab: NemoTab
}

/** 答えてよい送り手か（だめなら null = kypr では答えない）。 */
function senderOf(event: IpcMainInvokeEvent): Sender | null {
  const wc = event.sender
  const frame = event.senderFrame
  if (!frame || frame !== wc.mainFrame) return null
  if (isAgentContents(wc)) return null
  const found = findTabByWebContents(wc)
  if (!found || found.win.isDestroyed || found.win.isAgent) return null
  // 通常のページセッションか、シークレットのウィンドウ（Claude 用・拡張などのセッションでは答えない）
  if (wc.session !== electronSession.fromPartition(PAGE_PARTITION) && !found.win.isPrivate) return null
  const origin = frame.origin
  if (!origin || origin === 'null') return null
  return { wc, frame, origin, win: found.win, tab: found.tab }
}

/** タブがウィンドウ内で表示中で、ウィンドウが表示されていて最小化されていないか（OS のフォーカスは求めない）。 */
function shownToUser(sender: Sender): boolean {
  const { win, tab } = sender
  if (win.isDestroyed) return false
  const base = win.baseWindow
  if (!base.isVisible() || base.isMinimized()) return false
  return win.visibleTabKeys.has(tab.key)
}

/** 要求を受けたときと同じページのままか（書き込み・応答の直前に見る。遷移・閉じたタブには答えない）。 */
function stillSame(sender: Sender): boolean {
  return (
    !sender.wc.isDestroyed() && sender.wc.mainFrame === sender.frame && sender.frame.origin === sender.origin
  )
}

/** このページで isUVPAA を true にするか（サイトがパスキーのボタンを出すため）。 */
function availableFor(origin: string): boolean {
  if (origin === kyprServerOrigin()) return false
  const state = kyprState()
  if (state !== 'unlocked' && state !== 'locked') return false
  if (!touchIdAvailable()) return false
  try {
    return rpIdAllowed(origin, new URL(origin).hostname)
  } catch {
    return false
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
const b64url = (bytes: Uint8Array): string => b64urlEncode(bytes)
const utf8b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

/**
 * 解除されていなければ解除する。Touch ID で解除したら `verified`（本人確認を兼ねる。2 回出さない）。
 * 端末の鍵が無ければ kypr のポップアップを開いて断る（小窓はポップアップを持たないので断るだけ）。
 */
async function ensureUnlocked(sender: Sender, reason: string): Promise<{ verified: boolean } | null> {
  if (kyprSessionForPasskeys()) return { verified: false }
  if (!hasDeviceKeys()) {
    openKyprPopup(sender)
    return null
  }
  const result = await unlockKyprWithTouchId(reason)
  if (!result.ok) {
    // Touch ID を断られたときは開かない（キャンセルしたのに画面が出る）。鍵が使えなかったときは開く
    if (result.reason !== 'touch-id-failed') openKyprPopup(sender)
    return null
  }
  return kyprSessionForPasskeys() ? { verified: true } : null
}

function openKyprPopup(sender: Sender): void {
  if (!sender.win.isDestroyed && sender.win.kind !== 'mini') sender.win.setOverlay('kypr')
}

/** 候補を選ばせる（1 件ならそれ）。キャンセル・ウィンドウが閉じたら null。 */
async function choose<T extends { id: string }>(
  sender: Sender,
  purpose: 'sign-in' | 'save',
  rpId: string,
  choices: (T & { label: string; detail: string })[]
): Promise<T | null> {
  const only = choices.length === 1 ? choices[0] : undefined
  if (only) return only
  const answer = await ask(sender.win.id, {
    type: 'kypr-passkey-choice',
    purpose,
    rpId,
    choices: choices.map((c) => ({ id: c.id, label: c.label, detail: c.detail }))
  })
  const id = answer?.kind === 'kypr-passkey-choice' ? answer.choiceId : null
  // renderer から来る id は信用しない: 出した一覧に無ければキャンセル扱い
  return id === null ? null : (choices.find((c) => c.id === id) ?? null)
}

const loginOf = (entry: VaultEntry): { name: string; username: string } =>
  entry.state.kind === 'login'
    ? { name: entry.state.item.name, username: entry.state.item.username }
    : { name: '', username: '' }

/** 作ったパスキーを書く（`targetId` が null なら新しいログイン）。409 は差分を反映した版に 1 回だけやり直す。 */
async function savePasskey(
  session: VaultSession,
  targetId: string | null,
  passkey: Passkey
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (targetId === null) {
        await session.create([newPasskeyLogin(passkey)])
        return true
      }
      // 409 のときは共通のクライアントがサーバーの版を反映済みなので、読み直して重ねる
      const entry = session.entries.get(targetId)
      if (!entry || entry.deletedAt !== null || entry.state.kind !== 'login') return false
      await session.update(withPasskey(entry.state.item, passkey), entry.revision)
      return true
    } catch (error) {
      if (error instanceof ConflictError && attempt === 0) {
        log('kypr.passkey', { op: 'create', retry: 'conflict' })
        continue
      }
      throw error
    }
  }
  return false
}

async function create(sender: Sender, req: CreateRequest, rpId: string): Promise<Reply> {
  const unlocked = await ensureUnlocked(sender, passkeyTouchIdReason('unlock-create', rpId, req.userName))
  if (!unlocked) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'locked' })
    return fail('NotAllowedError')
  }
  const session = kyprSessionForPasskeys()
  if (!session) return fail('NotAllowedError')
  // 書けない（オフラインで開いた・読み取り専用）なら作らない
  if (session.readOnly) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'read-only' })
    return fail('NotAllowedError')
  }

  // 入れるログインを決める（ユーザー名が合う 1 件 → そこ。合うログインがあれば選ばせる。無ければ新しいログイン）
  const { exact, matches } = passkeyTargets(session.entries.values(), rpId, req.userName)
  let targetId: string | null = null
  if (exact) targetId = exact.id
  else if (matches.length > 0) {
    const picked = await choose(sender, 'save', rpId, [
      ...matches.map((e) => ({ id: e.id, label: loginOf(e).name, detail: loginOf(e).username })),
      { id: 'new', label: '新しいログイン', detail: req.userName }
    ])
    if (!picked) {
      log('kypr.passkey', { op: 'create', ok: false, reason: 'cancelled' })
      return fail('NotAllowedError')
    }
    targetId = picked.id === 'new' ? null : picked.id
  }

  if (!unlocked.verified && !(await promptTouchId(passkeyTouchIdReason('create', rpId, req.userName)))) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'touch-id' })
    return fail('NotAllowedError')
  }
  // 選択・Touch ID を待つ間にロック・サインアウトされていたら進まない
  if (kyprSessionForPasskeys() !== session) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'locked-meanwhile' })
    return fail('NotAllowedError')
  }
  // 除外は同意（Touch ID）の後に判定する（先に返すと、サイトが黙って kypr のパスキーの有無を調べられる）
  if (hasExcludedPasskey(session.entries.values(), rpId, req.excludeCredentials)) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'excluded' })
    return fail('InvalidStateError')
  }

  let created: Awaited<ReturnType<typeof createPasskey>>
  try {
    created = await createPasskey({
      rpId,
      rpName: req.rpName,
      userId: req.userId,
      userName: req.userName,
      userDisplayName: req.userDisplayName,
      algs: req.algs
    })
  } catch (error) {
    if (error instanceof PasskeyError) {
      log('kypr.passkey', { op: 'create', ok: false, reason: error.code })
      return fail(error.code === 'not-supported' ? 'NotSupportedError' : 'TypeError')
    }
    throw error
  }
  const cdj = clientDataJSON('webauthn.create', req.challenge, sender.origin)
  if (!stillSame(sender)) {
    log('kypr.passkey', { op: 'create', ok: false, reason: 'navigated' })
    return fail('NotAllowedError')
  }
  try {
    if (!(await savePasskey(session, targetId, created.passkey))) {
      log('kypr.passkey', { op: 'create', ok: false, reason: 'target-gone' })
      return fail('NotAllowedError')
    }
  } catch (error) {
    logError('kypr.passkey_save_failed', error, {})
    return fail('NotAllowedError')
  }
  touchKypr()
  log('kypr.passkey', { op: 'create', ok: true, target: targetId === null ? 'new' : 'existing' })
  return {
    ok: true,
    op: 'create',
    credentialId: b64url(created.credentialId),
    clientDataJSON: utf8b64url(cdj),
    attestationObject: b64url(created.attestationObject),
    authenticatorData: b64url(created.authenticatorData),
    publicKey: b64url(created.publicKeySpki),
    publicKeyAlgorithm: created.alg,
    credProps: req.credProps
  }
}

async function get(sender: Sender, req: GetRequest, rpId: string): Promise<Reply> {
  const unlocked = await ensureUnlocked(sender, passkeyTouchIdReason('unlock-get', rpId, ''))
  if (!unlocked) {
    log('kypr.passkey', { op: 'get', ok: false, reason: 'locked' })
    return fail('NotAllowedError')
  }
  const session = kyprSessionForPasskeys()
  if (!session) return fail('NotAllowedError')
  const allow = req.allowCredentials.map((d) => d.id)
  const candidates = passkeyCandidates(session.entries.values(), rpId, allow.length > 0 ? allow : null)
  if (candidates.length === 0) {
    // kypr に無い（セキュリティキー・別の端末のパスキーかもしれない）ので内側に渡す
    log('kypr.passkey', { op: 'get', ok: false, reason: 'no-candidate' })
    return PASS
  }
  const picked = await choose<PasskeyMatch<VaultEntry> & { id: string }>(
    sender,
    'sign-in',
    rpId,
    candidates.map((m) => ({
      ...m,
      id: m.passkey.credentialId,
      label: m.passkey.userName || m.passkey.userDisplayName || '（ユーザー名なし）',
      detail: loginOf(m.entry).name
    }))
  )
  if (!picked) {
    log('kypr.passkey', { op: 'get', ok: false, reason: 'cancelled' })
    return fail('NotAllowedError')
  }
  if (
    !unlocked.verified &&
    !(await promptTouchId(passkeyTouchIdReason('get', rpId, picked.passkey.userName)))
  ) {
    log('kypr.passkey', { op: 'get', ok: false, reason: 'touch-id' })
    return fail('NotAllowedError')
  }
  // 選択・Touch ID を待つ間にロック・サインアウト・同期で消されていたら署名しない（秘密鍵は今の保管庫から引き直す）
  const current =
    kyprSessionForPasskeys() === session
      ? passkeyCandidates(session.entries.values(), rpId, [picked.passkey.credentialId])[0]
      : undefined
  if (!current) {
    log('kypr.passkey', { op: 'get', ok: false, reason: 'locked-meanwhile' })
    return fail('NotAllowedError')
  }
  const cdj = clientDataJSON('webauthn.get', req.challenge, sender.origin)
  if (!stillSame(sender)) {
    log('kypr.passkey', { op: 'get', ok: false, reason: 'navigated' })
    return fail('NotAllowedError')
  }
  let assertion: Awaited<ReturnType<typeof assertPasskey>>
  try {
    assertion = await assertPasskey(current.passkey, sha256(cdj))
  } catch (error) {
    if (error instanceof PasskeyError) {
      log('kypr.passkey', { op: 'get', ok: false, reason: error.code })
      return fail('NotAllowedError')
    }
    throw error
  }
  touchKypr()
  log('kypr.passkey', { op: 'get', ok: true, candidates: candidates.length })
  return {
    ok: true,
    op: 'get',
    credentialId: b64url(assertion.credentialId),
    clientDataJSON: utf8b64url(cdj),
    authenticatorData: b64url(assertion.authenticatorData),
    signature: b64url(assertion.signature),
    userHandle: b64url(assertion.userHandle)
  }
}

async function onRequest(event: IpcMainInvokeEvent, raw: unknown): Promise<Reply> {
  const op = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['op'] : null
  const sender = senderOf(event)
  if (op === 'available') return { ok: true, available: sender ? availableFor(sender.origin) : false }
  if (!sender) return PASS
  // 読めない要求（main の上限を超える・型が違う）は内側に渡す（kypr を使っていない人の挙動を変えない。
  // 本当に壊れた要求は native と webauthn-shim が正しいエラーを返す）
  const read = readPasskeyRequest(raw)
  if (!read.ok) {
    log('kypr.passkey', { op: typeof op === 'string' ? op.slice(0, 16) : null, pass: 'unreadable' })
    return PASS
  }
  const req = read.value
  const passReason = passBeforeVault(req, sender.origin, kyprServerOrigin())
  if (passReason) {
    log('kypr.passkey', { op: req.op, pass: passReason })
    return PASS
  }
  const state = kyprState()
  if (state !== 'unlocked' && state !== 'locked') return PASS
  // kypr が扱えない origin（http の localhost 以外・IP アドレス）は今までどおり内側へ（rpId の食い違いとは別）
  let host: string
  try {
    host = new URL(sender.origin).hostname
  } catch {
    return PASS
  }
  if (!rpIdAllowed(sender.origin, host)) {
    log('kypr.passkey', { op: req.op, pass: 'origin' })
    return PASS
  }

  const rpId = effectiveRpId(req.rpId, sender.origin)
  if (!rpIdAllowed(sender.origin, rpId)) {
    log('kypr.passkey', { op: req.op, ok: false, reason: 'rp-id' })
    return fail('SecurityError')
  }
  if (req.op === 'create') {
    // 同意（Touch ID）の前に断れるものは先に断る
    if (!req.algs.includes(ES256)) {
      log('kypr.passkey', { op: 'create', ok: false, reason: 'not-supported' })
      return fail('NotSupportedError')
    }
    let userIdBytes: number
    try {
      userIdBytes = b64urlDecode(req.userId).length
    } catch {
      userIdBytes = 0
    }
    if (userIdBytes < 1 || userIdBytes > 64) {
      log('kypr.passkey', { op: 'create', ok: false, reason: 'user-id' })
      return fail('TypeError')
    }
  }
  if (!shownToUser(sender)) {
    log('kypr.passkey', { op: req.op, ok: false, reason: 'hidden' })
    return fail('NotAllowedError')
  }
  if (!touchIdAvailable()) {
    log('kypr.passkey', { op: req.op, ok: false, reason: 'no-touch-id' })
    return fail('NotAllowedError')
  }
  const release = holdWebAuthnRequest()
  if (!release) {
    log('kypr.passkey', { op: req.op, ok: false, reason: 'busy' })
    return fail('NotAllowedError')
  }
  try {
    return req.op === 'create' ? await create(sender, req, rpId) : await get(sender, req, rpId)
  } catch (error) {
    logError('kypr.passkey_failed', error, { op: req.op })
    return fail('NotAllowedError')
  } finally {
    release()
  }
}

export function installKyprPasskey(): void {
  ipcMain.handle('nemo:kypr-passkey', onRequest)
}
