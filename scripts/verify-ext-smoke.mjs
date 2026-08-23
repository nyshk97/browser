#!/usr/bin/env node
/**
 * 拡張互換の smoke test（`mise run verify:ext`）。
 *
 * **CI の必須チェックにするための版**。計画 1-10 の「CI 必須（資格情報なし・決定的）」に対応する。
 * リポジトリ内の自作テスト拡張（`test-extension/`）だけを使うので、
 * 外部からのダウンロードも資格情報も要らず、結果が決定的になる。
 *
 * Electron を上げる PR ではここが落ちたら据え置く、という判断に使う。
 *
 *   node scripts/verify-ext-smoke.mjs            主要セット（再起動をまたぐ確認まで）
 *   node scripts/verify-ext-smoke.mjs --sw-idle  service worker の idle 停止もまたぐ（遅い）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
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
const withSwIdle = process.argv.includes('--sw-idle')

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extsmoke-'))
const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extsmoke-ext-'))

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** @type {import('node:child_process').ChildProcess[]} */
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

const appEnv = () => ({
  ...process.env,
  NEMO_REMOTE_DEBUGGING_PORT: debugPort,
  NEMO_USER_DATA_DIR: userDataDir,
  NEMO_EXT_DIR: path.join(extRoot, 'extensions'),
  NEMO_EXT_LOCK: path.join(extRoot, 'extensions.lock.json')
})

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
  const child = start(electronPath, ['out/main/index.js'], { env: appEnv() })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return child
}

async function stopAll() {
  await stopChildren(spawned.filter(isChildAlive))
}

/** service worker の target（CDP でつなぐと idle 停止しなくなるので、必要なときだけつなぐ）。 */
async function swTarget() {
  return (await listTargets(cdp)).find((t) => t.type === 'service_worker') ?? null
}

async function swSession() {
  const target = await swTarget()
  if (!target) throw new Error('拡張の service worker が動いていない')
  return connect(target.webSocketDebuggerUrl)
}

