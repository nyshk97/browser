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

const channel = process.argv[2] === 'stable' ? 'stable' : 'dev'
const config =
  channel === 'stable'
    ? { appId: 'local.nyshk97.nemo', productName: 'Nemo', icon: 'build/icon.icns' }
    : { appId: 'local.nyshk97.nemo.dev', productName: 'Nemo Dev', icon: 'build/icon-dev.icns' }

const env = {
  ...process.env,
  NEMO_BUILD_CHANNEL: channel,
  NEMO_APP_ID: config.appId,
  NEMO_PRODUCT_NAME: config.productName,
  // 署名・notarize は Phase 2-6 で入れる。ここでは成果物の中身の検査だけしたい。
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.NEMO_SIGN === '1' ? 'true' : 'false'
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
await run('pnpm', [
  'exec',
  'electron-builder',
  '--mac',
  '--config',
  'electron-builder.yml',
  `--config.appId=${config.appId}`,
  `--config.productName=${config.productName}`,
  `--config.mac.icon=${config.icon}`,
  `--config.directories.output=dist/${channel}`
])

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
if (process.env.NEMO_SIGN !== '1') {
  const target = fs.existsSync(path.join(outDir, 'mac-arm64', `${config.productName}.app`))
    ? path.join(outDir, 'mac-arm64', `${config.productName}.app`)
    : path.join(outDir, 'mac', `${config.productName}.app`)
  console.log('\n=== ad-hoc 署名（配布用ではない。起動できるようにするため）')
  await run('codesign', ['--force', '--deep', '--sign', '-', target])
}

console.log(`\n=== 成果物を検査する`)
await run(process.execPath, ['scripts/check-package.mjs', channel, config.productName])

console.log(`\n[package] 完成: ${outDir}`)
