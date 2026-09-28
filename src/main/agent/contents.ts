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