try {
  assertNemoNotRunning('verify:ext')
  console.log(`（CDP ${cdp} / テストページ ${pages} / userData ${userDataDir}）`)

  console.log('\n=== テスト拡張を用意する')
  if ((await runToCompletion(process.execPath, ['scripts/make-test-extension.mjs', extRoot])) !== 0) {
    throw new Error('テスト拡張の生成に失敗した')
  }
  const lock = JSON.parse(fs.readFileSync(path.join(extRoot, 'extensions.lock.json'), 'utf8'))
  const expected = lock.extensions[0]

  console.log('\n=== ビルド')
  if ((await runToCompletion('pnpm', ['exec', 'electron-vite', 'build'])) !== 0) {
    throw new Error('ビルド失敗')
  }

  await startPagesServer()
  await startApp()

  const ui = await connectUi(cdp)

  /* ---- 1. ロード ---- */
  const loaded = await ui.ev('window.nemo.getExtensions().then((e) => JSON.stringify(e))').then(JSON.parse)
  check(
    'lock どおりの ID / version でロードされる',
    loaded.length === 1 && loaded[0].id === expected.id && loaded[0].version === expected.version,
    JSON.stringify(loaded.map((e) => `${e.id} ${e.version}`))
  )
  check('オプションページが検出される', Boolean(loaded[0]?.optionsUrl), loaded[0]?.optionsUrl ?? '')

  /* ---- 2. service worker ---- */
  // 起動には数秒かかることがある（CI の遅いマシンで顕著）。瞬間値で判定しない。
  const swUp = await (async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await swTarget()) return true
      await sleep(500)
    }
    return false
  })()
  check('service worker が起動している', swUp)

  /* ---- 3. content script（トップ + iframe） ---- */
  await ui.ev(`window.nemo.createTab('${pages}/iframe.html').then((k) => k)`)
  await sleep(2500)
  const page = await connectTo(cdp, '/iframe.html')
  const marks = await page
    .ev(
      `(() => {
    const top = document.documentElement.getAttribute('data-nemo-ci')
    const frames = [...document.querySelectorAll('iframe')].map((f) => {
      try { return f.contentDocument.documentElement.getAttribute('data-nemo-ci') } catch { return 'cross-origin' }
    })
    return JSON.stringify({ top, frames, ping: document.documentElement.getAttribute('data-nemo-ci-ping') })
  })()`
    )
    .then(JSON.parse)
  check('content script がトップフレームに入る', marks.top === 'top', JSON.stringify(marks))
  check(
    'content script が iframe にも入る',
    marks.frames.length > 0 && marks.frames.every((m) => m === 'frame'),
    JSON.stringify(marks.frames)
  )
  check('content script から service worker へメッセージが通る', marks.ping === 'true', String(marks.ping))

  /* ---- 4. chrome.tabs / chrome.windows ---- */
  {
    const sw = await swSession()
    const before = await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    const bg = await sw.ev(`chrome.tabs.create({ url: '${pages}/login.html', active: false })`)
    await sleep(1500)
    const after = await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    check('chrome.tabs.create が Nemo のタブになる', after.tabs.length === before.tabs.length + 1)
    check(
      'active: false のタブはアクティブにならない',
      after.activeTabKey === before.activeTabKey,
      `${before.activeTabKey?.slice(0, 4)} -> ${after.activeTabKey?.slice(0, 4)}`
    )
    const created = after.tabs.find((t) => t.webContentsId === bg?.id)
    check(
      '拡張から見た windowId が Nemo の所属ウィンドウと一致する',
      created?.chromeWindowId === bg?.windowId
    )

    const uiCountBefore = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    const win = await sw.ev(`chrome.windows.create({ url: '${pages}/index.html' })`)
    await sleep(2500)
    const uiCountAfter = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    check('chrome.windows.create が Nemo のウィンドウになる', uiCountAfter === uiCountBefore + 1)
    await sw.ev(`chrome.windows.remove(${win?.id}).then(() => 'ok')`)
    await sleep(1500)
    const uiCountFinal = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    check('chrome.windows.remove でウィンドウが閉じる', uiCountFinal === uiCountBefore)

    await sw.ev(`chrome.tabs.remove(${bg?.id}).then(() => 'ok')`)

    // 作った直後のウィンドウを閉じても main プロセスが落ちないこと。
    //
    // 準備待ちで積んである「初期タブを作る」処理が破棄済みウィンドウで走ると
    // `Object has been destroyed` で落ちる。**このテストはその競合を強制はできない**
    // （UI のロードが速いと素通りする）。競合そのものは registry 側のガードで塞いであり、
    // 実際に起きたときは最後の「例外がログに1件も無い」で捕まえる。
    const quick = await sw.ev(`chrome.windows.create({ url: '${pages}/index.html' })`)
    await sw.ev(`chrome.windows.remove(${quick?.id}).then(() => 'ok', (e) => 'error: ' + e.message)`)
    await sleep(3000)
    const alive = await ui
      .ev(`window.nemo.getAppStatus().then((s) => JSON.stringify(s))`)
      .then(JSON.parse, () => null)
    check(
      'UI の準備前にウィンドウを閉じても main プロセスが落ちない',
      alive !== null && alive.ready === true,
      JSON.stringify(alive)
    )

    sw.close()
  }

  /* ---- 5. popup ---- */
  {
    const sw = await swSession()
    // `chrome.action.openPopup()` は「どのウィンドウに出すか」を
    // フォーカス中のウィンドウから決めるので、直前にウィンドウを閉じていると
    // 取りこぼすことがある。**開くところまでを再試行する**。
    let popup = null
    let openResult = ''
    for (let attempt = 0; attempt < 3 && !popup; attempt += 1) {
      openResult = await sw.ev(
        `chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + (e && e.message))`
      )
      popup = await connectTo(cdp, 'popup.html', { timeoutMs: 5000 }).catch(() => null)
    }
    const ready = popup
      ? await waitFor(
          popup,
          `document.getElementById('ready')?.textContent === 'popup-ready' ? 'ready' : ''`
        ).catch(() => '')
      : ''
    check('popup が開いて chrome.* が使える', ready === 'ready', popup ? '' : `openPopup: ${openResult}`)
    popup?.close()
    sw.close()
  }

  /* ---- 6. オプションページ ---- */
  {
    await ui.ev(`window.nemo.openExtensionOptions(${JSON.stringify(expected.id)}).then(() => 'ok')`)
    const options = await connectTo(cdp, 'options.html', { timeoutMs: 10000 })
    // target ができた直後は本文がまだ無いことがあるので、描画まで待つ
    const ready = await waitFor(options, `document.getElementById('options-ready')?.textContent ?? ''`).catch(
      () => ''
    )
    check('拡張のオプションページを Nemo から開ける', ready === 'options-ready', ready)
    options.close()
  }

  /* ---- 7. service worker の idle 停止をまたぐ ---- */
  if (withSwIdle) {
    console.log('\n=== service worker の idle 停止を待つ（最大 120 秒）')
    // CDP でつないだままだと idle 停止しないので、ここでは絶対につながない
    const deadline = Date.now() + 120_000
    let stopped = false
    while (Date.now() < deadline) {
      if (!(await swTarget())) {
        stopped = true
        break
      }
      await sleep(2000)
    }
    check('service worker が idle で停止する', stopped, stopped ? '' : '120 秒待っても停止しなかった')

    if (stopped) {
      // content script からの ping で起こす（Nemo 側から明示的に start しない経路）
      await ui.ev(`window.nemo.createTab('${pages}/login.html').then((k) => k)`)
      const woke = await (async () => {
        const until = Date.now() + 30_000
        while (Date.now() < until) {
          if (await swTarget()) return true
          await sleep(1000)
        }
        return false
      })()
      check('停止した service worker が content script からの通信で起きる', woke)
      if (woke) {
        const sw = await swSession()
        const stored = await sw
          .ev(`chrome.storage.local.get(null).then((v) => JSON.stringify(v))`)
          .then(JSON.parse)
        // 停止前に書いた値が残っていること。ping の回数が増えていれば
        // 「起きた worker が古い storage を読めている」ことまで言える。
        check(
          'idle 停止をまたいで chrome.storage.local が残る',
          typeof stored['__nemo_ci_wakes__'] === 'number' && stored['__nemo_ci_wakes__'] >= 2,
          `wakes=${stored['__nemo_ci_wakes__']} keys=${Object.keys(stored).join(',')}`
        )
        // `chrome.runtime.onInstalled` は electron-chrome-extensions では発火しない。
        // 初回セットアップをここに置いている拡張は動かないので、事実として出しておく
        // （壊れている挙動を assert すると、直ったときに誤検知になるので check にはしない）。
        if (stored['__nemo_ci_marker__'] !== 'installed') {
          console.log(
            '      注意: chrome.runtime.onInstalled が発火していない（既知の制約。docs/compat.md 参照）'
          )
        }
        sw.close()
      }
    }
  }

  /* ---- 8. 再起動をまたぐ chrome.storage ---- */
  {
    const sw = await swSession()
    await sw.ev(`chrome.storage.local.set({ __nemo_restart__: 'before' }).then(() => 'ok')`)
    sw.close()
  }
  ui.close()
  page.close()
  await stopAll()

  await startPagesServer()
  await startApp()
  {
    const sw = await swSession()
    const value = await sw
      .ev(`chrome.storage.local.get('__nemo_restart__').then((v) => JSON.stringify(v))`)
      .then(JSON.parse)
    check(
      '再起動をまたいで chrome.storage.local が残る',
      value['__nemo_restart__'] === 'before',
      JSON.stringify(value)
    )
    sw.close()
  }
} catch (error) {
  failures += 1
  console.error(`\n[verify:ext] ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    await stopAll()
  } catch (error) {
    failures += 1
    console.error(`[verify:ext] ${error.message}`)
  }
  // main プロセスの例外は握ってログに落としているので、ここで必ず見る
  const uncaught = findUncaughtExceptions(userDataDir)
  check('main プロセスの例外がログに1件も無い', uncaught.length === 0, uncaught.join(' / '))

  if (spawned.filter(isChildAlive).length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(extRoot, { recursive: true, force: true })
  } else {
    failures += 1
    console.error(`[verify:ext] 生き残ったプロセスがある。一時ディレクトリを残した: ${userDataDir}`)
  }
}

console.log(failures === 0 ? '\nverify:ext: すべて PASS' : `\nverify:ext: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
