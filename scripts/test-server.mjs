#!/usr/bin/env node
/**
 * Phase 0 の受け入れテスト用のローカルサーバ。
 * Bitwarden の自動入力は http://localhost でも動くが、実サイトに近い条件で見たいので
 * 既定は 127.0.0.1:8787 で配信する。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-pages')
const port = Number(process.env.PORT ?? 8787)

// 「自分が起動したサーバか」を検証側が確かめられるようにする
const MARKER_PATH = '/__nemo_test_pages__'
/** ダウンロードの検証用。Content-Disposition を付けて必ずダウンロードにする。 */
const DOWNLOAD_PATH = '/__nemo_download__'
/**
 * スーパーリロード（キャッシュ無視）の検証用。
 *
 * 長い max-age を付けたサブリソースを返し、**取りに来た回数**を数える。
 * 普通の再読み込みではキャッシュから使われて増えず、キャッシュ無視なら増える。
 * メインリソースは再読み込みで必ず再検証されるので、差が出るのはサブリソースの方。
 */
const CACHE_ASSET_PATH = '/__nemo_cached_asset__'
const CACHE_COUNT_PATH = '/__nemo_cache_count__'
let cachedAssetHits = 0
/**
 * Peek の検証用。**POST の body をそのままページに書き戻す**。
 *
 * `<form method="POST" target="_blank">` が Peek 側に届いているかを見るためのもの。
 * popup を「deny して URL だけ作り直す」実装だと body が落ちるので、ここが空になる。
 */
const ECHO_PATH = '/__nemo_echo__'
/**
 * ナビゲーション判定の検証用。**サーバ側 302** で `?to=` の URL へ飛ばす。
 *
 * `location.href = ...` だと `will-frame-navigate` しか踏まないので、
 * `will-redirect` のトップフレーム側（拡張ページへリダイレクトさせる経路）を
 * 塞げているかを確かめられない。
 */
const REDIRECT_PATH = '/__nemo_redirect__'
/**
 * Peek のプレースホルダー検証用。**応答を握ったまま止める門**。
 *
 * `?id=<印>` で開くと、`/__nemo_gate_release__?id=<印>` を叩くまで**1バイトも返さない**。
 * ページが一度も描画されない状態を検証側の都合で好きなだけ保てるので、
 * 「まだ描いていない Peek の矩形」を撮れる。
 *
 * **固定の `sleep` で代用しない**。`screencapture` や CDP が遅れると応答後を撮ってしまい、
 * 「速いマシンでだけ落ちる検査」になる。到達を `/__nemo_gate_state__` で確かめてから撮り、
 * 撮り終えてから解放する。
 */
const GATE_PATH = '/__nemo_gate__'
const GATE_STATE_PATH = '/__nemo_gate_state__'
const GATE_RELEASE_PATH = '/__nemo_gate_release__'
/** 印ごとの、握ったままの `res`。 */
const gateHeld = new Map()
/** 印ごとの到達回数。**解放後も残す**（撮影の後に数え直せるように）。 */
const gateArrived = new Map()

/**
 * HTTP Basic 認証の自走検証用。
 *
 * `/__nemo_basic_auth__/<tag>?user=<u>&pass=<p>` に `Authorization` が一致しなければ
 * `401` + `WWW-Authenticate: Basic realm="..."`、一致すれば `200`。
 *
 * **パスに tag を持たせる**のが要点で、クエリ文字列だと正規表現の `?` を
 * エスケープしなければならず、テスト用パターンが読めなくなる。
 * 「同じ origin / realm で勝つルールが違う URL」を作るのにも path が要る。
 *
 * 受け取った `Authorization` は `/__nemo_auth_log__` から読める
 * （**送信回数だけでなく宛先違いも見る**ため、中身ごと残す）。
 */
