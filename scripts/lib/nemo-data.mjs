// @ts-check
/**
 * 常用データディレクトリを触るスクリプト（`arc-import` など）の共通部品。
 *
 * 元は設定同期（config-sync）の一部だった。同期はブックマークのセーブスロットに
 * 置き換わって廃止したが、**「起動中の Nemo を止める」「書き換える前に控えを取る」は
 * 同期に固有の話ではない**ので、ここへ移して残した。
 *
 * バックアップの置き場だけは `NemoConfigSync/` のまま。名前は config-sync 時代の名残だが、
 * 変えると**過去に取ったバックアップが行方不明になる**（戻したいときに一番困る）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PRODUCT_NAME = { dev: 'Nemo Dev', stable: 'Nemo' }

/** JSON を書くときの形（末尾に改行）。 */
export function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** ファイル名に使える時刻。 */
export function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

/** `dev` / `stable` の常用データディレクトリ。`NEMO_USER_DATA_DIR` で上書きできる。 */
export function userDataDirFor(channel) {
  if (process.env['NEMO_USER_DATA_DIR']) return path.resolve(process.env['NEMO_USER_DATA_DIR'])
  const name = channel === 'dev' ? 'Nemo-dev' : 'Nemo'
  return path.join(os.homedir(), 'Library', 'Application Support', name)
}

/**
 * バックアップ置き場。
 *
 * **channel と用途で必ず分ける**。1か所に混ぜると、戻す操作が別 channel
 * （＝起動中かもしれない常用版）や別用途のバックアップを拾って上書きしうる。
 */
export function backupsDir(channel = null) {
  const base = process.env['NEMO_SYNC_HOME']
    ? path.resolve(process.env['NEMO_SYNC_HOME'])
    : path.join(os.homedir(), 'Library', 'Application Support', 'NemoConfigSync')
  const dir = path.join(base, 'backups')
  return channel ? path.join(dir, channel) : dir
}

/**
 * `ps` の1行が `--user-data-dir=<target>` を**引数まるごと**として含むか。
 *
 * 単純な `includes` だと **`.../Nemo` が `.../Nemo-dev` に前方一致する**ので、
 * Nemo Dev を開いているだけで常用側の操作が「起動中」と誤判定される。
 * パスの直後が空白か行末であることまで見る。
 *
 * @param {string} line
 * @param {string} target 解決済みのデータディレクトリ
 */
export function matchesUserDataArg(line, target) {
  const needle = `--user-data-dir=${target}`
  for (let index = line.indexOf(needle); index !== -1; index = line.indexOf(needle, index + 1)) {
    const after = line[index + needle.length]
    // 行末 / 空白なら、その引数はちょうど target を指している
    if (after === undefined || after === ' ' || after === '\t' || after === '\n') return true
  }
  return false
}

/**
 * その channel の Nemo が動いているか。
 * パッケージ版は `.app/Contents/MacOS/<名前>`、開発起動は `.nemo-run/<pid>.json` で見る。
 */
