// @ts-check
import { normalizeLivePullRequest } from './live-folder-schema.js'

/**
 * GitHub の Pull Request を GraphQL で1発取ってくる。
 *
 * **Electron に依存しない**（`fetch` を引数で注入する）ので、
 * `scripts/live-folder.test.mjs` から実 API を叩かずに全経路を踏める。
 * main 側（`src/main/live-folders/github-pr.ts`）は `net.fetch` を渡すだけ。
 *
 * Arc のように github.com の HTML をスクレイプする方式は採らない
 * （DOM が変わるたび壊れる。Arc 自身が新旧2系統のパーサを抱えているのがその維持コストの証拠）。
 */

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql'

/**
 * 1検索あたりの取得件数。`search` の上限が 100 なのでそこに合わせる。
 * **ページングはしない**。自分に関係する open PR が 100 件を超えるのは平常時にありえず、
 * 仮に超えてもサイドバーに 100 行出ている時点で一覧として機能していない。
 * ただし**黙って切らない**（`issueCount` を見て打ち切りを明示する）。
 */
export const SEARCH_PAGE_SIZE = 100

/**
 * **両方のクエリに `sort:updated-desc` を入れる。**
 * これが無いと既定順（best-match）で返るので、100 件で切られたときに
 * 「どの 100 件が残るか」が不定になる。取得後に並べ替えても、
 * **取得されなかった PR は救えない**。
 *
 * `commits.statusCheckRollup`（CI の状態）は**取らない**。
 * 表示しないものを取ってもレスポンスが重くなるだけ。
 */
export const PR_QUERY = `query LiveFolder($first: Int!) {
  viewer { login }
  reviewRequested: search(query: "is:open is:pr review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: $first) {
    issueCount
    nodes { ...pr }
  }
  mine: search(query: "is:open is:pr author:@me archived:false sort:updated-desc", type: ISSUE, first: $first) {
    issueCount
    nodes { ...pr }
  }
  rateLimit { cost remaining resetAt }
}
fragment pr on PullRequest {
  number
  title
  url
  isDraft
  updatedAt
  reviewDecision
  author { login }
  repository { nameWithOwner }
}`

/* ------------------------------------------------------------------ *
 * 状態の判定
 * ------------------------------------------------------------------ */

/**
 * PR の状態を1つに決める。**呼び出し側に `isDraft` と `reviewDecision` の分岐を散らさない。**
 *
 * 競合するので優先順位を決めてある。一度 approve された PR を draft に戻すと
 * `isDraft: true` と `reviewDecision: 'APPROVED'` が**同時に立つ**。
 * **`isDraft` が最優先**（draft はレビューを受け付けない状態なので、
 * そこに古い approval のチェックを出すと「もう通っている」と誤読される）。
 *
 * @param {{ isDraft?: unknown, reviewDecision?: unknown }} pr
 * @returns {import('./types.js').LivePrState}
 */
export function prState(pr) {
  if (pr.isDraft === true) return 'draft'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested'
  return 'waiting'
}

/* ------------------------------------------------------------------ *
 * 失敗の分類
 * ------------------------------------------------------------------ */

/**
 * `Retry-After` を待ち時間（ミリ秒）に直す。
 *
 * **秒数とは限らない。** RFC 9110 §10.2.3 は delay-seconds と HTTP-date の
 * **両方**を許している（`Retry-After: Wed, 26 Aug 2026 10:30:00 GMT`）。
 *
 * ①整数として読めれば秒数 ②読めなければ HTTP-date として `Date.parse`
 * ③どちらも不正なら **null を返して通常のバックオフに落とす**
 * （変な値のせいで永遠に待つ、を作らない）。過去の日時は 0（＝すぐ次を試す）。
 *
 * @param {unknown} value
 * @param {number} now epoch ms
 * @returns {number | null} 待ち時間（ms）。解釈できなければ null
 */
export function parseRetryAfter(value, now) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    if (!Number.isFinite(seconds)) return null
    return Math.min(seconds, 24 * 3600) * 1000
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/** 認証として扱う GraphQL の `errors[].type`。 */
const AUTH_ERROR_TYPES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_SCOPES'])

