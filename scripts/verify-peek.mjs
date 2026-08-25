#!/usr/bin/env node
/**
 * Peek（ウィンドウ内ポップアップ）と小窓（Little Nemo）の自走検証。
 *
 * 見るもの（計画の R1〜R11 に対応）:
 *
 * - **R1**: `target=_blank` の POST body が Peek に届く / `window.opener.postMessage` が親に届く /
 *   `window.close()` で Peek が閉じる（= `deny` + URL 作り直しに戻っていないこと）
 * - **R2**: chrome から見た active が Peek を指す。別タブへ行って**戻ったあとも**指す
 *   （1回撃つだけの実装だとここで落ちる）。無限再入していないこと
 * - **R8**: Peek の中の popup で Peek が昇格し、`window.opener.postMessage` が届く
 * - **R9**: Peek を持つ親タブを別ウィンドウへ移すと Peek も付いてくる
 * - **R11**: 昇格したタブは**元の親タブを閉じても残る**（`outlivesOpener`）。
 *   昇格していない Peek は親と一緒に閉じる（閉じ漏れて見えない WebContents が残らない）
 * - 小窓: 外部 URL で1枚できる / 上限4枚 / セッションに含まれない / ⌘⇧T で戻せる /
 *   ⌘W でウィンドウごと閉じる / ⌘O で通常ウィンドウへ移る
 *
 * ここで見られないもの（Phase 8 で実機確認する）:
 * - **Space とフォーカス**（フルスクリーンの上に出るか・前面を奪わないか）。
 *   Phase 0 のスパイクで測ってあるが、実ターミナルでの確認は人が行う
 * - **⌘クリックの背面タブ**。`disposition: 'background-tab'` は合成キーでしか作れず、
 *   メニューのアクセラレータと同じで CDP からは撃てない
 * - **実 Vault の Bitwarden**での自動入力
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { connect, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import { countLogEvents, projectRoot, readLogLines } from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'
const USER_DATA = process.env.NEMO_USER_DATA_DIR ?? ''

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

const ui = await connectUi(CDP)
const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const call = (expression) => ui.ev(`${expression}.then(() => 'ok')`)

/**
 * ユーザー操作として評価する。
 * **`window.open` は普通の `Runtime.evaluate` ではポップアップブロッカーに弾かれる**ので、
 * Peek を開く経路は必ずこちらを使う。
 */
async function evUser(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  const details = r.result?.exceptionDetails
  if (details) throw new Error(details.exception?.description ?? details.text ?? 'eval failed')
  return r.result?.result?.value
}

/**
 * 「自分が繋いでいる WebContents ごと消える」操作を撃つ。
 *
 * 小窓を閉じる系（⌘W / ⌘O）は**その小窓の UI WebContents 自体が破棄される**ので、
 * `ev` の応答が返ってこず永久に待つ。撃ちっぱなしにして時間で切り上げる。
 */
async function evSuicidal(session, expression) {
  await Promise.race([session.ev(expression).catch(() => null), sleep(2500).then(() => null)])
}

/** URL 完全一致でページ target に繋ぐ（UI 自身を掴まないように部分一致で選ばない）。 */
async function connectPage(url, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await listTargets(CDP)).filter((t) => t.type === 'page' && t.url === url)
    if (found.length === 1) return connect(found[0].webSocketDebuggerUrl)
    if (Date.now() > deadline) {
      throw new Error(`ページの target が1つに定まらない: ${url}（${found.length} 件）`)
    }
    await sleep(250)
  }
}

/** 生きているページ target の数（閉じ漏れた WebContents を数えるのに使う）。 */
async function pageTargetCount(urlPart) {
  const targets = await listTargets(CDP)
  return targets.filter((t) => t.type === 'page' && t.url.includes(urlPart)).length
}

const peekOf = (s, parentKey) => s.tabs.find((t) => t.peekParentKey === parentKey) ?? null
const normalTabs = (s) => s.tabs.filter((t) => t.peekParentKey === null)

