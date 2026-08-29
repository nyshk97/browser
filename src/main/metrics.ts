import { app } from 'electron'
import { summarizeMetrics, type MetricsSample } from '../shared/metrics-summary.js'
import { log } from './log.js'
import { collectTabsByOsPid, countTabs } from './registry.js'

/**
 * メモリ・CPU の定期記録。
 *
 * 「Arc / Chrome と比べて Nemo はどうか」を後から見返すための材料で、
 * **Nemo 自身が持っている値**（`app.getAppMetrics()`）を 5 分おきに `metrics.sample` として
 * 診断ログへ流す。他ブラウザとの横並びは OS 側のサンプラーの仕事で、ここではやらない。
 *
 * 形と指標の意味は `src/shared/metrics-summary.js` を見る。
 */

/** 既定の間隔。設定項目にはしない。 */
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let primed = false

/**
 * `percentCPUUsage` は**前回の `getAppMetrics()` 呼び出しからの平均**で、初回は 0 が返る。
 * タイマーを張る時点で一度空撃ちしておき、最初のサンプルから意味のある値にする。
 */
function prime(): void {
  if (primed) return
  app.getAppMetrics()
  primed = true
}

/** 今の値を 1 行ぶんに整形する（ログには書かない）。 */
export function sampleMetrics(): MetricsSample {
  prime()
  const counts = countTabs()
  return summarizeMetrics(app.getAppMetrics(), collectTabsByOsPid(), {
    uptimeMs: Math.round(process.uptime() * 1000),
    ...counts
  })
}

function resolveInterval(): number {
  const raw = process.env['NEMO_METRICS_INTERVAL_MS']
  if (!raw) return SAMPLE_INTERVAL_MS
  // **ゲートは `!app.isPackaged`**（他の差し替え口と同じ）。常用版で間隔を触れる口は残さない
  if (app.isPackaged) {
    console.error('[nemo] パッケージ版では NEMO_METRICS_INTERVAL_MS を無視した')
    return SAMPLE_INTERVAL_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[nemo] NEMO_METRICS_INTERVAL_MS が不正（${raw}）。既定の間隔にする`)
    return SAMPLE_INTERVAL_MS
  }
  return parsed
}

export function startMetricsSampling(): void {
  if (timer) return
  prime()
  const intervalMs = resolveInterval()
  if (intervalMs !== SAMPLE_INTERVAL_MS) log('metrics.interval_override', { intervalMs })
  timer = setInterval(() => {
    log('metrics.sample', { ...sampleMetrics() })
  }, intervalMs)
  timer.unref?.()
}

export function stopMetricsSampling(): void {
  if (timer) clearInterval(timer)
  timer = null
}