/**
 * 「トークンを直すまで直らない」ことを示すメッセージ。
 *
 * fine-grained PAT で対象 org や権限が足りないと、GraphQL は 403 で
 * `Resource not accessible by personal access token` を返す。
 * 401 でもレート制限でもないので、**放っておくと永遠に `Couldn't refresh` を
 * 出しながら再試行し続ける**。直す方法は「トークンを直す」ことなので `auth` に入れる。
 */
const PERMISSION_MESSAGE_RE =
  /resource not accessible by (?:personal access token|integration)|bad credentials|requires authentication|token.*(?:expired|revoked)/i

/** secondary rate limit は `errors[].type` が付かず message にだけ出ることがある。 */
const SECONDARY_LIMIT_RE = /secondary rate limit/i

/**
 * 本文に出てくるメッセージを全部集める（`errors[].message` と REST 形式の `message`）。
 * @param {unknown} body
 * @returns {string[]}
 */
function bodyMessages(body) {
  /** @type {string[]} */
  const messages = []
  if (typeof body !== 'object' || body === null) return messages
  const record = /** @type {Record<string, unknown>} */ (body)
  if (typeof record['message'] === 'string') messages.push(record['message'])
  const errors = record['errors']
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (typeof error === 'object' && error !== null) {
        const message = /** @type {Record<string, unknown>} */ (error)['message']
        if (typeof message === 'string') messages.push(message)
      }
    }
  }
  return messages
}

/**
 * `errors[].type` を全部集める。
 * @param {unknown} body
 * @returns {string[]}
 */
function bodyErrorTypes(body) {
  /** @type {string[]} */
  const types = []
  if (typeof body !== 'object' || body === null) return types
  const errors = /** @type {Record<string, unknown>} */ (body)['errors']
  if (!Array.isArray(errors)) return types
  for (const error of errors) {
    if (typeof error === 'object' && error !== null) {
      const type = /** @type {Record<string, unknown>} */ (error)['type']
      if (typeof type === 'string') types.push(type)
    }
  }
  return types
}

/**
 * 本文の `data.rateLimit.resetAt`。
 * @param {unknown} body
 * @returns {number | null}
 */
function bodyRateLimitResetAt(body) {
  if (typeof body !== 'object' || body === null) return null
  const data = /** @type {Record<string, unknown>} */ (body)['data']
  if (typeof data !== 'object' || data === null) return null
  const rateLimit = /** @type {Record<string, unknown>} */ (data)['rateLimit']
  if (typeof rateLimit !== 'object' || rateLimit === null) return null
  const resetAt = /** @type {Record<string, unknown>} */ (rateLimit)['resetAt']
  if (typeof resetAt !== 'string') return null
  const at = Date.parse(resetAt)
  return Number.isNaN(at) ? null : at
}

/**
 * @typedef {object} FailureClassification
 * @property {'auth' | 'rate-limit' | 'transient'} kind
 * @property {number | null} resetAt レート制限が解ける時刻（epoch ms）。`rate-limit` 以外は null
 * @property {number | null} retryAfterMs サーバが申告した待ち時間（ms）。無ければ null
 */

/**
 * 失敗を3つに分類する。**この述語1つに閉じ、呼び出し側で HTTP ステータスを見ない。**
 *
 * `rate-limit` は上から順に見る（`primary` だけ見ると secondary を取りこぼす）:
 *
 * 1. **403 / 429 で** `retry-after` ヘッダがある → `now + retry-after`
 * 2. `x-ratelimit-remaining: 0` → `x-ratelimit-reset`
 * 3. `errors[].type === 'RATE_LIMITED'` → `rateLimit.resetAt`、無ければ `now + 60s`
 * 4. **ステータスに関係なく**本文が secondary limit を示す → `retry-after` があればそれ、無ければ `now + 60s`
 *
 * - **403 を一律 `auth` にしない**（secondary rate limit でも 403 が返る）
 * - **`remaining` が 0 でなくても secondary limit は起きる**
 * - **本文の判定をステータスで絞らない**（GraphQL の secondary limit は HTTP 200 でも返る）
 * - **`retry-after` 単独で `rate-limit` と断定しない**。`Retry-After` は 503 でも
 *   正当に使われる（RFC 9110 §10.2.3）ので、#1 は 403 / 429 のときだけに絞る。
 *   ただし `transient` でも `retryAfterMs` は返す（サーバの申告を無視して 60 秒で叩かない）
 *
 * @param {{ status: number, headers: { get(name: string): string | null }, body: unknown, now: number }} input
 * @returns {FailureClassification}
 */
