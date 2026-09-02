#!/usr/bin/env node
/**
 * ローカルファイル（`file://`）の自走検証（2026-09-02 の plan「ローカルファイル」）。
 *
 * 「人間が明示的に開いた経路だけ `file:` を通す」:
 * - 通す: argv の `file://`（第 2 インスタンス）/ OS の `open-file` / アドレスバーのパス入力 / file → file のリンク
 * - 通さない: http ページからの `location.href` / `window.open`、file ページからの `window.open`
 * - 一時タブ定義には載せない（`ephemeral-tabs.json` に `file:` が現れず、既存定義の url / title も汚れない）
 * - アドレスバーで拒否された入力は入力欄に残り、赤枠が付く
 *
 * 単体で回せる（`node scripts/verify-local-file.mjs`）。
 * 使い捨てのデータディレクトリで**自分でアプリを起動する**。`open -a <Electron.app>` は
 * バンドル単位の配送で宛先インスタンスを選べないため、共有アプリには相乗りしない。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  isChildAlive,
  projectRoot,
  readLogLines,
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
function skip(name, reason) {
  console.log(`SKIP  ${name} — ${reason}`)
}
const json = (value) => JSON.stringify(value)

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const CDP = `http://127.0.0.1:${debugPort}`
const PAGES = `http://127.0.0.1:${pagesPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-local-file-'))

const pagesDir = path.join(projectRoot, 'test-pages')
const localA = path.join(pagesDir, 'local-a.html')
const localB = path.join(pagesDir, 'local-b.html')
/** `file://` URL（クエリで開いた経路を区別し、CDP の target 選びを取り違えない）。 */
const fileUrl = (filePath, who) => `${pathToFileURL(filePath).href}?who=${who}`

const appEnv = {
  ...process.env,
  NEMO_REMOTE_DEBUGGING_PORT: debugPort,
  NEMO_USER_DATA_DIR: userDataDir
}

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = []
let exitCode = 0

