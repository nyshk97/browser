#!/usr/bin/env node
/**
 * ピン留め / Favorites の自走検証（リネーム・遅延ロード・フォルダ1階層・専用枠）。
 *
 * CDP でブラウザ UI（`nemo://ui/?view=sidebar`）につなぎ、preload が公開している
 * API と**実際の DOM 操作**の両方で確かめる。
 *
 * 前提（`verify-all.mjs` が用意する）:
 * - Nemo が `NEMO_REMOTE_DEBUGGING_PORT` 付きで起動している
 * - テストページサーバが動いている
 * - **使い捨てのデータディレクトリ**で動いている（CDP を開けるので実プロファイルでは回さない）
 *
 * 使い方:
 *   node scripts/verify-pins.mjs              主要セット（API + UI 操作）
 *   node scripts/verify-pins.mjs --lazy-write 遅延ロードの前半（枠を作って開く）
 *   node scripts/verify-pins.mjs --lazy-read  再起動後にタブ実体が無いことを見る
 */
import { connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import { afterSessionSave } from './lib/timings.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

/** 単クリックの遅延（`InlineRename.tsx` の CLICK_DELAY_MS）。Favorites の「遅延しない」判定の閾値にも使う。 */
const CLICK_DELAY_MS = 250
/** 単クリックの遅延より確実に長く待つ。 */
const CLICK_DELAY_WAIT_MS = 600

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const json = (value) => JSON.stringify(value)

const ui = await connectUi(CDP)
const state = () => ui.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
const shared = () => ui.ev('window.nemo.getSharedState().then(s => JSON.stringify(s))').then(JSON.parse)

/** ピン留めツリーを平らにする。 */
function flatten(nodes) {
  return nodes.flatMap((node) => (node.kind === 'folder' ? [node, ...node.children] : [node]))
}

/** 検証で作ったものを全部片付ける（次のセクションに持ち越さない）。 */
async function resetDefinitions(session = ui) {
  const sh = await session
    .ev('window.nemo.getSharedState().then(s => JSON.stringify(s))')
    .then((value) => JSON.parse(value))
  for (const node of sh.pinned) await session.ev(`window.nemo.unpin(${json(node.id)}).then(() => 'ok')`)
  for (const item of sh.favorites) {
    await session.ev(`window.nemo.removeFavorite(${json(item.id)}).then(() => 'ok')`)
  }
}

/**
 * 開いているタブを全部閉じる（タブ数や行の並びを見る検証の前に揃える）。
 *
 * **1個も残さない**。1個でも残すと「サイドバーの先頭の行」が
 * 前の検証で作ったタブになり、DOM 操作の対象がずれる（実際に踏んだ）。
 */
async function closeEphemeralTabs(session = ui) {
  const s = await session
    .ev('window.nemo.getWindowState().then(s => JSON.stringify(s))')
    .then((value) => JSON.parse(value))
  for (const tab of s.tabs) {
    await session.ev(`window.nemo.closeTab(${json(tab.key)}).then(() => 'ok')`)
  }
}

/**
 * 2枚目のウィンドウを開いて、その UI に繋ぐ。
 *
 * 定義は全ウィンドウ共有なので、**変換や解除の写像は1枚では検証できない**
 * （「その他のウィンドウの変換元のタブ → null」が丸ごと抜ける）。
 */
async function openSecondWindow() {
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

/** タブ行を名前で名指しする（並び順に依存しないため、掴む行は必ずリネームで名指しする）。 */
async function labelTab(key, label) {
  await ui.ev(`window.nemo.renameTab(${json(key)}, ${json(label)}).then(() => 'ok')`)
}

const mode = process.argv[2]

/* ------------------------------------------------------------------ *
 * 遅延ロード（再起動をまたぐので2回に分けて呼ばれる）
 * ------------------------------------------------------------------ */

if (mode === '--lazy-write') {
  await resetDefinitions()
  // ピン留めと Favorite を1つずつ作り、どちらも**開いた状態**にする
  const pinTab = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(pinTab)}).then(() => 'ok')`)
  const favTab = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
  await ui.ev(`window.nemo.addFavorite(${json(favTab)}).then(() => 'ok')`)
  // Favorite にカスタムアイコン（絵文字）を付ける（再起動をまたいで残ることを見る。
  // ピンには付けない: 下の「ピン行が favicon の <img>」の検査が絵文字に変わってしまう）
  {
    const fav = (await shared()).favorites[0]
    const ok = await ui.ev(`window.nemo.setCustomIcon(${json(fav.id)}, '🏠').then(v => String(v))`)
    check('Favorite に絵文字のカスタムアイコンを付けられる', ok === 'true', ok)
  }
  // 一時タブにリネームを付ける（再起動をまたいで残ることを見る）
  const tmpTab = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(k => k)`)
  await ui.ev(`window.nemo.renameTab(${json(tmpTab)}, '作業用').then(() => 'ok')`)

  // `/index.html` は favicon を出す。**定義側**に写るまで待つ（再起動後の検査の前提）
  const pinDef = await waitFor(
    ui,
    `window.nemo.getSharedState().then(s => { const n = s.pinned.find(n => n.kind === 'link'); return n && n.faviconUrl ? n.faviconUrl : '' })`,
    { timeoutMs: 15000 }
  ).catch(() => '')
  check('ページが申告した favicon がピン定義に写る', pinDef !== '', pinDef.slice(0, 60))

  const s = await state()
  check(
    '遅延ロード前提: ピンと Favorite のタブが開いている',
    s.tabs.some((t) => t.pinnedId) && s.tabs.some((t) => t.favoriteId),
    json(s.tabs.map((t) => [t.pinnedId ? 'pin' : t.favoriteId ? 'fav' : 'tmp', t.url.split('/').pop()]))
  )
  // セッション保存はデバウンスされているので、書かれるまで待つ（デバウンス 2 段の合計から導く）。
  // `verify-phase1.mjs` の `--session-write` と同じく、実際の担保は終了時の `markCleanExit()` 側
  await sleep(afterSessionSave())
  console.log('lazy-write done')
  process.exit(failures === 0 ? 0 : 1)
}

