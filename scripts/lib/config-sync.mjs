/**
 * 設定同期の実体（計画 2-1）。
 *
 * 境界（計画で先に決めたとおり）:
 * - **常用データ** = `Application Support/<Nemo|Nemo-dev>/` の JSON。アプリが読み書きするのはここだけ
 * - **staging** = `nemo-config` の git 作業コピー。アプリは絶対に読まない
 * - **pull** … staging を更新 → 競合なし・スキーマ正常を検証 → 常用データへ原子的に import
 * - **push** … 常用データの snapshot を clean な staging へ export → commit → push
 * - **競合中は import / push を止める**（git で解決するまでアプリは触らない）
 *
 * git 操作以外は素の関数にして `scripts/config-sync.test.mjs` から直接テストする。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REFERENCE_FILES,
  SYNCED_FILES,
  SYNC_SCHEMA_VERSION,
  stringify,
  validateManifest,
  validateSyncedFile
} from '../../src/shared/sync-schema.js'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 既定の同期リポジトリ。`NEMO_CONFIG_REPO` か `sync.json` で上書きできる。 */
export const DEFAULT_REPO = 'git@github.com:nyshk97/nemo-config.git'

/* ------------------------------------------------------------------ *
 * パス
 * ------------------------------------------------------------------ */

/**
 * staging の置き場。**常用データディレクトリの外**に置く。
 * 中に置くと、コンフリクトマーカー入りの JSON がアプリの目に入りうる。
 */
export function syncHome() {
  return process.env['NEMO_SYNC_HOME']
    ? path.resolve(process.env['NEMO_SYNC_HOME'])
    : path.join(os.homedir(), 'Library', 'Application Support', 'NemoConfigSync')
}

export function stagingDir() {
  return path.join(syncHome(), 'repo')
}

export function backupsDir() {
  return path.join(syncHome(), 'backups')
}

/** 同期リポジトリの URL などの手元の設定（public repo には置かない）。 */
export function localConfigPath() {
  return path.join(syncHome(), 'sync.json')
}

/** `dev` / `stable` の常用データディレクトリ。`NEMO_USER_DATA_DIR` で上書きできる。 */
export function userDataDirFor(channel) {
  if (process.env['NEMO_USER_DATA_DIR']) return path.resolve(process.env['NEMO_USER_DATA_DIR'])
  const name = channel === 'dev' ? 'Nemo-dev' : 'Nemo'
  return path.join(os.homedir(), 'Library', 'Application Support', name)
}

export function readLocalConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(localConfigPath(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function writeLocalConfig(config) {
  fs.mkdirSync(syncHome(), { recursive: true })
  fs.writeFileSync(localConfigPath(), stringify(config))
}

export function repoUrl() {
  return process.env['NEMO_CONFIG_REPO'] || readLocalConfig().repo || DEFAULT_REPO
}

/* ------------------------------------------------------------------ *
 * git
 * ------------------------------------------------------------------ */

export function git(args, { cwd = stagingDir(), allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (allowFail) return null
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(`git ${args.join(' ')} が失敗した\n${stderr || error.message}`, { cause: error })
  }
}

export function stagingExists() {
  return fs.existsSync(path.join(stagingDir(), '.git'))
}

export function assertStaging() {
  if (!stagingExists()) {
    throw new Error(
      `同期リポジトリの作業コピーが無い（${stagingDir()}）。\n  先に mise run config:init を実行する`
    )
  }
}

/** 未解決のコンフリクトが残っているか（`git status` の unmerged path）。 */
export function unmergedPaths() {
  const out = git(['status', '--porcelain=v1'], { allowFail: true }) ?? ''
  return out
    .split('\n')
    .filter((line) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(line))
    .map((line) => line.slice(3))
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) ?? 'main'
}

export function hasRemote() {
  return Boolean(git(['remote', 'get-url', 'origin'], { allowFail: true }))
}

/** origin との進み / 遅れ。remote 追跡が無ければ null。 */
export function aheadBehind() {
  const branch = currentBranch()
  const upstream = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { allowFail: true })
  if (!upstream) return null
  const out = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { allowFail: true })
  if (!out) return null
  const [behind, ahead] = out.split(/\s+/).map(Number)
  return { upstream, ahead, behind }
}

/* ------------------------------------------------------------------ *
 * 起動中の Nemo 検出
 *
 * import は常用データを置き換えるので、**アプリが動いている間は絶対にやらない**。
 * 動いていると JsonStore がメモリ上の古い値を持っていて、次の保存で上書きされる
 * （＝ import が黙って無かったことになる）。
 * ------------------------------------------------------------------ */

const PRODUCT_NAME = { dev: 'Nemo Dev', stable: 'Nemo' }

/**
 * その channel の Nemo が動いているか。
 * パッケージ版は `.app/Contents/MacOS/<名前>`、開発起動は `.nemo-run/<pid>.json` で見る。
 */
export function findRunningForChannel(channel) {
  const found = []
  const product = PRODUCT_NAME[channel] ?? PRODUCT_NAME.stable
  const needle = `${product}.app/Contents/MacOS/${product}`
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (!line.includes(needle)) continue
      if (line.includes('Helper')) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid)) found.push({ pid, source: 'ps', command: line.trim() })
    }
  } catch {
    /* ps が使えなくてもマーカー側で拾えることがある */
  }

  // 開発起動（未パッケージ）は Electron 本体として動くのでコマンド名では拾えない。
  // アプリ自身が書くマーカーの userData を見る。
  const markerDir = path.join(projectRoot, '.nemo-run')
  let entries
  try {
    entries = fs.readdirSync(markerDir)
  } catch {
    entries = []
  }
  const target = path.resolve(userDataDirFor(channel))
  for (const name of entries) {
    if (!/^\d+\.json$/.test(name)) continue
    let info
    try {
      info = JSON.parse(fs.readFileSync(path.join(markerDir, name), 'utf8'))
    } catch {
      continue
    }
    if (!info || typeof info.pid !== 'number') continue
    try {
      process.kill(info.pid, 0)
    } catch (error) {
      if (error.code !== 'EPERM') continue
    }
    if (path.resolve(String(info.userData ?? '')) !== target) continue
    if (found.some((item) => item.pid === info.pid)) continue
    found.push({ pid: info.pid, source: 'marker', userData: info.userData })
  }
  return found
}

