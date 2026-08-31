#!/usr/bin/env node
/**
 * 分割ビュー（2 ペイン）の自走検証。
 *
 * **D&D だけは UI の合成イベントで撃つ**。IPC を直接叩くと当たり判定を通らないので、
 * 「行の中央帯に落としたら分割になる／上下端では何も起きない」が検証できない。
 * それ以外は `window.nemo.*` か、検証専用のコマンドの口から撃つ。
 *
 * **キー操作は撃てない**。⌘W / ⌘数字 / ⌃Tab / ⌘F / ⌘⇧N はメニューのアクセラレータで、
 * AppKit が NSEvent の段階で食うので `Input.dispatchKeyEvent` では入口ごと発火しない
 * （`verify-switcher.mjs` の冒頭にも同じ注意がある）。
 * ここでは `runCommandForVerify` から撃ち、**キーの割り当てそのもの**は
 * `keybindings.test.mjs` と人間の動作確認に分けてある。
 *
 * ここで見られないもの:
 * - **角丸**（`SPLIT_RADIUS`）。bounds には出ないので、`NEMO_VERIFY_SHOTS` で撮った PNG を人が見る
 * - **実キー入力からアクセラレータへの接続**（上記のとおり）
 *
 * 使い方:
 *
 *   mise run verify:split                      # 単体（アプリの起動ごと面倒を見る）
 *   NEMO_VERIFY_SHOTS=<dir> mise run verify:split   # 目視用の PNG も出す
 *   node scripts/verify-split.mjs --restart-write   # 再起動をまたぐ検証の書き込み側
 *   node scripts/verify-split.mjs --restart-read    # 同・読み出し側
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import { captureWindow } from './lib/window-shot.mjs'
import { afterSessionSave, afterSweep } from './lib/timings.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'
const SHOT_DIR = process.env.NEMO_VERIFY_SHOTS ?? ''
/** Live Folder の取得先（`verify-all.mjs` がローカルへ向ける）。 */
const GITHUB_ENDPOINT = process.env.NEMO_GITHUB_TEST_ENDPOINT ?? ''
/** 再起動をまたいで値を渡す置き場（`verify-live-folder.mjs` と同じ作法）。 */
const MARKER_PATH = path.join(process.env.NEMO_USER_DATA_DIR ?? '.', 'split.restart.json')

const argv = process.argv.slice(2)
const MODE = argv.includes('--restart-write')
  ? 'restart-write'
  : argv.includes('--restart-read')
    ? 'restart-read'
    : 'full'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 条件に到達できなかったものは**黙って PASS にしない**（何を見ていないかを必ず出す）。 */
let skipped = 0
function skip(name, reason) {
  skipped += 1
  console.log(`SKIP  ${name} — ${reason}`)
}

const ui = await connectUi(CDP)
const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const call = (expression) => ui.ev(`${expression}.then(() => 'ok')`)
const visibleKeys = () =>
  ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))').then(JSON.parse)
const diag = () =>
  ui.ev('window.nemo.splitDiagnostics().then((d) => JSON.stringify(d))').then((raw) => JSON.parse(raw))
/** メニューのコマンドを名前で撃つ（キーでは撃てないため）。 */
const runCommand = (command) =>
  ui.ev(`window.nemo.runCommandForVerify(${JSON.stringify(command)}).then((ok) => (ok ? 'ok' : 'no'))`)

const tabOf = (s, key) => s.tabs.find((tab) => tab.key === key) ?? null

/**
 * ペインのツールバーにつなぐ。
 * URL は `?view=toolbar&window=N&pane=right` なので、**`view=toolbar&pane=right` では一致しない**。
 */
async function toolbarOf(pane) {
  const session =
    pane === 'right'
      ? await connectUi(CDP, 'toolbar', { urlPart: 'pane=right' })
      : await connectUi(CDP, 'toolbar', { exclude: 'pane=right' })
  // **描画を待つ**。`connectUi` が待つのは preload の `window.nemo` までで、
  // React の初回描画は待たない（右ペインのツールバーは遅延生成なので必ず踏む）。
  await waitFor(session, "document.querySelector('.toolbar .addr') ? 'ok' : ''")
  return session
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

/** サイドバーを綺麗にする（前の検証が残したタブを畳む）。 */
async function resetTabs() {
  const s = await state()
  for (const tab of s.tabs) {
    if (tab.splitSide !== null) await call(`window.nemo.separateSplit(${JSON.stringify(tab.key)})`)
  }
  /*
   * **Peek を先に、まとめて閉じる**。`removeTab` は親を閉じるときに Peek も一緒に畳むので、
   * 親を先に閉じてから Peek の key を閉じにいくと
   * `tab does not belong to this window` で落ちる（分割中の Peek を残す検証を足してから踏む）。
   */
  for (const tab of (await state()).tabs) {
    if (tab.peekParentKey !== null) await call(`window.nemo.closeTab(${JSON.stringify(tab.key)})`)
  }
  const after = await state()
  // **残す 1 本も通常タブから選ぶ**（Peek を選ぶと、親を閉じた時点で道連れになる）
  const keep = after.tabs.find(
    (tab) => tab.pinnedId === null && tab.favoriteId === null && tab.peekParentKey === null
  )
  for (const tab of after.tabs) {
    if (tab.key === keep?.key) continue
    if (tab.pinnedId !== null || tab.favoriteId !== null) continue
    if (tab.peekParentKey !== null) continue
    await call(`window.nemo.closeTab(${JSON.stringify(tab.key)})`)
  }
}

/** 一時タブを n 本作って key を返す（作った順）。 */
async function makeTabs(n, prefix = 'split') {
  const keys = []
  for (let i = 0; i < n; i += 1) {
    const url = `${PAGES}/blank.html?${prefix}-${i}`
    const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)}, { background: true })`)
    keys.push(key)
  }
  /*
   * 一覧に出て、**読み込みが終わるまで**待つ。
   *
   * 一覧に出た時点で返すと、まだ読み込み中のタブに `navigate()` を撃つ経路ができる。
   * Electron の `loadURL` は**別 URL の `did-fail-load` でも reject する**ので、
   * 中断された元の読み込み（`ERR_ABORTED (-3) loading 'blank.html?lf-0'`）が
   * `nemo:navigate` の失敗として飛び、スクリプトごと落ちる（間欠的に踏んだ）。
   */
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       ${JSON.stringify(keys)}.every((k) => {
         const tab = s.tabs.find((t) => t.key === k)
         return tab !== undefined && !tab.loading
       }) ? 'ok' : '')`
  )
  return keys
}

/**
 * サイドバーの行に D&D を撃つ。
 *
 * **`dragover` の時点では `getData` が読めない**という HTML5 の制約まで再現するため、
 * `dragover` に渡す `DataTransfer` は `types` だけを持たせ、`drop` で値を返す。
 * 実装が `types` だけで判定して素通りさせていたら、ここで落ちる。
 *
 * @param {string} targetKey 落とす先のタブ
 * @param {string} draggedKey 掴んでいるタブ
 * @param {'top'|'middle'|'bottom'} where 行のどこへ落とすか
 */
function dragScript(targetKey, draggedKey, where) {
  return `(() => {
    const TYPE = 'application/x-nemo-tab'
    // 行は data-key を出しているのでそのまま引ける
    // 一時タブ行は \`data-key\`（タブ key）、ピン留め行は \`data-pin\`（定義の ID）で引ける
    const find = (key) =>
      document.querySelector('[data-key=' + JSON.stringify(key) + ']') ??
      document.querySelector('[data-pin=' + JSON.stringify(key) + ']')
    const target = find(${JSON.stringify(targetKey)})
    const source = find(${JSON.stringify(draggedKey)})
    if (!target || !source) return JSON.stringify({ ok: false, reason: 'row not found' })
    const rect = target.getBoundingClientRect()
    const y =
      ${JSON.stringify(where)} === 'top'
        ? rect.top + 2
        : ${JSON.stringify(where)} === 'bottom'
          ? rect.bottom - 2
          : rect.top + rect.height / 2
    const x = rect.left + rect.width / 2

    /** dragover 用（値は読めない）。 */
    const overData = {
      types: [TYPE],
      dropEffect: 'none',
      effectAllowed: 'move',
      getData: () => '',
      setData: () => {}
    }
    /** drop 用（値が読める）。 */
    const dropData = {
      types: [TYPE],
      dropEffect: 'move',
      effectAllowed: 'move',
      getData: (type) => (type === TYPE ? ${JSON.stringify(draggedKey)} : ''),
      setData: () => {}
    }
    const fire = (el, type, data) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: data })
      Object.defineProperty(event, 'clientX', { value: x })
      Object.defineProperty(event, 'clientY', { value: y })
      el.dispatchEvent(event)
      return event
    }
    fire(source, 'dragstart', dropData)
    const over = fire(target, 'dragover', overData)
    const accepted = over.defaultPrevented
    // 受け皿のハイライトは行そのものに付く（チップに落ちたときは親の行を見る）
    const row = target.closest('.row') ?? target
    const dropping = row.classList.contains('drop-split')
    if (accepted) fire(target, 'drop', dropData)
    fire(source, 'dragend', dropData)
    window.dispatchEvent(new Event('dragend'))
    return JSON.stringify({ ok: true, accepted, dropping })
  })()`
}

/** ページ領域の中身を読む（描かれているかの確認）。 */
async function pageInfo(url) {
  const session = await connectTo(CDP, url, { type: 'page' })
  const info = await session.ev('JSON.stringify({ href: location.href, w: innerWidth, h: innerHeight })')
  session.close()
  return JSON.parse(info)
}

/** ユーザー操作としての eval（`window.open` はユーザー操作が無いと弾かれる）。 */
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

/** 好きな URL でタブを 1 本作って、一覧に出るまで待つ。 */
async function openTab(url) {
  const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)}, { background: true })`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.some((t) => t.key === ${JSON.stringify(key)}) ? 'ok' : '')`
  )
  return key
}

