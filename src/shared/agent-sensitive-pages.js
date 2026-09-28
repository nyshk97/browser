// @ts-check
/**
 * Claude in Nemo で **Claude に操作させないページ**の判定（計画 Phase 7「既知の危ないページ」）。
 *
 * ログインを引き継いだ後のセッションで、Claude（= 操作中のページに誘導されうる）が
 * API トークン・SSH 鍵・OAuth の許可・再認証（sudo）を**作って持ち出す**経路を塞ぐ。
 * ここに当たるページでは、Claude の navigate と入力系ツールを断り、`request_user_action` でユーザーに頼ませる。
 * 読み取り（スクショ・read_page）は断らない（ユーザーの番の画面を Claude が確かめるため）。
 *
 * 判定は**ドキュメントの URL（origin とパス）だけ**で行う。タイトルやページの文言は見ない
 * （ページが自分で書き換えられる）。パスも `pushState` で書き換えられるので、ここは
 * 「危ないページを取りこぼさない」側の網で、偽装への防御ではない（偽装されても危ない側にしか倒れない）。
 *
 * Electron に依存しない純粋な関数だけを置く（`scripts/agent-sensitive-pages.test.mjs`）。
 */

/**
 * @typedef {'token' | 'oauth' | 'reauth'} SensitiveKind
 * - `token` … API トークン・鍵・シークレットを発行 / 表示する画面
 * - `oauth` … 第三者アプリへの権限付与（同意画面）
 * - `reauth` … 再認証・2 段階認証やパスワードの設定変更
 */

/** @type {{ host: RegExp, path: RegExp, kind: SensitiveKind }[]} */
const RULES = [
  // GitHub
  {
    host: /^github\.com$/,
    path: /^\/settings\/(tokens|personal-access-tokens|keys|ssh|gpg_keys)(\/|$)/,
    kind: 'token'
  },
  {
    host: /^github\.com$/,
    path: /^\/settings\/(applications|apps|connections\/applications|installations)(\/|$)/,
    kind: 'oauth'
  },
  {
    host: /^github\.com$/,
    path: /^\/settings\/(security|auth|two_factor_authentication|password)(\/|$)/,
    kind: 'reauth'
  },
  {
    host: /^github\.com$/,
    path: /^\/[^/]+\/[^/]+\/settings\/(keys|secrets|variables|hooks)(\/|$)/,
    kind: 'token'
  },
  {
    host: /^github\.com$/,
    path: /^\/organizations\/[^/]+\/settings\/(secrets|variables|applications|personal-access-tokens)(\/|$)/,
    kind: 'token'
  },
  { host: /^github\.com$/, path: /^\/login\/(oauth|device)(\/|$)/, kind: 'oauth' },
  { host: /^github\.com$/, path: /^\/sessions\/(sudo|two-factor)(\/|$)/, kind: 'reauth' },
  // Google
  { host: /^accounts\.google\.com$/, path: /^\/(o\/oauth2|signin\/oauth)(\/|$)/, kind: 'oauth' },
  {
    host: /^myaccount\.google\.com$/,
    path: /^\/(security|signinoptions|apppasswords|connections|permissions)(\/|$)/,
    kind: 'reauth'
  },
  {
    host: /^console\.cloud\.google\.com$/,
    path: /^\/(apis\/credentials|iam-admin\/serviceaccounts)(\/|$)/,
    kind: 'token'
  },
  // Stripe / Cloudflare / Apple / X
  { host: /^dashboard\.stripe\.com$/, path: /^(\/test)?\/(apikeys|webhooks)(\/|$)/, kind: 'token' },
  { host: /^dash\.cloudflare\.com$/, path: /^\/profile\/(api-tokens|authentication)(\/|$)/, kind: 'token' },
  { host: /^appstoreconnect\.apple\.com$/, path: /^\/access\/(integrations|api)(\/|$)/, kind: 'token' },
  {
    host: /^account\.apple\.com$|^appleid\.apple\.com$/,
    path: /^\/account\/manage\/section\/security(\/|$)/,
    kind: 'reauth'
  },
  { host: /^developer\.(x|twitter)\.com$/, path: /\/(keys|keys-and-tokens)(\/|$)/, kind: 'token' }
]

/**
 * その URL が Claude に操作させないページか。
 * @param {string} url
 * @returns {SensitiveKind | null}
 */
export function sensitivePageKind(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  for (const rule of RULES) {
    if (rule.host.test(host) && rule.path.test(path)) return rule.kind
  }
  // 汎用の OAuth 認可要求（どの IdP でも同じ形。client_id と redirect_uri と response_type / scope）
  const params = parsed.searchParams
  if (
    params.has('client_id') &&
    params.has('redirect_uri') &&
    (params.has('response_type') || params.has('scope'))
  ) {
    return 'oauth'
  }
  return null
}

/**
 * Claude に返す断りの文言。
 * @param {SensitiveKind} kind
 */
export function sensitivePageMessage(kind) {
  const what =
    kind === 'token'
      ? 'API トークン・鍵・シークレットを発行 / 表示する画面'
      : kind === 'oauth'
        ? '第三者アプリへの権限付与（OAuth の同意）の画面'
        : '再認証・2 段階認証・パスワード等のセキュリティ設定の画面'
  return `このページは${what}なので、Claude は操作できません（Nemo の決まり）。必要なら request_user_action でユーザーに操作を頼んでください。`
}
