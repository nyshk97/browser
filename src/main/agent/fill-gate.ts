import { webContents as webContentsModule, type WebContents } from 'electron'
import { log, logError } from '../log.js'
import { findTabByWebContents, type NemoWindow } from '../registry.js'
import { isAgentContents, type AgentFillHooks, type AgentFillRefusal } from './contents.js'
import { agentPageOf, isWindowKey } from './connection.js'
import type { AgentPage } from './page.js'

/**
 * エージェント窓のページに kypr / フォーム自動入力で値を入れてよいか（計画 2026-09-30「Claude のウィンドウで kypr」）。
 * 呼び出し側は `contents.ts` の口（`agentFillRefusal` など）を使う。ここは `startAgent` が差し込む実体。
 *
 * **Claude が `javascript_tool` を実行した document には入れない**（仕込まれた JS に値を拾わせない）。
 * 記録はページの isolated world（`agent-page-source.js` の `scriptRan`）に持つので、document が替われば消える。
 * `window.open` でつながったページは互いの DOM に触れる（同じオリジンなら）ので、
 * 実行したときに**opener でつながったページ全部**に記録を付け、入れるときは**opener をさかのぼって**確かめる。
 *
 * opener は**生まれた時点で記録する**（`noteAgentContentsCreated`）。生の `wc.opener` だけだと、Claude の JS が
 * `w.opener = null` でつながりを切っても `w` から子を触り続けられる。また、生まれた時点で開いた側が JS 実行済みなら、
 * 子は WebContents ごと入れない（開いた側が移動して記録が消えても、子に差し込まれたフックは残る）。
 */

/** opener をさかのぼる上限（循環の保険）。 */
const MAX_CHAIN = 16

/** 記録を付けられなかったページ（ダイアログ待ちなど）。document によらず、この WebContents には入れない。 */
const exposed = new WeakSet<WebContents>()

/** 生まれた時点の opener（`w.opener = null` で切られても残す）。 */
const birthOpener = new WeakMap<WebContents, WebContents>()

/** 生まれた時点の opener の確認がまだ終わっていないページ（終わるまで入れない）。 */
const pending = new WeakSet<WebContents>()

/** 検証用: 窓が key でなくても「ユーザーが窓にいる」とみなす（`NEMO_VERIFY_DIAGNOSTICS` の口からだけ）。 */
const forcedKey = new WeakSet<NemoWindow>()

function liveOpenerOf(wc: WebContents): WebContents | null {
  let frame: Electron.WebFrameMain | null
  try {
    frame = wc.opener
  } catch {
    return null
  }
  if (!frame) return null
  const contents = webContentsModule.fromFrame(frame)
  return contents && !contents.isDestroyed() && isAgentContents(contents) ? contents : null
}

/** 生まれた時点の opener を優先する（切られていても・生のものが無くても）。 */
function openerOf(wc: WebContents): WebContents | null {
  const born = birthOpener.get(wc)
  if (born && !born.isDestroyed()) return born
  const live = liveOpenerOf(wc)
  if (live && !birthOpener.has(wc)) birthOpener.set(wc, live)
  return live
}

/**
 * agent セッションの WebContents が生まれたとき（`startAgent` の `web-contents-created`）。opener を記録し、
 * 開いた側（とその先）が JS 実行済みなら、この WebContents には document によらず入れない。
 */
export function noteAgentContentsCreated(wc: WebContents): void {
  const record = (): boolean => {
    if (birthOpener.has(wc)) return true
    const opener = liveOpenerOf(wc)
    if (!opener) return false
    birthOpener.set(wc, opener)
    pending.add(wc)
    void refusal(opener)
      .then((refused) => {
        if (refused) {
          exposed.add(wc)
          log('agent.script_exposure_at_birth', { reason: refused })
        }
      })
      .finally(() => pending.delete(wc))
    return true
  }
  // popup の子は生成の時点で opener を持つ。持っていなければ最初の遷移でもう一度見る
  if (!record()) wc.once('did-start-navigation', () => void record())
}

/** 自分から opener をさかのぼった列（先頭が自分）。 */
function chainOf(wc: WebContents): WebContents[] {
  const chain = [wc]
  let current = wc
  for (let i = 0; i < MAX_CHAIN; i += 1) {
    const next = openerOf(current)
    if (!next || chain.includes(next)) break
    chain.push(next)
    current = next
  }
  return chain
}

