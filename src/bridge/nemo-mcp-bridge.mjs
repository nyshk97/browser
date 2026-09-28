#!/usr/bin/env node
/**
 * Claude Code ⇔ Nemo のブリッジ（stdio の MCP サーバ）。計画 2026-09-28「Claude in Nemo」。
 *
 * Claude Code がセッションごとに 1 本起動し、セッションが終わると止める（stdin EOF / SIGINT / SIGTERM）。
 * Nemo の main は `<userData>/agent.sock`（unix socket, 0600）で待ち受けている。
 *
 * - `initialize` / `tools/list` は**静的に答える**（Nemo が起動していなくても一覧は返す）
 * - `tools/call` は Nemo へ転送する。socket は最初の呼び出しで繋ぎ、切れるまで持ち続ける
 *   （接続 = セッション = エージェント窓 1 枚）。切れたら次の呼び出しで繋ぎ直す
 * - **Nemo の再起動・未起動では終了しない**（Claude Code は対話モードで stdio サーバを再起動しない。
 *   ここで終わるとツールが消え、/mcp での手動再接続が要る）
 * - `file_upload` のファイルは**ここで読む**（Claude Code と同じ権限で読む。Nemo はパスを読まない）
 *
 * 依存なし（ユーザーの node で動く。Node 18 以降）。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_VERSION = '1'
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const CONNECT_RETRY_MS = 3000
/** 起動直後（再起動・セッション復元の途中）で socket がまだ無いときは長めに待つ。 */
const CONNECT_RETRY_STARTING_MS = 10_000
/** 「起動直後」とみなす長さ。これより前から動いていて socket が無いなら、設定で許可していない。 */
const STARTING_WINDOW_MS = 30_000
const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const here = path.dirname(fileURLToPath(import.meta.url))

/** ツール定義の正本を読む（パッケージ版は隣、リポジトリでは `../shared/`）。 */
async function loadToolModule() {
  const candidates = [path.join(here, 'agent-tools.js'), path.join(here, '..', 'shared', 'agent-tools.js')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(new URL(`file://${candidate}`).href)
  }
  throw new Error('agent-tools.js が見つからない')
}

const toolModule = await loadToolModule()
const { AGENT_TOOLS, AGENT_INSTRUCTIONS, AGENT_PROTOCOL_VERSION, AGENT_SERVER_NAME } = toolModule

function debug(message) {
  if (process.env.NEMO_BRIDGE_DEBUG) process.stderr.write(`[nemo-bridge] ${message}\n`)
}

/* ------------------------------------------------------------------ *
 * stdio（Claude Code 側）
 * ------------------------------------------------------------------ */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let newline
  while ((newline = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newline).trim()
    stdinBuffer = stdinBuffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      replyError(null, -32700, 'Parse error')
      continue
    }
    void handleClientMessage(message)
  }
})
// **セッションの終わり**。Claude Code が SIGKILL されても EOF は即座に届く（実測）
process.stdin.on('end', () => shutdown('stdin-end'))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal))

function shutdown(reason) {
  debug(`shutdown: ${reason}`)
  try {
    nemo?.socket.end()
  } catch {
    /* 既に閉じている */
  }
  process.exit(0)
}

async function handleClientMessage(message) {
  const { id, method, params } = message ?? {}
  // レスポンス（こちらから出した要求への応答）とただの通知は何もしない
  if (method === undefined) return
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        reply(id, {
          protocolVersion: SUPPORTED_MCP_VERSIONS.includes(requested) ? requested : SUPPORTED_MCP_VERSIONS[1],
          capabilities: { tools: {} },
          serverInfo: { name: AGENT_SERVER_NAME, version: BRIDGE_VERSION },
          instructions: AGENT_INSTRUCTIONS
        })
        return
      }
      case 'ping':
        if (isRequest) reply(id, {})
        return
      case 'tools/list':
        reply(id, {
          tools: AGENT_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnly === true }
          }))
        })
        return
      case 'tools/call':
        reply(id, await callTool(params?.name, params?.arguments ?? {}))
        return
      default:
        // `server/discover` など未知のメソッド。通知には答えない
        if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    if (isRequest)
      reply(id, toolError(`Nemo bridge error: ${error instanceof Error ? error.message : String(error)}`))
  }
}

/* ------------------------------------------------------------------ *
 * Nemo 側（unix socket）
 * ------------------------------------------------------------------ */

/** @type {{ socket: net.Socket, buffer: string, pending: Map<number, (message: any) => void> } | null} */
let nemo = null
/** @type {Promise<typeof nemo> | null} */
let connecting = null
let nextCallId = 1

function appSupport(name) {
  return path.join(os.homedir(), 'Library', 'Application Support', name)
}

/**
 * Nemo が起動しているか（Chromium の `SingletonLock` は `<host>-<pid>` を指す symlink）。
 * パッケージ版が起動しているのに socket が無い = 設定で許可していない、を見分けるために使う。
 */
/** Nemo が起動しているか。起動していれば SingletonLock を作ってからの ms（起動直後かどうかに使う）、していなければ null。 */
function runningFor(userDataDir) {
  try {
    const lock = path.join(userDataDir, 'SingletonLock')
    const target = fs.readlinkSync(lock)
    const pid = Number(target.split('-').pop())
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return Math.max(0, Date.now() - fs.lstatSync(lock).mtimeMs)
  } catch {
    return null
  }
}

function tryConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    const fail = (error) => {
      socket.destroy()
      resolve({ socket: null, error })
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve({ socket, error: null })
    })
  })
}

