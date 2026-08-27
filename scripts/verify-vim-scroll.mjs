#!/usr/bin/env node
/**
 * ページの `gg` / `G`（vim の作法で縦の端へ飛ぶ）の自走検証。
 *
 * 見るもの:
 * - `gg` で最上部・`G` で最下部へ飛ぶこと
 * - **`gg` の猶予（1000ms）を過ぎたら飛ばない**こと
 * - **ルートが動かず内側の div がスクローラのページ**（Gmail / Slack 型）で、
 *   フォーカス起点の祖先探索が内側スクローラを掴むこと
 * - **入力欄にフォーカスがあるあいだは飛ばない**こと、かつ
 *   **文字はちゃんと入る**こと（`preventDefault` していないことの裏取り）
 *
 * ここで見られないもの（実機で確かめる）:
 * - 実サイト（Gmail / Slack / Notion）での対象選択の当たり
 * - GitHub の `g c` など、ページ側の `g` プレフィックスが無傷であること
 * - smooth の手触り
 *
 * **判定ロジックそのもの（`gg` の状態機械）は `scripts/vim-scroll.test.mjs` が持つ。**
 * ここが受け持つのは、注入コードの中にしかいないヘルパー（入力欄の除外・スクロール対象の選択）。
 *
 * 罠:
 * - **smooth なので撃った直後に `scrollTop` を読むと偽 FAIL**。到達するまで polling する。
 * - 逆に**「動かない」を見るケースは polling が使えない**ので、smooth の最長ぶんを
 *   待ってから読む（撃った直後に読むと、動く実装でも PASS してしまう）。
 * - `Input.dispatchKeyEvent` は **`text` を渡さないと文字を挿入しない**。
 *   入力欄に `G` が入ることを見たいので、必ず付ける。
 *
 * 前提は verify-phase1 と同じ（`verify-all.mjs` が用意する）。
 */
import { connect, connectTo, listTargets, sleep, waitFor } from './lib/cdp.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

/** smooth の最長ぶん。「動かない」を見るケースはこれだけ待ってから読む。 */
const SMOOTH_SETTLE_MS = 1500
/** `gg` の猶予（1000ms）を確実に超える待ち。 */
const PENDING_EXPIRE_MS = 1200

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * サイドバーと**同じウィンドウ**に繋ぐ（`verify-switcher.mjs` から持ってきた）。
 *
 * 「view=sidebar の最初の target」を拾うと、ほかの検証が残したウィンドウがあるときに
 * 別のウィンドウを掴んで偽 FAIL になる。`window=` を読んで以降のページ URL に付ける。
 */
async function connectWindow() {
  const sidebars = (await listTargets(CDP)).filter(
    (target) => target.url.includes('view=sidebar') && !target.url.includes('private=1')
  )
  if (sidebars.length === 0) throw new Error('ブラウザ UI の target が見つからない')
  const windowId = /window=(\d+)/.exec(sidebars[0].url)?.[1]
  if (!windowId) throw new Error(`window= を読めない: ${sidebars[0].url}`)

  const ui = await connectTo(CDP, `view=sidebar&window=${windowId}`)
  await waitFor(ui, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
  await waitFor(ui, "window.nemo.getAppStatus().then((s) => (s.ready ? 'ready' : ''))")
  return { ui, windowId }
}

/**
 * タブのページに繋ぐ。
 *
 * **URL の部分一致で選ばない**。ブラウザ UI 自身が `nemo://ui/index.html` なので、
 * `/index.html` のようなパスで引くと UI 側を掴む。完全一致で絞り、
 * 1つに定まらなければ落とす（黙って別の target を検証しない）。
 */
async function connectPage(url, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await listTargets(CDP)).filter((target) => target.type === 'page' && target.url === url)
    if (found.length === 1) {
      const page = await connect(found[0].webSocketDebuggerUrl)
      // **読み込み完了を待つ**。target は URL で見つかっても document がまだ無いことがあり、
      // `document.scrollingElement` が null のまま落ちる（実際に踏んだ）。
      // 中身を JS で組み立てる fixture なので `complete` まで待つ。
      await waitFor(page, "document.readyState === 'complete' && document.scrollingElement ? 'ok' : ''")
      return page
    }
    if (Date.now() > deadline) {
      throw new Error(`ページの target が1つに定まらない: ${url}（${found.length} 件）`)
    }
    await sleep(200)
  }
}

