#!/usr/bin/env node
/**
 * Phase 1 の自走検証。
 *
 * CDP でブラウザ UI（`nemo://ui/?view=sidebar`）につなぎ、preload が公開している
 * API を叩いて Phase 1 の受け入れ内容を機械的に確認する。
 *
 * 前提（`verify-all.mjs` が用意する）:
 * - Nemo が `NEMO_REMOTE_DEBUGGING_PORT` 付きで起動している
 * - テストページサーバが動いている
 * - **使い捨てのデータディレクトリ**で動いている（CDP を開けるので実プロファイルでは回さない）
 *
 * 使い方:
 *   node scripts/verify-phase1.mjs                 主要セット
 *   node scripts/verify-phase1.mjs --session-write セッション復元の前半（タブを開く）
 *   node scripts/verify-phase1.mjs --session-read  再起動後に復元されたか見る
 */
import { connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** ピン留めツリーの ID を平らに並べる。 */
function flattenIds(nodes) {
  return nodes.flatMap((node) =>
    node.kind === 'folder' ? [node.id, ...flattenIds(node.children)] : [node.id]
  )
}

async function expectThrows(name, fn, detail = '') {
  try {
    await fn()
    check(name, false, `${detail}（拒否されずに通った）`)
  } catch {
    check(name, true, detail)
  }
}

const ui = await connectUi(CDP)
const overlay = await connectUi(CDP, 'overlay')

const state = () => ui.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
const shared = () => ui.ev('window.nemo.getSharedState().then(s => JSON.stringify(s))').then(JSON.parse)

const mode = process.argv[2]

/* ------------------------------------------------------------------ *
 * セッション復元（再起動をまたぐので2回に分けて呼ばれる）
 * ------------------------------------------------------------------ */

if (mode === '--session-write') {
  await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(() => 'ok')`)
  await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(() => 'ok')`)
  // **サイドバーを隠した状態で終了する**（この設定は永続化される）。
  // 次の起動でちゃんと出て来ることを --session-read で見る。
  await ui.ev('window.nemo.setSidebarVisible(false).then(() => "ok")')
  // セッション保存はデバウンスされているので、書かれるまで待つ
  await sleep(3000)
  console.log('session-write done')
  process.exit(0)
}

