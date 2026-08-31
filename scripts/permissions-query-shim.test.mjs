// `src/shared/permissions-query-shim.js` を偽の navigator で直接叩く。
//
// installer は `contextBridge.executeInMainWorld({ func })` で**文字列化されて**ページに入るので、
// 判定ロジックを別関数に切り出してそれだけをテストすると出荷されないコードを検証することになる。
// installer 1 本を偽の `globalThis.navigator` に当てて、ページから見える挙動ごと検証する。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installPermissionsQueryShim } from '../src/shared/permissions-query-shim.js'

/** 偽の PermissionStatus。実物と同じく change リスナーを持てる。 */
function fakeStatus(state) {
  const listeners = new Set()
  return {
    state,
    onchange: null,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener)
    },
    _listeners: listeners
  }
}

/**
 * 偽の navigator を組み立てる。
 * @param {{ state?: string, devices?: { kind: string, label: string }[], enumerateError?: Error,
 *           noMediaDevices?: boolean, gumResult?: { kind: string }[] | Error }} opts
 */
function fakeNavigator({ state = 'granted', devices = [], enumerateError, noMediaDevices, gumResult } = {}) {
  const status = fakeStatus(state)
  const deviceChangeListeners = new Set()
  const nav = {
    permissions: {
      query: async (descriptor) => {
        nav._queried.push(descriptor)
        return status
      }
    },
    _status: status,
    _queried: [],
    _fireDeviceChange: () => {
      for (const listener of deviceChangeListeners) listener()
    }
  }
  if (!noMediaDevices) {
    nav.mediaDevices = {
      enumerateDevices: async () => {
        if (enumerateError) throw enumerateError
        return devices
      },
      addEventListener: (type, listener) => {
        if (type === 'devicechange') deviceChangeListeners.add(listener)
      },
      removeEventListener: () => {},
      getUserMedia: async () => {
        if (gumResult instanceof Error) throw gumResult
        return { getTracks: () => (gumResult ?? []).map((track) => ({ kind: track.kind })) }
      }
    }
  }
  return nav
}

/** installer は `globalThis.navigator` を見るので、差し替えてから当てる。 */
function withNavigator(nav, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true })
  try {
    installPermissionsQueryShim()
    return fn()
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
}

