#!/usr/bin/env node
/**
 * ブックマークのセーブスロットの検証（`mise run verify:only slots`）。
 *
 * 見るもの:
 *   1. 保存 → `slot-1.json` が `{ version, data }` で書かれる
 *   2. **同じ枠を読み込む → 降格が 0 件**。かつ `pins.json` がスロットと一致する
 *      （降格 0 件だけだと、読み込みが丸ごと no-op でも PASS する）
 *   3. **別 Mac 相当（ID を振り直した fixture）→ 該当タブが全部「今日のタブ」に出る**
 *   4. 削除 → 空きに戻る / 名前変更 → 中身は変わらない
 *   5. **読めない枠は「空き」ではなく `unreadable`**（保存ボタンが出ない）。
 *      壊れた枠は退避され、「再試行」で空きに戻る。未来の版は退避しない
 *   6. 旧フォーマットの fixture（2 階層フォルダ / 不正 URL）を置いてから起動しても
 *      平坦化・除去が効き、**2 回読み込んでも結果が同じ**（冪等）
 *   7. **設定画面に実際にカードが描かれる**。IPC だけ見ていると `Slots.tsx` の描画例外
 *      （＝設定画面が丸ごと落ちる）を素通りするので、`OWNERS` の割り当てが嘘になる
 *
 * **`NEMO_SLOTS_DIR` を必ず渡す。** 渡し忘れると実 iCloud の常用スロットに書くので、
 * 起動直後に解決先が `env` であることを確かめてから先へ進む。
 *
 * 使い方:
 *   node scripts/verify-slots.mjs        （事前に out/ がビルドされていること）
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

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const spawned = []
const dirs = []
const lockedFiles = []

function makeDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-slots-${tag}-`))
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
      NEMO_DOWNLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-slots-dl-'))
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/**
 * UI に CDP でつないで式を1つ評価する。
 *
 * `view` で対象を選ぶ。設定画面は**サイドバーとは別の target**（`view=overlay`）なので、
 * 描画の確認はそちらにつながないと見えない。
 */
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

const json = async (cdp, expression) => JSON.parse(await evalInUi(cdp, expression))

/** ピン留め / お気に入りを 1 つずつ作る（枠とタブの両方ができる）。 */
async function seedDefinitions(cdp) {
  await evalInUi(
    cdp,
    `(async () => {
      const key = await window.nemo.createTab('https://example.com/pinned', {})
      await window.nemo.pinTab(key)
      const other = await window.nemo.createTab('https://example.org/fav', {})
      await window.nemo.addFavorite(other)
    })()`
  )
}

function readPins(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'pins.json'), 'utf8')).data
}

function readSlotFile(slotsDir, index = 1) {
  return JSON.parse(fs.readFileSync(path.join(slotsDir, `slot-${index}.json`), 'utf8'))
}

/** 定義の ID を総入れ替えする（＝別の Mac で作られたスロットと同じ形）。 */
function reidentify(data) {
  let n = 0
  const fresh = () => `remote-${(n += 1)}`
  return {
    ...data,
    favorites: data.favorites.map((item) => ({ ...item, id: fresh() })),
    pinned: data.pinned.map((node) =>
      node.kind === 'folder'
        ? { ...node, id: fresh(), children: node.children.map((c) => ({ ...c, id: fresh() })) }
        : { ...node, id: fresh() }
    )
  }
}

