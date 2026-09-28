import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, type WebContents } from 'electron'
import { log } from '../log.js'
import {
  clearAgentPresentationDeferral,
  createTab,
  findTabByWebContents,
  presentAgentWindow,
  removeWindow,
  setAgentHooks,
  windowsById,
  type NemoWindow
} from '../registry.js'
import { getSettings, onSettingsChanged } from '../store/settings.js'
import { isAgentContents } from './contents.js'
import {
  adoptAgentContents,
  allConnections,
  connectionForWindow,
  isWindowKey,
  makeWindowFocusable,
  pageFor
} from './connection.js'
import { startAgentServer, stopAgentServer } from './server.js'
import { normalizeAgentUrl } from './tools.js'

/**
 * Claude in Nemo（Claude Code から Nemo を操作する口）の入口。計画 2026-09-28。
 *
 * - 設定「Claude Code からの操作を許可」（`agentEnabled`、既定 OFF）が ON のときだけ socket を開く
 * - registry へ差し込む処理（離脱確認・窓とタブの後始末）はここで注入する（registry → agent の import を作らない）
 */
export function startAgent(): void {
  // 前回落ちたときに残った file_upload の置き場（接続の後始末が走らなかった分）
  fs.rmSync(path.join(app.getPath('userData'), 'agent-upload'), { recursive: true, force: true })
  setAgentHooks({
    decideUnload(tab) {
      const page = pageFor(tab)
      if (page?.forceUnload) return true
      const win = tab.window
      const conn = connectionForWindow(win)
      // ユーザーがいる（その窓を操作中 / ユーザーの番）なら、通常の窓と同じく聞く（同期でしか答えられない）
      if (!win.isDestroyed && ((conn?.isUserTurn(tab) ?? false) || isWindowKey(win))) {
        return (
          dialog.showMessageBoxSync(win.baseWindow, {
            type: 'question',
            buttons: ['このページを離れる', 'キャンセル'],
            defaultId: 0,
            cancelId: 1,
            message: 'サイトを離れますか？',
            detail: '行った変更が保存されない可能性があります。'
          }) === 0
        )
      }
      // Claude の操作中は既定で残る（未保存の変更を黙って捨てない）。navigate の force でだけ離れる
      if (page) page.unloadBlocked = true
      return false
    },
    windowClosed(win) {
      connectionForWindow(win)?.windowClosed(win)
    },
    tabRemoved(win, tab) {
      connectionForWindow(win)?.forgetTab(tab)
    },
    hasAgentWindow: () => agentWindows().length > 0,
    openUrlInAgentWindow
  })

  // agent セッションの WebContents（タブ・popup の子）が生まれたら操作口を付ける。
  // `-run-dialog` の差し替えは生成直後でないと間に合わない
  app.on('web-contents-created', (_event, wc) => {
    if (isAgentContents(wc)) adoptAgentContents(wc)
  })

  let enabled = getSettings().agentEnabled
  if (enabled) void startAgentServer()
  onSettingsChanged((settings) => {
    if (settings.agentEnabled === enabled) return
    enabled = settings.agentEnabled
    log('agent.setting_changed', { enabled })
    if (enabled) void startAgentServer()
    else stopAgentServer()
  })
}

export function stopAgent(): void {
  stopAgentServer()
}

/** エージェント窓の「終了」ボタン（ユーザーが閉じたのと同じ扱い）。 */
export function endFromUi(win: NemoWindow): void {
  if (win.isAgent) removeWindow(win)
}

/**
 * ユーザーの操作で、URL を Claude のウィンドウ（エージェント用プロファイル）で開く。
 * **MCP からは呼べない**（右クリック・小窓のボタンからだけ）。マジックリンク型のログインで、
 * メールのリンクが常用側で開いてしまうのを Claude のウィンドウへ運ぶための口。
 */
export function openUrlInAgentWindow(url: string): boolean {
  const target = normalizeAgentUrl(url)
  if (target === null) return false
  const candidates = agentWindows()
  const win =
    candidates.find((candidate) => connectionForWindow(candidate)?.hasUserTurn()) ??
    candidates[candidates.length - 1]
  if (!win) return false
  createTab(win, target)
  log('agent.open_in_agent_window', { windowId: win.id })
  return true
}

/** 今あるエージェント窓（新しい順ではなく作った順）。 */
export function agentWindows(): NemoWindow[] {
  return [...windowsById.values()].filter((win) => !win.isDestroyed && win.isAgent)
}

/**
 * エージェント窓を前面に出す（**ユーザー操作からだけ呼ぶ**。メニュー・サイドバーの行）。
 * ユーザーの番の窓を優先する。
 */
export function showAgentWindow(windowId?: number): void {
  const candidates = agentWindows()
  const target =
    (windowId !== undefined ? candidates.find((win) => win.id === windowId) : undefined) ??
    candidates.find((win) => connectionForWindow(win)?.hasUserTurn()) ??
    candidates[candidates.length - 1]
  if (!target) return
  clearAgentPresentationDeferral(target)
  if (target.baseWindow.isMinimized()) presentAgentWindow(target)
  makeWindowFocusable(target)
  target.baseWindow.show()
  target.baseWindow.focus()
}

/**
 * **パスワードを入れる口**（計画 Phase 6）。Nemo の UI 起点（ページの外。CDP からは届かない）で
 * エージェント窓のページに資格情報を入れたら、入れた側がこれを呼ぶ。
 * ページを taint し（javascript_tool を断る）、値を覚えて read_page / get_page_text / スクショで伏せる。
 * 初版には呼び出し元が無い（自作のパスワードマネージャーを差し込む先）。
 */
export async function noteCredentialsEntered(wc: WebContents, values: string[]): Promise<void> {
  if (!isAgentContents(wc)) return
  const found = findTabByWebContents(wc)
  const page = found ? pageFor(found.tab) : null
  await page?.page('rememberSecrets', values)
}

export { allConnections }
