#!/usr/bin/env node
/**
 * Live Folder（GitHub の PR）の自走検証。
 *
 * **GitHub には実際に繋がない。** アプリの endpoint を
 * `NEMO_GITHUB_TEST_ENDPOINT` でこのスクリプトが立てるローカルサーバへ向け、
 * そこで返す中身を切り替えて挙動を見る（差し替え中はアプリが実トークンを一切読まない）。
 *
 * 認証は `NEMO_GITHUB_TEST_AUTH=stored-only` で回す。
 * 「PAT を保存 → 取得が走る → 消す → `Connect GitHub` に戻る」を
 * **同一プロセスで**再現できるのはこの値だけ（`dummy` 固定だと保存も削除も結果が変わらない）。
 *
 * 使い方:
 *   node scripts/verify-live-folder.mjs                 … 本体
 *   node scripts/verify-live-folder.mjs --restart-write … 再起動前の仕込み（PAT とキャッシュ）
 *   node scripts/verify-live-folder.mjs --restart-read  … 再起動後の確認
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { connectUi, sleep } from './lib/cdp.mjs'
import { readLogLines } from './lib/harness.mjs'
import { timings } from './lib/timings.mjs'
import { normalizePrUrl } from '../src/shared/live-folder-schema.js'

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const USER_DATA = process.env.NEMO_USER_DATA_DIR ?? ''
const ENDPOINT = process.env.NEMO_GITHUB_TEST_ENDPOINT ?? ''

let failures = 0
let skipped = 0

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 条件に到達できなかったものは**黙って PASS にしない**（何を見ていないかを必ず出す）。 */
function skip(name, reason) {
  skipped += 1
  console.log(`SKIP  ${name} — ${reason}`)
}

/* ------------------------------------------------------------------ *
 * 差し替え先のサーバ
 * ------------------------------------------------------------------ */

/** いま返すもの。`respond(req, res)` を差し替えて挙動を作る。 */
let responder = () => okBody([])
let total = 0
let inFlight = 0
let maxInFlight = 0

function resetCounters() {
  total = 0
  inFlight = 0
  maxInFlight = 0
}

/**
 * PR を1件組み立てる。
 * @param {{bucket:'review'|'mine', repo:string, number:number, title:string, author:string, draft?:boolean, decision?:string|null, updatedAt?:string}} spec
 */
function pr(spec) {
  return {
    number: spec.number,
    title: spec.title,
    url: `https://github.com/${spec.repo}/pull/${spec.number}`,
    isDraft: spec.draft === true,
    updatedAt: spec.updatedAt ?? '2026-08-25T10:00:00Z',
    reviewDecision: spec.decision ?? null,
    author: { login: spec.author },
    repository: { nameWithOwner: spec.repo }
  }
}

/** 成功レスポンス。`issueCount` を明示すると打ち切りを作れる。 */
function okBody(items, { reviewTotal = null, mineTotal = null, login = 'octo-dev' } = {}) {
  const review = items.filter((item) => item.__bucket === 'review').map((item) => item.node)
  const mine = items.filter((item) => item.__bucket === 'mine').map((item) => item.node)
  return {
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: { login },
        reviewRequested: { issueCount: reviewTotal ?? review.length, nodes: review },
        mine: { issueCount: mineTotal ?? mine.length, nodes: mine },
        rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-08-26T10:00:00Z' }
      }
    }
  }
}

const review = (spec) => ({ __bucket: 'review', node: pr({ ...spec, bucket: 'review' }) })
const mine = (spec) => ({ __bucket: 'mine', node: pr({ ...spec, bucket: 'mine' }) })

const server = http.createServer((req, res) => {
  // 本文は読み捨てる（受け取り切ってから応答する）
  req.on('data', () => {})
  req.on('end', () => {
    total += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    const finish = (result) => {
      inFlight -= 1
      res.writeHead(result.status, { 'content-type': 'application/json', ...result.headers })
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    }
    const result = responder(total)
    if (result instanceof Promise) void result.then(finish)
    else finish(result)
  })
})

function serve(next) {
  responder = typeof next === 'function' ? next : () => next
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

/** UI の Live Folder セクションの見えている文字列。 */
const SECTION_TEXT = `(document.querySelector('.live-folder')?.innerText ?? '(no section)')`
const HAS_SECTION = `Boolean(document.querySelector('.live-folder'))`
const ROW_TITLES = `JSON.stringify([...document.querySelectorAll('.lf-row .lf-title')].map((e) => e.innerText))`
const STALE_ROWS = `document.querySelectorAll('.lf-row.stale').length`
const TRUNCATED = `JSON.stringify([...document.querySelectorAll('.lf-truncated')].map((e) => e.innerText))`
const EPHEMERAL_TITLES = `JSON.stringify([...document.querySelectorAll('.scroll > .row:not(.new-tab)')].map((e) => e.innerText))`

/** 共有状態の Live Folder（main が組み立てたもの）。 */
const LIVE_STATE = `window.nemo.getSharedState().then((s) => JSON.stringify(s.liveFolder))`

async function liveState(ui) {
  return JSON.parse((await ui.ev(LIVE_STATE)) ?? 'null')
}

/** 条件が満たされるまで待つ（満たされなければ最後の値を返す）。 */
async function until(fn, { timeoutMs = 9000, interval = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() > deadline) return last
    await sleep(interval)
  }
}

/** リクエスト総数が n になるまで待つ。 */
const waitRequests = (n, timeoutMs = 9000) => until(() => total >= n, { timeoutMs })

/* ---- 小見出しの開閉 ----
 * 小見出しは**起動のたびに両方折りたたみ**で、行は開くまで DOM に無い。
 * 開閉は Sidebar の React state なので、畳み直る契機は起動（Sidebar の初回マウント。`--restart-read` も同じ）だけ。
 * 設定の再有効化では `LiveFolder` が再マウントされても Sidebar は生きているので畳み直らない。
 * どの検査がどの経路の後に来るかを追うより、
 * 「行が見えている前提」の読み取りは**読むたびに開き直す**（`readExpanded`）。
 * 開閉状態そのものを検査するときは `ui.ev` を直接使う（`readExpanded` を通すと再展開されて検査にならない）。
 */
const CLOSED_SUBS = `document.querySelectorAll('.lf-sub[aria-expanded="false"]').length`
const OPEN_SUBS = `document.querySelectorAll('.lf-sub[aria-expanded="true"]').length`
const SUBS = `document.querySelectorAll('.lf-sub').length`
const ROWS = `document.querySelectorAll('.lf-row').length`

/** 畳まれている小見出しを全部開く（無ければ何もしない。冪等）。 */
async function expandAll(ui) {
  if ((await ui.ev(CLOSED_SUBS)) === 0) return
  await ui.ev(`document.querySelectorAll('.lf-sub[aria-expanded="false"]').forEach((b) => b.click())`)
  await until(async () => (await ui.ev(CLOSED_SUBS)) === 0, { timeoutMs: 3000 })
}

/** 開いている小見出しを全部畳む（検査の冒頭で状態を揃える）。 */
async function collapseAll(ui) {
  if ((await ui.ev(OPEN_SUBS)) === 0) return
  await ui.ev(`document.querySelectorAll('.lf-sub[aria-expanded="true"]').forEach((b) => b.click())`)
  await until(async () => (await ui.ev(OPEN_SUBS)) === 0, { timeoutMs: 3000 })
}

/** 行が見えている前提の式を、直前に全部開いてから評価する。 */
async function readExpanded(ui, expression) {
  await expandAll(ui)
  return ui.ev(expression)
}

/** 指定バケットの小見出し（`.lf-bucket[data-bucket=…] > .lf-sub`）を触るための式。 */
const sub = (bucket) => `document.querySelector('.lf-bucket[data-bucket="${bucket}"] > .lf-sub')`
const subExpanded = (bucket) => `${sub(bucket)}?.getAttribute('aria-expanded')`
const countOf = (selector) => `document.querySelectorAll(${JSON.stringify(selector)}).length`

/** 要素の中心へ合成マウスを動かす（`:hover` を作る）。 */
async function hoverAt(ui, expression) {
  const rect = JSON.parse(await ui.ev(`JSON.stringify((${expression}).getBoundingClientRect())`))
  await ui.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  })
  return rect
}

