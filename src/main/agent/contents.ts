import { session, type WebContents } from 'electron'
import { AGENT_PARTITION } from '../paths.js'

/**
 * エージェント用ウィンドウ（`persist:nemo-agent`）のページか。
 *
 * registry を import できない場所（自動入力・debugger を使う側）から判定するための口。
 * `session.fromPartition` は同じ partition に同じ Session を返す（Electron がキャッシュする）。
 */
export function isAgentContents(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false
  return contents.session === session.fromPartition(AGENT_PARTITION)
}

/**
 * エージェント窓のページに kypr / フォーム自動入力で値を入れるときの口（計画 2026-09-30「Claude のウィンドウで kypr」）。
 *
 * 実体は `agent/fill-gate.ts`（registry と connection に触る）。kypr・自動入力・右クリックのメニューは
 * registry → context-menu → autofill の import の下にいるので、agent の本体を直接 import すると循環する。
 * だからここ（registry を import しない）に口だけ置き、`startAgent` が実体を差し込む。
 * **差し込まれていなければ入れない側に倒す**（fail-closed）。
 *
 * - `agent-script`: その document（か、opener でつながったページ）で Claude が `javascript_tool` を実行した
 * - `agent-page`: ページの状態を確かめられない（ダイアログ待ち・読み込み中など）
 */
export type AgentFillRefusal = 'agent-script' | 'agent-page'

/**
 * ページからのクリップボードへの書き込み（`writeText` / `execCommand('copy')`）を断る理由（計画 2026-10-16「ユーザーが押したコピーボタン」）。
 *
 * - `user-absent`: ユーザーの番でも、ユーザーがウィンドウにいるのでもない（タブに載っていない popup の子もここ）
 * - `agent-input`: Claude のマウス・キーを送っている最中
 * - `no-recent-input`: 直近にそのページへの実入力（実マウスの mouseDown・実キーの keyDown）が無い（ページのタイマー等）
 * - `agent-script` / `agent-page`: `AgentFillRefusal` と同じ（Claude が javascript_tool を実行した document 等）
 */
export type AgentClipboardRefusal = AgentFillRefusal | 'user-absent' | 'agent-input' | 'no-recent-input'

export interface AgentFillHooks {
  refusal(wc: WebContents): Promise<AgentFillRefusal | null>
  clipboardRefusal(wc: WebContents): Promise<AgentClipboardRefusal | null>
  clipboardRefusalNow(wc: WebContents): AgentClipboardRefusal | null
  rememberSecrets(wc: WebContents, values: string[]): Promise<AgentFillRefusal | null>
  userAtWindow(wc: WebContents): boolean
  prepareDebugger(wc: WebContents): Promise<boolean>
}

let hooks: AgentFillHooks | null = null

export function setAgentFillHooks(next: AgentFillHooks): void {
  hooks = next
}

/** 入れてはいけない理由（エージェント窓でなければ常に null）。 */
export async function agentFillRefusal(wc: WebContents): Promise<AgentFillRefusal | null> {
  if (!isAgentContents(wc)) return null
  return hooks ? hooks.refusal(wc) : 'agent-page'
}

/**
 * ページがクリップボードに書いてよいか（エージェント窓のページのとき）。null なら書いてよい。
 * 権限の要求（`writeText`）と `execCommand('copy')` のガードの開け閉めが**同じ判定**を使う。
 * フックが差し込まれていなければ断る（fail-closed）。
 */
export async function agentClipboardRefusal(wc: WebContents): Promise<AgentClipboardRefusal | null> {
  return hooks ? hooks.clipboardRefusal(wc) : 'agent-page'
}

/** `agentClipboardRefusal` のうち同期で判定できる条件だけ（ガードを開ける知らせを送る直前に引き直す）。 */
export function agentClipboardRefusalNow(wc: WebContents): AgentClipboardRefusal | null {
  return hooks ? hooks.clipboardRefusalNow(wc) : 'agent-page'
}

/**
 * 入れる**直前に**、伏せる値をページ（isolated world）に覚えさせる。ページは taint され javascript_tool を断る。
 * Claude が JS を実行した document ならここでも断る（入口の `agentFillRefusal` から流し込むまでの間に実行されうる。
 * 確認と taint は world の中で排他）。エージェント窓でなければ何もせず null。**null 以外なら入れない**。
 */
export async function rememberAgentSecrets(
  wc: WebContents,
  values: string[]
): Promise<AgentFillRefusal | null> {
  if (!isAgentContents(wc)) return null
  return hooks ? hooks.rememberSecrets(wc, values) : 'agent-page'
}

/**
 * ユーザーがいまその窓を操作している（窓が key）。ページ起点の入口（欄の下の候補・右クリック・⌘⇧L）は
 * これが true のときだけ受ける（Claude の CDP のクリック・右クリック・キーで出さない）。エージェント窓でなければ true。
 */
export function agentUserAtWindow(wc: WebContents): boolean {
  if (!isAgentContents(wc)) return true
  return hooks?.userAtWindow(wc) ?? false
}

/**
 * iframe に CDP で入る前に、agent の debugger を付けておく（`frame-runner` に attach / detach させない。
 * 先に付けられると、後片付けの detach で agent の debugger ごと外れる）。エージェント窓でなければ true。
 */
export async function prepareAgentDebugger(wc: WebContents): Promise<boolean> {
  if (!isAgentContents(wc)) return true
  return hooks ? hooks.prepareDebugger(wc) : false
}
