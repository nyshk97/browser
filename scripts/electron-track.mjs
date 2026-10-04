#!/usr/bin/env node
/**
 * Electron の追従（workflow `.github/workflows/electron-track.yml` から使う）。
 *
 *   node scripts/electron-track.mjs plan
 *     サポート中で今より新しい major の最新版を JSON で出す（matrix 用）
 *   node scripts/electron-track.mjs report --results <dir> [--previous <file>] [--out <dir>]
 *     試した結果（<dir>/*.json）から issue の本文とコメントを作る
 *
 * **何も書き換えない**（package.json も lock も触らない）。上げるかどうかは人が決める。
 * EOL は endoflife.date から取る（electronjs.org の公開スケジュールを集約したもの）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assess,
  notifyComment,
  parseCycles,
  previousStateKey,
  renderBody,
  trialTargets
} from './lib/electron-support.mjs'

const [command, ...rest] = process.argv.slice(2)
const option = (name) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

const today = new Date().toISOString().slice(0, 10)

function currentElectronVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return pkg.devDependencies.electron
}

async function fetchCycles() {
  const response = await fetch('https://endoflife.date/api/electron.json', {
    headers: { accept: 'application/json', 'user-agent': 'nemo-electron-track' }
  })
  if (!response.ok) throw new Error(`endoflife.date が ${response.status}`)
  return parseCycles(await response.json())
}

function readResults(dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

if (command === 'plan') {
  const cycles = await fetchCycles()
  const targets = trialTargets(cycles, currentElectronVersion(), today)
  console.log(JSON.stringify(targets))
} else if (command === 'report') {
  const cycles = await fetchCycles()
  const currentVersion = currentElectronVersion()
  const results = readResults(option('--results'))
  const runUrl = process.env['GITHUB_SERVER_URL']
    ? `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    : undefined
  const { body } = renderBody({ currentVersion, cycles, results, today, runUrl })
  const previousFile = option('--previous')
  const previous = previousFile && existsSync(previousFile) ? readFileSync(previousFile, 'utf8') : ''
  const comment = notifyComment(
    assess({ currentVersion, cycles, results, today }),
    previousStateKey(previous)
  )

  const out = option('--out') ?? '.'
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'body.md'), body)
  if (comment) writeFileSync(join(out, 'comment.md'), comment)
  console.log(body)
  if (comment) console.log(`\n[comment] ${comment}`)
} else {
  console.error('使い方: electron-track.mjs plan | report --results <dir> [--previous <file>] [--out <dir>]')
  process.exit(2)
}
