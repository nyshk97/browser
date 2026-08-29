#!/usr/bin/env node
/**
 * 拡張に新しいバージョンが出ているかだけを確認する（計画 2-3）。
 *
 *   node scripts/ext-outdated.mjs
 *   node scripts/ext-outdated.mjs --json
 *
 * **何も書き換えない**。更新するかどうかは人が決めて `mise run ext:update <version>` を叩く。
 * 自動で最新を取りに行かないのが Nemo の拡張運用の前提（lock された不変 artifact だけをロードする）。
 */
import { compareVersions, versionFromCrxFilename, versionsFromTags } from './lib/ext-version.mjs'
import { readLock, webStoreDownloadUrl } from './lib/lock.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')

const info = (message) => {
  if (!asJson) console.log(`[ext-outdated] ${message}`)
}

async function latestForGithubRelease(entry) {
  const { repo, tagTemplate } = entry.source
  if (!repo || !tagTemplate) throw new Error('source に repo / tagTemplate が無い')

  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'nemo-ext-outdated' }
  if (process.env['GITHUB_TOKEN']) headers.authorization = `Bearer ${process.env['GITHUB_TOKEN']}`

  // Release は非常に多いので、新しい方から数ページだけ見る。
  // 拡張のリリース間隔（数週間）に対して十分な範囲。
  const found = []
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers
    })
    if (!response.ok) {
      throw new Error(`GitHub API が ${response.status}（${repo}）`)
    }
    const releases = await response.json()
    if (!Array.isArray(releases) || releases.length === 0) break
    found.push(
      ...versionsFromTags(
        releases.map((release) => release.tag_name),
        tagTemplate
      )
    )
    if (found.length > 0 && page >= 2) break
  }
  if (found.length === 0) throw new Error(`${tagTemplate} に当てはまるタグが見つからない`)
  return found.sort(compareVersions).at(-1)
}

/**
 * Web Store は「最新版の CRX へのリダイレクト」しか返さないが、
 * リダイレクト先のファイル名に版が入っているので、本体を落とさずに版だけ読める。
 */
async function latestForWebStore(entry) {
  const response = await fetch(webStoreDownloadUrl(entry), { redirect: 'manual' })
  const location = response.headers.get('location')
  if (!location) throw new Error(`Web Store がリダイレクトを返さない（${response.status}）`)
  const version = versionFromCrxFilename(location)
  if (!version) throw new Error(`リダイレクト先から版を読めない: ${location}`)
  return version
}

const lock = readLock()
const results = []
let failed = false

for (const entry of lock.extensions) {
  const resolver =
    entry.source.type === 'github-release'
      ? latestForGithubRelease
      : entry.source.type === 'chrome-web-store'
        ? latestForWebStore
        : null
  if (!resolver) {
    results.push({ id: entry.id, name: entry.name, current: entry.version, latest: null, note: '確認先なし' })
    continue
  }
  try {
    const latest = await resolver(entry)
    results.push({
      id: entry.id,
      name: entry.name,
      current: entry.version,
      latest,
      outdated: compareVersions(latest, entry.version) > 0
    })
  } catch (error) {
    failed = true
    results.push({
      id: entry.id,
      name: entry.name,
      current: entry.version,
      latest: null,
      note: error instanceof Error ? error.message : String(error)
    })
  }
}

if (asJson) {
  console.log(JSON.stringify({ extensions: results }, null, 2))
} else {
  for (const result of results) {
    if (result.latest === null) {
      info(`${result.name}: ${result.current}（確認できず: ${result.note}）`)
      continue
    }
    if (result.outdated) {
      info(`${result.name}: ${result.current} → ${result.latest} が出ている`)
      info(`  更新するなら: mise run ext:update ${result.latest}`)
      info('  更新後に mise run verify:ext と Bitwarden の実機確認を通す。戻すなら mise run ext:rollback')
    } else {
      info(`${result.name}: ${result.current}（最新）`)
    }
  }
}

// 「確認できなかった」を成功にしない（黙って見落とすため）
process.exit(failed ? 1 : 0)
