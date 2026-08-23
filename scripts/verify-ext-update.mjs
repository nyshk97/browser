#!/usr/bin/env node
/**
 * 「拡張のバージョンを上げ下げしても拡張の設定（chrome.storage）が失われない」ことを
 * 実物の Bitwarden artifact で自動検証する（`mise run verify:ext-update`）。
 *
 * Phase 0 の設計で一番効いている部分の確認:
 *   GitHub Release の zip には manifest.key が無いので、そのままだと拡張 ID が
 *   ロード元パス（版を含む）から決まり、版を上げるたびに ID が変わって
 *   chrome.storage が別物になる = Vault のログイン状態が飛ぶ。
 *   lock の manifestKey を注入して ID を固定しているので飛ばない、というのを機械で確かめる。
 *
 * **リポジトリの lock / extensions / cache には一切触らない。**
 * すべて一時ディレクトリに複製し、そこだけを書き換える
 * （以前は本物を差し替えており、稼働中の Nemo の拡張を巻き込んだ）。
 * 念のため Nemo が起動中なら実行を拒否する。
 *
 *   node scripts/verify-ext-update.mjs [他バージョン]
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
const otherVersion = process.argv[2] ?? '2026.7.0'

const realLockPath = path.join(projectRoot, 'extensions.lock.json')
const realCacheDir = path.join(projectRoot, '.ext-cache')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function runToCompletion(command, args, env, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, ...env },
      ...options
    })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

function capture(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, env: { ...process.env, ...env } })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', () => {})
    child.on('exit', (code) => resolve({ code: code ?? 1, out: out.trim() }))
    child.on('error', () => resolve({ code: 1, out: '' }))
  })
}

// --- すべて一時領域に隔離する
try {
  assertNemoNotRunning('verify:ext-update')
} catch (error) {
  console.error(`[verify:ext-update] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

// safeJoin が base を realpath するので、比較用にも実体パスを持っておく
// （macOS の /var は /private/var への symlink）
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extupdate-')))
const sandbox = {
  lock: path.join(work, 'extensions.lock.json'),
  extensions: path.join(work, 'extensions'),
  cache: path.join(work, 'cache'),
  userData: path.join(work, 'userData')
}
fs.copyFileSync(realLockPath, sandbox.lock)
if (fs.existsSync(realCacheDir)) {
  // ダウンロードし直さないためにキャッシュだけ複製する（読むのは複製側だけ）
  fs.cpSync(realCacheDir, sandbox.cache, { recursive: true })
}
fs.mkdirSync(sandbox.extensions, { recursive: true })
fs.mkdirSync(sandbox.userData, { recursive: true })

const debugPort = String(await getFreePort())
const extEnv = {
  NEMO_EXT_LOCK: sandbox.lock,
  NEMO_EXT_DIR: sandbox.extensions,
  NEMO_EXT_CACHE: sandbox.cache
}
const appEnv = {
  ...extEnv,
  NEMO_REMOTE_DEBUGGING_PORT: debugPort,
  NEMO_USER_DATA_DIR: sandbox.userData
}
const cdp = `http://127.0.0.1:${debugPort}`

const readSandboxLock = () => JSON.parse(fs.readFileSync(sandbox.lock, 'utf8')).extensions[0]
const originalVersion = readSandboxLock().version

/**
 * 起動した子は一度入れたら外さない（後片付けの可否は生存状態だけで判断する）。
 * @type {import('node:child_process').ChildProcess[]}
 */
const spawned = []

async function startApp() {
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: { ...process.env, ...appEnv }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => {
      const list = await res.json()
      return (
        list.some((t) => t.url.includes('/renderer/index.html')) &&
        list.some((t) => t.type === 'service_worker')
      )
    }
  })
  return child
}

/** 止めて**終了を待つ**。一時領域を消す前に確実に死んでいる必要がある。 */
async function stopAll() {
  await stopChildren(spawned.filter(isChildAlive))
}

const spike = (args) => capture(process.execPath, ['scripts/verify-spike.mjs', ...args], { NEMO_CDP: cdp })

