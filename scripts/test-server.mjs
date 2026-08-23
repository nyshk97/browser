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
