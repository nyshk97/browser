#!/usr/bin/env node
/**
 * Peek（ウィンドウ内ポップアップ）と小窓（Little Nemo）の自走検証。
 *
 * 見るもの（計画の R1〜R11 に対応）:
 *
 * - **R1**: `target=_blank` の POST body が Peek に届く / `window.opener.postMessage` が親に届く /
 *   `window.close()` で Peek が閉じる（= `deny` + URL 作り直しに戻っていないこと）
 * - **R2**: chrome から見た active が Peek を指す。別タブへ行って**戻ったあとも**指す
 *   （1回撃つだけの実装だとここで落ちる）。無限再入していないこと
 * - **R8**: Peek の中の popup で Peek が昇格し、`window.opener.postMessage` が届く
 * - **R9**: Peek を持つ親タブを別ウィンドウへ移すと Peek も付いてくる
 * - **R11**: 昇格したタブは**元の親タブを閉じても残る**（`outlivesOpener`）。
 *   昇格していない Peek は親と一緒に閉じる（閉じ漏れて見えない WebContents が残らない）
 * - 小窓: 外部 URL で1枚できる / 上限4枚 / セッションに含まれない / ⌘⇧T で戻せる /
 *   ⌘W でウィンドウごと閉じる / ⌘O で通常ウィンドウへ移る
 *
 * ここで見られないもの（Phase 8 で実機確認する）:
 * - **Space とフォーカス**（フルスクリーンの上に出るか・前面を奪わないか）。
 *   Phase 0 のスパイクで測ってあるが、実ターミナルでの確認は人が行う
 * - **⌘クリックの背面タブ**。`disposition: 'background-tab'` は合成キーでしか作れず、
 *   メニューのアクセラレータと同じで CDP からは撃てない
 * - **実 Vault の Bitwarden**での自動入力
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, connectTo, connectUi, listTargets, sleep, waitFor } from './lib/cdp.mjs'
import { countLogEvents, projectRoot, readLogLines } from './lib/harness.mjs'
import { afterSessionSave, afterSweep } from './lib/timings.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const CDP = process.env.NEMO_CDP ?? 'http://127.0.0.1:9333'
const PAGES = process.env.NEMO_TEST_PAGES ?? 'http://127.0.0.1:8787'
const USER_DATA = process.env.NEMO_USER_DATA_DIR ?? ''

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 道具
 * ------------------------------------------------------------------ */

const ui = await connectUi(CDP)
const state = () => ui.ev('window.nemo.getWindowState().then((s) => JSON.stringify(s))').then(JSON.parse)
const call = (expression) => ui.ev(`${expression}.then(() => 'ok')`)

/**
 * ユーザー操作として評価する。
 * **`window.open` は普通の `Runtime.evaluate` ではポップアップブロッカーに弾かれる**ので、
 * Peek を開く経路は必ずこちらを使う。
 */
async function evUser(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  const details = r.result?.exceptionDetails
  if (details) throw new Error(details.exception?.description ?? details.text ?? 'eval failed')
  return r.result?.result?.value
}

/**
 * 「自分が繋いでいる WebContents ごと消える」操作を撃つ。
 *
 * 小窓を閉じる系（⌘W / ⌘O）は**その小窓の UI WebContents 自体が破棄される**ので、
 * `ev` の応答が返ってこず永久に待つ。撃ちっぱなしにして時間で切り上げる。
 */
async function evSuicidal(session, expression) {
  if (!session) return
  await Promise.race([session.ev(expression).catch(() => null), sleep(2500).then(() => null)])
}

/** URL 完全一致でページ target に繋ぐ（UI 自身を掴まないように部分一致で選ばない）。 */
async function connectPage(url, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await listTargets(CDP)).filter((t) => t.type === 'page' && t.url === url)
    if (found.length === 1) return connect(found[0].webSocketDebuggerUrl)
    if (Date.now() > deadline) {
      throw new Error(`ページの target が1つに定まらない: ${url}（${found.length} 件）`)
    }
    await sleep(250)
  }
}

/** 生きているページ target の数（閉じ漏れた WebContents を数えるのに使う）。 */
async function pageTargetCount(urlPart) {
  const targets = await listTargets(CDP)
  return targets.filter((t) => t.type === 'page' && t.url.includes(urlPart)).length
}

/** プレースホルダーの面の色（DESIGN.md「Peek」の `--nemo-sidebar`）。 */
const PLACEHOLDER_RGB = '#1b1b20'
/** 待ち表現の頭文字タイル（`--nemo-surface-hi`）と文字（`--nemo-ink`）。 */
const LOADING_TILE_RGB = '#33333d'
const LOADING_INK_RGB = '#e8e8ee'
/**
 * ピクセル比較の許容差（各チャンネル）。
 * **`sips` を通すと色が 1〜2 ずれる**（PNG → BMP でカラープロファイルが噛む。
 * 実測で `#1b1b20` が `#1c1c1f` になった）ので、完全一致では見られない。
 */
const COLOR_TOLERANCE = 4

/** 2つの `#rrggbb` が許容差の中に収まっているか。 */
function nearlyEqual(a, b, tolerance = COLOR_TOLERANCE) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [x, y] = [parse(a), parse(b)]
  return x.every((v, i) => Math.abs(v - y[i]) <= tolerance)
}

/**
 * 32bpp BMP から色を読む小さな道具。
 * `sips` を通すのは、**PNG デコーダを持ち込まずにピクセルを見る**ため。
 */
function readBmp(file) {
  const d = fs.readFileSync(file)
  const offset = d.readUInt32LE(10)
  const width = d.readInt32LE(18)
  const rawHeight = d.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  const bpp = d.readUInt16LE(28)
  const bytes = bpp / 8
  // 24bpp は行が 4 バイト境界に揃う
  const stride = Math.ceil((width * bytes) / 4) * 4
  const at = (x, y) => {
    const px = Math.min(Math.max(Math.round(x), 0), width - 1)
    const py = Math.min(Math.max(Math.round(y), 0), height - 1)
    const row = topDown ? py : height - 1 - py
    const i = offset + row * stride + px * bytes
    return `#${[d[i + 2], d[i + 1], d[i]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  return { width, height, at }
}

/**
 * 暗幕の UI View を撮って、プレースホルダーの中央・内側の縁・角の色を返す。
 *
 * **合成後の画面（`screencapture`）は使わない**。ウィンドウが別 Space にあると
 * 古い絵が返るので判定に使えない（plan のログを見る）。ここはレンダラ単体を撮る。
 * 撮れた画は**物理ピクセル**なので、画像の幅と viewport の幅から倍率を出して換算する。
 */
async function samplePlaceholderPixels(session, measured) {
  if (!measured.found) return { error: 'プレースホルダーが無いので撮っても意味がない' }
  const png = path.join(os.tmpdir(), 'nemo-verify-peek-placeholder.png')
  const bmp = path.join(os.tmpdir(), 'nemo-verify-peek-placeholder.bmp')
  try {
    await session.send('Page.enable')
    /*
     * **地を指定して合成させてから撮る**。透過のまま撮ると alpha を捨てて読むことになり、
     * 面が半透明でも RGB だけは期待どおりに見えてしまう（祖先の `opacity` や
     * フェードの途中を「正しい色」と誤判定する）。
     * 合成させれば薄いぶんだけ色がずれる —— `.peek-placeholder` に `opacity: 0.5` を
     * 入れて実測すると `#1b1b20` が `#141419` になり、この検査は FAIL する。
     */
    await session.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 255, g: 255, b: 255, a: 1 }
    })
    /*
     * 暗幕のフェードイン（`peek-fade`）を**待たずに終端へ飛ばす**。
     * 「終わるまで待つ」形にすると、描画が遅い環境で待ち切れずに途中を撮り、
     * 薄く写った絵で偽 FAIL になる。
     */
    await session.ev(
      "(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { /* 無限アニメは飛ばせない */ } } return 'done' })()"
    )
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(png, Buffer.from(shot.result.data, 'base64'))

    // **前回の BMP を必ず消してから変換する**。残っていると、変換に失敗しても
    // 古い画像を読んで PASS してしまう
    fs.rmSync(bmp, { force: true })
    const converted = spawnSync('/usr/bin/sips', ['-s', 'format', 'bmp', png, '--out', bmp], {
      encoding: 'utf8'
    })
    if (converted.status !== 0) return { error: `sips が失敗した: ${converted.stderr ?? ''}` }
    if (!fs.existsSync(bmp)) return { error: 'sips が BMP を書かなかった' }

    const image = readBmp(bmp)
    const scale = image.width / measured.viewport.w
    const r = measured.rect
    const at = (x, y) => image.at(x * scale, y * scale)
    const lr = measured.loading?.letterRect
    return {
      file: png,
      scale,
      image: `${image.width}x${image.height}`,
      // **中央は見ない**。中央には待ち表現（頭文字・ホスト名）が乗っているので、面の色は左上 1/4 の点で見る
      face: at(r.x + r.w / 4, r.y + r.h / 4),
      insideEdge: at(r.x + 4, r.y + r.h / 2),
      // 角丸の外側。**面の色が来たら丸まっていない**
      corner: at(r.x + 1, r.y + 1),
      // 頭文字のタイルの中央。文字（ink）が来ることもあるので、タイルの色か文字の色のどちらか
      letter: lr ? at(lr.x + lr.w / 2, lr.y + lr.h / 2) : null
    }
  } catch (error) {
    return { error: String(error) }
  } finally {
    // **途中で落ちても地の指定は必ず戻す**。残すと後続の検査の描画条件が変わる
    await session.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => null)
  }
}