/**
 * 繋ぐ先を決めて繋ぐ。常用版（Nemo）を先に見て、**常用版が起動していないときだけ** dev 版に落とす
 * （常用版が起動しているのに設定が OFF なら、黙って dev 版を操作しない）。
 */
async function connectToNemo() {
  const override = process.env.NEMO_AGENT_SOCKET
  const targets = override
    ? [{ socketPath: override, userDataDir: null, name: 'override' }]
    : [
        {
          socketPath: path.join(appSupport('Nemo'), 'agent.sock'),
          userDataDir: appSupport('Nemo'),
          name: 'Nemo'
        },
        {
          socketPath: path.join(appSupport('Nemo-dev'), 'agent.sock'),
          userDataDir: appSupport('Nemo-dev'),
          name: 'Nemo Dev'
        }
      ]
  const started = Date.now()
  // 起動しているのに socket が無い Nemo。再起動の途中（更新の直後など）でもこうなるので、**期限まで繋ぎ直しを続け**、
  // 期限が来てもまだそうなら「許可していない」と返す。起動直後だけ期限を延ばす（設定が OFF のままのときに毎回待たせない）
  let runningWithoutSocket
  let justStarted
  for (;;) {
    runningWithoutSocket = null
    justStarted = false
    for (const target of targets) {
      const { socket } = await tryConnect(target.socketPath)
      if (socket) return { socket, target }
      const age = target.userDataDir ? runningFor(target.userDataDir) : null
      if (age !== null) {
        // 常用版が起動しているなら dev 版には落とさない
        runningWithoutSocket = target.name
        justStarted = age < STARTING_WINDOW_MS
        break
      }
    }
    if (Date.now() - started >= (justStarted ? CONNECT_RETRY_STARTING_MS : CONNECT_RETRY_MS)) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (runningWithoutSocket) {
    throw new Error(
      `${runningWithoutSocket} は起動していますが、Claude Code からの操作が許可されていません。Nemo の設定（⌘,）で「Claude Code からの操作を許可」を ON にしてください。`
    )
  }
  throw new Error(
    'Nemo が起動していません（または操作を許可していません）。Nemo を起動してから、もう一度呼んでください。'
  )
}

async function ensureNemo() {
  if (nemo) return nemo
  if (connecting) return connecting
  connecting = (async () => {
    const { socket, target } = await connectToNemo()
    const state = { socket, buffer: '', pending: new Map() }
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      state.buffer += chunk
      let newline
      while ((newline = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, newline)
        state.buffer = state.buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const resolve = state.pending.get(message.id)
        if (resolve) {
          state.pending.delete(message.id)
          resolve(message)
        }
      }
    })
    const onGone = () => {
      if (nemo === state) nemo = null
      for (const resolve of state.pending.values()) {
        resolve({
          type: 'result',
          result: toolError(
            'Nemo との接続が切れました（Nemo が再起動した可能性）。tabs_context からやり直してください。'
          )
        })
      }
      state.pending.clear()
      debug('nemo connection closed')
    }
    socket.on('close', onGone)
    socket.on('error', onGone)

    // 最初のメッセージで版とセッションの情報を送る（Nemo は版が合わなければ断る）
    const hello = await request(state, {
      type: 'hello',
      protocol: AGENT_PROTOCOL_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      pid: process.ppid
    })
    if (!hello.ok) {
      socket.destroy()
      throw new Error(hello.error ?? 'Nemo が接続を断りました')
    }
    debug(`connected to ${target.name}`)
    nemo = state
    return state
  })()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

/** Nemo の応答を待つ上限（固まったときに Claude Code の idle タイムアウト 30 分まで待たせない）。 */
const REQUEST_TIMEOUT_MS = 120_000

function request(state, message) {
  const id = nextCallId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      resolve({ type: 'result', result: toolError('Nemo が 2 分以内に応答しませんでした。') })
    }, REQUEST_TIMEOUT_MS)
    state.pending.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    state.socket.write(`${JSON.stringify({ ...message, id })}\n`)
  })
}

/* ------------------------------------------------------------------ *
 * ツール呼び出し
 * ------------------------------------------------------------------ */

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip'
}

/**
 * `file_upload` のファイルを読む。**Nemo にパスを渡さない**（Nemo は画面収録等の権限を持つので、
 * Nemo に読ませると Claude Code 自身が読めないものまで読める経路になる）。
 */
function readUploadFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths が空です')
  let total = 0
  return paths.map((raw) => {
    if (typeof raw !== 'string' || !path.isAbsolute(raw))
      throw new Error(`絶対パスで指定してください: ${raw}`)
    // symlink は辿らない（O_NOFOLLOW）。通常ファイルだけ
    const fd = fs.openSync(raw, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) throw new Error(`通常ファイルではありません: ${raw}`)
      total += stat.size
      if (total > MAX_UPLOAD_BYTES) throw new Error('合計 10MB を超えています')
      const data = fs.readFileSync(fd)
      return {
        name: path.basename(raw),
        mimeType: MIME[path.extname(raw).toLowerCase()] ?? 'application/octet-stream',
        data: data.toString('base64')
      }
    } finally {
      fs.closeSync(fd)
    }
  })
}

async function callTool(name, args) {
  if (!AGENT_TOOLS.some((tool) => tool.name === name)) return toolError(`Unknown tool: ${name}`)
  let forwarded = args
  if (name === 'file_upload') {
    try {
      const { paths, ...rest } = args
      forwarded = { ...rest, files: readUploadFiles(paths) }
    } catch (error) {
      return toolError(`file_upload: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let state
  try {
    state = await ensureNemo()
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error))
  }
  const response = await request(state, { type: 'call', name, arguments: forwarded })
  return response.result ?? toolError('Nemo から応答がありませんでした')
}
