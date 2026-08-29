import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregate,
  channelOfLogFile,
  isSampleLine,
  median,
  p95,
  parseLogText
} from './lib/metrics-aggregate.mjs'

test('median / p95（nearest-rank）の境界', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), 0)
  assert.equal(p95([1]), 1)
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19) // ceil(0.95*20)=19 番目
  assert.equal(p95(Array.from({ length: 21 }, (_, i) => i + 1)), 20) // ceil(19.95)=20 番目
  assert.equal(p95([]), 0)
})

test('サンプル行の判定: metrics.sample と source=quit の app.quit だけ', () => {
  assert.ok(isSampleLine({ t: 'x', event: 'metrics.sample', total: { cpu: 0, memMb: 1 } }))
  assert.ok(isSampleLine({ t: 'x', event: 'app.quit', source: 'quit', total: { cpu: 0, memMb: 1 } }))
  assert.ok(!isSampleLine({ t: 'x', event: 'app.quit' }))
  assert.ok(!isSampleLine({ t: 'x', event: 'tab.create', total: { cpu: 0, memMb: 1 } }))
})

test('日別 × チャンネル別の集計と先頭の内訳', () => {
  const day = (h, memMb, cpu, tabs, extra = {}) => ({
    t: `2026-08-29T${String(h).padStart(2, '0')}:00:00.000+09:00`,
    event: 'metrics.sample',
    total: { cpu, memMb },
    tabs,
    asleep: 1,
    ...extra
  })
  const sessions = [
    {
      channel: 'stable',
      session: 's1',
      lines: [
        { t: '2026-08-29T09:00:00.000+09:00', event: 'app.ready' },
        day(10, 1000, 2, 10),
        day(11, 3000, 4, 12),
        day(12, 2000, 3, 11),
        { ...day(13, 5000, 1, 9), event: 'app.quit', source: 'quit' }
      ]
    },
    { channel: 'dev', session: 'd1', lines: [day(10, 500, 1, 3)] },
    { channel: 'dev', session: 'd0', lines: [{ t: 'x', event: 'log.opened' }] } // サンプル無し → 数えない
  ]
  const r = aggregate(sessions)
  assert.equal(r.summary.files, 3)
  assert.equal(r.summary.sessions, 2)
  assert.equal(r.summary.samples, 5)
  assert.equal(r.summary.quits, 1)
  assert.ok(r.summary.from.startsWith('2026-08-29T10'))
  assert.equal(r.days.length, 2)
  const stable = r.days.find((d) => d.channel === 'stable')
  assert.equal(stable.samples, 4)
  assert.equal(stable.quits, 1)
  assert.equal(stable.memMedianMb, 2500)
  assert.equal(stable.memP95Mb, 5000)
  assert.equal(stable.cpuMean, 2.5)
  assert.equal(stable.tabsMedian, 10.5)
  assert.equal(r.sessionsDetail.find((s) => s.session === 's1').memMedianMb, 2500)
})

test('壊れた行は捨てる / ファイル名からチャンネル', () => {
  assert.equal(parseLogText('{"a":1}\n{broken\n\n{"b":2}').length, 2)
  assert.equal(channelOfLogFile('stable-2026-08-28T00-39-41-652Z-40499.log'), 'stable')
  assert.equal(channelOfLogFile('dev-2026-08-29T06-45-59-825Z-22317.log'), 'dev')
  assert.equal(channelOfLogFile('notes.txt'), null)
})
