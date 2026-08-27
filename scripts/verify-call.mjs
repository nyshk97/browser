#!/usr/bin/env node
/**
 * 会議の小窓（Meet の通話コントロール）の自走検証。
 *
 * 見るもの（計画の R3 / R5 / R6 / R7 / R9 / R10 / R11 に対応）:
 *
 * - 会議タブから離れると出る / 戻ると引っ込む（破棄はしない）
 * - マイク・カメラのボタンが**ページ側の属性を実際に変える**（押した結果をページで裏取り）
 * - ページ側でミュートすると小窓の表示が追従する
 * - **R3**: 会議中のタブが sleep しない（縮退中も）。会議が終われば寝る
 * - **R5**: 縮退（プローブが読めない）と、そこからの復帰。経過時間が 0 に戻らない
 * - **R7**: 開閉 10 回でページ target 数がベースへ戻る（`webContents` の閉じ漏れ）
 * - **R10**: 複数 Meet／retarget／古い応答で復活しない
 * - **R11**: 同じ origin の別ページ（`index.html`）は候補にならない
 * - IPC の拒否: 小窓以外の sender から `call:*` を撃つと弾かれる
 *
 * ここで見られないもの（実機で人が確認する）:
 * - 他アプリのフルスクリーンの上に浮くか（R2）・⌘H したときの挙動（R1）
 * - ドラッグで位置を動かす操作そのもの（`moved` は合成できない）。
 *   **保存位置を読んでいること**は `--position-plant` / `--position-read` で見る
 *
 * 使い方:
 *   node scripts/verify-call.mjs                  … 本体（アプリが起動している状態で）
 *   node scripts/verify-call.mjs --position-plant … 位置を仕込む（**アプリを止めてから**）
 *   node scripts/verify-call.mjs --position-read  … 仕込んだ位置の扱いを確かめる（再起動後）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { connect, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import { readLogLines } from './lib/harness.mjs'
import { afterSweep, timings } from './lib/timings.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'
const USER_DATA = process.env.NEMO_USER_DATA_DIR ?? ''

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 診断ログ
 * ------------------------------------------------------------------ */

/** 指定イベントのログ行（**時刻順に並べ直す**。ファイルの読み出し順は保証されない）。 */
function logEvents(event) {
  return readLogLines(USER_DATA)
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

/** 小窓が「今出ているか」。**表示 / 非表示はログでしか外から見えない**（ウィンドウ API が無い）。 */
function lastVisibility() {
  const entries = [...logEvents('call.window_shown'), ...logEvents('call.window_hidden')].sort((a, b) =>
    String(a.t).localeCompare(String(b.t))
  )
  const last = entries[entries.length - 1]
  return last ? (last.event === 'call.window_shown' ? 'shown' : 'hidden') : null
}

/* ------------------------------------------------------------------ *
 * 位置の検証（アプリの再起動をまたぐ）
 * ------------------------------------------------------------------ */

const PLANT_MARKER = () => path.join(USER_DATA, 'call-window.plant.json')

/**
 * **画面外の座標**を仕込む。アプリを止めてから呼ぶ
 * （起動中に書くと、終了時の `closeCallWindowStore()` が上書きする）。
 */
function plantPosition() {
  if (!USER_DATA) {
    console.error('[verify-call] NEMO_USER_DATA_DIR が無い')
    process.exit(2)
  }
  const position = { x: 99999, y: 99999, displayId: 424242 }
  fs.writeFileSync(
    path.join(USER_DATA, 'call-window.json'),
    `${JSON.stringify({ version: 1, data: { position } }, null, 2)}\n`
  )
  // 再起動後のログだけを見るための目印（ログは全セッション分が連結されて読まれる）
  fs.writeFileSync(PLANT_MARKER(), JSON.stringify({ plantedAt: new Date().toISOString(), position }))
  console.log(`[verify-call] 画面外の位置を仕込んだ: ${JSON.stringify(position)}`)
}

async function readPosition() {
  const marker = JSON.parse(fs.readFileSync(PLANT_MARKER(), 'utf8'))
  const since = marker.plantedAt

  const ui = await connectUi(CDP)
  // 小窓を出す（会議タブを背面に作る）
  const url = `${PAGES}/meet-fake.html?state=joined&id=pos`
  const tabKey = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)}, { background: true })`)

  const created = await waitUntil(() => {
    const entries = logEvents('call.window_created').filter((e) => String(e.t) > since)
    return entries.length > 0 ? entries[entries.length - 1] : null
  })
  check('再起動後に小窓が作られる', created !== null, created ? JSON.stringify(created) : '(出なかった)')

  const rejected = logEvents('call.position_out_of_range').filter((e) => String(e.t) > since)
  check(
    '画面外の保存位置は捨てられる（保存位置を読んでいる証拠でもある）',
    rejected.length > 0,
    JSON.stringify(rejected[rejected.length - 1] ?? null)
  )
  check(
    '画面外の座標のまま復元しない（既定位置へ戻る）',
    created !== null && created.x < 99999 && created.y < 99999,
    created ? `x=${created.x} y=${created.y}` : ''
  )
  // **後片付けまでやる**。残すと、あとから走る検証のタブ数・sleep 状態に混ざる
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(tabKey)}).then(() => 'ok')`)
  ui.close()
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

