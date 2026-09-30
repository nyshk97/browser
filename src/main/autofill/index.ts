import type { WebContents, WebFrameMain } from 'electron'
import { log, logError } from '../log.js'
import { AUTOFILL_PAGE_SOURCE } from '../../shared/autofill-collect-source.js'
import {
  buildFillPlan,
  buildJevRequests,
  isConfirmField,
  isEnglishForm,
  isExcluded,
  refineOption,
  normalizeCollected,
  readJevAnswers,
  resolveConflicts,
  resolveDocumentExpiry,
  ruleOption,
  type Decision
} from '../../shared/autofill-match.js'
import { deriveValues } from '../../shared/autofill-values.js'
import { profileFromKypr } from '../../shared/autofill-schema.js'
import type { AutofillRunResult } from '../../shared/types.js'
import { readJevKey } from '../store/jev-key.js'
import { getSettings } from '../store/settings.js'
import { kyprIdentityForFill, kyprState, kyprStatus, unlockKyprWithTouchId } from '../kypr/index.js'
import { askJev } from './jev.js'
import { mainFrameRunner, subFrameRunner, type PageRunner } from './frame-runner.js'
import { agentFillRefusal, isAgentContents, rememberAgentSecrets } from '../agent/contents.js'

/**
 * 実行中のタブ。**同じタブでの 2 回目は弾く**（収集した要素はページ側の 1 か所に持つので、
 * Jev を待っている間に 2 回目の収集が走ると、1 回目の割り当てが別の欄を指す）。
 */
const running = new WeakSet<WebContents>()

/**
 * フォーム自動入力の本体（右クリックの「フォーム自動入力」と、自走検証の口が呼ぶ）。
 *
 * 1. kypr の個人情報（既定の 1 件）からプロフィールを出す。ロック中なら Touch ID で解除する
 *    （通らない・未ログイン・0 件なら kypr のポップアップへ誘導するのは呼び出し側）
 * 2. ページの isolated world で、右クリックした位置のフォームから**空で見える欄だけ**集める
 * 3. `autocomplete` / `type` で決まる欄はルールで決める
 * 4. 残りを Jev に聞く（**送るのは欄の手がかりだけ**。`buildJevRequests` は値を受け取らない）
 * 5. 閾値で足切り → 同じ項目の取り合いを解く → 入力欄ごとの値に落として流し込む
 *
 * **Jev が失敗しても 3 の分は入れる**（キー無し・タイムアウト・HTTP エラー）。
 *
 * `frame` が iframe なら、その iframe の中で走らせる（CDP で isolated world を作る。`frame-runner.ts`）。
 * iframe では右クリックした欄にフォーカスがあるのでそこから辿り、座標は使わない。
 */
export async function runAutofill(
  wc: WebContents,
  x: number,
  y: number,
  frame: WebFrameMain | null = null,
  debug = false
): Promise<AutofillRunResult> {
  // エージェント窓: Claude が JS を実行した document には入れない（`agent/fill-gate.ts`。入口をここで一元的に閉じる）
  const agentRefusal = await agentFillRefusal(wc)
  if (agentRefusal) {
    const refused: AutofillRunResult = {
      ok: false,
      reason: agentRefusal,
      fields: 0,
      rule: 0,
      jev: 0,
      left: 0,
      filled: 0,
      jevMs: null
    }
    log('autofill.run', { ...refused })
    return refused
  }
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
    return await runAutofillOnce(wc, x, y, frame, debug)
  } finally {
    running.delete(wc)
  }
}

