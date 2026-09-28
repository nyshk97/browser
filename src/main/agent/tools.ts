import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTab, removeTab, selectTab, type NemoTab, type NemoWindow } from '../registry.js'
import { BLANK_URL } from '../security.js'
import type { AgentConnection } from './connection.js'
import { isWindowKey, pageFor } from './connection.js'
import type { AgentPage } from './page.js'
import { KeyParseError, parseKeySequence, parseModifiers } from './keys.js'
import { sensitivePageKind, sensitivePageMessage } from '../../shared/agent-sensitive-pages.js'
import { isBlockedAgentHost } from '../../shared/settings-schema.js'
import { getSettings } from '../store/settings.js'

/**
 * Claude in Nemo のツール実装。定義（名前・引数・説明）の正本は `src/shared/agent-tools.js`。
 *
 * 入力系（クリック・キー・遷移・値の設定・JS 実行・アップロード・ダイアログへの応答）は、
 * 次のときに断る（読み取り系は通す）:
 * - そのタブが「ユーザーの番」（`request_user_action` の後、resume まで）
 * - ユーザーがいまエージェント窓を操作している（窓が key）
 * - JS ダイアログの横取りが効いていない（Electron の更新で内部イベントが変わった。fail closed）
 */

export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })
const fail = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true })
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 1))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const USER_TURN_MESSAGE =
  'いまはユーザーの番です（request_user_action で渡した後、まだ戻っていません）。入力は行いませんでした。ユーザーに終わったか確認し、終わったと言われたら resume を呼んでからやり直してください。スクリーンショットと読み取り系のツールは使えます。'
const USER_PRESENT_MESSAGE =
  'ユーザーがいま Claude 用のウィンドウを操作しています（ウィンドウが前面でフォーカスされています）。入力は行いませんでした。ユーザーの操作が終わるのを待ってからやり直してください。スクリーンショットと読み取り系のツールは使えます。'

function assertCanInput(
  conn: AgentConnection,
  win: NemoWindow,
  tab: NemoTab,
  page: AgentPage,
  options: {
    /**
     * 今のページが「Claude に操作させないページ」でも通す（navigate / tabs_close）。
     * そのページから**離れる**のは止めない（止めると Claude がそこから動けなくなる）。行き先は navigate が別に見る
     */
    leavingPage?: boolean
  } = {}
): void {
  if (conn.isUserTurn(tab)) throw new Error(USER_TURN_MESSAGE)
  if (isWindowKey(win)) throw new Error(USER_PRESENT_MESSAGE)
  // トークン発行・OAuth の同意・再認証の画面は Claude に操作させない（ユーザーに頼ませる）
  const sensitive = options.leavingPage ? null : sensitivePageKind(tab.webContents?.getURL() ?? tab.url)
  if (sensitive) throw new Error(sensitivePageMessage(sensitive))
  if (page.dialogsBroken) {
    throw new Error(
      '安全のため入力系の操作を止めています（JavaScript ダイアログの横取りが効いていません。Nemo の更新が必要です）。'
    )
  }
}

function assertNoDialog(page: AgentPage): void {
  if (page.dialog) throw new Error(page.dialogMessage())
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function coordinate(value: unknown, name = 'coordinate'): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error(`${name} は [x, y]（スクショの px）で指定してください`)
  }
  return [value[0] as number, value[1] as number]
}

/** ブロックリスト（設定 `agentBlockedHosts`）に当たる URL か。 */
export function isBlockedForAgent(url: string): boolean {
  try {
    return isBlockedAgentHost(new URL(url).hostname, getSettings().agentBlockedHosts)
  } catch {
    return false
  }
}

const BLOCKED_MESSAGE =
  'このサイトは Nemo の設定（agentBlockedHosts）で Claude に開かせないことになっています。'

/**
 * Claude が開いてよい URL に正規化する。**http / https / about:blank だけ**
 * （`javascript:` を navigate に渡すと現在の document で実行され、戻り値は ERR_ABORTED で失敗に見えた。実測）。
 */