if (mode === '--session-read') {
  // 復元されるウィンドウは1つとは限らない（拡張の検証が別ウィンドウを開いている）。
  // 「どのウィンドウに戻ったか」は問わず、**全ウィンドウを合わせて**見る。
  const sidebars = (await listTargets(CDP)).filter((t) => t.url.includes('view=sidebar'))
  const windows = []
  for (const target of sidebars) {
    const session = await connectTo(CDP, new URL(target.url).search.slice(1))
    windows.push({
      session,
      state: await session.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
    })
  }

  const urls = windows.flatMap((w) => w.state.tabs.map((t) => t.url))
  check(
    'セッション復元: 前回のタブが戻っている',
    urls.some((u) => u.includes('/login.html')) && urls.some((u) => u.includes('/iframe.html')),
    urls.join(', ')
  )
  check(
    'セッション復元: 復元直後のタブは sleep 状態（一斉に読み込まない）',
    windows.every((w) => w.state.tabs.filter((t) => t.key !== w.state.activeTabKey).every((t) => t.asleep)),
    windows.flatMap((w) => w.state.tabs.map((t) => (t.asleep ? 'asleep' : 'awake'))).join(', ')
  )

  // 隠したまま起動すると、戻す手段が ⌘S だけになり（掴みしろを残していない）、
  // 空タブと重なって手がかりの無い真っ黒な窓になる。**起動時は必ず出す**。
  check(
    'サイドバーを隠して終了しても、次の起動では出ている',
    windows.every((w) => w.state.sidebarVisible === true),
    windows.map((w) => String(w.state.sidebarVisible)).join(', ')
  )

  const sleeper = windows.find((w) => w.state.tabs.some((t) => t.key !== w.state.activeTabKey && t.asleep))
  if (sleeper) {
    const target = sleeper.state.tabs.find((t) => t.key !== sleeper.state.activeTabKey && t.asleep)
    await sleeper.session.ev(`window.nemo.selectTab(${JSON.stringify(target.key)}).then(() => 'ok')`)
    const after = await waitFor(
      sleeper.session,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${JSON.stringify(target.key)}); return t && !t.asleep ? 'awake' : '' })`
    )
    check('sleep 中のタブを選ぶと読み直される', after === 'awake')
  } else {
    check('sleep 中のタブを選ぶと読み直される', false, 'sleep しているタブが無い')
  }
  process.exit(failures === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ *
 * 1-0 セキュリティ境界
 * ------------------------------------------------------------------ */

// 初期化完了の合図が「タブが揃ってから」であること。
// ここが逆転すると、外から見たときに registry が空に見える瞬間ができる。
{
  const status = await ui.ev('window.nemo.getAppStatus().then((s) => JSON.stringify(s))').then(JSON.parse)
  check(
    '初期化完了の合図は起動時のタブが揃ってから立つ',
    status.ready === true && status.windows >= 1 && status.tabs >= 1,
    JSON.stringify(status)
  )
}

const targets = await listTargets(CDP)
check(
  'ブラウザ UI は nemo:// から配信されている（file:// を使わない）',
  targets.some((t) => t.url.startsWith('nemo://ui/')) && !targets.some((t) => t.url.startsWith('file://')),
  targets.map((t) => t.url.split('?')[0]).join(', ')
)

const first = await state()
const activeKey = first.activeTabKey

for (const bad of [
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,<b>x',
  'chrome://version',
  'nemo://ui/index.html'
]) {
  await expectThrows(`許可外 scheme を拒否する: ${bad.split(':')[0]}:`, () =>
    ui.ev(`window.nemo.navigate(${JSON.stringify(activeKey)}, ${JSON.stringify(bad)})`)
  )
}

await expectThrows('他ウィンドウのタブは操作できない', () =>
  ui.ev(`window.nemo.selectTab('00000000-0000-0000-0000-000000000000')`)
)

// ブラウザ UI が外部ページへ遷移しないこと。
// 遷移できてしまうと、その外部ページに window.nemo（タブ操作・ナビゲーション）が渡る。
{
  const before = await ui.ev('location.href')
  await ui.ev(`(() => { location.href = 'https://example.com/'; return 'tried' })()`)
  await sleep(1500)
  const after = await ui.ev('location.href').catch(() => '(context lost)')
  check('ブラウザ UI は外部ページへ遷移できない', after === before, `${before} -> ${after}`)
  check(
    '遷移を試みても window.nemo は UI 以外に渡らない',
    (await ui.ev('location.protocol')) === 'nemo:',
    await ui.ev('location.protocol')
  )
}

/* ------------------------------------------------------------------ *
 * 1-2 タブとウィンドウの所有モデル
 * ------------------------------------------------------------------ */

const tabKey = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
await waitFor(
  ui,
  `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(tabKey)} && !t.loading && t.url.includes('/index.html')))`
)

{
  const s = await state()
  check('作ったタブがアクティブになる', s.activeTabKey === tabKey)
  const visible = await ui.ev('window.nemo.getVisibleTabKeys().then(v => JSON.stringify(v))').then(JSON.parse)
  check(
    '表示されている View はアクティブタブ1つだけ',
    visible.length === 1 && visible[0] === tabKey,
    JSON.stringify(visible)
  )
}

const bgKey = await ui.ev(`window.nemo.createTab('${PAGES}/login.html', { background: true }).then(k => k)`)
{
  const s = await state()
  check('背景タブはアクティブを奪わない', s.activeTabKey === tabKey, `active=${s.activeTabKey?.slice(0, 4)}`)
  const visible = await ui.ev('window.nemo.getVisibleTabKeys().then(v => JSON.stringify(v))').then(JSON.parse)
  check('背景タブは表示されない', !visible.includes(bgKey))
}

/* ------------------------------------------------------------------ *
 * 1-4 サイドバー3層（定義とタブ実体の分離）
 * ------------------------------------------------------------------ */

await ui.ev(`window.nemo.pinTab(${JSON.stringify(tabKey)}).then(() => 'ok')`)
const pinnedId = (await shared()).pinned.find((n) => n.kind === 'link' && n.url.includes('/index.html'))?.id
check('⌘D 相当でピン留めできる', Boolean(pinnedId))

await ui.ev(`window.nemo.closeTab(${JSON.stringify(tabKey)}).then(() => 'ok')`)
{
  const sh = await shared()
  const s = await state()
  check(
    'ピン留めタブを閉じても定義は残る',
    sh.pinned.some((n) => n.id === pinnedId) && !s.tabs.some((t) => t.key === tabKey)
  )
}

await ui.ev(`window.nemo.openPinned(${JSON.stringify(pinnedId)}).then(() => 'ok')`)
const reopened = await waitFor(
  ui,
  `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.pinnedId === ${JSON.stringify(pinnedId)}); return t ? t.key : '' })`
)
check('ピン留めをクリックすると開き直せる', Boolean(reopened))

// フォルダと DnD
await ui.ev(`window.nemo.createFolder('検証用').then(() => 'ok')`)
const folderId = (await shared()).pinned.find((n) => n.kind === 'folder')?.id
await ui.ev(
  `window.nemo.movePinned(${JSON.stringify(pinnedId)}, ${JSON.stringify(folderId)}, 0).then(() => 'ok')`
)
{
  const sh = await shared()
  const folder = sh.pinned.find((n) => n.id === folderId)
  check('ピン留めをフォルダに入れられる', folder?.children?.some((c) => c.id === pinnedId) === true)
}
await ui.ev(
  `window.nemo.movePinned(${JSON.stringify(folderId)}, ${JSON.stringify(folderId)}, 0).then(() => 'ok')`
)
{
  const sh = await shared()
  check(
    'フォルダを自分自身の中へは動かせない',
    sh.pinned.some((n) => n.id === folderId)
  )
}

// ピン留めの解除は全ウィンドウ・フォルダの子孫まで効く
{
  // フォルダの中にピン留めがある状態でフォルダごと消す
  const before = await state()
  const boundBefore = before.tabs.filter((t) => t.pinnedId !== null).length
  check('解除前は定義に紐づいたタブがある', boundBefore > 0, `bound=${boundBefore}`)

  await ui.ev(`window.nemo.unpin(${JSON.stringify(folderId)}).then(() => 'ok')`)
  await sleep(500)
  const sh = await shared()
  const after = await state()
  check(
    'フォルダを消すと子孫の定義も消える',
    !sh.pinned.some((n) => n.id === folderId) && !flattenIds(sh.pinned).includes(pinnedId),
    JSON.stringify(flattenIds(sh.pinned))
  )
  check(
    '定義が消えたタブは一時タブとして残る（サイドバーから消えない）',
    after.tabs.every((t) => t.pinnedId === null),
    JSON.stringify(after.tabs.map((t) => t.pinnedId))
  )
}

// Favorites
await ui.ev(`window.nemo.addFavorite(${JSON.stringify(reopened)}).then(() => 'ok')`)
{
  const sh = await shared()
  check('Favorites に追加できる', sh.favorites.length === 1, JSON.stringify(sh.favorites.map((f) => f.title)))
  await ui.ev(`window.nemo.removeFavorite(${JSON.stringify(sh.favorites[0]?.id)}).then(() => 'ok')`)
  check('Favorites から削除できる', (await shared()).favorites.length === 0)
}

// タブ行をピン留めへドラッグする経路（UI は D&D、IPC は pinTabAt）
{
  const dragKey = await ui.ev(`window.nemo.createTab('${PAGES}/login.html')`)
  await ui.ev(`window.nemo.createFolder('落とし先').then(() => 'ok')`)
  const target = (await shared()).pinned.find((n) => n.kind === 'folder')?.id
  await ui.ev(
    `window.nemo.pinTabAt(${JSON.stringify(dragKey)}, ${JSON.stringify(target)}, 0).then(() => 'ok')`
  )
  {
    const sh = await shared()
    const folder = sh.pinned.find((n) => n.id === target)
    const s2 = await state()
    check(
      'タブをフォルダへ落とすと、その中にピン留めされる',
      folder?.children?.[0]?.url?.includes('/login.html') === true,
      JSON.stringify(folder?.children?.map((c) => c.title))
    )
    check(
      '落としたタブは同じ定義に紐づく（別 ID を作らない）',
      s2.tabs.find((t) => t.key === dragKey)?.pinnedId === folder?.children?.[0]?.id
    )
  }
  // すでにピン留め済みのタブを掴み直したときは、定義を作らず場所だけ動かす。
  // 作り直すと ID が変わり、他ウィンドウで開いている同じピン留めの紐付けが切れる
  const definitionsBefore = flattenIds((await shared()).pinned).length
  await ui.ev(`window.nemo.pinTabAt(${JSON.stringify(dragKey)}, null, 0).then(() => 'ok')`)
  {
    const sh = await shared()
    check(
      'ピン留め済みのタブを落とし直しても定義は増えない',
      flattenIds(sh.pinned).length === definitionsBefore,
      `${definitionsBefore} -> ${flattenIds(sh.pinned).length}`
    )
    check('落とした位置（先頭）に移る', sh.pinned[0]?.url?.includes('/login.html') === true)
    await ui.ev(`window.nemo.unpin(${JSON.stringify(sh.pinned[0]?.id)}).then(() => 'ok')`)
    await ui.ev(`window.nemo.unpin(${JSON.stringify(target)}).then(() => 'ok')`)
  }
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(dragKey)}).then(() => 'ok')`)
}

