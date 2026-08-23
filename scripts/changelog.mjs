#!/usr/bin/env node
/**
 * CHANGELOG の読み書き（`mise run release` から呼ばれる）。
 *
 *   node scripts/changelog.mjs check              [Unreleased] が空でないことを確かめる
 *   node scripts/changelog.mjs release <ver> <日付>  [Unreleased] を確定して新しい空の枠を積む
 *   node scripts/changelog.mjs notes <ver> [出力先]  その版のノート本文を取り出す
 *
 * **パーサは ``` フェンスの中の見出しを無視する**。CHANGELOG の「書き方」セクションには
 * `## [Unreleased]` を含むコード例があり、素朴な正規表現だとそちらを先に拾って
 * 書き方の説明文をリリースノートとして公開してしまう。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const changelogPath = path.join(projectRoot, 'docs', 'CHANGELOG.md')

/**
 * `## [版] - 日付` の見出しを拾う。返すのは行番号つきのセクション一覧。
 * フェンス（``` / ~~~）の中は本文とみなす。
 */
export function parseSections(text) {
  const lines = text.split('\n')
  const sections = []
  let fence = null

  lines.forEach((line, index) => {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      return
    }
    if (fence !== null) return

    const heading = /^##\s+\[([^\]]+)\]\s*(?:-\s*(\S+))?\s*$/.exec(line)
    if (heading) {
      sections.push({ version: heading[1], date: heading[2] ?? null, headingLine: index })
    }
  })

  return sections.map((section, i) => {
    const nextHeading = sections[i + 1]?.headingLine ?? lines.length
    return {
      ...section,
      body: lines
        .slice(section.headingLine + 1, nextHeading)
        .join('\n')
        .trim()
    }
  })
}

export function findSection(text, version) {
  return parseSections(text).find((section) => section.version === version) ?? null
}

/** `[Unreleased]` を `[version] - date` に確定し、上に新しい空の `[Unreleased]` を積む。 */
export function releaseSection(text, version, date) {
  const sections = parseSections(text)
  const unreleased = sections.find((section) => section.version === 'Unreleased')
  if (!unreleased) throw new Error('[Unreleased] セクションが無い')
  if (!unreleased.body) throw new Error('[Unreleased] が空')
  if (sections.some((section) => section.version === version)) {
    throw new Error(`[${version}] は既に CHANGELOG にある`)
  }

  const lines = text.split('\n')
  lines[unreleased.headingLine] = `## [Unreleased]\n\n## [${version}] - ${date}`
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2)
  const text = fs.readFileSync(changelogPath, 'utf8')

  if (command === 'check') {
    const unreleased = findSection(text, 'Unreleased')
    if (!unreleased) {
      console.error('[changelog] docs/CHANGELOG.md に [Unreleased] セクションが無い')
      process.exit(1)
    }
    if (!unreleased.body) {
      console.error(
        '[changelog] [Unreleased] が空。リリースする内容を docs/CHANGELOG.md に書いてからやり直す'
      )
      process.exit(1)
    }
    console.log('[changelog] [Unreleased] に内容がある')
  } else if (command === 'release') {
    const [version, date] = rest
    if (!version || !date) {
      console.error('使い方: changelog.mjs release <version> <YYYY-MM-DD>')
      process.exit(1)
    }
    fs.writeFileSync(changelogPath, releaseSection(text, version, date))
    console.log(`[changelog] [${version}] - ${date} を確定した`)
  } else if (command === 'notes') {
    const [version, outFile] = rest
    const section = findSection(text, version)
    if (!section) {
      console.error(`[changelog] [${version}] のセクションが無い`)
      process.exit(1)
    }
    if (outFile) fs.writeFileSync(outFile, `${section.body}\n`)
    else process.stdout.write(`${section.body}\n`)
  } else {
    console.error('使い方: changelog.mjs check | release <ver> <date> | notes <ver> [out]')
    process.exit(1)
  }
}
