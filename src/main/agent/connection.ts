import { app, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type net from 'node:net'
import { log, logError } from '../log.js'
import {
  findTabByWebContents,
  openAgentWindow,
  presentAgentWindow,
  pushSharedToAll,
  removeWindow,
  type NemoTab,
  type NemoWindow
} from '../registry.js'
import { agentActivityLabel } from '../../shared/agent-activity.js'
import { AGENT_PROTOCOL_VERSION, AGENT_TOOL_NAMES } from '../../shared/agent-tools.js'
import { AgentPage } from './page.js'
import { isBlockedForAgent, runTool, type ToolResult } from './tools.js'

/**
 * Claude Code の 1 セッション（= ブリッジの 1 接続 = エージェント窓 1 枚）。
 *
 * - 窓は**最初のツール呼び出しで**開く（接続しただけでは開かない）。接続が切れたら閉じる
 * - tabId は接続ごとの不透明なトークン。呼ばれるたびに「この接続の窓のタブで、WebContents が生きている」を確かめる
 * - 「ユーザーの番」（`request_user_action`）の間は、そのタブへの入力系ツールを断る。
 *   解除はユーザーがチャットで終わったと言った後の `resume` だけ（blur による自動再開はしない。窓のボタンも置かない:
 *   Nemo から Claude Code を起こせないので、番だけ戻しても Claude は動き出さない）
 */

/** agent セッションの WebContents → 操作口。`web-contents-created` で作る（popup の子も含む）。 */
const pages = new WeakMap<WebContents, AgentPage>()
const connections = new Set<AgentConnection>()

export function allConnections(): AgentConnection[] {
  return [...connections]
}

export function connectionForWindow(win: NemoWindow): AgentConnection | null {
  for (const conn of connections) if (conn.window === win) return conn
  return null
}

/** agent セッションの WebContents が生まれたときに呼ぶ（index.ts）。 */
export function adoptAgentContents(wc: WebContents): void {
  if (pages.has(wc)) return
  const page = new AgentPage(wc, {
    window: () => findTabByWebContents(wc)?.win.baseWindow ?? null,
    userPresent: () => {
      const found = findTabByWebContents(wc)
      if (!found) return false
      const conn = connectionForWindow(found.win)
      return (conn?.isUserTurn(found.tab) ?? false) || isWindowKey(found.win)
    },
    userMouseDown: () => {
      const found = findTabByWebContents(wc)
      if (found) makeWindowFocusable(found.win)
    },
    changed: () => {
      const found = findTabByWebContents(wc)
      if (!found) return
      const conn = connectionForWindow(found.win)
      if (conn?.isUserTurn(found.tab)) conn.syncWindowState()
      else found.win.pushState()
    },
    viewSize: () => {
      const bounds = findTabByWebContents(wc)?.tab.view?.getBounds()
      return bounds ? { width: bounds.width, height: bounds.height } : null
    },
    navigationBlocked: (url) => {
      const found = findTabByWebContents(wc)
      if (!found) return false
      const conn = connectionForWindow(found.win)
      // ユーザーの番・ユーザーが窓にいるときはユーザーの操作なので止めない
      if ((conn?.isUserTurn(found.tab) ?? false) || isWindowKey(found.win)) return false
      return isBlockedForAgent(url)
    }
  })
  pages.set(wc, page)
}

export function pageFor(tab: NemoTab): AgentPage | null {
  const wc = tab.webContents
  if (!wc) return null
  if (!pages.has(wc)) adoptAgentContents(wc)
  return pages.get(wc) ?? null
}

/** 窓が key（ユーザーが今その窓を操作している）か。Nemo が前面でないときは false（実測）。 */
export function isWindowKey(win: NemoWindow): boolean {
  return !win.isDestroyed && !win.baseWindow.isDestroyed() && win.baseWindow.isFocused()
}

/**
 * ユーザーが窓を実クリックした。**このときだけ key になれるようにする**
 * （既定は focusable:false。全画面の常用窓から key を横取りしないため。実クリックで切り替わることは実測）。
 */
export function makeWindowFocusable(win: NemoWindow): void {
  if (win.isDestroyed || win.baseWindow.isDestroyed()) return
  if (!win.baseWindow.isFocusable()) {
    win.baseWindow.setFocusable(true)
    win.baseWindow.focus()
    log('agent.window_user_focus', { windowId: win.id })
  }
  // Claude の番に出て保留していたダイアログも、ユーザーが来たら見せる（ページが固まって見えないように）
  for (const tab of win.normalTabs) {
    const page = pageFor(tab)
    page?.noteUserPresent()
    if (page?.dialog) page.showDialogToUser()
  }
}

interface Hello {
  type: 'hello'
  id: number
  protocol: number
  bridgeVersion: string
  projectDir: string
  pid: number
}

interface Call {
  type: 'call'
  id: number
  name: string
  arguments: Record<string, unknown>
}

let nextConnectionId = 1

/** ツールが止まってから状態バーを「待機中」に落とすまで（ms）。 */
const AGENT_IDLE_AFTER_MS = 2500

export class AgentConnection {
  readonly id = nextConnectionId++
  label = 'Claude'
  window: NemoWindow | null = null
  /** ユーザーが窓を閉じた（次の tabs_create でだけ作り直す）。 */
  closedByUser = false
  /** 窓を用意している最中なら、その Promise。 */
  private windowReady: Promise<NemoWindow> | null = null
  private helloDone = false
  private buffer = ''
  private disposed = false
  private readonly tokenToKey = new Map<string, string>()
  private readonly keyToToken = new Map<string, string>()
  /** ユーザーの番のタブ（key）。 */
  private readonly userTurns = new Map<string, { message: string; origin: string | null }>()
  private readonly uploadDirs: string[] = []
  /** タブごとの直列化（同じタブへの呼び出しを重ねない。サブエージェントは接続を共有する）。 */
  private readonly tabLocks = new Map<string, Promise<unknown>>()
  /** 実行中のツールの数（状態バーの「作業中」。引き継ぎのツールは数えない）。 */
  private toolsInFlight = 0
  /** 今やっていること（Nemo が作る文言。`agent-activity.js`）。 */
  private activity: string | null = null
  private busy = false
  /** ツールが止まってから「待機中」に落とすまでの猶予（ツールの合間でちらつかせない）。 */
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly socket: net.Socket) {
    connections.add(this)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.dispose('closed'))
    socket.on('error', () => this.dispose('error'))
    log('agent.connected', { conn: this.id })
  }

  /* ---------------- 通信 ---------------- */

  private onData(chunk: string): void {
    this.buffer += chunk
    // 1 メッセージの上限（file_upload の 10MB を base64 にしたぶん + 余裕）
    if (this.buffer.length > 20 * 1024 * 1024) {
      log('agent.message_too_large', { conn: this.id })
      this.socket.destroy()
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.socket.destroy()
        return
      }
      void this.onMessage(message as Hello | Call)
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.disposed || this.socket.destroyed) return
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  private async onMessage(message: Hello | Call): Promise<void> {
    if (message.type === 'hello') {
      if (message.protocol !== AGENT_PROTOCOL_VERSION) {
        this.write({
          id: message.id,
          ok: false,
          error: `Nemo と Claude Code のブリッジの版が合いません（Nemo: ${AGENT_PROTOCOL_VERSION}, ブリッジ: ${String(message.protocol)}）。Claude Code を再起動してください。`
        })
        this.socket.end()
        return
      }
      this.helloDone = true
      const base = typeof message.projectDir === 'string' ? path.basename(message.projectDir) : ''
      this.label = base.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 40) || 'Claude'
      this.write({ id: message.id, ok: true })
      return
    }
    if (message.type !== 'call' || !this.helloDone) {
      this.socket.destroy()
      return
    }
    const started = Date.now()
    const activity = AGENT_TOOL_NAMES.includes(message.name)
      ? agentActivityLabel(message.name, message.arguments ?? {})
      : null
    if (activity) this.beginActivity(activity)
    let result: ToolResult
    try {
      if (!AGENT_TOOL_NAMES.includes(message.name)) throw new Error(`Unknown tool: ${message.name}`)
      result = await runTool(this, message.name, message.arguments ?? {})
    } catch (error) {
      result = {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true
      }
    } finally {
      if (activity) this.endActivity()
    }
    log('agent.tool', {
      conn: this.id,
      tool: message.name,
      ok: result.isError !== true,
      ms: Date.now() - started
    })
    this.write({ id: message.id, type: 'result', result })
  }

  /* ---------------- 状態バーの「作業中 / 待機中」 ---------------- */

  private beginActivity(activity: string): void {
    this.toolsInFlight += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.busy && this.activity === activity) return
    this.busy = true
    this.activity = activity
    this.syncWindowState()
  }

  private endActivity(): void {
    this.toolsInFlight = Math.max(0, this.toolsInFlight - 1)
    if (this.toolsInFlight > 0 || this.disposed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.toolsInFlight > 0) return
      this.busy = false
      this.activity = null
      this.syncWindowState()
    }, AGENT_IDLE_AFTER_MS)
  }

  /* ---------------- 窓とタブ ---------------- */

  /** 窓を用意する（無ければ作り、最初のタブができるまで待つ）。 */
  async ensureWindow(options: { reopen?: boolean } = {}): Promise<NemoWindow> {
    // 用意の途中に来た呼び出し（並列のサブエージェント）は同じ用意を待つ（初期タブができる前の窓を渡さない）
    if (this.windowReady) return this.windowReady
    if (this.window && !this.window.isDestroyed) return this.window
    if (this.closedByUser && !options.reopen) {
      throw new Error(
        'ユーザーが Claude 用のウィンドウを閉じました。続けてよいかユーザーに確認し、続けるなら tabs_create で作り直してください。'
      )
    }
    this.closedByUser = false
    const ready = (async () => {
      const win = openAgentWindow(this.label)
      this.window = win
      this.watchUiViews(win)
      await new Promise<void>((resolve) => win.whenUiSettled(resolve))
      // 初期タブ（about:blank）ができるまで待つ（createWindow の whenUiReady で作られる）
      for (let i = 0; i < 50 && win.normalTabs.length === 0 && !win.isDestroyed; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      if (win.isDestroyed) throw new Error('ウィンドウを開けませんでした')
      return win
    })()
    this.windowReady = ready
    try {
      return await ready
    } finally {
      this.windowReady = null
    }
  }

  /** UI View（サイドバー・ツールバー・オーバーレイ）の実クリックでも key になれるようにする。 */
  private watchUiViews(win: NemoWindow): void {
    const views = [win.chromeWebContents, win.toolbarView?.webContents, win.overlayWebContents]
    for (const wc of views) {
      wc?.on('before-mouse-event', (_event, input) => {
        if (input.type === 'mouseDown') makeWindowFocusable(win)
      })
    }
    // key でなくなったら（ターミナル等へ戻った）また key になれない状態へ戻す
    win.baseWindow.on('blur', () => {
      if (!win.baseWindow.isDestroyed() && win.baseWindow.isFocusable()) win.baseWindow.setFocusable(false)
    })
  }

  tokenFor(tab: NemoTab): string {
    let token = this.keyToToken.get(tab.key)
    if (!token) {
      token = randomBytes(4).toString('hex')
      this.keyToToken.set(tab.key, token)
      this.tokenToKey.set(token, tab.key)
    }
    return token
  }

  /** tabId → タブ（この接続の窓のもので、WebContents が生きていること）。 */
  resolveTab(tabId: unknown): { win: NemoWindow; tab: NemoTab; page: AgentPage } {
    if (typeof tabId !== 'string' || !tabId)
      throw new Error('tabId を指定してください（tabs_context で取れます）')
    const win = this.window
    if (!win || win.isDestroyed) {
      if (this.closedByUser) {
        throw new Error(
          'ユーザーが Claude 用のウィンドウを閉じました。続けるなら tabs_create で作り直してください。'
        )
      }
      throw new Error(
        'タブが見つかりません（Nemo が再起動した可能性）。tabs_context から始め直してください。'
      )
    }
    const key = this.tokenToKey.get(tabId)
    const tab = key ? win.findTab(key) : null
    if (!tab || tab.peekOf) {
      throw new Error(
        'そのタブはもうありません（閉じられた・Nemo が再起動した可能性）。tabs_context から始め直してください。'
      )
    }
    if (!tab.webContents) throw new Error('タブの中身がありません。tabs_context からやり直してください。')
    const page = pageFor(tab)
    if (!page) throw new Error('タブを操作できません')
    return { win, tab, page }
  }

  forgetTab(tab: NemoTab): void {
    const token = this.keyToToken.get(tab.key)
    if (token) this.tokenToKey.delete(token)
    this.keyToToken.delete(tab.key)
    if (this.userTurns.delete(tab.key)) this.syncWindowState()
  }

  /** 同じタブへの呼び出しを順に並べる。 */
  async withTabLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tabLocks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(fn)
    this.tabLocks.set(key, run)
    try {
      return await run
    } finally {
      if (this.tabLocks.get(key) === run) this.tabLocks.delete(key)
    }
  }

  /* ---------------- ユーザーの番 ---------------- */

  isUserTurn(tab: NemoTab): boolean {
    return this.userTurns.has(tab.key)
  }

  hasUserTurn(): boolean {
    return this.userTurns.size > 0
  }

  giveTurnToUser(tab: NemoTab, message: string): void {
    // 依頼先の origin は Nemo が確定した値（コミット済みの URL）。ページの pushState ではパスは偽れるが origin は変えられない
    let origin: string | null
    try {
      origin = new URL(tab.webContents?.getURL() ?? '').origin
    } catch {
      origin = null
    }
    this.userTurns.set(tab.key, { message: message.slice(0, 500), origin })
    const page = pageFor(tab)
    if (page) {
      page.noteUserPresent()
      void page.setFileChooserIntercept(false)
      if (page.dialog) page.showDialogToUser()
    }
    this.syncWindowState()
    updateDockBadge()
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    log('agent.handoff', { conn: this.id, to: 'user' })
  }

  takeTurnBack(): void {
    const hadTurn = this.userTurns.size > 0
    const keys = [...this.userTurns.keys()]
    this.userTurns.clear()
    for (const key of keys) {
      const tab = this.window?.findTab(key)
      const page = tab ? pageFor(tab) : null
      if (page) void page.setFileChooserIntercept(true)
    }
    this.syncWindowState()
    updateDockBadge()
    if (hadTurn) log('agent.handoff', { conn: this.id, to: 'claude' })
  }

  /** 窓の帯（UI）に出す状態を書き直す。 */
  syncWindowState(): void {
    const win = this.window
    if (!win || win.isDestroyed || !win.agent) return
    const firstKey = [...this.userTurns.keys()][0] ?? null
    const first = firstKey ? (this.userTurns.get(firstKey) ?? null) : null
    // 帯に出す origin は**今のページのもの**を毎回計算する（SSO などで別ドメインへ移ったら追う）
    const tab = firstKey ? win.findTab(firstKey) : null
    let origin: string | null = first?.origin ?? null
    try {
      const url = tab?.webContents?.getURL()
      if (url) origin = new URL(url).origin
    } catch {
      // 読めない URL は引き継いだ時点の値のまま
    }
    const mode = first ? 'user' : 'claude'
    // 通常窓の入口（共有状態）が見るのは名前と番だけ。作業中 / 待機中の切り替えでは全窓へ配らない
    const sharedChanged = win.agent?.mode !== mode || win.agent?.label !== this.label
    win.agent = {
      label: this.label,
      mode,
      request: first?.message ?? null,
      requestOrigin: first ? origin : null,
      busy: this.busy,
      activity: this.busy ? this.activity : null
    }
    win.pushState()
    if (sharedChanged) pushSharedToAll()
  }

  /* ---------------- file_upload のステージング ---------------- */

  stagingDir(): string {
    const dir = path.join(
      app.getPath('userData'),
      'agent-upload',
      `${this.id}-${randomBytes(4).toString('hex')}`
    )
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.uploadDirs.push(dir)
    return dir
  }

  /* ---------------- 後始末 ---------------- */

  /** 窓が閉じられた（ユーザーの ✕ / 終了ボタン、または自分で閉じた）。 */
  windowClosed(win: NemoWindow): void {
    if (this.window !== win) return
    this.window = null
    this.tokenToKey.clear()
    this.keyToToken.clear()
    this.userTurns.clear()
    updateDockBadge()
    if (!this.disposed) {
      this.closedByUser = true
      log('agent.window_closed_by_user', { conn: this.id })
    }
  }

  dispose(reason: string): void {
    if (this.disposed) return
    this.disposed = true
    connections.delete(this)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed) removeWindow(win)
    for (const dir of this.uploadDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        logError('agent.upload_cleanup_failed', error, {})
      }
    }
    if (!this.socket.destroyed) this.socket.destroy()
    updateDockBadge()
    log('agent.disconnected', { conn: this.id, reason })
  }

  /** 最小化されていたら前面を奪わずに戻す（最小化のまま遷移するとスクショが返らない。実測）。 */
  restoreIfMinimized(): void {
    const win = this.window
    if (!win || win.isDestroyed) return
    if (process.platform === 'darwin' && app.isHidden()) {
      throw new Error('Nemo が隠れています（⌘H）。ユーザーに Nemo を表示してもらってから続けてください。')
    }
    if (win.baseWindow.isMinimized()) presentAgentWindow(win)
  }
}

/** Dock のバッジ: どこかの接続がユーザーの番なら出す。 */
function updateDockBadge(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const waiting = allConnections().some((conn) => conn.hasUserTurn())
  app.dock.setBadge(waiting ? '●' : '')
}