if (mode === '--lazy-read') {
  // 復元されるウィンドウは1つとは限らないので、全ウィンドウを合わせて見る
  const sidebars = (await listTargets(CDP)).filter((t) => t.url.includes('view=sidebar'))
  const windows = []
  for (const target of sidebars) {
    const session = await connectTo(CDP, new URL(target.url).search.slice(1))
    windows.push({
      session,
      state: await session.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
    })
  }
  const tabs = windows.flatMap((w) => w.state.tabs)

  check(
    '再起動後、ピン / Favorites のタブ実体が1つも無い（遅延ロード）',
    tabs.every((t) => t.pinnedId === null && t.favoriteId === null),
    json(tabs.map((t) => [t.pinnedId, t.favoriteId]))
  )

  const sh = await windows[0].session
    .ev('window.nemo.getSharedState().then(s => JSON.stringify(s))')
    .then(JSON.parse)
  check(
    '再起動後も定義（枠）は残っている',
    sh.pinned.length > 0 && sh.favorites.length > 0,
    `pinned=${sh.pinned.length} favorites=${sh.favorites.length}`
  )

  check(
    '再起動後も Favorite のカスタムアイコン（絵文字）が残る',
    sh.favorites[0]?.customIcon === '🏠',
    json(sh.favorites[0]?.customIcon)
  )
  {
    const drawn = await windows[0].session.ev(
      `(() => { const el = document.querySelector('.fav .def-emoji'); return el ? el.textContent : 'none' })()`
    )
    check('再起動後もグリッドのセルが絵文字で描かれる', drawn === '🏠', drawn)
  }

  // 版 5 から一時タブの名前は共有定義側が持つ（実体はアクティブ定義しか作られないので、
  // タブ実体の customTitle では見えないことがある）
  check(
    '一時タブに付けた名前が再起動をまたいで残る',
    (sh.ephemeralTabs ?? []).some((d) => d.customTitle === '作業用'),
    json((sh.ephemeralTabs ?? []).map((d) => d.customTitle))
  )

  // **タブを開いていなくても** favicon で描かれる（定義に持っているので頭文字に落ちない）
  {
    const pinDef = sh.pinned.find((n) => n.kind === 'link')
    check(
      '再起動後もピン定義が favicon を持っている',
      Boolean(pinDef?.faviconUrl),
      pinDef?.faviconUrl?.slice(0, 60)
    )
    const drawn = await windows[0].session.ev(
      `(() => { const row = document.querySelector('.row.pin'); if (!row) return 'no-row'; return row.querySelector('img.fi') ? 'img' : row.querySelector('.fi.letter') ? 'letter' : 'none' })()`
    )
    check('タブ実体が無くてもピン行が favicon の <img> で描かれる（頭文字ではない）', drawn === 'img', drawn)
  }

  // 初クリックでタブが生まれ、**登録 URL**が開く
  const pin = sh.pinned.find((n) => n.kind === 'link')
  if (pin) {
    const target = windows[0]
    await target.session.ev(`window.nemo.openPinned(${json(pin.id)}).then(() => 'ok')`)
    const url = await waitFor(
      target.session,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.pinnedId === ${json(pin.id)}); return t ? t.url : '' })`
    )
    check('枠をクリックすると初めてタブが生まれ、登録 URL が開く', url === pin.url, `${url} / ${pin.url}`)
  } else {
    check('枠をクリックすると初めてタブが生まれ、登録 URL が開く', false, 'ピン定義が無い')
  }

  process.exit(failures === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ *
 * リネーム（定義 / 一時タブ）
 * ------------------------------------------------------------------ */

await resetDefinitions()

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await waitFor(ui, `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(key)}))`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  const pin = (await shared()).pinned.find((n) => n.kind === 'link')
  const defaultTitle = pin?.title

  await ui.ev(`window.nemo.renameNode(${json(pin.id)}, 'ぼくの名前').then(() => 'ok')`)
  {
    const after = (await shared()).pinned.find((n) => n.id === pin.id)
    check('定義をリネームできる', after?.customTitle === 'ぼくの名前', json(after))
    check('リネームしても既定名（title）は残る', after?.title === defaultTitle, after?.title)
  }

  await ui.ev(`window.nemo.renameNode(${json(pin.id)}, null).then(() => 'ok')`)
  {
    const after = (await shared()).pinned.find((n) => n.id === pin.id)
    check('null を送るとリネームが解除され既定名に戻る', after?.customTitle === null, json(after))
  }

  // 専用タブ経由のリネームは定義側に効く
  await ui.ev(`window.nemo.renameTab(${json(key)}, 'タブ経由').then(() => 'ok')`)
  {
    const after = (await shared()).pinned.find((n) => n.id === pin.id)
    check('専用タブのリネームは所属定義に効く', after?.customTitle === 'タブ経由', json(after))
  }

  // 専用タブの名前は**定義側が正**。コマンドバーもそこを見ないと、
  // 新しい名前では「開いているタブ」候補に出ず、古い名前のままで候補に残る。
  //
  // 判定は**そのタブの key** で行う。名前で数えると、URL に一致した他のタブや履歴の候補まで
  // 拾って意味の無い assertion になる（既定名が URL なので必ず起きる）。
  {
    await ui.ev(`window.nemo.renameTab(${json(key)}, 'あたらしい名前').then(() => 'ok')`)
    const suggestFor = (query) =>
      ui.ev(`window.nemo.suggest(${json(query)}).then(s => JSON.stringify(s))`).then(JSON.parse)
    const hasThisTab = (items) => items.some((item) => item.kind === 'tab' && item.target.key === key)

    check('リネーム後の名前で「開いているタブ」候補に出る', hasThisTab(await suggestFor('あたらしい名前')))
    check('古い名前ではそのタブの候補に出ない', !hasThisTab(await suggestFor('タブ経由')))
  }

  await ui.ev(`window.nemo.unpin(${json(pin.id)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
}

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
  await ui.ev(`window.nemo.renameTab(${json(key)}, '一時タブの名前').then(() => 'ok')`)
  const tab = (await state()).tabs.find((t) => t.key === key)
  check('一時タブをリネームできる', tab?.customTitle === '一時タブの名前', json(tab?.customTitle))

  await ui.ev(`window.nemo.renameTab(${json(key)}, '   ').then(() => 'ok')`)
  const cleared = (await state()).tabs.find((t) => t.key === key)
  check('空にすると一時タブのリネームも解除される', cleared?.customTitle === null, json(cleared?.customTitle))

  // リネーム済みの一時タブをピン留め / Favorites へ移しても名前が残る
  await ui.ev(`window.nemo.renameTab(${json(key)}, '持ち込んだ名前').then(() => 'ok')`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  {
    const pin = (await shared()).pinned.find((n) => n.kind === 'link')
    check(
      'リネーム済みの一時タブをピン留めしても名前が残る',
      pin?.customTitle === '持ち込んだ名前',
      json(pin?.customTitle)
    )
    await ui.ev(`window.nemo.addFavorite(${json(key)}).then(() => 'ok')`)
    const favorite = (await shared()).favorites[0]
    check(
      '変換（ピン → Favorites）でも名前が残る',
      favorite?.customTitle === '持ち込んだ名前',
      json(favorite?.customTitle)
    )
  }
  await resetDefinitions()
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
}

/* ------------------------------------------------------------------ *
 * フォルダは1階層
 * ------------------------------------------------------------------ */

{
  await ui.ev(`window.nemo.createFolder('親').then(() => 'ok')`)
  await ui.ev(`window.nemo.createFolder('子').then(() => 'ok')`)
  const [parent, child] = (await shared()).pinned
  await ui.ev(`window.nemo.movePinned(${json(child.id)}, ${json(parent.id)}, 0).then(() => 'ok')`)
  const sh = await shared()
  check(
    'フォルダをフォルダの中へは動かせない（1階層）',
    sh.pinned.length === 2 && sh.pinned.every((n) => n.kind === 'folder'),
    json(sh.pinned.map((n) => [n.title, n.children?.length]))
  )
  await resetDefinitions()
}

/* ------------------------------------------------------------------ *
 * Favorites 専用枠 / 変換 / 降格
 * ------------------------------------------------------------------ */

{
  // アーカイブの検証があるので、**このセクション専用の URL**を使う。
  // 先行する検証が同じ URL をアーカイブに残していると誤検知する（実際に踏んだ）。
  const url = `${PAGES}/index.html?fav=dedicated`
  const key = await ui.ev(`window.nemo.createTab('${url}').then(k => k)`)
  await ui.ev(`window.nemo.addFavorite(${json(key)}).then(() => 'ok')`)
  const favorite = (await shared()).favorites[0]
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)

  await ui.ev(`window.nemo.openFavorite(${json(favorite.id)}).then(() => 'ok')`)
  const opened = await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.favoriteId === ${json(favorite.id)}); return t ? t.key : '' })`
  )
  {
    const tab = (await state()).tabs.find((t) => t.key === opened)
    check('openFavorite で作ったタブは favoriteId を持つ', tab?.favoriteId === favorite.id)
    check('そのタブは pinnedId を持たない（排他）', tab?.pinnedId === null, json(tab?.pinnedId))
  }

  // 同じ枠を2回押しても増えない
  await ui.ev(`window.nemo.openFavorite(${json(favorite.id)}).then(() => 'ok')`)
  {
    const bound = (await state()).tabs.filter((t) => t.favoriteId === favorite.id)
    check('同じ Favorite の枠は 1 ウィンドウ 1 タブ', bound.length === 1, `${bound.length} 個`)
  }

  // Favorite のタブを閉じてもアーカイブに載らない
  await ui.ev(`window.nemo.closeTab(${json(opened)}).then(() => 'ok')`)
  {
    const archive = await ui.ev(`window.nemo.queryArchive('').then(a => JSON.stringify(a))`).then(JSON.parse)
    check(
      'Favorite のタブを閉じてもアーカイブに載らない',
      !archive.some((entry) => entry.url === favorite.url),
      json(archive.map((entry) => entry.url))
    )
    const sh = await shared()
    check(
      'Favorite のタブを閉じても定義は残る',
      sh.favorites.some((f) => f.id === favorite.id)
    )
  }
  await resetDefinitions()
}

/* 降格しても名前が残ること（経路ごとに見る） */
{
  /** 名前つきの定義に属するタブを作って、`operate` の後の customTitle を返す。 */
  const demote = async (kind, name, operate) => {
    const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html?d=${kind}').then(k => k)`)
    await ui.ev(`window.nemo.${kind === 'fav' ? 'addFavorite' : 'pinTab'}(${json(key)}).then(() => 'ok')`)
    const sh = await shared()
    const definition = kind === 'fav' ? sh.favorites[0] : flatten(sh.pinned).find((n) => n.kind === 'link')
    await ui.ev(`window.nemo.renameNode(${json(definition.id)}, ${json(name)}).then(() => 'ok')`)
    await operate(definition)
    await sleep(300)
    const tab = (await state()).tabs.find((t) => t.key === key)
    await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
    await resetDefinitions()
    return tab
  }

  const unpinned = await demote('pin', 'ピンの名前', (definition) =>
    ui.ev(`window.nemo.unpin(${json(definition.id)}).then(() => 'ok')`)
  )
  check(
    '降格（ピン留めを解除）しても名前が残る',
    unpinned?.customTitle === 'ピンの名前' && unpinned?.pinnedId === null,
    json(unpinned?.customTitle)
  )

  const unfavored = await demote('fav', 'お気に入りの名前', (definition) =>
    ui.ev(`window.nemo.removeFavorite(${json(definition.id)}).then(() => 'ok')`)
  )
  check(
    '降格（Favorites から外す）しても名前が残る',
    unfavored?.customTitle === 'お気に入りの名前' && unfavored?.favoriteId === null,
    json(unfavored?.customTitle)
  )

  const orphaned = await demote('pin', 'フォルダの中のピン', async (definition) => {
    await ui.ev(`window.nemo.createFolder('入れ物').then(() => 'ok')`)
    const folder = (await shared()).pinned.find((n) => n.kind === 'folder')
    await ui.ev(`window.nemo.movePinned(${json(definition.id)}, ${json(folder.id)}, 0).then(() => 'ok')`)
    await ui.ev(`window.nemo.unpin(${json(folder.id)}).then(() => 'ok')`)
  })
  check(
    '降格（フォルダごと削除で巻き添え）しても名前が残る',
    orphaned?.customTitle === 'フォルダの中のピン' && orphaned?.pinnedId === null,
    json(orphaned?.customTitle)
  )
}

