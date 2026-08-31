#!/usr/bin/env node
/**
 * Phase 0 の自走検証。CDP 経由で Nemo を操作し、受け入れ基準のうち
 * 資格情報が要らない部分を決定的に検証する。
 * Phase 1-10 の「CI 必須の拡張互換 smoke test」の種になる想定。
 *
 * 前提:
 *   node scripts/test-server.mjs &
 *   ./node_modules/.bin/electron out/main/index.js --remote-debugging-port=9333 &
 *
 * 使い方:
 *   node scripts/verify-spike.mjs                      基本セット
 *   node scripts/verify-spike.mjs --storage-write      chrome.storage に印を書く（再起動前）
 *   node scripts/verify-spike.mjs --storage-read       再起動後に印が残っているか見る
 *   node scripts/verify-spike.mjs --extension-info     ロード中の拡張の ID / version を出す
 */
const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const targets = async () => await (await fetch(`${CDP}/json/list`)).json()

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return {
    events,
    send,
    async ev(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
      }
      return r.result?.result?.value
    }
  }
}

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function uiSession() {
  // ブラウザ UI は nemo://ui/ から配信される（Phase 1 で file:// をやめた）
  const t = (await targets()).find((x) => x.url.includes('view=sidebar'))
  if (!t) throw new Error('ブラウザ UI の target が見つからない')
  const session = await connect(t.webSocketDebuggerUrl)
  await waitForAppReady(session)
  return session
}

/**
 * アプリの初期化完了を待つ。
 *
 * 起動時のタブは UI のロード完了後に作られるので、
 * 「UI の target が出た」だけで読み始めると registry が空に見える
 * （同じ HEAD で PASS と FAIL が入れ替わる形で踏んだ）。
 */
async function waitForAppReady(session, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await session.ev('window.nemo.getAppStatus().then((s) => JSON.stringify(s))')
      if (last && JSON.parse(last).ready) return
    } catch {
      // window.nemo がまだ生えていない
    }
    await sleep(300)
  }
  throw new Error(`アプリの初期化完了を待てなかった（最後の状態: ${last ?? 'なし'}）`)
}

/** サイドバーの UI target 数（= ウィンドウ数）。 */
async function uiWindowCount() {
  return (await targets()).filter((x) => x.url.includes('view=sidebar')).length
}

/** chrome の tabId（WebContents.id）から Nemo のタブを引く。 */
function tabByContentsId(state, contentsId) {
  return state.tabs.find((t) => t.webContentsId === contentsId) ?? null
}

/** アクティブタブの WebContents id。 */
function activeContentsId(state) {
  return state.tabs.find((t) => t.key === state.activeTabKey)?.webContentsId ?? null
}

/**
 * 拡張の service worker につなぐ。
 *
 * **止まっていたら起こしてから繋ぐ。** MV3 の service worker は無操作が続くと
 * idle 停止するので、「target が無い＝壊れている」ではない
 * （検証全体が長くなると、それだけで `--storage-write` が落ちるようになる。実際に踏んだ）。
 * 起こす手段はアプリが持っている `restartServiceWorkers()` を使う。
 */
async function swSession() {
  // **自作テスト拡張（lock の先頭）の SW を名指しで選ぶ**。`find` で
  // 「最初に見つかったもの」を拾うと、SW の起動順しだいで --storage-write と
  // --storage-read が**別の拡張**に繋がり、「chrome.storage.local が再起動をまたいで残る」が
  // {} で落ちる（順序依存のフレーク）。API 検査もこの拡張の permissions が前提
  const TEST_EXTENSION_ID = 'nngceckbapebfimnlniiiahkandclblb'
  const pick = (list) => list.find((x) => x.type === 'service_worker' && x.url.includes(TEST_EXTENSION_ID))
  let t = pick(await targets())
  if (!t) {
    // このファイルの `connect()` は close を返さない（開いたままにする）
    const ui = await uiSession()
    await ui.ev('window.nemo.restartServiceWorkers()')
    for (let i = 0; i < 20 && !t; i += 1) {
      await sleep(300)
      t = pick(await targets())
    }
  }
  if (!t) throw new Error('拡張の service worker が起動していない（起こしても出てこない）')
  return connect(t.webSocketDebuggerUrl)
}

