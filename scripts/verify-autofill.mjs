#!/usr/bin/env node
/**
 * フォーム自動入力の検証（`mise run verify:only autofill`）。
 *
 * 入れる値は kypr の個人情報（plan `2026-09-29-0934-kypr-identity-autofill.md`）。kypr の模擬サーバーに保管庫を作り、
 * 「別の端末」として Node 側（Web と同じクライアント）から個人情報を足す。
 *
 * 見るもの:
 *   1. kypr に未ログイン・個人情報が 0 件なら入れずに `kypr-signed-out` / `no-identity`（ポップアップへ誘導する合図）
 *   2. Jev のキーは Mac ごとに端末鍵で暗号化して保存する（ファイルに平文が無い）
 *   3. ロック中でも Touch ID で解除して入れる。右クリックの自動入力と同じ処理で、ルール（autocomplete / type）と
 *      Jev の両方の欄が入る。分割された電話・生年月日・select・カナ・郵便番号の書式まで**値で**見る
 *   4. **入れてはいけない欄に入らない**: 既に値のある欄・パスワード・本人でない欄（紹介者）・
 *      お問い合わせ内容・フォームの外の欄・**見えない罠 5 種**
 *   5. **Jev に値を送っていない**（モックが受け取った body 全体を見る）。罠とフォームの外の欄も送っていない
 *   6. React の valueTracker をまねた欄で変更イベントが拾われる（isolated world の native setter）
 *   7. 身分証: 番号と期限が正しい書類で入る（「有効期限」だけの欄・発行日を挟む並び・和暦の select）。
 *      発行日・発行国・同行者・会員番号・カード払いの「有効期限」には入らない
 *   8. 既定の個人情報を切り替えると、その値が入る
 *   9. Jev が 529 → 再試行で入る / 401・タイムアウト・キー無しでもルールの欄は入る
 *  10. 設定画面に「フォーム自動入力」の節が描かれる（Autofill.tsx の描画例外を拾う）
 *  11. 診断ログに値が出ていない / 未処理の例外が無い
 *  12. 再起動後もキーが残る。Touch ID が通らなければ `kypr-locked` で何も入れない
 *
 * **本物の kypr のサーバー・実 Keychain・実 Touch ID・実 Jev に触らない**:
 *   NEMO_KYPR_TEST_SERVER・NEMO_HTTP_AUTH_TEST_CRYPTO=memory・NEMO_KYPR_TEST_TOUCHID・NEMO_JEV_TEST_ENDPOINT
 *
 * 使い方:
 *   node scripts/verify-autofill.mjs   （事前に out/ がビルドされていること）
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
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { connectTo, connectUi, waitFor } from './lib/cdp.mjs'
import { createKyprVault, profileToKypr as toKypr } from './lib/kypr-fixture.mjs'
import { newIdentityItem } from '../src/vendor/kypr/crypto/index.ts'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const PASSWORD = 'nemo-verify-autofill マスター'
const JEV_KEY = 'apikey_verify_0123456789abcdef'

const PROFILE = {
  family_name: '山田',
  given_name: '太郎',
  family_name_kana: 'ヤマダ',
  given_name_kana: 'タロウ',
  family_name_roman: 'Yamada',
  given_name_roman: 'Taro',
  email: 'taro@example.com',
  tel: '090-1234-5678',
  postal_code: '100-0001',
  address_level1: '東京都',
  address_level2: '千代田区',
  address_line1: '千代田1-1',
  address_line2: 'サンプルタワー 1701',
  birthday: '1988-07-14',
  gender: 'male',
  organization: '株式会社サンプル',
  department: '開発部',
  job_title: '代表',
  organization_url: 'https://example.com',
  passport_number: 'TK1234567',
  passport_expiry: '2031-04-30',
  license_number: '987654321098',
  license_expiry: '2029-06-15',
  insurance_symbol: '4321',
  insurance_number: '65',
  insurance_branch: '07',
  insurer_number: '06987654'
}
/** 既定を切り替えたときの 2 件目（新しい方）。メールだけ違う */
const CORP_EMAIL = 'corp-verify@example.com'
/** 送っても書いてもいけない値（2 文字以上のもの）。 */
const SECRETS = [
  ...Object.values(PROFILE).filter((v) => v.length >= 2),
  '09012345678',
  '1000001',
  CORP_EMAIL,
  PASSWORD,
  JEV_KEY
]

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- Jev のモック + テストページ ---------------- */

