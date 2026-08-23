// @ts-check
/**
 * 設定同期（計画 2-1）のスキーマ。
 *
 * 同期の境界:
 * - **常用データ** = `Application Support/<Nemo|Nemo-dev>/` の JSON。アプリが読み書きするのは常にこちら
 * - **staging** = `nemo-config` の git 作業コピー。アプリは直接読まない
 *
 * ここには「何を同期するか」と「読む前の検証」だけを置く。git 操作は
 * `scripts/lib/config-sync.mjs`、CLI は `scripts/config-sync.mjs`。
 * Electron 非依存なので `scripts/config-sync.test.mjs` から直接テストできる。
 */
import {
  PINS_VERSION,
  SETTINGS_VERSION,
  isRecord,
  normalizePins,
  normalizeSettings,
  readVersioned
} from './settings-schema.js'

/**
 * staging に置く `manifest.json` の版。
 * **上げるのは「古い Nemo が読めなくなる変更」をしたときだけ**。
 * 2台で Nemo の版がズレている状態は普通に起きるので、
 * 新しい版が書いた staging を古い Nemo が黙って壊さないための歯止めにする。
 */
export const SYNC_SCHEMA_VERSION = 1

/**
 * 同期するファイル。
 *
 * 履歴（`history.db`）・セッション（`session.json`）・権限（`permissions.json`）・
 * ダウンロードは**端末ローカル**なので載せない（計画の決定事項）。
 *
 * @type {{ name: string, version: number, normalize: (raw: unknown) => unknown, label: string }[]}
 */
export const SYNCED_FILES = [
  { name: 'settings.json', version: SETTINGS_VERSION, normalize: normalizeSettings, label: '設定' },
  { name: 'pins.json', version: PINS_VERSION, normalize: normalizePins, label: 'ピン留め / Favorites' }
]

/**
 * staging に写すが **import はしない**ファイル。
 *
 * 拡張の lock はアプリ本体に同梱されて配られる（`extraResources`）ので、
 * 同期リポジトリを source of truth にすると二重管理になる。
 * ここでは「2台で版が揃っているか」を突き合わせるための写しとしてだけ持つ。
 */
export const REFERENCE_FILES = [{ name: 'extensions.lock.json', label: '拡張の lock（参照用）' }]

/** git のコンフリクトマーカー。混ざった JSON をアプリに読ませない。 */
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/m

/**
 * 中身にコンフリクトマーカーが残っているか。
 * @param {string} text
 */
export function hasConflictMarkers(text) {
  return CONFLICT_MARKER_RE.test(text)
}

/**
 * staging の `manifest.json` を検証する。
 * @param {unknown} raw
 * @returns {{ syncSchemaVersion: number, updatedAt: string, appVersion: string }}
 */
export function validateManifest(raw) {
  if (!isRecord(raw)) throw new Error('manifest.json がオブジェクトでない')
  const version = raw['syncSchemaVersion']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('manifest.json の syncSchemaVersion が不正')
  }
  if (version > SYNC_SCHEMA_VERSION) {
    throw new Error(
      `manifest.json の syncSchemaVersion が新しい（staging ${version} / この Nemo ${SYNC_SCHEMA_VERSION}）。` +
        'Nemo を更新してから pull する'
    )
  }
  return {
    syncSchemaVersion: version,
    updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : '',
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : ''
  }
}

/**
 * 同期ファイル1件を「読んでよい形か」まで検証して、正規化済みの `{version, data}` を返す。
 *
 * import の前段に必ずこれを通す。ここを抜くと、手で編集された JSON や
 * コンフリクトマーカー入りの JSON がそのまま常用データに入る。
 *
 * @param {{ name: string, version: number, normalize: (raw: unknown) => unknown }} spec
 * @param {string} text ファイルの中身
 * @returns {{ version: number, data: unknown }}
 */
export function validateSyncedFile(spec, text) {
  if (hasConflictMarkers(text)) {
    throw new Error(`${spec.name}: コンフリクトマーカーが残っている。git で解決してから pull する`)
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${spec.name}: JSON として読めない`, { cause: error })
  }
  const versioned = readVersioned(parsed, spec.version)
  if (!versioned) {
    throw new Error(
      `${spec.name}: version が無い / この Nemo より新しい（対応 ${spec.version}）。Nemo を更新してから pull する`
    )
  }
  return { version: spec.version, data: spec.normalize(versioned.data) }
}

/**
 * 書き出す JSON のテキスト（改行つき・キー順は入力のまま）。
 * push / pull の両方でこれを通し、**同じ内容なら必ず同じバイト列**にする
 * （空白の違いだけで git の差分が出ると、変更の有無を判定できない）。
 *
 * @param {unknown} value
 */
export function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}