/** 指定 URL のページに接続し、reload して execution context を集める。 */
async function contextsAfterReload(urlPart) {
  const t = (await targets()).find((x) => x.url.includes(urlPart))
  if (!t) throw new Error(`target not found: ${urlPart}`)
  const s = await connect(t.webSocketDebuggerUrl)
  await s.send('Runtime.enable')
  await s.send('Page.enable')
  await s.send('Page.reload')
  await sleep(3000)
  return {
    session: s,
    contexts: s.events
      .filter((e) => e.method === 'Runtime.executionContextCreated')
      .map((e) => e.params.context)
  }
}

const mode = process.argv[2]

if (mode === '--storage-write') {
  const sw = await swSession()
  console.log(await sw.ev(`chrome.storage.local.set({ __nemo_verify__: 'before-restart' }).then(() => 'ok')`))
  process.exit(0)
}

if (mode === '--extension-info') {
  // ロード中の拡張の ID / version を出す（更新をまたいで ID が不変かを見るため）
  const ui = await uiSession()
  const extensions = await ui.ev('window.nemo.getExtensions()')
  console.log(JSON.stringify(extensions))
  process.exit(0)
}

if (mode === '--storage-read') {
  const sw = await swSession()
  const value = await sw.ev(`chrome.storage.local.get('__nemo_verify__').then(v => v)`)
  check(
    'chrome.storage.local が再起動をまたいで残る',
    value?.__nemo_verify__ === 'before-restart',
    JSON.stringify(value)
  )
  process.exit(failures > 0 ? 1 : 0)
}

const ui = await uiSession()

// 1. registry の初期状態（起動直後はタブなし。最初のタブは自分で作る）
let state = await ui.ev('window.nemo.getWindowState()')
check(
  '起動直後は registry にタブが無い',
  state.tabs.length === 0,
  JSON.stringify(state.tabs.map((t) => t.key))
)
await ui.ev("window.nemo.createTab().then(() => 'ok')")
await sleep(300)
state = await ui.ev('window.nemo.getWindowState()')
check(
  'createTab で初期タブが 1 つできる',
  state.tabs.length === 1,
  JSON.stringify(state.tabs.map((t) => t.key))
)
if (state.tabs.length === 0) {
  // ここから先はタブが前提なので、例外で落ちるのではなく理由を出して終わる
  console.log('\n初期タブを作れなかったので以降の検証を打ち切る（アプリの初期化を待てていない）')
  process.exit(1)
}
const tabKey = JSON.stringify(state.tabs[0].key)

// 2. ナビゲーション
await ui.ev(`window.nemo.navigate(${tabKey}, '${PAGES}/login.html?site=a')`)
await sleep(2500)
state = await ui.ev('window.nemo.getWindowState()')
check('コマンドバー入力からナビゲートできる', state.tabs[0].url.includes('login.html'), state.tabs[0].url)

// 3. scheme allowlist
for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>']) {
  let rejected = false
  try {
    await ui.ev(`window.nemo.navigate(${tabKey}, ${JSON.stringify(bad)})`)
  } catch (error) {
    rejected = /navigation rejected/.test(String(error))
  }
  check(`scheme を拒否: ${bad.slice(0, 26)}`, rejected)
}
await sleep(500)
state = await ui.ev('window.nemo.getWindowState()')
check('拒否後も元の URL のまま', state.tabs[0].url.includes('login.html'), state.tabs[0].url)

// 4. ページ側の隔離
{
  const t = (await targets()).find((x) => x.url.includes('login.html'))
  const page = await connect(t.webSocketDebuggerUrl)
  const leaks = []
  for (const name of ['require', 'process', 'module', 'window.nemo', 'window.__browserAction__']) {
    if ((await page.ev(`typeof ${name}`)) !== 'undefined') leaks.push(name)
  }
  check('ページ側に Node / 特権 API が漏れていない', leaks.length === 0, leaks.join(', '))
}

// 5. content script の注入（トップフレーム）
{
  const { contexts } = await contextsAfterReload('login.html')
  const extensionWorlds = contexts.filter(
    (c) => c.auxData?.isDefault === false && !/Electron/.test(c.name ?? '')
  )
  check(
    'ページに拡張の content script が入る',
    extensionWorlds.length > 0,
    extensionWorlds.map((c) => c.name).join(', ')
  )
}

