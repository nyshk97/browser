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
export async function connectTo(cdp, urlPart, { timeoutMs = 15000, type = null, exclude = null } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await listTargets(cdp)
    const found = targets.find(
      (t) =>
        (type ? t.type === type : true) && t.url.includes(urlPart) && !(exclude && t.url.includes(exclude))
    )
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
  // シークレットウィンドウの UI も `view=sidebar` を持つ。
  // 素直に先頭を拾うと、検証が**シークレットウィンドウを操作してしまう**
  // （そこで作ったタブはセッションに保存されないので、後の復元検証が落ちる。実際に踏んだ）。
  // 明示的に欲しいときは `includePrivate: true` を渡す。
  // `urlPart` を渡すと、そちらで target を選ぶ
  // （`?view=toolbar&window=1&pane=right` のように `view=` の直後に別のパラメータが
  // 挟まる URL は `view=toolbar&pane=right` では一致しないため）。
  const session = await connectTo(cdp, options.urlPart ?? `view=${view}`, {
    exclude: options.includePrivate ? null : 'private=1',
    ...options
  })
  const timeoutMs = options.timeoutMs ?? 30000
  await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''", {
    timeoutMs
  })
  // **アプリの初期化完了まで待つ**。
  // 起動時のタブは UI のロード完了後に作られるので、ここを待たないと
  // registry が空の状態を読んでしまう（実際に間欠的な FAIL になった）。
  if (options.waitReady !== false) {
    await waitFor(session, "window.nemo.getAppStatus().then((s) => (s.ready ? 'ready' : ''))", {
      timeoutMs
    })
  }
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
