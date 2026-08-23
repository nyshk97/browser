#!/usr/bin/env node
/**
 * Arc のサイドバー（Favorites / ピン留め / フォルダ階層）を Nemo に取り込む（計画 2-2）。
 *
 *   node scripts/arc-import.mjs --dry-run                # 何が入るかだけ見る
 *   node scripts/arc-import.mjs                          # 常用版（stable）へ取り込む
 *   node scripts/arc-import.mjs --channel dev
 *   node scripts/arc-import.mjs --replace                # 既存のピン留めを捨てて Arc の内容にする
 *   node scripts/arc-import.mjs --input <StorableSidebar.json>
 *
 * **冪等**。同じ Arc アイテムは同じ ID で入るので、何度実行しても増えない。
 * 既定は既存のピン留めを残したまま重ねる（`--replace` で全部入れ替え）。
 *
 * 実行前に **Arc を完全に終了する**こと。起動中は `StorableSidebar.json` が
 * 最新でないことがある（起動中なら警告を出す）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mergeIntoPins, parseArcSidebar } from '../src/shared/arc-import.js'
import { PINS_VERSION, normalizePins, readVersioned } from '../src/shared/settings-schema.js'
import { stringify } from '../src/shared/sync-schema.js'
import { assertNotRunning, backupLiveData, timestamp, userDataDirFor } from './lib/config-sync.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const channel = option('channel', 'stable')
if (channel !== 'dev' && channel !== 'stable') {
  console.error(`[arc-import] --channel は dev / stable のみ (${channel})`)
  process.exit(1)
}

const dryRun = flag('dry-run')
const replace = flag('replace')
const inputPath = option(
  'input',
  path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json')
)

const info = (message) => console.log(`[arc-import] ${message}`)

/** 例外を人が読める形にする（cause の連鎖まで出す。原因が消えると調べようがない）。 */
function describe(error) {
  const parts = []
  let current = error
  while (current) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : null
  }
  return parts.join('\n  原因: ')
}

/** Arc が起動しているとサイドバーの JSON が最新でないことがある。 */
function warnIfArcRunning() {
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'command='], { encoding: 'utf8' })
    const running = out.split('\n').some((line) => line.includes('/Arc.app/Contents/MacOS/Arc'))
    if (running) {
      console.warn(
        '[arc-import] 警告: Arc が起動している。StorableSidebar.json が最新でない可能性がある。\n' +
          '  Arc を完全に終了してから実行し直すことを勧める。'
      )
    }
  } catch {
    /* ps が使えなくても続行する */
  }
}

/** ツリーを人が読める形で出す（--dry-run の確認用）。 */
function printTree(nodes, indent = '    ') {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      console.log(`${indent}📁 ${node.title}`)
      printTree(node.children, `${indent}  `)
    } else {
      console.log(`${indent}・${node.title}  ${node.url}`)
    }
  }
}

try {
  warnIfArcRunning()

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  } catch (error) {
    throw new Error(`Arc のサイドバー JSON を読めない: ${inputPath}`, { cause: error })
  }

  const imported = parseArcSidebar(raw)
  info(`読み込み: ${inputPath}`)
  info(
    `スペース ${imported.stats.spaces} / タブ ${imported.stats.tabs} / フォルダ ${imported.stats.folders}` +
      ` / 展開 ${imported.stats.flattened} / 取り込まず ${imported.stats.skipped}`
  )
  info(`Favorites ${imported.favorites.length} 件 / ピン留めの最上位 ${imported.pinned.length} 件`)

  const userDataDir = userDataDirFor(channel)
  const pinsPath = path.join(userDataDir, 'pins.json')

  /** @type {{ favorites: any[], pinned: any[] }} */
  let existing = { favorites: [], pinned: [] }
  if (fs.existsSync(pinsPath)) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(pinsPath, 'utf8'))
    } catch (error) {
      throw new Error('既存の pins.json が読めない', { cause: error })
    }
    // **版を必ず見る**。見ないと、新しい Nemo が書いた形式を古い importer が
    // 「知らないキーは捨てる」正規化にかけて壊し、現在の版として書き戻してしまう。
    const versioned = readVersioned(parsed, PINS_VERSION)
    if (!versioned) {
      throw new Error(
        `既存の pins.json の version がこの importer より新しい / 不正（対応 ${PINS_VERSION}）。\n` +
          `  ${pinsPath}\n` +
          '  Nemo とリポジトリを同じ版に揃えてから実行する。'
      )
    }
    existing = normalizePins(versioned.data)
  }

  const merged = replace ? imported : mergeIntoPins(existing, imported)
  // アプリが読む形（重複 ID・不正 URL・深すぎる入れ子）に必ず落とす
  const normalized = normalizePins(merged)

  if (dryRun) {
    console.log('\n  Favorites:')
    for (const favorite of normalized.favorites) console.log(`    ・${favorite.title}  ${favorite.url}`)
    console.log('\n  ピン留め:')
    printTree(normalized.pinned)
    console.log('')
    info('--dry-run なので何も書いていない')
    process.exit(0)
  }

  assertNotRunning(channel, 'arc-import')

  fs.mkdirSync(userDataDir, { recursive: true })
  if (fs.existsSync(pinsPath)) {
    // バックアップは channel と用途で分ける（config:restore が拾わないように）
    const backup = backupLiveData(userDataDir, timestamp(), { channel, kind: 'arc-import' })
    info(`バックアップ: ${backup.dir}`)
  }

  // 一時ファイル + rename（途中で落ちても半端な JSON を残さない）
  const tmp = `${pinsPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, stringify({ version: PINS_VERSION, data: normalized }))
  fs.renameSync(tmp, pinsPath)

  info(`書き込み: ${pinsPath}`)
  info(`Favorites ${normalized.favorites.length} 件 / ピン留めの最上位 ${normalized.pinned.length} 件`)
  info('Nemo を起動すると反映される。同期リポジトリにも上げるなら mise run config:push')
} catch (error) {
  console.error(`[arc-import] ${describe(error)}`)
  process.exit(1)
}
