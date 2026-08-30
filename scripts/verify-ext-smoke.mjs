#!/usr/bin/env node
/**
 * 拡張互換の smoke test（`mise run verify:ext`）。
 *
 * **CI の必須チェックにするための版**。計画 1-10 の「CI 必須（資格情報なし・決定的）」に対応する。
 * リポジトリ内の自作テスト拡張（`test-extension/`）だけを使うので、
 * 外部からのダウンロードも資格情報も要らず、結果が決定的になる。
 *
 * Electron を上げる PR ではここが落ちたら据え置く、という判断に使う。
 *
 *   node scripts/verify-ext-smoke.mjs            主要セット（再起動をまたぐ確認まで）
 *   node scripts/verify-ext-smoke.mjs --sw-idle  service worker の idle 停止もまたぐ（遅い）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  isChildAlive,
  projectRoot,
  readLogLines,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const withSwIdle = process.argv.includes('--sw-idle')

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extsmoke-'))
const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extsmoke-ext-'))

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = []
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
  spawned.push(child)
  return child
}
function runToCompletion(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

const appEnv = () => ({
  ...process.env,
  NEMO_REMOTE_DEBUGGING_PORT: debugPort,
  NEMO_USER_DATA_DIR: userDataDir,
  NEMO_EXT_DIR: path.join(extRoot, 'extensions'),
  NEMO_EXT_LOCK: path.join(extRoot, 'extensions.lock.json'),
  // 分割中の popup 位置を見るのに、ペインの実 bounds を main から出してもらう
  NEMO_VERIFY_DIAGNOSTICS: '1',
  // 拡張の SW / content script の console を診断ログに落とす（dev 用スイッチ。5c で見る）
  NEMO_EXT_CONSOLE: '1'
})

async function startPagesServer() {
  const child = start(process.execPath, ['scripts/test-server.mjs'], {
    env: { ...process.env, PORT: pagesPort },
    stdio: 'ignore'
  })
  await waitForHttp(`${pages}/__nemo_test_pages__`, {
    child,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${child.pid}`)
  })
  return child
}

async function startApp() {
  const child = start(electronPath, ['out/main/index.js'], { env: appEnv() })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return child
}

async function stopAll() {
  await stopChildren(spawned.filter(isChildAlive))
}

/** service worker の target（CDP でつなぐと idle 停止しなくなるので、必要なときだけつなぐ）。 */
async function swTarget() {
  return (await listTargets(cdp)).find((t) => t.type === 'service_worker') ?? null
}

async function swSession() {
  const target = await swTarget()
  if (!target) throw new Error('拡張の service worker が動いていない')
  return connect(target.webSocketDebuggerUrl)
}

