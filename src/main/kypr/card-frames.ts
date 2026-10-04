import type { WebContents } from 'electron'
import { log, logError } from '../log.js'
import { prepareAgentDebugger } from '../agent/contents.js'
import { OWNER_REGION, type PageRunner } from '../autofill/frame-runner.js'

/**
 * kypr のカード: メインフレームで**フォーカスのある直下の iframe**と、**それと同じオリジンの直下の兄弟 iframe**の組に、
 * 1 回の CDP の接続でまとめて isolated world を作る（plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`）。
 *
 * `subFrameRunner`（`autofill/frame-runner.ts`）を使わない理由:
 * - frame を URL の一致で探している。CDP の `Frame.url` には `#` 以降が入らないので、`#` に設定を載せる
 *   Stripe Elements の iframe が見つからない（2026-10-04 に Chrome で実測）
 * - 同じ URL の iframe が並ぶ分割型（番号・期限・CVC に 1 つずつ）は、`hasFocus()` の点数で 1 つに決められない
 *   （候補の View にフォーカスが移るとどの iframe も false になる）
 * - iframe 1 つごとに attach・150ms の待ち・detach が走る
 *
 * 代わりに、メインフレームの isolated world で iframe の要素を集め、`DOM.describeNode` で各要素の `frameId` を引く。
 * 別プロセスの iframe（OOPIF）は `targetId` が `frameId` と同じ（2026-10-04 に Chrome で実測）子セッションに付く。
 * **フォーカスのある iframe はメインフレームの `document.activeElement`**（ページのフォーカスが外れても残る）。
 * 親ページで iframe が見えていない（透明・極小・切り取り）ものは組に入れない（`OWNER_REGION`）。
 */

export interface CardFrame {
  /** CDP の frameId（組の中での識別子）。 */
  key: string
  /** メインフレームでフォーカスのある iframe。 */
  focused: boolean
  runner: PageRunner
}

export interface CardFrameGroup {
  frames: CardFrame[]
  dispose(): void
}

/** 組に入れる兄弟の数の上限（広告の iframe が大量に並ぶページで時間をかけない）。 */
const MAX_FRAMES = 8
const WORLD = 'nemo-kypr-card'

/** 同じページで重ねて attach / detach しない（後に始めた方の detach が先の方の接続を外す）。 */
const busy = new WeakMap<WebContents, Promise<unknown>>()

/**
 * 組を作って `use` に渡し、終わったら後片付けする。フォーカスのある iframe が無い・見えていない・付けないときは
 * `use(null)`。**同じページでは 1 つずつ走らせる**。
 */
export async function withCardFrameGroup<T>(
  wc: WebContents,
  use: (group: CardFrameGroup | null) => Promise<T>
): Promise<T> {
  const before = busy.get(wc) ?? Promise.resolve()
  const run = before
    .catch(() => {})
    .then(async () => {
      const group = await openGroup(wc)
      try {
        return await use(group)
      } finally {
        group?.dispose()
      }
    })
  busy.set(wc, run)
  return run
}

interface FrameTreeNode {
  frame: { id: string; securityOrigin?: string }
  childFrames?: FrameTreeNode[]
}