// 落とし先の位置は「掴んだ場所」で前後してはいけない（実装が「抜いてから挿す」なので
// 補正しないと、上から動かしたときだけ1つ後ろに入る）
{
  const ids = []
  for (const name of ['A', 'B', 'C']) {
    await ui.ev(`window.nemo.createFolder(${JSON.stringify(name)}).then(() => 'ok')`)
    ids.push((await shared()).pinned.at(-1))
  }
  const titles = () =>
    shared().then((sh) => sh.pinned.filter((n) => ids.some((i) => i.id === n.id)).map((n) => n.title))
  const at = async (title) => (await shared()).pinned.findIndex((n) => n.title === title)

  // A を C の位置へ（下へ動かす）→ C の手前
  await ui.ev(`window.nemo.movePinned(${JSON.stringify(ids[0].id)}, null, ${await at('C')}).then(() => 'ok')`)
  check(
    '同じ階層で下へ動かすと、落とした行の手前に入る',
    (await titles()).join('') === 'BAC',
    (await titles()).join('')
  )

  // C を A の位置へ（上へ動かす）→ A の手前
  await ui.ev(`window.nemo.movePinned(${JSON.stringify(ids[2].id)}, null, ${await at('A')}).then(() => 'ok')`)
  check(
    '同じ階層で上へ動かしても、落とした行の手前に入る',
    (await titles()).join('') === 'BCA',
    (await titles()).join('')
  )

  for (const node of ids) await ui.ev(`window.nemo.unpin(${JSON.stringify(node.id)}).then(() => 'ok')`)
}