export function normalizeAgentUrl(raw: string): string | null {
  const value = raw.trim()
  if (value === BLANK_URL) return BLANK_URL
  let candidate = value
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // ホストだけ（example.com / localhost:3000）なら https を補う。localhost / 127.0.0.1 は http
    candidate = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(candidate)
      ? `http://${candidate}`
      : `https://${candidate}`
  }
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

function tabSummary(conn: AgentConnection, win: NemoWindow, tab: NemoTab): Record<string, unknown> {
  const page = pageFor(tab)
  return {
    tabId: conn.tokenFor(tab),
    url: tab.url,
    title: tab.title === tab.url ? '' : tab.title,
    active: win.activeTabKey === tab.key,
    loading: tab.webContents?.isLoading() ?? false,
    ...(conn.isUserTurn(tab) ? { userTurn: true } : {}),
    ...(page?.dialog ? { dialog: `${page.dialog.type}: ${page.dialog.message.slice(0, 200)}` } : {})
  }
}

/** 読み込みが落ち着くまで待つ（上限つき）。 */
async function waitForLoad(tab: NemoTab, timeoutMs: number): Promise<boolean> {
  const wc = tab.webContents
  if (!wc) return false
  if (!wc.isLoading()) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wc.off('did-stop-loading', done)
      resolve(false)
    }, timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    wc.once('did-stop-loading', done)
  })
}

function tabKeys(win: NemoWindow): Set<string> {
  return new Set(win.normalTabs.map((tab) => tab.key))
}

/** クリックで新しいタブ（popup）が開いたら知らせる。 */
function newTabsNote(conn: AgentConnection, win: NemoWindow, before: Set<string>): string {
  const added = win.normalTabs.filter((tab) => !before.has(tab.key))
  if (added.length === 0) return ''
  return ` 新しいタブが開きました: ${added.map((tab) => conn.tokenFor(tab)).join(', ')}（tabs_context で確認できます）`
}

/* ------------------------------------------------------------------ */