try {
  if (originalVersion === otherVersion) {
    throw new Error(`lock が既に ${otherVersion}。別のバージョンを引数で指定する`)
  }

  console.log(`（一時領域: ${work}）`)
  console.log(`=== ${originalVersion} で起動して印を書く`)
  if ((await runToCompletion(process.execPath, ['scripts/ext-fetch.mjs'], extEnv)) !== 0) {
    throw new Error('ext-fetch 失敗')
  }
  await startApp()

  const before = JSON.parse((await spike(['--extension-info'])).out)[0]
  check(`${originalVersion} がロードされる`, before?.version === originalVersion, JSON.stringify(before))
  check(
    '拡張は一時領域から読まれている（リポジトリの extensions/ を触っていない）',
    typeof before?.path === 'string' && before.path.startsWith(work),
    before?.path
  )

  const written = await spike(['--storage-write'])
  check('chrome.storage.local に印を書ける', written.out.includes('ok'), written.out)
  await stopAll()

  console.log(`\n=== ${otherVersion} へ張り替える`)
  if (
    (await runToCompletion(process.execPath, ['scripts/ext-fetch.mjs', '--update', otherVersion], extEnv)) !==
    0
  ) {
    throw new Error('ext-fetch --update 失敗')
  }
  if ((await runToCompletion(process.execPath, ['scripts/ext-verify.mjs'], extEnv)) !== 0) {
    throw new Error('更新後の ext-verify 失敗')
  }

  await startApp()
  const after = JSON.parse((await spike(['--extension-info'])).out)[0]
  check(`${otherVersion} がロードされる`, after?.version === otherVersion, JSON.stringify(after))
  check(
    '版が変わっても拡張 ID が同じ（chrome.storage を引き継げる）',
    after?.id === before?.id,
    `${before?.id} -> ${after?.id}`
  )
  check('更新後も chrome.storage.local の印が残っている', (await spike(['--storage-read'])).code === 0)
  await stopAll()

  console.log(`\n=== ${originalVersion} へ戻して、戻した状態でも読めるか見る`)
  if (
    (await runToCompletion(
      process.execPath,
      ['scripts/ext-fetch.mjs', '--update', originalVersion],
      extEnv
    )) !== 0
  ) {
    throw new Error('ロールバックの ext-fetch 失敗')
  }
  if ((await runToCompletion(process.execPath, ['scripts/ext-verify.mjs'], extEnv)) !== 0) {
    throw new Error('ロールバック後の ext-verify 失敗')
  }

  await startApp()
  const restored = JSON.parse((await spike(['--extension-info'])).out)[0]
  check(`${originalVersion} に戻る`, restored?.version === originalVersion, JSON.stringify(restored))
  check('ロールバック後も拡張 ID が同じ', restored?.id === before?.id)
  check(
    'ロールバック後も chrome.storage.local の印が残っている',
    (await spike(['--storage-read'])).code === 0
  )
  await stopAll()
} catch (error) {
  console.error(`\n[verify:ext-update] ${error instanceof Error ? error.message : String(error)}`)
  failures += 1
} finally {
  try {
    await stopAll()
  } catch (error) {
    failures += 1
    console.error(`\n[verify:ext-update] ${error instanceof Error ? error.message : String(error)}`)
  }

  // 消してよいかは「生き残りがいないこと」だけで判断する
  const alive = spawned.filter(isChildAlive)
  if (alive.length === 0) {
    fs.rmSync(work, { recursive: true, force: true })
  } else {
    failures += 1
    console.error(
      `[verify:ext-update] 生き残ったプロセスがある (pid ${alive.map((c) => c.pid).join(', ')})。` +
        `一時領域を残した: ${work}`
    )
  }
}

// リポジトリ側は最初から触っていないので、念のため確認だけする
const untouched = fs.readFileSync(realLockPath, 'utf8')
check(
  'リポジトリの extensions.lock.json が変わっていない',
  JSON.parse(untouched).extensions[0].version === originalVersion
)

console.log(failures === 0 ? '\n=== すべて PASS' : `\n=== ${failures} 件 FAIL`)
process.exit(failures > 0 ? 1 : 0)
