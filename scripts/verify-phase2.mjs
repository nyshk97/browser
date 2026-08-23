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
import { connect, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'

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

  privateUi.close()
}

/* ------------------------------------------------------------------ *
 * 既定ブラウザ
 * ------------------------------------------------------------------ */

const browserStatus = await ui
  .ev('window.nemo.getDefaultBrowserStatus().then((s) => JSON.stringify(s))')
  .then(JSON.parse)
check(
  '開発起動では既定ブラウザにできないと分かる形で返る',
  browserStatus.canRequest === false && typeof browserStatus.reason === 'string',
  JSON.stringify(browserStatus)
)

// 呼んでも何も起きない（Electron 本体を既定ブラウザにしてしまわない）
const afterRequest = await ui
  .ev('window.nemo.requestDefaultBrowser().then((s) => JSON.stringify(s))')
  .then(JSON.parse)
check('開発起動での要求は無視される', afterRequest.isDefault === false)

console.log(failures === 0 ? '\n=== Phase 2 検証: すべて PASS' : `\n=== Phase 2 検証: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