// サイドバーの並び（見出しを置かず、一時タブの先頭に「New Tab」を出す）
{
  const dom = JSON.parse(
    await ui.ev(`JSON.stringify({
      todayLabel: document.body.innerText.includes('今日のタブ'),
      newTabRow: Boolean(document.querySelector('.row.new-tab')),
      newTabLabel: document.querySelector('.row.new-tab .tt')?.textContent ?? '',
      newTabAboveTabs: (() => {
        const rows = [...document.querySelectorAll('.scroll .row')]
        const at = rows.findIndex((r) => r.classList.contains('new-tab'))
        return at >= 0 && rows.slice(at + 1).every((r) => !r.classList.contains('pin'))
      })(),
      tabsDraggable: Boolean(document.querySelector('.scroll .row[draggable="true"]')),
      // 行の高さと閉じる（×）の当たり判定は DESIGN.md「サイズ」の値そのもの。
      // **実測値を出す**（セレクタが外れて 0 のまま PASS するのを防ぐ）
      rowHeight: (() => {
        const row = document.querySelector('.scroll .row.new-tab')
        return row ? Math.round(row.getBoundingClientRect().height) : 0
      })(),
      closeBox: (() => {
        const x = document.querySelector('.scroll .row .x')
        if (!x) return null
        const rect = x.getBoundingClientRect()
        return [Math.round(rect.width), Math.round(rect.height)]
      })(),
      // アドレスバーとナビゲーションはツールバーへ移した（サイドバーには無い）
      noAddress: !document.querySelector('.address'),
      noNavRow: !document.querySelector('.nav-row')
    })`)
  )
  check('一時タブに見出し（今日のタブ）を出さない', dom.todayLabel === false)
  check('「New Tab」行がある', dom.newTabRow)
  check('「New Tab」の文言', dom.newTabLabel === 'New Tab', dom.newTabLabel)
  check('「New Tab」はピン留めより下・一時タブより上にある', dom.newTabAboveTabs)
  check('タブ行はドラッグできる（ピン留めへ落とせる）', dom.tabsDraggable)
  check('行の高さは 40px', dom.rowHeight === 40, `${dom.rowHeight}px`)
  check(
    '閉じる（×）の当たり判定は 26×26',
    Array.isArray(dom.closeBox) && dom.closeBox[0] === 26 && dom.closeBox[1] === 26,
    JSON.stringify(dom.closeBox)
  )
  check('サイドバーにアドレスバーとナビ行を置かない', dom.noAddress && dom.noNavRow)
}

/*
 * ツールバー（アドレスバーはページ領域の上端。DESIGN.md「ツールバー」）。
 *
 * main の bounds は CDP から直接見られないので、**View ごとの innerWidth /
 * innerHeight の関係**で確かめる（サイドバーは全高・ページはツールバーぶん低い）。
 */
{
  await ui.ev("window.nemo.setSidebarVisible(true).then(() => 'ok')")
  // **ウィンドウ ID まで指定して繋ぐ**。破棄したウィンドウの UI ターゲットも
  // しばらく `/json/list` に残るので、`view=toolbar` の先頭を拾うと
  // 死んだウィンドウの View に繋がって IPC が unknown_sender で弾かれる。
  const windowId = (await state()).windowId
  const toolbar = await connectUi(CDP, `toolbar&window=${windowId}`)
  const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html?probe=toolbar`)})`)
  const page = await connectTo(CDP, 'probe=toolbar')
  const size = async (session) => JSON.parse(await session.ev('JSON.stringify([innerWidth, innerHeight])'))
  const [sideW, sideH] = await size(ui)
  const [barW, barH] = await size(toolbar)
  const [pageW, pageH] = await size(page)

  check('サイドバーの幅は 260px', sideW === 260, `${sideW}px`)
  check('ツールバーの高さは 40px', barH === 40, `${barH}px`)
  check('ツールバーはサイドバーの右を埋める', barW > 0 && barW === pageW, `bar=${barW} page=${pageW}`)
  check(
    'ページはツールバーぶん下がる（サイドバーとの高さの差が 40px）',
    sideH - pageH === 40,
    `sidebar=${sideH} page=${pageH}`
  )

  const addr = await toolbar.ev(
    "(() => { const el = document.querySelector('.toolbar .addr .u'); return el ? el.textContent : '' })()"
  )
  check('アドレスバーが現在のページを出す', addr.includes(new URL(PAGES).host), addr)

  page.close()
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
  toolbar.close()
}

/* ------------------------------------------------------------------ *
 * 1-5 コマンドバーの補完
 * ------------------------------------------------------------------ */

{
  const suggestions = await ui
    .ev(`window.nemo.suggest('login').then(s => JSON.stringify(s))`)
    .then(JSON.parse)
  check(
    'コマンドバーが開いているタブを候補に出す',
    suggestions.some((s) => s.kind === 'tab'),
    suggestions.map((s) => s.kind).join(',')
  )
  const search = await ui
    .ev(`window.nemo.suggest('これは検索語').then(s => JSON.stringify(s))`)
    .then(JSON.parse)
  check('URL に見えない入力は検索に回る', search[0]?.kind === 'search', search[0]?.subtitle ?? '')
}

/* ------------------------------------------------------------------ *
 * 1-5c 候補の上下移動（↑↓ と ⌃P / ⌃N）と、コマンドバーの縦位置
 * ------------------------------------------------------------------ */

