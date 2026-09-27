import type { WebContents } from 'electron'
import { log, logError } from '../log.js'
import { AUTOFILL_PAGE_SOURCE, AUTOFILL_WORLD_ID } from '../../shared/autofill-collect-source.js'
import {
  buildFillPlan,
  buildJevRequests,
  normalizeCollected,
  readJevAnswers,
  resolveConflicts,
  ruleOption,
  type Decision
} from '../../shared/autofill-match.js'
import { deriveValues } from '../../shared/autofill-values.js'
import type { AutofillRunResult } from '../../shared/types.js'
import { autofillVaultStatus, openAutofillVault, recallAutofillPassphrase } from '../store/autofill-vault.js'
import { readJevKey } from '../store/jev-key.js'
import { askJev } from './jev.js'

/**
 * 実行中のタブ。**同じタブでの 2 回目は弾く**（収集した要素はページ側の 1 か所に持つので、
 * Jev を待っている間に 2 回目の収集が走ると、1 回目の割り当てが別の欄を指す）。
 */
const running = new WeakSet<WebContents>()

/**
 * フォーム自動入力の本体（右クリックの「フォーム自動入力」と、自走検証の口が呼ぶ）。
 *
 * 1. 保管庫からプロフィールを出す（覚えているパスフレーズで。無ければ設定画面へ誘導するのは呼び出し側）
 * 2. ページの isolated world で、右クリックした位置のフォームから**空で見える欄だけ**集める
 * 3. `autocomplete` / `type` で決まる欄はルールで決める
 * 4. 残りを Jev に聞く（**送るのは欄の手がかりだけ**。`buildJevRequests` は値を受け取らない）
 * 5. 閾値で足切り → 同じ項目の取り合いを解く → 入力欄ごとの値に落として流し込む
 *
 * **Jev が失敗しても 3 の分は入れる**（キー無し・タイムアウト・HTTP エラー）。
 */
export async function runAutofill(wc: WebContents, x: number, y: number): Promise<AutofillRunResult> {
  if (running.has(wc)) {
    const busy: AutofillRunResult = {
      ok: false,
      reason: 'busy',
      fields: 0,
      rule: 0,
      jev: 0,
      left: 0,
      filled: 0,
      jevMs: null
    }
    log('autofill.run', { ...busy })
    return busy
  }
  running.add(wc)
  try {
    return await runAutofillOnce(wc, x, y)
  } finally {
    running.delete(wc)
  }
}

async function runAutofillOnce(wc: WebContents, x: number, y: number): Promise<AutofillRunResult> {
  const result: AutofillRunResult = { ok: false, fields: 0, rule: 0, jev: 0, left: 0, filled: 0, jevMs: null }
  const finish = (): AutofillRunResult => {
    // **値・見出し・URL は載せない**（件数と失敗の種類だけ）
    log('autofill.run', { ...result })
    return result
  }

  const passphrase = recallAutofillPassphrase()
  if (!passphrase) {
    const status = await autofillVaultStatus()
    result.reason = status.state === 'empty' ? 'no-vault' : 'no-passphrase'
    return finish()
  }
  const opened = await openAutofillVault(passphrase)
  if (!opened.ok) {
    result.reason =
      opened.reason === 'empty'
        ? 'no-vault'
        : opened.reason === 'bad-passphrase'
          ? 'bad-passphrase'
          : 'unreadable'
    return finish()
  }

  if (wc.isDestroyed()) {
    result.reason = 'collect-failed'
    return finish()
  }
  // 右クリックの座標は DIP。ページのズームを戻して CSS px にする
  const zoom = wc.getZoomFactor() || 1
  let raw: unknown
  try {
    raw = await wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
      {
        code: `${AUTOFILL_PAGE_SOURCE};globalThis.__nemoAutofillCollect(${Number(x / zoom) || 0}, ${Number(y / zoom) || 0})`
      }
    ])
  } catch (error) {
    logError('autofill.collect_failed', error, {})
    result.reason = 'collect-failed'
    return finish()
  }
  const collected = normalizeCollected(raw)
  if (!collected) {
    result.reason = 'collect-failed'
    return finish()
  }
  result.fields = collected.fields.length
  if (collected.fields.length === 0) {
    result.reason = 'no-fields'
    return finish()
  }

  const decisions = new Map<number, Decision>()
  const pending: number[] = []
  collected.fields.forEach((field, index) => {
    const option = ruleOption(field)
    if (option) decisions.set(index, { option, confidence: 1, source: 'rule' })
    else pending.push(index)
  })

  if (pending.length > 0) {
    // 保管庫のキーが正。保管庫へ移す前のキー（この Mac の userData）も読む
    const key = opened.jevKey ?? readJevKey()
    if (!key) {
      result.jevError = 'no-key'
    } else {
      const chunks = buildJevRequests(collected, pending)
      const answers = await Promise.all(chunks.map((chunk) => askJev(key, chunk.body)))
      result.jevMs = Math.max(...answers.map((answer) => answer.ms))
      answers.forEach((answer, i) => {
        const chunk = chunks[i]
        if (!chunk) return
        if (!answer.ok) {
          result.jevError = answer.kind === 'http' ? `http-${answer.status}` : answer.kind
          return
        }
        for (const [index, decision] of readJevAnswers(answer.answers, chunk.indexes).decisions) {
          decisions.set(index, decision)
        }
      })
    }
  }

  const plan = buildFillPlan(collected, resolveConflicts(decisions), deriveValues(opened.profile))
  result.rule = plan.filledFields.rule
  result.jev = plan.filledFields.jev
  result.left = result.fields - result.rule - result.jev

  if (plan.steps.length > 0 && !wc.isDestroyed()) {
    try {
      const filled = (await wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
        { code: `globalThis.__nemoAutofillFill(${JSON.stringify(plan.steps)})` }
      ])) as { filled?: unknown } | null
      result.filled = typeof filled?.filled === 'number' ? filled.filled : 0
    } catch (error) {
      logError('autofill.fill_failed', error, {})
      result.reason = 'fill-failed'
      return finish()
    }
  }
  result.ok = true
  return finish()
}
