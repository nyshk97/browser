import { app, systemPreferences } from 'electron'
import { resolveKyprTouchIdMode } from '../../shared/kypr-config.js'
import { log } from '../log.js'

/**
 * Touch ID。**自走検証は `NEMO_KYPR_TEST_TOUCHID`（ok / fail / unavailable）で差し替える**
 * （実物はダイアログを出して止まる。パッケージ版では env を無視する）。
 *
 * Touch ID は「覚えた鍵を復号する前の関門」で、Keychain の鍵自体は生体認証に縛られていない
 * （plan「解除（Touch ID）」。生体認証付きの Keychain はネイティブアドオンと entitlement が要るので見送った）。
 */
const mode = (): ReturnType<typeof resolveKyprTouchIdMode> =>
  resolveKyprTouchIdMode(process.env['NEMO_KYPR_TEST_TOUCHID'], app.isPackaged)

/**
 * 差し替えた Touch ID が答えるまでの時間（`NEMO_KYPR_TEST_TOUCHID_MS`）。実物はダイアログで待つので、
 * 「処理中に次の要求が来た」を自走検証で作るのに使う。パッケージ版では無視する（`mode()` が 'real' になる）。
 */
async function testDelay(): Promise<void> {
  const ms = Number(process.env['NEMO_KYPR_TEST_TOUCHID_MS'])
  if (Number.isFinite(ms) && ms > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10_000)))
}

export function touchIdAvailable(): boolean {
  const m = mode()
  if (m === 'ok' || m === 'fail') return true
  if (m === 'unavailable') return false
  try {
    return systemPreferences.canPromptTouchID()
  } catch {
    return false
  }
}

/** Touch ID のダイアログを出している最中か（どの経路からでも 2 枚目は出さない）。 */
let prompting = false

/**
 * 通れば true。キャンセル・失敗・使えないは false（呼び出し側はマスターパスワードに回す）。
 * **別の経路の Touch ID が出ている間は、出さずに false**（ダイアログを重ねない）。
 */
export async function promptTouchId(reason: string): Promise<boolean> {
  if (prompting) {
    log('kypr.touch_id_busy', {})
    return false
  }
  prompting = true
  try {
    const m = mode()
    if (m === 'ok' || m === 'fail') await testDelay()
    if (m === 'ok') return true
    if (m === 'fail' || m === 'unavailable') return false
    if (!touchIdAvailable()) return false
    try {
      await systemPreferences.promptTouchID(reason)
      return true
    } catch (error) {
      log('kypr.touch_id_failed', { error: error instanceof Error ? error.message.slice(0, 80) : 'unknown' })
      return false
    }
  } finally {
    prompting = false
  }
}

/** WebAuthn の要求（kypr の Web 版の PRF・パスキー）を処理中か。 */
let requestHeld = false

/**
 * WebAuthn の要求を 1 件だけ通すロック（PRF の認証器とパスキーの認証器で共通）。取れたら離す関数、
 * 処理中の要求があれば null（呼び出し側はすぐ断る）。アカウントの選択から Touch ID まで握る
 */
export function holdWebAuthnRequest(): (() => void) | null {
  if (requestHeld) return null
  requestHeld = true
  let released = false
  return () => {
    if (released) return
    released = true
    requestHeld = false
  }
}
