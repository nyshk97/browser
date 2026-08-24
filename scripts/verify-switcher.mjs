#!/usr/bin/env node
/**
 * タブスイッチャー（⌃M）の自走検証。
 *
 * 見るもの:
 * - MRU 順（直近に使った順）で並ぶこと・押すたびに1つ進んで末尾で先頭へ戻ること
 * - **修飾キーを離した瞬間に確定**すること（`before-input-event` 経由）
 * - Esc で取消・カードのクリックでそのタブへ・背景クリックで取消
 * - 確定したタブが次から MRU の先頭に来ること
 * - **ページ側に届いた keyUp でも確定する**こと（張り先が UI だけになっていないこと）
 * - **帯の表示が古くなっても、押したカードのタブへ行く**こと（位置ではなく key で決まる）
 * - **押しっぱなしのまま放置しても時間では切り替わらない**こと
 * - 辿る先が無いとき（タブ1枚）・ほかのオーバーレイが出ているときは割り込まないこと
 *
 * ここで見られないもの（実機で確かめる）:
 * - **⌃M のキー入力そのもの**。メニューのアクセラレータは AppKit が NSEvent の段階で
 *   処理するので、CDP から撃った合成キーでは発火しない。入口は `switchTab()` を使い、
 *   割り当ての妥当性・重複は `scripts/keybindings.test.mjs` で見る
 * - ウィンドウの blur による取消（CDP からフォーカスを外す手段が無い）
 *
 * 前提は verify-phase1 と同じ（`verify-all.mjs` が用意する）。
 */
import { connect, connectTo, listTargets, sleep, waitFor } from './lib/cdp.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * サイドバーと**同じウィンドウ**のオーバーレイに繋ぐ。
 *
 * 「view=sidebar の最初の target」「view=overlay の最初の target」を別々に拾うと、
 * ほかの検証が残したウィンドウがあるときに**別々のウィンドウを掴んで偽 FAIL になる**。
 * サイドバーから `window=` を読んで、必ず対にする。
 */
async function connectWindow() {
  const sidebars = (await listTargets(CDP)).filter(
    (target) => target.url.includes('view=sidebar') && !target.url.includes('private=1')
  )
  if (sidebars.length === 0) throw new Error('ブラウザ UI の target が見つからない')
  const windowId = /window=(\d+)/.exec(sidebars[0].url)?.[1]
  if (!windowId) throw new Error(`window= を読めない: ${sidebars[0].url}`)

  const ui = await connectTo(CDP, `view=sidebar&window=${windowId}`)
  const overlay = await connectTo(CDP, `view=overlay&window=${windowId}`)
  for (const session of [ui, overlay]) {
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
  }
  await waitFor(ui, "window.nemo.getAppStatus().then((s) => (s.ready ? 'ready' : ''))")
  return { ui, overlay, windowId }
}

/**
 * タブのページに繋ぐ。
 *
 * **URL の部分一致で選ばない**。ブラウザ UI 自身が `nemo://ui/index.html` なので、
 * `/index.html` のようなパスで引くと UI 側を掴む。完全一致で絞り、
 * 1つに定まらなければ落とす（黙って別の target を検証しない）。
 */
async function connectPage(url) {
  const found = (await listTargets(CDP)).filter((target) => target.type === 'page' && target.url === url)
  if (found.length !== 1) {
    throw new Error(`ページの target が1つに定まらない: ${url}（${found.length} 件）`)
  }
  return connect(found[0].webSocketDebuggerUrl)
}

const { ui, overlay, windowId } = await connectWindow()
console.log(`（ウィンドウ ${windowId} を検証する）`)

const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const call = (expression) => ui.ev(`${expression}.then(() => 'ok')`)

/** 帯に出ているタイトルとハイライト位置（＝画面に見えているもの）。 */
const strip = () =>
  overlay
    .ev(
      `JSON.stringify({
        cards: [...document.querySelectorAll('.switch-card .switch-title')].map((el) => el.textContent),
        index: [...document.querySelectorAll('.switch-card')].findIndex((el) => el.classList.contains('on'))
      })`
    )
    .then(JSON.parse)

/**
 * 修飾キーの keyUp を実際に撃つ。
 * ここが「離したら確定」の肝なので、IPC ではなく**キーイベントで**確かめる。
 *
 * 撃つ先を差し替えられるようにしてある。オーバーレイとページのどちらにフォーカスが
 * あっても拾えること（main が両方に `before-input-event` を張っていること）を見るため。
 * **一度ページへ撃つと、以降オーバーレイへ撃っても届かない**（7 の説明を見る）。
 */