export function classifyFailure({ status, headers, body, now }) {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'), now)
  const messages = bodyMessages(body)
  const errorTypes = bodyErrorTypes(body)

  // 401 は資格情報そのものの問題。レート制限の判定より先に決める
  if (status === 401) return { kind: 'auth', resetAt: null, retryAfterMs }

  /* ---- rate-limit（上から順に） ---- */
  // #1 403 / 429 で retry-after
  if ((status === 403 || status === 429) && retryAfterMs !== null) {
    return { kind: 'rate-limit', resetAt: now + retryAfterMs, retryAfterMs }
  }
  // #2 remaining: 0
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'))
    return {
      kind: 'rate-limit',
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000,
      retryAfterMs
    }
  }
  // #3 errors[].type === 'RATE_LIMITED'
  if (errorTypes.includes('RATE_LIMITED')) {
    return { kind: 'rate-limit', resetAt: bodyRateLimitResetAt(body) ?? now + 60_000, retryAfterMs }
  }
  // #4 本文が secondary limit を示す（**ステータスに関係なく**当てる）
  if (messages.some((message) => SECONDARY_LIMIT_RE.test(message))) {
    return { kind: 'rate-limit', resetAt: now + (retryAfterMs ?? 60_000), retryAfterMs }
  }

  /* ---- auth ---- */
  if (errorTypes.some((type) => AUTH_ERROR_TYPES.has(type))) {
    return { kind: 'auth', resetAt: null, retryAfterMs }
  }
  if (messages.some((message) => PERMISSION_MESSAGE_RE.test(message))) {
    return { kind: 'auth', resetAt: null, retryAfterMs }
  }

  /* ---- それ以外は transient ---- */
  return { kind: 'transient', resetAt: null, retryAfterMs }
}

/* ------------------------------------------------------------------ *
 * レスポンスの解釈
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 検索1件ぶんの nodes を PR の配列に直す。
 *
 * `search(type: ISSUE)` は Issue も返しうる（fragment が当たらず `{}` になる）ので、
 * **url が PR の形をしていないものは落とす**。
 *
 * **検索そのものの形が違えば null を返す。** `nodes` や `issueCount` が欠けたレスポンスを
 * 「0 件の成功」として扱うと、**既存のキャッシュが全消去される**
 * （HTTP 200 で `viewer` だけ返ってくる壊れ方が実際にありうる）。
 *
 * 各項目は**キャッシュを読むときと同じ `normalizeLivePullRequest` を通す**。
 * ここを通さないと、取得直後の UI と保存ファイルにだけ 200 文字超の値が入る
 * （`JsonStore.set()` は normalize しない）。
 *
 * @param {unknown} search
 * @param {import('./types.js').LivePrBucket} bucket
 * @returns {{ items: import('./types.js').LivePullRequest[], truncation: import('./types.js').LiveFolderTruncation | null } | null}
 */
function readSearch(search, bucket) {
  if (!isRecord(search)) return null
  const nodes = search['nodes']
  const issueCount = search['issueCount']
  if (!Array.isArray(nodes)) return null
  if (typeof issueCount !== 'number' || !Number.isInteger(issueCount) || issueCount < 0) return null

  /** @type {import('./types.js').LivePullRequest[]} */
  const items = []
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const author = isRecord(node['author']) ? node['author']['login'] : null
    const repository = isRecord(node['repository']) ? node['repository']['nameWithOwner'] : null
    const pr = normalizeLivePullRequest({
      url: node['url'],
      title: node['title'],
      repo: repository,
      // 著者が削除済みだと `author` は null。落とさずに空文字で出す
      author,
      state: prState(node),
      bucket,
      updatedAt: node['updatedAt']
    })
    if (pr) items.push(pr)
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  // **打ち切りは検索単位**（`nodes` の長さと総ヒット数を比べる。バケットに割り当てられた件数はここに入れない）
  const truncation = issueCount > nodes.length ? { returned: nodes.length, total: issueCount } : null
  return { items, truncation }
}

/**
 * @typedef {object} PullRequestsResult
 * @property {true} ok
 * @property {string} login
 * @property {import('./types.js').LivePullRequest[]} items
 * @property {import('./types.js').LiveFolderTruncations} truncation
 * @property {number | null} cost `rateLimit.cost`（実データでの重さを確かめるためログに出す）
 * @property {number | null} remaining
 */