async function waitUntil(fn, { timeoutMs = 9000, interval = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(interval)
  }
}

/** 小窓の UI target（無ければ空配列）。**ウィンドウの有無はこれで見る**。 */
async function callTargets() {
  const targets = await listTargets(CDP)
  return targets.filter((t) => t.type === 'page' && t.url.includes('view=call'))
}

async function withBar(fn) {
  const targets = await callTargets()
  if (targets.length === 0) return null
  const session = await connect(targets[0].webSocketDebuggerUrl)
  try {
    return await fn(session)
  } finally {
    session.close()
  }
}

/** 小窓に出ている内容（無ければ null）。 */
function barInfo() {
  return withBar(async (session) => {
    const raw = await session.ev(`(() => {
      const bar = document.querySelector('.call-bar')
      const device = (kind) => document.querySelector('[data-device="' + kind + '"]')
      const text = (selector) => {
        const el = document.querySelector(selector)
        return el ? el.textContent : null
      }
      return JSON.stringify({
        present: bar !== null,
        degraded: bar ? bar.dataset.degraded : null,
        host: text('.call-host'),
        elapsed: text('.call-elapsed'),
        mic: device('mic') ? device('mic').dataset.enabled : null,
        cam: device('cam') ? device('cam').dataset.enabled : null,
        hasGoto: document.querySelector('.call-goto') !== null,
        hasClose: document.querySelector('.call-close') !== null
      })
    })()`)
    return JSON.parse(raw)
  })
}

/**
 * バーが**描かれる**まで待つ。
 *
 * `barInfo()` は「target はあるが React がまだ描いていない」でも
 * `{ present: false }` を返す（＝真値）ので、そのまま `waitUntil` に渡すと
 * **描画前の空の状態を掴んで FAIL する**。必ず `present` で待つ。
 */
function waitBar(options) {
  return waitUntil(async () => {
    const info = await barInfo()
    return info?.present === true ? info : null
  }, options)
}

