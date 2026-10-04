/**
 * Electron のサポート状況の判定と、追従 issue の本文づくり（`scripts/electron-track.mjs` から使う）。
 * ネットワークに触らない純粋な関数だけを置き、`scripts/electron-support.test.mjs` から直接テストする。
 *
 * 方針（docs/compat.md「Electron の追従」）:
 * - 続ける条件: 今の major がサポート中（新しい方から 3 つ）であること
 * - 上げる先: 試して通る中で、いちばん新しい major
 * - 上げる時期: 今の major の EOL が近づいたら（8 週ごとと決め打ちせず、公開されている EOL 日で見る）
 */

/** EOL まで何日を切ったら「上げる時期」として知らせるか。kypr の実機確認に Mac が要るので余裕を持たせる */
export const WARN_DAYS = 45

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

/** 本文の末尾に埋める状態。前回と変わったときだけコメントで知らせる（本文の編集は通知が飛ばないため） */
const STATE_RE = /<!-- electron-track-state: (\S+) -->/

/**
 * endoflife.date の `/api/electron.json` を読む。形が崩れた行は落とす。
 * @returns {{ major: number, releaseDate: string, eol: string, latest: string }[]} major の昇順
 */
export function parseCycles(json) {
  if (!Array.isArray(json)) throw new Error('endoflife.date の応答が配列でない')
  const cycles = []
  for (const row of json) {
    if (!row || typeof row !== 'object') continue
    const major = Number(row.cycle)
    const { releaseDate, eol, latest } = row
    if (!Number.isInteger(major) || major <= 0) continue
    if (typeof releaseDate !== 'string' || !DATE_RE.test(releaseDate)) continue
    // eol は日付のほか false（未定）もありうる。未定はまだ切れないものとして遠い先にする
    const eolDate = eol === false ? '9999-12-31' : eol
    if (typeof eolDate !== 'string' || !DATE_RE.test(eolDate)) continue
    if (typeof latest !== 'string' || !VERSION_RE.test(latest)) continue
    if (Number(latest.split('.')[0]) !== major) continue
    cycles.push({ major, releaseDate, eol: eolDate, latest })
  }
  if (cycles.length === 0) throw new Error('endoflife.date の応答に読める行が無い')
  return cycles.sort((a, b) => a.major - b.major)
}

/** 日付（YYYY-MM-DD）どうしの日数差。b - a */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** 今日の時点でサポート中の major（リリース済みで EOL 前）。昇順 */
export function supportedCycles(cycles, today) {
  return cycles.filter((c) => c.releaseDate <= today && today < c.eol)
}

/** `package.json` の版（`41.10.6`。`^` などは付けない前提）から major を読む */
export function majorOf(version) {
  const match = /^(\d+)\.\d+\.\d+$/.exec(String(version))
  if (!match) throw new Error(`Electron の版が exact でない: ${version}`)
  return Number(match[1])
}

/**
 * 試す対象: 今より新しい、サポート中の major の最新版。
 * 今の major 自体は CI（ci.yml / verify.yml）が毎回見ているので試さない。
 */
export function trialTargets(cycles, currentVersion, today) {
  const current = majorOf(currentVersion)
  return supportedCycles(cycles, today)
    .filter((c) => c.major > current)
    .map((c) => ({ major: c.major, version: c.latest }))
}

const passed = (r) => r.smoke === 'success' && r.verify === 'success'

/**
 * 判定。
 * @param {{ currentVersion: string, cycles: ReturnType<typeof parseCycles>, results: { major: number, version: string, smoke: string, verify: string }[], today: string }} input
 */
