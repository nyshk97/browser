#!/usr/bin/env node
/**
 * セッション cookie（ログイン）を再起動をまたいで引き継ぐことの検証（`mise run verify:only session-cookies`）。
 *
 * 見るもの:
 *   (a) ページが受け取ったセッション cookie（HttpOnly を含む）が、数秒で暗号化されて保存される。
 *       期限付きの cookie は保存しない。保存先に平文が無く、パーミッションは 0600
 *   (b) **強制終了（SIGKILL = クラッシュ）の後**の起動で、ページにセッション cookie が送られる
 *   (c) Claude の窓のプロファイル（`persist:nemo-agent`）でも、戻した cookie が写しに入り、正常終了で保存し直される
 *   (d) `restoreSession: false` なら戻さず、保存先も消す（期限付きの cookie はそのまま届く = cookie の仕組み自体は生きている）
 *
 * **自分で起動する**（同じ userData で 3 回起動し直す。1 回目は SIGKILL で落とす）。
 * 暗号化は `NEMO_HTTP_AUTH_TEST_CRYPTO=memory`（実 Keychain に触らない。形式は secret-backend.ts の差し替え backend）。
 *
 * 使い方:
 *   node scripts/verify-session-cookies.mjs        （事前に out/ がビルドされていること）
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  projectRoot,
  readLogLines,
  sleep,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const SESSION_VALUE = 'plain-session-value-7f3a'
const HTTP_ONLY_VALUE = 'http-only-value-9c1b'
const AGENT_VALUE = 'agent-session-value-4d2e'

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const spawned = []
const dirs = []
function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-sesscookie-${tag}-`))
  dirs.push(dir)
  return dir
}

/* ---- secret-backend.ts の差し替え backend と同じ形式 ---- */
const TEST_PREFIX = 'NEMOTEST1:'
function testEncrypt(plain) {
  const checksum = createHash('sha256').update(plain).digest('hex').slice(0, 16)
  return TEST_PREFIX + Buffer.from(`${checksum}:${plain}`, 'utf8').toString('base64')
}
function testDecrypt(cipher) {
  const decoded = Buffer.from(cipher.slice(TEST_PREFIX.length), 'base64').toString('utf8')
  return decoded.slice(decoded.indexOf(':') + 1)
}

function readSaved(userData) {
  const file = path.join(userData, 'session-cookies.json')
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  const profiles = {}
  for (const [label, cipher] of Object.entries(parsed.profiles ?? {})) {
    profiles[label] = JSON.parse(testDecrypt(cipher))
  }
  return { raw, mode: fs.statSync(file).mode & 0o777, profiles }
}

function logEvents(userDataDir, event) {
  return readLogLines(userDataDir)
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line))
}

function writeSettings(userData, data) {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ version: 1, data }))
}

/**
 * `/set` でセッション cookie 2 つ（1 つは HttpOnly）と期限付き 1 つ、`/set-pers` で期限付きだけを返し、
 * `/echo` で届いた Cookie をそのまま返す。
 */
async function bootPages() {
  const port = await getFreePort()
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    if (req.url === '/set') {
      res.setHeader('Set-Cookie', [
        `vsess=${SESSION_VALUE}; Path=/`,
        `vhttp=${HTTP_ONLY_VALUE}; Path=/; HttpOnly`,
        'vpers=persistent-1; Path=/; Max-Age=86400'
      ])
      res.end('set')
      return
    }
    if (req.url === '/set-pers') {
      res.setHeader('Set-Cookie', 'vpers=persistent-1; Path=/; Max-Age=86400')
      res.end('set')
      return
    }
    res.end(`cookie:${req.headers.cookie ?? ''}`)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() }
}

async function bootApp(userDataDir) {
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_SLOTS_DIR: makeDir('slots'),
      NEMO_DOWNLOAD_DIR: makeDir('dl'),
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory'
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/** CDP の target に繋いで式を 1 つ評価する（`pick` で target を名指しする。最初に見つかったものに繋がない）。 */
async function evalIn(cdp, pick, expression, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let target = null
  while (Date.now() < deadline) {
    const list = await (await fetch(`${cdp}/json/list`)).json()
    target = list.find(pick)
    if (target) break
    await sleep(200)
  }
  if (!target) throw new Error('target が見つからない')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      ws.addEventListener('message', function onMessage(event) {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        ws.removeEventListener('message', onMessage)
        resolve(message)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    while (Date.now() < deadline) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      const value = result.result?.result?.value
      if (value) return value
      await sleep(200)
    }
    throw new Error(`式が値を返さない: ${expression.slice(0, 80)}`)
  } finally {
    ws.close()
  }
}

const inUi = (cdp, expression) =>
  evalIn(
    cdp,
    (t) => t.url.includes('view=sidebar'),
    `(async () => { const s = await window.nemo?.getAppStatus?.(); if (!s?.ready) return ''; return (${expression}) })()`
  )

async function openAndRead(cdp, url) {
  await inUi(cdp, `window.nemo.createTab(${JSON.stringify(url)}, {}).then(() => 'ok')`)
  return evalIn(
    cdp,
    (t) => t.type === 'page' && t.url === url,
    "document.readyState === 'complete' ? document.body.innerText : ''"
  )
}

async function waitFor(predicate, { timeoutMs = 15000, what }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`${Math.round(timeoutMs / 1000)} 秒待っても ${what}`)
}

async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

