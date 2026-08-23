#!/usr/bin/env node
/**
 * clean build した `.app` の smoke test（`mise run verify:packaged`）。
 *
 * 開発起動では通るのにパッケージすると壊れるもの
 * （ネイティブモジュールの同梱漏れ・拡張が asar の中に入っていて読めない・
 * preload の欠落）を、**実際に起動して**捕まえる。
 *
 * 使い捨てのデータディレクトリで起動するので、常用プロファイルには触らない。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectUi, sleep } from './lib/cdp.mjs'
import { getFreePort, isChildAlive, projectRoot, stopChildren, waitForHttp } from './lib/harness.mjs'

const channel = process.argv[2] === 'stable' ? 'stable' : 'dev'
const productName = channel === 'stable' ? 'Nemo' : 'Nemo Dev'

const appPath = [
  path.join(projectRoot, 'dist', channel, 'mac-arm64', `${productName}.app`),
  path.join(projectRoot, 'dist', channel, 'mac', `${productName}.app`)
].find((candidate) => fs.existsSync(candidate))

if (!appPath) {
  console.error(`[verify-packaged] .app が見つからない。先に \`mise run package\` を実行する。`)
  process.exit(1)
}

// 同じ .app のインスタンスが残っていると、起動しても新しいプロセスが立たず
// CDP を待ち続けて失敗する。先に見つけて理由を出す（原因が分かりにくい失敗なので）。
const strays = (() => {
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    return out
      .split('\n')
      .filter((line) => line.includes(`${appPath}/Contents/MacOS/`) && !line.includes('Helper'))
      .map((line) => line.trim().split(/\s+/)[0])
  } catch {
    return []
  }
})()
if (strays.length > 0) {
  console.error(`[verify-packaged] 同じ .app が起動したままになっている: pid ${strays.join(', ')}`)
  console.error(`  終了させてから実行する:  kill ${strays.join(' ')}`)
  process.exit(1)
}

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-packaged-'))
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-packaged-dl-'))

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = []
let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
  spawned.push(child)
  return child
}

try {
  const pagesChild = start(process.execPath, ['scripts/test-server.mjs'], {
    env: { ...process.env, PORT: pagesPort },
    stdio: 'ignore'
  })
  await waitForHttp(`${pages}/__nemo_test_pages__`, {
    child: pagesChild,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${pagesChild.pid}`)
  })

  const executable = path.join(appPath, 'Contents', 'MacOS', productName)
  const app = start(executable, [], {
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: debugPort,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: downloadDir
    }
  })
  // ビルドし直した直後の初回起動は、macOS 側のスキャン（Gatekeeper / Spotlight）で
  // 数十秒かかることがある。45 秒だと不安定に落ちたので余裕を持たせる。
  // 本当に起動していないなら、下の catch で子プロセスの状態まで出す。
  await waitForHttp(`${cdp}/json/list`, {
    child: app,
    timeoutMs: 150000,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  }).catch((error) => {
    throw new Error(`${error.message}（pid ${app.pid} / 生存: ${isChildAlive(app)} / .app: ${appPath}）`)
  })
  check('パッケージした .app が起動してブラウザ UI を表示する', true)

  const ui = await connectUi(cdp)

  // 拡張（Chromium のローダーは asar の中を読めないので、ここで落ちるなら同梱の仕方が間違い）
  const extensions = await ui
    .ev('window.nemo.getExtensions().then((e) => JSON.stringify(e))')
    .then(JSON.parse)
  check(
    'lock された拡張がパッケージ後もロードされる',
    extensions.length > 0 && extensions.every((e) => e.matchesLock),
    extensions.map((e) => `${e.name} ${e.version}`).join(', ') || '（1つもロードされていない）'
  )

  // SQLite（better-sqlite3 のネイティブバイナリが asar の外に出ていないとここで落ちる）。
  // **タブを閉じてから**候補を引く。開いたままだと「タブ」候補で一致してしまい、
  // SQLite が壊れていても PASS する。
  const key = await ui.ev(`window.nemo.createTab('${pages}/login.html').then((k) => k)`)
  await sleep(2500)
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
  await sleep(500)
  const history = await ui
    .ev(`window.nemo.suggest('login').then((s) => JSON.stringify(s.map((x) => x.kind)))`)
    .then(JSON.parse)
  check('履歴（SQLite）がパッケージ後も動く', history.includes('history'), history.join(','))

  // 診断ログがデータディレクトリに出ている
  const logDir = path.join(userDataDir, 'logs')
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir) : []
  check('診断ログがデータディレクトリに出る', logs.length > 0, logs.join(', '))

  ui.close()
} catch (error) {
  failures += 1
  console.error(`[verify-packaged] ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await stopChildren(spawned.filter(isChildAlive)).catch((error) => {
    failures += 1
    console.error(`[verify-packaged] ${error.message}`)
  })
  if (spawned.filter(isChildAlive).length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  } else {
    failures += 1
    console.error(`[verify-packaged] 生き残ったプロセスがある。一時ディレクトリを残した: ${userDataDir}`)
  }
}

console.log(failures === 0 ? '\nverify-packaged: すべて PASS' : `\nverify-packaged: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