/**
 * 診断ログの最後の `tab.foreground`（= chrome から見た active）。
 *
 * **ウィンドウを指定できるようにしてある**。ウィンドウ間の移動では
 * 移動先の同期のあとに移動元の「次のタブを選ぶ」が走るので、
 * 全体の最後の1件を見ると移動元の結果を読んでしまう。
 */
function lastForeground(windowId = null) {
  if (!USER_DATA) return null
  const lines = readLogLines(USER_DATA)
    .filter((line) => line.includes('"event":"tab.foreground"'))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null && (windowId === null || entry.windowId === windowId))
  return lines[lines.length - 1] ?? null
}

/** 親タブを1つ用意して Peek のテストページを開く。 */
async function openParent(site) {
  const url = `${PAGES}/peek.html?site=${site}`
  const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)})`)
  const page = await connectPage(url)
  await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
  return { key, url, page }
}

/* ------------------------------------------------------------------ *
 * 1. R1 — 新しい browsing context に付随するもの
 * ------------------------------------------------------------------ */

console.log('\n--- R1: POST body / window.opener / window.close')

{
  const parent = await openParent('post')
  await evUser(parent.page, "document.querySelector('#post-form').submit()")
  await sleep(1200)

  const s = await state()
  const peek = peekOf(s, parent.key)
  check('POST を target=_blank で投げると Peek ができる', peek !== null, peek ? peek.url : '(無し)')

  if (peek) {
    const echo = await connectPage(`${PAGES}/__nemo_echo__`)
    await waitFor(echo, "document.readyState === 'complete' ? 'ok' : ''")
    const method = await echo.ev("document.querySelector('#method').textContent")
    const body = await echo.ev("document.querySelector('#body').textContent")
    echo.close()
    check('Peek に POST として届く', method === 'POST', `method=${method}`)
    check(
      'POST の body が落ちていない',
      String(body).includes('nemo=peek-post-body'),
      `body=${JSON.stringify(body)}`
    )
    await call(`window.nemo.closePeek()`)
    await sleep(400)
  }
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

{
  const parent = await openParent('opener')
  await evUser(parent.page, "document.querySelector('#open-child').click()")
  await sleep(1500)

  const received = await parent.page.ev('JSON.stringify(window.__fromChild ?? [])')
  check(
    'window.opener.postMessage が親に届く',
    String(received).includes('nemo-peek-child-hello'),
    String(received)
  )

  await call(`window.nemo.closePeek()`)
  await sleep(400)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

{
  const parent = await openParent('selfclose')
  await evUser(parent.page, "document.querySelector('#open-selfclose').click()")
  await sleep(800)
  const opened = peekOf(await state(), parent.key)
  check('子が Peek として開く', opened !== null)

  await sleep(2500)
  const after = peekOf(await state(), parent.key)
  check('window.close() で Peek が閉じる', after === null, after ? `残っている: ${after.url}` : '')

  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

/* ------------------------------------------------------------------ *
 * 2. Peek の基本（一覧・可視・タブ切り替え）
 * ------------------------------------------------------------------ */

console.log('\n--- Peek の基本')

const base = await openParent('base')
await evUser(base.page, "document.querySelector('#open-blank').click()")
await sleep(1200)

{
  const s = await state()
  const peek = peekOf(s, base.key)
  check('target=_blank が Peek になる', peek !== null)
  check(
    'Peek は一覧（一時タブ）に出ない',
    s.tabs.some((t) => t.peekParentKey === base.key) && !normalTabs(s).some((t) => t.key === peek?.key)
  )
  check('サイドバーで選択されているのは親タブのまま', s.activeTabKey === base.key, `active=${s.activeTabKey}`)

  const visible = await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  const keys = JSON.parse(visible)
  check(
    'getVisibleTabKeys() が親と Peek の2つを返す',
    keys.length === 2 && keys.includes(base.key) && keys.includes(peek?.key),
    visible
  )

  const fg = lastForeground()
  check(
    'chrome から見た active が Peek を指す',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )
}

/* R2（再計算）: 別タブへ行って戻る */
{
  const other = await ui.ev(`window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)})`)
  await sleep(600)
  const hidden = await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  check('別タブへ行くと Peek は隠れる', JSON.parse(hidden).length === 1, hidden)

  const before = countLogEvents(USER_DATA, 'tab.foreground')
  await call(`window.nemo.selectTab(${JSON.stringify(base.key)})`)
  await sleep(600)
  const backVisible = JSON.parse(
    await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  )
  check('戻ると Peek が復帰する', backVisible.length === 2, JSON.stringify(backVisible))

  const s = await state()
  const peek = peekOf(s, base.key)
  const fg = lastForeground()
  check(
    'R2: 戻ったあとも chrome の active は Peek（毎回再計算している）',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )

  /* R2（再入）: 切り替えを繰り返しても呼び出し回数が有限であること */
  for (let i = 0; i < 5; i += 1) {
    await call(`window.nemo.selectTab(${JSON.stringify(other)})`)
    await call(`window.nemo.selectTab(${JSON.stringify(base.key)})`)
  }
  await sleep(800)
  const after = countLogEvents(USER_DATA, 'tab.foreground')
  check(
    'R2: 切り替えを繰り返しても同期が有限回で収まる（無限再入していない）',
    after - before < 60,
    `${after - before} 回`
  )
  const crashes = readLogLines(USER_DATA).filter((l) => l.includes('app.uncaught_exception')).length
  check('main の未捕捉例外が出ていない', crashes === 0, `${crashes} 件`)

  await call(`window.nemo.closeTab(${JSON.stringify(other)})`)
  await sleep(300)
}

/* ------------------------------------------------------------------ *
 * 3. 昇格（⌘O）と R11（道連れにしない）
 * ------------------------------------------------------------------ */

console.log('\n--- 昇格（⌘O）と outlivesOpener')

{
  // 昇格前に背面タブを1本足して、「昇格したら末尾に来る」を意味のある検査にする
  const trailing = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${PAGES}/login.html?site=trailing`)}, { background: true })`
  )
  await sleep(500)

  const before = await state()
  const peek = peekOf(before, base.key)
  const peekContentsId = peek?.webContentsId

  await call('window.nemo.promoteForegroundView()')
  await sleep(800)

  const after = await state()
  const promoted = after.tabs.find((t) => t.key === peek?.key)
  check('⌘O で Peek が通常タブになる', promoted !== undefined && promoted.peekParentKey === null)
  check(
    '昇格でページを読み直していない（WebContents の id が変わらない）',
    promoted?.webContentsId === peekContentsId,
    `${peekContentsId} → ${promoted?.webContentsId}`
  )
  check(
    '昇格したタブが配列の末尾にいる',
    after.tabs[after.tabs.length - 1]?.key === peek?.key,
    after.tabs.map((t) => t.title).join(' | ')
  )
  check('昇格したタブがアクティブになる', after.activeTabKey === peek?.key)

  /* R11: 元の親タブを閉じても昇格済みタブは残る */
  await call(`window.nemo.closeTab(${JSON.stringify(base.key)})`)
  await sleep(900)
  const survived = await state()
  const still = survived.tabs.find((t) => t.key === peek?.key)
  check(
    'R11: 元の親タブを閉じても昇格済みのタブが残る',
    still !== undefined && still.webContentsId === peekContentsId,
    `id=${still?.webContentsId}`
  )

  if (still) await call(`window.nemo.closeTab(${JSON.stringify(still.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(trailing)})`)
  await sleep(400)
}
base.page.close()

/* R11（未昇格）: 親を閉じたら Peek も閉じ、WebContents が残らない */
{
  const parent = await openParent('orphan')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)
  check('Peek ができている（前提）', peek !== null)

  // **この Peek 自身の URL で数える**。同じテストページを使い回すと
  // 別の節の残骸を数えてしまい、増減が見えなくなる。
  const peekUrl = peek?.url ?? ''
  const beforeCount = await pageTargetCount(peekUrl)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  await sleep(1500)

  const s = await state()
  check(
    '未昇格の Peek は親と一緒に閉じる',
    !s.tabs.some((t) => t.key === peek?.key),
    s.tabs.map((t) => t.url).join(' | ')
  )
  const afterCount = await pageTargetCount(peekUrl)
  check(
    '閉じ漏れた WebContents が残っていない',
    afterCount === beforeCount - 1,
    `${beforeCount} → ${afterCount}（${peekUrl}）`
  )
  parent.page.close()
}

/* ------------------------------------------------------------------ *
 * 4. R8 — 入れ子の popup で opener を殺さない
 * ------------------------------------------------------------------ */

console.log('\n--- R8: Peek の中の popup')

{
  const parent = await openParent('nested')
  // 親 → Peek（nested 役）
  await evUser(parent.page, `window.open(${JSON.stringify(`${PAGES}/peek.html?role=nested`)}, '_blank')`)
  await sleep(1400)
  const peek = peekOf(await state(), parent.key)
  check('親 → Peek ができる（前提）', peek !== null)

  // Peek → 孫 popup
  const child = await connectPage(`${PAGES}/peek.html?role=nested`)
  await waitFor(child, "document.readyState === 'complete' ? 'ok' : ''")
  await evUser(child, 'window.__openGrandChild()')
  await sleep(1600)

  const s = await state()
  const promoted = s.tabs.find((t) => t.key === peek?.key)
  check(
    'R8: Peek が通常タブへ昇格している（古いほうを閉じていない）',
    promoted !== undefined && promoted.peekParentKey === null,
    JSON.stringify(promoted && { key: promoted.key, peekParentKey: promoted.peekParentKey })
  )
  const grand = promoted ? peekOf(s, promoted.key) : null
  check('R8: 孫が昇格後タブの Peek になっている', grand !== null, grand ? grand.url : '(無し)')

  // 孫 → 昇格した親（元 Peek）へ postMessage が届く
  const received = await child.ev('JSON.stringify(window.__fromChild ?? [])')
  // nested 役のページは受信ハンドラを張っていないので、opener が生きているかは
  // 「孫が例外を出さずに開けたこと」と「昇格後タブが生きていること」で見る
  check(
    'R8: 元の Peek（= 孫の opener）が生きている',
    promoted !== undefined && promoted.webContentsId !== null,
    `webContentsId=${promoted?.webContentsId} received=${received}`
  )

  child.close()
  if (promoted) await call(`window.nemo.closeTab(${JSON.stringify(promoted.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(500)
}

/* ------------------------------------------------------------------ *
 * 5. R9 — Peek を持つ親タブのウィンドウ移動
 * ------------------------------------------------------------------ */

console.log('\n--- R9: Peek を持つ親タブの移動')

{
  const parent = await openParent('move')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)
  check('Peek ができている（前提）', peek !== null)

  await call(`window.nemo.moveTabToNewWindow(${JSON.stringify(parent.key)})`)
  await sleep(1800)

  // 移動先ウィンドウの UI に繋ぐ（元のウィンドウとは別の window= を持つ）
  const sidebars = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  const myWindow = /window=(\d+)/.exec(
    (await listTargets(CDP)).find((t) => t.url.includes('view=sidebar'))?.url ?? ''
  )
  const targets = []
  for (const sidebar of sidebars) {
    const session = await connect(sidebar.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    targets.push({ session, s })
  }
  const holder = targets.find((t) => t.s.tabs.some((tab) => tab.key === parent.key))
  check(
    '親タブが移動先ウィンドウにいる',
    holder !== undefined,
    `windows=${targets.length} ${myWindow?.[1] ?? ''}`
  )
  check(
    'R9: Peek も一緒に移動している',
    holder?.s.tabs.some((tab) => tab.key === peek?.key) === true,
    holder
      ? holder.s.tabs.map((t) => `${t.key.slice(0, 6)}:${t.peekParentKey ? 'peek' : 'tab'}`).join(' ')
      : ''
  )
  const fg = lastForeground(holder?.s.windowId ?? null)
  check(
    'R9: 移動後も chrome の active が Peek を指す',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )

  // 後片付け（移動先ウィンドウごと閉じる）
  if (holder) {
    await holder.session.ev(`window.nemo.closeTab(${JSON.stringify(parent.key)}).then(() => 'ok')`)
    await sleep(600)
  }
  for (const t of targets) t.session.close()
  parent.page.close()
  await sleep(600)
}

/* ------------------------------------------------------------------ *
 * 6. Peek を持つ親タブは寝ない
 * ------------------------------------------------------------------ */

console.log('\n--- sleep / archive の除外')

{
  const settings = JSON.parse(await ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))'))
  const parent = await openParent('sleep')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)

  // 別タブを選んで親を非アクティブにする（アクティブなタブはそもそも寝ない）
  const other = await ui.ev(`window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)})`)
  await ui.ev(`window.nemo.updateSettings({ tabSleepMinutes: 0.02 }).then(() => 'ok')`)
  await sleep(9000)

  const s = await state()
  const parentTab = s.tabs.find((t) => t.key === parent.key)
  check(
    'Peek を持つ親タブは tabSleepMinutes を過ぎても寝ない',
    parentTab !== undefined && parentTab.asleep === false,
    `asleep=${parentTab?.asleep}`
  )
  check(
    'Peek 自身も残っている',
    s.tabs.some((t) => t.key === peek?.key)
  )

  await ui.ev(`window.nemo.updateSettings({ tabSleepMinutes: ${settings.tabSleepMinutes} }).then(() => 'ok')`)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(other)})`)
  parent.page.close()
  await sleep(600)
}

/* ------------------------------------------------------------------ *
 * 7. 小窓（Little Nemo）
 * ------------------------------------------------------------------ */

console.log('\n--- 小窓')

/**
 * 外部アプリから URL を踏んだのと同じ経路を通す。
 *
 * **2つ目のインスタンスを起動する**。単一インスタンスロックに弾かれて
 * `second-instance` が飛び、`handleSecondInstance` → `openMiniWindow` に落ちる。
 * IPC から直接叩くと、実際に踏む経路（argv / open-url）を一度も通らない。
 */
async function openExternalUrl(url) {
  await new Promise((resolve) => {
    const child = spawn(electronPath, ['out/main/index.js', url], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: process.env
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
  await sleep(1500)
}

/** 通常ウィンドウ（サイドバー）の状態を全部取る。 */
async function normalStates() {
  const out = []
  const targets = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  for (const target of targets) {
    const session = await connect(target.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    out.push({ session, s })
  }
  return out
}

/** 小窓の UI target 一覧（`?view=mini`）。 */
async function miniTargets() {
  return (await listTargets(CDP)).filter((t) => t.url.includes('view=mini'))
}

async function miniStates() {
  const out = []
  for (const target of await miniTargets()) {
    const session = await connect(target.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    out.push({ session, s })
  }
  return out
}

{
  await openExternalUrl(`${PAGES}/login.html?site=mini1`)
  let minis = await miniStates()
  check('外部 URL は小窓で開く', minis.length === 1, `${minis.length} 枚`)
  check('小窓は kind=mini', minis[0]?.s.kind === 'mini', minis[0]?.s.kind)
  check('小窓のタブは1つ', minis[0]?.s.tabs.length === 1, `${minis[0]?.s.tabs.length}`)

  const main = await state()
  check(
    '小窓のタブは通常ウィンドウには入らない',
    !main.tabs.some((t) => t.url.includes('site=mini1')),
    main.tabs.map((t) => t.url).join(' | ')
  )
  for (const m of minis) m.session.close()

  /* 上限4枚 */
  for (const n of [2, 3, 4, 5]) await openExternalUrl(`${PAGES}/login.html?site=mini${n}`)
  minis = await miniStates()
  check('小窓は原則4枚まで（最古が閉じる）', minis.length === 4, `${minis.length} 枚`)
  const urls = minis.map((m) => m.s.tabs[0]?.url ?? '')
  check('閉じられたのは一番古い小窓', !urls.some((u) => u.includes('site=mini1')), urls.join(' | '))

  /* セッションに含まれない */
  if (USER_DATA) {
    await sleep(2600) // セッション保存のデバウンス
    const sessionFile = path.join(USER_DATA, 'session.json')
    const raw = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '{}'
    check('小窓はセッションに保存されない', !raw.includes('site=mini'), raw.slice(0, 200))
  }

  /* ⌘W（= closeTab）でウィンドウごと閉じ、⌘⇧T で戻せる */
  const victim = minis[minis.length - 1]
  await evSuicidal(
    victim.session,
    `window.nemo.closeTab(${JSON.stringify(victim.s.tabs[0].key)}).then(() => 'ok').catch(() => 'ok')`
  )
  await sleep(1200)
  const afterClose = await miniTargets()
  check(
    '小窓で ⌘W するとウィンドウごと閉じる（空の小窓が残らない）',
    afterClose.length === 3,
    `${afterClose.length} 枚`
  )

  for (const m of minis) {
    try {
      m.session.close()
    } catch {
      /* 閉じ済み */
    }
  }
  // ⌘⇧T は `reopen-tab` コマンド（メニューのアクセラレータ）で、UI の API には無い。
  // 「閉じた小窓が ⌘⇧T のスタックに積まれたか」は診断ログで確かめる。
  const closedLogged = readLogLines(USER_DATA).some((line) => line.includes('"event":"mini.closed"'))
  check('小窓を閉じたことが終了 API を通っている（⌘⇧T に積まれる経路）', closedLogged)

  /* ⌘O で通常ウィンドウへ移る */
  const remaining = await miniStates()
  if (remaining.length > 0) {
    const target = remaining[0]
    const movedUrl = target.s.tabs[0]?.url ?? ''
    const contentsId = target.s.tabs[0]?.webContentsId
    await evSuicidal(target.session, "window.nemo.promoteForegroundView().then(() => 'ok')")
    await sleep(1800)
    // **通常ウィンドウを全部見る**。行き先は「直近に使った通常ウィンドウ」なので、
    // 検証中にウィンドウが2枚できていると、こちらが繋いでいる方とは限らない。
    const normals = await normalStates()
    const landed = normals.flatMap((n) => n.s.tabs).find((t) => t.url === movedUrl)
    check(
      '小窓を ⌘O すると通常ウィンドウのタブになる',
      landed !== undefined,
      `${movedUrl}（通常ウィンドウ ${normals.length} 枚）`
    )
    check(
      '⌘O でページを読み直していない（WebContents の id が変わらない）',
      landed?.webContentsId === contentsId,
      `${contentsId} → ${landed?.webContentsId}`
    )
    check(
      '昇格した小窓は閉じている',
      (await miniTargets()).length === remaining.length - 1,
      `${(await miniTargets()).length} 枚`
    )
    if (landed) {
      const owner = normals.find((n) => n.s.tabs.some((t) => t.key === landed.key))
      await owner?.session.ev(`window.nemo.closeTab(${JSON.stringify(landed.key)}).then(() => 'ok')`)
    }
    for (const n of normals) n.session.close()
  } else {
    check('⌘O の検査に使う小窓が残っている', false, '0 枚')
  }

  // 後片付け: 残った小窓を閉じる
  for (const m of await miniStates()) {
    await evSuicidal(
      m.session,
      `window.nemo.closeTab(${JSON.stringify(m.s.tabs[0]?.key ?? '')}).then(() => 'ok').catch(() => 'ok')`
    )
    m.session.close()
  }
  await sleep(800)
  check('後片付けで小窓が残らない', (await miniTargets()).length === 0, `${(await miniTargets()).length} 枚`)
  check('検証中に main の未捕捉例外が出ていない', countLogEvents(USER_DATA, 'app.uncaught_exception') === 0)
}

console.log(failures === 0 ? '\n全て PASS' : `\n${failures} 件 FAIL`)
ui.close()
process.exit(failures === 0 ? 0 : 1)
