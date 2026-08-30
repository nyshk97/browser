import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyFailure,
  fetchPullRequests,
  parseRetryAfter,
  prState,
  readPullRequestsResponse
} from '../src/shared/github-pr.js'
import { MAX_LIVE_PRS, normalizeLiveFolderCache, normalizePrUrl } from '../src/shared/live-folder-schema.js'

/**
 * Live Folder（GitHub の PR）の取得と正規化のテスト。
 *
 * **実 API は叩かない。** fixture は合成で作ってある（`scripts/fixtures/github-prs.json`）。
 * 実レスポンスの置換にすると、社内のリポジトリ名・owner・PR の URL・author login が
 * 全部入っており、タイトルだけ差し替えても消し残る。
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FIXTURE = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'github-prs.json'), 'utf8'))

const NOW = Date.parse('2026-08-26T09:00:00Z')

/** ヘッダの最小実装（`Headers` に依存しない）。 */
function headers(map = {}) {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return { get: (name) => lower.get(name.toLowerCase()) ?? null }
}

function read(body, { status = 200, head = {} } = {}) {
  return readPullRequestsResponse({ status, headers: headers(head), body, now: NOW })
}

/** fixture の deep copy（テスト間で書き換えが漏れないように）。 */
const fixture = () => JSON.parse(JSON.stringify(FIXTURE))

/* ------------------------------------------------------------------ *
 * 状態の判定
 * ------------------------------------------------------------------ */

test('状態は4値になる。isDraft が最優先', () => {
  assert.equal(prState({ isDraft: false, reviewDecision: 'APPROVED' }), 'approved')
  assert.equal(prState({ isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }), 'changes-requested')
  assert.equal(prState({ isDraft: false, reviewDecision: 'REVIEW_REQUIRED' }), 'waiting')
  assert.equal(prState({ isDraft: false, reviewDecision: null }), 'waiting')
  // approve 済みの PR を draft に戻すと両方立つ。draft が勝たないと
  // 「もう通っている」と誤読される
  assert.equal(prState({ isDraft: true, reviewDecision: 'APPROVED' }), 'draft')
  assert.equal(prState({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED' }), 'draft')
})

/* ------------------------------------------------------------------ *
 * レスポンスの解釈
 * ------------------------------------------------------------------ */

test('並びは updatedAt 降順、両方に入る PR は review 側に寄る', () => {
  const result = read(fixture())
  assert.equal(result.ok, true)
  assert.equal(result.login, 'octo-dev')

  const review = result.items.filter((item) => item.bucket === 'review')
  const mine = result.items.filter((item) => item.bucket === 'mine')
  assert.deepEqual(
    review.map((item) => item.url),
    [
      'https://github.com/acme/tools/pull/12',
      'https://github.com/acme/widgets/pull/41',
      'https://github.com/acme/tools/pull/7'
    ]
  )
  // acme/tools/pull/12 は mine にも居るが review へ寄せるので出ない
  assert.deepEqual(
    mine.map((item) => item.url),
    ['https://github.com/acme/widgets/pull/88', 'https://github.com/acme/widgets/pull/90']
  )
  assert.equal(review[0].state, 'approved')
  assert.equal(mine[0].state, 'draft')
  assert.equal(mine[1].state, 'waiting')
})

test('著者が削除済み（author: null）でも落ちない', () => {
  const result = read(fixture())
  const orphan = result.items.find((item) => item.url === 'https://github.com/acme/tools/pull/7')
  assert.equal(orphan.author, '')
  assert.equal(orphan.repo, 'acme/tools')
})

test('nodes が空でも落ちない', () => {
  const body = fixture()
  body.data.reviewRequested = { issueCount: 0, nodes: [] }
  body.data.mine = { issueCount: 0, nodes: [] }
  const result = read(body)
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.truncation, { review: null, mine: null })
})

test('HTTP 200 + errors は失敗として扱う（空の一覧を成功と読まない）', () => {
  const result = read({ errors: [{ message: 'Something went wrong' }] })
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'transient')
})

test('HTTP 200 でも viewer が null なら auth', () => {
  const body = fixture()
  body.data.viewer = null
  const result = read(body)
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'auth')
})

