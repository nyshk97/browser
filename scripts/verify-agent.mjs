#!/usr/bin/env node
/**
 * Claude in Nemo（Claude Code から Nemo を操作する口）の検証（`mise run verify:only agent`）。
 * 計画: docs/plans/2026-09-28-1126-claude-in-nemo.md
 *
 * **Claude Code の代わりに偽の MCP クライアント**（このスクリプト）がブリッジ（`src/bridge/nemo-mcp-bridge.mjs`）を
 * stdio で起動し、Claude Code と同じ JSON-RPC を流す。ブリッジは `NEMO_AGENT_SOCKET` で
 * **このスクリプトが立てた使い捨ての Nemo にだけ**繋ぐ（常用・dev の socket には繋がない）。
 *
 * 見るもの:
 *   1. initialize / tools/list がブリッジだけで返り、定義の正本（agent-tools.js）と一致する
 *   2. 最初のツール呼び出しでエージェント窓が開き、**セッション保存・履歴・拡張のタブモデルに入らない**。
 *      窓の状態バーと通常窓の入口が、ツールの直後は作業中・止まると待機中になる
 *   3. 各ツール（navigate / screenshot / read_page / クリック / 入力 / キー / form_input / JS / console / network /
 *      ダイアログ / 離脱確認 / popup / file_upload / ダウンロード / タブの開閉）
 *   4. 安全の線: http(s) 以外の遷移を拒否（javascript: を含む）・クリップボードのキーを拒否・
 *      ユーザーが入力したパスワードが read_page / get_page_text に出ず javascript_tool が断られる
 *   5. 引き継ぎ: request_user_action の後は入力系が断られ、帯に「操作待ち」・通常窓の入口に「別ウィンドウで操作待ち」が出る。resume で戻る
 *   6. 切断で窓が閉じる / Nemo の再起動をまたいでブリッジが繋ぎ直す / 設定 OFF で接続が切れて socket が消える
 *   7. 診断ログにページ由来の値が出ていない / 未処理の例外が無い
 *   8. kypr（計画 2026-09-30「Claude のウィンドウで kypr」）: ユーザーの操作（ポップアップ・窓が key のときの
 *      ⌘⇧L / 欄の下の候補）で入り、入れたパスワード・コード・身分証の番号は read_page に出ない。
 *      Claude が javascript_tool を実行したページ（と、そこから開いたタブ）には入れない。iframe にはパスワードだけ。
 *      kypr の模擬サーバー（`scripts/lib/kypr-fixture.mjs`）と Jev の模擬を使う（本物には触らない）
 *
 * 使い方:
 *   node scripts/verify-agent.mjs   （事前に out/ がビルドされていること）
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  projectRoot,
  readLogLines,
  sleep,
  stopChild,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { connect, connectTo, connectUi, listTargets, waitFor } from './lib/cdp.mjs'
import { createKyprVault, profileToKypr } from './lib/kypr-fixture.mjs'
import { AGENT_TOOLS } from '../src/shared/agent-tools.js'
import { normalizeProfile } from '../src/shared/autofill-schema.js'
import { newIdentityItem, newLoginItem, newTotpItem } from '../src/vendor/kypr/crypto/index.ts'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

let failures = 0
let passes = 0
function check(name, ok, detail = '') {
  if (ok) passes += 1
  else failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const SECRET = 'Nemo-Secret-7731'

/* kypr（模擬サーバーの保管庫。本物には触らない） */
const KYPR_MASTER = 'agent-verify-master-1'
const KYPR_PW = 'Kypr-Agent-Pw-5821'
const KYPR_USER = 'agent-user@example.com'
const PASSPORT = 'TK7654321'
const PROFILE = normalizeProfile({ family_name: '山田', given_name: '太郎', passport_number: PASSPORT })

/* ------------------------------------------------------------------ *
 * テスト用のページ
 * ------------------------------------------------------------------ */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>agent-verify</title></head><body style="font:14px sans-serif">
<h1>Agent verify</h1>
<button id="count" onclick="this.dataset.n = String(Number(this.dataset.n || 0) + 1); this.textContent = 'Count ' + this.dataset.n">Count</button>
<label>Name <input id="name"></label>
<label>Password <input id="pw" type="password" autocomplete="current-password"></label>
<label>Plan <select id="plan"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label><input id="agree" type="checkbox"> agree</label>
<label>Date <input id="when" type="date"></label>
<input id="file" type="file" multiple>
<button id="confirm" onclick="document.body.dataset.confirm = String(confirm('本当に削除しますか？'))">Delete</button>
<button id="log" onclick="console.log('agent-verify-log-' + Date.now())">Log</button>
<a id="popup" href="/next" target="_blank">open popup</a>
<a id="dl" href="/download">download</a>
<p>Visible text paragraph for get_page_text.</p>
</body></html>`

const NEXT = `<!doctype html><title>next page</title><body>next</body>`
/** kypr のログイン（ユーザー名・パスワード・ワンタイムコードの欄。コードの欄は autocomplete の無い type=text）。 */
const KYPR_LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>kypr login</title></head><body>
<form><label>User <input id="u" name="username" autocomplete="username"></label>
<label>Password <input id="p" name="password" type="password"></label>
<label>Code <input id="otp" name="code"></label></form>
<button id="open" onclick="window.open(location.pathname + '?child=1')">open child</button>
</body></html>`
/** 個人情報（氏名はルール、旅券番号は Jev の模擬で決まる）。 */
const IDENTITY = `<!doctype html><html><head><meta charset="utf-8"><title>identity</title></head><body>
<form style="padding:20px"><label>氏名 <input id="name" autocomplete="name"></label><br>
<label>旅券番号 <input id="passport" name="passport"></label></form></body></html>`
const frameOf = (src) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body><iframe src="${src}" width="700" height="320"></iframe></body></html>`

/** Jev の模擬（`NEMO_JEV_TEST_ENDPOINT`）。見出しで答えを決める（値は届かない）。 */
function jevAnswer(body) {
  const answers = {}
  for (const [id, question] of Object.entries(body.questions ?? {})) {
    const field = question.instructions?.field ?? {}
    const label = field.label || field.nearby_text || ''
    if (id.startsWith('own')) answers[id] = { type: 'noul', noul: 0.93 }
    else {
      const choice = label.includes('旅券番号')
        ? 'passport_number'
        : label.includes('氏名')
          ? 'full_name'
          : 'none'
      answers[id] = { type: 'choice', choice, confidence: 0.97, probabilities: { [choice]: 0.97 } }
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }
}
const UNLOAD = `<!doctype html><title>unload guard</title><body><input id="t" value="dirty">
<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x' })</script></body>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/page') {
    // ログインが残るサイトの一覧と消去を見るための cookie
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'agent_sid=abc123; Path=/'
    })
    res.end(PAGE)
  } else if (url.pathname === '/authorize') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>consent</title><button id="allow">Allow</button>')
  } else if (url.pathname === '/next') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(NEXT)
  } else if (url.pathname === '/unload') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(UNLOAD)
  } else if (url.pathname === '/kypr-login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(KYPR_LOGIN)
  } else if (url.pathname === '/kypr-frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(frameOf('/kypr-login?in-frame=1'))
  } else if (url.pathname === '/identity') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(IDENTITY)
  } else if (url.pathname === '/identity-frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(frameOf('/identity?f=1'))
  } else if (url.pathname === '/v1/systemone' && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(jevAnswer(JSON.parse(raw))))
    })
  } else if (url.pathname === '/download') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="agent-verify.bin"'
    })
    res.end(Buffer.alloc(64, 7))
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})

