#!/usr/bin/env node
/**
 * メモリ・CPU の定期記録と UI 例外・起動終了スナップショットの検証（`mise run verify:only metrics`）。
 *
 * 見るもの:
 *   (a) `metrics.sample` が 2 行以上出る（件数を出力に出す）
 *   (b) 2 行目以降の**いずれか**で `total.cpu > 0` かつ `byType` が非空（初回空撃ちが効いている）
 *   (c) 同じ origin のタブを 2 つ開くと `top` の `keys` 合計が 2 で、`origins` にそのローカル origin がある
 *       （同一サイトは 1 renderer にまとまるので、同居してもしなくても成り立つ条件）
 *   (d) UI から `window.nemo.reportError` を撃つと `ui.error` が 1 行出る（`error` と `view`）
 *   (e) 終了後の `app.quit` に `uptimeMs` / `total` / `source: "quit"` がある
 *   (f) `app.ready` に `readyMs > 0` と数値の `extensions` がある（`restoredTabs` は再起動をまたがないので見ない）
 *
 * **自分で起動する**（`NEMO_METRICS_INTERVAL_MS` を短くしたいので共有アプリは使えない）。
 * ページも自前で `test-server.mjs` を立てる（`about:blank` は `origins` が `"about:"` で非空になり素通りする）。
 *
 * 使い方:
 *   node scripts/verify-metrics.mjs        （事前に out/ がビルドされていること）
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

const INTERVAL_MS = 2000

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const spawned = []
const dirs = []
function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-metrics-${tag}-`))
  dirs.push(dir)
  return dir
}

function logEvents(userDataDir, event) {
  return readLogLines(userDataDir)
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line))
}

async function waitFor(predicate, { timeoutMs = 30000, what }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(300)
  }
  throw new Error(`${Math.round(timeoutMs / 1000)} 秒待っても ${what}`)
}

async function bootPages() {
  const port = String(await getFreePort())
  const child = spawn(process.execPath, ['scripts/test-server.mjs'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, PORT: port }
  })
  spawned.push(child)
  const origin = `http://127.0.0.1:${port}`
  await waitForHttp(`${origin}/`, { child })
  return origin
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
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      NEMO_METRICS_INTERVAL_MS: String(INTERVAL_MS)
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/** UI（サイドバー）に CDP でつないで式を 1 つ評価する。 */
async function evalInUi(cdp, expression, view = 'sidebar') {
  const list = await (await fetch(`${cdp}/json/list`)).json()
  const target = list.find((t) => t.url.includes(`view=${view}`))
  if (!target) throw new Error(`ブラウザ UI の target が見つからない（view=${view}）`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  try {
    const send = (method, params) =>
      new Promise((resolve) => {
        const id = 1
        ws.addEventListener('message', function onMessage(event) {
          const message = JSON.parse(event.data)
          if (message.id !== id) return
          ws.removeEventListener('message', onMessage)
          resolve(message)
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const probe = await send('Runtime.evaluate', {
        expression: 'window.nemo?.getAppStatus?.().then((s) => JSON.stringify(s))',
        awaitPromise: true,
        returnByValue: true
      })
      const value = probe.result?.result?.value
      if (value && JSON.parse(value).ready) break
      await sleep(300)
    }
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return result.result?.result?.value
  } finally {
    ws.close()
  }
}

try {
  assertNemoNotRunning('メトリクスの検証')
  const userData = makeDir('data')
  const origin = await bootPages()
  const { child, cdp } = await bootApp(userData)

  // (f) 起動スナップショット
  const ready = logEvents(userData, 'app.ready')[0]
  check(
    'app.ready に readyMs > 0 がある',
    typeof ready?.readyMs === 'number' && ready.readyMs > 0,
    `readyMs=${ready?.readyMs}`
  )
  check(
    'app.ready に数値の extensions がある',
    typeof ready?.extensions === 'number',
    `extensions=${ready?.extensions}`
  )
  check(
    'metrics.interval_override が出ている（短縮が効いている）',
    logEvents(userData, 'metrics.interval_override').length === 1
  )

  // (c) 同じ origin のタブを 2 つ
  const keys = JSON.parse(
    await evalInUi(
      cdp,
      `(async () => {
        const a = await window.nemo.createTab(${JSON.stringify(`${origin}/index.html`)}, {})
        const b = await window.nemo.createTab(${JSON.stringify(`${origin}/index.html?second`)}, {})
        return JSON.stringify([a, b])
      })()`
    )
  )
  // 2 タブが renderer を持ってから撮れたサンプルが要る。数サンプル待つ
  await sleep(INTERVAL_MS * 3)

  // (a) (b)
  const samples = await waitFor(
    () => {
      const found = logEvents(userData, 'metrics.sample')
      return found.length >= 2 ? found : null
    },
    { what: 'metrics.sample が 2 行にならない', timeoutMs: INTERVAL_MS * 10 }
  )
  check('metrics.sample が 2 行以上ある', samples.length >= 2, `${samples.length} 件`)
  const laterSamples = samples.slice(1)
  const primedSample = laterSamples.find((s) => s.total?.cpu > 0 && Object.keys(s.byType ?? {}).length > 0)
  check(
    '2 行目以降のいずれかで total.cpu > 0 かつ byType が非空（初回空撃ちが効いている）',
    Boolean(primedSample),
    primedSample
      ? `cpu=${primedSample.total.cpu} types=${Object.keys(primedSample.byType).join(',')}`
      : laterSamples.map((s) => s.total?.cpu).join(',')
  )
  const last = samples[samples.length - 1]
  check(
    'windows / tabs / asleep / uptimeMs が数値',
    ['windows', 'tabs', 'asleep', 'uptimeMs'].every((k) => typeof last[k] === 'number'),
    JSON.stringify({ windows: last.windows, tabs: last.tabs, asleep: last.asleep })
  )
  const withKeys = last.top?.filter((e) => e.keys?.some((k) => keys.includes(k))) ?? []
  const keyTotal = withKeys.reduce((n, e) => n + e.keys.filter((k) => keys.includes(k)).length, 0)
  check(
    '同じ origin の 2 タブが top の keys に合計 2 件ある',
    keyTotal === 2,
    `${keyTotal} 件（${withKeys.length} renderer に分かれた）`
  )
  check(
    'top の origins にローカルの origin がある（パス以降は無い）',
    withKeys.some((e) => e.origins?.includes(origin)) && !JSON.stringify(last.top).includes('index.html'),
    JSON.stringify(withKeys.map((e) => e.origins))
  )

  // (d) UI 例外
  await evalInUi(
    cdp,
    `window.nemo.reportError({ message: 'verify boom', stack: 'Error: verify boom\\n    at x (nemo://ui/index.html?view=sidebar&secret=1)', view: 'sidebar' })`
  )
  const uiErrors = await waitFor(
    () => {
      // 起動中に本物の UI 例外が混ざっても、撃った 1 件だけを見る
      const found = logEvents(userData, 'ui.error').filter((e) => e.error === 'verify boom')
      return found.length > 0 ? found : null
    },
    { what: 'ui.error が出ない', timeoutMs: 10000 }
  )
  check('ui.error が 1 行出る', uiErrors.length === 1, `${uiErrors.length} 件`)
  check(
    'ui.error の error / view が渡した値',
    uiErrors[0]?.error === 'verify boom' && uiErrors[0]?.view === 'sidebar',
    JSON.stringify({ error: uiErrors[0]?.error, view: uiErrors[0]?.view })
  )
  check(
    'ui.error の frames にクエリが残らない',
    Array.isArray(uiErrors[0]?.frames) &&
      uiErrors[0].frames.length === 2 &&
      !JSON.stringify(uiErrors[0].frames).includes('secret'),
    JSON.stringify(uiErrors[0]?.frames)
  )
  // 未検査の送信元（ページ側）からは撃てない: main のハンドラは UI の WebContents 以外を弾く。ここでは正常系だけ見る

  // (e) 終了スナップショット
  await stopChildren([child])
  const quit = logEvents(userData, 'app.quit')[0]
  check('app.quit が出ている', Boolean(quit))
  check(
    'app.quit に uptimeMs / total / source:"quit" がある',
    typeof quit?.uptimeMs === 'number' && typeof quit?.total?.memMb === 'number' && quit?.source === 'quit',
    JSON.stringify({ uptimeMs: quit?.uptimeMs, total: quit?.total, source: quit?.source })
  )
  const uncaught = findUncaughtExceptions(userData)
  check('main の未捕捉例外が出ていない', uncaught.length === 0, uncaught.slice(0, 2).join(' | '))
} catch (error) {
  failures += 1
  console.error(`FAIL  例外で中断 — ${error?.stack ?? error}`)
} finally {
  await stopChildren(spawned.splice(0))
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全て PASS' : `\n${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