// 6. iframe を含む全フレーム
await ui.ev(`window.nemo.navigate(${tabKey}, '${PAGES}/iframe.html')`)
await sleep(2500)
{
  const { contexts } = await contextsAfterReload('iframe.html')
  const extensionWorlds = contexts.filter(
    (c) => c.auxData?.isDefault === false && !/Electron/.test(c.name ?? '')
  )
  check(
    'iframe を含む全フレームに content script が入る',
    extensionWorlds.length >= 2,
    `isolated=${extensionWorlds.length}`
  )
}

// 7. ブラウザ UI には content script が入らない（セッション分離）
{
  const { contexts } = await contextsAfterReload('view=sidebar')
  const extensionWorlds = contexts.filter(
    (c) => c.auxData?.isDefault === false && !/Electron/.test(c.name ?? '')
  )
  check(
    'ブラウザ UI には content script が入らない',
    extensionWorlds.length === 0,
    extensionWorlds.map((c) => c.name).join(', ')
  )
}

// UI をリロードしたので接続し直す
const ui2 = await uiSession()

// 8. popup がタブ / ウィンドウモデルに乗る
await ui2.ev(`window.nemo.navigate(${tabKey}, '${PAGES}/popup.html')`)
await sleep(2500)
{
  const before = await ui2.ev('window.nemo.getWindowState()')
  const t = (await targets()).find((x) => x.url.includes('popup.html'))
  const page = await connect(t.webSocketDebuggerUrl)
  await page.send('Runtime.evaluate', {
    expression: `window.open('/login.html?site=popup-tab')`,
    userGesture: true
  })
  await sleep(2000)
  const after = await ui2.ev('window.nemo.getWindowState()')
  check(
    'window.open が registry に入る（Peek として親タブの上に浮く）',
    after.tabs.length === before.tabs.length + 1 &&
      after.tabs.some((tab) => tab.peekParentKey !== null && tab.url.includes('site=popup-tab')),
    `${before.tabs.length} -> ${after.tabs.length}`
  )

  // **サイズ指定つきの popup（OAuth・決済でよくある形）も Peek になる**。
  // 以前は別ウィンドウにしていたが、「前面に出そうとする要求はすべて Peek」に変えた
  // （DESIGN.md「Peek」）。ウィンドウは増えず、親タブの上に浮かぶ。
  const uiBefore = await uiWindowCount()
  await page.send('Runtime.evaluate', {
    expression: `window.open('/login.html?site=popup-window', '_blank', 'width=500,height=400')`,
    userGesture: true
  })
  await sleep(2500)
  const uiAfter = await uiWindowCount()
  const afterState = await ui2.ev('window.nemo.getWindowState()')
  const peeks = afterState.tabs.filter((tab) => tab.peekParentKey !== null)
  check(
    'サイズ指定の window.open が Peek になる（ウィンドウは増えない）',
    uiAfter === uiBefore && peeks.length === 1 && peeks[0].url.includes('site=popup-window'),
    `windows ${uiBefore} -> ${uiAfter} / peek=${peeks.map((tab) => tab.url).join(',')}`
  )

  // 次の検査に Peek を持ち越さない（可視 View の数が変わる）
  for (const peek of peeks) await ui2.ev(`window.nemo.closeTab('${peek.key}')`)
  await sleep(800)
}

