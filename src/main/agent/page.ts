import { dialog, type BaseWindow, type WebContents } from 'electron'
import { log, logError } from '../log.js'
import { AGENT_MAIN_WORLD_GUARD, AGENT_PAGE_SOURCE, AGENT_WORLD_ID } from '../../shared/agent-page-source.js'

/**
 * エージェント窓のタブ 1 枚ぶんの操作口（ページの WebContents 1 つに 1 つ）。
 *
 * **ページに触るのはここだけ**。CDP は main の `webContents.debugger`（ページ単位）で撃つが、
 * ページ単位の口でも `Target.*` で他のタブ・拡張の SW に入れ、`Network.getAllCookies` で全 cookie が取れた（実測）。
 * だから撃つメソッドは下の許可リストに限り、ツールの入力から任意の CDP には届かないようにする。
 */

/** 撃ってよい CDP メソッド。**ここに無いものは撃たない**（`Target.*`・cookie 系・`Storage.*`・`Browser.*`・`Fetch.*` 等）。 */
const ALLOWED_CDP = new Set([
  'Page.enable',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.setInterceptFileChooserDialog',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.enable',
  'Runtime.evaluate',
  'Network.enable',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.setFileInputFiles',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setFocusEmulationEnabled'
])

export class CdpNotAllowedError extends Error {}

/** CDP の 1 回の応答を待つ上限。保留中の JS ダイアログがあると Runtime / スクショは返らない（実測）。 */
const CDP_TIMEOUT_MS = 10_000

/**
 * ダイアログが出たら応答を待たずに返すメソッド。クリック・キー・JS 実行が alert / confirm を出すと、
 * その CDP の応答は**ダイアログに答えるまで返らない**（実測: クリックが 10 秒でタイムアウトした）。
 */
const RACE_DIALOG = new Set([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Runtime.evaluate'
])

/** ダイアログで打ち切った CDP 呼び出しの戻り値。 */
export const INTERRUPTED_BY_DIALOG = Symbol('interrupted-by-dialog')

export interface PendingDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  answer: (accept: boolean, text: string) => void
}

export interface ConsoleEntry {
  level: string
  text: string
  at: number
}

export interface NetworkEntry {
  id: string
  url: string
  method: string
  type: string
  status: number | null
  failed: string | null
  at: number
}

const CONSOLE_LIMIT = 2000
const NETWORK_LIMIT = 1000

/** スクショの長辺の上限（Claude Code は 2000px に縮めるが、1 メッセージ 16MiB で接続ごと切れるので Nemo 側で抑える）。 */
const SCREENSHOT_LONG_EDGE = 1568

export interface PageHost {
  /** この WebContents が載っている窓（無ければ null）。 */
  window(): BaseWindow | null
  /** ユーザーがこの窓にいる（窓が key）か、ユーザーの番か。いればダイアログは画面に出す。 */
  userPresent(): boolean
  /** ページ上で実マウスが押された（CDP 由来ではない）。 */
  userMouseDown(): void
  /** ページ View の寸法（CSS px）。capturePage の縮尺に使う。 */
  viewSize(): { width: number; height: number } | null
  /** Claude の番に、ページ起点でこの URL へ移ってよいか（ブロックリスト）。 */
  navigationBlocked(url: string): boolean
  /** 状態が変わった（保留中のダイアログ等）。UI に出し直す。 */
  changed(): void
}