/** D&D で分割を作り、成立するまで待つ（左 = ドロップ先・右 = 掴んだ方）。 */
async function makeSplit(leftKey, rightKey) {
  const result = JSON.parse(await ui.ev(dragScript(leftKey, rightKey, 'middle')))
  if (!result.accepted) throw new Error(`分割のドロップが受け付けられなかった: ${JSON.stringify(result)}`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.find((t) => t.key === ${JSON.stringify(leftKey)})?.splitSide === 'left' ? 'ok' : '')`
  )
}

/**
 * 条件が満たされたかを**真偽値で**返す（`waitFor` は満たされないと throw する）。
 *
 * `check(name, true)` と書いて判定を `waitFor` に任せると、回帰したときに
 * FAIL 行が出ないままスクリプトごと落ち、**以降の検査が一度も走らない**。
 */
async function became(session, expression, options) {
  return waitFor(session, expression, options).then(
    () => true,
    () => false
  )
}

/** 矩形 a が矩形 b の内側に収まっているか。 */
const inside = (a, b) =>
  a !== null &&
  b !== undefined &&
  a.x >= b.x &&
  a.y >= b.y &&
  a.x + a.width <= b.x + b.width &&
  a.y + a.height <= b.y + b.height

async function updateSetting(patch) {
  return JSON.parse(
    await ui.ev(`window.nemo.updateSettings(${JSON.stringify(patch)}).then((s) => JSON.stringify(s))`)
  )
}

/**
 * ペインの bounds が 2 回続けて同じになるまで待つ（レイアウトの遷移が終わった印）。
 * 撮影の前に挟まないと、**動いている途中**の絵が残って目視の材料にならない。
 */
async function settleLayout() {
  let prev = ''
  for (let i = 0; i < 25; i += 1) {
    const d = await diag()
    const now = JSON.stringify({ panes: d.panes.map((pane) => pane.outer), ring: d.focusRing })
    if (now === prev) return
    prev = now
    await sleep(120)
  }
}

/**
 * 目視用の PNG を 1 枚撮る（`NEMO_VERIFY_SHOTS` を指定したときだけ）。
 *
 * **撮る前に整える**。撮ってから気づいても撮り直せない:
 * - レイアウトの遷移が終わるのを待つ
 * - ポインタをサイドバーの外へ逃がして `:hover` を 0 件にする
 *   （行のハイライトが混ざると、結合行の「フォーカス側チップ」の見え方が判定できない）
 *
 * **戻り値も検査する**。画面収録の許可が無いと `captureWindow()` は null を返すので、
 * 見ないままだと「1 枚も撮れていないのに全部 PASS」になる。
 */
async function shoot(name, mediaSourceId) {
  if (!SHOT_DIR) return null
  // 合成の `mouseMoved` でも `:hover` は動く。サイドバーの外（負の座標）へ逃がす
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -50, y: -50, button: 'none' })
  await settleLayout()
  const hovered = await ui.ev("document.querySelectorAll('.row:hover, .chip:hover, .split-row:hover').length")
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = captureWindow(mediaSourceId, path.join(SHOT_DIR, `split-${name}.png`))
  check(
    `スクショ: ${name} が撮れて hover も混ざっていない`,
    file !== null && hovered === 0,
    file === null ? '撮影に失敗（画面収録の許可を確認する）' : `${path.resolve(file)}（hover ${hovered} 件）`
  )
  return file
}

/* ------------------------------------------------------------------ *
 * 再起動をまたぐ検証
 * ------------------------------------------------------------------ */

if (MODE === 'restart-write') {
  // **既存のタブを片付けない**。この再起動には phase1（セッション復元）と
  // pins（遅延ロード）の書き込みが相乗りしていて、消すとそちらの検証が落ちる。
  // **2 組**作る。1 組だけだと「復元で全ペアが materialize される」誤実装が通ってしまう
  const [a, b, c, d] = await makeTabs(4, 'restart')
  await makeSplit(a, b)
  await makeSplit(c, d)
  const s = await state()
  const pairs = s.tabs.filter((tab) => tab.splitSide === 'left').length
  check('再起動前: 分割が 2 組できている', pairs === 2, `pairs=${pairs}`)
  // 片方の組をアクティブにしておく（もう片方は寝たまま復元されるはず）
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  // **セッション保存はデバウンスされている**ので、書かれるまで待つ
  // （待たずに抜けると、運が悪いと分割が保存されないまま終了する。
  // フル検証でだけ間欠的に落ちた）。`verify-phase1.mjs` の `--session-write` と同じ作法。
  // 待ちはデバウンス 2 段の合計から導く（`scripts/lib/timings.mjs`）
  await sleep(afterSessionSave())
  /*
   * **書いたものを読み返す**。「復元されない」が起きたとき、
   * 書けていないのか読めていないのかをここで切り分けられるようにする。
   */
  const sessionPath = path.join(process.env.NEMO_USER_DATA_DIR ?? '.', 'session.json')
  const saved = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, 'utf8')) : null
  const savedSplits = (saved?.data?.windows ?? []).flatMap((w) => w.splits ?? [])
  check(
    '再起動前: session.json に分割が 2 組書かれている',
    savedSplits.length === 2,
    `windows=${saved?.data?.windows?.length ?? 'なし'} splits=${JSON.stringify(savedSplits)}`
  )
  /*
   * **保存された `lastActiveAt` を控える**。復元で通常の `splitTabs` を呼ぶと
   * 全ペアが materialize され、`lastActiveAt` も現在時刻に上書きされる。
   * 読み出し側で突き合わせないと、「関係構築だけの関数を使う」理由が守られているか分からない。
   */
  // 版 5 から野良タブの正は共有定義ストア。`lastActiveAt` は定義側が持つ
  // （session.json は URL を持たない）。セッション保存が実体の値を定義へ写した後の
  // メモリ値を控える（ディスクは JsonStore のデバウンス中でずれうる）
  const savedTimes = Object.fromEntries(
    JSON.parse(
      await ui.ev(
        "window.nemo.getSharedState().then(s => JSON.stringify((s.ephemeralTabs ?? []).map(d => [d.url, d.lastActiveAt])))"
      )
    ).filter(([url]) => url.includes('blank.html?restart-'))
  )
  check(
    '再起動前: 4 本ぶんの lastActiveAt を控えられた',
    Object.keys(savedTimes).length === 4,
    JSON.stringify(Object.keys(savedTimes).length)
  )
  fs.writeFileSync(MARKER_PATH, `${JSON.stringify({ savedTimes }, null, 2)}\n`)
  console.log(failures === 0 ? '\n分割: 再起動前の書き込み OK' : `\n分割: FAIL ${failures} 件`)
  process.exit(failures === 0 ? 0 : 1)
}

if (MODE === 'restart-read') {
  /*
   * **復元先のウィンドウは 1 つとは限らない**（Peek / 会議の検証が別ウィンドウを開く）。
   * 先頭のサイドバーだけ見ると、分割を作ったのとは別のウィンドウを読んで
   * 「復元されていない」と誤判定する（フル検証でだけ落ちる形）。
   */
  const sidebars = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  const windows = []
  for (const target of sidebars) {
    const session = await connectTo(CDP, new URL(target.url).search.slice(1))
    windows.push({
      session,
      state: await session.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    })
  }
  const owner = windows.find((w) => w.state.tabs.some((tab) => tab.splitSide !== null)) ?? windows[0]
  for (const w of windows) if (w !== owner) w.session.close()
  console.log(
    `（復元されたウィンドウ ${windows.length} 枚 / タブ ${windows.map((w) => w.state.tabs.length).join('+')}）`
  )
  const s = owner.state
  const lefts = s.tabs.filter((tab) => tab.splitSide === 'left')
  check('再起動後: 分割が 2 組とも復元されている', lefts.length === 2, `pairs=${lefts.length}`)
  for (const left of lefts) {
    const right = tabOf(s, left.splitPartnerKey)
    check(
      `再起動後: 左右の順序が保たれている（${left.url.split('?')[1] ?? ''}）`,
      right !== null && right.splitSide === 'right' && s.tabs.indexOf(right) === s.tabs.indexOf(left) + 1,
      right ? `right=${right.splitSide} 隣接=${s.tabs.indexOf(right) === s.tabs.indexOf(left) + 1}` : 'なし'
    )
  }
  /*
   * **復元が全ペアを materialize していないこと**。
   *
   * ここに来るまでに phase1 / pins の読み出しが走ってアクティブタブを動かしているので、
   * 「いま見えている組」では判定できない。**寝ている組がちょうど 1 組あること**で見る
   * （復元で通常の `splitTabs` を呼ぶと全ペアが起きるので、この検査が落ちる）。
   */
  const asleepPairs = lefts.filter((left) => {
    const right = tabOf(s, left.splitPartnerKey)
    return left.asleep && right?.asleep === true
  })
  check(
    '再起動後: 触っていない組は 2 本とも asleep のまま（全ペアを起こしていない）',
    asleepPairs.length === 1,
    lefts.map((left) => `${left.url.split('?')[1]}=${left.asleep ? 'asleep' : 'awake'}`).join(' ')
  )

  /*
   * **非アクティブな組の `lastActiveAt` が保存値から動いていないこと**。
   * `asleep` だけ見ても、復元で通常の `splitTabs` を通して時刻を現在時刻に
   * 上書きしていれば「寝ているのに MRU の順だけ壊れている」状態を見逃す。
   */
  const savedTimes = fs.existsSync(MARKER_PATH)
    ? (JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8')).savedTimes ?? {})
    : {}
  const asleepLeft = asleepPairs[0] ?? null
  const asleepRight = asleepLeft ? tabOf(s, asleepLeft.splitPartnerKey) : null
  const compared = [asleepLeft, asleepRight]
    .filter((tab) => tab !== null)
    .map((tab) => ({ url: tab.url, now: tab.lastActiveAt, saved: savedTimes[tab.url] ?? null }))
  check(
    '再起動後: 非アクティブな組の lastActiveAt が保存値のまま',
    compared.length === 2 && compared.every((row) => row.saved !== null && row.now === row.saved),
    JSON.stringify(compared)
  )
  fs.rmSync(MARKER_PATH, { force: true })

  // **寝ている組を選ぶと 2 枚とも起きて見える**
  // （`splitSide` だけ見ると、片側が空でも「復元成功」になってしまう）
  const target = asleepPairs[0] ?? lefts[0]
  if (target) {
    await owner.session.ev(`window.nemo.selectTab(${JSON.stringify(target.key)}).then(() => 'ok')`)
    const visible = JSON.parse(
      await owner.session.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
    )
    check('再起動後: 組を選ぶと 2 枚とも見える', visible.length === 2, `visible=${visible.length}`)
    const after = await owner.session
      .ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))')
      .then(JSON.parse)
    for (const key of visible) {
      const tab = tabOf(after, key)
      if (!tab) continue
      const info = await pageInfo(tab.url)
      check(
        `再起動後: ${tab.url.split('?')[1] ?? ''} が実体化して幅を持つ`,
        info.w > 0 && info.href.startsWith('http'),
        `w=${info.w}`
      )
    }
  }
  console.log(failures === 0 ? '\n分割: 再起動後の読み出し OK' : `\n分割: FAIL ${failures} 件`)
  process.exit(failures === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ *
 * 本編
 * ------------------------------------------------------------------ */

await resetTabs()

/* ---- 生成と当たり判定 ---- */
{
  const [a, b, c] = await makeTabs(3, 'make')

  // 上端に落としても受け付けない（中央帯だけで反応する）
  const top = JSON.parse(await ui.ev(dragScript(b, c, 'top')))
  check('当たり判定: 行の上端では受け付けない', top.ok && !top.accepted && !top.dropping, JSON.stringify(top))

  // 中央に落とすと分割になる
  const mid = JSON.parse(await ui.ev(dragScript(b, c, 'middle')))
  check('当たり判定: 行の中央では受け付ける', mid.ok && mid.accepted, JSON.stringify(mid))

  await waitFor(ui, "window.nemo.getWindowState().then((s) => s.tabs.some((t) => t.splitSide) ? 'ok' : '')")
  const s = await state()
  const left = tabOf(s, b)
  const right = tabOf(s, c)
  check(
    '左右: ドロップ先が左・ドラッグ元が右',
    left?.splitSide === 'left' && right?.splitSide === 'right',
    `left=${left?.splitSide} right=${right?.splitSide}`
  )
  check(
    '作った直後は右にフォーカス',
    s.activeTabKey === c,
    `active=${s.activeTabKey === c ? 'right' : s.activeTabKey}`
  )

  const visible = await visibleKeys()
  check('分割中は 2 枚が見えている', visible.length === 2, `visible=${visible.length}`)

  // 結合行が 1 件出て、**分割に入った 2 本は通常行から消える**こと。
  // 前の検証が残したタブがあるので、通常行の数は状態から出す（固定値で書かない）。
  // 一時タブの一覧は**全ウィンドウ共有の定義**から描かれるので、期待値も共有一覧から出す:
  // 「共有定義のうち、このウィンドウで分割に入っていないもの」+「ローカルタブ（定義なし）」
  const splitDefIds = new Set(
    s.tabs.filter((tab) => tab.splitSide !== null).flatMap((tab) => (tab.ephemeralId ? [tab.ephemeralId] : []))
  )
  const sharedDefIds = JSON.parse(
    await ui.ev(
      "window.nemo.getSharedState().then(s => JSON.stringify((s.ephemeralTabs ?? []).map(d => d.id)))"
    )
  )
  const localRows = s.tabs.filter(
    (tab) =>
      tab.pinnedId === null &&
      tab.favoriteId === null &&
      tab.ephemeralId === null &&
      tab.peekParentKey === null &&
      tab.splitSide === null
  ).length
  const expectedRows = sharedDefIds.filter((id) => !splitDefIds.has(id)).length + localRows
  const rows = JSON.parse(
    await ui.ev(
      "JSON.stringify({ split: document.querySelectorAll('.split-row').length," +
        " rows: document.querySelectorAll('.scroll > .row:not(.new-tab)').length })"
    )
  )
  check(
    'サイドバー: 結合行 1 件・分割の 2 本は通常行から消える',
    rows.split === 1 && rows.rows === expectedRows,
    `split=${rows.split} rows=${rows.rows} 期待=${expectedRows}`
  )

  /* ---- ペインの実寸 ---- */
  const d = await diag()
  const [pl, pr] = d.panes
  check(
    'ペイン: 左右の幅が等しい',
    Math.abs(pl.outer.width - pr.outer.width) <= 2,
    `${pl.outer.width} / ${pr.outer.width}`
  )
  check(
    'ペイン: 隔間が 8px',
    pr.outer.x - (pl.outer.x + pl.outer.width) === 8,
    `${pr.outer.x - (pl.outer.x + pl.outer.width)}`
  )
  check(
    'ペイン: 外周の余白が 8px',
    pl.outer.x - d.area.x === 8 && pl.outer.y - d.area.y === 8,
    `left=${pl.outer.x - d.area.x} top=${pl.outer.y - d.area.y}`
  )
  check(
    'ペイン: 右端の余白が 8px',
    d.area.x + d.area.width - (pr.outer.x + pr.outer.width) === 8,
    `${d.area.x + d.area.width - (pr.outer.x + pr.outer.width)}`
  )
  check(
    'ペイン: ツールバーとページの幅が外枠と一致する',
    pl.toolbar.width === pl.outer.width &&
      pl.page.width === pl.outer.width &&
      pr.toolbar.width === pr.outer.width &&
      pr.page.width === pr.outer.width,
    `${pl.toolbar.width}/${pl.page.width}/${pr.toolbar.width}/${pr.page.width} vs ${pl.outer.width}/${pr.outer.width}`
  )
  const ring = d.focusRing
  const focused = d.panes.find((pane) => pane.tabKey === c)
  check(
    'フォーカス枠: 該当ペインの外枠を 2px 上回る',
    ring !== null &&
      focused !== undefined &&
      ring.x === focused.outer.x - 2 &&
      ring.y === focused.outer.y - 2 &&
      ring.width === focused.outer.width + 4 &&
      ring.height === focused.outer.height + 4,
    JSON.stringify({ ring, outer: focused?.outer })
  )

  await shoot('right-focus', d.mediaSourceId)

  /* ---- フォーカスの移動 ---- */
  // ペインのページをクリック（`input-event` の mouseDown で拾う）
  const leftPage = await connectTo(CDP, tabOf(s, b).url, { type: 'page' })
  await leftPage.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: 30,
    y: 30,
    button: 'left',
    clickCount: 1
  })
  await leftPage.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 30,
    y: 30,
    button: 'left',
    clickCount: 1
  })
  leftPage.close()
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) => s.activeTabKey === ${JSON.stringify(b)} ? 'ok' : '')`
  )
  const afterClick = await visibleKeys()
  check(
    'ページのクリックでフォーカスが移る（2 枚のまま）',
    afterClick.length === 2,
    `visible=${afterClick.length}`
  )
  await shoot('left-focus', (await diag()).mediaSourceId)

  /* ---- ツールバー経由のフォーカス移動 ---- */
  // 右にフォーカスがある状態で**左の**ツールバーのリロードを押す
  await call(`window.nemo.selectTab(${JSON.stringify(c)})`)
  const leftToolbar = await toolbarOf('left')
  await leftToolbar.ev("[...document.querySelectorAll('.toolbar .nav')].at(-1)?.click(); 'ok'")
  const movedByReload = await became(
    ui,
    `window.nemo.getWindowState().then((s) => s.activeTabKey === ${JSON.stringify(b)} ? 'ok' : '')`
  )
  check(
    'ツールバーのリロードでそのペインにフォーカスが移る',
    movedByReload,
    `active=${(await state()).activeTabKey === c ? 'right のまま' : (await state()).activeTabKey}`
  )

  // 逆向きも見る（右のツールバーを押すと右へ移る）
  const rightToolbar = await toolbarOf('right')
  const rightAddr = await rightToolbar.ev(
    'JSON.stringify({ href: location.href, view: document.body.dataset.view,' +
      ' pane: document.body.dataset.pane,' +
      " addr: document.querySelector('.toolbar .addr')?.title ?? null," +
      " nav: document.querySelectorAll('.toolbar .nav').length })"
  )
  check(
    '右ペインのツールバーが右タブを担当している',
    JSON.parse(rightAddr).addr === tabOf(await state(), c)?.url,
    rightAddr
  )
  await rightToolbar.ev("[...document.querySelectorAll('.toolbar .nav')].at(-1)?.click(); 'ok'")
  await sleep(400)
  check(
    '右のツールバーでも同じようにフォーカスが移る',
    (await state()).activeTabKey === c,
    `active=${(await state()).activeTabKey === b ? 'left' : 'other'}`
  )
  // 右ペインには拡張・ダウンロード・履歴・＋・サイドバー開閉を置かない
  // （戻る / 進む / リロードは `.icon.nav` なので除いて数える）
  const rightIcons = await rightToolbar.ev("document.querySelectorAll('.toolbar .icon:not(.nav)').length")
  check('右ペインのツールバーは最小構成（✕ だけ）', rightIcons === 1, `icons=${rightIcons}`)
  const rightExt = await rightToolbar.ev("document.querySelectorAll('browser-action-list').length")
  check('右ペインに拡張アイコンを出さない', rightExt === 0, `browser-action-list=${rightExt}`)
  rightToolbar.close()

  // **アドレスバーもペイン固有**（触った側にフォーカスが移る）。
  // ここが抜けると「左のアドレスバーを触ったのに ⌘F・拡張の対象は右のまま」になる。
  await call(`window.nemo.selectTab(${JSON.stringify(c)})`) // 右にフォーカス
  await leftToolbar.ev("document.querySelector('.toolbar .addr')?.click(); 'ok'")
  const movedByAddr = await became(
    ui,
    `window.nemo.getWindowState().then((s) => (s.activeTabKey === ${JSON.stringify(b)} ? 'ok' : ''))`
  )
  check(
    '左のアドレスバーを触ると左ペインにフォーカスが移る',
    movedByAddr,
    `active=${(await state()).activeTabKey === c ? 'right のまま' : (await state()).activeTabKey}`
  )
  // 編集モードを畳む（開いたままだと以降のアイコン取得が入力欄に化ける）
  await leftToolbar.ev(
    "document.querySelector('.toolbar .addr.editing input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'"
  )
  await leftToolbar.ev('document.activeElement?.blur?.(); 1')
  await waitFor(leftToolbar, "document.querySelector('.toolbar button.addr') ? 'ok' : ''")

  /*
   * **ウィンドウ共通の操作ではフォーカスが動かない**。
   * `focusPane()` を通しているかどうかの切り分けなので、**左のツールバーに出ている
   * 共通ボタンを 1 つずつ**撃つ（履歴だけだと他の配線ミスを見逃す）。
   */
  await call(`window.nemo.selectTab(${JSON.stringify(c)})`) // 右にフォーカスして始める
  for (const [label, titlePrefix] of [
    ['ダウンロード', 'ダウンロード'],
    ['履歴', '履歴'],
    ['＋（新規タブ）', '新規タブ'],
    ['サイドバー開閉', 'サイドバーを']
  ]) {
    const before = (await state()).activeTabKey
    const clicked = await leftToolbar.ev(
      `(() => {
         const el = [...document.querySelectorAll('.toolbar .icon:not(.nav)')]
           .find((node) => node.title.startsWith(${JSON.stringify(titlePrefix)}))
         if (!el) return 'not-found'
         el.click()
         return 'ok'
       })()`
    )
    await sleep(350)
    await call('window.nemo.setOverlay(null)')
    const after = (await state()).activeTabKey
    check(
      `ウィンドウ共通の操作（${label}）ではフォーカスが動かない`,
      clicked === 'ok' && after === before,
      `clicked=${clicked} before=${before === c ? 'right' : before} after=${after === c ? 'right' : after}`
    )
    // サイドバーは開閉したので必ず戻す（戻さないと以降の DOM 取得ごと消える）
    if (titlePrefix === 'サイドバーを') {
      await leftToolbar.ev(
        "[...document.querySelectorAll('.toolbar .icon:not(.nav)')].find((n) => n.title.startsWith('サイドバーを'))?.click(); 'ok'"
      )
      await sleep(350)
    }
  }
  // 拡張（`<browser-action-list>`）はこのアプリに拡張が載っていないので押せない
  skip(
    'ウィンドウ共通の操作（拡張）ではフォーカスが動かない',
    'この検証のアプリには拡張がロードされていない（押せるボタンが 1 つも無い）。分割中の拡張は verify:ext 側で見る'
  )
  leftToolbar.close()

  /* ---- 別タブへ行って戻る ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  check('別タブを選ぶと分割は隠れる', (await visibleKeys()).length === 1)
  const stillSplit = await state()
  check('別タブを選んでも分割は保たれる', tabOf(stillSplit, b)?.splitSide === 'left')
  await call(`window.nemo.selectTab(${JSON.stringify(b)})`)
  check('戻ると 2 枚に復帰する', (await visibleKeys()).length === 2)

  /* ---- 後始末（器とフォーカス枠を隠す） ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  check('別タブを選んだらフォーカス枠は隠れる', (await diag()).focusRingVisible === false)

  /* ---- オーバーレイの位置 ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(b)})`)
  await call("window.nemo.setOverlay('find')")
  const withFind = await diag()
  const pane = withFind.panes.find((p) => p.tabKey === b)
  check(
    '分割中の検索バーはペインのページ上端 + 12px',
    withFind.overlay !== null && pane !== undefined && withFind.overlay.y === pane.page.y + 12,
    JSON.stringify({ overlay: withFind.overlay?.y, pageTop: pane?.page.y })
  )
  await call('window.nemo.setOverlay(null)')

  /* ---- 3 つ目のドロップ ---- */
  const third = JSON.parse(await ui.ev(dragScript(b, a, 'middle')))
  check(
    '3 つ目のドロップは受け付けない',
    third.ok && !third.accepted && !third.dropping,
    JSON.stringify(third)
  )
  check('3 つ目を落としても相方は変わらない', tabOf(await state(), b)?.splitPartnerKey === c)

  /* ---- main 側の拒否 ---- */
  await ui.ev(`window.nemo.splitTabs(${JSON.stringify(a)}, ${JSON.stringify(b)}).then(() => 'ok')`)
  check('main: すでに分割に入っているタブは拒否される', tabOf(await state(), a)?.splitSide === null)

  /* ---- ⌘数字 / ⌃Tab ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  await runCommand('next-tab')
  const afterNext = await state()
  check('⌃Tab でペインへ移れる', afterNext.activeTabKey !== a, `active=${afterNext.activeTabKey}`)

  /* ---- ⌃M の順（MRU） ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(c)})`) // 右にフォーカス
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`) // 別タブへ
  await call('window.nemo.switchTab()')
  await sleep(150)
  const switcher = JSON.parse(
    await ui.ev('window.nemo.getOverlayState().then((s) => JSON.stringify(s.switcher))')
  )
  const picked = switcher?.tabs?.[switcher.index]?.key ?? null
  await call('window.nemo.cancelSwitcher()')
  check('⌃M は直前にフォーカスしていた「右」を指す', picked === c, `picked=${picked === b ? 'left' : picked}`)

  /* ---- ⌘W（ペアの後ろに別タブがある状態で右を閉じる） ---- */
  await call(`window.nemo.selectTab(${JSON.stringify(c)})`)
  await runCommand('close-tab')
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) => s.tabs.every((t) => t.key !== ${JSON.stringify(c)}) ? 'ok' : '')`
  )
  const afterClose = await state()
  check(
    '⌘W: 右を閉じると「左」が選ばれる（後続タブではない）',
    afterClose.activeTabKey === b,
    `active=${afterClose.activeTabKey === a ? '後続タブ' : afterClose.activeTabKey}`
  )
  check(
    '⌘W: 分割が解けて全画面になる',
    tabOf(afterClose, b)?.splitSide === null && (await visibleKeys()).length === 1
  )
  check('⌘W: 結合行が消えている', (await ui.ev("document.querySelectorAll('.split-row').length")) === 0)

  /*
   * **左を閉じる経路も撃つ**。ペアを解くときに `tab.split` を消しながら読むと、
   * 自分が左のときだけ null 参照で落ちる（右を閉じる検査だけでは素通りする。
   * 実際に `verify:ext` が先に踏んだ）。
   */
  const [x, y] = await makeTabs(2, 'closeleft')
  await ui.ev(dragScript(x, y, 'middle'))
  await waitFor(ui, "window.nemo.getWindowState().then((s) => s.tabs.some((t) => t.splitSide) ? 'ok' : '')")
  await call(`window.nemo.closeTab(${JSON.stringify(x)})`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) => s.tabs.every((t) => t.key !== ${JSON.stringify(x)}) ? 'ok' : '')`
  )
  const afterLeft = await state()
  check(
    '左のペインを閉じても落ちない（相方が残って分割が解ける）',
    tabOf(afterLeft, y) !== null && tabOf(afterLeft, y)?.splitSide === null,
    `right=${tabOf(afterLeft, y) === null ? '消えた' : tabOf(afterLeft, y)?.splitSide}`
  )
  check(
    '左を閉じると残った右が選ばれる',
    afterLeft.activeTabKey === y,
    `active=${afterLeft.activeTabKey === y ? 'right' : afterLeft.activeTabKey}`
  )
  await shoot('separated', (await diag()).mediaSourceId)
}