/* 変換で「同じ窓の先客タブ」が降格すること */
{
  const first = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.addFavorite(${json(first)}).then(() => 'ok')`)
  const favorite = (await shared()).favorites[0]
  await ui.ev(`window.nemo.renameNode(${json(favorite.id)}, '先客の名前').then(() => 'ok')`)

  // 同じ URL の別タブをピン留め → Favorite 定義がピンへ変換され、先客は降格する
  const second = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(second)}).then(() => 'ok')`)
  await sleep(300)
  {
    const s = await state()
    const sh = await shared()
    const older = s.tabs.find((t) => t.key === first)
    const newer = s.tabs.find((t) => t.key === second)
    check('変換で操作中のタブが変換先の定義に属する', Boolean(newer?.pinnedId), json(newer?.pinnedId))
    check('変換で元の定義（Favorite）が消える', sh.favorites.length === 0, json(sh.favorites))
    check(
      '同じ窓の先客タブは一時タブへ降格し、名前が残る',
      older?.favoriteId === null && older?.pinnedId === null && older?.customTitle === '先客の名前',
      json([older?.favoriteId, older?.pinnedId, older?.customTitle])
    )
  }
  await resetDefinitions()
  await ui.ev(`window.nemo.closeTab(${json(first)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(second)}).then(() => 'ok')`)
}

/* 変換が**別ウィンドウ**のタブにも効くこと（写像の3行目） */
{
  await resetDefinitions()
  const url = `${PAGES}/index.html?convert=cross-window`
  const here = await ui.ev(`window.nemo.createTab('${url}').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(here)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
  await ui.ev(`window.nemo.renameNode(${json(pin.id)}, '別窓にも出る名前').then(() => 'ok')`)

  // 2枚目のウィンドウで同じピンを開く（＝同じ定義に属するタブが2つの窓にある）
  const other = await openSecondWindow()
  await other.ev(`window.nemo.openPinned(${json(pin.id)}).then(() => 'ok')`)
  const otherKey = await waitFor(
    other,
    `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.pinnedId === ${json(pin.id)}); return t ? t.key : '' })`
  )

  // 1枚目で Favorites へ変換する
  await ui.ev(`window.nemo.addFavorite(${json(here)}).then(() => 'ok')`)
  await sleep(400)
  {
    const sh = await shared()
    const mine = (await state()).tabs.find((t) => t.key === here)
    const theirs = await other
      .ev('window.nemo.getWindowState().then(s => JSON.stringify(s))')
      .then((value) => JSON.parse(value).tabs.find((t) => t.key === otherKey))

    check('変換で元のピン定義が消える', flatten(sh.pinned).length === 0, json(sh.pinned))
    check(
      '操作したウィンドウのタブだけが変換先に属する',
      mine?.favoriteId === sh.favorites[0]?.id && mine?.pinnedId === null,
      json([mine?.pinnedId, mine?.favoriteId])
    )
    check(
      '**別ウィンドウ**の変換元タブは一時タブへ降格し、名前が残る',
      theirs?.pinnedId === null && theirs?.favoriteId === null && theirs?.customTitle === '別窓にも出る名前',
      json([theirs?.pinnedId, theirs?.favoriteId, theirs?.customTitle])
    )
  }

  // 解除（削除）も別ウィンドウに効くこと
  {
    const favorite = (await shared()).favorites[0]
    await other.ev(`window.nemo.openFavorite(${json(favorite.id)}).then(() => 'ok')`)
    const otherFavKey = await waitFor(
      other,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.favoriteId === ${json(favorite.id)}); return t ? t.key : '' })`
    )
    await ui.ev(`window.nemo.renameNode(${json(favorite.id)}, '解除で残る名前').then(() => 'ok')`)
    await ui.ev(`window.nemo.removeFavorite(${json(favorite.id)}).then(() => 'ok')`)
    await sleep(400)
    const theirs = await other
      .ev('window.nemo.getWindowState().then(s => JSON.stringify(s))')
      .then((value) => JSON.parse(value).tabs.find((t) => t.key === otherFavKey))
    check(
      '解除は別ウィンドウのタブにも効き、名前が残る',
      theirs?.favoriteId === null && theirs?.customTitle === '解除で残る名前',
      json([theirs?.favoriteId, theirs?.customTitle])
    )
  }

  await closeEphemeralTabs(other)
  other.close()
  await resetDefinitions()
  await closeEphemeralTabs()
}

/* ------------------------------------------------------------------ *
 * ピン URL の更新
 * ------------------------------------------------------------------ */

/** 読み込みが終わるまで待つ。終わる前に navigate すると ERR_ABORTED で投げる。 */
const loaded = (session, key, part) =>
  waitFor(
    session,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(key)} && !t.loading && t.url.includes(${json(part)})))`,
    { timeoutMs: 15000 }
  )

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await loaded(ui, key, '/index.html')
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')

  await ui.ev(`window.nemo.navigate(${json(key)}, '${PAGES}/login.html').then(() => 'ok')`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(key)} && t.url.includes('/login.html')))`
  )
  {
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('ページ遷移ではピン定義の URL は変わらない', after?.url === pin.url, after?.url)
  }

  await ui.ev(`window.nemo.updatePinnedUrl(${json(key)}).then(() => 'ok')`)
  {
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check(
      '「このページに更新」でピンの URL が差し替わる',
      after?.url?.includes('/login.html') === true,
      after?.url
    )
  }

  // 別のピンが既に持っている URL への更新は拒否される
  const other = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(k => k)`)
  await loaded(ui, other, '/iframe.html')
  await ui.ev(`window.nemo.pinTab(${json(other)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.navigate(${json(other)}, '${PAGES}/login.html').then(() => 'ok')`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(other)} && t.url.includes('/login.html')))`
  )
  {
    const before = flatten((await shared()).pinned).map((n) => n.url)
    await ui.ev(`window.nemo.updatePinnedUrl(${json(other)}).then(() => 'ok')`)
    const after = flatten((await shared()).pinned).map((n) => n.url)
    check('別のピンが持つ URL への更新は拒否される', json(before) === json(after), json(after))
  }
  await resetDefinitions()
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(other)}).then(() => 'ok')`)
}

/* ------------------------------------------------------------------ *
 * URL の明示的な変更（「URLを変更…」= Arc の Edit Pinned URL 相当）
 * ------------------------------------------------------------------ */

{
  await resetDefinitions()
  await closeEphemeralTabs()

  // ピン（favicon の**ある** /index.html）と Favorite を1つずつ作る
  const pinTab = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await loaded(ui, pinTab, '/index.html')
  await ui.ev(`window.nemo.pinTab(${json(pinTab)}).then(() => 'ok')`)
  const favTab = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
  await loaded(ui, favTab, '/login.html')
  await ui.ev(`window.nemo.addFavorite(${json(favTab)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
  const fav = (await shared()).favorites[0]

  // favicon が定義へ写るのを待つ（「host が変わったら捨てる」検査の前提を先に作る）
  await waitFor(
    ui,
    `window.nemo.getSharedState().then(s => { const p = s.pinned.find(n => n.id === ${json(pin.id)}); return p && p.faviconUrl ? 'yes' : '' })`,
    { timeoutMs: 15000 }
  )

  // 開いているタブは触らない（決定: 変わるのは「次に開くとき」だけ。開き直しで反映）
  {
    const ok = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(pin.id)}, ${json(`${PAGES}/index.html?while-open=1`)}).then(v => String(v))`
    )
    const tabUrl = (await state()).tabs.find((t) => t.key === pinTab)?.url
    check(
      '開いているタブの URL は書き換えでは変わらない',
      ok === 'true' && tabUrl === `${PAGES}/index.html`,
      `${ok} / ${tabUrl}`
    )
  }

  // 「このページに更新」と違い、タブが**閉じていても**書き換えられるのが肝
  await ui.ev(`window.nemo.closeTab(${json(pinTab)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(favTab)}).then(() => 'ok')`)

  const pinUrl2 = `${PAGES}/index.html?edited=1`
  const favUrl2 = `${PAGES}/login.html?edited=1`
  {
    const ok = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(pin.id)}, ${json(pinUrl2)}).then(v => String(v))`
    )
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check(
      'タブが閉じていてもピンの URL を書き換えられる',
      ok === 'true' && after?.url === pinUrl2,
      `${ok} / ${after?.url}`
    )
    check(
      '同じ host への変更では faviconUrl が残る',
      typeof after?.faviconUrl === 'string' && after.faviconUrl.length > 0,
      json(after?.faviconUrl)
    )
  }
  {
    const ok = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(fav.id)}, ${json(favUrl2)}).then(v => String(v))`
    )
    const after = (await shared()).favorites.find((f) => f.id === fav.id)
    check(
      'Favorite の URL も書き換えられる',
      ok === 'true' && after?.url === favUrl2,
      `${ok} / ${after?.url}`
    )
  }

  // http/https 以外は拒否され、URL は変わらない
  {
    const ok = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(pin.id)}, 'file:///etc/passwd').then(v => String(v))`
    )
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('file: URL への変更は拒否される', ok === 'false' && after?.url === pinUrl2, `${ok} / ${after?.url}`)
  }

  // 重複の拒否。ピン ↔ ピンは既存の検査にあるので、ここでは**ピン ↔ Favorite のクロス**を見る
  {
    const toFav = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(pin.id)}, ${json(favUrl2)}).then(v => String(v))`
    )
    const toPin = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(fav.id)}, ${json(pinUrl2)}).then(v => String(v))`
    )
    const pinAfter = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    const favAfter = (await shared()).favorites.find((f) => f.id === fav.id)
    check(
      'Favorite が持つ URL へのピンの変更は拒否される',
      toFav === 'false' && pinAfter?.url === pinUrl2,
      `${toFav} / ${pinAfter?.url}`
    )
    check(
      'ピンが持つ URL への Favorite の変更は拒否される',
      toPin === 'false' && favAfter?.url === favUrl2,
      `${toPin} / ${favAfter?.url}`
    )
  }

  // host が変わったら faviconUrl を捨てる（`setFaviconForDefinition` の host ガードで自動では直らないため）
  {
    const otherHost = PAGES.includes('127.0.0.1')
      ? PAGES.replace('127.0.0.1', 'localhost')
      : 'http://nemo-url-edit.invalid'
    const ok = await ui.ev(
      `window.nemo.setDefinitionUrl(${json(pin.id)}, ${json(`${otherHost}/index.html`)}).then(v => String(v))`
    )
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check(
      'host が変わる変更では faviconUrl を捨てる',
      ok === 'true' && after?.faviconUrl === null,
      `${ok} / ${json(after?.faviconUrl)}`
    )
  }

  await resetDefinitions()
  await closeEphemeralTabs()
}