test('打ち切りは検索単位。片側だけ超えたら片側だけ立つ', () => {
  const body = fixture()
  // reviewRequested だけ 137 件ヒットして 100 件返った状況
  body.data.reviewRequested.issueCount = 137
  body.data.reviewRequested.nodes = Array.from({ length: 100 }, (_unused, index) => ({
    number: 1000 + index,
    title: `bulk ${index}`,
    url: `https://github.com/acme/bulk/pull/${1000 + index}`,
    isDraft: false,
    updatedAt: '2026-08-24T09:00:00Z',
    reviewDecision: null,
    author: { login: 'someone' },
    repository: { nameWithOwner: 'acme/bulk' }
  }))
  const result = read(body)
  assert.deepEqual(result.truncation.review, { returned: 100, total: 137 })
  assert.equal(result.truncation.mine, null, 'mine は切られていないので null のまま')
})

test('PR ではない node（Issue）は落ちる', () => {
  const body = fixture()
  body.data.mine.nodes.push({})
  body.data.mine.nodes.push({
    url: 'https://github.com/acme/tools/issues/9',
    updatedAt: '2026-08-26T00:00:00Z'
  })
  const result = read(body)
  assert.equal(result.items.filter((item) => item.url.includes('/issues/')).length, 0)
})

test('検索の形が壊れた HTTP 200 は「0 件の成功」にしない', () => {
  // `viewer` だけ返ってくる壊れ方。成功として扱うと**既存のキャッシュが全消去される**
  const onlyViewer = read({ data: { viewer: { login: 'octo-dev' } } })
  assert.equal(onlyViewer.ok, false)
  assert.equal(onlyViewer.failure.kind, 'transient')

  // nodes が配列でない
  const badNodes = fixture()
  badNodes.data.mine.nodes = null
  assert.equal(read(badNodes).ok, false)

  // issueCount が無い
  const noCount = fixture()
  delete noCount.data.reviewRequested.issueCount
  assert.equal(read(noCount).ok, false)

  // 片方だけ壊れていても失敗
  const halfBroken = fixture()
  halfBroken.data.mine = { nodes: [] }
  assert.equal(read(halfBroken).ok, false)
})

test('取得時もキャッシュ読み込みと同じ正規化を通る（長さで切る）', () => {
  const body = fixture()
  // **`mine.nodes[0]` は review 側に寄って消えるので、残る PR を書き換える**
  const target = body.data.mine.nodes[1]
  assert.equal(target.url, 'https://github.com/acme/widgets/pull/88')
  target.title = 'あ'.repeat(300)
  target.repository.nameWithOwner = 'r'.repeat(300)
  target.author.login = 'a'.repeat(300)
  const result = read(body)
  const item = result.items.find((entry) => entry.url === 'https://github.com/acme/widgets/pull/88')
  assert.ok(item)
  assert.equal(item.title.length, 200, `title=${item.title.length}`)
  assert.equal(item.repo.length, 200, `repo=${item.repo.length}`)
  assert.equal(item.author.length, 200, `author=${item.author.length}`)
})

/* ------------------------------------------------------------------ *
 * Retry-After
 * ------------------------------------------------------------------ */

test('Retry-After は秒数・HTTP-date・壊れた値を撃ち分ける', () => {
  assert.equal(parseRetryAfter('120', NOW), 120_000)
  assert.equal(parseRetryAfter(' 30 ', NOW), 30_000)
  assert.equal(parseRetryAfter('Wed, 26 Aug 2026 09:02:00 GMT', NOW), 120_000)
  // 過去の日時は 0（すぐ次を試す）
  assert.equal(parseRetryAfter('Wed, 26 Aug 2026 08:00:00 GMT', NOW), 0)
  // 壊れた値は null（通常のバックオフに落とす。永遠に待つ状態を作らない）
  assert.equal(parseRetryAfter('garbage', NOW), null)
  assert.equal(parseRetryAfter('', NOW), null)
  assert.equal(parseRetryAfter(null, NOW), null)
})

/* ------------------------------------------------------------------ *
 * 失敗の分類
 * ------------------------------------------------------------------ */

const classify = (status, head, body = null) =>
  classifyFailure({ status, headers: headers(head), body, now: NOW })

test('401 は auth', () => {
  assert.equal(classify(401, {}, { message: 'Bad credentials' }).kind, 'auth')
})

test('403 + retry-after は rate-limit（403 を一律 auth にしない）', () => {
  const result = classify(403, { 'retry-after': '60' })
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, NOW + 60_000)
})

test('remaining: 0 の 403 は rate-limit。resetAt は x-ratelimit-reset', () => {
  const reset = Math.floor(NOW / 1000) + 600
  const result = classify(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, reset * 1000)
})