export async function runTool(
  conn: AgentConnection,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'tabs_context':
        return await tabsContext(conn)
      case 'tabs_create':
        return await tabsCreate(conn, args)
      case 'resize_window':
        return await resizeWindow(conn, args)
      case 'resume':
        conn.takeTurnBack()
        return text(
          'Claude の番に戻しました。screenshot でユーザーが何をしたかを確かめてから続けてください。'
        )
      default:
        break
    }
    const { win, tab, page } = conn.resolveTab(args['tabId'])
    return await conn.withTabLock(tab.key, () => runTabTool(conn, win, tab, page, name, args))
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function runTabTool(
  conn: AgentConnection,
  win: NemoWindow,
  tab: NemoTab,
  page: AgentPage,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  conn.restoreIfMinimized()
  switch (name) {
    case 'tabs_close':
      assertCanInput(conn, win, tab, page, { leavingPage: true })
      removeTab(win, tab.key)
      return text('タブを閉じました。')
    case 'navigate':
      assertCanInput(conn, win, tab, page, { leavingPage: true })
      assertNoDialog(page)
      return navigate(tab, page, args)
    case 'computer':
      return computer(conn, win, tab, page, args)
    case 'read_page': {
      assertNoDialog(page)
      const result = await page.page<Record<string, unknown>>('tree', {
        filter: args['filter'],
        depth: args['depth'],
        maxChars: args['max_chars'],
        ref: args['ref_id']
      })
      if (typeof result['error'] === 'string') return fail(result['error'])
      return text(
        `url: ${String(result['url'])}\ntitle: ${String(result['title'])}\nviewport: ${String(result['viewport'])} scroll: ${String(result['scroll'])}\n` +
          `${String(result['tree'])}${result['truncated'] ? '\n…(truncated: ref_id で絞るか depth を下げてください)' : ''}`
      )
    }
    case 'get_page_text': {
      assertNoDialog(page)
      const result = await page.page<Record<string, unknown>>('pageText', { maxChars: args['max_chars'] })
      return text(
        `url: ${String(result['url'])}\ntitle: ${String(result['title'])}\n\n${String(result['text'])}${result['truncated'] ? '\n…(truncated)' : ''}`
      )
    }
    case 'form_input': {
      assertCanInput(conn, win, tab, page)
      assertNoDialog(page)
      const result = await page.withAgentActive(
        () => page.page<Record<string, unknown>>('setValue', str(args['ref']), args['value']),
        { input: true }
      )
      if (typeof result['error'] === 'string') return fail(result['error'])
      return text('値を設定しました。')
    }
    case 'javascript_tool':
      assertCanInput(conn, win, tab, page)
      assertNoDialog(page)
      return javascriptTool(page, args)
    case 'read_console_messages':
      return readConsole(page, args)
    case 'read_network_requests':
      return readNetwork(page, args)
    case 'handle_dialog': {
      if (conn.isUserTurn(tab)) return fail(USER_TURN_MESSAGE)
      const pending = page.dialog
      if (!pending) return text('このタブに答えを待っているダイアログはありません。')
      pending.answer(
        args['accept'] === true,
        typeof args['promptText'] === 'string' ? args['promptText'] : ''
      )
      return text(`${pending.type} に ${args['accept'] === true ? 'OK' : 'キャンセル'} で答えました。`)
    }
    case 'file_upload':
      assertCanInput(conn, win, tab, page)
      assertNoDialog(page)
      return fileUpload(conn, page, args)
    case 'request_user_action': {
      const message = typeof args['message'] === 'string' ? args['message'].trim() : ''
      if (!message) return fail('message を指定してください')
      selectTab(win, tab.key)
      conn.giveTurnToUser(tab, message)
      return text(
        'ユーザーの番にしました（Nemo の Claude 用ウィンドウに依頼文を出し、Dock にバッジを付けました）。' +
          'ユーザーにチャットで同じことを伝え、終わったらチャットで「done」と返してもらうよう頼んで止まってください。ユーザーが終わったと言ったら resume を呼んでから続けてください。'
      )
    }
    default:
      return fail(`Unknown tool: ${name}`)
  }
}

/* ------------------------------------------------------------------ */

async function tabsContext(conn: AgentConnection): Promise<ToolResult> {
  const win = await conn.ensureWindow()
  const tabs = win.normalTabs.map((tab) => tabSummary(conn, win, tab))
  return json({
    window: `Claude — ${conn.label}`,
    userTurn: conn.hasUserTurn(),
    userIsUsingWindow: isWindowKey(win),
    tabs
  })
}

async function tabsCreate(conn: AgentConnection, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = typeof args['url'] === 'string' ? args['url'] : ''
  const target = raw ? normalizeAgentUrl(raw) : BLANK_URL
  if (target === null) return fail('開けるのは http / https の URL だけです。')
  if (isBlockedForAgent(target)) return fail(BLOCKED_MESSAGE)
  const sensitive = sensitivePageKind(target)
  if (sensitive) return fail(sensitivePageMessage(sensitive))
  const reopened = conn.closedByUser
  const win = await conn.ensureWindow({ reopen: true })
  // 窓を作ったばかりで空タブしかないなら、それを使う
  const blank =
    win.normalTabs.length === 1 &&
    win.normalTabs[0].url === BLANK_URL &&
    !win.normalTabs[0].webContents?.isLoading()
  let tab: NemoTab
  if (blank && !reopened && raw === '') {
    tab = win.normalTabs[0]
  } else if (blank) {
    tab = win.normalTabs[0]
    if (target !== BLANK_URL) void tab.webContents?.loadURL(target).catch(() => {})
  } else {
    tab = createTab(win, target, { background: false })
  }
  if (target !== BLANK_URL) await waitForLoad(tab, 20_000)
  return json({ ...(reopened ? { note: 'ウィンドウを作り直しました' } : {}), ...tabSummary(conn, win, tab) })
}

