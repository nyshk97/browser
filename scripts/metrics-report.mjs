#!/usr/bin/env node
/**
 * 診断ログのメモリ・CPU（`metrics.sample`）を日別 × チャンネル別に集計して出す。
 *
 *   mise run metrics:report                 常用版と dev 版の両方を読む
 *   node scripts/metrics-report.mjs --dir <logs>   任意のログディレクトリ（複数可）
 *   node scripts/metrics-report.mjs --json         機械可読（セッション別の行も含む）
 *
 * 保持は 20 セッションぶんだけなので、**先頭に読めた期間・セッション数・サンプル数を必ず出す**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregate, channelOfLogFile, parseLogText, renderTable } from './lib/metrics-aggregate.mjs'

const args = process.argv.slice(2)
const dirs = []
let json = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir') {
    const value = args[i + 1]
    if (!value || value.startsWith('--')) {
      console.error('--dir にはディレクトリを渡す')
      process.exit(2)
    }
    dirs.push(value)
    i += 1
  } else if (args[i] === '--json') json = true
  else {
    console.error(`不明な引数: ${args[i]}`)
    process.exit(2)
  }
}
if (dirs.length === 0) {
  const base = path.join(os.homedir(), 'Library', 'Application Support')
  dirs.push(path.join(base, 'Nemo', 'logs'), path.join(base, 'Nemo-dev', 'logs'))
}

const sessions = []
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue
  for (const name of fs.readdirSync(dir).sort()) {
    const channel = channelOfLogFile(name)
    if (!channel) continue
    sessions.push({
      channel,
      session: name,
      lines: parseLogText(fs.readFileSync(path.join(dir, name), 'utf8'))
    })
  }
}

const result = aggregate(sessions)
if (json) console.log(JSON.stringify(result, null, 2))
else console.log(renderTable(result))
