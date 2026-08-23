/**
 * CDP の最小クライアント。
 * 自走検証（`verify-phase1.mjs` / `verify-spike.mjs`）から使う。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function listTargets(cdp) {
  return await (await fetch(`${cdp}/json/list`)).json()
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return {
    events,
    send,
    close: () => ws.close(),
    /** ページ内で式を評価して値を返す。例外は Error にして投げる。 */
    async ev(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      const details = r.result?.exceptionDetails
      if (details) {
        throw new Error(details.exception?.description ?? details.text ?? 'eval failed')
      }
      return r.result?.result?.value
    }
  }
}

/** URL の一部が一致する target につなぐ。見つかるまで待つ。 */
export async function connectTo(cdp, urlPart, { timeoutMs = 15000, type = null } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await listTargets(cdp)
    const found = targets.find((t) => (type ? t.type === type : true) && t.url.includes(urlPart))
    if (found) return connect(found.webSocketDebuggerUrl)
    if (Date.now() > deadline) {
      throw new Error(
        `target が見つからない: ${urlPart}\n  ある target: ${targets.map((t) => `${t.type} ${t.url}`).join('\n              ')}`
      )
    }
    await sleep(300)
  }
}

/**
 * ブラウザ UI（サイドバー）に繋ぎ、`window.nemo` が生えるまで待つ。
 *
 * target は `nemo://ui/` のロードが始まった時点で現れるので、
 * つないだ直後に評価すると **実行コンテキストがまだ無く `undefined` が返る**
 * （`JSON.parse(undefined)` で落ちて原因が分かりにくい。CI で踏んだ）。
 */
export async function connectUi(cdp, view = 'sidebar', options = {}) {
  const session = await connectTo(cdp, `view=${view}`, options)
  await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''", {
    timeoutMs: options.timeoutMs ?? 15000
  })
  return session
}

/** 条件が満たされるまで ev を繰り返す。 */
export async function waitFor(session, expression, { timeoutMs = 10000, interval = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await session.ev(expression)
    if (last) return last
    await sleep(interval)
  }
  throw new Error(`条件が満たされなかった: ${expression}（最後の値: ${JSON.stringify(last)}）`)
}
