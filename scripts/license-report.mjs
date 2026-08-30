#!/usr/bin/env node
/**
 * 依存ライブラリのライセンスを棚卸しする（`mise run licenses`）。
 *
 * Nemo は GPL-3.0-only で配布するので、**copyleft と衝突する依存が
 * 紛れ込んでいないこと**を機械的に確認できる状態にしておく。
 *
 *   node scripts/license-report.mjs                  一覧を出す
 *   node scripts/license-report.mjs --check          衝突しうるライセンスがあれば非ゼロで終わる
 *   node scripts/license-report.mjs --write <path>   notice ファイルを書き出す（成果物に同梱する）
 */
import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './lib/harness.mjs'

/** GPL-3.0 の成果物に取り込んでよいライセンス。 */
const COMPATIBLE = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'MPL-2.0',
  'WTFPL'
])

const storeDir = path.join(projectRoot, 'node_modules', '.pnpm')
if (!fs.existsSync(storeDir)) {
  console.error('node_modules/.pnpm が無い。先に `pnpm install` を実行する。')
  process.exit(1)
}

/**
 * 個別に確認して受け入れたもの。
 * OR で並んでいるライセンスは互換な側を選べるので問題ない。
 */
const ACCEPTED = new Map([
  [
    'electron-chrome-extensions',
    'GPL-3.0 と Patron License のデュアル。GPL-3.0 を選ぶ（Nemo 本体を GPL-3.0-only で public 配布する理由そのもの）'
  ],
  ['sanitize-filename', 'WTFPL OR ISC。ISC を選ぶ'],
  ['type-fest', 'MIT OR CC0-1.0。MIT を選ぶ'],
  ['utf8-byte-length', 'WTFPL OR MIT。MIT を選ぶ']
])

/** @type {Map<string, string[]>} */
const byLicense = new Map()
/** @type {Map<string, string>} */
const unknown = new Map()
/** notice に出す本文。`name@version` → { license, text }。 */
const notices = new Map()

const LICENSE_FILE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i

/** パッケージ内のライセンス本文を探す（MIT / BSD は本文の同梱が条件になっている）。 */
function readLicenseText(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  const name = entries.find((entry) => LICENSE_FILE_RE.test(entry))
  if (!name) return null
  try {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    return text.length > 20000 ? `${text.slice(0, 20000)}\n…（省略）` : text
  } catch {
    return null
  }
}

for (const entry of fs.readdirSync(storeDir)) {
  const modulesDir = path.join(storeDir, entry, 'node_modules')
  if (!fs.existsSync(modulesDir)) continue
  for (const scope of fs.readdirSync(modulesDir)) {
    const packages = scope.startsWith('@')
      ? fs.readdirSync(path.join(modulesDir, scope)).map((name) => `${scope}/${name}`)
      : [scope]
    for (const name of packages) {
      const manifestPath = path.join(modulesDir, name, 'package.json')
      if (!fs.existsSync(manifestPath)) continue
      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      if (!manifest.version) continue
      const license =
        typeof manifest.license === 'string'
          ? manifest.license
          : (manifest.license?.type ?? manifest.licenses?.[0]?.type ?? 'UNKNOWN')
      const id = `${name}@${manifest.version}`
      const list = byLicense.get(license) ?? []
      if (!list.includes(id)) list.push(id)
      byLicense.set(license, list)
      if (!COMPATIBLE.has(license) && !ACCEPTED.has(name)) unknown.set(id, license)
      if (!notices.has(id)) {
        notices.set(id, { license, text: readLicenseText(path.join(modulesDir, name)) })
      }
    }
  }
}

const sorted = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)
console.log('| ライセンス | 件数 |')
console.log('|---|---|')
for (const [license, packages] of sorted) {
  console.log(`| ${license} | ${packages.length} |`)
}

console.log('\n個別に確認して受け入れたもの:')
for (const [name, reason] of ACCEPTED) {
  console.log(`  ${name.padEnd(28)} ${reason}`)
}

if (unknown.size > 0) {
  console.log('\n要確認（互換リストにも例外リストにも無い）:')
  for (const [id, license] of [...unknown].sort()) {
    console.log(`  ${license.padEnd(28)} ${id}`)
  }
}

const writeIndex = process.argv.indexOf('--write')
if (writeIndex !== -1) {
  const target = process.argv[writeIndex + 1]
  if (!target) {
    console.error('--write には出力先を指定する')
    process.exit(1)
  }
  const lines = [
    '# Third-party notices',
    '',
    'Nemo は GPL-3.0-only で配布されています。Nemo 自身のソースは',
    'https://github.com/nyshk97/browser で入手できます。',
    '',
    '以下は Nemo に同梱・リンクされている第三者ソフトウェアとそのライセンスです。',
    ''
  ]
  for (const [id, entry] of [...notices].sort()) {
    lines.push(`## ${id}`, '', `License: ${entry.license}`, '')
    if (entry.text) lines.push('```', entry.text.trimEnd(), '```', '')
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
  fs.writeFileSync(target, `${lines.join('\n')}\n`)
  console.log(`\n[licenses] notice を書き出した: ${target}（${notices.size} 件）`)
}

if (process.argv.includes('--check')) {
  process.exit(unknown.size === 0 ? 0 : 1)
}
