// `src/shared/webauthn-shim.js` を偽の navigator / PublicKeyCredential で直接叩く。
//
// installer は `contextBridge.executeInMainWorld({ func })` で**文字列化されて**ページに入るので、
// 判定ロジックを別関数に切り出してそれだけをテストすると出荷されないコードを検証することになる。
// installer 1 本を偽の `globalThis` に当てて、ページから見える挙動ごと検証する。
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { installWebAuthnShim } from '../src/shared/webauthn-shim.js'

const CHALLENGE = new Uint8Array(32)
const CRED = (transports) => ({ type: 'public-key', id: new Uint8Array(16), transports })

/**
 * 偽の環境を組み立てる。native の get / create は**永久に pending**（Electron の実挙動）。
 * @param {{ uvpaa?: boolean | Error, pending?: boolean }} opts
 */
function fakeEnv({ uvpaa = false, pending = true } = {}) {
  const calls = { get: [], create: [] }
  const settle = { get: [], create: [] }
  const native = (method) =>
    function (...args) {
      calls[method].push(args)
      if (!pending) return Promise.resolve({ id: `${method}-result` })
      return new Promise((resolve, reject) => {
        settle[method].push({ resolve, reject })
      })
    }
  const nav = { credentials: { get: native('get'), create: native('create') } }
  const PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => {
      if (uvpaa instanceof Error) throw uvpaa
      return uvpaa
    }
  }
  return { nav, PublicKeyCredential, calls, settle }
}

/** installer は `globalThis` を見るので、差し替えてから当てる。 */
async function withEnv(env, fn) {
  const saved = ['navigator', 'PublicKeyCredential'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key)
  ])
  Object.defineProperty(globalThis, 'navigator', { value: env.nav, configurable: true })
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: env.PublicKeyCredential,
    configurable: true
  })
  const warn = mock.method(console, 'warn', () => {})
  try {
    installWebAuthnShim()
    return await fn()
  } finally {
    // 素通しした要求は実 setTimeout（最長 10 分）を抱える。native を settle して timer を消し、
    // テストプロセスが 5 分待ち続けないようにする
    for (const s of [...env.settle.get, ...env.settle.create]) s.resolve(null)
    warn.mock.restore()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

/** 「まだ pending か」を見る（マイクロタスクを流してから判定） */
async function state(promise) {
  let result = 'pending'
  promise.then(
    (v) => (result = { resolved: v }),
    (e) => (result = { rejected: e })
  )
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  return result
}

const assertNotAllowed = (result) => {
  assert.ok(result.rejected, `NotAllowedError で reject されるべき: ${JSON.stringify(result)}`)
  assert.equal(result.rejected.name, 'NotAllowedError')
  assert.ok(result.rejected instanceof DOMException)
}

test('get: allowCredentials 無し（パスキー）+ isUVPAA false → native を呼ばず即 NotAllowedError', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({ publicKey: { challenge: CHALLENGE, userVerification: 'required' } })
    )
    assertNotAllowed(result)
    assert.equal(env.calls.get.length, 0, 'native を呼ぶと frame に pending が残る')
  })
})

test('get: allowCredentials が空配列 → 即 NotAllowedError', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({ publicKey: { challenge: CHALLENGE, allowCredentials: [] } })
    )
    assertNotAllowed(result)
    assert.equal(env.calls.get.length, 0)
  })
})

test('get: transports が internal / hybrid だけ → 即 NotAllowedError', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({
        publicKey: {
          challenge: CHALLENGE,
          allowCredentials: [CRED(['internal']), CRED(['internal', 'hybrid'])]
        }
      })
    )
    assertNotAllowed(result)
    assert.equal(env.calls.get.length, 0)
  })
})

test('get: transports に usb を含む → native に素通し（pending のまま）', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({
        publicKey: { challenge: CHALLENGE, allowCredentials: [CRED(['internal', 'usb'])] }
      })
    )
    assert.equal(result, 'pending')
    assert.equal(env.calls.get.length, 1)
  })
})

test('get: transports 無しのエントリがある → 不明なので素通し', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({
        publicKey: { challenge: CHALLENGE, allowCredentials: [CRED(['internal']), CRED(undefined)] }
      })
    )
    assert.equal(result, 'pending')
    assert.equal(env.calls.get.length, 1)
  })
})

