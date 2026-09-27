import type { WebContents, WebFrameMain } from 'electron'
import { log, logError } from '../log.js'
import { AUTOFILL_WORLD_ID } from '../../shared/autofill-collect-source.js'

/**
 * 自動入力のページ側スクリプトを**isolated world で**走らせる口。
 *
 * - メインフレーム: `executeJavaScriptInIsolatedWorld`（Electron の API）
 * - iframe: `WebFrameMain` はメインワールドの `executeJavaScript` しか持たない。メインワールドで走らせると
 *   ページが `getComputedStyle` 等を差し替えて**可視判定を偽り、見えない欄に値を入れさせられる**ので使わない。
 *   代わりに `webContents.debugger`（CDP）で iframe に isolated world を作って走らせる
 *   （`devtools-shim.ts` と同じく flatten したセッションで別プロセスの iframe に付く）
 *
 * **同じ runner で収集と流し込みを走らせる**（isolated world の中に収集した要素を持っているため）。
 */
/** iframe の中で見えている範囲（iframe の表示領域の座標）。この外の欄は集めない。 */
export interface VisibleRegion {
  left: number
  top: number
  right: number
  bottom: number
  /** 親ページでの拡大率（`transform: scale()`）。欄の見た目の大きさ = iframe の中の大きさ × これ。 */
  scaleX: number
  scaleY: number
  /** iframe の中をスクロールできる（`scrolling="no"` でない）。できるなら位置では絞らない。 */
  scrollable: boolean
}

export interface PageRunner {
  run(code: string): Promise<unknown>
  dispose(): void
  /** iframe のとき、親ページで見えている範囲。メインフレームは null（範囲で絞らない）。 */
  region: VisibleRegion | null
}

export function mainFrameRunner(wc: WebContents): PageRunner {
  return {
    run: (code) => wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]),
    dispose: () => {},
    region: null
  }
}

interface FrameTreeNode {
  frame: { id: string; url: string }
  childFrames?: FrameTreeNode[]
}

/**
 * CDP の frame tree から URL が一致する frame を**すべて**集める（`WebFrameMain.frameToken` は CDP の frame ID と別物）。
 * `skipRoot` はメインのセッションの根（メインフレーム）を候補から外すため。
 */
function collectFrameIds(
  node: FrameTreeNode | undefined,
  url: string,
  skipRoot: boolean,
  out: string[]
): void {
  if (!node) return
  if (!skipRoot && node.frame.url === url) out.push(node.frame.id)
  for (const child of node.childFrames ?? []) collectFrameIds(child, url, false, out)
}

/**
 * 親ページで iframe の要素そのものが見えているかを確かめ、見えている範囲を iframe の座標で返す。
 * **iframe の中の可視判定だけでは足りない**: 親が iframe に `opacity: 0` をかけたり、極小にしたり、
 * 祖先で切り取ったりすると、中の欄は見えないまま入ってしまう（透明な iframe を重ねる手口）。
 * 収集スクリプトの `isVisible` と同じ基準（`autofill-collect-source.js`）。見えなければ null。
 */
const OWNER_REGION = `function () {
  const el = this
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return null
  if (el.closest('[aria-hidden="true"], [inert]')) return null
  const r = el.getBoundingClientRect()
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom
  const doc = document.documentElement
  for (let p = el.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
    const style = getComputedStyle(p)
    if (!/hidden|clip/.test(style.overflowX + ' ' + style.overflowY)) continue
    const b = p.getBoundingClientRect()
    left = Math.max(left, b.left); top = Math.max(top, b.top); right = Math.min(right, b.right); bottom = Math.min(bottom, b.bottom)
  }
  if (right - left < 4 || bottom - top < 4) return null
  if (right + window.scrollX <= 0 || bottom + window.scrollY <= 0) return null
  if (left + window.scrollX >= Math.max(doc.scrollWidth, doc.clientWidth) || top + window.scrollY >= Math.max(doc.scrollHeight, doc.clientHeight)) return null
  // 親で拡大・縮小されていると、親の px と iframe の中の px が違う。範囲は iframe の中の px に直して返す
  const scaleX = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1
  const scaleY = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1
  if (scaleX <= 0 || scaleY <= 0) return null
  const cs = getComputedStyle(el)
  const ox = r.left + (el.clientLeft + parseFloat(cs.paddingLeft || '0')) * scaleX
  const oy = r.top + (el.clientTop + parseFloat(cs.paddingTop || '0')) * scaleY
  return {
    left: (left - ox) / scaleX, top: (top - oy) / scaleY, right: (right - ox) / scaleX, bottom: (bottom - oy) / scaleY,
    scaleX, scaleY, scrollable: el.getAttribute('scrolling') !== 'no'
  }
}`

/**
 * iframe に isolated world を作る。見つからない・付けないときは null（呼び出し側は「集められなかった」にする）。
 */