/* ---- 解除の並び ---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'sep')
  await makeSplit(a, b)

  /*
   * **解除は結合行の右クリックメニューから撃つ**（実際の導線と同じ経路）。
   * `separateSplit` の IPC を直接叩くと、メニュー項目の配線が外れていても通る。
   */
  const menuResult = await ui.ev(
    `(() => {
       const chip = document.querySelector('.split-row .chip[data-key=' + ${JSON.stringify(JSON.stringify(a))} + ']')
       if (!chip) return 'no-chip'
       chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 120 }))
       return 'ok'
     })()`
  )
  await waitFor(ui, "document.querySelector('.row-menu') ? 'ok' : ''")
  const items = JSON.parse(
    await ui.ev(
      "JSON.stringify([...document.querySelectorAll('.row-menu [role=menuitem]')].map((e) => e.innerText))"
    )
  )
  check(
    '解除: 結合行の右クリックメニューに「分割を解除」が出る',
    menuResult === 'ok' && items.includes('分割を解除'),
    JSON.stringify(items)
  )
  await ui.ev(
    "[...document.querySelectorAll('.row-menu [role=menuitem]')].find((e) => e.innerText === '分割を解除')?.click(); 'ok'"
  )
  await waitFor(
    ui,
    "window.nemo.getWindowState().then((s) => s.tabs.every((t) => t.splitSide === null) ? 'ok' : '')"
  )
  const s = await state()
  const order = s.tabs.filter((t) => t.pinnedId === null && t.favoriteId === null).map((t) => t.key)
  check(
    '解除: 左だったタブが上・右だったタブが下',
    order.indexOf(a) >= 0 && order.indexOf(b) === order.indexOf(a) + 1,
    `order=${order.map((k) => (k === a ? 'L' : k === b ? 'R' : '.')).join('')}`
  )
  check('解除: 見えるのは 1 枚だけ', (await visibleKeys()).length === 1)

  // **解除した直後の後始末**（別タブを選んだときとは別の経路）。
  // 隠し忘れると、背景色を持つ空の器や古い枠がページの上に残ってクリックを遮る。
  const afterSeparate = await diag()
  check(
    '解除: 直後にフォーカス枠が隠れている',
    afterSeparate.focusRingVisible === false,
    `focusRingVisible=${afterSeparate.focusRingVisible}`
  )
  check(
    '解除: 直後にペインの矩形が 1 つも残っていない',
    afterSeparate.panes.length === 0,
    `panes=${afterSeparate.panes.length}`
  )
}

