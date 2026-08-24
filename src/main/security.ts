import { app, desktopCapturer, shell, webContents, type Session, type WebContents } from 'electron'
import { log, logError, redactUrl } from './log.js'
import {
  ensureSystemMediaAccess,
  isSystemMediaDenied,
  mediaKindsFor,
  openMediaSettings,
  type MediaKind
} from './media-access.js'
import { ask } from './prompts.js'
import { getDecision, getSchemeDecision, rememberDecision, rememberScheme } from './store/permissions.js'
import {
  BLANK_URL,
  isLoadedExtensionUrl as isLoadedExtensionUrlWith,
  isNavigableUrl as isNavigableUrlWith,
  normalizeNavigationInput as normalizeNavigationInputImpl,
  UI_SCHEME_URL_PREFIX
} from '../shared/navigation-policy.js'
import type { PermissionKind } from '../shared/types.js'

/**
 * セキュリティ境界（計画 1-0）。
 *
 * URL の許可判定そのものは Electron に依存しない `shared/navigation-policy.js` に置き、
 * `scripts/navigation-policy.test.mjs` で回帰テストしている。
 */

export { BLANK_URL, redactUrl }
export type { NavigationDecision } from '../shared/navigation-policy.js'

/**
 * 確認なしで許可する permission。
 * 「ページを見るのに必然的に伴う」ものだけに絞る。
 */
const AUTO_ALLOWED = new Set<string>([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock'
])

/** ユーザーに聞く permission。ここに無いものは**確認せず拒否**する。 */
const ASKABLE = new Set<PermissionKind>([
  'geolocation',
  'notifications',
  'media',
  'camera',
  'microphone',
  'clipboard-read',
  'midi',
  'display-capture',
  'idle-detection'
])

export interface NavigationPolicy {
  /**
   * `chrome-extension://<ロード済み拡張 ID>/` を許可する。
   * 拡張自身がタブを作る経路（`chrome.tabs.create` / 拡張ページ内のナビゲーション）でのみ true にする。
   * コマンドバーや Web ページからのナビゲーションでは絶対に true にしない。
   */
  allowExtensionPages?: boolean
}

/**
 * ロード済み拡張の ID。
 * 拡張がロードされる前は空なので、起動直後に任意の拡張 URL が通ることはない。
 */
let loadedExtensionIds: ReadonlySet<string> = new Set()

export function setLoadedExtensionIds(ids: readonly string[]): void {
  loadedExtensionIds = new Set(ids)
}

export function isNavigableUrl(url: string, policy: NavigationPolicy = {}): boolean {
  return isNavigableUrlWith(url, { ...policy, extensionIds: loadedExtensionIds })
}

/** その URL がロード済み拡張のページか。 */
export function isLoadedExtensionUrl(url: string): boolean {
  return isLoadedExtensionUrlWith(url, loadedExtensionIds)
}

/**
 * 拡張やページから渡された URL を検証する。通らなければ null を返す。
 * 呼び出し側は `loadURL` に生の文字列を渡さず、必ずこれを通す。
 */
export function resolveNavigationTarget(
  url: string | undefined | null,
  policy: NavigationPolicy = {},
  context = 'unknown'
): string | null {
  if (!url) return BLANK_URL
  if (!isNavigableUrl(url, policy)) {
    log('navigation.blocked', { phase: context, target: redactUrl(url) })
    return null
  }
  return url
}

/** コマンドバー等の人間の入力を、そのまま loadURL に渡さずに正規化・検証する。 */
export const normalizeNavigationInput = normalizeNavigationInputImpl

/* ------------------------------------------------------------------ *
 * セッション単位の既定
 * ------------------------------------------------------------------ */

/**
 * ブラウザ UI 自身は権限を要求しない前提なので、UI セッションは全部拒否する。
 * ページセッションは origin 単位で聞く。
 */