async function releaseControl(target = overlay) {
  await target.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  })
}

async function pressKey(key, code) {
  await overlay.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : 0,
    nativeVirtualKeyCode: key === 'Escape' ? 27 : 0
  })
}

/** タブの表示名（サイドバーと帯で同じものが出る）。 */
const titleOf = (s, key) => s.tabs.find((t) => t.key === key)?.title ?? '(なし)'

/* ------------------------------------------------------------------ *
 * 下ごしらえ: 狙った順番で3枚開き、それ以外は畳む
 * ------------------------------------------------------------------ */

/**
 * A → B → C の順に開く（＝MRU は C, B, A）。
 *
 * URL に**ウィンドウ固有の印**を付ける。ほかの検証が残したウィンドウが同じページを
 * 開いていると、`connectPage` が target を1つに絞れない（実際に落ちた）。
 */
async function openThree() {
  const before = (await state()).tabs.map((tab) => tab.key)
  const a = await ui.ev(`window.nemo.createTab('${PAGES}/index.html?w=${windowId}')`)
  const b = await ui.ev(`window.nemo.createTab('${PAGES}/login.html?w=${windowId}')`)
  const c = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html?w=${windowId}')`)
  // 起動時のタブは最後に畳む（先に全部閉じるとウィンドウごと消える）
  for (const key of before) await call(`window.nemo.closeTab(${JSON.stringify(key)})`)
  return { a, b, c }
}

const keys = await openThree()
const s0 = await state()
check(
  '下ごしらえ: タブが3枚で、最後に開いたものがアクティブ',
  s0.tabs.length === 3 && s0.activeTabKey === keys.c,
  `${s0.tabs.length} 枚 / active=${titleOf(s0, s0.activeTabKey)}`
)

/* ------------------------------------------------------------------ *
 * 1. 押すと直近のタブを指した帯が出る
 * ------------------------------------------------------------------ */

{
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const view = await strip()
  const s = await state()

  check(
    '⌃M で帯が出る',
    (await state()).tabs.length === 3 && view.cards.length === 3,
    JSON.stringify(view.cards)
  )
  check(
    '並びは MRU 順（先頭が今のタブ）',
    view.cards[0] === titleOf(s, keys.c) &&
      view.cards[1] === titleOf(s, keys.b) &&
      view.cards[2] === titleOf(s, keys.a),
    JSON.stringify(view.cards)
  )
  check('最初のハイライトは直前のタブ（2番目）', view.index === 1, String(view.index))
  check('押しているだけではタブは変わらない', s.activeTabKey === keys.c, titleOf(s, s.activeTabKey))
}

/* ------------------------------------------------------------------ *
 * 2. 押すたびに進み、末尾で先頭へ戻る
 * ------------------------------------------------------------------ */

{
  await call('window.nemo.switchTab()')
  check('もう一度押すと1つ先へ進む', (await strip()).index === 2, String((await strip()).index))
  await call('window.nemo.switchTab()')
  check('末尾まで行ったら先頭へ戻る', (await strip()).index === 0, String((await strip()).index))
  await call('window.nemo.switchTab()')
  check('先頭からさらに進める', (await strip()).index === 1, String((await strip()).index))
}

/* ------------------------------------------------------------------ *
 * 3. 修飾キーを離した瞬間に確定する
 * ------------------------------------------------------------------ */

{
  await releaseControl()
  await waitFor(ui, `window.nemo.getWindowState().then((s) => (s.activeTabKey ? 'ok' : ''))`)
  await sleep(300)
  const s = await state()
  check('⌃ を離すとハイライトしていたタブへ切り替わる', s.activeTabKey === keys.b, titleOf(s, s.activeTabKey))
  const kind = await overlay.ev(`document.querySelectorAll('.switch-card').length`)
  check('確定したら帯は消える', kind === 0, String(kind))
}

/* ------------------------------------------------------------------ *
 * 4. 確定したタブが MRU の先頭に来る（＝もう一度押せば戻れる）
 * ------------------------------------------------------------------ */

{
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const s = await state()
  const view = await strip()
  check(
    '直前に居たタブが2番目に来る（1回押して離せば行き来できる）',
    view.cards[0] === titleOf(s, keys.b) && view.cards[1] === titleOf(s, keys.c),
    JSON.stringify(view.cards)
  )
  await releaseControl()
  await sleep(300)
  check(
    '行き来できる',
    (await state()).activeTabKey === keys.c,
    titleOf(await state(), (await state()).activeTabKey)
  )
}

/* ------------------------------------------------------------------ *
 * 5. Esc で取消（タブは変わらない）
 * ------------------------------------------------------------------ */

