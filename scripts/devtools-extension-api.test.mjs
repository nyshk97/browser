// `src/shared/devtools-extension-api.js` が組み立てるスクリプトを、凍った chrome を持つ偽の frame（vm）で走らせる。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { buildDevToolsFrameSource } from '../src/shared/devtools-extension-api.js'

const ORIGIN = 'chrome-extension://aaaa'

/** DevTools の画面が渡すスクリプトと同じ形（strict mode で `chrome.devtools` を足す。既にあれば何もしない） */
const DEVTOOLS_SCRIPT =
  "(function(injectedScriptId){ 'use strict'; const chrome = window.chrome || {}; if (Object.getOwnPropertyDescriptor(chrome, 'devtools')) return; chrome.devtools = { injectedScriptId, runs: (globalThis.runs = (globalThis.runs ?? 0) + 1) }; })"

/** ece の preload を通った後の frame（`chrome` が凍っている） */
function frame({ protocol = 'chrome-extension:', origin = ORIGIN, frozen = true } = {}) {
  const runtime = { id: 'aaaa' }
  const chrome = Object.defineProperty({ runtime }, 'tabs', { value: { query() {} }, enumerable: false })
  if (frozen) Object.freeze(chrome)
  const errors = []
  const context = vm.createContext({
    location: { protocol, origin },
    crypto: { randomUUID: () => 'uuid-1' },
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    chrome
  })
  context.window = context
  return { context, runtime, errors, original: chrome }
}

const run = (context, source) => vm.runInContext(source, context)

test('凍った chrome でも chrome.devtools が入り、元の中身を残したまま凍り直す', () => {
  const { context, runtime, errors, original } = frame()
  run(context, buildDevToolsFrameSource([], { [ORIGIN]: DEVTOOLS_SCRIPT }))
  assert.deepEqual(errors, [])
  assert.notEqual(context.chrome, original)
  assert.equal(context.chrome.devtools.injectedScriptId, 'uuid-1')
  assert.equal(context.chrome.runtime, runtime)
  assert.equal(typeof context.chrome.tabs.query, 'function', '列挙されないプロパティも写す')
  assert.equal(Object.isFrozen(context.chrome), true)
})

test('補完も凍った chrome に入り、1 つが落ちても残りと chrome.devtools は入る', () => {
  const { context, errors } = frame()
  const shims = [
    "throw new Error('boom')",
    "Object.defineProperty(globalThis.chrome, 'debugger', { value: {}, enumerable: true })"
  ]
  run(context, buildDevToolsFrameSource(shims, { [ORIGIN]: DEVTOOLS_SCRIPT }))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /拡張 frame の補完に失敗した.*boom/)
  assert.equal(typeof context.chrome.debugger, 'object')
  assert.equal(typeof context.chrome.devtools, 'object')
})

test('凍っていない chrome は差し替えず、凍らせもしない', () => {
  const { context, original } = frame({ frozen: false })
  run(context, buildDevToolsFrameSource([], { [ORIGIN]: DEVTOOLS_SCRIPT }))
  assert.equal(context.chrome, original)
  assert.equal(typeof context.chrome.devtools, 'object')
  assert.equal(Object.isFrozen(context.chrome), false)
})

test('origin が合わない拡張のスクリプトは走らせない', () => {
  const { context, original } = frame({ origin: 'chrome-extension://bbbb' })
  run(context, buildDevToolsFrameSource([], { [ORIGIN]: DEVTOOLS_SCRIPT }))
  assert.equal(context.chrome.devtools, undefined)
  assert.deepEqual(Object.keys(context.chrome), Object.keys(original))
})

test('拡張ページ以外の frame では何もしない（補完も走らせない）', () => {
  const { context, original } = frame({ protocol: 'devtools:', origin: 'devtools://devtools' })
  run(context, buildDevToolsFrameSource(['globalThis.touched = true'], { [ORIGIN]: DEVTOOLS_SCRIPT }))
  assert.equal(context.chrome, original)
  assert.equal(context.touched, undefined)
})

test('Electron 側の注入が後から走っても二重にならない', () => {
  const { context } = frame()
  run(context, buildDevToolsFrameSource([], { [ORIGIN]: DEVTOOLS_SCRIPT }))
  run(context, `${DEVTOOLS_SCRIPT}('electron')`)
  assert.equal(context.runs, 1)
  assert.equal(context.chrome.devtools.injectedScriptId, 'uuid-1')
})

test('chrome-extension 以外の origin のスクリプトは埋め込まない', () => {
  const source = buildDevToolsFrameSource([], { 'https://evil.example': DEVTOOLS_SCRIPT, [ORIGIN]: '' })
  assert.equal(source.includes('evil.example'), false)
  assert.equal(source.includes('injectedScriptId'), false)
})
