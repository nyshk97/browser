import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDetail } from '../src/shared/log-redact.js'

/**
 * Claude in Nemo の診断ログ（`agent.*`）の detail が、`sanitizeDetail` を通しても**変わらない**こと。
 * キー名が伏せ字の対象（session / text / input / value / auth …）に当たると `[redacted]` になり、
 * 診断に使えなくなる（リポジトリ CLAUDE.md「`log()` に新しいイベントを足すとき」）。
 * ここに並べたのは src/main/agent/ と downloads.ts が実際に出している形。
 */
const DETAILS = {
  'agent.connected': { conn: 1 },
  'agent.tool': { conn: 1, tool: 'navigate', ok: true, ms: 12 },
  'agent.disconnected': { conn: 1, reason: 'closed' },
  'agent.handoff': { conn: 1, to: 'claude', via: 'button' },
  'agent.window_presented': { windowId: 2 },
  'agent.window_deferred': { windowId: 2 },
  'agent.window_user_focus': { windowId: 2 },
  'agent.window_closed_by_user': { conn: 1 },
  'agent.dialog': { type: 'confirm' },
  'agent.dialog_override_skipped': { listeners: 2 },
  'agent.debugger_detached': { reason: 'target closed' },
  'agent.navigation_blocked': { reason: 'blocklist' },
  'agent.socket_refused': { reason: 'insecure_directory' },
  'agent.setting_changed': { enabled: true },
  'agent.site_cleared': { n: 3 },
  'agent.download': { ok: true, bytes: 64 },
  'agent.open_in_agent_window': { windowId: 2 },
  'agent.popup_tab': {
    key: '029327c8-49e8-477c-88c1-6502d51a0063',
    windowId: 2,
    target: 'http://127.0.0.1:55133'
  }
}

for (const [event, detail] of Object.entries(DETAILS)) {
  test(`${event} の detail は伏せ字・[deep]・切り詰めを受けない`, () => {
    assert.deepEqual(sanitizeDetail(detail), detail)
  })
}
