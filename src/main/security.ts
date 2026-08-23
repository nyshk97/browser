import { shell, type Session, type WebContents } from 'electron'
import { log } from './log.js'
import {
  BLANK_URL,
  isLoadedExtensionUrl as isLoadedExtensionUrlWith,
  isNavigableUrl as isNavigableUrlWith,
  normalizeNavigationInput as normalizeNavigationInputImpl,
  redactUrl
} from '../shared/navigation-policy.js'

/**
 * Phase 0 時点のセキュリティ既定。
 * Phase 1-0 で origin 単位の permission UI・custom protocol 配信・
 * fuses 検査まで広げる。ここは「スパイクでも既定を緩めない」ための最小限。
 *
 * URL の許可判定そのものは Electron に依存しない `shared/navigation-policy.js` に置き、
 * `scripts/navigation-policy.test.mjs` で回帰テストしている。
 */

export { BLANK_URL, redactUrl }
export type { NavigationDecision } from '../shared/navigation-policy.js'

/** 既定で許可する permission。それ以外は拒否する（未設定だと自動許可されうる）。 */
const ALLOWED_PERMISSIONS = new Set<string>(['fullscreen', 'clipboard-sanitized-write'])

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

/** セッション単位の既定（permission / デバイス）。 */
export function applySessionSecurityDefaults(session: Session, label: string): void {
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission)
    log('permission.request', { session: label, permission, allowed })
    callback(allowed)
  })

  session.setPermissionCheckHandler((_wc, permission) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission)
    log('permission.check', { session: label, permission, allowed })
    return allowed
  })

  // デバイス選択も既定で拒否する
  session.setDevicePermissionHandler(() => false)
}

/**
 * ページ側 WebContents に付ける既定。
 * - 許可外 scheme へのナビゲーションを拒否する（リダイレクト後も検査する）
 * - attach された webview を拒否する
 *
 * 拡張ページ（`chrome-extension://`）は、**現在すでに同じ拡張のページを開いている場合にだけ**
 * 遷移を許可する。Web ページから拡張ページへ飛ぶ経路は塞ぐ。
 */
export function applyWebContentsSecurityDefaults(contents: WebContents): void {
  const policyForCurrentPage = (): NavigationPolicy => ({
    allowExtensionPages: isLoadedExtensionUrl(contents.getURL())
  })

  const guard = (phase: string, url: string, preventDefault: () => void): void => {
    if (isNavigableUrl(url, policyForCurrentPage())) return
    preventDefault()
    log('navigation.blocked', { phase, target: redactUrl(url) })
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

/** Phase 1-6 で allowlist 化する。現時点では明示的に呼ばれたときだけ開く。 */
export function openExternal(url: string): void {
  const allowed = ['mailto:', 'tel:']
  try {
    if (allowed.includes(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    /* noop */
  }
}
