import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMANDS,
  holdModifiersFor,
  isValidAccelerator,
  resolveKeybindings
} from '../src/shared/keybindings.js'

test('既定のアクセラレータはすべて妥当', () => {
  for (const command of COMMANDS) {
    assert.ok(isValidAccelerator(command.accelerator), `${command.id}: ${command.accelerator}`)
  }
})

test('既定のアクセラレータは重複しない', () => {
  const { problems } = resolveKeybindings({})
  assert.deepEqual(problems, [])
})

test('不正なアクセラレータは採用しない', () => {
  const { bindings, problems } = resolveKeybindings({ 'close-tab': 'Cmd+' })
  assert.equal(bindings['close-tab'], 'CmdOrCtrl+W')
  assert.equal(problems[0]?.reason, 'invalid_accelerator')
})

test('知らないコマンドは弾く', () => {
  const { problems } = resolveKeybindings({ 'no-such-command': 'CmdOrCtrl+K' })
  assert.equal(problems[0]?.reason, 'unknown_command')
})

test('重複した割り当ては両方とも既定に戻す', () => {
  const { bindings, problems } = resolveKeybindings({ 'pin-tab': 'CmdOrCtrl+R' })
  assert.equal(bindings['pin-tab'], 'CmdOrCtrl+D')
  assert.equal(bindings['reload'], 'CmdOrCtrl+R')
  assert.equal(problems.length, 2)
  assert.ok(problems.every((p) => p.reason === 'duplicate_accelerator'))
})

test('空文字は「割り当てなし」として通す', () => {
  const { bindings, problems } = resolveKeybindings({ 'pin-tab': '' })
  assert.equal(bindings['pin-tab'], '')
  assert.deepEqual(problems, [])
})

/* --- 押しっぱなしで確定するタブスイッチャー（⌃M） --- */

test('直近のタブへ切り替えの既定は ⌃M', () => {
  const { bindings } = resolveKeybindings({})
  assert.equal(bindings['switch-tab'], 'Control+M')
})

test('離したら確定する修飾キーを取り出す', () => {
  assert.deepEqual(holdModifiersFor('Control+M'), ['Control'])
  assert.deepEqual(holdModifiersFor('Alt+Tab'), ['Alt'])
  assert.deepEqual(holdModifiersFor('CmdOrCtrl+M', 'darwin'), ['Meta'])
  assert.deepEqual(holdModifiersFor('CmdOrCtrl+M', 'win32'), ['Control'])
})

test('Shift は押しっぱなしの土台に数えない', () => {
  // 先に ⇧ を離しただけで確定してしまうと「⇧ を足して逆回し」ができなくなる
  assert.deepEqual(holdModifiersFor('Control+Shift+M'), ['Control'])
  assert.deepEqual(holdModifiersFor('Shift+M'), [])
})

test('修飾キーの無い割り当ては押しっぱなしにできない', () => {
  assert.deepEqual(holdModifiersFor('F5'), [])
  assert.deepEqual(holdModifiersFor(''), [])
})