test('後から isUVPAA が true に差し替えられても（Bitwarden の page script）native の false で判定する', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    // Bitwarden の fido2-page-script.js と同じ差し替え（native が false のとき true を返す）
    env.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true)
    // Bitwarden は注入時に get を bind して fallback 先にする → シム後の get が fallback 先になる
    const fallback = env.nav.credentials.get.bind(env.nav.credentials)
    const result = await state(
      fallback({ publicKey: { challenge: CHALLENGE, userVerification: 'required' } })
    )
    assertNotAllowed(result)
    assert.equal(env.calls.get.length, 0)
  })
})

test('get: mediation conditional は判定せず素通し（isUVPAA は install 時の 1 回だけ）', async () => {
  const env = fakeEnv()
  let uvpaaCalls = 0
  // シムは install 時に native を bind するので、差し替えは install より前に済ませる
  env.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => {
    uvpaaCalls++
    return false
  }
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.get({ mediation: 'conditional', publicKey: { challenge: CHALLENGE } })
    )
    assert.equal(result, 'pending')
    assert.equal(env.calls.get.length, 1)
    // install 時の 1 回だけ（要求ごとには呼ばない）
    assert.equal(uvpaaCalls, 1)
  })
})

test('get: publicKey 以外（password）は素通し', async () => {
  const env = fakeEnv({ pending: false })
  await withEnv(env, async () => {
    const result = await state(env.nav.credentials.get({ password: true }))
    assert.deepEqual(result, { resolved: { id: 'get-result' } })
    assert.deepEqual(env.calls.get, [[{ password: true }]])
  })
})

test('get: isUVPAA true（将来 configureWebAuthn を入れたとき）は素通し', async () => {
  const env = fakeEnv({ uvpaa: true, pending: false })
  await withEnv(env, async () => {
    const result = await state(env.nav.credentials.get({ publicKey: { challenge: CHALLENGE } }))
    assert.deepEqual(result, { resolved: { id: 'get-result' } })
  })
})

test('get: isUVPAA が例外なら判定を諦めて素通し', async () => {
  const env = fakeEnv({ uvpaa: new Error('boom'), pending: false })
  await withEnv(env, async () => {
    const result = await state(env.nav.credentials.get({ publicKey: { challenge: CHALLENGE } }))
    assert.deepEqual(result, { resolved: { id: 'get-result' } })
  })
})

test('get: native の reject は素通し（NotAllowedError に化けない）', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const promise = env.nav.credentials.get({
      publicKey: { challenge: CHALLENGE, allowCredentials: [CRED(['usb'])] }
    })
    await state(promise)
    env.settle.get[0].reject(new DOMException('already pending', 'OperationError'))
    const result = await state(promise)
    assert.equal(result.rejected?.name, 'OperationError')
  })
})

test('create: authenticatorAttachment platform → 即 NotAllowedError', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const result = await state(
      env.nav.credentials.create({
        publicKey: { challenge: CHALLENGE, authenticatorSelection: { authenticatorAttachment: 'platform' } }
      })
    )
    assertNotAllowed(result)
    assert.equal(env.calls.create.length, 0)
  })
})

test('create: cross-platform / 無指定は素通し', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const a = await state(
      env.nav.credentials.create({
        publicKey: {
          challenge: CHALLENGE,
          authenticatorSelection: { authenticatorAttachment: 'cross-platform' }
        }
      })
    )
    const b = await state(env.nav.credentials.create({ publicKey: { challenge: CHALLENGE } }))
    assert.equal(a, 'pending')
    assert.equal(b, 'pending')
    assert.equal(env.calls.create.length, 2)
  })
})