async function clickBar(selector) {
  const clicked = await withBar(async (session) => {
    return session.ev(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`
    )
  })
  if (!clicked) throw new Error(`小窓のボタンを押せなかった: ${selector}`)
}

/** 経過時間の表示（`m:ss` / `h:mm:ss`）を秒に直す。出ていなければ null。 */
function elapsedSeconds(info) {
  if (!info?.elapsed) return null
  const parts = info.elapsed.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((total, n) => total * 60 + n, 0)
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

const mode = process.argv[2] ?? ''
if (mode === '--position-plant') {
  plantPosition()
  process.exit(0)
}
if (mode === '--position-read') {
  await readPosition()
  console.log(
    failures === 0 ? '\n=== 会議の小窓（位置）: すべて PASS' : '\n=== 会議の小窓（位置）: FAIL あり'
  )
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * **この検証専用のウィンドウを立てる**。
 *
 * 「会議タブが見えているか」は**フォーカスにも依る**ので、
 * 既存のウィンドウにぶら下がると、前の検証が残した小窓（Little Nemo の panel）や
 * 2枚目のウィンドウにキーを取られていて、**会議タブを見ていても「見えていない」**になる
 * （フル検証でだけ落ちる、という一番たちの悪い形で踏んだ）。
 * `createWindow()` は `show: true` で作るので、作った時点でそれがキーウィンドウになる。
 */
async function openOwnWindow() {
  const bootstrap = await connectUi(CDP)
  const before = new Set(
    (await listTargets(CDP)).filter((t) => t.url.includes('view=sidebar')).map((t) => t.url)
  )
  await bootstrap.ev("window.nemo.createWindow().then(() => 'ok')")
  bootstrap.close()

  const found = await waitUntil(
    async () => {
      const fresh = (await listTargets(CDP)).find(
        (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1') && !before.has(t.url)
      )
      return fresh ?? null
    },
    { timeoutMs: 20000 }
  )
  if (!found) throw new Error('検証用のウィンドウを作れなかった')
  const session = await connect(found.webSocketDebuggerUrl)
  await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
  await waitFor(session, "window.nemo.getWindowState().then((s) => (s.tabs.length > 0 ? 'ok' : ''))")
  return session
}

const ui = await openOwnWindow()
const windowState = () =>
  ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const selectTab = (key) => ui.ev(`window.nemo.selectTab(${JSON.stringify(key)}).then(() => 'ok')`)
const closeTab = (key) => ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)

/**
 * ユーザー操作として評価する。
 *
 * **偽 Meet のボタンはこちらで押す**。`location.href = ...` を
 * user activation 無しで撃つと Chromium が**クライアントリダイレクト扱いにして
 * 履歴エントリを置き換える**ことがあり、そのあと「戻る」が効かない
 * （bfcache の検査が「戻れていないだけ」で落ちる）。
 */
async function evUser(session, expression) {
  // **必ず時間で切り上げる**。タブが sleep すると target ごと消え、
  // CDP の応答が永久に返らない（検査が1つ落ちただけで全体が固まる）。
  const sent = session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  const r = await Promise.race([sent, sleep(8000).then(() => null)])
  if (r === null) throw new Error(`ページの評価が返ってこない（タブが寝た？）: ${expression.slice(0, 60)}`)
  const details = r.result?.exceptionDetails
  if (details) throw new Error(details.exception?.description ?? details.text ?? 'eval failed')
  return r.result?.result?.value
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

/** 偽 Meet を1枚開く。`id` は target を一意に選ぶためのもの（内容には関係しない）。 */
async function openMeet(id, { joined = true, background = true } = {}) {
  const url = `${PAGES}/meet-fake.html?id=${id}${joined ? '&state=joined' : ''}`
  const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)}, ${JSON.stringify({ background })})`)
  const page = await connectPage(url)
  await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
  return {
    key,
    url,
    page,
    act: (id2) => evUser(page, `(document.getElementById(${JSON.stringify(id2)}).click(), 'ok')`),
    status: async () => JSON.parse(await page.ev("document.getElementById('status').textContent"))
  }
}

/** park 用の非会議タブ（起動時の空タブを使う）。 */
const parkKey = (await windowState()).tabs[0].key

/* ------------------------------------------------------------------ *
 * 1. 出る / 出ない の基本
 * ------------------------------------------------------------------ */

console.log('\n--- 出る / 出ない')

const meet = await openMeet('main', { joined: true, background: false })
await sleep(1500)

{
  const targets = await callTargets()
  const ok = targets.length === 0
  check(
    '会議タブを見ている間は小窓が出ない',
    ok,
    ok ? '' : '出てしまった（＝会議タブが「見えていない」と判定された）'
  )
  if (!ok) {
    /*
     * **ここで打ち切る**。「見えているか」はウィンドウのフォーカスにも依るので、
     * 検証用ウィンドウが前面に無いと以降の検査は**全部**意味を成さず、
     * 10 件以上の FAIL が並んで本当の原因が埋もれる（実際に埋もれた）。
     *
     * 一番ありがちなのは**常用の Nemo が前面にいる**こと。
     * `assertNemoNotRunning` はリポジトリの node_modules から起動したものしか見ないので、
     * パッケージ済みの .app は素通りする。ここで名指しして終わる。
     */
    let running = ''
    try {
      running = execFileSync('/bin/ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /\/MacOS\/Nemo( Dev)?$/.test(line.trim()))
        .map((line) => `    ${line.trim()}`)
        .join('\n')
    } catch {
      /* ps が使えなくても案内は出す */
    }
    console.log(
      '\n[verify-call] 検証用ウィンドウが前面にない。以降の検査は成立しないので中断する。\n' +
        '  「会議タブが見えているか」はウィンドウのフォーカスにも依る（他アプリ作業中に小窓を出すための機能なので）。\n' +
        (running ? `  前面を奪っていそうな Nemo:\n${running}\n` : '') +
        '  起動中の Nemo を終了してからやり直す。'
    )
    ui.close()
    process.exit(1)
  }
}

await selectTab(parkKey)
{
  const info = await waitBar()
  check('会議タブから離れると小窓が出る', info?.present === true, JSON.stringify(info))
  check('縮退していない（マイク・カメラが出ている）', info?.degraded === '0', JSON.stringify(info))
  check('マイクもカメラも ON として出る', info?.mic === 'true' && info?.cam === 'true', JSON.stringify(info))
  check('経過時間が出ている', elapsedSeconds(info) !== null, String(info?.elapsed))
  check('表示状態のログが shown', lastVisibility() === 'shown', String(lastVisibility()))
}

/* ------------------------------------------------------------------ *
 * 2. マイク / カメラ（**押した結果をページ側で裏取りする**）
 * ------------------------------------------------------------------ */

console.log('\n--- マイク / カメラ')

await clickBar('[data-device="mic"]')
{
  const status = await waitUntil(async () => {
    const s = await meet.status()
    return s.clicks.mic === 1 && s.micMuted === 'true' ? s : null
  })
  check(
    '小窓のマイクボタンがページ側の data-is-muted を変える',
    status !== null,
    JSON.stringify(status ?? (await meet.status()))
  )
  const info = await waitUntil(async () => {
    const value = await barInfo()
    return value?.mic === 'false' ? value : null
  })
  check('小窓の表示がマイク OFF に追従する', info !== null, JSON.stringify(info ?? (await barInfo())))
}

await clickBar('[data-device="cam"]')
{
  const status = await waitUntil(async () => {
    const s = await meet.status()
    return s.clicks.cam === 1 && s.camMuted === 'true' ? s : null
  })
  check('小窓のカメラボタンがページ側に届く', status !== null, JSON.stringify(status))
}

// ページ側で戻すと小窓が追従する（片方向でないこと）
await meet.act('mic')
{
  const info = await waitUntil(async () => {
    const value = await barInfo()
    return value?.mic === 'true' ? value : null
  })
  check(
    'ページ側でミュートを解除すると小窓が追従する',
    info !== null,
    JSON.stringify(info ?? (await barInfo()))
  )
}

/* ------------------------------------------------------------------ *
 * 3. 会議へ移動する
 * ------------------------------------------------------------------ */

console.log('\n--- 会議へ移動する')

await clickBar('.call-goto')
{
  const ok = await waitUntil(async () => {
    const state = await windowState()
    return state.activeTabKey === meet.key ? state : null
  })
  check(
    'ドメイン名を押すと会議タブがアクティブになる',
    ok !== null,
    `active=${(await windowState()).activeTabKey}`
  )
  const gone = await waitUntil(async () => ((await callTargets()).length === 0 ? 'destroyed' : null), {
    timeoutMs: 3000
  })
  const hidden = lastVisibility() === 'hidden'
  check(
    '戻ったら小窓は引っ込む（hide か destroy）',
    gone !== null || hidden,
    `visibility=${lastVisibility()}`
  )
  check(
    '戻っただけでは破棄しない（会議中は行き来が頻繁なので作り直さない）',
    (await callTargets()).length === 1,
    `targets=${(await callTargets()).length}`
  )
}

// 離れればまた出る。**閉じる手段は置いていない**ので、会議中はこの往復だけになる
await selectTab(parkKey)
{
  const info = await waitBar()
  check('また離れると出てくる', info?.present === true, JSON.stringify(info))
  check('✕ は置いていない（会議中はいつでも出ている）', info?.hasClose === false, JSON.stringify(info))
}

/* ------------------------------------------------------------------ *
 * 4. 縮退と、そこからの復帰（R5）
 * ------------------------------------------------------------------ */

console.log('\n--- 縮退と復帰')

// 経過時間が数秒たまってから壊す（復帰後に 0 へ戻らないことを見るため）
await sleep(4000)
const beforeBreak = elapsedSeconds(await barInfo())
await meet.act('break')
{
  const info = await waitUntil(async () => {
    const value = await barInfo()
    return value?.degraded === '1' ? value : null
  })
  check('プローブが読めなくなると縮退する', info !== null, JSON.stringify(info ?? (await barInfo())))
  check(
    '縮退時はマイク・カメラのボタンを出さない',
    info?.mic === null && info?.cam === null,
    JSON.stringify(info)
  )
  check('縮退時は会議へ移動するボタンだけ残る', info?.hasGoto === true, JSON.stringify(info))
  check(
    '縮退時は経過時間を出さない（0:00 で止まって見せない）',
    info?.elapsed === null,
    String(info?.elapsed)
  )
  check('診断ログに call.probe_failed が残る', logEvents('call.probe_failed').length > 0)
}

await meet.act('repair')
{
  const info = await waitUntil(async () => {
    const value = await barInfo()
    return value?.degraded === '0' ? value : null
  })
  check('正常値が返ると縮退から復帰する', info !== null, JSON.stringify(info ?? (await barInfo())))
  check(
    '復帰するとマイク・カメラのボタンが戻る',
    info?.mic !== null && info?.cam !== null,
    JSON.stringify(info)
  )
  const after = elapsedSeconds(info)
  check(
    '復帰後の経過時間が縮退前から続いている（0 に戻らない）',
    beforeBreak !== null && after !== null && after >= beforeBreak,
    `縮退前=${beforeBreak}s 復帰後=${after}s`
  )
}

/* ------------------------------------------------------------------ *
 * 5. 参加をやめる / 再参加（経過時間は数え直す）
 * ------------------------------------------------------------------ */

console.log('\n--- 参加をやめる / 再参加')

const beforeLeave = elapsedSeconds(await barInfo())
await meet.act('leave')
{
  const gone = await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))
  check('参加をやめると小窓が消える', gone !== null)
}

await meet.act('join')
{
  const info = await waitBar()
  check('再参加すると小窓が出る', info?.present === true, JSON.stringify(info))
  const after = elapsedSeconds(info)
  check(
    '再参加では経過時間を 0 から数え直す（縮退からの復帰と混同しない）',
    beforeLeave !== null && after !== null && after < beforeLeave,
    `退出前=${beforeLeave}s 再参加後=${after}s`
  )
}

/* ------------------------------------------------------------------ *
 * 6. R11 — 同じ origin の別ページは候補にならない
 * ------------------------------------------------------------------ */

console.log('\n--- R11: 同じ origin の別ページ')

await closeTab(meet.key)
meet.page.close()
await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))