try {
  assertNemoNotRunning('verify:ext')
  console.log(`（CDP ${cdp} / テストページ ${pages} / userData ${userDataDir}）`)

  console.log('\n=== テスト拡張を用意する')
  if ((await runToCompletion(process.execPath, ['scripts/make-test-extension.mjs', extRoot])) !== 0) {
    throw new Error('テスト拡張の生成に失敗した')
  }
  const lock = JSON.parse(fs.readFileSync(path.join(extRoot, 'extensions.lock.json'), 'utf8'))
  const expected = lock.extensions[0]

  console.log('\n=== ビルド')
  if ((await runToCompletion('pnpm', ['exec', 'electron-vite', 'build'])) !== 0) {
    throw new Error('ビルド失敗')
  }

  await startPagesServer()
  await startApp()

  const ui = await connectUi(cdp)

  /* ---- 1. ロード ---- */
  const loaded = await ui.ev('window.nemo.getExtensions().then((e) => JSON.stringify(e))').then(JSON.parse)
  check(
    'lock どおりの ID / version でロードされる',
    // ロード失敗行も lock の id / version で一覧に残るので、`enabled && matchesLock`（= ロードできた）まで見る
    loaded.length === 1 &&
      loaded[0].id === expected.id &&
      loaded[0].version === expected.version &&
      loaded[0].enabled === true &&
      loaded[0].matchesLock === true,
    JSON.stringify(loaded.map((e) => `${e.id} ${e.version}`))
  )
  check('オプションページが検出される', Boolean(loaded[0]?.optionsUrl), loaded[0]?.optionsUrl ?? '')

  /* ---- 2. service worker ---- */
  // 起動には数秒かかることがある（CI の遅いマシンで顕著）。瞬間値で判定しない。
  const swUp = await (async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await swTarget()) return true
      await sleep(500)
    }
    return false
  })()
  check('service worker が起動している', swUp)

  /* ---- 3. content script（トップ + iframe） ---- */
  await ui.ev(`window.nemo.createTab('${pages}/iframe.html').then((k) => k)`)
  await sleep(2500)
  const page = await connectTo(cdp, '/iframe.html')
  const marks = await page
    .ev(
      `(() => {
    const top = document.documentElement.getAttribute('data-nemo-ci')
    // **同一オリジンの iframe だけを見る**。ページに挿さる iframe が増えたときに
    // 巻き添えで落ちないよう、このページが置いている /login.html の iframe に絞る。
    const frames = [...document.querySelectorAll('iframe[src^="/login.html"]')].map((f) => {
      try { return f.contentDocument.documentElement.getAttribute('data-nemo-ci') } catch { return 'cross-origin' }
    })
    return JSON.stringify({ top, frames, ping: document.documentElement.getAttribute('data-nemo-ci-ping') })
  })()`
    )
    .then(JSON.parse)
  check('content script がトップフレームに入る', marks.top === 'top', JSON.stringify(marks))
  check(
    'content script が iframe にも入る',
    marks.frames.length > 0 && marks.frames.every((m) => m === 'frame'),
    JSON.stringify(marks.frames)
  )
  check('content script から service worker へメッセージが通る', marks.ping === 'true', String(marks.ping))

  /* ---- 3b. 拡張ページを iframe で読めるか（web_accessible_resources） ---- */
  // Bitwarden のインラインオートフィル候補は、この経路で挿す iframe で出来ている。
  // ページ側 WebContents の will-frame-navigate が chrome-extension: を一律拒否していると
  // 候補が出せない。**公開したものは読め、公開していないものは読めない**の両方を固定する。
  {
    await ui.ev(`window.nemo.createTab('${pages}/war-frame.html').then((k) => k)`)
    await sleep(2500)
    const warPage = await connectTo(cdp, '/war-frame.html')
    // 非公開側が「Chromium に拒否された」ことまで見たいので、
    // ネットワークのイベントを拾える状態にしてから読み込み直す。
    await warPage.send('Page.enable')
    await warPage.send('Network.enable')
    await warPage.send('Page.reload')
    await sleep(1500)
    // content script 側の待ちは 5 秒。timeout が確定するまで待ってから読む。
    const war = await (async () => {
      const deadline = Date.now() + 15000
      for (;;) {
        const state = await warPage
          .ev(
            `JSON.stringify({
          open: document.documentElement.getAttribute('data-nemo-ci-war'),
          hidden: document.documentElement.getAttribute('data-nemo-ci-war-private'),
          host: document.documentElement.getAttribute('data-nemo-ci-war-host')
        })`
          )
          .then(JSON.parse)
        const settled = (v) => v === 'ok' || v === 'timeout'
        if ((settled(state.open) && settled(state.hidden)) || Date.now() > deadline) return state
        await sleep(500)
      }
    })()

    check(
      '公開した拡張ページが iframe の中で走る（web_accessible_resources）',
      war.open === 'ok',
      JSON.stringify(war)
    )
    check(
      '公開していない拡張ページは iframe で読めない',
      war.hidden === 'timeout',
      `data-nemo-ci-war-private=${war.hidden}`
    )
    // 「読めない」を timeout だけで判定すると、拡張が壊れて何も挿さらなくても PASS する。
    // **Chromium が拒否した**ことをネットワーク層の理由まで見て確定させる。
    //
    // 非公開側は `requestWillBeSent` が飛ばないまま落ちるので requestId から URL を引けない。
    // このページが挿す iframe は 2 つだけなので、**公開側が ok であること**（上の check）と
    // 合わせれば、残る `ERR_BLOCKED_BY_CLIENT` は非公開側のものと判断できる。
    const blockedByClient = warPage.events.filter(
      (event) =>
        event.method === 'Network.loadingFailed' && event.params.errorText === 'net::ERR_BLOCKED_BY_CLIENT'
    )
    check(
      '公開していない拡張ページは Chromium に拒否される（ERR_BLOCKED_BY_CLIENT）',
      war.open === 'ok' && blockedByClient.length > 0,
      `open=${war.open} / ERR_BLOCKED_BY_CLIENT ${blockedByClient.length} 件`
    )
    // ここが拡張 ID と同じなら use_dynamic_url を踏んでいない＝
    // ホストで allowlist する実装に戻っても検知できない状態になっている。
    check(
      'iframe のホストが拡張 ID と異なる（use_dynamic_url）',
      Boolean(war.host) && war.host !== expected.id,
      `host=${war.host} / id=${expected.id}`
    )

    // トップレベル遷移は拒否したまま（サブフレームだけ通す、が効いているか）。
    const target = `chrome-extension://${expected.id}/popup.html`
    await warPage.ev(`(() => { window.location.href = ${JSON.stringify(target)}; return 'ok' })()`)
    await sleep(2000)
    const landed = await warPage.ev('window.location.href')
    check(
      'ページから拡張ページへのトップレベル遷移は拒否される',
      typeof landed === 'string' && !landed.startsWith('chrome-extension:'),
      String(landed)
    )
    /** 診断ログから navigation.blocked を phase / isMainFrame で数える。 */
    const blockedCount = (phase) =>
      readLogLines(userDataDir).filter((line) => {
        try {
          const entry = JSON.parse(line)
          return entry.event === 'navigation.blocked' && entry.phase === phase && entry.isMainFrame === true
        } catch {
          return false
        }
      }).length

    // will-frame-navigate は will-navigate より先に発火する。ここで止めていることまで見ないと、
    // 全フレームをサブフレーム扱いする配線ミスをしても後段の will-navigate が拒否して PASS してしまう。
    check(
      'メインフレームの拡張ページ遷移が will-frame-navigate で止まっている',
      blockedCount('will-frame-navigate') > 0,
      `該当ログ ${blockedCount('will-frame-navigate')} 件`
    )

    // **サーバ側 302 で拡張ページへ飛ばす経路**も塞げているか。
    // `location.href` の遷移は will-frame-navigate しか踏まないので、
    // will-redirect のトップフレーム側はこの経路でしか検証できない
    // （ここが緩むと、リダイレクト1つで Web ページから拡張ページへ入れてしまう）。
    const redirectTo = `${pages}${'/__nemo_redirect__'}?to=${encodeURIComponent(target)}`
    await warPage.ev(`(() => { window.location.href = ${JSON.stringify(redirectTo)}; return 'ok' })()`)
    await sleep(2500)
    const landedAfterRedirect = await warPage.ev('window.location.href')
    check(
      '302 で拡張ページへリダイレクトさせても遷移しない',
      typeof landedAfterRedirect === 'string' && !landedAfterRedirect.startsWith('chrome-extension:'),
      String(landedAfterRedirect)
    )
    check(
      'メインフレームの拡張ページへのリダイレクトが will-redirect で止まっている',
      blockedCount('will-redirect') > 0,
      `該当ログ ${blockedCount('will-redirect')} 件`
    )
  }

  /* ---- 4. chrome.tabs / chrome.windows ---- */
  {
    const sw = await swSession()
    const before = await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    const bg = await sw.ev(`chrome.tabs.create({ url: '${pages}/login.html', active: false })`)
    await sleep(1500)
    const after = await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    check('chrome.tabs.create が Nemo のタブになる', after.tabs.length === before.tabs.length + 1)
    check(
      'active: false のタブはアクティブにならない',
      after.activeTabKey === before.activeTabKey,
      `${before.activeTabKey?.slice(0, 4)} -> ${after.activeTabKey?.slice(0, 4)}`
    )
    const created = after.tabs.find((t) => t.webContentsId === bg?.id)
    check(
      '拡張から見た windowId が Nemo の所属ウィンドウと一致する',
      created?.chromeWindowId === bg?.windowId
    )

    const uiCountBefore = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    const win = await sw.ev(`chrome.windows.create({ url: '${pages}/index.html' })`)
    await sleep(2500)
    const uiCountAfter = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    check('chrome.windows.create が Nemo のウィンドウになる', uiCountAfter === uiCountBefore + 1)
    await sw.ev(`chrome.windows.remove(${win?.id}).then(() => 'ok')`)
    await sleep(1500)
    const uiCountFinal = (await listTargets(cdp)).filter((t) => t.url.includes('view=sidebar')).length
    check('chrome.windows.remove でウィンドウが閉じる', uiCountFinal === uiCountBefore)

    await sw.ev(`chrome.tabs.remove(${bg?.id}).then(() => 'ok')`)

    // 作った直後のウィンドウを閉じても main プロセスが落ちないこと。
    //
    // 準備待ちで積んである「初期タブを作る」処理が破棄済みウィンドウで走ると
    // `Object has been destroyed` で落ちる。**このテストはその競合を強制はできない**
    // （UI のロードが速いと素通りする）。競合そのものは registry 側のガードで塞いであり、
    // 実際に起きたときは最後の「例外がログに1件も無い」で捕まえる。
    const quick = await sw.ev(`chrome.windows.create({ url: '${pages}/index.html' })`)
    await sw.ev(`chrome.windows.remove(${quick?.id}).then(() => 'ok', (e) => 'error: ' + e.message)`)
    await sleep(3000)
    const alive = await ui
      .ev(`window.nemo.getAppStatus().then((s) => JSON.stringify(s))`)
      .then(JSON.parse, () => null)
    check(
      'UI の準備前にウィンドウを閉じても main プロセスが落ちない',
      alive !== null && alive.ready === true,
      JSON.stringify(alive)
    )

    sw.close()
  }

  /* ---- 5. popup ---- */
  {
    const sw = await swSession()
    // `chrome.action.openPopup()` は「どのウィンドウに出すか」を
    // フォーカス中のウィンドウから決めるので、直前にウィンドウを閉じていると
    // 取りこぼすことがある。**開くところまでを再試行する**。
    let popup = null
    let openResult = ''
    for (let attempt = 0; attempt < 3 && !popup; attempt += 1) {
      openResult = await sw.ev(
        `chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + (e && e.message))`
      )
      popup = await connectTo(cdp, 'popup.html', { timeoutMs: 5000 }).catch(() => null)
    }
    const ready = popup
      ? await waitFor(
          popup,
          `document.getElementById('ready')?.textContent === 'popup-ready' ? 'ready' : ''`
        ).catch(() => '')
      : ''
    check('popup が開いて chrome.* が使える', ready === 'ready', popup ? '' : `openPopup: ${openResult}`)

    // popup ↔ service worker のメッセージング。
    // Bitwarden のログインは popup が service worker からの通知を待つ作りなので、
    // ここが1つでも通らないと popup がスピナーのまま止まる（実機で発生した症状）。
    const messaging = popup
      ? await waitFor(popup, `document.getElementById('messaging')?.textContent || ''`, {
          timeoutMs: 20000
        })
          .then(JSON.parse)
          .catch(() => null)
      : null
    for (const [name, label] of [
      ['popupToWorker', 'popup → service worker（応答つき）'],
      ['workerToPopup', 'service worker → popup（一斉配信）'],
      ['portRoundTrip', '長寿命 port の往復'],
      ['storageChanged', 'service worker の書き込みが popup の storage.onChanged に届く'],
      ['ignoredWithCallback', '応答されない sendMessage の callback が呼ばれる'],
      ['ignoredAsPromise', '応答されない sendMessage の Promise が決着する'],
      ['wasmInPopup', 'popup で WebAssembly が使える（manifest の wasm-unsafe-eval が効く）']
    ]) {
      check(label, messaging?.[name] === 'ok', messaging ? String(messaging[name]) : '結果が出ない')
    }
    // 次のケースはクリックで popup を開く。開いたままだとクリックが
    // トグル（閉じる）になるので、**ウィンドウごと閉じてから**次へ進む
    await popup?.ev('window.close()').catch(() => {})
    popup?.close()
    await sleep(500)
    sw.close()
  }

  /* ---- 5c. chrome.storage.onChanged（コンテキストをまたぐ通知） ---- */
  {
    /*
     * Bitwarden の状態管理は `storageArea.onChanged` で「他コンテキストでの変更」を知る。
     * Electron 41 は **service worker 側で onChanged を鳴らさない**（popup で受ける側は鳴る）ので、
     * popup で Vault を解除しても SW が知らず、アイコンがロックのまま・インラインメニューが
     * 「Unlock」のままになる（2026-08-30 に実測）。Nemo の preload が polyfill で補う。
     *
     * 送り手 {SW, popup} × area {local, session} × 受け手 {SW, popup} を別々に見る。
     * **受け手が SW の check は「今ネイティブで落ちている経路」**なので名前に [SW受信] を付け、
     * polyfill が丸ごと外れた回帰をここで拾う。件数は「ちょうど N 回」で見る（二重配信も落とす）。
     */
    const sw = await swSession()
    let popup = null
    for (let attempt = 0; attempt < 3 && !popup; attempt += 1) {
      await sw.ev(`chrome.action.openPopup().then(() => 'ok', (e) => 'error: ' + (e && e.message))`)
      popup = await connectTo(cdp, 'popup.html', { timeoutMs: 5000 }).catch(() => null)
    }
    check('[storage] popup を開けた', popup !== null)
    // popup.js の初期化（自分の storage 書き込み・SW への touch）が**終わってから**記録を空にする。
    // target ができた直後に繋ぐと、まだ popup.js が走っておらずリスナーも無い（最初の check だけ 0 件になる）
    if (popup) {
      // popup.js の probe は within(3000) × 7 本で最悪 21 秒かかるので、待ちはそれより長く取る
      const initialized = await waitFor(
        popup,
        `document.getElementById('messaging')?.textContent ? 'ready' : ''`,
        { timeoutMs: 25000 }
      ).catch(() => '')
      check('[storage] popup の初期化（#messaging）が終わった', initialized === 'ready')
    }
    const reset = async () => {
      await sw.ev(`(self.__nemoStorageEvents = []).length`)
      await popup?.ev(`(window.__nemoStorageEvents = []).length`)
    }
    /** 受け手の記録から、area と via が一致するものだけ取り出す（少し待って落ち着かせる）。 */
    let lastRaw = ''
    const eventsOf = async (side, area, via = 'storage.onChanged') => {
      await sleep(700)
      const raw =
        side === 'sw'
          ? await sw.ev(`JSON.stringify(self.__nemoStorageEvents)`)
          : await popup?.ev(`JSON.stringify(window.__nemoStorageEvents)`)
      lastRaw = raw ?? ''
      return (raw ? JSON.parse(raw) : []).filter((e) => e.area === area && e.via === via)
    }
    // 件数が合わないときは受け手の記録を**絞る前の形**で出す（area / via の取り違えをその場で見分ける）
    const exactly = (name, events, n, extra = () => true) =>
      check(
        name,
        events.length === n && events.every(extra),
        `${events.length} 件: ${JSON.stringify(events)}${
          events.length === n && events.every(extra) ? '' : ` / 全記録: ${lastRaw}`
        }`
      )

    if (popup) {
      // popup → session
      await reset()
      await popup.ev(`chrome.storage.session.set({ __nemo_s1__: 1 }).then(() => 'ok')`)
      exactly(
        '[SW受信] popup の session.set が SW の storage.onChanged に 1 回届く',
        await eventsOf('sw', 'session'),
        1
      )
      exactly(
        '[SW受信] popup の session.set が SW の session.onChanged に 1 回届く',
        await eventsOf('sw', 'session', 'session.onChanged'),
        1
      )
      exactly(
        '[popup受信] popup 自身の session.set が popup に 1 回届く',
        await eventsOf('popup', 'session'),
        1
      )

      // popup → local（複数キーは 1 イベント）
      await reset()
      await popup.ev(`chrome.storage.local.set({ __nemo_a__: 1, __nemo_b__: 2 }).then(() => 'ok')`)
      exactly(
        '[SW受信] popup の local.set({a,b}) が SW に 1 イベント（changes に 2 キー）で届く',
        await eventsOf('sw', 'local'),
        1,
        (e) => e.keys.length === 2 && e.saved.length === 2
      )
      exactly('[popup受信] popup 自身の local.set が popup に 1 回届く', await eventsOf('popup', 'local'), 1)

      // SW → local remove（実在キー）
      await reset()
      await sw.ev(`chrome.storage.local.remove('__nemo_a__').then(() => 'ok')`)
      exactly(
        '[popup受信] SW の local.remove が popup に 1 回届く（newValue 無し）',
        await eventsOf('popup', 'local'),
        1,
        (e) => e.keys.includes('__nemo_a__') && e.saved.length === 0
      )
      exactly('[SW受信] SW 自身の local.remove が SW に 1 回届く', await eventsOf('sw', 'local'), 1)

      // SW → session
      await reset()
      await sw.ev(`chrome.storage.session.set({ __nemo_s2__: 1 }).then(() => 'ok')`)
      exactly('[popup受信] SW の session.set が popup に 1 回届く', await eventsOf('popup', 'session'), 1)
      exactly('[SW受信] SW 自身の session.set が SW に 1 回届く', await eventsOf('sw', 'session'), 1)

      // 同じ値を 2 回（同値でも通知する。台帳が「内容一致で捨てる」形になっていないこと）
      await reset()
      await popup.ev(
        `chrome.storage.local.set({ __nemo_same__: 'x' }).then(() => chrome.storage.local.set({ __nemo_same__: 'x' })).then(() => 'ok')`
      )
      exactly('[SW受信] popup が同じ値を 2 回書くと SW で 2 回鳴る', await eventsOf('sw', 'local'), 2)
      exactly(
        '[popup受信] popup が同じ値を 2 回書くと popup で 2 回鳴る',
        await eventsOf('popup', 'local'),
        2
      )

      // 存在しないキーを混ぜた remove（実在するキーだけで、ちょうど 1 回）
      await reset()
      await sw.ev(`chrome.storage.local.remove(['__nemo_b__', '__nemo_missing__']).then(() => 'ok')`)
      exactly(
        '[popup受信] 存在しないキーを混ぜた SW の remove が popup に 1 回、実在キーだけで届く',
        await eventsOf('popup', 'local'),
        1,
        (e) => e.keys.length === 1 && e.keys[0] === '__nemo_b__'
      )

      // 配送メッセージの形を受けても拡張のハンドラが壊れない（polyfill 前は飛ばないので手で 1 回送る）
      await sw.ev(
        `chrome.runtime.sendMessage({ __nemo: 'storage-changed', area: 'local', keys: ['__nemo_x__'], type: 'save' }, () => void chrome.runtime.lastError); 1`
      )
      const echo = await popup.ev(
        `chrome.runtime.sendMessage({ type: 'echo', value: 'still-ok' }).then((r) => r?.echo ?? 'no')`
      )
      check(
        '配送メッセージの形を受けても popup ↔ SW のメッセージングが壊れない',
        echo === 'still-ok',
        String(echo)
      )

      await popup.ev('window.close()').catch(() => {})
      popup.close()
      await sleep(500)
    }

    // 診断ログ: NEMO_EXT_CONSOLE=1 で SW の console.error が URL を伏せて載る（CDP から直接吐かせる。
    // 拡張自身の sendMessage は送信元には配られないので「メッセージで起こす」形にはしない）
    await sw.ev(`console.error('nemo ci error https://example.com/secret?token=1'); 1`)
    await sleep(700)
    const lines = readLogLines(userDataDir)
    check(
      'NEMO_EXT_CONSOLE=1 で console の取り込みが有効になる（extension.console_watch_enabled）',
      lines.some((l) => l.includes('"event":"extension.console_watch_enabled"'))
    )
    const swConsole = lines.filter(
      (l) => l.includes('"event":"extension.sw_console"') && l.includes('nemo ci error')
    )
    check(
      'SW の console.error が extension.sw_console に URL を伏せて載る',
      swConsole.length >= 1 &&
        swConsole.every((l) => !l.includes('secret') && l.includes('https://example.com')),
      swConsole.map((l) => l.slice(0, 200)).join(' / ')
    )
    sw.close()
  }

  /* ---- 5b. popup の表示位置 ---- */
  {
    /*
     * `chrome.action.openPopup()` はウィンドウ右上の擬似アンカーで開くので、
     * **ツールバーのボタンを実際にクリックする経路**でないと位置を検証できない。
     *
     * アンカー（`<browser-action-list>`）はサイドバーの右の**ツールバー View**に載る。
     * electron-chrome-extensions は View 内の座標にウィンドウの左上を足すだけなので、
     * 足し戻さないと**サイドバー幅ぶん左**（サイドバーの上）に出る
     * （`extensions.ts` の `popupAnchorOffset`）。
     * 伸びる向きは既定（アンカーの右端に popup の右端を合わせて左へ伸びる）。
     * ツールバーの右端にアイコンがあるので、右へ伸ばすと画面外に見切れる。
     */
    await ui.ev("window.nemo.setSidebarVisible(true).then(() => 'ok')")
    const windowId = (
      await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
    ).windowId
    // **ウィンドウ ID まで指定して繋ぐ**（破棄したウィンドウの UI ターゲットも一覧に残る）
    const toolbar = await connectUi(cdp, `toolbar&window=${windowId}`)

    /*
     * ツールバーに出すのは lock で `showInToolbar` にした拡張だけ（`Toolbar.tsx` が
     * shadowRoot に style を差し込んで残りを隠す）。テスト拡張は 1 つしか無く、
     * フラグ無しの拡張を実際にロードするのは重いので、**別 ID の `.action` を
     * shadowRoot に複製して境界を作り**、`getComputedStyle` で隠れることを見る。
     * テスト拡張のボタン自身（フラグあり）は隠れないことも同時に確認する。
     */
    const visibility = await toolbar
      .ev(
        `(() => {
          const list = document.querySelector('browser-action-list')
          const root = list && list.shadowRoot
          const btn = root && root.querySelector('.action')
          if (!btn) return JSON.stringify({ ok: false })
          const other = btn.cloneNode(false)
          other.id = 'a'.repeat(32)
          root.appendChild(other)
          const result = {
            ok: true,
            shown: getComputedStyle(btn).display,
            hiddenOther: getComputedStyle(other).display,
            styleCount: root.querySelectorAll('style[data-nemo-action-filter]').length
          }
          other.remove()
          return JSON.stringify(result)
        })()`
      )
      .then(JSON.parse)
    check(
      'showInToolbar の拡張のボタンは表示される',
      visibility.ok && visibility.shown !== 'none',
      JSON.stringify(visibility)
    )
    check(
      'showInToolbar でない拡張のボタンは隠れる',
      visibility.ok && visibility.hiddenOther === 'none',
      JSON.stringify(visibility)
    )
    check(
      '表示フィルタの style は 1 枚だけ',
      visibility.ok && visibility.styleCount === 1,
      JSON.stringify(visibility)
    )

    const sidebarWidth = JSON.parse(await ui.ev('JSON.stringify(innerWidth)'))
    const anchor = await toolbar
      .ev(
        `(() => {
          const list = document.querySelector('browser-action-list')
          const btn = list && (list.shadowRoot ?? list).querySelector('.action')
          if (!btn) return JSON.stringify({ ok: false })
          const r = btn.getBoundingClientRect()
          btn.click()
          return JSON.stringify({ ok: true, right: window.screenX + ${sidebarWidth} + r.right })
        })()`
      )
      .then(JSON.parse)
    const popup = anchor.ok ? await connectTo(cdp, 'popup.html', { timeoutMs: 5000 }).catch(() => null) : null
    // 位置は preferred size が届いた後に確定するので、少し待ってから読む
    if (popup) await sleep(1000)
    const box = popup
      ? await popup
          .ev(
            `JSON.stringify({
              left: window.screenX, top: window.screenY,
              width: window.outerWidth, height: window.outerHeight,
              availLeft: screen.availLeft, availTop: screen.availTop,
              availWidth: screen.availWidth, availHeight: screen.availHeight
            })`
          )
          .then(JSON.parse, () => null)
      : null
    check('ツールバーのボタンのクリックで popup が開く', box !== null, anchor.ok ? '' : 'ボタンが無い')
    if (box) {
      check(
        'popup が画面内に収まる',
        box.left >= box.availLeft &&
          box.left + box.width <= box.availLeft + box.availWidth &&
          box.top >= box.availTop &&
          box.top + box.height <= box.availTop + box.availHeight,
        JSON.stringify(box)
      )
      // 画面端で押し戻された場合を誤検出しないよう、そのまま置ける位置のときだけ見る
      if (anchor.right - box.width >= box.availLeft && anchor.right <= box.availLeft + box.availWidth) {
        check(
          'popup の右端がアイコンの右端に合う（サイドバー幅ぶん左にずれない）',
          Math.abs(box.left + box.width - anchor.right) <= 2,
          `popup right ${box.left + box.width} / anchor right ${anchor.right}`
        )
      }
      await popup.ev('window.close()').catch(() => {})
    }
    popup?.close()

    /*
     * **分割中も同じ位置に出ること**。
     * 分割すると左ペインのツールバーは外周余白ぶん右へ動くので、
     * `popupAnchorOffset` がサイドバー幅のままだとその余白ぶん左にずれる。
     * 期待値は診断 IPC が返す**左ペインの実 x** から取る（定数を書き写さない）。
     */
    const keys = JSON.parse(
      await ui.ev(`Promise.all([
        window.nemo.createTab('about:blank', { background: true }),
        window.nemo.createTab('about:blank', { background: true })
      ]).then((k) => JSON.stringify(k))`)
    )
    await ui.ev(
      `window.nemo.splitTabs(${JSON.stringify(keys[0])}, ${JSON.stringify(keys[1])}).then(() => 'ok')`
    )
    const diag = JSON.parse(await ui.ev('window.nemo.splitDiagnostics().then((d) => JSON.stringify(d))'))
    const leftPane = diag?.panes?.find((pane) => pane.side === 'left') ?? null
    if (leftPane) {
      const splitAnchor = await toolbar
        .ev(
          `(() => {
            const list = document.querySelector('browser-action-list')
            const btn = list && (list.shadowRoot ?? list).querySelector('.action')
            if (!btn) return JSON.stringify({ ok: false })
            const r = btn.getBoundingClientRect()
            btn.click()
            return JSON.stringify({ ok: true, right: window.screenX + ${leftPane.outer.x} + r.right })
          })()`
        )
        .then(JSON.parse)
      const splitPopup = splitAnchor.ok
        ? await connectTo(cdp, 'popup.html', { timeoutMs: 5000 }).catch(() => null)
        : null
      if (splitPopup) await sleep(1000)
      const splitBox = splitPopup
        ? await splitPopup
            .ev(
              `JSON.stringify({ left: window.screenX, width: window.outerWidth,
                availLeft: screen.availLeft, availWidth: screen.availWidth })`
            )
            .then(JSON.parse, () => null)
        : null
      if (
        splitBox &&
        splitAnchor.right - splitBox.width >= splitBox.availLeft &&
        splitAnchor.right <= splitBox.availLeft + splitBox.availWidth
      ) {
        check(
          '分割中も popup の右端がアイコンの右端に合う（外周余白ぶんずれない）',
          Math.abs(splitBox.left + splitBox.width - splitAnchor.right) <= 2,
          `popup right ${splitBox.left + splitBox.width} / anchor right ${splitAnchor.right}`
        )
      } else {
        check(
          '分割中も popup の右端がアイコンの右端に合う（外周余白ぶんずれない）',
          splitBox !== null,
          splitBox ? '画面端で押し戻されたので位置は見ない' : 'popup が開かなかった'
        )
      }
      await splitPopup?.ev('window.close()').catch(() => {})
      splitPopup?.close()
    } else {
      check(
        '分割中も popup の右端がアイコンの右端に合う（外周余白ぶんずれない）',
        false,
        '分割が作れなかった'
      )
    }
    for (const key of keys) await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)

    toolbar.close()
    await sleep(500)
  }

  /* ---- 6. オプションページ ---- */
  {
    await ui.ev(`window.nemo.openExtensionOptions(${JSON.stringify(expected.id)}).then(() => 'ok')`)
    const options = await connectTo(cdp, 'options.html', { timeoutMs: 10000 })
    // target ができた直後は本文がまだ無いことがあるので、描画まで待つ
    const ready = await waitFor(options, `document.getElementById('options-ready')?.textContent ?? ''`).catch(
      () => ''
    )
    check('拡張のオプションページを Nemo から開ける', ready === 'options-ready', ready)

    /* ---- 6b. 拡張ページ向けの chrome.* 補完（chrome.debugger の空実装） ---- */
    // Nemo の preload（extension-shim）は electron-chrome-extensions の preload より**先に登録**
    // されている必要がある（後者が最後に `Object.freeze(chrome)` する）。登録順が崩れると
    // ここが `undefined` になる。**同時に `chrome.runtime.id` が生きている**ことも見る
    // （shim が別の `chrome` オブジェクトを作って ece の注入先がずれていないこと）。
    const shim = await options
      .ev(
        `JSON.stringify({
          debugger: typeof chrome.debugger,
          addListener: typeof chrome.debugger?.onEvent?.addListener,
          runtimeId: chrome.runtime?.id ?? null,
          tabs: typeof chrome.tabs
        })`
      )
      .then(JSON.parse)
    check(
      '拡張ページに chrome.debugger の空実装が生えている（ece の freeze より先）',
      shim.debugger === 'object' && shim.addListener === 'function',
      JSON.stringify(shim)
    )
    check(
      'shim を入れても chrome.runtime.id / chrome.tabs は生きている（ece の注入先がずれていない）',
      shim.runtimeId === expected.id && shim.tabs === 'object',
      JSON.stringify(shim)
    )
    options.close()

    const leak = await page
      .ev(`JSON.stringify({ chrome: typeof window.chrome, debugger: typeof window.chrome?.debugger })`)
      .then(JSON.parse)
    check(
      '素のページには chrome.debugger が漏れていない',
      leak.debugger === 'undefined',
      JSON.stringify(leak)
    )
  }

  /* ---- 6c. DevTools パネル（devtools_page）の frame にも補完が届く ---- */
  // GraphQL Network Inspector が真っ白になった経路そのもの。パネルの iframe は
  // DevTools がパネルを初めて表示したときに作られるので、⌘] でパネルを順送りして到達させる。
  {
    const devKey = await ui.ev(`window.nemo.createTab('${pages}/login.html').then((k) => k)`)
    await sleep(2000)
    await ui.ev(`window.nemo.toggleDevTools(${JSON.stringify(devKey)}).then(() => 'ok')`)
    const devtoolsTarget = await (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const found = (await listTargets(cdp)).find((t) => t.url.startsWith('devtools://'))
        if (found) return found
        await sleep(500)
      }
      return null
    })()
    check('DevTools が開く', Boolean(devtoolsTarget))
    if (devtoolsTarget) {
      const devtools = await connect(devtoolsTarget.webSocketDebuggerUrl)
      await sleep(3000)
      let panelTarget = null
      for (let i = 0; i < 16 && !panelTarget; i += 1) {
        const key = { key: ']', code: 'BracketRight', modifiers: 4, windowsVirtualKeyCode: 221 }
        await devtools.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
        await devtools.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        await sleep(800)
        panelTarget =
          (await listTargets(cdp)).find((t) => t.url.includes(`${expected.id}/panel.html`)) ?? null
      }
      check('devtools_page が足したパネルが DevTools に出る', Boolean(panelTarget), panelTarget?.url ?? '')
      if (panelTarget) {
        const panel = await connect(panelTarget.webSocketDebuggerUrl)
        const apis = await waitFor(panel, `document.getElementById('panel-apis')?.textContent ?? ''`)
          .then((text) => JSON.parse(text))
          .catch((error) => ({ error: error.message }))
        check(
          'DevTools パネルの frame にも chrome.debugger の空実装が届く（CDP 経路: src/main/devtools-shim.ts）',
          apis.debugger === 'object' && apis.onEvent === 'function' && apis.addListenerOk === true,
          JSON.stringify(apis)
        )
        // webRequest の tabId フィルタ（Electron は tabId: -1 で流すので、外さないと一度も発火しない）
        await ui.ev(`window.nemo.getWindowState().then(() => 'ok')`)
        const pageForDevtools = await connectTo(cdp, '/login.html')
        await pageForDevtools.ev(`fetch('${pages}/iframe.html?from-devtools-probe').then((r) => r.status)`)
        const webRequestSeen = await waitFor(
          panel,
          `(document.getElementById('panel-webrequest')?.textContent ?? '').includes('from-devtools-probe') ? document.getElementById('panel-webrequest').textContent : ''`,
          { timeoutMs: 10000 }
        ).catch((error) => `TIMEOUT: ${error.message}`)
        check(
          'パネルの { tabId } 付き webRequest listener に inspected tab のリクエストが届く（tabId フィルタの補完）',
          webRequestSeen.includes('from-devtools-probe'),
          webRequestSeen.slice(0, 200)
        )
        pageForDevtools.close()
        check(
          'パネルの frame で chrome.runtime.id / chrome.devtools が生きている',
          apis.runtimeId === expected.id && apis.devtools === 'object',
          JSON.stringify(apis)
        )
        panel.close()
      }
      devtools.close()
    }
    await ui.ev(`window.nemo.closeTab(${JSON.stringify(devKey)}).then(() => 'ok')`)
    await sleep(500)
  }

  /* ---- 7. service worker の idle 停止をまたぐ ---- */
  if (withSwIdle) {
    console.log('\n=== service worker の idle 停止を待つ（最大 120 秒）')
    // CDP でつないだままだと idle 停止しないので、ここでは絶対につながない
    const deadline = Date.now() + 120_000
    let stopped = false
    while (Date.now() < deadline) {
      if (!(await swTarget())) {
        stopped = true
        break
      }
      await sleep(2000)
    }
    check('service worker が idle で停止する', stopped, stopped ? '' : '120 秒待っても停止しなかった')

    if (stopped) {
      // content script からの ping で起こす（Nemo 側から明示的に start しない経路）
      await ui.ev(`window.nemo.createTab('${pages}/login.html').then((k) => k)`)
      const woke = await (async () => {
        const until = Date.now() + 30_000
        while (Date.now() < until) {
          if (await swTarget()) return true
          await sleep(1000)
        }
        return false
      })()
      check('停止した service worker が content script からの通信で起きる', woke)
      if (woke) {
        const sw = await swSession()
        const stored = await sw
          .ev(`chrome.storage.local.get(null).then((v) => JSON.stringify(v))`)
          .then(JSON.parse)
        // 停止前に書いた値が残っていること。ping の回数が増えていれば
        // 「起きた worker が古い storage を読めている」ことまで言える。
        check(
          'idle 停止をまたいで chrome.storage.local が残る',
          typeof stored['__nemo_ci_wakes__'] === 'number' && stored['__nemo_ci_wakes__'] >= 2,
          `wakes=${stored['__nemo_ci_wakes__']} keys=${Object.keys(stored).join(',')}`
        )
        // `chrome.runtime.onInstalled` は electron-chrome-extensions では発火しない。
        // 初回セットアップをここに置いている拡張は動かないので、事実として出しておく
        // （壊れている挙動を assert すると、直ったときに誤検知になるので check にはしない）。
        if (stored['__nemo_ci_marker__'] !== 'installed') {
          console.log(
            '      注意: chrome.runtime.onInstalled が発火していない（既知の制約。docs/compat.md 参照）'
          )
        }
        sw.close()
      }
    }
  }

  /* ---- 7b. 端末ごとの ON/OFF（再起動なし） ---- */
  {
    const idJson = JSON.stringify(expected.id)
    const extTargets = async () =>
      (await listTargets(cdp)).filter((t) => t.url.startsWith(`chrome-extension://${expected.id}/`))
    const contentMark = async () => {
      await page.send('Page.reload')
      await sleep(2500)
      return page.ev(`document.documentElement.getAttribute('data-nemo-ci')`)
    }
    // OFF の前に「動いている」ことを示す（0 件の検査は直前が 1 件以上あってこそ意味がある）
    {
      const sw = await swSession()
      await sw.ev(`chrome.storage.local.set({ __nemo_toggle__: 'kept' }).then(() => 'ok')`)
      sw.close()
    }
    check('OFF の前: service worker が動いている', Boolean(await swTarget()))
    check('OFF の前: content script が入っている', (await contentMark()) === 'top')
    // ページから拡張ページへのトップレベル遷移は ON でも拒否される方針（3c）なので、allowlist の
    // 「OFF で外れる」は `openExtensionOptions` が開かないことで見る（chrome.tabs.create も同じ allowlist を通る）

    // lock に無い ID は拒否される
    const bogus = 'b'.repeat(32)
    const rejected = await ui.ev(
      `window.nemo.setExtensionEnabled('${bogus}', false).then(() => 'accepted', (e) => 'rejected: ' + e.message)`
    )
    check('lock に無い ID の ON/OFF は拒否される', rejected.startsWith('rejected'), rejected)

    // OFF
    const afterOff = await ui
      .ev(`window.nemo.setExtensionEnabled(${idJson}, false).then((e) => JSON.stringify(e))`)
      .then(JSON.parse)
    check(
      'OFF にすると一覧に enabled: false で残る（optionsUrl は null）',
      afterOff.length === 1 && afterOff[0].enabled === false && afterOff[0].optionsUrl === null,
      JSON.stringify(afterOff)
    )
    const swGone = await (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (!(await swTarget())) return true
        await sleep(300)
      }
      return false
    })()
    check('OFF にすると service worker が消える', swGone)
    check('OFF にするとリロード後に content script が入らない', (await contentMark()) === null)
    const optionsCountBefore = (await extTargets()).length
    await ui.ev(`window.nemo.openExtensionOptions(${idJson}).then(() => 'ok')`)
    await sleep(1000)
    check(
      'OFF の間は「設定を開く」で拡張ページが開かない',
      (await extTargets()).length === optionsCountBefore,
      `${optionsCountBefore} → ${(await extTargets()).length}`
    )
    const shared = await ui
      .ev('window.nemo.getSharedState().then((s) => JSON.stringify(s.extensions))')
      .then(JSON.parse)
    check(
      'OFF が SharedState（サイドバー）にも届く',
      shared.length === 1 && shared[0].enabled === false,
      JSON.stringify(shared)
    )
    const settingsOff = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    check(
      'settings.json の extensions.disabled に書かれる',
      Array.isArray(settingsOff.data?.extensions?.disabled) &&
        settingsOff.data.extensions.disabled.includes(expected.id),
      JSON.stringify(settingsOff.data?.extensions)
    )

    // ON
    const afterOn = await ui
      .ev(`window.nemo.setExtensionEnabled(${idJson}, true).then((e) => JSON.stringify(e))`)
      .then(JSON.parse)
    check(
      'ON に戻すと一覧が enabled: true に戻る（optionsUrl も戻る）',
      afterOn.length === 1 && afterOn[0].enabled === true && Boolean(afterOn[0].optionsUrl),
      JSON.stringify(afterOn)
    )
    const swBack = await (async () => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (await swTarget()) return true
        await sleep(500)
      }
      return false
    })()
    check('ON に戻すと service worker が起動する', swBack)
    check('ON に戻すとリロード後に content script が入る', (await contentMark()) === 'top')
    {
      const sw = await swSession()
      const value = await sw
        .ev(`chrome.storage.local.get('__nemo_toggle__').then((v) => JSON.stringify(v))`)
        .then(JSON.parse)
      check(
        'OFF→ON をまたいで chrome.storage.local が残る',
        value['__nemo_toggle__'] === 'kept',
        JSON.stringify(value)
      )
      sw.close()
    }
    const settingsOn = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    check(
      'ON に戻すと settings.json の disabled から消える',
      Array.isArray(settingsOn.data?.extensions?.disabled) &&
        !settingsOn.data.extensions.disabled.includes(expected.id),
      JSON.stringify(settingsOn.data?.extensions)
    )
  }

  /* ---- 8. 再起動をまたぐ chrome.storage ---- */
  {
    const sw = await swSession()
    await sw.ev(`chrome.storage.local.set({ __nemo_restart__: 'before' }).then(() => 'ok')`)
    sw.close()
  }
  // OFF のまま再起動して、設定が効いていることも同じ枠で見る
  await ui.ev(`window.nemo.setExtensionEnabled(${JSON.stringify(expected.id)}, false).then(() => 'ok')`)
  ui.close()
  page.close()
  await stopAll()

  await startPagesServer()
  await startApp()
  {
    const ui2 = await connectUi(cdp)
    const afterRestart = await ui2
      .ev('window.nemo.getExtensions().then((e) => JSON.stringify(e))')
      .then(JSON.parse)
    check(
      '再起動後も OFF のまま（一覧に enabled: false で載る）',
      afterRestart.length === 1 && afterRestart[0].enabled === false,
      JSON.stringify(afterRestart)
    )
    check('再起動後も OFF なら service worker は起動しない', !(await swTarget()))
    await ui2.ev(`window.nemo.setExtensionEnabled(${JSON.stringify(expected.id)}, true).then(() => 'ok')`)
    ui2.close()
  }
  {
    const sw = await swSession()
    const value = await sw
      .ev(`chrome.storage.local.get('__nemo_restart__').then((v) => JSON.stringify(v))`)
      .then(JSON.parse)
    check(
      '再起動をまたいで chrome.storage.local が残る',
      value['__nemo_restart__'] === 'before',
      JSON.stringify(value)
    )
    sw.close()
  }
} catch (error) {
  failures += 1
  console.error(`\n[verify:ext] ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    await stopAll()
  } catch (error) {
    failures += 1
    console.error(`[verify:ext] ${error.message}`)
  }
  // main プロセスの例外は握ってログに落としているので、ここで必ず見る
  const uncaught = findUncaughtExceptions(userDataDir)
  check('main プロセスの例外がログに1件も無い', uncaught.length === 0, uncaught.join(' / '))

  if (spawned.filter(isChildAlive).length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(extRoot, { recursive: true, force: true })
  } else {
    failures += 1
    console.error(`[verify:ext] 生き残ったプロセスがある。一時ディレクトリを残した: ${userDataDir}`)
  }
}

console.log(failures === 0 ? '\nverify:ext: すべて PASS' : `\nverify:ext: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
