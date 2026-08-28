import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ビルド種別（dev 版 / 常用版）。
 *
 * `__NEMO_CHANNEL__` は electron-vite の define でビルド時に埋め込む。
 * **開発起動（未パッケージ）は常に dev**にする。常用版のデータディレクトリを
 * 開発中の実行が触ってしまうと、実 Vault の入ったプロファイルを壊しうる。
 */
declare const __NEMO_CHANNEL__: 'dev' | 'stable'

export type Channel = 'dev' | 'stable'

const BUILD_CHANNEL: Channel = typeof __NEMO_CHANNEL__ === 'string' ? __NEMO_CHANNEL__ : 'dev'

export const channel: Channel = app.isPackaged ? BUILD_CHANNEL : 'dev'

export const isDevChannel = channel === 'dev'

/** 表示名 / bundle id / データディレクトリを channel ごとに分ける。 */
const CHANNEL_CONFIG = {
  dev: { appName: 'Nemo Dev', userDataDirName: 'Nemo-dev', appId: 'local.nyshk97.nemo.dev' },
  stable: { appName: 'Nemo', userDataDirName: 'Nemo', appId: 'local.nyshk97.nemo' }
} as const

export const APP_NAME = CHANNEL_CONFIG[channel].appName
export const APP_ID = CHANNEL_CONFIG[channel].appId
/** データディレクトリの名前（`Nemo` / `Nemo-dev`）。iCloud のスロット置き場にも使う。 */
export const USER_DATA_DIR_NAME = CHANNEL_CONFIG[channel].userDataDirName

/** Web ページ・拡張が同居するセッション。 */
export const PAGE_PARTITION = 'persist:nemo'
/**
 * ブラウザ UI 専用のセッション。
 * ページと同じセッションに UI を置くと、拡張の content script が
 * ブラウザ UI 自身に注入されうるため必ず分ける。
 */
export const UI_PARTITION = 'persist:nemo-ui'

/** ブラウザ UI を配信する custom protocol（`file://` では配信しない）。 */
export const UI_SCHEME = 'nemo'
export const UI_ORIGIN = `${UI_SCHEME}://ui`
export const UI_INDEX_URL = `${UI_ORIGIN}/index.html`

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** ビルド成果物のルート（out/main から1つ上 = out/）。 */
export const outDir = path.resolve(moduleDir, '..')

/** リポジトリのルート（out/main から2つ上）。パッケージ後は app.asar のルート。 */
export const projectRoot = path.resolve(moduleDir, '..', '..')

/** ブラウザ UI の静的ファイル置き場。 */
export const rendererDir = path.join(outDir, 'renderer')

/**
 * lock された拡張 artifact の置き場所。
 *
 * パッケージ後は **asar の外**（`Contents/Resources/`）を見る。
 * Chromium の拡張ローダーはネイティブコードなので、asar の中のパスからは読めない
 * （`fs` は asar を透過的に読めるので、存在チェックだけ通って
 * `loadExtension` で落ちる、という分かりにくい壊れ方をする）。
 *
 * `NEMO_EXT_DIR` / `NEMO_EXT_LOCK` で差し替えられる。
 * 検証スクリプトが**実リポジトリの拡張に触らずに**版の上げ下げを試すために必要
 * （稼働中の Nemo の拡張を差し替えてしまった実績あり）。
 */
const resourcesRoot = app.isPackaged ? process.resourcesPath : projectRoot

export const extensionsDir = process.env['NEMO_EXT_DIR']
  ? path.resolve(process.env['NEMO_EXT_DIR'])
  : path.join(resourcesRoot, 'extensions')

export const extensionsLockPath = process.env['NEMO_EXT_LOCK']
  ? path.resolve(process.env['NEMO_EXT_LOCK'])
  : path.join(resourcesRoot, 'extensions.lock.json')

/**
 * データディレクトリを channel ごとに分ける。
 * `NEMO_USER_DATA_DIR` で上書きできる。
 * 実 Vault の入ったプロファイルを触りたくない検証（CDP を開ける自走検証など）では
 * 必ず使い捨てのディレクトリを指定する。
 */
export function applyUserDataDir(): void {
  app.setName(APP_NAME)
  const override = process.env['NEMO_USER_DATA_DIR']
  app.setPath(
    'userData',
    override
      ? path.resolve(override)
      : path.join(app.getPath('appData'), CHANNEL_CONFIG[channel].userDataDirName)
  )
}

/** `<userData>/...` を組み立てる。applyUserDataDir の後にだけ呼ぶ。 */
export function userDataPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments)
}
