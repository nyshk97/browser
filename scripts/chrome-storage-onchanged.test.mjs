// `src/shared/chrome-storage-onchanged.js` の台帳・配信を、偽の chrome で直接叩く。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installStorageOnChangedPolyfill } from '../src/shared/chrome-storage-onchanged.js'

/** 偽の storage area（メモリ）。callback 形式と Promise 形式の両方を持つ。 */
function fakeArea() {
  const data = {}
  const area = {
    get(keys, cb) {
      const out = {}
      const list = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]
      for (const k of list) if (k in data) out[k] = data[k]
      if (cb) return void cb(out)
      return Promise.resolve(out)
    },
    set(items, cb) {
      Object.assign(data, items)
      if (cb) return void cb()
      return Promise.resolve()
    },
    remove(keys, cb) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]
      if (cb) return void cb()
      return Promise.resolve()
    },
    clear(cb) {
      for (const k of Object.keys(data)) delete data[k]
      if (cb) return void cb()
      return Promise.resolve()
    },
    onChanged: { addListener() {}, removeListener() {} }
  }
  return area
}

/** 偽の chrome。ネイティブ onChanged の発火と sendMessage の捕捉ができる。 */
function fakeChrome() {
  const nativeListeners = new Set()
  const messageListeners = new Set()
  const sent = []
  const chrome = {
    storage: {
      local: fakeArea(),
      session: fakeArea(),
      onChanged: {
        addListener: (fn) => nativeListeners.add(fn),
        removeListener: (fn) => nativeListeners.delete(fn)
      }
    },
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        sent.push(msg)
        cb?.()
      },
      onMessage: { addListener: (fn) => messageListeners.add(fn) }
    }
  }
  return {
    chrome,
    sent,
    fireNative: (changes, area) => nativeListeners.forEach((fn) => fn(changes, area)),
    receive: (msg) => messageListeners.forEach((fn) => fn(msg))
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function install() {
  const fake = fakeChrome()
  globalThis.chrome = fake.chrome
  const api = installStorageOnChangedPolyfill()
  const events = []
  fake.chrome.storage.onChanged.addListener((changes, area) => events.push({ area, changes }))
  const areaEvents = []
  fake.chrome.storage.local.onChanged.addListener((changes) => areaEvents.push(changes))
  return { ...fake, api, events, areaEvents }
}

test('set({a,b}) は 1 イベントに全キー、area 別 onChanged にも同じ 1 件', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1, b: 2 })
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0], { area: 'local', changes: { a: { newValue: 1 }, b: { newValue: 2 } } })
  assert.equal(t.areaEvents.length, 1)
  assert.deepEqual(t.sent, [{ __nemo: 'storage-changed', area: 'local', keys: ['a', 'b'], type: 'save' }])
})

test('同じ値を 2 回書くと 2 回鳴る（内容一致で捨てない）', async () => {
  const t = install()
  await t.chrome.storage.local.set({ same: 'x' })
  await t.chrome.storage.local.set({ same: 'x' })
  assert.equal(t.events.length, 2)
})

test('remove は実在するキーだけ、存在しないキーだけなら鳴らない', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1 })
  t.events.length = 0
  await t.chrome.storage.local.remove(['a', 'missing'])
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0].changes, { a: {} })
  await t.chrome.storage.local.remove('missing')
  assert.equal(t.events.length, 1)
})

test('clear は事前のキー一覧で remove として鳴る、空なら鳴らない', async () => {
  const t = install()
  await t.chrome.storage.session.set({ k1: 1, k2: 2 })
  t.events.length = 0
  await t.chrome.storage.session.clear()
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0], { area: 'session', changes: { k1: {}, k2: {} } })
  await t.chrome.storage.session.clear()
  assert.equal(t.events.length, 1)
})

test('undefined の値も save として配る', async () => {
  const t = install()
  await t.chrome.storage.local.set({ u: undefined })
  assert.equal(t.events.length, 1)
  assert.ok('newValue' in t.events[0].changes.u)
})

