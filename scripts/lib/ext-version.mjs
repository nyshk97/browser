/**
 * 拡張のバージョン比較とタグの読み取り（`ext-outdated` から使う）。
 * ネットワークに触らない純粋な関数だけを置き、`scripts/ext-outdated.test.mjs` から直接テストする。
 */
import { VERSION_RE } from '../../src/shared/ext-lock.js'

/**
 * `2026.8.0` のような版を比べる。**数値の桁ごとに**見る
 * （文字列比較だと `2026.10.0 < 2026.9.0` になり、新しい版を見落とす）。
 * @returns {number} a が新しければ 1
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left !== right) return left > right ? 1 : -1
  }
  return 0
}

/**
 * GitHub Release のタグ一覧から、その拡張のバージョンだけを取り出す。
 *
 * `tagTemplate`（例 `browser-v{version}`）に当てはまるものだけを見る。
 * bitwarden/clients は desktop / cli など**別プロダクトのタグも同じリポジトリに並ぶ**ので、
 * 接頭辞で絞らないと関係ない版を「新しい」と誤認する。
 *
 * @param {(string | { name?: string })[]} tags
 * @param {string} tagTemplate
 * @returns {string[]}
 */
export function versionsFromTags(tags, tagTemplate) {
  const [prefix, suffix] = tagTemplate.split('{version}')
  const versions = []
  for (const tag of tags) {
    const name = typeof tag === 'string' ? tag : tag?.name
    if (typeof name !== 'string') continue
    if (!name.startsWith(prefix)) continue
    if (suffix && !name.endsWith(suffix)) continue
    const version = name.slice(prefix.length, suffix ? name.length - suffix.length : undefined)
    if (VERSION_RE.test(version)) versions.push(version)
  }
  return versions
}
