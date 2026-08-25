#!/usr/bin/env node
/**
 * 自走検証を一括で通す（`mise run verify`）。
 *
 *   ユニットテスト → ビルド → 拡張の照合 → ページサーバ → アプリ起動 →
 *   verify-spike → verify-phase1 → verify-phase2 → verify-pins → verify-switcher →
 *   verify-peek → 再起動をまたぐ永続性 → 旧版セッションからの移行 →
 *   履歴 DB の列追加 → 後片付け
 *
 * 終了コードがそのまま合否になるので CI にも載せられる。
 *
 * `--only <名前...>` で回すものを絞れる（`mise run verify:only phase1 pins`）。
 * **1か所直して確かめ直す**ループで無関係な検証まで毎回回すと1回3分かかるが、
 * 関係するものだけなら十数秒で済む。絞ったときは**何を飛ばしたかを必ず出す**
 * （出さないと「フルで通った」と読み違える）。
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
  findUncaughtExceptions,
  getFreePort,
  isChildAlive,
  projectRoot,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

/**
 * 回せる検証の名前。`--only` はここに無い名前を**エラーにする**
 * （typo を黙って無視すると「何も回さずに PASS」になる）。
 */
const KNOWN_TARGETS = [
  'spike', // Phase 0: 拡張
  'phase1', // ブラウザ本体
  'phase2', // ライブラリ・アーカイブ・シークレット
  'pins', // ピン留め / Favorites
  'switcher', // タブスイッチャー（⌃M）
  'peek', // Peek と小窓
  'restart', // 再起動をまたぐ永続性（spike / phase1 / pins の write → read）
  'migration', // 旧版セッションからの移行
  'db' // 旧スキーマの履歴 DB からの移行
]
/** アプリとページサーバを立てる必要があるもの（migration / db は自分で起動する）。 */
const NEEDS_APP = ['spike', 'phase1', 'phase2', 'pins', 'switcher', 'peek', 'restart']