test('errors[].type === RATE_LIMITED の 200 は rate-limit', () => {
  const body = {
    errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
    data: { rateLimit: { resetAt: '2026-08-26T09:30:00Z' } }
  }
  const result = classify(200, {}, body)
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, Date.parse('2026-08-26T09:30:00Z'))
})

test('remaining が残っている secondary limit の 403 も rate-limit', () => {
  // #2（remaining: 0）に当たらないのが肝心。transient に落ちると
  // 制限中に手動 Retry が通ってしまう
  const result = classify(
    403,
    { 'x-ratelimit-remaining': '4231', 'retry-after': '45' },
    { message: 'You have exceeded a secondary rate limit' }
  )
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, NOW + 45_000)
})

test('HTTP 200・type なし・message に secondary rate limit（retry-after あり）も rate-limit', () => {
  const result = classify(
    200,
    { 'retry-after': '90' },
    { errors: [{ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }] }
  )
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, NOW + 90_000)
})

test('HTTP 200・type なし・message に secondary rate limit（retry-after なし）も rate-limit', () => {
  const result = classify(
    200,
    {},
    { errors: [{ message: 'was submitted too quickly — secondary rate limit' }] }
  )
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.resetAt, NOW + 60_000)
})

test('403 の権限不足は auth（永遠に再試行し続けない）', () => {
  const body = { errors: [{ message: 'Resource not accessible by personal access token' }] }
  assert.equal(classify(403, {}, body).kind, 'auth')
  const integration = { errors: [{ message: 'Resource not accessible by integration' }] }
  assert.equal(classify(403, {}, integration).kind, 'auth')
})

test('500 は transient', () => {
  assert.equal(classify(500, {}, null).kind, 'transient')
})

test('503 + Retry-After: 120 は transient のまま、待機だけ 120 秒になる', () => {
  const result = classify(503, { 'retry-after': '120' })
  assert.equal(result.kind, 'transient', 'Retry-After 単独で rate-limit と断定しない')
  assert.equal(result.resetAt, null)
  assert.equal(result.retryAfterMs, 120_000)
})

test('503 + Retry-After: HTTP-date はその時刻まで待つ', () => {
  const result = classify(503, { 'retry-after': 'Wed, 26 Aug 2026 09:05:00 GMT' })
  assert.equal(result.kind, 'transient')
  assert.equal(result.retryAfterMs, 300_000)
})

test('503 + Retry-After: garbage は通常のバックオフに落ちる', () => {
  const result = classify(503, { 'retry-after': 'not-a-date' })
  assert.equal(result.kind, 'transient')
  assert.equal(result.retryAfterMs, null)
})

/* ------------------------------------------------------------------ *
 * fetch の注入（環境変数を使わない）
 * ------------------------------------------------------------------ */

test('fetchPullRequests は注入した fetch を使う', async () => {
  let seen = null
  const result = await fetchPullRequests({
    token: 'ghp_dummy',
    endpoint: 'https://example.invalid/graphql',
    now: NOW,
    fetchImpl: (url, init) => {
      seen = { url, init }
      return Promise.resolve({
        status: 200,
        headers: headers({}),
        text: () => Promise.resolve(JSON.stringify(FIXTURE))
      })
    }
  })
  assert.equal(result.ok, true)
  assert.equal(seen.url, 'https://example.invalid/graphql')
  assert.equal(seen.init.headers.authorization, 'Bearer ghp_dummy')
  assert.match(seen.init.body, /reviewRequested/)
  assert.match(seen.init.body, /sort:updated-desc/)
})

