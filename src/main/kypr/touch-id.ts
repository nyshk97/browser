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

/** 通れば true。キャンセル・失敗・使えないは false（呼び出し側はマスターパスワードに回す）。 */
export async function promptTouchId(reason: string): Promise<boolean> {
  const m = mode()
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
}