const onlyAt = process.argv.indexOf('--only')
const only = new Set(
  onlyAt === -1 ? [] : process.argv.slice(onlyAt + 1).filter((arg) => !arg.startsWith('--'))
)
if (onlyAt !== -1 && only.size === 0) {
  console.error(`[verify] --only には回すものを渡す。使えるのは: ${KNOWN_TARGETS.join(' / ')}`)
  process.exit(2)
}
const unknown = [...only].filter((name) => !KNOWN_TARGETS.includes(name))
if (unknown.length > 0) {
  console.error(
    `[verify] 知らない検証名: ${unknown.join(', ')}\n  使えるのは: ${KNOWN_TARGETS.join(' / ')}`
  )
  process.exit(2)
}
/** その検証を回すか（`--only` を渡していなければ全部回す）。 */
const want = (name) => only.size === 0 || only.has(name)
const needsApp = NEEDS_APP.some(want)

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`

/**
 * 自走検証は CDP を開けるので、**実 Vault の入ったプロファイルでは絶対に回さない**。
 * 使い捨てのデータディレクトリを毎回作って、そこで完結させる。
 */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-verify-'))
/** ダウンロードの検証で実際の ~/Downloads を汚さないための保存先。 */
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-verify-dl-'))

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
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: downloadDir
    }
  })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => {
      const list = await res.json()
      // UI は nemo://ui/ から配信される（file:// ではない）
      return list.some((t) => t.url.startsWith('nemo://ui/'))
    }
  })
  return child
}

/** 検証スクリプトには採番したエンドポイントを必ず明示的に渡す。 */
const runVerify = (script, args = []) =>
  runToCompletion(process.execPath, [script, ...args], {
    // **userData も渡す**。診断ログ・session.json を読む検証（Peek / 小窓）が
    // 「どのプロファイルを見ればよいか」を知る手段がこれしか無い。
    env: {
      ...process.env,
      NEMO_CDP: cdp,
      NEMO_TEST_PAGES: pages,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: downloadDir
    }
  })

const spike = (args) => runVerify('scripts/verify-spike.mjs', args)
const phase1 = (args) => runVerify('scripts/verify-phase1.mjs', args)
const phase2 = (args) => runVerify('scripts/verify-phase2.mjs', args)
const pins = (args) => runVerify('scripts/verify-pins.mjs', args)
const switcher = (args) => runVerify('scripts/verify-switcher.mjs', args)
const peek = (args) => runVerify('scripts/verify-peek.mjs', args)

let exitCode = 0
try {
  assertNemoNotRunning('verify')
  console.log(`（CDP ${cdp} / テストページ ${pages} / userData ${userDataDir}）`)
  if (only.size > 0) {
    const skipped = KNOWN_TARGETS.filter((name) => !only.has(name))
    console.log(`（--only ${[...only].join(' ')} … 回さない: ${skipped.join(' ')}）`)
  }

  console.log('\n=== ユニットテスト')
  if ((await runToCompletion(process.execPath, ['--test', 'scripts/*.test.mjs'])) !== 0) {
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

  if (needsApp) {
    console.log('\n=== ページサーバ')
    await startPagesServer()

    console.log('=== Nemo 起動')
    await startApp()
  }

  if (want('spike')) {
    console.log('\n=== 自走検証（Phase 0: 拡張）')
    const spikeCode = await spike([])
    if (spikeCode !== 0) exitCode = spikeCode
  }

  if (want('phase1')) {
    console.log('\n=== 自走検証（Phase 1: ブラウザ本体）')
    const phase1Code = await phase1([])
    if (phase1Code !== 0) exitCode = phase1Code
  }

  if (want('phase2')) {
    console.log('\n=== 自走検証（Phase 2: ライブラリ・アーカイブ・シークレット）')
    const phase2Code = await phase2([])
    if (phase2Code !== 0) exitCode = phase2Code
  }

  if (want('pins')) {
    console.log('\n=== 自走検証（ピン留め / Favorites）')
    const pinsCode = await pins([])
    if (pinsCode !== 0) exitCode = pinsCode
  }

  if (want('switcher')) {
    console.log('\n=== 自走検証（タブスイッチャー ⌃M）')
    const switcherCode = await switcher([])
    if (switcherCode !== 0) exitCode = switcherCode
  }

  if (want('peek')) {
    console.log('\n=== 自走検証（Peek と小窓）')
    const peekCode = await peek([])
    if (peekCode !== 0) exitCode = peekCode
  }

  if (want('restart')) {
    console.log('\n=== 再起動をまたぐ永続性')
    await spike(['--storage-write'])
    await phase1(['--session-write'])
    // ピン / Favorites の遅延ロードも再起動をまたぐので、同じ再起動に相乗りする
    const lazyWriteCode = await pins(['--lazy-write'])
    if (lazyWriteCode !== 0) exitCode = lazyWriteCode
    await stopAll()

    await startPagesServer()
    await startApp()
    const storageCode = await spike(['--storage-read'])
    if (storageCode !== 0) exitCode = storageCode
    const sessionCode = await phase1(['--session-read'])
    if (sessionCode !== 0) exitCode = sessionCode
    const lazyReadCode = await pins(['--lazy-read'])
    if (lazyReadCode !== 0) exitCode = lazyReadCode
  }

  if (want('migration')) {
    // 旧版セッションからの移行は**自分でアプリを起動して**確かめる（別プロファイル）。
    // ここまでの起動を止めてから回す（同時に2つの Nemo を立てない）。
    await stopAll()
    console.log('\n=== 旧版セッションからの移行')
    const migrationCode = await runToCompletion(process.execPath, ['scripts/verify-session-migration.mjs'])
    if (migrationCode !== 0) exitCode = migrationCode
  }

  if (want('db')) {
    // 履歴 DB の列追加も同じ理由で別建て。ここまでの userData は毎回まっさらなので、
    // **既存の pages テーブルへの ALTER TABLE を一度も通らない**。
    await stopAll()
    console.log('\n=== 旧スキーマの履歴 DB からの移行')
    const dbMigrationCode = await runToCompletion(process.execPath, ['scripts/verify-db-migration.mjs'])
    if (dbMigrationCode !== 0) exitCode = dbMigrationCode
  }
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

  // main プロセスの例外は握ってログに落としている（ブラウザごと止めないため）。
  // 握ったまま気づかないと意味がないので、検証の最後に必ず見る。
  const uncaught = findUncaughtExceptions(userDataDir)
  if (uncaught.length > 0) {
    exitCode = 1
    console.error(`\n[verify] main プロセスの例外がログに残っている:\n  ${uncaught.join('\n  ')}`)
  }

  // 消してよいかは「生き残りがいないこと」だけで判断する。
  // stopAll が成功したかどうかでは判断しない（途中で止め損ねた子を見落とす）。
  const alive = spawned.filter(isChildAlive)
  if (alive.length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  } else {
    exitCode = 1
    console.error(
      `[verify] 生き残ったプロセスがある (pid ${alive.map((c) => c.pid).join(', ')})。` +
        `一時ディレクトリを残した: ${userDataDir}`
    )
  }
}

const scope = only.size > 0 ? `（--only ${[...only].join(' ')} だけ）` : ''
console.log(
  exitCode === 0 ? `\n=== 自走検証: すべて PASS${scope}` : `\n=== 自走検証: FAIL あり${scope}`
)
process.exit(exitCode)