/* ------------------------------------------------------------------ *
 * 偽の Claude Code（ブリッジを stdio で起動する MCP クライアント）
 * ------------------------------------------------------------------ */

function startBridge(socketPath) {
  const child = spawn(process.execPath, ['src/bridge/nemo-mcp-bridge.mjs'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, NEMO_AGENT_SOCKET: socketPath, CLAUDE_PROJECT_DIR: '/tmp/agent-verify-project' }
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  const request = (method, params = {}, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  /** ツールを呼び、`{ text, image, isError }` にする。 */
  const call = async (name, args = {}) => {
    const message = await request('tools/call', { name, arguments: args })
    const content = message.result?.content ?? []
    return {
      text: content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n'),
      image: content.find((item) => item.type === 'image') ?? null,
      isError: message.result?.isError === true,
      raw: message
    }
  }
  return { child, request, call }
}

/* ------------------------------------------------------------------ */

const spawned = []
const tempDirs = []
/** kypr の模擬サーバー（後片付けで閉じる）。 */
let kyprMock = null
function makeDir(prefix) {
  // unix socket の sun_path は 104 バイトまで。tmpdir 直下に短い名前で作る
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.chmodSync(dir, 0o700)
  tempDirs.push(dir)
  return dir
}

try {
  assertNemoNotRunning('verify-agent')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js')))
    throw new Error('out/ が無い。先に pnpm build する')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  // kypr の保管庫（模擬サーバー）。ログイン・ワンタイムコードはこの検証のページの origin に合わせる
  const kypr = await createKyprVault(KYPR_MASTER)
  kyprMock = kypr.mock
  const LOGIN = newLoginItem({
    name: 'Agent Site',
    username: KYPR_USER,
    password: KYPR_PW,
    uris: [{ uri: origin }]
  })
  const TOTP = newTotpItem({
    name: 'Agent Otp',
    account: 'me',
    secret: 'JBSWY3DPEHPK3PXP',
    uris: [{ uri: origin }]
  })
  const IDENT = newIdentityItem({ name: '自分', ...profileToKypr(PROFILE) })
  await kypr.other.create([LOGIN, TOTP, IDENT])

  const userData = makeDir('nav-data-')
  const socketDir = makeDir('nav-')
  const socketPath = path.join(socketDir, 'a.sock')
  const downloadDir = makeDir('nav-dl-')
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    // Live Folder を止める（使い捨てプロファイルでも gh の実トークンで GitHub を叩き続ける）
    JSON.stringify({ version: 1, data: { liveFolderEnabled: false, agentEnabled: true } })
  )

  const bootApp = async () => {
    const port = String(await getFreePort())
    const child = spawn(electronPath, ['out/main/index.js'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        NEMO_REMOTE_DEBUGGING_PORT: port,
        NEMO_USER_DATA_DIR: userData,
        NEMO_AGENT_SOCKET: socketPath,
        NEMO_DOWNLOAD_DIR: downloadDir,
        NEMO_VERIFY_DIAGNOSTICS: '1',
        NEMO_KYPR_TEST_SERVER: kypr.origin,
        NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
        NEMO_KYPR_TEST_TOUCHID: 'ok',
        NEMO_KYPR_TEST_CLIPBOARD: 'memory',
        NEMO_JEV_TEST_ENDPOINT: `${origin}/v1/systemone`
      }
    })
    spawned.push(child)
    const cdp = `http://127.0.0.1:${port}`
    await waitForHttp(`${cdp}/json/list`, {
      child,
      check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
    })
    return { child, cdp }
  }

  let app = await bootApp()
  const ui = await connectUi(app.cdp, 'sidebar', { urlPart: 'view=sidebar&window=1' })
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i += 1) await sleep(100)
  const socketStat = fs.existsSync(socketPath) ? fs.lstatSync(socketPath) : null
  check(
    '設定が ON なら socket を開く（0600）',
    socketStat?.isSocket() === true && (socketStat.mode & 0o777) === 0o600,
    socketStat ? `mode ${(socketStat.mode & 0o777).toString(8)}` : '無い'
  )

  /* ---- 1. initialize / tools/list ---- */
  let bridge = startBridge(socketPath)
  spawned.push(bridge.child)
  const init = await bridge.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify', version: '0' }
  })
  check(
    'initialize はブリッジだけで返る（instructions 付き）',
    init.result?.serverInfo?.name === 'nemo' && typeof init.result?.instructions === 'string',
    `${init.result?.instructions?.length ?? 0} 文字`
  )
  check(
    'instructions は 2048 文字以内（Claude Code が切る長さ）',
    (init.result?.instructions?.length ?? 9999) <= 2048
  )
  const listed = await bridge.request('tools/list')
  const names = (listed.result?.tools ?? []).map((tool) => tool.name)
  check(
    'tools/list が定義の正本と一致する',
    JSON.stringify(names) === JSON.stringify(AGENT_TOOLS.map((tool) => tool.name)),
    `${names.length} 件`
  )
  const unknown = await bridge.request('server/discover')
  check('未知のメソッドには -32601', unknown.error?.code === -32601)

  /* ---- 2. 窓 ---- */
  const before = await listTargets(app.cdp)
  const ctx = await bridge.call('tabs_context')
  const ctxJson = ctx.isError ? null : JSON.parse(ctx.text)
  check('tabs_context でエージェント窓が開く', ctxJson?.tabs?.length === 1, ctx.text.slice(0, 200))
  const agentUi = (await listTargets(app.cdp)).find(
    (t) => t.url.includes('view=sidebar') && t.url.includes('agent=1')
  )
  check(
    'エージェント窓の UI は agent=1 付きで開く',
    Boolean(agentUi) && !before.some((t) => t.url.includes('agent=1'))
  )
  check('窓の名前はプロジェクト名', ctxJson?.window === 'Claude — agent-verify-project', ctxJson?.window)
  // kypr はエージェント窓でも使える（ツールバーのアイコンの元になる状態を渡す・IPC も通る）。入れる検査は 8.
  if (agentUi) {
    const agentSession = await connect(agentUi.webSocketDebuggerUrl)
    await waitFor(agentSession, "typeof window.nemo === 'object' ? 'ok' : ''")
    const agentState = JSON.parse(await agentSession.ev('window.nemo.getWindowState().then(JSON.stringify)'))
    const kyprCall = await agentSession.ev(
      "window.nemo.kyprStatus().then((s) => 'allowed:' + s.state, (e) => 'rejected: ' + String(e && e.message).slice(-60))"
    )
    check(
      'エージェント窓にも kypr を出す（状態を渡す・IPC は通る）',
      agentState.kind === 'agent' && agentState.kypr !== null && kyprCall.startsWith('allowed'),
      `kind=${agentState.kind} kypr=${JSON.stringify(agentState.kypr)} ipc=${kyprCall}`
    )
    agentSession.close()
  }
  const tabId = ctxJson?.tabs?.[0]?.tabId

  /* ---- 3. 遷移と読み取り ---- */
  const nav = await bridge.call('navigate', { tabId, url: `${origin}/page` })
  check('navigate', !nav.isError && nav.text.includes('agent-verify'), nav.text.slice(0, 120))
  const shot = await bridge.call('computer', { tabId, action: 'screenshot' })
  const shotBytes = shot.image ? Buffer.from(shot.image.data, 'base64') : Buffer.alloc(0)
  const shotSize = jpegSize(shotBytes)
  check(
    'screenshot は JPEG で返る（長辺 1568 以下）',
    shot.image?.mimeType === 'image/jpeg' &&
      shotSize !== null &&
      Math.max(shotSize.width, shotSize.height) <= 1568,
    `${shotSize ? `${shotSize.width}x${shotSize.height}` : 'JPEG として読めない'} / ${shot.text}`
  )
  const tree = await bridge.call('read_page', { tabId })
  const countRef = tree.text.match(/button "Count" \[(ref_\d+)\]/)?.[1]
  check('read_page が ref 付きの木を返す', Boolean(countRef), tree.text.split('\n').slice(0, 6).join(' / '))
  const pageText = await bridge.call('get_page_text', { tabId })
  check('get_page_text', pageText.text.includes('Visible text paragraph'), `${pageText.text.length} 文字`)

  /* ---- 3. 入力 ---- */
  const page = await connectTo(app.cdp, '/page', { type: 'page' })
  const click = await bridge.call('computer', { tabId, action: 'left_click', ref: countRef })
  const counted = await page.ev("document.getElementById('count').dataset.n ?? '0'")
  check('ref でクリックできる', !click.isError && counted === '1', `n=${counted}`)
  const nameRef = tree.text.match(/textbox "Name" \[(ref_\d+)\]/)?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: nameRef })
  const typed = await bridge.call('computer', { tabId, action: 'type', text: 'こんにちは' })
  const nameValue = await page.ev("document.getElementById('name').value")
  check('type で文字が入る（日本語）', !typed.isError && nameValue === 'こんにちは', nameValue)
  await bridge.call('computer', { tabId, action: 'key', text: 'cmd+a' })
  await bridge.call('computer', { tabId, action: 'key', text: 'Backspace' })
  const cleared = await page.ev("document.getElementById('name').value")
  check('key で cmd+a → Backspace が効く', cleared === '', JSON.stringify(cleared))
  const paste = await bridge.call('computer', { tabId, action: 'key', text: 'cmd+v' })
  check(
    'クリップボードのキー（cmd+v）は断る',
    paste.isError && paste.text.includes('クリップボード'),
    paste.text
  )

  const tree2 = await bridge.call('read_page', { tabId })
  const planRef = tree2.text.match(/combobox "Plan" \[(ref_\d+)\]/)?.[1]
  const agreeRef = tree2.text.match(/checkbox "agree" \[(ref_\d+)\]/)?.[1]
  await bridge.call('form_input', { tabId, ref: planRef, value: 'Beta' })
  await bridge.call('form_input', { tabId, ref: agreeRef, value: true })
  const formState = await page.ev(
    "document.getElementById('plan').value + ',' + document.getElementById('agree').checked"
  )
  check('form_input（select のラベル・checkbox）', formState === 'b,true', formState)

  const js = await bridge.call('javascript_tool', { tabId, text: 'document.title + ":" + (1 + 2)' })
  check('javascript_tool は値を返す', js.text === 'agent-verify:3', js.text)
  const jsAwait = await bridge.call('javascript_tool', {
    tabId,
    text: 'await new Promise((r) => setTimeout(() => r(42), 50))'
  })
  check('javascript_tool はトップレベル await を待つ', jsAwait.text === '42', jsAwait.text)

  /* ---- 4. 安全の線: 遷移 ---- */
  for (const bad of [
    'javascript:document.title="pwned"',
    'file:///etc/hosts',
    'chrome-extension://abcdef/index.html',
    'data:text/html,x'
  ]) {
    const refused = await bridge.call('navigate', { tabId, url: bad })
    const title = await page.ev('document.title')
    check(
      `navigate は ${bad.split(':')[0]}: を拒否する`,
      refused.isError && title === 'agent-verify',
      refused.text.slice(0, 80)
    )
  }

  /* ---- 3. console / network ---- */
  await bridge.call('read_console_messages', { tabId })
  const logRef = tree2.text.match(/button "Log" \[(ref_\d+)\]/)?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: logRef })
  await sleep(200)
  const consoleOut = await bridge.call('read_console_messages', { tabId })
  check('read_console_messages', consoleOut.text.includes('agent-verify-log-'), consoleOut.text.slice(0, 120))
  await bridge.call('read_network_requests', { tabId })
  await page.ev(`fetch('${origin}/next').then(() => 1)`)
  await sleep(300)
  const net = await bridge.call('read_network_requests', { tabId })
  check(
    'read_network_requests（URL・メソッド・ステータス）',
    /GET 200 \w* http:\/\/127\.0\.0\.1:\d+\/next/.test(net.text),
    net.text.slice(0, 160)
  )

  /* ---- 3. JS ダイアログ（ネイティブの NSAlert を出さず、ツールで答える） ---- */
  const confirmRef = tree2.text.match(/button "Delete" \[(ref_\d+)\]/)?.[1]
  const clickConfirm = await bridge.call('computer', { tabId, action: 'left_click', ref: confirmRef })
  check(
    'confirm は保留されてツール結果に出る',
    clickConfirm.text.includes('confirm'),
    clickConfirm.text.slice(0, 160)
  )
  const blocked = await bridge.call('read_page', { tabId })
  check(
    'ダイアログ待ちの間は読み取りも「ダイアログ待ち」を返す',
    blocked.isError && blocked.text.includes('handle_dialog')
  )
  const shotDuringDialog = await bridge.call('computer', { tabId, action: 'screenshot' })
  check('ダイアログ待ちでもスクショは撮れる（capturePage）', Boolean(shotDuringDialog.image))
  await bridge.call('handle_dialog', { tabId, accept: true })
  const confirmed = await page.ev("document.body.dataset.confirm ?? ''")
  check('handle_dialog で confirm に答えられる', confirmed === 'true', confirmed)

  /* ---- 3. popup は同じ窓の新しいタブ ---- */
  const popupRef = tree2.text.match(/link "open popup" \[(ref_\d+)\]/)?.[1]
  const popupClick = await bridge.call('computer', { tabId, action: 'left_click', ref: popupRef })
  await sleep(800)
  const ctx2 = JSON.parse((await bridge.call('tabs_context')).text)
  check(
    'target=_blank は同じエージェント窓の新しいタブになる',
    ctx2.tabs.length === 2 && popupClick.text.includes('新しいタブ'),
    `${ctx2.tabs.length} タブ / ${popupClick.text.slice(0, 80)}`
  )
  const popupTab = ctx2.tabs.find((tab) => tab.tabId !== tabId)
  const closed = await bridge.call('tabs_close', { tabId: popupTab.tabId })
  const ctx3 = JSON.parse((await bridge.call('tabs_context')).text)
  check('tabs_close', !closed.isError && ctx3.tabs.length === 1)
  const stale = await bridge.call('read_page', { tabId: popupTab.tabId })
  check(
    '閉じたタブの tabId は「tabs_context から」を返す',
    stale.isError && stale.text.includes('tabs_context')
  )

  /* ---- 3. file_upload（ブリッジが読む） ---- */
  const uploadFile = path.join(makeDir('nav-up-'), 'hello.txt')
  fs.writeFileSync(uploadFile, 'hello from agent')
  const fileRef = (await bridge.call('read_page', { tabId })).text.match(/file[^\n]*\[(ref_\d+)\]/)?.[1]
  const uploaded = await bridge.call('file_upload', { tabId, ref: fileRef, paths: [uploadFile] })
  const fileState = await page.ev(
    "(async () => { const f = document.getElementById('file').files[0]; return f ? f.name + ':' + (await f.text()) : 'none' })()"
  )
  check(
    'file_upload',
    !uploaded.isError && fileState === 'hello.txt:hello from agent',
    `${uploaded.text} / ${fileState}`
  )
  const relative = await bridge.call('file_upload', { tabId, ref: fileRef, paths: ['relative.txt'] })
  check('file_upload は相対パスを断る', relative.isError)

  /* ---- 3. ダウンロードはダイアログなしで固定フォルダ ---- */
  const dlRef = (await bridge.call('read_page', { tabId })).text.match(/link "download" \[(ref_\d+)\]/)?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: dlRef })
  const dlTarget = path.join(downloadDir, 'Nemo Agent', 'agent-verify.bin')
  for (let i = 0; i < 50 && !fs.existsSync(dlTarget); i += 1) await sleep(100)
  check('ダウンロードは <保存先>/Nemo Agent へダイアログなしで保存', fs.existsSync(dlTarget), dlTarget)

  /* ---- 4. 安全の線: ユーザーが入力したパスワード ---- */
  // 「ユーザーの入力」の代わりに、Claude の操作の外（CDP の remote 接続）から値を入れる
  await page.send('Runtime.evaluate', { expression: "document.getElementById('pw').focus()" })
  await page.send('Input.insertText', { text: SECRET })
  // 「パスワードを表示」相当（type=text にする）。一度でも password だった欄は伏せる
  await page.ev("document.getElementById('pw').type = 'text'; 1")
  const afterTree = await bridge.call('read_page', { tabId })
  const afterText = await bridge.call('get_page_text', { tabId })
  check(
    'ユーザーが入れたパスワードは read_page / get_page_text に出ない',
    !afterTree.text.includes(SECRET) &&
      !afterText.text.includes(SECRET) &&
      afterTree.text.includes('[redacted]'),
    afterTree.text.split('\n').find((line) => line.includes('Password')) ?? ''
  )
  const jsTainted = await bridge.call('javascript_tool', {
    tabId,
    text: "document.getElementById('pw').value"
  })
  check(
    'パスワード入力後の javascript_tool は断る',
    jsTainted.isError && !jsTainted.text.includes(SECRET),
    jsTainted.text.slice(0, 80)
  )

  /* ---- 3. 離脱確認（beforeunload）: 既定では残り、force で離れる ---- */
  await bridge.call('navigate', { tabId, url: `${origin}/unload` })
  const unloadPage = await connectTo(app.cdp, '/unload', { type: 'page' })
  // beforeunload はユーザー操作（sticky activation）の後でないと出ない。ページを 1 回クリックしておく
  await bridge.call('computer', { tabId, action: 'left_click', coordinate: [30, 30] })
  const stay = await bridge.call('navigate', { tabId, url: `${origin}/next` })
  const stillThere = await unloadPage.ev('location.pathname')
  check(
    '離脱確認が出たら既定では移動しない',
    stay.isError && stillThere === '/unload',
    stay.text.slice(0, 80)
  )
  const leave = await bridge.call('navigate', { tabId, url: `${origin}/next`, force: true })
  check('force: true なら離れる', !leave.isError && leave.text.includes('/next'), leave.text.slice(0, 80))

  /* ---- 5. 引き継ぎ ---- */
  const handoff = await bridge.call('request_user_action', { tabId, message: 'ログインしてください' })
  check('request_user_action', !handoff.isError)
  const refusedClick = await bridge.call('computer', { tabId, action: 'left_click', coordinate: [10, 10] })
  check('ユーザーの番は入力系を断る', refusedClick.isError && refusedClick.text.includes('ユーザーの番'))
  const readDuringTurn = await bridge.call('computer', { tabId, action: 'screenshot' })
  check('ユーザーの番でもスクショは撮れる', Boolean(readDuringTurn.image))
  // エージェント窓のサイドバー（ツールバー・オーバーレイも agent=1 を持つので view で選ぶ）
  const agentSidebarTarget = (await listTargets(app.cdp)).find(
    (t) => t.url.includes('view=sidebar') && t.url.includes('agent=1')
  )
  const agentSidebar = await connect(agentSidebarTarget.webSocketDebuggerUrl)
  await waitFor(
    agentSidebar,
    "document.querySelector('.agent-band')?.dataset.agentMode === 'user' ? 'ok' : ''"
  )
  const band = await agentSidebar.ev("document.querySelector('.agent-band')?.innerText ?? ''")
  check(
    '帯に「操作待ち」と Nemo が確かめた origin・Claude の依頼文・「終わったらチャットで「done」」が出る',
    band.includes('操作待ち') &&
      band.includes(origin) &&
      band.includes('ログインしてください') &&
      band.includes('終わったらチャットで「done」'),
    band.replace(/\s+/g, ' ').slice(0, 160)
  )
  // 通常窓のサイドバーにも入口が出て、ユーザーの番は目立たせる
  await waitFor(ui, "document.querySelector('.agent-entry.user-turn') ? 'ok' : ''")
  const entryUser = await ui.ev("document.querySelector('.agent-entry')?.innerText ?? ''")
  check(
    '通常窓のサイドバーに「別ウィンドウで操作待ち」の入口が目立つ形で出る',
    entryUser.includes('別ウィンドウで操作待ち'),
    entryUser.replace(/\s+/g, ' ')
  )
  const resumed = await bridge.call('resume')
  const clickAfter = await bridge.call('computer', { tabId, action: 'left_click', coordinate: [10, 10] })
  check('resume の後は入力できる', !resumed.isError && !clickAfter.isError, clickAfter.text.slice(0, 80))
  await waitFor(
    agentSidebar,
    "document.querySelector('.agent-band')?.dataset.agentMode === 'claude' ? 'ok' : ''"
  )
  check('帯は Claude の番に戻る', true)
  // 窓の側に番を戻すボタン・IPC は無い（再開はチャットの「done」→ resume だけ。番だけ戻しても Claude は動き出さない）
  check(
    '依頼カードに「Claude に戻す」ボタンが無く、UI に番を戻す口も無い',
    !band.includes('Claude に戻す') &&
      (await agentSidebar.ev("typeof window.nemo.agentResume === 'undefined' ? 'none' : 'exists'")) === 'none'
  )

  /* ---- 4. 安全の線: Claude に操作させないページ・ブロックリスト ---- */
  const oauthUrl = `${origin}/authorize?client_id=a&redirect_uri=https%3A%2F%2Fx.example&response_type=code`
  const navOauth = await bridge.call('navigate', { tabId, url: oauthUrl })
  check(
    'OAuth の同意画面へは navigate できない',
    navOauth.isError && navOauth.text.includes('request_user_action'),
    navOauth.text.slice(0, 80)
  )
  const navToken = await bridge.call('navigate', { tabId, url: 'https://github.com/settings/tokens/new' })
  check('トークン発行の画面へは navigate できない', navToken.isError && navToken.text.includes('トークン'))
  // ページ起点（リダイレクト・リンク）で着いた場合は、入力を断る
  await bridge.call('javascript_tool', { tabId, text: `location.href = ${JSON.stringify(oauthUrl)}; 1` })
  const consent = await connectTo(app.cdp, '/authorize', { type: 'page' })
  await waitFor(consent, "document.getElementById('allow') ? 'ok' : ''")
  const clickConsent = await bridge.call('computer', { tabId, action: 'left_click', coordinate: [20, 20] })
  check(
    'ページ起点で着いた OAuth の同意画面でも入力を断る',
    clickConsent.isError && clickConsent.text.includes('Claude は操作できません')
  )
  const readConsent = await bridge.call('read_page', { tabId })
  check('Claude に操作させないページでも読み取りはできる', !readConsent.isError)
  await ui.ev("window.nemo.updateSettings({ agentBlockedHosts: ['127.0.0.1'] }).then(() => 'ok')")
  const navBlocked = await bridge.call('navigate', { tabId, url: `${origin}/next` })
  check(
    'ブロックリストのホストへは navigate できない',
    navBlocked.isError && navBlocked.text.includes('agentBlockedHosts')
  )
  await ui.ev("window.nemo.updateSettings({ agentBlockedHosts: [] }).then(() => 'ok')")
  const back = await bridge.call('navigate', { tabId, url: `${origin}/page` })
  check(
    'Claude に操作させないページから離れる navigate はできる',
    !back.isError && back.text.includes('/page'),
    back.text.slice(0, 80)
  )

  /* ---- 2. 状態バーの作業中 / 待機中 ---- */
  await bridge.call('computer', { tabId, action: 'screenshot' })
  // ツールが止まってから 2.5 秒は作業中のまま（ツールの合間でちらつかせない）ので、返った直後は作業中が見える
  const busyText = await agentSidebar.ev(
    "(() => { const b = document.querySelector('.agent-band'); return b?.dataset.agentPhase + '|' + (b?.querySelector('.agent-status')?.innerText ?? '') })()"
  )
  check(
    '状態バー: ツールの直後は作業中で、今の動作（スクリーンショット）が出る',
    busyText.startsWith('busy|') && busyText.includes('スクリーンショット'),
    busyText.replace(/\s+/g, ' ')
  )
  await waitFor(
    agentSidebar,
    "document.querySelector('.agent-band')?.dataset.agentPhase === 'idle' ? 'ok' : ''"
  )
  const idleText = await agentSidebar.ev("document.querySelector('.agent-status')?.innerText ?? ''")
  check(
    '状態バー: ツールが止まると待機中に落ちる',
    idleText.includes('待機中'),
    idleText.replace(/\s+/g, ' ')
  )

  /* ---- 2. 通常窓の入口も状態バーと同じ作業中 / 待機中 ---- */
  // 入口は main の共有状態経由（全窓へ配る）で、状態バーとは別の経路。作業中に上がって待機中に落ちるまでを見る
  const entryState =
    "(() => { const e = document.querySelector('.agent-entry'); return e ? e.dataset.agentPhase + '|' + e.innerText : '' })()"
  const entryIdleBefore = await waitFor(
    ui,
    `(() => { const s = ${entryState}; return s.startsWith('idle|') ? s : '' })()`
  )
  await bridge.call('computer', { tabId, action: 'screenshot' })
  const entryBusy = await waitFor(
    ui,
    `(() => { const s = ${entryState}; return s.startsWith('busy|') ? s : '' })()`,
    {
      timeoutMs: 2000,
      interval: 50
    }
  )
  check(
    '通常窓の入口: ツールの直後は「別ウィンドウで作業中」',
    entryIdleBefore.startsWith('idle|') && entryBusy.includes('別ウィンドウで作業中'),
    `前: ${entryIdleBefore.replace(/\s+/g, ' ')} → ${entryBusy.replace(/\s+/g, ' ')}`
  )
  const entryIdle = await waitFor(
    ui,
    `(() => { const s = ${entryState}; return s.startsWith('idle|') ? s : '' })()`
  )
  check(
    '通常窓の入口: ツールが止まると「別ウィンドウで待機中」に落ちる',
    entryIdle.includes('別ウィンドウで待機中'),
    entryIdle.replace(/\s+/g, ' ')
  )

  /* ---- 2. Claude in Nemo の cookie 等を全て削除（設定画面） ---- */
  const readCookie = () => bridge.call('javascript_tool', { tabId, text: 'document.cookie' })
  const cookieBefore = await readCookie()
  check('（前提）Claude のタブに cookie がある', cookieBefore.text.includes('agent_sid'), cookieBefore.text)
  check(
    'Claude のウィンドウのサイドバーに cookie のサイト一覧が無い',
    (await agentSidebar.ev("document.querySelector('.agent-sites') ? 'exists' : 'none'")) === 'none'
  )
  const fromAgent = await agentSidebar.ev(
    "window.nemo.agentClearData().then(() => 'allowed', () => 'refused')"
  )
  check('Claude のウィンドウからは消せない（設定画面からだけ）', fromAgent === 'refused')
  // 設定画面は通常窓のオーバーレイ（agent=1 の付かない view=overlay）。描画からボタンを押す
  await ui.ev("window.nemo.setOverlay('settings').then(() => 'ok')")
  let overlayTarget = null
  for (let i = 0; i < 50 && !overlayTarget; i += 1) {
    overlayTarget = (await listTargets(app.cdp)).find(
      (t) => t.url.includes('view=overlay') && !t.url.includes('agent=1')
    )
    if (!overlayTarget) await sleep(200)
  }
  const settingsView = await connect(overlayTarget.webSocketDebuggerUrl)
  const clearButton = "document.querySelector('.agent-clear-data button')"
  const clearLabel = await waitFor(settingsView, `${clearButton}?.innerText ?? ''`)
  check(
    '設定画面に「Claude in Nemo の cookie 等を全て削除」がある',
    clearLabel === 'Claude in Nemo の cookie 等を全て削除',
    clearLabel
  )
  await settingsView.ev(`${clearButton}.click(), 'ok'`)
  const armedLabel = await waitFor(
    settingsView,
    `${clearButton}?.dataset.armed === 'true' ? ${clearButton}.innerText : ''`
  )
  const cookieArmed = await readCookie()
  check(
    '1 回目の押下では消えず、「削除する」の確認に変わる',
    armedLabel.startsWith('削除する') && cookieArmed.text.includes('agent_sid'),
    `${armedLabel} / ${cookieArmed.text}`
  )
  await settingsView.ev(`${clearButton}.click(), 'ok'`)
  const clearedMessage = await waitFor(
    settingsView,
    "document.querySelector('.agent-clear-message')?.innerText ?? ''"
  )
  const cookieAfter = await readCookie()
  check(
    'もう一度押すと消え、Claude のタブの cookie が無くなる',
    clearedMessage === '削除しました。' && !cookieAfter.isError && !cookieAfter.text.includes('agent_sid'),
    `${clearedMessage} / ${cookieAfter.text}`
  )
  settingsView.close()
  await ui.ev("window.nemo.setOverlay(null).then(() => 'ok')")

  /* ---- 2. 共有状態に入らない ---- */
  const suggestions = await ui.ev(
    "window.nemo.suggest('next page').then((s) => JSON.stringify(s.map((x) => x.kind + ':' + x.url)))"
  )
  check('エージェントの訪問は履歴・候補に入らない', !suggestions.includes('/next'), suggestions.slice(0, 160))
  await sleep(2500)
  const sessionFile = path.join(userData, 'session.json')
  const savedWindows = fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')).data?.windows
    : null
  check(
    'セッション保存にエージェント窓は入らない',
    Array.isArray(savedWindows) && savedWindows.length === 1,
    `${savedWindows?.length ?? '?'} 窓`
  )

  /* ---- 8. kypr（Claude のウィンドウで、ユーザーの操作で入れる） ---- */
  const signIn = JSON.parse(
    await ui.ev(`window.nemo.kyprSignIn(${JSON.stringify(KYPR_MASTER)}, true).then(JSON.stringify)`)
  )
  check(
    '（前提）kypr の模擬サーバーの保管庫に通常窓からログインできる',
    signIn.ok === true,
    JSON.stringify(signIn)
  )
  await ui.ev("window.nemo.saveJevKey('agent-verify-jev-key').then(String)")
  const agentUiTarget = (await listTargets(app.cdp)).find(
    (t) => t.url.includes('view=sidebar') && t.url.includes('agent=1')
  )
  const agentUi2 = await connect(agentUiTarget.webSocketDebuggerUrl)
  await waitFor(agentUi2, "typeof window.nemo === 'object' ? 'ok' : ''")
  const aj = async (expression) => JSON.parse(await agentUi2.ev(`${expression}.then(JSON.stringify)`))
  const agentTabKey = async (part) =>
    (await aj('window.nemo.getWindowState()')).tabs.find((t) => t.url.includes(part))?.key ?? null
  /** Claude の navigate で開き、ページに CDP で繋ぐ（値の確かめ用。**マウスは撃たない**: 実マウス扱いで窓が key になりうる） */
  const openForKypr = async (pathAndQuery) => {
    const nav = await bridge.call('navigate', { tabId, url: `${origin}${pathAndQuery}` })
    const session = await connectTo(app.cdp, pathAndQuery, { type: 'page' })
    await waitFor(session, "document.readyState === 'complete' ? 'ok' : ''")
    return { nav, session }
  }
  const readValue = (session, expr) => session.ev(`String(${expr} ?? '')`)

  // --- ポップアップから入れる（窓が key でなくてよい。ポップアップは Nemo の View で CDP から届かない） ---
  let { session: kp } = await openForKypr('/kypr-login')
  const kyprPanel = await aj('window.nemo.kyprPanel()')
  check(
    'kypr: Claude のウィンドウのポップアップに、このページに合うログインとコードが出る',
    kyprPanel.matches.some((m) => m.id === LOGIN.id) &&
      kyprPanel.totpMatches.some((m) => m.id === TOTP.id) &&
      kyprPanel.agentRefusal === null,
    JSON.stringify({
      m: kyprPanel.matches.length,
      t: kyprPanel.totpMatches.length,
      r: kyprPanel.agentRefusal
    })
  )
  const popupFill = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
  const filledUser = await readValue(kp, "document.getElementById('u').value")
  const filledPw = await readValue(kp, "document.getElementById('p').value")
  check(
    'kypr: ポップアップからログインを入れられる',
    popupFill.ok === true && filledUser === KYPR_USER && filledPw === KYPR_PW,
    JSON.stringify({ popupFill, u: filledUser, p: filledPw ? '(入っている)' : '' })
  )
  const kyprTree = await bridge.call('read_page', { tabId })
  check(
    'kypr: 入れたパスワードは read_page に出ない',
    !kyprTree.text.includes(KYPR_PW) && kyprTree.text.includes('[redacted]'),
    kyprTree.text.split('\n').find((line) => line.includes('Password')) ?? ''
  )
  const jsAfterKypr = await bridge.call('javascript_tool', {
    tabId,
    text: "document.getElementById('p').value"
  })
  check(
    'kypr: 入れた後の javascript_tool は断る（taint）',
    jsAfterKypr.isError && !jsAfterKypr.text.includes(KYPR_PW),
    jsAfterKypr.text.slice(0, 80)
  )
  // コード（autocomplete の無い type=text の欄）: 既存の伏せ字では拾えない値。入れる前に覚えさせるので出ない
  await kp.ev("document.getElementById('otp').focus(), 'ok'")
  const totpFill = await aj(`window.nemo.kyprFillTotp(${JSON.stringify(TOTP.id)})`)
  const codeInPage = await readValue(kp, "document.getElementById('otp').value")
  const codeTree = await bridge.call('read_page', { tabId })
  check(
    'kypr: ワンタイムコードを入れられ、入れたコードは read_page に出ない',
    totpFill.ok === true &&
      !totpFill.copied &&
      /^\d{6}$/.test(codeInPage) &&
      !codeTree.text.includes(codeInPage),
    `${JSON.stringify(totpFill)} / ${codeTree.text.split('\n').find((line) => line.includes('Code')) ?? ''}`
  )

  // --- javascript_tool を実行したページには入れない ---
  ;({ session: kp } = await openForKypr('/kypr-login?js=1'))
  await bridge.call('javascript_tool', { tabId, text: '1 + 1' })
  const refusedFill = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
  const refusedPanel = await aj('window.nemo.kyprPanel()')
  const refusedTotp = await aj(`window.nemo.kyprFillTotp(${JSON.stringify(TOTP.id)})`)
  check(
    'kypr: Claude が javascript_tool を実行したページには入れない（ポップアップにも理由が出る）',
    refusedFill.ok === false &&
      refusedFill.reason === 'agent-script' &&
      refusedTotp.reason === 'agent-script' &&
      refusedPanel.agentRefusal === 'agent-script' &&
      (await readValue(kp, "document.getElementById('p').value")) === '',
    JSON.stringify({ refusedFill, refusedTotp, panel: refusedPanel.agentRefusal })
  )
  // 記録のある document が window.open で開いたタブ（opener から DOM を触れる）にも入れない
  const openRef = (await bridge.call('read_page', { tabId })).text.match(
    /button "open child" \[(ref_\d+)\]/
  )?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: openRef })
  let childKey = null
  for (let i = 0; i < 50 && !childKey; i += 1) {
    childKey = await agentTabKey('child=1')
    if (!childKey) await sleep(100)
  }
  const childPage = await connectTo(app.cdp, 'child=1', { type: 'page' })
  await waitFor(childPage, "document.readyState === 'complete' ? 'ok' : ''")
  await agentUi2.ev(`window.nemo.selectTab(${JSON.stringify(childKey)}).then(() => 'ok')`)
  const childFill = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
  check(
    'kypr: javascript_tool を実行したページが開いたタブにも入れない',
    childFill.ok === false &&
      childFill.reason === 'agent-script' &&
      (await readValue(childPage, "document.getElementById('p').value")) === '',
    JSON.stringify(childFill)
  )
  const childTabId = JSON.parse((await bridge.call('tabs_context')).text).tabs.find((t) =>
    t.url.includes('child=1')
  )?.tabId
  if (childTabId) await bridge.call('tabs_close', { tabId: childTabId })
  // opener を切っても（`w.opener = null`）、開いた側が移動しても、JS を実行したページが開いたタブには入れない
  // （生まれた時点で記録する。生の opener をたどるだけだと、どちらも入ってしまう）
  const openedByScript = async (query, afterOpen) => {
    await openForKypr(`/kypr-login?${query}`)
    const opened = await bridge.call('javascript_tool', {
      tabId,
      text: `window.__w = window.open(location.pathname + '?${query}-child=1'); ${afterOpen}; 'opened'`
    })
    let key = null
    for (let i = 0; i < 50 && !key; i += 1) {
      key = await agentTabKey(`${query}-child=1`)
      if (!key) await sleep(100)
    }
    return { opened: opened.text, key }
  }
  const tryChild = async (key, part) => {
    const session = await connectTo(app.cdp, part, { type: 'page' })
    await waitFor(session, "document.readyState === 'complete' ? 'ok' : ''")
    await agentUi2.ev(`window.nemo.selectTab(${JSON.stringify(key)}).then(() => 'ok')`)
    const result = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
    const pw = await readValue(session, "document.getElementById('p').value")
    const ctx = JSON.parse((await bridge.call('tabs_context')).text)
    const child = ctx.tabs.find((t) => t.url.includes(part))
    if (child) await bridge.call('tabs_close', { tabId: child.tabId })
    return { result, pw }
  }
  const nulled = await openedByScript('nulled', 'window.__w.opener = null')
  const nulledTry = nulled.key ? await tryChild(nulled.key, 'nulled-child=1') : null
  check(
    'kypr: JS を実行したページが開いて opener を切った（w.opener = null）タブにも入れない',
    nulledTry?.result.ok === false && nulledTry.result.reason === 'agent-script' && nulledTry.pw === '',
    JSON.stringify({ opened: nulled.opened, key: Boolean(nulled.key), result: nulledTry?.result })
  )
  const orphan = await openedByScript('orphan', 'void 0')
  await bridge.call('navigate', { tabId, url: `${origin}/next` })
  const orphanTry = orphan.key ? await tryChild(orphan.key, 'orphan-child=1') : null
  check(
    'kypr: JS を実行したページが開いたタブは、開いた側が移動した後も入れない',
    orphanTry?.result.ok === false && orphanTry.result.reason === 'agent-script' && orphanTry.pw === '',
    JSON.stringify({ opened: orphan.opened, key: Boolean(orphan.key), result: orphanTry?.result })
  )
  // 移動（新しい document）すれば入れられる
  ;({ session: kp } = await openForKypr('/kypr-login?js=2'))
  const afterNav = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
  check(
    'kypr: 移動した後の新しいページには入れられる',
    afterNav.ok === true && (await readValue(kp, "document.getElementById('p').value")) === KYPR_PW,
    JSON.stringify(afterNav)
  )

  // --- ページ起点の入口（⌘⇧L・欄の下の候補）は窓が key のときだけ ---
  ;({ session: kp } = await openForKypr('/kypr-login?key=1'))
  await agentUi2.ev("window.nemo.runCommandForVerify('kypr-fill').then(String)")
  await sleep(500)
  const shortcutNotKey = await readValue(kp, "document.getElementById('p').value")
  // Claude の CDP のキーで ⌘⇧L（ページで処理されなければメニューへ回る経路）
  const uRef = (await bridge.call('read_page', { tabId })).text.match(/textbox "User" \[(ref_\d+)\]/)?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: uRef })
  await bridge.call('computer', { tabId, action: 'key', text: 'cmd+shift+l' })
  await sleep(500)
  const shortcutCdp = await readValue(kp, "document.getElementById('p').value")
  const overlayNotKey = (await aj('window.nemo.getOverlayState()')).kind
  check(
    'kypr: 窓が key でないとき ⌘⇧L は入れず、Claude のクリック・キー（CDP）で候補も出さず入れない',
    shortcutNotKey === '' && shortcutCdp === '' && overlayNotKey !== 'kypr-inline',
    JSON.stringify({ shortcutNotKey, shortcutCdp, overlay: overlayNotKey })
  )
  await agentUi2.ev('window.nemo.agentKeyForVerify(true).then(String)')
  await agentUi2.ev("window.nemo.runCommandForVerify('kypr-fill').then(String)")
  let shortcutKey = ''
  for (let i = 0; i < 30 && !shortcutKey; i += 1) {
    shortcutKey = await readValue(kp, "document.getElementById('p').value")
    if (!shortcutKey) await sleep(100)
  }
  check('kypr: 窓が key のとき ⌘⇧L で入る（合うログインが 1 件）', shortcutKey === KYPR_PW)
  ;({ session: kp } = await openForKypr('/kypr-login?key=2'))
  const uRef2 = (await bridge.call('read_page', { tabId })).text.match(/textbox "User" \[(ref_\d+)\]/)?.[1]
  await bridge.call('computer', { tabId, action: 'left_click', ref: uRef2 })
  const inlineShown = await waitFor(
    agentUi2,
    "window.nemo.getOverlayState().then((s) => s.kind === 'kypr-inline' ? 'ok' : '')",
    { timeoutMs: 5000 }
  ).catch(() => '')
  check('kypr: 窓が key のときは欄の下に候補が出る', inlineShown === 'ok')
  await agentUi2.ev('window.nemo.kyprInlineDismiss().then(String)')
  await agentUi2.ev('window.nemo.agentKeyForVerify(false).then(String)')

  const detachedLines = () =>
    readLogLines(userData).filter((line) => line.includes('"event":"agent.debugger_detached"'))
  const detachedBefore = detachedLines().length
  // --- iframe: パスワードは入れる / コードは入れずにコピーに回す ---
  ;({ session: kp } = await openForKypr('/kypr-frame'))
  await waitFor(kp, "document.querySelector('iframe')?.contentDocument?.getElementById('p') ? 'ok' : ''")
  const frameFill = await aj(`window.nemo.kyprFill(${JSON.stringify(LOGIN.id)})`)
  const framePw = await readValue(
    kp,
    "document.querySelector('iframe').contentDocument.getElementById('p').value"
  )
  check(
    'kypr: iframe のパスワードの欄には入れる',
    frameFill.ok === true && framePw === KYPR_PW,
    JSON.stringify(frameFill)
  )
  await kp.ev("document.querySelector('iframe').contentDocument.getElementById('otp').focus(), 'ok'")
  const frameTotp = await aj(`window.nemo.kyprFillTotp(${JSON.stringify(TOTP.id)})`)
  const frameCode = await readValue(
    kp,
    "document.querySelector('iframe').contentDocument.getElementById('otp').value"
  )
  const clip = await aj('window.nemo.kyprClipboardForVerify()')
  check(
    'kypr: iframe のコードの欄には入れず、コピーに回す',
    frameTotp.ok === true && frameTotp.copied === true && frameCode === '' && /^\d{6}$/.test(clip ?? ''),
    JSON.stringify({ frameTotp, frameCode, clip: clip ? '(コード)' : clip })
  )

  // --- フォーム自動入力（個人情報） ---
  ;({ session: kp } = await openForKypr('/identity'))
  const idKey = await agentTabKey('/identity')
  const rect = JSON.parse(
    await kp.ev(
      "(() => { const r = document.getElementById('passport').getBoundingClientRect(); return JSON.stringify({ x: r.left + 5, y: r.top + r.height / 2 }) })()"
    )
  )
  const idResult = await aj(`window.nemo.autofillForVerify(${JSON.stringify(idKey)}, ${rect.x}, ${rect.y})`)
  const idName = await readValue(kp, "document.getElementById('name').value")
  const idPassport = await readValue(kp, "document.getElementById('passport').value")
  const idTree = await bridge.call('read_page', { tabId })
  check(
    '自動入力: Claude のウィンドウでも入り、旅券番号は read_page に出ず、氏名は出る',
    idResult?.ok === true &&
      idPassport === PASSPORT &&
      idName.includes('山田') &&
      !idTree.text.includes(PASSPORT) &&
      idTree.text.includes('山田'),
    `${JSON.stringify({ ok: idResult?.ok, reason: idResult?.reason, jevError: idResult?.jevError })} / ${idTree.text
      .split('\n')
      .filter((line) => line.includes('旅券') || line.includes('氏名'))
      .join(' / ')}`
  )
  ;({ session: kp } = await openForKypr('/identity?js=1'))
  await bridge.call('javascript_tool', { tabId, text: '1' })
  const idRefused = await aj(
    `window.nemo.autofillForVerify(${JSON.stringify(await agentTabKey('js=1'))}, ${rect.x}, ${rect.y})`
  )
  check(
    '自動入力: Claude が javascript_tool を実行したページには入れない',
    idRefused?.ok === false &&
      idRefused.reason === 'agent-script' &&
      (await readValue(kp, "document.getElementById('name').value")) === '',
    JSON.stringify(idRefused)
  )
  ;({ session: kp } = await openForKypr('/identity-frame'))
  await waitFor(
    kp,
    "document.querySelector('iframe')?.contentDocument?.getElementById('passport') ? 'ok' : ''"
  )
  const idFrame = await aj(
    `window.nemo.autofillForVerify(${JSON.stringify(await agentTabKey('/identity-frame'))}, -1, -1, ${JSON.stringify(`${origin}/identity?f=1`)})`
  )
  const frameName = await readValue(
    kp,
    "document.querySelector('iframe').contentDocument.getElementById('name').value"
  )
  const framePassport = await readValue(
    kp,
    "document.querySelector('iframe').contentDocument.getElementById('passport').value"
  )
  check(
    '自動入力: iframe では旅券番号の欄だけ空のまま残し、氏名は入れる',
    idFrame?.ok === true && idFrame.withheld === 1 && framePassport === '' && frameName.includes('山田'),
    JSON.stringify({ ok: idFrame?.ok, reason: idFrame?.reason, withheld: idFrame?.withheld, name: frameName })
  )
  // iframe に CDP で入った後も agent の debugger は付いたまま（先に agent が付け、相乗りした側は detach しない）
  const shotAfterFrame = await bridge.call('computer', { tabId, action: 'screenshot' })
  const detached = detachedLines().slice(detachedBefore)
  check(
    'iframe に入った後も agent の debugger は外れていない（スクショも撮れる）',
    detached.length === 0 && Boolean(shotAfterFrame.image),
    `前 ${detachedBefore} 回 / iframe の間に ${detached.length} 回外れた ${detached.join(' ').slice(0, 300)}`
  )

  // --- Web 版 kypr の Touch ID（Nemo 内蔵の認証器）は Claude のウィンドウでは出ない ---
  const uvpaa = async (url) => {
    await bridge.call('navigate', { tabId, url })
    const r = await bridge.call('javascript_tool', {
      tabId,
      text: 'JSON.stringify({ uv: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), caps: await (PublicKeyCredential.getClientCapabilities ? PublicKeyCredential.getClientCapabilities() : null) })'
    })
    return r.text
  }
  const onKypr = await uvpaa(`${kypr.origin}/`)
  const onOther = await uvpaa(`${origin}/next`)
  check(
    'kypr の Web 版の Touch ID（内蔵の認証器）は Claude のウィンドウでは入らない（kypr の origin でも素の値）',
    onKypr === onOther && onKypr.startsWith('{'),
    `kypr=${onKypr.slice(0, 120)} / other=${onOther.slice(0, 120)}`
  )
  agentUi2.close()
  await bridge.call('navigate', { tabId, url: `${origin}/page` })

  /* ---- 6. 切断で窓が閉じる ---- */
  bridge.child.stdin.end()
  await stopChild(bridge.child).catch(() => {})
  let agentGone = false
  for (let i = 0; i < 50 && !agentGone; i += 1) {
    agentGone = !(await listTargets(app.cdp)).some((t) => t.url.includes('agent=1'))
    if (!agentGone) await sleep(100)
  }
  check('Claude Code が終わる（stdin EOF）とエージェント窓が閉じる', agentGone)

  /* ---- 6. Nemo の再起動をまたいでブリッジが繋ぎ直す ---- */
  bridge = startBridge(socketPath)
  spawned.push(bridge.child)
  await bridge.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'v', version: '0' }
  })
  const first = JSON.parse((await bridge.call('tabs_context')).text)
  await stopChild(app.child)
  const whileDown = await bridge.call('tabs_context')
  check(
    'Nemo が落ちている間はエラーを返し、ブリッジは生きている',
    whileDown.isError && bridge.child.exitCode === null,
    whileDown.text.slice(0, 80)
  )
  app = await bootApp()
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i += 1) await sleep(100)
  const afterRestart = await bridge.call('tabs_context')
  check('Nemo が戻ったら同じブリッジで繋ぎ直す', !afterRestart.isError, afterRestart.text.slice(0, 80))
  const oldTab = await bridge.call('read_page', { tabId: first.tabs[0].tabId })
  check(
    '再起動前の tabId は「tabs_context から」を返す',
    oldTab.isError && oldTab.text.includes('tabs_context')
  )

  /* ---- 6. 設定 OFF で接続が切れ、窓が閉じ、socket が消える ---- */
  const ui2 = await connectUi(app.cdp, 'sidebar', { urlPart: 'view=sidebar&window=1' })
  await ui2.ev("window.nemo.updateSettings({ agentEnabled: false }).then(() => 'ok')")
  await sleep(500)
  const afterOff = await bridge.call('tabs_context')
  const agentAfterOff = (await listTargets(app.cdp)).some((t) => t.url.includes('agent=1'))
  check(
    '設定 OFF で接続が切れ、エージェント窓が閉じ、socket が消える',
    afterOff.isError && !agentAfterOff && !fs.existsSync(socketPath),
    afterOff.text.slice(0, 100)
  )
  await ui2.ev("window.nemo.updateSettings({ agentEnabled: true }).then(() => 'ok')")

  /* ---- 7. ログ ---- */
  const lines = readLogLines(userData)
  const leaked = lines.filter(
    (line) =>
      line.includes(SECRET) ||
      line.includes('こんにちは') ||
      line.includes('/page') ||
      line.includes(KYPR_PW) ||
      line.includes(PASSPORT) ||
      line.includes('山田')
  )
  check(
    '診断ログにページ由来の値（入力・URL のパス）が出ない',
    leaked.length === 0,
    leaked.slice(0, 2).join(' / ')
  )
  const toolLines = lines.filter((line) => line.includes('"event":"agent.tool"')).length
  check('ツール呼び出しはログに 1 行ずつ残る', toolLines >= 30, `${toolLines} 行`)
} catch (error) {
  failures += 1
  console.error(`[verify-agent] ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await stopChildren(spawned.filter((child) => child.exitCode === null)).catch(() => {})
  server.close()
  await kyprMock?.close()
  for (const dir of tempDirs) {
    const uncaught = dir.includes('nav-data-') ? findUncaughtExceptions(dir) : []
    if (uncaught.length > 0) {
      failures += 1
      console.log(`FAIL  main プロセスの例外がログに無い — ${uncaught.join(' / ')}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\nverify-agent: ${passes} 件 PASS / ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)

/** JPEG の SOF マーカーから幅と高さを読む（読めなければ null）。 */
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    const length = bytes.readUInt16BE(i + 2)
    // SOF0〜SOF15（DHT 0xC4・JPG 0xC8・DAC 0xCC を除く）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return null
}
