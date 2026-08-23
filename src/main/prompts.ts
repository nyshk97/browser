import { randomUUID } from 'node:crypto'
import { log } from './log.js'
import type { Prompt, PromptAnswer } from '../shared/types.js'

/**
 * ブラウザ UI に出すダイアログ（権限要求 / HTTP 認証 / 証明書エラー / 外部 protocol）。
 *
 * ネイティブの `dialog.showMessageBox` を使わずブラウザ UI 側に出す:
 * - 見た目を Nemo に揃えられる
 * - **自走検証で CDP から答えられる**（ネイティブダイアログは CDP から触れず、
 *   自動検証が「人間が押すまで止まる」形になってしまう）
 *
 * ウィンドウごとに1つずつ順番に出す（同時に複数出すと、どれに答えたのか分からなくなる）。
 */

/**
 * union に対する Omit は分配されないので、明示的に分配する。
 * （`Omit<Prompt, 'id'>` だと各分岐の固有フィールドが消える）
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** `id` は ask 側で採番する。 */
export type PromptRequest = DistributiveOmit<Prompt, 'id'>

interface Pending {
  prompt: Prompt
  resolve: (answer: PromptAnswer | null) => void
}

const queues = new Map<number, Pending[]>()

type Notifier = (windowId: number, prompt: Prompt | null) => void
let notify: Notifier = () => {}

export function setPromptNotifier(notifier: Notifier): void {
  notify = notifier
}

export function currentPrompt(windowId: number): Prompt | null {
  return queues.get(windowId)?.[0]?.prompt ?? null
}

/**
 * ダイアログを出して答えを待つ。
 * ウィンドウが閉じられたら null で解決する（呼び出し側は「拒否」に倒す）。
 */
export function ask(windowId: number, prompt: PromptRequest): Promise<PromptAnswer | null> {
  return new Promise((resolve) => {
    const queue = queues.get(windowId) ?? []
    const full = { ...prompt, id: randomUUID() } as Prompt
    queue.push({ prompt: full, resolve })
    queues.set(windowId, queue)
    log('prompt.opened', { windowId, kind: full.type })
    if (queue.length === 1) notify(windowId, full)
  })
}

export function answerPrompt(windowId: number, id: string, answer: PromptAnswer): boolean {
  const queue = queues.get(windowId)
  if (!queue || queue.length === 0) return false
  // 先頭以外への回答は受け付けない（UI には先頭しか出していない）
  if (queue[0].prompt.id !== id) {
    log('prompt.rejected', { windowId, reason: 'not_current' })
    return false
  }
  const [pending] = queue.splice(0, 1)
  log('prompt.answered', { windowId, kind: pending.prompt.type })
  pending.resolve(answer)
  notify(windowId, queue[0]?.prompt ?? null)
  return true
}

/** ウィンドウが閉じたら、残っている要求をすべて拒否として解決する。 */
export function cancelPrompts(windowId: number): void {
  const queue = queues.get(windowId)
  queues.delete(windowId)
  for (const pending of queue ?? []) pending.resolve(null)
}
