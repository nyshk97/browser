import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runtimeMarkerDir = path.join(projectRoot, '.nemo-run')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `promise` とタイムアウトを競争させ、**どちらで決着してもタイマーを片付ける**。
 * `Promise.race([p, sleep(ms)])` だと p が先に決着してもタイマーが残り、
 * その分だけプロセスが終われない（テスト全体が10秒待たされていた）。
 */
async function raceTimeout(promise, ms, timeoutValue = 'timeout') {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 子プロセスがまだ生きているか。 */
export function isChildAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null
}

/**
 * 空きポートを1つ取る（非同期）。
 * 固定ポートだと「既に別のプロセスが使っている」ときに、
 * **そちらを検証して PASS してしまう**（実際に 8787 で踏んだ）。
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    // listen は非同期。listening を待たずに address() を読むと null になる
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM は「居るが自分の権限では触れない」なので生存扱い
    return error.code === 'EPERM'
  }
}

/**
 * 起動中の Nemo を探す。
 *
 * 一次情報はアプリ自身が書く `.nemo-run/<pid>.json`。
 * `ps` のコマンドラインは当てにならない
 * （electron-vite dev は `Electron .` で起動するので `out/main/index.js` を含まない。
 * 実際にこれで検出をすり抜けた）。
 * 念のため ps でも拾うが、そちらは「このリポジトリの Electron 本体プロセス」で判定する。
 */
/**
 * マーカーディレクトリを読む。
 *
 * ここは **stale なマーカーを削除する**ので、対象を厳しく絞る:
 * - ディレクトリ自体が通常のディレクトリであること（symlink なら異常として投げる。
 *   `.nemo-run -> .` のような細工で `package.json` 等を「不正なマーカー」として消せてしまう）
 * - ファイル名が `<pid>.json` であること
 * - 通常ファイルであること（symlink・ディレクトリには触らない）
 * - 削除するのは**ファイル名の PID が死んでいるときだけ**
 *
 * @returns {import('node:fs').Dirent[] | null} ディレクトリが無ければ null
 */
function readMarkerDir() {
  let stat
  try {
    stat = fs.lstatSync(runtimeMarkerDir)
  } catch (error) {
    // 「無い」以外（EACCES・I/O エラー等）を素通りさせると、
    // 起動中の Nemo を見落として稼働中のインスタンスを壊す側に転ぶ
    if (error.code === 'ENOENT') return null
    throw new Error(
      `${runtimeMarkerDir} を読めない (${error.code}). 起動中か判定できないので検証を中止する`
    )
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${runtimeMarkerDir} が symlink になっている。異常なので検証を中止する`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${runtimeMarkerDir} がディレクトリでない。異常なので検証を中止する`)
  }
  return fs.readdirSync(runtimeMarkerDir, { withFileTypes: true })
}

const MARKER_NAME_RE = /^([1-9]\d{0,9})\.json$/

/**
 * 起動中の Nemo を探す。
 *
 * 一次情報はアプリ自身が書く `.nemo-run/<pid>.json`。
 * `ps` のコマンドラインは当てにならない
 * （electron-vite dev は `Electron .` で起動するので `out/main/index.js` を含まない。
 * 実際にこれで検出をすり抜けた）。
 * 念のため ps でも拾うが、そちらは「このリポジトリの Electron 本体プロセス」で判定する。
 *
 * 判定できない異常（マーカーディレクトリが壊れている等）は投げる。
 * 「検出できなかった＝起動していない」に倒すと、稼働中のインスタンスを壊す側に転ぶため。
 */
export function findRunningNemo() {
  /** @type {Map<number, any>} */
  const found = new Map()

  // 1) マーカー（stale は掃除する）
  for (const entry of readMarkerDir() ?? []) {
    const matched = MARKER_NAME_RE.exec(entry.name)
    if (!matched) continue
    // Dirent は lstat 相当。symlink やディレクトリはここで落ちる
    if (!entry.isFile()) continue

    const pid = Number(matched[1])
    const file = path.join(runtimeMarkerDir, entry.name)

    if (!isAlive(pid)) {
      fs.rmSync(file, { force: true })
      continue
    }

    let info = null
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      info = null
    }
    // 中身が壊れていても PID が生きている以上「起動中」として扱う（消さない）
    found.set(
      pid,
      info && info.pid === pid
        ? { source: 'marker', ...info }
        : { source: 'marker', pid, note: 'マーカーの中身が読めない' }
    )
  }

  // 2) ps でのフォールバック。ヘルパープロセスは除く
  try {
    const out = execFileSync('/bin/ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    const electronPrefix = path.join(projectRoot, 'node_modules')
    for (const line of out.split('\n')) {
      if (!line.includes(electronPrefix)) continue
      if (!line.includes('/MacOS/Electron')) continue
      if (line.includes('Electron Helper')) continue
      if (line.includes(' grep ')) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      if (!Number.isInteger(pid) || found.has(pid)) continue
      found.set(pid, { source: 'ps', pid, command: line.trim() })
    }
  } catch {
    /* ps が使えなくてもマーカーで拾えていればよい */
  }

  return [...found.values()]
}

export function assertNemoNotRunning(what) {
  const running = findRunningNemo()
  if (running.length === 0) return
  const detail = running
    .map((r) => `    pid ${r.pid} (${r.source})${r.userData ? ` userData=${r.userData}` : ''}`)
    .join('\n')
  throw new Error(
    `${what} は Nemo が起動していると実行できない（拡張や lock を触るため）。\n` +
      `${detail}\n` +
      '  Nemo を終了してからもう一度実行する。'
  )
}

/**
 * 子プロセスを止めて、**終了を待つ**。
 * 固定時間の sleep で次へ進むと、同じポートを掴んだままの旧プロセスに
 * 再接続したり、まだ使っている一時ディレクトリを消したりする。
 */
export async function stopChild(child, { timeoutMs = 10000, killTimeoutMs = 5000 } = {}) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve('exited'))
    child.once('close', () => resolve('exited'))
  })

  try {
    child.kill('SIGTERM')
  } catch {
    return // すでに死んでいる
  }

  if ((await raceTimeout(exited, timeoutMs)) === 'exited') return

  try {
    child.kill('SIGKILL')
  } catch {
    return
  }

  // SIGKILL しても確認できないなら、生き残りとして**投げる**。
  // ここで黙って進むと、まだ使われている一時ディレクトリを消したり
  // 同じポートを掴んだままの旧プロセスに再接続したりする。
  if ((await raceTimeout(exited, killTimeoutMs)) !== 'exited') {
    throw new Error(
      `子プロセス (pid ${child.pid}) が SIGKILL 後も終了を確認できない。` +
        '後片付けを中止する（手で終了させて一時ディレクトリを消す）'
    )
  }
}

/** 全部止める。1つでも確認できなければまとめて投げる。 */
export async function stopChildren(children, options) {
  const results = await Promise.allSettled(children.map((child) => stopChild(child, options)))
  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    throw new Error(failures.map((r) => r.reason?.message ?? String(r.reason)).join('\n'))
  }
}

/** HTTP エンドポイントが「自分が起動した相手」として応答するまで待つ。 */
export async function waitForHttp(url, { timeoutMs = 30000, child = null, check = null } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`起動したプロセスが終了した (exit ${child.exitCode}): ${url}`)
    }
    try {
      const res = await fetch(url)
      if (res.ok) {
        if (!check) return true
        if (await check(res)) return true
      }
    } catch {
      /* まだ起動していない */
    }
    await sleep(300)
  }
  throw new Error(`起動を待てなかった: ${url}`)
}
