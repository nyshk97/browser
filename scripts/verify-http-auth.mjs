#!/usr/bin/env node
/**
 * HTTP Basic 認証の自動入力の自走検証。
 *
 * 前提（`verify-all.mjs` が用意する）:
 * - Nemo が `NEMO_REMOTE_DEBUGGING_PORT` 付き・使い捨ての `NEMO_USER_DATA_DIR` で起動している
 * - **`NEMO_HTTP_AUTH_TEST_CRYPTO=memory`** で起動している。
 *   実 `safeStorage` に触ると macOS が `SecurityAgent` を上げて**検証が永久に止まる**
 *   （PAT のときに実際に踏んでいる）。実際の暗号化経路は人間の動作確認に分ける。
 * - `NEMO_VERIFY_TIMINGS` で `httpAuthRevealMs` / `httpAuthWatchdogMs` を縮めてある
 *
 * クロスオリジンの検査に**2 つ目のテストサーバを自分で立てる**（別ポート＝別オリジン）。
 * `localhost` と `127.0.0.1` で分ける手は使えない（macOS の `localhost` は ::1 を先に引く）。
 *
 * 使い方:
 *   node scripts/verify-http-auth.mjs                 … 本体
 *   node scripts/verify-http-auth.mjs --restart-write … 再起動前の仕込み（暗号文を壊す / 理由を立てる）
 *   node scripts/verify-http-auth.mjs --restart-read  … 再起動後の確認
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { connect, connectTo, connectUi, listTargets, sleep } from './lib/cdp.mjs'
import {
  countLogEvents,
  getFreePort,
  isChildAlive,
  projectRoot,
  readLogLines,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { timings } from './lib/timings.mjs'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'
const USER_DATA = process.env.NEMO_USER_DATA_DIR ?? ''
const AUTH_FILE = USER_DATA ? path.join(USER_DATA, 'http-auth.json') : ''
const FAIL_CACHE_MARKER = USER_DATA ? path.join(USER_DATA, '.nemo-fail-auth-cache-clear') : ''

let failures = 0
let skipped = 0

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 条件に到達できなかったものは**黙って PASS にしない**。 */
function skip(name, reason) {
  skipped += 1
  console.log(`SKIP  ${name} — ${reason}`)
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

async function until(fn, { timeoutMs = 8000, interval = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > deadline) return last
    await sleep(interval)
  }
}

const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 保護されたリソースの URL。`tag` は `<グループ>/<名前>` の形にする。 */
const authUrl = (tag, { user = 'u', pass = 'p', realm = 'Nemo Test', base = PAGES, delay = 0 } = {}) =>
  `${base}/__nemo_basic_auth__/${tag}?user=${user}&pass=${pass}&realm=${encodeURIComponent(realm)}` +
  (delay > 0 ? `&delay=${delay}` : '')

/**
 * そのタグに当たるパターン。
 *
 * **パスに tag を持たせている**のは、Chromium の `HttpAuthCache` が Basic を
 * *ディレクトリ単位*で先読み送信するため。グループごとにディレクトリを分けないと、
 * 一度通した資格情報が次の検査のリクエストに勝手に付いて「401 が来ない」になる。
 */
const patternFor = (tag, base = PAGES) => `^${esc(`${base}/__nemo_basic_auth__/${tag}`)}`

/**
 * 構文検査を**通る**のに照合が終わらないパターン。
 * `validateHttpAuthPattern` は入れ子の量化子を弾くが、
 * **連続する量化子**（`[a-z]+[a-z]+…`）は通る。だからワーカー隔離が要る。
 */
const adversarial = (group) => `^${esc(`${PAGES}/__nemo_basic_auth__/${group}/`)}${'[a-z]+'.repeat(12)}x`

/** Settings のインポート検証に使うダミー（**実データは絶対に置かない**）。 */
const DUMMY_MULTIPASS = JSON.stringify({
  h1: { url: 'imported.example.com', username: 'mp-user', password: 'mp-pass', priority: 1 },
  h2: { url: 'https://raw.example.com/admin', username: 'raw-user', password: 'raw-pass', priority: 5 },
  h3: { url: '(a+)+$', username: 'bad', password: 'bad', priority: 1 },
  h4: { url: 'nouser.example.com', password: 'x', priority: 1 }
})

/** 保護されたサブリソースを並列に踏むページ。 */
const authPage = (
  tags,
  { user = 'u', pass = 'p', realm = 'Nemo Test', base = PAGES, origin = '', delay = 0 } = {}
) =>
  `${base}/__nemo_auth_page__?tags=${tags.join(',')}&user=${user}&pass=${pass}` +
  `&realm=${encodeURIComponent(realm)}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}` +
  (delay > 0 ? `&delay=${delay}` : '')

/*
 * **`--restart-plant` は CDP に繋ぐ前に処理する。**
 * この仕込みはアプリを止めてから走る（起動中に書くと終了時の close が上書きする）ので、
 * 先に `connectUi` を呼ぶと ECONNREFUSED で落ちる。
 */
if (process.argv[2] === '--restart-plant') {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
  const target = raw.data.rules.find((rule) => rule.username === 'broken')
  const prefix = 'NEMOTEST1:'
  if (!target || !target.password.startsWith(prefix)) {
    console.log(
      `FAIL  再起動前の仕込み: 壊す対象が居る — ${JSON.stringify(raw.data.rules.map((r) => r.username))}`
    )
    process.exit(1)
  }
  // **checksum の 1 バイトを反転する。** テスト backend は固定ヘッダ + checksum なので、
  // これで必ず復号エラーになる（base64 の末尾をいじるだけだと、
  // パディングで捨てられるビットに当たって**改変が効かないことがある**）。
  const decoded = Buffer.from(target.password.slice(prefix.length), 'base64')
  decoded[0] ^= 0xff
  const tampered = prefix + decoded.toString('base64')
  if (tampered === target.password) {
    console.log('FAIL  再起動前の仕込み: 暗号文が変わっていない')
    process.exit(1)
  }
  target.password = tampered
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(raw, null, 2)}\n`)
  console.log('restart-plant: 1 件の暗号文を壊した')
  process.exit(0)
}

const ui = await connectUi(CDP)
const overlay = await connectUi(CDP, 'overlay')

const call = (expression) => ui.ev(`window.nemo.${expression}`)
const json = async (expression) =>
  JSON.parse(await ui.ev(`window.nemo.${expression}.then(v => JSON.stringify(v))`))

const listRules = () => json('listHttpAuthRules()')
const saveRule = (input) => json(`saveHttpAuthRule(${JSON.stringify(input)})`)
const deleteRule = (id) => json(`deleteHttpAuthRule(${JSON.stringify(id)})`)
const testPattern = (urls, draft = null) =>
  json(`testHttpAuthPattern(${JSON.stringify(urls)}, ${JSON.stringify(draft)})`)

/** 全ルールを消す（消すたびに `clearAuthCache()` も走る）。 */
async function clearRules() {
  const { rules } = await listRules()
  for (const rule of rules) await deleteRule(rule.id)
}

const openTab = (url) => ui.ev(`window.nemo.createTab(${JSON.stringify(url)}).then(k => k)`)
const closeTab = (key) => ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
/**
 * タブを遷移させる。**失敗も正常な結果として受ける** ——
 * 「クロスオリジンへの遷移が失敗した直後」の検査では `loadURL` が
 * `ERR_EMPTY_RESPONSE` で reject し、そのまま投げると検証が落ちる。
 */
const navigate = (key, url) =>
  ui.ev(
    `window.nemo.navigate(${JSON.stringify(key)}, ${JSON.stringify(url)}).then(() => 'ok', (e) => 'failed: ' + e.message)`
  )

/* ---- サーバ側で受けた Authorization ---- */

const authEntries = async (base = PAGES) => (await (await fetch(`${base}/__nemo_auth_log__`)).json()).entries
const resetAuthLog = async (base = PAGES) => {
  await fetch(`${base}/__nemo_auth_reset__`)
}
/** 実際に資格情報が送られた回数（`Authorization` が載っていたリクエスト）。 */
const sentCount = (entries) => entries.filter((entry) => entry.authorization.length > 0).length
const decodeAuth = (value) => Buffer.from(value.replace(/^Basic /, ''), 'base64').toString('utf8')

/* ---- ダイアログ ---- */

const DIALOG_KIND = `(() => { const d = document.querySelector('[data-testid]'); return d ? d.getAttribute('data-testid') : '' })()`

const dialogKind = () => overlay.ev(DIALOG_KIND)
const waitDialog = (kind = 'prompt-auth', timeoutMs = 8000) =>
  until(async () => (await dialogKind()) === kind, { timeoutMs })

/** 一定時間ダイアログが出ないこと。 */
async function stayQuiet(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await dialogKind()) !== '') return false
    await sleep(150)
  }
  return true
}

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'missing'
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`

