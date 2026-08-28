#!/usr/bin/env node
/**
 * Basic 認証の保管庫の検証（`mise run verify:only auth-vault`）。
 *
 * 見るもの:
 *   1. 保存 → `basic-auth.json` が `{ version, data }` で書かれ、**平文が一切現れない**
 *   2. **別の Mac 相当**（`NEMO_USER_DATA_DIR` を分けて `NEMO_SLOTS_DIR` を共有）で
 *      差分が 3 グループに正しく分かれる
 *   3. **チェックしたものだけ入る**（チェックしていないものが入らないこと）。
 *      「入った」だけ見ると、全部入れても PASS するので**両方**見る
 *   4. **無効なルールは保管庫に入らない**（保存は有効なものだけ）
 *   5. パスフレーズ違いは `bad-passphrase`（**`tampered` に畳まれない**）。
 *      畳むと打ち間違いに「削除して作り直せ」と出すことになる
 *   6. 2 つ目のプロファイルでは**パスフレーズを覚えていない**
 *   7. `updatedAt` が保管庫を通って**引き継がれる**（読み込んだ時刻に化けない）
 *   8. **設定画面に実際にカードが描かれる**。IPC だけ見ていると `AuthVault.tsx` の
 *      描画例外（＝設定画面が丸ごと落ちる）を素通りする
 *
 * **`NEMO_SLOTS_DIR` を必ず渡す。** 渡し忘れると実 iCloud の常用の保管庫に書く。
 * **`NEMO_HTTP_AUTH_TEST_CRYPTO=memory` も必ず渡す。** 実 `safeStorage` に触ると
 * macOS が `SecurityAgent` を上げて**検証が永久に止まる**。
 *
 * 使い方:
 *   node scripts/verify-auth-vault.mjs   （事前に out/ がビルドされていること）
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
  projectRoot,
  sleep,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const PASSPHRASE = 'nemo-verify-passphrase'

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const spawned = []
const dirs = []

function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-vault-${tag}-`))
  dirs.push(dir)
  return dir
}

async function bootApp(userDataDir, slotsDir) {
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_SLOTS_DIR: slotsDir,
      // 実 safeStorage に触ると SecurityAgent で検証が永久に止まる
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      NEMO_DOWNLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-vault-dl-'))
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/** UI に CDP でつないで式を 1 つ評価する（`view` で sidebar / overlay を選ぶ）。 */
async function evalInUi(cdp, expression, view = 'sidebar') {
  const list = await (await fetch(`${cdp}/json/list`)).json()
  const target = list.find((t) => t.url.includes(`view=${view}`))
  if (!target) throw new Error(`ブラウザ UI の target が見つからない（view=${view}）`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  try {
    const send = (method, params) =>
      new Promise((resolve) => {
        const id = 1
        ws.addEventListener('message', function onMessage(event) {
          const message = JSON.parse(event.data)
          if (message.id !== id) return
          ws.removeEventListener('message', onMessage)
          resolve(message)
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const probe = await send('Runtime.evaluate', {
        expression: 'window.nemo?.getAppStatus?.().then((s) => JSON.stringify(s))',
        awaitPromise: true,
        returnByValue: true
      })
      const value = probe.result?.result?.value
      if (value && JSON.parse(value).ready) break
      await sleep(300)
    }
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return result.result?.result?.value
  } finally {
    ws.close()
  }
}

const json = async (cdp, expression, view = 'sidebar') => JSON.parse(await evalInUi(cdp, expression, view))

/** ルールを 1 件作る。 */
async function addRule(cdp, pattern, username, password) {
  return json(
    cdp,
    `window.nemo.saveHttpAuthRule(${JSON.stringify({ pattern, username, password })}).then(JSON.stringify)`
  )
}

function vaultFile(slotsDir) {
  return path.join(slotsDir, 'basic-auth.json')
}

const A = '^https://a\\.example/'
const B = '^https://b\\.example/'
const C = '^https://c\\.example/'
const D = '^https://d\\.example/'

try {
  assertNemoNotRunning('verify-auth-vault')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js'))) {
    throw new Error('out/ が無い。先に pnpm build する')
  }

  const slotsDir = makeDir('slots')
  const firstData = makeDir('data1')
  const secondData = makeDir('data2')

  /* ================= 1 台目: 保存 ================= */
  {
    const { cdp } = await bootApp(firstData, slotsDir)

    // **実 iCloud に書いていないことを最初に確かめる**（渡し忘れの検出）
    const initial = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check('保存先が env の上書きで解決されている', initial.kind === 'env', `${initial.kind} ${initial.dir}`)
    check('最初は保管庫が空', initial.state === 'empty', initial.state)
    check('最初はパスフレーズを覚えていない', initial.hasPassphrase === false)

    await addRule(cdp, A, 'admin', 'pw-a')
    await addRule(cdp, B, 'admin', 'pw-b')
    const disabled = await addRule(cdp, C, 'admin', 'pw-c')
    // C は無効にする（保管庫に入らないことを見る）。
    // 有効トグルは `pattern` を省いた `saveHttpAuthRule` が受ける
    const toggled = await json(
      cdp,
      `window.nemo.saveHttpAuthRule(${JSON.stringify({ id: disabled.id, username: 'admin', enabled: false })}).then(JSON.stringify)`
    )
    check('C を無効にできた', toggled.saved === true, JSON.stringify(toggled))

    const status = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check(
      'この Mac の有効な件数が 2（無効な 1 件を数えない）',
      status.localCount === 2,
      String(status.localCount)
    )

    const preview = await json(
      cdp,
      `window.nemo.authVaultPreviewSave(${JSON.stringify(PASSPHRASE)}).then(JSON.stringify)`
    )
    check(
      '初回の保存は first で、消えるものが無い',
      preview.ok === true && preview.first === true && preview.disappearing.length === 0,
      JSON.stringify(preview)
    )

    const saved = await json(
      cdp,
      `window.nemo.authVaultSave(${JSON.stringify(PASSPHRASE)}, true).then(JSON.stringify)`
    )
    check('保存できた（有効な 2 件だけ）', saved.ok === true && saved.saved === 2, JSON.stringify(saved))

    const raw = fs.readFileSync(vaultFile(slotsDir), 'utf8')
    const parsed = JSON.parse(raw)
    check('{ version, data } で書かれている', parsed.version === 1 && typeof parsed.data === 'object')
    check(
      '平文メタが読める（復号せずにカードを描ける）',
      parsed.data.meta.count === 2,
      JSON.stringify(parsed.data.meta)
    )

    /*
     * **ファイル全体を見て平文が無いことを確かめる。** 「暗号化した」の検査は
     * 「暗号文が入っている」だけだと、平文が別のキーに残っていても PASS する。
     */
    for (const secret of ['pw-a', 'pw-b', 'a\\.example', 'b\\.example', 'admin']) {
      check(`保管庫のファイルに平文が現れない（${secret}）`, !raw.includes(secret))
    }

    check(
      '保存後はパスフレーズを覚えている',
      (await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')).hasPassphrase === true
    )

    await stopChildren(spawned.splice(0))
  }

  /* ================= 2 台目: 差分と選択取り込み ================= */
  {
    const { cdp } = await bootApp(secondData, slotsDir)

    const status = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check(
      '別プロファイルからも保管庫が見える',
      status.state === 'ok' && status.meta.count === 2,
      JSON.stringify(status.meta)
    )
    check(
      '別プロファイルではパスフレーズを覚えていない',
      status.hasPassphrase === false,
      '覚えていたら `NEMO_USER_DATA_DIR` を分けられていない'
    )

    // 記憶が無いので、パスフレーズ無しの下見は no-passphrase で止まる（＝1 段目を出す合図）
    const noPass = await json(cdp, 'window.nemo.authVaultPreviewLoad(null).then(JSON.stringify)')
    check(
      'パスフレーズ無しでは開けない',
      noPass.ok === false && noPass.reason === 'no-passphrase',
      JSON.stringify(noPass)
    )

    const wrong = await json(
      cdp,
      'window.nemo.authVaultPreviewLoad("wrong-passphrase-x").then(JSON.stringify)'
    )
    check(
      'パスフレーズ違いは bad-passphrase（tampered に畳まれない）',
      wrong.ok === false && wrong.reason === 'bad-passphrase',
      JSON.stringify(wrong)
    )

    /*
     * **保存側もブロックされること。** 保存は全件置き換えで undo が無いので、
     * パスフレーズ違いのまま保存が通るのが最悪の事故。読み込み側だけ見ていると、
     * `preview-save` が `openVault` を呼ばなくなる回帰を誰も止められない。
     */
    const wrongSave = await json(
      cdp,
      'window.nemo.authVaultPreviewSave("wrong-passphrase-x").then(JSON.stringify)'
    )
    check(
      '違うパスフレーズでは保存の下見が通らない',
      wrongSave.ok === false && wrongSave.reason === 'bad-passphrase',
      JSON.stringify(wrongSave)
    )

    // この Mac には B（内容違い）と D（保管庫に無い）を置く
    await addRule(cdp, B, 'admin2', 'pw-b-local')
    await addRule(cdp, D, 'admin', 'pw-d')

    const preview = await json(
      cdp,
      `window.nemo.authVaultPreviewLoad(${JSON.stringify(PASSPHRASE)}).then(JSON.stringify)`
    )
    check('下見が通った', preview.ok === true, JSON.stringify(preview).slice(0, 200))
    check(
      'この Mac に無いものが A だけ',
      preview.missing.length === 1 && preview.missing[0].pattern === A,
      JSON.stringify(preview.missing)
    )
    check(
      '内容が違うものが B だけで、両方のユーザー名が出る',
      preview.differing.length === 1 &&
        preview.differing[0].pattern === B &&
        preview.differing[0].fromUsername === 'admin' &&
        preview.differing[0].toUsername === 'admin2' &&
        preview.differing[0].passwordDiffers === true,
      JSON.stringify(preview.differing)
    )
    check('既にあるものは無い（B は内容が違う側）', preview.same.length === 0, JSON.stringify(preview.same))
    check('無効だった C は保管庫に入っていない', !JSON.stringify(preview).includes('c\\\\.example'))

    /*
     * **A だけ取り込む。** 「入った」だけ見ると全部入れても PASS するので、
     * **B が変わっていないこと**も必ず見る。
     */
    const loaded = await json(
      cdp,
      `window.nemo.authVaultLoad(${JSON.stringify(PASSPHRASE)}, ${JSON.stringify([A])}, false).then(JSON.stringify)`
    )
    check('選んだ 1 件だけ取り込んだ', loaded.ok === true && loaded.imported === 1, JSON.stringify(loaded))

    const rules = await json(cdp, 'window.nemo.listHttpAuthRules().then(JSON.stringify)')
    const byPattern = new Map(rules.rules.map((rule) => [rule.pattern, rule]))
    check('A が入った', byPattern.has(A))
    check('D はそのまま残っている', byPattern.has(D))
    check(
      'チェックしていない B は上書きされていない',
      byPattern.get(B)?.username === 'admin2',
      `username=${byPattern.get(B)?.username}`
    )

    const revealed = await evalInUi(
      cdp,
      `window.nemo.revealHttpAuthPassword(${JSON.stringify(byPattern.get(A)?.id)})`
    )
    check('取り込んだ A のパスワードが保管庫のもの', revealed === 'pw-a', String(revealed))

    /* ---- updatedAt が引き継がれる（読み込んだ時刻に化けない） ---- */
    const vaultSavedAt = JSON.parse(fs.readFileSync(vaultFile(slotsDir), 'utf8')).data.meta.savedAt
    const importedAt = byPattern.get(A)?.updatedAt
    check(
      '取り込んだルールの更新時刻が保管庫の値を引き継いでいる',
      typeof importedAt === 'number' && importedAt <= vaultSavedAt,
      `imported=${String(importedAt)} vaultSavedAt=${vaultSavedAt}`
    )

    /* ---- 設定画面が実際に描けている（AuthVault.tsx を OWNERS に載せる根拠） ---- */
    await evalInUi(cdp, `window.nemo.setOverlay('settings').then(() => 'ok')`)
    const deadline = Date.now() + 15000
    let rendered = ''
    while (Date.now() < deadline) {
      try {
        rendered = await evalInUi(
          cdp,
          `document.querySelector('[data-testid="auth-vault-count"]')?.textContent ?? ''`,
          'overlay'
        )
      } catch {
        rendered = ''
      }
      if (rendered) break
      await sleep(300)
    }
    // 描画が落ちていると 0 件になるので、**件数の中身まで**見る
    check('設定画面に保管庫のカードが描かれ、件数が出ている', rendered === '2 件', JSON.stringify(rendered))
    const localText = await evalInUi(
      cdp,
      `document.querySelector('[data-testid="auth-vault-local"]')?.textContent ?? ''`,
      'overlay'
    )
    check('この Mac の件数も描かれている', localText.includes('3 件'), JSON.stringify(localText))

    await stopChildren(spawned.splice(0))
  }

  /* ================= 1 台目に戻る: 上書き保存の「消えるもの」 ================= */
  {
    const { cdp } = await bootApp(firstData, slotsDir)

    // 1 台目は A と B を持っている。B を消してから保存し直すと、B が保管庫から消える
    const rules = await json(cdp, 'window.nemo.listHttpAuthRules().then(JSON.stringify)')
    const b = rules.rules.find((rule) => rule.pattern === B)
    await evalInUi(cdp, `window.nemo.deleteHttpAuthRule(${JSON.stringify(b.id)})`)

    // パスフレーズは覚えているので null で通る
    const preview = await json(cdp, 'window.nemo.authVaultPreviewSave(null).then(JSON.stringify)')
    check('覚えているパスフレーズで下見できる', preview.ok === true, JSON.stringify(preview).slice(0, 200))
    check(
      '消えるものが B だけ（向きを取り違えていない）',
      preview.disappearing.length === 1 && preview.disappearing[0].pattern === B,
      JSON.stringify(preview.disappearing)
    )

    /* ---- 削除するとパスフレーズの記憶も消える ---- */
    check('削除できた', (await evalInUi(cdp, 'window.nemo.authVaultDelete()')) === true)
    const after = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check('削除後は空きに戻る', after.state === 'empty', after.state)
    check('削除でパスフレーズの記憶も消える', after.hasPassphrase === false)

    await stopChildren(spawned.splice(0))
  }

  /* ================= 壊れた保管庫 / 未来の版 ================= */
  {
    // **未来の版は退避しない**（保管庫は全ての Mac が 1 ファイルを共有する。
    // 古い Nemo が退避すると新しい方からも丸ごと消える）
    fs.writeFileSync(vaultFile(slotsDir), JSON.stringify({ version: 99, data: {} }))
    const { cdp } = await bootApp(makeDir('data3'), slotsDir)

    const status = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check('未来の版は unreadable（空きに倒さない）', status.state === 'unreadable', status.state)
    check('未来の版だと分かる理由が出る', String(status.reason).includes('新しい版'), String(status.reason))
    /*
     * **UI が削除の導線を切る条件はフラグの側**。文言だけ見ていると、
     * `readVaultFile` が `future: true` を落としても PASS してしまい、
     * 未来の版の保管庫に削除ボタンが黙って戻る。
     */
    check('未来の版はフラグでも分かる', status.isFutureVersion === true, JSON.stringify(status))
    check('未来の版のファイルは退避されず残っている', fs.existsSync(vaultFile(slotsDir)))

    // 壊れたファイルは退避される
    fs.writeFileSync(vaultFile(slotsDir), '{ not json')
    const broken = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check('壊れたファイルは unreadable', broken.state === 'unreadable', broken.state)
    check('壊れただけならフラグは立たない（削除の導線を残す）', broken.isFutureVersion === false)
    const quarantined = fs.readdirSync(slotsDir).filter((name) => name.includes('.broken-'))
    check('壊れたファイルは退避される（黙って消さない）', quarantined.length === 1, quarantined.join(','))
    const gone = await json(cdp, 'window.nemo.authVaultStatus().then(JSON.stringify)')
    check('退避後は空きに戻る', gone.state === 'empty', gone.state)

    await stopChildren(spawned.splice(0))
  }

  const crashes = [...findUncaughtExceptions(firstData), ...findUncaughtExceptions(secondData)]
  check('未処理の例外が出ていない', crashes.length === 0, crashes.join(' / '))
} catch (error) {
  failures += 1
  console.error('FAIL  検証が途中で落ちた —', error?.stack ?? error)
} finally {
  await stopChildren(spawned)
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks} 件中 ${checks - failures} 件 PASS / ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