// 9. 拡張が作るタブ / ウィンドウ（Phase 0 の中核）
//    ページの window.open ではなく chrome.tabs.create / chrome.windows.create を実際に呼ぶ。
{
  const sw = await swSession()
  const state0 = await ui2.ev('window.nemo.getWindowState()')
  const activeBefore = activeContentsId(state0)

  // 9-1. active: false は「作るがフォアグラウンドにしない」
  const bg = await sw.ev(`chrome.tabs.create({ url: '${PAGES}/login.html?site=ext-bg', active: false })`)
  await sleep(2500)
  const state1 = await ui2.ev('window.nemo.getWindowState()')
  check(
    'chrome.tabs.create が Nemo のタブになる',
    state1.tabs.length === state0.tabs.length + 1,
    `${state0.tabs.length} -> ${state1.tabs.length}`
  )
  check(
    'chrome.tabs.create の戻り値に tabId がある',
    typeof bg?.id === 'number',
    JSON.stringify(bg && { id: bg.id, windowId: bg.windowId, active: bg.active })
  )
  check(
    'active: false でアクティブタブが変わらない',
    activeContentsId(state1) === activeBefore,
    `active ${activeBefore} -> ${activeContentsId(state1)}`
  )
  check(
    'active: false のタブは registry に居るがアクティブではない',
    Boolean(tabByContentsId(state1, bg?.id)) && activeContentsId(state1) !== bg?.id
  )
  // 実際に前面に描画されていないこと（View の可視性）を UI 側から見る。
  // **Peek が出ていると可視 View は2つになる**（選択中の通常タブ＋その Peek）ので、
  // 「アクティブタブが含まれ、Peek でないものはそれだけ」で見る。
  const visible = await ui2.ev('window.nemo.getVisibleTabKeys()')
  const peekKeys = new Set(state1.tabs.filter((tab) => tab.peekParentKey !== null).map((tab) => tab.key))
  const visibleNormal = Array.isArray(visible) ? visible.filter((key) => !peekKeys.has(key)) : []
  check(
    'バックグラウンドタブの View が表示されていない',
    visibleNormal.length === 1 && visibleNormal[0] === state1.activeTabKey,
    `visible=${JSON.stringify(visible)} active=${state1.activeTabKey}`
  )

  // 9-2. active: true はフォアグラウンドになる
  const fg = await sw.ev(`chrome.tabs.create({ url: '${PAGES}/login.html?site=ext-fg', active: true })`)
  await sleep(2500)
  const state2 = await ui2.ev('window.nemo.getWindowState()')
  check(
    'active: true で作ったタブがアクティブになる',
    activeContentsId(state2) === fg?.id,
    `active=${activeContentsId(state2)} created=${fg?.id}`
  )

  // 9-3. windowId が Nemo のウィンドウと対応している
  const chromeWindowId = await sw.ev(`chrome.windows.getCurrent().then(w => w.id)`)
  check(
    'chrome.tabs.create の windowId が現在のウィンドウと一致する',
    bg?.windowId === chromeWindowId,
    `tab.windowId=${bg?.windowId} current=${chromeWindowId}`
  )
  // 1-8: 拡張のウィンドウ対応が Nemo の所有モデルと一致していること
  check(
    '拡張から見た windowId が Nemo のタブの所属ウィンドウと一致する',
    tabByContentsId(state1, bg?.id)?.chromeWindowId === bg?.windowId,
    `nemo=${tabByContentsId(state1, bg?.id)?.chromeWindowId} chrome=${bg?.windowId}`
  )

  // 9-4. chrome.windows.create が Nemo のウィンドウになる
  const uiBefore = await uiWindowCount()
  const created = await sw.ev(`chrome.windows.create({ url: '${PAGES}/login.html?site=ext-window' })`)
  await sleep(3000)
  const uiAfter = await uiWindowCount()
  check(
    'chrome.windows.create が Nemo のウィンドウになる',
    uiAfter === uiBefore + 1,
    `${uiBefore} -> ${uiAfter}`
  )
  check(
    'chrome.windows.create の戻り値に windowId がある',
    typeof created?.id === 'number',
    JSON.stringify(created && { id: created.id })
  )

  const allWindows = await sw.ev(`chrome.windows.getAll().then(w => w.map(x => x.id))`)
  check(
    'chrome.windows.getAll に新しいウィンドウが載る',
    Array.isArray(allWindows) && allWindows.includes(created?.id),
    JSON.stringify(allWindows)
  )

  // 9-5. 拡張からの片付け
  await sw.ev(`chrome.windows.remove(${created?.id}).then(() => 'ok')`)
  await sleep(2000)
  const uiFinal = await uiWindowCount()
  check('chrome.windows.remove でウィンドウが閉じる', uiFinal === uiBefore, `${uiAfter} -> ${uiFinal}`)

  await sw.ev(`chrome.tabs.remove(${bg?.id}).then(() => 'ok')`)
  await sleep(1500)
  const state3 = await ui2.ev('window.nemo.getWindowState()')
  check('chrome.tabs.remove でタブが registry から消える', !tabByContentsId(state3, bg?.id))
}

