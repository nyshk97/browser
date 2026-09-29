import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, session as electronSession, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  capPerOrigin,
  decideCreate,
  decideGet,
  normalizeWebAuthnStore,
  prfOutput,
  type StoredCredential,
  type WebAuthnStore
} from '../../shared/kypr-webauthn.js'
import { isAgentContents } from '../agent/contents.js'
import { log, logError } from '../log.js'
import { PAGE_PARTITION } from '../paths.js'
import { findTabByWebContents } from '../registry.js'
import { getSecretBackend } from '../store/secret-backend.js'
import { kyprDir } from './cache-store.js'
import { kyprServerOrigin } from './index.js'
import { promptTouchId } from './touch-id.js'

/**
 * kypr の Web 版の Touch ID 解除に答える、Nemo 内蔵の小さな認証器
 * （plan `docs/plans/2026-09-29-1212-kypr-web-touch-id.md`）。
 *
 * kypr の Web 版はパスキーの PRF 拡張の出力で鍵を包む。Nemo は Touch ID の認証器を持たない
 * （`app.configureWebAuthn` は entitlement とプロビジョニングプロファイルが要るので見送った）ので、
 * **kypr の Web の origin のメインフレームにだけ**、ページ側の shim（`src/shared/kypr-webauthn-shim.js`。
 * `src/preload/kypr-page.ts` が入れる）から要求を受けて答える。
 *
 * - クレデンシャルごとの秘密（32 バイト）を `safeStorage` で暗号化して `userData/kypr/web-authenticator.json` に置く。
 *   **取り出すのは Touch ID を通したあとだけ**。守りの強さは Nemo の kypr の Touch ID 解除（`device-keys.ts`）と同じ
 * - 送り手は main で確かめる（preload の判定は信用しない）。全部: メインフレーム・kypr の origin・通常のページセッション。
 *   `create` / `get` だけ追加で、タブがウィンドウ内で表示中で、ウィンドウが表示されていて最小化されていない
 *   （OS のフォーカスは求めない。自走検証がターミナル前面でも揺れないように）
 * - 同時に来た要求は、処理中のものがあればすぐ断る（Touch ID のダイアログを重ねない）
 * - Nemo の kypr のログアウトでは消さない（Web 版の IndexedDB の記録とは無関係に生きている）
 */

type Reply =
  | { ok: true; id: string; prf: string | null }
  | { ok: true }
  | { ok: false; reason: 'not-kypr' | 'not-allowed' }

function storeFile(): string {
  return path.join(kyprDir(), 'web-authenticator.json')
}

