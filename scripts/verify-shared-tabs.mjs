#!/usr/bin/env node
/**
 * 野良タブのウィンドウ横断共有（Arc 風）の自走検証。
 *
 * 「サイドバーは共有データ、ウィンドウはそのビュー」:
 * - どのウィンドウで開いたタブも、他の通常ウィンドウの共有一覧に出る
 * - アクティブ選択とページ実体はウィンドウごとに独立（同じ定義を両方で実体化できる）
 * - 閉じる = 定義ごと削除で全ウィンドウから消える / ウィンドウを閉じても定義は残る
 * - シークレット・小窓は共有に参加しない（小窓は ⌘O 合流時点で共有入り）
 * - 実体化済みの他ウィンドウは**その行を選んだ瞬間**に定義の現在 URL へ追随する
 *   （一致時は読み直さない・beforeunload に止められたら静かに残す・sleep 復帰は定義優先・
 *   会議参加中の実体は追随しない・追随後は「戻る」で戻れる）
 *
 * 単体で回せる（`node scripts/verify-shared-tabs.mjs`）。
 * 使い捨てのデータディレクトリで自分でアプリを起動する（2 枚目のウィンドウ・
 * 再起動・第 2 インスタンス起動を伴うため、共有アプリには相乗りしない）。
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
const json = (value) => JSON.stringify(value)

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const CDP = `http://127.0.0.1:${debugPort}`
const PAGES = `http://127.0.0.1:${pagesPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-shared-tabs-'))

const appEnv = {
  ...process.env,
  NEMO_REMOTE_DEBUGGING_PORT: debugPort,
  NEMO_USER_DATA_DIR: userDataDir,
  // `run-command-for-verify`（reopen-tab / close-window / new-private-window）を叩くため
  NEMO_VERIFY_DIAGNOSTICS: '1',
  // 通話ガードの検査で偽 Meet を会議と判定させる。**自分でアプリを起動するので自分で渡す**
  // （verify-call は verify-all が起こした共有アプリに相乗りしているので不要だった）
  NEMO_MEET_TEST_URL_PREFIX: `${PAGES}/meet-fake.html`,
  // beforeunload の検査: 追随起点の遷移は確認を出さずに諦めるのが仕様だが、
  // 抑止が壊れたときに**本物のネイティブ modal で main が固まる**より「離れる」が選ばれて
  // URL が変わり FAIL になるほうがよい（単体実行でハングさせない保険）
  NEMO_VERIFY_UNLOAD_CHOICE: 'leave',
  // sleep 復帰の検査で「寝かせるべきタブ」を見に行く周期を縮める（本番 5 秒）。
  // verify-all は自分の子スクリプトにこの値を渡さないので、無ければここで決める
  NEMO_VERIFY_TIMINGS: process.env.NEMO_VERIFY_TIMINGS ?? JSON.stringify({ sleepSweepMs: 500 })
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

/** 外部アプリから URL を踏んだのと同じ経路（第 2 インスタンス → second-instance → 小窓）。 */
async function openExternalUrl(url) {
  await new Promise((resolve) => {
    const child = spawn(electronPath, ['out/main/index.js', url], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: appEnv
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
  await sleep(1500)
}

/** 2 枚目のウィンドウを開いて、その UI に繋ぐ（`verify-pins.mjs` と同じ手筋）。 */
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

const state = (session) =>
  session.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
const defs = (session) =>
  session.ev('window.nemo.getSharedState().then(s => JSON.stringify(s.ephemeralTabs ?? []))').then(JSON.parse)

/** 共有一覧に URL の一部が現れる / 消えるのを待つ。 */
async function waitForDef(session, urlPart, { present = true, timeoutMs = 10000, onFail = null } = {}) {
  try {
    await waitFor(
      session,
      `window.nemo.getSharedState().then(s => ((s.ephemeralTabs ?? []).some(d => d.url.includes(${json(urlPart)})) === ${present}) ? 'ok' : '')`,
      { timeoutMs }
    )
  } catch (error) {
    // 「何が無かったか」を残す（定義一覧と、呼び出し側が渡した追加の状態）
    const list = await defs(session).catch(() => [])
    const extra = onFail ? await onFail().catch((e) => String(e)) : ''
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n  定義一覧: ${json(list.map((d) => d.url))}${extra ? `\n  ${extra}` : ''}`,
      { cause: error }
    )
  }
}

/**
 * `close-window` は**発火だけして応答を待たない**。
 * 自分のウィンドウを閉じるコマンドを invoke で待つと、応答が返る前に
 * WebContents ごと破棄されて `Runtime.evaluate` が永久に解決しない（実際にハングした）。
 */
async function closeWindowOf(session) {
  await session.ev(`(setTimeout(() => { void window.nemo.runCommandForVerify('close-window') }, 50), 'ok')`)
  session.close()
  await sleep(1000)
}

/** 指定イベントの診断ログ（時刻順）。 */
function logEvents(event) {
  return readLogLines(userDataDir)
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null && entry.event === event)
    .sort((a, b) => String(a.t).localeCompare(String(b.t)))
}

/** `fn` が null 以外を返すまで待つ（返らなければ null）。 */
async function waitUntil(fn, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline) return null
    await sleep(intervalMs)
  }
}

const tabOf = async (session, key) => (await state(session)).tabs.find((t) => t.key === key) ?? null
/** 検査の詳細に出すぶんだけ（favicon の data URL まで出すと 1 行が数 KB になる）。 */
const brief = (tab) =>
  tab ? json({ url: tab.url, asleep: tab.asleep, canGoBack: tab.canGoBack, loading: tab.loading }) : 'null'

/**
 * そのタブの読み込みが終わるまで待つ。**読み込み中のタブへ `navigate` を撃たない**ため
 * （先行ロードが中断されると Electron の `loadURL` は新しいほうの Promise を `ERR_ABORTED` で reject する）。
 */
const waitForLoaded = (session, key) =>
  waitFor(
    session,
    `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${json(key)}); return t && !t.loading ? 'ok' : '' })`
  )

/**
 * そのウィンドウで共有定義を実体化し、**初回の読み込みが終わるまで待つ**。
 * 実体化直後の初回コミット（`did-navigate`）は定義へ URL を書き戻す（最後に触った実体が勝つ）ので、
 * 待たずに他ウィンドウで遷移すると、遅れて届いた古い書き戻しが新しい URL を巻き戻すことがある
 * （verify-all 経由で 3 回中 2 回踏んだ。人間の操作では踏めない数十 ms の窓）。
 */
async function openEphemeralIn(session, defId) {
  await session.ev(`window.nemo.openEphemeral(${json(defId)}).then(() => 'ok')`)
  await waitFor(
    session,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.ephemeralId === ${json(defId)}) ? 'ok' : '')`
  )
  const inst = (await state(session)).tabs.find((t) => t.ephemeralId === defId)
  await waitForLoaded(session, inst.key)
  return inst
}