async function runAutofillOnce(
  wc: WebContents,
  x: number,
  y: number,
  frame: WebFrameMain | null,
  debug: boolean
): Promise<AutofillRunResult> {
  const result: AutofillRunResult = { ok: false, fields: 0, rule: 0, jev: 0, left: 0, filled: 0, jevMs: null }
  const finish = (): AutofillRunResult => {
    // **値・見出し・URL は載せない**（件数と失敗の種類だけ。`debug` は検証の口にだけ返す）
    const { debug: _debug, ...counts } = result
    log('autofill.run', counts)
    return result
  }

  const state = kyprState()
  if (state === 'disabled') {
    result.reason = 'kypr-disabled'
    return finish()
  }
  if (state === 'signed-out') {
    result.reason = 'kypr-signed-out'
    return finish()
  }
  if (state === 'locked') {
    // Touch ID を覚えていなければ聞かずにポップアップへ（マスターパスワードの入力はポップアップで）
    const unlocked = kyprStatus().touchIdEnrolled ? await unlockKyprWithTouchId() : null
    if (!unlocked?.ok) {
      result.reason = 'kypr-locked'
      return finish()
    }
  }
  const identity = kyprIdentityForFill(getSettings().kyprAutofillIdentityId)
  if (!identity) {
    // ロックされ直した（解除を待つ間に画面ロック）か、個人情報が 1 件も無い
    result.reason = kyprState() === 'unlocked' ? 'no-identity' : 'kypr-locked'
    return finish()
  }
  const profile = profileFromKypr(identity.values)

  if (wc.isDestroyed()) {
    result.reason = 'collect-failed'
    return finish()
  }
  // 右クリックしてからメニューを押すまでに iframe が作り直された。**メインフレームに落とさない**
  // （右クリックの座標にはメインフレームの iframe 要素しか無いので、メインページに入れてしまう）
  if (frame !== null && frame.isDestroyed()) {
    result.reason = 'collect-failed'
    return finish()
  }
  const inSubFrame = frame !== null && frame.parent !== null
  const runner = inSubFrame ? await subFrameRunner(wc, frame) : mainFrameRunner(wc)
  if (!runner) {
    result.reason = 'collect-failed'
    return finish()
  }
  try {
    return await collectAndFill(wc, runner, inSubFrame, x, y, profile, result, finish, debug)
  } finally {
    runner.dispose()
  }
}

