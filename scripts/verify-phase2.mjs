#!/usr/bin/env node
/**
 * Phase 2 の自走検証（ライブラリ・自動アーカイブ・シークレットウィンドウ・既定ブラウザ）。
 *
 * `verify-phase1.mjs` と同じ前提で動く:
 * - Nemo が `NEMO_REMOTE_DEBUGGING_PORT` 付きで起動している
 * - テストページサーバが動いている
 * - **使い捨てのデータディレクトリ**（CDP を開けるので実プロファイルでは回さない）
 *
 *   node scripts/verify-phase2.mjs
 */
import { connect, connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const ui = await connectUi(CDP)

const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const settings = () => ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))').then(JSON.parse)
const history = (query = '') =>
  ui.ev(`window.nemo.queryHistory(${JSON.stringify(query)}).then((r) => JSON.stringify(r))`).then(JSON.parse)
const archive = (query = '') =>
  ui.ev(`window.nemo.queryArchive(${JSON.stringify(query)}).then((r) => JSON.stringify(r))`).then(JSON.parse)

/* ------------------------------------------------------------------ *
 * 履歴の検索（全文検索）
 * ------------------------------------------------------------------ */

// テストページを開いて履歴に載せる
await ui.ev(`window.nemo.createTab('${PAGES}/login.html').then(() => 'ok')`)
await waitFor(ui, `window.nemo.queryHistory('login').then((r) => (r.length > 0 ? 'ok' : ''))`)

const all = await history('')
check('空クエリで最近見たページが返る', all.length > 0, `${all.length} 件`)

const byUrl = await history('login')
check(
  'URL の部分一致で引ける',
  byUrl.some((entry) => entry.url.includes('login.html')),
  byUrl.map((entry) => entry.url).join(', ')
)

// 日本語のタイトルを部分一致で引く（trigram tokenizer の確認）。
// 既定の tokenizer だと日本語のタイトルが1語になり、ここが必ず0件になる。
const titles = all.map((entry) => entry.title).filter(Boolean)
const japanese = titles.find((title) => /[ぁ-んァ-ヶ一-龠]{3,}/.test(title))
if (japanese) {
  const needle = japanese.match(/[ぁ-んァ-ヶ一-龠]{3}/)[0]
  const found = await history(needle)
  check(
    '日本語タイトルの部分一致で引ける（全文検索）',
    found.some((entry) => entry.title === japanese),
    `"${needle}" → ${found.length} 件`
  )
} else {
  // テストページに日本語タイトルが無い環境でも、検索経路そのものは確認する
  const found = await history('ページ')
  check('日本語クエリでも例外なく引ける', Array.isArray(found), `${found.length} 件`)
}

const missing = await history('この語はどこにも無いはず')
check('見つからない語では 0 件', missing.length === 0)

/* ------------------------------------------------------------------ *
 * 一時タブを閉じたらアーカイブに残る
 * ------------------------------------------------------------------ */

const beforeClose = await state()
const closeKey = await ui.ev(`window.nemo.createTab('${PAGES}/iframe.html').then((key) => key)`)
await waitFor(
  ui,
  `window.nemo.getWindowState().then((s) => (s.tabs.length > ${beforeClose.tabs.length} ? 'ok' : ''))`
)
await ui.ev(`window.nemo.closeTab(${JSON.stringify(closeKey)}).then(() => 'ok')`)

const closed = await archive('iframe')
check(
  '閉じた一時タブがアーカイブに残る',
  closed.some((entry) => entry.url.includes('iframe.html')),
  closed.map((entry) => `${entry.url}(${entry.reason})`).join(', ')
)

/* ------------------------------------------------------------------ *
 * 自動アーカイブ
 *
 * sweep は 5 秒周期。しきい値を極小にして、
 * 「一時タブだけが片付く」「ピン留めとアクティブは残る」を確かめる。
 * ------------------------------------------------------------------ */

const original = await settings()

// 対象: 一時タブ（背景で開いて触らない）
const victimKey = await ui.ev(
  `window.nemo.createTab('${PAGES}/index.html', { background: true }).then((key) => key)`
)
// 対象外: ピン留めしたタブ
const pinnedKey = await ui.ev(
  `window.nemo.createTab('${PAGES}/login.html', { background: true }).then((key) => key)`
)
await ui.ev(`window.nemo.pinTab(${JSON.stringify(pinnedKey)}).then(() => 'ok')`)

