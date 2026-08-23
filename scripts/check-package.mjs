#!/usr/bin/env node
/**
 * パッケージ成果物の検査。
 *
 * 「開発起動では通るがビルドすると壊れている」を捕まえるための検査で、
 * **これを通らない成果物は配らない**。
 *
 * 見るもの:
 * - Electron fuses（`runAsNode` 等が無効になっているか）
 * - `better-sqlite3` のネイティブバイナリが asar の外に出ているか
 * - `electron-chrome-extensions` の preload が同梱されているか
 * - lock された拡張 artifact が同梱されているか
 * - Info.plist の bundle id / 表示名が channel と一致しているか
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './lib/harness.mjs'

const channel = process.argv[2] ?? 'dev'
const productName = process.argv[3] ?? (channel === 'stable' ? 'Nemo' : 'Nemo Dev')
const expectedAppId = channel === 'stable' ? 'local.nyshk97.nemo' : 'local.nyshk97.nemo.dev'

const outDir = path.join(projectRoot, 'dist', channel)
const candidates = [
  path.join(outDir, 'mac-arm64', `${productName}.app`),
  path.join(outDir, 'mac', `${productName}.app`)
]
const appPath = candidates.find((p) => fs.existsSync(p))
if (!appPath) {
  console.error(`[check-package] .app が見つからない:\n  ${candidates.join('\n  ')}`)
  process.exit(1)
}

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const resources = path.join(appPath, 'Contents', 'Resources')
const unpacked = path.join(resources, 'app.asar.unpacked')

/* ---- Info.plist ---- */
const plist = path.join(appPath, 'Contents', 'Info.plist')
const readPlist = (key) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()

check(
  'bundle id が channel と一致する',
  readPlist('CFBundleIdentifier') === expectedAppId,
  readPlist('CFBundleIdentifier')
)
check('表示名が channel と一致する', readPlist('CFBundleName') === productName, readPlist('CFBundleName'))

/* ---- ネイティブモジュール ---- */
const sqliteNode = fs.existsSync(path.join(unpacked, 'node_modules', 'better-sqlite3'))
check('better-sqlite3 が asar の外に出ている', sqliteNode, unpacked)

/* ---- 拡張の preload と artifact ---- */
const asarPath = path.join(resources, 'app.asar')
const { listPackage } = await import('@electron/asar')
const asarList = listPackage(asarPath).join('\n')

check(
  'electron-chrome-extensions の preload が同梱されている',
  /electron-chrome-extensions[/\\]dist[/\\].*preload/.test(asarList),
  asarList
    .split('\n')
    .filter((l) => l.includes('electron-chrome-extensions') && l.includes('preload'))
    .join(', ')
)
// 拡張は asar の外（Resources/）に置く。中に入っていると loadExtension が読めない。
const lockOutside = fs.existsSync(path.join(resources, 'extensions.lock.json'))
const manifestOutside = fs.existsSync(path.join(resources, 'extensions'))
check('lock された拡張 artifact が asar の外にある', lockOutside && manifestOutside, resources)
check(
  '拡張が asar の中に二重に入っていない',
  !asarList.includes('/extensions.lock.json') && !/\/extensions\//.test(asarList)
)
check('ブラウザ UI が同梱されている', /\/out\/renderer\/index\.html/.test(asarList))
check(
  'GPL-3.0 の LICENSE と第三者 notice が同梱されている',
  fs.existsSync(path.join(resources, 'LICENSE')) &&
    fs.existsSync(path.join(resources, 'THIRD-PARTY-NOTICES.md'))
)
check('UI の preload が同梱されている', /\/out\/preload\/ui\.cjs/.test(asarList))

/* ---- fuses ---- */
const { FuseV1Options, getCurrentFuseWire } = await import('@electron/fuses')
const executable = path.join(appPath, 'Contents', 'MacOS', productName)
const expected = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  // 任意のサイトを開くアプリなので file: に余分な権限を与えない
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
}

/**
 * fuse wire の値は '0' / '1' の**文字コード**（48 / 49）で返ってくる。
 * 真偽値や文字列で比較すると全部 false になり、
 * 「false を期待している fuse だけたまたま PASS する」という質の悪い誤判定になる。
 */
function fuseEnabled(value) {
  if (typeof value === 'number') return value === 49 || value === 1
  return value === '1' || value === true
}

const current = await getCurrentFuseWire(executable)
for (const [fuse, want] of Object.entries(expected)) {
  const actual = fuseEnabled(current[fuse])
  check(`fuse ${FuseV1Options[fuse]} = ${want}`, actual === want, `実際: ${actual}`)
}

console.log(failures === 0 ? '\ncheck-package: すべて PASS' : `\ncheck-package: ${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