/** 合成マウスをサイドバー外へ退避して `:hover` を消す。 */
async function unhover(ui) {
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await until(async () => (await ui.ev(countOf('.live-folder :hover'))) === 0, { timeoutMs: 2000 })
}

/** `--nemo-hover` の計算値（比較用に一時要素へ当てて色文字列にする）。 */
const HOVER_COLOR = `(() => {
  const el = document.createElement('div')
  el.style.background = 'var(--nemo-hover)'
  document.body.appendChild(el)
  const color = getComputedStyle(el).backgroundColor
  el.remove()
  return color
})()`

const bg = (expression) => `getComputedStyle(${expression}).backgroundColor`
const CHEV_OPEN = 'matrix(0, 1, -1, 0, 0, 0)'
const chev = (bucket) => `getComputedStyle(${sub(bucket)}.querySelector('.chev')).transform`

/**
 * `NEMO_VERIFY_SHOTS=<dir>` が指定されたときだけ、Live Folder の見た目を PNG に残す
 * （自走検証の判定には使わない。矢印・件数・ドットの配置を目で確かめるため）。
 */
const SHOTS_DIR = process.env.NEMO_VERIFY_SHOTS ?? ''
if (SHOTS_DIR) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  if (!fs.statSync(SHOTS_DIR).isDirectory()) {
    console.error(`[verify-live-folder] NEMO_VERIFY_SHOTS がディレクトリでない: ${SHOTS_DIR}`)
    process.exit(2)
  }
}

async function shot(ui, name) {
  if (!SHOTS_DIR) return
  // 回転途中・hover 中を撮らない
  await until(
    async () =>
      (await ui.ev(
        `[...document.querySelectorAll('.lf-sub')].every((b) => getComputedStyle(b.querySelector('.chev')).transform === (b.getAttribute('aria-expanded') === 'true' ? ${JSON.stringify(CHEV_OPEN)} : 'none'))`
      )) === true,
    { timeoutMs: 2000 }
  )
  await unhover(ui)
  // 右クリックやキー操作で残ったフォーカスリングと、hover 背景のフェード（0.12s）を写さない
  await ui.ev(`document.activeElement?.blur()`)
  await sleep(300)
  const rect = JSON.parse(
    await ui.ev(`JSON.stringify(document.querySelector('.live-folder').getBoundingClientRect())`)
  )
  const result = await ui.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: Math.max(0, rect.y - 8), width: rect.right + 8, height: rect.height + 16, scale: 2 }
  })
  const file = path.join(SHOTS_DIR, `live-folder-${name}.png`)
  fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'))
  console.log(`[verify-live-folder] スクショ ${file}`)
}

/** 診断ログの1イベント（時刻順）。 */
function logEvents(event) {
  return readLogLines(USER_DATA)
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null && entry.event === event)
    .sort((a, b) => String(a.t).localeCompare(String(b.t)))
}

/** アプリ側と同じ非可逆 fingerprint（`sha256(token)` の先頭 16 文字）。 */
const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16)

const TEST_PAT_A = 'ghp_testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TEST_PAT_B = 'ghp_testBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

const savePat = (ui, token) => ui.ev(`window.nemo.saveGithubToken(${JSON.stringify(token)})`)
const clearPat = (ui) => ui.ev(`window.nemo.clearGithubToken().then(() => 'ok')`)
const refresh = (ui) => ui.ev(`window.nemo.liveFolderRefresh().then(() => 'ok')`)
const setEnabled = (ui, enabled) =>
  ui.ev(`window.nemo.updateSettings({ liveFolderEnabled: ${enabled} }).then(() => 'ok')`)

/* ------------------------------------------------------------------ *
 * 再起動をまたぐぶん
 * ------------------------------------------------------------------ */

const CACHE_PATH = () => path.join(USER_DATA, 'live-folders.json')
const MARKER_PATH = () => path.join(USER_DATA, 'live-folder.plant.json')

/**
 * 再起動前の仕込み。**アプリを止めてから**呼ぶ
 * （起動中に書くと、終了時の `close()` が上書きする）。
 *
 * 壊れたキャッシュ（1000件・`javascript:` URL・不正な `state`）を混ぜて置き、
 * 「起動できること」と「`javascript:` が1つも描画されないこと」を再起動後に見る。
 */
function restartWrite() {
  if (!USER_DATA) {
    console.error('[verify-live-folder] NEMO_USER_DATA_DIR が無い')
    process.exit(2)
  }
  // 起動時に読める資格情報（`stored-only` はこのストアだけを読む）
  const items = [
    ...Array.from({ length: 1000 }, (_unused, index) => ({
      url: `https://github.com/acme/bulk/pull/${index + 1}`,
      title: `cached bulk ${index + 1}`,
      repo: 'acme/bulk',
      author: 'someone',
      state: 'waiting',
      bucket: 'review',
      updatedAt: '2026-08-01T00:00:00Z'
    })),
    {
      url: 'javascript:alert(1)',
      title: 'evil',
      repo: 'x',
      author: 'x',
      state: 'waiting',
      bucket: 'mine',
      updatedAt: '2026-08-01T00:00:00Z'
    },
    {
      url: 'https://github.com/acme/x/pull/1',
      title: 'bad state',
      repo: 'acme/x',
      author: 'x',
      state: 'merged',
      bucket: 'mine',
      updatedAt: '2026-08-01T00:00:00Z'
    }
  ]
  fs.writeFileSync(
    CACHE_PATH(),
    `${JSON.stringify(
      {
        version: 1,
        data: {
          // **TEST_PAT_A と一致する fingerprint** を入れる。
          // 一致するキャッシュは「取得を待たずに出る」ことを再起動後に見る
          // （一致しない側は再起動後に PAT を差し替えて見る）
          credentialKey: fingerprint(TEST_PAT_A),
          login: 'someone-else',
          items,
          truncation: { review: null, mine: null },
          updatedAt: Date.now()
        }
      },
      null,
      2
    )}\n`
  )
  fs.writeFileSync(MARKER_PATH(), JSON.stringify({ plantedAt: new Date().toISOString() }))
  console.log(`[verify-live-folder] 壊れたキャッシュを仕込んだ（${items.length} 件・javascript: 入り）`)
}

async function restartRead() {
  const port = Number(new URL(ENDPOINT).port)
  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  // **取得は必ず失敗させる。** 成功するとキャッシュが置き換わってしまい、
  // 「キャッシュが出ているのか、取得できたのか」が区別できなくなる
  serve({ status: 500, headers: {}, body: { message: 'boom' } })

  const ui = await connectUi(CDP)
  // ㉒ 壊れたキャッシュを置いても起動する（ここまで来ている時点で起動はしている）
  const text = await ui.ev(SECTION_TEXT)
  check('㉒ 壊れたキャッシュを置いても起動する', typeof text === 'string', String(text).slice(0, 40))

  // ① 一致する資格情報なら、取得を待たずにキャッシュが出る
  await savePat(ui, TEST_PAT_A)
  // 小見出しは**キャッシュ復元でも起動のたびに折りたたみ**（開く前に見る）。
  // fixture は review 1000 件が先頭で 200 件に切られるので `mine` の小見出しは出ない
  await until(async () => (await ui.ev(SUBS)) >= 1, { timeoutMs: 8000 })
  const subsAtBoot = await ui.ev(SUBS)
  const closedAtBoot = await ui.ev(CLOSED_SUBS)
  const rowsAtBoot = await ui.ev(ROWS)
  check(
    '小見出しはキャッシュ復元でも折りたたみから始まる',
    subsAtBoot >= 1 && closedAtBoot === subsAtBoot && rowsAtBoot === 0,
    `小見出し ${subsAtBoot} 件 / 閉 ${closedAtBoot} 件 / 行 ${rowsAtBoot}`
  )
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length > 0, { timeoutMs: 8000 })
  let titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  const state = await liveState(ui)
  check(
    '① 起動直後に前回のキャッシュが出る（取得は 500 で失敗している）',
    titles.length > 0 && state.failure?.kind === 'transient',
    `${titles.length} 行 / failure=${JSON.stringify(state.failure?.kind)}`
  )
  // ㉒ 1000 件は 200 件に切られ、javascript: と不正な state は落ちる
  check(
    '㉒ 1000 件のキャッシュは 200 件で切られる',
    titles.length === 200,
    `仕込み 1002 件 → 描画 ${titles.length} 行`
  )
  check(
    '㉒ javascript: の項目が1つも描画されない',
    titles.every((title) => title !== 'evil'),
    `描画 ${titles.length} 行`
  )
  check(
    '㉒ 不正な state の項目も落ちる',
    titles.every((title) => title !== 'bad state'),
    `描画 ${titles.length} 行`
  )

  // ⑳ トークンを別のものに差し替えたら、取得前に古い一覧が出ない
  await savePat(ui, TEST_PAT_B)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 0, { timeoutMs: 8000 })
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check(
    '⑳ fingerprint が一致しないキャッシュは取得前に捨てられる',
    titles.length === 0,
    `直前は 200 行 → 描画 ${titles.length} 行`
  )
  ui.close()
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

