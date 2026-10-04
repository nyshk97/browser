import type { WebContents } from 'electron'
import { KYPR_PAGE_SOURCE, KYPR_WORLD_ID } from '../../shared/kypr-page-source.js'
import {
  planCardFill,
  type CardFieldDesc,
  type CardFillStep,
  type CardFrameDesc
} from '../../shared/kypr-card-fill.js'
import type { KyprActionResult } from '../../shared/types.js'
import { log, logError } from '../log.js'
import { agentFillRefusal, isAgentContents, rememberAgentSecrets } from '../agent/contents.js'
import type { PageRunner } from '../autofill/frame-runner.js'
import { withCardFrameGroup, type CardFrameGroup } from './card-frames.js'
import { kyprCardForFill, kyprCardSummaries, touchKypr } from './index.js'

/**
 * kypr のカードを決済フォームに入れる（欄の下の候補・⌘⇧L・ポップアップ）。
 * plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`。
 *
 * **入れる先**（3 つの経路で同じ判定 `kyprCardTarget` を使う）:
 *   1. メインフレームでカードの欄にフォーカスがある（番号の欄があるフォーム）→ メインフレーム
 *   2. メインフレームでフォーカスのある直下の iframe と、その同じオリジンの兄弟の組に番号の欄がある → その組
 *      （組に無い項目（サイトのページに置いた名義の欄など）がメインフレームのカードの欄にあれば一緒に入れる）
 * **入れる直前に、同じ runner で欄を調べ直してから手順を作る**（候補を出したときの記述は使わない）。
 * 安全なコンテキスト（https・loopback の http）でないフレームが組にあれば入れない。
 * Claude のウィンドウ: メインフレームなら入れる（番号・CVC の欄は `agent-page-source.js` が欄そのもので伏せる。
 * 値も `rememberAgentSecrets` で覚えさせる）。iframe の中は伏せ字が効かないので入れない（`agent-iframe`）。
 */

interface Probe {
  fields: CardFieldDesc[]
  hasNumber: boolean
  /** 期限か CVC の欄がある（番号の欄とそろってカードのフォーム）。 */
  hasOther: boolean
  focused: boolean
  secure: boolean
}

/** メインフレームでカードのフォームの欄にいる（番号の欄と、期限か CVC の欄がそろっている）。 */
const onMainCardForm = (p: Probe): boolean => p.focused && p.hasNumber && p.hasOther

/**
 * iframe の組がカードのフォーム（組の中に番号の欄がある。plan の決定表どおり）。期限・CVC がサイトのページ側にある型も
 * あるので、メインフレームのような「期限か CVC とそろう」は求めない（名前の手がかりの誤判定の心配は、別オリジンの
 * 決済代行の iframe では小さい）
 */
const groupIsCardForm = (probes: FrameProbe[]): boolean => probes.some((p) => p.probe.hasNumber)

function mainRunner(wc: WebContents): PageRunner {
  return {
    run: (code) => wc.executeJavaScriptInIsolatedWorld(KYPR_WORLD_ID, [{ code }]),
    dispose: () => {},
    region: null
  }
}

async function probe(runner: PageRunner): Promise<Probe | null> {
  try {
    const result = (await runner.run(`${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.probeCard()`)) as Probe | null
    if (!result || typeof result !== 'object' || !Array.isArray(result.fields)) return null
    return {
      fields: result.fields,
      hasNumber: result.hasNumber === true,
      hasOther: result.hasOther === true,
      focused: result.focused === true,
      secure: result.secure === true
    }
  } catch (error) {
    logError('kypr.card_probe_failed', error, {})
    return null
  }
}

/** メインフレームでフォーカスのある iframe（無ければ null）。 */
export async function kyprActiveFrame(wc: WebContents): Promise<{
  doc: string
  index: number
  src: string
  rect: { x: number; y: number; width: number; height: number }
} | null> {
  if (wc.isDestroyed()) return null
  try {
    const result = (await mainRunner(wc).run(
      `${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.activeFrame()`
    )) as Awaited<ReturnType<typeof kyprActiveFrame>>
    return result && typeof result === 'object' && typeof result.doc === 'string' ? result : null
  } catch (error) {
    logError('kypr.active_frame_failed', error, {})
    return null
  }
}

interface FrameProbe {
  key: string
  runner: PageRunner
  probe: Probe
}

/** 組の各フレームの記述（調べられなかったフレームは外す）。 */
async function probeGroup(group: CardFrameGroup): Promise<FrameProbe[]> {
  const out: FrameProbe[] = []
  // フォーカスのあるフレームを先に（手順を作るときもこの順で優先する）
  const frames = [...group.frames].sort((a, b) => Number(b.focused) - Number(a.focused))
  for (const frame of frames) {
    const p = await probe(frame.runner)
    if (p) out.push({ key: frame.key, runner: frame.runner, probe: p })
  }
  return out
}

