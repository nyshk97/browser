import { protocol, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { UI_ORIGIN, UI_SCHEME, rendererDir } from './paths.js'
import { log, logError } from './log.js'

/**
 * ブラウザ UI は `file://` ではなく制限付きの custom protocol で配信する。
 *
 * `file://` で配信すると、UI に穴が空いたときにローカルファイル全体が読める。
 * `nemo://ui/` は **rendererDir の中しか返さない**ので、そこが構造的に塞がる。
 *
 * `standard: true` … 正しい origin を持たせる（`nemo://ui`）
 * `secure: true`   … secure context にする（`crypto.subtle` 等が使える）
 * `bypassCSP: false` … UI 自身の CSP を必ず効かせる
 */
export function registerUiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: UI_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: false,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

/**
 * `nemo://ui/...` を配信する。
 *
 * 開発時（`ELECTRON_RENDERER_URL` あり）は Vite の dev server に中継する。
 * dev だけ `http://localhost:5173` を直接読む作りにすると、
 * **origin と CSP が本番と変わってしまい、UI の穴が dev では見えない**。
 * 同じ `nemo://ui` origin を通すことで、経路を1本に保つ。
 */
export function handleUiScheme(session: Electron.Session): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']

  session.protocol.handle(UI_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'ui') {
      log('protocol.rejected', { reason: 'unknown_host' })
      return new Response('not found', { status: 404 })
    }

    if (devUrl) {
      // dev server への中継。middleware 経由なので Vite の HMR もそのまま通る。
      //
      // ヘッダは丸ごと転送しない。`Host` / `Origin` をそのまま渡すと
      // dev server 側で弾かれ、`net.fetch` が `ERR_FAILED` で落ちる。
      // GET / HEAD に body を付けるのも同じく失敗するので、必要なときだけ付ける。
      const target = new URL(url.pathname + url.search, devUrl)
      const headers = new Headers()
      for (const name of ['accept', 'accept-language', 'cache-control', 'content-type']) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
      }
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      try {
        return await net.fetch(target.toString(), {
          method: request.method,
          headers,
          ...(hasBody ? { body: request.body, duplex: 'half' } : {})
        })
      } catch (error) {
        logError('protocol.dev_proxy_failed', error, { path: url.pathname })
        return new Response('dev server unreachable', { status: 502 })
      }
    }

    let resolved: string
    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const root = path.resolve(rendererDir)
      // まず語彙的に閉じ込め（`..` を潰す）、そのうえで実体パスでも確認する（symlink 対策）。
      // realpath は存在しないパスで投げるので、判定は必ず try の中で行う。
      const lexical = path.resolve(root, relative || 'index.html')
      if (lexical !== root && !lexical.startsWith(root + path.sep)) {
        log('protocol.rejected', { reason: 'outside_root' })
        return new Response('forbidden', { status: 403 })
      }
      resolved = fs.realpathSync.native(lexical)
      const realRoot = fs.realpathSync.native(root)
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
        log('protocol.rejected', { reason: 'symlink_escape' })
        return new Response('forbidden', { status: 403 })
      }
    } catch {
      return new Response('not found', { status: 404 })
    }

    try {
      const body = await fs.promises.readFile(resolved)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  log('protocol.registered', { origin: UI_ORIGIN, dev: Boolean(devUrl) })
}
