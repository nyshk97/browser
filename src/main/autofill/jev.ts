import { app } from 'electron'
import { log } from '../log.js'

/**
 * Jev（TypeSafe AI の判定特化モデル）を呼ぶ。
 *
 * **SDK を入れずに `fetch` で叩く**（body は小さく形が決まっている。モックへの差し替えも URL だけで済む）。
 * 仕様は plan の Phase 0 のログ（`POST /v1/systemone`・401 / 422 / 429 / 529）。
 *
 * 右クリックから待たせる処理なので、**全体の締め切りを決めて、それを越えたら諦める**
 * （Jev が遅い / 落ちているときも、ルールで決まった欄は入れる。呼び出し側がそう組んでいる）。
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** 全体の締め切り。実測は 0.3〜0.6 秒（37 欄）。再試行 1 回ぶんの余裕を取る。 */
const DEADLINE_MS = 3000

/**
 * 呼び先。**`NEMO_JEV_TEST_ENDPOINT` はパッケージ版では無視する**
 * （env を付けて起動したパッケージ版から、キーを任意のサーバへ送らせないため）。
 */
export function jevEndpoint(): string {
  const override = process.env['NEMO_JEV_TEST_ENDPOINT']
  if (override && !app.isPackaged) return override
  return ENDPOINT
}

export type JevResult =
  | { ok: true; answers: unknown; ms: number }
  | { ok: false; kind: 'http'; status: number; ms: number }
  | { ok: false; kind: 'timeout' | 'network' | 'bad-response'; ms: number }

/**
 * 1 リクエスト投げる。429 / 529 は `retry-after`（無ければ 300ms）を見て 1 回だけ再試行する。
 * **例外は投げない**（呼び出し側は失敗の種類をログに出して、Jev の分を諦めるだけ）。
 */
export async function askJev(key: string, body: Record<string, unknown>): Promise<JevResult> {
  const started = Date.now()
  const deadline = started + DEADLINE_MS
  const elapsed = (): number => Date.now() - started

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, kind: 'timeout', ms: elapsed() }
    let response: Response
    try {
      response = await fetch(jevEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining)
      })
    } catch (error) {
      const name = (error as Error).name
      return {
        ok: false,
        kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
        ms: elapsed()
      }
    }

    if ((response.status === 429 || response.status === 529) && attempt === 0) {
      const wait = retryAfterMs(response.headers.get('retry-after'))
      if (Date.now() + wait >= deadline)
        return { ok: false, kind: 'http', status: response.status, ms: elapsed() }
      log('autofill.jev_retry', { status: response.status, waitMs: wait })
      await new Promise((resolve) => setTimeout(resolve, wait))
      continue
    }
    if (!response.ok) return { ok: false, kind: 'http', status: response.status, ms: elapsed() }

    try {
      const json: unknown = await response.json()
      if (typeof json !== 'object' || json === null || !('answers' in json)) {
        return { ok: false, kind: 'bad-response', ms: elapsed() }
      }
      return { ok: true, answers: json.answers, ms: elapsed() }
    } catch {
      return { ok: false, kind: 'bad-response', ms: elapsed() }
    }
  }
  return { ok: false, kind: 'timeout', ms: elapsed() }
}

function retryAfterMs(header: string | null): number {
  // 無い・空・HTTP-date は 300ms（`Number(null)` / `Number('')` は 0 なので先に弾く）
  if (!header || !/^\d+(\.\d+)?$/.test(header.trim())) return 300
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, DEADLINE_MS)
  return 300
}
