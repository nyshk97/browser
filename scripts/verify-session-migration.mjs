#!/usr/bin/env node
/**
 * 版 2 のセッションファイルから起動して、移行が壊れていないことを確かめる。
 *
 * これは**一度きりの移行**で、ユーザーはやり直せない。壊れると
 * 「前回のピン留めタブが一時タブとして大量に復活する」「選択タブがずれる」
 * という形で、気づいたときには元のセッションが上書きされている。
 * だから正規化のユニットテストとは別に、**実際に起動して**確かめる。
 *
 * 単体で回せる（`node scripts/verify-session-migration.mjs`）。
 * 使い捨てのデータディレクトリを作り、そこに版 2 の session.json を置いて起動する。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectUi } from './lib/cdp.mjs'
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

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const debugPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-migrate-'))

/**
 * 版 2 のセッション。
 * - 先頭とアクティブの手前がピン留めタブ（＝落ちる）
 * - アクティブは3番目の一時タブ → 移行後は 1 番目に来るはず
 */
const V2_SESSION = {
  version: 2,
  data: {
    windows: [
      {
        bounds: null,
        activeIndex: 3,
        tabs: [
          { url: 'https://pin-a.example/', title: 'ピンA', pinnedId: 'p-a', lastActiveAt: Date.now() },
          { url: 'https://tmp-1.example/', title: '一時1', pinnedId: null, lastActiveAt: Date.now() },
          { url: 'https://pin-b.example/', title: 'ピンB', pinnedId: 'p-b', lastActiveAt: Date.now() },
          { url: 'https://tmp-2.example/', title: '一時2', pinnedId: null, lastActiveAt: Date.now() }
        ]
      },
      {
        // ピン留めタブしか無いウィンドウは丸ごと落ちる
        bounds: null,
        activeIndex: 0,
        tabs: [{ url: 'https://pin-c.example/', title: 'ピンC', pinnedId: 'p-c', lastActiveAt: Date.now() }]
      }
    ],
    cleanExit: true,
    savedAt: Date.now()
  }
}

/** 版 1 の pins.json（customTitle が無い）も一緒に置いて、両方の移行を1度に見る。 */
const V1_PINS = {
  version: 1,
  data: {
    favorites: [{ id: 'f-a', url: 'https://fav-a.example/', title: 'お気に入りA' }],
    pinned: [
      { id: 'p-a', kind: 'link', url: 'https://pin-a.example/', title: 'ピンA' },
      {
        id: 'folder',
        kind: 'folder',
        title: '外',
        collapsed: false,
        children: [
          { id: 'p-b', kind: 'link', url: 'https://pin-b.example/', title: 'ピンB' },
          {
            id: 'inner',
            kind: 'folder',
            title: '中',
            children: [{ id: 'p-c', kind: 'link', url: 'https://pin-c.example/', title: 'ピンC' }]
          }
        ]
      }
    ]
  }
}

fs.writeFileSync(path.join(userDataDir, 'session.json'), `${JSON.stringify(V2_SESSION, null, 2)}\n`)
fs.writeFileSync(path.join(userDataDir, 'pins.json'), `${JSON.stringify(V1_PINS, null, 2)}\n`)

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = []
let exitCode = 0

