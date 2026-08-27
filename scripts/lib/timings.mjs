// @ts-check
/**
 * 検証スクリプト側が見る「見に行く周期 / デバウンス」の実効値。
 *
 * **`NEMO_VERIFY_TIMINGS` を読み戻し、無ければ本番既定値へフォールバックする**。
 * 検証値を決め打ちで持たないのが要点。各スクリプトは単独起動も公式にサポートされていて
 * （`mise run verify:switcher` は「Nemo を起動してから回す」）、そのときアプリは
 * env を受け取らず**本番値で動く**。verify 側が短い値を決め打ちしていると、
 * この経路で待ちが本番値より短くなり、flaky FAIL か、否定形の検査の空振り PASS を生む。
 *
 * 既定値は `src/shared/timings.js` が唯一の置き場（アプリと同じファイルを読む）。
 */
import { resolveTimings } from '../../src/shared/timings.js'

/** アプリと**必ず同じ**実効値。パース失敗・知らないキーはここでも即エラーになる。 */
export const timings = resolveTimings(process.env['NEMO_VERIFY_TIMINGS'])

/**
 * 「条件が成立してから sweep が**必ず 1 回**通るまで」の待ち（ms）。
 *
 * sweep は周期実行なので、条件成立の瞬間が周期のどこであっても
 * `成立までの残り + 周期` 待てば必ず 1 回は判定される。`slackMs` は
 * CDP の往復と設定反映のぶん。
 *
 * @param {number} untilConditionMs 条件が成立するまでの残り時間（既に成立しているなら 0）
 * @param {number} [slackMs]
 */
export function afterSweep(untilConditionMs, slackMs = 1500) {
  return untilConditionMs + timings.sleepSweepMs + slackMs
}

/**
 * セッションが**ディスクに書かれる**まで（ms）。
 *
 * デバウンスは 2 段（`registry.ts` の `scheduleSessionSave` →
 * `store/session.ts` が `JsonStore` に渡す値）。片方だけ見ると下限がもう片方に張り付く。
 *
 * @param {number} [slackMs]
 */
export function afterSessionSave(slackMs = 700) {
  return timings.sessionSaveDebounceMs + timings.sessionStoreDebounceMs + slackMs
}