const pages = await bootPages()
try {
  assertNemoNotRunning('セッション cookie の引き継ぎの検証')
  const userData = makeDir('data')
  // Live Folder を止める（使い捨てプロファイルでも gh の実トークンで実 GitHub を叩くため）
  writeSettings(userData, { liveFolderEnabled: false })

  /* ---- 1 回目: 受け取って保存 → SIGKILL ---- */
  const first = await bootApp(userData)
  const setBody = await openAndRead(first.cdp, `${pages.origin}/set`)
  check('1 回目: /set が開いた', setBody === 'set', setBody)
  const saved = await waitFor(
    () => {
      const found = readSaved(userData)
      return found?.profiles.page?.some((c) => c.name === 'vsess') ? found : null
    },
    { what: 'session-cookies.json に vsess が保存されない' }
  )
  const pageNames = saved.profiles.page.map((c) => c.name).sort()
  check(
    '(a) セッション cookie（HttpOnly を含む）を保存し、期限付きは保存しない',
    pageNames.includes('vsess') && pageNames.includes('vhttp') && !pageNames.includes('vpers'),
    pageNames.join(', ')
  )
  check(
    '(a) 保存先に平文が無い',
    !saved.raw.includes(SESSION_VALUE) &&
      !saved.raw.includes(HTTP_ONLY_VALUE) &&
      !saved.raw.includes('vsess'),
    `${saved.raw.length} bytes`
  )
  check('(a) 保存先のパーミッションは 0600', saved.mode === 0o600, saved.mode.toString(8))
  await kill(first.child)

  // Claude の窓のプロファイルにも 1 件仕込む（止めてから。起動中に書くと終了時の保存が上書きする）
  const file = path.join(userData, 'session-cookies.json')
  const planted = JSON.parse(fs.readFileSync(file, 'utf8'))
  planted.profiles.agent = testEncrypt(
    JSON.stringify([
      {
        name: 'vagent',
        value: AGENT_VALUE,
        domain: '127.0.0.1',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'lax'
      }
    ])
  )
  fs.writeFileSync(file, JSON.stringify(planted))

  /* ---- 2 回目: クラッシュ後の起動で戻る → 正常終了で保存し直す ---- */
  const second = await bootApp(userData)
  const echo = await openAndRead(second.cdp, `${pages.origin}/echo`)
  check(
    '(b) SIGKILL の後の起動で、セッション cookie（HttpOnly を含む）がページに送られる',
    echo.includes(`vsess=${SESSION_VALUE}`) && echo.includes(`vhttp=${HTTP_ONLY_VALUE}`),
    echo
  )
  const restored = logEvents(userData, 'session_cookies.restored')
  const restoredPage = restored.find((e) => e.profile === 'page')
  const restoredAgent = restored.find((e) => e.profile === 'agent')
  // 使い捨てのプロファイルでも起動時に他の cookie（GitHub の `_gh_sess` 等）が入るので、保存した件数と比べる。
  // 比べる相手は SIGKILL の後のファイル（最初に vsess を見つけた後にも保存が入りうる）
  const savedPageCount = JSON.parse(testDecrypt(planted.profiles.page)).length
  check(
    '(b) 戻した件数がログに出る（page = SIGKILL 時点で保存されていた件数・agent 1 件、失敗 0）',
    restoredPage?.count === savedPageCount &&
      restoredAgent?.count === 1 &&
      !restoredPage?.failed &&
      !restoredAgent?.failed,
    JSON.stringify(restored.map((e) => ({ profile: e.profile, count: e.count, failed: e.failed })))
  )
  // 期限付きの cookie は 1 回目の SIGKILL で消えている（Chromium は約 30 秒ごとにしか書かない）。
  // 正常終了する 2 回目で入れ直し、3 回目で「cookie の仕組み自体は生きている」ことの目印にする
  check('2 回目: /set-pers が開いた', (await openAndRead(second.cdp, `${pages.origin}/set-pers`)) === 'set')
  await stopChildren([second.child])
  check('2 回目は正常終了した（app.quit が出た）', logEvents(userData, 'app.quit').length >= 1)
  const resaved = readSaved(userData)
  check(
    '(c) Claude の窓のプロファイルに戻した cookie が、正常終了で保存し直される',
    resaved?.profiles.agent?.some((c) => c.name === 'vagent' && c.value === AGENT_VALUE) === true,
    JSON.stringify(resaved?.profiles.agent?.map((c) => c.name))
  )
  check(
    '(c) 常用のプロファイルの cookie も保存し直される',
    resaved?.profiles.page?.some((c) => c.name === 'vsess') === true,
    JSON.stringify(resaved?.profiles.page?.map((c) => c.name))
  )

  /* ---- 3 回目: restoreSession: false なら戻さない ---- */
  writeSettings(userData, { liveFolderEnabled: false, restoreSession: false })
  const third = await bootApp(userData)
  const echoOff = await openAndRead(third.cdp, `${pages.origin}/echo`)
  check(
    '(d) restoreSession: false ではセッション cookie を戻さない（期限付きは届く）',
    !echoOff.includes('vsess=') && !echoOff.includes('vhttp=') && echoOff.includes('vpers=persistent-1'),
    echoOff
  )
  check('(d) 保存先を消す', !fs.existsSync(file))
  await stopChildren([third.child])

  const uncaught = findUncaughtExceptions(userData)
  check('main の未捕捉例外が出ていない', uncaught.length === 0, uncaught.slice(0, 2).join(' | '))
} catch (error) {
  checks += 1
  failures += 1
  console.error(`FAIL  例外で中断 — ${error?.stack ?? error}`)
} finally {
  await stopChildren(spawned.splice(0))
  pages.close()
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\nverify-session-cookies: ${checks - failures} 件 PASS / ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