{
  await openCommandBar('command-bar')
  await overlay.ev(`(() => {
    const input = document.querySelector('.cmd input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'login')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  // 2件以上出ていないと「動いた」ことを見分けられない
  await waitFor(overlay, `document.querySelectorAll('.cmd .sug:not(.dim)').length >= 2 ? 'ready' : ''`)

  /** 何番目の候補が選ばれているか。 */
  const cursor = () =>
    overlay.ev(`[...document.querySelectorAll('.cmd .sug')].findIndex((r) => r.classList.contains('on'))`)

  /**
   * 入力欄にキーを撃つ。`ctrl` を渡すと ⌃ 付きで撃つ。
   * **戻り値は defaultPrevented**。macOS の入力欄は ⌃P / ⌃N を行移動として
   * 既定で食うので、止められているかどうかまで見ないと意味がない。
   */
  const press = (k, ctrl = false) =>
    overlay.ev(`(() => {
      const input = document.querySelector('.cmd input')
      const e = new KeyboardEvent('keydown', {
        key: ${JSON.stringify(k)},
        ctrlKey: ${ctrl},
        bubbles: true,
        cancelable: true
      })
      input.dispatchEvent(e)
      return e.defaultPrevented
    })()`)

  check('開いた直後は先頭の候補が選ばれている', (await cursor()) === 0, String(await cursor()))

  const downPrevented = await press('n', true)
  check('⌃N で1つ下へ動く', (await cursor()) === 1, String(await cursor()))
  check('⌃N は既定動作を止める（キャレットだけ動くのを防ぐ）', downPrevented === true)

  await press('n', true)
  check('⌃N を続けて撃つとさらに下へ動く', (await cursor()) === 2, String(await cursor()))

  const upPrevented = await press('p', true)
  check('⌃P で1つ上へ戻る', (await cursor()) === 1, String(await cursor()))
  check('⌃P は既定動作を止める', upPrevented === true)

  await press('ArrowDown')
  check('↑↓ も従来どおり効く', (await cursor()) === 2, String(await cursor()))

  await press('p', true)
  await press('p', true)
  await press('p', true)
  check('先頭より上へは行かない', (await cursor()) === 0, String(await cursor()))

  // ⌃ が付いていない素の n / p は文字入力なので、候補を動かしてはいけない
  const before = await cursor()
  await press('n')
  check('⌃ の付かない n は候補を動かさない', (await cursor()) === before, String(await cursor()))

  /* --- 縦位置。箱の中心が画面の中心よりわずかに上に来ること --- */

  // 実ウィンドウをリサイズする API は無いので、ビューポートだけ差し替えて CSS の効きを見る。
  // 位置も高さの上限も vh で決まるので、これで両端（既定と最小 minHeight 480px）を確かめられる。
  for (const [w, h] of [
    [1280, 860],
    [640, 480]
  ]) {
    await overlay.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 0,
      mobile: false
    })
    await sleep(300)

    const box = await overlay
      .ev(
        `JSON.stringify({ vh: innerHeight, box: document.querySelector('.cmd').getBoundingClientRect().toJSON() })`
      )
      .then(JSON.parse)
    const delta = Math.round(box.box.top + box.box.height / 2 - box.vh / 2)
    check(`${box.vh}px の窓: コマンドバーの中心が画面中心より上`, delta < 0, `${delta}px`)

    // 候補は kind ごとに 4 件（全体 12 件）で頭打ちなので、履歴だけでは満杯にできない。
    // 高さの上限（`.sugs` の max-height）が効いているかを見たいので、行を複製して膨らませる。
    const full = await overlay
      .ev(
        `(() => {
          const list = document.querySelector('.sugs')
          const seed = list.querySelector('.sug')
          while (list.children.length < 12) list.appendChild(seed.cloneNode(true))
          const b = document.querySelector('.cmd').getBoundingClientRect()
          return JSON.stringify({ bottom: b.bottom, vh: innerHeight, rows: list.children.length })
        })()`
      )
      .then(JSON.parse)
    check(
      `${box.vh}px の窓: 候補が満杯でもコマンドバーの下がはみ出さない`,
      full.bottom <= full.vh,
      `bottom=${Math.round(full.bottom)} / vh=${full.vh}`
    )

    // 複製した行を消すため、入力し直して候補を作り直す
    await overlay.ev(`(() => {
      const input = document.querySelector('.cmd input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'login')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(400)
  }
  await overlay.send('Emulation.clearDeviceMetricsOverride')

  await ui.ev(`window.nemo.setOverlay(null).then(() => 'ok')`)
  await waitFor(overlay, `document.querySelector('.cmd') ? '' : 'closed'`)
}

/* ------------------------------------------------------------------ *
 * 1-5b コマンドバーの決定先（⌘T は新規タブ / ⌘L は現在のタブ）
 * ------------------------------------------------------------------ */

/** オーバーレイのコマンドバーを開き、**開いた直後の**モードと入力値を返す。 */
async function openCommandBar(kind) {
  await ui.ev(`window.nemo.setOverlay(${JSON.stringify(kind)}).then(() => 'ok')`)
  await waitFor(overlay, `document.querySelector('.cmd') ? 'open' : ''`)
  // 開いた直後の姿を見る（`.cmd` が出てから読む。後から埋まる作りだと FAIL する）
  return await overlay
    .ev(
      `(() => {
        const c = document.querySelector('.cmd')
        return JSON.stringify({ mode: c.dataset.mode, value: c.querySelector('input').value })
      })()`
    )
    .then(JSON.parse)
}

/**
 * コマンドバーを開いて入力し、Enter で決定する。
 *
 * React の制御 input なので `input.value = ...` では onChange が走らない。
 * ネイティブの setter で書いてから `input` イベントを投げる。
 */
async function submitCommandBar(kind, text, { shift = false } = {}) {
  const { mode } = await openCommandBar(kind)
  await overlay.ev(`(() => {
    const input = document.querySelector('.cmd input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  // 候補が出てからでないと Enter が空振りする（決定は候補に対して効く）
  await waitFor(overlay, `document.querySelectorAll('.cmd .sug:not(.dim)').length`)
  await overlay.ev(`(() => {
    const input = document.querySelector('.cmd input')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: ${shift} }))
    return 'ok'
  })()`)
  await waitFor(overlay, `document.querySelector('.cmd') ? '' : 'closed'`)
  return mode
}

{
  const before = await state()
  const beforeKey = before.activeTabKey
  const beforeUrl = before.tabs.find((t) => t.key === beforeKey)?.url ?? ''

  // ⌘L は「現在の URL を編集する」入り口なので、開いた時点で URL が入っていること。
  // バーの中で状態を購読すると、開いた瞬間はまだ取得できておらず空欄になる（実際に踏んだ）。
  {
    const opened = await openCommandBar('address-bar')
    check('⌘L のコマンドバーは現在の URL が入った状態で開く', opened.value === beforeUrl, opened.value)
    await ui.ev(`window.nemo.setOverlay(null).then(() => 'ok')`)
    const emptied = await openCommandBar('command-bar')
    check('⌘T のコマンドバーは空で開く', emptied.value === '', emptied.value)
    await ui.ev(`window.nemo.setOverlay(null).then(() => 'ok')`)
  }

  // ⌘T / ＋ ボタン: 今のタブを潰さず新しいタブで開く
  const mode = await submitCommandBar('command-bar', `${PAGES}/index.html?probe=cmdbar-new`)
  check('⌘T のコマンドバーは新規タブモードで開く', mode === 'new-tab', mode)
  const after = await state()
  check(
    '⌘T のコマンドバーの Enter は新しいタブを開く',
    after.tabs.length === before.tabs.length + 1 && after.activeTabKey !== beforeKey,
    `tabs ${before.tabs.length}→${after.tabs.length}`
  )
  check(
    '⌘T のコマンドバーは今のタブを上書きしない',
    after.tabs.find((t) => t.key === beforeKey)?.url === beforeUrl,
    after.tabs.find((t) => t.key === beforeKey)?.url ?? '(消えた)'
  )

  // ⌘L: 今のタブで開く
  const openedKey = after.activeTabKey
  const addressMode = await submitCommandBar('address-bar', `${PAGES}/index.html?probe=cmdbar-same`)
  check('⌘L のコマンドバーはアドレスモードで開く', addressMode === 'address', addressMode)
  const replaced = await state()
  check(
    '⌘L のコマンドバーの Enter は今のタブで開く',
    replaced.tabs.length === after.tabs.length && replaced.activeTabKey === openedKey,
    `tabs ${after.tabs.length}→${replaced.tabs.length}`
  )
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(openedKey)} && t.url.includes('probe=cmdbar-same')))`
  )

  // ⇧Enter は既定の逆（アドレスモードなら新規タブ）
  await submitCommandBar('address-bar', `${PAGES}/index.html?probe=cmdbar-shift`, { shift: true })
  const shifted = await state()
  check(
    '⇧Enter は既定の逆に開く（アドレスモードでも新規タブ）',
    shifted.tabs.length === replaced.tabs.length + 1 && shifted.activeTabKey !== openedKey,
    `tabs ${replaced.tabs.length}→${shifted.tabs.length}`
  )

  // 後片付け（この検証で開いたタブを閉じる）
  for (const tab of shifted.tabs) {
    if (tab.url.includes('probe=cmdbar')) {
      await ui.ev(`window.nemo.closeTab(${JSON.stringify(tab.key)}).then(() => 'ok')`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 1-6 一日使うために必要な機能
 * ------------------------------------------------------------------ */

// ページ内検索
{
  const s = await state()
  const key = s.activeTabKey
  await ui.ev(`window.nemo.find(${JSON.stringify(key)}, 'Nemo').then(() => 'ok')`)
  const total = await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.find && s.find.totalMatches > 0 ? s.find.totalMatches : 0)`
  )
  check('ページ内検索がヒット数を返す', total > 0, `matches=${total}`)
  await ui.ev(`window.nemo.stopFind(${JSON.stringify(key)}).then(() => 'ok')`)
  check('ページ内検索を終了できる', (await state()).find === null)
}

// zoom
{
  const key = (await state()).activeTabKey
  const zoom = await ui.ev(`window.nemo.setZoom(${JSON.stringify(key)}, 1.5).then(z => z)`)
  check('zoom を変更できる', Math.abs(zoom - 1.5) < 0.001, String(zoom))
  const clamped = await ui.ev(`window.nemo.setZoom(${JSON.stringify(key)}, 99).then(z => z)`)
  check('zoom は上限で頭打ちになる', clamped === 5, String(clamped))
  await ui.ev(`window.nemo.setZoom(${JSON.stringify(key)}, 1).then(z => z)`)
}

// ダウンロード
{
  const key = (await state()).activeTabKey
  await ui.ev(
    `window.nemo.navigate(${JSON.stringify(key)}, '${PAGES}/__nemo_download__').catch(() => 'download')`
  )
  const done = await waitFor(
    ui,
    `window.nemo.getSharedState().then(s => { const d = s.downloads[0]; return d && d.state === 'completed' ? d.filename : '' })`,
    { timeoutMs: 15000 }
  )
  check('ダウンロードが完了として記録される', done.startsWith('nemo-verify'), done)
  await ui.ev('window.nemo.clearDownloads().then(() => "ok")')
  check('終わったダウンロードを消せる', (await shared()).downloads.length === 0)
}

// 外部 protocol（既定は拒否、確認を挟む）
// ここから先はページ側から操作するので、**この検証専用の URL** で開く。
// 同じ URL のタブが他にもあると connectTo が別のタブにつながり、
// 「背景タブからの要求」になってダイアログが出ない（実際に踏んだ）。
{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html?probe=external').then(k => k)`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(key)} && !t.loading))`
  )
  const page = await connectTo(CDP, 'probe=external')
  await page.ev(`(() => { location.href = 'mailto:someone@example.com'; return 'ok' })()`)
  const kind = await waitFor(
    overlay,
    `(() => { const d = document.querySelector('[data-testid]'); return d ? d.getAttribute('data-testid') : '' })()`
  )
  check('外部 protocol は確認ダイアログを出す（無条件に OS へ渡さない）', kind === 'prompt-external', kind)
  await overlay.ev(
    `(() => { const b = [...document.querySelectorAll('.dialog-actions button')].find(x => x.textContent === '開かない'); b.click(); return 'ok' })()`
  )
  page.close()
}

// 権限ダイアログ（要求元は**アクティブなタブ**でなければならない。
// 背景タブからの要求は Chromium 側で保留され、ダイアログまで届かない）
{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html?probe=permission').then(k => k)`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(key)} && !t.loading))`
  )
  const page = await connectTo(CDP, 'probe=permission')
  void page
    .ev(`new Promise(r => navigator.geolocation.getCurrentPosition(() => r('ok'), () => r('denied')))`)
    .catch(() => {})
  const kind = await waitFor(
    overlay,
    `(() => { const d = document.querySelector('[data-testid]'); return d ? d.getAttribute('data-testid') : '' })()`
  )
  check('権限要求はダイアログを出す（自動許可しない）', kind === 'prompt-permission', kind)

  // オーバーレイを読み直しても、答え待ちのダイアログが戻ること。
  // 戻らないと permission / auth の callback が未解決のまま残り、ページが止まる
  // （起動直後は「ダイアログを送る側」が「購読する側」より先に動きうる）。
  await overlay.send('Page.reload')
  const afterReload = await waitFor(
    overlay,
    `(() => { const d = document.querySelector('[data-testid]'); return d ? d.getAttribute('data-testid') : '' })()`,
    { timeoutMs: 15000 }
  ).catch(() => '')
  check(
    'オーバーレイを読み直しても答え待ちのダイアログが戻る',
    afterReload === 'prompt-permission',
    afterReload
  )

  await overlay.ev(
    `(() => { const b = [...document.querySelectorAll('.dialog-actions button')].find(x => x.textContent === '許可しない'); b.click(); return 'ok' })()`
  )
  await sleep(500)
  check(
    '答えたらダイアログが閉じる',
    (await overlay.ev(`document.querySelector('[data-testid]') ? 'open' : 'closed'`)) === 'closed'
  )
  page.close()
}

/* ------------------------------------------------------------------ *
 * 2本指スワイプ / スーパーリロード（dev 常用で足りなかった分）
 * ------------------------------------------------------------------ */

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html')`)
  const loaded = (part) =>
    waitFor(
      ui,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${JSON.stringify(key)}); return t && !t.loading && t.url.includes('${part}') ? t.url : '' })`,
      { timeoutMs: 15000 }
    )
  await loaded('/index.html')
  await ui.ev(`window.nemo.navigate(${JSON.stringify(key)}, '${PAGES}/cache.html').then(() => 'ok')`)
  await loaded('/cache.html')

  const page = await connectTo(CDP, '/cache.html', { type: 'page' })
  check(
    'スワイプ判定はページから見えない（隔離ワールドに入っている）',
    (await page.ev('String(window.__nemoSwipeAttached)')) === 'undefined'
  )

  /**
   * トラックパッドのスワイプ相当（DOM の deltaX は指を右に払うと負）。
   *
   * 呼ぶ前に必ず間を空ける。**ページが切り替わった直後に流れ込む慣性では動かない**のが
   * 仕様なので（そうしないと戻った勢いでもう1ページ戻る）、指を離した状態から始める。
   */
  const swipe = async (deltaX, deltaY = 0) => {
    await sleep(500)
    for (let i = 0; i < 12; i += 1) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 300,
        y: 300,
        deltaX: deltaX / 12,
        deltaY: deltaY / 12,
        pointerType: 'mouse'
      })
      await sleep(10)
    }
  }

  const urlOf = () =>
    ui.ev(
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${JSON.stringify(key)}); return t ? t.url : '' })`
    )

  /** 遷移が終わるのを待つ。動かなかったときは今の URL をそのまま返して check に見せる。 */
  const urlAfterSwipe = async (part) => {
    try {
      return await loaded(part)
    } catch {
      return await urlOf()
    }
  }

  await swipe(-240)
  const moved = await urlAfterSwipe('/index.html')
  check('2本指スワイプ（指を右へ）で戻る', moved.includes('/index.html'), moved)

  await swipe(240)
  const forward = await urlAfterSwipe('/cache.html')
  check('2本指スワイプ（指を左へ）で進む', forward.includes('/cache.html'), forward)

  // iframe の中でも効くこと。`wheel` は iframe の境界を越えて親へ伝わらないので、
  // メインフレームだけに入れていると埋め込み動画や広告の上で死ぬ。
  // **子フレームの window へ直接**イベントを投げて、そこに判定が入っていることを見る
  // （座標でホイールを送ると親フレームが受けてしまい、子に入れなくても通ってしまう）
  {
    await ui.ev(`window.nemo.navigate(${JSON.stringify(key)}, '${PAGES}/iframe.html').then(() => 'ok')`)
    await loaded('/iframe.html')
    // 注入した直後は「1つ前のページの慣性」とみなす作りなので、少し待ってから始める
    await sleep(500)
    const sent = await page.ev(`(() => {
      const frame = document.querySelector('iframe').contentWindow
      for (let i = 0; i < 12; i += 1) {
        frame.dispatchEvent(new WheelEvent('wheel', { deltaX: -20, deltaY: 0, bubbles: true }))
      }
      return 'sent'
    })()`)
    const afterIframe = await urlAfterSwipe('/cache.html')
    check('iframe の中でもスワイプで戻れる', afterIframe.includes('/cache.html'), `${sent} / ${afterIframe}`)
    await ui.ev(`window.nemo.navigate(${JSON.stringify(key)}, '${PAGES}/cache.html').then(() => 'ok')`)
    await loaded('/cache.html')
  }

  // 縦に流れているジェスチャでページが飛ばないこと（読んでいる最中の誤爆）
  await swipe(-240, 400)
  await sleep(600)
  const afterVertical = await urlOf()
  check('縦に流れるジェスチャでは履歴が動かない', afterVertical.includes('/cache.html'), afterVertical)
  page.close()

  /* スーパーリロード（右クリック / ⌘⇧R）は、キャッシュ済みのサブリソースまで取り直す */
  const hits = async () => (await (await fetch(`${PAGES}/__nemo_cache_count__`)).json()).hits
  const base = await hits()
  await ui.ev(`window.nemo.reload(${JSON.stringify(key)}).then(() => 'ok')`)
  await sleep(400)
  await loaded('/cache.html')
  await sleep(400)
  const normal = await hits()
  check(
    '通常の再読み込みではキャッシュ済みのサブリソースを取り直さない',
    normal === base,
    `${base} -> ${normal}`
  )

  await ui.ev(`window.nemo.reload(${JSON.stringify(key)}, { ignoreCache: true }).then(() => 'ok')`)
  await sleep(400)
  await loaded('/cache.html')
  let hard = normal
  for (let i = 0; i < 20 && hard === normal; i += 1) {
    await sleep(300)
    hard = await hits()
  }
  check('キャッシュ無視の再読み込みでは取り直す', hard > normal, `${normal} -> ${hard}`)

  await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
}