test('fetch が投げたら transient（ネットワーク断）', async () => {
  const result = await fetchPullRequests({
    token: 'ghp_dummy',
    endpoint: 'https://example.invalid/graphql',
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED'))
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'transient')
})

test('JSON として読めない本文は transient', async () => {
  const result = await fetchPullRequests({
    token: 'ghp_dummy',
    endpoint: 'https://example.invalid/graphql',
    fetchImpl: () =>
      Promise.resolve({ status: 200, headers: headers({}), text: () => Promise.resolve('<html>') })
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'transient')
})

/* ------------------------------------------------------------------ *
 * キャッシュの正規化（手で編集できるファイルを読む側）
 * ------------------------------------------------------------------ */

test('PR の URL は github.com の pull だけを通す', () => {
  assert.equal(
    normalizePrUrl('https://github.com/acme/tools/pull/12'),
    'https://github.com/acme/tools/pull/12'
  )
  // クエリ・フラグメントは落として正準形にそろえる
  assert.equal(
    normalizePrUrl('https://github.com/acme/tools/pull/12?w=1#discussion'),
    'https://github.com/acme/tools/pull/12'
  )
  assert.equal(normalizePrUrl('https://evil.example/acme/tools/pull/12'), null)
  assert.equal(normalizePrUrl('https://github.com.evil.example/a/b/pull/1'), null)
  assert.equal(normalizePrUrl('http://github.com/acme/tools/pull/12'), null, 'http は通さない')
  assert.equal(normalizePrUrl('javascript:alert(1)'), null)
  assert.equal(normalizePrUrl('https://github.com/acme/tools/issues/12'), null)
  assert.equal(normalizePrUrl('https://github.com/acme/tools/pull/0'), null)
  assert.equal(normalizePrUrl(42), null)
})

test('壊れたキャッシュはどれも落ちる', () => {
  const cache = normalizeLiveFolderCache({
    credentialKey: 'ZZZZ',
    login: 12,
    updatedAt: 'yesterday',
    items: [
      // 巨大配列（1000件）
      ...Array.from({ length: 1000 }, (_unused, index) => ({
        url: `https://github.com/acme/bulk/pull/${index + 1}`,
        title: 'bulk',
        repo: 'acme/bulk',
        author: 'a',
        state: 'waiting',
        bucket: 'review',
        updatedAt: '2026-08-01T00:00:00Z'
      })),
      // 非 GitHub の URL
      {
        url: 'https://evil.example/a/b/pull/1',
        state: 'waiting',
        bucket: 'review',
        updatedAt: '2026-08-01T00:00:00Z'
      },
      // javascript: URL
      { url: 'javascript:alert(1)', state: 'waiting', bucket: 'review', updatedAt: '2026-08-01T00:00:00Z' },
      // 不正な state
      {
        url: 'https://github.com/acme/x/pull/1',
        state: 'merged',
        bucket: 'review',
        updatedAt: '2026-08-01T00:00:00Z'
      },
      // 壊れた日時
      { url: 'https://github.com/acme/x/pull/2', state: 'waiting', bucket: 'review', updatedAt: 'いつか' },
      // 不正な bucket
      {
        url: 'https://github.com/acme/x/pull/3',
        state: 'waiting',
        bucket: 'other',
        updatedAt: '2026-08-01T00:00:00Z'
      }
    ],
    truncation: { review: { returned: 100, total: 3 }, mine: { returned: 'x', total: 1 } }
  })
  assert.equal(cache.credentialKey, null)
  assert.equal(cache.login, null)
  assert.equal(cache.updatedAt, null)
  assert.equal(cache.items.length, MAX_LIVE_PRS, `200 件で切る（実測 ${cache.items.length}）`)
  assert.equal(
    cache.items.every((item) => item.url.startsWith('https://github.com/')),
    true
  )
  assert.equal(
    cache.items.some((item) => item.url.startsWith('javascript:')),
    false
  )
  // total <= returned の打ち切りは打ち切りではない
  assert.equal(cache.truncation.review, null)
  assert.equal(cache.truncation.mine, null)
})

test('正しいキャッシュはそのまま通る', () => {
  const cache = normalizeLiveFolderCache({
    credentialKey: '0123456789abcdef',
    login: 'octo-dev',
    updatedAt: NOW,
    items: [
      {
        url: 'https://github.com/acme/tools/pull/12',
        title: 'Cache the parsed manifest',
        repo: 'acme/tools',
        author: 'quill',
        state: 'approved',
        bucket: 'review',
        updatedAt: '2026-08-25T11:30:00Z'
      },
      // 同じ URL が2度出ても1行にする
      {
        url: 'https://github.com/acme/tools/pull/12',
        state: 'waiting',
        bucket: 'mine',
        updatedAt: '2026-08-25T11:30:00Z'
      }
    ],
    truncation: { review: { returned: 100, total: 137 }, mine: null }
  })
  assert.equal(cache.credentialKey, '0123456789abcdef')
  assert.equal(cache.login, 'octo-dev')
  assert.equal(cache.updatedAt, NOW)
  assert.equal(cache.items.length, 1)
  assert.deepEqual(cache.truncation.review, { returned: 100, total: 137 })
})