const peekOf = (s, parentKey) => s.tabs.find((t) => t.peekParentKey === parentKey) ?? null
const normalTabs = (s) => s.tabs.filter((t) => t.peekParentKey === null)

/**
 * 診断ログの最後の `tab.foreground`（= chrome から見た active）。
 *
 * **ウィンドウを指定できるようにしてある**。ウィンドウ間の移動では
 * 移動先の同期のあとに移動元の「次のタブを選ぶ」が走るので、
 * 全体の最後の1件を見ると移動元の結果を読んでしまう。
 */
function lastForeground(windowId = null) {
  return lastLogEntry('tab.foreground', windowId)
}

/**
 * 診断ログの最後の1件（イベント名で絞る。`windowId` を渡すとそのウィンドウ分だけ）。
 * **`windowId` の絞り込みは detail に `windowId` を出しているイベントに限る**
 * （`copy_url.requested` / `find.requested` は出していないので、渡すと黙って常に null になる）。
 */
function lastLogEntry(event, windowId = null) {
  if (!USER_DATA) return null
  const lines = readLogLines(USER_DATA)
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null && (windowId === null || entry.windowId === windowId))
  return lines[lines.length - 1] ?? null
}

/** 親タブを1つ用意して Peek のテストページを開く。 */
async function openParent(site) {
  const url = `${PAGES}/peek.html?site=${site}`
  const key = await ui.ev(`window.nemo.createTab(${JSON.stringify(url)})`)
  const page = await connectPage(url)
  await waitFor(page, "document.readyState === 'complete' ? 'ok' : ''")
  return { key, url, page }
}

/* ------------------------------------------------------------------ *
 * 1. R1 — 新しい browsing context に付随するもの
 * ------------------------------------------------------------------ */

console.log('\n--- R1: POST body / window.opener / window.close')