export function assertNotRunning(channel, what) {
  const running = findRunningForChannel(channel)
  if (running.length === 0) return
  const detail = running.map((item) => `    pid ${item.pid} (${item.source})`).join('\n')
  throw new Error(
    `${what} は ${PRODUCT_NAME[channel] ?? channel} が起動していると実行できない。\n` +
      `${detail}\n  Nemo を終了してからもう一度実行する（起動中だと import が次の保存で上書きされる）。`
  )
}

/* ------------------------------------------------------------------ *
 * export / import
 * ------------------------------------------------------------------ */

/** 常用データから staging に書く内容を組み立てる（ファイルには書かない）。 */
export function buildSnapshot(userDataDir, { appVersion = '', lockPath = null } = {}) {
  /** @type {{ name: string, text: string, missing?: boolean }[]} */
  const files = []
  for (const spec of SYNCED_FILES) {
    const source = path.join(userDataDir, spec.name)
    let text
    try {
      text = fs.readFileSync(source, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // まだ一度も書かれていないファイルは「既定値」として書き出す。
      // 欠けたまま push すると、2台目が pull しても何も揃わない
      files.push({
        name: spec.name,
        text: stringify({ version: spec.version, data: spec.normalize(undefined) }),
        missing: true
      })
      continue
    }
    // 手で壊れた JSON をそのまま push しない（正規化を必ず通す）
    const validated = validateSyncedFile(spec, text)
    files.push({ name: spec.name, text: stringify(validated) })
  }

  for (const ref of REFERENCE_FILES) {
    const source = lockPath ?? path.join(projectRoot, ref.name)
    try {
      files.push({ name: ref.name, text: fs.readFileSync(source, 'utf8') })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  files.push({
    name: 'manifest.json',
    text: stringify({
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      appVersion
    })
  })
  return files
}

/**
 * staging を読んで検証する。**import の前に必ず通す**。
 * 1件でも壊れていたら投げる（部分的に入れると常用データが中途半端になる）。
 */
export function validateStaging(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    throw new Error('staging の manifest.json が読めない', { cause: error })
  }

  const payloads = []
  for (const spec of SYNCED_FILES) {
    const file = path.join(dir, spec.name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`staging に ${spec.name} が無い。push した端末で mise run config:push を実行する`, {
          cause: error
        })
      }
      throw error
    }
    payloads.push({ spec, validated: validateSyncedFile(spec, text) })
  }
  return { manifest, payloads }
}

/** 常用データの現物を退避する。戻すのは `restoreBackup`。 */
export function backupLiveData(userDataDir, stamp) {
  const dir = path.join(backupsDir(), stamp)
  fs.mkdirSync(dir, { recursive: true })
  const saved = []
  for (const spec of SYNCED_FILES) {
    const source = path.join(userDataDir, spec.name)
    if (!fs.existsSync(source)) {
      // 「元は無かった」ことも記録する。戻すときに消す必要がある
      saved.push({ name: spec.name, existed: false })
      continue
    }
    fs.copyFileSync(source, path.join(dir, spec.name))
    saved.push({ name: spec.name, existed: true })
  }
  fs.writeFileSync(path.join(dir, 'backup.json'), stringify({ userDataDir, savedAt: stamp, files: saved }))
  return { dir, files: saved }
}

/** バックアップを常用データへ戻す。 */
export function restoreBackup(backupDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8'))
  for (const entry of meta.files) {
    const target = path.join(meta.userDataDir, entry.name)
    if (entry.existed) fs.copyFileSync(path.join(backupDir, entry.name), target)
    else fs.rmSync(target, { force: true })
  }
  return meta
}

/** 直近のバックアップ（新しい順）。 */
export function listBackups() {
  try {
    return fs
      .readdirSync(backupsDir())
      .filter((name) => fs.existsSync(path.join(backupsDir(), name, 'backup.json')))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * 検証済みの内容を常用データへ**原子的に**書く。
 * 一時ファイル + rename なので、途中で落ちても半端な JSON は残らない。
 */
export function importPayloads(userDataDir, payloads) {
  fs.mkdirSync(userDataDir, { recursive: true })
  for (const { spec, validated } of payloads) {
    const target = path.join(userDataDir, spec.name)
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, stringify(validated))
    fs.renameSync(tmp, target)
  }
}

/** 常用データと staging の差分（内容が違うファイル名）。 */
export function diffAgainstStaging(userDataDir, dir) {
  const differs = []
  for (const spec of SYNCED_FILES) {
    const live = readOrNull(path.join(userDataDir, spec.name))
    const staged = readOrNull(path.join(dir, spec.name))
    if (live === null && staged === null) continue
    if (live === null || staged === null) {
      differs.push(spec.name)
      continue
    }
    // 空白の違いで差分を出さないよう、両方とも正規化してから比べる
    if (safeNormalized(spec, live) !== safeNormalized(spec, staged)) differs.push(spec.name)
  }
  return differs
}

function safeNormalized(spec, text) {
  try {
    return stringify(validateSyncedFile(spec, text))
  } catch {
    return `INVALID:${text}`
  }
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}