/** CDP のイベントの値を文字列に（オブジェクトは既定の値に倒す）。 */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} が ${ms}ms 以内に返りませんでした`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export class AgentPage {
  private attached: Promise<void> | null = null
  private dialogOverrideOk = false
  /** Claude が撃っている最中のマウス（`before-mouse-event` を実マウスと見分ける。ack より先に届く。実測）。 */
  private cdpMouseInFlight = 0
  private activeRefs = 0
  /** 入力系のツールの入れ子の数（isolated world の「Claude の入力中」を立てている数）。 */
  private inputRefs = 0
  /** ユーザーに出しているシート（1 枚だけ。Claude が先に答えたら閉じる）。 */
  private sheet: AbortController | null = null
  /** 最後に見たとき、ページに秘密（ユーザーが入れた値）があったか。ダイアログ保留中のスクショの判断に使う。 */
  private pageHadSecrets = false
  /**
   * 最後に確かめた後にユーザーがこのページにいた（引き継ぎ・実クリック）。その間に入れた秘密は pageHadSecrets に
   * 載っていないので、ダイアログ保留中は「秘密あり」とみなす。遷移では消さない（ユーザーが遷移先で入れうる）
   */
  private userSinceLastCheck = false
  private interceptFileChooser: boolean | null = null
  dialog: PendingDialog | null = null
  private dialogWaiters: (() => void)[] = []
  console: ConsoleEntry[] | null = null
  network: Map<string, NetworkEntry> | null = null
  /** 次の beforeunload だけ離れてよい（navigate の force）。 */
  forceUnload = false
  /** 直近の遷移が beforeunload で止まった（navigate がそう伝えるため）。 */
  unloadBlocked = false
  /** 最後のスクショの縮尺（スクショの px → CSS px）。 */
  scale = 1

  constructor(
    readonly wc: WebContents,
    private readonly host: PageHost
  ) {
    this.installDialogOverride()
    const inject = (): void => void this.injectPageScript()
    wc.on('dom-ready', inject)
    wc.on('did-navigate', () => {
      // 新しい document。前の document のコンソールの記録は捨てる（taint が付いていたか後から分からないので、捨てる側に倒す）
      if (this.console) this.console.length = 0
      this.pageHadSecrets = false
      inject()
      this.host.changed()
    })
    // 実マウスでユーザーが来たことを知る（CDP のマウスは送出中フラグで除く）
    wc.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown' && this.cdpMouseInFlight === 0) this.host.userMouseDown()
    })
    // ブロックリストのホストへは、ページ起点（リンク・リダイレクト）でも移らせない（Claude の番のとき）
    const guard = (event: { preventDefault(): void }, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame || !this.host.navigationBlocked(url)) return
      event.preventDefault()
      log('agent.navigation_blocked', { reason: 'blocklist' })
    }
    wc.on('will-navigate', (event) => guard(event, event.url, event.isMainFrame))
    wc.on('will-redirect', (event) => guard(event, event.url, event.isMainFrame))
    // debugger の購読は 1 回だけ張る（attach し直しても重ならないように）
    wc.debugger.on('detach', (_event, reason) => {
      log('agent.debugger_detached', { reason })
      this.attached = null
      this.interceptFileChooser = null
    })
    // **子セッション（`sessionId` 付き）のイベントは捨てる**。kypr・自動入力が iframe に入るとき、同じ debugger で
    // `Target.setAutoAttach` した iframe のイベントが届く（メインの console / network の記録に混ぜない）
    wc.debugger.on('message', (_event, method, params, sessionId) => {
      if (sessionId) return
      this.onCdpEvent(method, params as Record<string, unknown>)
    })
    // 起きた直後から ガード（印刷・showPicker・execCommand('copy')）を入れる
    void this.ensureDebugger().catch((error: unknown) => logError('agent.debugger_attach_failed', error, {}))
  }

  get alive(): boolean {
    return !this.wc.isDestroyed()
  }

  /* ---------------- JS ダイアログ ---------------- */

  /**
   * Electron 内部の `-run-dialog` を差し替える。既定の実装は**親の無い NSAlert（runModal）**を出して前面を奪い、
   * CDP で答えても画面に残った（実測）。`disableDialogs` は手動操作の confirm まで黙って false にするので使わない。
   *
   * **内部イベントなので、Electron を上げたときに既定の listener が 1 本でなければ差し替えない**（fail closed:
   * 入力系ツールを止める。`dialogsBroken`）。
   */
  private installDialogOverride(): void {
    const count = this.wc.listenerCount('-run-dialog')
    if (count !== 1) {
      log('agent.dialog_override_skipped', { listeners: count })
      return
    }
    this.wc.removeAllListeners('-run-dialog')
    this.wc.on(
      '-run-dialog' as never,
      ((info: { dialogType: string; messageText: string }, callback: (ok: boolean, text: string) => void) => {
        let answered = false
        const answer = (accept: boolean, text: string): void => {
          if (answered) return
          answered = true
          try {
            callback(accept, text)
          } catch (error) {
            logError('agent.dialog_answer_failed', error, {})
          }
          if (this.dialog?.answer === answer) this.dialog = null
          this.sheet?.abort()
          this.sheet = null
          this.host.changed()
          void this.settleAfterAgent()
        }
        // prompt() は Electron が対応していない（既定の実装も即 false）
        if (info.dialogType === 'prompt') {
          answer(false, '')
          return
        }
        const type = info.dialogType === 'confirm' ? 'confirm' : 'alert'
        this.dialog = { type, message: String(info.messageText ?? ''), answer }
        const waiters = this.dialogWaiters
        this.dialogWaiters = []
        for (const wake of waiters) wake()
        log('agent.dialog', { type })
        this.host.changed()
        if (this.host.userPresent()) this.showDialogToUser()
      }) as never
    )
    this.wc.on('-cancel-dialogs' as never, () => {
      this.dialog = null
      this.sheet?.abort()
      this.sheet = null
      this.host.changed()
      void this.settleAfterAgent()
    })
    this.dialogOverrideOk = true
  }

  get dialogsBroken(): boolean {
    return !this.dialogOverrideOk
  }

  /**
   * 保留中のダイアログをユーザーに出す（ユーザーの番・窓にいるとき）。**窓のシートにする**
   * （親付きの非同期 `showMessageBox` は main を止めず、アプリモーダルにもならない）。
   */
  showDialogToUser(): void {
    const pending = this.dialog
    const parent = this.host.window()
    // シートは 1 枚だけ（引き継ぎを 2 回呼んでも・クリックで何度来ても重ねない）
    if (!pending || !parent || parent.isDestroyed() || this.sheet) return
    const confirm = pending.type === 'confirm'
    const sheet = new AbortController()
    this.sheet = sheet
    void dialog
      .showMessageBox(parent, {
        message: pending.message,
        buttons: confirm ? ['OK', 'キャンセル'] : ['OK'],
        defaultId: 0,
        cancelId: confirm ? 1 : 0,
        // Claude が先に答えた・取り下げられたら閉じる
        signal: sheet.signal
      })
      .then((result) => {
        if (!sheet.signal.aborted) pending.answer(result.response === 0, '')
      })
      .catch((error: unknown) => logError('agent.dialog_show_failed', error, {}))
      .finally(() => {
        if (this.sheet === sheet) this.sheet = null
      })
  }

  /* ---------------- CDP ---------------- */

  /** agent の debugger を付けておく（kypr・自動入力が iframe に CDP で入る前。`contents.ts` の `prepareAgentDebugger`）。 */
  readyDebugger(): Promise<void> {
    return this.ensureDebugger()
  }

  private ensureDebugger(): Promise<void> {
    if (this.attached) return this.attached
    this.attached = (async () => {
      const dbg = this.wc.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      // まだ何も読み込んでいない WebContents に Page.enable を送ると、最初の読み込みまで返らない（実測）。
      // 最初の dom-ready を待ってから送る（上限つき）
      if (!this.wc.getURL()) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CDP_TIMEOUT_MS)
          this.wc.once('dom-ready', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      await this.send('Page.enable')
      await this.send('Page.addScriptToEvaluateOnNewDocument', {
        source: AGENT_MAIN_WORLD_GUARD,
        runImmediately: true
      })
      await this.setFileChooserIntercept(true)
    })()
    this.attached.catch(() => {
      this.attached = null
    })
    return this.attached
  }

  /**
   * 許可リストの CDP だけを撃つ。入力・JS 実行の途中でダイアログが出たら、応答を待たずに
   * `INTERRUPTED_BY_DIALOG` を返す（元の呼び出しはダイアログに答えた後に黙って終わる）。
   */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!ALLOWED_CDP.has(method)) throw new CdpNotAllowedError(`CDP ${method} は許可していない`)
    if (this.wc.isDestroyed()) throw new Error('タブが閉じられています')
    if (method !== 'Page.enable' && method !== 'Page.addScriptToEvaluateOnNewDocument') {
      await this.ensureDebugger()
    }
    const call = withTimeout(
      this.wc.debugger.sendCommand(method, params) as Promise<T>,
      CDP_TIMEOUT_MS,
      method
    )
    if (!RACE_DIALOG.has(method)) return call
    call.catch(() => {})
    const dialogOpened = new Promise<typeof INTERRUPTED_BY_DIALOG>((resolve) => {
      if (this.dialog) resolve(INTERRUPTED_BY_DIALOG)
      else this.dialogWaiters.push(() => resolve(INTERRUPTED_BY_DIALOG))
    })
    return (await Promise.race([call, dialogOpened])) as T
  }

  /** ファイル選択のネイティブパネルを出させない（Claude の操作中）。ユーザーの番は出す。 */
  async setFileChooserIntercept(enabled: boolean): Promise<void> {
    if (this.interceptFileChooser === enabled) return
    this.interceptFileChooser = enabled
    try {
      await withTimeout(
        this.wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled }) as Promise<unknown>,
        CDP_TIMEOUT_MS,
        'Page.setInterceptFileChooserDialog'
      )
    } catch (error) {
      this.interceptFileChooser = null
      logError('agent.file_chooser_intercept_failed', error, {})
    }
  }

  private onCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Runtime.consoleAPICalled' && this.console) {
      const args =
        (params['args'] as { value?: unknown; description?: string; type?: string }[] | undefined) ?? []
      const text = args
        .map((arg) =>
          arg.value !== undefined
            ? str(arg.value, JSON.stringify(arg.value) ?? '')
            : (arg.description ?? arg.type ?? '')
        )
        .join(' ')
      this.pushConsole(str(params['type'], 'log'), text)
    } else if (method === 'Runtime.exceptionThrown' && this.console) {
      const details = params['exceptionDetails'] as
        { text?: string; exception?: { description?: string } } | undefined
      this.pushConsole('error', details?.exception?.description ?? details?.text ?? 'Uncaught exception')
    } else if (method === 'Network.requestWillBeSent' && this.network) {
      const request = params['request'] as { url?: string; method?: string } | undefined
      const id = str(params['requestId'])
      this.network.set(id, {
        id,
        url: str(request?.url),
        method: str(request?.method, 'GET'),
        type: str(params['type']),
        status: null,
        failed: null,
        at: Date.now()
      })
      if (this.network.size > NETWORK_LIMIT) {
        const first = this.network.keys().next().value
        if (first !== undefined) this.network.delete(first)
      }
    } else if (method === 'Network.responseReceived' && this.network) {
      const entry = this.network.get(str(params['requestId']))
      const response = params['response'] as { status?: number } | undefined
      if (entry) entry.status = typeof response?.status === 'number' ? response.status : null
    } else if (method === 'Network.loadingFailed' && this.network) {
      const entry = this.network.get(str(params['requestId']))
      if (entry) entry.failed = str(params['errorText'], 'failed')
    }
  }

  private pushConsole(level: string, text: string): void {
    if (!this.console) return
    this.console.push({ level, text: text.slice(0, 2000), at: Date.now() })
    if (this.console.length > CONSOLE_LIMIT) this.console.splice(0, this.console.length - CONSOLE_LIMIT)
  }

  async startConsole(): Promise<void> {
    if (this.console) return
    this.console = []
    await this.send('Runtime.enable')
  }

  async startNetwork(): Promise<void> {
    if (this.network) return
    this.network = new Map()
    await this.send('Network.enable')
  }

  /* ---------------- ページ側スクリプト（isolated world） ---------------- */

  private async injectPageScript(): Promise<void> {
    if (this.wc.isDestroyed()) return
    try {
      await this.wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: AGENT_PAGE_SOURCE }])
    } catch {
      // 差し替わっている途中。次の dom-ready で入り直す
    }
  }

  /** isolated world で `__nemoAgent.<method>(...args)` を呼ぶ。 */
  async page<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (this.dialog) throw new Error(this.dialogMessage())
    await this.injectPageScript()
    const code = `globalThis.__nemoAgent.${method}(...${JSON.stringify(args)})`
    return withTimeout(
      this.wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }]) as Promise<T>,
      CDP_TIMEOUT_MS,
      `page.${method}`
    )
  }

  dialogMessage(): string {
    const pending = this.dialog
    if (!pending) return ''
    return `このタブで JavaScript の ${pending.type} ダイアログが答えを待っています: 「${pending.message.slice(0, 300)}」。handle_dialog で答えてください。`
  }

  /* ---------------- Claude の操作中 ---------------- */

  /**
   * Claude の操作を囲む。**この間だけ**フォーカスエミュレーションを入れる
   * （一度も描画していない窓・タブでは CDP のクリック / キーが ack 成功のまま捨てられる。エミュレーションで全状態で通った。
   * 常時入れると隠れていても 60fps で描き続けるので、呼び出しの間だけにする。いずれも実測）。
   * isolated world にも「Claude の操作中」を伝える（taint と秘密の値の記録をこの間は止める）。
   */
  async withAgentActive<T>(fn: () => Promise<T>, options: { input?: boolean } = {}): Promise<T> {
    // **「Claude の入力中」をページに伝えるのは入力系だけ、かつユーザーがいないときだけ**。
    // 読み取り（スクショ・wait）の最中やユーザーの番に立てると、その間にユーザーが打ったパスワードを
    // 記録し損ね、taint も立たない（レビューで指摘。ユーザーのログイン中に Claude が様子を見るのはよくある）
    const markInput = options.input === true && !this.host.userPresent()
    this.activeRefs += 1
    if (markInput) this.inputRefs += 1
    // ダイアログを保留している間はレンダラが止まっていて、エミュレーションの切り替えも返らない（実測）
    if (!this.dialog) {
      if (this.activeRefs === 1)
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      if (markInput && this.inputRefs === 1) await this.page('setActive', true).catch(() => {})
      const state = await this.page<{ secrets?: number; tainted?: boolean }>('state').catch(() => null)
      if (state) {
        this.pageHadSecrets = (state.secrets ?? 0) > 0 || state.tainted === true
        // ユーザーがまだいる間は消さない（確かめた後に打つかもしれない）
        if (!this.host.userPresent()) this.userSinceLastCheck = false
      }
    }
    try {
      return await fn()
    } finally {
      this.activeRefs -= 1
      if (markInput) this.inputRefs -= 1
      await this.settleAfterAgent()
    }
  }

  /**
   * Claude の操作が終わった後の片付け（エミュレーションを切る・「入力中」を下ろす）。
   * ダイアログを保留している間は返らないので、**ダイアログに答えた時点でもう一度呼ぶ**
   * （呼ばないと、ツールの途中でダイアログが出たときに `agentActive` とエミュレーションが残る）。
   */
  private async settleAfterAgent(): Promise<void> {
    if (!this.alive || this.dialog) return
    if (this.activeRefs === 0)
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
    if (this.inputRefs === 0) await this.page('setActive', false).catch(() => {})
  }

  /* ---------------- 入力 ---------------- */

  async mouse(
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
    x: number,
    y: number,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    this.cdpMouseInFlight += 1
    try {
      await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra })
    } finally {
      this.cdpMouseInFlight -= 1
    }
  }

  async click(
    x: number,
    y: number,
    options: { button?: 'left' | 'right'; clickCount?: number; modifiers?: number } = {}
  ): Promise<void> {
    const button = options.button ?? 'left'
    const modifiers = options.modifiers ?? 0
    await this.mouse('mouseMoved', x, y, { modifiers })
    const count = options.clickCount ?? 1
    for (let n = 1; n <= count && !this.dialog; n += 1) {
      await this.mouse('mousePressed', x, y, { button, clickCount: n, modifiers })
      if (this.dialog) break
      await this.mouse('mouseReleased', x, y, { button, clickCount: n, modifiers })
    }
  }

  /* ---------------- スクショ ---------------- */

  /** ビューポートの CSS 寸法と、スクショの縮尺。 */
  async viewport(): Promise<{
    x: number
    y: number
    width: number
    height: number
    scale: number
    devicePixelRatio: number
  }> {
    const metrics = await this.send<{
      cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
      visualViewport?: { clientWidth: number }
    }>('Page.getLayoutMetrics')
    const vv = metrics.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }
    const width = Math.max(1, Math.round(vv.clientWidth))
    const height = Math.max(1, Math.round(vv.clientHeight))
    const scale = Math.min(1, SCREENSHOT_LONG_EDGE / Math.max(width, height))
    // visualViewport は device px。Retina では CSS px の 2 倍（ページのズームも乗る）
    const ratio = metrics.visualViewport
      ? metrics.visualViewport.clientWidth / Math.max(vv.clientWidth, 1)
      : 1
    const devicePixelRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
    return { x: vv.pageX, y: vv.pageY, width, height, scale, devicePixelRatio }
  }

  /** ユーザーがこのページに来た（引き継ぎ・実クリック）。 */
  noteUserPresent(): void {
    this.userSinceLastCheck = true
  }

  /**
   * スクショ（JPEG, base64）。秘密が見えている欄は撮る前に塗る（撮る手段によらず。CDP / capturePage とも）。
   * `region` は CSS px のビューポート座標（zoom 用）。
   */
  async screenshot(region?: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<{ data: string; width: number; height: number; scale: number }> {
    // ダイアログを保留している間はページの JS も CDP のスクショも返らない（実測）。capturePage で撮る。
    // この経路では秘密の欄を塗れないので、**秘密があったページでは撮らない**（撮る手段によらず伏せる、の代わり）
    if (this.dialog) {
      if (this.pageHadSecrets || this.userSinceLastCheck) {
        throw new Error(
          `パスワード等が入ったページでダイアログが答えを待っているため、スクリーンショットは撮れません。${this.dialogMessage()}`
        )
      }
      return this.capturePageJpeg()
    }
    const view = await this.viewport()
    const clip = region
      ? { x: view.x + region.x, y: view.y + region.y, width: region.width, height: region.height }
      : { x: view.x, y: view.y, width: view.width, height: view.height }
    const scale = region
      ? Math.min(2, SCREENSHOT_LONG_EDGE / Math.max(region.width, region.height))
      : view.scale
    const masked = await this.page<{ masked?: number }>('maskSecrets').catch(() => null)
    const state = await this.page<{ secrets?: number; tainted?: boolean }>('state').catch(() => null)
    this.pageHadSecrets = (masked?.masked ?? 0) > 0 || (state?.secrets ?? 0) > 0 || state?.tainted === true
    if (state && !this.host.userPresent()) this.userSinceLastCheck = false
    try {
      const shot = await this.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        // clip.scale は device px に掛かる（Retina で指定の 2 倍の画像になる。実測）ので、device px の倍率で割る
        clip: { ...clip, scale: scale / view.devicePixelRatio },
        captureBeyondViewport: false
      })
      if (!region) this.scale = scale
      return {
        data: shot.data,
        width: Math.round(clip.width * scale),
        height: Math.round(clip.height * scale),
        scale
      }
    } catch (error) {
      logError('agent.screenshot_cdp_failed', error, {})
      return this.capturePageJpeg()
    } finally {
      await this.page('unmaskSecrets').catch(() => {})
    }
  }

  private async capturePageJpeg(): Promise<{ data: string; width: number; height: number; scale: number }> {
    const image = await withTimeout(this.wc.capturePage(), CDP_TIMEOUT_MS, 'capturePage')
    const size = image.getSize()
    // 縮尺は CSS px 基準で決める（capturePage は device px で返る）
    const css = this.host.viewSize() ?? size
    const target = Math.min(1, SCREENSHOT_LONG_EDGE / Math.max(css.width, css.height, 1))
    const width = Math.max(1, Math.round(css.width * target))
    const resized = image.resize({ width })
    const out = resized.getSize()
    this.scale = out.width / Math.max(css.width, 1)
    return {
      data: resized.toJPEG(70).toString('base64'),
      width: out.width,
      height: out.height,
      scale: this.scale
    }
  }

  /** スクショの px → CSS px。 */
  toCss(point: [number, number]): { x: number; y: number } {
    const scale = this.scale > 0 ? this.scale : 1
    return { x: point[0] / scale, y: point[1] / scale }
  }
}