{
  const parent = await openParent('post')
  await evUser(parent.page, "document.querySelector('#post-form').submit()")
  await sleep(1200)

  const s = await state()
  const peek = peekOf(s, parent.key)
  check('POST を target=_blank で投げると Peek ができる', peek !== null, peek ? peek.url : '(無し)')

  if (peek) {
    const echo = await connectPage(`${PAGES}/__nemo_echo__`)
    await waitFor(echo, "document.readyState === 'complete' ? 'ok' : ''")
    const method = await echo.ev("document.querySelector('#method').textContent")
    const body = await echo.ev("document.querySelector('#body').textContent")
    echo.close()
    check('Peek に POST として届く', method === 'POST', `method=${method}`)
    check(
      'POST の body が落ちていない',
      String(body).includes('nemo=peek-post-body'),
      `body=${JSON.stringify(body)}`
    )
    await call(`window.nemo.closePeek()`)
    await sleep(400)
  }
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

{
  const parent = await openParent('opener')
  await evUser(parent.page, "document.querySelector('#open-child').click()")
  await sleep(1500)

  const received = await parent.page.ev('JSON.stringify(window.__fromChild ?? [])')
  check(
    'window.opener.postMessage が親に届く',
    String(received).includes('nemo-peek-child-hello'),
    String(received)
  )

  await call(`window.nemo.closePeek()`)
  await sleep(400)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

{
  const parent = await openParent('selfclose')
  await evUser(parent.page, "document.querySelector('#open-selfclose').click()")
  await sleep(800)
  const opened = peekOf(await state(), parent.key)
  check('子が Peek として開く', opened !== null)

  await sleep(2500)
  const after = peekOf(await state(), parent.key)
  check('window.close() で Peek が閉じる', after === null, after ? `残っている: ${after.url}` : '')

  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

/* ------------------------------------------------------------------ *
 * 2. Peek の基本（一覧・可視・タブ切り替え）
 * ------------------------------------------------------------------ */

console.log('\n--- Peek の基本')

const base = await openParent('base')
await evUser(base.page, "document.querySelector('#open-blank').click()")
await sleep(1200)

{
  const s = await state()
  const peek = peekOf(s, base.key)
  check('target=_blank が Peek になる', peek !== null)
  check(
    'Peek は一覧（一時タブ）に出ない',
    s.tabs.some((t) => t.peekParentKey === base.key) && !normalTabs(s).some((t) => t.key === peek?.key)
  )
  check('サイドバーで選択されているのは親タブのまま', s.activeTabKey === base.key, `active=${s.activeTabKey}`)

  const visible = await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  const keys = JSON.parse(visible)
  check(
    'getVisibleTabKeys() が親と Peek の2つを返す',
    keys.length === 2 && keys.includes(base.key) && keys.includes(peek?.key),
    visible
  )

  const fg = lastForeground()
  check(
    'chrome から見た active が Peek を指す',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )
}

/* R2（再計算）: 別タブへ行って戻る */
{
  const other = await ui.ev(`window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)})`)
  await sleep(600)
  const hidden = await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  check('別タブへ行くと Peek は隠れる', JSON.parse(hidden).length === 1, hidden)

  const before = countLogEvents(USER_DATA, 'tab.foreground')
  await call(`window.nemo.selectTab(${JSON.stringify(base.key)})`)
  await sleep(600)
  const backVisible = JSON.parse(
    await ui.ev('window.nemo.getVisibleTabKeys().then((k) => JSON.stringify(k))')
  )
  check('戻ると Peek が復帰する', backVisible.length === 2, JSON.stringify(backVisible))

  const s = await state()
  const peek = peekOf(s, base.key)
  const fg = lastForeground()
  check(
    'R2: 戻ったあとも chrome の active は Peek（毎回再計算している）',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )

  /* R2（再入）: 切り替えを繰り返しても呼び出し回数が有限であること */
  for (let i = 0; i < 5; i += 1) {
    await call(`window.nemo.selectTab(${JSON.stringify(other)})`)
    await call(`window.nemo.selectTab(${JSON.stringify(base.key)})`)
  }
  await sleep(800)
  const after = countLogEvents(USER_DATA, 'tab.foreground')
  check(
    'R2: 切り替えを繰り返しても同期が有限回で収まる（無限再入していない）',
    after - before < 60,
    `${after - before} 回`
  )
  const crashes = readLogLines(USER_DATA).filter((l) => l.includes('app.uncaught_exception')).length
  check('main の未捕捉例外が出ていない', crashes === 0, `${crashes} 件`)

  await call(`window.nemo.closeTab(${JSON.stringify(other)})`)
  await sleep(300)
}

/* ------------------------------------------------------------------ *
 * 3. プレースホルダー（中身が来るまでの「窓の形」）
 * ------------------------------------------------------------------ */

console.log('\n--- プレースホルダー')

{
  /**
   * **合成後の画面は見ない**。`screencapture` はウィンドウが別 Space にあると
   * 古い絵を返すので、ピクセル判定に使えない（実測。plan のログを見る）。
   * ここでは暗幕の UI View そのものに CDP で繋いで、レンダラの中で判定する。
   */
  const parent = await openParent('placeholder')
  const gateId = `verify-${process.pid}-${Date.now()}`
  const gateUrl = `${PAGES}/__nemo_gate__?id=${gateId}`
  const gateState = async () => await (await fetch(`${PAGES}/__nemo_gate_state__?id=${gateId}`)).json()

  await evUser(parent.page, `window.open(${JSON.stringify(gateUrl)}, '_blank')`)
  // **固定の sleep で間に合わせない**。リクエストが着いたことを確かめてから測る
  for (let i = 0; i < 60; i += 1) {
    if ((await gateState()).arrived >= 1) break
    await sleep(200)
  }
  check('止まる URL でも Peek はできる', (await gateState()).arrived >= 1)
  await sleep(400)

  const held = await state()
  const heldPeek = peekOf(held, parent.key)
  check('中身が来るまで Peek の View は出さない', heldPeek?.visible === false, `visible=${heldPeek?.visible}`)

  const chrome = await connectTo(CDP, 'view=peek')
  /**
   * 矩形・色・角丸をレンダラの中で測る。
   * **角は `elementFromPoint` で見る**（角丸は当たり判定にも効くので、
   * 角の内側 2px がプレースホルダー以外を返せば「丸まっている」と言える）。
   */
  const probe = `(() => {
    const el = document.querySelector('.peek-placeholder')
    if (!el) return JSON.stringify({ found: false })
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const at = (x, y) => (document.elementFromPoint(x, y) === el ? 'placeholder' : (document.elementFromPoint(x, y)?.className ?? 'none'))
    return JSON.stringify({
      found: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: innerWidth, h: innerHeight },
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      center: at(r.x + r.width / 2, r.y + r.height / 2),
      insideEdge: at(r.x + 4, r.y + r.height / 2),
      corner: at(r.x + 2, r.y + 2),
      // 待ち表現（頭文字・ホスト名）。頭文字のタイルは矩形も取ってピクセルで見る
      loading: (() => {
        const letter = el.querySelector('.peek-loading-letter')
        const host = el.querySelector('.peek-loading-host')
        if (!letter || !host) return null
        const lr = letter.getBoundingClientRect()
        return {
          letter: letter.textContent,
          host: host.textContent,
          letterRect: { x: Math.round(lr.x), y: Math.round(lr.y), w: Math.round(lr.width), h: Math.round(lr.height) },
          dots: el.querySelectorAll('.peek-loading-dots i').length
        }
      })()
    })
  })()`
  const measured = JSON.parse(await chrome.ev(probe))
  check('プレースホルダーが描かれている', measured.found === true)
  check('面の色が DESIGN.md の値', measured.background === 'rgb(27, 27, 32)', String(measured.background))
  check('角丸 16px', measured.radius === '16px', String(measured.radius))
  check(
    '中央と内側の縁がプレースホルダー（待ち表現は当たり判定に参加しない）',
    measured.center === 'placeholder' && measured.insideEdge === 'placeholder',
    JSON.stringify({ center: measured.center, insideEdge: measured.insideEdge })
  )
  /*
   * 待ち表現（DESIGN.md「Peek」）: リンク先の URL だけから作るので、板が出た時点で揃っている。
   * ホストは gate の URL から**期待値を作って**突き合わせる（「何か出ている」では足りない）。
   */
  const gateHost = new URL(gateUrl).host
  check(
    '板の上に行き先のホスト名と頭文字が出る',
    measured.loading?.host === gateHost && measured.loading?.letter === gateHost.slice(0, 1).toUpperCase(),
    JSON.stringify(measured.loading)
  )
  check('ドットが 3 つ', measured.loading?.dots === 3, `dots=${measured.loading?.dots}`)
  // **`found` を条件に入れる**。入れないと「そもそも描かれていない」ときに素通りで PASS になる
  check(
    '角は丸まっている（角の内側は当たらない）',
    measured.found === true && measured.corner !== 'placeholder',
    `corner=${measured.corner}`
  )

  /*
   * **実際に描かれた色をピクセルで見る**。DOM と computed style だけだと、
   * 祖先に `opacity: 0` が付いているような「要素はあるのに見えない」を通してしまう。
   */
  const pixels = await samplePlaceholderPixels(chrome, measured)
  if (pixels.error) {
    check('プレースホルダーのピクセルを確認できた', false, pixels.error)
  } else {
    check(
      'ピクセルでも面が DESIGN.md の色（合成しても色がずれない＝不透明）',
      nearlyEqual(pixels.face, PLACEHOLDER_RGB) && nearlyEqual(pixels.insideEdge, PLACEHOLDER_RGB),
      JSON.stringify(pixels)
    )
    // 待ち表現が**実際に描かれている**こと（DOM にあるだけで `opacity: 0` の類を通さない）。
    // 頭文字タイルの中央はタイルの色（`--nemo-surface-hi`）か文字の色（`--nemo-ink`）のどちらか
    check(
      'ピクセルでも頭文字のタイルが描かれている',
      pixels.letter !== null &&
        (nearlyEqual(pixels.letter, LOADING_TILE_RGB) || nearlyEqual(pixels.letter, LOADING_INK_RGB)),
      `letter=${pixels.letter}`
    )
    check(
      'ピクセルでも角が抜けている（角丸）',
      !nearlyEqual(pixels.corner, PLACEHOLDER_RGB),
      `corner=${pixels.corner} scale=${pixels.scale} img=${pixels.image}`
    )
    console.log(`      スクショ: ${pixels.file}`)
  }

  /* 解放したら本体が出て、プレースホルダーは消える */
  await (await fetch(`${PAGES}/__nemo_gate_release__?id=${gateId}`)).json()
  await sleep(1500)
  const after = await state()
  const afterPeek = peekOf(after, parent.key)
  check('中身が来たら Peek の View が出る', afterPeek?.visible === true, `visible=${afterPeek?.visible}`)
  // **`found` を条件に入れる**。描かれていない状態からの「消えた」は検査にならない
  check(
    '本体が出たらプレースホルダーは消える',
    measured.found === true &&
      (await chrome.ev("document.querySelector('.peek-placeholder') ? 'ある' : 'ない'")) === 'ない'
  )

  /**
   * **main の `peekBounds()` と CSS の矩形がずれていないこと**。
   * 割合を main と CSS の2か所に書いているので、片方だけ変えると
   * 「本体が出た瞬間に窓が飛ぶ」。解放後のページの viewport が実寸なので突き合わせる。
   */
  const gate = await connectPage(gateUrl)
  const inner = JSON.parse(await gate.ev('JSON.stringify({ w: innerWidth, h: innerHeight })'))
  gate.close()
  // 描かれていなければ比べようがない。**ここで例外にして後続の検証ごと落とさない**
  const placeholderRect = measured.rect ?? { w: -1, h: -1 }
  check(
    'プレースホルダーの寸法が Peek 本体と一致する',
    Math.abs(inner.w - placeholderRect.w) <= 1 && Math.abs(inner.h - placeholderRect.h) <= 1,
    `本体=${inner.w}x${inner.h} プレースホルダー=${placeholderRect.w}x${placeholderRect.h}`
  )
  chrome.close()

  /*
   * **保険のタイムアウト**。`dom-ready` が来ないページ（204 で終わる・ダウンロードに化ける）
   * でも View が出ることを見る。**これが無いと Peek が永久に出ないままの回帰を拾えない**。
   * ゲートは解放せず、時間だけで出てくることを確かめる。
   */
  /*
   * **`dom-ready` の前に閉じられた Peek**。タイマーだけが残って、後から
   * 幽霊の Peek が生えたり main が落ちたりしないことを見る。
   * （この後の「保険」の待ちが 8 秒のタイマーを跨ぐので、待ち時間は共用できる）
   */
  const earlyId = `${gateId}-early`
  await evUser(
    parent.page,
    `window.open(${JSON.stringify(`${PAGES}/__nemo_gate__?id=${earlyId}`)}, '_blank')`
  )
  for (let i = 0; i < 60; i += 1) {
    const r = await (await fetch(`${PAGES}/__nemo_gate_state__?id=${earlyId}`)).json()
    if (r.arrived >= 1) break
    await sleep(200)
  }
  const earlyPeek = peekOf(await state(), parent.key)
  /*
   * **「まだ中身が来ていない」ことを前提として必ず確かめる**。ここが崩れていると
   * （保険のタイムアウトで既に表示済みだと）以降は何も検査していないのに通ってしまう。
   */
  check(
    '（早期 close）閉じる前は中身待ちの Peek がある',
    earlyPeek !== null && earlyPeek.visible === false,
    `peek=${earlyPeek === null ? 'なし' : `visible=${earlyPeek.visible}`}`
  )
  await call('window.nemo.closePeek()')
  await sleep(500)
  check('（早期 close）中身が来る前でも閉じられる', peekOf(await state(), parent.key) === null)

  const stuckId = `${gateId}-stuck`
  await evUser(
    parent.page,
    `window.open(${JSON.stringify(`${PAGES}/__nemo_gate__?id=${stuckId}`)}, '_blank')`
  )
  for (let i = 0; i < 60; i += 1) {
    const r = await (await fetch(`${PAGES}/__nemo_gate_state__?id=${stuckId}`)).json()
    if (r.arrived >= 1) break
    await sleep(200)
  }
  await sleep(400)
  const stuckPeek = peekOf(await state(), parent.key)
  check(
    '（保険）来ないうちは View を出していない',
    stuckPeek?.visible === false,
    `visible=${stuckPeek?.visible}`
  )
  // registry.ts の `PEEK_PLACEHOLDER_TIMEOUT`（8000ms）に余裕を足した待ち
  await sleep(10000)
  const revealed = peekOf(await state(), parent.key)
  check(
    '（保険）dom-ready が来なくてもタイムアウトで View が出る',
    revealed?.visible === true,
    `visible=${revealed?.visible}`
  )
  /*
   * **閉じた Peek の key で `peek.revealed` が出ていないこと**。
   * タブの本数だけ見ても、破棄済みの Peek に対してタイマーが発火したことは分からない。
   */
  check(
    '（早期 close）閉じた Peek のタイマーが後から発火しない',
    earlyPeek !== null &&
      !readLogLines(USER_DATA).some(
        (line) => line.includes('"event":"peek.revealed"') && line.includes(earlyPeek.key)
      ),
    `key=${earlyPeek?.key}`
  )
  check(
    '（保険）出た理由がタイムアウトとして記録されている',
    readLogLines(USER_DATA).some(
      (line) => line.includes('"event":"peek.revealed"') && line.includes('"reason":"timeout"')
    )
  )
  check(
    '（早期 close）main の未捕捉例外が出ていない',
    countLogEvents(USER_DATA, 'app.uncaught_exception') === 0
  )
  await (await fetch(`${PAGES}/__nemo_gate_release__?id=${stuckId}`)).json()
  await (await fetch(`${PAGES}/__nemo_gate_release__?id=${earlyId}`)).json()
  await sleep(500)

  await call('window.nemo.closePeek()')
  await sleep(400)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
}

/* ------------------------------------------------------------------ *
 * 3. 昇格（⌘O）と R11（道連れにしない）
 * ------------------------------------------------------------------ */

console.log('\n--- 昇格（⌘O）と outlivesOpener')

{
  // 昇格前に背面タブを1本足して、「昇格したら末尾に来る」を意味のある検査にする
  const trailing = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${PAGES}/login.html?site=trailing`)}, { background: true })`
  )
  await sleep(500)

  const before = await state()
  const peek = peekOf(before, base.key)
  const peekContentsId = peek?.webContentsId

  await call('window.nemo.promoteForegroundView()')
  await sleep(800)

  const after = await state()
  const promoted = after.tabs.find((t) => t.key === peek?.key)
  check('⌘O で Peek が通常タブになる', promoted !== undefined && promoted.peekParentKey === null)
  check(
    '昇格でページを読み直していない（WebContents の id が変わらない）',
    promoted?.webContentsId === peekContentsId,
    `${peekContentsId} → ${promoted?.webContentsId}`
  )
  check(
    '昇格したタブが配列の末尾にいる',
    after.tabs[after.tabs.length - 1]?.key === peek?.key,
    after.tabs.map((t) => t.title).join(' | ')
  )
  check('昇格したタブがアクティブになる', after.activeTabKey === peek?.key)

  /* R11: 元の親タブを閉じても昇格済みタブは残る */
  await call(`window.nemo.closeTab(${JSON.stringify(base.key)})`)
  await sleep(900)
  const survived = await state()
  const still = survived.tabs.find((t) => t.key === peek?.key)
  check(
    'R11: 元の親タブを閉じても昇格済みのタブが残る',
    still !== undefined && still.webContentsId === peekContentsId,
    `id=${still?.webContentsId}`
  )

  if (still) await call(`window.nemo.closeTab(${JSON.stringify(still.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(trailing)})`)
  await sleep(400)
}
base.page.close()

/* R11（未昇格）: 親を閉じたら Peek も閉じ、WebContents が残らない */
{
  const parent = await openParent('orphan')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)
  check('Peek ができている（前提）', peek !== null)

  // **この Peek 自身の URL で数える**。同じテストページを使い回すと
  // 別の節の残骸を数えてしまい、増減が見えなくなる。
  const peekUrl = peek?.url ?? ''
  const beforeCount = await pageTargetCount(peekUrl)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  await sleep(1500)

  const s = await state()
  check(
    '未昇格の Peek は親と一緒に閉じる',
    !s.tabs.some((t) => t.key === peek?.key),
    s.tabs.map((t) => t.url).join(' | ')
  )
  const afterCount = await pageTargetCount(peekUrl)
  check(
    '閉じ漏れた WebContents が残っていない',
    afterCount === beforeCount - 1,
    `${beforeCount} → ${afterCount}（${peekUrl}）`
  )
  parent.page.close()
}

/* ------------------------------------------------------------------ *
 * 4. R8 — 入れ子の popup で opener を殺さない
 * ------------------------------------------------------------------ */

console.log('\n--- R8: Peek の中の popup')

{
  const parent = await openParent('nested')
  // 親 → Peek（nested 役）
  await evUser(parent.page, `window.open(${JSON.stringify(`${PAGES}/peek.html?role=nested`)}, '_blank')`)
  await sleep(1400)
  const peek = peekOf(await state(), parent.key)
  check('親 → Peek ができる（前提）', peek !== null)

  // Peek → 孫 popup
  const child = await connectPage(`${PAGES}/peek.html?role=nested`)
  await waitFor(child, "document.readyState === 'complete' ? 'ok' : ''")
  await evUser(child, 'window.__openGrandChild()')
  await sleep(1600)

  const s = await state()
  const promoted = s.tabs.find((t) => t.key === peek?.key)
  check(
    'R8: Peek が通常タブへ昇格している（古いほうを閉じていない）',
    promoted !== undefined && promoted.peekParentKey === null,
    JSON.stringify(promoted && { key: promoted.key, peekParentKey: promoted.peekParentKey })
  )
  const grand = promoted ? peekOf(s, promoted.key) : null
  check('R8: 孫が昇格後タブの Peek になっている', grand !== null, grand ? grand.url : '(無し)')

  // 孫 → 昇格した親（元 Peek）へ postMessage が届く
  const received = await child.ev('JSON.stringify(window.__fromChild ?? [])')
  // nested 役のページは受信ハンドラを張っていないので、opener が生きているかは
  // 「孫が例外を出さずに開けたこと」と「昇格後タブが生きていること」で見る
  check(
    'R8: 元の Peek（= 孫の opener）が生きている',
    promoted !== undefined && promoted.webContentsId !== null,
    `webContentsId=${promoted?.webContentsId} received=${received}`
  )

  child.close()
  if (promoted) await call(`window.nemo.closeTab(${JSON.stringify(promoted.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(500)
}

/* ------------------------------------------------------------------ *
 * 5. R9 — Peek を持つ親タブのウィンドウ移動
 * ------------------------------------------------------------------ */

console.log('\n--- R9: Peek を持つ親タブの移動')

{
  const parent = await openParent('move')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)
  check('Peek ができている（前提）', peek !== null)

  // `moveTabToNewWindow` は**タブが1枚だと no-op**（1枚を動かしても意味が無いため）。
  // 詰め物のタブをもう1本用意して、移動が実際に起きる状態を作る
  // （これが無いと以降の R9 検査は全部「移動していないのに PASS」の空振りになる。
  // ⌘⇧N 廃止でウィンドウのタブが1枚になった際に実際に腐っていた）
  const moveFiller = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html?move-filler`)}, { background: true })`
  )
  const originWindowId = (await state()).windowId
  await call(`window.nemo.moveTabToNewWindow(${JSON.stringify(parent.key)})`)
  await sleep(1800)

  // 移動先ウィンドウの UI に繋ぐ（元のウィンドウとは別の window= を持つ）
  const sidebars = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  const myWindow = /window=(\d+)/.exec(
    (await listTargets(CDP)).find((t) => t.url.includes('view=sidebar'))?.url ?? ''
  )
  const targets = []
  for (const sidebar of sidebars) {
    const session = await connect(sidebar.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    targets.push({ session, s })
  }
  const holder = targets.find((t) => t.s.tabs.some((tab) => tab.key === parent.key))
  check(
    'R9: 親タブが元と**別の**ウィンドウへ移った',
    holder !== undefined && holder.s.windowId !== originWindowId,
    `origin=${originWindowId} holder=${holder?.s.windowId ?? '(無し)'} windows=${targets.length} ${myWindow?.[1] ?? ''}`
  )
  check(
    'R9: 元のウィンドウから親タブが消えている',
    !(await state()).tabs.some((tab) => tab.key === parent.key)
  )
  check(
    'R9: Peek も一緒に移動している',
    holder?.s.tabs.some((tab) => tab.key === peek?.key) === true,
    holder
      ? holder.s.tabs.map((t) => `${t.key.slice(0, 6)}:${t.peekParentKey ? 'peek' : 'tab'}`).join(' ')
      : ''
  )
  const fg = lastForeground(holder?.s.windowId ?? null)
  check(
    'R9: 移動後も chrome の active が Peek を指す',
    fg?.key === peek?.key && fg?.peek === true,
    JSON.stringify(fg)
  )

  // 後片付け: 先にタブを閉じて共有定義ごと消し、空になった移動先ウィンドウも閉じる
  // （最後のタブを閉じてもウィンドウは空状態で残るため。close-window は自分の
  // WebContents ごと消える操作なので応答を待たない —— CLAUDE.md「自分のウィンドウを
  // 閉じるコマンドは invoke の応答を待たない」）
  if (holder && holder.s.windowId !== originWindowId) {
    await holder.session.ev(`window.nemo.closeTab(${JSON.stringify(parent.key)}).then(() => 'ok')`)
    await sleep(600)
    await evSuicidal(
      holder.session,
      `(setTimeout(() => { void window.nemo.runCommandForVerify('close-window') }, 50), 'ok')`
    )
    await sleep(800)
  } else if (holder) {
    await holder.session.ev(`window.nemo.closeTab(${JSON.stringify(parent.key)}).then(() => 'ok')`)
    await sleep(600)
  }
  for (const t of targets) t.session.close()
  await call(`window.nemo.closeTab(${JSON.stringify(moveFiller)})`)
  parent.page.close()
  await sleep(600)
}

/* ------------------------------------------------------------------ *
 * 5.5 暗幕（Peek 用の透明 View）の後始末と ⌃M
 * ------------------------------------------------------------------ */

console.log('\n--- 暗幕の出し入れと ⌃M')

{
  const parent = await openParent('scrim')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)
  check('Peek ができている（前提）', peek !== null)

  /*
   * 暗幕は独立した UI View。**出し入れの判定は main の実状態
   * （`splitDiagnostics().peekScrim` = `getVisible()` とその bounds）を正にする**。
   * renderer の `document.visibilityState` は View の可視性だけでなく
   * **検証ウィンドウ自体の遮蔽（別 Space・前面に他のウィンドウ）でも hidden になる**ため、
   * PASS 条件に使うと実行環境依存で揺れる（実測: 同一コードで run ごとに hidden / visible）。
   * visibilityState は診断の詳細としてだけ出す。
   * 暗幕セッション（⌃M のキー入力用）は CLAUDE.md の規則どおりウィンドウを名指しして繋ぐ。
   */
  const scrimWindowId = (await state()).windowId
  const scrim = await connectUi(CDP, 'peek', {
    urlPart: `view=peek&window=${scrimWindowId}`,
    waitReady: false
  })
  const scrimDiag = () =>
    ui.ev('window.nemo.splitDiagnostics().then((d) => JSON.stringify(d))').then(JSON.parse)
  const visibleWhileOpen = await scrim.ev('document.visibilityState')
  check(
    'Peek が出ている間は暗幕の View が表示されている',
    (await scrimDiag()).peekScrim !== null,
    `visibilityState=${visibleWhileOpen}`
  )

  /* ⌃M: 暗幕にフォーカスがあるときも「⌃ を離したら確定」できること */
  // 帯は通常タブが 2 本以上ないと開かない（`advanceSwitcher` が黙って return する）。
  // 共有モデルでは閉じる操作が全ウィンドウに波及して先行セクションの残りタブが減るので、
  // 前提の 2 本目はここで自分で用意する
  const mruFiller = await ui.ev(
    `window.nemo.createTab('${PAGES}/index.html?scrim-mru', { background: true })`
  )
  const beforeActive = (await state()).activeTabKey
  await call('window.nemo.switchTab()')
  await sleep(500)
  const opened = JSON.parse(await ui.ev('window.nemo.getOverlayState().then((s) => JSON.stringify(s))'))
  check('⌃M で帯が出る（前提）', opened.kind === 'tab-switcher', JSON.stringify(opened.kind))
  await scrim.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  })
  await sleep(700)
  const afterSwitch = JSON.parse(await ui.ev('window.nemo.getOverlayState().then((s) => JSON.stringify(s))'))
  check(
    '暗幕にフォーカスがあっても ⌃ の keyUp で確定する（帯が残らない）',
    afterSwitch.kind === null,
    JSON.stringify(afterSwitch.kind)
  )
  const switched = await state()
  check('⌃M の確定で別のタブへ移っている', switched.activeTabKey !== beforeActive)
  await call(`window.nemo.closeTab(${JSON.stringify(mruFiller)})`)
  await call(`window.nemo.selectTab(${JSON.stringify(parent.key)})`)
  await sleep(400)

  /* ✕ で閉じたあと、暗幕の View が残っていないこと（残るとページを触れなくなる）。
     判定は開き側と同じく main の実状態（遮蔽で hidden になる visibilityState だと、
     暗幕が残る回帰が出ていても遮蔽中は hidden が返って素通りする） */
  await call('window.nemo.closePeek()')
  await sleep(800)
  const visibleAfterClose = await scrim.ev('document.visibilityState')
  check(
    'Peek を閉じたら暗幕の View も隠れる（ページのクリックを遮らない）',
    (await scrimDiag()).peekScrim === null,
    `visibilityState=${visibleAfterClose}`
  )
  scrim.close()

  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(500)
}

/* ------------------------------------------------------------------ *
 * 6. Peek を持つ親タブは寝ない
 * ------------------------------------------------------------------ */

console.log('\n--- sleep / archive の除外')

{
  const settings = JSON.parse(await ui.ev('window.nemo.getSettings().then((s) => JSON.stringify(s))'))
  const parent = await openParent('sleep')
  await evUser(parent.page, "document.querySelector('#open-blank').click()")
  await sleep(1200)
  const peek = peekOf(await state(), parent.key)

  // 別タブを選んで親を非アクティブにする（アクティブなタブはそもそも寝ない）
  const other = await ui.ev(`window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)})`)
  /*
   * **比較用の普通のタブ**（見えていない・Peek を持たない）。
   * 下の検査は「寝ない」という否定形なので、これが無いと **sweep が一度も走らなくても PASS** する。
   * 待ちを timings 由来にして縮めた以上、空振りしていない証拠を同じブロックに置く。
   */
  const control = await ui.ev(
    `window.nemo.createTab(${JSON.stringify(`${PAGES}/index.html`)}, { background: true })`
  )
  // **設定値は ms 定数から導出する**（両方に数字を書くと片方だけ直してズレる）
  const SLEEP_THRESHOLD_MS = 600
  await ui.ev(
    `window.nemo.updateSettings({ tabSleepMinutes: ${SLEEP_THRESHOLD_MS / 60_000} }).then(() => 'ok')`
  )
  await sleep(afterSweep(SLEEP_THRESHOLD_MS))

  const s = await state()
  const parentTab = s.tabs.find((t) => t.key === parent.key)
  check(
    '比較用の普通のタブは寝る（除外の検査が空振りしていない証拠）',
    s.tabs.find((t) => t.key === control)?.asleep === true,
    `asleep=${s.tabs.find((t) => t.key === control)?.asleep}`
  )
  check(
    'Peek を持つ親タブは tabSleepMinutes を過ぎても寝ない',
    parentTab !== undefined && parentTab.asleep === false,
    `asleep=${parentTab?.asleep}`
  )
  check(
    'Peek 自身も残っている',
    s.tabs.some((t) => t.key === peek?.key)
  )

  await ui.ev(`window.nemo.updateSettings({ tabSleepMinutes: ${settings.tabSleepMinutes} }).then(() => 'ok')`)
  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(other)})`)
  await call(`window.nemo.closeTab(${JSON.stringify(control)})`)
  parent.page.close()
  await sleep(600)
}

