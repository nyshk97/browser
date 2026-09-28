import { app } from 'electron'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'
import { getSettings } from '../store/settings.js'
import { AgentConnection, allConnections } from './connection.js'

/**
 * Claude Code のブリッジを待ち受ける unix socket（`<userData>/agent.sock`）。
 *
 * - **TCP は開かない**（ブラウザ上のページから localhost へ届く面を作らない）
 * - 置き場所のディレクトリは 0700・自分の所有・symlink でないことを毎回確かめる。socket は 0600
 * - 古い socket は「socket で、繋ぐと ECONNREFUSED」のときだけ消す（生きている別の Nemo を奪わない）
 * - dev と常用は userData が別なので socket も分かれる。自走検証は `NEMO_AGENT_SOCKET`（未パッケージのみ）で短いパスへ
 *   （sun_path は 104 バイトまで。使い捨ての userData は長くなる）
 */

let server: net.Server | null = null
let starting = false

export function agentSocketPath(): string {
  const override = process.env['NEMO_AGENT_SOCKET']
  if (override && !app.isPackaged) return path.resolve(override)
  return userDataPath('agent.sock')
}

function directoryIsPrivate(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir)
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** 古い socket か。**ECONNREFUSED のときだけ** stale（それ以外のエラーは使用中かもしれないので消さない）。 */
function probe(target: string): Promise<'alive' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = net.createConnection(target)
    socket.once('connect', () => {
      socket.destroy()
      resolve('alive')
    })
    socket.once('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown')
    )
  })
}

export async function startAgentServer(): Promise<void> {
  if (server || starting) return
  starting = true
  try {
    const target = agentSocketPath()
    const dir = path.dirname(target)
    if (!directoryIsPrivate(dir)) {
      log('agent.socket_refused', { reason: 'insecure_directory' })
      return
    }
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target)
      if (!stat.isSocket()) {
        log('agent.socket_refused', { reason: 'not_a_socket' })
        return
      }
      const status = await probe(target)
      if (status !== 'stale') {
        log('agent.socket_refused', { reason: status === 'alive' ? 'in_use' : 'probe_failed' })
        return
      }
      fs.unlinkSync(target)
    }
    const created = net.createServer((socket) => {
      // 設定が OFF に戻っていたら受けない
      if (!server) {
        socket.destroy()
        return
      }
      new AgentConnection(socket)
    })
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject)
      created.listen(target, () => {
        created.off('error', reject)
        resolve()
      })
    })
    fs.chmodSync(target, 0o600)
    // 待っている間に設定が OFF になっていたら開けたままにしない
    if (!getSettings().agentEnabled) {
      created.close()
      if (fs.existsSync(target)) fs.unlinkSync(target)
      log('agent.listen_cancelled', {})
      return
    }
    server = created
    created.on('error', (error) => logError('agent.server_error', error, {}))
    log('agent.listening', {})
  } catch (error) {
    logError('agent.listen_failed', error, {})
  } finally {
    starting = false
  }
}

/** 止める。**張ったままの接続も切り、エージェント窓を閉じる**（OFF にしたのに操作が続く、を作らない）。 */
export function stopAgentServer(): void {
  const current = server
  server = null
  for (const conn of allConnections()) conn.dispose('server_stopped')
  if (!current) return
  current.close()
  try {
    const target = agentSocketPath()
    if (fs.existsSync(target) && fs.lstatSync(target).isSocket()) fs.unlinkSync(target)
  } catch (error) {
    logError('agent.socket_unlink_failed', error, {})
  }
  log('agent.stopped', {})
}

export function isAgentServerRunning(): boolean {
  return server !== null
}