const AUTH_PREFIX = '/__nemo_basic_auth__/'
/** 保護されたサブリソースを持つページ。 */
const AUTH_PAGE_PATH = '/__nemo_auth_page__'
const AUTH_LOG_PATH = '/__nemo_auth_log__'
const AUTH_RESET_PATH = '/__nemo_auth_reset__'
/** 接続ごと落とす（メインフレームの `did-fail-load` を作る）。 */
const ABORT_PATH = '/__nemo_abort__'
/** 204 を返してナビゲーションだけ中断させる（元のページは残る）。 */
const NO_CONTENT_PATH = '/__nemo_no_content__'
/** @type {{tag: string, path: string, authorization: string}[]} */
const authLog = []

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (url.pathname === MARKER_PATH) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`nemo-test-pages ${process.pid}`)
    return
  }
  if (url.pathname === DOWNLOAD_PATH) {
    const body = Buffer.alloc(64 * 1024, 'n')
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'content-disposition': 'attachment; filename="nemo-verify.bin"'
    })
    res.end(body)
    return
  }

  if (url.pathname === CACHE_ASSET_PATH) {
    cachedAssetHits += 1
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=600'
    })
    res.end(`window.__nemoCachedAsset = ${cachedAssetHits}\n`)
    return
  }
  if (url.pathname === CACHE_COUNT_PATH) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ hits: cachedAssetHits }))
    return
  }

  if (url.pathname === GATE_PATH) {
    const id = url.searchParams.get('id') ?? 'default'
    gateArrived.set(id, (gateArrived.get(id) ?? 0) + 1)
    const held = gateHeld.get(id) ?? []
    held.push(res)
    gateHeld.set(id, held)
    // ページ側が閉じた（Peek を閉じた・再読み込みした）ぶんは持ち続けない。
    // **`req` ではなく `res` を見る**。`req` の `close` は「本文を読み切った」でも出るので、
    // Node の版によっては GET が届いた直後に外れて、解放できない握りになる。
    res.on('close', () => {
      if (res.writableEnded) return
      const list = gateHeld.get(id)
      if (!list) return
      const index = list.indexOf(res)
      if (index !== -1) list.splice(index, 1)
    })
    return
  }
  if (url.pathname === GATE_STATE_PATH) {
    const id = url.searchParams.get('id') ?? 'default'
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ arrived: gateArrived.get(id) ?? 0, held: (gateHeld.get(id) ?? []).length }))
    return
  }
  if (url.pathname === GATE_RELEASE_PATH) {
    const id = url.searchParams.get('id') ?? 'default'
    const held = gateHeld.get(id) ?? []
    gateHeld.set(id, [])
    for (const target of held) {
      target.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      // 解放後は**白一色**にする。プレースホルダー（暗い面）と確実に見分けられる
      target.end(
        `<!doctype html><meta charset="utf-8"><title>gate</title>` +
          `<style>html,body{margin:0;height:100%;background:#fff}</style><h1 id="gate">released</h1>`
      )
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ released: held.length }))
    return
  }

  if (url.pathname.startsWith(AUTH_PREFIX)) {
    const tag = url.pathname.slice(AUTH_PREFIX.length)
    const user = url.searchParams.get('user') ?? 'u'
    const pass = url.searchParams.get('pass') ?? 'p'
    const realm = url.searchParams.get('realm') ?? 'Nemo Test'
    const delay = Number(url.searchParams.get('delay') ?? 0)
    const header = req.headers.authorization ?? ''
    authLog.push({ tag, path: url.pathname + url.search, authorization: header })
    const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
    const send = () => {
      if (header === expected) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`nemo-basic-auth ok ${tag}`)
        return
      }
      res.writeHead(401, {
        'www-authenticate': `Basic realm="${realm}"`,
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end('unauthorized')
    }
    // **遅らせるのは資格情報が載っているリクエストだけ**。最初の 401 まで遅らせると、
    // 「自動入力を送ったあと応答が来ない」を作るのに毎回その遅延を待つことになる
    if (delay > 0 && header.length > 0) setTimeout(send, delay)
    else send()
    return
  }

  if (url.pathname === AUTH_PAGE_PATH) {
    // `?tags=a,b` の数だけ保護されたサブリソースを踏むページ。
    // `?origin=` を付けるとクロスオリジンのサブリソースになる。
    const tags = (url.searchParams.get('tags') ?? '').split(',').filter(Boolean)
    const user = url.searchParams.get('user') ?? 'u'
    const pass = url.searchParams.get('pass') ?? 'p'
    const realm = url.searchParams.get('realm') ?? 'Nemo Test'
    const origin = url.searchParams.get('origin') ?? ''
    const delay = url.searchParams.get('delay') ?? ''
    const query =
      `user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}&realm=${encodeURIComponent(realm)}` +
      (delay ? `&delay=${encodeURIComponent(delay)}` : '')
    const sources = tags.map((tag) => `${origin}${AUTH_PREFIX}${tag}?${query}`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(
      `<!doctype html><meta charset="utf-8"><title>auth page</title><h1>auth page</h1>` +
        // **同時に投げる**（並列に飛ぶ 401 を作るため）。結果は本文に書き出す
        `<pre id="result">pending</pre><script>
          const sources = ${JSON.stringify(sources)}
          Promise.all(sources.map((src) => fetch(src).then((r) => r.status).catch(() => 'error')))
            .then((codes) => { document.getElementById('result').textContent = codes.join(',') })
        </script>`
    )
    return
  }

  if (url.pathname === NO_CONTENT_PATH) {
    // **204 はナビゲーションを中断させるが、元のページはそのまま残る**。
    // 接続断（`__nemo_abort__`）だとエラーページに置き換わり、
    // 「遷移に失敗して元のページに留まった」状態が作れない。
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
    return
  }

  if (url.pathname === ABORT_PATH) {
    // **接続ごと落とす**（404 では `did-fail-load` にならない）。
    // 「クロスオリジンへの遷移が失敗した直後」の検証に要る。
    req.socket.destroy()
    return
  }

  if (url.pathname === AUTH_LOG_PATH) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ entries: authLog }))
    return
  }

  if (url.pathname === AUTH_RESET_PATH) {
    authLog.length = 0
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('reset')
    return
  }

  if (url.pathname === REDIRECT_PATH) {
    const to = url.searchParams.get('to')
    if (!to) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('to= がない')
      return
    }
    res.writeHead(302, { location: to, 'cache-control': 'no-store' })
    res.end()
    return
  }

  if (url.pathname === ECHO_PATH) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>echo</title>` +
          `<h1>echo</h1><pre id="method">${req.method}</pre><pre id="body">${body.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`
      )
    })
    return
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname
  const filePath = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))

  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': types[path.extname(filePath)] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(filePath))
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // 既存サーバを黙って使うと「別プロセスを検証して PASS」になる。
    // dev で明示的に許可したときだけ見逃す。
    if (process.env.NEMO_TEST_PAGES_ALLOW_EXISTING === '1') {
      console.log(`[test-server] ポート ${port} は既に使われている（既存サーバをそのまま使う）`)
      process.exit(0)
    }
    console.error(`[test-server] ポート ${port} は既に使われている`)
    process.exit(1)
  }
  throw error
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[test-server] http://127.0.0.1:${port}/`)
})

/** 自分が起動したサーバかを検証側が確かめるための印。 */
export const SERVER_MARKER = 'nemo-test-pages'
