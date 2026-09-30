import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, session } from 'electron'
import { log } from '../log.js'
import { AGENT_PARTITION } from '../paths.js'
import { forgetSessionCookies } from '../store/session-cookies.js'
import {
  clearAgentPresentationDeferral,
  createTab,
  presentAgentWindow,
  removeWindow,
  setAgentHooks,
  windowsById,
  type NemoWindow
} from '../registry.js'
import { getSettings, onSettingsChanged } from '../store/settings.js'
import { isAgentContents, setAgentFillHooks } from './contents.js'
import { agentFillHooks, noteAgentContentsCreated } from './fill-gate.js'
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

  // kypr・フォーム自動入力がエージェント窓のページに値を入れるときの判定（contents.ts の口に実体を差し込む）
  setAgentFillHooks(agentFillHooks)

  // agent セッションの WebContents（タブ・popup の子）が生まれたら操作口を付ける。
  // `-run-dialog` の差し替えは生成直後でないと間に合わない
  app.on('web-contents-created', (_event, wc) => {
    if (!isAgentContents(wc)) return
    adoptAgentContents(wc)
    // opener を生まれた時点で記録する（kypr が「JS を実行したページが開いたタブ」に入れないため。fill-gate.ts）
    noteAgentContentsCreated(wc)
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

/**
 * Claude in Nemo のプロファイル（`persist:nemo-agent`）の cookie・サイトデータを全て消す（設定画面のボタン）。
 *
 * 引き継ぎでユーザーが入れたログインは、専用プロファイルでも残り続ける（再起動もまたぐ）。
 * 何か変なことが起きたときに、Claude が使えるログインをまとめて無くす逃げ道。普段のプロファイルには触れない。
 * 以前はサイト単位の一覧と消去を置いていたが、広告の第三者 cookie で埋まって判断に使えなかったので全消去だけにした。
 * 開いている Claude のタブは表示が残るが、次の通信からはログアウトした状態になる。
 * @returns 消したあとに残っている cookie の件数（0 のはず。検証用）
 */
export async function clearAgentData(): Promise<number> {
  const agentSession = session.fromPartition(AGENT_PARTITION)
  // dataTypes を省くと cookie・localStorage・IndexedDB・キャッシュ・Service Worker 等の全種
  await agentSession.clearData()
  await agentSession.clearAuthCache()
  // 再起動をまたいで戻すための控え（session-cookies.json）からも落とす
  forgetSessionCookies('agent')
  const left = (await agentSession.cookies.get({})).length
  log('agent.data_cleared', { left })
  return left
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

export { allConnections }
export { setAgentKeyForVerify } from './fill-gate.js'