/* ------------------------------------------------------------------ *
 * シークレットウィンドウでは既定名を書かない
 * ------------------------------------------------------------------ */

{
  // ピンは favicon の**無い** `/login.html` から作る。シークレット側で favicon の**ある** `/index.html`
  // （同じ host）へ遷移させ、pins.json の faviconUrl が null のままなことを見る
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
  check(
    '前提: favicon の無いページから作ったピンは faviconUrl が null',
    pin?.faviconUrl === null,
    json(pin?.faviconUrl)
  )
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)

  await ui.ev('window.nemo.createPrivateWindow().then(() => "ok")')
  const priv = await connectUi(CDP, 'sidebar', { includePrivate: true, exclude: null })
  const isPrivate = await priv.ev('window.nemo.getWindowState().then(s => s.isPrivate)')
  if (isPrivate) {
    await priv.ev(`window.nemo.openPinned(${json(pin.id)}).then(() => 'ok')`)
    const privKey = await waitFor(
      priv,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.pinnedId === ${json(pin.id)}); return t ? t.key : '' })`
    )
    await loaded(priv, privKey, '/login.html')
    await priv.ev(`window.nemo.navigate(${json(privKey)}, '${PAGES}/index.html').then(() => 'ok')`)
    await waitFor(
      priv,
      `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(privKey)} && !t.loading && t.url.includes('/index.html')))`,
      { timeoutMs: 15000 }
    )
    // favicon がシークレット側のタブに届くまで待つ（届いていないと「書かない」検査が空振りする）
    const privFavicon = await waitFor(
      priv,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.key === ${json(privKey)}); return t && t.faviconUrl ? 'yes' : '' })`,
      { timeoutMs: 15000 }
    ).catch(() => '')
    check('前提: シークレット側のタブには favicon が届いている', privFavicon === 'yes')
    await sleep(500)
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check(
      'シークレットで開いたページのタイトルを pins.json に書かない',
      after?.title === pin.title,
      `${pin.title} -> ${after?.title}`
    )
    check(
      'シークレットで届いた favicon を pins.json に書かない',
      after?.faviconUrl === null,
      json(after?.faviconUrl)
    )
    // シークレットウィンドウは閉じる（後の検証が誤って掴まないように）
    await priv.ev(
      'window.nemo.getWindowState().then(s => s.tabs.map(t => window.nemo.closeTab(t.key))).then(() => "ok")'
    )
  } else {
    check('シークレットで開いたページのタイトルを pins.json に書かない', false, 'シークレット窓に繋げない')
  }
  priv.close()
  await resetDefinitions()
}

/* ------------------------------------------------------------------ *
 * UI 操作（合成イベントでサイドバーを直接触る）
 * ------------------------------------------------------------------ */

/** ページ内で使う小道具（マウスイベントの合成）。 */
const HELPERS = `
  (() => {
    if (window.__nemoVerify) return 'ok'
    const fire = (el, type, init = {}) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }))
    window.__nemoVerify = {
      fire,
      /** 実際のブラウザと同じ click → click → dblclick の順で撃つ。 */
      doubleClick(el) {
        fire(el, 'mousedown')
        fire(el, 'mouseup')
        fire(el, 'click', { detail: 1 })
        fire(el, 'mousedown')
        fire(el, 'mouseup')
        fire(el, 'click', { detail: 2 })
        fire(el, 'dblclick', { detail: 2 })
      },
      /**
       * dragstart → dragover → drop を1本の DataTransfer で通す。
       *
       * **間を空ける**のが肝。ピン留めツリーは「何を掴んでいるか」を React の state に
       * 持つので、続けて撃つと drop の時点でまだ state が入っておらず、
       * ドロップが黙って無視される（＝実装が壊れていても PASS してしまう）。
       */
      async drag(from, to) {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const dataTransfer = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
        await wait(150)
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
        await wait(80)
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
        return 'ok'
      },
      /**
       * dragover まで撃って、**ドラッグ中の**ドロップ線の数を返す（落とさずに終える）。
       *
       * ドラッグが終わってから数えても dragend で消えているので**常に 0** になり、
       * 「線が出ない」の検証が素通りする。必ずドラッグ中に読む。
       */
      async hintFor(from, to) {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const dataTransfer = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
        await wait(150)
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
        await wait(80)
        const count = document.querySelectorAll('.row.drop').length
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
        return count
      }
    }
    return 'ok'
  })()
`

await ui.ev(HELPERS)

/** React の再描画を待ってから DOM を読む。 */
const settle = () => sleep(250)

