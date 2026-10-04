import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WARN_DAYS,
  assess,
  daysBetween,
  notifyComment,
  parseCycles,
  previousStateKey,
  renderBody,
  stateKey,
  supportedCycles,
  trialTargets
} from './lib/electron-support.mjs'

// endoflife.date の /api/electron.json の形（2026-10 時点の公開スケジュール）
const RAW = [
  { cycle: '44', releaseDate: '2026-08-25', eol: '2027-03-02', latest: '44.1.2', lts: false },
  { cycle: '43', releaseDate: '2026-06-30', eol: '2027-01-05', latest: '43.3.0', lts: false },
  { cycle: '42', releaseDate: '2026-05-05', eol: '2026-10-20', latest: '42.4.1', lts: false },
  { cycle: '41', releaseDate: '2026-03-10', eol: '2026-08-25', latest: '41.10.6', lts: false }
]
const cycles = parseCycles(RAW)

test('endoflife.date の行を major の昇順で読む', () => {
  assert.deepEqual(
    cycles.map((c) => c.major),
    [41, 42, 43, 44]
  )
  assert.deepEqual(cycles[0], { major: 41, releaseDate: '2026-03-10', eol: '2026-08-25', latest: '41.10.6' })
})

test('形が崩れた行は落とす / eol が false（未定）はまだ切れない扱い', () => {
  const parsed = parseCycles([
    ...RAW,
    { cycle: 'x', releaseDate: '2026-01-01', eol: '2026-02-01', latest: '1.0.0' },
    { cycle: '45', releaseDate: '2026-10-20', eol: false, latest: '45.0.0' },
    // latest の major が cycle と食い違う行は信用しない
    { cycle: '46', releaseDate: '2027-01-05', eol: '2027-06-01', latest: '45.0.0' },
    null
  ])
  assert.deepEqual(
    parsed.map((c) => c.major),
    [41, 42, 43, 44, 45]
  )
  assert.equal(parsed.at(-1).eol, '9999-12-31')
  assert.throws(() => parseCycles({}))
  assert.throws(() => parseCycles([]))
})

test('サポート中はリリース済みで EOL 前のものだけ（EOL 当日は切れている）', () => {
  assert.deepEqual(
    supportedCycles(cycles, '2026-10-04').map((c) => c.major),
    [42, 43, 44]
  )
  assert.deepEqual(
    supportedCycles(cycles, '2026-10-20').map((c) => c.major),
    [43, 44]
  )
  assert.equal(daysBetween('2026-10-04', '2026-10-20'), 16)
})

test('試すのは今より新しいサポート中の major の最新版', () => {
  assert.deepEqual(trialTargets(cycles, '41.10.6', '2026-10-04'), [
    { major: 42, version: '42.4.1' },
    { major: 43, version: '43.3.0' },
    { major: 44, version: '44.1.2' }
  ])
  assert.deepEqual(trialTargets(cycles, '44.0.0', '2026-10-04'), [])
  // ^ 付きは pin の前提が崩れているので止める
  assert.throws(() => trialTargets(cycles, '^41.10.6', '2026-10-04'))
})

const ok = (major, version) => ({ major, version, smoke: 'success', verify: 'success' })
const ng = (major, version) => ({ major, version, smoke: 'success', verify: 'failure' })

test('上げる先は通る中でいちばん新しい major', () => {
  const a = assess({
    currentVersion: '41.10.6',
    cycles,
    results: [ok(42, '42.4.1'), ok(43, '43.3.0'), ng(44, '44.1.2')],
    today: '2026-10-04'
  })
  assert.equal(a.state, 'eol')
  assert.equal(a.best.version, '43.3.0')
  assert.equal(a.blocked, false)
})

test('EOL の判定: 余裕あり / 間近 / 切れた / 通るものが無い', () => {
  const base = { cycles, results: [ok(44, '44.1.2')] }
  // 43 の EOL は 2027-01-05
  assert.equal(assess({ ...base, currentVersion: '43.3.0', today: '2026-10-04' }).state, 'ok')
  const soon = assess({ ...base, currentVersion: '43.3.0', today: '2026-12-01' })
  assert.equal(soon.state, 'eol-soon')
  assert.ok(soon.daysLeft <= WARN_DAYS)
  assert.equal(assess({ ...base, currentVersion: '41.10.6', today: '2026-10-04' }).state, 'eol')
  const blocked = assess({
    cycles,
    results: [ng(44, '44.1.2')],
    currentVersion: '41.10.6',
    today: '2026-10-04'
  })
  assert.equal(blocked.blocked, true)
  // 余裕があるうちは通るものが無くても止めない
  assert.equal(
    assess({ cycles, results: [ng(44, '44.1.2')], currentVersion: '43.3.0', today: '2026-10-04' }).blocked,
    false
  )
})

test('知らせるのは状態が変わったときだけ（毎週同じコメントを付けない）', () => {
  const input = { currentVersion: '41.10.6', cycles, results: [ok(43, '43.3.0')], today: '2026-10-04' }
  const { body, assessment } = renderBody(input)
  const key = previousStateKey(body)
  assert.equal(key, stateKey(assessment))
  // 初回は知らせる
  assert.match(notifyComment(assessment, null), /43\.3\.0 に上げる/)
  // 同じ状態なら知らせない
  assert.equal(notifyComment(assessment, key), null)
  // 通る版が変わったら知らせ直す
  const next = assess({ ...input, results: [ok(43, '43.3.0'), ok(44, '44.1.2')] })
  assert.match(notifyComment(next, key), /44\.1\.2/)
  // 余裕があるときは知らせない
  assert.equal(notifyComment(assess({ ...input, currentVersion: '44.1.2' }), null), null)
})

test('本文に判定・結果の表・サポート中の一覧が出る', () => {
  const { body } = renderBody({
    currentVersion: '41.10.6',
    cycles,
    results: [ok(43, '43.3.0'), ng(44, '44.1.2')],
    today: '2026-10-04',
    runUrl: 'https://github.com/o/r/actions/runs/1'
  })
  assert.match(body, /使っている版: \*\*41\.10\.6\*\*（EOL 2026-08-25（40 日前に切れた））/)
  assert.match(body, /\| 44 \| 44\.1\.2 \| ✅ \| ❌ \|/)
  assert.match(body, /\| 42 \| 2026-05-05 \| 2026-10-20 \| 42\.4\.1 \|/)
  assert.doesNotMatch(body, /\| 41 \| 2026-03-10/)
  assert.match(body, /\[実行ログ\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/)
})
