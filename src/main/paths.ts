import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Phase 0 のスパイクは常用データと完全に分離する。
 * （Phase 1 で Debug=Nemo-dev / Release=Nemo に分ける）
 */
export const APP_NAME = 'Nemo (Spike)'
export const USER_DATA_DIR_NAME = 'Nemo-spike'

/** Web ページ・拡張が同居するセッション。 */
export const PAGE_PARTITION = 'persist:nemo'
/**
 * ブラウザ UI 専用のセッション。
 * ページと同じセッションに UI を置くと、拡張の content script が
 * ブラウザ UI 自身に注入されうるため必ず分ける。
 */
export const UI_PARTITION = 'persist:nemo-ui'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** リポジトリのルート（out/main から2つ上）。 */
export const projectRoot = path.resolve(moduleDir, '..', '..')

/**
 * lock された拡張 artifact の置き場所。
 * `NEMO_EXT_DIR` / `NEMO_EXT_LOCK` で差し替えられる。
 * 検証スクリプトが**実リポジトリの拡張に触らずに**版の上げ下げを試すために必要
 * （稼働中の Nemo の拡張を差し替えてしまった実績あり）。
 */
export const extensionsDir = process.env['NEMO_EXT_DIR']
  ? path.resolve(process.env['NEMO_EXT_DIR'])
  : path.join(projectRoot, 'extensions')

export const extensionsLockPath = process.env['NEMO_EXT_LOCK']
  ? path.resolve(process.env['NEMO_EXT_LOCK'])
  : path.join(projectRoot, 'extensions.lock.json')

/**
 * データディレクトリ。
 * `NEMO_USER_DATA_DIR` で上書きできる。
 * 実 Vault の入ったプロファイルを触りたくない検証（CDP を開ける自走検証など）では
 * 必ず使い捨てのディレクトリを指定する。
 */
export function applyUserDataDir(): void {
  app.setName(APP_NAME)
  const override = process.env['NEMO_USER_DATA_DIR']
  app.setPath(
    'userData',
    override ? path.resolve(override) : path.join(app.getPath('appData'), USER_DATA_DIR_NAME)
  )
}