const BASE = [
  review({
    repo: 'acme/tools',
    number: 12,
    title: 'Cache the parsed manifest',
    author: 'quill',
    decision: 'APPROVED',
    updatedAt: '2026-08-25T11:30:00Z'
  }),
  review({
    repo: 'acme/widgets',
    number: 41,
    title: 'Extract the retry policy',
    author: 'riverstone',
    decision: 'CHANGES_REQUESTED',
    updatedAt: '2026-08-24T09:00:00Z'
  }),
  mine({
    repo: 'acme/widgets',
    number: 88,
    title: 'Rewrite the sync schema',
    author: 'octo-dev',
    draft: true,
    updatedAt: '2026-08-26T01:15:00Z'
  })
]
const PR_12 = 'https://github.com/acme/tools/pull/12'

async function main() {
  if (!ENDPOINT) {
    console.error('[verify-live-folder] NEMO_GITHUB_TEST_ENDPOINT が無い')
    process.exit(2)
  }
  const port = Number(new URL(ENDPOINT).port)
  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  console.log(`[verify-live-folder] 差し替え先 ${ENDPOINT} で待ち受け`)

  const ui = await connectUi(CDP)

  /* ---- ④ トークン未設定 ---- */
  serve(okBody(BASE))
  resetCounters()
  await until(async () => (await liveState(ui))?.source === 'none')
  const noneState = await liveState(ui)
  check(
    '④ トークン未設定なら source が none',
    noneState?.source === 'none',
    JSON.stringify(noneState?.source)
  )
  const connectText = await until(async () => {
    const text = await ui.ev(SECTION_TEXT)
    return text.includes('Connect GitHub') ? text : ''
  })
  check(
    '④ Connect GitHub の1行だけが出る',
    String(connectText).trim() === 'Connect GitHub',
    JSON.stringify(connectText)
  )
  check('④ トークンが無いうちは1度も投げない', total === 0, `リクエスト ${total} 回`)

  /* ---- ⑫ PAT を保存した直後に取得が走る ---- */
  resetCounters()
  await savePat(ui, TEST_PAT_A)
  const fetched = await waitRequests(1, 5000)
  check('⑫ PAT を保存した直後に取得が走る（60秒待たない）', fetched === true, `リクエスト ${total} 回`)

  /* ---- 小見出しは初期折りたたみ ---- */
  // **一覧が初めて出た瞬間、まだ何も開いていない状態**を raw の `ui.ev` で見る
  // （`readExpanded` を1回でも通すと開いてしまい、初期値が「開」に退行しても気づけない）
  await until(async () => (await ui.ev(SUBS)) === 2)
  const closedAtFirst = await ui.ev(CLOSED_SUBS)
  const rowsAtFirst = await ui.ev(ROWS)
  const countsAtFirst = JSON.parse(
    await ui.ev(
      `JSON.stringify([...document.querySelectorAll('.lf-bucket[data-bucket]')].map((b) => [b.dataset.bucket, b.querySelector(':scope > .lf-sub .count').innerText, b.querySelector(':scope > .lf-sub .count').offsetParent !== null]))`
    )
  )
  check(
    '一覧が初めて出たとき小見出しは両方折りたたみで、行は DOM に無い',
    closedAtFirst === 2 && rowsAtFirst === 0,
    `閉 ${closedAtFirst} 件 / 行 ${rowsAtFirst}`
  )
  check(
    '件数はバケットに割り当てられた件数（review 2 / mine 1）で、畳んでいても見える',
    JSON.stringify(countsAtFirst) ===
      JSON.stringify([
        ['review', '2', true],
        ['mine', '1', true]
      ]),
    JSON.stringify(countsAtFirst)
  )
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  let titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check('② 取得後に行が置き換わる', titles.length === 3, JSON.stringify(titles))

  /* ---- ⑱ 平文の PAT がファイルに無い ---- */
  // **差し替え中は実ストア（`safeStorage` = macOS では Keychain）に触らない**ので、
  // ここでは見られない。触ると OS の許可ダイアログが出て検証が永久に止まる（実際に踏んだ）。
  // 人間の確認（VERIFY.md）に回す。
  const tokenFile = path.join(USER_DATA, 'github-token.json')
  if (fs.existsSync(tokenFile)) {
    const tokenRaw = fs.readFileSync(tokenFile, 'utf8')
    check(
      '⑱ github-token.json に平文の PAT が含まれない',
      !tokenRaw.includes(TEST_PAT_A),
      `${tokenRaw.length} バイト`
    )
  } else {
    skip(
      '⑱ github-token.json に平文の PAT が含まれない',
      '差し替え中は実ストア（Keychain）に触らないためファイルが無い。人間の確認に回す'
    )
  }

  /* ---- 小見出しと2行目 ---- */
  const sectionText = await ui.ev(SECTION_TEXT)
  check(
    '小見出しは REVIEW REQUESTED / CREATED（右はバケットに割り当てられた件数）',
    /REVIEW REQUESTED\s*2/i.test(sectionText) && /CREATED\s*1/i.test(sectionText),
    JSON.stringify(sectionText)
  )
  const sublines = JSON.parse(
    await readExpanded(
      ui,
      `JSON.stringify([...document.querySelectorAll('.lf-row .lf-sub-line')].map((e) => e.innerText))`
    )
  )
  check(
    '2行目は文脈で変わる（レビュー依頼は著者名 / 自分の PR はリポジトリ名）',
    sublines[0] === 'quill' && sublines[2] === 'acme/widgets',
    JSON.stringify(sublines)
  )

  /* ---- 小見出しの折りたたみ ---- */
  // 初期状態は上（⑫ の直後）で見た。ここからは畳み直した状態から各検査を始める
  await collapseAll(ui)
  await until(async () => (await ui.ev(SUBS)) === 2)
  const closedSubs = await ui.ev(CLOSED_SUBS)
  const rowsWhileClosed = await ui.ev(ROWS)
  check(
    '開いた後に畳み直すと行が DOM から消える',
    closedSubs === 2 && rowsWhileClosed === 0,
    `閉 ${closedSubs} 件 / 行 ${rowsWhileClosed}`
  )
  await shot(ui, 'both-closed')

  // 外観: 矢印の回転と hover 背景
  // 直前の `collapseAll` で回転が戻る途中を読まない（閉も最終値まで待つ）
  const chevClosed = await until(async () => ((await ui.ev(chev('review'))) === 'none' ? 'none' : ''))
  const hoverColor = await ui.ev(HOVER_COLOR)
  const subBefore = await ui.ev(bg(sub('review')))
  await hoverAt(ui, sub('review'))
  const subHovered = await until(async () =>
    (await ui.ev(bg(sub('review')))) === hoverColor ? hoverColor : ''
  )
  const subIsHover = await ui.ev(`${sub('review')}.matches(':hover')`)
  check(
    '小見出しのホバー背景は .row:hover と同じ（--nemo-hover）',
    subIsHover === true && subHovered === hoverColor && subBefore !== hoverColor,
    `:hover=${subIsHover} 前=${subBefore} 後=${subHovered} 期待=${hoverColor}`
  )
  await unhover(ui)
  await ui.ev(`${sub('review')}.click()`)
  const chevOpened = await until(async () => ((await ui.ev(chev('review'))) === CHEV_OPEN ? CHEV_OPEN : ''))
  check(
    '矢印は閉で none、開で 90° 回転',
    chevClosed === 'none' && chevOpened === CHEV_OPEN,
    `閉=${chevClosed} 開=${chevOpened}`
  )
  const rowSel = `document.querySelector('.lf-bucket[data-bucket="review"] .lf-row')`
  const rowBefore = await ui.ev(bg(rowSel))
  await hoverAt(ui, rowSel)
  const rowHovered = await until(async () => ((await ui.ev(bg(rowSel))) === hoverColor ? hoverColor : ''))
  const rowIsHover = await ui.ev(`${rowSel}.matches(':hover')`)
  check(
    '（対照）行のホバー背景も同じ色に変わる',
    rowIsHover === true && rowHovered === hoverColor && rowBefore !== hoverColor,
    `:hover=${rowIsHover} 前=${rowBefore} 後=${rowHovered}`
  )
  await unhover(ui)

  // 独立開閉: review だけ開いている
  const reviewRows = await ui.ev(countOf('.lf-bucket[data-bucket="review"] .lf-row'))
  const mineRows = await ui.ev(countOf('.lf-bucket[data-bucket="mine"] .lf-row'))
  const mineExpanded = await ui.ev(subExpanded('mine'))
  check(
    'review だけ開くと review の行だけ出て mine は畳まれたまま',
    reviewRows === 2 && mineRows === 0 && mineExpanded === 'false',
    `review ${reviewRows} 行 / mine ${mineRows} 行 / mine aria-expanded=${mineExpanded}`
  )
  await shot(ui, 'review-open')

  // 右クリック: メニューは出るが開閉しない・再取得もしない
  await collapseAll(ui)
  resetCounters()
  const subRect = await hoverAt(ui, sub('review'))
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ui.send('Input.dispatchMouseEvent', {
      type,
      button: 'right',
      clickCount: 1,
      x: subRect.x + subRect.width / 2,
      y: subRect.y + subRect.height / 2
    })
  }
  const menuShown = await until(async () => (await ui.ev(countOf('.row-menu'))) > 0, { timeoutMs: 2000 })
  await sleep(300)
  const expandedAfterRight = await ui.ev(subExpanded('review'))
  check(
    '小見出しの右クリックはメニューを出すだけで開閉も再取得もしない',
    menuShown === true && expandedAfterRight === 'false' && total === 0,
    `menu=${menuShown} aria-expanded=${expandedAfterRight} リクエスト ${total} 回`
  )
  await ui.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await ui.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await until(async () => (await ui.ev(countOf('.row-menu'))) === 0, { timeoutMs: 2000 })
  await unhover(ui)

  /*
   * 開閉で再取得しない。
   *
   * **計測の窓は「成功した取得の直後」から始める。** 自動取得の間隔は成功のたびに
   * 引き直されるので、直前に 1 回成功させておけば窓のあいだは自動取得が来ない。
   * これをやらないと、`liveFolderPollMs` を縮めたときに
   * **たまたま自動取得が窓に入って「開閉で再取得した」と誤判定する**。
   */
  await refresh(ui)
  await until(async () => (await liveState(ui))?.loading === false)
  await collapseAll(ui)
  resetCounters()
  await expandAll(ui)
  await shot(ui, 'both-open')
  await collapseAll(ui)
  await sleep(1000)
  check('開閉しても再取得しない', total === 0, `リクエスト ${total} 回`)

  // アクセシビリティ: aria-label / aria-controls / キーボード
  await collapseAll(ui)
  const labels = JSON.parse(
    await ui.ev(
      `JSON.stringify([...document.querySelectorAll('.lf-bucket[data-bucket]')].map((b) => [b.dataset.bucket, b.querySelector(':scope > .lf-sub').getAttribute('aria-label')]))`
    )
  )
  const labelOf = (bucket) => labels.find(([key]) => key === bucket)?.[1] ?? ''
  check(
    'aria-label に件数が入る',
    /2 件/.test(labelOf('review')) && /1 件/.test(labelOf('mine')),
    JSON.stringify(labels)
  )
  const controlsOk = await ui.ev(
    `[...document.querySelectorAll('.lf-sub')].every((b) => b.getAttribute('aria-controls').split(' ').every((id) => document.getElementById(id) !== null))`
  )
  check('aria-controls の参照先が全部実在する（打ち切りなし）', controlsOk === true, '')
  const pressKey = async (key, code, keyCode, text) => {
    await ui.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      text
    })
    await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }
  await ui.ev(`${sub('review')}.focus()`)
  await pressKey('Enter', 'Enter', 13, '\r')
  const enterReview = await until(async () => ((await ui.ev(subExpanded('review'))) === 'true' ? 'true' : ''))
  const enterMine = await ui.ev(subExpanded('mine'))
  check(
    'Enter でフォーカス中の小見出しだけ開く',
    enterReview === 'true' && enterMine === 'false',
    `review=${enterReview} mine=${enterMine}`
  )
  await collapseAll(ui)
  await ui.ev(`${sub('mine')}.focus()`)
  await pressKey(' ', 'Space', 32, ' ')
  const spaceMine = await until(async () => ((await ui.ev(subExpanded('mine'))) === 'true' ? 'true' : ''))
  const spaceReview = await ui.ev(subExpanded('review'))
  check(
    'Space でフォーカス中の小見出しだけ開く',
    spaceMine === 'true' && spaceReview === 'false',
    `mine=${spaceMine} review=${spaceReview}`
  )
  await collapseAll(ui)

  /* ---- ③ 一覧に載る前後で PR のタブが一時タブに出入りする ---- */
  // 1回目のレスポンスにその PR を含めず、同じ URL のタブを**非アクティブで**開いておく →
  // 2回目で現れた瞬間に一時タブから消える
  //
  // **この検証だけは github.com に実際の GET が飛ぶ**（存在しない PR なので 404 が返る）。
  // タブとの紐づけは URL が自然キーなので、`https://github.com/...` 以外は
  // そもそも Live Folder の項目として通らない
  serve(okBody(BASE.filter((item) => item.node.url !== PR_12)))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 2)
  // ③ の基準になる一時タブの行数（PR のタブを開く前）
  const ephemeralBefore = JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length
  const bgKey = await ui.ev(`window.nemo.createTab(${JSON.stringify(PR_12)}, { background: true })`)
  await sleep(400)
  const ephemeralWithTab = JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length
  check(
    '③ （前提）一覧に載っていない PR のタブは一時タブに出る',
    ephemeralWithTab === ephemeralBefore + 1,
    `${ephemeralBefore} → ${ephemeralWithTab} 行`
  )

  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => (await liveState(ui))?.items.some((item) => item.url === PR_12))

  /* ---- ③ Live Folder に載っている URL のタブは一時タブから消える ---- */
  const ephemeralExcluded = await until(async () => {
    const count = JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length
    return count === ephemeralBefore ? count : 0
  })
  check(
    '③ Live Folder に載った瞬間、そのタブは一時タブから消える',
    ephemeralExcluded === ephemeralBefore,
    `一覧に載る前 ${ephemeralWithTab} 行 → 載った後 ${JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length} 行`
  )

  /* ---- ③ 一覧から消えると開いていたタブが「今日のタブ」に現れる ---- */
  serve(okBody(BASE.filter((item) => item.node.url !== PR_12)))
  await refresh(ui)
  await until(async () => !(await liveState(ui)).items.some((item) => item.url === PR_12))
  const ephemeralBack = await until(async () => {
    const count = JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length
    return count === ephemeralBefore + 1 ? count : 0
  })
  check(
    '③ 一覧から消えた PR のタブは「今日のタブ」に現れる（降格処理を書かずに降格と同じ結果）',
    ephemeralBack === ephemeralBefore + 1,
    `${ephemeralBefore} 行 → ${JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length} 行`
  )
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(bgKey)}).then(() => 'ok')`)
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  /* ---- ③ クエリ付きの PR タブも「同じ PR」として扱う ---- */
  //
  // 通知から開いた `.../pull/12?notification_referrer_id=…` は
  // **renderer 側では正準化されて一時タブから隠れる**。main 側が文字列の完全一致で
  // 探していると、行を押したときに**正準 URL の別タブがもう1枚作られる**。
  //
  // **クエリではなくフラグメントを使う。** 存在しない PR にクエリ付きで行くと
  // github.com 側が 404 の過程でクエリを落として正準 URL になってしまい、
  // **検査が空振りしたまま PASS する**（実際に踏んだ）。
  // フラグメントはサーバに送られないので必ずタブの URL に残る。
  const noisyUrl = `${PR_12}?notification_referrer_id=NT_test#issuecomment-1`
  const noisyKey = await ui.ev(`window.nemo.createTab(${JSON.stringify(noisyUrl)}, { background: true })`)
  await sleep(800)
  const noisyTabUrl = await ui.ev(
    `window.nemo.getWindowState().then((s) => s.tabs.find((t) => t.key === ${JSON.stringify(noisyKey)})?.url ?? '')`
  )
  check(
    '③ （前提）タブの URL は正準 URL と一致していない',
    String(noisyTabUrl) !== PR_12 && String(noisyTabUrl).startsWith(PR_12),
    JSON.stringify(noisyTabUrl)
  )
  const ephemeralWithNoisy = JSON.parse(await ui.ev(EPHEMERAL_TITLES)).length
  check(
    '③ クエリ / フラグメント付きの PR タブも一時タブから隠れる（renderer 側の正準化）',
    ephemeralWithNoisy === ephemeralBefore,
    `${ephemeralBefore} 行 → ${ephemeralWithNoisy} 行`
  )
  const tabsBeforeOpen = await ui.ev(`window.nemo.getWindowState().then((s) => s.tabs.length)`)
  await ui.ev(`window.nemo.liveFolderOpen(${JSON.stringify(PR_12)}).then(() => 'ok')`)
  await sleep(800)
  const tabsAfterOpen = await ui.ev(`window.nemo.getWindowState().then((s) => s.tabs.length)`)
  const activeUrl = await ui.ev(
    `window.nemo.getWindowState().then((s) => s.tabs.find((t) => t.key === s.activeTabKey)?.url ?? '')`
  )
  check(
    '③ クエリ / フラグメント付きのタブを再利用する（正準 URL の別タブを作らない）',
    tabsAfterOpen === tabsBeforeOpen && String(activeUrl) === String(noisyTabUrl),
    `タブ ${tabsBeforeOpen} → ${tabsAfterOpen} / active=${JSON.stringify(activeUrl)}`
  )
  await ui.ev(`window.nemo.closeTab(${JSON.stringify(noisyKey)}).then(() => 'ok')`)
  await sleep(300)

  /* ---- ⌘⌥↑↓: 小見出しを畳んでいれば PR 行を飛ばし、開いていれば PR 行へ入る ---- */
  {
    const runCommand = (command) =>
      ui.ev(`window.nemo.runCommandForVerify(${JSON.stringify(command)}).then((ok) => (ok ? 'ok' : 'no'))`)
    /** アクティブが `key` になるまで待つ（`runCommandForVerify` は renderer の反映を待たない）。 */
    const activeBecame = (key) =>
      until(
        async () =>
          (await ui.ev(
            `window.nemo.getWindowState().then((s) => (s.activeTabKey === ${JSON.stringify(key)} ? 'ok' : ''))`
          )) === 'ok',
        { timeoutMs: 4000, interval: 50 }
      )
    const activeUrlOf = () =>
      ui.ev(
        `window.nemo.getWindowState().then((s) => s.tabs.find((t) => t.key === s.activeTabKey)?.url ?? '')`
      )
    const tabCount = () => ui.ev('window.nemo.getWindowState().then((s) => s.tabs.length)')

    // 前のスイート（split など）が残したピン留め / Favorites を消し、一時タブを**ちょうど 2 枚**にする
    // （並びが一時タブだけになっていないと「最下段 → 最上段」の期待値が成立しない。
    // 1 枚以下だと出発点と到達点が同じ行になり、何も見ずに PASS する）。
    // **消したものは節の末尾で戻さない**（後続の ⑦ 以降は自前で状態を作る）。この節を動かすときは前後の前提を見直す
    {
      const sh = JSON.parse(await ui.ev('window.nemo.getSharedState().then((s) => JSON.stringify(s))'))
      for (const node of sh.pinned)
        await ui.ev(`window.nemo.unpin(${JSON.stringify(node.id)}).then(() => 'ok')`)
      for (const item of sh.favorites)
        await ui.ev(`window.nemo.removeFavorite(${JSON.stringify(item.id)}).then(() => 'ok')`)
    }
    for (const key of JSON.parse(
      await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.map((t) => t.key)))')
    )) {
      await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
    }
    const t0 = await ui.ev(`window.nemo.createTab('about:blank', { background: true })`)
    const t1 = await ui.ev(`window.nemo.createTab('about:blank', { background: true })`)
    await sleep(400)
    await collapseAll(ui)
    const premise = JSON.parse(
      await ui.ev(
        `window.nemo.getSharedState().then((sh) => JSON.stringify({ favorites: sh.favorites.length, pinned: sh.pinned.length, lfRows: document.querySelectorAll('.lf-row').length, ephemeral: document.querySelectorAll('.scroll > .row:not(.new-tab)').length }))`
      )
    )
    check(
      '（前提）Favorites / ピンは 0 件・畳んだ PR 行は 0 本・一時タブは 2 行',
      premise.favorites === 0 && premise.pinned === 0 && premise.lfRows === 0 && premise.ephemeral === 2,
      JSON.stringify(premise)
    )

    // 畳んでいる: 最下段の一時タブから ↓ で並びの先頭（= 最上段の一時タブ）へ回り、PR タブは増えない
    await ui.ev(`window.nemo.selectTab(${JSON.stringify(t1)}).then(() => 'ok')`)
    await activeBecame(t1)
    const collapsedBefore = await tabCount()
    await runCommand('select-row-below')
    const wrapped = await activeBecame(t0)
    check(
      '畳んでいる小見出しの PR 行は飛ばされ、最下段から ↓ で最上段の一時タブへ回る',
      wrapped === true && normalizePrUrl(String(await activeUrlOf())) === null,
      `active url=${JSON.stringify(await activeUrlOf())}`
    )
    check(
      '畳んでいる間は PR タブが増えない',
      (await tabCount()) === collapsedBefore,
      `${collapsedBefore} -> ${await tabCount()}`
    )

    // 開いている: 同じ操作で先頭の PR 行へ入り、その PR のタブが開いて選ばれる
    const firstPr = await readExpanded(ui, `document.querySelector('.lf-row')?.dataset.url ?? ''`)
    await ui.ev(`window.nemo.selectTab(${JSON.stringify(t1)}).then(() => 'ok')`)
    await activeBecame(t1)
    const expandedBefore = await tabCount()
    await runCommand('select-row-below')
    const entered = await until(async () => normalizePrUrl(String(await activeUrlOf())) === firstPr, {
      timeoutMs: 4000,
      interval: 50
    })
    check(
      '開いている小見出しなら最下段から ↓ で先頭の PR 行へ入り、その PR のタブが選ばれる',
      entered === true && firstPr !== '',
      `first=${JSON.stringify(firstPr)} active=${JSON.stringify(await activeUrlOf())}`
    )
    check(
      'PR 行に入った手でタブが 1 枚増える',
      (await tabCount()) === expandedBefore + 1,
      `${expandedBefore} -> ${await tabCount()}`
    )

    // 後始末: 開いた PR タブは実 github.com を読むので必ず閉じる（残すと後続の行数がずれる）
    for (const key of JSON.parse(
      await ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.map((t) => t.key)))')
    )) {
      if (key !== t0 && key !== t1)
        await ui.ev(`window.nemo.closeTab(${JSON.stringify(key)}).then(() => 'ok')`)
    }
    await sleep(300)
  }

  /* ---- ⑦ 打ち切り（片方だけ 101 件以上） ---- */
  const bulk = Array.from({ length: 100 }, (_unused, index) =>
    mine({
      repo: 'acme/bulk',
      number: 1000 + index,
      title: `bulk ${index}`,
      author: 'octo-dev',
      updatedAt: '2026-08-20T00:00:00Z'
    })
  )
  serve(okBody([...BASE.filter((item) => item.__bucket === 'review'), ...bulk], { mineTotal: 137 }))
  await refresh(ui)
  await until(async () => (await liveState(ui))?.truncation?.mine !== null)
  let state = await liveState(ui)
  const mineCount = state.items.filter((item) => item.bucket === 'mine').length
  check(
    '⑦ 100 件で止まる（サーバは 137 件と申告 / 返したのは 100 件）',
    state.truncation.mine?.returned === 100 && state.truncation.mine?.total === 137 && mineCount === 100,
    `returned=${state.truncation.mine?.returned} total=${state.truncation.mine?.total} mine=${mineCount} 件`
  )
  check(
    '⑦ 切られていない側は null のまま',
    state.truncation.review === null,
    JSON.stringify(state.truncation.review)
  )
  const subheads = JSON.parse(
    await ui.ev(
      `JSON.stringify([...document.querySelectorAll('.lf-sub')].map((e) => e.innerText.replace(/\\s+/g, ' ')))`
    )
  )
  check(
    '⑦ 小見出しの右はバケットに割り当てられた件数のまま（137 や total を名乗らない）',
    subheads.some((text) => /CREATED 100/i.test(text)) && !subheads.some((text) => text.includes('137')),
    JSON.stringify(subheads)
  )
  const truncatedLines = JSON.parse(await readExpanded(ui, TRUNCATED))
  check(
    '⑦ 末尾に First 100 of 137 fetched for CREATED が1行だけ',
    truncatedLines.length === 1 && /First 100 of 137 fetched for/i.test(truncatedLines[0]),
    JSON.stringify(truncatedLines)
  )
  const controlsWithTruncation = await ui.ev(
    `${sub('mine')}.getAttribute('aria-controls').split(' ').every((id) => document.getElementById(id) !== null) && ${sub('mine')}.getAttribute('aria-controls').includes('lf-truncated-mine')`
  )
  check(
    'aria-controls が打ち切り行も指し、参照先が実在する（打ち切りあり）',
    controlsWithTruncation === true,
    ''
  )
  await collapseAll(ui)
  const truncAll = await ui.ev(countOf('.lf-truncated'))
  const truncVisibleClosed = await ui.ev(countOf('.lf-truncated:not([hidden])'))
  await ui.ev(`${sub('mine')}.click()`)
  const truncVisibleOpen = await until(async () =>
    (await ui.ev(countOf('.lf-truncated:not([hidden])'))) === 1 ? 1 : 0
  )
  check(
    '打ち切り行は小見出しを畳むと隠れ、開くと戻る（DOM からは消えない）',
    truncAll === 1 && truncVisibleClosed === 0 && truncVisibleOpen === 1,
    `全 ${truncAll} / 閉 ${truncVisibleClosed} / 開 ${truncVisibleOpen}`
  )

  // 重複除外で mine が空になっても打ち切り行は隠れない（小見出しが無いと開く手段が無い）
  const dupAsMine = BASE.filter((item) => item.__bucket === 'review').map((item) => ({
    __bucket: 'mine',
    node: item.node
  }))
  serve(okBody([...BASE.filter((item) => item.__bucket === 'review'), ...dupAsMine], { mineTotal: 150 }))
  await refresh(ui)
  await until(async () => (await liveState(ui))?.truncation?.mine?.total === 150)
  const dupMineSubs = await ui.ev(countOf('.lf-bucket[data-bucket="mine"]'))
  const dupMineItems = (await liveState(ui)).items.filter((item) => item.bucket === 'mine').length
  const dupTruncVisible = await until(async () =>
    (await ui.ev(countOf('.lf-truncated:not([hidden])'))) === 1 ? 1 : 0
  )
  check(
    '重複除外で小見出しが無いバケットの打ち切り行は初期折りたたみでも見える',
    dupMineSubs === 0 && dupMineItems === 0 && dupTruncVisible === 1,
    `mine 小見出し ${dupMineSubs} / mine 件数 ${dupMineItems} / 打ち切り行（可視） ${dupTruncVisible}`
  )
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  /* ---- ⑤ 500 でも行が消えない ---- */
  serve({ status: 500, headers: {}, body: { message: 'boom' } })
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure?.kind === 'transient')
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check('⑤ 500 でも行が消えない', titles.length === 3, `${titles.length} 行`)
  check('⑤ 末尾行が失敗表示になる', (await ui.ev(SECTION_TEXT)).includes("Couldn't refresh"), '')
  check(
    '⑤ 行の opacity が落ちる（stale）',
    (await readExpanded(ui, STALE_ROWS)) === 3,
    `stale ${await readExpanded(ui, STALE_ROWS)} 行`
  )
  check('⑭ 500 は transient（Couldn’t refresh）', (await liveState(ui)).failure.kind === 'transient', '')

  /* ---- ⑯ transient のバックオフ中でも手動は投げられる ---- */
  resetCounters()
  await refresh(ui)
  await waitRequests(1, 5000)
  check('⑯ transient のバックオフ中は手動で投げられる', total >= 1, `リクエスト ${total} 回`)

  /* ---- ⑥ HTTP 200 + errors でも行が消えない（⑤とは別経路） ---- */
  serve({ status: 200, headers: {}, body: { errors: [{ message: 'Something went wrong' }] } })
  await refresh(ui)
  await sleep(600)
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check('⑥ HTTP 200 + errors でも行が消えない', titles.length === 3, `${titles.length} 行`)
  check(
    '⑥ 失敗として扱われる',
    (await liveState(ui)).failure !== null,
    JSON.stringify((await liveState(ui)).failure)
  )

  /* ---- ⑲ / ㉕ 待ち時間（バックオフ）を値で確かめる ---- */
  // **先に1回成功させてバックオフを初期値に戻す。** これをやらないと
  // ここまでの失敗で伸びきった値を見ることになり、「60s → 120s」を撃てない
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure === null)
  const backoffBefore = logEvents('live_folder.backoff').length
  serve({ status: 500, headers: {}, body: { message: 'boom' } })
  await refresh(ui)
  await sleep(500)
  await refresh(ui)
  await sleep(700)
  let backoffs = logEvents('live_folder.backoff').slice(backoffBefore)
  const transientWaits = backoffs.filter((entry) => entry.kind === 'transient').map((entry) => entry.waitMs)
  const BACKOFF_MIN = timings.liveFolderBackoffMinMs
  check(
    `⑲ transient のバックオフは ${BACKOFF_MIN}ms → ${BACKOFF_MIN * 2}ms と倍々になる`,
    transientWaits.length >= 2 &&
      transientWaits.at(-2) === BACKOFF_MIN &&
      transientWaits.at(-1) === BACKOFF_MIN * 2,
    `waitMs=${JSON.stringify(transientWaits.slice(-2))}`
  )

  /*
   * ⑲ タイマーがバックオフを迂回しない。
   *
   * **観測窓はいまのバックオフ（= 初期値の 2 倍）の 3 割**にする。正確な待ち時間は上の waitMs で見る。
   * 3 割にするのは、窓がバックオフを超えると「待ちが明けたから飛んだ」と区別が付かなくなるため。
   * 同時に**タイマーが何度も起きる長さ**でなければ空振りするので、tick の 5 倍を下限にする。
   *
   * これは否定形の検査だが、**同じプロセスで後の ⑮ が「時が来れば必ず 1 回飛ぶ」を撃つ**ので、
   * 「タイマーが死んでいるから飛ばない」ではないことはそちらで担保される。
   */
  resetCounters()
  const observeMs = Math.max(timings.liveFolderTickMs * 5, Math.round(BACKOFF_MIN * 2 * 0.3))
  console.log(`[verify-live-folder] バックオフ中に何も飛ばないことを ${observeMs}ms 観測する…`)
  await sleep(observeMs)
  check('⑲ バックオフ中はタイマーが起きても投げない', total === 0, `${observeMs}ms で ${total} 回`)

  /* ---- ㉕ 503 + Retry-After: 120 ---- */
  const before503 = logEvents('live_folder.backoff').length
  serve({ status: 503, headers: { 'retry-after': '120' }, body: { message: 'unavailable' } })
  await refresh(ui)
  await sleep(700)
  backoffs = logEvents('live_folder.backoff').slice(before503)
  check(
    '㉕ 503 + Retry-After: 120 は transient のまま、次の試行が 120 秒後になる',
    backoffs.at(-1)?.kind === 'transient' && backoffs.at(-1)?.waitMs === 120_000,
    JSON.stringify(backoffs.at(-1))
  )

  /* ---- ⑭ 401 は Reconnect GitHub ---- */
  serve({ status: 401, headers: {}, body: { message: 'Bad credentials' } })
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure?.kind === 'auth')
  check('⑭ 401 は auth', (await liveState(ui)).failure.kind === 'auth', '')
  check(
    '⑭ Reconnect GitHub の1行だけになる',
    (await ui.ev(SECTION_TEXT)).trim() === 'Reconnect GitHub',
    JSON.stringify(await ui.ev(SECTION_TEXT))
  )

  /* ---- ㉔ 403 の権限不足も Reconnect GitHub ---- */
  serve({
    status: 403,
    headers: {},
    body: { errors: [{ message: 'Resource not accessible by personal access token' }] }
  })
  await refresh(ui)
  await sleep(700)
  check(
    '㉔ 403 の権限不足は auth（Couldn’t refresh のまま再試行し続けない）',
    (await liveState(ui)).failure?.kind === 'auth',
    JSON.stringify((await liveState(ui)).failure)
  )

  // 一覧を戻す
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  /* ---- ⑭ / ㉑ rate-limit の各経路 ---- */
  const rateReset = () => Math.floor(Date.now() / 1000) + 900
  serve(() => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(rateReset()) },
    body: { message: 'API rate limit exceeded' }
  }))
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure?.kind === 'rate-limit')
  state = await liveState(ui)
  check(
    '⑭ remaining:0 の 403 は rate-limit（Reconnect GitHub にしない）',
    state.failure.kind === 'rate-limit',
    ''
  )
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check('⑭ rate-limit でも前回の内容を出したまま', titles.length === 3, `${titles.length} 行`)
  const rateText = await ui.ev(SECTION_TEXT)
  check(
    'rate-limit の状態行に残り時間が出る',
    /Rate limited · retrying in \d+m/.test(rateText),
    JSON.stringify(rateText)
  )
  check('rate-limit のときは Retry を出さない', !rateText.includes('Retry'), JSON.stringify(rateText))

  /* ---- ⑯ rate-limit 中は手動を押しても投げない ---- */
  resetCounters()
  await refresh(ui)
  await refresh(ui)
  await sleep(1200)
  check('⑯ rate-limit 中は手動を押しても投げない', total === 0, `リクエスト ${total} 回`)

  /* ---- ㉗ トークン変更の予約は rate-limit 中でも1回だけ ---- */
  resetCounters()
  await savePat(ui, TEST_PAT_B)
  await sleep(1500)
  check('㉗ トークンを変えたら rate-limit 中でも 1 回だけ飛ぶ', total === 1, `リクエスト ${total} 回`)
  resetCounters()
  await refresh(ui)
  await savePat(ui, TEST_PAT_B)
  await sleep(1500)
  check('㉗ その 1 回も rate-limit なら以後は手動でも自動でも投げない', total === 0, `リクエスト ${total} 回`)

  /* ---- ⑰ 別アカウントの一覧が残らない ---- */
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check(
    '⑰ PAT を別のものに替えて取得が失敗したら、前の資格情報の一覧が出ない',
    titles.length === 0,
    `${titles.length} 行: ${JSON.stringify(titles.slice(0, 2))}`
  )

  /* ---- ㉑ secondary rate limit（remaining あり / HTTP 200） ---- */
  // いったん成功させて rate-limit を解く
  serve(okBody(BASE))
  await savePat(ui, TEST_PAT_A)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  serve({
    status: 403,
    headers: { 'x-ratelimit-remaining': '4231', 'retry-after': '45' },
    body: { message: 'You have exceeded a secondary rate limit' }
  })
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure?.kind === 'rate-limit')
  check(
    '㉑ remaining が残っている secondary limit の 403 も rate-limit',
    (await liveState(ui)).failure.kind === 'rate-limit',
    JSON.stringify((await liveState(ui)).failure)
  )

  serve(okBody(BASE))
  await savePat(ui, TEST_PAT_A + 'x')
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  serve({
    status: 200,
    headers: {},
    body: { errors: [{ message: 'You have exceeded a secondary rate limit. Please wait.' }] }
  })
  await refresh(ui)
  await until(async () => (await liveState(ui))?.failure?.kind === 'rate-limit')
  check(
    '㉑ HTTP 200・type なし・本文が secondary limit も rate-limit',
    (await liveState(ui)).failure.kind === 'rate-limit',
    JSON.stringify((await liveState(ui)).failure)
  )

  /* ---- ⑨ 取得の直列化 ---- */
  serve(okBody(BASE))
  await savePat(ui, TEST_PAT_A)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  resetCounters()
  const slowBase = [...BASE]
  serve((n) => {
    const items =
      n === 1
        ? slowBase
        : [
            ...slowBase,
            mine({
              repo: 'acme/last',
              number: 5,
              title: 'LAST',
              author: 'octo-dev',
              updatedAt: '2026-08-27T00:00:00Z'
            })
          ]
    const body = okBody(items)
    return new Promise((resolve) => setTimeout(() => resolve(body), n === 1 ? 1500 : 100))
  })
  await Promise.all([refresh(ui), refresh(ui), refresh(ui), refresh(ui)])
  await sleep(3000)
  check(
    '⑨ 同時実行は常に1本（single-flight）',
    maxInFlight === 1,
    `同時 ${maxInFlight} 本 / 総数 ${total} 回`
  )
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check(
    '⑨ 最後の要求の内容が最終状態になる（古い応答が上書きしない）',
    titles.includes('LAST'),
    JSON.stringify(titles)
  )

  /* ---- ㉖ 遅い取得の実行中に手動 → その取得が rate-limit ---- */
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  resetCounters()
  serve(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(rateReset()) },
              body: { message: 'API rate limit exceeded' }
            }),
          1500
        )
      )
  )
  void refresh(ui)
  await sleep(400)
  void refresh(ui)
  await sleep(3000)
  check(
    '㉖ 実行中の手動で立った予約は rate-limit 観測でキャンセルされる',
    total === 1,
    `リクエスト ${total} 回`
  )
  check(
    '㉖ UI が rate-limit になる',
    (await liveState(ui)).failure?.kind === 'rate-limit',
    JSON.stringify((await liveState(ui)).failure)
  )

  /* ---- ㉖+㉗ 予約の競合: 資格情報の変更を手動更新が押し流さない ---- */
  //
  // 予約を「最後に来た種類」で単純に上書きすると、この順序で
  // **新しい PAT で1度も取得されないまま**旧アカウントのキャッシュが `resetAt` まで残る:
  //   ① 旧 PAT で取得中（応答は遅い rate-limit）
  //   ② 新 PAT を保存 → 予約は `credential`
  //   ③ 手動更新 → 予約が `manual` に化ける
  //   ④ 旧 PAT の応答が rate-limit → `manual` の予約はキャンセルされる
  // **先に rate-limit を解いておく。** 解かないと最初の手動更新がゲートで弾かれ、
  // 「旧 PAT で取得中」の状態そのものを作れない（＝シナリオが再現しないまま PASS する）
  serve(okBody(BASE))
  await savePat(ui, `${TEST_PAT_A}y`)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  // **値は1回だけ読む**（`check` の引数の中で2回読むと、ok と detail が別の瞬間の値になる）
  const beforeRace = await liveState(ui)
  check(
    '㉖+㉗（前提）rate-limit が解けている',
    beforeRace?.failure === null,
    JSON.stringify(beforeRace?.failure)
  )

  resetCounters()
  serve(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(rateReset()) },
              body: { message: 'API rate limit exceeded' }
            }),
          1800
        )
      )
  )
  // ① 旧 PAT で取得中（応答は遅い rate-limit）
  void refresh(ui)
  await sleep(400)
  // ② 資格情報の変更（予約が立つ）
  void savePat(ui, `${TEST_PAT_A}z`)
  await sleep(200)
  // ③ そのあとに手動更新（ここで予約が上書きされると新 PAT の取得が消える）
  void refresh(ui)
  await sleep(4000)
  check(
    '㉖+㉗ 資格情報の変更の予約は手動更新で押し流されない（新 PAT で 1 回は飛ぶ）',
    total === 2,
    `リクエスト ${total} 回（旧 PAT の 1 回 + 新 PAT の 1 回）`
  )

  // rate-limit を解く（次のブロックのため）
  serve(okBody(BASE))
  await savePat(ui, `${TEST_PAT_A}w`)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)

  /* ---- ⑮ 実行中に来た自動の要求は捨てられる ---- */
  //
  // **OS のウィンドウフォーカスは CDP から確実には撃てない**（`Page.bringToFront` では
  // `browser-window-focus` が飛ばない）。focus・タイマー・resume は**同じ経路**
  // （`requestAutomatic` → `requestFetch(kind: 'auto')`）を通るので、
  // タイマーで同じ規則を撃つ。
  //
  // 見るのは2つ:
  //   1. 実行中に来た自動の要求が**世代番号に触れず捨てられる**（リクエストが増えない）
  //   2. **その1回の結果が最終状態として適用される**
  //      （世代を進める順序を間違えると、リクエスト数は1でも結果が捨てられて一覧が空になる）
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  resetCounters()
  // 直前の成功で次の自動取得は `liveFolderPollMs` 後。そこでタイマーが**遅い**応答を掴む
  const slowItems = [
    ...BASE,
    mine({
      repo: 'acme/slow',
      number: 9,
      title: 'SLOW',
      author: 'octo-dev',
      updatedAt: '2026-08-28T00:00:00Z'
    })
  ]
  /*
   * 応答を遅らせる長さ。**取得中にタイマーが何度も起きる**必要があるので tick より十分長く、
   * かつ**クライアント側のタイムアウト（15 秒）より短く**する
   * （長いと abort されて transient になり、「結果が適用される」を撃てない）。
   * 本番の tick 5 秒なら 8 秒（元の値）、検証時の短い tick なら比例して短くなる。
   */
  const SLOW_MS = Math.max(2_000, timings.liveFolderTickMs * 1.6)
  serve(() => new Promise((resolve) => setTimeout(() => resolve(okBody(slowItems)), SLOW_MS)))
  console.log(
    `[verify-live-folder] 自動取得（${timings.liveFolderPollMs}ms 後）が ${SLOW_MS}ms かかる状況を観測する…`
  )
  const started = await until(() => total >= 1, {
    timeoutMs: timings.liveFolderPollMs + 20_000,
    interval: Math.min(500, Math.max(50, Math.round(timings.liveFolderTickMs / 4)))
  })
  check(
    `⑮ ${timings.liveFolderPollMs}ms 後にタイマーが自動取得を1回始める`,
    started === true,
    `リクエスト ${total} 回`
  )
  // 取得中のあいだ、タイマーは tick ごとに起きて条件を見る。ここで予約が立つと2回目が飛ぶ
  await sleep(SLOW_MS + timings.liveFolderTickMs)
  check(
    '⑮ 実行中に来た自動の要求は捨てられる（取得は1回のまま）',
    total === 1,
    `リクエスト ${total} 回（${timings.liveFolderTickMs}ms ごとのタイマーが ${SLOW_MS}ms の取得中に起きている）`
  )
  titles = JSON.parse(await readExpanded(ui, ROW_TITLES))
  check(
    '⑮ その1回の結果が最終状態として適用される（世代の順序を間違えると捨てられる）',
    titles.includes('SLOW'),
    JSON.stringify(titles)
  )

  /* ---- ⑬ 設定で無効 / 有効 ---- */
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  await setEnabled(ui, false)
  const gone = await until(async () => ((await ui.ev(HAS_SECTION)) === false ? 'gone' : ''), {
    timeoutMs: 3000
  })
  check('⑬ 設定で無効にした瞬間にセクションが消える（60秒待たない）', gone === 'gone', String(gone))
  resetCounters()
  await setEnabled(ui, true)
  const back = await until(async () => ((await ui.ev(HAS_SECTION)) === true ? 'back' : ''), {
    timeoutMs: 3000
  })
  check('⑬ 戻した瞬間に出る', back === 'back', String(back))
  await waitRequests(1, 5000)
  check('⑬ 有効に戻したら即時に1回取得する', total >= 1, `リクエスト ${total} 回`)

  /* ---- ⑬ 取得中に予約を立ててから無効化する ---- */
  //
  // 予約を残したまま無効にすると、走っていた取得が終わった瞬間に予約ぶんが送信され、
  // **無効にしたのに GitHub へ1回つなぎに行く**。
  serve(okBody(BASE))
  await refresh(ui)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  resetCounters()
  serve(() => new Promise((resolve) => setTimeout(() => resolve(okBody(BASE)), 2000)))
  void refresh(ui) // ① 遅い取得が走り出す
  await sleep(500)
  const reservedState = await liveState(ui)
  check(
    '⑬（前提）遅い取得が実行中である',
    reservedState?.loading === true && total === 1,
    `loading=${reservedState?.loading} / リクエスト ${total} 回`
  )
  void refresh(ui) // ② 予約が立つ
  await sleep(200)
  await setEnabled(ui, false) // ③ 予約を残したまま無効化
  await sleep(3500) // ④ 走っていた取得が終わるまで待つ
  check(
    '⑬ 無効化したら予約済みの取得も捨てる（GitHub につなぎに行かない）',
    total === 1,
    `リクエスト ${total} 回（実行中の 1 回だけ。予約ぶんが飛ぶと 2 回になる）`
  )
  check(
    '⑬ 無効のままセクションは出ない',
    (await ui.ev(HAS_SECTION)) === false,
    String(await ui.ev(HAS_SECTION))
  )
  // 戻して、取得中の表示のまま止まっていないことも見る
  serve(okBody(BASE))
  await setEnabled(ui, true)
  await until(async () => JSON.parse(await readExpanded(ui, ROW_TITLES)).length === 3)
  const revived = await liveState(ui)
  check(
    '⑬ 戻したあと「取得中」のまま止まらない',
    revived?.loading === false && revived?.items.length === 3,
    `loading=${revived?.loading} / ${revived?.items.length} 行`
  )

  /* ---- ㉓ 一覧に無い URL は開かない ---- */
  const beforeTabs = JSON.parse(
    await ui.ev(`window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.length))`)
  )
  await ui.ev(`window.nemo.liveFolderOpen('https://github.com/evil/repo/pull/1').then(() => 'ok')`)
  await sleep(500)
  const afterTabs = JSON.parse(
    await ui.ev(`window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.length))`)
  )
  check('㉓ 一覧に無い URL を渡しても何も開かない', beforeTabs === afterTabs, `${beforeTabs} → ${afterTabs}`)

  /* ---- ⑧ シークレットウィンドウには出ない ---- */
  await ui.ev(`window.nemo.createPrivateWindow().then(() => 'ok')`)
  const privateUi = await connectUi(CDP, 'sidebar', {
    includePrivate: true,
    waitReady: false,
    timeoutMs: 15000
  })
  // シークレット側の target を確実につかむ
  const privateSection = await privateUi.ev(
    `JSON.stringify({ private: location.search.includes('private=1'), has: ${HAS_SECTION} })`
  )
  const parsedPrivate = JSON.parse(privateSection)
  if (!parsedPrivate.private) {
    skip('⑧ シークレットウィンドウにはセクションが出ない', 'シークレットの UI target をつかめなかった')
  } else {
    check('⑧ シークレットウィンドウにはセクションが出ない', parsedPrivate.has === false, privateSection)
    const privateShared = JSON.parse(await privateUi.ev(LIVE_STATE))
    check(
      '⑧ SharedState の時点で渡していない（liveFolder が null）',
      privateShared === null,
      JSON.stringify(privateShared)
    )
  }
  privateUi.close()

  /* ---- ⑫ PAT を消したら即 Connect GitHub ---- */
  await clearPat(ui)
  const backToConnect = await until(async () => ((await liveState(ui))?.source === 'none' ? 'none' : ''), {
    timeoutMs: 5000
  })
  check('⑫ PAT を消したら即時に Connect GitHub へ戻る', backToConnect === 'none', String(backToConnect))

  ui.close()
}

/* ------------------------------------------------------------------ *
 * 実行
 * ------------------------------------------------------------------ */

const mode = process.argv.includes('--restart-write')
  ? 'restart-write'
  : process.argv.includes('--restart-read')
    ? 'restart-read'
    : 'main'

try {
  if (mode === 'restart-write') restartWrite()
  else if (mode === 'restart-read') await restartRead()
  else await main()
} catch (error) {
  failures += 1
  console.error(`[verify-live-folder] ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  server.close()
}

if (mode !== 'restart-write') {
  const note = skipped > 0 ? `（SKIP ${skipped} 件）` : ''
  console.log(failures === 0 ? `\nLive Folder: PASS${note}` : `\nLive Folder: FAIL ${failures} 件${note}`)
}
process.exit(failures === 0 ? 0 : 1)