// sleep で WebContents が消えてもアーカイブ判定は URL で行う。
// sleep が先に走っても結果が変わらないことも同時に見ている。
await ui.ev(`window.nemo.updateSettings({ tabArchiveHours: 0.0004 }).then((s) => String(s.tabArchiveHours))`)

const activeBefore = (await state()).activeTabKey
await waitFor(
  ui,
  `window.nemo.getWindowState().then((s) => (s.tabs.some((t) => t.key === ${JSON.stringify(victimKey)}) ? '' : 'gone'))`,
  { timeoutMs: 20000 }
)

const afterSweep = await state()
check('放置した一時タブが自動アーカイブされて閉じた', !afterSweep.tabs.some((tab) => tab.key === victimKey))
check(
  'ピン留めしたタブは自動アーカイブされない',
  afterSweep.tabs.some((tab) => tab.key === pinnedKey)
)
check(
  '見ているタブは自動アーカイブされない',
  afterSweep.tabs.some((tab) => tab.key === activeBefore),
  `activeTabKey=${activeBefore}`
)

const autoArchived = await archive('index.html')
check(
  '自動アーカイブされたタブは掘り返せる',
  autoArchived.some((entry) => entry.url.includes('index.html') && entry.reason === 'auto'),
  autoArchived.map((entry) => `${entry.url}(${entry.reason})`).join(', ')
)

// 設定を戻す（以降の検証に影響させない）
await ui.ev(
  `window.nemo.updateSettings({ tabArchiveHours: ${original.tabArchiveHours} }).then((s) => String(s.tabArchiveHours))`
)

// アーカイブから消せること
const target = autoArchived.find((entry) => entry.url.includes('index.html'))
await ui.ev(`window.nemo.removeArchived(${JSON.stringify(target.url)}).then(() => 'ok')`)
const afterRemove = await archive('index.html')
check('アーカイブから1件消せる', !afterRemove.some((entry) => entry.url === target.url))

/* ------------------------------------------------------------------ *
 * オーバーレイ（ライブラリ / 設定）
 * ------------------------------------------------------------------ */

for (const kind of ['library', 'settings']) {
  await ui.ev(`window.nemo.setOverlay('${kind}').then(() => 'ok')`)
  const shown = await ui.ev(`window.nemo.getOverlayState().then((s) => s.kind)`)
  check(`${kind} オーバーレイを開ける`, shown === kind, String(shown))
}
await ui.ev(`window.nemo.setOverlay(null).then(() => 'ok')`)

let rejected = false
try {
  await ui.ev(`window.nemo.setOverlay('not-a-kind').then(() => 'ok')`)
} catch {
  rejected = true
}
check('知らないオーバーレイ名は拒否される', rejected)

/* ------------------------------------------------------------------ *
 * シークレットウィンドウ
 * ------------------------------------------------------------------ */

const historyBefore = (await history('')).length
await ui.ev(`window.nemo.createPrivateWindow().then(() => 'ok')`)

/** シークレットウィンドウのサイドバー target が現れるまで待つ。 */
async function findPrivateSidebar(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets(CDP)
    const found = targets.find((t) => t.url.includes('private=1') && t.url.includes('view=sidebar'))
    if (found) return found
    await sleep(300)
  }
  return null
}

const privateTarget = await findPrivateSidebar()
check('シークレットウィンドウの UI が private として開く', Boolean(privateTarget), privateTarget?.url ?? '')

