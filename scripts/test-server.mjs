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