/* ------------------------------------------------------------------ *
 * 1-2 タブの sleep / ウィンドウ間の移動
 * ------------------------------------------------------------------ */

{
  // 0.05 分（3秒）に縮めて実際に寝ることを確認する
  await ui.ev('window.nemo.updateSettings({ tabSleepMinutes: 0.05 }).then(() => "ok")')
  const asleep = await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key !== s.activeTabKey && t.asleep) ? 'slept' : '')`,
    { timeoutMs: 20000 }
  )
  check('非アクティブタブが sleep する', asleep === 'slept')
  await ui.ev('window.nemo.updateSettings({ tabSleepMinutes: 30 }).then(() => "ok")')
}

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html?probe=move').then(k => k)`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(key)} && !t.loading))`
  )
  // ページ側に印を置き、ウィンドウを移しても WebContents が作り直されていないことを見る
  const page = await connectTo(CDP, 'probe=move')
  await page.ev(`(() => { window.__nemo_move_marker = 'kept'; return 'ok' })()`)
  await ui.ev(`window.nemo.moveTabToNewWindow(${JSON.stringify(key)}).then(() => 'ok')`)
  // 移動は新しいウィンドウの UI が用意できてから走る。
  // 固定 sleep で待つと遅いマシンで間欠的に落ちるので、結果そのものを待つ。
  const gone = await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${JSON.stringify(key)}) ? '' : 'moved')`,
    { timeoutMs: 20000 }
  ).catch(() => 'still-here')
  check('移したタブは元のウィンドウから外れる', gone === 'moved', gone)
  const marker = await page.ev('window.__nemo_move_marker ?? "lost"')
  check('別ウィンドウへ移しても WebContents を作り直さない', marker === 'kept', marker)
  page.close()
}

/* ------------------------------------------------------------------ *
 * 1-9 永続化
 * ------------------------------------------------------------------ */

{
  const settings = await ui
    .ev('window.nemo.updateSettings({ searchTemplate: "ftp://x/{q}" }).then(s => JSON.stringify(s))')
    .then(JSON.parse)
  check(
    '設定は検証してから採用する（https 以外の検索テンプレートは拒否）',
    settings.searchTemplate.startsWith('https://'),
    settings.searchTemplate
  )
}

ui.close()
overlay.close()
console.log(failures === 0 ? '\nverify-phase1: すべて PASS' : `\nverify-phase1: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
