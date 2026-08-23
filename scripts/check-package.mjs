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
 * - Info.plist の bundle id / 表示名 / バージョンが期待どおりか
 * - 更新 feed（app-update.yml）が **stable にだけ**入っているか
 * - 配布用の署名をしたときは、署名と公証が実際に有効か
 */
import { execFileSync, spawnSync } from 'node:child_process'
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

// バージョンは package.json が唯一の源。2箇所に手書きが増えると必ずズレる。
const expectedVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
check(
  'CFBundleShortVersionString が package.json と一致する',
  readPlist('CFBundleShortVersionString') === expectedVersion,
  readPlist('CFBundleShortVersionString')
)
check(
  'CFBundleVersion が package.json と一致する',
  readPlist('CFBundleVersion') === expectedVersion,
  readPlist('CFBundleVersion')
)

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

/* ---- 更新 feed ---- */
/**
 * **dev 版に app-update.yml があってはならない**。
 * 入っていると dev で更新チェックが走った瞬間に常用版のビルドで置き換わる。
 * updater.ts 側の `isDevChannel` ガードと合わせて二重防御にしている。
 */
const updateFeed = path.join(resources, 'app-update.yml')
if (channel === 'stable') {
  const feed = fs.existsSync(updateFeed) ? fs.readFileSync(updateFeed, 'utf8') : ''
  check('常用版に更新 feed（app-update.yml）が入っている', feed.length > 0)
  check(
    '更新 feed が GitHub の nyshk97/nemo を指している',
    /provider:\s*github/.test(feed) && /owner:\s*nyshk97/.test(feed) && /repo:\s*nemo/.test(feed),
    feed.replace(/\n/g, ' ').trim()
  )
} else {
  check('dev 版に更新 feed（app-update.yml）が入っていない', !fs.existsSync(updateFeed))
}

/* ---- 署名・公証（配布用にビルドしたときだけ） ---- */
if (process.env['NEMO_SIGN'] === '1') {
  const codesign = (args) => {
    try {
      execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: '' }
    } catch (error) {
      return { ok: false, out: String(error.stderr ?? error.message).trim() }
    }
  }

  const verified = codesign(['--verify', '--strict', '--deep', appPath])
  check('配布用の署名が壊れていない', verified.ok, verified.out)

  // `codesign -dvv` は **stderr** に出す。stdout だけ読むと常に空になり、
  // 「Authority が見つからない」という誤った FAIL になる。
  const shown = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' })
  const info = `${shown.stdout ?? ''}${shown.stderr ?? ''}`
  // ad-hoc 署名（`Signature=adhoc`）のまま配ると Gatekeeper に弾かれる
  check('ad-hoc 署名ではない', !/Signature=adhoc/.test(info))
  check('Developer ID で署名されている', /Authority=Developer ID Application/.test(info))

  if (process.env['NEMO_NOTARIZE'] === '1') {
    try {
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      check('公証のチケットが staple されている', true)
    } catch (error) {
      check('公証のチケットが staple されている', false, String(error.stderr ?? error.message).trim())
    }
  }
}

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
