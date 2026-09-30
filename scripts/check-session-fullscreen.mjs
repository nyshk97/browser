#!/usr/bin/env node
/**
 * 全画面で終えた通常ウィンドウが、次の起動で全画面に戻ることを実アプリで確かめる。
 *
 * **verify-all には入れていない**。全画面は専用の Space へ切り替わるので、
 * 回すたびに画面が一瞬奪われる（数秒で戻る）。セッションの保存・復元の全画面まわりを
 * 触ったときだけ手で回す: `mise run build && node scripts/check-session-fullscreen.mjs`
 *
 * 1. 版 5 の session.json（全画面のウィンドウ 2 枚 + `fullScreen` の無い旧形式のウィンドウ）から起動する
 *    → 全画面の 2 枚が**両方**全画面になる（続けて `setFullScreen` すると 2 枚目が無視される。実際に踏んだ）。
 *    旧形式は全画面にならない。保存し直した bounds が画面いっぱいでなく元の大きさ
 * 2. 全画面を抜ける → 保存が `fullScreen: false` と元の大きさになる
 * 3. 外部 URL で起こされた（argv に URL）ときは、全画面で保存されていても全画面にしない。
 *    ただし保存は `fullScreen: true` のまま持ち越し、次の普通の起動で全画面に戻る
 * 4. 持ち越し中にユーザーが全画面に出入りしたら、その操作が正（抜けたなら `fullScreen: false`）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectUi, waitFor } from './lib/cdp.mjs'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  projectRoot,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const FULL_BOUNDS = { x: 120, y: 120, width: 1000, height: 700 }
const FULL2_BOUNDS = { x: 160, y: 140, width: 960, height: 680 }
const PLAIN_BOUNDS = { x: 200, y: 160, width: 900, height: 640 }

/** 使い捨ての userData。Live Folder を止めておく（実 GitHub を叩かない）。 */
function makeProfile(windows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-fullscreen-'))
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 2)}\n`)
  write('settings.json', { version: 1, data: { liveFolderEnabled: false } })
  write('session.json', { version: 5, data: { windows, cleanExit: true, savedAt: Date.now() } })
  return dir
}

const readSaved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).data

/**
 * `since` より後に書かれた保存が条件を満たすまで待つ（2 段のデバウンスで約 3 秒遅れる）。
 * **`since` を必ず渡す** —— 全画面への切り替えは非同期で、切り替え完了前に走った保存
 * （ウィンドウ作成時のもの）を読むと、全画面中の bounds の検査が素通りする（実際に踏んだ）。
 */
async function waitSaved(dir, since, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = readSaved(dir)
    if (data.savedAt > since && predicate(data.windows)) {
      console.log(`（保存 savedAt=${data.savedAt}、基準より ${data.savedAt - since}ms 後）`)
      return data.windows
    }
    await sleep(300)
  }
  // **期限切れは古い保存を返さない**（返すと、まさに素通りさせたくない保存で検査が通る）。
  // 空配列を返して、呼び出し側の検査を全部 FAIL にする
  console.log(`（${timeoutMs}ms 待っても基準より後の保存が来なかった）`)
  return []
}

async function launch(dir, extraArgs = []) {
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js', ...extraArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: dir,
      NEMO_VERIFY_DIAGNOSTICS: '1'
    }
  })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/** 復元順どおりのウィンドウ ID（1, 2, …）ごとにサイドバーへ繋ぐ。 */
async function connectWindows(cdp, count) {
  const sessions = []
  for (let id = 1; id <= count; id += 1) {
    sessions.push(await connectUi(cdp, 'sidebar', { urlPart: `view=sidebar&window=${id}` }))
  }
  return sessions
}

const fullScreenOf = (session) => session.ev('window.nemo.getWindowState().then((s) => String(s.fullScreen))')

const sameBounds = (a, b) =>
  a !== null && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 2)

const spawned = []
const dirs = []

/**
 * 起動 → `fn(windows)` → 終了 → main の例外を見る、を 1 回ぶん。
 * `windows` は復元順（ウィンドウ ID 1, 2, …）のサイドバーのセッション。
 */
async function withApp(label, dir, count, fn, extraArgs = []) {
  const app = await launch(dir, extraArgs)
  spawned.push(app.child)
  const windows = await connectWindows(app.cdp, count)
  await fn(windows)
  for (const win of windows) win.close()
  await stopChildren([app.child])
  spawned.splice(spawned.indexOf(app.child), 1)
  const uncaught = findUncaughtExceptions(dir)
  check(`${label}: main プロセスに例外が出ていない`, uncaught.length === 0, uncaught.join(' / '))
}

const waitFullScreen = (session, want) =>
  waitFor(session, `window.nemo.getWindowState().then((s) => (s.fullScreen === ${want} ? 'ok' : ''))`, {
    timeoutMs: 10000
  }).catch(() => undefined)

const toggleFullScreen = (session) =>
  session.ev("window.nemo.runCommandForVerify('toggle-fullscreen').then(String)")

try {
  assertNemoNotRunning('check-session-fullscreen')

  /* 1〜2. 全画面の復元（2 枚）・旧形式の読み込み・全画面を抜ける ---------- */
  const dir = makeProfile([
    { bounds: FULL_BOUNDS, activeEphemeralId: null, splits: [], fullScreen: true },
    { bounds: FULL2_BOUNDS, activeEphemeralId: null, splits: [], fullScreen: true },
    // 版 5 の初期の形（fullScreen を持たない）
    { bounds: PLAIN_BOUNDS, activeEphemeralId: null, splits: [] }
  ])
  dirs.push(dir)
  await withApp('1〜2', dir, 3, async ([full, full2, plain]) => {
    await waitFullScreen(full, true)
    await waitFullScreen(full2, true)
    check('fullScreen: true で保存したウィンドウが全画面で戻る', (await fullScreenOf(full)) === 'true')
    check('全画面のウィンドウが 2 枚でも、2 枚目も全画面で戻る', (await fullScreenOf(full2)) === 'true')
    check('fullScreen の無い旧形式のウィンドウは全画面にならない', (await fullScreenOf(plain)) === 'false')

    let saved = await waitSaved(
      dir,
      Date.now(),
      (w) => w.length === 3 && w[0].fullScreen === true && w[1].fullScreen === true
    )
    check(
      '保存し直した session.json: 全画面の 2 枚は fullScreen: true',
      saved[0]?.fullScreen === true && saved[1]?.fullScreen === true,
      JSON.stringify(saved.slice(0, 2))
    )
    check(
      '全画面中の bounds は画面いっぱいでなく元の大きさ（getNormalBounds。2 枚とも）',
      sameBounds(saved[0]?.bounds ?? null, FULL_BOUNDS) && sameBounds(saved[1]?.bounds ?? null, FULL2_BOUNDS),
      JSON.stringify(saved.slice(0, 2).map((w) => w.bounds))
    )
    check(
      '旧形式のウィンドウは fullScreen: false・bounds はそのまま',
      saved[2]?.fullScreen === false && sameBounds(saved[2]?.bounds ?? null, PLAIN_BOUNDS),
      JSON.stringify(saved[2])
    )

    await toggleFullScreen(full)
    await waitFullScreen(full, false)
    check('全画面を抜けられる', (await fullScreenOf(full)) === 'false')
    saved = await waitSaved(dir, Date.now(), (w) => w[0]?.fullScreen === false)
    check(
      '抜けたあとは fullScreen: false・元の大きさで保存される',
      saved[0]?.fullScreen === false && sameBounds(saved[0]?.bounds ?? null, FULL_BOUNDS),
      JSON.stringify(saved[0])
    )
  })

  /* 3. 外部 URL で起こされたときは全画面にせず、次の起動へ持ち越す ------- */
  const woken = makeProfile([{ bounds: FULL_BOUNDS, activeEphemeralId: null, splits: [], fullScreen: true }])
  dirs.push(woken)
  await withApp(
    '3 URL で起こされた起動',
    woken,
    1,
    async ([back]) => {
      const since = Date.now()
      // 全画面への切り替えは非同期なので、入るなら入り終わる時間だけ待ってから見る
      await sleep(3000)
      check(
        '外部 URL で起こされたときは、背面で復元するウィンドウを全画面にしない',
        (await fullScreenOf(back)) === 'false'
      )
      const saved = await waitSaved(woken, since, (w) => w.length === 1)
      check(
        '全画面にしなかったウィンドウも fullScreen: true・元の大きさで保存される（持ち越し）',
        saved[0]?.fullScreen === true && sameBounds(saved[0]?.bounds ?? null, FULL_BOUNDS),
        JSON.stringify(saved[0])
      )
    },
    ['https://example.com/']
  )
  await withApp('3 次の普通の起動', woken, 1, async ([win]) => {
    await waitFullScreen(win, true)
    check('持ち越した次の普通の起動で全画面に戻る', (await fullScreenOf(win)) === 'true')
  })

  /* 4. 持ち越し中にユーザーが全画面に出入りしたら、その操作が正 ----------- */
  await withApp(
    '4',
    woken,
    1,
    async ([back]) => {
      await sleep(1000)
      check('（前提）URL で起こされたので全画面になっていない', (await fullScreenOf(back)) === 'false')
      await toggleFullScreen(back)
      await waitFullScreen(back, true)
      await toggleFullScreen(back)
      await waitFullScreen(back, false)
      check('（前提）全画面に入って抜けた', (await fullScreenOf(back)) === 'false')
      const saved = await waitSaved(woken, Date.now(), (w) => w[0]?.fullScreen === false)
      check(
        '持ち越し中に全画面を出入りしたら fullScreen: false で保存される',
        saved[0]?.fullScreen === false && sameBounds(saved[0]?.bounds ?? null, FULL_BOUNDS),
        JSON.stringify(saved[0])
      )
    },
    ['https://example.com/']
  )
} catch (error) {
  failures += 1
  console.error('FAIL  例外', error)
} finally {
  await stopChildren(spawned).catch((error) => console.error(error))
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks} 件の検査、${failures} 件失敗`)
process.exit(failures > 0 ? 1 : 0)
