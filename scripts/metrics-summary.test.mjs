import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeMetrics, TOP_LIMIT } from '../src/shared/metrics-summary.js'
import { sanitizeDetail } from '../src/shared/log-redact.js'

const metric = (pid, type, cpu, kb) => ({
  pid,
  type,
  cpu: { percentCPUUsage: cpu },
  memory: { workingSetSize: kb }
})
const counts = { uptimeMs: 1000, windows: 1, tabs: 3, asleep: 1 }

test('種別ごとの合計と全体の合計', () => {
  const s = summarizeMetrics(
    [
      metric(1, 'Browser', 0.4, 200 * 1024),
      metric(2, 'Tab', 1.25, 400 * 1024),
      metric(3, 'GPU', 0.1, 100 * 1024)
    ],
    new Map(),
    counts
  )
  assert.deepEqual(s.total, { cpu: 1.8, memMb: 700, processes: 3 })
  assert.deepEqual(s.byType.Tab, { cpu: 1.3, memMb: 400, n: 1 })
  assert.equal(s.tabs, 3)
  assert.equal(s.asleep, 1)
})

test('同居しているタブは 1 つの pid に全部並ぶ（origin は重複除去）', () => {
  const s = summarizeMetrics(
    [metric(10, 'Tab', 1, 1024)],
    new Map([
      [
        10,
        [
          { key: 'a', origin: 'https://github.com', private: false },
          { key: 'b', origin: 'https://github.com', private: false }
        ]
      ]
    ]),
    counts
  )
  assert.equal(s.top.length, 1)
  assert.deepEqual(s.top[0].keys, ['a', 'b'])
  assert.deepEqual(s.top[0].origins, ['https://github.com'])
  assert.equal(s.top[0].private, 0)
})

test('シークレットのタブは keys には入るが origins には入らない', () => {
  const s = summarizeMetrics(
    [metric(10, 'Tab', 1, 1024)],
    new Map([
      [
        10,
        [
          { key: 'p', origin: 'https://secret.example', private: true },
          { key: 'n', origin: 'https://public.example', private: false }
        ]
      ]
    ]),
    counts
  )
  assert.deepEqual(s.top[0].keys, ['p', 'n'])
  assert.deepEqual(s.top[0].origins, ['https://public.example'])
  assert.equal(s.top[0].private, 1)
  assert.ok(!JSON.stringify(s).includes('secret.example'))
})

test('top はタブを持つ renderer を優先し、その中でメモリ降順、上限は TOP_LIMIT', () => {
  const metrics = []
  for (let i = 0; i < 6; i += 1) metrics.push(metric(100 + i, 'Tab', 0, (900 - i) * 1024)) // UI の renderer（重い）
  metrics.push(metric(1, 'Tab', 0, 50 * 1024))
  metrics.push(metric(2, 'Tab', 0, 80 * 1024))
  const s = summarizeMetrics(
    metrics,
    new Map([
      [1, [{ key: 'light', origin: 'https://a', private: false }]],
      [2, [{ key: 'heavy', origin: 'https://b', private: false }]]
    ]),
    counts
  )
  assert.equal(s.top.length, TOP_LIMIT)
  assert.deepEqual(
    s.top.slice(0, 2).map((e) => e.keys[0]),
    ['heavy', 'light']
  )
  assert.ok(s.top.slice(2).every((e) => e.keys.length === 0))
})

test('整形結果は sanitizeDetail を素通りする（[deep] / [redacted] / 切り詰めが出ない）', () => {
  const s = summarizeMetrics(
    [metric(1, 'Browser', 0.5, 1024), metric(2, 'Tab', 1, 2048), metric(3, 'Tab', 1, 4096)],
    new Map([
      [2, [{ key: 'k1', origin: 'https://github.com', private: false }]],
      [3, [{ key: 'k2', origin: 'https://example.com', private: true }]]
    ]),
    counts
  )
  const before = JSON.stringify(s)
  const after = JSON.stringify(sanitizeDetail({ ...s }))
  assert.equal(after, before)
  assert.ok(!after.includes('[deep]'))
  assert.ok(!after.includes('[redacted]'))
  assert.ok(!after.includes('…'))
})