{
  const before = (await state()).activeTabKey
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  await pressKey('Escape', 'Escape')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(200)
  check('Esc で帯が消える', (await overlay.ev(`document.querySelectorAll('.switch-card').length`)) === 0)
  check('Esc ではタブが変わらない', (await state()).activeTabKey === before)
}

/* ------------------------------------------------------------------ *
 * 6. カードのクリックでその位置へ / 背景クリックで取消
 * ------------------------------------------------------------------ */

{
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const view = await strip()
  const target = view.cards[2]
  await overlay.ev(`(() => { document.querySelectorAll('.switch-card')[2].click(); return 'ok' })()`)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  const s = await state()
  check(
    'カードをクリックするとそのタブへ行く',
    titleOf(s, s.activeTabKey) === target,
    `${titleOf(s, s.activeTabKey)} / 期待 ${target}`
  )

  const before = s.activeTabKey
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  await overlay.ev(
    `(() => { document.querySelector('.switch-back').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'ok' })()`
  )
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(200)
  check('背景クリックは取消（タブが変わらない）', (await state()).activeTabKey === before)
}

/* ------------------------------------------------------------------ *
 * 7. ページ側に届いた keyUp でも確定する
 *
 * オーバーレイとページのどちらにフォーカスがあっても拾えること
 * （main が両方に `before-input-event` を張っていること）を見る。
 *
 * **ここから後の keyUp はページ側へ撃つ**。CDP の合成キーは撃った先へフォーカスが
 * 移るらしく、一度ページへ撃つと以降オーバーレイへ撃っても届かない。実機では
 * フォーカスを持っている View に届くだけなので、これは harness 側の制約。
 * 張り先をウィンドウ内の全 WebContents にしてあるので、どちらでも確定できる。
 * ------------------------------------------------------------------ */

{
  const s = await state()
  const active = s.tabs.find((tab) => tab.key === s.activeTabKey)
  const page = await connectPage(active.url)

  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const wanted = (await strip()).cards[1]
  // オーバーレイではなく**ページの WebContents**へ keyUp を撃つ
  await releaseControl(page)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  const after = await state()
  check(
    'ページ側に届いた keyUp でも確定する（張り先が UI だけになっていない）',
    titleOf(after, after.activeTabKey) === wanted,
    `${titleOf(after, after.activeTabKey)} / 期待 ${wanted}`
  )
  page.close()
}

/* ------------------------------------------------------------------ *
 * 8. 押しっぱなしのまま放置しても、時間では切り替わらない
 * ------------------------------------------------------------------ */

{
  const s = await state()
  const before = s.activeTabKey
  const page = await connectPage(s.tabs.find((tab) => tab.key === before).url)

  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  // 修飾キーのある割り当てでは時間で確定しない（選んでいる途中で目的地が変わらない）
  await sleep(6000)
  check('6秒待っても帯は出たまま', (await overlay.ev(`document.querySelectorAll('.switch-card').length`)) > 0)
  check('6秒待ってもタブは変わらない', (await state()).activeTabKey === before)
  await releaseControl(page)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  check('待った後でも ⌃ を離せば確定する', (await state()).activeTabKey !== before)
  page.close()
}

/* ------------------------------------------------------------------ *
 * 9. 帯を出したままタブが閉じられたとき
 *
 * 帯を出したままタブを閉じると main 側の並びだけが詰まり、UI が持っている位置は
 * 古いままになる。位置で受け渡すと1件ぶんずれて**別のタブへ飛ぶ**ので、key で渡す。
 * 破壊的なので後ろに置く。
 * ------------------------------------------------------------------ */

{
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const before = await strip()
  const s = await state()

  // 帯の先頭（＝今のタブ）を、帯を出したまま閉じる
  await call(`window.nemo.closeTab(${JSON.stringify(s.activeTabKey)})`)
  await sleep(400)

  const stale = await strip()
  check(
    '前提: タブを閉じても帯の表示は古いまま（ずれる条件が作れている）',
    stale.cards.length === before.cards.length,
    `${stale.cards.length} 枚 / 閉じる前 ${before.cards.length} 枚`
  )

  // 既に閉じたタブのカード（先頭）を押しても、投げずに何も起きないこと。
  // 投げると renderer 側で unhandled rejection になり、帯が出たまま残る。
  const dead = s.activeTabKey
  const outcome = await overlay.ev(
    `window.nemo.pickSwitcherTab(${JSON.stringify(dead)}).then(() => 'ok', () => 'rejected')`
  )
  await sleep(300)
  check('閉じたタブのカードを押しても投げない', outcome === 'ok', String(outcome))
  check(
    '閉じたタブのカードを押しても帯は残る（切り替わらない）',
    (await overlay.ev(`document.querySelectorAll('.switch-card').length`)) > 0 &&
      (await state()).activeTabKey !== dead
  )

  const wanted = stale.cards[1]
  await overlay.ev(`(() => { document.querySelectorAll('.switch-card')[1].click(); return 'ok' })()`)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  const after = await state()
  check(
    '古い帯でも、押したカードのタブへ行く（位置ではなく key で決まる）',
    titleOf(after, after.activeTabKey) === wanted,
    `${titleOf(after, after.activeTabKey)} / 期待 ${wanted}`
  )
}

