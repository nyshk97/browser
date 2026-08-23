import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeDetail } from '../shared/log-redact.js'
import { channel, userDataPath } from './paths.js'

export { redactUrl } from '../shared/log-redact.js'

/**
 * 診断ログ。
 *
 * - 拡張のロード / 更新・タブのクラッシュ・同期・自動更新は UI だけでは原因を追えないので、
 *   **安定したイベント名**でファイルに残す
 * - dev 版 / 常用版はデータディレクトリごと分かれるので、ログも自然に分かれる
 * - セッション単位でファイルを作り、古いものから消す（ローテーション）
 * - **載せてよい値への変換は `sanitizeDetail` が強制する**（書く側の注意に頼らない）
 */

/** 残すセッション数。 */
const KEEP_SESSIONS = 20

let stream: fs.WriteStream | null = null
let logFilePath: string | null = null

/**
 * ログファイルを開く前に出た行。
 *
 * `openLogFile()` は `app.whenReady` の後にしか呼べないが、
 * **その前にも記録したいことがある**（外部アプリから渡された URL の queue など。
 * 未起動から開かれたときの経路は必ず ready より前に始まる）。
 * 溜めておいてファイルが開いた時点で書き出す。溜めっぱなしにならないよう上限を置く。
 */
const preOpen: string[] = []
const MAX_PRE_OPEN = 200

/** ログファイルを開く。app.whenReady の後に1回だけ呼ぶ。 */
export function openLogFile(): string | null {
  if (stream) return logFilePath
  try {
    const dir = userDataPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    rotate(dir)
    // ファイル名はソートで時系列になる形にする
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    logFilePath = path.join(dir, `${channel}-${stamp}-${process.pid}.log`)
    stream = fs.createWriteStream(logFilePath, { flags: 'a' })
    // ファイルを開く前に出た行を先に書き出す（時系列が崩れないよう log.opened より前）
    const queued = preOpen.splice(0, preOpen.length)
    for (const line of queued) stream.write(`${line}\n`)
    log('log.opened', { channel, version: app.getVersion(), replayed: queued.length })
    return logFilePath
  } catch (error) {
    // ログが書けないこと自体でアプリを止めない（標準出力には出る）
    console.error('[nemo] log.open_failed', error)
    return null
  }
}

function rotate(dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${channel}-`) && name.endsWith('.log'))
    .sort()
  for (const name of files.slice(0, Math.max(files.length - KEEP_SESSIONS + 1, 0))) {
    fs.rmSync(path.join(dir, name), { force: true })
  }
}

function write(level: 'info' | 'error', event: string, detail: Record<string, unknown>): void {
  const safe = sanitizeDetail(detail)
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...safe })
  if (level === 'error') console.error(`[nemo] ${line}`)
  else console.log(`[nemo] ${line}`)
  if (stream) {
    stream.write(`${line}\n`)
  } else if (preOpen.length < MAX_PRE_OPEN) {
    preOpen.push(line)
  }
}

export function log(event: string, detail: Record<string, unknown> = {}): void {
  write('info', event, detail)
}

export function logError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error)
  write('error', event, { ...detail, error: message })
}

export function closeLogFile(): void {
  stream?.end()
  stream = null
}

export function currentLogFile(): string | null {
  return logFilePath
}