if (privateTarget) {
  const privateUi = await connect(privateTarget.webSocketDebuggerUrl)
  await waitFor(privateUi, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")

  const privState = await privateUi
    .ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))')
    .then(JSON.parse)
  check('シークレットウィンドウの状態が isPrivate になっている', privState.isPrivate === true)

  // 通常ウィンドウで開いたことのないページを、シークレット側だけで開く。
  // 他の検証で開いた URL を使うと、履歴に残っている理由が
  // 「シークレットが記録した」のか「別の検証が記録した」のか区別できない。
  const privateUrl = `${PAGES}/index.html?probe=private-only`
  const privateKey = await privateUi.ev(`window.nemo.createTab('${privateUrl}').then((key) => key)`)
  await waitFor(
    privateUi,
    `window.nemo.getWindowState().then((s) => (s.tabs.some((t) => t.key === ${JSON.stringify(privateKey)} && t.url.includes('probe=private-only')) ? 'ok' : ''))`
  )
  // 履歴の書き込みは did-navigate で同期に走るが、念のため少し待つ
  await sleep(800)

  check('シークレットで開いたページは履歴に残らない', (await history('probe=private-only')).length === 0)
  // favicon の記録も同じ `remember()` の内側にある。タブ側には出ていても、
  // 履歴に行が無い＝ favicon も書かれていないことを、タブと履歴の両方で見る。
  const privateFavicon = await privateUi.ev(
    `window.nemo.getWindowState().then((s) => (s.tabs.find((t) => t.key === ${JSON.stringify(privateKey)})?.faviconUrl ? 'shown' : 'none'))`
  )
  check(
    'シークレットのタブでも favicon は表示される（記録しないだけ）',
    privateFavicon === 'shown',
    String(privateFavicon)
  )
  check(
    'シークレットで開いたページの favicon は履歴に書かれない',
    (await history('probe=private-only')).every((entry) => !entry.faviconUrl)
  )
  check('シークレットのタブはアーカイブにも残らない', (await archive('probe=private-only')).length === 0)

  await privateUi.ev(`window.nemo.closeTab(${JSON.stringify(privateKey)}).then(() => 'ok')`)
  await sleep(300)
  check(
    'シークレットのタブを閉じてもアーカイブに入らない',
    (await archive('probe=private-only')).length === 0
  )

  const total = await history('')
  check(
    '通常ウィンドウの履歴は影響を受けない',
    total.length >= historyBefore,
    `${historyBefore} → ${total.length}`
  )

  /* ---- シークレットのタブを新規ウィンドウへ移す ---- */
  // 移動先を通常ウィンドウで作ると partition が違って registry が移動を拒否し、
  // **空のウィンドウだけが増えて対象タブはシークレット側に残る**（実際に踏んだ）。
  // 移動には2枚以上要る。**初期タブ（about:blank）の有無に頼らない**
  // （UI のロード完了より前にタブを作ると、初期タブは作られない）。ここで明示的に揃える。
  await privateUi.ev(`window.nemo.createTab('${PAGES}/login.html').then(() => 'ok')`)
  const moveKey = await privateUi.ev(`window.nemo.createTab('${PAGES}/index.html').then((key) => key)`)
  // 移動には「2枚以上ある」ことが要る（1枚しかないと registry は何もしない）。
  // 揃わなかったときに原因が分かるよう、その時点の状態を出す。
  const beforeMove = await waitFor(
    privateUi,
    `window.nemo.getWindowState().then((s) => (s.tabs.length >= 2 ? JSON.stringify(s.tabs.map((t) => t.url)) : ''))`,
    { timeoutMs: 8000 }
  ).catch(async () => {
    const now = await privateUi.ev(
      'window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.map((t) => t.url)))'
    )
    return `（2枚に届かなかった: ${now}）`
  })
  const privateSidebarsBefore = (await listTargets(CDP)).filter(
    (t) => t.url.includes('private=1') && t.url.includes('view=sidebar')
  ).length

  await privateUi.ev(`window.nemo.moveTabToNewWindow(${JSON.stringify(moveKey)}).then(() => 'ok')`)
  await sleep(2500)

  const privateSidebarsAfter = (await listTargets(CDP)).filter(
    (t) => t.url.includes('private=1') && t.url.includes('view=sidebar')
  ).length
  check(
    'シークレットのタブは**シークレットの**新規ウィンドウへ移る',
    privateSidebarsAfter === privateSidebarsBefore + 1,
    `シークレット窓 ${privateSidebarsBefore} → ${privateSidebarsAfter} / 移動前 ${beforeMove}`
  )

  const stillHere = await privateUi
    .ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))')
    .then(JSON.parse)
  check(
    '移したタブは元のシークレット窓から外れている',
    !stillHere.tabs.some((tab) => tab.key === moveKey),
    stillHere.tabs.map((tab) => tab.key).join(', ')
  )

  /* ---- ダウンロードは scope で分かれる ---- */
  // ハンドラを付けていないと `will-download` に誰も応えず、保存先が決まらないまま失敗する。
  // さらに一覧は全ウィンドウ共通なので、**絞らないと通常窓からシークレットの
  // ファイル名・保存先が見えて Finder 表示もキャンセルもできてしまう**。
  const dlUrl = `${PAGES}/__nemo_download__`
  const startDownload = async (session) => {
    const before = await session
      .ev('window.nemo.getSharedState().then((s) => String(s.downloads.length))')
      .then(Number)
    const key = await session.ev(`window.nemo.createTab('${PAGES}/index.html').then((k) => k)`)
    // ダウンロードは navigation が中断される形になるので reject は握る
    await session.ev(
      `window.nemo.navigate(${JSON.stringify(key)}, ${JSON.stringify(dlUrl)}).catch(() => 'download')`
    )
    return waitFor(
      session,
      `window.nemo.getSharedState().then((s) => (s.downloads.length > ${before} ? JSON.stringify(s.downloads[0]) : ''))`,
      { timeoutMs: 15000 }
    )
      .then(JSON.parse)
      .catch(() => null)
  }

  // **両方に1件ずつ**作る。片方が空だと「出ていない」が偶然成立してしまう
  const normalDownload = await startDownload(ui)
  const privateDownload = await startDownload(privateUi)
  check(
    'シークレットでもダウンロードが Nemo の一覧に載る',
    Boolean(privateDownload),
    String(privateDownload?.id)
  )
  check('通常ウィンドウのダウンロードも記録される', Boolean(normalDownload), String(normalDownload?.id))

  const listOf = (session) =>
    session.ev('window.nemo.getSharedState().then((s) => JSON.stringify(s.downloads))').then(JSON.parse)

  const normalList = await listOf(ui)
  const privateList = await listOf(privateUi)
  check(
    'シークレットのダウンロードが通常ウィンドウの一覧に出ない',
    !normalList.some((item) => item.id === privateDownload?.id) &&
      normalList.some((item) => item.id === normalDownload?.id),
    `通常側 ${normalList.length} 件`
  )
  check(
    '通常のダウンロードがシークレットの一覧に出ない',
    !privateList.some((item) => item.id === normalDownload?.id) &&
      privateList.some((item) => item.id === privateDownload?.id),
    `シークレット側 ${privateList.length} 件`
  )

  // 一覧に出さなくても id を知っていれば叩けるので、操作も scope で絞る
  if (privateDownload) {
    await ui.ev(`window.nemo.cancelDownload(${JSON.stringify(privateDownload.id)}).then(() => 'ok')`)
    await sleep(600)
    const stillThere = await listOf(privateUi)
    check(
      '通常ウィンドウからシークレットのダウンロードを消せない',
      stillThere.some((item) => item.id === privateDownload.id),
      `シークレット側 ${stillThere.length} 件`
    )
  }

  /* ---- シークレット窓どうしはセッションを共有する ---- */
  // ウィンドウごとに別セッションにすると、タブを別のシークレット窓へ移せず
  // （partition が違って registry が拒否する）、2枚目でログインし直す羽目になる。
  // Chrome と同じで**全シークレット窓で1つ**を共有する。
  const cookieProbe = `${PAGES}/index.html?probe=private-cookie`
  await privateUi.ev(`window.nemo.createTab('${cookieProbe}').then((key) => key)`)
  await sleep(1500)
  const cookiePage = await connectTo(CDP, 'probe=private-cookie', { type: 'page' })
  await cookiePage.ev("document.cookie = 'nemo_private_probe=1; path=/'")
  const wrote = await cookiePage.ev('document.cookie')
  check('シークレットのページで cookie を書ける', String(wrote).includes('nemo_private_probe'), String(wrote))
  cookiePage.close()

  // 2枚目のシークレット窓から同じ origin を開くと、同じ cookie が見える
  await ui.ev(`window.nemo.createPrivateWindow().then(() => 'ok')`)
  await sleep(2500)
  const second = (await listTargets(CDP))
    .filter((t) => t.url.includes('private=1') && t.url.includes('view=sidebar'))
    .find((t) => !t.url.includes(`window=${privState.windowId}`))
  if (second) {
    const secondUi = await connect(second.webSocketDebuggerUrl)
    await waitFor(secondUi, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const shareProbe = `${PAGES}/index.html?probe=private-share`
    await secondUi.ev(`window.nemo.createTab('${shareProbe}').then(() => 'ok')`)
    await sleep(1500)
    const sharePage = await connectTo(CDP, 'probe=private-share', { type: 'page' })
    const shared = await sharePage.ev('document.cookie')
    check(
      '2枚目のシークレット窓が同じセッションを見る（ログインし直しにならない）',
      String(shared).includes('nemo_private_probe'),
      String(shared) || '（空）'
    )
    sharePage.close()
    secondUi.close()
  } else {
    check('2枚目のシークレット窓が開く', false, '見つからなかった')
  }

  /* ---- 権限の記憶が常用プロファイルへ漏れないこと ---- */
  // 権限ダイアログの「今後も同じ扱い」は**既定で ON**。
  // シークレットで一度許可しただけの origin が permissions.json に残ると、
  // 通常ウィンドウでも黙って自動許可される。
  // `navigator.permissions.query` は Nemo の permission check handler の結果を返すので、
  // 「記憶がどう見えているか」を OS の位置情報に触らずに確かめられる。
  const QUERY = `navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)`
  const permProbe = `${PAGES}/index.html?probe=private-perm`
  await privateUi.ev(`window.nemo.createTab('${permProbe}').then(() => 'ok')`)
  await sleep(1500)
  const permPage = await connectTo(CDP, 'probe=private-perm', { type: 'page' })
  check(
    'シークレットの初期状態では権限を覚えていない',
    (await permPage.ev(QUERY)) !== 'granted',
    String(await permPage.ev(QUERY))
  )

  // ダイアログを出して「許可」（「今後も」は既定 ON）で答える
  void permPage
    .ev(`new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('ok'), () => r('denied')))`)
    .catch(() => {})
  const privateOverlayTarget = (await listTargets(CDP)).find(
    (t) => t.url.includes('view=overlay') && t.url.includes(`window=${privState.windowId}`)
  )
  if (privateOverlayTarget) {
    const privateOverlay = await connect(privateOverlayTarget.webSocketDebuggerUrl)
    const kind = await waitFor(
      privateOverlay,
      `(() => { const d = document.querySelector('[data-testid]'); return d ? d.getAttribute('data-testid') : '' })()`,
      { timeoutMs: 10000 }
    ).catch(() => '')
    check('シークレットでも権限は自動許可せずダイアログを出す', kind === 'prompt-permission', kind)
    // ボタンの文言は「許可する」。取り違えると**押せていないのに先へ進む**ので、
    // 押せたかどうかを必ず確かめる。
    const clicked = await privateOverlay.ev(
      `(() => { const b = [...document.querySelectorAll('.dialog-actions button')].find((x) => x.textContent === '許可する'); if (!b) return 'none'; b.click(); return 'ok' })()`
    )
    check('権限ダイアログの「許可する」を押せる', clicked === 'ok', String(clicked))
    await sleep(800)
    check(
      'シークレットの中では「今後も」が効く',
      (await permPage.ev(QUERY)) === 'granted',
      String(await permPage.ev(QUERY))
    )
    privateOverlay.close()
  } else {
    check('シークレット窓のオーバーレイが見つかる', false, '')
  }
  permPage.close()

  // 同じ origin を通常ウィンドウで見ても、許可が移っていないこと
  const normalPermProbe = `${PAGES}/index.html?probe=normal-perm`
  await ui.ev(`window.nemo.createTab('${normalPermProbe}').then(() => 'ok')`)
  await sleep(1500)
  const normalPermPage = await connectTo(CDP, 'probe=normal-perm', { type: 'page' })
  const leaked = await normalPermPage.ev(QUERY)
  check('シークレットで許可した権限が常用プロファイルに漏れていない', leaked !== 'granted', String(leaked))
  normalPermPage.close()

  // 通常ウィンドウには漏れていないこと
  const normalProbe = `${PAGES}/index.html?probe=normal-cookie`
  await ui.ev(`window.nemo.createTab('${normalProbe}').then(() => 'ok')`)
  await sleep(1500)
  const normalPage = await connectTo(CDP, 'probe=normal-cookie', { type: 'page' })
  const normalCookie = await normalPage.ev('document.cookie')
  check(
    'シークレットの cookie が通常セッションに漏れていない',
    !String(normalCookie).includes('nemo_private_probe'),
    String(normalCookie) || '（空）'
  )
  normalPage.close()

  privateUi.close()
}

console.log(failures === 0 ? '\n=== Phase 2 検証: すべて PASS' : `\n=== Phase 2 検証: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