{
  // 上でレイアウトが走った後も、確定の経路が残っていること
  const s = await state()
  const active = s.tabs.find((tab) => tab.key === s.activeTabKey)
  const page = await connectPage(active.url)
  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)
  const wanted = (await strip()).cards[1]
  await releaseControl(page)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  const after = await state()
  check(
    'タブを閉じてレイアウトが走った後でも、離せば確定する',
    titleOf(after, after.activeTabKey) === wanted,
    `${titleOf(after, after.activeTabKey)} / 期待 ${wanted}`
  )
  page.close()
}

/* ------------------------------------------------------------------ *
 * 9b. 読み直した状態のハイライトと、実際の切替先が一致する
 *
 * オーバーレイは押している最中に読み直されることがある（HMR・再読み込み）。
 * そのとき閉じたタブを落とした配列に**落とす前の位置**を混ぜると、
 * 見えているハイライトと ⌃ を離した先が食い違う。
 * ------------------------------------------------------------------ */

{
  // 3枚に戻す（先頭を閉じても2枚残る状態を作る）
  await ui.ev(`window.nemo.createTab('${PAGES}/media.html?w=${windowId}')`)
  await sleep(800)

  await call('window.nemo.switchTab()')
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length > 0 ? 'ready' : ''`)

  const s = await state()
  const page = await connectPage(s.tabs.find((tab) => tab.key !== s.activeTabKey).url)
  // 帯の先頭（＝今のタブ）を閉じて、並びが詰まる条件を作る
  await call(`window.nemo.closeTab(${JSON.stringify(s.activeTabKey)})`)
  await sleep(400)

  // 購読より前に開いた UI が取りに来る経路。ここが詰めた配列と古い位置を混ぜていないか
  const shown = JSON.parse(
    await ui.ev('window.nemo.getOverlayState().then((s) => JSON.stringify(s.switcher))')
  )
  const highlighted = shown.tabs[shown.index]
  check(
    '読み直した状態にも閉じたタブが残っていない',
    shown.tabs.every((tab) => tab.key !== s.activeTabKey),
    `${shown.tabs.length} 枚 / index=${shown.index}`
  )

  await releaseControl(page)
  await waitFor(overlay, `document.querySelectorAll('.switch-card').length === 0 ? 'ok' : ''`)
  await sleep(300)
  const after = await state()
  check(
    '見えているハイライトと、離したときの切替先が一致する',
    after.activeTabKey === highlighted.key,
    `${titleOf(after, after.activeTabKey)} / 期待 ${highlighted.title}`
  )
  page.close()
}

/* ------------------------------------------------------------------ *
 * 10. 割り込まない条件
 * ------------------------------------------------------------------ */

{
  await call(`window.nemo.setOverlay('command-bar')`)
  await sleep(200)
  await call('window.nemo.switchTab()')
  await sleep(200)
  check(
    'ほかのオーバーレイが出ている間は帯を出さない',
    (await overlay.ev(`document.querySelectorAll('.switch-card').length`)) === 0
  )
  await call('window.nemo.setOverlay(null)')
  await sleep(200)
}

{
  // タブ1枚のウィンドウでは辿る先が無い
  const s = await state()
  const keep = s.activeTabKey
  for (const tab of s.tabs) {
    if (tab.key !== keep) await call(`window.nemo.closeTab(${JSON.stringify(tab.key)})`)
  }
  await sleep(200)
  await call('window.nemo.switchTab()')
  await sleep(300)
  check(
    'タブが1枚のときは何も起きない',
    (await overlay.ev(`document.querySelectorAll('.switch-card').length`)) === 0 &&
      (await state()).tabs.length === 1
  )
}

console.log(failures === 0 ? '\nタブスイッチャー: すべて PASS' : `\nタブスイッチャー: FAIL ${failures} 件`)
process.exit(failures === 0 ? 0 : 1)
