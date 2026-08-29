// @ts-check
/**
 * 診断ログの `metrics.sample`（と `app.quit` の `source: "quit"` 行）を日別 × チャンネル別に集計する。
 * CLI は `scripts/metrics-report.mjs`。ここは純粋関数だけ（`scripts/metrics-report.test.mjs` が見る）。
 */

/**
 * @typedef {{ t: string, event: string, source?: string, total?: { cpu: number, memMb: number }, tabs?: number, asleep?: number }} LogLine
 * @typedef {{ channel: string, session: string, lines: LogLine[] }} SessionInput
 * @typedef {{
 *   date: string, channel: string, samples: number, quits: number,
 *   memMedianMb: number, memP95Mb: number, cpuMean: number, tabsMedian: number, asleepMedian: number
 * }} DayRow
 */

/** @param {number[]} values 昇順でなくてよい */
export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * nearest-rank の p95（n 件なら ceil(0.95 n) 番目）。
 * @param {number[]} values
 */
export function p95(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length))
  return sorted[rank - 1]
}

/** @param {number[]} values */
const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)

/** @param {number} v */
const round1 = (v) => Math.round(v * 10) / 10

/**
 * サンプル行か（`metrics.sample`、または `source: "quit"` を持つ `app.quit`）。
 * @param {LogLine} line
 */
export function isSampleLine(line) {
  if (!line || typeof line !== 'object' || !line.total) return false
  return line.event === 'metrics.sample' || (line.event === 'app.quit' && line.source === 'quit')
}

/**
 * ISO 時刻をローカルの日付（YYYY-MM-DD）へ。
 * @param {string} iso
 */
export function localDate(iso) {
  const d = new Date(iso)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * @param {SessionInput[]} sessions
 * @returns {{
 *   summary: { from: string | null, to: string | null, files: number, sessions: number, samples: number, quits: number },
 *   days: DayRow[],
 *   sessionsDetail: { channel: string, session: string, samples: number, quits: number, memMedianMb: number, cpuMean: number, tabsMedian: number }[]
 * }}
 */
export function aggregate(sessions) {
  /** @type {Map<string, { date: string, channel: string, samples: LogLine[], quits: number }>} */
  const byDay = new Map()
  const sessionsDetail = []
  let total = 0
  let quits = 0
  /** @type {string | null} */
  let from = null
  /** @type {string | null} */
  let to = null

  for (const { channel, session, lines } of sessions) {
    const samples = lines.filter(isSampleLine)
    if (samples.length === 0) continue
    let sessionQuits = 0
    for (const line of samples) {
      total += 1
      if (line.event === 'app.quit') {
        quits += 1
        sessionQuits += 1
      }
      if (from === null || line.t < from) from = line.t
      if (to === null || line.t > to) to = line.t
      const date = localDate(line.t)
      const key = `${date}\t${channel}`
      const bucket = byDay.get(key) ?? { date, channel, samples: [], quits: 0 }
      bucket.samples.push(line)
      if (line.event === 'app.quit') bucket.quits += 1
      byDay.set(key, bucket)
    }
    sessionsDetail.push({
      channel,
      session,
      samples: samples.length,
      quits: sessionQuits,
      memMedianMb: median(samples.map((s) => s.total?.memMb ?? 0)),
      cpuMean: round1(mean(samples.map((s) => s.total?.cpu ?? 0))),
      tabsMedian: median(samples.map((s) => s.tabs ?? 0))
    })
  }

  const days = [...byDay.values()]
    .sort((a, b) => (a.date === b.date ? a.channel.localeCompare(b.channel) : a.date.localeCompare(b.date)))
    .map((b) => ({
      date: b.date,
      channel: b.channel,
      samples: b.samples.length,
      quits: b.quits,
      memMedianMb: median(b.samples.map((s) => s.total?.memMb ?? 0)),
      memP95Mb: p95(b.samples.map((s) => s.total?.memMb ?? 0)),
      cpuMean: round1(mean(b.samples.map((s) => s.total?.cpu ?? 0))),
      tabsMedian: median(b.samples.map((s) => s.tabs ?? 0)),
      asleepMedian: median(b.samples.map((s) => s.asleep ?? 0))
    }))

  return {
    // `files` は読んだログの総数、`sessions` はそのうちサンプルを 1 件でも含むもの（5 分未満で終わった起動は後者に入らない）
    summary: { from, to, files: sessions.length, sessions: sessionsDetail.length, samples: total, quits },
    days,
    sessionsDetail
  }
}

/**
 * ログファイル 1 つの中身を行配列にする（壊れた行は捨てる）。
 * @param {string} text
 * @returns {LogLine[]}
 */
export function parseLogText(text) {
  /** @type {LogLine[]} */
  const lines = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      /* 途中で切れた行など */
    }
  }
  return lines
}

/**
 * ファイル名 `<channel>-<stamp>-<pid>.log` からチャンネルを取る。
 * @param {string} name
 */
export function channelOfLogFile(name) {
  const m = /^([a-z]+)-\d{4}-\d{2}-\d{2}T.*\.log$/.exec(name)
  return m ? m[1] : null
}

/**
 * 表を文字列にする。
 * @param {ReturnType<typeof aggregate>} result
 */
export function renderTable(result) {
  const { summary, days } = result
  const out = []
  out.push(
    `期間: ${summary.from ?? '-'} 〜 ${summary.to ?? '-'} / ログ ${summary.files} 本（サンプルあり ${summary.sessions}） / サンプル ${summary.samples}（うち終了時 ${summary.quits}）`
  )
  out.push(
    '（memMb は workingSetSize の合計。アクティビティモニタの数字とは一致しない。同じ指標の時系列比較にだけ使う）'
  )
  out.push('')
  const header = ['日付', 'ch', '件数', 'mem中央値', 'mem p95', 'cpu平均', 'タブ中央値', '休眠中央値']
  const rows = days.map((d) => [
    d.date,
    d.channel,
    String(d.samples),
    `${d.memMedianMb} MB`,
    `${d.memP95Mb} MB`,
    `${d.cpuMean} %`,
    String(d.tabsMedian),
    String(d.asleepMedian)
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (/** @type {string[]} */ cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  out.push(line(header))
  out.push(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) out.push(line(r))
  if (rows.length === 0) out.push('（サンプルなし）')
  return out.join('\n')
}