/** iframe の組に番号の欄があるか（候補を出すかの判定）。組を作れなければ false。 */
export async function kyprFrameGroupHasCard(wc: WebContents): Promise<boolean> {
  return withCardFrameGroup(wc, async (group) => {
    if (!group) return false
    const probes = await probeGroup(group)
    return groupIsCardForm(probes) && probes.every((p) => p.probe.secure)
  })
}

/**
 * 入れる先がカードの欄か（⌘⇧L・ポップアップが使う）。`main` / `frames` / null。
 * iframe の組を覗く（CDP で付く）のは、カードが 1 件以上あるときだけ。
 */
export async function kyprCardTarget(wc: WebContents): Promise<'main' | 'frames' | null> {
  if (wc.isDestroyed()) return null
  const main = await probe(mainRunner(wc))
  if (main && onMainCardForm(main) && main.secure) return 'main'
  if (kyprCardSummaries().length === 0 || !(await kyprActiveFrame(wc))) return null
  return (await kyprFrameGroupHasCard(wc)) ? 'frames' : null
}

/**
 * `expect` は欄の下の候補から選んだとき: 候補を出したときの入れる先（メインフレームの欄か iframe の組か）と
 * 違えば入れない（選ぶまでにページがフォーカスを動かしていたら、出したときと別の欄に入れない）。
 */
export async function fillKyprCard(
  wc: WebContents,
  itemId: string,
  expect?: 'main' | 'frames'
): Promise<KyprActionResult> {
  const refused = await agentFillRefusal(wc)
  if (refused) {
    log('kypr.fill_card', { ok: false, reason: refused })
    return { ok: false, reason: refused }
  }
  const card = kyprCardForFill(itemId)
  if (!card) return { ok: false, reason: 'not-found' }
  if (wc.isDestroyed()) return { ok: false, reason: 'no-target' }

  const finish = (result: KyprActionResult, detail: Record<string, unknown> = {}): KyprActionResult => {
    log('kypr.fill_card', { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }), ...detail })
    if (result.ok) touchKypr()
    return result
  }
  const fillFrames = async (
    targets: FrameProbe[],
    agent: boolean
  ): Promise<{ result: KyprActionResult; detail: Record<string, unknown> }> => {
    const plan = planCardFill(
      targets.map((t): CardFrameDesc => ({ key: t.key, fields: t.probe.fields })),
      card
    )
    if (plan.kinds.length === 0) return { result: { ok: false, reason: 'no-target' }, detail: {} }
    // Claude のウィンドウ: 流し込む直前に、伏せる値を覚えさせる（入口の後に Claude が JS を実行していたら断る）
    if (agent) {
      const refusedNow = await rememberAgentSecrets(wc, [card.number, card.code].filter(Boolean))
      if (refusedNow) return { result: { ok: false, reason: refusedNow }, detail: {} }
    }
    let filled = 0
    for (const t of targets) {
      const steps: CardFillStep[] = plan.steps[t.key] ?? []
      if (steps.length === 0) continue
      const n = await t.runner.run(
        `${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.fillCard(${JSON.stringify(steps)})`
      )
      if (typeof n === 'number') filled += n
    }
    const detail = { kinds: plan.kinds, frames: Object.keys(plan.steps).length, filled }
    return { result: filled > 0 ? { ok: true, id: itemId } : { ok: false, reason: 'no-target' }, detail }
  }

  try {
    const mainR = mainRunner(wc)
    const main = await probe(mainR)
    if (main && onMainCardForm(main)) {
      if (expect === 'frames') return finish({ ok: false, reason: 'no-target' })
      if (!main.secure) return finish({ ok: false, reason: 'insecure' })
      const { result, detail } = await fillFrames(
        [{ key: 'main', runner: mainR, probe: main }],
        isAgentContents(wc)
      )
      return finish(result, { ...detail, inSubFrame: false })
    }
    if (expect === 'main' || !(await kyprActiveFrame(wc))) return finish({ ok: false, reason: 'no-target' })
    // iframe の中は Claude のウィンドウでは伏せ字が効かないので入れない（組を調べる前に断る）
    if (isAgentContents(wc)) return finish({ ok: false, reason: 'agent-iframe' })
    return await withCardFrameGroup(wc, async (group) => {
      if (!group) return finish({ ok: false, reason: 'no-target' })
      const probes = await probeGroup(group)
      if (!groupIsCardForm(probes)) return finish({ ok: false, reason: 'no-target' })
      if (!probes.every((p) => p.probe.secure) || (main && !main.secure))
        return finish({ ok: false, reason: 'insecure' })
      // 組に無い項目（名義など）はメインフレームのカードの欄にも入れる（組の後ろに並べる = 組が優先）
      const targets =
        main && main.fields.length > 0 ? [...probes, { key: 'main', runner: mainR, probe: main }] : probes
      const { result, detail } = await fillFrames(targets, false)
      return finish(result, { ...detail, inSubFrame: true })
    })
  } catch (error) {
    logError('kypr.fill_card_failed', error, {})
    return finish({ ok: false, reason: 'failed' })
  }
}