try {
  assertNemoNotRunning('verify-slots')
  if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js'))) {
    throw new Error('out/ が無い。先に pnpm build する')
  }

  /* ---------------- 保存 → 同じ枠を読み込む ---------------- */
  const userDataDir = makeDir('data')
  const slotsDir = makeDir('slots')
  {
    const { cdp } = await bootApp(userDataDir, slotsDir)

    // **実 iCloud に書いていないことを最初に確かめる**（渡し忘れの検出）
    const list = await json(cdp, 'window.nemo.listSlots().then(JSON.stringify)')
    check('保存先が env の上書きで解決されている', list.kind === 'env', `${list.kind} ${list.dir}`)
    check(
      '最初は 3 枠とも空き',
      list.slots.every((s) => s.state === 'empty'),
      JSON.stringify(list.slots.map((s) => s.state))
    )

    await seedDefinitions(cdp)
    const before = await json(cdp, 'window.nemo.getSharedState().then(JSON.stringify)')
    check(
      '定義を作れた（ピン留め 1・お気に入り 1）',
      before.pinned.length === 1 && before.favorites.length === 1,
      `pinned=${before.pinned.length} favorites=${before.favorites.length}`
    )

    const saved = await evalInUi(cdp, 'window.nemo.saveSlot(0, "検証用")')
    check('保存できた', saved === true, String(saved))

    const file = readSlotFile(slotsDir)
    check(
      '{ version, data } 形式で書かれている',
      file.version === 1 && !!file.data,
      JSON.stringify(Object.keys(file))
    )
    check('スロットの名前が入っている', file.data.name === '検証用', String(file.data.name))
    check(
      'スロットにピン留めとお気に入りが入っている',
      file.data.pinned.length === 1 && file.data.favorites.length === 1
    )

    // 埋まっている枠には書かない（別の Mac のスロットを潰さない）
    const twice = await evalInUi(cdp, 'window.nemo.saveSlot(0, "二度目")')
    check('埋まっている枠には保存しない', twice === false, String(twice))

    /* --- 同じ枠を読み込む → 降格 0 件、かつ中身が一致 --- */
    const applied = await evalInUi(cdp, 'window.nemo.applySlot(0)')
    check('同じ枠を読み込めた', applied === true, String(applied))

    const win = await json(cdp, 'window.nemo.getWindowState().then(JSON.stringify)')
    const stillOwned = win.tabs.filter((t) => t.pinnedId || t.favoriteId).length
    check(
      '同じ枠の読み込みで降格が起きない（ID が一致するので定義もタブもそのまま）',
      stillOwned === 2,
      `所属タブ ${stillOwned} 本`
    )
    // 降格 0 件だけだと no-op でも通る。**中身の一致まで見る**
    const pins = readPins(userDataDir)
    check(
      '読み込み後の pins.json がスロットの中身と一致する',
      JSON.stringify(pins.pinned) === JSON.stringify(file.data.pinned) &&
        JSON.stringify(pins.favorites) === JSON.stringify(file.data.favorites),
      `pinned=${pins.pinned.length} favorites=${pins.favorites.length}`
    )

    /* --- 名前変更は中身を変えない --- */
    await evalInUi(cdp, 'window.nemo.renameSlot(0, "名前だけ変更")')
    const renamed = readSlotFile(slotsDir)
    check('名前だけ変わる', renamed.data.name === '名前だけ変更', String(renamed.data.name))
    check(
      '名前変更で中身は変わらない',
      JSON.stringify(renamed.data.pinned) === JSON.stringify(file.data.pinned) &&
        JSON.stringify(renamed.data.favorites) === JSON.stringify(file.data.favorites)
    )

    /* --- 設定画面に実際に描かれる（Slots.tsx を OWNERS でこのスイートに割り当てている根拠） --- */
    await evalInUi(cdp, `window.nemo.setOverlay('settings').then(() => 'ok')`)
    const deadline = Date.now() + 15000
    let cards = 0
    while (Date.now() < deadline) {
      try {
        cards = await evalInUi(
          cdp,
          `document.querySelectorAll('[data-testid="slots"] .slot').length`,
          'overlay'
        )
      } catch {
        cards = 0
      }
      if (cards === 3) break
      await sleep(300)
    }
    check('設定画面にカードが 3 枚描かれる', cards === 3, `${cards} 枚`)
    // 描画そのものが落ちていないか（例外だと 0 枚になるので、中身まで見る）
    const cardText = await evalInUi(
      cdp,
      `document.querySelector('[data-testid="slot-0"]')?.innerText ?? ''`,
      'overlay'
    )
    check(
      'SLOT 1 のカードに保存した名前が出ている',
      cardText.includes('名前だけ変更'),
      JSON.stringify(cardText)
    )
    // 設定画面の節は固定（タブ / 起動と検索 / 既定のブラウザ / キーバインド は画面に出さない）
    const headings = JSON.parse(
      await evalInUi(
        cdp,
        `JSON.stringify([...document.querySelectorAll('.settings section h3')].map((h) => h.textContent))`,
        'overlay'
      )
    )
    const expectedHeadings = [
      'Chrome 拡張',
      'GitHub の PR',
      'HTTP 認証',
      'HTTP 認証の持ち出し',
      'ブックマークの持ち出し',
      'データ'
    ]
    check(
      `設定画面の節が ${expectedHeadings.length} つだけ描かれる`,
      JSON.stringify(headings) === JSON.stringify(expectedHeadings),
      JSON.stringify(headings)
    )
    await evalInUi(cdp, `window.nemo.setOverlay(null).then(() => 'ok')`)

    await stopChildren(spawned.splice(0))
  }

  /* ---------------- 別 Mac 相当のスロットを読み込む ---------------- */
  {
    // ID を総入れ替えして 2 枠目に置く（＝別の Mac で保存されたのと同じ形）
    const original = readSlotFile(slotsDir)
    fs.writeFileSync(
      path.join(slotsDir, 'slot-2.json'),
      `${JSON.stringify({ version: 1, data: reidentify(original.data) }, null, 2)}\n`
    )

    const { cdp } = await bootApp(userDataDir, slotsDir)
    // 枠をクリックした状態を作る（タブ実体を出してから読み込む）
    await evalInUi(
      cdp,
      `(async () => {
        const state = await window.nemo.getSharedState()
        await window.nemo.openPinned(state.pinned[0].id)
        await window.nemo.openFavorite(state.favorites[0].id)
      })()`
    )
    const owned = await json(
      cdp,
      'window.nemo.getWindowState().then((s) => JSON.stringify(s.tabs.filter((t) => t.pinnedId || t.favoriteId).length))'
    )
    check('読み込む前に所属タブが 2 本ある（0 本だと降格の検査が空振りする）', owned === 2, `${owned} 本`)

    // **定義に名前を付けてから**読み込む。降格でタブに写る名前の出どころは定義側しか無いので、
    // 付けずに検査すると「名前を保っている」が URL を見ているだけになる
    await evalInUi(
      cdp,
      `(async () => {
        const state = await window.nemo.getSharedState()
        await window.nemo.renameNode(state.pinned[0].id, 'ぼくのピン')
        await window.nemo.renameNode(state.favorites[0].id, 'ぼくのお気に入り')
      })()`
    )

    const applied = await evalInUi(cdp, 'window.nemo.applySlot(1)')
    check('別 Mac 相当のスロットを読み込めた', applied === true, String(applied))

    const after = await json(cdp, 'window.nemo.getSharedState().then(JSON.stringify)')
    const winAfter = await json(cdp, 'window.nemo.getWindowState().then(JSON.stringify)')
    const newIds = new Set([
      ...after.favorites.map((f) => f.id),
      ...after.pinned.flatMap((p) => [p.id, ...(p.children ?? []).map((c) => c.id)])
    ])
    const orphan = winAfter.tabs.filter((t) => {
      const id = t.pinnedId ?? t.favoriteId
      return id && !newIds.has(id)
    })
    check('新定義に無い ID を持ったままのタブが 1 本も無い', orphan.length === 0, `${orphan.length} 本`)

    const demoted = winAfter.tabs.filter((t) => !t.pinnedId && !t.favoriteId && /^https?:/.test(t.url))
    check('降格したタブが「今日のタブ」に出ている', demoted.length >= 2, `${demoted.length} 本`)
    const names = demoted.map((t) => t.customTitle)
    check(
      '降格したタブが定義に付けていた名前を保っている',
      names.includes('ぼくのピン') && names.includes('ぼくのお気に入り'),
      JSON.stringify(names)
    )

    /* --- 削除 → 空きに戻る --- */
    await evalInUi(cdp, 'window.nemo.deleteSlot(1)')
    const list = await json(cdp, 'window.nemo.listSlots().then(JSON.stringify)')
    check('削除した枠は空きに戻る', list.slots[1].state === 'empty', list.slots[1].state)
    check('ファイルも消えている', !fs.existsSync(path.join(slotsDir, 'slot-2.json')))

    check('未捕捉例外が出ていない', findUncaughtExceptions(userDataDir).length === 0)
    await stopChildren(spawned.splice(0))
  }

  /* ---------------- 読めない枠は「空き」に倒さない ---------------- */
  {
    const brokenSlots = makeDir('broken')
    const brokenData = makeDir('broken-data')
    const file = path.join(brokenSlots, 'slot-1.json')
    fs.writeFileSync(file, '{"version":1,"data":{"name":"読めない"}}\n')
    fs.chmodSync(file, 0o000)
    lockedFiles.push(file)
    // version が壊れている枠（退避される）と、未来の版の枠（退避しない）を並べて置く
    fs.writeFileSync(path.join(brokenSlots, 'slot-2.json'), '{"version":0,"data":{}}\n')
    fs.writeFileSync(path.join(brokenSlots, 'slot-3.json'), '{"version":99,"data":{}}\n')

    const { cdp } = await bootApp(brokenData, brokenSlots)
    const list = await json(cdp, 'window.nemo.listSlots().then(JSON.stringify)')
    check(
      '読めない枠は「空き」ではなく unreadable',
      list.slots[0].state === 'unreadable',
      `${list.slots[0].state} ${list.slots[0].reason ?? ''}`
    )
    // 空きに倒れると保存ボタンが出て、押した瞬間に別 Mac のスロットを潰す
    const saved = await evalInUi(cdp, 'window.nemo.saveSlot(0, "潰す")')
    check('読めない枠には保存できない', saved === false, String(saved))

    /* --- 壊れ と 未来の版 は別扱い（前者だけ退避する） --- */
    check(
      'version が壊れた枠は「中身が壊れていました」',
      list.slots[1].state === 'unreadable' && list.slots[1].reason === '中身が壊れていました',
      `${list.slots[1].state} ${list.slots[1].reason ?? ''}`
    )
    check(
      '未来の版は「新しい版の Nemo で保存されています」',
      list.slots[2].state === 'unreadable' && list.slots[2].reason?.includes('新しい版'),
      `${list.slots[2].state} ${list.slots[2].reason ?? ''}`
    )
    const quarantined = fs.readdirSync(brokenSlots).filter((n) => n.includes('.broken-'))
    check('壊れた枠は消さずに退避される', quarantined.length === 1, JSON.stringify(quarantined))
    check(
      '未来の版は退避しない（新しい Nemo が書いたものを古い Nemo が捨てない）',
      fs.existsSync(path.join(brokenSlots, 'slot-3.json'))
    )

    /* --- カードの「再試行」（= もう一度 listSlots）で、退避済みの枠は空きに戻る --- */
    await evalInUi(cdp, `window.nemo.setOverlay('settings').then(() => 'ok')`)
    const retryDeadline = Date.now() + 15000
    let hasRetry = false
    while (Date.now() < retryDeadline) {
      try {
        hasRetry = await evalInUi(cdp, `!!document.querySelector('[data-testid="slot-retry-0"]')`, 'overlay')
      } catch {
        hasRetry = false
      }
      if (hasRetry) break
      await sleep(300)
    }
    check('読めない枠のカードに「再試行」が出る（常時無効のボタンを置かない）', hasRetry === true)
    await evalInUi(cdp, `window.nemo.setOverlay(null).then(() => 'ok')`)

    const again = await json(cdp, 'window.nemo.listSlots().then(JSON.stringify)')
    check(
      '再試行すると、退避済みの枠は「空き」に戻る',
      again.slots[1].state === 'empty',
      `${again.slots[1].state} ${again.slots[1].reason ?? ''}`
    )
    check(
      '再試行しても未来の版は unreadable のまま',
      again.slots[2].state === 'unreadable',
      again.slots[2].state
    )
    check(
      '再試行しても権限の無い枠は unreadable のまま',
      again.slots[0].state === 'unreadable',
      again.slots[0].state
    )

    await stopChildren(spawned.splice(0))
  }

  /* ---------------- 旧 / 不正フォーマットの取り込み（移行の経路） ---------------- */
  {
    const migSlots = makeDir('migrate')
    const migData = makeDir('migrate-data')
    // 2 階層フォルダ・不正 URL・重複 ID を混ぜた fixture
    fs.writeFileSync(
      path.join(migSlots, 'slot-1.json'),
      `${JSON.stringify(
        {
          version: 1,
          data: {
            name: '旧フォーマット',
            savedAt: 1_700_000_000_000,
            host: 'Old-Mac',
            favorites: [
              { id: 'f1', url: 'https://ok.example/', title: 'ok', customTitle: null },
              { id: 'f2', url: 'file:///etc/passwd', title: 'ng', customTitle: null }
            ],
            pinned: [
              {
                id: 'outer',
                kind: 'folder',
                title: '外',
                customTitle: null,
                collapsed: false,
                children: [
                  {
                    id: 'inner',
                    kind: 'folder',
                    title: '中',
                    customTitle: null,
                    collapsed: false,
                    children: [
                      {
                        id: 'deep',
                        kind: 'link',
                        url: 'https://deep.example/',
                        title: '奥',
                        customTitle: null
                      }
                    ]
                  }
                ]
              },
              { id: 'bad', kind: 'link', url: 'javascript:alert(1)', title: 'ng', customTitle: null }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    const { cdp } = await bootApp(migData, migSlots)
    await evalInUi(cdp, 'window.nemo.applySlot(0)')
    const first = await json(cdp, 'window.nemo.getSharedState().then(JSON.stringify)')
    check('不正 URL のお気に入りは落ちる', first.favorites.length === 1, `${first.favorites.length} 件`)
    check('不正 URL のピン留めは落ちる', first.pinned.length === 1, `${first.pinned.length} 件`)
    const outer = first.pinned[0]
    check(
      '2 階層フォルダは中身が親へ平坦化される（黙って消さない）',
      outer.kind === 'folder' && outer.children.length === 1 && outer.children[0].id === 'deep',
      JSON.stringify(outer.children?.map((c) => c.id))
    )

    // 同じ fixture をもう一度読み込んでも結果が同じ（冪等）
    await evalInUi(cdp, 'window.nemo.applySlot(0)')
    const second = await json(cdp, 'window.nemo.getSharedState().then(JSON.stringify)')
    check(
      '同じ fixture を 2 回読み込んでも結果が同じ（冪等）',
      JSON.stringify(second.pinned) === JSON.stringify(first.pinned) &&
        JSON.stringify(second.favorites) === JSON.stringify(first.favorites)
    )
    check('移行の経路で未捕捉例外が出ていない', findUncaughtExceptions(migData).length === 0)
    await stopChildren(spawned.splice(0))
  }
} catch (error) {
  failures += 1
  console.error(`FAIL  例外で中断 — ${error?.stack ?? error}`)
} finally {
  await stopChildren(spawned.splice(0))
  // 読み取り不可にした**ファイルだけ**戻す。ディレクトリまで触ると実行ビットが落ちて
  // 中をたどれなくなり、rmSync が ENOTEMPTY で落ちる
  for (const file of lockedFiles) {
    try {
      fs.chmodSync(file, 0o644)
    } catch {
      /* すでに消えている */
    }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全て PASS' : `\n${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