test('素通しした要求は timeout（10 秒〜10 分に丸め、無指定 60 秒）で NotAllowedError に落ちる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = fakeEnv()
  await withEnv(env, async () => {
    const short = env.nav.credentials.get({
      publicKey: { challenge: CHALLENGE, timeout: 1000, allowCredentials: [CRED(['usb'])] }
    })
    const none = env.nav.credentials.get({
      publicKey: { challenge: CHALLENGE, allowCredentials: [CRED(['usb'])] }
    })
    const long = env.nav.credentials.create({
      publicKey: { challenge: CHALLENGE, timeout: 99_999_999, authenticatorSelection: {} }
    })
    // isUVPAA の await を流して native を呼ばせる（setTimeout の登録まで進める）
    await state(short)
    await state(none)
    await state(long)
    assert.equal(env.calls.get.length, 2)
    assert.equal(env.calls.create.length, 1)

    t.mock.timers.tick(9_999)
    assert.equal(await state(short), 'pending', '1 秒指定でも 10 秒未満では切らない')
    t.mock.timers.tick(1)
    assertNotAllowed(await state(short))
    assert.equal(await state(none), 'pending')

    t.mock.timers.tick(60_000 - 10_000)
    assertNotAllowed(await state(none))
    assert.equal(await state(long), 'pending', '10 分までは待つ')
    t.mock.timers.tick(600_000 - 60_000)
    assertNotAllowed(await state(long))
  })
})

test('native が先に解決すれば timeout は発火せず値を返す', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = fakeEnv()
  await withEnv(env, async () => {
    const promise = env.nav.credentials.get({
      publicKey: { challenge: CHALLENGE, timeout: 10_000, allowCredentials: [CRED(['usb'])] }
    })
    await state(promise)
    env.settle.get[0].resolve({ id: 'from-key' })
    assert.deepEqual(await state(promise), { resolved: { id: 'from-key' } })
    t.mock.timers.tick(20_000)
    assert.deepEqual(await state(promise), { resolved: { id: 'from-key' } })
  })
})

test('差し替えた get / create は toString / name / length が native に見える', async () => {
  const env = fakeEnv()
  const originalGet = env.nav.credentials.get
  const originalCreate = env.nav.credentials.create
  await withEnv(env, async () => {
    const { get, create } = env.nav.credentials
    assert.notEqual(get, originalGet)
    assert.equal(get.toString(), originalGet.toString())
    assert.equal(get.name, originalGet.name)
    assert.equal(get.length, originalGet.length)
    assert.equal(create.toString(), originalCreate.toString())
  })
})

test('WebAuthn を持たない環境（素の http）では何もしない', async () => {
  const env = fakeEnv()
  delete env.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  const originalGet = env.nav.credentials.get
  await withEnv(env, async () => {
    assert.equal(env.nav.credentials.get, originalGet)
  })
})

test('timeout で native の要求を abort する（渡した signal が aborted になる。publicKey は同じ参照）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = fakeEnv()
  await withEnv(env, async () => {
    const publicKey = { challenge: CHALLENGE, timeout: 10_000, allowCredentials: [CRED(['usb'])] }
    const promise = env.nav.credentials.get({ publicKey })
    await state(promise)
    const [passed] = env.calls.get[0]
    assert.equal(passed.publicKey, publicKey, 'publicKey は浅いコピーで同じ参照のまま')
    assert.ok(passed.signal instanceof AbortSignal)
    assert.equal(passed.signal.aborted, false)
    t.mock.timers.tick(10_000)
    assertNotAllowed(await state(promise))
    assert.equal(passed.signal.aborted, true)
  })
})

test('サイトの signal は合成される（サイト側の abort で native に渡した signal も aborted）', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const site = new AbortController()
    const promise = env.nav.credentials.get({
      signal: site.signal,
      publicKey: { challenge: CHALLENGE, allowCredentials: [CRED(['usb'])] }
    })
    await state(promise)
    const [passed] = env.calls.get[0]
    assert.notEqual(passed.signal, site.signal)
    assert.equal(passed.signal.aborted, false)
    site.abort()
    assert.equal(passed.signal.aborted, true)
  })
})

test('判定中にオプションの getter が投げたら素通し（native とも Chrome とも違うエラーを出さない）', async () => {
  const env = fakeEnv()
  await withEnv(env, async () => {
    const publicKey = { challenge: CHALLENGE }
    Object.defineProperty(publicKey, 'allowCredentials', {
      get() {
        throw new Error('boom')
      }
    })
    const result = await state(env.nav.credentials.get({ publicKey }))
    assert.equal(result, 'pending')
    assert.equal(env.calls.get.length, 1)
  })
})