export function applySessionSecurityDefaults(
  session: Session,
  label: 'page' | 'ui',
  resolveWindowId: (contents: WebContents) => number | null,
  /**
   * 権限の記憶をどこに置くか。`null` は常用プロファイル（永続）、
   * 文字列はシークレットの partition 名（**メモリ上だけ**）。
   */
  permissionScope: string | null = null
): void {
  if (label === 'ui') {
    session.setPermissionRequestHandler((_wc, permission, callback) => {
      log('permission.request', { partition: label, permission, allowed: false })
      callback(false)
    })
    session.setPermissionCheckHandler(() => false)
    session.setDevicePermissionHandler(() => false)
    return
  }

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    void handlePermissionRequest(contents, permission, details, resolveWindowId, permissionScope).then(
      callback
    )
  })

  // check は同期。**聞かずに答えられる場合だけ true**（未設定は false）。
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOWED.has(permission)) return true
    const origin = normalizeOrigin(requestingOrigin)
    if (!origin) return false
    if (getDecision(origin, permission as PermissionKind, permissionScope) !== 'allow') return false
    // Nemo が許可していても、OS 側で拒まれていれば使えない（`media-access.ts`）。
    const kinds = mediaKindsFor(permission)
    return kinds.length === 0 || !kinds.every(isSystemMediaDenied)
  })

  installDisplayMediaHandler(session, resolveWindowId, permissionScope)

  // デバイス選択（WebUSB / WebHID / シリアル）は既定で拒否する
  session.setDevicePermissionHandler(() => false)
}

async function handlePermissionRequest(
  contents: WebContents,
  permission: string,
  details: Electron.PermissionRequest,
  resolveWindowId: (contents: WebContents) => number | null,
  permissionScope: string | null
): Promise<boolean> {
  if (AUTO_ALLOWED.has(permission)) {
    log('permission.request', { partition: 'page', permission, allowed: true, auto: true })
    return true
  }

  const origin = normalizeOrigin(details.requestingUrl ?? contents.getURL())
  if (!origin || !ASKABLE.has(permission as PermissionKind)) {
    log('permission.request', { partition: 'page', permission, allowed: false, reason: 'not_askable' })
    return false
  }

  const windowId = resolveWindowId(contents)
  if (!(await decidePermission(origin, permission as PermissionKind, windowId, permissionScope))) {
    return false
  }

  // Nemo が許可した後に **OS の許可**を取る。ここを通さないと、ページは
  // 「許可されているのに無音・真っ暗」になる（`media-access.ts`）。
  const kinds = mediaKindsFor(permission, details)
  if (kinds.length === 0) return true

  const denied = await ensureSystemMediaAccess(kinds)
  if (denied.length === 0) return true

  log('permission.os_denied', { permission, denied: denied.join(',') })
  // 案内は待たない（ページを止めないため）。
  void promptSystemMediaSettings(windowId, denied[0])
  // 一部だけ拒まれたなら残りで通す（カメラだけ拒否 → 音声だけで参加する）。
  return denied.length < kinds.length
}

/** 記憶済みならそれに従い、無ければユーザーに聞く。 */
async function decidePermission(
  origin: string,
  permission: PermissionKind,
  windowId: number | null,
  permissionScope: string | null
): Promise<boolean> {
  const remembered = getDecision(origin, permission, permissionScope)
  if (remembered) {
    log('permission.request', {
      partition: 'page',
      permission,
      allowed: remembered === 'allow',
      remembered: true
    })
    return remembered === 'allow'
  }

  if (windowId === null) {
    log('permission.request', { partition: 'page', permission, allowed: false, reason: 'no_window' })
    return false
  }

  const answer = await ask(windowId, { type: 'permission', origin, permission })
  if (!answer || answer.kind !== 'permission') return false
  if (answer.remember) {
    rememberDecision(origin, permission, answer.allow ? 'allow' : 'deny', permissionScope)
  }
  log('permission.request', { partition: 'page', permission, allowed: answer.allow })
  return answer.allow
}

/** OS 側で拒まれていることを伝えて、システム設定への導線を出す。 */
async function promptSystemMediaSettings(windowId: number | null, kind: MediaKind): Promise<void> {
  if (windowId === null) return
  const answer = await ask(windowId, { type: 'system-media', kind })
  if (answer?.kind === 'system-media' && answer.openSettings) openMediaSettings(kind)
}