/** マイクロタスクを流す（reevaluate は async）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('granted + label 全空 → prompt に読み替える', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [{ kind: 'audioinput', label: '' }] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'prompt')
  })
})

test('granted + label あり → granted のまま', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [{ kind: 'audioinput', label: 'Built-in Mic' }] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'granted')
  })
})

test('別 kind の label は効かない（camera の label があっても microphone は prompt）', async () => {
  const nav = fakeNavigator({
    state: 'granted',
    devices: [
      { kind: 'audioinput', label: '' },
      { kind: 'videoinput', label: 'FaceTime HD' }
    ]
  })
  await withNavigator(nav, async () => {
    assert.equal((await nav.permissions.query({ name: 'microphone' })).state, 'prompt')
    assert.equal((await nav.permissions.query({ name: 'camera' })).state, 'granted')
  })
})

test('denied は素通し', async () => {
  const nav = fakeNavigator({ state: 'denied', devices: [] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'camera' })
    assert.equal(status.state, 'denied')
  })
})

test('prompt は素通し', async () => {
  const nav = fakeNavigator({ state: 'prompt', devices: [] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'prompt')
  })
})

test('デバイス 0 台 → prompt（fail-safe 側に倒す）', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'prompt')
  })
})

test('microphone / camera 以外の name は実 status をそのまま返す（ファサードで包まない）', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'notifications' })
    assert.equal(status, nav._status)
  })
})

test('mediaDevices が無い（素の http）なら query に触らない', async () => {
  const nav = fakeNavigator({ noMediaDevices: true })
  const originalQuery = nav.permissions.query
  await withNavigator(nav, async () => {
    assert.equal(nav.permissions.query, originalQuery)
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'granted')
  })
})

test('enumerateDevices が reject したら実 status を素通しする', async () => {
  const nav = fakeNavigator({ state: 'granted', enumerateError: new Error('boom') })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status, nav._status)
    assert.equal(status.state, 'granted')
  })
})

test('getUserMedia 成功後は granted を素通しし、change が飛ぶ', async () => {
  const nav = fakeNavigator({
    state: 'granted',
    devices: [{ kind: 'audioinput', label: '' }],
    gumResult: [{ kind: 'audio' }]
  })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'prompt')
    const fired = []
    status.addEventListener('change', () => fired.push(status.state))
    status.onchange = () => fired.push(`onchange:${status.state}`)

    await nav.mediaDevices.getUserMedia({ audio: true })
    await flush()

    // 「一度だけ許可」（remember なし）でも読み替えが外れる
    assert.equal(status.state, 'granted')
    assert.deepEqual(fired, ['granted', 'onchange:granted'])

    // 記憶した後の新しい query も granted のまま
    assert.equal((await nav.permissions.query({ name: 'microphone' })).state, 'granted')
    // video は取っていないので camera は読み替えたまま
    nav.mediaDevices.enumerateDevices = async () => [
      { kind: 'audioinput', label: '' },
      { kind: 'videoinput', label: '' }
    ]
    assert.equal((await nav.permissions.query({ name: 'camera' })).state, 'prompt')
  })
})

test('getUserMedia の reject は透過し、記憶しない', async () => {
  const nav = fakeNavigator({
    state: 'granted',
    devices: [{ kind: 'audioinput', label: '' }],
    gumResult: new Error('NotAllowedError')
  })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    await assert.rejects(() => nav.mediaDevices.getUserMedia({ audio: true }))
    await flush()
    assert.equal(status.state, 'prompt')
  })
})

test('devicechange で再評価し、label が出たら change が飛んで state も新しい値になる', async () => {
  let devices = [{ kind: 'videoinput', label: '' }]
  const nav = fakeNavigator({ state: 'granted' })
  nav.mediaDevices.enumerateDevices = async () => devices
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'camera' })
    assert.equal(status.state, 'prompt')
    const fired = []
    status.addEventListener('change', (event) => fired.push(event.type))

    devices = [{ kind: 'videoinput', label: 'FaceTime HD' }]
    nav._fireDeviceChange()
    await flush()

    assert.deepEqual(fired, ['change'])
    assert.equal(status.state, 'granted')
  })
})

test('change リスナーは実 status に転送しない（実 change 時の二重発火と読み替え前の値の露出を防ぐ）', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [{ kind: 'audioinput', label: '' }] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    const listener = () => {}
    status.addEventListener('change', listener)
    // 実 status 側には makeFacade 内の再評価用リスナー 1 本だけ
    assert.equal(nav._status._listeners.has(listener), false)
    assert.equal(nav._status._listeners.size, 1)
    status.removeEventListener('change', listener)
    // onchange の読み書きはファサード側で完結する（実 status の granted→granted では鳴らないため）
    const handler = () => {}
    status.onchange = handler
    assert.equal(status.onchange, handler)
  })
})

test('実 status の change（decision の変化）で再評価され、ページのリスナーは 1 回だけ呼ばれる', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [{ kind: 'audioinput', label: '' }] })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    assert.equal(status.state, 'prompt')
    const fired = []
    status.addEventListener('change', (event) => fired.push(event.target.state))

    // Nemo 側で拒否された（実 status が denied に遷移して change を発火）
    nav._status.state = 'denied'
    for (const listener of [...nav._status._listeners]) listener(new Event('change'))
    await flush()

    assert.deepEqual(fired, ['denied'])
    assert.equal(status.state, 'denied')
  })
})

test('同じ name の query は同じファサードを返す（リスナーとエントリを増やさない）', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [{ kind: 'audioinput', label: '' }] })
  await withNavigator(nav, async () => {
    const first = await nav.permissions.query({ name: 'microphone' })
    const second = await nav.permissions.query({ name: 'microphone' })
    assert.equal(first, second)
    // 何度 query しても実 status への購読は再評価用の 1 本のまま
    assert.equal(nav._status._listeners.size, 1)
  })
})

test('合成 change イベントの target がファサードを指す', async () => {
  const nav = fakeNavigator({
    state: 'granted',
    devices: [{ kind: 'audioinput', label: '' }],
    gumResult: [{ kind: 'audio' }]
  })
  await withNavigator(nav, async () => {
    const status = await nav.permissions.query({ name: 'microphone' })
    const targets = []
    status.addEventListener('change', (event) => targets.push(event.target))
    await nav.mediaDevices.getUserMedia({ audio: true })
    await flush()
    assert.deepEqual(targets, [status])
  })
})

test('差し替えた query / getUserMedia の toString は元の関数のものを返す', async () => {
  const nav = fakeNavigator({ state: 'granted', devices: [] })
  const queryToString = String(nav.permissions.query)
  const gumToString = String(nav.mediaDevices.getUserMedia)
  await withNavigator(nav, async () => {
    assert.equal(String(nav.permissions.query), queryToString)
    assert.equal(String(nav.mediaDevices.getUserMedia), gumToString)
  })
})