async function resizeWindow(conn: AgentConnection, args: Record<string, unknown>): Promise<ToolResult> {
  const win = await conn.ensureWindow()
  const width = Math.round(Math.min(Math.max(num(args['width'], 1280), 400), 3000))
  const height = Math.round(Math.min(Math.max(num(args['height'], 800), 300), 2000))
  win.baseWindow.setContentSize(width, height)
  return text(`ウィンドウを ${width}x${height} にしました。`)
}

async function navigate(tab: NemoTab, page: AgentPage, args: Record<string, unknown>): Promise<ToolResult> {
  const wc = tab.webContents
  if (!wc) return fail('タブの中身がありません')
  const raw = typeof args['url'] === 'string' ? args['url'] : ''
  page.forceUnload = args['force'] === true
  page.unloadBlocked = false
  try {
    if (raw === 'back' || raw === 'forward') {
      const history = wc.navigationHistory
      if (raw === 'back' ? !history.canGoBack() : !history.canGoForward())
        return fail(`${raw} できる履歴がありません。`)
      if (raw === 'back') history.goBack()
      else history.goForward()
      await sleep(100)
      await waitForLoad(tab, 20_000)
    } else {
      const target = normalizeAgentUrl(raw)
      if (target === null) return fail('開けるのは http / https の URL だけです。')
      if (isBlockedForAgent(target)) return fail(BLOCKED_MESSAGE)
      const sensitive = sensitivePageKind(target)
      if (sensitive) return fail(sensitivePageMessage(sensitive))
      const previous = wc.getURL()
      try {
        await Promise.race([wc.loadURL(target), sleep(30_000)])
      } catch (error) {
        if (page.unloadBlocked) {
          return fail(
            'ページが「サイトを離れますか？」を出したため移動しませんでした（未保存の変更がある可能性）。離れてよければ force: true で呼び直してください。'
          )
        }
        const message = error instanceof Error ? error.message : String(error)
        // ERR_ABORTED はリダイレクト・ダウンロード等でも出る。読み込めた先があれば成功扱い
        if (!/ERR_ABORTED/.test(message))
          return fail(`読み込みに失敗しました: ${message.replace(/\(.*\)/, '').slice(0, 200)}`)
      }
      // 作った直後の空タブは about:blank の読み込みが同時に終わり、loadURL が先に返ることがある。
      // URL が変わるまで少し待ってから、読み込みの完了を待つ
      for (let i = 0; i < 100 && previous !== target && wc.getURL() === previous; i += 1) await sleep(50)
      await waitForLoad(tab, 20_000)
    }
  } finally {
    page.forceUnload = false
  }
  return text(`url: ${wc.getURL()}\ntitle: ${wc.getTitle()}`)
}

/* ------------------------------------------------------------------ */