async function collectAndFill(
  wc: WebContents,
  runner: PageRunner,
  inSubFrame: boolean,
  x: number,
  y: number,
  profile: Record<string, string>,
  result: AutofillRunResult,
  finish: () => AutofillRunResult,
  debug: boolean
): Promise<AutofillRunResult> {
  // 右クリックの座標は DIP。ページのズームを戻して CSS px にする。iframe では座標を使わない（-1）
  const zoom = wc.getZoomFactor() || 1
  const cx = inSubFrame ? -1 : Number(x / zoom) || 0
  const cy = inSubFrame ? -1 : Number(y / zoom) || 0
  let raw: unknown
  try {
    raw = await runner.run(
      `${AUTOFILL_PAGE_SOURCE};globalThis.__nemoAutofillCollect(${cx}, ${cy}, ${JSON.stringify(runner.region)})`
    )
  } catch (error) {
    logError('autofill.collect_failed', error, { inSubFrame })
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
  const jevRaw = new Map<number, { choice: string; confidence: number; own: number }>()
  const confirms = new Set<number>()
  collected.fields.forEach((field, index) => {
    // FAX などは入れない（Jev にも聞かない）
    if (isExcluded(field)) return
    if (isConfirmField(field)) confirms.add(index)
    const option = ruleOption(field, collected.elements)
    if (option) decisions.set(index, { option: refineOption(option, field), confidence: 1, source: 'rule' })
    else pending.push(index)
  })

  if (pending.length > 0) {
    // Jev のキーは Mac ごと（userData に端末鍵で暗号化。`jev-key.ts`）
    const key = readJevKey()
    if (!key) {
      result.jevError = 'no-key'
    } else {
      const chunks = buildJevRequests(collected, pending)
      const groups = new Set(pending.filter((index) => (collected.fields[index]?.members.length ?? 0) > 1))
      const answers = await Promise.all(chunks.map((chunk) => askJev(key, chunk.body)))
      result.jevMs = Math.max(...answers.map((answer) => answer.ms))
      answers.forEach((answer, i) => {
        const chunk = chunks[i]
        if (!chunk) return
        if (!answer.ok) {
          result.jevError = answer.kind === 'http' ? `http-${answer.status}` : answer.kind
          return
        }
        for (const [index, decision] of readJevAnswers(answer.answers, chunk.indexes, groups).decisions) {
          const field = collected.fields[index]
          decisions.set(
            index,
            field ? { ...decision, option: refineOption(decision.option, field) } : decision
          )
        }
        if (debug && typeof answer.answers === 'object' && answer.answers !== null) {
          for (const index of chunk.indexes) {
            const raw = answer.answers as Record<
              string,
              { choice?: unknown; confidence?: unknown; noul?: unknown }
            >
            jevRaw.set(index, {
              choice: typeof raw[`f${index}`]?.choice === 'string' ? String(raw[`f${index}`]?.choice) : '',
              confidence: Number(raw[`f${index}`]?.confidence ?? 0),
              own: Number(raw[`own${index}`]?.noul ?? 0)
            })
          }
        }
      })
    }
  }

  // 「有効期限」だけの欄の書類を決めてから重複を解く（`document_expiry` のまま解くと片方が消える）
  const resolved = resolveConflicts(resolveDocumentExpiry(decisions, collected), confirms)
  // 建物名の欄が別にあるなら、番地の欄に建物名まで入れない（二重になる）
  if ([...resolved.values()].some((decision) => decision.option === 'address_line2')) {
    for (const [index, decision] of resolved) {
      if (decision.option === 'address_line1_2') resolved.set(index, { ...decision, option: 'address_line1' })
    }
  }
  // 英語のフォームでは氏名をローマ字・住所を英語の住所にする（英語の住所が無ければ住所の欄は空のまま）
  result.english = isEnglishForm(collected)
  const plan = buildFillPlan(collected, resolved, deriveValues(profile, { english: result.english }))
  if (debug) {
    // 自走検証・実サイト調査の口にだけ返す（**診断ログには載せない**。見出しはページの中身なので）
    result.debug = collected.fields.map((field, index) => ({
      label: field.label,
      nearby: field.nearby,
      section: field.section,
      placeholder: field.placeholder,
      boxes: field.members.length,
      decided: resolved.get(index)?.option ?? null,
      source: resolved.get(index)?.source ?? null,
      jev: jevRaw.get(index) ?? null
    }))
  }
  result.rule = plan.filledFields.rule
  result.jev = plan.filledFields.jev
  result.documents = plan.documents
  result.left = result.fields - result.rule - result.jev

  // エージェント窓: 身分証の番号は伏せる。iframe の中はスクショの伏せ字が効かない（塗るのはメインフレームの要素だけ）ので
  // その欄だけ入れない。メインフレームでは**流し込む直前に**伏せる値として覚えさせ、覚えさせられなければ何も入れない。
  // 入口の判定から流し込むまでに Touch ID・Jev の待ちが挟まるので、Claude が JS を実行していないかをここで確かめ直す
  // （伏せる値があるときは world の中で排他に確かめる `rememberAgentSecrets`、無いときは `agentFillRefusal`）
  let steps = plan.steps
  if (isAgentContents(wc)) {
    const secrets = !inSubFrame && plan.secretElements.length > 0
    if (inSubFrame && plan.secretElements.length > 0) {
      const withheld = new Set(plan.secretElements)
      steps = steps.filter((step) => !withheld.has(step.element))
      result.withheld = plan.steps.length - steps.length
    }
    const refusedNow = secrets
      ? await rememberAgentSecrets(wc, plan.secretValues)
      : await agentFillRefusal(wc)
    if (refusedNow) {
      result.reason = refusedNow
      return finish()
    }
  }

  if (steps.length > 0 && !wc.isDestroyed()) {
    try {
      const filled = (await runner.run(`globalThis.__nemoAutofillFill(${JSON.stringify(steps)})`)) as {
        filled?: unknown
      } | null
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