export function findRunningForChannel(channel) {
  const found = []
  const product = PRODUCT_NAME[channel] ?? PRODUCT_NAME.stable
  const needle = `${product}.app/Contents/MacOS/${product}`
  const target = path.resolve(userDataDirFor(channel))
  /**
   * 常用のデータディレクトリを見ているか。
   *
   * `NEMO_USER_DATA_DIR` で別のディレクトリを指しているときは、
   * **同じ名前のアプリが動いていても関係ない**（別プロファイル）。
   * 名前だけで判定すると、常用の Nemo を開いているだけで
   * 使い捨てディレクトリ相手の操作まで止まる（テストが実アプリの起動状態で落ちた）。
   */
  const usingDefaultDir = !process.env['NEMO_USER_DATA_DIR']
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (!Number.isInteger(pid)) continue

      // ヘルパープロセスは `--user-data-dir=<パス>` を持つので、狙ったプロファイルだけ拾える。
      // **前方一致では駄目**（`.../Nemo` は `.../Nemo-dev` にも一致する）
      if (matchesUserDataArg(line, target)) {
        if (!found.some((item) => item.pid === pid)) {
          found.push({ pid, source: 'ps', command: line.trim() })
        }
        continue
      }
      // main プロセスはパスを持たないので名前で拾う。
      // 既定のディレクトリを見ているときだけ有効な手掛かり。
      if (!usingDefaultDir) continue
      if (!line.includes(needle)) continue
      if (line.includes('Helper')) continue
      if (!found.some((item) => item.pid === pid)) {
        found.push({ pid, source: 'ps', command: line.trim() })
      }
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

/** 起動中の Nemo が居る間は書き換えない（import が次の保存で上書きされる）。 */
export function assertNotRunning(channel, what) {
  const running = findRunningForChannel(channel)
  if (running.length === 0) return
  const detail = running.map((item) => `    pid ${item.pid} (${item.source})`).join('\n')
  throw new Error(
    `${what} は ${PRODUCT_NAME[channel] ?? channel} が起動していると実行できない。\n` +
      `${detail}\n  Nemo を終了してからもう一度実行する（起動中だと書き込みが次の保存で上書きされる）。`
  )
}

/**
 * 常用データの控えを取る。
 *
 * **対象のファイル名は引数で受ける**（呼び出し側が「何を触るか」を知っているので、
 * ここに固定のリストを置くと使い回せない）。
 *
 * @param {string} userDataDir
 * @param {string} stamp
 * @param {{ channel: string, kind: string, files: string[] }} options
 */
export function backupLiveData(userDataDir, stamp, { channel, kind, files }) {
  if (!channel || !kind) throw new Error('backupLiveData には channel と kind が要る')
  if (!Array.isArray(files) || files.length === 0) throw new Error('backupLiveData には files が要る')
  const dir = path.join(backupsDir(channel), `${kind}-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const saved = []
  for (const name of files) {
    const source = path.join(userDataDir, name)
    if (!fs.existsSync(source)) {
      // 「元は無かった」ことも記録する。戻すときに消す必要がある
      saved.push({ name, existed: false })
      continue
    }
    fs.copyFileSync(source, path.join(dir, name))
    saved.push({ name, existed: true })
  }
  fs.writeFileSync(
    path.join(dir, 'backup.json'),
    stringify({ userDataDir, channel, kind, savedAt: stamp, files: saved })
  )
  return { dir, files: saved, stamp }
}

/**
 * 控えから戻す。**戻し先は必ず突き合わせる**（`backup.json` の値を鵜呑みにしない）。
 *
 * CLI からの入口は無い（`config:restore` はセーブスロットへの一本化で廃止した）。
 * Arc 取り込みをやり直したいときに `node -e` から呼ぶための最後の手段として残してある
 * —— 控えを取る側だけあって戻す側が無いと、事故ったときにファイルを手で並べ替えることになる。
 */
export function restoreBackup(backupDir, expect = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8'))
  if (expect.expectedChannel && meta.channel !== expect.expectedChannel) {
    throw new Error(
      `このバックアップは channel が違う（バックアップ: ${meta.channel ?? '不明'} / 指定: ${expect.expectedChannel}）`
    )
  }
  if (
    expect.expectedUserDataDir &&
    path.resolve(String(meta.userDataDir ?? '')) !== path.resolve(expect.expectedUserDataDir)
  ) {
    throw new Error(
      `このバックアップの戻し先が想定と違う\n  バックアップ: ${meta.userDataDir}\n  指定       : ${expect.expectedUserDataDir}`
    )
  }
  for (const entry of meta.files) {
    const target = path.join(meta.userDataDir, entry.name)
    if (entry.existed) fs.copyFileSync(path.join(backupDir, entry.name), target)
    else fs.rmSync(target, { force: true })
  }
  return meta
}

/** ある channel / 用途の控えを新しい順に並べる。 */
export function listBackups(channel, kind = null) {
  const dir = backupsDir(channel)
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => (kind ? name.startsWith(`${kind}-`) : true))
      .filter((name) => fs.existsSync(path.join(dir, name, 'backup.json')))
      .sort()
      .reverse()
  } catch {
    return []
  }
}
