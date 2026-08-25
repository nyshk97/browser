#!/usr/bin/env node
/**
 * 技術スパイク（計画 Phase 0）— 小窓の Space とフォーカス。
 *
 * **Nemo 本体には一切触らない**。最小の `BaseWindow` を2枚出すだけの使い捨て。
 * 計画の価値の大半が「フォーカスを奪わない」に乗っているので、
 * Peek / 小窓を積み上げる前にここで実測して確定させる。
 *
 * 見るもの:
 *
 * 1. フルスクリーンの Space の上に小窓を出せるか
 *    （`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`）
 * 2. その小窓**だけ**にキーフォーカスを渡せるか（`focus()` のみ / `app.focus({ steal: true })` 併用）
 * 3. 既存の通常ウィンドウが前面に出ないか（= Space が切り替わらないか）
 * 4. `setVisibleOnAllWorkspaces(false)` に戻したあと、どの Space に属するか
 * 5. `setVisibleOnAllWorkspaces` の副作用（process type の変更）が Dock に出ないか
 *
 * 使い方（ターミナルをフルスクリーンにした状態で叩く）:
 *
 *   node scripts/spike-mini-window.mjs --mode focus-only --wait-for Terminal
 *   node scripts/spike-mini-window.mjs --mode steal      --wait-for Terminal
 *
 * `--wait-for <アプリ名>` を付けると、そのアプリが最前面になる（= ユーザーが
 * フルスクリーンの Space に戻る）まで待ってから測り始める。
 *
 * **各段階で `screencapture` を撮る**。`screencapture` は今アクティブな Space しか
 * 撮れないので、撮れた画像が「フルスクリーンのターミナル」なら Space は動いていない、
 * 「デスクトップと通常ウィンドウ」なら Space が切り替わった、と機械的に判定できる。
 * これが無いと「Space が切り替わらないこと」を人の目でしか確かめられない。
 *
 * 実測値は stdout と `--report <path>` の JSON に出る。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

// Electron 本体として起動されたときの中身は下（`runInElectron`）。
// `node scripts/spike-mini-window.mjs` で叩かれたときは Electron を spawn し直す。
//
// **top-level await を使わない**。ESM を main のエントリにしたまま TLA を書くと、
// モジュール評価が終わらないうちに `ready` が過ぎ、`app.whenReady()` が
// 二度と解決しない（Electron 41 で実測。ログが1行も出ないまま固まる）。
// ここでは `runInElectron()` を **await せずに**呼び、中の await はモジュール評価後に走らせる。
if (process.versions.electron) {
  void runInElectron()
} else {
  const electronPath = require('electron')
  const child = spawn(electronPath, [path.join(here, 'spike-mini-window.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit'
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

async function runInElectron() {
  const { app, BaseWindow, Menu, WebContentsView } = await import('electron')
  const fs = await import('node:fs')

  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const flag = (name) => argv.includes(name)

  /** `focus-only` = `win.focus()` だけ / `steal` = `app.focus({ steal: true })` も撃つ。 */
  const mode = arg('--mode', 'focus-only')
  /** process type の変換を飛ばす（Dock アイコンが消えるのを避けられるか見る）。 */
  const skipTransform = flag('--skip-transform')
  const reportPath = arg('--report', '')
  const shotDir = arg('--shots', '')
  const waitFor = arg('--wait-for', '')

  const report = {
    mode,
    skipTransform,
    platform: process.platform,
    electron: process.versions.electron,
    steps: []
  }

  const record = (step, data = {}) => {
    report.steps.push({ at: Date.now(), step, ...data })
    console.log(`[spike] ${step} ${JSON.stringify(data)}`)
  }

  const dockVisible = () => {
    try {
      return app.dock ? app.dock.isVisible() : null
    } catch {
      return null
    }
  }

  /** 今アクティブな Space を撮る。撮れた絵が「どの Space か」の唯一の証拠になる。 */
  const shoot = (name) => {
    if (!shotDir) return null
    const file = path.join(shotDir, `${name}.png`)
    // `screencapture` はオプションをファイル名より**前**に置く（後ろだとファイル名扱いされる）
    const result = spawnSync('/usr/sbin/screencapture', ['-x', '-t', 'png', file], { encoding: 'utf8' })
    if (result.status !== 0) return null
    return file
  }

  /** 最前面のアプリ名（Space が誰のものかの手がかり）。 */
  const frontmost = () => {
    const result = spawnSync(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'],
      { encoding: 'utf8' }
    )
    return result.status === 0 ? result.stdout.trim() : null
  }

  const snapshot = (label, win) => {
    if (!win || win.isDestroyed()) return { label, destroyed: true }
    return { label, visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() }
  }

  /** ページ側から見たキーフォーカス（`win.isFocused()` はアプリ内の key window でしかない）。 */
  const pageHasFocus = async (view) => {
    if (!view || view.webContents.isDestroyed()) return null
    try {
      return await view.webContents.executeJavaScript('document.hasFocus()')
    } catch {
      return null
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const page = (title, body) =>
    `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#16161a;color:#e8e8ee;-webkit-user-select:none}
  body{padding:18px 20px;box-sizing:border-box}
  h1{font-size:15px;margin:0 0 10px}
  b{color:#5b9dff}
  #focus{font-size:20px;font-weight:600;margin:10px 0}
  #keys{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#8b8b98;
    min-height:3em;white-space:pre-wrap;word-break:break-all}
  .tall{height:800px;background:linear-gradient(#26262d,#0e0e11);margin-top:12px;border-radius:8px}
</style>
<h1>${title}</h1>
<div>${body}</div>
<div id="focus">document.hasFocus(): <b>…</b></div>
<div id="keys">（押したキーがここに出る）</div>
<div class="tall">↓ スクロールを試す領域</div>
<script>
  const focusEl = document.querySelector('#focus b')
  const keysEl = document.querySelector('#keys')
  const keys = []
  window.__keys = keys
  setInterval(() => { focusEl.textContent = String(document.hasFocus()) }, 200)
  addEventListener('keydown', (e) => {
    keys.push(e.key)
    keysEl.textContent = keys.slice(-12).join(' ')
    console.log('[spike-page] keydown ' + e.key)
  })
</script>`)}`

  const attach = (win, html) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    win.contentView.addChildView(view)
    const fit = () => {
      const { width, height } = win.getContentBounds()
      view.setBounds({ x: 0, y: 0, width, height })
    }
    win.on('resize', fit)
    void view.webContents.loadURL(html)
    view.webContents.on('console-message', (event) => {
      if (String(event.message).startsWith('[spike-page]')) console.log(`[spike] ${event.message}`)
    })
    fit()
    return view
  }

  await app.whenReady()

  // ⌘J をメニューのアクセラレータとして登録する（着弾したかを数える）。
  let accelFired = 0
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Spike',
        submenu: [
          {
            label: 'アクセラレータ検査',
            accelerator: 'CmdOrCtrl+J',
            click: () => {
              accelFired += 1
              console.log('[spike] menu-accelerator-fired')
            }
          },
          { role: 'quit' }
        ]
      }
    ])
  )

  record('ready', { dockVisible: dockVisible(), frontmost: frontmost() })

  /* -------- おとりのフルスクリーン Space（`--role decoy`） -------- */
  // 「ユーザーのフルスクリーンのターミナル」の代わり。**別プロセス**で動かすので、
  // 「ほかのアプリがフルスクリーンで占有している Space」に近い状態を自前で作れる。
  // これが無いと Space まわりの実測が人の目にしか頼れない。
  if (arg('--role', '') === 'decoy') {
    const decoy = new BaseWindow({ width: 1200, height: 800, show: false, backgroundColor: '#2a0a0a' })
    attach(
      decoy,
      page(
        'おとりのフルスクリーン（ターミナル役）',
        'この Space の上に小窓が出るか / この Space から離れないかを見る。'
      )
    )
    decoy.once('enter-full-screen', () => {
      console.log('[spike] decoy-fullscreen-ready')
    })
    decoy.show()
    decoy.setFullScreen(true)
    return
  }

  /* -------- 0) 対象の Space に戻るのを待つ -------- */
  if (waitFor) {
    console.log(`[spike] ${waitFor} が最前面になるまで待つ（フルスクリーンの Space に戻る）…`)
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && frontmost() !== waitFor) await sleep(1000)
    record('space_ready', { frontmost: frontmost() })
    // 切り替え直後のアニメーションが落ち着くまで待つ
    await sleep(1500)
  }
  record('baseline', { frontmost: frontmost(), shot: shoot('0-baseline') })

  /* -------- 1) 通常ウィンドウ（メインウィンドウ相当）を背面に出す -------- */
  // `show: false` で作ってから `showInactive()`。
  // 計画 R6 の「未起動時は通常ウィンドウを背面で復元する」と同じ出し方を試す。
  const main = new BaseWindow({
    width: 1000,
    height: 700,
    x: 120,
    y: 120,
    show: false,
    title: 'spike: 通常ウィンドウ',
    backgroundColor: '#16161a'
  })
  attach(main, page('通常ウィンドウ（メインウィンドウ相当）', 'これが<b>前面に出てこない</b>ことを見る。'))
  main.showInactive()
  await sleep(1200)
  record('main_shown_inactive', {
    main: snapshot('main', main),
    dockVisible: dockVisible(),
    frontmost: frontmost(),
    shot: shoot('1-main-shown')
  })

  /* -------- 2) 小窓を全 Space（フルスクリーンの上）に出す -------- */
  const mini = new BaseWindow({
    width: 460,
    height: 560,
    x: 900,
    y: 90,
    show: false,
    title: 'spike: 小窓',
    backgroundColor: '#16161a',
    titleBarStyle: 'hiddenInset',
    // NSPanel（nonactivating panel）。**アプリを前面に出さずにキーフォーカスを受け取れる**
    // かどうかがここの争点。取れるなら `app.focus({ steal: true })` が要らなくなり、
    // Space が動かない。
    ...(flag('--panel') ? { type: 'panel' } : {})
  })
  const miniView = attach(
    mini,
    page(
      `小窓（mode: ${mode}${skipTransform ? ' / skip-transform' : ''}）`,
      'フルスクリーンのターミナルの上に出ているか。<br><b>キーを打つ</b>と下に出る。'
    )
  )

  // ここが本題。`visibleOnFullScreen` を付けないとフルスクリーン Space の上には出ない。
  // `--no-all-workspaces` を付けると**全 Space 指定を一切使わない**（NSPanel だけで
  // フルスクリーンの上に出て、その Space に留まるかを見るため）。
  if (!flag('--no-all-workspaces')) {
    mini.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      ...(skipTransform ? { skipTransformProcessType: true } : {})
    })
  }
  await sleep(300)
  record('mini_all_workspaces_on', { dockVisible: dockVisible(), frontmost: frontmost() })

  // まず**フォーカスを奪わずに**出す。ここで既に見えているかが1つ目の分かれ目。
  mini.showInactive()
  await sleep(1200)
  record('mini_shown_inactive', {
    mini: snapshot('mini', mini),
    main: snapshot('main', main),
    pageHasFocus: await pageHasFocus(miniView),
    dockVisible: dockVisible(),
    frontmost: frontmost(),
    shot: shoot('2-mini-shown-inactive')
  })

  // 次にキーフォーカスだけを渡す。
  // **View 側にも focus を入れる**。ウィンドウが key になっても、中の WebContents に
  // 入れないと `document.hasFocus()` は false のままになる。
  mini.focus()
  miniView.webContents.focus()
  await sleep(1200)
  record('after_mini_focus', {
    mini: snapshot('mini', mini),
    main: snapshot('main', main),
    pageHasFocus: await pageHasFocus(miniView),
    frontmost: frontmost(),
    shot: shoot('3-after-focus')
  })

  if (mode === 'steal') {
    // `focus()` だけでキーフォーカスが来ないなら、アプリごと前面に出すしかない。
    // **その副作用（メインウィンドウの Space へ飛ぶか）**を見るのがこのモード。
    app.focus({ steal: true })
    mini.focus()
    await sleep(1500)
    record('after_app_focus_steal', {
      mini: snapshot('mini', mini),
      main: snapshot('main', main),
      pageHasFocus: await pageHasFocus(miniView),
      frontmost: frontmost(),
      shot: shoot('4-after-steal')
    })
  }

  /* -------- 3) 全 Space を解除して、どの Space に残るか -------- */
  if (!flag('--no-all-workspaces')) mini.setVisibleOnAllWorkspaces(false)
  await sleep(2000)
  record('mini_all_workspaces_off', {
    mini: snapshot('mini', mini),
    main: snapshot('main', main),
    pageHasFocus: await pageHasFocus(miniView),
    dockVisible: dockVisible(),
    frontmost: frontmost(),
    shot: shoot('5-all-workspaces-off')
  })

  await sleep(3000)
  record('settled', { dockVisible: dockVisible(), frontmost: frontmost(), shot: shoot('6-settled') })

  /* -------- 3.5) メニューのアクセラレータが小窓に届くか -------- */
  // NSPanel は**アプリを前面に出さずに**キーを受け取る。ということは
  // メニューバーは前面のアプリ（ターミナル）のまま。⌘W / ⌘O のような
  // **メニューのアクセラレータが自分に届くのか**がここで決まる。
  // 届かないなら、小窓のキー操作はメニュー経由では作れない。
  if (flag('--probe-accelerator')) {
    mini.focus()
    miniView.webContents.focus()
    await sleep(600)
    spawnSync('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to keystroke "j" using command down'
    ])
    await sleep(1200)
    record('after_accelerator', {
      accelFired,
      pageKeys: await miniView.webContents.executeJavaScript('window.__keys ? window.__keys.join(",") : ""'),
      frontmost: frontmost(),
      shot: shoot('4b-accelerator')
    })
  }

  /* -------- 4) 別の Space へ移ったときに小窓が付いてくるか -------- */
  // 通常ウィンドウを前面に出して**わざと Space を切り替える**。
  // そこで小窓が見えていれば「全 Space 追従」、見えなければ「出した Space に固定」。
  if (flag('--probe-other-space')) {
    app.focus({ steal: true })
    main.focus()
    await sleep(2500)
    record('other_space', {
      mini: snapshot('mini', mini),
      main: snapshot('main', main),
      frontmost: frontmost(),
      shot: shoot('7-other-space')
    })
  }

  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`[spike] レポートを書いた: ${reportPath}`)
  }
  app.quit()
}