const { ui, windowId } = await connectWindow()
console.log(`（ウィンドウ ${windowId} を検証する）`)

const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)

/**
 * キーを1つ撃つ。
 *
 * **`text` を必ず渡す**。渡さないと入力欄に文字が入らず、
 * 「`preventDefault` していない」の裏取りが必ず空振り FAIL になる。
 */
async function pressKey(page, key) {
  const shift = key === key.toUpperCase() && key !== key.toLowerCase()
  const common = {
    key,
    code: `Key${key.toUpperCase()}`,
    text: key,
    unmodifiedText: key.toLowerCase(),
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    modifiers: shift ? 8 : 0
  }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** 式の値が条件を満たすまで待つ。満たさないまま時間切れなら最後の値を返す（実測値を出すため）。 */
async function pollUntil(page, expression, ok, { timeoutMs = 4000, interval = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = await page.ev(expression)
  while (!ok(last) && Date.now() < deadline) {
    await sleep(interval)
    last = await page.ev(expression)
  }
  return last
}

const ROOT_TOP = 'document.scrollingElement.scrollTop'
const ROOT_MAX = 'document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight'

/* ------------------------------------------------------------------ *
 * 下ごしらえ: 検証用のタブを開く
 * ------------------------------------------------------------------ */

const longUrl = `${PAGES}/scroll-long.html?w=${windowId}`
const innerUrl = `${PAGES}/scroll-inner.html?w=${windowId}`

const openedKeys = []
for (const url of [longUrl, innerUrl]) {
  openedKeys.push(await ui.ev(`window.nemo.createTab(${JSON.stringify(url)})`))
}

const longPage = await connectPage(longUrl)
const innerPage = await connectPage(innerUrl)

/* ------------------------------------------------------------------ *
 * 1. gg で最上部へ
 * ------------------------------------------------------------------ */

{
  // アクティブにしてから撃つ（キーはフォーカスのある WebContents に届く）。
  await ui.ev(`window.nemo.selectTab(${JSON.stringify(openedKeys[0])})`)
  const max = await longPage.ev(ROOT_MAX)
  await longPage.ev(`document.scrollingElement.scrollTo({ top: ${max}, behavior: 'auto' }), 0`)
  const before = await longPage.ev(ROOT_TOP)

  await pressKey(longPage, 'g')
  await pressKey(longPage, 'g')
  const after = await pollUntil(longPage, ROOT_TOP, (v) => v <= 1)

  check(
    'gg で最上部へ戻る',
    before > 100 && after <= 1,
    `scrollTop ${before} → ${after} / max ${max}（押す前が最下部だったことも見ている）`
  )
}

/* ------------------------------------------------------------------ *
 * 2. G で最下部へ
 * ------------------------------------------------------------------ */

{
  const max = await longPage.ev(ROOT_MAX)
  const before = await longPage.ev(ROOT_TOP)

  await pressKey(longPage, 'G')
  const after = await pollUntil(longPage, ROOT_TOP, (v) => v >= max - 2)

  check(
    'G で最下部へ飛ぶ',
    before <= 1 && after >= max - 2,
    `scrollTop ${before} → ${after} / max ${max}（押す前が 0 だったことも見ている）`
  )
}

/* ------------------------------------------------------------------ *
 * 3. gg の猶予を過ぎたら飛ばない
 *
 * **polling が使えない**（動かないことを見るので）。smooth の最長ぶん待ってから読む。
 * 直前の 1 が通っていることで「そもそも効いていない」と区別できる。
 * ------------------------------------------------------------------ */

{
  const before = await longPage.ev(ROOT_TOP)

  await pressKey(longPage, 'g')
  await sleep(PENDING_EXPIRE_MS)
  await pressKey(longPage, 'g')
  await sleep(SMOOTH_SETTLE_MS)
  const after = await longPage.ev(ROOT_TOP)

  check(
    `gg の猶予（${PENDING_EXPIRE_MS}ms 空ける）を過ぎたら飛ばない`,
    before > 100 && Math.abs(after - before) <= 2,
    `scrollTop ${before} → ${after}（押す前が最下部＝動けば必ず変わる位置だったことも見ている）`
  )
}

/* ------------------------------------------------------------------ *
 * 4. 内側スクローラ（Gmail / Slack 型）
 *
 * スクローラは**画面中央から外して**あるので、中央フォールバックでは拾えない。
 * ここが動けば activeElement 起点の祖先探索が効いている証明になる。
 * ------------------------------------------------------------------ */

{
  await ui.ev(`window.nemo.selectTab(${JSON.stringify(openedKeys[1])})`)
  const center = await innerPage.ev(
    "(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return el ? el.id || el.tagName : '(なし)' })()"
  )
  await innerPage.ev("document.getElementById('scroller').focus({ preventScroll: true }), 0")
  const focused = await innerPage.ev('document.activeElement.id')
  const max = await innerPage.ev(
    "(() => { const s = document.getElementById('scroller'); return s.scrollHeight - s.clientHeight })()"
  )
  const before = await innerPage.ev("document.getElementById('scroller').scrollTop")

  await pressKey(innerPage, 'G')
  const after = await pollUntil(
    innerPage,
    "document.getElementById('scroller').scrollTop",
    (v) => v >= max - 2
  )
  const rootTop = await innerPage.ev(ROOT_TOP)

  check(
    '内側スクローラ（画面中央の外）で G が効く',
    focused === 'scroller' && center !== 'scroller' && before <= 1 && after >= max - 2 && rootTop === 0,
    `scroller ${before} → ${after} / max ${max}、root ${rootTop}、画面中央は ${center}`
  )
}

/* ------------------------------------------------------------------ *
 * 5. 入力欄では飛ばない・文字は入る
 *
 * **先に中間位置へ動かしてから**撃つ。3 の直後は最下部にいるので、そのまま撃つと
 * 入力欄の除外が壊れていても `scrollTop` が変わらず**通ってしまう**。
 * `focus({ preventScroll: true })` にしないと、フォーカスした時点で基準値が汚れる。
 * ------------------------------------------------------------------ */

{
  await ui.ev(`window.nemo.selectTab(${JSON.stringify(openedKeys[0])})`)
  const max = await longPage.ev(ROOT_MAX)
  await longPage.ev(
    `document.scrollingElement.scrollTo({ top: ${Math.round(max / 2)}, behavior: 'auto' }), 0`
  )
  await longPage.ev(
    "(() => { const el = document.getElementById('probe'); el.value = ''; el.focus({ preventScroll: true }) })(), 0"
  )
  const before = await longPage.ev(ROOT_TOP)

  await pressKey(longPage, 'G')
  await sleep(SMOOTH_SETTLE_MS)
  const after = await longPage.ev(ROOT_TOP)
  const typed = await longPage.ev("document.getElementById('probe').value")

  check(
    '入力欄にフォーカスがあるあいだは飛ばず、文字が入る',
    before > 100 && before < max - 100 && Math.abs(after - before) <= 2 && typed === 'G',
    `scrollTop ${before} → ${after} / max ${max}（基準値は最上部でも最下部でもない）、input.value=${JSON.stringify(typed)}`
  )
}

/* ------------------------------------------------------------------ *
 * 後片付け
 *
 * **タブが 0 になるとウィンドウごと消える**。後続の restart ブロックが丸ごと落ちるので、
 * 他に残っていることを確かめてから閉じる（残っていなければ 1 枚残す）。
 * ------------------------------------------------------------------ */

{
  for (const key of openedKeys) {
    const s = await state()
    if (s.tabs.length <= 1) {
      console.log(`（タブが残り ${s.tabs.length} 枚なので閉じない。ウィンドウごと消えるため）`)
      break
    }
    await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)})`)
  }
}

longPage.close()
innerPage.close()
ui.close()

console.log(
  failures === 0 ? '\n自走検証（gg / G）: すべて PASS' : `\n自走検証（gg / G）: ${failures} 件 FAIL`
)
process.exit(failures === 0 ? 0 : 1)