{
  await resetDefinitions()
  await closeEphemeralTabs()

  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
  await settle()

  // --- 閉じているピン行のダブルクリックで、タブが増えずに編集だけが始まる ---
  const before = (await state()).tabs.length
  await ui.ev(
    `(() => { window.__nemoVerify.doubleClick(document.querySelector('.row.pin')); return 'ok' })()`
  )
  await sleep(CLICK_DELAY_WAIT_MS)
  {
    const editing = await ui.ev(`Boolean(document.querySelector('.row.pin .rename'))`)
    const after = (await state()).tabs.length
    check('閉じているピン行のダブルクリックで編集に入る', editing === true)
    check('そのときタブは増えない（単クリックの遅延が効いている）', after === before, `${before} -> ${after}`)
  }

  // --- 入力欄に値を入れて Enter → 定義に反映される ---
  await ui.ev(`(() => {
    const input = document.querySelector('.row.pin .rename')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'UI から付けた名前')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await settle()
  {
    const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
    check(
      'UI のインライン編集が定義に反映される',
      pin?.customTitle === 'UI から付けた名前',
      json(pin?.customTitle)
    )
    const label = await ui.ev(`document.querySelector('.row.pin .tt')?.textContent ?? ''`)
    check('サイドバーの表示も付けた名前になる', label === 'UI から付けた名前', label)
  }

  // --- 閉じているピン行のコンテキストメニューに「このページに更新」を出さない ---
  await ui.ev(`(() => {
    const row = document.querySelector('.row.pin')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 100 }))
    return 'ok'
  })()`)
  await settle()
  {
    const items = await ui
      .ev(`JSON.stringify([...document.querySelectorAll('.row-menu button')].map((b) => b.textContent))`)
      .then(JSON.parse)
    check('右クリックでメニューが出る', items.length > 0, json(items))
    check(
      '閉じているピン行には「このページに更新」を出さない',
      !items.includes('このページに更新'),
      json(items)
    )
    // メニューの「名前を変更」が編集を開始する
    await ui.ev(`(() => {
      const item = [...document.querySelectorAll('.row-menu button')].find((b) => b.textContent === '名前を変更')
      item.click()
      return 'ok'
    })()`)
    await settle()
    const editing = await ui.ev(`Boolean(document.querySelector('.row.pin .rename'))`)
    check('メニューの「名前を変更」で編集に入る', editing === true)
    // Esc で取消（名前が変わらないこと）
    await ui.ev(`(() => {
      document.querySelector('.row.pin .rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'ok'
    })()`)
    await settle()
    const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
    check(
      'Esc で取り消すと名前は変わらない',
      pin?.customTitle === 'UI から付けた名前',
      json(pin?.customTitle)
    )
  }

  // --- 開いているピン行は即座に選択される（遅延しない） ---
  await ui.ev(`window.nemo.openPinned(${json(flatten((await shared()).pinned)[0].id)}).then(() => 'ok')`)
  await settle()
  {
    const other = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
    await settle()
    await ui.ev(`(() => { document.querySelector('.row.pin').click(); return 'ok' })()`)
    // 遅延を待たずに切り替わっていること
    await sleep(120)
    const s = await state()
    const pinTab = s.tabs.find((t) => t.pinnedId !== null)
    check(
      '既に開いている専用タブの選択は遅延しない',
      s.activeTabKey === pinTab?.key,
      `${s.activeTabKey?.slice(0, 6)} / ${pinTab?.key?.slice(0, 6)}`
    )
    await ui.ev(`window.nemo.closeTab(${json(other)}).then(() => 'ok')`)
  }

  await resetDefinitions()
  await closeEphemeralTabs()
  await settle()
}

/* --- フォルダはダブルクリックでリネームしない（導線は右クリックだけ） --- */
{
  await resetDefinitions()
  await closeEphemeralTabs()

  await ui.ev(`window.nemo.createFolder('検証フォルダ').then(() => 'ok')`)
  await settle()

  const before = flatten((await shared()).pinned).find((n) => n.kind === 'folder')
  await ui.ev(
    `(() => { window.__nemoVerify.doubleClick(document.querySelector('.row.folder')); return 'ok' })()`
  )
  await sleep(CLICK_DELAY_WAIT_MS)
  {
    const editing = await ui.ev(`Boolean(document.querySelector('.row.folder .rename'))`)
    const after = flatten((await shared()).pinned).find((n) => n.kind === 'folder')
    check('フォルダのダブルクリックでは編集に入らない', editing === false)
    // 開閉が2回走って元に戻る（＝クリックはフォルダの開閉のまま）
    check(
      'ダブルクリックしても開閉の状態は元のまま',
      Boolean(after?.collapsed) === Boolean(before?.collapsed),
      `${json(before?.collapsed)} -> ${json(after?.collapsed)}`
    )
  }

  // 右クリックからは今までどおり名前を変えられる
  await ui.ev(`(() => {
    const row = document.querySelector('.row.folder')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 80 }))
    return 'ok'
  })()`)
  await settle()
  await ui.ev(`(() => {
    const item = [...document.querySelectorAll('.row-menu button')].find((b) => b.textContent === '名前を変更')
    item.click()
    return 'ok'
  })()`)
  await settle()
  check(
    'フォルダは右クリックの「名前を変更」で編集に入る',
    (await ui.ev(`Boolean(document.querySelector('.row.folder .rename'))`)) === true
  )
  await ui.ev(`(() => {
    document.querySelector('.row.folder .rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'ok'
  })()`)
  await settle()

  await resetDefinitions()
  await closeEphemeralTabs()
  await settle()
}

/* --- 一時タブを Favorites グリッドへ落として追加する（空のときと、既にあるとき） --- */
{
  await resetDefinitions()
  await closeEphemeralTabs()

  const first = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await labelTab(first, 'ドラッグ元A')
  await settle()
  check(
    'Favorites が空のときも受け皿が出る',
    (await ui.ev(`Boolean(document.querySelector('.fav-empty'))`)) === true
  )
  // 1 件も無い初回だけ messages を畳む（受け皿は tools 側の 1 つ）
  {
    const empty = JSON.parse(
      await ui.ev(
        `JSON.stringify({
           sections: [...document.querySelectorAll('.fav-empty')].map((el) => el.dataset.section),
           messagesLabel: [...document.querySelectorAll('.scroll .label')].some((l) => (l.childNodes[0]?.textContent ?? '').trim() === 'messages')
         })`
      )
    )
    check(
      '初回（全空）は受け皿が tools だけで、messages はラベルごと畳まれる',
      json(empty.sections) === json(['tools']) && !empty.messagesLabel,
      json(empty)
    )
  }

  await ui.ev(
    `window.__nemoVerify.drag(
       document.querySelector('.scroll .row[title="ドラッグ元A"]'),
       document.querySelector('.fav-empty')
     )`
  )
  await settle()
  {
    const sh = await shared()
    const tab = (await state()).tabs.find((t) => t.key === first)
    check(
      '空のグリッドへタブを落として Favorites に追加できる',
      sh.favorites.length === 1,
      json(sh.favorites.map((f) => f.customTitle ?? f.title))
    )
    check(
      '追加したタブは Favorite 定義に属する',
      tab?.favoriteId === sh.favorites[0]?.id,
      json(tab?.favoriteId)
    )
    check(
      '専用タブは一時タブ一覧に出ない',
      (await ui.ev(`!document.querySelector('.scroll .row[title="ドラッグ元A"]')`)) === true
    )
  }

  // 既に何件かあるときも足せる（受け皿の要素が別物になる）
  const second = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
  await labelTab(second, 'ドラッグ元B')
  await settle()
  await ui.ev(
    `window.__nemoVerify.drag(
       document.querySelector('.scroll .row[title="ドラッグ元B"]'),
       document.querySelector('.fav-grid')
     )`
  )
  await settle()
  {
    const sh = await shared()
    check(
      '既に何件かあるグリッドへも落とせる',
      sh.favorites.length === 2,
      json(sh.favorites.map((f) => f.customTitle ?? f.title))
    )
    check(
      'リネーム済みの一時タブを落としても名前が残る',
      sh.favorites.some((f) => f.customTitle === 'ドラッグ元B'),
      json(sh.favorites.map((f) => f.customTitle))
    )
  }

  // --- 大きい favicon でグリッドが膨らまないこと ---
  // `/index.html` は 256x256 の favicon を出す。サイズ指定が効いていないと
  // <img> が実寸で描かれ、列ごとサイドバーからはみ出す（実際に踏んだ）。
  {
    await waitFor(ui, `document.querySelector('.fav img.fi') ? 'ready' : ''`, { timeoutMs: 15000 }).catch(
      () => ''
    )
    const box = await ui
      .ev(
        `JSON.stringify((() => {
           const grid = document.querySelector('.fav-grid')
           const cell = document.querySelector('.fav')
           const icon = document.querySelector('.fav img.fi')
           return {
             sidebar: document.querySelector('.sidebar').clientWidth,
             grid: Math.round(grid.getBoundingClientRect().width),
             cell: Math.round(cell.getBoundingClientRect().width),
             cellHeight: Math.round(cell.getBoundingClientRect().height),
             icon: icon ? Math.round(icon.getBoundingClientRect().width) : null
           }
         })())`
      )
      .then(JSON.parse)
    check('大きい favicon が実寸で描かれない', box.icon !== null && box.icon <= 24, `${box.icon}px`)
    check(
      'Favorites グリッドがサイドバー幅を超えない',
      box.grid <= box.sidebar,
      `grid=${box.grid} / sidebar=${box.sidebar}`
    )
    // 列数そのものは DESIGN.md の裁量なので固定値では見ない。
    // 「1行に複数個ちゃんと並ぶ正方形」であることだけを保証する。
    check(
      'セルは1行に複数個並ぶ正方形に収まる',
      box.cell > 0 && box.cell <= box.sidebar / 3 && Math.abs(box.cell - box.cellHeight) <= 1,
      `${box.cell}x${box.cellHeight} / sidebar=${box.sidebar}`
    )
  }

  // グリッドのセルに状態（アクティブ / 閉じている）が重なる
  await ui.ev(`window.nemo.selectTab(${json(first)}).then(() => 'ok')`)
  await settle()
  check(
    '見ている Favorite のセルにアクティブ表示が出る',
    (await ui.ev(`Boolean(document.querySelector('.fav.active'))`)) === true
  )

  await ui.ev(`window.nemo.closeTab(${json(first)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(second)}).then(() => 'ok')`)
  await settle()
  {
    const sh = await shared()
    check('Favorite のタブを閉じてもセルは残る（閉じている表示になる）', sh.favorites.length === 2)
    const closed = await ui.ev(`document.querySelectorAll('.fav.closed').length`)
    check('閉じている Favorite は沈んだ表示になる', closed === 2, `${closed} 個`)
  }

  // --- 閉じている Favorite のセルは、ダブルクリックしてもリネームに入らず開くだけ ---
  // ピン行と違い**グリッドの導線は右クリックだけ**（別のコンポーネントなので別に見る）。
  // ダブルクリックしても `openFavorite` が冪等なので、タブは 1 つしか増えない
  const [firstFav, secondFav] = (await shared()).favorites
  {
    const before = (await state()).tabs.length
    await ui.ev(
      `(() => { window.__nemoVerify.doubleClick(document.querySelector('.fav[data-id=${json(firstFav.id)}]')); return 'ok' })()`
    )
    // 遅れて出てくる入力欄（退行）を見逃さない・タブ生成の反映前に数えないように、遅延ぶん待ってから読む
    await sleep(CLICK_DELAY_WAIT_MS)
    const editing = await ui.ev(`Boolean(document.querySelector('.fav-edit .rename'))`)
    const after = (await state()).tabs.length
    check('閉じている Favorite のダブルクリックでは編集に入らない', editing === false)
    check(
      'そのときタブはちょうど 1 つ増える（開くだけ。2 発目は選ぶだけ）',
      after === before + 1,
      `${before} -> ${after}`
    )
  }

  // --- 閉じている Favorite の単クリックは遅延しない（押した瞬間に開く） ---
  // `settle()`（250ms）待ちだと遅延が残っていてもタブができていて PASS してしまうので、
  // クリック直後から細かく待って**経過時間**で見る（旧実装なら 250ms 超で FAIL）
  {
    const before = (await state()).tabs.length
    await ui.ev(
      `(() => { window.__nemoVerify.fire(document.querySelector('.fav[data-id=${json(secondFav.id)}]'), 'click', { detail: 1 }); return 'ok' })()`
    )
    const t0 = Date.now()
    let elapsed = null
    try {
      await waitFor(ui, `window.nemo.getWindowState().then(s => s.tabs.length > ${before} ? 'ok' : '')`, {
        timeoutMs: 3000,
        interval: 30
      })
      elapsed = Date.now() - t0
    } catch {
      // 時間切れは check の FAIL に落とす（throw させるとスイートが止まり、修正前の FAIL を観測できない）
    }
    check(
      '閉じている Favorite の単クリックは遅延しない',
      elapsed !== null && elapsed < CLICK_DELAY_MS,
      elapsed === null ? '3 秒待ってもタブが増えなかった' : `${elapsed}ms（閾値 ${CLICK_DELAY_MS}ms）`
    )
  }

  // --- 右クリックの「名前を変更」からは編集に入り、定義に反映される ---
  await ui.ev(`(() => {
    const cell = document.querySelector('.fav[data-id=${json(firstFav.id)}]')
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 80 }))
    return 'ok'
  })()`)
  await settle()
  await ui.ev(`(() => {
    const item = [...document.querySelectorAll('.row-menu button')].find((b) => b.textContent === '名前を変更')
    item.click()
    return 'ok'
  })()`)
  await settle()
  check(
    'Favorite は右クリックの「名前を変更」で編集に入る',
    (await ui.ev(`Boolean(document.querySelector('.fav-edit .rename'))`)) === true
  )
  await ui.ev(`(() => {
    const input = document.querySelector('.fav-edit .rename')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'グリッドから付けた名前')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await settle()
  {
    const sh = await shared()
    check(
      'Favorites のインライン編集が定義に反映される',
      sh.favorites.some((f) => f.customTitle === 'グリッドから付けた名前'),
      json(sh.favorites.map((f) => f.customTitle))
    )
  }

  // 開いたタブを残さない（定義だけ消すと一時タブとして残り、次のブロックの先頭行がずれる）
  await closeEphemeralTabs()
  await resetDefinitions()
}

