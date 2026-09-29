#!/usr/bin/env node
/**
 * kypr（パスワードマネージャー）の自走検証（`mise run verify:only kypr`）。
 *
 * 自分でアプリを起動する（verify-all のアプリに相乗りしない。サーバーの宛先・Touch ID・クリップボードを
 * 差し替えて起動する必要があるため）。**本物の kypr のサーバー・実 Keychain・実 Touch ID・実クリップボードに触らない**:
 *   NEMO_KYPR_TEST_SERVER（模擬サーバー）・NEMO_HTTP_AUTH_TEST_CRYPTO=memory・NEMO_KYPR_TEST_TOUCHID・
 *   NEMO_KYPR_TEST_CLIPBOARD=memory・NEMO_VERIFY_DIAGNOSTICS=1（宛先が無ければ kypr が起動しない fail-closed の条件）
 *
 * 保管庫は、この検証が kypr のクライアント（src/vendor/kypr。Web と同じコード）で模擬サーバーに作る。
 * 「別の端末」として Node 側でも同じ保管庫を開き、Nemo が書いたものを復号して中身を照合する。
 *
 * 使い方:
 *   node scripts/verify-kypr.mjs   （事前に out/ がビルドされていること）
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  readLogLines,
  projectRoot,
  sleep,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { connectTo, connectUi, listTargets, waitFor } from './lib/cdp.mjs'
import { createKyprMockServer } from './lib/kypr-mock-server.mjs'
import { createApi, MemoryCacheStore, VaultSession } from '../src/vendor/kypr/client/index.ts'
import {
  b64Encode,
  deriveKeys,
  generateVaultKey,
  newCardItem,
  newKdfParams,
  newLoginItem,
  newNoteItem,
  wrapVaultKey
} from '../src/vendor/kypr/crypto/index.ts'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const PASSWORD = 'nemo-verify マスター 🔑'
/** 平文の目印。**このアイテムの URL は一度も開かない**（開くと履歴に正当に残る）。 */
const MARK = 'KYPRMARK7d3'
const MARKERS = [MARK, 'kyprmark-url', '4111111111111111', 'pw-A-secret', 'pw-created-secret']

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- テストページ ---------------- */

const LOGIN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>ログイン</title>' +
  '<form id="f" onsubmit="return false">' +
  '<label>ID <input id="username" name="username" autocomplete="username" style="width:200px;height:24px"></label>' +
  '<label>PW <input id="password" name="password" type="password" autocomplete="current-password" style="width:200px;height:24px"></label>' +
  '<button>ログイン</button></form>' +
  '<div style="height:2000px"></div>'

const pages = {
  '/login.html': LOGIN_PAGE,
  // 欄の無いトップの中に、別オリジン（localhost）のログインの iframe
  '/frame.html': (_req, server) =>
    '<!doctype html><meta charset="utf-8"><title>埋め込み</title><p>ログインは iframe の中</p>' +
    `<iframe id="login" src="http://localhost:${server.address().port}/login.html" width="600" height="200"></iframe>`,
  // 見えない欄（透明・display:none）だけのページ
  // メインにメルマガのメール欄、ログインは別オリジンの iframe（入れる先は iframe のパスワード欄を優先する）
  '/mixed.html': (_req, server) =>
    '<!doctype html><meta charset="utf-8"><title>混在</title>' +
    '<p>ニュースレター <input id="newsletter" type="email" name="email" style="width:200px;height:24px"></p>' +
    `<iframe id="login" src="http://localhost:${server.address().port}/login.html?mixed=1" width="600" height="200"></iframe>`,
  '/hidden.html':
    '<!doctype html><meta charset="utf-8"><title>罠</title><form>' +
    '<input id="username" name="username" style="display:none">' +
    '<input id="password" type="password" style="opacity:0">' +
    '</form>'
}

/* ---------------- 起動 ---------------- */