/**
 * @typedef {object} PullRequestsFailure
 * @property {false} ok
 * @property {FailureClassification} failure
 * @property {number} status 診断ログ用（**UI はこれを見ない**）
 */

/**
 * GraphQL のレスポンス本文を解釈する。
 *
 * **GraphQL は HTTP 200 でも `errors` を返す**ので、ステータスコードだけ見ると
 * 「空の一覧を取得成功した」と誤読して**全件消える**。
 *
 * @param {{ status: number, headers: { get(name: string): string | null }, body: unknown, now: number }} input
 * @returns {PullRequestsResult | PullRequestsFailure}
 */
export function readPullRequestsResponse({ status, headers, body, now }) {
  if (status !== 200 || !isRecord(body)) {
    return { ok: false, failure: classifyFailure({ status, headers, body, now }), status }
  }
  if (Array.isArray(body['errors']) && body['errors'].length > 0) {
    return { ok: false, failure: classifyFailure({ status, headers, body, now }), status }
  }
  const data = body['data']
  if (!isRecord(data)) {
    return { ok: false, failure: { kind: 'transient', resetAt: null, retryAfterMs: null }, status }
  }
  // `viewer` が null なら、200 でも認証が通っていない
  const viewer = data['viewer']
  const login = isRecord(viewer) && typeof viewer['login'] === 'string' ? viewer['login'] : ''
  if (!login) {
    return { ok: false, failure: { kind: 'auth', resetAt: null, retryAfterMs: null }, status }
  }

  const review = readSearch(data['reviewRequested'], 'review')
  const mine = readSearch(data['mine'], 'mine')
  // **片方でも形が違えば失敗**（0 件の成功として扱うとキャッシュが全消去される）
  if (!review || !mine) {
    return { ok: false, failure: { kind: 'transient', resetAt: null, retryAfterMs: null }, status }
  }

  // **両方に入る PR は `review` を優先する**（自分の PR に自分でレビュー依頼が来る場合がある）。
  // 重複を除くのは表示だけで、打ち切り（`truncation`）は検索単位のまま触らない。
  const reviewUrls = new Set(review.items.map((item) => item.url))
  const items = [...review.items, ...mine.items.filter((item) => !reviewUrls.has(item.url))]

  const rateLimit = isRecord(data['rateLimit']) ? data['rateLimit'] : null
  return {
    ok: true,
    login,
    items,
    truncation: { review: review.truncation, mine: mine.truncation },
    cost: rateLimit && typeof rateLimit['cost'] === 'number' ? rateLimit['cost'] : null,
    remaining: rateLimit && typeof rateLimit['remaining'] === 'number' ? rateLimit['remaining'] : null
  }
}

/* ------------------------------------------------------------------ *
 * 取得
 * ------------------------------------------------------------------ */

/**
 * 最小の fetch 互換。**`Response` 型そのものを要求しない**
 * （renderer 側の tsconfig には DOM、main 側には Node の型しか無い）。
 * @typedef {object} FetchLike
 * @property {number} status
 * @property {{ get(name: string): string | null }} headers
 * @property {() => Promise<string>} text
 */

/**
 * PR を1リクエストで取ってくる。
 *
 * @param {object} input
 * @param {string} input.token
 * @param {string} input.endpoint
 * @param {(url: string, init: { method: string, headers: Record<string, string>, body: string, signal?: unknown }) => Promise<FetchLike>} input.fetchImpl
 * @param {number} [input.now]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<PullRequestsResult | PullRequestsFailure>}
 */
export async function fetchPullRequests({
  token,
  endpoint,
  fetchImpl,
  now = Date.now(),
  timeoutMs = 15_000
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'Nemo'
      },
      body: JSON.stringify({ query: PR_QUERY, variables: { first: SEARCH_PAGE_SIZE } }),
      signal: controller.signal
    })
    const text = await response.text()
    /** @type {unknown} */
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      // パース失敗は transient（ステータスが 200 でも中身が読めなければ成功ではない）
      body = null
    }
    return readPullRequestsResponse({ status: response.status, headers: response.headers, body, now })
  } catch {
    // ネットワーク断・タイムアウト（中身を握らない。**トークンを載せない**ため）
    return { ok: false, failure: { kind: 'transient', resetAt: null, retryAfterMs: null }, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}
