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

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

/** 単クリックの遅延（`InlineRename.tsx` の CLICK_DELAY_MS）より確実に長く待つ。 */
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
  // 一時タブにリネームを付ける（再起動をまたいで残ることを見る）
  const tmpTab = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then(k => k)`)
  await ui.ev(`window.nemo.renameTab(${json(tmpTab)}, '作業用').then(() => 'ok')`)

  const s = await state()
  check(
    '遅延ロード前提: ピンと Favorite のタブが開いている',
    s.tabs.some((t) => t.pinnedId) && s.tabs.some((t) => t.favoriteId),
    json(s.tabs.map((t) => [t.pinnedId ? 'pin' : t.favoriteId ? 'fav' : 'tmp', t.url.split('/').pop()]))
  )
  // セッション保存はデバウンスされているので、書かれるまで待つ
  await sleep(3000)
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
    '一時タブに付けた名前が再起動をまたいで残る',
    tabs.some((t) => t.customTitle === '作業用'),
    json(tabs.map((t) => t.customTitle))
  )

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
 * シークレットウィンドウでは既定名を書かない
 * ------------------------------------------------------------------ */

{
  const key = await ui.ev(`window.nemo.createTab('${PAGES}/index.html').then(k => k)`)
  await ui.ev(`window.nemo.pinTab(${json(key)}).then(() => 'ok')`)
  const pin = flatten((await shared()).pinned).find((n) => n.kind === 'link')
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
    await loaded(priv, privKey, '/index.html')
    await priv.ev(`window.nemo.navigate(${json(privKey)}, '${PAGES}/login.html').then(() => 'ok')`)
    await waitFor(
      priv,
      `window.nemo.getWindowState().then(s => s.tabs.some(t => t.key === ${json(privKey)} && !t.loading && t.url.includes('/login.html')))`,
      { timeoutMs: 15000 }
    )
    await sleep(500)
    const after = flatten((await shared()).pinned).find((n) => n.id === pin.id)
    check(
      'シークレットで開いたページのタイトルを pins.json に書かない',
      after?.title === pin.title,
      `${pin.title} -> ${after?.title}`
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

  // --- 閉じている Favorite のセルも、ダブルクリックでタブを増やさずに編集へ入る ---
  // ピン行と同じ規則が**グリッド側にも効いているか**を見る（別のコンポーネントなので別に見る）
  {
    const before = (await state()).tabs.length
    await ui.ev(
      `(() => { window.__nemoVerify.doubleClick(document.querySelector('.fav.closed')); return 'ok' })()`
    )
    await sleep(CLICK_DELAY_WAIT_MS)
    const editing = await ui.ev(`Boolean(document.querySelector('.fav-edit .rename'))`)
    const after = (await state()).tabs.length
    check('閉じている Favorite のダブルクリックで編集に入る', editing === true)
    check(
      'そのときタブは増えない（Favorites 側でも単クリックの遅延が効いている）',
      after === before,
      `${before} -> ${after}`
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
    const sh = await shared()
    check(
      'Favorites のインライン編集が定義に反映される',
      sh.favorites.some((f) => f.customTitle === 'グリッドから付けた名前'),
      json(sh.favorites.map((f) => f.customTitle))
    )
  }

  await resetDefinitions()
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

await resetDefinitions()
ui.close()
console.log(failures === 0 ? '\nverify-pins: すべて PASS' : `\nverify-pins: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