// 10. 拡張からの URL は検証を通ること（http/https と自分の拡張ページ以外は拒否）
{
  const sw = await swSession()
  const before = (await ui2.ev('window.nemo.getWindowState()')).tabs.length
  const rejected = await sw.ev(`chrome.tabs.create({ url: 'file:///etc/passwd' })
    .then(() => 'created', (e) => 'rejected: ' + (e && e.message))`)
  await sleep(1500)
  const after = (await ui2.ev('window.nemo.getWindowState()')).tabs.length
  check('拡張からの file: URL はタブにならない', after === before, `${rejected} / tabs ${before} -> ${after}`)

  const own =
    await sw.ev(`chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html'), active: false })
    .then(t => ({ id: t.id }), e => ({ error: String(e && e.message) }))`)
  await sleep(2000)
  check('拡張は自分の chrome-extension:// ページを開ける', typeof own?.id === 'number', JSON.stringify(own))
  if (typeof own?.id === 'number') {
    await sw.ev(`chrome.tabs.remove(${own.id}).then(() => 'ok')`)
    await sleep(1000)
  }
}

// 11. 拡張の service worker
{
  const sw = (await targets()).filter((t) => t.type === 'service_worker')
  check('拡張の service worker が動いている', sw.length > 0, sw.map((t) => t.url.slice(0, 60)).join(', '))
  const started = await ui2.ev('window.nemo.restartServiceWorkers()')
  check('service worker の再起動要求が通る', started >= 1, `started=${started}`)
}

// 12. chrome API の可否（動かないものを列挙する）
{
  const sw = await swSession()
  const probe = await sw.ev(`(async () => {
    const out = {}
    const check = async (name, fn) => {
      try { await fn(); out[name] = 'ok' } catch (e) { out[name] = String((e && e.message) || e) }
    }
    await check('tabs.query', () => chrome.tabs.query({}))
    await check('windows.getAll', () => chrome.windows.getAll())
    await check('storage.local', () => chrome.storage.local.get(null))
    await check('storage.session', () => chrome.storage.session.get(null))
    await check('storage.sync', () => chrome.storage.sync.get(null))
    await check('alarms.getAll', () => chrome.alarms.getAll())
    await check('notifications.getAll', () => chrome.notifications.getAll())
    await check('permissions.getAll', () => chrome.permissions.getAll())
    await check('declarativeNetRequest.getDynamicRules', () => chrome.declarativeNetRequest.getDynamicRules())
    await check('sidePanel.setOptions', () => chrome.sidePanel.setOptions({}))
    await check('commands.getAll', () => chrome.commands.getAll())
    await check('commands.onCommand', () => {
      if (typeof chrome.commands?.onCommand?.addListener !== 'function') throw new Error('onCommand が無い')
    })
    return out
  })()`)
  const KNOWN_MISSING = ['declarativeNetRequest', 'sidePanel', 'commands.onCommand']
  const ng = Object.entries(probe).filter(([, v]) => v !== 'ok')
  check(
    '既知の欠落以外の chrome API が使える',
    ng.every(([k]) => KNOWN_MISSING.some((known) => k.startsWith(known))),
    `NG: ${ng.map(([k]) => k).join(' / ') || 'なし'}`
  )
  console.log(`      使えない API: ${ng.map(([k]) => k).join(', ') || 'なし'}`)

  // commands は「呼べるが shortcut が空」= キーバインドが登録されていない、が実態
  const commands = await sw.ev(
    `chrome.commands.getAll().then(c => c.map(x => x.name + ':' + JSON.stringify(x.shortcut)))`
  )
  console.log(`      chrome.commands.getAll(): ${JSON.stringify(commands)}`)
}

// 13. タブを閉じたときの後始末
{
  const before = await ui2.ev('window.nemo.getWindowState()')
  const victim = JSON.stringify(before.tabs[before.tabs.length - 1].key)
  await ui2.ev(`window.nemo.closeTab(${victim})`)
  await sleep(1000)
  const after = await ui2.ev('window.nemo.getWindowState()')
  check('タブを閉じると registry から消える', after.tabs.length === before.tabs.length - 1)
}

// 14. IPC の検証（他ウィンドウ / 存在しないタブを操作できない）
{
  let rejected = false
  try {
    await ui2.ev(`window.nemo.selectTab('00000000-0000-0000-0000-000000000000')`)
  } catch (error) {
    rejected = /does not belong/.test(String(error))
  }
  check('未所有のタブ ID は IPC で拒否される', rejected)
}

console.log(failures === 0 ? '\nすべて PASS' : `\n${failures} 件 FAIL`)
process.exit(failures > 0 ? 1 : 0)