/* ------------------------------------------------------------------ *
 * 画面共有（getDisplayMedia）
 * ------------------------------------------------------------------ */

/**
 * `setDisplayMediaRequestHandler` を設定しないと、Electron では
 * `getDisplayMedia()` が **必ず失敗する**（Meet の「画面を共有できません」はこれ）。
 *
 * macOS では OS のネイティブ共有ピッカーに任せる（`useSystemPicker`）。
 * 「どれを共有するか」をユーザーが OS のピッカーで選ぶこと自体が同意になるので、
 * 使える環境ではこのハンドラは呼ばれない。
 * 呼ばれた場合（ピッカーが使えない環境）は Nemo のダイアログで確認してから画面全体を渡す。
 */
function installDisplayMediaHandler(
  session: Session,
  resolveWindowId: (contents: WebContents) => number | null,
  permissionScope: string | null
): void {
  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      void handleDisplayMediaRequest(request, resolveWindowId, permissionScope).then(callback)
    },
    { useSystemPicker: true }
  )
}

/** 要求元のフレームから、ダイアログを出すウィンドウを引く（破棄済みなら null）。 */
function displayMediaWindowId(
  frame: Electron.WebFrameMain,
  resolveWindowId: (contents: WebContents) => number | null
): number | null {
  try {
    const contents = webContents.fromFrame(frame)
    return contents ? resolveWindowId(contents) : null
  } catch {
    return null
  }
}

/** 空の `Streams` を返すと、ページ側は拒否（`NotAllowedError`）になる。 */
const DENY_DISPLAY_MEDIA: Electron.Streams = {}

async function handleDisplayMediaRequest(
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  resolveWindowId: (contents: WebContents) => number | null,
  permissionScope: string | null
): Promise<Electron.Streams> {
  const origin = normalizeOrigin(request.securityOrigin)
  const frame = request.frame
  if (!origin || !frame) {
    log('display_capture.request', { allowed: false, reason: 'no_origin' })
    return DENY_DISPLAY_MEDIA
  }

  const windowId = displayMediaWindowId(frame, resolveWindowId)

  if (!(await decidePermission(origin, 'display-capture', windowId, permissionScope))) {
    return DENY_DISPLAY_MEDIA
  }

  try {
    // ピッカーが無い経路なので、選ばせずに画面全体を渡す（ウィンドウ単位は選べない）。
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    const video = sources[0]
    if (!video) {
      log('display_capture.request', { allowed: false, reason: 'no_source' })
      return DENY_DISPLAY_MEDIA
    }
    log('display_capture.request', { allowed: true, fallback: true })
    return { video }
  } catch (error) {
    logError('display_capture.failed', error, {})
    return DENY_DISPLAY_MEDIA
  }
}

/** `https://example.com` の形にする。ここを通らないものは permission を扱わない。 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * WebContents 単位の既定
 * ------------------------------------------------------------------ */

/**
 * ページ側 WebContents に付ける既定。
 * - 許可外 scheme へのナビゲーションを拒否する（リダイレクト後も検査する）
 * - attach された webview を拒否する
 *
 * 拡張ページ（`chrome-extension://`）は、**現在すでに同じ拡張のページを開いている場合にだけ**
 * 遷移を許可する。Web ページから拡張ページへ飛ぶ経路は塞ぐ。
 */
export function applyWebContentsSecurityDefaults(
  contents: WebContents,
  resolveWindowId: (contents: WebContents) => number | null,
  permissionScope: string | null = null
): void {
  const policyForCurrentPage = (): NavigationPolicy => ({
    allowExtensionPages: isLoadedExtensionUrl(contents.getURL())
  })

  const guard = (phase: string, url: string, preventDefault: () => void): void => {
    if (isNavigableUrl(url, policyForCurrentPage())) return
    preventDefault()
    log('navigation.blocked', { phase, target: redactUrl(url) })
    // http(s) 以外は「外部アプリで開くか」を聞く経路に回す（既定は開かない）
    void maybeOpenExternal(url, resolveWindowId(contents), permissionScope)
  }

  contents.on('will-navigate', (event, url) => {
    guard('will-navigate', url, () => event.preventDefault())
  })

  // リダイレクト後の scheme も検査する（初回だけ見て通さない）
  contents.on('will-redirect', (event, url) => {
    guard('will-redirect', url, () => event.preventDefault())
  })

  contents.on('will-frame-navigate', (event) => {
    guard('will-frame-navigate', event.url, () => event.preventDefault())
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log('webview.blocked', {})
  })
}

