#!/usr/bin/env node
/**
 * フォーム自動入力の実サイト調査（`mise run autofill:survey`）。**自走検証ではない**（外部サイトと実 Jev に依存する）。
 *
 * 使い捨てのプロファイルで Nemo を 1 つ起動し、`scripts/autofill-survey-urls.txt` の各ページで
 * 右クリックの「フォーム自動入力」と同じ処理を走らせて、欄ごとに「何が入ったか」を一覧にする。
 * 入らない欄を見つけるたびに 1 件ずつ報告してもらう代わりに、代表的なフォームをまとめて見るためのもの。
 *
 * - **送信はしない**（入力するだけ）。プロフィールは架空の値
 * - Jev のキーは `NEMO_SURVEY_JEV_KEY_FILE`（キーを 1 行書いたファイル）から読む。無ければルールだけで回す
 * - 実 iCloud・実 Keychain には触らない（`NEMO_SLOTS_DIR` / `NEMO_HTTP_AUTH_TEST_CRYPTO=memory`）
 * - フォームがメインのページに無いとき（iframe の中・描画されない）は、その旨と iframe の URL の host を出す
 *
 * 使い方:
 *   NEMO_SURVEY_JEV_KEY_FILE=~/path/to/key node scripts/autofill-survey.mjs [--out report.md] [URL...]
 *   （事前に out/ がビルドされていること。URL を渡すとリストの代わりにそれだけ見る）
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  getFreePort,
  projectRoot,
  sleep,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { connect, connectUi, listTargets } from './lib/cdp.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

/** 架空のプロフィール（実在の人・住所ではない）。 */
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
  job_title: '部長',
  organization_url: 'https://example.com'
}

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
const outFile = outAt === -1 ? null : args[outAt + 1]
const urlArgs = args.filter((_, i) => outAt === -1 || (i !== outAt && i !== outAt + 1))
const urls =
  urlArgs.length > 0
    ? urlArgs
    : fs
        .readFileSync(path.join(projectRoot, 'scripts/autofill-survey-urls.txt'), 'utf8')
        .split('\n')
        .map((line) => line.replace(/#.*/, '').trim())
        .filter(Boolean)

const keyFile = process.env['NEMO_SURVEY_JEV_KEY_FILE']
const jevKey = keyFile ? fs.readFileSync(keyFile.replace(/^~/, os.homedir()), 'utf8').trim() : null

/** ページのメインワールドで欄を列挙する（調査用。可視判定は収集スクリプトより緩い）。 */
const DESCRIBE = String.raw`(() => {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const types = new Set(['text', 'email', 'tel', 'number', 'url', 'date'])
  const out = []
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = el instanceof HTMLInputElement ? (el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase()
    if (el instanceof HTMLInputElement && !types.has(type)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const label = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : clean(el.getAttribute('aria-label'))
    const row = el.closest('tr, dl, .form-group, .field, li, p, div')
    const th = el.closest('td') && el.closest('tr') ? clean(el.closest('tr').querySelector('th')?.textContent) : ''
    out.push({ type, name: clean(el.getAttribute('name')), placeholder: String(el.getAttribute('placeholder') || '').replace(/[^\S\u3000]+/g, ' ').trim().slice(0, 40), label, th, row: row ? clean(row.textContent) : '', value: el instanceof HTMLSelectElement ? clean(el.selectedOptions[0]?.textContent) + (el.selectedIndex > 0 ? '' : ' (未選択)') : el.value })
  }
  return JSON.stringify(out)
})()`

/**
 * 右クリックする欄。**欄がいちばん多いフォームの中の最初の欄**（ページ上部のサイト内検索のような
 * 別の form を選ぶと、そのフォームの 1 欄しか集まらない）。form が無ければページの最初の欄。
 */
const FIRST = String.raw`(() => {
  const types = new Set(['text', 'email', 'tel', 'number', 'url', 'date'])
  const usable = (el) => {
    if (el instanceof HTMLInputElement && !types.has((el.getAttribute('type') || 'text').toLowerCase())) return false
    const r = el.getBoundingClientRect()
    return r.width >= 4 && r.height >= 4 && el.checkVisibility()
  }
  const all = [...document.querySelectorAll('input, select, textarea')].filter(usable)
  const counts = new Map()
  for (const el of all) counts.set(el.form, (counts.get(el.form) || 0) + 1)
  let best = null
  for (const [form, count] of counts) if (form && (!best || count > counts.get(best))) best = form
  const el = all.find((e) => (best ? e.form === best : true))
  if (!el) return ''
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: r.left + Math.min(10, r.width / 2), y: r.top + r.height / 2 })
})()`

/** 欄の一覧を表で出す（`session` はページか iframe の CDP セッション）。 */
async function printFields(session) {
  say('')
  say('| 見出し（label / th / 行） | name | 例 | 入った値 |')
  say('|---|---|---|---|')
  for (const field of JSON.parse(await session.ev(DESCRIBE))) {
    const heading = field.label || field.th || field.row
    const value = field.value && !field.value.endsWith('(未選択)') ? `**${field.value}**` : '（空）'
    say(
      `| ${heading.replace(/\|/g, '／')} | ${field.name} | ${field.placeholder.replace(/\|/g, '／')} | ${value.replace(/\|/g, '／')} |`
    )
  }
  say('')
}

/** 欄ごとの判定の内訳（`autofillForVerify` が返す `debug`）。入らなかった欄の原因を見るためのもの。 */
function printDebug(result) {
  if (!result?.debug?.length) return
  say('')
  say('| 手がかり（label / 近く / 表の見出し / 例） | 枠 | 判定 | Jev の答え（確信度・本人性） |')
  say('|---|---|---|---|')
  for (const field of result.debug) {
    const hint = [
      field.label,
      field.nearby,
      field.section && `［${field.section}］`,
      field.placeholder && `例:${field.placeholder}`
    ]
      .filter(Boolean)
      .join(' / ')
      .replace(/\|/g, '／')
      .slice(0, 80)
    const jev = field.jev
      ? `${field.jev.choice}（${field.jev.confidence.toFixed(2)}・${field.jev.own.toFixed(2)}）`
      : ''
    say(
      `| ${hint} | ${field.boxes} | ${field.decided ?? '—'}${field.source === 'rule' ? '（ルール）' : ''} | ${jev} |`
    )
  }
}

const resultLine = (result) =>
  `- 結果: 欄 ${result.fields}・ルール ${result.rule}・Jev ${result.jev}・残り ${result.left}・入力要素 ${result.filled}` +
  `${result.reason ? `・reason=${result.reason}` : ''}${result.jevError ? `・jevError=${result.jevError}` : ''}`

const spawned = []
const dirs = []
const report = []
const say = (line) => {
  report.push(line)
  console.log(line)
}

try {
  assertNemoNotRunning('autofill-survey')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js')))
    throw new Error('out/ が無い。先に pnpm build する')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-survey-'))
  const slotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-survey-slots-'))
  dirs.push(userData, slotsDir)
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ version: 1, data: { liveFolderEnabled: false } })
  )
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: userData,
      NEMO_SLOTS_DIR: slotsDir,
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      NEMO_VERIFY_DIAGNOSTICS: '1',
      NEMO_DOWNLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-survey-dl-'))
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, { child })
  const ui = await connectUi(cdp)
  const saved = JSON.parse(
    await ui.ev(
      `window.nemo.autofillSave(${JSON.stringify(PROFILE)}, 'survey-passphrase', true).then(JSON.stringify)`
    )
  )
  if (!saved.ok) throw new Error(`プロフィールを保存できない: ${JSON.stringify(saved)}`)
  if (jevKey) {
    const key = JSON.parse(
      await ui.ev(`window.nemo.saveJevKey(${JSON.stringify(jevKey)}).then(JSON.stringify)`)
    )
    if (!key.ok) throw new Error(`キーを保存できない: ${JSON.stringify(key)}`)
  } else {
    console.error('[survey] NEMO_SURVEY_JEV_KEY_FILE が無いので、ルールで決まる欄だけ入れる')
  }

  say(`# フォーム自動入力の実サイト調査（${new Date().toISOString().slice(0, 10)}・${urls.length} ページ）\n`)
  for (const url of urls) {
    say(`## ${url}\n`)
    const before = new Set((await listTargets(cdp)).map((t) => t.id))
    let tabKey = null
    let page = null
    try {
      tabKey = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)}).then((k) => k)`)
      // 新しくできたページの target（リダイレクトで URL が変わるので id の差分で拾う）
      let target = null
      for (let i = 0; i < 40 && !target; i += 1) {
        target = (await listTargets(cdp)).find(
          (t) => t.type === 'page' && !before.has(t.id) && /^https?:/.test(t.url)
        )
        if (!target) await sleep(250)
      }
      if (!target) throw new Error('ページの target が見つからない')
      page = await connect(target.webSocketDebuggerUrl)
      // 描画を待つ: 欄の数が 1.5 秒変わらなくなるまで（最大 15 秒）
      let last = -1
      let stableSince = Date.now()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const count = await page
          .ev("document.readyState === 'complete' ? JSON.parse(" + JSON.stringify(DESCRIBE) + ').length : -1')
          .catch(() => -1)
        if (count !== last) {
          last = count
          stableSince = Date.now()
        } else if (count >= 0 && Date.now() - stableSince > 1500) break
        await sleep(500)
      }
      const frames = await page.send('Page.getFrameTree')
      const iframeHosts = []
      const walk = (node) => {
        for (const childFrame of node?.childFrames ?? []) {
          try {
            iframeHosts.push(new URL(childFrame.frame.url).host || childFrame.frame.url.slice(0, 30))
          } catch {
            iframeHosts.push(childFrame.frame.url.slice(0, 30))
          }
          walk(childFrame)
        }
      }
      walk(frames.result?.frameTree)
      const fields = JSON.parse(await page.ev(DESCRIBE))
      // ページ本体に欄が無いときは、埋め込みフォーム（iframe）の読み込みを待つ
      if (fields.length === 0) await sleep(6000)
      const iframeTargets = (await listTargets(cdp)).filter(
        (t) => t.type === 'iframe' && !before.has(t.id) && /^https?:/.test(t.url)
      )
      const domIframes = JSON.parse(
        await page.ev(
          "JSON.stringify([...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean))"
        )
      )
      const hosts = [
        ...iframeHosts,
        ...domIframes.map((u) => {
          try {
            return new URL(u).host
          } catch {
            return u
          }
        })
      ]
      say(
        `- ページ本体の欄: ${fields.length} / iframe: ${[...new Set(hosts)].filter(Boolean).join(', ') || 'なし'}`
      )
      if (fields.length > 0) {
        const { x, y } = JSON.parse(await page.ev(FIRST))
        const result = JSON.parse(
          await ui.ev(
            `window.nemo.autofillForVerify(${JSON.stringify(tabKey)}, ${x}, ${y}).then(JSON.stringify)`
          )
        )
        say(resultLine(result))
        printDebug(result)
        await sleep(500)
        await printFields(page)
      }
      // 別プロセスの iframe（埋め込みフォーム）。欄があるものだけ走らせる
      for (const target of iframeTargets) {
        const frame = await connect(target.webSocketDebuggerUrl).catch(() => null)
        if (!frame) continue
        try {
          const count = JSON.parse(await frame.ev(DESCRIBE)).length
          if (count === 0) continue
          say(`### iframe: ${new URL(target.url).host}（欄 ${count}）\n`)
          const result = JSON.parse(
            await ui.ev(
              `window.nemo.autofillForVerify(${JSON.stringify(tabKey)}, -1, -1, ${JSON.stringify(target.url)}).then(JSON.stringify)`
            )
          )
          say(result ? resultLine(result) : '- **iframe を見つけられなかった**（frameUrl が一致しない）')
          printDebug(result)
          await printFields(frame)
        } catch (error) {
          say(`- **iframe を調べられなかった**: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          frame.close()
        }
      }
      if (fields.length === 0 && iframeTargets.length === 0)
        say('- **ページ本体にも別プロセスの iframe にも入力欄が無い**\n')
    } catch (error) {
      say(`- **調査できなかった**: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      page?.close()
      if (tabKey)
        await ui.ev(`window.nemo.closeTab(${JSON.stringify(tabKey)}).then(() => 'ok')`).catch(() => {})
    }
  }
} catch (error) {
  console.error('[survey] 途中で落ちた —', error?.stack ?? error)
  process.exitCode = 1
} finally {
  await stopChildren(spawned)
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  if (outFile) fs.writeFileSync(outFile, `${report.join('\n')}\n`)
}