/* ---- ピン留めで解ける ---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'pin')
  await ui.ev(dragScript(a, b, 'middle'))
  await waitFor(ui, "window.nemo.getWindowState().then((s) => s.tabs.some((t) => t.splitSide) ? 'ok' : '')")
  await call(`window.nemo.pinTab(${JSON.stringify(a)})`)
  await sleep(200)
  const s = await state()
  check(
    'ピン留めすると分割が解ける',
    s.tabs.every((tab) => tab.splitSide === null)
  )
  check('ピン留めすると結合行が消える', (await ui.ev("document.querySelectorAll('.split-row').length")) === 0)
  const pinned = s.tabs.find((tab) => tab.key === a)
  check('ピン留めが成立している', pinned?.pinnedId !== null && pinned?.pinnedId !== undefined)
  if (pinned?.pinnedId) await call(`window.nemo.unpin(${JSON.stringify(pinned.pinnedId)})`)
}

/* ---- main 側の拒否（ピン留め・Favorites）---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'reject')
  await call(`window.nemo.pinTab(${JSON.stringify(a)})`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.find((t) => t.key === ${JSON.stringify(a)})?.pinnedId ? 'ok' : '')`
  )
  // **renderer の受け皿を迂回して IPC を直接叩く**
  await call(`window.nemo.splitTabs(${JSON.stringify(a)}, ${JSON.stringify(b)})`)
  await sleep(300)
  check(
    'main: ピン留めのタブは分割に入れない',
    (await state()).tabs.every((tab) => tab.splitSide === null),
    JSON.stringify((await state()).tabs.map((tab) => [tab.pinnedId !== null, tab.splitSide]))
  )
  const pinnedId = tabOf(await state(), a)?.pinnedId
  if (pinnedId) await call(`window.nemo.unpin(${JSON.stringify(pinnedId)})`)

  await call(`window.nemo.addFavorite(${JSON.stringify(b)})`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.find((t) => t.key === ${JSON.stringify(b)})?.favoriteId ? 'ok' : '')`
  )
  const c = await openTab(`${PAGES}/blank.html?reject-fav`)
  await call(`window.nemo.splitTabs(${JSON.stringify(b)}, ${JSON.stringify(c)})`)
  await sleep(300)
  check(
    'main: Favorites のタブは分割に入れない',
    (await state()).tabs.every((tab) => tab.splitSide === null),
    JSON.stringify((await state()).tabs.map((tab) => [tab.favoriteId !== null, tab.splitSide]))
  )
  const favoriteId = tabOf(await state(), b)?.favoriteId
  if (favoriteId) await call(`window.nemo.removeFavorite(${JSON.stringify(favoriteId)})`)
}

/* ---- 寝ていた相方が起きる ---- */
{
  await resetTabs()
  const settings = JSON.parse(await ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))'))
  try {
    const [a, b, control] = await makeTabs(3, 'wake')
    await makeSplit(a, b)
    const leftUrl = tabOf(await state(), a)?.url
    const rightUrl = tabOf(await state(), b)?.url

    // ペアを隠してから寝かせる（見えている間は寝ない ＝ 別の検査で担保済み）
    await call(`window.nemo.selectTab(${JSON.stringify(control)})`)
    await updateSetting({ tabSleepMinutes: 0.05 })
    await waitFor(
      ui,
      `window.nemo.getWindowState().then((s) =>
         s.tabs.filter((t) => [${JSON.stringify(a)}, ${JSON.stringify(b)}].includes(t.key))
           .every((t) => t.asleep) ? 'ok' : '')`,
      { timeoutMs: 20000 }
    )
    // **前提が成立していること**を実測で出す（寝ていなければこの検査は空振りする）
    const asleepState = await state()
    check(
      'sleep 明け: 前提（ペアの 2 本とも寝ている）が成立している',
      tabOf(asleepState, a)?.asleep === true && tabOf(asleepState, b)?.asleep === true,
      `left=${tabOf(asleepState, a)?.asleep} right=${tabOf(asleepState, b)?.asleep}`
    )
    await updateSetting({ tabSleepMinutes: 0 })

    // **サイドバーの結合行のチップ**から戻る（実際の導線と同じ経路を通す）
    const clicked = await ui.ev(
      `(() => {
         const chip = document.querySelector('.split-row .chip[data-key=' + ${JSON.stringify(JSON.stringify(a))} + ']')
         if (!chip) return 'no-chip'
         chip.click()
         return 'ok'
       })()`
    )
    check('sleep 明け: 結合行のチップから戻れる', clicked === 'ok', String(clicked))
    await waitFor(
      ui,
      `window.nemo.getWindowState().then((s) =>
         s.tabs.filter((t) => [${JSON.stringify(a)}, ${JSON.stringify(b)}].includes(t.key))
           .every((t) => !t.asleep) ? 'ok' : '')`,
      { timeoutMs: 20000 }
    )
    check('sleep 明け: 2 枚とも見えている', (await visibleKeys()).length === 2)

    // **中身が描かれていること**を各ページから読む（`asleep` が false でも
    // View が付いていなければ左ペインは真っ白になる）
    const li = await pageInfo(leftUrl)
    const ri = await pageInfo(rightUrl)
    const d = await diag()
    const pl = d.panes.find((pane) => pane.tabKey === a)
    const pr = d.panes.find((pane) => pane.tabKey === b)
    check(
      'sleep 明け: 左ペインの中身が描かれている（href と実測幅が取れる）',
      li.href.includes('wake-0') && Math.abs(li.w - (pl?.page.width ?? 0)) <= 2,
      `${li.href} w=${li.w} vs ${pl?.page.width}`
    )
    check(
      'sleep 明け: 右ペインの中身が描かれている（href と実測幅が取れる）',
      ri.href.includes('wake-1') && Math.abs(ri.w - (pr?.page.width ?? 0)) <= 2,
      `${ri.href} w=${ri.w} vs ${pr?.page.width}`
    )

    // **起き直した WebContents にフォーカス購読が張り直されているか**。
    // 張り直しに失敗すると、見た目は正常なのに
    // **そのペインをクリックしてもフォーカスが移らない**（bounds では見えない壊れ方）。
    // 起こしたのは左チップなので、いま活性なのは左。右を叩いて移ることを見る。
    //
    // **`sleep()` の `paneFocusOff` の後始末はこの検査では撃てない**。
    // 寝る前に必ず非表示化を通り、そこで `syncPaneFocusWatchers` が購読を外すため、
    // 後始末を消してもこの経路は PASS する（実測済み）。あちらは将来の保険。
    const wakePage = await connectTo(CDP, rightUrl, { type: 'page' })
    for (const type of ['mousePressed', 'mouseReleased']) {
      await wakePage.send('Input.dispatchMouseEvent', {
        type,
        x: 30,
        y: 30,
        button: 'left',
        clickCount: 1
      })
    }
    wakePage.close()
    await sleep(600)
    check(
      'sleep 明け: 起きたペインのクリックでフォーカスが移る',
      (await state()).activeTabKey === b,
      `active=${(await state()).activeTabKey === b ? 'right' : 'left'}`
    )
  } finally {
    await updateSetting({ tabSleepMinutes: settings.tabSleepMinutes })
  }
}

