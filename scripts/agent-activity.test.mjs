import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentActivityLabel } from '../src/shared/agent-activity.js'
import { AGENT_TOOL_NAMES } from '../src/shared/agent-tools.js'

test('navigate は行き先のホストだけを出す（パス・クエリは出さない）', () => {
  assert.equal(
    agentActivityLabel('navigate', { url: 'https://dash.cloudflare.com/abc?token=x' }),
    'dash.cloudflare.com を開いています'
  )
  assert.equal(agentActivityLabel('navigate', { url: 'example.com/path' }), 'example.com を開いています')
  assert.equal(agentActivityLabel('navigate', { url: 'back' }), '前のページに戻っています')
  assert.equal(agentActivityLabel('navigate', { url: 'forward' }), '次のページに進んでいます')
  assert.equal(agentActivityLabel('navigate', { url: '' }), 'ページを開いています')
  assert.equal(agentActivityLabel('navigate', {}), 'ページを開いています')
  const long = `${'a'.repeat(60)}.example.com`
  assert.equal(agentActivityLabel('navigate', { url: `https://${long}/` }).length <= 50, true)
})

test('computer は action ごとの文言、知らない action は「操作しています」', () => {
  assert.equal(agentActivityLabel('computer', { action: 'screenshot' }), 'スクリーンショット')
  assert.equal(agentActivityLabel('computer', { action: 'left_click' }), 'クリック')
  assert.equal(agentActivityLabel('computer', { action: 'type', text: 'secret' }), '入力しています')
  assert.equal(agentActivityLabel('computer', { action: 'weird' }), '操作しています')
})

test('入力の中身・スクリプトの中身は文言に出ない', () => {
  const label = agentActivityLabel('javascript_tool', { text: 'document.cookie' })
  assert.equal(label.includes('cookie'), false)
  assert.equal(agentActivityLabel('form_input', { value: 'hunter2' }).includes('hunter2'), false)
})

test('引き継ぎのツールは出さない。それ以外のツールはすべて文言を持つ', () => {
  assert.equal(agentActivityLabel('request_user_action', {}), null)
  assert.equal(agentActivityLabel('resume', {}), null)
  for (const name of AGENT_TOOL_NAMES) {
    if (name === 'request_user_action' || name === 'resume') continue
    assert.equal(typeof agentActivityLabel(name, {}), 'string', name)
  }
})
