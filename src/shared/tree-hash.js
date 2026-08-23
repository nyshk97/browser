// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 展開済み拡張ツリーの決定的なハッシュ。
 *
 * lock には「取得したアーカイブの sha256」だけでなく、**manifest.key を注入したあとの
 * ツリー全体のハッシュ**も記録する。アーカイブの hash だけだと、展開後の JS を
 * 書き換えられても検知できないため。
 *
 * main プロセスは起動時にこの値を照合し、**一致しなければロードしない**。
 *
 * ハッシュ対象: 相対パス（`/` 区切り・昇順）と各ファイルの内容。
 * シンボリックリンクが含まれていたらツリー外を指せるので拒否する。
 *
 * @param {string} dir
 * @returns {string} 16進の sha256
 */
export function hashExtensionTree(dir) {
  /** @type {Array<[string, string]>} */
  const files = []

  /**
   * @param {string} current
   * @param {string} rel
   */
  const walk = (current, rel) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(`拡張ツリーにシンボリックリンクが含まれている: ${relative}`)
      }
      if (entry.isDirectory()) {
        walk(absolute, relative)
      } else if (entry.isFile()) {
        files.push([relative, absolute])
      } else {
        throw new Error(`拡張ツリーに通常ファイル以外が含まれている: ${relative}`)
      }
    }
  }

  walk(dir, '')

  const hash = createHash('sha256')
  hash.update(`files:${files.length}\n`)
  for (const [relative, absolute] of files) {
    hash.update(relative)
    hash.update('\0')
    hash.update(createHash('sha256').update(fs.readFileSync(absolute)).digest())
  }
  return hash.digest('hex')
}
