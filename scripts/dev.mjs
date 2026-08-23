#!/usr/bin/env node
/**
 * 開発版 Nemo を起動する。
 *
 *   mise run dev            HMR あり（electron-vite dev）
 *   mise run dev:nodebug    remote debugging を開けない（実 Vault を入れて触るとき）
 *   mise run dev:popup      拡張 popup の DevTools を自動で開く（popup の不具合を追うとき）
 *   mise run dev:build      ビルドしてから起動（本番に近い経路で確認したいとき）
 *
 * どちらも:
 * - 起動前に拡張が lock と一致しているか検証する（ズレたまま動かさない）
 * - 受け入れテスト用のページサーバ（http://127.0.0.1:8787/）を一緒に立てる
 * - remote debugging を 9333 で開ける（dev 限定。常用版では開かない）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const useBuilt = process.argv.includes('--built')
const noDebug = process.argv.includes('--no-debug')
const popupDevTools = process.argv.includes('--popup-devtools')
const debugPort = noDebug ? null : (process.env.NEMO_REMOTE_DEBUGGING_PORT ?? '9333')
const pagesPort = process.env.NEMO_TEST_PAGES_PORT ?? '8787'

/** @type {import('node:child_process').ChildProcess[]} */
const children = []

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options
  })
  children.push(child)
  return child
}

function runToCompletion(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
    child.on('error', reject)
  })
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// 1. 拡張が lock と一致しているか（展開後のツリー hash まで）
try {
  await runToCompletion(process.execPath, ['scripts/ext-verify.mjs'])
} catch {
  console.error('\n[dev] 拡張が lock と一致していない。`mise run ext:fetch` を実行してから起動する。')
  process.exit(1)
}

// 2. 受け入れテスト用のページサーバ
run(process.execPath, ['scripts/test-server.mjs'], {
  // dev では既に立っているサーバをそのまま使ってよい
  env: { ...process.env, PORT: pagesPort, NEMO_TEST_PAGES_ALLOW_EXISTING: '1' }
})

// 3. アプリ本体
const env = { ...process.env }
if (popupDevTools) env.NEMO_POPUP_DEVTOOLS = '1'
if (debugPort) {
  env.NEMO_REMOTE_DEBUGGING_PORT = debugPort
} else {
  // remote debugging を開けない。実 Vault の Bitwarden を入れて触るときはこちらを使う。
  // CDP が開いていると、そこに到達できるものは拡張の service worker で任意の JS を実行でき、
  // アンロック済み Vault の中身に手が届く（自走検証はまさにそれを使っている）。
  delete env.NEMO_REMOTE_DEBUGGING_PORT
}

let app
if (useBuilt) {
  await runToCompletion('pnpm', ['exec', 'electron-vite', 'build'])
  const electronPath = require('electron')
  app = run(electronPath, ['out/main/index.js'], { env })
} else {
  app = run('pnpm', ['exec', 'electron-vite', 'dev'], { env })
}

console.log(`\n[dev] Nemo を起動した`)
console.log(`[dev]   テストページ    http://127.0.0.1:${pagesPort}/`)
if (debugPort) {
  console.log(`[dev]   remote debugging http://127.0.0.1:${debugPort}/json/list`)
  console.log(`[dev]   自走検証        mise run verify （別ターミナルなら pnpm verify:spike）`)
  console.log('[dev]   ⚠ CDP が開いている。実 Vault の Bitwarden を入れるなら mise run dev:nodebug を使う')
} else {
  console.log('[dev]   remote debugging 無効（--no-debug）。自走検証は使えない')
}
if (popupDevTools) {
  console.log('[dev]   拡張 popup の DevTools を自動で開く（--popup-devtools）')
}
console.log('[dev] 終了は Ctrl-C\n')

app.on('exit', (code) => shutdown(code ?? 0))