/** そのタブの URL に `urlPart` が含まれるまで待つ（含まれれば URL、諦めれば null）。 */
const waitForTabUrl = (session, key, urlPart, options) =>
  waitUntil(async () => {
    const tab = await tabOf(session, key)
    return tab && tab.url.includes(urlPart) ? tab.url : null
  }, options)

/**
 * 「読み直されたか」を見るためのページ側マーカー。**新しいドキュメントになると消える**。
 * `ev` は main world で評価するので、同じドキュメントの間だけ `window.__nemoFollowProbe` が残り、
 * 遷移で新しいドキュメントになると消える（対象は静的な test-pages なのでページ側から潰されない。
 * verify-phase1 の beforeunload 検査と同じ手筋）。
 *
 * **仕込む瞬間に `urlPart` へ一致する page target が 1 つだけ**であること（`connectTo` は
 * 最初に見つかった target を返すので、2 ウィンドウが同じ URL に居ると相手側に仕込んで空振りする）。
 */
async function plantProbe(urlPart) {
  const matches = (await listTargets(CDP)).filter((t) => t.type === 'page' && t.url.includes(urlPart))
  if (matches.length !== 1) {
    throw new Error(`マーカーの仕込み先が 1 つに定まらない: ${urlPart}（${matches.length} 件）`)
  }
  const page = await connect(matches[0].webSocketDebuggerUrl)
  await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
  await page.ev(`(window.__nemoFollowProbe = 1, 'ok')`)
  const planted = await page.ev('window.__nemoFollowProbe === 1')
  page.close()
  return planted === true
}

/** `urlPart` に一致する page target ごとに、マーカーが残っているかを返す。 */
async function probeOnTargets(urlPart) {
  const matches = (await listTargets(CDP)).filter((t) => t.type === 'page' && t.url.includes(urlPart))
  const results = []
  for (const target of matches) {
    const page = await connect(target.webSocketDebuggerUrl)
    try {
      results.push((await page.ev('window.__nemoFollowProbe === 1')) === true)
    } catch {
      results.push('error')
    }
    page.close()
  }
  return results
}

/**
 * ユーザー操作として評価する（偽 Meet の「参加する」を押すのに使う。verify-call と同じ理由で
 * 時間で必ず切り上げる）。
 */
async function evUser(session, expression) {
  const sent = session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  const r = await Promise.race([sent, sleep(8000).then(() => null)])
  if (r === null) throw new Error(`ページの評価が返ってこない: ${expression.slice(0, 60)}`)
  const details = r.result?.exceptionDetails
  if (details) throw new Error(details.exception?.description ?? details.text ?? 'eval failed')
  return r.result?.result?.value
}

/**
 * beforeunload で離脱を止めるページにする。Chromium は sticky user activation が無いと
 * キャンセル自体を無視する（＝検査が空振りする）ので、実クリック相当を撃ってから印を付ける
 * （verify-phase1 の手筋）。`urlPart` に一致する page target は 1 つだけであること。
 */
async function armBeforeUnload(urlPart) {
  const matches = (await listTargets(CDP)).filter((t) => t.type === 'page' && t.url.includes(urlPart))
  if (matches.length !== 1) {
    throw new Error(`beforeunload の仕込み先が 1 つに定まらない: ${urlPart}（${matches.length} 件）`)
  }
  const page = await connect(matches[0].webSocketDebuggerUrl)
  await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
  await page.ev(
    `(window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' }), 'ok')`
  )
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: 10, y: 10, button: 'left', clickCount: 1 })
  }
  const armed = await page.ev(`navigator.userActivation?.hasBeenActive === true`)
  page.close()
  return armed === true
}

