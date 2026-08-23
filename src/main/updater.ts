import { app, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { APP_NAME, isDevChannel } from './paths.js'
import { log, logError } from './log.js'
import type { UpdateState } from '../shared/types.js'

/**
 * アプリ内自動更新（計画 2-6）。
 *
 * 更新の取得元は GitHub Release の `latest-mac.yml`。electron-builder が
 * `publish` 設定から `app-update.yml` を成果物に埋め込む。
 *
 * **dev 版では絶対に動かさない**。dev で更新チェックが走ると、開発中のビルドが
 * 常用版のバイナリで置き換わる。二重防御にしてある:
 *   ① `scripts/package.mjs` が dev では `publish` を外す（`app-update.yml` を埋め込まない）
 *   ② ここで `isDevChannel` を見て updater を起動しない
 * `scripts/check-package.mjs` が①を成果物に対して検査する。
 *
 * 適用のタイミングは**終了時**（`autoInstallOnAppQuit`）。一日中開いているブラウザで
 * 作業中に再起動を迫るのは割に合わないので、落としてくるところまでを自動でやり、
 * 適用は次の起動か、ユーザーがメニューから「再起動して更新」を選んだときにする。
 */

const { autoUpdater } = electronUpdater

/** 起動直後のチェックを遅らせる（起動時のタブ読み込みと帯域を取り合わないため）。 */
const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle', version: null, percent: null, error: null }
let listener: (() => void) | null = null
let timer: NodeJS.Timeout | null = null
/** メニューから明示的に叩かれたか（結果をダイアログで知らせるのはこのときだけ）。 */
let manualCheck = false

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateChanged(callback: () => void): void {
  listener = callback
}

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  listener?.()
}

/** 更新の導線が使えるか（dev 版と未パッケージでは使えない）。 */
export function isUpdaterAvailable(): boolean {
  return app.isPackaged && !isDevChannel
}

export function initUpdater(): void {
  if (!isUpdaterAvailable()) {
    log('updater.disabled', { packaged: app.isPackaged, dev: isDevChannel })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // electron-updater の内部ログも診断ログに寄せる（更新の失敗は UI からは追えない）
  autoUpdater.logger = {
    info: (message: unknown) => log('updater.info', { message: String(message) }),
    warn: (message: unknown) => log('updater.warn', { message: String(message) }),
    error: (message: unknown) => log('updater.error', { message: String(message) }),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }))

  autoUpdater.on('update-available', (info) => {
    log('updater.available', { version: info.version })
    setState({ status: 'downloading', version: info.version, percent: 0 })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ status: 'idle', version: null, percent: null })
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'info',
        message: `${APP_NAME} は最新です`,
        detail: `バージョン ${app.getVersion()}`,
        buttons: ['OK']
      })
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log('updater.downloaded', { version: info.version })
    manualCheck = false
    setState({ status: 'ready', version: info.version, percent: 100 })
  })

  autoUpdater.on('error', (error) => {
    logError('updater.failed', error)
    const wasManual = manualCheck
    manualCheck = false
    setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    if (wasManual) {
      void dialog.showMessageBox({
        type: 'error',
        message: '更新を確認できなかった',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['OK']
      })
    }
  })

  // 起動直後と 24 時間ごと。ブラウザは自分から更新を見に行く動機が無いので、
  // 自動チェックを切ると更新が永久に取りこぼされる。
  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS).unref?.()
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  timer.unref?.()
}

async function check(): Promise<void> {
  if (!isUpdaterAvailable()) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // イベント側でも拾うが、await の拒否を未処理にしない
    logError('updater.check_failed', error)
  }
}

/** メニューの「アップデートを確認…」。結果をダイアログで知らせる。 */
export function checkForUpdatesManually(): void {
  if (!isUpdaterAvailable()) {
    void dialog.showMessageBox({
      type: 'info',
      message: 'この版では更新を確認できない',
      detail: '開発版（Nemo Dev）は更新の対象外。常用版の Nemo で確認する。',
      buttons: ['OK']
    })
    return
  }
  if (state.status === 'ready') {
    promptRestart()
    return
  }
  manualCheck = true
  void check()
}

/** 落とし終えた更新を適用する（終了 → インストール → 再起動）。 */
export function promptRestart(): void {
  if (state.status !== 'ready') return
  void dialog
    .showMessageBox({
      type: 'info',
      message: `${APP_NAME} ${state.version} の準備ができた`,
      detail: '再起動すると更新が適用される。開いているタブは復元される。',
      buttons: ['再起動して更新', 'あとで'],
      defaultId: 0,
      cancelId: 1
    })
    .then((result) => {
      if (result.response === 0) {
        log('updater.quit_and_install', { version: state.version })
        autoUpdater.quitAndInstall()
      }
    })
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
