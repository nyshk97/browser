#!/usr/bin/env node
/**
 * Electron の追従（workflow `.github/workflows/electron-track.yml` から使う）。
 *
 *   node scripts/electron-track.mjs plan
 *     サポート中で今より新しい major の最新版と、基準にする今の版を JSON で出す（matrix 用）
 *   node scripts/electron-track.mjs result --major <n> --version <v> --baseline <bool> --smoke <outcome> --verify <outcome> \
 *     --smoke-log <file> --verify-log <file> --out <file>
 *     1 つの版を試した結果（落ちた検査の名前つき）を JSON にする
 *   node scripts/electron-track.mjs report --results <dir> [--previous <file>] [--out <dir>]
 *     試した結果（<dir>/*.json）から issue の本文とコメントを作る
 *
 * **何も書き換えない**（package.json も lock も触らない）。上げるかどうかは人が決める。
 * EOL は endoflife.date から取る（electronjs.org の公開スケジュールを集約したもの）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assess,
  failuresFromLog,
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
} else if (command === 'result') {
  // 1 つの版を試した結果を JSON にする（try ジョブの最後に呼ぶ）
  const log = (name) => {
    const file = option(name)
    return file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const result = {
    major: Number(option('--major')),
    version: option('--version'),
    baseline: option('--baseline') === 'true',
    smoke: option('--smoke') || 'skipped',
    verify: option('--verify') || 'skipped',
    smokeFailures: failuresFromLog(log('--smoke-log')),
    verifyFailures: failuresFromLog(log('--verify-log'))
  }
  const out = option('--out')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(result)}\n`)
  console.log(JSON.stringify(result, null, 2))
} else {
  console.error(
    '使い方: electron-track.mjs plan | result ... | report --results <dir> [--previous <file>] [--out <dir>]'
  )
  process.exit(2)
}