test('callback 形式の set / remove でも鳴る', async () => {
  const t = install()
  await new Promise((r) => t.chrome.storage.local.set({ c: 1 }, r))
  await new Promise((r) => t.chrome.storage.local.remove('c', r))
  await tick()
  assert.equal(t.events.length, 2)
})

test('台帳: 自己配信のあとに native が来ても 1 回', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1 })
  t.fireNative({ a: { oldValue: undefined, newValue: 1 } }, 'local')
  assert.equal(t.events.length, 1)
})

test('台帳: 先着 native → 後着ブロードキャストで 1 回、oldValue は落ちる', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1 })
  t.events.length = 0
  t.fireNative({ a: { oldValue: 0, newValue: 1 } }, 'local')
  t.receive({ __nemo: 'storage-changed', area: 'local', keys: ['a'], type: 'save' })
  await tick()
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0].changes, { a: { newValue: 1 } })
})

test('台帳: 先着ブロードキャスト → 後着 native で 1 回。changes は get の結果から作る', async () => {
  const t = install()
  await t.chrome.storage.session.set({ s: 'v' })
  t.events.length = 0
  t.receive({ __nemo: 'storage-changed', area: 'session', keys: ['s'], type: 'save' })
  t.fireNative({ s: { newValue: 'v' } }, 'session')
  await tick()
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0], { area: 'session', changes: { s: { newValue: 'v' } } })
})

test('ブロードキャストだけ（SW 受信の形）でも配られ、save なのに無ければ remove 扱い', async () => {
  const t = install()
  t.receive({ __nemo: 'storage-changed', area: 'local', keys: ['gone'], type: 'save' })
  await tick()
  assert.equal(t.events.length, 1)
  assert.deepEqual(t.events[0].changes, { gone: {} })
})

test('台帳: 窓を過ぎた後着は独立イベントとして配る', async () => {
  const t = install()
  const realNow = Date.now
  try {
    let now = 1_000_000
    Date.now = () => now
    await t.chrome.storage.local.set({ a: 1 })
    now += t.api.WINDOW_MS + 1
    t.fireNative({ a: { newValue: 1 } }, 'local')
    assert.equal(t.events.length, 2)
  } finally {
    Date.now = realNow
  }
})

test('台帳: 同じ経路どうしは突き合わせない（native 2 連続 → broadcast 2 連続で 2 回）', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1 })
  t.events.length = 0
  t.fireNative({ a: { newValue: 1 } }, 'local')
  t.fireNative({ a: { newValue: 1 } }, 'local')
  t.receive({ __nemo: 'storage-changed', area: 'local', keys: ['a'], type: 'save' })
  t.receive({ __nemo: 'storage-changed', area: 'local', keys: ['a'], type: 'save' })
  await tick()
  assert.equal(t.events.length, 2)
})

test('台帳: native が鳴かない側で self の直後に同内容の broadcast が来ても 2 回配る（self ↔ broadcast は消さない）', async () => {
  const t = install()
  await t.chrome.storage.session.set({ key: 'v' })
  t.receive({ __nemo: 'storage-changed', area: 'session', keys: ['key'], type: 'save' })
  await tick()
  assert.equal(t.events.length, 2)
})

test('remove / clear は get を待たずに出す（remove 直後の set が消えない）', async () => {
  const t = install()
  await t.chrome.storage.local.set({ a: 1 })
  t.events.length = 0
  const p1 = t.chrome.storage.local.remove('a')
  const p2 = t.chrome.storage.local.set({ a: 2 })
  await Promise.all([p1, p2])
  await tick()
  assert.deepEqual(await t.chrome.storage.local.get('a'), { a: 2 })
  assert.equal(t.events.length, 2)
})

test('callback 形式で lastError が立っていれば配らない', async () => {
  const t = install()
  t.chrome.runtime.lastError = { message: 'quota' }
  await new Promise((r) => t.chrome.storage.local.set({ q: 1 }, r))
  t.chrome.runtime.lastError = undefined
  assert.equal(t.events.length, 0)
})

test('関係ないメッセージは無視し、二重に install しない', () => {
  const t = install()
  t.receive({ type: 'echo' })
  assert.equal(t.events.length, 0)
  assert.equal(installStorageOnChangedPolyfill(), t.api)
})
