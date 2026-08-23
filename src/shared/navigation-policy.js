// @ts-check
/**
 * ナビゲーションの許可判定。Electron に依存しない純粋な関数だけを置き、
 * `scripts/navigation-policy.test.mjs` から直接テストできるようにしている
 * （許可外 scheme を拒否することの回帰テストは、実アプリを起動せず回したい）。
 */

/** 通常の Web ページとして開いてよい scheme。 */
export const PAGE_SCHEMES = new Set(['http:', 'https:'])

/**
 * **明示的に拒否する scheme**（計画 1-0）。
 *
 * `PAGE_SCHEMES` に無いものはそもそも通らないので、この集合は判定に使わない。
 * 「うっかり許可側に足さないための覚書」として置き、
 * `scripts/navigation-policy.test.mjs` が1つずつ拒否されることを確認する。
 */
export const DENIED_SCHEMES = Object.freeze([
  'javascript:', // ブックマークレット相当。UI からもページからも通さない
  'data:', // data: ページは origin を持たないので同一生成元の判定が崩れる
  'file:', // ローカルファイルはブラウザ UI からは開かない
  'chrome:',
  'devtools:',
  'blob:',
  'filesystem:',
  'view-source:'
])

/** 新規タブの空ページ。`about:` を丸ごと許可すると `about:srcdoc` 等まで通るので厳密一致で扱う。 */
export const BLANK_URL = 'about:blank'

/** ブラウザ UI を配信する origin。ページ側 WebContents では**絶対に**開かない。 */
export const UI_SCHEME_URL_PREFIX = 'nemo://ui/'

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

/** 検索エンジンの既定（`{q}` を入力で置換する）。 */
export const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q={q}'

/**
 * コマンドバー等の人間の入力を、そのまま loadURL に渡さずに正規化・検証する。
 * ここからは `chrome-extension:` / `devtools:` / `file:` / `javascript:` / `nemo:` を一切通さない。
 * @param {string} input
 * @param {string} [searchTemplate] 検索に回すときのテンプレート（https のみ）
 * @returns {NavigationDecision}
 */
export function normalizeNavigationInput(input, searchTemplate = DEFAULT_SEARCH_TEMPLATE) {
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

    let candidate
    try {
      candidate = new URL(trimmed)
    } catch {
      // scheme はあるが URL として壊れている入力（`http:/x` など）
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
  return { allowed: true, url: buildSearchUrl(trimmed, searchTemplate) }
}

/**
 * 検索 URL を組み立てる。テンプレートが壊れていたら既定に落とす
 * （設定ファイル1行で任意 scheme のナビゲーションを作れないようにする）。
 * @param {string} query
 * @param {string} template
 */
function buildSearchUrl(query, template) {
  const candidate = (template.includes('{q}') ? template : DEFAULT_SEARCH_TEMPLATE).replace(
    '{q}',
    encodeURIComponent(query)
  )
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') throw new Error('not https')
    return url.toString()
  } catch {
    return DEFAULT_SEARCH_TEMPLATE.replace('{q}', encodeURIComponent(query))
  }
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

/**
 * コマンドライン引数から「外部から開けと渡された URL」を拾う（計画 2-5）。
 *
 * macOS では `open-url` イベントで届くが、macOS 以外の経路と
 * `open --args` からの起動では argv に乗る。**ここでは形だけ見て拾い**、
 * 実際に開いてよいかは `isNavigableUrl` で改めて判定する
 * （argv は外から来る文字列なので、拾った時点では信用しない）。
 *
 * @param {readonly string[]} argv 実行ファイル名を除いた引数
 * @returns {string[]}
 */
export function urlsFromArgv(argv) {
  if (!Array.isArray(argv)) return []
  return argv.filter((arg) => typeof arg === 'string' && /^https?:\/\//i.test(arg))
}