async function openGroup(wc: WebContents): Promise<CardFrameGroup | null> {
  if (wc.isDestroyed()) return null
  // エージェント窓のページは agent が debugger を持つ。先に agent に付けさせてから相乗りする（frame-runner と同じ）
  if (!(await prepareAgentDebugger(wc))) {
    log('kypr.card_frames', { ok: false, reason: 'agent-debugger' })
    return null
  }
  const dbg = wc.debugger
  const attachedHere = !dbg.isAttached()
  const sessions = new Map<string, string>()
  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method !== 'Target.attachedToTarget') return
    const { sessionId, targetInfo } = params as {
      sessionId: string
      targetInfo: { type: string; targetId: string }
    }
    if (targetInfo.type === 'iframe') sessions.set(targetInfo.targetId, sessionId)
  }
  const dispose = (): void => {
    dbg.removeListener('message', onMessage)
    if (!dbg.isAttached()) return
    if (attachedHere) {
      try {
        dbg.detach()
      } catch {
        // 既に外れている
      }
      return
    }
    dbg
      .sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false })
      .catch(() => {})
  }
  const fail = (reason: string, detail: Record<string, unknown> = {}): null => {
    log('kypr.card_frames', { ok: false, reason, ...detail })
    dispose()
    return null
  }
  const send = async <R>(method: string, params: object, sessionId?: string): Promise<R> =>
    (await dbg.sendCommand(method, params, sessionId)) as R
  const evaluate = async (
    contextId: number,
    sessionId: string | undefined,
    code: string
  ): Promise<unknown> => {
    const result = await send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.evaluate',
      { expression: code, contextId, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed'
      )
    }
    return result.result?.value
  }

  try {
    if (attachedHere) dbg.attach('1.3')
    dbg.on('message', onMessage)
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const tree = await send<{ frameTree?: FrameTreeNode }>('Page.getFrameTree', {})
    const mainId = tree.frameTree?.frame.id
    if (!mainId) return fail('no-main')
    const mainWorld = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: mainId,
      worldName: WORLD
    })
    // メインフレームの iframe の要素（直下の iframe だけが並ぶ）と、フォーカスのある要素
    const listed = await send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression:
        "(() => { const a = document.activeElement; const list = [...document.querySelectorAll('iframe')]; return { active: a instanceof HTMLIFrameElement ? list.indexOf(a) : -1, list } })()",
      contextId: mainWorld.executionContextId,
      returnByValue: false
    })
    const listedId = listed.result?.objectId
    if (!listedId) return fail('no-list')
    const props = await send<{ result: { name: string; value?: { objectId?: string; value?: unknown } }[] }>(
      'Runtime.getProperties',
      { objectId: listedId, ownProperties: true }
    )
    const activeIndex = Number(props.result.find((p) => p.name === 'active')?.value?.value ?? -1)
    const listObjectId = props.result.find((p) => p.name === 'list')?.value?.objectId
    if (activeIndex < 0 || !listObjectId) return fail('no-focused-frame')
    const elements = await send<{ result: { name: string; value?: { objectId?: string } }[] }>(
      'Runtime.getProperties',
      { objectId: listObjectId, ownProperties: true }
    )
    const owners = elements.result
      .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
      .map((p) => ({ index: Number(p.name), objectId: p.value?.objectId as string }))

    // 各 iframe の frameId とオリジン
    const sameProcess = new Map<string, string>()
    for (const child of tree.frameTree?.childFrames ?? [])
      sameProcess.set(child.frame.id, child.frame.securityOrigin ?? '')
    const described: {
      index: number
      objectId: string
      frameId: string
      origin: string
      sessionId?: string
    }[] = []
    for (const owner of owners) {
      const node = await send<{ node?: { frameId?: string } }>('DOM.describeNode', {
        objectId: owner.objectId
      }).catch(() => null)
      const frameId = node?.node?.frameId
      if (!frameId) continue
      const sessionId = sessions.get(frameId)
      let origin = sameProcess.get(frameId)
      if (sessionId) {
        const sub = await send<{ frameTree?: FrameTreeNode }>('Page.getFrameTree', {}, sessionId).catch(
          () => null
        )
        origin = sub?.frameTree?.frame.securityOrigin
      }
      if (origin === undefined) continue
      described.push({ ...owner, frameId, origin, ...(sessionId ? { sessionId } : {}) })
    }
    const focused = described.find((d) => d.index === activeIndex)
    if (!focused) return fail('focused-frame-unknown', { frames: described.length, sessions: sessions.size })
    // 不透明なオリジン（sandbox・about:blank の継承）は兄弟と組にしない
    const opaque = focused.origin === '' || focused.origin === 'null'
    const members = [
      focused,
      ...(opaque ? [] : described.filter((d) => d !== focused && d.origin === focused.origin))
    ].slice(0, MAX_FRAMES)

    const frames: CardFrame[] = []
    for (const member of members) {
      // 親ページで iframe の要素が見えているか（透明・極小・切り取り）
      const region = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
        objectId: member.objectId,
        functionDeclaration: OWNER_REGION,
        returnByValue: true
      })
      if (!region.result?.value) continue
      const world = await send<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId: member.frameId, worldName: WORLD },
        member.sessionId
      )
      const contextId = world.executionContextId
      const sessionId = member.sessionId
      frames.push({
        key: member.frameId,
        focused: member === focused,
        runner: {
          run: (code) => evaluate(contextId, sessionId, code),
          dispose: () => {},
          region: null
        }
      })
    }
    if (!frames.some((f) => f.focused)) return fail('focused-frame-hidden')
    log('kypr.card_frames', {
      ok: true,
      frames: frames.length,
      crossProcess: focused.sessionId !== undefined
    })
    return { frames, dispose }
  } catch (error) {
    logError('kypr.card_frames_failed', error, {})
    dispose()
    return null
  }
}