try {
  assertNemoNotRunning('verify-shared-tabs')
  console.log(`（CDP ${CDP} / pages ${PAGES} / userData ${userDataDir}）`)

  // Live Folder は止めておく（自走検証から実 GitHub を叩かない。
  // `NEMO_GITHUB_TEST_ENDPOINT` 方式はモックサーバが要るので、設定で無効化する）
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    `${JSON.stringify({ version: 1, data: { liveFolderEnabled: false } }, null, 2)}\n`
  )

  // ページサーバ（http/https でないと共有定義にならないので file:// では代用できない）
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

  const appChild = await startApp()
  const uiA = await connectUi(CDP)

  /* ---------------------------------------------------------------- *
   * 1. 共有と独立アクティブ
   * ---------------------------------------------------------------- */
  console.log('\n--- 共有と独立アクティブ')

  const keyA = await uiA.ev(`window.nemo.createTab(${json(`${PAGES}/index.html?site=shared1`)}).then(k => k)`)
  await waitForDef(uiA, 'site=shared1')
  {
    const s = await state(uiA)
    const tab = s.tabs.find((t) => t.key === keyA)
    check('開いたタブに共有定義が付く', typeof tab?.ephemeralId === 'string', json(tab?.ephemeralId))
  }

  const uiB = await openSecondWindow(uiA)
  await waitForDef(uiB, 'site=shared1')
  const defA = (await defs(uiB)).find((d) => d.url.includes('site=shared1'))
  check('A で開いたタブが B の共有一覧に出る', Boolean(defA), json((await defs(uiB)).map((d) => d.url)))
  {
    const sB = await state(uiB)
    check(
      'B にはまだ実体が無い（一覧に出るだけ）',
      !sB.tabs.some((t) => t.ephemeralId === defA.id),
      json(sB.tabs.map((t) => t.ephemeralId))
    )
  }

  // B でクリック → B に実体化。A のアクティブは変わらない（選択はウィンドウローカル）
  await openEphemeralIn(uiB, defA.id)
  {
    const sB = await state(uiB)
    const instB = sB.tabs.find((t) => t.ephemeralId === defA.id)
    const sA = await state(uiA)
    check('B でクリックすると B に実体化する', Boolean(instB), json(sB.tabs.map((t) => t.url)))
    check('実体はウィンドウごとに別（key が違う）', instB && instB.key !== keyA, `${instB?.key} vs ${keyA}`)
    check('B のアクティブは B の実体', sB.activeTabKey === instB?.key, sB.activeTabKey)
    check('A のアクティブは変わらない（選択はウィンドウ独立）', sA.activeTabKey === keyA, sA.activeTabKey)
  }

  /* ---------------------------------------------------------------- *
   * 2. 書き戻し（ナビゲーションへの追随）と乖離の許容
   * ---------------------------------------------------------------- */
  console.log('\n--- 定義への書き戻し')

  await uiA.ev(
    `window.nemo.navigate(${json(keyA)}, ${json(`${PAGES}/login.html?site=shared1-moved`)}).then(() => 'ok')`
  )
  await waitForDef(uiB, 'site=shared1-moved', {
    onFail: async () => `A の実体: ${brief(await tabOf(uiA, keyA))}`
  })
  {
    const def = (await defs(uiB)).find((d) => d.id === defA.id)
    check(
      'A のナビゲートに未実体化側の一覧（定義の URL）が追随する',
      def?.url.includes('login.html?site=shared1-moved') === true,
      def?.url
    )
  }
  {
    const sB = await state(uiB)
    const instB = sB.tabs.find((t) => t.ephemeralId === defA.id)
    check(
      '実体化済みの B 側は選び直すまで追随しない（ライブ追随はしない。発火点は選択の 1 点）',
      instB?.url.includes('site=shared1') === true && !instB.url.includes('moved'),
      instB?.url
    )
  }

  /* ---------------------------------------------------------------- *
   * 2b. 選択時追随（別ウィンドウで進んだページの続きを読む）
   *
   * 検査順は固定: 追随する → 一致時は追随しない → beforeunload → sleep 復帰 → 戻れる → 通話ガード。
   * 「戻れる」は定義を汚す（戻った側の URL に書き戻る）ので、その定義を使う検査の最後に置く。
   * 「通話ガード」は参加中の実体が sleep 除外・close ガードで残るので末尾に置き、参加側の
   * ウィンドウから閉じて片付ける。
   * ---------------------------------------------------------------- */
  console.log('\n--- 選択時追随（別ウィンドウで進んだページの続き）')

  // B の「別のタブ」（切り替え経路で追随を撃つための退避先）
  const parkB = await uiB.ev(
    `window.nemo.createTab(${json(`${PAGES}/index.html?site=follow-park`)}).then(k => k)`
  )
  await waitForDef(uiA, 'site=follow-park')

  // --- 追随する（切り替えて選ぶ経路）
  const keyF = await uiA.ev(`window.nemo.createTab(${json(`${PAGES}/index.html?site=follow1`)}).then(k => k)`)
  await waitForDef(uiB, 'index.html?site=follow1')
  const defF = (await defs(uiB)).find((d) => d.url.includes('index.html?site=follow1'))
  const instF = await openEphemeralIn(uiB, defF.id)
  await uiB.ev(`window.nemo.selectTab(${json(parkB)}).then(() => 'ok')`)
  // A で先へ進む → 定義が乖離。この時点で index.html?site=follow1 に居る page は B の実体だけ
  await waitForLoaded(uiA, keyF)
  await uiA.ev(
    `window.nemo.navigate(${json(keyF)}, ${json(`${PAGES}/login.html?site=follow1-moved`)}).then(() => 'ok')`
  )
  await waitForDef(uiB, 'site=follow1-moved')
  check('前提: 追随される側（B の実体）にマーカーを仕込めた', await plantProbe('index.html?site=follow1'))
  {
    const followedBefore = logEvents('tab.followed').filter((e) => e.key === instF.key).length
    await uiB.ev(`window.nemo.selectTab(${json(instF.key)}).then(() => 'ok')`)
    const followedUrl = await waitForTabUrl(uiB, instF.key, 'site=follow1-moved')
    const defNow = (await defs(uiB)).find((d) => d.id === defF.id)
    check(
      '別ウィンドウで進んだ定義の URL に、その行を選んだ瞬間に追随する',
      followedUrl !== null && followedUrl === defNow?.url,
      json({ got: followedUrl, def: defNow?.url })
    )
    const followedAfter = logEvents('tab.followed').filter((e) => e.key === instF.key).length
    check(
      '追随は tab.followed としてログに残る',
      followedAfter === followedBefore + 1,
      `${followedBefore} → ${followedAfter}`
    )
    // 対になる「追随しない」検査の空振り防止: 追随は読み直しなのでマーカーが消える
    const probes = await probeOnTargets('login.html?site=follow1-moved')
    check(
      '追随は読み直しなので、仕込んだマーカーが消える（A・B とも同じ URL に居る）',
      probes.length === 2 && probes.every((v) => v === false),
      json(probes)
    )
  }

  // --- 一致時は追随しない（実体を 1 ウィンドウだけにして、マーカーの仕込み先を一意にする）
  const keyS = await uiA.ev(
    `window.nemo.createTab(${json(`${PAGES}/index.html?site=follow-same`)}).then(k => k)`
  )
  await waitForDef(uiA, 'site=follow-same')
  check('前提: 一致状態の実体にマーカーを仕込めた', await plantProbe('index.html?site=follow-same'))
  // 再クリック（already 経路）と、別タブへ行って戻る（切り替え経路）の両方
  await uiA.ev(`window.nemo.selectTab(${json(keyS)}).then(() => 'ok')`)
  await sleep(500)
  await uiA.ev(`window.nemo.selectTab(${json(keyF)}).then(() => 'ok')`)
  await sleep(300)
  await uiA.ev(`window.nemo.selectTab(${json(keyS)}).then(() => 'ok')`)
  await sleep(800)
  {
    const probes = await probeOnTargets('index.html?site=follow-same')
    check(
      '実体と定義が一致していれば選び直しても読み直さない（マーカーが残る）',
      probes.length === 1 && probes[0] === true,
      json(probes)
    )
    check(
      '一致時は tab.followed が出ない',
      logEvents('tab.followed').filter((e) => e.key === keyS).length === 0,
      json(logEvents('tab.followed').map((e) => e.key))
    )
  }

  // --- beforeunload: 止められる側（追随される実体 = B）に仕込む。B だけが実体を持つうちに仕込む
  const keyBU = await uiB.ev(
    `window.nemo.createTab(${json(`${PAGES}/login.html?site=follow-bu`)}).then(k => k)`
  )
  await waitForDef(uiA, 'site=follow-bu')
  const defBU = (await defs(uiA)).find((d) => d.url.includes('site=follow-bu'))
  check(
    '前提: クリックで sticky activation が付き beforeunload を仕込めた',
    await armBeforeUnload('login.html?site=follow-bu')
  )
  const instBU_A = await openEphemeralIn(uiA, defBU.id)
  {
    await uiA.ev(
      `window.nemo.navigate(${json(instBU_A.key)}, ${json(`${PAGES}/index.html?site=follow-bu-moved`)}).then(() => 'ok')`
    )
    await waitForDef(uiB, 'site=follow-bu-moved')
    const promptsBefore = logEvents('tab.unload_prompt').length
    await uiB.ev(`window.nemo.selectTab(${json(keyBU)}).then(() => 'ok')`)
    const blocked = await waitUntil(
      () => (logEvents('tab.follow_blocked').some((e) => e.key === keyBU) ? 'blocked' : null),
      { timeoutMs: 8000 }
    )
    check('beforeunload で止められた追随は tab.follow_blocked としてログに残る', blocked !== null)
    await sleep(500)
    const tab = await tabOf(uiB, keyBU)
    check(
      '止められた実体は URL が変わらない（乖離のまま静かに残す）',
      tab?.url.includes('login.html?site=follow-bu') === true && !tab.url.includes('moved'),
      tab?.url
    )
    check(
      '離脱確認ダイアログは出ない（tab.unload_prompt が増えない）',
      logEvents('tab.unload_prompt').length === promptsBefore,
      `${promptsBefore} → ${logEvents('tab.unload_prompt').length}`
    )
    const defAfter = (await defs(uiB)).find((d) => d.id === defBU.id)
    check(
      '止められても定義の URL は先へ進んだ側のまま',
      defAfter?.url.includes('follow-bu-moved') === true,
      defAfter?.url
    )
    // 次の選択でまた試みる（抑止フラグが畳まれていれば 2 回目も blocked として出る）
    await uiB.ev(`window.nemo.selectTab(${json(keyBU)}).then(() => 'ok')`)
    const blockedTwice = await waitUntil(
      () => (logEvents('tab.follow_blocked').filter((e) => e.key === keyBU).length >= 2 ? 'ok' : null),
      { timeoutMs: 8000 }
    )
    check('次の選択でまた追随を試みる（止められた記録が 2 件になる）', blockedTwice !== null)
  }

  // --- sleep 復帰は定義の現在 URL を読む（起こした直後の二重ロードもしない）
  // B は instF（追随済み・定義と一致・後で「戻れる」に使うので寝かせない）を見せておく
  await uiB.ev(`window.nemo.selectTab(${json(instF.key)}).then(() => 'ok')`)
  const keySL = await uiA.ev(
    `window.nemo.createTab(${json(`${PAGES}/index.html?site=follow-sleep`)}).then(k => k)`
  )
  await waitForDef(uiB, 'site=follow-sleep')
  const defSL = (await defs(uiB)).find((d) => d.url.includes('site=follow-sleep'))
  const instSL = await openEphemeralIn(uiB, defSL.id)
  await uiB.ev(`window.nemo.selectTab(${json(instF.key)}).then(() => 'ok')`)
  {
    // 全ウィンドウの非表示タブが一斉に寝るので、寝かせたい実体が寝たら即座に元へ戻す
    const originalSleep = JSON.parse(
      await uiA.ev('window.nemo.getSettings().then(s => JSON.stringify(s))')
    ).tabSleepMinutes
    await uiA.ev(`window.nemo.updateSettings({ tabSleepMinutes: ${600 / 60_000} }).then(() => 'ok')`)
    const slept = await waitUntil(async () => ((await tabOf(uiB, instSL.key))?.asleep ? 'asleep' : null), {
      timeoutMs: 15000
    })
    await uiA.ev(`window.nemo.updateSettings({ tabSleepMinutes: ${originalSleep} }).then(() => 'ok')`)
    check('前提: B の実体が sleep した', slept !== null, brief(await tabOf(uiB, instSL.key)))
    await waitForLoaded(uiA, keySL)
    await uiA.ev(
      `window.nemo.navigate(${json(keySL)}, ${json(`${PAGES}/login.html?site=follow-sleep-moved`)}).then(() => 'ok')`
    )
    await waitForDef(uiB, 'site=follow-sleep-moved')
    await uiB.ev(`window.nemo.selectTab(${json(instSL.key)}).then(() => 'ok')`)
    const wokeUrl = await waitForTabUrl(uiB, instSL.key, 'site=follow-sleep-moved')
    check(
      'sleep から起きた実体は定義の現在 URL を読む（寝る前の URL に戻さない）',
      wokeUrl !== null,
      brief(await tabOf(uiB, instSL.key))
    )
    check(
      '起床時の採用は tab.follow_on_wake としてログに残る',
      logEvents('tab.follow_on_wake').filter((e) => e.key === instSL.key).length === 1,
      json(logEvents('tab.follow_on_wake').map((e) => e.key))
    )
    check(
      '起こした直後の selectTab で二重に読み直さない（tab.followed が出ない）',
      logEvents('tab.followed').filter((e) => e.key === instSL.key).length === 0,
      json(logEvents('tab.followed').filter((e) => e.key === instSL.key))
    )
  }

  // --- 追随後に「戻る」で乖離側のページに戻れる（定義もそちらへ書き戻る）
  await uiB.ev(`window.nemo.selectTab(${json(instF.key)}).then(() => 'ok')`)
  {
    const before = await tabOf(uiB, instF.key)
    check(
      '前提: 追随した実体は「戻る」が押せる（追随は履歴に積む通常の遷移）',
      before?.canGoBack === true,
      brief(before)
    )
    await uiB.ev(`window.nemo.goBack(${json(instF.key)}).then(() => 'ok')`)
    const backUrl = await waitUntil(async () => {
      const tab = await tabOf(uiB, instF.key)
      return tab && tab.url.includes('index.html?site=follow1') && !tab.url.includes('moved') ? tab.url : null
    })
    check('「戻る」で乖離側（追随前）のページに戻れる', backUrl !== null, brief(await tabOf(uiB, instF.key)))
    const defBack = await waitUntil(async () => {
      const def = (await defs(uiB)).find((d) => d.id === defF.id)
      return def && def.url.includes('index.html?site=follow1') && !def.url.includes('moved') ? def.url : null
    })
    check('戻ると定義も戻った側の URL に書き戻される（最後に触った実体が勝つ）', defBack !== null, defBack)
    // 他ウィンドウは次の選択でそちらへ追随する
    await uiA.ev(`window.nemo.selectTab(${json(keyF)}).then(() => 'ok')`)
    const aUrl = await waitUntil(async () => {
      const tab = await tabOf(uiA, keyF)
      return tab && tab.url.includes('index.html?site=follow1') && !tab.url.includes('moved') ? tab.url : null
    })
    check('他ウィンドウは次の選択で戻った側へ追随する', aUrl !== null, brief(await tabOf(uiA, keyF)))
  }

  // --- 通話ガード: 参加中の実体は選んでも追随しない
  // 順序: 先に A・B 双方で実体化 → A が別 URL へ（乖離。A は会議候補から外れ、偽 Meet の target は B だけ）→
  // B で参加 → B で選ぶ。参加後に開く順では openEphemeral のガードが実体化自体を拒むので乖離を作れない
  const keyM = await uiA.ev(
    `window.nemo.createTab(${json(`${PAGES}/meet-fake.html?id=follow-call`)}).then(k => k)`
  )
  await waitForDef(uiB, 'id=follow-call')
  const defM = (await defs(uiB)).find((d) => d.url.includes('id=follow-call'))
  const instM = await openEphemeralIn(uiB, defM.id)
  await waitForLoaded(uiA, keyM)
  await uiA.ev(
    `window.nemo.navigate(${json(keyM)}, ${json(`${PAGES}/index.html?site=follow-call-moved`)}).then(() => 'ok')`
  )
  await waitForDef(uiB, 'site=follow-call-moved')
  {
    const matches = (await listTargets(CDP)).filter(
      (t) => t.type === 'page' && t.url.includes('meet-fake.html?id=follow-call')
    )
    check(
      '前提: 偽 Meet の page target は B の実体だけ',
      matches.length === 1,
      json(matches.map((t) => t.url))
    )
    const meetPage = await connect(matches[0].webSocketDebuggerUrl)
    await waitFor(meetPage, "document.readyState === 'complete' ? 'ok' : ''")
    await evUser(meetPage, `(document.getElementById('join').click(), 'ok')`)
    const joined = await waitUntil(
      () => (logEvents('call.joined').some((e) => e.key === instM.key) ? 'joined' : null),
      { timeoutMs: 15000 }
    )
    check('前提: B の実体が会議に参加中と検知される（call.joined）', joined !== null)
    await uiB.ev(`window.nemo.selectTab(${json(instM.key)}).then(() => 'ok')`)
    await sleep(1500)
    const tab = await tabOf(uiB, instM.key)
    check(
      '会議に参加中の実体は選んでも追随しない（URL が変わらない）',
      tab?.url.includes('meet-fake.html?id=follow-call') === true,
      tab?.url
    )
    check(
      '追随の見送りは call.guarded（action=follow）としてログに残る',
      logEvents('call.guarded').some((e) => e.action === 'follow' && e.defId === defM.id),
      json(logEvents('call.guarded').map((e) => e.action))
    )
    check(
      '参加中の実体に tab.followed は出ない',
      logEvents('tab.followed').filter((e) => e.key === instM.key).length === 0
    )
    meetPage.close()
    // 後片付け: 参加側のウィンドウから閉じる（origin が参加側なので close ガードを通る）
    await uiB.ev(`window.nemo.closeTab(${json(instM.key)}).then(() => 'ok')`)
    await waitForDef(uiA, 'id=follow-call', { present: false })
  }

  /* ---------------------------------------------------------------- *
   * 3. 閉じる = 全ウィンドウから消える / ⌘⇧T は 1 回で戻る
   * ---------------------------------------------------------------- */
  console.log('\n--- 閉じると全ウィンドウから消える')

  {
    // 0 件検査の空振り防止: 直前に**両方のウィンドウに実体がある**ことを見る
    const sA = await state(uiA)
    const sB = await state(uiB)
    check(
      '閉じる前: 両方のウィンドウに実体がある',
      sA.tabs.some((t) => t.ephemeralId === defA.id) && sB.tabs.some((t) => t.ephemeralId === defA.id),
      json([sA.tabs.length, sB.tabs.length])
    )
    const instB = sB.tabs.find((t) => t.ephemeralId === defA.id)
    await uiB.ev(`window.nemo.closeTab(${json(instB.key)}).then(() => 'ok')`)
  }
  await waitForDef(uiA, 'site=shared1', { present: false })
  {
    const sA = await state(uiA)
    check(
      'B で閉じると A の実体も閉じ、定義が消える',
      !sA.tabs.some((t) => t.ephemeralId === defA.id),
      json(sA.tabs.map((t) => t.url))
    )
  }

  // ⌘⇧T は 1 回で戻る（波及 close で 2 回積まれていたら、2 回目の reopen で二重に開く）
  await uiA.ev(`window.nemo.runCommandForVerify('reopen-tab').then(() => 'ok')`)
  await waitForDef(uiA, 'site=shared1-moved')
  await uiA.ev(`window.nemo.runCommandForVerify('reopen-tab').then(() => 'ok')`)
  await sleep(800)
  {
    const list = await defs(uiA)
    const count = list.filter((d) => d.url.includes('site=shared1-moved')).length
    check('⌘⇧T 1 回で戻る（2 回押しても二重に積まれていない）', count === 1, `defs=${count}`)
    const rows = await uiA.ev(
      `window.nemo.queryArchive('site=shared1').then(rows => JSON.stringify(rows.map(r => r.url)))`
    )
    check('アーカイブに記録が残る（閉じても掘り返せる）', JSON.parse(rows).length >= 1, rows)
  }

  /* ---------------------------------------------------------------- *
   * 4. about:blank のローカル行（定義化はナビゲーション時）
   * ---------------------------------------------------------------- */
  console.log('\n--- ローカルタブと定義化')

  const before = (await defs(uiA)).length
  const blankKey = await uiA.ev(`window.nemo.createTab().then(k => k)`)
  await sleep(500)
  {
    const after = (await defs(uiA)).length
    const sA = await state(uiA)
    const blank = sA.tabs.find((t) => t.key === blankKey)
    check('about:blank は共有定義にならない（ローカルタブ）', after === before, `defs ${before} → ${after}`)
    check('ローカルタブの ephemeralId は null', blank?.ephemeralId === null, json(blank?.ephemeralId))
    const sB = await state(uiB)
    check(
      'ローカルタブは他ウィンドウに出ない（B に実体もない）',
      !sB.tabs.some((t) => t.key === blankKey),
      json(sB.tabs.length)
    )
  }
  await uiA.ev(
    `window.nemo.navigate(${json(blankKey)}, ${json(`${PAGES}/iframe.html?site=lazy1`)}).then(() => 'ok')`
  )
  await waitForDef(uiB, 'site=lazy1')
  {
    const sA = await state(uiA)
    const blank = sA.tabs.find((t) => t.key === blankKey)
    check(
      '最初の http ナビゲーションで共有一覧に現れる（B からも見える）',
      typeof blank?.ephemeralId === 'string',
      json(blank?.ephemeralId)
    )
  }

  /* ---------------------------------------------------------------- *
   * 5. ピン留めとの転換（昇格で定義が消え、解除で 1 本だけ戻る）
   * ---------------------------------------------------------------- */
  console.log('\n--- ピン留めとの転換')

  const pinKey = await uiA.ev(`window.nemo.createTab(${json(`${PAGES}/index.html?site=pin1`)}).then(k => k)`)
  await waitForDef(uiA, 'site=pin1')
  await uiA.ev(`window.nemo.pinTab(${json(pinKey)}).then(() => 'ok')`)
  await waitForDef(uiA, 'site=pin1', { present: false })
  {
    const list = await defs(uiA)
    check(
      'ピン留めに昇格すると共有定義は消える（同じタブが 2 層に出ない）',
      !list.some((d) => d.url.includes('site=pin1')),
      json(list.map((d) => d.url))
    )
  }
  const pinId = await uiA.ev(
    `window.nemo.getSharedState().then(s => { const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'link' && n.url.includes('site=pin1')) return n.id; if (n.kind === 'folder') { const f = walk(n.children); if (f) return f } } return '' }; return walk(s.pinned) })`
  )
  check('ピン定義ができている', pinId !== '', pinId)
  // B でも同じピンを開いてから解除 → 全ウィンドウの実体が **1 本の**共有定義に束ねられる
  await uiB.ev(`window.nemo.openPinned(${json(pinId)}).then(() => 'ok')`)
  await waitFor(
    uiB,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.pinnedId === ${json(pinId)}) ? 'ok' : '')`
  )
  await uiA.ev(`window.nemo.unpin(${json(pinId)}).then(() => 'ok')`)
  await waitForDef(uiA, 'site=pin1')
  {
    const list = await defs(uiA)
    const count = list.filter((d) => d.url.includes('site=pin1')).length
    check(
      '2 ウィンドウで開いていたピンを解除しても、共有一覧に増える行は 1 本だけ',
      count === 1,
      `defs=${count}`
    )
    const sA = await state(uiA)
    const sB = await state(uiB)
    const idA = sA.tabs.find((t) => t.url.includes('site=pin1'))?.ephemeralId
    const idB = sB.tabs.find((t) => t.url.includes('site=pin1'))?.ephemeralId
    check('両ウィンドウの実体が同じ定義に束ねられる', Boolean(idA) && idA === idB, json([idA, idB]))
  }

  /* ---------------------------------------------------------------- *
   * 5b. 昇格の付け替えは他ウィンドウの分割を解く
   * （ピン留め / Favorites は分割に入れない、の不変条件を rebind 経路でも守る）
   * ---------------------------------------------------------------- */

  {
    const xKey = await uiA.ev(
      `window.nemo.createTab(${json(`${PAGES}/index.html?site=rebind-split`)}).then(k => k)`
    )
    await waitForDef(uiB, 'site=rebind-split')
    const defX = (await defs(uiB)).find((d) => d.url.includes('site=rebind-split'))
    // B で実体化し、B のもう 1 本と分割に入れる
    await openEphemeralIn(uiB, defX.id)
    const yKey = await uiB.ev(
      `window.nemo.createTab(${json(`${PAGES}/login.html?site=rebind-partner`)}).then(k => k)`
    )
    const sB1 = await state(uiB)
    const xInstB = sB1.tabs.find((t) => t.ephemeralId === defX.id)
    await uiB.ev(`window.nemo.splitTabs(${json(xInstB.key)}, ${json(yKey)}).then(() => 'ok')`)
    await waitFor(
      uiB,
      `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(xInstB.key)} && t.splitSide !== null) ? 'ok' : '')`
    )
    // A 側の実体を ⌘D → B の実体は分割が解かれてピン定義に付け替わる
    await uiA.ev(`window.nemo.pinTab(${json(xKey)}).then(() => 'ok')`)
    await waitFor(
      uiB,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${json(xInstB.key)}); return t && t.pinnedId !== null ? 'ok' : '' })`
    )
    const sB2 = await state(uiB)
    const xAfter = sB2.tabs.find((t) => t.key === xInstB.key)
    check(
      '昇格の付け替え: 他ウィンドウの実体は分割が解かれてからピン定義へ付く',
      xAfter?.pinnedId !== null && xAfter?.splitSide === null && xAfter?.ephemeralId === null,
      json({ pinnedId: xAfter?.pinnedId, splitSide: xAfter?.splitSide, ephemeralId: xAfter?.ephemeralId })
    )
    // 後片付け（ピンを解除して定義ごと閉じる）
    const rebindPinId = xAfter?.pinnedId
    if (rebindPinId) {
      await uiA.ev(`window.nemo.unpin(${json(rebindPinId)}).then(() => 'ok')`)
      await waitForDef(uiA, 'site=rebind-split')
      const cleanup = (await defs(uiA)).find((d) => d.url.includes('site=rebind-split'))
      if (cleanup) await uiA.ev(`window.nemo.closeEphemeral(${json(cleanup.id)}).then(() => 'ok')`)
    }
    const partnerDef = (await defs(uiA)).find((d) => d.url.includes('site=rebind-partner'))
    if (partnerDef) await uiA.ev(`window.nemo.closeEphemeral(${json(partnerDef.id)}).then(() => 'ok')`)
    await sleep(500)
  }

  /* ---------------------------------------------------------------- *
   * 6. ウィンドウを閉じても定義は残る（デタッチのみ）
   * ---------------------------------------------------------------- */
  console.log('\n--- ウィンドウを閉じても定義は残る')

  {
    const beforeClose = (await defs(uiA)).map((d) => d.url).sort()
    check('閉じる前: 共有一覧に定義がある（0 件の空振り防止）', beforeClose.length > 0, json(beforeClose))
    await closeWindowOf(uiB)
    const afterClose = (await defs(uiA)).map((d) => d.url).sort()
    check(
      'ウィンドウ B を閉じても定義は全部残る（実体のデタッチのみ）',
      JSON.stringify(afterClose) === JSON.stringify(beforeClose),
      json({ before: beforeClose.length, after: afterClose.length })
    )
  }

  /* ---------------------------------------------------------------- *
   * 7. シークレットは共有に参加しない
   * ---------------------------------------------------------------- */
  console.log('\n--- シークレットの除外')

  await uiA.ev(`window.nemo.runCommandForVerify('new-private-window').then(() => 'ok')`)
  const uiP = await connectUi(CDP, 'sidebar', { urlPart: 'private=1', includePrivate: true })
  {
    const sharedInPrivate = await uiP.ev(
      `window.nemo.getSharedState().then(s => JSON.stringify(s.ephemeralTabs))`
    )
    check('シークレットには ephemeralTabs を渡さない（null）', sharedInPrivate === 'null', sharedInPrivate)
    const beforePrivate = (await defs(uiA)).length
    const privateKey = await uiP.ev(
      `window.nemo.createTab(${json(`${PAGES}/login.html?site=private1`)}).then(k => k)`
    )
    await sleep(800)
    const sP = await state(uiP)
    const privateTab = sP.tabs.find((t) => t.key === privateKey)
    check(
      'シークレットのタブは定義を持たない',
      privateTab?.ephemeralId === null,
      json(privateTab?.ephemeralId)
    )
    const afterPrivate = (await defs(uiA)).length
    check(
      'シークレットのタブは共有一覧に出ない',
      afterPrivate === beforePrivate,
      `defs ${beforePrivate} → ${afterPrivate}`
    )
    await closeWindowOf(uiP)
  }

  /* ---------------------------------------------------------------- *
   * 8. 小窓は不参加・⌘O 合流で共有入り
   * ---------------------------------------------------------------- */
  console.log('\n--- 小窓の除外と ⌘O 合流')

  await openExternalUrl(`${PAGES}/login.html?site=mini-share`)
  {
    const miniTarget = (await listTargets(CDP)).find((t) => t.url.includes('view=mini'))
    check('外部 URL は小窓で開く', Boolean(miniTarget), miniTarget?.url ?? 'なし')
    const list = await defs(uiA)
    check(
      '小窓のタブは共有一覧に出ない',
      !list.some((d) => d.url.includes('site=mini-share')),
      json(list.map((d) => d.url))
    )
    const uiM = await connect(miniTarget.webSocketDebuggerUrl)
    await waitFor(uiM, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    // ⌘O 昇格は小窓自身を閉じるので、`closeWindowOf` と同じく発火だけして応答を待たない
    await uiM.ev(`(setTimeout(() => { void window.nemo.promoteForegroundView() }, 50), 'ok')`)
    uiM.close()
    await waitForDef(uiA, 'site=mini-share')
    const merged = (await defs(uiA)).find((d) => d.url.includes('site=mini-share'))
    check('⌘O で通常ウィンドウへ合流した時点で共有一覧に入る', Boolean(merged), json(merged?.url))
  }

  /* ---------------------------------------------------------------- *
   * 8b. 境界線の「↓ Clear」は野良タブを全部閉じる
   * （共有定義は全ウィンドウから・ローカル行はこのウィンドウから。アクティブも例外にしない）
   * ---------------------------------------------------------------- */
  console.log('\n--- Clear で野良タブを全部閉じる')

  {
    const uiB2 = await openSecondWindow(uiA)
    const keyC = await uiA.ev(
      `window.nemo.createTab(${json(`${PAGES}/index.html?site=clear1`)}).then(k => k)`
    )
    await waitForDef(uiB2, 'site=clear1')
    const defC = (await defs(uiB2)).find((d) => d.url.includes('site=clear1'))
    const instC = await openEphemeralIn(uiB2, defC.id)
    const blankKey = await uiA.ev(`window.nemo.createTab().then(k => k)`)
    await sleep(500)
    // 0 件検査の空振り防止: 閉じる前に「定義が複数・両ウィンドウに実体・A にローカル行」を見る
    const beforeDefs = await defs(uiA)
    const sA0 = await state(uiA)
    const sB0 = await state(uiB2)
    const strayOf = (s) => s.tabs.filter((t) => t.pinnedId === null && t.favoriteId === null)
    check(
      '閉じる前: 定義が複数あり、両ウィンドウに実体があり、A にローカル行がある',
      beforeDefs.length >= 2 &&
        sA0.tabs.some((t) => t.key === keyC) &&
        sB0.tabs.some((t) => t.key === instC.key) &&
        sA0.tabs.some((t) => t.key === blankKey && t.ephemeralId === null),
      json({ defs: beforeDefs.length, strayA: strayOf(sA0).length, strayB: strayOf(sB0).length })
    )
    check(
      'アクティブは野良タブ（Clear がアクティブを例外にしないことの前提）',
      strayOf(sA0).some((t) => t.key === sA0.activeTabKey),
      json(sA0.activeTabKey)
    )
    // サイドバーの境界線にボタンが描かれている（描画まで見る。IPC を直接叩くと UI の欠落を素通りする）
    const hasButton = await uiA.ev(`document.querySelector('.tabs-sep.clear-sep .clear-tabs') ? 'yes' : 'no'`)
    check('境界線に Clear ボタンが描かれている', hasButton === 'yes', hasButton)
    // 誤タップ防止の確認（線の直下のポップオーバー）。**キャンセルでは何も閉じない**ことを先に見る
    const clickClear = () =>
      uiA.ev(`(document.querySelector('.tabs-sep.clear-sep .clear-tabs').click(), 'ok')`)
    const confirmState = () =>
      uiA
        .ev(
          `JSON.stringify({ open: !!document.querySelector('.clear-confirm'), focused: document.activeElement?.textContent ?? '' })`
        )
        .then(JSON.parse)
    await clickClear()
    const c1 = await waitUntil(async () => ((await confirmState()).open ? await confirmState() : null))
    check(
      'Clear を押すと線の直下に確認が出て、まだ何も閉じない',
      c1 !== null && (await defs(uiA)).length === beforeDefs.length,
      json({ confirm: c1, defs: (await defs(uiA)).length })
    )
    check(
      '確認の「Close all tabs」にフォーカスが乗る（Enter で進める）',
      c1?.focused === 'Close all tabs',
      json(c1?.focused)
    )
    // キャンセルのボタンは無い。外側（New Tab 行）への mousedown で畳む
    await uiA.ev(
      `(document.querySelector('.row.new-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 'ok')`
    )
    await sleep(300)
    check(
      '外側をクリックすると確認が消え、定義も実体もそのまま',
      !(await confirmState()).open &&
        (await defs(uiA)).length === beforeDefs.length &&
        strayOf(await state(uiA)).length === strayOf(sA0).length,
      json({ defs: (await defs(uiA)).length, strayA: strayOf(await state(uiA)).length })
    )
    await clickClear()
    await waitUntil(async () => ((await confirmState()).open ? 'ok' : null))
    await uiA.ev(
      `(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 'ok')`
    )
    await sleep(300)
    check(
      'Esc でも確認が消える（何も閉じない）',
      !(await confirmState()).open && (await defs(uiA)).length === beforeDefs.length
    )
    await clickClear()
    await waitUntil(async () => ((await confirmState()).open ? 'ok' : null))
    await uiA.ev(`(document.querySelector('.clear-confirm button.danger').click(), 'ok')`)
    const cleared = await waitUntil(async () => ((await defs(uiA)).length === 0 ? 'ok' : null))
    check('Clear で共有定義が 0 件になる', cleared !== null, json((await defs(uiA)).map((d) => d.url)))
    const sA1 = await state(uiA)
    const sB1 = await state(uiB2)
    check(
      'A の野良タブ（ローカル行含む）が全部閉じる',
      strayOf(sA1).length === 0,
      json(strayOf(sA1).map((t) => t.url))
    )
    check(
      'B の実体も閉じる（定義ごと全ウィンドウから消える）',
      strayOf(sB1).length === 0,
      json(strayOf(sB1).map((t) => t.url))
    )
    check('閉じた後の A は空状態（アクティブ無し）', sA1.activeTabKey === null, json(sA1.activeTabKey))
    const buttonAfter = await waitFor(
      uiA,
      `document.querySelector('.tabs-sep.clear-sep .clear-tabs') ? '' : 'gone'`
    )
    check('閉じる行が無くなるとボタンも消える（線だけ残る）', buttonAfter === 'gone', buttonAfter)
    const clearedLog = logEvents('tab.ephemeral_cleared').at(-1) ?? null
    check(
      'tab.ephemeral_cleared に閉じた件数が残る（定義 + ローカル行）',
      clearedLog !== null && clearedLog.closed === beforeDefs.length + 1 && clearedLog.guarded === 0,
      json(clearedLog)
    )
    const rows = await uiA.ev(
      `window.nemo.queryArchive('site=clear1').then(rows => JSON.stringify(rows.map(r => r.url)))`
    )
    check(
      'Clear で閉じたタブもアーカイブに残る（ライブラリから掘り返せる）',
      JSON.parse(rows).length >= 1,
      rows
    )
    await closeWindowOf(uiB2)
    // 次の節（再起動の復元）が定義とアクティブを前提にするので積み直す
    for (const site of ['restore1', 'restore2', 'restore3']) {
      await uiA.ev(`window.nemo.createTab(${json(`${PAGES}/index.html?site=${site}`)}).then(k => k)`)
    }
    await waitForDef(uiA, 'site=restore3')
  }

  /* ---------------------------------------------------------------- *
   * 9. 再起動で共有一覧とアクティブが復元される
   * ---------------------------------------------------------------- */
  console.log('\n--- 再起動をまたぐ復元')

  const beforeRestart = { defs: (await defs(uiA)).map((d) => d.url).sort(), active: null }
  beforeRestart.active = await state(uiA).then(
    (s) => s.tabs.find((t) => t.key === s.activeTabKey)?.ephemeralId ?? null
  )
  // セッション保存（2 段デバウンス）と定義ストアの flush は終了時の close が書き切る
  uiA.close()
  await stopChildren([appChild])
  spawned.splice(spawned.indexOf(appChild), 1)

  await startApp()
  const uiA2 = await connectUi(CDP)
  {
    const restoredDefs = (await defs(uiA2)).map((d) => d.url).sort()
    check(
      '再起動で共有一覧が丸ごと復元される',
      JSON.stringify(restoredDefs) === JSON.stringify(beforeRestart.defs),
      json({ before: beforeRestart.defs.length, after: restoredDefs.length })
    )
    const s = await state(uiA2)
    const active = s.tabs.find((t) => t.key === s.activeTabKey)
    check(
      '再起動でウィンドウのアクティブ定義が復元される',
      Boolean(beforeRestart.active) && active?.ephemeralId === beforeRestart.active,
      json({ want: beforeRestart.active, got: active?.ephemeralId })
    )
    check(
      '実体化されるのはアクティブ定義（+分割構成員）だけで、他は一覧に出るだけ',
      s.tabs.length < restoredDefs.length,
      json({ tabs: s.tabs.length, defs: restoredDefs.length })
    )
  }

  /* ---------------------------------------------------------------- *
   * 9b. アクティブがピン留めだったウィンドウは先頭定義へ倒して復元される
   * （`activeEphemeralId` は null で保存される。倒さないと空状態で立ち上がる）
   * ---------------------------------------------------------------- */

  {
    const s = await state(uiA2)
    const active = s.tabs.find((t) => t.key === s.activeTabKey)
    // アクティブタブをピン留めしてアクティブのまま終了 → activeEphemeralId は null で保存される
    await uiA2.ev(`window.nemo.pinTab(${json(active.key)}).then(() => 'ok')`)
    await waitFor(
      uiA2,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${json(active.key)}); return t && t.pinnedId !== null ? 'ok' : '' })`
    )
  }
  uiA2.close()
  await stopChildren(spawned.filter((c) => isChildAlive(c) && c !== pagesChild))

  await startApp()
  const uiA3 = await connectUi(CDP)
  {
    const s = await state(uiA3)
    const list = await defs(uiA3)
    const firstDef = list[0] ?? null
    const materialized = s.tabs.find((t) => t.ephemeralId !== null)
    check(
      'アクティブがピン留めだったウィンドウは先頭定義へ倒して復元される（空状態にしない）',
      Boolean(firstDef) && materialized?.ephemeralId === firstDef.id,
      json({ first: firstDef?.id, got: materialized?.ephemeralId, tabs: s.tabs.length })
    )
  }
  uiA3.close()
} catch (error) {
  console.error(`\n[shared-tabs] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await stopChildren(spawned.filter(isChildAlive))
  const uncaught = findUncaughtExceptions(userDataDir)
  if (uncaught.length > 0) {
    exitCode = 1
    console.error(`\n[shared-tabs] main プロセスの例外がログに残っている:\n  ${uncaught.join('\n  ')}`)
  }
  if (spawned.every((c) => !isChildAlive(c))) fs.rmSync(userDataDir, { recursive: true, force: true })
  else console.error(`[shared-tabs] 生き残りがいるので一時ディレクトリを残した: ${userDataDir}`)
}

if (failures > 0) exitCode = 1
console.log(
  failures === 0
    ? `\nverify-shared-tabs: すべて PASS（${checks} 件）`
    : `\nverify-shared-tabs: ${failures} / ${checks} 件 FAIL`
)
process.exit(exitCode)
