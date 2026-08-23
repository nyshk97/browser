import { app } from 'electron'
import { log } from './log.js'

/**
 * 既定ブラウザの登録（計画 2-5）。
 *
 * `Info.plist` に `http` / `https` のハンドラを宣言しておくのが前提で
 * （`electron-builder.yml` の `mac.extendInfo`）、実際に既定にするのは
 * `setAsDefaultProtocolClient`。macOS はここで OS のダイアログを出すことがあり、
 * **返り値が true でも実際には既定になっていない**ことがある。
 * だから設定した後に必ず `isDefaultProtocolClient` で確かめて、
 * その結果を UI に返す（「押したのに変わらない」を黙って起こさない）。
 *
 * 開発起動（未パッケージ）では登録できない。Electron 本体が既定ブラウザとして
 * 登録されてしまうと後始末が面倒なので、**パッケージ版でだけ**受け付ける。
 */

export interface DefaultBrowserStatus {
  /** `http` の既定になっているか。 */
  http: boolean
  /** `https` の既定になっているか。 */
  https: boolean
  /** 両方の既定になっているか。 */
  isDefault: boolean
  /** この起動では設定できるか（未パッケージなら false）。 */
  canRequest: boolean
  /** 設定できない理由（UI に出す）。 */
  reason: string | null
}

const SCHEMES = ['http', 'https'] as const

export function getDefaultBrowserStatus(): DefaultBrowserStatus {
  const http = app.isDefaultProtocolClient('http')
  const https = app.isDefaultProtocolClient('https')
  return {
    http,
    https,
    isDefault: http && https,
    canRequest: app.isPackaged,
    reason: app.isPackaged
      ? null
      : '開発起動では既定ブラウザにできない（Electron 本体が登録されてしまうため）。パッケージ版で設定する'
  }
}

/**
 * 既定ブラウザにするよう OS に要求し、**結果を確かめて**返す。
 * 呼んだだけで成功扱いにしない。
 */
export function requestDefaultBrowser(): DefaultBrowserStatus {
  if (!app.isPackaged) {
    log('default_browser.request_skipped', { reason: 'not_packaged' })
    return getDefaultBrowserStatus()
  }
  for (const scheme of SCHEMES) {
    const accepted = app.setAsDefaultProtocolClient(scheme)
    log('default_browser.requested', { scheme, accepted })
  }
  const status = getDefaultBrowserStatus()
  log('default_browser.status', { http: status.http, https: status.https })
  return status
}