export async function subFrameRunner(wc: WebContents, frame: WebFrameMain): Promise<PageRunner | null> {
  const dbg = wc.debugger
  const attachedHere = !dbg.isAttached()
  const sessions = new Set<string>()
  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method !== 'Target.attachedToTarget') return
    const { sessionId, targetInfo } = params as { sessionId: string; targetInfo: { type: string } }
    if (targetInfo.type === 'iframe') sessions.add(sessionId)
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
    // 自分で付けたのでなければ、自動 attach だけ戻す
    dbg
      .sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false })
      .catch(() => {})
  }
  const evaluate = async (
    contextId: number,
    sessionId: string | undefined,
    code: string
  ): Promise<unknown> => {
    const result = (await dbg.sendCommand(
      'Runtime.evaluate',
      { expression: code, contextId, returnByValue: true, awaitPromise: true },
      sessionId
    )) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed'
      )
    }
    return result.result?.value
  }
  const fail = (event: string, detail: Record<string, unknown> = {}): null => {
    log(event, detail)
    dispose()
    return null
  }

  try {
    // 親で iframe の要素を確かめるので、**メインフレーム直下の iframe だけ**（入れ子の iframe は親の world を作れない）
    if (frame.parent?.parent !== null) return fail('autofill.frame_nested')
    if (attachedHere) dbg.attach('1.3')
    dbg.on('message', onMessage)
    // 別プロセスの iframe は別 target。既にある子 target も attachedToTarget で届く
    await dbg.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    // 同じプロセスの iframe はメインのセッションの frame tree（根のメインフレームは除く）に、別プロセスのものは子セッションにある
    const matches: { sessionId: string | undefined; frameId: string }[] = []
    let mainRootId: string | null = null
    for (const sessionId of [undefined, ...sessions]) {
      const tree = (await dbg.sendCommand('Page.getFrameTree', {}, sessionId).catch(() => null)) as {
        frameTree?: FrameTreeNode
      } | null
      if (sessionId === undefined) mainRootId = tree?.frameTree?.frame.id ?? null
      const ids: string[] = []
      collectFrameIds(tree?.frameTree, frame.url, sessionId === undefined, ids)
      for (const frameId of ids) matches.push({ sessionId, frameId })
    }
    if (matches.length === 0 || !mainRootId)
      return fail('autofill.frame_not_found', { sessions: sessions.size })

    const worlds: { sessionId: string | undefined; frameId: string; contextId: number }[] = []
    for (const match of matches) {
      const world = (await dbg.sendCommand(
        'Page.createIsolatedWorld',
        { frameId: match.frameId, worldName: 'nemo-autofill' },
        match.sessionId
      )) as { executionContextId: number }
      worlds.push({ ...match, contextId: world.executionContextId })
    }
    // 同じ URL の iframe が複数あるときは、右クリックした欄（＝フォーカス）のある方。
    // ウィンドウにフォーカスが無いと hasFocus は全部 false なので、入力欄が選ばれているかも見る。決まらなければやめる
    let target = worlds[0]
    if (worlds.length > 1) {
      const scores: number[] = []
      for (const world of worlds) {
        const score = await evaluate(
          world.contextId,
          world.sessionId,
          "document.hasFocus() ? 2 : document.activeElement && document.activeElement.matches('input, select, textarea') ? 1 : 0"
        ).catch(() => 0)
        scores.push(typeof score === 'number' ? score : 0)
      }
      const best = Math.max(...scores)
      const top = worlds.filter((_, i) => scores[i] === best)
      if (best === 0 || top.length !== 1) return fail('autofill.frame_ambiguous', { matches: worlds.length })
      target = top[0]
    }
    if (!target) return fail('autofill.frame_not_found', { sessions: sessions.size })

    // 親ページで iframe の要素が見えているか（メインのセッションで isolated world を作って確かめる）
    const owner = (await dbg.sendCommand('DOM.getFrameOwner', { frameId: target.frameId })) as {
      backendNodeId: number
    }
    const mainWorld = (await dbg.sendCommand('Page.createIsolatedWorld', {
      frameId: mainRootId,
      worldName: 'nemo-autofill'
    })) as { executionContextId: number }
    const node = (await dbg.sendCommand('DOM.resolveNode', {
      backendNodeId: owner.backendNodeId,
      executionContextId: mainWorld.executionContextId
    })) as { object?: { objectId?: string } }
    if (!node.object?.objectId) return fail('autofill.frame_owner_missing')
    const regionResult = (await dbg.sendCommand('Runtime.callFunctionOn', {
      objectId: node.object.objectId,
      functionDeclaration: OWNER_REGION,
      returnByValue: true
    })) as { result?: { value?: VisibleRegion | null } }
    const region = regionResult.result?.value ?? null
    if (!region) return fail('autofill.frame_hidden')

    log('autofill.frame_attached', { crossProcess: target.sessionId !== undefined })
    const chosen = target
    return {
      run: (code) => evaluate(chosen.contextId, chosen.sessionId, code),
      dispose,
      region
    }
  } catch (error) {
    logError('autofill.frame_attach_failed', error, {})
    dispose()
    return null
  }
}