const AUTH_USER = '[data-testid="prompt-auth"] input[autocomplete="username"]'
const AUTH_PASS = '[data-testid="prompt-auth"] input[autocomplete="current-password"]'
const AUTH_SAVE = '[data-testid="prompt-auth-save"]'

async function answerAuth(username, password, { save = false } = {}) {
  await overlay.ev(setInput(AUTH_USER, username))
  await overlay.ev(setInput(AUTH_PASS, password))
  if (save) {
    await overlay.ev(
      `(() => { const c = document.querySelector('${AUTH_SAVE}'); if (!c) return 'missing'; if (!c.checked) c.click(); return 'ok' })()`
    )
  }
  await overlay.ev(
    `(() => { document.querySelector('[data-testid="prompt-auth"] button.primary').click(); return 'ok' })()`
  )
}

async function cancelAuth() {
  await overlay.ev(
    `(() => { const b = [...document.querySelectorAll('[data-testid="prompt-auth"] .dialog-actions button')].find(x => x.textContent === 'キャンセル'); if (!b) return 'missing'; b.click(); return 'ok' })()`
  )
}

/**
 * 残っている認証ダイアログを全部キャンセルする。
 *
 * 1 つの検査で複数のダイアログが出るのは**正しい挙動**（別のルール・別の URL には
 * 別々に聞く）。片付けずに次の検査へ進むと、次の `waitDialog()` が
 * **前のダイアログを見て即座に PASS する**（実際にこれで 4 件が偽 PASS / 偽 FAIL になった）。
 */
async function drainDialogs() {
  for (let i = 0; i < 12; i += 1) {
    const kind = await dialogKind()
    if (kind === '') return true
    if (kind === 'prompt-notice') await closeNotice()
    else await cancelAuth()
    await sleep(250)
  }
  return (await dialogKind()) === ''
}

async function closeNotice() {
  await overlay.ev(
    `(() => { const b = document.querySelector('[data-testid="prompt-notice"] button'); if (!b) return 'missing'; b.click(); return 'ok' })()`
  )
}

/** 「自動入力しなかった理由」が診断ログに出ているか。 */
const loggedReasons = () =>
  readLogLines(USER_DATA)
    .filter((line) => line.includes('"event":"auth.not_autofilled"'))
    .map((line) => JSON.parse(line).reason)

/** 出た認証ダイアログの数（診断ログの `prompt.opened` から数える）。 */
const authDialogCount = () =>
  readLogLines(USER_DATA).filter(
    (line) => line.includes('"event":"prompt.opened"') && line.includes('"auth"')
  ).length

/* ------------------------------------------------------------------ *
 * 2 つ目のテストサーバ（別オリジン）
 * ------------------------------------------------------------------ */

const spawned = []
let OTHER = ''

