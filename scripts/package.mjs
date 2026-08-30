#!/usr/bin/env node
/**
 * パッケージング（`mise run package` / `mise run package:stable`）。
 *
 * 開発起動では露見しない問題（ネイティブモジュールの同梱漏れ・preload の欠落・
 * fuses の緩み）を潰すのが目的なので、**ビルド → パッケージ → 検査**まで一続きにする。
 *
 *   node scripts/package.mjs          dev 版
 *   node scripts/package.mjs stable   常用版
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './lib/harness.mjs'
import { loadReleaseConfig } from './lib/release-config.mjs'

const channel = process.argv[2] === 'stable' ? 'stable' : 'dev'
const config =
  channel === 'stable'
    ? { appId: 'local.nyshk97.nemo', productName: 'Nemo', icon: 'build/icon.icns' }
    : { appId: 'local.nyshk97.nemo.dev', productName: 'Nemo Dev', icon: 'build/icon-dev.icns' }

/**
 * 配布用の署名をするか。
 * 既定では**しない**（ad-hoc 署名だけ）。成果物の中身を検査したいだけのときに
 * keychain も証明書も要らない状態を保つ。`mise run release` が 1 を立てる。
 */
const sign = process.env.NEMO_SIGN === '1'
/** notarize は署名よりさらに重い（数分 + ネットワーク）ので別のフラグで刻む。 */
const notarize = process.env.NEMO_NOTARIZE === '1'

const env = {
  ...process.env,
  NEMO_BUILD_CHANNEL: channel,
  NEMO_APP_ID: config.appId,
  NEMO_PRODUCT_NAME: config.productName,
  CSC_IDENTITY_AUTO_DISCOVERY: sign ? 'true' : 'false'
}

if (sign) {
  // 証明書が複数あるマシンで誤爆しないよう、Team ID で絞った1つを明示的に渡す。
  // **CSC_NAME に "Developer ID Application:" のプレフィックスを付けてはいけない**
  // （electron-builder が「prefix を外せ」と言って止まる）。
  const { identity } = loadReleaseConfig({ notary: notarize })
  env.CSC_NAME = identity.replace(/^Developer ID Application:\s*/, '')
  console.log(`[package] 署名に使う証明書: ${identity}`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', env })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
    child.on('error', reject)
  })
}

console.log(`=== ${channel} 版をパッケージする（${config.productName} / ${config.appId}）`)

await run('pnpm', ['exec', 'electron-vite', 'build'])
// notice は成果物に同梱するので、パッケージのたびに作り直す
await run(process.execPath, ['scripts/license-report.mjs', '--write', 'build/THIRD-PARTY-NOTICES.md'])
const builderArgs = [
  'exec',
  'electron-builder',
  '--mac',
  // アップロードは release.mjs が gh で行う。electron-builder には publish させない
  // （トークンの無い CI でここが落ちる）。
  '--publish',
  'never',
  '--config',
  'electron-builder.yml',
  `--config.appId=${config.appId}`,
  `--config.productName=${config.productName}`,
  `--config.mac.icon=${config.icon}`,
  `--config.directories.output=dist/${channel}`
]

if (channel === 'stable') {
  // 自動更新の feed は**常用版にだけ**埋め込む（`app-update.yml`）。
  // dev に入れると、dev で更新チェックが走った瞬間に常用版のビルドで置き換わる。
  // 埋め込みの有無は check-package.mjs が成果物に対して検査する。
  builderArgs.push(
    '--config.publish.provider=github',
    '--config.publish.owner=nyshk97',
    '--config.publish.repo=browser'
  )
} else {
  // 自動更新用の zip は常用版だけでよい。target を上書きすると yml 側の
  // arch 指定ごと消えるので、arch は CLI で明示する。
  builderArgs.push('--config.mac.target=dmg', '--arm64')
}

await run('pnpm', builderArgs)

const outDir = path.join(projectRoot, 'dist', channel)
const appPath = path.join(outDir, 'mac-arm64', `${config.productName}.app`)
if (!fs.existsSync(appPath)) {
  // arch 付きでないディレクトリ名になることがある
  const alt = path.join(outDir, 'mac', `${config.productName}.app`)
  if (!fs.existsSync(alt)) {
    console.error(`[package] .app が見つからない: ${appPath}`)
    process.exit(1)
  }
}

// 署名しない場合でも **ad-hoc 署名は必要**。
// fuses を書き換えると Electron 本体の linker 署名が無効になり、
// macOS が起動時に SIGKILL する（出力も残らないので原因が分かりにくい）。
// ad-hoc 署名（`-`）は keychain を触らないので、どのマシンでも実行してよい。
if (!sign) {
  const target = fs.existsSync(path.join(outDir, 'mac-arm64', `${config.productName}.app`))
    ? path.join(outDir, 'mac-arm64', `${config.productName}.app`)
    : path.join(outDir, 'mac', `${config.productName}.app`)
  console.log('\n=== ad-hoc 署名（配布用ではない。起動できるようにするため）')
  await run('codesign', ['--force', '--deep', '--sign', '-', target])
}

console.log(`\n=== 成果物を検査する`)
await run(process.execPath, ['scripts/check-package.mjs', channel, config.productName])

console.log(`\n[package] 完成: ${outDir}`)