{
  const other = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)}, { background: true })`
  )
  await sleep(2500)
  check(
    '同じ origin の index.html は会議候補にならない',
    (await callTargets()).length === 0,
    `targets=${(await callTargets()).length}`
  )
  await closeTab(other)
}

/* ------------------------------------------------------------------ *
 * 7. R10 — 複数 Meet と retarget
 * ------------------------------------------------------------------ */

console.log('\n--- R10: 複数 Meet')

// **古いほうが参加中・新しいほうが未参加**。1件しかプローブしない実装はここで落ちる
const older = await openMeet('older', { joined: true })
await sleep(500)
const newer = await openMeet('newer', { joined: false })
// `lastActiveAt` は「選んだ時刻」なので、順に選んで新しい側を確定させる
await selectTab(older.key)
await sleep(300)
await selectTab(newer.key)
await sleep(300)
await selectTab(parkKey)

{
  const info = await waitBar()
  check('参加中の会議があれば小窓が出る（直近が未参加でも）', info?.present === true, JSON.stringify(info))
  await clickBar('.call-goto')
  const active = await waitUntil(async () => {
    const s = await windowState()
    return s.activeTabKey === older.key ? s.activeTabKey : null
  })
  check(
    '対象は「参加中」のほう（直近の未参加タブではない）',
    active !== null,
    `active=${(await windowState()).activeTabKey} / 参加中=${older.key} / 未参加=${newer.key}`
  )
}

// 2 つとも参加中にして「直近のほうが対象になる」と retarget を見る
await newer.act('join')
// **参加が検知されるまで待つ**（プローブは最大5秒ごと）。
// 待たずに進むと「まだ未参加の側」を対象から外して判定してしまう
const newerJoined = await waitUntil(
  () => (logEvents('call.joined').some((e) => e.key === newer.key) ? 'joined' : null),
  { timeoutMs: 12000 }
)
check('未参加だった会議に参加すると検知される', newerJoined !== null)
await selectTab(older.key)
await sleep(300)
await selectTab(newer.key)
await sleep(300)
await selectTab(parkKey)
await waitUntil(async () => {
  const info = await barInfo()
  return info?.degraded === '0' ? info : null
})

{
  // `lastActiveAt` が最大なのは newer なので、それが対象
  await clickBar('.call-goto')
  const first = await waitUntil(async () => {
    const s = await windowState()
    return s.activeTabKey === newer.key ? s.activeTabKey : null
  })
  check(
    '両方参加中なら直近のほうが対象になる',
    first !== null,
    `active=${(await windowState()).activeTabKey}`
  )
}

// retarget を見るために、**古いほうの会議を直近にして対象へ引き戻す**
await selectTab(older.key)
await sleep(300)
await selectTab(parkKey)
await waitBar()
{
  const before = await barInfo()
  const destroyedBefore = logEvents('call.window_destroyed').length
  // 今の対象（older）の会議を終える → newer へ retarget される
  await older.act('leave')
  const after = await waitUntil(async () => {
    const value = await barInfo()
    const seconds = elapsedSeconds(value)
    const beforeSeconds = elapsedSeconds(before)
    return value?.present === true && seconds !== null && beforeSeconds !== null && seconds !== beforeSeconds
      ? value
      : null
  })
  check('対象の会議が終わっても、別の会議が残っていれば小窓は消えない', after !== null, JSON.stringify(after))
  check(
    'retarget で小窓を作り直していない（destroy が増えていない）',
    logEvents('call.window_destroyed').length === destroyedBefore,
    `destroy ${destroyedBefore} → ${logEvents('call.window_destroyed').length}`
  )
  check(
    'retarget 後の経過時間は移った先の会議のもの',
    after !== null && elapsedSeconds(after) !== elapsedSeconds(before),
    `前=${before?.elapsed} 後=${after?.elapsed}`
  )
}

/* ------------------------------------------------------------------ *
 * 8. R10 — 古い応答で復活しない
 * ------------------------------------------------------------------ */

console.log('\n--- R10: 古い応答で復活しない')

await older.act('join')
await selectTab(older.key)
await sleep(300)
await selectTab(parkKey)
await waitBar()
{
  // プローブが飛んでいる最中に両方閉じる
  await closeTab(older.key)
  await closeTab(newer.key)
  older.page.close()
  newer.page.close()
  const gone = await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))
  check('会議タブを全部閉じると小窓が消える', gone !== null)
  // プローブ周期（2〜5秒）より長く待って、遅れて届いた応答で復活しないことを見る
  await sleep(6000)
  check('古いプローブ応答で小窓が復活しない', (await callTargets()).length === 0)
}

/* ------------------------------------------------------------------ *
 * 9. bfcache（戻る / 進む）
 * ------------------------------------------------------------------ */

console.log('\n--- bfcache')

const bf = await openMeet('bfcache', { joined: true })
await selectTab(parkKey)
await waitBar()
await bf.act('go-away')
{
  const gone = await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))
  check('Meet 以外へ遷移すると候補から外れる', gone !== null)
}
await ui.ev(`window.nemo.goBack(${JSON.stringify(bf.key)}).then(() => 'ok')`)
{
  const info = await waitBar({ timeoutMs: 12000 })
  const back = (await windowState()).tabs.find((t) => t.key === bf.key)
  check(
    '戻るで復帰したあとも候補として検知される（bfcache では dom-ready が出ない）',
    info?.present === true,
    `bar=${JSON.stringify(info)} tabUrl=${back?.url} asleep=${back?.asleep}`
  )
}

/* ------------------------------------------------------------------ *
 * 10. R3 — 会議中のタブは寝ない
 * ------------------------------------------------------------------ */

console.log('\n--- R3: sleep の除外')

const originalSleep = JSON.parse(
  await ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))')
).tabSleepMinutes
// **設定値は ms 定数から導出する**（両方に数字を書くと片方だけ直してズレる）
const SLEEP_THRESHOLD_MS = 1_500
/**
 * `call-coordinator.ts` の `PROBE_INTERVAL_JOINED`。
 * 会議の状態が変わっても、`isSleepExempt` に反映されるのは**次のプローブを撃ってから**。
 * （timings 経由にするかは計画の Phase 4 ⑤ 待ち。ここは値を写して根拠をコメントで残す）
 */
const PROBE_INTERVAL_JOINED_MS = 2_000
/** 状態変化がプローブに拾われるまで（1 回だと撃った直後の変化を取りこぼすので 2 周期分見る）。 */
const PROBE_SETTLE_MS = PROBE_INTERVAL_JOINED_MS * 2
await ui.ev(
  `window.nemo.updateSettings({ tabSleepMinutes: ${SLEEP_THRESHOLD_MS / 60_000} }).then(() => "ok")`
)

const sleeper = await ui.ev(
  `window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)}, { background: true })`
)
// 作ったばかりの sleeper が期限切れになるまで + sweep 1 周（周期は timings 経由で読み戻す）
await sleep(afterSweep(SLEEP_THRESHOLD_MS))

const asleepOf = async (key) => {
  const s = await windowState()
  return s.tabs.find((t) => t.key === key)?.asleep ?? null
}

check('比較用の普通のタブは寝る（除外の検査が空振りしていない証拠）', (await asleepOf(sleeper)) === true)
check('会議中のタブは寝ない', (await asleepOf(bf.key)) === false, `asleep=${await asleepOf(bf.key)}`)

// 縮退中でも寝ない
await bf.act('break')
// bf は既に期限切れ（上で SLEEP_THRESHOLD_MS 以上待っている）。
// 待ちを決めるのは**縮退がプローブに拾われるまで**と sweep 1 周の大きい方
await sleep(afterSweep(Math.max(0, PROBE_SETTLE_MS - timings.sleepSweepMs)))
check('縮退中（プローブが読めない）でも会議タブは寝ない', (await asleepOf(bf.key)) === false)
await bf.act('repair')

// 会議が終われば寝るようになる（永久に寝ないタブを残さない）
await bf.act('leave')
// 退出がプローブに拾われて除外が外れてから、sweep 1 周で寝る
await sleep(afterSweep(PROBE_SETTLE_MS))
check(
  '会議が終わったら寝るようになる（除外が外れる）',
  (await asleepOf(bf.key)) === true,
  `asleep=${await asleepOf(bf.key)}`
)

await ui.ev(`window.nemo.updateSettings({ tabSleepMinutes: ${originalSleep} }).then(() => "ok")`)
await closeTab(sleeper)
await closeTab(bf.key)
bf.page.close()
await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))

/* ------------------------------------------------------------------ *
 * 11. R7 — 開閉 10 回でプロセスが戻る
 * ------------------------------------------------------------------ */

console.log('\n--- R7: 開閉 10 回（webContents の閉じ漏れ）')

const baseTargets = (await listTargets(CDP)).filter((t) => t.type === 'page').length
for (let i = 0; i < 10; i += 1) {
  const round = await openMeet(`leak${i}`, { joined: true })
  const shown = await waitUntil(async () => ((await callTargets()).length === 1 ? 'shown' : null))
  if (!shown) {
    check(`開閉 ${i + 1} 回目で小窓が出る`, false)
    break
  }
  await closeTab(round.key)
  round.page.close()
  await waitUntil(async () => ((await callTargets()).length === 0 ? 'gone' : null))
}
{
  // target の消滅は非同期なので少し待つ
  await sleep(1500)
  const afterTargets = (await listTargets(CDP)).filter((t) => t.type === 'page').length
  check(
    '開閉 10 回でページ target 数がベースへ戻る（webContents を閉じている）',
    afterTargets === baseTargets,
    `base=${baseTargets} after=${afterTargets}`
  )
}

/* ------------------------------------------------------------------ *
 * 12. IPC の拒否（R8）
 * ------------------------------------------------------------------ */

console.log('\n--- R8: IPC の拒否')

for (const [name, expression] of [
  ['call:getState', 'window.nemo.getCallState()'],
  ['call:focusTab', 'window.nemo.callFocusTab()'],
  ['call:toggleMic', 'window.nemo.callToggleMic()'],
  ['call:toggleCam', 'window.nemo.callToggleCam()']
]) {
  const result = await ui.ev(`${expression}.then(() => 'allowed', (e) => 'rejected:' + String(e.message))`)
  check(`サイドバーから ${name} は弾かれる`, String(result).startsWith('rejected:'), String(result))
}

ui.close()
console.log(failures === 0 ? '\n=== 会議の小窓: すべて PASS' : `\n=== 会議の小窓: FAIL ${failures} 件`)
process.exit(failures === 0 ? 0 : 1)