/* ---- Peek（ペインの中に収まる / ⌘W と ✕ の違い）---- */
{
  await resetTabs()
  const a = await openTab(`${PAGES}/peek.html?site=split-left`)
  const b = await openTab(`${PAGES}/peek.html?site=split-right`)
  await makeSplit(a, b)

  // 左ペインにフォーカスを移してから、そのページで target=_blank を開く
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  const leftPage = await connectTo(CDP, `${PAGES}/peek.html?site=split-left`, { type: 'page' })
  await waitFor(leftPage, "document.readyState === 'complete' ? 'ok' : ''")
  await evUser(leftPage, "document.querySelector('#open-blank').click()")
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.some((t) => t.peekParentKey === ${JSON.stringify(a)}) ? 'ok' : '')`,
    { timeoutMs: 15000 }
  )
  await settleLayout()

  const withPeek = await diag()
  const leftPane = withPeek.panes.find((pane) => pane.tabKey === a)
  check(
    'Peek: 本体が左ペインのページの内側に収まる',
    inside(withPeek.peek, leftPane?.page),
    JSON.stringify({ peek: withPeek.peek, page: leftPane?.page })
  )
  check(
    'Peek: 暗幕も左ペインのページの内側に収まる',
    inside(withPeek.peekScrim, leftPane?.page),
    JSON.stringify({ scrim: withPeek.peekScrim, page: leftPane?.page })
  )
  check(
    'Peek: 分割中は 3 枚（左 + 右 + フォーカス中の Peek）が見えている',
    (await visibleKeys()).length === 3,
    `visible=${(await visibleKeys()).length}`
  )

  // 右へフォーカスを移すと**左の Peek は隠れる**（相方の Peek は出さない）
  await call(`window.nemo.selectTab(${JSON.stringify(b)})`)
  await settleLayout()
  check(
    'Peek: フォーカスを移すと相方の Peek は隠れる（2 枚に戻る）',
    (await visibleKeys()).length === 2,
    `visible=${(await visibleKeys()).length}`
  )
  check('Peek: 隠れている間は診断にも出ない', (await diag()).peek === null)

  // 右でも Peek を開くと、そちらのペインに収まる
  const rightPage = await connectTo(CDP, `${PAGES}/peek.html?site=split-right`, { type: 'page' })
  await waitFor(rightPage, "document.readyState === 'complete' ? 'ok' : ''")
  await evUser(rightPage, "document.querySelector('#open-blank').click()")
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.some((t) => t.peekParentKey === ${JSON.stringify(b)}) ? 'ok' : '')`,
    { timeoutMs: 15000 }
  )
  await settleLayout()
  const rightDiag = await diag()
  const rightPane = rightDiag.panes.find((pane) => pane.tabKey === b)
  check(
    'Peek: 右で開いた Peek は右ペインのページの内側に収まる',
    inside(rightDiag.peek, rightPane?.page),
    JSON.stringify({ peek: rightDiag.peek, page: rightPane?.page })
  )

  /*
   * **⌘W と ✕ の違い**。⌘W は「Peek が出ていれば Peek だけ閉じる」という
   * 既存の規則を持つ（`menu.ts`）。✕ は担当ペインのタブを閉じる。
   * 実装が両者を同じ経路に再統合すると、どちらかが崩れる。
   */
  await runCommand('close-tab')
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.every((t) => t.peekParentKey !== ${JSON.stringify(b)}) ? 'ok' : '')`
  )
  const afterPeekClose = await state()
  check(
    '⌘W: Peek が出ていれば Peek だけ閉じてペアは残る',
    tabOf(afterPeekClose, b)?.splitSide === 'right' && tabOf(afterPeekClose, a)?.splitSide === 'left',
    `left=${tabOf(afterPeekClose, a)?.splitSide} right=${tabOf(afterPeekClose, b)?.splitSide}`
  )

  // もう一度 Peek を出し、今度は**そのペインの ✕**で閉じる
  await evUser(rightPage, "document.querySelector('#open-blank').click()")
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.some((t) => t.peekParentKey === ${JSON.stringify(b)}) ? 'ok' : '')`,
    { timeoutMs: 15000 }
  )
  const rightToolbar = await toolbarOf('right')
  await rightToolbar.ev("[...document.querySelectorAll('.toolbar .icon:not(.nav)')].at(-1)?.click(); 'ok'")
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.every((t) => t.key !== ${JSON.stringify(b)}) ? 'ok' : '')`
  )
  rightToolbar.close()
  const afterX = await state()
  check(
    '✕: 担当タブと Peek がまとめて閉じる',
    tabOf(afterX, b) === null && afterX.tabs.every((tab) => tab.peekParentKey !== b),
    `tab=${tabOf(afterX, b) === null ? 'なし' : '残っている'}`
  )
  /*
   * **「見えているのが 1 枚」では判定しない**。この時点で左タブは自分の Peek を
   * まだ持っている（右へフォーカスを移したときに隠れただけで、閉じてはいない）ので、
   * 左へ戻れば「左 + 左の Peek」で 2 枚になるのが正しい。
   * 見るべきは「**見えている通常タブが左だけ**」であること。
   */
  const visibleAfterX = await visibleKeys()
  const strayNormal = visibleAfterX.filter((key) => key !== a && tabOf(afterX, key)?.peekParentKey === null)
  check(
    '✕: 相方が全画面になる（見えている通常タブは左だけ）',
    tabOf(afterX, a)?.splitSide === null && afterX.activeTabKey === a && strayNormal.length === 0,
    `left=${tabOf(afterX, a)?.splitSide} active=${afterX.activeTabKey === a} visible=${JSON.stringify(
      visibleAfterX.map((key) =>
        key === a ? 'left' : tabOf(afterX, key)?.peekParentKey === a ? 'left-peek' : key
      )
    )}`
  )

  leftPage.close()
  rightPage.close()
}

/* ---- ✕ は「押した側のペイン」を閉じる（フォーカスしている側ではない）---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'closex')
  await makeSplit(a, b)
  // **右にフォーカスしたまま左の ✕ を押す**。`focusPane()` を通さないと
  // 「押したのは左なのに、閉じる対象・⌘W・拡張の対象は右のまま」になる。
  await call(`window.nemo.selectTab(${JSON.stringify(b)})`)
  const leftToolbar = await toolbarOf('left')
  await leftToolbar.ev("[...document.querySelectorAll('.toolbar .icon:not(.nav)')].at(-1)?.click(); 'ok'")
  const closedLeft = await became(
    ui,
    `window.nemo.getWindowState().then((s) => (s.tabs.every((t) => t.key !== ${JSON.stringify(a)}) ? 'ok' : ''))`
  )
  leftToolbar.close()
  const after = await state()
  check(
    '✕: フォーカスしていない側の ✕ でも、閉じるのはそのペインのタブ',
    closedLeft && tabOf(after, b) !== null,
    `left=${closedLeft ? '閉じた' : '残っている'} right=${tabOf(after, b) !== null ? '残っている' : '消えた'}`
  )
  check(
    '✕: 残った相方が全画面になる',
    tabOf(after, b)?.splitSide === null && after.activeTabKey === b,
    `side=${tabOf(after, b)?.splitSide} active=${after.activeTabKey === b}`
  )
}

/* ---- ⌃Tab は「2 つのタブのまま」数える ---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'nav')
  await makeSplit(a, b)

  // ⌃Tab / セッション保存はサイドバーの並び（Peek を除いた `normalTabs`）に対応する。
  // （⌘1〜9 は Favorites 用に付け替えたので、ここでは並びだけ見る）
  const s = await state()
  const order = s.tabs.filter((tab) => tab.peekParentKey === null).map((tab) => tab.key)
  const leftIndex = order.indexOf(a)
  const rightIndex = order.indexOf(b)
  check(
    '並び: 左右がタブの並びで隣接している',
    leftIndex >= 0 && rightIndex === leftIndex + 1,
    `left=${leftIndex} right=${rightIndex} / ${order.length} 本`
  )

  // ⌃Tab / ⌃⇧Tab は**両方向**見る（片方向だけだとペアを飛ばす実装が通る）
  await call(`window.nemo.selectTab(${JSON.stringify(a)})`)
  await runCommand('next-tab')
  await sleep(250)
  check(
    '⌃Tab: 左ペインから右ペインへ進む',
    (await state()).activeTabKey === b,
    `active=${(await state()).activeTabKey === a ? 'left' : 'other'}`
  )
  await runCommand('previous-tab')
  await sleep(250)
  check(
    '⌃⇧Tab: 右ペインから左ペインへ戻る',
    (await state()).activeTabKey === a,
    `active=${(await state()).activeTabKey === b ? 'right' : 'other'}`
  )
}

/* ---- ドロップ先の取り合い（ピン留めツリーと） ---- */
{
  await resetTabs()
  const [a, b] = await makeTabs(2, 'drop')
  // 1 本をピン留めしてツリーに行を出す
  await call(`window.nemo.pinTab(${JSON.stringify(a)})`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.find((t) => t.key === ${JSON.stringify(a)})?.pinnedId ? 'ok' : '')`
  )
  const pinnedId = tabOf(await state(), a)?.pinnedId
  check('取り合い: 前提（ピン留め行が出ている）が成立している', Boolean(pinnedId), `pinnedId=${pinnedId}`)

  /*
   * ピン留め行の**中央**へ一時タブを持っていっても、分割の受け皿は出ない。
   * **行は `data-pin`（定義の ID）で引く** —— ピン留めするとタブ行が
   * ピン留めツリーへ移り、`data-key` では引けなくなる。
   */
  const onPinned = JSON.parse(await ui.ev(dragScript(pinnedId, b, 'middle')))
  check(
    '取り合い: ピン留め行の上では `.drop-split` が付かない',
    onPinned.ok && !onPinned.dropping,
    JSON.stringify(onPinned)
  )
  check(
    '取り合い: ピン留め行へ落としても分割にならない',
    (await state()).tabs.every((tab) => tab.splitSide === null),
    JSON.stringify((await state()).tabs.map((tab) => tab.splitSide))
  )

  // 逆向き: タブ行の中央帯に落としたドロップが**ピン留めを増やさない**
  const [c, d] = await makeTabs(2, 'drop2')
  const pinnedBefore = JSON.parse(
    await ui.ev('window.nemo.getSharedState().then((s) => JSON.stringify(s.pinned.length))')
  )
  await makeSplit(c, d)
  const pinnedAfter = JSON.parse(
    await ui.ev('window.nemo.getSharedState().then((s) => JSON.stringify(s.pinned.length))')
  )
  check(
    '取り合い: タブ行へのドロップはピン留めツリーを動かさない',
    pinnedAfter === pinnedBefore,
    `before=${pinnedBefore} after=${pinnedAfter}`
  )

  if (pinnedId) await call(`window.nemo.unpin(${JSON.stringify(pinnedId)})`)
}