/* --- 「URLを変更…」の編集枠（ピン行と Favorite セル） --- */
{
  await resetDefinitions()
  await closeEphemeralTabs()

  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
  await settle()
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')

  // メニューの「URLを変更…」で編集枠が開く（初期値は今の URL）
  await ui.ev(`(() => {
    const row = document.querySelector('.row.pin')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 100 }))
    return 'ok'
  })()`)
  await settle()
  {
    const items = await ui
      .ev(`JSON.stringify([...document.querySelectorAll('.row-menu button')].map((b) => b.textContent))`)
      .then(JSON.parse)
    check('ピン行のメニューに「URLを変更…」が出る', items.includes('URLを変更…'), json(items))
  }
  await ui.ev(`(() => {
    const item = [...document.querySelectorAll('.row-menu button')].find((b) => b.textContent === 'URLを変更…')
    item.click()
    return 'ok'
  })()`)
  await settle()
  {
    const value = await ui.ev(`document.querySelector('.url-edit input')?.value ?? ''`)
    check('編集枠は今の URL を初期値に開く', value === pin.url, value)
  }

  // http/https 以外はエラーを出して、定義は変わらない
  await ui.ev(`(() => {
    const input = document.querySelector('.url-edit input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'file:///etc/passwd')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await settle()
  {
    const error = await ui.ev(`document.querySelector('.url-edit .icon-edit-error')?.textContent ?? ''`)
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('http/https 以外はエラーを出す', error.length > 0, error)
    check('そのとき定義の URL は変わらない', after?.url === pin.url, after?.url)
  }

  // 正しい URL は保存されて枠が閉じ、開き直すと新しい URL で開く
  const edited = `${PAGES}/login.html?from=url-edit`
  await ui.ev(`(() => {
    const input = document.querySelector('.url-edit input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${json(edited)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`)
  await settle()
  {
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('編集枠から URL を保存できる', after?.url === edited, after?.url)
    check('保存に成功すると枠が閉じる', (await ui.ev(`!document.querySelector('.url-edit')`)) === true)
  }
  {
    await ui.ev(`window.nemo.openPinned(${json(pin.id)}).then(() => 'ok')`)
    const opened = await waitFor(
      ui,
      `window.nemo.getWindowState().then(s => { const t = s.tabs.find(t => t.pinnedId === ${json(pin.id)}); return t ? t.url : '' })`
    )
    check('開き直すと変更後の URL で開く', opened.includes('from=url-edit'), opened)
  }

  // Favorite セル: 開いていれば「このページに更新」も出て、実際に差し替わる
  const favTab = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(k => k)`)
  await loaded(ui, favTab, '/iframe.html')
  await ui.ev(`window.nemo.addFavorite(${json(favTab)}).then(() => 'ok')`)
  await settle()
  {
    await ui.ev(`(() => {
      const cell = document.querySelector('.fav')
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
      return 'ok'
    })()`)
    await settle()
    const items = await ui
      .ev(`JSON.stringify([...document.querySelectorAll('.row-menu button')].map((b) => b.textContent))`)
      .then(JSON.parse)
    check(
      '開いている Favorite のメニューに「URLを変更…」と「このページに更新」が出る',
      items.includes('URLを変更…') && items.includes('このページに更新'),
      json(items)
    )
  }
  {
    await ui.ev(`window.nemo.navigate(${json(favTab)}, '${PAGES}/login.html?fav-current=1').then(() => 'ok')`)
    await waitFor(
      ui,
      `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(favTab)} && t.url.includes('fav-current=1')))`
    )
    await ui.ev(`window.nemo.updateFavoriteUrl(${json(favTab)}).then(() => 'ok')`)
    const favAfter = (await shared()).favorites[0]
    check(
      'Favorite の「このページに更新」で URL が差し替わる',
      favAfter?.url?.includes('fav-current=1') === true,
      favAfter?.url
    )
  }
  // 閉じている Favorite のセルには「このページに更新」を出さない（ピン行と同じ規則）
  await ui.ev(`window.nemo.closeTab(${json(favTab)}).then(() => 'ok')`)
  await settle()
  {
    await ui.ev(`(() => {
      const cell = document.querySelector('.fav')
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
      return 'ok'
    })()`)
    await settle()
    const items = await ui
      .ev(`JSON.stringify([...document.querySelectorAll('.row-menu button')].map((b) => b.textContent))`)
      .then(JSON.parse)
    check(
      '閉じている Favorite のセルには「このページに更新」を出さない',
      items.includes('URLを変更…') && !items.includes('このページに更新'),
      json(items)
    )
    // 開いたメニューは閉じておく（次の検証が誤って掴まないように）
    await ui.ev(
      `(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'ok' })()`
    )
    await settle()
  }

  await resetDefinitions()
  await closeEphemeralTabs()
  await settle()
}

/* --- ピン留め行の D&D（並べ替え・フォルダへ入れる・フォルダ同士は弾く） --- */
{
  await resetDefinitions()
  await closeEphemeralTabs()
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.createFolder('落とし先').then(() => 'ok')`)
  await settle()

  await ui.ev(
    `window.__nemoVerify.drag(document.querySelector('.row.pin'), document.querySelector('.row.folder'))`
  )
  await settle()
  {
    const folder = (await shared()).pinned.find((n) => n.kind === 'folder')
    check(
      'ピン行をフォルダ行へ落とすと中に入る',
      folder?.children?.length === 1,
      json(folder?.children?.length)
    )
  }

  // フォルダを**フォルダの中のリンク行**へ落とすのも受け付けない
  // （落とすとそのフォルダの中に入る位置なので、行がフォルダでなくても弾く必要がある）
  await ui.ev(`window.nemo.createFolder('もう1つ').then(() => 'ok')`)
  await settle()
  // まず**線が出る側**（一時タブを掴んだとき）で、合成 dragover が効いていることを確かめる。
  // これが無いと「線が 0 だった」が「dragover が届いていないだけ」と区別できない。
  {
    const tmp = await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(k => k)`)
    await labelTab(tmp, 'ドロップ線の確認')
    await settle()
    const shown = await ui.ev(
      `window.__nemoVerify.hintFor(
         document.querySelector('.scroll .row[title="ドロップ線の確認"]'),
         document.querySelector('.children .row.pin')
       )`
    )
    check('落とせる位置ではドロップ線が出る（合成 dragover が効いている）', shown === 1, `${shown} 個`)
    await ui.ev(`window.nemo.closeTab(${json(tmp)}).then(() => 'ok')`)
    await settle()
  }

  const hinted = await ui.ev(
    `(() => {
       const folders = [...document.querySelectorAll('.row.folder')]
       return window.__nemoVerify.hintFor(folders[1], document.querySelector('.children .row.pin'))
     })()`
  )
  check('フォルダを「フォルダの中のリンク行」へ重ねてもドロップ線が出ない', hinted === 0, `${hinted} 個`)

  await ui.ev(
    `(() => {
       const folders = [...document.querySelectorAll('.row.folder')]
       return window.__nemoVerify.drag(folders[1], document.querySelector('.children .row.pin'))
     })()`
  )
  await settle()
  {
    const sh = await shared()
    const folder = sh.pinned.find((n) => n.kind === 'folder')
    check(
      'フォルダを「フォルダの中のリンク行」へ落としても入らない',
      folder?.children?.every((child) => child.kind === 'link') === true &&
        sh.pinned.filter((n) => n.kind === 'folder').length === 2,
      json(sh.pinned.map((n) => [n.kind, n.title, n.children?.length]))
    )
  }

  // フォルダをフォルダへ落とすドロップも受け付けない
  await settle()
  await ui.ev(
    `(() => {
       const folders = [...document.querySelectorAll('.row.folder')]
       return window.__nemoVerify.drag(folders[1], folders[0])
     })()`
  )
  await settle()
  {
    const sh = await shared()
    check(
      'フォルダをフォルダへ落とすドロップは弾かれる',
      sh.pinned.filter((n) => n.kind === 'folder').length === 2,
      json(sh.pinned.map((n) => [n.kind, n.title]))
    )
  }

  await resetDefinitions()
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
}

/* ------------------------------------------------------------------ *
 * Favorites のセクション（tools / messages）・⌘1〜9（tools のみ）・⌘長押しの番号バッジ
 * ------------------------------------------------------------------ */

{
  await resetDefinitions()
  await closeEphemeralTabs()
  const settleUi = () => sleep(250)

  /** N 個の Favorite を作って ID の配列を返す（全部 `tools` に入る）。 */
  const makeFavorites = async (n, prefix) => {
    const ids = []
    for (let i = 0; i < n; i += 1) {
      const key = await ui.ev(`window.nemo.createTab('${PAGES}/login.html?${prefix}${i}').then(k => k)`)
      await ui.ev(`window.nemo.addFavorite(${json(key)}).then(() => 'ok')`)
      const sh = await shared()
      const fav = sh.favorites.find((f) => f.url.endsWith(`?${prefix}${i}`))
      ids.push(fav.id)
      await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
    }
    return ids
  }
  const favs = await makeFavorites(5, 'f')
  await settleUi()
  {
    const sh = await shared()
    check(
      '追加した Favorite は全部 tools に入る（既定）',
      sh.favorites.length === 5 && sh.favorites.every((f) => f.section === 'tools'),
      json(sh.favorites.map((f) => f.section))
    )
    // tools が 1 件でもあれば、messages は空でも D&D の受け皿を出す
    const shape = JSON.parse(
      await ui.ev(
        `JSON.stringify({
           labels: [...document.querySelectorAll('.scroll .label')].map((l) => (l.childNodes[0]?.textContent ?? '').trim()),
           toolsCells: document.querySelectorAll('.fav-grid[data-section="tools"] .fav').length,
           messagesEmpty: Boolean(document.querySelector('.fav-empty[data-section="messages"]'))
         })`
      )
    )
    check('tools のグリッドに 5 件描かれている', shape.toolsCells === 5, json(shape.toolsCells))
    check(
      'messages が空でも受け皿が出る（ラベルは tools → messages → bookmarks）',
      json(shape.labels) === json(['tools', 'messages', 'bookmarks']) && shape.messagesEmpty,
      json(shape)
    )
  }

  // messages へ 2 件移す（右クリックの「Messages へ移動」と同じ API）
  await ui.ev(`window.nemo.moveFavorite(${json(favs[0])}, 'messages').then(() => 'ok')`)
  await ui.ev(`window.nemo.moveFavorite(${json(favs[1])}, 'messages').then(() => 'ok')`)
  await settleUi()
  {
    const sh = await shared()
    const messages = sh.favorites.filter((f) => f.section === 'messages').map((f) => f.id)
    const tools = sh.favorites.filter((f) => f.section === 'tools').map((f) => f.id)
    check('messages へ移せる（末尾に付く）', json(messages) === json([favs[0], favs[1]]), json(messages))
    check('tools 側の並びは動かない', json(tools) === json([favs[2], favs[3], favs[4]]), json(tools))
    // 描画順: tools → messages → bookmarks（ラベルの並び）と、グリッドの data-section
    const labels = JSON.parse(
      await ui.ev(
        `JSON.stringify([...document.querySelectorAll('.scroll .label')].map((l) => (l.childNodes[0]?.textContent ?? '').trim()))`
      )
    )
    check(
      'ラベルが tools → messages → bookmarks の順に描かれる',
      json(labels) === json(['tools', 'messages', 'bookmarks']),
      json(labels)
    )
    const grids = JSON.parse(
      await ui.ev(
        `JSON.stringify([...document.querySelectorAll('.fav-grid')].map((g) => [g.dataset.section, g.querySelectorAll('.fav').length]))`
      )
    )
    check(
      'グリッドが tools(3) → messages(2) の順',
      json(grids) ===
        json([
          ['tools', 3],
          ['messages', 2]
        ]),
      json(grids)
    )
    check(
      'messages ↔ bookmarks の間に区切り線が無い',
      (await ui.ev(
        `(() => { const g = document.querySelector('.fav-grid[data-section="messages"]'); let el = g.nextElementSibling; return el && el.classList.contains('label') && (el.childNodes[0]?.textContent ?? '').trim() === 'bookmarks' })()`
      )) === true
    )
  }

  // 相対 index の解決: Messages 2 件・Tools 3 件で、tools の 3 番目を tools の index 1 へ
  await ui.ev(`window.nemo.moveFavorite(${json(favs[4])}, 'tools', 1).then(() => 'ok')`)
  {
    const sh = await shared()
    const messages = sh.favorites.filter((f) => f.section === 'messages').map((f) => f.id)
    const tools = sh.favorites.filter((f) => f.section === 'tools').map((f) => f.id)
    check('相対 index: tools の 2 番目に入る', json(tools) === json([favs[2], favs[4], favs[3]]), json(tools))
    check('相対 index: messages は動かない', json(messages) === json([favs[0], favs[1]]), json(messages))
  }
  // messages の 2 番目を tools の末尾へ → ⌘N の並び（tools のみ）の末尾に付く
  await ui.ev(`window.nemo.moveFavorite(${json(favs[1])}, 'tools').then(() => 'ok')`)
  {
    const sh = await shared()
    const tools = sh.favorites.filter((f) => f.section === 'tools').map((f) => f.id)
    check(
      'messages → tools へ移すと tools（⌘N の並び）の末尾に付く',
      json(tools) === json([favs[2], favs[4], favs[3], favs[1]]),
      json(tools)
    )
  }

  /* --- ⌘1〜9 --- */
  // 番号は tools のみ: 1 = tools の 1 件目。messages（favs[0] の 1 件）は対象外
  const active = () => state().then((s) => s.tabs.find((t) => t.key === s.activeTabKey) ?? null)
  const base = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(k => k)`)
  await ui.ev(`window.nemo.selectTab(${json(base)}).then(() => 'ok')`)
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-1').then(String)`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.favoriteId === ${json(favs[2])}) ? 'ok' : '')`
  )
  check(
    '⌘1 で tools の 1 件目が開いてアクティブになる（messages は飛ばされる）',
    (await active())?.favoriteId === favs[2],
    json((await active())?.favoriteId)
  )
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-2').then(String)`)
  await waitFor(
    ui,
    `window.nemo.getWindowState().then(s => s.tabs.some(t => t.favoriteId === ${json(favs[4])}) ? 'ok' : '')`
  )
  check(
    '⌘2 で tools の 2 件目が開く',
    (await active())?.favoriteId === favs[4],
    json((await active())?.favoriteId)
  )
  // 同じキーをもう一度 → 直前のタブ（⌘1 で開いた tools 1 件目）へ戻る
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-2').then(String)`)
  await settleUi()
  check(
    '同じ ⌘N をもう一度押すと直前のタブへ戻る',
    (await active())?.favoriteId === favs[2],
    json((await active())?.favoriteId)
  )
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-2').then(String)`)
  await settleUi()
  check(
    'さらに押すと行ったり来たりできる',
    (await active())?.favoriteId === favs[4],
    json((await active())?.favoriteId)
  )
  // messages は番号の対象外: 番号付きは tools の 4 件だけなので ⌘5 は空振り
  // （messages 1 件がどこかで番号に混ざっていれば 5 番目が開いてしまう）
  const beforeFive = (await state()).activeTabKey
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-5').then(String)`)
  await settleUi()
  {
    const afterFive = (await state()).activeTabKey
    check(
      'messages は ⌘N の対象にならない（tools 4 件で ⌘5 は空振り）',
      afterFive === beforeFive,
      `before=${beforeFive} after=${afterFive}`
    )
  }
  // 対象が無い番号は何もしない
  const beforeNine = (await state()).activeTabKey
  await ui.ev(`window.nemo.runCommandForVerify('select-favorite-9').then(String)`)
  await settleUi()
  check('対象の無い ⌘9 は何もしない', (await state()).activeTabKey === beforeNine)
  check(
    '旧 select-tab-N は知らないコマンドとして拒否される',
    (await ui.ev(`window.nemo.runCommandForVerify('select-tab-1').then(String)`)) === 'false'
  )

  /* --- ⌘ 長押しの番号バッジ（main の状態機械を診断 IPC で直接叩く） --- */
  const hint = (action) => ui.ev(`window.nemo.shortcutHintForVerify('${action}').then(String)`)
  const badges = () =>
    ui.ev(`JSON.stringify([...document.querySelectorAll('.fav .kb')].map((b) => b.textContent))`)
  await hint('up')
  check('⌘ を押した瞬間には出ない（350ms 未満）', (await hint('down')) === 'false')
  await sleep(120)
  check('120ms ではまだ出ない', (await hint('query')) === 'false')
  await sleep(500)
  check('350ms を超えると出る', (await hint('query')) === 'true')
  await settleUi()
  check(
    'バッジは tools だけに 1〜4 の順で描かれる（messages には出ない）',
    (await badges()) === json(['1', '2', '3', '4']),
    await badges()
  )
  {
    const messagesBadges = await ui.ev(
      `document.querySelectorAll('.fav-grid[data-section="messages"] .kb').length`
    )
    check('messages のグリッドにバッジが無い', messagesBadges === 0, `messages .kb=${messagesBadges}`)
  }
  check('keyUp で消える', (await hint('up')) === 'false')
  await settleUi()
  check('keyUp 後は DOM からも消える', (await badges()) === '[]', await badges())
  await hint('down')
  await sleep(500)
  check('（再度）出ている', (await hint('query')) === 'true')
  check('blur で消える', (await hint('blur')) === 'false')
  await hint('down')
  await sleep(500)
  check('（再々度）出ている', (await hint('query')) === 'true')
  await sleep(5200)
  check('表示から 5 秒で自動的に消える（keyUp の取りこぼし対策）', (await hint('query')) === 'false')
  await settleUi()
  check('自動解除後は DOM からも消える', (await badges()) === '[]', await badges())

  /* --- グリッドへのドロップは落とした側の section に入る --- */
  await closeEphemeralTabs()
  const dropped = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.renameTab(${json(dropped)}, 'ドロップ元M').then(() => 'ok')`)
  await settleUi()
  await ui.ev(
    `window.__nemoVerify.drag(
       document.querySelector('.scroll .row[title="ドロップ元M"]'),
       document.querySelector('.fav-grid[data-section="messages"]')
     )`
  )
  await settleUi()
  {
    const sh = await shared()
    const fav = sh.favorites.find((f) => f.customTitle === 'ドロップ元M')
    check('messages のグリッドへ落とすと messages に入る', fav?.section === 'messages', json(fav?.section))
    // favicon が定義に写る（/index.html は favicon を出す）→ タブを閉じても <img> で描かれる
    const favicon = await waitFor(
      ui,
      `window.nemo.getSharedState().then(s => { const f = s.favorites.find(f => f.customTitle === 'ドロップ元M'); return f && f.faviconUrl ? 'yes' : '' })`,
      { timeoutMs: 15000 }
    ).catch(() => '')
    check('開いている Favorite の favicon が定義に写る', favicon === 'yes')
    await ui.ev(`window.nemo.closeTab(${json(dropped)}).then(() => 'ok')`)
    await settleUi()
    const drawn = await ui.ev(
      `(() => { const cell = document.querySelector('.fav[data-id=${JSON.stringify(fav?.id)}]'); if (!cell) return 'no-cell'; return cell.querySelector('img.fi') ? 'img' : cell.querySelector('.fi.letter') ? 'letter' : 'none' })()`
    )
    check('閉じても Favorite のセルは favicon の <img> のまま（頭文字に落ちない）', drawn === 'img', drawn)
  }

  await resetDefinitions()
  await closeEphemeralTabs()
}

/* ------------------------------------------------------------------ *
 * カスタムアイコン（`customIcon`）: 絵文字 / PNG、拒否時は既存を残す、変換で引き継ぐ
 * ------------------------------------------------------------------ */
{
  await resetDefinitions()
  const setIcon = (id, icon) =>
    ui.ev(`window.nemo.setCustomIcon(${json(id)}, ${json(icon)}).then(v => String(v))`)
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')

  check('ピン留めに絵文字を付けると true', (await setIcon(pin.id, '👨‍👩‍👧')) === 'true')
  {
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('ピン定義が customIcon（ZWJ 絵文字）を持つ', after?.customIcon === '👨‍👩‍👧', json(after?.customIcon))
    await sleep(250)
    const drawn = await ui.ev(
      `(() => { const row = document.querySelector('.row.pin[data-pin=${JSON.stringify(pin.id)}]'); if (!row) return 'no-row'; const el = row.querySelector('.def-emoji'); return el ? el.textContent : 'none' })()`
    )
    check('ピン行が絵文字で描かれる（favicon より優先）', drawn === '👨‍👩‍👧', drawn)
  }

  // 拒否: 上限超え / 2 grapheme / 絵文字以外。**既存のアイコンは残る**
  {
    const tooLong = await ui.ev(
      `window.nemo.setCustomIcon(${json(pin.id)}, 'data:image/png;base64,' + 'A'.repeat(20000)).then(v => String(v))`
    )
    check('上限超えの画像は false（reject にならない）', tooLong === 'false', tooLong)
    check('2 grapheme は false', (await setIcon(pin.id, '🏢🏠')) === 'false')
    check('PNG 以外の data: は false', (await setIcon(pin.id, 'data:image/svg+xml;base64,AAAA')) === 'false')
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check('拒否されても既存のアイコンは消えない', after?.customIcon === '👨‍👩‍👧', json(after?.customIcon))
    check('存在しない ID は false', (await setIcon('no-such-id', '🏢')) === 'false')
  }

  // ピン → Favorite の変換でアイコンが引き継がれる
  await ui.ev(`window.nemo.addFavorite(${json(key)}).then(() => 'ok')`)
  await sleep(400)
  const fav = (await shared()).favorites[0]
  check(
    'ピン → Favorite の変換でカスタムアイコンが引き継がれる',
    fav?.customIcon === '👨‍👩‍👧',
    json(fav?.customIcon)
  )
  {
    const drawn = await ui.ev(
      `(() => { const cell = document.querySelector('.fav[data-id=${JSON.stringify(fav?.id)}]'); if (!cell) return 'no-cell'; const el = cell.querySelector('.def-emoji'); return el ? el.textContent : 'none' })()`
    )
    check('グリッドのセルが絵文字で描かれる', drawn === '👨‍👩‍👧', drawn)
  }

  // 右クリック「アイコンを変更…」で枠が開き、プレビューの × で favicon に戻る
  {
    await ui.ev(`(() => {
      const cell = document.querySelector('.fav[data-id=${JSON.stringify(fav?.id)}]')
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 100 }))
      return 'ok'
    })()`)
    await sleep(250)
    await ui.ev(`(() => {
      const item = [...document.querySelectorAll('.row-menu button')].find((b) => b.textContent === 'アイコンを変更…')
      if (item) item.click()
      return item ? 'ok' : 'no-item'
    })()`)
    await sleep(250)
    const shape = await ui
      .ev(
        `JSON.stringify((() => { const box = document.querySelector('.icon-edit'); if (!box) return null; return { prev: box.querySelector('.icon-edit-prev .def-emoji')?.textContent ?? null, buttons: [...box.querySelectorAll('.icon-edit-btn')].map((b) => b.textContent), clear: Boolean(box.querySelector('.icon-edit-clear')), placeholder: box.querySelector('.icon-edit-input')?.placeholder ?? null } })())`
      )
      .then(JSON.parse)
    check(
      '「アイコンを変更…」で枠が開き、プレビュー・絵文字欄（placeholder 😀）・🖼 ボタン・× がある',
      shape?.prev === '👨‍👩‍👧' &&
        shape?.buttons?.length === 1 &&
        shape?.clear === true &&
        shape?.placeholder === '😀',
      json(shape)
    )
    await ui.ev(`(() => { document.querySelector('.icon-edit-clear')?.click(); return 'ok' })()`)
    await sleep(250)
    const cleared = (await shared()).favorites.find((f) => f.id === fav?.id)
    check(
      'プレビューの × で favicon に戻る（customIcon が null）',
      cleared?.customIcon === null,
      json(cleared?.customIcon)
    )
    const closed = await ui.ev(
      `(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return 'ok' })()`
    )
    await sleep(150)
    const still = await ui.ev(`document.querySelector('.icon-edit') ? 'open' : 'closed'`)
    check('枠外クリックで枠が閉じる', closed === 'ok' && still === 'closed', still)
    // 次の検査（PNG）のためにアイコンを戻しておく
    await setIcon(fav.id, '👨‍👩‍👧')
  }

  // PNG の data URL（1×1 の透明 PNG）は通り、セルは <img> で描かれる
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  check('PNG の data URL は true', (await setIcon(fav.id, png)) === 'true')
  {
    const after = (await shared()).favorites.find((f) => f.id === fav.id)
    check('Favorite 定義が PNG を持つ', after?.customIcon === png)
    await sleep(250)
    const drawn = await ui.ev(
      `(() => { const cell = document.querySelector('.fav[data-id=${JSON.stringify(fav.id)}]'); if (!cell) return 'no-cell'; const img = cell.querySelector('img.fi'); return img ? img.getAttribute('src').slice(0, 22) : 'none' })()`
    )
    check('画像アイコンはセルが <img> で描かれる', drawn === 'data:image/png;base64,', drawn)
  }

  // Favorite → ピンの変換でも引き継がれる（既に同 URL のピンは無い）
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  await sleep(400)
  {
    const back = flatten((await shared()).pinned).find((n) => n.kind === 'link')
    check(
      'Favorite → ピンの変換でもカスタムアイコンが引き継がれる',
      back?.customIcon === png,
      json(back?.customIcon?.slice(0, 30))
    )
    check('null で解除すると true', (await setIcon(back.id, null)) === 'true')
    const cleared = flatten((await shared()).pinned).find((n) => n.id === back.id)
    check('解除後は customIcon が null', cleared?.customIcon === null, json(cleared?.customIcon))
  }

  await resetDefinitions()
  await ui.ev(`window.nemo.closeTab(${json(key)}).then(() => 'ok')`)
}

await resetDefinitions()
ui.close()
console.log(failures === 0 ? '\nverify-pins: すべて PASS' : `\nverify-pins: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