async function startOtherServer() {
  const port = String(await getFreePort())
  const child = spawn(process.execPath, ['scripts/test-server.mjs'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: { ...process.env, PORT: port }
  })
  spawned.push(child)
  const base = `http://127.0.0.1:${port}`
  await waitForHttp(`${base}/__nemo_test_pages__`, {
    child,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${child.pid}`)
  })
  return base
}

async function cleanup() {
  await stopChildren(spawned.filter(isChildAlive))
}

/* ------------------------------------------------------------------ *
 * 再起動をまたぐ検査（自動無効化の理由 / 復号失敗）
 * ------------------------------------------------------------------ */

const mode = process.argv[2]

if (mode === '--restart-write') {
  await clearRules()
  const good = await saveRule({ pattern: patternFor('rw/alive'), username: 'alive', password: 'p' })
  const broken = await saveRule({ pattern: patternFor('rw/broken'), username: 'broken', password: 'p' })
  check('再起動前: 2 件保存できた', good.saved && broken.saved, JSON.stringify({ good, broken }))
  // **壊す前に 2 件とも読めていたことを示す**（最初から 0 件だと空振りで PASS する）
  const before = await Promise.all([
    ui.ev(`window.nemo.revealHttpAuthPassword(${JSON.stringify(good.id ?? '')}).then(v => v ?? '')`),
    ui.ev(`window.nemo.revealHttpAuthPassword(${JSON.stringify(broken.id ?? '')}).then(v => v ?? '')`)
  ])
  const ids = (await listRules()).rules.map((rule) => rule.id)
  check(
    '再起動前: 2 件とも復号できていた',
    before.every((value) => value === 'p'),
    JSON.stringify(before)
  )
  console.log(`restart-write: rules=${JSON.stringify(ids)}`)
  process.exit(failures === 0 ? 0 : 1)
}

if (mode === '--restart-read') {
  // 仕込みは **アプリを止めてから** `--restart-plant` が行う（下）
  const { rules } = await listRules()
  const broken = rules.find((rule) => rule.username === 'broken')
  const alive = rules.find((rule) => rule.username === 'alive')
  check(
    '壊した 1 件だけが無効化され、理由が再起動後も残る',
    broken?.disabledReason === 'decrypt-failed',
    JSON.stringify(broken ?? null)
  )
  check('もう 1 件は生きている', alive !== undefined && !alive.disabledReason, JSON.stringify(alive ?? null))

  if (broken) {
    const refused = await saveRule({ id: broken.id, username: broken.username, enabled: true })
    check('理由がある間は有効トグルが効かない', refused.saved === false, JSON.stringify(refused))
    const fixed = await saveRule({
      id: broken.id,
      pattern: broken.pattern,
      username: broken.username,
      password: 'fixed'
    })
    const after = (await listRules()).rules.find((rule) => rule.id === broken.id)
    check(
      'パスワードを保存し直すと decrypt-failed が消える',
      fixed.saved && after?.disabledReason === undefined,
      JSON.stringify(after ?? null)
    )
  } else {
    skip('理由がある間は有効トグルが効かない', '壊したルールが見つからない')
    skip('パスワードを保存し直すと decrypt-failed が消える', '壊したルールが見つからない')
  }
  process.exit(failures === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

OTHER = await startOtherServer()

try {
  await runAll()
} finally {
  await cleanup()
}

console.log(
  failures === 0 ? `\n全項目 PASS${skipped > 0 ? `（SKIP ${skipped} 件）` : ''}` : `\n${failures} 件 FAIL`
)
process.exit(failures === 0 ? 0 : 1)

async function runAll() {
  await clearRules()
  await resetAuthLog()
  await resetAuthLog(OTHER)
  // 各検査の**前後**でダイアログを片付ける（前の検査の残りを見て偽 PASS しないように）

  const steps = [
    checkNoRule,
    checkAutofill,
    checkWrongPassword,
    checkSerializedSubresources,
    checkPrefillAndSelfHeal,
    checkNoResendAfterDialogSave,
    checkDialogRemount,
    checkParallelDistinctUrls,
    checkDifferentRulesSameSpace,
    checkCrossOrigin,
    checkRedirect,
    checkFailedNavigationClearsPending,
    checkUrlTooLong,
    checkPrivateWindow,
    checkAdversarialPattern,
    checkTesterDoesNotDisable,
    checkClosedTabNoLateDialog,
    checkCredentialChangeClearsCache,
    checkConcurrentSaves,
    checkCacheClearFailure,
    checkWriteFailure,
    checkSettingsUi,
    checkUnavailableBackend
  ]
  for (const step of steps) {
    await drainDialogs()
    await step()
    await drainDialogs()
  }
  await checkNoUncaught()
}

/* ---- ① ルール無し → ダイアログ ---- */
async function checkNoRule() {
  const key = await openTab(authUrl('g1/main', { realm: 'r1' }))
  const shown = await waitDialog()
  check('ルール無し → 認証ダイアログが出る', shown === true, await dialogKind())
  await cancelAuth()
  await closeTab(key)
}

/* ---- ② ルール有り → ダイアログ無しで 200 ---- */
async function checkAutofill() {
  const saved = await saveRule({ pattern: patternFor('g2/'), username: 'u', password: 'p' })
  check('ルールを保存できる', saved.saved === true, JSON.stringify(saved))
  const url = authUrl('g2/main', { realm: 'r2' })
  const key = await openTab(url)
  const page = await connectTo(CDP, '/__nemo_basic_auth__/g2/main')
  const body = await until(async () => {
    const text = await page.ev('document.body.innerText')
    return text && text.includes('ok') ? text : ''
  })
  check('ルール有り → ダイアログ無しで 200 が描画される', body.includes('nemo-basic-auth ok g2/main'), body)
  check('自動入力が効いたときはダイアログが出ない', (await dialogKind()) === '')
  page.close()
  await closeTab(key)
}

/* ---- ③ 間違ったパスワード → 2 回目でダイアログ ---- */
async function checkWrongPassword() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g3/'), username: 'u', password: 'wrong' })
  const key = await openTab(authUrl('g3/main', { realm: 'r3' }))
  const shown = await waitDialog()
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g3/'))
  check(
    '間違ったパスワードのルール → 2 回目でダイアログに落ちる',
    shown === true,
    `試行 ${entries.length} 回 / 資格情報の送信 ${sentCount(entries)} 回`
  )
  check(
    '同じ誤パスワードを 2 回以上送らない',
    sentCount(entries) === 1,
    `送信 ${sentCount(entries)} 回（受けた総リクエスト ${entries.length} 件）`
  )
  await cancelAuth()

  // 拒否されたあとリロードしても再送されない（`denied` を did-start-navigation で消していないこと）
  await resetAuthLog()
  await ui.ev(`window.nemo.reload(${JSON.stringify(key)}).then(() => 'ok')`)
  await waitDialog()
  const afterReload = (await authEntries()).filter((entry) => entry.tag.startsWith('g3/'))
  check(
    '拒否されたあとリロードしても誤パスワードを再送しない',
    sentCount(afterReload) === 0,
    `送信 ${sentCount(afterReload)} 回 / リクエスト ${afterReload.length} 件`
  )
  await cancelAuth()
  await closeTab(key)
}

/* ---- ④ 保護サブリソース複数 → 送信 1 回・ダイアログ 1 つ ---- */
async function checkSerializedSubresources() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g4/'), username: 'u', password: 'wrong' })
  const before = authDialogCount()
  const tags = ['g4/a', 'g4/b', 'g4/c']
  const key = await openTab(authPage(tags, { realm: 'r4' }))
  const shown = await waitDialog()
  await sleep(600)
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g4/'))
  const touched = new Set(entries.map((entry) => entry.tag)).size
  check(
    '保護されたサブリソースが 2 件以上ある状態を作れている',
    touched >= 2,
    `踏んだサブリソース ${touched} 件 / 用意 ${tags.length} 件`
  )
  check(
    '誤パスワードでも資格情報の送信は 1 回だけ（protection space 単位の直列化）',
    sentCount(entries) === 1,
    `送信 ${sentCount(entries)} 回 / リクエスト ${entries.length} 件`
  )
  const dialogs = authDialogCount() - before
  check(
    '拒否されたとき認証ダイアログは 1 つだけ出る（グループ集約）',
    shown === true && dialogs === 1,
    `ダイアログ ${dialogs} 件`
  )
  await cancelAuth()
  await sleep(300)
  await closeTab(key)
}

/* ---- ⑤ prefill と自己修復 ---- */
async function checkPrefillAndSelfHeal() {
  await clearRules()
  await resetAuthLog()
  // **ワイルドカードのルール**にする（新規作成に倒れると元ルールが残って自己修復が壊れる）
  await saveRule({ pattern: patternFor('g5/'), username: 'saved-user', password: 'wrong' })
  const key = await openTab(authUrl('g5/main', { realm: 'r5' }))
  await waitDialog()
  const prefilled = JSON.parse(
    await overlay.ev(
      `JSON.stringify({ u: document.querySelector('${AUTH_USER}').value, p: document.querySelector('${AUTH_PASS}').value, save: document.querySelector('${AUTH_SAVE}')?.checked ?? null, rejected: Boolean(document.querySelector('[data-testid="prompt-auth-rejected"]')) })`
    )
  )
  check(
    '拒否されたら保存値で prefill され、拒否された旨が出る',
    prefilled.u === 'saved-user' && prefilled.p === 'wrong' && prefilled.rejected === true,
    JSON.stringify(prefilled)
  )
  check('保存チェックは既定 OFF', prefilled.save === false, JSON.stringify(prefilled.save))

  await answerAuth('u', 'p', { save: true })
  await sleep(500)
  const { rules } = await listRules()
  check(
    '直して再保存すると元ルールが上書きされる（新規に増えない）',
    rules.length === 1 && rules[0].pattern === patternFor('g5/') && rules[0].username === 'u',
    JSON.stringify(rules)
  )

  // 次回から通ること
  await resetAuthLog()
  await navigate(key, authUrl('g5/second', { realm: 'r5' }))
  const page = await connectTo(CDP, '/__nemo_basic_auth__/g5/second')
  const body = await until(async () => {
    const text = await page.ev('document.body.innerText')
    return text && text.includes('ok') ? text : ''
  })
  check('直したあとは次回から自動で通る', body.includes('nemo-basic-auth ok g5/second'), body)
  page.close()
  await closeTab(key)
}

/* ---- ⑤b 打ち直しも間違えていたとき、同じ値を 2 回送らない ---- */

/**
 * ダイアログで保存すると `httpAuthCredentialsChanged()` が `attempts` / `denied` を全消しする。
 * その直後に資格情報を配るので、**打ち直したパスワードも間違っていた場合、
 * 同じ値が「手入力の 1 回」と「直後の自動入力の 1 回」で 2 回飛ぶ**。
 * plan #11（アカウントロック回避）に反するので、配った URL の試行回数だけ戻して抑止する。
 */
async function checkNoResendAfterDialogSave() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g22/'), username: 'u', password: 'wrong1' })
  const key = await openTab(authUrl('g22/main', { realm: 'r22' }))
  await waitDialog()

  // 打ち直しも間違える（保存チェックあり）
  await answerAuth('u', 'wrong2', { save: true })
  // 答えたダイアログが閉じ、拒否の 2 回目でまた出るまで待つ
  await until(async () => (await dialogKind()) === '', { timeoutMs: 6000 })
  await waitDialog()
  await sleep(600)

  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g22/'))
  const sent = entries
    .filter((entry) => entry.authorization.length > 0)
    .map((entry) => decodeAuth(entry.authorization))
  const resent = sent.filter((value) => value === 'u:wrong2')
  check(
    '打ち直しも間違えていたとき、手入力した資格情報は 1 回しか送らない',
    resent.length === 1,
    `送信 ${JSON.stringify(sent)}`
  )
  await closeTab(key)
}

/* ---- ⑥ 別ホストの連続ダイアログで入力値が残らない ---- */
async function checkDialogRemount() {
  await clearRules()
  const keyA = await openTab(authUrl('g6/a', { realm: 'r6' }))
  await waitDialog()
  await overlay.ev(setInput(AUTH_USER, 'leaked-user'))
  await overlay.ev(setInput(AUTH_PASS, 'leaked-pass'))
  await overlay.ev(
    `(() => { const c = document.querySelector('${AUTH_SAVE}'); if (c && !c.checked) c.click(); return 'ok' })()`
  )
  await cancelAuth()
  await sleep(300)

  const keyB = await openTab(authUrl('g6/b', { realm: 'r6-other', base: OTHER }))
  await waitDialog()
  const second = JSON.parse(
    await overlay.ev(
      `JSON.stringify({ u: document.querySelector('${AUTH_USER}').value, p: document.querySelector('${AUTH_PASS}').value, save: document.querySelector('${AUTH_SAVE}')?.checked ?? null })`
    )
  )
  check(
    '別ホストのダイアログに前の入力値と保存チェックが残らない',
    second.u === '' && second.p === '' && second.save === false,
    JSON.stringify(second)
  )
  await cancelAuth()
  await closeTab(keyA)
  await closeTab(keyB)
}

/* ---- ⑦ 同一オリジンの並列 401（URL は互いに異なる）→ 全部自動入力 ---- */
async function checkParallelDistinctUrls() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g7/'), username: 'u', password: 'p' })
  const key = await openTab(authPage(['g7/a', 'g7/b', 'g7/c'], { realm: 'r7' }))
  const page = await connectTo(CDP, '__nemo_auth_page__')
  const result = await until(async () => {
    const text = await page.ev(`document.getElementById('result')?.textContent ?? ''`)
    return text && text !== 'pending' ? text : ''
  })
  check('同一オリジンの並列 401 がすべて自動入力される', result === '200,200,200', result)
  check('自動入力が全部効いたときはダイアログが出ない', (await dialogKind()) === '')
  page.close()
  await closeTab(key)
}

/* ---- ⑧ 同じ origin/realm で勝つルールが違う URL の並列 ---- */
async function checkDifferentRulesSameSpace() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g8/a'), username: 'user-a', password: 'wrong-a' })
  await saveRule({ pattern: patternFor('g8/b'), username: 'user-b', password: 'wrong-b' })
  const before = authDialogCount()
  const key = await openTab(authPage(['g8/a', 'g8/b'], { realm: 'r8' }))
  await waitDialog()
  await sleep(500)
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g8/'))
  const sent = entries.filter((entry) => entry.authorization.length > 0)
  check(
    '勝つルールが違う URL を並列に踏んでも資格情報の送信は 1 回だけ',
    sent.length === 1,
    `送信 ${sent.length} 回 / リクエスト ${entries.length} 件`
  )
  const misdirected = sent.filter(
    (entry) => !decodeAuth(entry.authorization).startsWith(`user-${entry.tag.at(-1)}`)
  )
  check(
    'ルール A の資格情報が URL B へ送られていない',
    misdirected.length === 0,
    JSON.stringify(sent.map((entry) => [entry.tag, decodeAuth(entry.authorization)]))
  )

  // 手入力が別グループへ配られないこと
  await answerAuth('typed-user', 'typed-pass')
  await waitDialog()
  const secondShown = (await dialogKind()) === 'prompt-auth'
  await cancelAuth()
  await sleep(400)
  const after = (await authEntries()).filter((entry) => entry.tag.startsWith('g8/'))
  const typed = after.filter(
    (entry) => entry.authorization && decodeAuth(entry.authorization).startsWith('typed-user')
  )
  const typedTags = new Set(typed.map((entry) => entry.tag))
  check(
    '手入力した資格情報は答えたグループの URL にしか配られない',
    typedTags.size <= 1,
    `届いた先 ${JSON.stringify([...typedTags])}`
  )
  check(
    '別ルールのグループには独立したダイアログが出る',
    secondShown,
    `ダイアログ ${authDialogCount() - before} 件`
  )
  await closeTab(key)
}

/* ---- ⑨ クロスオリジンのサブリソース ---- */
async function checkCrossOrigin() {
  await clearRules()
  await resetAuthLog(OTHER)
  await saveRule({ pattern: patternFor('g9/', OTHER), username: 'u', password: 'p' })
  const key = await openTab(authPage(['g9/x'], { realm: 'r9', origin: OTHER }))
  await sleep(1500)
  const entries = (await authEntries(OTHER)).filter((entry) => entry.tag.startsWith('g9/'))
  check(
    'クロスオリジンのサブリソース 401 では資格情報を送らない',
    entries.length > 0 && sentCount(entries) === 0,
    `到達 ${entries.length} 件 / 送信 ${sentCount(entries)} 回 / ダイアログ "${await dialogKind()}"`
  )
  await closeTab(key)
}

/* ---- ⑩ サーバ側 302 で別オリジンへ ---- */
async function checkRedirect() {
  await clearRules()
  await resetAuthLog(OTHER)
  await saveRule({ pattern: patternFor('g10/', OTHER), username: 'u', password: 'p' })
  const target = authUrl('g10/main', { realm: 'r10', base: OTHER })
  const key = await openTab(`${PAGES}/__nemo_redirect__?to=${encodeURIComponent(target)}`)
  const page = await connectTo(CDP, '/__nemo_basic_auth__/g10/main')
  const body = await until(async () => {
    const text = await page.ev('document.body.innerText')
    return text && text.includes('ok') ? text : ''
  })
  check(
    'サーバ側 302 で別オリジンへ飛んだ先の 401 がダイアログなしで通る',
    body.includes('nemo-basic-auth ok g10/main'),
    body || (await dialogKind())
  )
  page.close()
  await closeTab(key)
}

/* ---- ⑪ 遷移失敗のあと pending が残らない ---- */

/**
 * **判定は「同一オリジンの自動入力が生き残るか」で行う。**
 *
 * 元々の狙いは「遷移先のルールが元ページのサブリソースに使われない」だったが、
 * Chromium は**クロスオリジンのサブリソースには認証チャレンジを出さない**ので
 * （`login` イベントが飛ばない）、その向きでは実装の差が出ない＝検査にならない。
 *
 * `pendingNavigation` を消し忘れる実装は、**逆向きで必ず壊れる**:
 * 失敗した遷移先（別オリジン）の URL が残ったままだと、元ページの同一オリジンの
 * サブリソースが「クロスオリジン」と判定され、正しい自動入力がダイアログに退行する。
 * こちらは実際に踏める経路なので、こちらで見る。
 */
async function checkFailedNavigationClearsPending() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g11/'), username: 'u', password: 'p' })
  const key = await openTab(authPage([], { realm: 'r11' }))
  const page = await connectTo(CDP, '__nemo_auth_page__')
  await until(async () => (await page.ev(`document.readyState === 'complete' ? 'ok' : ''`)) === 'ok')

  // クロスオリジンへの遷移を**失敗させる**（接続ごと落とす）
  // **204 で中断させる**（接続断だとエラーページに置き換わり、元のページに留まれない）
  const failed = await navigate(key, `${OTHER}/__nemo_no_content__`)
  check('クロスオリジンへの遷移が実際に中断している', String(failed).startsWith('failed:'), String(failed))
  await sleep(800)

  // 元ページに留まったまま、**同一オリジンの**サブリソースを撃つ
  const status = await page.ev(
    `fetch(${JSON.stringify(authUrl('g11/x', { realm: 'r11' }))}).then(r => String(r.status)).catch(() => 'error')`
  )
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g11/'))
  check(
    '遷移が失敗しても、元ページの同一オリジンの自動入力は生き残る（pending を消している）',
    status === '200' && sentCount(entries) === 1,
    `status=${status} / 送信 ${sentCount(entries)} 回 / ダイアログ "${await dialogKind()}"`
  )
  page.close()
  await closeTab(key)
}

/* ---- ⑫ URL が長すぎる ---- */
async function checkUrlTooLong() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g12/'), username: 'u', password: 'p' })
  const padding = 'a'.repeat(2200)
  const key = await openTab(`${authUrl('g12/main', { realm: 'r12' })}&pad=${padding}`)
  const shown = await waitDialog()
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g12/'))
  const hasSave = await overlay.ev(`document.querySelector('${AUTH_SAVE}') ? 'yes' : 'no'`)
  check(
    'URL の上限を超えるリクエストでは自動入力しない',
    shown === true && sentCount(entries) === 0,
    `送信 ${sentCount(entries)} 回`
  )
  check('URL の上限を超えるときは保存チェックも出さない', hasSave === 'no', hasSave)
  // **理由が診断ログに残る**（残さないと「なぜ自動入力されないのか」を切り分けられない）
  const reasons = loggedReasons()
  check(
    '自動入力しなかった理由が診断ログに残る',
    reasons.includes('url-too-long'),
    JSON.stringify([...new Set(reasons)])
  )

  /*
   * **チェックボックスを隠すだけの実装ならここで FAIL する。**
   * renderer を経由せず `resolvePrompt` の IPC に直接 `save: true` を投げる。
   */
  const promptId = await ui.ev(`window.nemo.getOverlayState().then(s => s.prompt?.id ?? '')`)
  const before = (await listRules()).rules.length
  await overlay.ev(
    `window.nemo.resolvePrompt(${JSON.stringify(promptId)}, { kind: 'auth', username: 'x', password: 'y', save: true }).then(() => 'ok')`
  )
  await sleep(500)
  const after = (await listRules()).rules.length
  check(
    'canSave: false の状況で save: true を送ってもルールは作られない',
    after === before,
    `${before} → ${after}`
  )
  await closeTab(key)
}

/* ---- ⑬ シークレットウィンドウ ---- */
async function checkPrivateWindow() {
  await clearRules()
  await resetAuthLog()
  await saveRule({ pattern: patternFor('g13/'), username: 'u', password: 'p' })
  await call(`createPrivateWindow().then(() => 'ok')`)
  const target = await until(
    async () =>
      (await listTargets(CDP)).find((t) => t.url.includes('private=1') && t.url.includes('view=sidebar')) ??
      null
  )
  if (!target) {
    skip('シークレットでは自動入力しない', 'シークレットウィンドウの UI が見つからない')
    return
  }
  const privateUi = await connect(target.webSocketDebuggerUrl)
  await until(async () => (await privateUi.ev(`typeof window.nemo === 'object' ? 'ok' : ''`)) === 'ok')
  const privateOverlay = await connect(
    (await listTargets(CDP)).find((t) => t.url.includes('private=1') && t.url.includes('view=overlay'))
      ?.webSocketDebuggerUrl ?? target.webSocketDebuggerUrl
  )
  await privateUi.ev(
    `window.nemo.createTab(${JSON.stringify(authUrl('g13/main', { realm: 'r13' }))}).then(() => 'ok')`
  )
  const shown = await until(async () => (await privateOverlay.ev(DIALOG_KIND)) === 'prompt-auth', {
    timeoutMs: 8000
  })
  const entries = (await authEntries()).filter((entry) => entry.tag.startsWith('g13/'))
  check(
    'シークレットウィンドウでは自動入力しない',
    shown === true && sentCount(entries) === 0,
    `送信 ${sentCount(entries)} 回 / ダイアログ ${await privateOverlay.ev(DIALOG_KIND)}`
  )
  const hasSave = await privateOverlay.ev(`document.querySelector('${AUTH_SAVE}') ? 'yes' : 'no'`)
  check('シークレットでは保存チェックも出さない', hasSave === 'no', hasSave)
  // シークレットと「タブでない」は挙動が同じでも**理由を畳まない**
  const reasons = loggedReasons()
  check(
    'シークレットの理由が private として残る（not-a-tab と畳まれていない）',
    reasons.includes('private'),
    JSON.stringify([...new Set(reasons)])
  )
  await privateOverlay.ev(
    `(() => { const b = [...document.querySelectorAll('[data-testid="prompt-auth"] .dialog-actions button')].find(x => x.textContent === 'キャンセル'); if (b) b.click(); return 'ok' })()`
  )
  privateUi.close()
  privateOverlay.close()
}

/* ---- ⑭ 敵対的な正規表現 ---- */

async function checkAdversarialPattern() {
  await clearRules()
  await resetAuthLog()
  const normal = await saveRule({ pattern: patternFor('g14/'), username: 'u', password: 'p' })
  const evil = await saveRule({ pattern: adversarial('g14'), username: 'evil', password: 'p' })
  check(
    '敵対的なパターンは構文検査を通ってしまう（ワーカー隔離が要る理由）',
    evil.saved === true,
    JSON.stringify(evil)
  )

  const started = Date.now()
  const key = await openTab(authUrl(`g14/${'a'.repeat(40)}`, { realm: 'r14' }))
  // **main が固まっていないこと**を、UI からの IPC が返るかで見る
  const responded = await until(
    async () => ((await ui.ev(`window.nemo.getWindowState().then(() => 'ok')`)) === 'ok' ? 'ok' : ''),
    { timeoutMs: 5000 }
  )
  check('敵対的なパターンを踏んでも UI が固まらない', responded === 'ok', `${Date.now() - started}ms`)

  const disabled = await until(async () => {
    const { rules } = await listRules()
    const target = rules.find((rule) => rule.id === evil.id)
    return target?.disabledReason === 'pattern-timeout' ? target : null
  })
  check(
    'タイムアウトしたルールだけが自動で無効化され、理由が残る',
    disabled?.disabledReason === 'pattern-timeout',
    JSON.stringify(disabled ?? null)
  )
  const survivor = (await listRules()).rules.find((rule) => rule.id === normal.id)
  check(
    '正常なルールは巻き添えで無効化されない',
    survivor !== undefined && !survivor.disabledReason,
    JSON.stringify(survivor ?? null)
  )

  // ワーカーが落ちたあとも pending が残らない（認証とテスターを同時に走らせる）
  const [tested, authed] = await Promise.all([
    testPattern([authUrl('g14/after', { realm: 'r14b' })]),
    (async () => {
      const tab = await openTab(authUrl('g14/after', { realm: 'r14b' }))
      const page = await connectTo(CDP, '/__nemo_basic_auth__/g14/after')
      const body = await until(async () => {
        const text = await page.ev('document.body.innerText')
        return text && text.includes('ok') ? text : ''
      })
      page.close()
      await closeTab(tab)
      return body
    })()
  ])
  check(
    'ワーカーが落ちても pending が残らない（認証とテスターが両方応答する）',
    Array.isArray(tested) && tested.length === 1 && authed.includes('ok'),
    `tester=${JSON.stringify(tested)} auth=${authed}`
  )
  await closeTab(key)
}

/* ---- ⑮ テスターは保存済みルールを無効化しない ---- */
async function checkTesterDoesNotDisable() {
  await clearRules()
  const normal = await saveRule({ pattern: patternFor('g15/'), username: 'u', password: 'p' })
  const results = await testPattern([authUrl(`g15/${'a'.repeat(40)}`, { realm: 'r15' })], adversarial('g15'))
  const timedOut = results[0]?.timedOutIds ?? []
  check(
    'テスターでは下書きの照合がタイムアウトとして返る',
    timedOut.includes('draft'),
    JSON.stringify(results)
  )
  const after = (await listRules()).rules.find((rule) => rule.id === normal.id)
  check(
    'テスターのタイムアウトでは保存済みルールを無効化しない',
    after !== undefined && !after.disabledReason,
    JSON.stringify(after ?? null)
  )
}

/* ---- ⑮b ダイアログ待ちのままタブを閉じる ---- */
async function checkClosedTabNoLateDialog() {
  await clearRules()
  await resetAuthLog()
  // 正しいパスワードだが、**資格情報つきのリクエストへの応答が返って来ない**状態を作る。
  // watchdog が満了するとキュー待ちの要求がダイアログへ倒れる —— その前にタブを閉じる。
  await saveRule({ pattern: patternFor('g21/'), username: 'u', password: 'p' })
  const key = await openTab(authPage(['g21/a', 'g21/b'], { realm: 'r21', delay: 60_000 }))
  await sleep(1200)
  const beforeClose = await dialogKind()
  await closeTab(key)
  const quiet = await stayQuiet(timings.httpAuthWatchdogMs + 2500)
  check(
    '認証ダイアログ待ちのままタブを閉じても、あとからダイアログが出てこない',
    quiet === true,
    `閉じる前 "${beforeClose}" / 待った ${timings.httpAuthWatchdogMs + 2500}ms`
  )
}

/* ---- ⑯ 資格情報の変更で認証キャッシュが破棄される ---- */
async function checkCredentialChangeClearsCache() {
  await clearRules()
  await resetAuthLog()
  const rule = await saveRule({ pattern: patternFor('g16/'), username: 'u', password: 'p' })
  const key = await openTab(authPage([], { realm: 'r16' }))
  const page = await connectTo(CDP, '__nemo_auth_page__')
  await until(async () => (await page.ev(`document.readyState === 'complete' ? 'ok' : ''`)) === 'ok')

  const fetchAuth = (tag, extra = {}) =>
    page.ev(
      `fetch(${JSON.stringify(authUrl(tag, { realm: 'r16', ...extra }))}).then(r => String(r.status)).catch(() => 'error')`
    )

  // **操作前に 1 回認証を通しておく**（通していないと共通処理の呼び忘れが出ない）
  check('編集前に一度認証を通せる', (await fetchAuth('g16/x')) === '200')

  // 有効トグル
  await saveRule({ id: rule.id, username: 'u', enabled: false })
  // **リロードせず同じ document から撃つ**（リロードすると attempts が消えて片方の実装でも PASS する）
  const afterDisable = fetchAuth('g16/x')
  const shownAfterDisable = await waitDialog()
  check(
    '有効トグルでも認証キャッシュが破棄され、再チャレンジが起きる',
    shownAfterDisable === true,
    await dialogKind()
  )
  await cancelAuth()
  await afterDisable

  // パスワードの編集
  await saveRule({ id: rule.id, pattern: patternFor('g16/'), username: 'u', password: 'p2', enabled: true })
  await resetAuthLog()
  const status = await fetchAuth('g16/y', { pass: 'p2' })
  check('パスワードを編集すると同じセッションで新しい資格情報が使われる', status === '200', String(status))

  // ユーザー名だけ編集してもパスワードは消えない（patch semantics）
  await saveRule({ id: rule.id, pattern: patternFor('g16/'), username: 'u2' })
  const revealed = await ui.ev(
    `window.nemo.revealHttpAuthPassword(${JSON.stringify(rule.id)}).then(v => v ?? '')`
  )
  check('ユーザー名だけ編集してもパスワードが消えない', revealed === 'p2', JSON.stringify(revealed))

  // 「パスワードを変更」で空文字にできる
  await saveRule({ id: rule.id, pattern: patternFor('g16/'), username: 'u2', password: '' })
  const emptied = await ui.ev(
    `window.nemo.revealHttpAuthPassword(${JSON.stringify(rule.id)}).then(v => v ?? '(null)')`
  )
  check('空文字は有効な新パスワードとして保存される', emptied === '', JSON.stringify(emptied))

  page.close()
  await closeTab(key)
}

/* ---- ⑰ 同時保存 ---- */
async function checkConcurrentSaves() {
  await clearRules()
  const both = JSON.parse(
    await ui.ev(`Promise.all([
      window.nemo.saveHttpAuthRule({ pattern: ${JSON.stringify(patternFor('g17/a'))}, username: 'a', password: 'p' }),
      window.nemo.saveHttpAuthRule({ pattern: ${JSON.stringify(patternFor('g17/b'))}, username: 'b', password: 'p' })
    ]).then(r => JSON.stringify(r))`)
  )
  const { rules } = await listRules()
  check(
    '複数のルールを同時に保存しても両方残る（トランザクションの直列化）',
    both.every((r) => r.saved) && rules.length === 2,
    JSON.stringify(rules.map((r) => r.username))
  )
}

/* ---- ⑱ 認証キャッシュの消去に失敗させる ---- */
async function checkCacheClearFailure() {
  if (!FAIL_CACHE_MARKER) {
    skip('キャッシュ消去に失敗しても保存は成立する', 'NEMO_USER_DATA_DIR が渡っていない')
    return
  }
  await clearRules()
  fs.writeFileSync(FAIL_CACHE_MARKER, '1')
  const result = await saveRule({ pattern: patternFor('g18/'), username: 'u', password: 'p' })
  fs.rmSync(FAIL_CACHE_MARKER, { force: true })
  const { rules } = await listRules()
  check(
    'キャッシュ消去に失敗しても保存は成立し、authCacheCleared: false が返る',
    result.saved === true && result.authCacheCleared === false && rules.length === 1,
    JSON.stringify(result)
  )
}

/* ---- ⑲ 書き込み失敗 ---- */
async function checkWriteFailure() {
  if (!AUTH_FILE) {
    skip('書き込みに失敗したら IPC がエラーを返す', 'NEMO_USER_DATA_DIR が渡っていない')
    return
  }
  await clearRules()
  await resetAuthLog()
  const before = (await listRules()).rules.length

  // **書けない状態を作る**（ファイルの位置をディレクトリにすると rename が必ず失敗する）
  fs.rmSync(AUTH_FILE, { force: true })
  fs.mkdirSync(AUTH_FILE, { recursive: true })

  const failed = await saveRule({ pattern: patternFor('g19/'), username: 'u', password: 'p' })
  check('書き込みに失敗したら保存も失敗として返る', failed.saved === false, JSON.stringify(failed))
  const during = (await listRules()).rules
  check(
    '失敗した変更は一覧に現れない（メモリに先に commit しない）',
    during.length === before,
    `${before} → ${during.length}`
  )

  // 保存に失敗してもページの認証は完了し、失敗が UI に出る
  const key = await openTab(authUrl('g19/main', { realm: 'r19' }))
  await waitDialog()
  await answerAuth('u', 'p', { save: true })
  const noticed = await waitDialog('prompt-notice', 6000)
  check('保存に失敗したら Nemo の UI で知らせる', noticed === true, await dialogKind())
  await closeNotice()
  const page = await connectTo(CDP, '/__nemo_basic_auth__/g19/main')
  const body = await until(async () => {
    const text = await page.ev('document.body.innerText')
    return text && text.includes('ok') ? text : ''
  })
  check('保存に失敗してもページの認証は完了する', body.includes('nemo-basic-auth ok g19/main'), body)
  page.close()
  await closeTab(key)

  // 書けるように戻す
  fs.rmdirSync(AUTH_FILE)
  const recovered = await saveRule({ pattern: patternFor('g19/after'), username: 'after', password: 'p' })
  const after = (await listRules()).rules
  check(
    '書けるように戻したあと、失敗分が混入しない',
    recovered.saved === true && after.length === before + 1 && after.every((r) => r.username !== 'u'),
    JSON.stringify(after.map((r) => r.username))
  )
}

/* ---- ⑳ Settings の実操作 ---- */

async function checkSettingsUi() {
  await clearRules()
  await saveRule({ pattern: patternFor('g20/'), username: 'listed', password: 'secret-pw' })
  await call(`setOverlay('settings').then(() => 'ok')`)
  const opened = await until(async () =>
    (await overlay.ev(`document.querySelector('.http-auth') ? 'ok' : ''`)) === 'ok' ? 'ok' : ''
  )
  if (opened !== 'ok') {
    skip('Settings の HTTP 認証セクション', '設定画面が開かない')
    return
  }
  // 一覧は IPC の往復のあとに描かれる。**待たずに数えると 0 件を読む**
  const rows = await until(async () => (await overlay.ev(`document.querySelectorAll('.ha-row').length`)) || 0)
  check('Settings に保存済みルールが並ぶ', rows === 1, `行 ${rows} 件`)

  /** 行は普段 1 行だけで、操作は開いた行にしか出ない。操作の前に開く */
  const openRow = async (id) => {
    await overlay.ev(
      `(() => { const row = document.querySelector('[data-rule-id="${id}"]'); if (row && !row.querySelector('.ha-editor')) row.querySelector('.ha-summary').click(); return 'ok' })()`
    )
    return until(
      async () => await overlay.ev(`!!document.querySelector('[data-rule-id="${id}"] .ha-editor')`)
    )
  }
  // テスターと取り込みは <details> に畳んである。開いてから触る
  await overlay.ev(`(() => { document.querySelector('.ha-tools').open = true; return 'ok' })()`)

  /* --- インポート --- */
  await overlay.ev(setInput('.ha-import-text', DUMMY_MULTIPASS))
  await overlay.ev(`(() => { document.querySelector('.ha-import-run').click(); return 'ok' })()`)
  const importText = await until(async () => {
    const text = await overlay.ev(`document.querySelector('.ha-import-result')?.innerText ?? ''`)
    return text.length > 0 ? text : ''
  })
  check(
    'インポート結果に取り込み件数が出る',
    importText.includes('2 件を取り込みました'),
    importText.split('\n')[0]
  )
  check(
    'priority が一様でなければ一括警告が出る',
    importText.includes('優先度は取り込まれません'),
    importText
  )
  check(
    '取り込めなかったパターンが理由付きで出る',
    importText.includes('(a+)+$') && importText.includes('nouser.example.com'),
    importText
  )
  const cleared = await overlay.ev(`document.querySelector('.ha-import-text').value`)
  check('取り込んだら貼り付け欄を直ちに空にする', cleared === '', JSON.stringify(cleared))
  const importedFrom = await overlay.ev(
    `JSON.stringify([...document.querySelectorAll('.ha-imported')].map(e => e.getAttribute('data-from')))`
  )
  check('変換したルールには変換元が出る', importedFrom.includes('imported.example.com'), importedFrom)

  const listedId = (await listRules()).rules.find((rule) => rule.username === 'listed')?.id ?? ''
  const rowSelector = `[data-rule-id="${listedId}"]`
  const rowOpened = await openRow(listedId)
  check('行を押すと編集欄が開く', rowOpened === true)

  /* --- テスター --- */
  await overlay.ev(
    setInput(
      '.ha-test-urls',
      `${authUrl('g20/main', { realm: 'r20' })}\n${PAGES}/__nemo_basic_auth__/zzz/none`
    )
  )
  await overlay.ev(`(() => { document.querySelector('.ha-test-run').click(); return 'ok' })()`)
  const testText = await until(async () => {
    const text = await overlay.ev(
      `JSON.stringify([...document.querySelectorAll('.ha-test-result')].map(e => e.innerText))`
    )
    return text !== '[]' ? text : ''
  })
  check(
    'テスターが勝者とマッチなしを出す',
    testText.includes('が使われます') && testText.includes('マッチするルールはありません'),
    testText
  )

  /* --- 「パスワードを変更」を押しても他の欄は消えず、「取り消す」で戻れる --- */
  const patternBefore = await overlay.ev(`document.querySelector('${rowSelector} .ha-pattern').value`)
  await overlay.ev(
    `(() => { document.querySelector('${rowSelector} .ha-change-password').click(); return 'ok' })()`
  )
  const passwordInputShown = await until(
    async () => await overlay.ev(`!!document.querySelector('${rowSelector} .ha-new-password')`)
  )
  const patternAfter = await overlay.ev(`document.querySelector('${rowSelector} .ha-pattern').value`)
  check(
    '「パスワードを変更」を押してもパターンは消えない',
    passwordInputShown === true && patternAfter === patternBefore && patternBefore.length > 0,
    `before=${patternBefore} after=${patternAfter}`
  )
  await overlay.ev(`(() => { document.querySelector('${rowSelector} .ha-cancel').click(); return 'ok' })()`)
  const cancelled = await until(
    async () => await overlay.ev(`!document.querySelector('${rowSelector} .ha-new-password')`)
  )
  check('「取り消す」でパスワード欄が閉じて元に戻る', cancelled === true)

  /* --- validator に弾かれるパターン ---
   * **テスターより後に置く。** 壊れた下書きが残っている間はテスター自体が弾かれるので、
   * 先に置くと「テスターが動かないだけ」で FAIL する。
   */
  await overlay.ev(setInput(`${rowSelector} .ha-pattern`, '(a+)+$'))
  await overlay.ev(`(() => { document.querySelector('${rowSelector} .ha-save').click(); return 'ok' })()`)
  const message = await until(async () => {
    const text = await overlay.ev(`document.querySelector('.ha-message')?.innerText ?? ''`)
    return text.length > 0 ? text : ''
  })
  check('validator に弾かれるパターンはエラーとして出る', message.includes('invalid-pattern'), message)

  /* --- パスワードの表示と 3 つの再マスク経路 --- */
  const revealOnce = async () => {
    await overlay.ev(`(() => { document.querySelector('${rowSelector} .ha-reveal').click(); return 'ok' })()`)
    return until(async () => {
      const text = await overlay.ev(`document.querySelector('${rowSelector} .ha-password')?.innerText ?? ''`)
      return text && text !== '••••••' ? text : ''
    })
  }
  const shown = await revealOnce()
  check('「表示」でパスワードが 1 件だけ出る', shown === 'secret-pw', shown)

  // ⓪ 「隠す」で手動で戻せる（表示したら戻せない、を踏んだ）
  await overlay.ev(`(() => { document.querySelector('${rowSelector} .ha-hide').click(); return 'ok' })()`)
  const hidden = await until(
    async () =>
      (await overlay.ev(`document.querySelector('${rowSelector} .ha-password')?.innerText ?? ''`)) ===
      '••••••'
  )
  check('「隠す」で再マスクされる', hidden === true)
  await revealOnce()

  // ① タイマー（`httpAuthRevealMs` を検証用に縮めてある）
  const remasked = await until(
    async () =>
      (await overlay.ev(`document.querySelector('${rowSelector} .ha-password')?.innerText ?? ''`)) ===
      '••••••',
    { timeoutMs: timings.httpAuthRevealMs + 4000 }
  )
  check('表示から一定時間で再マスクされる', remasked === true, `${timings.httpAuthRevealMs}ms`)

  // ② 別のルールを表示したとき
  await revealOnce()
  const otherRow = await overlay.ev(
    `(() => { const rows = [...document.querySelectorAll('.ha-row')].filter(r => r.getAttribute('data-rule-id') !== ${JSON.stringify(listedId)}); return rows.length > 0 ? rows[0].getAttribute('data-rule-id') : '' })()`
  )
  if (otherRow) {
    await openRow(otherRow)
    await overlay.ev(
      `(() => { document.querySelector('[data-rule-id="${otherRow}"] .ha-reveal').click(); return 'ok' })()`
    )
    const previous = await until(
      async () =>
        (await overlay.ev(`document.querySelector('${rowSelector} .ha-password')?.innerText ?? ''`)) ===
        '••••••',
      { timeoutMs: 4000 }
    )
    check('別のルールを表示すると前の平文が消える', previous === true)
  } else {
    skip('別のルールを表示すると前の平文が消える', '他のルールが無い')
  }

  // ③ Settings を閉じたとき
  await revealOnce()
  await call(`setOverlay(null).then(() => 'ok')`)
  await sleep(300)
  await call(`setOverlay('settings').then(() => 'ok')`)
  // **一覧が届くまで待つ**（`.http-auth` は空のまま先に出るので、待たないと空文字を読む）。
  // 開いていた行も閉じた状態に戻るので、開き直してから読む
  await until(async () => await overlay.ev(`!!document.querySelector('${rowSelector}')`))
  await openRow(listedId)
  const afterClose = await until(async () => {
    const text = await overlay.ev(`document.querySelector('${rowSelector} .ha-password')?.innerText ?? ''`)
    return text.length > 0 ? text : ''
  })
  check('Settings を閉じると平文が消える', afterClose === '••••••', afterClose)

  /* --- 一覧のペイロードにパスワードが入らない --- */
  const payload = await ui.ev(`window.nemo.listHttpAuthRules().then(s => JSON.stringify(s))`)
  check(
    '一覧 IPC のペイロードにパスワードが一切含まれない',
    !payload.includes('secret-pw') && !payload.includes('mp-pass') && !payload.includes('password'),
    payload.slice(0, 160)
  )

  await call(`setOverlay(null).then(() => 'ok')`)
}

/* ---- ㉑「この端末では暗号化できない」backend ---- */

/**
 * 端末鍵が使えない環境。**まっさらな状態からの検証では一度も通らない経路**なので、
 * 差し替え backend をマーカーで「利用不可」に倒して踏む。
 */
async function checkUnavailableBackend() {
  if (!USER_DATA) {
    skip('暗号化が使えない環境では保存を断る', 'NEMO_USER_DATA_DIR が渡っていない')
    return
  }
  await clearRules()
  const marker = path.join(USER_DATA, '.nemo-crypto-unavailable')
  fs.writeFileSync(marker, '1')
  try {
    const state = await listRules()
    check(
      '暗号化が使えないことが一覧と一緒に返る',
      state.encryptionAvailable === false,
      JSON.stringify(state)
    )

    const refused = await saveRule({
      pattern: patternFor('g21b/'),
      username: 'u',
      password: 'plaintext-secret'
    })
    check(
      '暗号化が使えない環境では保存を断る',
      refused.saved === false && refused.reason === 'no-encryption',
      JSON.stringify(refused)
    )

    // 認証ダイアログにも保存チェックを出さない
    const key = await openTab(authUrl('g21b/main', { realm: 'r21b' }))
    await waitDialog()
    const hasSave = await overlay.ev(`document.querySelector('${AUTH_SAVE}') ? 'yes' : 'no'`)
    check('暗号化が使えない環境では保存チェックを出さない', hasSave === 'no', hasSave)
    await cancelAuth()
    await closeTab(key)

    const onDisk = fs.existsSync(AUTH_FILE) ? fs.readFileSync(AUTH_FILE, 'utf8') : '(ファイル無し)'
    check(
      '平文がディスクに書かれない',
      !onDisk.includes('plaintext-secret'),
      onDisk.length > 200 ? `${onDisk.slice(0, 200)}…` : onDisk
    )
  } finally {
    fs.rmSync(marker, { force: true })
  }
  const restored = await listRules()
  check(
    'マーカーを外すと元に戻る',
    restored.encryptionAvailable === true,
    JSON.stringify(restored.encryptionAvailable)
  )
}

/* ---- 最後に main の未捕捉例外を見る ---- */
async function checkNoUncaught() {
  const count = countLogEvents(USER_DATA, 'app.uncaught_exception')
  check('main に未捕捉例外が出ていない', count === 0, `${count} 件`)
}
