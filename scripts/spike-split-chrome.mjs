#!/usr/bin/env node
/**
 * 技術スパイク（分割ビュー Phase 0）— ペインの器・フォーカス枠・フォーカス検出。
 *
 * **Nemo 本体には一切触らない**。最小の `BaseWindow` を 1 枚出すだけ。
 * 分割ビューの実装方針が 3 つの未確認事項に乗っているので、先にここで潰す。
 *
 * 見るもの:
 *
 * 1. **子 View が親 View の角丸でクリップされるか**
 *    クリップされる → 器を 1 枚丸めるだけで「ツールバー + ページ」が丸い器に収まる。
 *    されない → ページだけを丸めると継ぎ目にえぐれが出るので、**角丸は捨てて隔間だけ**にする
 *    （計画で決定済み。`SPLIT_RADIUS = 0`）
 * 2. **フォーカス枠**（ページより上下左右 2px 大きい `View` を後ろに敷く）が 2px で出るか
 * 3. **ページのクリックで `webContents` の `focus` が飛ぶか**
 *    飛ばなければ、ペイン間のフォーカス移動を別の経路で拾う必要がある
 *
 * 使い方:
 *
 *   pnpm spike:split                       # 判定だけ（PNG は撮らない）
 *   pnpm spike:split --shots <dir>         # 合成後のウィンドウを撮る（目視用）
 *   pnpm spike:split --report <path>       # 判定を JSON で残す
 *
 * `--shots` を付けるには**画面収録の許可**が要る。撮れなくても 1 と 2 の
 * 「クリップされたか」の判定は**ページ側のピクセル読み取り**で機械的に出るので、
 * PNG は人が見て納得するためのもの。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

// **top-level await を使わない**（`spike-mini-window.mjs` と同じ理由。
// ESM を main のエントリにしたまま TLA を書くと `app.whenReady()` が解決しない）。
if (process.versions.electron) {
  void runInElectron()
} else {
  const electronPath = require('electron')
  const child = spawn(electronPath, [path.join(here, 'spike-split-chrome.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit'
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

async function runInElectron() {
  const { app, BaseWindow, View, WebContentsView } = await import('electron')
  const fs = await import('node:fs')
  const { captureWindow } = await import('./lib/window-shot.mjs')

  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const reportPath = arg('--report', '')
  const shotDir = arg('--shots', '')

  /** 器の角丸。クリップされるならこの半径ぶん角が削れる。 */
  const RADIUS = 24
  /** フォーカス枠の太さ。 */
  const RING = 2

  const report = {
    platform: process.platform,
    electron: process.versions.electron,
    radius: RADIUS,
    ring: RING,
    /** 子 View が親の角丸でクリップされるか。 */
    clipsChildren: null,
    /** フォーカス枠が意図どおり 2px で出るか。 */
    ringVisible: null,
    /** 別ペインのクリックで `webContents` の `focus` が飛ぶか。 */
    focusEvent: null,
    shots: [],
    notes: []
  }

  const say = (line) => {
    console.log(line)
    report.notes.push(line)
  }

  await app.whenReady()

  const win = new BaseWindow({
    width: 720,
    height: 480,
    show: true,
    // 器の外は**この色**が見える。クリップされたかどうかをページ側から読むために、
    // ページの地（白）と大きく違う色にしておく。
    backgroundColor: '#ff00ff',
    titleBarStyle: 'hiddenInset'
  })

  /*
   * 積み方は本番と同じ:
   *   フォーカス枠（素の View・アクセント色）
   *     └ 器（素の View・角丸）
   *          └ ページ（WebContentsView）
   */
  const ring = new View()
  ring.setBackgroundColor('#5b9dff')
  ring.setBorderRadius(RADIUS + RING)

  const shell = new View()
  shell.setBackgroundColor('#1b1b20')
  shell.setBorderRadius(RADIUS)

  const page = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })

  win.contentView.addChildView(ring)
  win.contentView.addChildView(shell)
  shell.addChildView(page)

  // 器はウィンドウ座標、器の子は `{0,0}` 起点（`View.setBounds` は親相対）
  const outer = { x: 40, y: 60, width: 320, height: 320 }
  ring.setBounds({
    x: outer.x - RING,
    y: outer.y - RING,
    width: outer.width + RING * 2,
    height: outer.height + RING * 2
  })
  shell.setBounds(outer)
  page.setBounds({ x: 0, y: 0, width: outer.width, height: outer.height })

  /** 角が削れたか読むために、ページ全面を単色で塗る。 */
  const filled = `data:text/html,${encodeURIComponent(
    '<body style="margin:0;background:#ffffff;height:100vh"></body>'
  )}`
  await page.webContents.loadURL(filled)

  let focusFired = false
  page.webContents.on('focus', () => {
    focusFired = true
  })

  await new Promise((resolve) => setTimeout(resolve, 400))

  /*
   * 判定 1: クリップされたか。
   *
   * **ページ側からは自分の描画結果を読めない**ので、ここは合成後の PNG が要る。
   * ただし PNG が撮れない環境（画面収録の許可なし）でも詰まないように、
   * 「器の角の位置に何が見えるか」を撮れたときだけ読む。
   */
  const shot = (name) => {
    if (!shotDir) return null
    const file = captureWindow(win.getMediaSourceId(), path.join(shotDir, `${name}.png`))
    if (file) report.shots.push(file)
    return file
  }

  const clipShot = shot('01-clip-and-ring')
  if (clipShot) {
    say(`撮影: ${clipShot}`)
  } else {
    say('撮影できなかった（画面収録の許可が無いか、--shots 未指定）')
  }

  /*
   * 判定 1 の機械的な読み取り。
   *
   * `nativeImage` で撮った PNG を読み、**器の左上の角**（丸みの内側になるはずの点）の色を見る。
   * クリップされていれば、そこはウィンドウの地（マゼンタ）。
   * クリップされていなければ、ページの白がそのまま角まで来る。
   */
  if (clipShot) {
    const { nativeImage, screen } = await import('electron')
    const image = nativeImage.createFromPath(clipShot)
    const size = image.getSize()
    const scale = size.width / win.getContentBounds().width
    // 角丸の内側 2px（丸みが効いていれば、ここはまだ器の外）
    const probe = { x: Math.round((outer.x + 2) * scale), y: Math.round((outer.y + 2) * scale) }
    const bitmap = image.toBitmap()
    const index = (probe.y * size.width + probe.x) * 4
    const [b, g, r] = [bitmap[index], bitmap[index + 1], bitmap[index + 2]]
    const isPageWhite = r > 240 && g > 240 && b > 240
    report.clipsChildren = !isPageWhite
    say(
      `角の色 rgb(${r},${g},${b}) scale=${scale} display=${screen.getPrimaryDisplay().scaleFactor} → ` +
        (report.clipsChildren ? 'クリップされる' : 'クリップされない（ページの白が角まで来ている）')
    )
    // フォーカス枠は「器の外周 2px」に出る。器のすぐ外側を読む
    const ringProbe = {
      x: Math.round((outer.x + outer.width / 2) * scale),
      y: Math.round((outer.y - 1) * scale)
    }
    const ringIndex = (ringProbe.y * size.width + ringProbe.x) * 4
    const [rb, rg, rr] = [bitmap[ringIndex], bitmap[ringIndex + 1], bitmap[ringIndex + 2]]
    report.ringVisible = rr > 60 && rr < 140 && rg > 130 && rb > 200
    say(`枠の色 rgb(${rr},${rg},${rb}) → ` + (report.ringVisible ? '枠が出ている' : '枠が読めない'))
  }

  /*
   * 判定 3: ページのクリックで `focus` が飛ぶか。
   *
   * **ウィンドウを前面にしてから測る**。背面のままだと、そもそも誰も
   * キーフォーカスを持っていないので `focus` は飛ばず、「飛ばない」と誤判定する。
   *
   * `sendInputEvent` はウィンドウではなく **WebContents** に直接撃てるので、
   * CDP を立てずに済む。実際のマウス操作と同じく `mouseDown` → `mouseUp` の対で送る。
   *
   * もう 1 枚ページを置いて、**別の View から別の View へフォーカスが移る**場面を作る
   * （分割ビューで起きるのはこれ。1 枚だけだと「最初から持っている」と区別が付かない）。
   */
  const second = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.contentView.addChildView(second)
  second.setBounds({ x: 400, y: 60, width: 280, height: 320 })
  await second.webContents.loadURL(
    `data:text/html,${encodeURIComponent('<body style="margin:0;background:#ddd;height:100vh"></body>')}`
  )
  let secondFocusFired = false
  second.webContents.on('focus', () => {
    secondFocusFired = true
  })
  /*
   * `focus` が使えないときの代替。**`input-event` は WebContents の入力パイプラインを通る**ので、
   * 実際のマウスでも `sendInputEvent` / CDP の合成クリックでも同じように飛ぶ（はず）。
   * ここが飛べば、ペイン間のフォーカス移動はこれで拾える。
   */
  let secondInputFired = false
  second.webContents.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') secondInputFired = true
  })

  app.focus({ steal: true })
  win.focus()
  await new Promise((resolve) => setTimeout(resolve, 500))

  // まず 1 枚目にフォーカスを置く（ここは「移った」ではなく初期状態づくり）
  page.webContents.focus()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const firedByFocusCall = focusFired

  // 2 枚目をクリック → **別の View へ移る**場面
  second.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
  second.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
  await new Promise((resolve) => setTimeout(resolve, 400))

  report.focusEvent = {
    byFocusCall: firedByFocusCall,
    byClickOnOtherView: secondFocusFired,
    inputEventOnOtherView: secondInputFired
  }
  say(
    `focus イベント: focus() 呼び出し=${firedByFocusCall} / 別 View のクリック=${secondFocusFired}` +
      ` / input-event(mouseDown)=${secondInputFired}`
  )
  second.webContents.close()

  if (reportPath) {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    say(`レポート: ${reportPath}`)
  }

  console.log('\n=== 判定 ===')
  console.log(`1. 子 View は親の角丸でクリップされるか: ${describe(report.clipsChildren)}`)
  console.log(`   → SPLIT_RADIUS = ${report.clipsChildren === true ? 10 : 0}`)
  console.log(`2. フォーカス枠が出るか: ${describe(report.ringVisible)}`)
  console.log(
    `3. 別ペインのクリックで focus が飛ぶか: ${describe(report.focusEvent?.byClickOnOtherView ?? null)}` +
      ` （focus() 呼び出しでは ${describe(report.focusEvent?.byFocusCall ?? null)}）`
  )
  console.log(
    `   代替: input-event の mouseDown は飛ぶか: ${describe(report.focusEvent?.inputEventOnOtherView ?? null)}`
  )

  page.webContents.close()
  win.destroy()
  app.quit()
}

function describe(value) {
  if (value === true) return 'はい'
  if (value === false) return 'いいえ'
  return '判定できず（PNG が撮れていない）'
}