async function computer(
  conn: AgentConnection,
  win: NemoWindow,
  tab: NemoTab,
  page: AgentPage,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const action = str(args['action'])
  const readOnly = action === 'screenshot' || action === 'zoom' || action === 'wait'
  if (!readOnly) {
    assertCanInput(conn, win, tab, page)
    assertNoDialog(page)
  }
  // 見えていないタブは前面にしてから操作する（選ばれていないタブは View が隠れている）。
  // **ユーザーの番・ユーザーが窓にいるときは切り替えない**（ログイン中の画面を裏へ回さない。
  // 隠れたタブのスクショもフォーカスエミュレーションで撮れる）
  const userHere = conn.isUserTurn(tab) || isWindowKey(win) || conn.hasUserTurn()
  if (win.activeTabKey !== tab.key && !userHere) selectTab(win, tab.key)

  return page.withAgentActive(
    async () => {
      const pointFor = async (): Promise<{ x: number; y: number }> => {
        if (typeof args['ref'] === 'string' && args['ref']) {
          const result = await page.page<{ x?: number; y?: number; error?: string }>('point', args['ref'])
          if (result.error || result.x === undefined || result.y === undefined) {
            throw new Error(result.error ?? 'ref の位置が取れません')
          }
          return { x: result.x, y: result.y }
        }
        return page.toCss(coordinate(args['coordinate']))
      }

      switch (action) {
        case 'screenshot': {
          const shot = await page.screenshot()
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
              {
                type: 'text',
                text: `screenshot ${shot.width}x${shot.height}（座標はこの画像の px で指定してください）${page.dialog ? `\n${page.dialogMessage()}` : ''}`
              }
            ]
          }
        }
        case 'zoom': {
          const region = args['region']
          if (!Array.isArray(region) || region.length !== 4)
            return fail('region は [x0, y0, x1, y1] で指定してください')
          const [x0, y0] = [page.toCss([region[0] as number, region[1] as number])].map((p) => [p.x, p.y])[0]
          const [x1, y1] = [page.toCss([region[2] as number, region[3] as number])].map((p) => [p.x, p.y])[0]
          const shot = await page.screenshot({
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            width: Math.max(Math.abs(x1 - x0), 1),
            height: Math.max(Math.abs(y1 - y0), 1)
          })
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
              {
                type: 'text',
                text: `zoom ${shot.width}x${shot.height}（拡大図。座標の指定には使わないでください）`
              }
            ]
          }
        }
        case 'wait': {
          await sleep(Math.min(Math.max(num(args['duration'], 1), 0), 10) * 1000)
          return text('待ちました。')
        }
        case 'left_click':
        case 'right_click':
        case 'double_click':
        case 'triple_click': {
          const point = await pointFor()
          const before = tabKeys(win)
          await page.click(point.x, point.y, {
            button: action === 'right_click' ? 'right' : 'left',
            clickCount: action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1,
            modifiers: parseModifiers(typeof args['modifiers'] === 'string' ? args['modifiers'] : undefined)
          })
          await sleep(150)
          return text(
            `クリックしました。${newTabsNote(conn, win, before)}${page.dialog ? `\n${page.dialogMessage()}` : ''}`
          )
        }
        case 'hover': {
          const point = await pointFor()
          await page.mouse('mouseMoved', point.x, point.y)
          return text('マウスを移動しました。')
        }
        case 'left_click_drag': {
          const start = page.toCss(coordinate(args['start_coordinate'], 'start_coordinate'))
          const end = page.toCss(coordinate(args['coordinate']))
          await page.mouse('mouseMoved', start.x, start.y)
          await page.mouse('mousePressed', start.x, start.y, { button: 'left', clickCount: 1 })
          const steps = 10
          for (let i = 1; i <= steps; i += 1) {
            await page.mouse(
              'mouseMoved',
              start.x + ((end.x - start.x) * i) / steps,
              start.y + ((end.y - start.y) * i) / steps,
              {
                button: 'left',
                buttons: 1
              }
            )
          }
          await page.mouse('mouseReleased', end.x, end.y, { button: 'left', clickCount: 1 })
          return text('ドラッグしました。')
        }
        case 'type': {
          const value = typeof args['text'] === 'string' ? args['text'] : ''
          if (!value) return fail('text を指定してください')
          await page.send('Input.insertText', { text: value })
          return text('入力しました。')
        }
        case 'key': {
          const value = typeof args['text'] === 'string' ? args['text'] : ''
          let strokes
          try {
            strokes = parseKeySequence(value)
          } catch (error) {
            if (error instanceof KeyParseError) return fail(error.message)
            throw error
          }
          const repeat = Math.min(Math.max(Math.round(num(args['repeat'], 1)), 1), 100)
          for (let n = 0; n < repeat; n += 1) {
            for (const stroke of strokes) {
              const base = {
                key: stroke.key,
                code: stroke.code,
                windowsVirtualKeyCode: stroke.keyCode,
                nativeVirtualKeyCode: stroke.keyCode,
                modifiers: stroke.modifiers
              }
              await page.send('Input.dispatchKeyEvent', {
                ...base,
                type: stroke.text ? 'keyDown' : 'rawKeyDown',
                ...(stroke.text ? { text: stroke.text, unmodifiedText: stroke.text } : {}),
                ...(stroke.commands.length > 0 ? { commands: stroke.commands } : {})
              })
              await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
            }
          }
          await sleep(50)
          return text(`キーを送りました: ${value}${page.dialog ? `\n${page.dialogMessage()}` : ''}`)
        }
        case 'scroll': {
          const view = await page.viewport()
          const point =
            args['coordinate'] || args['ref'] ? await pointFor() : { x: view.width / 2, y: view.height / 2 }
          const amount = Math.min(Math.max(Math.round(num(args['scroll_amount'], 3)), 1), 10) * 100
          const direction = str(args['scroll_direction'], 'down')
          const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
          const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
          await page.mouse('mouseWheel', point.x, point.y, { deltaX, deltaY })
          await sleep(150)
          return text('スクロールしました。')
        }
        case 'scroll_to': {
          const ref = typeof args['ref'] === 'string' ? args['ref'] : ''
          if (!ref) return fail('ref を指定してください')
          const result = await page.page<{ error?: string }>('scrollTo', ref)
          if (result.error) return fail(result.error)
          return text('スクロールしました。')
        }
        default:
          return fail(`未対応の action: ${action}`)
      }
    },
    { input: !readOnly }
  )
}

