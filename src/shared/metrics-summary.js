// @ts-check
/**
 * `app.getAppMetrics()` の生の配列を、診断ログに載せる 1 行（`metrics.sample`）へ整形する。
 *
 * main から切り離した純粋関数。**整形結果が `sanitizeDetail` を素通りできる形**であることを
 * `scripts/metrics-summary.test.mjs` が固定している（`MAX_DEPTH = 4` を超える入れ子は `"[deep]"` に潰れ、
 * URL に見える文字列はホストまでに落ちる。ここで作る形はどちらにも当たらない）。
 *
 * - `memMb` は `workingSetSize`（KB。resident）を MB に丸めたもの。アクティビティモニタの
 *   「メモリ」列（圧縮分を含む phys_footprint）とは常時ズレる。**同じ指標の時系列比較にだけ使う**
 * - `cpu` は `percentCPUUsage`（前回呼び出しからの平均。1 コア = 100）
 * - `top` は renderer **プロセス**をメモリ降順で上位 `TOP_LIMIT` 件。1 要素 = 1 pid で、
 *   同居しているタブを `keys` / `origins` に全部並べる（同一サイトのタブは 1 renderer にまとまる）。
 *   `keys` が非空のものを優先して枠を埋め、余りを UI の renderer（`keys: []`）で埋める
 * - シークレットのタブは `keys` には入れるが `origins` には入れず、`private` の件数に足す
 */

/** `top` に載せる renderer の数。 */
export const TOP_LIMIT = 5

/**
 * @typedef {{ key: string, origin: string, private: boolean }} TabRef
 * @typedef {{ pid: number, type: string, cpu?: { percentCPUUsage?: number }, memory?: { workingSetSize?: number } }} RawMetric
 * @typedef {{ cpu: number, memMb: number, n: number }} TypeSummary
 * @typedef {{ pid: number, cpu: number, memMb: number, keys: string[], origins: string[], private: number }} TopEntry
 * @typedef {{
 *   uptimeMs: number, windows: number, tabs: number, asleep: number,
 *   total: { cpu: number, memMb: number, processes: number },
 *   byType: Record<string, TypeSummary>,
 *   top: TopEntry[]
 * }} MetricsSample
 */

/** @param {number} value */
const round1 = (value) => Math.round(value * 10) / 10

/** @param {number | undefined} kb */
const toMb = (kb) => Math.round((kb ?? 0) / 1024)

/**
 * @param {RawMetric[]} metrics
 * @param {Map<number, TabRef[]>} tabsByPid renderer の pid → そこに同居しているタブ
 * @param {{ uptimeMs: number, windows: number, tabs: number, asleep: number }} counts
 * @returns {MetricsSample}
 */
export function summarizeMetrics(metrics, tabsByPid, counts) {
  const total = { cpu: 0, memMb: 0, processes: 0 }
  /** @type {Record<string, TypeSummary>} */
  const byType = {}
  /** @type {TopEntry[]} */
  const renderers = []

  for (const metric of metrics) {
    const cpu = metric.cpu?.percentCPUUsage ?? 0
    const memMb = toMb(metric.memory?.workingSetSize)
    total.cpu += cpu
    total.memMb += memMb
    total.processes += 1
    const bucket = (byType[metric.type] ??= { cpu: 0, memMb: 0, n: 0 })
    bucket.cpu += cpu
    bucket.memMb += memMb
    bucket.n += 1

    if (metric.type !== 'Tab') continue
    const refs = tabsByPid.get(metric.pid) ?? []
    /** @type {Set<string>} */
    const origins = new Set()
    let privateCount = 0
    for (const ref of refs) {
      if (ref.private) privateCount += 1
      else origins.add(ref.origin)
    }
    renderers.push({
      pid: metric.pid,
      cpu: round1(cpu),
      memMb,
      keys: refs.map((ref) => ref.key),
      origins: [...origins],
      private: privateCount
    })
  }

  // タブを持つ renderer を先に、その中でメモリ降順
  renderers.sort((a, b) => {
    const aHas = a.keys.length > 0 ? 1 : 0
    const bHas = b.keys.length > 0 ? 1 : 0
    if (aHas !== bHas) return bHas - aHas
    return b.memMb - a.memMb
  })

  total.cpu = round1(total.cpu)
  for (const bucket of Object.values(byType)) bucket.cpu = round1(bucket.cpu)

  return {
    uptimeMs: counts.uptimeMs,
    windows: counts.windows,
    tabs: counts.tabs,
    asleep: counts.asleep,
    total,
    byType,
    top: renderers.slice(0, TOP_LIMIT)
  }
}