function readStore(): WebAuthnStore {
  let raw: string
  try {
    raw = fs.readFileSync(storeFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError('kypr.webauthn_read_failed', error, {})
    return { version: 1, credentials: [] }
  }
  try {
    return normalizeWebAuthnStore(JSON.parse(raw))
  } catch (error) {
    logError('kypr.webauthn_read_failed', error, {})
    return { version: 1, credentials: [] }
  }
}

function writeStore(credentials: StoredCredential[]): void {
  fs.mkdirSync(kyprDir(), { recursive: true, mode: 0o700 })
  const body: WebAuthnStore = { version: 1, credentials: capPerOrigin(credentials) }
  fs.writeFileSync(storeFile(), `${JSON.stringify(body)}\n`, { mode: 0o600 })
}

/** kypr の origin か。kypr が無効なら常に false。 */
function kyprOriginOf(event: IpcMainEvent | IpcMainInvokeEvent): string | null {
  const wc = event.sender
  const frame = event.senderFrame
  if (!frame || frame !== wc.mainFrame) return null
  if (isAgentContents(wc)) return null
  if (wc.session !== electronSession.fromPartition(PAGE_PARTITION)) return null
  const expected = kyprServerOrigin()
  if (!expected || frame.origin !== expected) return null
  return expected
}

/** タブがウィンドウ内で表示中で、ウィンドウが表示されていて最小化されていないか。 */
function shownToUser(event: IpcMainInvokeEvent): boolean {
  const found = findTabByWebContents(event.sender)
  if (!found || found.win.isDestroyed || found.win.isAgent || found.win.isPrivate) return false
  const base = found.win.baseWindow
  if (!base.isVisible() || base.isMinimized()) return false
  return found.win.visibleTabKeys.has(found.tab.key)
}

const b64url = (buf: Buffer): string => buf.toString('base64url')

let busy = false

async function create(origin: string, req: unknown): Promise<Reply> {
  const host = new URL(origin).hostname
  const decision = decideCreate(req, host)
  if (!decision.ok) return decision
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return { ok: false, reason: 'not-allowed' }
  if (!(await promptTouchId(`${host} の Touch ID での解除を有効に`))) {
    log('kypr.webauthn', { op: 'create', ok: false, reason: 'touch-id' })
    return { ok: false, reason: 'not-allowed' }
  }
  const secret = randomBytes(32)
  const id = b64url(randomBytes(16))
  try {
    const row: StoredCredential = {
      id,
      rpId: host,
      origin,
      encrypted: backend.encrypt(secret.toString('base64')),
      createdAt: new Date().toISOString()
    }
    writeStore([row, ...readStore().credentials])
    const prf = decision.salt ? prfOutput(secret, decision.salt).toString('base64') : null
    log('kypr.webauthn', { op: 'create', ok: true, count: readStore().credentials.length })
    return { ok: true, id, prf }
  } catch (error) {
    logError('kypr.webauthn_create_failed', error, {})
    return { ok: false, reason: 'not-allowed' }
  } finally {
    secret.fill(0)
  }
}

async function get(origin: string, req: unknown): Promise<Reply> {
  const host = new URL(origin).hostname
  const rows = readStore().credentials.filter((row) => row.origin === origin && row.rpId === host)
  const decision = decideGet(req, host, new Set(rows.map((row) => row.id)))
  if (!decision.ok) return decision
  const row = rows.find((r) => r.id === decision.id)
  const backend = getSecretBackend()
  if (!row || !backend.isAvailable()) return { ok: false, reason: 'not-allowed' }
  // Touch ID が通らなくても秘密は消さない（kypr はマスターパスワードに回る。次は通るかもしれない）
  if (!(await promptTouchId(`${host} のロックを解除`))) {
    log('kypr.webauthn', { op: 'get', ok: false, reason: 'touch-id' })
    return { ok: false, reason: 'not-allowed' }
  }
  let secret: Buffer | null = null
  try {
    secret = Buffer.from(backend.decrypt(row.encrypted), 'base64')
    if (secret.length !== 32) throw new Error('秘密の長さが違う')
    const prf = prfOutput(secret, decision.salt).toString('base64')
    log('kypr.webauthn', { op: 'get', ok: true })
    return { ok: true, id: row.id, prf }
  } catch (error) {
    logError('kypr.webauthn_get_failed', error, {})
    return { ok: false, reason: 'not-allowed' }
  } finally {
    secret?.fill(0)
  }
}

function forget(origin: string, req: unknown): Reply {
  const id = typeof req === 'object' && req !== null ? (req as Record<string, unknown>)['credentialId'] : null
  const rpId = typeof req === 'object' && req !== null ? (req as Record<string, unknown>)['rpId'] : null
  const host = new URL(origin).hostname
  if (typeof id !== 'string' || (rpId != null && rpId !== host)) return { ok: true }
  const before = readStore().credentials
  const after = before.filter((row) => !(row.origin === origin && row.id === id))
  if (after.length !== before.length) {
    writeStore(after)
    log('kypr.webauthn', { op: 'forget', ok: true, count: after.length })
  }
  return { ok: true }
}

async function onRequest(event: IpcMainInvokeEvent, req: unknown): Promise<Reply> {
  const origin = kyprOriginOf(event)
  if (!origin) return { ok: false, reason: 'not-kypr' }
  const op = typeof req === 'object' && req !== null ? (req as Record<string, unknown>)['op'] : null
  if (op === 'forget') return forget(origin, req)
  if (op !== 'create' && op !== 'get') return { ok: false, reason: 'not-kypr' }
  if (!shownToUser(event)) {
    log('kypr.webauthn', { op, ok: false, reason: 'hidden' })
    return { ok: false, reason: 'not-allowed' }
  }
  if (busy) {
    log('kypr.webauthn', { op, ok: false, reason: 'busy' })
    return { ok: false, reason: 'not-allowed' }
  }
  busy = true
  try {
    return op === 'create' ? await create(origin, req) : await get(origin, req)
  } finally {
    busy = false
  }
}

export function installKyprWebAuthn(): void {
  // preload が「この frame に認証器を入れるか」を聞く（候補の origin のメインフレームでだけ、1 回）
  ipcMain.on('nemo:kypr-webauthn-enabled', (event) => {
    event.returnValue = kyprOriginOf(event) !== null
  })
  ipcMain.handle('nemo:kypr-webauthn', onRequest)
}