try {
  assertNemoNotRunning('verify-session-migration')
  console.log(`（CDP ${cdp} / userData ${userDataDir}）`)

  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: debugPort,
      NEMO_USER_DATA_DIR: userDataDir
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })

  const ui = await connectUi(cdp)
  const state = await ui.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
  const shared = await ui.ev('window.nemo.getSharedState().then(s => JSON.stringify(s))').then(JSON.parse)

  const urls = state.tabs.map((tab) => tab.url)
  check(
    '版 2 のピン留めタブは一時タブとして復活しない',
    !urls.some((url) => url.includes('pin-a') || url.includes('pin-b') || url.includes('pin-c')),
    urls.join(', ')
  )
  check(
    '一時タブは復元される',
    urls.some((url) => url.includes('tmp-1')) && urls.some((url) => url.includes('tmp-2')),
    urls.join(', ')
  )
  const active = state.tabs.find((tab) => tab.key === state.activeTabKey)
  check(
    '移行後も元のアクティブタブが選ばれたまま',
    active?.url.includes('tmp-2') === true,
    `${active?.url} / ${active?.title}`
  )
  check(
    '復元したタブに所属は付かない',
    state.tabs.every((tab) => tab.pinnedId === null && tab.favoriteId === null),
    JSON.stringify(state.tabs.map((tab) => [tab.pinnedId, tab.favoriteId]))
  )

  const folder = shared.pinned.find((node) => node.kind === 'folder')
  check(
    '版 1 の pins.json が読める（Favorites とピン留めが残る）',
    shared.favorites.length === 1 && shared.pinned.length === 2,
    JSON.stringify({ favorites: shared.favorites.length, pinned: shared.pinned.length })
  )
  check(
    '2階層目のフォルダは中身を親へ平坦化して読む',
    folder?.children?.length === 2 && folder.children.every((node) => node.kind === 'link'),
    JSON.stringify(folder?.children?.map((node) => [node.kind, node.title]))
  )
  check(
    '版 1 の定義は customTitle 未設定として読める',
    shared.favorites.every((item) => item.customTitle === null) &&
      shared.pinned.every((node) => node.customTitle === null),
    JSON.stringify(shared.pinned.map((node) => node.customTitle))
  )

  ui.close()

  /* ---------------------------------------------------------------- *
   * 版 4（分割ビュー）
   *
   * **交差する組は通常操作では作れない**（`splitTabs` は右を左の直後へ並べ、
   * `toSaved()` も隣接形で書く）ので、再起動の検証では再現できない。
   * ここだけが「添字を先に全部解決してから並べ替える」を踏める場所。
   * ---------------------------------------------------------------- */
  const splitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-migrate-split-'))
  const url = (name) => `https://example.com/${name}`
  fs.writeFileSync(
    path.join(splitDir, 'session.json'),
    `${JSON.stringify(
      {
        version: 4,
        data: {
          windows: [
            {
              bounds: null,
              activeIndex: 0,
              tabs: ['s0', 's1', 's2', 's3'].map((name) => ({
                url: url(name),
                title: name,
                customTitle: null,
                lastActiveAt: Date.now()
              })),
              // 交差する組（0-2 と 1-3）
              splits: [
                [0, 2],
                [1, 3]
              ]
            }
          ],
          cleanExit: true,
          savedAt: Date.now()
        }
      },
      null,
      2
    )}\n`
  )

  /**
   * 一時プロファイルで起動して、ウィンドウの状態を読む。
   *
   * **毎回ポートを採番する**。プロファイルごとに独立して立ち上げるので、
   * 使い回すと前の Electron が落ちきる前に次が同じポートを掴もうとする。
   */
  const readSplitSession = async (label, dir) => {
    const port = String(await getFreePort())
    const endpoint = `http://127.0.0.1:${port}`
    const proc = spawn(electronPath, ['out/main/index.js'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, NEMO_REMOTE_DEBUGGING_PORT: port, NEMO_USER_DATA_DIR: dir }
    })
    spawned.push(proc)
    await waitForHttp(`${endpoint}/json/list`, {
      child: proc,
      check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
    })
    const session = await connectUi(endpoint)
    const read = await session
      .ev('window.nemo.getWindowState().then(s => JSON.stringify(s))')
      .then(JSON.parse)
    session.close()
    await stopChildren([proc])
    spawned.splice(spawned.indexOf(proc), 1)
    /*
     * **止めたあとに main のログを見る**。最後の `findUncaughtExceptions()` は
     * 最初の `userDataDir` しか見ないので、ここで見ないと
     * 「main が例外を握って処理を続けた」ときに状態検査だけ通って PASS してしまう。
     */
    const uncaughtHere = findUncaughtExceptions(dir)
    check(`${label}: main プロセスに例外が出ていない`, uncaughtHere.length === 0, uncaughtHere.join(' / '))
    console.log(`（${label}: タブ ${read.tabs.length} 本）`)
    return read
  }

  /** 分割の組を URL の対にして返す（添字ではなく **URL** で突き合わせる）。 */
  const pairsOf = (read) =>
    read.tabs
      .filter((tab) => tab.splitSide === 'left')
      .map((left) => [left.url, read.tabs.find((tab) => tab.key === left.splitPartnerKey)?.url ?? null])

  const firstRun = await readSplitSession('版 4 の初回起動', splitDir)
  check(
    '版 4: 交差する組が意図どおりに繋がる',
    JSON.stringify(pairsOf(firstRun)) ===
      JSON.stringify([
        [url('s0'), url('s2')],
        [url('s1'), url('s3')]
      ]),
    JSON.stringify(pairsOf(firstRun))
  )
  const firstActive = firstRun.tabs.find((tab) => tab.key === firstRun.activeTabKey)
  check('版 4: アクティブタブが並べ替えでずれない', firstActive?.url === url('s0'), firstActive?.url)

  // **2 回目**。初回の終了時に正規化済みの版 4 が書かれるので、
  // それを読み直す経路が壊れていても初回だけでは気づけない。
  const secondRun = await readSplitSession('版 4 の 2 回目の起動', splitDir)
  check(
    '版 4: 2 回目の起動でも同じ組・同じアクティブタブ（冪等）',
    JSON.stringify(pairsOf(secondRun)) === JSON.stringify(pairsOf(firstRun)) &&
      secondRun.tabs.find((tab) => tab.key === secondRun.activeTabKey)?.url === firstActive?.url,
    JSON.stringify(pairsOf(secondRun))
  )

  fs.rmSync(splitDir, { recursive: true, force: true })

  /* ---------------------------------------------------------------- *
   * 版 4 + `moved`（除外されたタブがあるときの添字の読み替え）
   *
   * **組の「前」と「間」に除外対象を置く**（版 2 以前のピン留めタブと不正 URL）。
   * 読み替えを間違えると **有効な組が別のタブに繋がる** —— 一番危険なのに、
   * 無効値を捨てる検査だけでは検知できない。`normalizeSession` のユニットテストと
   * 別に**実アプリの復元まで通す**（正規化と復元側の添字の受け渡しが噛み合って
   * いなければここで落ちる）。
   * ---------------------------------------------------------------- */
  const movedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-migrate-moved-'))
  fs.writeFileSync(
    path.join(movedDir, 'session.json'),
    `${JSON.stringify(
      {
        version: 4,
        data: {
          windows: [
            {
              bounds: null,
              // 添字 3（= 読み替え後 1 の「右」）を選んでおく。
              // `activeIndex` の読み替えが壊れていてもここで落ちる。
              activeIndex: 3,
              tabs: [
                // 落ちる（版 2 以前のピン留めタブ）
                { url: url('m-pinned'), title: 'p', customTitle: null, pinnedId: 'pin-1', lastActiveAt: 1 },
                // → 0（左）
                { url: url('m-left'), title: 'L', customTitle: null, lastActiveAt: 1 },
                // 落ちる（`https?:` 以外）
                { url: 'file:///etc/passwd', title: 'x', customTitle: null, lastActiveAt: 1 },
                // → 1（右）
                { url: url('m-right'), title: 'R', customTitle: null, lastActiveAt: 1 }
              ],
              splits: [[1, 3]]
            }
          ],
          cleanExit: true,
          savedAt: Date.now()
        }
      },
      null,
      2
    )}\n`
  )

  const movedRun = await readSplitSession('版 4 + moved の初回起動', movedDir)
  check(
    '版 4: 組の前と間にタブが落ちても、左右が正しい URL に繋がる',
    JSON.stringify(pairsOf(movedRun)) === JSON.stringify([[url('m-left'), url('m-right')]]),
    JSON.stringify(pairsOf(movedRun))
  )
  check(
    '版 4: 除外で添字が動いてもアクティブタブがずれない',
    movedRun.tabs.find((tab) => tab.key === movedRun.activeTabKey)?.url === url('m-right'),
    movedRun.tabs.find((tab) => tab.key === movedRun.activeTabKey)?.url
  )
  // **2 回目**も見る（1 回目の終了時に読み替え済みの版 4 が書き直される）
  const movedSecond = await readSplitSession('版 4 + moved の 2 回目の起動', movedDir)
  check(
    '版 4: 読み替えたあとも 2 回目の起動で同じ組（冪等）',
    JSON.stringify(pairsOf(movedSecond)) === JSON.stringify(pairsOf(movedRun)),
    JSON.stringify(pairsOf(movedSecond))
  )

  fs.rmSync(movedDir, { recursive: true, force: true })
} catch (error) {
  console.error(`\n[migration] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await stopChildren(spawned.filter(isChildAlive))
  const uncaught = findUncaughtExceptions(userDataDir)
  if (uncaught.length > 0) {
    exitCode = 1
    console.error(`\n[migration] main プロセスの例外がログに残っている:\n  ${uncaught.join('\n  ')}`)
  }
  if (spawned.every((c) => !isChildAlive(c))) fs.rmSync(userDataDir, { recursive: true, force: true })
  else console.error(`[migration] 生き残りがいるので一時ディレクトリを残した: ${userDataDir}`)
}

if (failures > 0) exitCode = 1
console.log(failures === 0 ? '\nverify-session-migration: すべて PASS' : `\n${failures} 件 FAIL`)
process.exit(exitCode)
