/**
 * kypr の模擬サーバー（自走検証用）。**本物の kypr の Worker（apps/api）と同じ応答の形**をメモリで返す。
 *
 * kypr は private リポジトリで Nemo の CI には無いので、Nemo の検証はこれに向ける
 * （本物との突き合わせは手元で kypr の Worker を 8797 番で立てて行う。VERIFY.md「kypr」）。
 *
 * API: prelogin / setup / login / logout / items の取得・作成・更新・ゴミ箱・復元・完全削除（409 / 410 / 401 / 429）
 * ほかに、自走検証のログインのテストページ（`/login.html` など）も同じサーバーから返す。
 *
 * 検証から触る口: `offline`（true なら接続をすぐ切る = サーバーに届かない）・`rejectAuth`（ログインを 401 にする）・
 * `kdfOverride`（prelogin の KDF パラメータを差し替える）・`requests`（受け取ったリクエストの記録）・
 * `passphraseHash`（合言葉の SHA-256(passphraseKey) の hex。null なら未設定で端末を確かめない）・
 * `devices`（端末トークンの SHA-256 → 端末。消せば取り消したのと同じ）
 *
 * 端末の登録と合言葉（kypr の `docs/crypto-spec.md`「端末の登録と合言葉」）: 合言葉が設定済みで端末トークンが無効なら、
 * passphraseKey が無ければ authKey を確かめる前に 401 `device-required`、あれば両方確かめて同じ 401 `bad-password`。
 * `register: true` なら端末を登録して `deviceToken` を返す
 */
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'

const b64 = (s) => Buffer.from(String(s ?? ''), 'base64')
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

export function createKyprMockServer({ pages = {} } = {}) {
  const state = {
    offline: false,
    rejectAuth: false,
    kdfOverride: null,
    account: null,
    revision: 0,
    /** @type {Map<string, {id: string, revision: number, data: unknown, deletedAt: string|null, purgedAt: string|null}>} */
    items: new Map(),
    tokens: new Set(),
    logins: 0,
    /** @type {string | null} */
    passphraseHash: null,
    /** @type {Map<string, {id: string, name: string}>} */
    devices: new Map(),
    /** 最後のログインの本文（送った値を確かめる） */
    lastLogin: null,
    /** @type {{ method: string, path: string, body: string }[]} */
    requests: []
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra })

  const register = (name) => {
    const id = randomUUID()
    const token = randomUUID()
    state.devices.set(sha256Hex(token), { id, name: String(name ?? '') })
    return { id, token }
  }

  const mutate = (res, id, body, apply) => {
    const it = state.items.get(id)
    if (!it) return fail(res, 404, 'not-found')
    if (it.purgedAt !== null) return fail(res, 410, 'purged')
    const copy = { ...it }
    if (it.revision !== body.baseRevision || !apply(copy))
      return send(res, 409, { error: 'conflict', item: it })
    state.revision += 1
    const next = { ...it, revision: state.revision }
    apply(next)
    state.items.set(id, next)
    return send(res, 200, { item: next })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (state.offline && url.pathname.startsWith('/api/')) {
      // 接続を切る（fetch は失敗する = サーバーに届かない）
      req.socket.destroy()
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      const page = pages[url.pathname]
      if (!page) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(typeof page === 'function' ? page(req, server) : page)
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      state.requests.push({ method: req.method, path: url.pathname + url.search, body: raw })
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return fail(res, 400, 'bad-json')
      }
      const p = url.pathname
      if (p === '/api/prelogin' && req.method === 'GET') {
        if (!state.account) return fail(res, 404, 'no-account')
        return send(res, 200, { kdf: state.kdfOverride ?? state.account.kdf })
      }
      if (p === '/api/setup' && req.method === 'POST') {
        if (state.account) return fail(res, 403, 'registration-closed')
        state.account = {
          kdf: body.kdf,
          authHash: sha256Hex(b64(body.authKey)),
          wrappedVaultKey: body.wrappedVaultKey
        }
        const token = randomUUID()
        state.tokens.add(token)
        const device = register(body.deviceName)
        return send(res, 201, {
          token,
          wrappedVaultKey: state.account.wrappedVaultKey,
          deviceId: device.id,
          deviceToken: device.token
        })
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (!state.account) return fail(res, 404, 'no-account')
        state.lastLogin = body
        const device =
          typeof body.deviceToken === 'string' ? state.devices.get(sha256Hex(body.deviceToken)) : undefined
        const needPassphrase = state.passphraseHash !== null && !device
        if (needPassphrase && body.passphraseKey === undefined) return fail(res, 401, 'device-required')
        if (state.rejectAuth || sha256Hex(b64(body.authKey)) !== state.account.authHash)
          return fail(res, 401, 'bad-password')
        if (needPassphrase && sha256Hex(b64(body.passphraseKey)) !== state.passphraseHash)
          return fail(res, 401, 'bad-password')
        state.logins += 1
        const token = randomUUID()
        state.tokens.add(token)
        let deviceId = device?.id ?? null
        let deviceToken
        if (!device && body.register === true) {
          const registered = register(body.deviceName)
          deviceId = registered.id
          deviceToken = registered.token
        }
        return send(res, 200, {
          token,
          wrappedVaultKey: state.account.wrappedVaultKey,
          deviceId,
          deviceToken
        })
      }
      if (p === '/api/logout') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        state.tokens.delete(token)
        return send(res, 200, { ok: true })
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!state.tokens.has(token)) return fail(res, 401, 'unauthorized')

      if (p === '/api/items' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0')
        const items = [...state.items.values()]
          .filter((it) => it.revision > since)
          .sort((a, b) => a.revision - b.revision)
        return send(res, 200, { revision: state.revision, items })
      }
      if (p === '/api/items' && req.method === 'POST') {
        for (const it of body.items ?? []) {
          const ex = state.items.get(it.id)
          if (ex?.purgedAt) return fail(res, 410, 'purged')
          if (ex) return fail(res, 409, 'exists')
        }
        const created = (body.items ?? []).map((it) => {
          state.revision += 1
          const w = { id: it.id, revision: state.revision, data: it.data, deletedAt: null, purgedAt: null }
          state.items.set(it.id, w)
          return w
        })
        return send(res, 201, { revision: state.revision, items: created })
      }
      const m = /^\/api\/items\/([^/]+)(?:\/(trash|restore|purge))?$/.exec(p)
      if (m) {
        const [, id, action] = m
        const now = new Date().toISOString()
        if (!action && req.method === 'PUT')
          return mutate(res, id, body, (it) => ((it.data = body.data), true))
        if (action === 'trash')
          return mutate(res, id, body, (it) => it.deletedAt === null && ((it.deletedAt = now), true))
        if (action === 'restore')
          return mutate(res, id, body, (it) => it.deletedAt !== null && ((it.deletedAt = null), true))
        if (action === 'purge')
          return mutate(
            res,
            id,
            body,
            (it) => it.deletedAt !== null && ((it.data = null), (it.purgedAt = now), true)
          )
      }
      return fail(res, 404, 'not-found')
    })
  })

  return {
    state,
    server,
    /** サーバーを巻き戻す（Time Travel での復元のつもり）。この revision より後の行は無かったことにする */
    rollback(revision) {
      state.revision = revision
      for (const [id, it] of state.items) if (it.revision > revision) state.items.delete(id)
    },
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}
