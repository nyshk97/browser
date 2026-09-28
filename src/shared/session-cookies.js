// @ts-check
/**
 * セッション cookie（有効期限の無い cookie）を Nemo の再起動をまたいで引き継ぐための純粋関数。
 *
 * Chromium は終了でセッション cookie を捨てる（実測。Electron 41.10.6）。Chrome は「前回のページを開く」の
 * ときだけ戻すが、Electron にはその口が無い。Nemo はタブを復元するので、ログインも同じく戻す
 * （更新のたびにログアウトされるのを止める）。main 側は `src/main/store/session-cookies.ts`。
 *
 * Electron に依存しない（`scripts/session-cookies.test.mjs`）。
 */

/**
 * 保存する cookie の形（Electron の `Cookie` から、戻すのに要るものだけ）。
 * @typedef {{
 *   name: string
 *   value: string
 *   domain: string
 *   hostOnly: boolean
 *   path: string
 *   secure: boolean
 *   httpOnly: boolean
 *   sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
 * }} SavedCookie
 */

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict'])

/**
 * 写し（Map）のキー。Chromium の cookie の同一性（name・domain・path）と同じ。
 * partitioned cookie（CHIPS）の partition は Electron 41 の `Cookie` / `cookies.set` に出ていないので区別できない
 * （同じ name・domain・path で partition だけ違うものは 1 件にまとまり、戻すと partition 無しで入る）。対象外として受け入れる
 */
export function cookieKey(/** @type {{ name: string, domain?: string, path?: string }} */ cookie) {
  return `${cookie.domain ?? ''}\t${cookie.path ?? '/'}\t${cookie.name}`
}

/**
 * Electron の `Cookie` を保存する形にする。保存しないもの（期限付き・形が壊れている）は null。
 * @param {Record<string, unknown>} cookie
 * @returns {SavedCookie | null}
 */
export function toSavedCookie(cookie) {
  if (!cookie || cookie['session'] !== true) return null
  const { name, value, domain } = cookie
  if (typeof name !== 'string' || typeof value !== 'string' || typeof domain !== 'string' || !domain)
    return null
  const sameSite = typeof cookie['sameSite'] === 'string' && SAME_SITE.has(cookie['sameSite'])
  return {
    name,
    value,
    domain,
    hostOnly: cookie['hostOnly'] === true,
    path: typeof cookie['path'] === 'string' && cookie['path'] ? cookie['path'] : '/',
    secure: cookie['secure'] === true,
    httpOnly: cookie['httpOnly'] === true,
    sameSite: sameSite ? /** @type {SavedCookie['sameSite']} */ (cookie['sameSite']) : 'unspecified'
  }
}

/**
 * `cookies.on('changed')` の 1 件を写しに反映する。変わったら true。
 * 消えた・期限付きになった cookie は写しから外す（上書きは「消える → 足される」の 2 件で来る）。
 * @param {Map<string, SavedCookie>} mirror
 * @param {Record<string, unknown>} cookie
 * @param {boolean} removed
 */
export function applyCookieChange(mirror, cookie, removed) {
  const key = cookieKey(/** @type {{ name: string, domain?: string, path?: string }} */ (cookie))
  const saved = removed ? null : toSavedCookie(cookie)
  if (!saved) return mirror.delete(key)
  const before = mirror.get(key)
  mirror.set(key, saved)
  return !before || JSON.stringify(before) !== JSON.stringify(saved)
}

/**
 * 保存した cookie を `cookies.set` の引数にする（`expirationDate` を付けない = セッション cookie のまま戻す）。
 * host-only の cookie は `domain` を渡さない（渡すとサブドメインにも送る cookie に化ける）。
 * @param {SavedCookie} cookie
 * @returns {{
 *   url: string
 *   name: string
 *   value: string
 *   path: string
 *   secure: boolean
 *   httpOnly: boolean
 *   sameSite: SavedCookie['sameSite']
 *   domain?: string
 * }}
 */
export function toSetDetails(cookie) {
  const host = cookie.domain.replace(/^\./, '')
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain })
  }
}

/**
 * 復号した JSON を検査して、戻せる cookie だけにする（壊れた要素は捨てる。全体は捨てない）。
 * @param {unknown} parsed
 * @returns {SavedCookie[]}
 */
export function parseSavedCookies(parsed) {
  if (!Array.isArray(parsed)) return []
  /** @type {SavedCookie[]} */
  const out = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const saved = toSavedCookie({ ...item, session: true })
    if (saved) out.push(saved)
  }
  return out
}
