// @ts-check
import fs from 'node:fs'
import path from 'node:path'

/**
 * `extensions.lock.json` のスキーマ検証とパス組み立て。
 *
 * lock の値はそのままファイルパスになり、`ext-fetch` は古い版のディレクトリを
 * **再帰削除する**。検証せずに使うと、壊れた（あるいは細工された）lock で
 * リポジトリごと消せてしまう（例: `id: ".."` なら削除対象がリポジトリルートになる）。
 *
 * main プロセスと Node スクリプトの両方から使う。検証を二重に実装しない。
 */

/** Chrome の拡張 ID は a〜p の32文字。 */
export const EXTENSION_ID_RE = /^[a-p]{32}$/

/** manifest の version は 1〜4 個のドット区切り整数（各 0〜65535）。 */
export const VERSION_RE = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/

/**
 * `target` が `base` の中（または base 自身）に収まっているか、**文字列として**検証する。
 * これだけではシンボリックリンクを防げない（`safeJoin` を使うこと）。
 * @param {string} base
 * @param {string} target
 * @param {string} label
 * @returns {string} 解決済みの target
 */
export function assertInside(base, target, label = 'path') {
  const resolvedBase = path.resolve(base)
  const resolved = path.resolve(target)
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`${label} が想定ディレクトリの外を指している: ${resolved} (base: ${resolvedBase})`)
  }
  return resolved
}

/**
 * base 自身は実体パスに解決する。
 * macOS の一時ディレクトリは `/var -> /private/var` のように
 * **base より上に** シンボリックリンクが混ざるので、そこは許容しないと何も通らない。
 * 危険なのは base より下に張られたリンクなので、そちらだけを見る。
 * @param {string} base
 */
function realBase(base) {
  const resolved = path.resolve(base)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

/**
 * `base` の下に `segments` を継ぎ足したパスを返す。
 *
 * - base の外を指していたら投げる
 * - **base から下の各段にシンボリックリンクがあれば投げる**
 *
 * `ext-fetch` は `extensions/<id>/` の配下を再帰削除するので、
 * 文字列の検証だけでは足りない。`extensions/<正しい形式の id>` が
 * リポジトリルートへの symlink なら、字句上は base 内に見えたまま外を消せてしまう。
 *
 * @param {string} base
 * @param {string[]} segments
 * @param {string} label
 * @returns {string}
 */
export function safeJoin(base, segments, label = 'path') {
  const root = realBase(base)
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new Error(`${label}: 空のパス要素は使えない`)
    }
  }
  const target = path.resolve(root, ...segments)
  assertInside(root, target, label)

  let current = root
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch {
      break // まだ存在しない = リンクではない。以降も存在しない
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}: 経路にシンボリックリンクがある: ${current}`)
    }
  }
  return target
}

/**
 * lock エントリ1件を検証する。
 * @param {any} entry
 * @param {number} index
 */
export function validateEntry(entry, index) {
  const where = `extensions[${index}]`
  if (!entry || typeof entry !== 'object') throw new Error(`${where}: オブジェクトでない`)

  if (typeof entry.id !== 'string' || !EXTENSION_ID_RE.test(entry.id)) {
    throw new Error(`${where}: id が拡張 ID の形式でない (${JSON.stringify(entry.id)})`)
  }
  if (typeof entry.version !== 'string' || !VERSION_RE.test(entry.version)) {
    throw new Error(`${where}: version が不正 (${JSON.stringify(entry.version)})`)
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    throw new Error(`${where}: name が無い`)
  }

  const source = entry.source
  if (!source || typeof source !== 'object') throw new Error(`${where}: source が無い`)
  if (source.type !== 'github-release' && source.type !== 'chrome-web-store' && source.type !== 'local') {
    throw new Error(`${where}: source.type が不正 (${JSON.stringify(source.type)})`)
  }

  if (source.type === 'local') {
    // リポジトリ内の自作拡張（取得先が無い）。CI 用のテスト拡張がこれ。
    // パスはリポジトリ相対に限る（絶対パスや `..` を許すと lock 1行で任意のディレクトリを読める）。
    if (typeof source.path !== 'string' || source.path.length === 0) {
      throw new Error(`${where}: source.path が無い（type: local）`)
    }
    if (path.isAbsolute(source.path)) {
      throw new Error(`${where}: source.path に絶対パスは使えない`)
    }
    const normalized = path.normalize(source.path)
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`${where}: source.path がリポジトリの外を指している`)
    }
  } else {
    if (typeof source.url !== 'string') throw new Error(`${where}: source.url が無い`)
    let url
    try {
      url = new URL(source.url)
    } catch {
      throw new Error(`${where}: source.url が URL でない`)
    }
    if (url.protocol !== 'https:') {
      throw new Error(`${where}: source.url は https のみ許可 (${url.protocol})`)
    }
  }

  for (const field of ['sha256', 'treeSha256']) {
    const value = entry[field]
    if (value !== undefined && value !== '' && !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${where}: ${field} が sha256 の形式でない`)
    }
  }

  if (entry.manifestKey !== undefined && typeof entry.manifestKey !== 'string') {
    throw new Error(`${where}: manifestKey が文字列でない`)
  }

  if (entry.unpackedRoot !== undefined) {
    if (typeof entry.unpackedRoot !== 'string') {
      throw new Error(`${where}: unpackedRoot が文字列でない`)
    }
    if (path.isAbsolute(entry.unpackedRoot)) {
      throw new Error(`${where}: unpackedRoot に絶対パスは使えない`)
    }
    const normalized = path.normalize(entry.unpackedRoot)
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`${where}: unpackedRoot が展開先の外を指している`)
    }
  }
}

/**
 * lock 全体を検証する。壊れていたら投げる。
 * @param {any} lock
 * @returns {any} 検証済みの lock
 */
export function validateLock(lock) {
  if (!lock || typeof lock !== 'object') throw new Error('lock がオブジェクトでない')
  if (lock.lockfileVersion !== 1) {
    throw new Error(`unsupported lockfileVersion: ${lock.lockfileVersion}`)
  }
  if (!Array.isArray(lock.extensions)) throw new Error('lock.extensions が配列でない')

  const seen = new Set()
  lock.extensions.forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
    validateEntry(entry, index)
    if (seen.has(entry.id)) throw new Error(`extensions[${index}]: id が重複している (${entry.id})`)
    seen.add(entry.id)
  })
  return lock
}

/**
 * 拡張1件の展開先ディレクトリ。必ず extensionsDir の中に収まることを確認する。
 * @param {string} extensionsDir
 * @param {{ id: string, version: string }} entry
 * @returns {string}
 */
export function artifactDirFor(extensionsDir, entry) {
  if (!EXTENSION_ID_RE.test(entry.id)) throw new Error(`不正な拡張 ID: ${entry.id}`)
  if (!VERSION_RE.test(entry.version)) throw new Error(`不正な version: ${entry.version}`)
  return safeJoin(extensionsDir, [entry.id, `${entry.version}_0`], 'artifactDir')
}

/**
 * 拡張1件のディレクトリ（版をまたぐ親）。
 * @param {string} extensionsDir
 * @param {{ id: string }} entry
 * @returns {string}
 */
export function extensionRootFor(extensionsDir, entry) {
  if (!EXTENSION_ID_RE.test(entry.id)) throw new Error(`不正な拡張 ID: ${entry.id}`)
  return safeJoin(extensionsDir, [entry.id], 'extensionRoot')
}
