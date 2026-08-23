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