/* ------------------------------------------------------------------ *
 * 外部 protocol（mailto: など）
 * ------------------------------------------------------------------ */

/**
 * OS に渡してよい scheme。**無条件には渡さない**。
 * ここに載っていても、初回は必ずユーザーに聞く。
 */
const EXTERNAL_SCHEMES = new Set([
  'mailto:',
  'tel:',
  'facetime:',
  'sms:',
  'webcal:',
  'zoommtg:',
  'slack:',
  'msteams:',
  'vscode:',
  'itms-apps:'
])

/** ページ / 拡張から要求された外部 protocol を、確認を挟んで OS に渡す。 */
export async function maybeOpenExternal(
  url: string,
  windowId: number | null,
  permissionScope: string | null = null
): Promise<boolean> {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return false
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) {
    log('external_protocol.blocked', { scheme })
    return false
  }

  const remembered = getSchemeDecision(scheme, permissionScope)
  if (remembered === 'deny') return false
  if (remembered !== 'allow') {
    if (windowId === null) return false
    const answer = await ask(windowId, {
      type: 'external-protocol',
      scheme,
      display: redactUrl(url)
    })
    if (!answer || answer.kind !== 'external-protocol' || !answer.open) return false
    if (answer.remember) rememberScheme(scheme, 'allow', permissionScope)
  }

  try {
    await shell.openExternal(url)
    log('external_protocol.opened', { scheme })
    return true
  } catch (error) {
    logError('external_protocol.failed', error, { scheme })
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 証明書エラー / HTTP 認証 / renderer crash
 * ------------------------------------------------------------------ */

/**
 * 証明書エラー。
 * **既定は拒否**（`event.preventDefault()` を呼ばなければ Electron が拒否する）。
 * ユーザーが明示的に続行を選んだときだけ通す。記憶はしない（毎回聞く）。
 */
export function installCertificateHandler(resolveWindowId: (contents: WebContents) => number | null): void {
  app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
    const windowId = resolveWindowId(contents)
    log('certificate.error', { target: redactUrl(url), code: error })
    if (windowId === null) {
      callback(false)
      return
    }
    event.preventDefault()
    void ask(windowId, {
      type: 'certificate',
      host: redactUrl(url),
      errorCode: error,
      issuerName: certificate.issuerName,
      subjectName: certificate.subjectName,
      validStart: certificate.validStart,
      validExpiry: certificate.validExpiry
    }).then((answer) => {
      const proceed = answer?.kind === 'certificate' && answer.proceed
      log('certificate.decision', { proceed })
      callback(proceed)
    })
  })
}

/** HTTP 認証（Basic / Digest / プロキシ）。 */
export function installAuthHandler(resolveWindowId: (contents: WebContents) => number | null): void {
  app.on('login', (event, contents, _details, authInfo, callback) => {
    const windowId = resolveWindowId(contents)
    log('auth.requested', { isProxy: authInfo.isProxy })
    if (windowId === null) return
    event.preventDefault()
    void ask(windowId, {
      type: 'auth',
      host: `${authInfo.host}:${authInfo.port}`,
      realm: authInfo.realm,
      isProxy: authInfo.isProxy
    }).then((answer) => {
      if (answer?.kind === 'auth') {
        // 資格情報はログに出さない（イベント名だけ残す）
        log('auth.submitted', { isProxy: authInfo.isProxy })
        callback(answer.username, answer.password)
      } else {
        log('auth.cancelled', { isProxy: authInfo.isProxy })
        callback()
      }
    })
  })
}

/** UI をロードする URL かどうか（IPC の送信元検証に使う）。 */
export function isUiUrl(url: string): boolean {
  return url.startsWith(UI_SCHEME_URL_PREFIX)
}
