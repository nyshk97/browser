import { app } from 'electron'
import { DEFAULT_TIMINGS, resolveTimings, type Timings } from '../shared/timings.js'
import { log } from './log.js'

/**
 * 自走検証だけが縮められる「見に行く周期 / デバウンス」の実効値。
 *
 * **解決はプロセス起動時に1回**。`startBackgroundWork()` は `setInterval` を1回張るだけで、
 * 実行中に変えられるものではないので、参照のたびに再解決する作りにはしない。
 *
 * ゲートは **`!app.isPackaged`**（`ipc.ts` の `NEMO_VERIFY_DIAGNOSTICS` と同じ流儀）。
 * `isDevChannel` では塞げない —— `paths.ts` は `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので
 * **dev 版のパッケージでも `isDevChannel === true`** になり、裏口が配布物に残る。
 * timings は本番のスリープ / アーカイブの発火間隔を変えうるので、ここは厳しく閉める。
 */
let resolved: Timings = { ...DEFAULT_TIMINGS }

/** 起動時に1回だけ呼ぶ（`openLogFile()` の直後。ストアの初期化より前）。 */
export function initTimings(): void {
  const raw = app.isPackaged ? undefined : process.env['NEMO_VERIFY_TIMINGS']
  // 失敗は **throw**。黙って本番値に倒すと「verify だけ縮めたつもり」のズレが静かに生まれる
  resolved = resolveTimings(raw)
  /*
   * 実効値は必ず1行残す。既定値の書き間違いは、30分 / 24時間を実時間で待つ確認では捕まらない。
   *
   * **平たく展開せず JSON 文字列で出す**。`sessionSaveDebounceMs` のようにキー名へ
   * `session` を含むものは `log-redact` が `[redacted]` に落とすので、
   * 展開すると肝心の値が読めない（redaction 側に穴を開けるのは論外）。
   */
  log('timings.resolved', {
    effective: JSON.stringify(resolved),
    overridden: raw !== undefined && raw !== ''
  })
}

export function getTimings(): Timings {
  return resolved
}