/* ------------------------------------------------------------------ */

async function javascriptTool(page: AgentPage, args: Record<string, unknown>): Promise<ToolResult> {
  const code = typeof args['text'] === 'string' ? args['text'] : ''
  if (!code.trim()) return fail('text を指定してください')
  const state = await page.page<{ tainted?: boolean }>('state')
  if (state.tainted) {
    return fail(
      'このページではユーザーがパスワード等を入力したため、javascript_tool は使えません（ページを移動すると使えるようになります）。read_page / get_page_text / screenshot を使ってください。'
    )
  }
  return page.withAgentActive(
    async () => {
      const result = await page.send<{
        result?: { value?: unknown; description?: string; type?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }>('Runtime.evaluate', {
        expression: code,
        replMode: true,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
        timeout: 10_000
      })
      if (page.dialog) return text(`実行中にダイアログが出ました。${page.dialogMessage()}`)
      if (result.exceptionDetails) {
        return fail(
          `例外: ${(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '').slice(0, 2000)}`
        )
      }
      const value = result.result?.value
      let out: string
      if (value === undefined) out = result.result?.description ?? 'undefined'
      else if (typeof value === 'string') out = value
      else {
        try {
          out = JSON.stringify(value, null, 1)
        } catch {
          out = Object.prototype.toString.call(value)
        }
      }
      const limit = 30_000
      return text(out.length > limit ? `${out.slice(0, limit)}\n…(truncated)` : out)
    },
    { input: true }
  )
}

async function readConsole(page: AgentPage, args: Record<string, unknown>): Promise<ToolResult> {
  const first = page.console === null
  await page.startConsole()
  const state = await page.page<{ tainted?: boolean }>('state').catch(() => ({ tainted: false }))
  if (state.tainted) {
    // その document の記録は捨てる（移動して taint が解けた後に返さない）
    if (page.console) page.console.length = 0
    return fail('このページではユーザーがパスワード等を入力したため、コンソールの記録は返しません。')
  }
  let entries = page.console ?? []
  if (args['onlyErrors'] === true)
    entries = entries.filter((entry) => entry.level === 'error' || entry.level === 'assert')
  if (typeof args['pattern'] === 'string' && args['pattern']) {
    let re: RegExp
    try {
      re = new RegExp(args['pattern'])
    } catch {
      return fail('pattern が正規表現として読めません')
    }
    entries = entries.filter((entry) => re.test(entry.text))
  }
  const limit = Math.min(Math.max(Math.round(num(args['limit'], 100)), 1), 500)
  const lines = entries.slice(-limit).map((entry) => `[${entry.level}] ${entry.text}`)
  if (args['clear'] === true && page.console) page.console.length = 0
  if (first)
    return text(
      '記録を始めました（これ以降のメッセージが残ります）。' + (lines.length ? `\n${lines.join('\n')}` : '')
    )
  return text(lines.length ? lines.join('\n') : '（メッセージはありません）')
}

async function readNetwork(page: AgentPage, args: Record<string, unknown>): Promise<ToolResult> {
  const first = page.network === null
  await page.startNetwork()
  let entries = [...(page.network?.values() ?? [])]
  if (typeof args['urlPattern'] === 'string' && args['urlPattern']) {
    const needle = args['urlPattern']
    entries = entries.filter((entry) => entry.url.includes(needle))
  }
  const limit = Math.min(Math.max(Math.round(num(args['limit'], 100)), 1), 500)
  const lines = entries
    .slice(-limit)
    .map(
      (entry) =>
        `${entry.method} ${entry.status ?? (entry.failed ? `failed(${entry.failed})` : 'pending')} ${entry.type} ${entry.url.slice(0, 500)}`
    )
  if (args['clear'] === true && page.network) page.network.clear()
  if (first)
    return text(
      '記録を始めました（これ以降のリクエストが残ります）。' + (lines.length ? `\n${lines.join('\n')}` : '')
    )
  return text(lines.length ? lines.join('\n') : '（リクエストはありません）')
}

async function fileUpload(
  conn: AgentConnection,
  page: AgentPage,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const ref = typeof args['ref'] === 'string' ? args['ref'] : ''
  const files = args['files']
  if (!ref) return fail('ref を指定してください')
  if (!Array.isArray(files) || files.length === 0)
    return fail('ファイルがありません（ブリッジが読めなかった可能性）')
  const dir = conn.stagingDir()
  const paths: string[] = []
  for (const [index, file] of (files as { name?: unknown; data?: unknown }[]).entries()) {
    const name = path.basename(typeof file.name === 'string' && file.name ? file.name : 'upload.bin')
    if (typeof file.data !== 'string') return fail('ファイルの中身が読めません')
    // 同名のファイル（別ディレクトリの a/x.png と b/x.png）が上書きし合わないよう、1 個ずつ別の置き場にする。
    // ファイル名はサイトに見えるので変えない
    const slot = path.join(dir, String(index))
    fs.mkdirSync(slot, { recursive: true, mode: 0o700 })
    const target = path.join(slot, name)
    fs.writeFileSync(target, Buffer.from(file.data, 'base64'), { mode: 0o600 })
    paths.push(target)
  }
  const nonce = randomBytes(8).toString('hex')
  return page.withAgentActive(
    async () => {
      const marked = await page.page<{ error?: string; multiple?: boolean }>('markFileInput', ref, nonce)
      if (marked.error) return fail(marked.error)
      if (!marked.multiple && paths.length > 1) {
        await page.page('unmarkFileInput', nonce)
        return fail('この欄は 1 ファイルしか受け付けません')
      }
      try {
        const doc = await page.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
        const found = await page.send<{ nodeId: number }>('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: `[data-nemo-agent-upload="${nonce}"]`
        })
        if (!found.nodeId) return fail('ファイル欄が見つかりません（shadow DOM の中は未対応）')
        await page.send('DOM.setFileInputFiles', { files: paths, nodeId: found.nodeId })
      } finally {
        await page.page('unmarkFileInput', nonce).catch(() => {})
      }
      return text(`${paths.length} 個のファイルを添付しました。`)
    },
    { input: true }
  )
}
