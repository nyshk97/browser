import { Worker } from 'node:worker_threads'
import {
  HTTP_AUTH_LIMITS,
  HTTP_AUTH_PATTERN_TIMEOUT_MS,
  rankRules
} from '../shared/http-auth-rules.js'
import { WORKER_SOURCE } from '../shared/http-auth-worker-source.js'
import { log, logError } from './log.js'
import type { HttpAuthRule } from '../shared/types.js'

/**
 * ユーザーが書いた正規表現を**main スレッドの外**で走らせるための仲介層。
 *
 * 拡張と違って Nemo の main は別プロセスに隔離されていないので、
 * catastrophic backtracking を踏むと Settings ではなく**ブラウザ全体が固まる**。
 * `validateHttpAuthPattern` は第一の関門だが保証ではない
 * （`[a-z]+[a-z]+[a-z]+…` のような連続する量化子は構文検査を通る）。
 *
 * 設計の要点:
 * - **ジョブはルール 1 件単位**。`matchRules` 全体を 1 ジョブにすると、応答しないワーカーから
 *   「どのルールが原因か」を取り出せず、「そのルールだけ無効化」が実装できない
 * - **`runtime` と `tester` を区別する**。自動無効化は `runtime` のタイムアウトだけに適用する。
 *   区別しないと、未保存の下書きを試しただけで有効な保存済みルールが無効化される
 * - **request ID を持つ仲介層を 1 つ置く**。ワーカーの `error` / `exit` / タイムアウトの
 *   いずれでも pending をすべて明示的に解決する。放置すると別タブの認証や
 *   Settings のテスターの Promise が永久に残る
 * - タイムアウトしたら**ワーカーを terminate して作り直す**（次の照合を巻き添えにしない）
 */

export type MatchOutcome = 'match' | 'no-match' | 'timeout' | 'error'
export type MatchKind = 'runtime' | 'tester'

interface PendingJob {
  resolve: (outcome: MatchOutcome) => void
  timer: NodeJS.Timeout
}

let worker: Worker | null = null
let nextJobId = 1
const pending = new Map<number, PendingJob>()

/**
 * pending をすべて明示的に解決する（**ここを通らない終わり方を作らない**）。
 *
 * **`timeout` を返してよいのは、実際に時間切れになったジョブだけ**。
 * ワーカーは 1 本なので、1 件がタイムアウトすると同時に走っている別の照合
 * （並列 401 の別リクエストや Settings のテスター）の pending も道連れになる。
 * それらまで `timeout` で返すと、`resolveCredential` が
 * **敵対的パターンと無関係な正常ルールを `pattern-timeout` で無効化する**。
 * 巻き添えは `error`（＝不一致。無効化しない）で返す。
 */
function settleAll(outcome: MatchOutcome, timedOutId: number | null = null): void {
  const jobs = [...pending.entries()]
  pending.clear()
  for (const [id, job] of jobs) {
    clearTimeout(job.timer)
    job.resolve(id === timedOutId ? outcome : outcome === 'timeout' ? 'error' : outcome)
  }
}

function disposeWorker(outcome: MatchOutcome, timedOutId: number | null = null): void {
  const current = worker
  worker = null
  settleAll(outcome, timedOutId)
  if (current) void current.terminate()
}

function ensureWorker(): Worker | null {
  if (worker) return worker
  try {
    const created = new Worker(WORKER_SOURCE, { eval: true })
    created.on('message', (reply: { id: number; matched: boolean; error: string | null }) => {
      const job = pending.get(reply.id)
      if (!job) return
      pending.delete(reply.id)
      clearTimeout(job.timer)
      // 壊れた正規表現は「不一致」に倒す（他のルールは生かす）
      job.resolve(reply.error ? 'no-match' : reply.matched ? 'match' : 'no-match')
    })
    created.on('error', (error) => {
      logError('http_auth.worker_error', error, {})
      disposeWorker('error')
    })
    created.on('exit', () => {
      if (worker === created) disposeWorker('error')
    })
    created.unref()
    worker = created
    return created
  } catch (error) {
    logError('http_auth.worker_spawn_failed', error, {})
    return null
  }
}

/** ワーカーで 1 件だけ照合する。 */
function testPattern(pattern: string, url: string): Promise<MatchOutcome> {
  const current = ensureWorker()
  // ワーカーを作れなければ**自動入力しない**（main では絶対に走らせない）
  if (!current) return Promise.resolve('error')
  const id = nextJobId++
  return new Promise<MatchOutcome>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      log('http_auth.pattern_timeout', {})
      // 応答しないワーカーは作り直す。**pending は全部解決してから**捨てる
      // （`timeout` を受け取るのはこのジョブだけ。他は巻き添えなので `error`）
      disposeWorker('timeout', id)
    }, HTTP_AUTH_PATTERN_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    current.postMessage({ id, pattern, url })
  })
}

export interface MatchResult {
  /** 勝ったルール（`runtime` は最初に一致したもの）。 */
  winner: HttpAuthRule | null
  /** マッチしたルール ID（勝ち順）。 */
  matchedIds: string[]
  /** 照合がタイムアウトしたルール ID。 */
  timedOutIds: string[]
}

/**
 * ルール群を URL に当てる。
 *
 * 順序は `rankRules`（パターン長の降順 → 登録順）で**照合前に確定している**ので、
 * `runtime` は最初に一致した時点で打ち切れる（全件にタイムアウト時間を払わない）。
 * `tester` は「この URL には複数マッチする」を出すため全件を見る。
 */
export async function matchHttpAuthRules(
  rules: HttpAuthRule[],
  url: string,
  kind: MatchKind
): Promise<MatchResult> {
  const result: MatchResult = { winner: null, matchedIds: [], timedOutIds: [] }
  if (url.length > HTTP_AUTH_LIMITS.MAX_URL) return result
  for (const rule of rankRules(rules)) {
    const outcome = await testPattern(rule.pattern, url)
    if (outcome === 'timeout') {
      result.timedOutIds.push(rule.id)
      continue
    }
    if (outcome !== 'match') continue
    result.matchedIds.push(rule.id)
    if (result.winner === null) result.winner = rule
    if (kind === 'runtime') break
  }
  return result
}

/** アプリ終了時に必ず呼ぶ（ワーカーを残さない）。 */
export function stopHttpAuthMatcher(): void {
  disposeWorker('error')
}
