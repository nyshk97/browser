#!/usr/bin/env node
/**
 * 自走検証を一括で通す（`mise run verify`）。
 *
 *   ユニットテスト → ビルド → 拡張の照合 → ページサーバ → アプリ起動 →
 *   verify-spike → 再起動をまたぐ永続性 → 後片付け
 *
 * 終了コードがそのまま合否になるので CI にも載せられる。
 *
 * 検証対象の取り違えを防ぐための決まりごと:
 * - ポートは毎回空きを採番する（固定ポートだと別プロセスを検証して PASS しうる。実際に踏んだ）
 * - 採番したエンドポイントは verify-spike に env で明示的に渡す
 * - 起動した子プロセスが生きていること・**自分が起動したサーバ**であることを確認してから進む
 * - 次の段へ進む前に、止めた子プロセスの**終了を待つ**（固定 sleep で進まない）
 * - データディレクトリは使い捨て（実 Vault の入ったプロファイルで CDP を開けない）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  getFreePort,
  isChildAlive,
  projectRoot,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`

/**
 * 自走検証は CDP を開けるので、**実 Vault の入ったプロファイルでは絶対に回さない**。
 * 使い捨てのデータディレクトリを毎回作って、そこで完結させる。
 */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-verify-'))

/**
 * 起動した子プロセスは**一度入れたら外さない**。
 * 「止める前に配列から外す」と、途中の停止に失敗したときに
 * 最後の後片付けが空配列を見て成功扱いになり、
 * **まだ使われている一時ディレクトリを消してしまう**。
 * 後片付けしてよいかは、常に生存状態そのものから判断する。
 * @type {import('node:child_process').ChildProcess[]}
 */
const spawned = []

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
  spawned.push(child)
  return child
}

function runToCompletion(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** 生きている子をすべて止め、**終了を待つ**（固定 sleep だとポート再利用や一時ディレクトリ削除と競合する）。 */
async function stopAll() {
  await stopChildren(spawned.filter(isChildAlive))
}

/** ページサーバを起動し、**自分が起動したもの**が応答することを確認する。 */
async function startPagesServer() {
  const child = start(process.execPath, ['scripts/test-server.mjs'], {
    env: { ...process.env, PORT: pagesPort },
    stdio: 'ignore'
  })
  await waitForHttp(`${pages}/__nemo_test_pages__`, {
    child,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${child.pid}`)
  })
  return child
}

async function startApp() {
  const child = start(electronPath, ['out/main/index.js'], {
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: debugPort,
      NEMO_USER_DATA_DIR: userDataDir
    }
  })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => {
      const list = await res.json()
      return list.some((t) => t.url.includes('/renderer/index.html'))
    }
  })
  return child
}

/** verify-spike には採番したエンドポイントを必ず明示的に渡す。 */
const spike = (args) =>
  runToCompletion(process.execPath, ['scripts/verify-spike.mjs', ...args], {
    env: { ...process.env, NEMO_CDP: cdp, NEMO_TEST_PAGES: pages }
  })

let exitCode = 0
try {
  assertNemoNotRunning('verify')
  console.log(`（CDP ${cdp} / テストページ ${pages} / userData ${userDataDir}）`)

  console.log('\n=== ユニットテスト')
  if (
    (await runToCompletion(process.execPath, [
      '--test',
      'scripts/navigation-policy.test.mjs',
      'scripts/ext-lock.test.mjs',
      'scripts/harness.test.mjs'
    ])) !== 0
  ) {
    throw new Error('ユニットテスト失敗')
  }

  console.log('\n=== ビルド')
  if ((await runToCompletion('pnpm', ['exec', 'electron-vite', 'build'])) !== 0) {
    throw new Error('ビルド失敗')
  }

  console.log('\n=== 拡張の照合')
  if ((await runToCompletion(process.execPath, ['scripts/ext-verify.mjs'])) !== 0) {
    throw new Error('拡張が lock と一致しない')
  }

  console.log('\n=== ページサーバ')
  await startPagesServer()

  console.log('=== Nemo 起動')
  await startApp()

  console.log('\n=== 自走検証')
  const spikeCode = await spike([])
  if (spikeCode !== 0) exitCode = spikeCode

  console.log('\n=== 再起動をまたぐ永続性')
  await spike(['--storage-write'])
  await stopAll()

  await startPagesServer()
  await startApp()
  const storageCode = await spike(['--storage-read'])
  if (storageCode !== 0) exitCode = storageCode
} catch (error) {
  console.error(`\n[verify] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  try {
    await stopAll()
  } catch (error) {
    exitCode = 1
    console.error(`\n[verify] ${error instanceof Error ? error.message : String(error)}`)
  }

  // 消してよいかは「生き残りがいないこと」だけで判断する。
  // stopAll が成功したかどうかでは判断しない（途中で止め損ねた子を見落とす）。
  const alive = spawned.filter(isChildAlive)
  if (alive.length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } else {
    exitCode = 1
    console.error(
      `[verify] 生き残ったプロセスがある (pid ${alive.map((c) => c.pid).join(', ')})。` +
        `一時ディレクトリを残した: ${userDataDir}`
    )
  }
}

console.log(exitCode === 0 ? '\n=== 自走検証: すべて PASS' : '\n=== 自走検証: FAIL あり')
process.exit(exitCode)
