// @ts-check
/**
 * kypr（自作のパスワードマネージャー）の宛先と、自走検証の差し替えの**純粋ロジック**。
 *
 * Electron を import しない（main と `scripts/*.test.mjs` の両方から読む）。
 *
 * - サーバーは dev 版も常用版も本番を向ける（dev 版を常用することもあるため）
 * - 自走検証だけ `NEMO_KYPR_TEST_SERVER` で模擬サーバーへ向ける。**パッケージ版では無視する**
 *   （env を付けて起動したパッケージ版から、鍵を任意のサーバーへ送らせないため。`NEMO_JEV_TEST_ENDPOINT` と同じ作法）
 * - **検証モード（`NEMO_VERIFY_DIAGNOSTICS=1`）で宛先が無ければ kypr を起動しない**。渡し忘れた検証が本番に届かないように
 */

export const KYPR_PRODUCTION_SERVER = 'https://kypr.tools97.com'

/**
 * @param {{ testServer: string | undefined, isPackaged: boolean, verifyMode: boolean }} input
 * @returns {{ ok: true, url: string, testing: boolean } | { ok: false, reason: 'verify-without-server' | 'bad-test-server' }}
 */
export function resolveKyprServer({ testServer, isPackaged, verifyMode }) {
  if (isPackaged) return { ok: true, url: KYPR_PRODUCTION_SERVER, testing: false }
  if (testServer) {
    let url
    try {
      url = new URL(testServer)
    } catch {
      return { ok: false, reason: 'bad-test-server' }
    }
    // 模擬サーバーは手元（127.0.0.1 / localhost）だけ。外へ向けられる口にしない
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return { ok: false, reason: 'bad-test-server' }
    }
    return { ok: true, url: url.origin, testing: true }
  }
  if (verifyMode) return { ok: false, reason: 'verify-without-server' }
  return { ok: true, url: KYPR_PRODUCTION_SERVER, testing: false }
}

/**
 * Touch ID の差し替え（自走検証で実際の Touch ID のダイアログを出さない）。パッケージ版では無視する。
 * @param {string | undefined} envValue
 * @param {boolean} isPackaged
 * @returns {'real' | 'ok' | 'fail' | 'unavailable'}
 */
export function resolveKyprTouchIdMode(envValue, isPackaged) {
  if (isPackaged) return 'real'
  if (envValue === 'ok' || envValue === 'fail' || envValue === 'unavailable') return envValue
  return 'real'
}

/** 使っていないとロックするまでの時間（自動入力・コピー・ポップアップの操作で延びる）。 */
export const KYPR_IDLE_LOCK_MS = 60 * 60 * 1000

/** 候補・バッジを出す前に同期し直す間隔。 */
export const KYPR_SYNC_INTERVAL_MS = 60 * 1000

/** コピーしたものをクリップボードから消すまでの時間（Web と同じ）。 */
export const KYPR_CLIPBOARD_CLEAR_MS = 30 * 1000