export function assess({ currentVersion, cycles, results, today }) {
  const major = majorOf(currentVersion)
  const cycle = cycles.find((c) => c.major === major)
  const eol = cycle?.eol ?? null
  const daysLeft = eol ? daysBetween(today, eol) : null
  const best = results.filter(passed).sort((a, b) => b.major - a.major)[0] ?? null

  let state
  if (daysLeft === null) state = 'unknown'
  else if (daysLeft <= 0) state = 'eol'
  else if (daysLeft <= WARN_DAYS) state = 'eol-soon'
  else state = 'ok'

  // 上げる時期なのに通る major が無い = 回避策を作るか据え置くかを人が決める
  const blocked = (state === 'eol' || state === 'eol-soon') && !best
  return { major, eol, daysLeft, state, best, blocked }
}

/** 前回から知らせるべき変化があったか。状態と「通る中で最新の版」の組で見る */
export function stateKey(assessment) {
  const { major, state, best, blocked } = assessment
  return `${major}:${state}:${blocked ? 'blocked' : (best?.major ?? 'none')}`
}

export function previousStateKey(body) {
  return STATE_RE.exec(String(body ?? ''))?.[1] ?? null
}

const mark = (outcome) =>
  outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : outcome === 'skipped' ? '—' : '❔'

/** issue の本文 */
export function renderBody({ currentVersion, cycles, results, today, runUrl }) {
  const a = assess({ currentVersion, cycles, results, today })
  const supported = supportedCycles(cycles, today)
  const lines = []

  lines.push('Electron の追従の状況。週 1 回、workflow `Electron の追従` が書き換える（手で編集しない）。')
  lines.push('方針と手順は `docs/compat.md`「Electron の追従」。')
  lines.push('')
  lines.push('## いまの判定')
  lines.push('')
  const eolText = a.eol
    ? `${a.eol}（${a.daysLeft > 0 ? `あと ${a.daysLeft} 日` : `${-a.daysLeft} 日前に切れた`}）`
    : '不明'
  lines.push(`- 使っている版: **${currentVersion}**（EOL ${eolText}）`)
  lines.push(`- 通る中でいちばん新しい版: ${a.best ? `**${a.best.version}**` : 'なし'}`)
  lines.push(`- 判定: ${summaryLine(a)}`)
  lines.push('')
  lines.push('## 試した結果')
  lines.push('')
  if (results.length === 0) {
    lines.push('今より新しいサポート中の major が無いので、試していない。')
  } else {
    lines.push('| major | 版 | 拡張 smoke | 自走検証 |')
    lines.push('|---|---|---|---|')
    for (const r of [...results].sort((x, y) => y.major - x.major)) {
      lines.push(`| ${r.major} | ${r.version} | ${mark(r.smoke)} | ${mark(r.verify)} |`)
    }
  }
  lines.push('')
  lines.push('## サポート中の major')
  lines.push('')
  lines.push('| major | リリース | EOL | 最新 |')
  lines.push('|---|---|---|---|')
  for (const c of [...supported].reverse()) {
    lines.push(`| ${c.major} | ${c.releaseDate} | ${c.eol} | ${c.latest} |`)
  }
  lines.push('')
  lines.push(`更新: ${today}${runUrl ? ` / [実行ログ](${runUrl})` : ''}`)
  lines.push('')
  lines.push(`<!-- electron-track-state: ${stateKey(a)} -->`)
  return { body: lines.join('\n'), assessment: a }
}

function summaryLine(a) {
  if (a.state === 'unknown') return '今の major の EOL が分からない（endoflife.date に載っていない）'
  if (a.blocked) {
    return '**上げる時期だが、通る major が無い**。回避策を作るか、承知のうえで据え置くかを決める'
  }
  if (a.state === 'eol') return `**サポートが切れている**。${a.best.version} に上げる`
  if (a.state === 'eol-soon')
    return `**上げる時期**（EOL まで ${WARN_DAYS} 日を切った）。${a.best.version} に上げる`
  return 'このままでよい'
}

/** 前回から状態が変わったときに付けるコメント。知らせることが無ければ null */
export function notifyComment(assessment, previousKey) {
  if (stateKey(assessment) === previousKey) return null
  if (assessment.state === 'ok' || assessment.state === 'unknown') return null
  return summaryLine(assessment)
}