/** 見出し → 答え（本物の Jev の代わり。`none` と本人性の低い欄も混ぜる）。 */
const ANSWERS = {
  'お名前（姓）': 'family_name',
  'お名前（名）': 'given_name',
  'メールアドレス（確認用）': 'email',
  電話番号: 'tel',
  都道府県: 'address_level1',
  市区町村: 'address_level2',
  生年月日: 'birthday',
  会社名: 'organization',
  ご紹介者のお名前: 'full_name',
  お問い合わせ内容: 'none',
  // autofill-efo.html（th の中に見出しと欄が並ぶ形）
  お名前必須: 'full_name',
  郵便番号: 'postal_code',
  町名番地: 'address_line1',
  建物名: 'address_line2',
  // 罠の欄には**本物らしい項目を答える**（攻撃側のページはそう見せる）。
  // `none` を返すと、可視判定が壊れていても「入らない」検査が PASS してしまう
  '電話番号（予備）': 'tel',
  '氏名（予備）': 'full_name',
  'メール（予備）': 'email',
  '住所（予備）': 'address_full',
  '電話（予備）': 'job_title',
  電話番号必須: 'tel',
  // autofill-patterns.html
  '氏 名': 'full_name',
  '氏 名（全角フリガナ）': 'full_name_kana',
  // 本物の Jev は FAX に tel と答えた。聞かれたら入ってしまうので、聞かないことを見る
  FAX番号: 'tel',
  'ご住所（建物名まで）': 'address_full',
  // autofill-documents.html（身分証）
  旅券番号: 'passport_number',
  発行日: 'none',
  有効期限: 'document_expiry', // 書類名の無い「有効期限」。カード払いの欄にも同じ答えを返す（本物も取り違えうる）
  発行国: 'none',
  免許証番号: 'license_number',
  交付日: 'none',
  免許の色: 'none',
  記号: 'insurance_symbol',
  番号: 'insurance_number',
  枝番: 'insurance_branch',
  保険者番号: 'insurer_number',
  同行者の旅券番号: 'passport_number', // 本人でない（NOT_OWN）
  会員番号: 'passport_number', // 確からしさが身分証の足切りに届かない（CONFIDENCE）
  カード番号: 'none'
}
/** 確信度を変える欄（無ければ 0.9）。 */
const CONFIDENCE = { 会員番号: 0.6 }
/**
 * 本物の Jev をまねた答え（見出し → [選択肢, 確率の分布]）。2 枠の氏名で 1 枠目の例「姓」に引っ張られる
 * （2026-09-27 に実 Jev で測った値）。無ければ `ANSWERS` の選択肢を確信度 0.9 で返す
 */
const SPLIT_ANSWERS = {
  氏名必須: ['family_name', { family_name: 0.53, full_name: 0.47 }, 0.49],
  ふりがな必須: [
    'family_name_kana',
    { family_name_kana: 0.77, full_name_kana: 0.21, given_name_kana: 0.02 },
    0.75
  ]
}
const NOT_OWN = new Set(['ご紹介者のお名前', 'お問い合わせ内容', '同行者の旅券番号'])

let mode = 'ok'
let calls = 0
const requests = []

function jevAnswer(body) {
  const answers = {}
  for (const [id, question] of Object.entries(body.questions ?? {})) {
    const field = question.instructions?.field ?? {}
    const label = field.label || field.nearby_text || ''
    if (id.startsWith('own')) {
      answers[id] = { type: 'noul', noul: NOT_OWN.has(label) ? 0.05 : 0.93 }
    } else {
      const split = SPLIT_ANSWERS[label]
      if (split) {
        answers[id] = { type: 'choice', choice: split[0], confidence: split[2], probabilities: split[1] }
        continue
      }
      const choice = ANSWERS[label] ?? 'none'
      const confidence = CONFIDENCE[label] ?? 0.9
      answers[id] = { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } }
    }
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname
  if (
    [
      '/autofill.html',
      '/autofill-efo.html',
      '/autofill-kayac.html',
      '/autofill-patterns.html',
      '/autofill-documents.html'
    ].includes(pathname)
  ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(path.join(projectRoot, 'test-pages', pathname.slice(1))))
    return
  }
  // iframe の埋め込みフォーム。同じオリジン（同じプロセス）と、localhost 経由の別オリジン（別プロセス。
  // HubSpot や Brevo の埋め込みと同じ形）を 1 つずつ置く
  if (pathname === '/autofill-iframe.html') {
    const { port } = server.address()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>埋め込みフォーム</title>' +
        '<p>フォームは iframe の中にある</p>' +
        '<iframe id="same" src="/autofill-kayac.html?same" width="600" height="300"></iframe>' +
        `<iframe id="cross" src="http://localhost:${port}/autofill-kayac.html?cross" width="600" height="300"></iframe>` +
        // 親が透明にした iframe（中の可視判定だけでは見抜けない。透明な iframe を重ねる手口）
        `<iframe id="hidden" style="opacity:0" src="http://localhost:${port}/autofill-kayac.html?hidden" width="600" height="300"></iframe>` +
        // 親が上の帯（高さ 30px）だけを見せている iframe。帯の外の欄は、中をスクロールしても見えない
        `<div style="overflow:hidden;height:30px"><iframe id="band" src="http://localhost:${port}/autofill-kayac.html?band" width="600" height="300"></iframe></div>` +
        // 同じ URL の iframe が 2 つ（フォーカスのある方だけに入れる）
        '<iframe id="dup1" src="/autofill-kayac.html?dup" width="600" height="300"></iframe>' +
        '<iframe id="dup2" src="/autofill-kayac.html?dup" width="600" height="300"></iframe>'
    )
    return
  }
  if (req.url !== '/v1/systemone' || req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', async () => {
    calls += 1
    requests.push({ auth: req.headers.authorization, raw })
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"detail":{"error_type":"authentication_error"}}')
      return
    }
    if (mode === '529-then-ok' && calls === 1) {
      res.writeHead(529, { 'retry-after': '0' })
      res.end()
      return
    }
    if (mode === 'slow') await sleep(4500)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(jevAnswer(JSON.parse(raw))))
  })
})

