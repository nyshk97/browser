import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS, isValidAccelerator, resolveKeybindings } from '../src/shared/keybindings.js'

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