/* ---- 複数ペア（ツールバーがアクティブなペアに追従する） ---- */
{
  await resetTabs()
  const [a, b, c, d] = await makeTabs(4, 'multi')
  await makeSplit(a, b)
  await makeSplit(c, d)
  check('複数ペア: 結合行が 2 件出る', (await ui.ev("document.querySelectorAll('.split-row').length")) === 2)

  const leftToolbar = await toolbarOf('left')
  const rightToolbar = await toolbarOf('right')
  const addrOf = (session) => session.ev("document.querySelector('.toolbar .addr')?.title ?? ''")

  for (const [left, right, label] of [
    [a, b, '1 組目'],
    [c, d, '2 組目'],
    [a, b, '1 組目へ戻る']
  ]) {
    await call(`window.nemo.selectTab(${JSON.stringify(left)})`)
    const s = await state()
    const leftUrl = tabOf(s, left)?.url
    const rightUrl = tabOf(s, right)?.url
    await waitFor(leftToolbar, `(document.querySelector('.toolbar .addr')?.title ?? '') ? 'ok' : ''`)
    await sleep(250)
    check(
      `複数ペア: ${label} を選ぶとツールバーが 2 本ともその組を指す`,
      (await addrOf(leftToolbar)) === leftUrl && (await addrOf(rightToolbar)) === rightUrl,
      `left=${await addrOf(leftToolbar)} / right=${await addrOf(rightToolbar)}`
    )
  }
  leftToolbar.close()
  rightToolbar.close()
}