/* ------------------------------------------------------------------ *
 * 7. 小窓（Little Nemo）
 * ------------------------------------------------------------------ */

console.log('\n--- 小窓')

/**
 * 外部アプリから URL を踏んだのと同じ経路を通す。
 *
 * **2つ目のインスタンスを起動する**。単一インスタンスロックに弾かれて
 * `second-instance` が飛び、`handleSecondInstance` → `openMiniWindow` に落ちる。
 * IPC から直接叩くと、実際に踏む経路（argv / open-url）を一度も通らない。
 */
async function openExternalUrl(url) {
  await new Promise((resolve) => {
    const child = spawn(electronPath, ['out/main/index.js', url], {
      cwd: projectRoot,
      stdio: 'ignore',
      env: process.env
    })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
  await sleep(1500)
}

/** 通常ウィンドウ（サイドバー）の状態を全部取る。 */
async function normalStates() {
  const out = []
  const targets = (await listTargets(CDP)).filter(
    (t) => t.url.includes('view=sidebar') && !t.url.includes('private=1')
  )
  for (const target of targets) {
    const session = await connect(target.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    out.push({ session, s })
  }
  return out
}

/** 小窓の UI target 一覧（`?view=mini`）。 */
async function miniTargets() {
  return (await listTargets(CDP)).filter((t) => t.url.includes('view=mini'))
}

async function miniStates() {
  const out = []
  for (const target of await miniTargets()) {
    const session = await connect(target.webSocketDebuggerUrl)
    await waitFor(session, "typeof window.nemo === 'object' && window.nemo !== null ? 'ready' : ''")
    const s = JSON.parse(await session.ev('window.nemo.getWindowState().then((x) => JSON.stringify(x))'))
    out.push({ session, s })
  }
  return out
}

{
  await openExternalUrl(`${PAGES}/login.html?site=mini1`)
  let minis = await miniStates()
  check('外部 URL は小窓で開く', minis.length === 1, `${minis.length} 枚`)
  check('小窓は kind=mini', minis[0]?.s.kind === 'mini', minis[0]?.s.kind)
  check('小窓のタブは1つ', minis[0]?.s.tabs.length === 1, `${minis[0]?.s.tabs.length}`)

  const main = await state()
  check(
    '小窓のタブは通常ウィンドウには入らない',
    !main.tabs.some((t) => t.url.includes('site=mini1')),
    main.tabs.map((t) => t.url).join(' | ')
  )
  for (const m of minis) m.session.close()

  /* 上限4枚 */
  for (const n of [2, 3, 4, 5]) await openExternalUrl(`${PAGES}/login.html?site=mini${n}`)
  minis = await miniStates()
  check('小窓は原則4枚まで（最古が閉じる）', minis.length === 4, `${minis.length} 枚`)
  const urls = minis.map((m) => m.s.tabs[0]?.url ?? '')
  check('閉じられたのは一番古い小窓', !urls.some((u) => u.includes('site=mini1')), urls.join(' | '))

  /* セッションに含まれない */
  if (USER_DATA) {
    /*
     * **否定形の検査なので、先に「書かれた後に読んでいる」を担保する**。
     *
     * `小窓はセッションに保存されない` は完全な否定形で、`session.json` がまだ
     * 書かれていなくても（`existsSync` が false で `'{}'` にフォールバックしても）PASS する。
     * そこで**必ず現れるはずの普通のタブ URL**を通常ウィンドウに用意し、
     * それが書かれていることを先に assert する。これが PASS して初めて
     * 下の否定形が「読めた内容に小窓が無い」という意味になる。
     */
    const marker = `${PAGES}/index.html?session-marker`
    const markerKey = await ui.ev(`window.nemo.createTab(${JSON.stringify(marker)}, { background: true })`)
    // 版 5 から野良タブの正は共有定義ストア（session.json は URL を持たない）。
    // ephemeral-tabs.json のデバウンスは JsonStore 既定（400ms）なので少し余分に待つ
    await sleep(afterSessionSave() + 800)
    const defsFile = path.join(USER_DATA, 'ephemeral-tabs.json')
    const rawDefs = fs.existsSync(defsFile) ? fs.readFileSync(defsFile, 'utf8') : '{}'
    check(
      'ephemeral-tabs.json が実際に書かれている（否定形の検査が空振りしていない証拠）',
      rawDefs.includes('session-marker'),
      `exists=${fs.existsSync(defsFile)} len=${rawDefs.length}`
    )
    check('小窓は共有定義ストアに保存されない', !rawDefs.includes('site=mini'), rawDefs.slice(0, 200))
    const sessionFile = path.join(USER_DATA, 'session.json')
    const rawSession = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '{}'
    check('小窓はセッションに保存されない', !rawSession.includes('site=mini'), rawSession.slice(0, 200))
    await call(`window.nemo.closeTab(${JSON.stringify(markerKey)})`)
  }

  /* ⌘W（= closeTab）でウィンドウごと閉じ、⌘⇧T で戻せる */
  const victim = minis[minis.length - 1]
  await evSuicidal(
    victim.session,
    `window.nemo.closeTab(${JSON.stringify(victim.s.tabs[0].key)}).then(() => 'ok').catch(() => 'ok')`
  )
  await sleep(1200)
  const afterClose = await miniTargets()
  check(
    '小窓で ⌘W するとウィンドウごと閉じる（空の小窓が残らない）',
    afterClose.length === 3,
    `${afterClose.length} 枚`
  )

  for (const m of minis) {
    try {
      m.session.close()
    } catch {
      /* 閉じ済み */
    }
  }
  // ⌘⇧T は `reopen-tab` コマンド（メニューのアクセラレータ）で、UI の API には無い。
  // 「閉じた小窓が ⌘⇧T のスタックに積まれたか」は診断ログで確かめる。
  const closedLogged = readLogLines(USER_DATA).some((line) => line.includes('"event":"mini.closed"'))
  check('小窓を閉じたことが終了 API を通っている（⌘⇧T に積まれる経路）', closedLogged)

  /* ⌘O で通常ウィンドウへ移る */
  const remaining = await miniStates()
  if (remaining.length > 0) {
    const target = remaining[0]
    const movedUrl = target.s.tabs[0]?.url ?? ''
    const contentsId = target.s.tabs[0]?.webContentsId
    await evSuicidal(target.session, "window.nemo.promoteForegroundView().then(() => 'ok')")
    await sleep(1800)
    // **通常ウィンドウを全部見る**。行き先は「直近に使った通常ウィンドウ」なので、
    // 検証中にウィンドウが2枚できていると、こちらが繋いでいる方とは限らない。
    const normals = await normalStates()
    const landed = normals.flatMap((n) => n.s.tabs).find((t) => t.url === movedUrl)
    check(
      '小窓を ⌘O すると通常ウィンドウのタブになる',
      landed !== undefined,
      `${movedUrl}（通常ウィンドウ ${normals.length} 枚）`
    )
    check(
      '⌘O でページを読み直していない（WebContents の id が変わらない）',
      landed?.webContentsId === contentsId,
      `${contentsId} → ${landed?.webContentsId}`
    )
    check(
      '昇格した小窓は閉じている',
      (await miniTargets()).length === remaining.length - 1,
      `${(await miniTargets()).length} 枚`
    )
    if (landed) {
      const owner = normals.find((n) => n.s.tabs.some((t) => t.key === landed.key))
      await owner?.session.ev(`window.nemo.closeTab(${JSON.stringify(landed.key)}).then(() => 'ok')`)
    }
    for (const n of normals) n.session.close()
  } else {
    check('⌘O の検査に使う小窓が残っている', false, '0 枚')
  }

  // 後片付け: 残った小窓を閉じる
  for (const m of await miniStates()) {
    await evSuicidal(
      m.session,
      `window.nemo.closeTab(${JSON.stringify(m.s.tabs[0]?.key ?? '')}).then(() => 'ok').catch(() => 'ok')`
    )
    m.session.close()
  }
  await sleep(800)
  check('後片付けで小窓が残らない', (await miniTargets()).length === 0, `${(await miniTargets()).length} 枚`)

  /* ------------------------------------------------------------------ *
   * R8 / R10 — 小窓の中の popup と opener チェーン
   * ------------------------------------------------------------------ */

  // **小窓を5段ネストさせる**（独立した5枚ではない）。
  // 既存4枚がすべて次の小窓の opener になるので、上限で閉じられる候補が無くなる。
  // R10 は「opener を切って OAuth を壊すより、一時的に上限を超える」を選ぶ仕様。
  await openExternalUrl(`${PAGES}/peek.html?site=chain0`)
  let previous = await connectPage(`${PAGES}/peek.html?site=chain0`)
  await waitFor(previous, "document.readyState === 'complete' ? 'ok' : ''")
  check('小窓が1枚できた（チェーンの起点）', (await miniTargets()).length === 1)

  for (let step = 1; step <= 4; step += 1) {
    const url = `${PAGES}/peek.html?site=chain${step}`
    await evUser(previous, `window.open(${JSON.stringify(url)}, '_blank')`)
    await sleep(1500)
    if (step === 1) {
      check(
        'R8: 小窓の中の popup がもう1枚の小窓になる',
        (await miniTargets()).length === 2,
        `${(await miniTargets()).length} 枚`
      )
      check(
        'R8: 1枚目（= 子の opener）が生きている',
        (await pageTargetCount(`${PAGES}/peek.html?site=chain0`)) === 1
      )
    }
    // **開けなかったら FAIL にして打ち切る**（例外にすると以降の検査が丸ごと飛ぶ）。
    // 上限の trim が「たった今開いた小窓」を victim に選ぶと、ここで消える。
    let next
    try {
      next = await connectPage(url, { timeoutMs: 4000 })
    } catch {
      check(
        `R10: ${step + 1} 枚目の小窓が開いた直後に閉じられていない`,
        false,
        `chain${step} が見つからない（小窓 ${(await miniTargets()).length} 枚）`
      )
      break
    }
    await waitFor(next, "document.readyState === 'complete' ? 'ok' : ''")
    previous.close()
    previous = next
  }

  const chained = await miniTargets()
  check('R10: opener チェーンが5段なら上限4枚を一時的に超える', chained.length === 5, `${chained.length} 枚`)
  check(
    'R10: 超過したことがログに残る',
    countLogEvents(USER_DATA, 'mini.cap_exceeded') > 0,
    `${countLogEvents(USER_DATA, 'mini.cap_exceeded')} 件`
  )

  // 末端を閉じたら、超過を放置せず4枚まで詰める
  const chainStates = await miniStates()
  const tail = chainStates
    .filter((m) => (m.s.tabs[0]?.url ?? '').includes('site=chain'))
    .sort((a, b) => a.s.windowId - b.s.windowId)
    .pop()
  await evSuicidal(
    tail?.session,
    `window.nemo.closeTab(${JSON.stringify(tail?.s.tabs[0]?.key ?? '')}).then(() => 'ok').catch(() => 'ok')`
  )
  previous.close()
  await sleep(1800)
  check(
    'R10: 末端を閉じたら4枚まで詰まる',
    (await miniTargets()).length === 4,
    `${(await miniTargets()).length} 枚`
  )

  for (const m of await miniStates()) {
    await evSuicidal(
      m.session,
      `window.nemo.closeTab(${JSON.stringify(m.s.tabs[0]?.key ?? '')}).then(() => 'ok').catch(() => 'ok')`
    )
    m.session.close()
  }
  await sleep(800)
  check(
    'チェーンの後片付けで小窓が残らない',
    (await miniTargets()).length === 0,
    `${(await miniTargets()).length} 枚`
  )
  check('検証中に main の未捕捉例外が出ていない', countLogEvents(USER_DATA, 'app.uncaught_exception') === 0)
}

/* ------------------------------------------------------------------ *
 * 前面コマンド（Peek 表示中は ⌘L / reload / go-back / copy-url / find / zoom が Peek に向く）
 *
 * 「前面 = 表示中の Peek ?? 選択タブ」の不変条件を守る。
 * main は `getForegroundTab()`（registry.ts）、renderer は `foregroundTab(state)`
 * （useNemo.ts）が実体で、次に `getActiveTab()` や `toState().find` を触った誰かが
 * 黙って壊せるので、ここで恒久的に見張る。
 * ------------------------------------------------------------------ */

console.log('\n--- 前面コマンド（Peek 表示中は Peek が対象）')

{
  const parent = await openParent('foreground')
  // クエリで一意にする。素の index.html はフル実行だと他スイートの残タブと同一 URL になり、
  // `connectPage` が「target が1つに定まらない」で落ちる（--only では 1 件で通ってしまう）
  const childUrl = `${PAGES}/index.html?peek-foreground`
  await evUser(parent.page, `window.open(${JSON.stringify(childUrl)}, '_blank')`)

  // reveal（dom-ready で View が出る）まで待つ。awaiting の Peek は前面にならない
  let peek = null
  for (let i = 0; i < 40; i += 1) {
    peek = peekOf(await state(), parent.key)
    if (peek?.visible === true) break
    await sleep(250)
  }
  check('前面コマンド: Peek が開いて表示済み', peek?.visible === true, JSON.stringify(peek))

  if (peek?.visible === true) {
    const cmd = (name) => ui.ev(`window.nemo.runCommandForVerify(${JSON.stringify(name)})`)
    // オーバーレイ（アドレスバー / FindBar）は sidebar とは別の UI View。
    // **ウィンドウを名指しする**（素の view=overlay は後続でウィンドウが増えると別の窓を掴む）
    const windowId = (await state()).windowId
    const overlay = await connectTo(CDP, `view=overlay&window=${windowId}`)

    /* ⌘L: アドレスバーには前面（= Peek）の URL が入る */
    await cmd('focus-address')
    await waitFor(overlay, "document.querySelector('.cmd-input input') ? 'ok' : ''")
    const addr = await overlay.ev("document.querySelector('.cmd-input input')?.value ?? ''")
    check('⌘L のアドレスバーは Peek の URL（親ではない）', addr === peek.url, `value=${addr}`)
    await call('window.nemo.setOverlay(null)')
    await sleep(300)

    /* copy-url: 対象 key を選ぶのは renderer。ログの key が Peek を指す */
    await cmd('copy-url')
    await sleep(500)
    const copied = lastLogEntry('copy_url.requested')
    check(
      'copy-url の対象が Peek（renderer の foregroundTab）',
      copied?.key === peek.key && copied?.peek === true,
      JSON.stringify(copied)
    )

    /* zoom: 前面（Peek）の zoomFactor だけが変わる */
    await cmd('zoom-in')
    await sleep(400)
    {
      const s = await state()
      const z = peekOf(s, parent.key)
      const p = s.tabs.find((t) => t.key === parent.key)
      check(
        'zoom-in は Peek に効く（親は 1 のまま）',
        z?.zoomFactor === 1.1 && p?.zoomFactor === 1,
        `peek=${z?.zoomFactor} parent=${p?.zoomFactor}`
      )
      await cmd('zoom-reset')
      await sleep(300)
    }

    /* find (a) 直叩き: n/N（WindowState.find）が Peek 側の件数を返す = toState が前面から引く */
    await call(`window.nemo.find(${JSON.stringify(peek.key)}, 'Nemo')`)
    const total = await waitFor(
      ui,
      'window.nemo.getWindowState().then((s) => (s.find && s.find.totalMatches > 0 ? s.find.totalMatches : 0))'
    ).catch(() => 0)
    check('find: n/N が Peek 側の件数（toState().find が前面から引く）', total > 0, `matches=${total}`)
    await call(`window.nemo.stopFind(${JSON.stringify(peek.key)})`)
    await sleep(200)

    /* find (b) FindBar 経由: 検索対象の key が Peek を指す = renderer の foregroundTab を通る */
    await cmd('find')
    await waitFor(overlay, "document.querySelector('.findbar input') ? 'ok' : ''")
    await overlay.ev(`(() => {
      const input = document.querySelector('.findbar input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Nemo')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(800)
    const found = lastLogEntry('find.requested')
    check(
      'FindBar の検索対象が Peek（renderer の foregroundTab）',
      found?.key === peek.key && found?.peek === true,
      JSON.stringify(found)
    )

    /* reload: Peek だけが読み直される（ページ内の印が消える）。親の印は残る */
    await call('window.nemo.setOverlay(null)')
    await sleep(300)
    const peekPage = await connectPage(childUrl)
    await peekPage.ev("window.__nemoMark = 'peek'; 'ok'")
    await parent.page.ev("window.__nemoMark = 'parent'; 'ok'")
    peekPage.close()
    await cmd('reload')
    await sleep(1500)
    const peekPage2 = await connectPage(childUrl)
    await waitFor(peekPage2, "document.readyState === 'complete' ? 'ok' : ''")
    const peekMark = await peekPage2.ev("window.__nemoMark ?? ''")
    const parentMark = await parent.page.ev("window.__nemoMark ?? ''")
    peekPage2.close()
    check(
      'reload は Peek に効く（親は読み直されない）',
      peekMark === '' && parentMark === 'parent',
      `peek=[${peekMark}] parent=[${parentMark}]`
    )

    /* navigate（⌘L の確定と同じ IPC）: Peek が遷移し、親は動かず、Peek のまま */
    const secondUrl = `${PAGES}/peek.html?site=fg2`
    await call(`window.nemo.navigate(${JSON.stringify(peek.key)}, ${JSON.stringify(secondUrl)})`)
    await sleep(1000)
    {
      const s = await state()
      const moved = peekOf(s, parent.key)
      const p = s.tabs.find((t) => t.key === parent.key)
      check(
        'navigate で Peek が遷移し、Peek のまま維持される',
        moved?.key === peek.key && moved?.url === secondUrl,
        JSON.stringify({ url: moved?.url, peekParentKey: moved?.peekParentKey })
      )
      check('親タブの URL は変わらない', p?.url === parent.url, `parent=${p?.url}`)
    }

    /* go-back: Peek の履歴が戻る（親は履歴が無く canGoBack が false なので、
       親側の不動は検査しない —— FAIL できない検査は守っている範囲を偽る） */
    await cmd('go-back')
    await sleep(1200)
    {
      const back = peekOf(await state(), parent.key)
      check('go-back は Peek に効く', back?.url === childUrl, `url=${back?.url}`)
    }

    /* Peek を検索中に Peek を閉じる → FindBar も閉じ、消えた key への stopFind で落ちない */
    await cmd('find')
    await waitFor(overlay, "document.querySelector('.findbar input') ? 'ok' : ''")
    const uiErrorsBefore = countLogEvents(USER_DATA, 'ui.error')
    await call('window.nemo.closePeek()')
    await sleep(1000)
    const overlayState = JSON.parse(
      await ui.ev('window.nemo.getOverlayState().then((s) => JSON.stringify(s))')
    )
    check('Peek を閉じたら FindBar も閉じる', overlayState.kind === null, `kind=${overlayState.kind}`)
    check(
      'FindBar の閉じ経路で ui.error が出ていない',
      countLogEvents(USER_DATA, 'ui.error') === uiErrorsBefore,
      `${countLogEvents(USER_DATA, 'ui.error') - uiErrorsBefore} 件増`
    )

    overlay.close()
  }

  await call(`window.nemo.closeTab(${JSON.stringify(parent.key)})`)
  parent.page.close()
  await sleep(300)
  check(
    '前面コマンド検証で main の未捕捉例外が出ていない',
    countLogEvents(USER_DATA, 'app.uncaught_exception') === 0
  )
}

console.log(failures === 0 ? '\n全て PASS' : `\n${failures} 件 FAIL`)
ui.close()
process.exit(failures === 0 ? 0 : 1)