const spawned = []
const dirs = []
function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-kypr-${tag}-`))
  dirs.push(dir)
  return dir
}

const mock = createKyprMockServer({ pages })

/** 1 回ぶん起動する。 */
async function bootApp(dataDir, origin, extraEnv = {}) {
  // Live Folder を止める（使い捨てプロファイルでも gh の実トークンで GitHub を叩き続ける）
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ version: 1, data: { liveFolderEnabled: false } })
  )
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: dataDir,
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      NEMO_VERIFY_DIAGNOSTICS: '1',
      NEMO_DOWNLOAD_DIR: makeDir('dl'),
      NEMO_KYPR_TEST_SERVER: origin,
      NEMO_KYPR_TEST_TOUCHID: 'ok',
      NEMO_KYPR_TEST_CLIPBOARD: 'memory',
      NEMO_KYPR_TEST_CLIPBOARD_MS: '1500',
      ...extraEnv
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { cdp, child }
}

async function stopApp(child) {
  await stopChildren([child])
}

/** userData の全ファイルを読み、目印が現れる場所を返す（utf8 と utf16le の両方で探す）。 */
function findMarkers(dir) {
  const hits = []
  let files = 0
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        files += 1
        let buf
        try {
          buf = fs.readFileSync(p)
        } catch {
          continue
        }
        for (const marker of MARKERS) {
          if (buf.includes(Buffer.from(marker, 'utf8')) || buf.includes(Buffer.from(marker, 'utf16le'))) {
            hits.push(`${path.relative(dir, p)}: ${marker}`)
          }
        }
      }
    }
  }
  walk(dir)
  return { hits, files }
}

try {
  assertNemoNotRunning('verify-kypr')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js')))
    throw new Error('out/ が無い。先に pnpm build する')

  const port = await mock.listen()
  const origin = `http://127.0.0.1:${port}`

  /* ---- 保管庫を作る（Web と同じクライアント。「別の端末」として後で照合にも使う） ---- */
  // t=4 で作る（後で t=3 に下げて「前回より弱い」を撃つため）
  const kdf = newKdfParams({ t: 4 })
  const derived = await deriveKeys(PASSWORD, kdf)
  const wrapped = await wrapVaultKey(derived.wrapKey, generateVaultKey())
  const setup = await fetch(`${origin}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: 'x',
      kdf,
      authKey: b64Encode(derived.authKey),
      wrappedVaultKey: wrapped
    })
  })
  if (setup.status !== 201) throw new Error(`setup 失敗: ${setup.status}`)
  const other = await VaultSession.unlock(
    { api: createApi(origin), cache: new MemoryCacheStore(), derive: deriveKeys },
    PASSWORD
  )
  const A = newLoginItem({
    name: 'Site A',
    username: 'alice@example.com',
    password: 'pw-A-secret',
    uris: [{ uri: origin }]
  })
  const B = newLoginItem({
    name: 'Site B',
    username: 'bob',
    password: 'pw-B',
    uris: [{ uri: `http://localhost:${port}` }]
  })
  const M = newLoginItem({
    name: `${MARK}-name`,
    username: `${MARK}-user@example.com`,
    password: `${MARK}-pass`,
    notes: `${MARK}-note`,
    uris: [{ uri: 'https://kyprmark-url.example/' }]
  })
  // URI の要素の中の知らないキー（bwId）と、知らない方式の match（6）も、保存し直して残るか見る
  const U = {
    ...newLoginItem({
      name: 'Unknown keys',
      uris: [{ uri: 'https://unknown.example', match: 6, bwId: 'keep-me' }]
    }),
    futureFlag: true,
    ratio: 0.25
  }
  // match の種類: 3（完全一致）は ?exact=1 のページだけ・5（一致させない）と 1（ホスト + ポート違い）は出ない
  const X3 = newLoginItem({
    name: 'Exact',
    username: 'exact',
    password: 'pw-x3',
    uris: [{ uri: `${origin}/login.html?exact=1`, match: 3 }]
  })
  const X5 = newLoginItem({
    name: 'Never',
    username: 'never',
    password: 'pw-x5',
    uris: [{ uri: origin, match: 5 }]
  })
  const X1 = newLoginItem({
    name: 'Other port',
    username: 'port',
    password: 'pw-x1',
    uris: [{ uri: 'http://127.0.0.1:1', match: 1 }]
  })
  const C = newCardItem({
    name: 'Card',
    cardholderName: `${MARK} HOLDER`,
    number: '4111111111111111',
    expMonth: '1',
    expYear: '2030',
    code: '123'
  })
  const N = newNoteItem({ name: 'Note', notes: `${MARK}-notebody` })
  await other.create([A, B, M, U, C, N, X3, X5, X1])

  /* ================= 1 回目の起動 ================= */
  const userData = makeDir('data')
  let app = await bootApp(userData, origin)
  let ui = await connectUi(app.cdp)
  const json = async (expression) => JSON.parse(await ui.ev(`${expression}.then(JSON.stringify)`))
  const windowKypr = async () => (await json('window.nemo.getWindowState()')).kypr

  /* ---- 1. ログイン前 ---- */
  let status = await json('window.nemo.kyprStatus()')
  check('最初はログインしていない（signed-out）', status.state === 'signed-out', JSON.stringify(status))
  check('宛先は模擬サーバー', status.server === origin, status.server)
  check('ツールバーの状態も signed-out', (await windowKypr())?.state === 'signed-out')

  const wrong = await json(`window.nemo.kyprSignIn('違うパスワード', true)`)
  check(
    'マスターパスワードが違えば bad-password',
    wrong.ok === false && wrong.reason === 'bad-password',
    JSON.stringify(wrong)
  )

  const signIn = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check('マスターパスワードで解除できる', signIn.ok === true, JSON.stringify(signIn))
  status = await json('window.nemo.kyprStatus()')
  check(
    '解除後: unlocked・9 件・Touch ID の鍵を覚えた',
    status.state === 'unlocked' &&
      status.itemCount === 9 &&
      status.touchIdEnrolled === true &&
      !status.readOnly,
    JSON.stringify({ state: status.state, n: status.itemCount, touch: status.touchIdEnrolled })
  )

  /* ---- 2. バッジと照合 ---- */
  const tabKey = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${origin}/login.html`)}).then((k) => k)`
  )
  let page = await connectTo(app.cdp, '/login.html', { type: 'page' })
  await waitFor(page, "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''")
  await waitFor(ui, "window.nemo.getWindowState().then((s) => s.kypr && s.kypr.count === 1 ? 'ok' : '')")
  check(
    'バッジ: このページに合うログインが 1 件',
    (await windowKypr())?.count === 1,
    JSON.stringify(await windowKypr())
  )

  let panel = await json('window.nemo.kyprPanel()')
  check(
    'ポップアップ: このページ（127.0.0.1）に合うのは Site A だけ',
    panel.page?.host === '127.0.0.1' && panel.matches.length === 1 && panel.matches[0].id === A.id,
    JSON.stringify({ page: panel.page, matches: panel.matches.map((m) => m.name) })
  )
  check('ポップアップ: 全件が一覧に出る', panel.items.length === 9, `items=${panel.items.length}`)
  // 完全一致（match 3）のページを別タブで開くと 2 件（Site A と Exact）。5 と 1（ポート違い）は数えない
  const exactKey = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${origin}/login.html?exact=1`)}).then((k) => k)`
  )
  await waitFor(ui, "window.nemo.getWindowState().then((s) => s.kypr && s.kypr.count === 2 ? 'ok' : '')", {
    timeoutMs: 8000
  }).catch(() => '')
  const exactPanel = await json('window.nemo.kyprPanel()')
  check(
    'match の種類: 完全一致は同じ URL のときだけ・一致させない / ポート違いのホストは出ない',
    (await windowKypr())?.count === 2 &&
      exactPanel.matches
        .map((m) => m.id)
        .sort()
        .join() === [A.id, X3.id].sort().join(),
    JSON.stringify({ count: (await windowKypr())?.count, matches: exactPanel.matches.map((m) => m.name) })
  )
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(exactKey)})`)
  await ui.ev(`window.nemo.selectTab(${JSON.stringify(tabKey)})`)
  const leaked =
    JSON.stringify(panel).includes('pw-A-secret') || JSON.stringify(panel).includes('4111111111111111')
  check('一覧にはパスワード・カード番号が入っていない', !leaked)

  /* ---- 3. 入力 ---- */
  const values = async (session) =>
    JSON.parse(
      await session.ev(
        "JSON.stringify({ u: document.getElementById('username').value, p: document.getElementById('password').value })"
      )
    )
  let filled = await json(`window.nemo.kyprFill(${JSON.stringify(A.id)})`)
  let v = await values(page)
  check(
    'ポップアップから入力: ユーザー名とパスワードが入る',
    filled.ok === true && v.u === 'alice@example.com' && v.p === 'pw-A-secret',
    JSON.stringify({ filled, u: v.u, p: v.p ? '(入っている)' : '' })
  )

  /* ---- 4. コピー（メモリ上のクリップボード。実物は触らない） ---- */
  const copied = await json(`window.nemo.kyprCopy(${JSON.stringify(A.id)}, 'password')`)
  const clip1 = await json('window.nemo.kyprClipboardForVerify()')
  check(
    'パスワードをコピーできる（main が書く）',
    copied === true && clip1 === 'pw-A-secret',
    JSON.stringify(clip1 ? '(入っている)' : clip1)
  )
  await sleep(2200)
  const clip2 = await json('window.nemo.kyprClipboardForVerify()')
  check('決めた時間でクリップボードから消える', clip2 === '', JSON.stringify(clip2))
  const cardCopy = await json(`window.nemo.kyprCopy(${JSON.stringify(C.id)}, 'expiry')`)
  check(
    'カードの有効期限は MM/YY でコピーされる',
    cardCopy === true && (await json('window.nemo.kyprClipboardForVerify()')) === '01/30'
  )

  /* ---- 5. 別オリジンの iframe ---- */
  await ui.ev(`window.nemo.navigate(${JSON.stringify(tabKey)}, ${JSON.stringify(`${origin}/frame.html`)})`)
  const frame = await connectTo(app.cdp, `localhost:${port}/login.html`, { type: 'iframe' })
  await waitFor(
    frame,
    "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''"
  )
  panel = await json('window.nemo.kyprPanel()')
  check(
    'iframe のページ: 照合は入力欄のある iframe（localhost）の URL で行う',
    panel.page?.host === 'localhost' && panel.matches.length === 1 && panel.matches[0].id === B.id,
    JSON.stringify({ page: panel.page?.host, matches: panel.matches.map((m) => m.name) })
  )
  const mismatch = await json(`window.nemo.kyprFill(${JSON.stringify(A.id)})`)
  v = await values(frame)
  check(
    'トップ向けのログインは別オリジンの iframe に入らない（url-mismatch）',
    mismatch.ok === false && mismatch.reason === 'url-mismatch' && v.u === '' && v.p === '',
    JSON.stringify({ mismatch, u: v.u })
  )
  filled = await json(`window.nemo.kyprFill(${JSON.stringify(B.id)})`)
  v = await values(frame)
  check(
    'iframe に合うログインは iframe の中に入る',
    filled.ok === true && v.u === 'bob' && v.p === 'pw-B',
    JSON.stringify(filled)
  )

  /* ---- 6. 見えない欄 ---- */
  await ui.ev(`window.nemo.navigate(${JSON.stringify(tabKey)}, ${JSON.stringify(`${origin}/hidden.html`)})`)
  const hidden = await connectTo(app.cdp, '/hidden.html', { type: 'page' })
  await waitFor(hidden, "document.readyState === 'complete' ? 'ok' : ''")
  const noTarget = await json(`window.nemo.kyprFill(${JSON.stringify(A.id)})`)
  v = await values(hidden)
  check(
    '見えない欄（透明・display:none）には入れない',
    noTarget.ok === false && noTarget.reason === 'no-target' && v.u === '' && v.p === '',
    JSON.stringify(noTarget)
  )

  /* ---- 6b. メインにメール欄・ログインは iframe ---- */
  await ui.ev(`window.nemo.navigate(${JSON.stringify(tabKey)}, ${JSON.stringify(`${origin}/mixed.html`)})`)
  const mixedTop = await connectTo(app.cdp, '/mixed.html', { type: 'page' })
  const mixedFrame = await connectTo(app.cdp, `localhost:${port}/login.html?mixed=1`, { type: 'iframe' })
  await waitFor(
    mixedFrame,
    "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''"
  )
  panel = await json('window.nemo.kyprPanel()')
  const mixedFill = await json(`window.nemo.kyprFill(${JSON.stringify(B.id)})`)
  v = await values(mixedFrame)
  const newsletter = await mixedTop.ev("document.getElementById('newsletter').value")
  check(
    'メインのメール欄より、iframe のパスワード欄を入れる先にする',
    panel.page?.host === 'localhost' && mixedFill.ok === true && v.u === 'bob' && newsletter === '',
    JSON.stringify({ page: panel.page?.host, mixedFill, u: v.u, newsletter })
  )

  /* ---- 7. ⌘⇧L ---- */
  await ui.ev(
    `window.nemo.navigate(${JSON.stringify(tabKey)}, ${JSON.stringify(`${origin}/login.html?k=1`)})`
  )
  page = await connectTo(app.cdp, '/login.html?k=1', { type: 'page' })
  await waitFor(page, "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''")
  await ui.ev("window.nemo.runCommandForVerify('kypr-fill')")
  await waitFor(page, "document.getElementById('password').value ? 'ok' : ''", { timeoutMs: 8000 }).catch(
    () => ''
  )
  v = await values(page)
  check(
    '⌘⇧L: 合うログインが 1 件ならそのまま入る',
    v.u === 'alice@example.com' && v.p === 'pw-A-secret',
    JSON.stringify({ u: v.u })
  )

  // 2 件目を「別の端末」で足す → Nemo で同期 → ⌘⇧L はポップアップを開く
  const A2 = newLoginItem({
    name: 'Site A (2)',
    username: 'alice2',
    password: 'pw-A2',
    uris: [{ uri: origin }]
  })
  await other.create([A2])
  const synced = await json('window.nemo.kyprSync()')
  check(
    '同期で別の端末の追加が入る',
    synced.ok === true && (await json('window.nemo.kyprStatus()')).itemCount === 10,
    JSON.stringify(synced)
  )
  await page.ev(
    "document.getElementById('username').value = ''; document.getElementById('password').value = ''"
  )
  await ui.ev("window.nemo.runCommandForVerify('kypr-fill')")
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => s.kind === 'kypr' ? 'ok' : '')", {
    timeoutMs: 8000
  }).catch(() => '')
  const overlay = await json('window.nemo.getOverlayState()')
  v = await values(page)
  check(
    '⌘⇧L: 2 件以上ならポップアップを開き、勝手に入れない',
    overlay.kind === 'kypr' && v.u === '',
    JSON.stringify({ kind: overlay.kind, u: v.u })
  )

  /* ---- 8. ポップアップと設定画面が描ける（Kypr.tsx / KyprSettings.tsx の描画例外を拾う） ---- */
  const overlayUi = await connectTo(app.cdp, 'view=overlay', { exclude: 'private=1' })
  await waitFor(overlayUi, `document.querySelector('[data-kypr-id="${A.id}"]') ? 'ok' : ''`, {
    timeoutMs: 8000
  }).catch(() => '')
  const panelView = JSON.parse(
    await overlayUi.ev(`JSON.stringify({
      host: document.querySelector('.kypr-hero-host')?.textContent ?? null,
      hero: [...document.querySelectorAll('.kypr-hero .kypr-row .kypr-row-name')].map((e) => e.textContent),
      fills: document.querySelectorAll('.kypr-hero .kypr-fill').length,
      list: [...document.querySelectorAll('.kypr-list > .kypr-scroll > .kypr-row .kypr-row-name')].map((e) => e.textContent),
      logo: !!document.querySelector('.kypr-foot .kypr-mark')
    })`)
  )
  check(
    'ポップアップが描ける（このページのカードに 2 件と「入力」、下に一覧、フッターにロゴ）',
    panelView.host === '127.0.0.1' &&
      panelView.hero.includes('Site A (2)') &&
      panelView.hero.length === 2 &&
      panelView.fills === 2 &&
      panelView.list.includes('Site B') &&
      panelView.logo,
    JSON.stringify({ ...panelView, list: panelView.list.length })
  )
  // ツールバーのボタンは kypr のロゴ（Web / iOS と同じ図柄）に件数のバッジ
  const toolbarUi = await connectTo(app.cdp, 'view=toolbar', { exclude: 'private=1' })
  const toolbarIcon = JSON.parse(
    await toolbarUi.ev(`JSON.stringify({
      mark: !!document.querySelector('.kypr-icon .kypr-mark:not(.locked)'),
      count: document.querySelector('.kypr-icon .count')?.textContent ?? null
    })`)
  )
  check(
    'ツールバー: kypr のロゴと、このページに合う件数（2）',
    toolbarIcon.mark && toolbarIcon.count === '2',
    JSON.stringify(toolbarIcon)
  )

  /* ---- 8b. 閉じ方: Esc では閉じない・外をクリックすると閉じる ---- */
  const overlayKind = async () => (await json('window.nemo.getOverlayState()')).kind
  const pressEscape = async (session) => {
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
  }
  const kindBeforeEsc = await overlayKind()
  await pressEscape(overlayUi)
  await new Promise((r) => setTimeout(r, 400))
  check(
    'ポップアップは Esc で閉じない',
    kindBeforeEsc === 'kypr' && (await overlayKind()) === 'kypr',
    JSON.stringify({ before: kindBeforeEsc })
  )
  // 詳細の Esc は一覧へ戻るだけ
  const kindBeforeDetail = await overlayKind()
  const outsideCloses = () =>
    readLogLines(userData).filter((line) => line.includes('kypr.popup_outside_close')).length
  await overlayUi.ev(
    `document.querySelector('.kypr-list > .kypr-scroll > .kypr-row[data-kypr-id="${B.id}"]')?.click()`
  )
  const detailShown = await waitFor(overlayUi, "document.querySelector('.kypr-detail') ? 'ok' : ''", {
    timeoutMs: 5000
  }).catch(() => '')
  const detailText = String(await overlayUi.ev('document.body.innerText'))
    .slice(0, 80)
    .replace(/\n/g, ' / ')
  await pressEscape(overlayUi)
  const backToList = await waitFor(
    overlayUi,
    "document.querySelector('.kypr-list') && !document.querySelector('.kypr-detail') ? 'ok' : ''",
    { timeoutMs: 5000 }
  ).catch(() => '')
  check(
    '詳細の Esc は一覧へ戻り、ポップアップは開いたまま',
    kindBeforeDetail === 'kypr' &&
      detailShown === 'ok' &&
      backToList === 'ok' &&
      (await overlayKind()) === 'kypr',
    JSON.stringify({ kindBeforeDetail, detailShown, backToList, detailText, outsideCloses: outsideCloses() })
  )
  // 外（ページ）をクリック = ページの View へフォーカスが移る → 閉じる。
  // 直前に開いていたことも見る（閉じていたら「閉じた」は空振りで PASS する）
  const kindBeforeOutside = await overlayKind()
  const focusMoved = await json("window.nemo.focusForVerify('page')")
  const closedByPage = await waitFor(
    ui,
    "window.nemo.getOverlayState().then((s) => (s.kind === null ? 'ok' : ''))",
    { timeoutMs: 5000 }
  ).catch(() => '')
  check(
    'ページをクリックすると閉じる',
    kindBeforeOutside === 'kypr' && focusMoved === true && closedByPage === 'ok',
    JSON.stringify({ kindBeforeOutside, focusMoved, closedByPage, outsideCloses: outsideCloses() })
  )
  // ツールバーのアイコンを押す = 押し下げでツールバーへフォーカスが移って閉じ、続く click の「開く」は捨てる
  await ui.ev("window.nemo.setOverlay('kypr')")
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => (s.kind === 'kypr' ? 'ok' : ''))", {
    timeoutMs: 5000
  }).catch(() => '')
  const toggled = JSON.parse(
    await ui.ev(`(async () => {
      const opened = (await window.nemo.getOverlayState()).kind
      await window.nemo.focusForVerify('toolbar')
      const deadline = Date.now() + 3000
      let closed = null
      while (Date.now() < deadline) {
        closed = (await window.nemo.getOverlayState()).kind
        if (closed === null) break
        await new Promise((r) => setTimeout(r, 10))
      }
      await window.nemo.setOverlay('kypr')
      await new Promise((r) => setTimeout(r, 100))
      const afterClick = (await window.nemo.getOverlayState()).kind
      await new Promise((r) => setTimeout(r, 700))
      await window.nemo.setOverlay('kypr')
      await new Promise((r) => setTimeout(r, 100))
      const later = (await window.nemo.getOverlayState()).kind
      return JSON.stringify({ opened, closed, afterClick, later })
    })()`)
  )
  check(
    'ツールバーのアイコンを押すと閉じる（押し下げで閉じた直後の「開く」は捨てる。少し後なら開く）',
    toggled.opened === 'kypr' &&
      toggled.closed === null &&
      toggled.afterClick === null &&
      toggled.later === 'kypr',
    JSON.stringify(toggled)
  )
  await ui.ev('window.nemo.setOverlay(null)')
  await ui.ev("window.nemo.setOverlay('settings')")
  // 節の見出しは先に出て、状態（解除中・件数）は kyprStatus の往復のあとに出る。状態まで待つ
  await waitFor(overlayUi, "document.body.innerText.includes('解除中') ? 'ok' : ''", {
    timeoutMs: 8000
  }).catch(() => '')
  const settingsText = await overlayUi.ev('document.body.innerText')
  check(
    '設定画面に kypr の節が描ける（解除中・件数）',
    settingsText.includes('解除中') && settingsText.includes('10 件'),
    (settingsText.match(/kypr[\s\S]{0,120}/)?.[0] ?? settingsText.slice(0, 120)).replace(/\n/g, ' / ')
  )
  await ui.ev('window.nemo.setOverlay(null)')

  /* ---- 9. 新規作成の下書きと保存 ---- */
  await page.ev(
    "document.getElementById('username').value = 'typed-user'; document.getElementById('password').value = 'typed-pass'"
  )
  const draft = await json('window.nemo.kyprDraft()')
  check(
    '下書き: ページのオリジン・ホスト名・いま入っている値',
    draft.uri === origin &&
      draft.name === '127.0.0.1' &&
      draft.username === 'typed-user' &&
      draft.password === 'typed-pass',
    JSON.stringify({ ...draft, password: draft.password ? '(入っている)' : '' })
  )
  const created = await json(
    `window.nemo.kyprSave({ id: null, type: 'login', fields: { name: 'Created in Nemo', username: 'carol', password: 'pw-created-secret', notes: '', uris: [{ uri: ${JSON.stringify(origin)} }] } })`
  )
  await other.sync()
  const seen = other.entries.get(created.id)
  check(
    '作成: 別の端末で復号でき、中身が一致する',
    created.ok === true &&
      seen?.state.kind === 'login' &&
      seen.state.item.username === 'carol' &&
      seen.state.item.password === 'pw-created-secret',
    JSON.stringify(created)
  )
  const sentBodies = mock.state.requests
    .filter((r) => r.method === 'POST' && r.path === '/api/items')
    .map((r) => r.body)
    .join('')
  check(
    'サーバーに届いた本文に平文が無い',
    sentBodies.length > 0 && !sentBodies.includes('pw-created-secret') && !sentBodies.includes('carol')
  )

  /* ---- 10. 編集（知らないキーが残る）・カードの整形 ---- */
  const edited = await json(
    `window.nemo.kyprSave({ id: ${JSON.stringify(U.id)}, type: 'login', fields: { name: 'Unknown keys (edited)', username: '', password: '', notes: '', uris: [{ uri: 'https://unknown.example', match: 6, bwId: 'keep-me' }] } })`
  )
  await other.sync()
  const u2 = other.entries.get(U.id)?.state
  check(
    '編集: 名前が変わり、知らないキー（真偽値・小数）は残る',
    edited.ok === true &&
      u2?.kind === 'login' &&
      u2.item.name === 'Unknown keys (edited)' &&
      u2.item.futureFlag === true &&
      u2.item.ratio === 0.25 &&
      u2.item.uris[0]?.bwId === 'keep-me' &&
      u2.item.uris[0]?.match === 6,
    JSON.stringify({
      edited,
      name: u2?.item?.name,
      futureFlag: u2?.item?.futureFlag,
      ratio: u2?.item?.ratio,
      uri0: u2?.item?.uris?.[0]
    })
  )
  const card = await json(
    `window.nemo.kyprSave({ id: ${JSON.stringify(C.id)}, type: 'card', fields: { name: 'Card', cardholderName: 'X', brand: '', number: '4111 1111-1111 1111', expMonth: '03', expYear: '29', code: '123', notes: '' } })`
  )
  await other.sync()
  const c2 = other.entries.get(C.id)?.state
  check(
    'カード: 番号は数字だけ・月は 0 埋めしない・年は 4 桁で保存',
    card.ok === true &&
      c2?.kind === 'card' &&
      c2.item.number === '4111111111111111' &&
      c2.item.expMonth === '3' &&
      c2.item.expYear === '2029',
    JSON.stringify({ card, n: c2?.item?.number?.length, m: c2?.item?.expMonth, y: c2?.item?.expYear })
  )
  const bad = await json(`window.nemo.kyprSave({ id: null, type: 'login', fields: { name: 1 } })`)
  check('不正な項目は保存しない', bad.ok === false && bad.reason === 'invalid', JSON.stringify(bad))

  /* ---- 11. 競合 ---- */
  const aEntry = other.entries.get(A.id)
  await other.update({ ...aEntry.state.item, name: 'Site A（別の端末で変更）' }, aEntry.revision)
  const conflict = await json(
    `window.nemo.kyprSave({ id: ${JSON.stringify(A.id)}, type: 'login', fields: { name: 'Nemo で変更', username: 'alice@example.com', password: 'pw-A-secret', notes: '', uris: [{ uri: ${JSON.stringify(origin)} }] } })`
  )
  const afterConflict = await json(`window.nemo.kyprItem(${JSON.stringify(A.id)})`)
  check(
    '競合: conflict を返し、手元は別の端末の版に取り直す',
    conflict.ok === false &&
      conflict.reason === 'conflict' &&
      afterConflict?.item?.name === 'Site A（別の端末で変更）',
    JSON.stringify({ conflict, name: afterConflict?.item?.name })
  )

  /* ---- 12. ゴミ箱・復元・完全削除 ---- */
  const trashed = await json(`window.nemo.kyprTrash(${JSON.stringify(A2.id)})`)
  await other.sync()
  check('ゴミ箱へ移せる', trashed.ok === true && other.entries.get(A2.id)?.deletedAt !== null)
  const purgeLive = await json(`window.nemo.kyprPurge(${JSON.stringify(N.id)})`)
  check(
    'ゴミ箱の外のものは完全削除できない',
    purgeLive.ok === false && purgeLive.reason === 'invalid',
    JSON.stringify(purgeLive)
  )
  const restored = await json(`window.nemo.kyprRestore(${JSON.stringify(A2.id)})`)
  await other.sync()
  check('ゴミ箱から戻せる', restored.ok === true && other.entries.get(A2.id)?.deletedAt === null)
  await json(`window.nemo.kyprTrash(${JSON.stringify(A2.id)})`)
  const purged = await json(`window.nemo.kyprPurge(${JSON.stringify(A2.id)})`)
  await other.sync()
  check(
    '完全削除すると、別の端末からも消える（トゥームストーン）',
    purged.ok === true &&
      !other.entries.has(A2.id) &&
      (await json(`window.nemo.kyprItem(${JSON.stringify(A2.id)})`)) === null,
    JSON.stringify(purged)
  )

  /* ---- 13. セッション切れ・オフライン ---- */
  const loginsBefore = mock.state.logins
  mock.state.tokens.clear()
  const relogin = await json('window.nemo.kyprSync()')
  check(
    'セッションが切れても authKey でログインし直して同期する',
    relogin.ok === true && mock.state.logins === loginsBefore + 1,
    JSON.stringify(relogin)
  )

  await ui.ev('window.nemo.kyprLock()')
  mock.state.offline = true
  const offline = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, false)`)
  status = await json('window.nemo.kyprStatus()')
  check(
    'サーバーに届かなければキャッシュから読み取り専用で開く',
    offline.ok === true && status.readOnly === true && status.itemCount === 10,
    JSON.stringify({ offline, ro: status.readOnly, n: status.itemCount })
  )
  const roSave = await json(
    `window.nemo.kyprSave({ id: null, type: 'note', fields: { name: 'x', notes: 'y' } })`
  )
  check(
    '読み取り専用のあいだは書き込まない',
    roSave.ok === false && roSave.reason === 'read-only',
    JSON.stringify(roSave)
  )
  mock.state.offline = false
  const online = await json('window.nemo.kyprSync()')
  status = await json('window.nemo.kyprStatus()')
  check(
    'サーバーに届くようになったら、同期で書き込めるようになる',
    online.ok === true && status.readOnly === false,
    JSON.stringify(online)
  )

  /* ---- 14. ロックと Touch ID ---- */
  await ui.ev('window.nemo.kyprLock()')
  await waitFor(
    ui,
    "window.nemo.getWindowState().then((s) => s.kypr && s.kypr.state === 'locked' ? 'ok' : '')"
  )
  check('ロックするとツールバーも locked（件数は出さない）', (await windowKypr())?.count === 0)
  const touch = await json('window.nemo.kyprUnlockTouchId()')
  check(
    'Touch ID で解除できる（マスターパスワード無し）',
    touch.ok === true && (await json('window.nemo.kyprStatus()')).state === 'unlocked',
    JSON.stringify(touch)
  )

  await ui.ev('window.nemo.kyprLock()')
  mock.state.rejectAuth = true
  const rejected = await json('window.nemo.kyprUnlockTouchId()')
  status = await json('window.nemo.kyprStatus()')
  check(
    'サーバーが覚えた鍵を認めなければ bad-password で、覚えた鍵を捨てる',
    rejected.ok === false && rejected.reason === 'bad-password' && status.touchIdEnrolled === false,
    JSON.stringify({ rejected, enrolled: status.touchIdEnrolled })
  )
  mock.state.rejectAuth = false

  mock.state.kdfOverride = { ...kdf, t: 3 }
  const weaker = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check(
    'KDF パラメータが前回より弱ければ開かない（weaker-params）',
    weaker.ok === false && weaker.reason === 'weaker-params',
    JSON.stringify(weaker)
  )
  mock.state.kdfOverride = null
  const again = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check(
    'マスターパスワードで解除し直すと Touch ID の鍵を覚え直す',
    again.ok === true && (await json('window.nemo.kyprStatus()')).touchIdEnrolled === true
  )

  /* ---- 15. ログイン欄の下の候補 ---- */
  await ui.ev(
    `window.nemo.navigate(${JSON.stringify(tabKey)}, ${JSON.stringify(`${origin}/login.html?inline=1`)})`
  )
  page = await connectTo(app.cdp, '/login.html?inline=1', { type: 'page' })
  await waitFor(page, "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''")
  await ui.ev('window.nemo.kyprSync()')
  // スクリプトの focus() では出ない
  await page.ev("document.getElementById('username').focus()")
  await sleep(800)
  check(
    'スクリプトの focus() では候補を出さない',
    (await overlayKind()) !== 'kypr-inline',
    String(await overlayKind())
  )
  await page.ev('document.activeElement && document.activeElement.blur()')
  // 実際のクリック（trusted な pointerdown）で出る
  const clickAt = async (id) => {
    const r = JSON.parse(
      await page.ev(
        `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + 10, y: r.top + r.height / 2 }) })()`
      )
    )
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: r.x,
      y: r.y,
      button: 'left',
      clickCount: 1
    })
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: r.x,
      y: r.y,
      button: 'left',
      clickCount: 1
    })
  }
  await clickAt('username')
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => s.kind === 'kypr-inline' ? 'ok' : '')", {
    timeoutMs: 5000
  }).catch(() => '')
  const inline = await json('window.nemo.kyprInlineState()')
  check(
    'ログイン欄をクリックすると、欄の下に合うログインが出る',
    (await overlayKind()) === 'kypr-inline' &&
      inline?.locked === false &&
      inline.rows.some((r) => r.id === A.id),
    JSON.stringify({ kind: await overlayKind(), rows: inline?.rows?.map((r) => r.name) })
  )
  const focusedPage = await page.ev('document.activeElement && document.activeElement.id')
  check('候補を出してもページのフォーカスは奪わない', focusedPage === 'username', String(focusedPage))
  // 出た直後の押下は無視する
  await waitFor(overlayUi, `document.querySelector('.kypr-inline-row[data-kypr-id="${A.id}"]') ? 'ok' : ''`, {
    timeoutMs: 5000
  }).catch(() => '')
  await overlayUi.ev(`document.querySelector('.kypr-inline-row[data-kypr-id="${A.id}"]')?.click()`)
  await sleep(300)
  v = await values(page)
  check('出た直後の押下は無視する（誤クリック対策）', v.u === '' && v.p === '', JSON.stringify({ u: v.u }))
  await sleep(500)
  await overlayUi.ev(`document.querySelector('.kypr-inline-row[data-kypr-id="${A.id}"]')?.click()`)
  await waitFor(page, "document.getElementById('password').value ? 'ok' : ''", { timeoutMs: 5000 }).catch(
    () => ''
  )
  v = await values(page)
  check(
    '少し待って押すと入り、候補は閉じる',
    v.u === 'alice@example.com' && v.p === 'pw-A-secret' && (await overlayKind()) === null,
    JSON.stringify({ u: v.u, kind: await overlayKind() })
  )

  // スクロールで閉じる
  await page.ev(
    "document.getElementById('username').value = ''; document.activeElement && document.activeElement.blur()"
  )
  await clickAt('password')
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => s.kind === 'kypr-inline' ? 'ok' : '')", {
    timeoutMs: 5000
  }).catch(() => '')
  const shownBeforeScroll = (await overlayKind()) === 'kypr-inline'
  await page.ev('window.scrollBy(0, 200)')
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => s.kind === null ? 'ok' : '')", {
    timeoutMs: 5000
  }).catch(() => '')
  check(
    'スクロールすると候補を閉じる',
    shownBeforeScroll && (await overlayKind()) === null,
    `shown=${shownBeforeScroll} now=${await overlayKind()}`
  )

  // ロック中は「解除」の 1 行
  await ui.ev('window.nemo.kyprLock()')
  await page.ev('window.scrollTo(0, 0); document.activeElement && document.activeElement.blur()')
  await clickAt('username')
  await waitFor(ui, "window.nemo.getOverlayState().then((s) => s.kind === 'kypr-inline' ? 'ok' : '')", {
    timeoutMs: 5000
  }).catch(() => '')
  const lockedInline = await json('window.nemo.kyprInlineState()')
  check(
    'ロック中は「kypr のロックを解除」だけを出す',
    lockedInline?.locked === true && lockedInline.rows.length === 0,
    JSON.stringify(lockedInline)
  )
  await ui.ev('window.nemo.kyprInlineDismiss()')
  await json('window.nemo.kyprUnlockTouchId()')

  /* ---- 16. シークレットウィンドウ ---- */
  await ui.ev('window.nemo.createPrivateWindow()')
  const privateUi = await connectTo(app.cdp, 'private=1', {})
  await waitFor(privateUi, "typeof window.nemo === 'object' ? 'ok' : ''")
  await privateUi.ev(`window.nemo.createTab(${JSON.stringify(`${origin}/login.html?private=1`)})`)
  const privatePage = await connectTo(app.cdp, '/login.html?private=1', { type: 'page' })
  await waitFor(
    privatePage,
    "document.readyState === 'complete' && document.getElementById('password') ? 'ok' : ''"
  )
  // このオリジンに合うのは Site A と、途中で Nemo から作った「Created in Nemo」の 2 件
  await waitFor(
    privateUi,
    "window.nemo.getWindowState().then((s) => s.kypr && s.kypr.count === 2 ? 'ok' : '')",
    { timeoutMs: 8000 }
  ).catch(() => '')
  const privateState = JSON.parse(await privateUi.ev('window.nemo.getWindowState().then(JSON.stringify)'))
  check(
    'シークレットウィンドウでもバッジが出る',
    privateState.isPrivate === true && privateState.kypr?.count === 2,
    JSON.stringify(privateState.kypr)
  )
  const privateFill = JSON.parse(
    await privateUi.ev(`window.nemo.kyprFill(${JSON.stringify(A.id)}).then(JSON.stringify)`)
  )
  v = await values(privatePage)
  check(
    'シークレットウィンドウでも入力できる',
    privateFill.ok === true && v.u === 'alice@example.com',
    JSON.stringify(privateFill)
  )

  /* ---- 17. サーバーの巻き戻しと、ログインし直しも断られたとき ---- */
  const liveBefore = (await json('window.nemo.kyprStatus()')).itemCount
  // Nemo で作ったアイテムの手前まで戻す（それより後に作った・変えた行は、サーバーから無くなる）
  mock.rollback(mock.state.items.get(created.id).revision - 1)
  const liveOnServer = [...mock.state.items.values()].filter((it) => it.data !== null).length
  const rolled = await json('window.nemo.kyprSync()')
  const afterRollback = (await json('window.nemo.kyprStatus()')).itemCount
  check(
    'サーバーが巻き戻ったら全部取り直し、手元もサーバーと同じ件数になる',
    rolled.ok === true && afterRollback === liveOnServer && afterRollback < liveBefore,
    JSON.stringify({ rolled, before: liveBefore, after: afterRollback, server: liveOnServer })
  )
  mock.state.tokens.clear()
  mock.state.rejectAuth = true
  const expired = await json('window.nemo.kyprSync()')
  status = await json('window.nemo.kyprStatus()')
  check(
    'セッション切れでログインし直しも断られたら、ロックして覚えた鍵を捨てる（マスターパスワードへ）',
    expired.ok === false &&
      expired.reason === 'session-expired' &&
      status.state === 'locked' &&
      status.touchIdEnrolled === false,
    JSON.stringify({ expired, state: status.state, enrolled: status.touchIdEnrolled })
  )
  mock.state.rejectAuth = false
  // 次の起動で Touch ID の検査をするので、マスターパスワードで入れ直して鍵を覚え直す
  const reenroll = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check(
    'マスターパスワードで入れ直すと、また Touch ID の鍵を覚える',
    reenroll.ok === true && (await json('window.nemo.kyprStatus()')).touchIdEnrolled === true,
    JSON.stringify(reenroll)
  )

  const crashes1 = findUncaughtExceptions(userData)
  check('未処理の例外が出ていない', crashes1.length === 0, crashes1.join(' / '))
  await stopApp(app.child)

  /* ================= 2 回目の起動（Touch ID が通らない・使わないとロック） ================= */
  app = await bootApp(userData, origin, { NEMO_KYPR_TEST_TOUCHID: 'fail', NEMO_KYPR_TEST_IDLE_MS: '2500' })
  ui = await connectUi(app.cdp)
  status = await json('window.nemo.kyprStatus()')
  check(
    '再起動するとロックされている（キャッシュはある）',
    status.state === 'locked' && status.itemCount === afterRollback,
    JSON.stringify({ state: status.state, n: status.itemCount })
  )
  const touchFail = await json('window.nemo.kyprUnlockTouchId()')
  check(
    'Touch ID が通らなければ touch-id-failed（マスターパスワードへ）',
    touchFail.ok === false && touchFail.reason === 'touch-id-failed',
    JSON.stringify(touchFail)
  )
  const pw2 = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check('マスターパスワードでは解除できる', pw2.ok === true)
  await waitFor(ui, "window.nemo.kyprStatus().then((s) => s.state === 'locked' ? 'ok' : '')", {
    timeoutMs: 8000
  }).catch(() => '')
  check(
    '使わないまま決めた時間が経つとロックする',
    (await json('window.nemo.kyprStatus()')).state === 'locked'
  )
  const crashes2 = findUncaughtExceptions(userData)
  check('2 回目: 未処理の例外が出ていない', crashes2.length === 0, crashes2.join(' / '))
  await stopApp(app.child)

  /* ================= 3 回目の起動（検証モードで宛先を渡し忘れた） ================= */
  const dataNoServer = makeDir('noserver')
  app = await bootApp(dataNoServer, origin, { NEMO_KYPR_TEST_SERVER: '' })
  ui = await connectUi(app.cdp)
  status = await json('window.nemo.kyprStatus()')
  check(
    '検証モードで宛先が無ければ kypr を起動しない（本番に届かない）',
    status.state === 'disabled' &&
      status.server === null &&
      status.disabledReason === 'verify-without-server',
    JSON.stringify({ state: status.state, server: status.server, reason: status.disabledReason })
  )
  check('そのときツールバーの状態は disabled', (await windowKypr())?.state === 'disabled')
  await stopApp(app.child)

  /* ---- 平文が残っていないこと ---- */
  // 対照: 平文を書くように細工した起動（NEMO_KYPR_TEST_LEAK=1。解除したら一覧を平文で userData に書く）で、
  // 同じ検査が FAIL（目印を見つける）することを先に確かめる
  const dataLeak = makeDir('leak')
  app = await bootApp(dataLeak, origin, { NEMO_KYPR_TEST_LEAK: '1' })
  ui = await connectUi(app.cdp)
  const leakSignIn = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, false)`)
  await stopApp(app.child)
  const leakScan = findMarkers(dataLeak)
  check(
    '（対照）平文を書く細工をした起動では、この検査が目印を見つける',
    leakSignIn.ok === true && leakScan.hits.length > 0,
    `hits=${leakScan.hits.slice(0, 3).join(' / ')}`
  )
  const cacheFile = path.join(userData, 'kypr', 'cache.json')
  const cacheItems = fs.existsSync(cacheFile)
    ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')).items.length
    : 0
  check(
    '（前提）userData に kypr のキャッシュがあり、暗号文が入っている',
    cacheItems === afterRollback,
    `items=${cacheItems}`
  )
  const scan = findMarkers(userData)
  check(
    'userData のどのファイルにも平文（名前・ユーザー名・パスワード・メモ・URL・カード番号）が無い',
    scan.hits.length === 0 && scan.files > 0,
    `files=${scan.files} hits=${scan.hits.slice(0, 5).join(' / ')}`
  )
  const targets = await listTargets(app.cdp).catch(() => [])
  void targets
} catch (error) {
  failures += 1
  console.error('FAIL  検証が途中で落ちた —', error?.stack ?? error)
} finally {
  await stopChildren(spawned)
  await mock.close()
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks} 件中 ${checks - failures} 件 PASS / ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
