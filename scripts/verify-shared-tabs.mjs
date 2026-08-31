#!/usr/bin/env node
/**
 * 野良タブのウィンドウ横断共有（Arc 風）の自走検証。
 *
 * 「サイドバーは共有データ、ウィンドウはそのビュー」:
 * - どのウィンドウで開いたタブも、他の通常ウィンドウの共有一覧に出る
 * - アクティブ選択とページ実体はウィンドウごとに独立（同じ定義を両方で実体化できる）
 * - 閉じる = 定義ごと削除で全ウィンドウから消える / ウィンドウを閉じても定義は残る
 * - シークレット・小窓は共有に参加しない（小窓は ⌘O 合流時点で共有入り）
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
  NEMO_VERIFY_DIAGNOSTICS: '1'
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
async function waitForDef(session, urlPart, { present = true, timeoutMs = 10000 } = {}) {
  await waitFor(
    session,
    `window.nemo.getSharedState().then(s => ((s.ephemeralTabs ?? []).some(d => d.url.includes(${json(urlPart)})) === ${present}) ? 'ok' : '')`,
    { timeoutMs }
  )
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
  await uiB.ev(`window.nemo.openEphemeral(${json(defA.id)}).then(() => 'ok')`)
  await waitFor(
    uiB,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.ephemeralId === ${json(defA.id)}) ? 'ok' : '')`
  )
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
  await waitForDef(uiB, 'site=shared1-moved')
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
      '実体化済みの B 側は追随しない（乖離を許容。Arc と同じ）',
      instB?.url.includes('site=shared1') === true && !instB.url.includes('moved'),
      instB?.url
    )
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
    await uiB.ev(`window.nemo.openEphemeral(${json(defX.id)}).then(() => 'ok')`)
    await waitFor(
      uiB,
      `window.nemo.getWindowState().then(s => s.tabs.some(t => t.ephemeralId === ${json(defX.id)}) ? 'ok' : '')`
    )
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