/** 記録を付ける。`onlyIfClean` なら taint（ユーザーが秘密を入れた）の document には付けずに 'tainted'。 */
async function markPage(page: AgentPage | null, onlyIfClean = false): Promise<'ok' | 'tainted' | 'failed'> {
  if (!page) return 'failed'
  try {
    const result = await page.page<{ ok?: boolean; reason?: string }>('markScriptRan', onlyIfClean)
    if (result?.ok === true) return 'ok'
    return result?.reason === 'tainted' ? 'tainted' : 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * javascript_tool の**実行前に**呼ぶ。自分の document に記録を付けられなければ実行しない
 * （`tainted`: ユーザーが秘密を入れた document。taint の確認と記録を world の中で 1 回にまとめる）。
 * opener でつながったページ（開いた側・開かれた側）にも付け、付けられなかったものは `exposed` に入れる。
 */
export async function markScriptExposure(page: AgentPage): Promise<'ok' | 'tainted' | 'failed'> {
  const own = await markPage(page, true)
  if (own !== 'ok') return own
  const chain = chainOf(page.wc)
  const root = chain[chain.length - 1] ?? page.wc
  const related = webContentsModule
    .getAllWebContents()
    .filter(
      (contents) =>
        contents !== page.wc &&
        !contents.isDestroyed() &&
        isAgentContents(contents) &&
        chainOf(contents).includes(root)
    )
  let unmarked = 0
  await Promise.all(
    related.map(async (contents) => {
      if ((await markPage(agentPageOf(contents))) === 'ok') return
      exposed.add(contents)
      unmarked += 1
    })
  )
  if (related.length > 0) log('agent.script_exposure', { related: related.length, unmarked })
  return 'ok'
}

async function refusalOf(contents: WebContents): Promise<AgentFillRefusal | null> {
  if (exposed.has(contents)) return 'agent-script'
  if (pending.has(contents)) return 'agent-page'
  const page = agentPageOf(contents)
  if (!page) return 'agent-page'
  try {
    const state = await page.page<{ scriptRan?: boolean }>('state')
    return state?.scriptRan === true ? 'agent-script' : null
  } catch {
    return 'agent-page'
  }
}

async function refusal(wc: WebContents): Promise<AgentFillRefusal | null> {
  for (const contents of chainOf(wc)) {
    const refused = await refusalOf(contents)
    if (refused) return refused
  }
  return null
}

async function rememberSecrets(wc: WebContents, values: string[]): Promise<AgentFillRefusal | null> {
  // opener の側は入れる直前にもう一度確かめる（入口で見てから流し込むまでに Jev・Touch ID 等の待ちが挟まる）。
  // 自分の document は world の中で排他に確かめる（`rememberSecrets` が scriptRan なら断る）
  for (const contents of chainOf(wc).slice(1)) {
    const refused = await refusalOf(contents)
    if (refused) return refused
  }
  if (exposed.has(wc)) return 'agent-script'
  if (pending.has(wc)) return 'agent-page'
  const page = agentPageOf(wc)
  if (!page) return 'agent-page'
  try {
    const result = await page.page<{ ok?: boolean; reason?: string }>('rememberSecrets', values)
    if (result?.ok === true) return null
    return result?.reason === 'script' ? 'agent-script' : 'agent-page'
  } catch (error) {
    logError('agent.remember_secrets_failed', error, {})
    return 'agent-page'
  }
}

function userAtWindow(wc: WebContents): boolean {
  const found = findTabByWebContents(wc)
  if (!found || found.win.isDestroyed) return false
  return isWindowKey(found.win) || forcedKey.has(found.win)
}

async function prepareDebugger(wc: WebContents): Promise<boolean> {
  const page = agentPageOf(wc)
  if (!page) return false
  try {
    await page.readyDebugger()
    return true
  } catch (error) {
    logError('agent.debugger_prepare_failed', error, {})
    return false
  }
}

export const agentFillHooks: AgentFillHooks = { refusal, rememberSecrets, userAtWindow, prepareDebugger }

/** 検証用（`NEMO_VERIFY_DIAGNOSTICS=1` の IPC からだけ）。 */
export function setAgentKeyForVerify(win: NemoWindow, on: boolean): void {
  if (on) forcedKey.add(win)
  else forcedKey.delete(win)
}