/* ---- ウィンドウ移動（⌘⇧N）---- */
{
  await resetTabs()
  // **ペアの後ろに対照タブを 1 本置く**（後続タブが選ばれる誤りを捕まえるため）
  const [a, b] = await makeTabs(2, 'move')
  await makeSplit(a, b)
  const control = await openTab(`${PAGES}/blank.html?move-control`)
  await call(`window.nemo.selectTab(${JSON.stringify(b)})`) // 右にフォーカス

  const movedUrl = tabOf(await state(), b)?.url
  await call(`window.nemo.moveTabToNewWindow(${JSON.stringify(b)})`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then((s) =>
       s.tabs.every((t) => t.key !== ${JSON.stringify(b)}) ? 'ok' : '')`
  )
  const after = await state()
  check(
    'ウィンドウ移動: 元のウィンドウの左は分割から外れる',
    tabOf(after, a)?.splitSide === null && tabOf(after, a)?.splitPartnerKey === null,
    `side=${tabOf(after, a)?.splitSide} partner=${tabOf(after, a)?.splitPartnerKey}`
  )
  check(
    'ウィンドウ移動: 元のウィンドウで選ばれるのは「左」（後続タブではない）',
    after.activeTabKey === a,
    `active=${after.activeTabKey === control ? '後続タブ' : after.activeTabKey}`
  )
  check(
    'ウィンドウ移動: 結合行が消えている',
    (await ui.ev("document.querySelectorAll('.split-row').length")) === 0
  )

  // 移動先のウィンドウを探して、単独表示になっていることを見る
  const sidebars = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  let moved = null
  const opened = []
  for (const target of sidebars) {
    const session = await connectTo(CDP, new URL(target.url).search.slice(1))
    opened.push(session)
    const st = await session
      .ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))')
      .then(JSON.parse)
    if (st.tabs.some((tab) => tab.key === b)) {
      moved = { session, state: st }
      break
    }
  }
  check(
    'ウィンドウ移動: 移した右タブが移動先のウィンドウに居る',
    moved !== null,
    moved ? `タブ ${moved.state.tabs.length} 本` : '見つからない'
  )
  if (moved) {
    const tab = moved.state.tabs.find((t) => t.key === b)
    check(
      'ウィンドウ移動: 移動先では単独表示（分割の関係は残らない）',
      tab?.splitSide === null && tab?.splitPartnerKey === null,
      `side=${tab?.splitSide} partner=${tab?.splitPartnerKey} url=${movedUrl}`
    )
    const visible = JSON.parse(
      await moved.session.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
    )
    check('ウィンドウ移動: 移動先で見えるのは 1 枚', visible.length === 1, `visible=${visible.length}`)
    /*
     * 後片付けは **⌘⇧W（`close-window`）で畳む**。
     * 最後のタブを閉じても通常ウィンドウは空のまま残るので、
     * そのままだと後続の検証が `connectUi()` でその空ウィンドウを掴みうる。
     */
    /*
     * **応答は待たない**。`close-window` は自分が繋いでいる CDP ターゲット
     * （そのウィンドウのサイドバー）ごと破棄するので、`await` すると返事が
     * 永久に来ずスクリプトが止まる（実際に 26 分ハングした）。
     * 撃ちっぱなしにして、下の `listTargets` で消えたことを確かめる。
     */
    void moved.session
      .ev("window.nemo.runCommandForVerify('close-window').then((ok) => (ok ? 'ok' : 'no'))")
      .catch(() => {})
    // sidebar の target が消えるまで待つ（消えないと「畳めた」と言えない）
    const closed = await (async () => {
      for (let i = 0; i < 25; i += 1) {
        const rest = (await listTargets(CDP)).filter(
          (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
        )
        if (rest.length === sidebars.length - 1) return true
        await sleep(200)
      }
      return false
    })()
    check('ウィンドウ移動: 後片付けで移動先のウィンドウを畳めた', closed, `sidebar target が減らなかった`)
  }
  for (const session of opened) session.close()
  await call(`window.nemo.closeTab(${JSON.stringify(control)})`)
}

/* ---- Live Folder との関係 ---- */
{
  await resetTabs()
  if (!GITHUB_ENDPOINT) {
    skip('Live Folder との関係', 'NEMO_GITHUB_TEST_ENDPOINT が無い（verify-all 経由で走らせる）')
  } else {
    const PR_URL = 'https://github.com/acme/split/pull/7'
    /** アプリと同じ形の GraphQL 応答を返すだけの差し替えサーバ。 */
    const node = {
      number: 7,
      title: 'Split view',
      url: PR_URL,
      isDraft: false,
      updatedAt: '2026-08-25T10:00:00Z',
      reviewDecision: null,
      author: { login: 'octo-dev' },
      repository: { nameWithOwner: 'acme/split' }
    }
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: {
              viewer: { login: 'octo-dev' },
              reviewRequested: { issueCount: 1, nodes: [node] },
              mine: { issueCount: 0, nodes: [] },
              rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-08-26T10:00:00Z' }
            }
          })
        )
      })
    })
    // **PAT は verify-live-folder とは別の値**にする。同じ値だと、あちらが
    // 「別アカウントに貼り替えたらキャッシュを捨てる」を検査しているのと
    // 混線する（こちらの残骸が「同じ資格情報のキャッシュ」として再利用される）。
    const PAT = `ghp_test${'S'.repeat(36)}`
    const liveState = () =>
      ui.ev('window.nemo.getSharedState().then((s) => JSON.stringify(s.liveFolder))').then(JSON.parse)
    try {
      await new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(Number(new URL(GITHUB_ENDPOINT).port), '127.0.0.1', resolve)
      })
      await ui.ev(`window.nemo.saveGithubToken(${JSON.stringify(PAT)})`)
      await waitFor(
        ui,
        `window.nemo.getSharedState().then((s) =>
           (s.liveFolder?.items ?? []).some((item) => item.url === ${JSON.stringify(PR_URL)}) ? 'ok' : '')`,
        { timeoutMs: 15000 }
      )
      check(
        'Live Folder: 前提（PR が一覧に載っている）が成立している',
        ((await liveState())?.items ?? []).length === 1,
        JSON.stringify(((await liveState())?.items ?? []).map((item) => item.url))
      )

      /* ---- 作るときは拒否する ---- */
      const prTab = await openTab(PR_URL)
      const plain = await openTab(`${PAGES}/blank.html?lf-plain`)
      await call(`window.nemo.splitTabs(${JSON.stringify(prTab)}, ${JSON.stringify(plain)})`)
      await sleep(400)
      check(
        'main: Live Folder に載っている URL のタブは分割に入れない',
        (await state()).tabs.every((tab) => tab.splitSide === null),
        JSON.stringify((await state()).tabs.map((tab) => [tab.url.slice(-12), tab.splitSide]))
      )

      /* ---- 作った後に Live Folder 対象になっても結合行は消えない ---- */
      const [a, b] = await makeTabs(2, 'lf')
      await makeSplit(a, b)
      check(
        'Live Folder: 分割を作った直後は結合行が 1 件',
        (await ui.ev("document.querySelectorAll('.split-row').length")) === 1
      )
      // 左ペインを PR の URL へ飛ばす（**分割は勝手に解かない**）
      await call(`window.nemo.navigate(${JSON.stringify(a)}, ${JSON.stringify(PR_URL)})`)
      await waitFor(
        ui,
        `window.nemo.getWindowState().then((s) =>
           s.tabs.find((t) => t.key === ${JSON.stringify(a)})?.url.startsWith(${JSON.stringify(PR_URL)}) ? 'ok' : '')`,
        { timeoutMs: 20000 }
      )
      await sleep(500)
      check(
        'Live Folder: 後から PR の URL になっても結合行は消えない',
        (await ui.ev("document.querySelectorAll('.split-row').length")) === 1,
        `split-row=${await ui.ev("document.querySelectorAll('.split-row').length")}`
      )
      check(
        'Live Folder: 分割は保たれたまま',
        tabOf(await state(), a)?.splitSide === 'left',
        `side=${tabOf(await state(), a)?.splitSide}`
      )
      /*
       * Live Folder 側の行が「開いている」表示（`.lf-row.active`）になること。
       *
       * **小見出しは初期折りたたみ**なので、開かないと行が DOM に出ない。
       * ただし開いた状態は renderer のローカル state で、同じアプリを使い回す
       * 後続の verify-live-folder が「初めて出たときは両方折りたたみ」を見ている。
       * **見たら必ず畳み直す**。
       */
      const toggleReview =
        "document.querySelector('.lf-bucket[data-bucket=\"review\"] > .lf-sub')?.click(); 'ok'"
      await ui.ev(toggleReview)
      await sleep(200)
      const openRows = await ui.ev(
        "JSON.stringify({ rows: document.querySelectorAll('.lf-row').length," +
          " active: document.querySelectorAll('.lf-row.active').length })"
      )
      await ui.ev(toggleReview)
      await sleep(200)
      const restored = await ui.ev("document.querySelectorAll('.lf-row').length")
      check(
        'Live Folder: 一覧側の行は「開いている」表示になる',
        JSON.parse(openRows).rows === 1 && JSON.parse(openRows).active === 1,
        openRows
      )
      check(
        'Live Folder: 見たあとに小見出しを畳み直した（後続の検証の前提を壊さない）',
        restored === 0,
        `lf-row=${restored}`
      )

      await call(`window.nemo.separateSplit(${JSON.stringify(a)})`)
      await call(`window.nemo.closeTab(${JSON.stringify(prTab)})`)
    } finally {
      // **必ず戻す**。PAT を残すと、後で走る verify-live-folder の
      // 「トークン未設定なら source が none」が落ちる
      await ui.ev("window.nemo.clearGithubToken().then(() => 'ok')")
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

/* ---- sleep / アーカイブ（ペア単位の寿命） ---- */
{
  await resetTabs()
  const settings = JSON.parse(await ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))'))
  try {
    const [a, b, control] = await makeTabs(3, 'sleep')
    await ui.ev(dragScript(a, b, 'middle'))
    await waitFor(ui, "window.nemo.getWindowState().then((s) => s.tabs.some((t) => t.splitSide) ? 'ok' : '')")

    // 見えているあいだは寝ない。対照タブ（見えていない非分割）は寝ること
    // **設定値は ms 定数から導出する**（両方に数字を書くと片方だけ直してズレる）
    const SLEEP_THRESHOLD_MS = 1_500
    await updateSetting({ tabSleepMinutes: SLEEP_THRESHOLD_MS / 60_000 })
    // 直前に触ったタブが期限切れになるまで + sweep 1 周（**周期は timings 経由で読み戻す**）
    await sleep(afterSweep(SLEEP_THRESHOLD_MS))
    const s = await state()
    check(
      'sleep: 分割中の 2 本は寝ない',
      tabOf(s, a)?.asleep === false && tabOf(s, b)?.asleep === false,
      `left=${tabOf(s, a)?.asleep} right=${tabOf(s, b)?.asleep}`
    )
    check(
      'sleep: 対照タブ（見えていない非分割）は寝ている',
      tabOf(s, control)?.asleep === true,
      `control=${tabOf(s, control)?.asleep}`
    )

    /*
     * **ペア単位の寿命**: ペアを隠したうえで、**左だけが期限切れ・右は期限内**を作る。
     *
     * 閾値より長い間隔を空けてから右を触り直すのが肝心。
     * 「両方とも期限切れ」になると `pairLastActiveAt` が無くても 2 本とも寝るので、
     * 検査が空振りする（フル検証でだけ落ちた実例）。
     */
    const THRESHOLD_MS = 6_000
    /*
     * 前提チェックのマージンは**この 2 つの差**で決まる（= `THRESHOLD_MS / 12`）。
     * 痩せると「両方とも期限切れ」に化けて検査が空振りする（フル検証でだけ落ちた実例がある）。
     *
     * **閾値に対する比で書く**。素の引き算（`THRESHOLD_MS - 2000`）だと閾値を縮めたときに
     * マージンだけが不釣り合いに痩せる。比で書けば閾値と一緒に比例して縮む。
     * 実測のマージンは `sleep: 検査の前提…` の行に毎回出るので、痩せ過ぎたら気づける。
     */
    const AGE_HEAD_START_MS = Math.round((THRESHOLD_MS * 5) / 6) // 左を先に触ってから右を触るまでの間隔
    const GAP_FLOOR_MS = Math.round((THRESHOLD_MS * 3) / 4) // 前提が成立していると見なす下限
    await updateSetting({ tabSleepMinutes: 0 }) // 仕込みの間は sweep を止める
    await call(`window.nemo.selectTab(${JSON.stringify(a)})`) // 左を触る
    await call(`window.nemo.selectTab(${JSON.stringify(control)})`) // ペアを隠す
    await sleep(AGE_HEAD_START_MS) // 左だけが十分古くなる
    await call(`window.nemo.selectTab(${JSON.stringify(b)})`) // 右を触り直す（右だけ新しい）
    await call(`window.nemo.selectTab(${JSON.stringify(control)})`)
    await updateSetting({ tabSleepMinutes: THRESHOLD_MS / 60_000 })
    // 左は既に AGE_HEAD_START_MS だけ古い。残り（= THRESHOLD_MS の 1/6）で期限切れになり、そこから sweep 1 周。
    // 右はこの時点で若いままなので期限内に留まる
    await sleep(afterSweep(THRESHOLD_MS - AGE_HEAD_START_MS))
    const paired = await state()
    // **前提が成立していること**を先に見る（左が実際に十分古いか）。
    // 実測の差と余裕は PASS のときも必ず出す（flaky が出たとき「マージン不足」か
    // 「別要因」かを 1 回の実行で切り分けるため）
    const gap = (tabOf(paired, b)?.lastActiveAt ?? 0) - (tabOf(paired, a)?.lastActiveAt ?? 0)
    check(
      'sleep: 検査の前提（左だけが期限切れ）が成立している',
      gap >= GAP_FLOOR_MS,
      `差=${gap}ms（下限 ${GAP_FLOOR_MS}ms / 余裕 ${gap - GAP_FLOOR_MS}ms）`
    )
    check(
      'sleep: ペアの新しい方の時刻を使う（古い側だけ寝ない）',
      tabOf(paired, a)?.asleep === false && tabOf(paired, b)?.asleep === false,
      `left=${tabOf(paired, a)?.asleep} right=${tabOf(paired, b)?.asleep}`
    )

    /*
     * アーカイブ側も独立に撃つ（`sweepArchive` は `sweepSleep` とは別関数なので、
     * sleep だけ発火させると archive 側に古い判定が残っていても素通りする）。
     * **ペアを表示した状態で撃つ** —— 見えていない分割は今までどおり sweep の対象で、
     * 隠したまま撃つと「消えて当然」を検査してしまう。
     */
    await updateSetting({ tabSleepMinutes: 0 })
    await call(`window.nemo.selectTab(${JSON.stringify(a)})`) // ペアを見せる
    const beforeArchive = await state()
    check(
      'archive: 撃つ前は分割の 2 本と対照タブが在る',
      tabOf(beforeArchive, a) !== null &&
        tabOf(beforeArchive, b) !== null &&
        tabOf(beforeArchive, control) !== null
    )
    const ARCHIVE_THRESHOLD_MS = 1_800
    await updateSetting({ tabArchiveHours: ARCHIVE_THRESHOLD_MS / 3_600_000 })
    await sleep(afterSweep(ARCHIVE_THRESHOLD_MS))
    const archived = await state()
    check(
      'archive: 見えている分割の 2 本は残る',
      tabOf(archived, a) !== null && tabOf(archived, b) !== null,
      `left=${tabOf(archived, a) !== null} right=${tabOf(archived, b) !== null}`
    )
    check(
      'archive: 対照タブ（見えていない非分割）は閉じられている',
      tabOf(archived, control) === null,
      `control=${tabOf(archived, control) !== null ? '残っている' : 'なし'}`
    )

    /*
     * **archive もペア単位の寿命で見る**。上は「見えている間は残る」だけなので、
     * `visibleTabKeys` の除外があれば `pairLastActiveAt` を書き忘れても通る。
     * ここは**ペアを隠したうえで「古い側だけ期限切れ」**を作って撃つ。
     */
    await updateSetting({ tabArchiveHours: 0 })
    const [p1, p2, spare] = await makeTabs(3, 'agepair')
    await makeSplit(p1, p2)
    const AGE_MS = 6_000
    await call(`window.nemo.selectTab(${JSON.stringify(p1)})`) // 左を触る
    await call(`window.nemo.selectTab(${JSON.stringify(spare)})`) // ペアを隠す
    await sleep(Math.round((AGE_MS * 7) / 6)) // 左だけが十分古くなる（閾値に比例させる）
    await call(`window.nemo.selectTab(${JSON.stringify(p2)})`) // 右を触り直す
    await call(`window.nemo.selectTab(${JSON.stringify(spare)})`) // また隠す
    const aged = await state()
    const ageGap = (tabOf(aged, p2)?.lastActiveAt ?? 0) - (tabOf(aged, p1)?.lastActiveAt ?? 0)
    // **前提が成立していること**を先に見る（両方とも期限切れだと検査が空振りする）
    check(
      'archive: 検査の前提（左だけが期限切れ）が成立している',
      ageGap >= AGE_MS,
      `差=${ageGap}ms（下限 ${AGE_MS}ms / 余裕 ${ageGap - AGE_MS}ms）`
    )
    check(
      'archive: 前提（ペアが隠れている）が成立している',
      !(await visibleKeys()).includes(p1) && !(await visibleKeys()).includes(p2),
      JSON.stringify(await visibleKeys())
    )
    await updateSetting({ tabArchiveHours: AGE_MS / 3_600_000 })
    // 左は既に AGE_MS の 7/6 だけ古い（= 設定した瞬間に期限切れ）ので、あとは sweep 1 周待つだけ
    await sleep(afterSweep(0))
    const agedAfter = await state()
    check(
      'archive: ペアの新しい方の時刻を使う（古い側だけ消えない）',
      tabOf(agedAfter, p1) !== null && tabOf(agedAfter, p2) !== null,
      `left=${tabOf(agedAfter, p1) !== null} right=${tabOf(agedAfter, p2) !== null}`
    )
  } finally {
    // **必ず戻す**。極小のまま抜けると後続の検証のタブが勝手に寝る / 閉じる
    await updateSetting({
      tabSleepMinutes: settings.tabSleepMinutes,
      tabArchiveHours: settings.tabArchiveHours
    })
  }
}

await resetTabs()

if (SHOT_DIR) console.log(`\nスクリーンショット: ${SHOT_DIR}`)
if (skipped > 0) console.log(`\n（SKIP ${skipped} 件 —— 見ていない検査がある）`)
console.log(failures === 0 ? '\n分割ビュー: すべて PASS' : `\n分割ビュー: FAIL ${failures} 件`)
process.exit(failures === 0 ? 0 : 1)
