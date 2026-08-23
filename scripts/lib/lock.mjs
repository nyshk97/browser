import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { artifactDirFor, safeJoin, validateLock } from '../../src/shared/ext-lock.js'

export { hashExtensionTree } from '../../src/shared/tree-hash.js'
export {
  artifactDirFor,
  assertInside,
  extensionRootFor,
  safeJoin,
  validateLock
} from '../../src/shared/ext-lock.js'


export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 置き場所は env で差し替えられる。
 * 更新・ロールバックの往復テストを、実物の lock と拡張に触れずに回すために要る。
 */
export const lockPath = process.env.NEMO_EXT_LOCK ?? path.join(projectRoot, 'extensions.lock.json')
export const extensionsDir =
  process.env.NEMO_EXT_DIR ?? path.join(projectRoot, 'extensions')
export const cacheDir = process.env.NEMO_EXT_CACHE ?? path.join(projectRoot, '.ext-cache')

export function readLock() {
  return validateLock(JSON.parse(fs.readFileSync(lockPath, 'utf8')))
}

export function writeLock(lock) {
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
}

export function artifactDir(entry) {
  return artifactDirFor(extensionsDir, entry)
}

export function cachePath(entry) {
  // ファイル名は URL 由来なので、basename を取ったうえで cacheDir の中に収まることを必ず確認する
  const name = path.basename(new URL(entry.source.url).pathname) || `${entry.id}-${entry.version}`
  return safeJoin(cacheDir, [entry.id, entry.version, path.basename(name)], 'cachePath')
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export async function download(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(destPath, buffer)
  return buffer
}
