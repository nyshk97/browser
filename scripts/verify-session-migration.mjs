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