async function startApp() {
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: appEnv
  })
  spawned.push(child)
  await waitForHttp(`${CDP}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return child
}

/** 外部から URL を渡されたのと同じ経路（第 2 インスタンス → second-instance → 小窓）。 */
async function openViaSecondInstance(url) {
  await new Promise((resolve) => {
    const child = spawn(electronPath, ['out/main/index.js', url], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: appEnv
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

const state = (session) =>
  session.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
const defs = (session) =>
  session.ev('window.nemo.getSharedState().then(s => JSON.stringify(s.ephemeralTabs ?? []))').then(JSON.parse)

/** 小窓の UI target（`?view=mini`）の数。 */
async function miniCount() {
  return (await listTargets(CDP)).filter((t) => t.url.includes('view=mini')).length
}

async function waitMiniCount(n, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await miniCount()
    if (count >= n) return count
    if (Date.now() > deadline) return count
    await sleep(300)
  }
}

/** そのタブの URL が条件を満たすまで待つ（満たさなければ最後の URL を返す）。 */
async function waitTabUrl(ui, key, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await state(ui)
    const url = s.tabs.find((t) => t.key === key)?.url ?? ''
    if (predicate(url)) return url
    if (Date.now() > deadline) return url
    await sleep(200)
  }
}

const tabOf = async (ui, key) => (await state(ui)).tabs.find((t) => t.key === key) ?? null

/** そのタブの読み込みが終わるまで待つ。 */
async function waitLoaded(ui, key, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tab = await tabOf(ui, key)
    if (tab && tab.loading === false) return
    if (Date.now() > deadline) return
    await sleep(200)
  }
}

/**
 * アドレスバー相当の入力でナビゲートする。
 *
 * Electron の `loadURL` は**直前の読み込みが中断された**ときに ERR_ABORTED（-3）で reject する
 * （新しい方の promise に古い失敗が乗る既知の癖）。ポリシー拒否ではないので握り潰し、
 * それ以外（`navigation rejected` 等）はそのまま投げる。
 */
async function nav(ui, key, input) {
  await waitLoaded(ui, key)
  await ui.ev(
    `window.nemo.navigate(${json(key)}, ${json(input)}).then(() => 'ok', (e) => (/\\(-3\\)/.test(String(e)) ? 'aborted' : Promise.reject(e)))`
  )
}

/** ページ側の target に繋ぐ（URL のクエリで経路ごとに区別する）。 */
async function connectPage(urlPart) {
  const session = await connectTo(CDP, urlPart, { type: 'page' })
  await waitFor(session, "document.readyState === 'complete' ? 'ok' : ''")
  return session
}

function countBlocked(phase) {
  return readLogLines(userDataDir).filter(
    (line) => line.includes('"event":"navigation.blocked"') && line.includes(`"phase":"${phase}"`)
  ).length
}

function countOpenFile() {
  return readLogLines(userDataDir).filter(
    (line) => line.includes('"event":"open_url.handled"') && line.includes('"source":"open-file"')
  ).length
}

/** 2 枚目のウィンドウを開いて、その UI に繋ぐ（`verify-shared-tabs.mjs` と同じ手筋）。 */
async function openSecondWindow(ui) {
  const before = new Set(
    (await listTargets(CDP)).filter((t) => t.url.includes('view=sidebar')).map((t) => t.url)
  )
  await ui.ev('window.nemo.createWindow().then(() => "ok")')
  const deadline = Date.now() + 15000
  for (;;) {
    const fresh = (await listTargets(CDP)).find(
      (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1') && !before.has(t.url)
    )
    if (fresh) {
      const session = await connectTo(CDP, new URL(fresh.url).search.slice(1))
      await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
      return session
    }
    if (Date.now() > deadline) throw new Error('2枚目のウィンドウの UI に繋げない')
    await sleep(200)
  }
}

try {
  assertNemoNotRunning('verify-local-file')
  console.log(`（CDP ${CDP} / pages ${PAGES} / userData ${userDataDir}）`)

  // Live Folder は止めておく（自走検証から実 GitHub を叩かない）
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    `${JSON.stringify({ version: 1, data: { liveFolderEnabled: false } }, null, 2)}\n`
  )

  // ページサーバ（http 側からの `file:` 遷移の拒否と、共有定義の検査に要る）
  const pagesChild = spawn(process.execPath, ['scripts/test-server.mjs'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: { ...process.env, PORT: pagesPort }
  })
  spawned.push(pagesChild)
  await waitForHttp(`${PAGES}/__nemo_test_pages__`, {
    child: pagesChild,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${pagesChild.pid}`)
  })

  await startApp()
  const ui = await connectUi(CDP)

  /* ---------------------------------------------------------------- *
   * 1. OS / argv からの経路（小窓）
   * ---------------------------------------------------------------- */
  console.log('\n--- argv / open-file → 小窓')

  {
    const before = await miniCount()
    await openViaSecondInstance(fileUrl(localA, 'argv'))
    const after = await waitMiniCount(before + 1)
    check('argv の file:// は小窓で開く', after === before + 1, `${before} → ${after} 枚`)
    const target = (await listTargets(CDP)).find((t) => t.type === 'page' && t.url.includes('who=argv'))
    check(
      '小窓のタブ URL が file:// になる',
      target?.url.startsWith('file://') === true,
      target?.url ?? '(無し)'
    )
    if (target) {
      const page = await connect(target.webSocketDebuggerUrl)
      await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
      const title = await page.ev('document.title')
      check('小窓でローカル HTML が描画される（document.title）', title === 'local-a', title)
      page.close()
    }
  }

  {
    // Finder / `open <path>` と同じ `open-file` イベント。`open -a` はバンドル単位の配送なので
    // **dev の Electron.app に向ける**（常用 Nemo には絶対に渡さない）
    const appBundle = path.resolve(path.dirname(electronPath), '..', '..')
    const name = 'open-file（Finder / open <path>）で小窓が開く'
    if (process.platform !== 'darwin' || !appBundle.endsWith('.app')) {
      skip(name, `open -a を使えない環境（${process.platform} / ${appBundle}）。人間の確認に落とす`)
    } else {
      const beforeMini = await miniCount()
      const beforeHandled = countOpenFile()
      await new Promise((resolve) => {
        const child = spawn('open', ['-a', appBundle, localB], { stdio: 'ignore' })
        child.on('exit', () => resolve())
        child.on('error', () => resolve())
      })
      const deadline = Date.now() + 10000
      while (countOpenFile() <= beforeHandled && Date.now() < deadline) await sleep(300)
      if (countOpenFile() <= beforeHandled) {
        skip(
          name,
          `10 秒待っても open_url.handled source=open-file が増えない（LaunchServices が ${appBundle} に配送しない）。` +
            'Finder の「このアプリケーションで開く」/ `open -a <dev の .app>` を人間が確認する。' +
            '別の Electron が新規起動していないか（既定の Nemo-dev プロファイルで動き、この検証は止められない）も確認する'
        )
      } else {
        const afterMini = await waitMiniCount(beforeMini + 1)
        check(name, afterMini === beforeMini + 1, `${beforeMini} → ${afterMini} 枚`)
        const target = (await listTargets(CDP)).find(
          (t) => t.type === 'page' && t.url.startsWith('file://') && t.url.endsWith('local-b.html')
        )
        check('open-file の小窓のタブ URL が file:// になる', Boolean(target), target?.url ?? '(無し)')
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 2. アドレスバー（人間の入力）
   * ---------------------------------------------------------------- */
  console.log('\n--- アドレスバーの入力')

  const key = await ui.ev(`window.nemo.createTab(${json(`${PAGES}/index.html?site=addr`)}).then(k => k)`)
  await waitTabUrl(ui, key, (u) => u.includes('site=addr'))

  {
    await nav(ui, key, localA)
    const url = await waitTabUrl(ui, key, (u) => u.startsWith('file://'))
    check('絶対パスの入力は file:// になる', url.startsWith('file://') && url.endsWith('local-a.html'), url)
  }
  {
    await nav(ui, key, fileUrl(localB, 'typed'))
    const url = await waitTabUrl(ui, key, (u) => u.includes('who=typed'))
    check('file:// URL の入力はそのまま開く', url.startsWith('file://') && url.includes('local-b.html'), url)
  }
  {
    await nav(ui, key, '/no/such/path/nemo-local-file-check')
    const url = await waitTabUrl(ui, key, (u) => u.includes('google.com/search'))
    check(
      '実在しないパスは file:// にせず検索へ落とす',
      url.includes('google.com/search') && url.includes('nemo-local-file-check'),
      url
    )
  }
  {
    const rel = path.relative(os.homedir(), localA)
    const name = '~/ 始まりの入力は homedir 配下に解決される'
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      skip(name, `リポジトリが homedir の外にある（${rel}）`)
    } else {
      await nav(ui, key, `~/${rel}`)
      const url = await waitTabUrl(ui, key, (u) => u.startsWith('file://') && u.endsWith('local-a.html'))
      check(name, url.startsWith('file://') && url.endsWith('local-a.html'), url)
    }
  }

  /* ---------------------------------------------------------------- *
   * 2b. ⌘L のコマンドバー（`suggest.ts` の「そのまま実行」行）も同じ判定を通る
   * ---------------------------------------------------------------- */
  console.log('\n--- コマンドバーの候補')

  {
    const suggest = (q) =>
      ui.ev(`window.nemo.suggest(${json(q)}).then(s => JSON.stringify(s))`).then(JSON.parse)
    const first = (list) => list.find((item) => item.kind === 'url' || item.kind === 'search') ?? null

    const byPath = first(await suggest(localA))
    check(
      'コマンドバー: 絶対パスの「そのまま実行」行は file:// を開く',
      byPath?.kind === 'url' &&
        byPath.target?.url?.startsWith('file://') === true &&
        byPath.target.url.endsWith('local-a.html'),
      json(byPath)
    )
    const byUrl = first(await suggest(fileUrl(localB, 'suggest')))
    check(
      'コマンドバー: file:// URL の行が出る（kind=url）',
      byUrl?.kind === 'url' && byUrl.target?.url === fileUrl(localB, 'suggest'),
      json(byUrl)
    )
    const missing = first(await suggest('/no/such/path/nemo-local-file-suggest'))
    check(
      'コマンドバー: 実在しないパスは検索行のまま',
      missing?.kind === 'search' && missing.target?.url?.includes('google.com/search') === true,
      json(missing)
    )
  }

  /* ---------------------------------------------------------------- *
   * 3. file → file のリンクは通り、http / file からの window.open と http → file は通らない
   * ---------------------------------------------------------------- */
  console.log('\n--- ページ起点のナビゲーション')

  {
    await nav(ui, key, fileUrl(localA, 'link'))
    await waitTabUrl(ui, key, (u) => u.includes('who=link'))
    const page = await connectPage('who=link')
    await page.ev(`(document.getElementById('to-b').click(), 'clicked')`)
    const url = await waitTabUrl(ui, key, (u) => u.endsWith('local-b.html'))
    check(
      'file: ページ内の相対リンクで別の file: へ遷移できる',
      url.startsWith('file://') && url.endsWith('local-b.html'),
      url
    )
    page.close()
  }

  {
    await nav(ui, key, `${PAGES}/local-a.html?who=http`)
    await waitTabUrl(ui, key, (u) => u.includes('who=http'))
    const page = await connectPage('who=http')
    const before = (await state(ui)).tabs.length
    const beforeMini = await miniCount()
    const beforeBlocked = countBlocked('will-navigate') + countBlocked('popup')

    await page.ev(`window.tryNavigate(${json(fileUrl(localB, 'http-nav'))})`)
    await sleep(1500)
    const url = (await tabOf(ui, key))?.url ?? ''
    check('http ページからの location.href = file: は遷移しない', url.includes('who=http'), url)

    await page.ev(`window.tryOpen(${json(fileUrl(localB, 'http-open'))})`)
    await sleep(1500)
    const after = (await state(ui)).tabs.length
    const afterMini = await miniCount()
    check(
      'http ページの window.open(file:) でタブも小窓も増えない',
      after === before && afterMini === beforeMini,
      `tabs ${before} → ${after} / mini ${beforeMini} → ${afterMini}`
    )
    console.log(
      `      （補助: navigation.blocked will-navigate+popup ${beforeBlocked} → ${countBlocked('will-navigate') + countBlocked('popup')}。` +
        'Chromium が renderer 内で止めた分は main のログに出ない）'
    )
    page.close()
  }

  {
    await nav(ui, key, fileUrl(localA, 'file-open'))
    await waitTabUrl(ui, key, (u) => u.includes('who=file-open'))
    const page = await connectPage('who=file-open')
    const before = (await state(ui)).tabs.length
    const beforeMini = await miniCount()
    await page.ev(`window.tryOpen(${json(fileUrl(localB, 'file-open-child'))})`)
    await sleep(1500)
    const after = (await state(ui)).tabs.length
    const afterMini = await miniCount()
    check(
      'file: ページの window.open(file:) も拒否（起点が人間でない）',
      after === before && afterMini === beforeMini,
      `tabs ${before} → ${after} / mini ${beforeMini} → ${afterMini}`
    )
    page.close()
  }

  /* ---------------------------------------------------------------- *
   * 4. 一時タブ定義には載せない
   * ---------------------------------------------------------------- */
  console.log('\n--- 一時タブ定義')

  {
    const defKey = await ui.ev(
      `window.nemo.createTab(${json(`${PAGES}/index.html?site=deftest`)}).then(k => k)`
    )
    await waitTabUrl(ui, defKey, (u) => u.includes('site=deftest'))
    await waitFor(
      ui,
      `window.nemo.getSharedState().then(s => ((s.ephemeralTabs ?? []).some(d => d.url.includes('site=deftest'))) ? 'ok' : '')`
    )
    // http ページ本来の題名と favicon が定義に写るまで待つ（写った後の値が「汚れない」ことを見る。
    // 題名は URL がフォールバックで入るので、URL でない値になるまで待つ）
    await waitFor(
      ui,
      `window.nemo.getSharedState().then(s => { const d = (s.ephemeralTabs ?? []).find(d => d.url.includes('site=deftest')); return d && d.title && !d.title.startsWith('http') && d.faviconUrl ? 'ok' : '' })`
    )
    const beforeDef = (await defs(ui)).find((d) => d.url.includes('site=deftest'))
    const tabBefore = await tabOf(ui, defKey)
    check(
      '共有定義を持つタブができている',
      Boolean(beforeDef) && tabBefore?.ephemeralId === beforeDef?.id,
      json(beforeDef)
    )

    await nav(ui, defKey, fileUrl(localB, 'def'))
    await waitTabUrl(ui, defKey, (u) => u.includes('who=def'))
    // 題名（local-b）が来るまで待ってから定義を見る
    await waitFor(
      ui,
      `window.nemo.getWindowState().then(s => (s.tabs.find(t => t.key === ${json(defKey)})?.title === 'local-b') ? 'ok' : '')`
    )
    await sleep(800)
    const afterDef = (await defs(ui)).find((d) => d.id === beforeDef?.id)
    check(
      '共有タブを file: へ飛ばしても定義の url / title / favicon は変わらない',
      Boolean(afterDef) &&
        afterDef.url === beforeDef.url &&
        afterDef.title === beforeDef.title &&
        (afterDef.faviconUrl ?? null) === (beforeDef.faviconUrl ?? null),
      json({ before: beforeDef, after: afterDef })
    )
  }

  {
    const list = await defs(ui)
    const fileDefs = list.filter((d) => !/^https?:\/\//.test(d.url))
    check(
      'file: のタブは ephemeral-tabs.json に現れない',
      list.length > 0 && fileDefs.length === 0,
      `${list.length} 件中 file: ${fileDefs.length} 件`
    )

    const raw = fs.existsSync(path.join(userDataDir, 'ephemeral-tabs.json'))
      ? fs.readFileSync(path.join(userDataDir, 'ephemeral-tabs.json'), 'utf8')
      : ''
    check(
      'ephemeral-tabs.json の生データにも file:// が無い',
      raw.length > 0 && !raw.includes('file://'),
      `${raw.length} bytes`
    )

    // 他ウィンドウには出ない（file: タブはウィンドウローカル）
    const uiB = await openSecondWindow(ui)
    const sB = await state(uiB)
    const fileTabsInB = sB.tabs.filter((t) => t.url.startsWith('file://'))
    const fileTabsInA = (await state(ui)).tabs.filter((t) => t.url.startsWith('file://'))
    check(
      'file: タブは自分のウィンドウにだけあり、他ウィンドウには出ない',
      fileTabsInA.length > 0 && fileTabsInB.length === 0,
      `A ${fileTabsInA.length} 件 / B ${fileTabsInB.length} 件`
    )
    uiB.close()
  }

  /* ---------------------------------------------------------------- *
   * 5. アドレスバーで拒否された入力は無言にしない
   * ---------------------------------------------------------------- */
  console.log('\n--- アドレスバーの拒否表示')

  {
    await ui.ev(`window.nemo.selectTab(${json(key)}).then(() => 'ok')`)
    // 直前で 2 枚目のウィンドウを開いたままなので、**ウィンドウ A のツールバーを名指しで**選ぶ
    // （`view=toolbar` の先頭を拾うと `/json/list` の並び次第でウィンドウ B を掴み、検査が自明に PASS する）
    const windowId = (await tabOf(ui, key))?.windowId
    const toolbar = await connectUi(CDP, 'toolbar', {
      urlPart: `view=toolbar&window=${windowId}`,
      exclude: 'pane=right',
      waitReady: false
    })
    await waitFor(toolbar, "document.querySelector('.toolbar .addr') ? 'ok' : ''")
    await toolbar.ev(`(document.querySelector('.toolbar button.addr').click(), 'ok')`)
    await waitFor(toolbar, "document.querySelector('.toolbar .addr.editing input') ? 'ok' : ''")
    await toolbar.ev(`(() => {
      const input = document.querySelector('.toolbar .addr.editing input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'javascript:alert(1)')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.form.requestSubmit()
      return 'submitted'
    })()`)
    let shown = true
    try {
      await waitFor(
        toolbar,
        "document.querySelector('.toolbar .addr.editing.rejected input')?.value === 'javascript:alert(1)' ? 'ok' : ''",
        {
          timeoutMs: 5000
        }
      )
    } catch {
      shown = false
    }
    const snapshot = JSON.parse(
      await toolbar.ev(
        "JSON.stringify({ cls: document.querySelector('.toolbar .addr')?.className, value: document.querySelector('.toolbar .addr input')?.value ?? null, title: document.querySelector('.toolbar .addr')?.getAttribute('title') })"
      )
    )
    check('拒否された入力は入力欄に残り、赤枠（.rejected）が付く', shown, json(snapshot))
    // 文言はユーザー向け（内部識別子 `scheme_not_allowed:` は見せない。plan ログ > 方針変更）
    check(
      '理由の title はユーザー向けの文言（内部識別子を出さない）',
      typeof snapshot.title === 'string' &&
        snapshot.title.includes('開けません') &&
        !snapshot.title.includes('scheme_not_allowed'),
      json(snapshot.title)
    )
    const url = (await tabOf(ui, key))?.url ?? ''
    check('拒否された入力でタブは遷移していない', !url.startsWith('javascript:'), url)
    let cleared = true
    try {
      await waitFor(toolbar, "document.querySelector('.toolbar .addr.rejected') ? '' : 'ok'", {
        timeoutMs: 8000
      })
    } catch {
      cleared = false
    }
    check('赤枠は数秒で消える', cleared)
    toolbar.close()
  }
} catch (error) {
  console.error(`\n[local-file] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await stopChildren(spawned.filter(isChildAlive))
  const uncaught = findUncaughtExceptions(userDataDir)
  if (uncaught.length > 0) {
    exitCode = 1
    console.error(`\n[local-file] main プロセスの例外がログに残っている:\n  ${uncaught.join('\n  ')}`)
  }
  if (spawned.every((c) => !isChildAlive(c))) fs.rmSync(userDataDir, { recursive: true, force: true })
  else console.error(`[local-file] 生き残りがいるので一時ディレクトリを残した: ${userDataDir}`)
}

if (failures > 0) exitCode = 1
console.log(
  failures === 0
    ? `\nverify-local-file: すべて PASS（${checks} 件）`
    : `\nverify-local-file: ${failures} / ${checks} 件 FAIL`
)
process.exit(exitCode)
