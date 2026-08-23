// @ts-check
/**
 * ナビゲーションの許可判定。Electron に依存しない純粋な関数だけを置き、
 * `scripts/navigation-policy.test.mjs` から直接テストできるようにしている
 * （許可外 scheme を拒否することの回帰テストは、実アプリを起動せず回したい）。
 */

/** 通常の Web ページとして開いてよい scheme。 */
export const PAGE_SCHEMES = new Set(['http:', 'https:'])

/** 新規タブの空ページ。`about:` を丸ごと許可すると `about:srcdoc` 等まで通るので厳密一致で扱う。 */
export const BLANK_URL = 'about:blank'

/**
 * @typedef {object} NavigationPolicy
 * @property {boolean} [allowExtensionPages]
 *   `chrome-extension://<extensionIds に含まれる ID>/` を許可する。
 *   拡張自身がタブを作る経路でのみ true にする。
 *   コマンドバーや Web ページからのナビゲーションでは絶対に true にしない。
 * @property {ReadonlySet<string>} [extensionIds] ロード済み拡張の ID。
 */

/**
 * ログに出す URL は scheme とホストまでに落とす。
 * パス・クエリ・フラグメントにはトークンが載りうるので出さない（計画 1-9 のルール）。
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol
  } catch {
    const colon = url.indexOf(':')
    return colon > 0 ? `${url.slice(0, colon + 1)}…` : '(unparsable)'
  }
}

/**
 * @param {string} url
 * @param {NavigationPolicy} [policy]
 * @returns {boolean}
 */
export function isNavigableUrl(url, policy = {}) {
  if (url === BLANK_URL) return true

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (PAGE_SCHEMES.has(parsed.protocol)) return true

  if (policy.allowExtensionPages && parsed.protocol === 'chrome-extension:') {
    return policy.extensionIds ? policy.extensionIds.has(parsed.hostname) : false
  }

  return false
}

/**
 * その URL がロード済み拡張のページか。
 * @param {string} url
 * @param {ReadonlySet<string>} extensionIds
 * @returns {boolean}
 */
export function isLoadedExtensionUrl(url, extensionIds) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'chrome-extension:' && extensionIds.has(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * @typedef {object} NavigationDecision
 * @property {boolean} allowed
 * @property {string} url
 * @property {string} [reason]
 */

/**
 * コマンドバー等の人間の入力を、そのまま loadURL に渡さずに正規化・検証する。
 * ここからは `chrome-extension:` / `devtools:` / `file:` / `javascript:` を一切通さない。
 * @param {string} input
 * @returns {NavigationDecision}
 */
export function normalizeNavigationInput(input) {
  const trimmed = input.trim()
  if (!trimmed) return { allowed: false, url: '', reason: 'empty' }
  if (trimmed === BLANK_URL) return { allowed: true, url: BLANK_URL }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)

  if (hasScheme) {
    // `localhost:8787` は URL としては scheme `localhost:` に見えてしまう。
    // 「scheme に見えるが実体は host:port」を先に救っておかないと、
    // ローカル開発でアドレスバーが使えなくなる。
    const hostPort = /^([^\s/:?#]+):(\d{1,5})(\/.*)?$/.exec(trimmed)
    if (hostPort) {
      return { allowed: true, url: `${schemeForHost(hostPort[1])}//${trimmed}` }
    }

    let candidate = null
    try {
      candidate = new URL(trimmed)
    } catch {
      candidate = null
    }
    if (!candidate || !PAGE_SCHEMES.has(candidate.protocol)) {
      const scheme = candidate ? candidate.protocol : `${trimmed.slice(0, trimmed.indexOf(':') + 1)}`
      return { allowed: false, url: trimmed, reason: `scheme_not_allowed:${scheme}` }
    }
    return { allowed: true, url: candidate.toString() }
  }

  // scheme が無い入力。ドメインらしければ scheme を補い、そうでなければ検索に回す。
  // ループバック判定はポートを除いたホストで行う（127.0.0.1:8787 等）
  const host = trimmed.split(/[/?#]/)[0].replace(/:\d+$/, '')
  const looksLikeHost = /^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(trimmed) || isLoopbackHost(host)
  if (looksLikeHost) {
    return { allowed: true, url: `${schemeForHost(host)}//${trimmed}` }
  }
  return { allowed: true, url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}` }
}

/**
 * ループバックか（ローカル開発では http が期待値なので分ける）。
 * @param {string} host
 */
function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** @param {string} host */
function schemeForHost(host) {
  return isLoopbackHost(host) ? 'http:' : 'https:'
}