/* ---------------- 起動 ---------------- */

const spawned = []
const dirs = []
function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-autofill-${tag}-`))
  dirs.push(dir)
  return dir
}

/** @type {Awaited<ReturnType<typeof createKyprVault>> | null} */
let kypr = null
/** `autofillForVerify` を呼んだ回数（ログの `autofill.run` の件数と突き合わせる）。 */
let runCount = 0

try {
  assertNemoNotRunning('verify-autofill')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js')))
    throw new Error('out/ が無い。先に pnpm build する')

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  // kypr の保管庫を作る（Web と同じクライアント。個人情報は後から「別の端末」として足す）
  kypr = await createKyprVault(PASSWORD)
  const { origin: kyprOrigin, other } = kypr

  const userData = makeDir('data')
  // やめた保管庫のパスフレーズの記憶（起動で消えることを見る）
  fs.writeFileSync(path.join(userData, 'autofill-vault-key.json'), '{"encrypted":"x"}')

  /** 1 回ぶん起動する。Live Folder は settings.json で止める（使い捨てプロファイルでも gh の実トークンで GitHub を叩き続ける） */
  const bootApp = async (dataDir, touchId = 'ok') => {
    const settingsFile = path.join(dataDir, 'settings.json')
    if (!fs.existsSync(settingsFile))
      fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, data: { liveFolderEnabled: false } }))
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
        NEMO_JEV_TEST_ENDPOINT: `${origin}/v1/systemone`,
        NEMO_KYPR_TEST_SERVER: kyprOrigin,
        NEMO_KYPR_TEST_TOUCHID: touchId,
        NEMO_KYPR_TEST_CLIPBOARD: 'memory',
        NEMO_VERIFY_DIAGNOSTICS: '1',
        NEMO_DOWNLOAD_DIR: makeDir('dl')
      }
    })
    spawned.push(child)
    await waitForHttp(`${cdp}/json/list`, {
      child,
      check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
    })
    return cdp
  }

  const cdp = await bootApp(userData)
  const ui = await connectUi(cdp)
  const json = async (expression) => JSON.parse(await ui.ev(`${expression}.then(JSON.stringify)`))
  check(
    'やめた保管庫のパスフレーズの記憶は起動で消えた',
    !fs.existsSync(path.join(userData, 'autofill-vault-key.json'))
  )

  const tabKey = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${origin}/autofill.html`)}).then((k) => k)`
  )
  const page = await connectTo(cdp, '/autofill.html', { type: 'page' })
  await waitFor(page, "document.readyState === 'complete' && document.getElementById('sei') ? 'ok' : ''")

  const reload = async () => {
    await page.ev('window.__before = 1')
    await page.send('Page.reload')
    await waitFor(
      page,
      "typeof window.__before === 'undefined' && document.readyState === 'complete' && document.getElementById('sei') ? 'ok' : ''"
    )
  }
  const point = async () =>
    JSON.parse(
      await page.ev(
        "(() => { const r = document.getElementById('sei').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) })()"
      )
    )
  /** 右クリックの自動入力と同じ処理（`runAutofill`）を検証の口から呼ぶ。 */
  const autofillAt = (key, x, y, frameUrl) => {
    runCount += 1
    return json(
      `window.nemo.autofillForVerify(${JSON.stringify(key)}, ${x}, ${y}${frameUrl ? `, ${JSON.stringify(frameUrl)}` : ''})`
    )
  }
  const run = async () => {
    const { x, y } = await point()
    return autofillAt(tabKey, x, y)
  }
  const countedJson = (expression) => {
    runCount += 1
    return json(expression)
  }
  const values = async () =>
    JSON.parse(
      await page.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input, select, textarea')].map((el) => [el.name, el.value])))"
      )
    )

  /* ---- 1. kypr に未ログイン・個人情報が無い ---- */
  const signedOut = await run()
  check(
    '未ログインなら kypr-signed-out で何も入れない',
    signedOut?.reason === 'kypr-signed-out' && signedOut.filled === 0,
    JSON.stringify(signedOut)
  )
  const signIn = await json(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true)`)
  check('kypr にログインできた（Touch ID を覚える）', signIn.ok === true, JSON.stringify(signIn))
  const noIdentity = await run()
  check(
    '個人情報が 0 件なら no-identity で何も入れない',
    noIdentity?.reason === 'no-identity' && noIdentity.filled === 0,
    JSON.stringify(noIdentity)
  )
  check('入れないときは Jev を呼ばない', calls === 0, `calls=${calls}`)

  // 「別の端末」から個人情報を 2 件足す（古い方が既定になる）
  const mine = newIdentityItem({ name: '自分', ...toKypr(PROFILE), createdAt: '2026-01-01T00:00:00.000Z' })
  const corp = newIdentityItem({
    name: '会社',
    ...toKypr({ ...PROFILE, email: CORP_EMAIL }),
    createdAt: '2026-02-01T00:00:00.000Z'
  })
  await other.create([corp, mine])
  const synced = await json('window.nemo.kyprSync()')
  check('Nemo で同期して個人情報を受け取った', synced.ok === true, JSON.stringify(synced))
  const panel = await json('window.nemo.kyprPanel()')
  check(
    '既定の個人情報は一番古いもの（自分）',
    panel.autofillIdentityId === mine.id &&
      panel.items.filter((item) => item.kind === 'identity').length === 2,
    JSON.stringify({ id: panel.autofillIdentityId, mine: mine.id })
  )
  const identityRow = panel.items.find((item) => item.id === mine.id)
  check(
    '一覧の 2 行目は氏名だけ（身分証の番号を出さない）',
    identityRow?.subtitle === '山田 太郎',
    JSON.stringify(identityRow?.subtitle)
  )

  /* ---- 2. Jev のキー（Mac ごと） ---- */
  const initial = await json('window.nemo.autofillStatus()')
  check(
    '最初はキーが無い',
    initial.hasJevKey === false && initial.encryptionAvailable,
    JSON.stringify(initial)
  )
  const saved = await json(`window.nemo.saveJevKey(${JSON.stringify(JEV_KEY)})`)
  check('キーを保存できた', saved === true, JSON.stringify(saved))
  const keyFile = path.join(userData, 'jev-key.json')
  const keyRaw = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : ''
  check(
    'キーのファイルに平文が現れない',
    keyRaw !== '' && !keyRaw.includes(JEV_KEY),
    `${keyRaw.length} bytes`
  )
  check('状態: キーあり', (await json('window.nemo.autofillStatus()')).hasJevKey === true)

  // ロックしてから入れる（Touch ID で解除して続ける）
  await ui.ev('window.nemo.kyprLock().then(() => "ok")')
  check('ロックした', (await json('window.nemo.kyprStatus()')).state === 'locked')

  /* ---- 3〜6. 自動入力 ---- */
  await reload()
  requests.length = 0
  calls = 0
  const result = await run()
  const got = await values()
  check('自動入力が成功した', result?.ok === true, JSON.stringify(result))
  check(
    'ロック中でも Touch ID で解除して入れた',
    (await json('window.nemo.kyprStatus()')).state === 'unlocked'
  )
  check(
    '欄の数・ルール・Jev・残りが想定どおり（16 欄 = ルール 6 + Jev 8 + 残り 2）',
    result?.fields === 16 && result.rule === 6 && result.jev === 8 && result.left === 2,
    JSON.stringify(result)
  )
  check('入力要素 18 個に入った（分割グループは要素ごと）', result?.filled === 18, String(result?.filled))
  const expected = {
    sei: '山田',
    mei: '太郎',
    kana_sei: 'ヤマダ',
    kana_mei: 'タロウ',
    mail: 'taro@example.com',
    mail_confirm: 'taro@example.com',
    tel1: '090',
    tel2: '1234',
    tel3: '5678',
    zip: '1000001',
    // autocomplete を持つ 2 欄が 1 行に並んでも、1 欄ずつルールで入る
    addr1: '千代田1-1',
    addr2: 'サンプルタワー 1701',
    pref: '13',
    city: '千代田区',
    by: '1988',
    bm: '7',
    bd: '14',
    company: '株式会社サンプル'
  }
  for (const [name, want] of Object.entries(expected)) {
    check(`${name} に ${want}`, got[name] === want, `got=${JSON.stringify(got[name])}`)
  }
  const untouched = {
    busho: '営業部',
    referrer: '',
    pw: '',
    body: '',
    q: '',
    trap_display: '',
    trap_opacity: '',
    trap_offscreen: '',
    trap_clip: '',
    trap_tiny: ''
  }
  for (const [name, want] of Object.entries(untouched)) {
    check(`${name} は触らない`, got[name] === want, `got=${JSON.stringify(got[name])}`)
  }
  const reactLog = await page.ev("document.getElementById('react-log').textContent")
  check(
    'React の valueTracker をまねた欄で変更が拾われた',
    reactLog === 'changed:株式会社サンプル',
    JSON.stringify(reactLog)
  )

  check('Jev を 1 回だけ呼んだ', requests.length === 1, `requests=${requests.length}`)
  check('Authorization に保存したキーが載っている', requests[0]?.auth === `Bearer ${JEV_KEY}`)
  const sent = requests.map((r) => r.raw).join('\n')
  /*
   * **ページ自体に書いてある文字列は外して見る**（都道府県の select の見本「東京都」は
   * ページの中身で、送ってよい）。外しすぎて空振りしていないことを件数で示す
   */
  const pageHtml = fs.readFileSync(path.join(projectRoot, 'test-pages/autofill.html'), 'utf8')
  const watched = SECRETS.filter((s) => s !== JEV_KEY && !pageHtml.includes(s))
  const leaked = watched.filter((s) => sent.includes(s))
  check(
    'Jev に値を 1 つも送っていない',
    leaked.length === 0 && watched.length >= 18,
    leaked.length > 0 ? leaked.join(', ') : `見た値 ${watched.length} 個`
  )
  const trapSent = ['trap_', '"q"', 'サイト内検索', '（予備）'].filter((s) => sent.includes(s))
  check('見えない罠とフォームの外の欄を Jev に送っていない', trapSent.length === 0, trapSent.join(', '))
  const body = JSON.parse(requests[0]?.raw ?? '{}')
  const asked = Object.keys(body.questions ?? {}).filter((k) => k.startsWith('f')).length
  check('Jev にはルールで決まらない 10 欄だけ聞いた', asked === 10, `asked=${asked}`)
  check('モデルは版を固定している', body.model === 'jev-1.13.0', String(body.model))

  /* ---- 6b. 表の中に見出しと欄が並ぶ形（実在の EFO サンプルと同じ組み方） ---- */
  {
    const efoKey = await ui.ev(
      `window.nemo.createTab(${JSON.stringify(`${origin}/autofill-efo.html`)}).then((k) => k)`
    )
    const efo = await connectTo(cdp, '/autofill-efo.html', { type: 'page' })
    await waitFor(
      efo,
      "document.readyState === 'complete' && document.querySelector('[name=text2]') ? 'ok' : ''"
    )
    const at = JSON.parse(
      await efo.ev(
        "(() => { const r = document.querySelector('[name=text2]').getBoundingClientRect(); return JSON.stringify({ x: r.left + 5, y: r.top + 5 }) })()"
      )
    )
    const efoResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(efoKey)}, ${at.x}, ${at.y})`
    )
    const efoValues = JSON.parse(
      await efo.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input, select')].map((el) => [el.name, el.value])))"
      )
    )
    const efoWant = {
      text2: '山田　太郎', // 例が全角空白区切りなら全角（収集で潰さない）
      text9: '100',
      text10: '0001',
      select: '東京都',
      text4: '千代田区',
      text41: '千代田1-1',
      text42: 'サンプルタワー 1701'
    }
    for (const [name, want] of Object.entries(efoWant)) {
      check(
        `表の中の見出し: ${name} に ${want}`,
        efoValues[name] === want,
        `got=${JSON.stringify(efoValues[name])} ${JSON.stringify(efoResult)}`
      )
    }
    efo.close()
  }

  /* ---- 6c. 姓名が 2 枠に分かれ、Jev が 1 枠目の例に引っ張られる形（実在の問い合わせフォームと同じ組み方） ---- */
  {
    const kayacKey = await ui.ev(
      `window.nemo.createTab(${JSON.stringify(`${origin}/autofill-kayac.html`)}).then((k) => k)`
    )
    const kayac = await connectTo(cdp, '/autofill-kayac.html', { type: 'page' })
    await waitFor(
      kayac,
      "document.readyState === 'complete' && document.querySelector('[name=tel]') ? 'ok' : ''"
    )
    const at = JSON.parse(
      await kayac.ev(
        "(() => { const r = document.querySelector('[name=tel]').getBoundingClientRect(); return JSON.stringify({ x: r.left + 5, y: r.top + 5 }) })()"
      )
    )
    const kayacResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(kayacKey)}, ${at.x}, ${at.y})`
    )
    const kayacValues = JSON.parse(
      await kayac.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.name, el.value])))"
      )
    )
    const kayacWant = {
      last_name: '山田',
      first_name: '太郎',
      last_name_kana: 'やまだ',
      first_name_kana: 'たろう',
      // 例が「090XXXXXXXX」ならハイフンなし
      tel: '09012345678'
    }
    for (const [name, want] of Object.entries(kayacWant)) {
      check(
        `2 枠の姓名: ${name} に ${want}`,
        kayacValues[name] === want,
        `got=${JSON.stringify(kayacValues[name])} ${JSON.stringify(kayacResult)}`
      )
    }
    kayac.close()
  }

  /* ---- 6d. iframe の中のフォーム（同じプロセス / 別プロセス） ---- */
  {
    const frameKey = await ui.ev(
      `window.nemo.createTab(${JSON.stringify(`${origin}/autofill-iframe.html`)}).then((k) => k)`
    )
    const host = await connectTo(cdp, '/autofill-iframe.html', { type: 'page' })
    await waitFor(
      host,
      "document.readyState === 'complete' && document.getElementById('same')?.contentDocument?.querySelector('[name=tel]') ? 'ok' : ''"
    )
    const port = server.address().port
    const want = {
      last_name: '山田',
      first_name: '太郎',
      last_name_kana: 'やまだ',
      first_name_kana: 'たろう',
      tel: '09012345678'
    }
    const cases = [
      ['同じプロセスの iframe', `${origin}/autofill-kayac.html?same`],
      ['別プロセスの iframe', `http://localhost:${port}/autofill-kayac.html?cross`]
    ]
    for (const [name, frameUrl] of cases) {
      const r = await countedJson(
        `window.nemo.autofillForVerify(${JSON.stringify(frameKey)}, -1, -1, ${JSON.stringify(frameUrl)})`
      )
      const inner = await connectTo(cdp, frameUrl.split('/').pop(), {
        type: frameUrl.startsWith(origin) ? 'page' : 'iframe'
      }).catch(() => null)
      const read =
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.name, el.value])))"
      const got = frameUrl.startsWith(origin)
        ? JSON.parse(
            await host.ev(
              `(() => { const document = window.document.getElementById('same').contentDocument; return ${read} })()`
            )
          )
        : JSON.parse((await inner?.ev(read)) ?? '{}')
      inner?.close()
      check(
        `${name}: 入った`,
        Object.entries(want).every(([k, v]) => got[k] === v),
        `${JSON.stringify(got)} ${JSON.stringify(r)}`
      )
    }
    // 透明な iframe には入れない
    const hiddenUrl = `http://localhost:${port}/autofill-kayac.html?hidden`
    const hiddenResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(frameKey)}, -1, -1, ${JSON.stringify(hiddenUrl)})`
    )
    const hiddenFrame = await connectTo(cdp, 'autofill-kayac.html?hidden', { type: 'iframe' })
    const hiddenValues = JSON.parse(
      await hiddenFrame.ev(
        "JSON.stringify([...document.querySelectorAll('input')].map((el) => el.value).filter(Boolean))"
      )
    )
    hiddenFrame.close()
    check(
      '親が透明にした iframe には入れない',
      hiddenResult?.reason === 'collect-failed' && hiddenValues.length === 0,
      `${JSON.stringify(hiddenValues)} ${JSON.stringify(hiddenResult)}`
    )

    // 親が上の帯だけ見せている iframe: 帯の外（電話番号・ふりがな）には入らない
    const bandUrl = `http://localhost:${port}/autofill-kayac.html?band`
    const bandResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(frameKey)}, -1, -1, ${JSON.stringify(bandUrl)})`
    )
    const bandFrame = await connectTo(cdp, 'autofill-kayac.html?band', { type: 'iframe' })
    const bandValues = JSON.parse(
      await bandFrame.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.name, el.value])))"
      )
    )
    bandFrame.close()
    check(
      '親が上の帯だけ見せている iframe では、帯の外の欄に入らない',
      bandValues.tel === '' && bandValues.last_name_kana === '',
      `${JSON.stringify(bandValues)} ${JSON.stringify(bandResult)}`
    )

    // 同じ URL の iframe が 2 つ: フォーカスのある方（dup2）だけに入る
    await host.ev("document.getElementById('dup2').contentDocument.querySelector('[name=tel]').focus()")
    const dupResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(frameKey)}, -1, -1, ${JSON.stringify(`${origin}/autofill-kayac.html?dup`)})`
    )
    const dupValues = JSON.parse(
      await host.ev(
        "JSON.stringify(['dup1', 'dup2'].map((id) => document.getElementById(id).contentDocument.querySelector('[name=last_name]').value))"
      )
    )
    check(
      '同じ URL の iframe が 2 つなら、フォーカスのある方だけに入る',
      dupValues[0] === '' && dupValues[1] === '山田',
      `${JSON.stringify(dupValues)} ${JSON.stringify(dupResult)}`
    )
    host.close()
  }

  /* ---- 6e. 実サイト調査で見つけた組み方（フォームごとに 1 回ずつ） ---- */
  {
    const patternsKey = await ui.ev(
      `window.nemo.createTab(${JSON.stringify(`${origin}/autofill-patterns.html`)}).then((k) => k)`
    )
    const patterns = await connectTo(cdp, '/autofill-patterns.html', { type: 'page' })
    await waitFor(
      patterns,
      "document.readyState === 'complete' && document.querySelector('[name=zip]') ? 'ok' : ''"
    )
    for (const anchor of ['p_name', 'z1', 'zip']) {
      const at = JSON.parse(
        await patterns.ev(
          `(() => { const el = document.querySelector('[name=${anchor}]'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + 3, y: r.top + 3 }) })()`
        )
      )
      await countedJson(`window.nemo.autofillForVerify(${JSON.stringify(patternsKey)}, ${at.x}, ${at.y})`)
    }
    const got = JSON.parse(
      await patterns.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.name, el.value])))"
      )
    )
    const want = {
      p_name: '山田 太郎', // 見出しが左の td
      p_kana: 'ヤマダ　タロウ', // 見出しに「全角」があれば姓名の区切りも全角
      by: '1988', // 区切りが <span>年</span> の 3 分割
      bm: '7',
      bd: '14',
      tel: '090-1234-5678',
      tel2: '090-1234-5678', // 確認用は 2 か所目にも入れる
      kana_sei: 'やまだ', // autocomplete=family-name でも例がひらがななら、ふりがな
      fax1: '', // FAX は入れない
      fax2: '',
      fax3: '',
      z1: '100', // 3 桁 / 4 桁の 2 分割は郵便番号
      z2: '0001',
      zip: '1000001', // type=tel でも見出しが郵便番号なら郵便番号
      ctel: '090-1234-5678',
      lines: '千代田1-1 サンプルタワー 1701', // 番地と建物をまとめた欄
      ad1: '東京都千代田区千代田1-1', // 「ご住所」「建物名称」の 2 枠
      ad2: 'サンプルタワー 1701'
    }
    for (const [name, value] of Object.entries(want)) {
      check(
        `調査で見つけた組み方: ${name} に ${JSON.stringify(value)}`,
        got[name] === value,
        `got=${JSON.stringify(got[name])}`
      )
    }
    patterns.close()
  }

  /* ---- 6f. 身分証（パスポート・運転免許証・健康保険証） ---- */
  let documentRuns = 0
  {
    const docsKey = await ui.ev(
      `window.nemo.createTab(${JSON.stringify(`${origin}/autofill-documents.html`)}).then((k) => k)`
    )
    const docs = await connectTo(cdp, '/autofill-documents.html', { type: 'page' })
    await waitFor(
      docs,
      "document.readyState === 'complete' && document.querySelector('[name=pp_no]') ? 'ok' : ''"
    )
    const at = JSON.parse(
      await docs.ev(
        "(() => { const r = document.querySelector('[name=pp_no]').getBoundingClientRect(); return JSON.stringify({ x: r.left + 5, y: r.top + 5 }) })()"
      )
    )
    requests.length = 0
    const docsResult = await countedJson(
      `window.nemo.autofillForVerify(${JSON.stringify(docsKey)}, ${at.x}, ${at.y})`
    )
    documentRuns += 1
    const got = JSON.parse(
      await docs.ev(
        "JSON.stringify(Object.fromEntries([...document.querySelectorAll('input, select')].map((el) => [el.name, el.value])))"
      )
    )
    const want = {
      name: '山田 太郎',
      pp_no: 'TK1234567',
      // 「有効期限」だけの欄は、発行日（決まらなかった日付の欄）を飛ばして旅券番号の書類に決まる
      pp_ey: '2031',
      pp_em: '4',
      pp_ed: '30',
      pp_iy: '', // 発行日は入れない
      pp_im: '',
      pp_id: '',
      pp_country: '', // 発行国は入れない
      lic_no: '987654321098',
      lic_issue: '', // 交付日は入れない
      lic_ey: '令和11', // 和暦の年の select
      lic_em: '6',
      lic_ed: '15',
      lic_color: '',
      ins_sym: '4321',
      ins_no: '65',
      ins_br: '07',
      ins_insurer: '06987654',
      companion_pp: '', // 本人でない
      member_no: '', // 確からしさが身分証の足切りに届かない
      card_no: '',
      card_exp: '' // カード番号の直後の「有効期限」には身分証の期限を入れない
    }
    for (const [name, value] of Object.entries(want)) {
      check(
        `身分証: ${name} に ${JSON.stringify(value)}`,
        got[name] === value,
        `got=${JSON.stringify(got[name])}`
      )
    }
    check(
      '身分証: 入れた身分証の欄の数（旅券番号・期限・免許証番号・期限・保険証 4 欄 = 8）',
      docsResult?.documents === 8,
      JSON.stringify(docsResult)
    )
    const sentDocs = requests.map((r) => r.raw).join('\n')
    const docValues = ['TK1234567', '987654321098', '4321', '06987654', '2031-04-30', '2029-06-15']
    const leakedDocs = docValues.filter((value) => sentDocs.includes(value))
    check(
      '身分証: Jev に身分証の値を送っていない',
      requests.length > 0 && leakedDocs.length === 0,
      leakedDocs.length > 0 ? leakedDocs.join(', ') : `requests=${requests.length}`
    )
    docs.close()
  }

  /* ---- 6g. 既定の個人情報を切り替える ---- */
  await ui.ev(
    `window.nemo.updateSettings({ kyprAutofillIdentityId: ${JSON.stringify(corp.id)} }).then(() => 'ok')`
  )
  check('既定を「会社」に切り替えた', (await json('window.nemo.kyprPanel()')).autofillIdentityId === corp.id)
  await reload()
  await run()
  check('切り替えた個人情報の値が入る', (await values()).mail === CORP_EMAIL, (await values()).mail)
  // ゴミ箱に入れたら一番古いもの（自分）に戻る
  await json(`window.nemo.kyprTrash(${JSON.stringify(corp.id)})`)
  await reload()
  await run()
  check(
    '既定の個人情報をゴミ箱に入れたら一番古いものに戻る',
    (await values()).mail === 'taro@example.com',
    (await values()).mail
  )

  /* ---- 7. Jev の失敗 ---- */
  const ruleOnly = {
    kana_sei: 'ヤマダ',
    mail: 'taro@example.com',
    zip: '1000001',
    addr1: '千代田1-1'
  }
  const scenario = async (name, setMode, expectError) => {
    await reload()
    mode = setMode
    calls = 0
    const r = await run()
    const v = await values()
    mode = 'ok'
    return { r, v, name, expectError }
  }

  {
    const { r, v } = await scenario('529', '529-then-ok')
    check(
      '529 のあと再試行して入った',
      r?.jev === 8 && calls === 2 && v.company === '株式会社サンプル',
      JSON.stringify({ jev: r?.jev, calls })
    )
  }
  for (const [name, setMode, error] of [
    ['401', '401', 'http-401'],
    ['タイムアウト', 'slow', 'timeout']
  ]) {
    const { r, v } = await scenario(name, setMode)
    check(`${name}: jevError が ${error}`, r?.jevError === error, JSON.stringify(r))
    check(
      `${name}: ルールの欄は入り、Jev の欄は入らない`,
      Object.entries(ruleOnly).every(([k, want]) => v[k] === want) && v.sei === '' && v.company === '',
      JSON.stringify({ kana_sei: v.kana_sei, mail: v.mail, zip: v.zip, sei: v.sei })
    )
  }
  await ui.ev('window.nemo.clearJevKey().then(() => "ok")')
  check('キーを消せた（ファイルも消える）', !fs.existsSync(keyFile))
  {
    const { r, v } = await scenario('キー無し', 'ok')
    check(
      'キー無し: Jev を呼ばずにルールの欄だけ入る',
      r?.jevError === 'no-key' && calls === 0 && v.mail === 'taro@example.com' && v.sei === '',
      JSON.stringify(r)
    )
  }

  /* ---- 10. 設定画面の描画 ---- */
  await ui.ev(`window.nemo.setOverlay('settings').then(() => 'ok')`)
  const overlay = await connectTo(cdp, 'view=overlay')
  const rendered = await waitFor(
    overlay,
    `document.querySelector('[data-testid="autofill-jev-state"]')?.textContent ?? ''`,
    { timeoutMs: 15000 }
  ).catch(() => '')
  check(
    '設定画面に自動入力の節が描かれ、キーを消したあとは「未設定」',
    String(rendered).startsWith('未設定'),
    JSON.stringify(rendered)
  )
  const source = await overlay.ev(
    `document.querySelector('[data-testid="autofill-source"]')?.textContent ?? ''`
  )
  check('設定画面で値の元が kypr の個人情報だと分かる', source.includes('kypr'), JSON.stringify(source))
  await ui.ev(`window.nemo.setOverlay(null).then(() => 'ok')`)

  /* ---- 11. ログ ---- */
  const lines = readLogLines(userData)
  const runs = lines.filter((line) => line.includes('"event":"autofill.run"'))
  check(
    'autofill.run が実行回数ぶん出ている',
    runs.length === runCount && runCount > 0,
    `runs=${runs.length} called=${runCount}`
  )
  check(
    'autofill.run に身分証の欄の数が出ている',
    runs.filter((line) => line.includes('"documents":8')).length === documentRuns,
    `documentRuns=${documentRuns}`
  )
  // **ログの検査だけ 3 桁以下の数字だけの値（保険証の番号「65」・枝番「07」）を外す**
  // （時刻や件数に普通に現れ、空振りの FAIL になる。Jev に送る body の検査には全部の値を残す）
  const logSecrets = SECRETS.filter((s) => !/^\d{1,3}$/.test(s))
  const logLeaks = logSecrets.filter((s) => lines.some((line) => line.includes(s)))
  check('診断ログに値・キー・マスターパスワードが出ていない', logLeaks.length === 0, logLeaks.join(', '))
  const crashes = findUncaughtExceptions(userData)
  check('未処理の例外が出ていない', crashes.length === 0, crashes.join(' / '))

  /* ---- 12. 再起動: キーは残る・Touch ID が通らなければ入れない ---- */
  const resaved = await json(`window.nemo.saveJevKey(${JSON.stringify(JEV_KEY)})`)
  check('キーを保存し直した', resaved === true)
  await stopChildren(spawned.splice(0))

  const cdp2 = await bootApp(userData, 'fail')
  const ui2 = await connectUi(cdp2)
  const json2 = async (expression) => JSON.parse(await ui2.ev(`${expression}.then(JSON.stringify)`))
  check(
    '再起動後もキーが残っている（この Mac の userData）',
    (await json2('window.nemo.autofillStatus()')).hasJevKey === true
  )
  check('再起動後の kypr はロック中', (await json2('window.nemo.kyprStatus()')).state === 'locked')
  const tabKey2 = await ui2.ev(
    `window.nemo.createTab(${JSON.stringify(`${origin}/autofill.html`)}).then((k) => k)`
  )
  const page2 = await connectTo(cdp2, '/autofill.html', { type: 'page' })
  await waitFor(page2, "document.readyState === 'complete' && document.getElementById('sei') ? 'ok' : ''")
  const at2 = JSON.parse(
    await page2.ev(
      "(() => { const r = document.getElementById('sei').getBoundingClientRect(); return JSON.stringify({ x: r.left + 5, y: r.top + 5 }) })()"
    )
  )
  calls = 0
  const locked = await json2(`window.nemo.autofillForVerify(${JSON.stringify(tabKey2)}, ${at2.x}, ${at2.y})`)
  const lockedValues = JSON.parse(
    await page2.ev(
      "JSON.stringify([...document.querySelectorAll('input')].map((el) => el.value).filter(Boolean))"
    )
  )
  check(
    'Touch ID が通らなければ kypr-locked で何も入れない（Jev も呼ばない）',
    locked?.reason === 'kypr-locked' && calls === 0 && lockedValues.every((v) => v === '営業部'),
    `${JSON.stringify(locked)} ${JSON.stringify(lockedValues)}`
  )
  const crashes2 = findUncaughtExceptions(userData)
  check('再起動後: 未処理の例外が出ていない', crashes2.length === 0, crashes2.join(' / '))
} catch (error) {
  failures += 1
  console.error('FAIL  検証が途中で落ちた —', error?.stack ?? error)
} finally {
  await stopChildren(spawned)
  server.close()
  await kypr?.mock.close()
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks} 件中 ${checks - failures} 件 PASS / ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
