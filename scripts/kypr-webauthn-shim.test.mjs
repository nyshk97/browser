// `src/shared/kypr-webauthn-shim.js` を、実物と同じ順（`webauthn-shim.js` → kypr の shim）で偽の環境に入れて叩く。
//
// installer は `contextBridge.executeInMainWorld({ func })` で**文字列化されて**ページに入るので、
// `webauthn-shim.test.mjs` と同じく installer をそのまま当て、文字列から作り直したものでも動くことを見る。
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { installWebAuthnShim } from '../src/shared/webauthn-shim.js'
import { installKyprWebAuthn } from '../src/shared/kypr-webauthn-shim.js'

const ORIGIN = 'https://kypr.tools97.com'
const PRF_B64 = Buffer.alloc(32, 9).toString('base64')
const ID = Buffer.alloc(16, 3).toString('base64url')

function fakeEnv() {
  const nativeCalls = { get: 0, create: 0 }
  const native = (method) =>
    function () {
      nativeCalls[method] += 1
      return new Promise(() => {}) // Electron の実挙動（永久に pending）
    }
  const nav = { credentials: { get: native('get'), create: native('create') } }
  const PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    getClientCapabilities: async () => ({ conditionalGet: true, 'extension:prf': false }),
    signalUnknownCredential: async () => {}
  }
  return { nav, PublicKeyCredential, nativeCalls }
}

/** @param {(req: any) => any} reply main の代わり（受け取った要求を記録する） */
async function withEnv(reply, fn, { fromString = false } = {}) {
  const env = fakeEnv()
  const requests = []
  const bridge = async (req) => {
    requests.push(req)
    return reply(req)
  }
  const saved = ['navigator', 'PublicKeyCredential', 'location'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key)
  ])
  Object.defineProperty(globalThis, 'navigator', { value: env.nav, configurable: true })
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: env.PublicKeyCredential,
    configurable: true
  })
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true })
  const warn = mock.method(console, 'warn', () => {})
  try {
    installWebAuthnShim()
    const install = fromString
      ? new Function(`return (${installKyprWebAuthn.toString()})`)()
      : installKyprWebAuthn
    install(bridge)
    return await fn({ env, requests })
  } finally {
    warn.mock.restore()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const kyprCreateOptions = (salt = new Uint8Array(32).fill(5)) => ({
  publicKey: {
    rp: { name: 'kypr' },
    user: { id: new Uint8Array(16), name: 'kypr', displayName: 'kypr のロック解除' },
    challenge: new Uint8Array(32).fill(1),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred'
    },
    attestation: 'none',
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } }
  }
})
const kyprGetOptions = (id, salt = new Uint8Array(32).fill(5)) => ({
  publicKey: {
    challenge: new Uint8Array(32).fill(2),
    allowCredentials: [{ type: 'public-key', id }],
    userVerification: 'required',
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } }
  }
})

const okReply = (req) => (req.op === 'forget' ? { ok: true } : { ok: true, id: ID, prf: PRF_B64 })

for (const fromString of [false, true]) {
  const label = fromString ? '（文字列から作り直したもの）' : ''

  test(`kypr の create は main に回り、PRF の結果と rawId が返る${label}`, () =>
    withEnv(
      okReply,
      async ({ env, requests }) => {
        const cred = await globalThis.navigator.credentials.create(kyprCreateOptions())
        assert.equal(requests.length, 1)
        assert.equal(requests[0].op, 'create')
        assert.equal(requests[0].attachment, 'platform')
        assert.equal(requests[0].userVerification, 'required')
        assert.equal(requests[0].prfFirst, Buffer.alloc(32, 5).toString('base64'))
        assert.deepEqual(Buffer.from(cred.rawId), Buffer.alloc(16, 3))
        assert.equal(cred.id, ID)
        const ext = cred.getClientExtensionResults().prf
        assert.equal(ext.enabled, true)
        assert.deepEqual(Buffer.from(ext.results.first), Buffer.alloc(32, 9))
        const client = JSON.parse(Buffer.from(cred.response.clientDataJSON).toString('utf8'))
        assert.equal(client.type, 'webauthn.create')
        assert.equal(client.origin, ORIGIN)
        assert.equal(env.nativeCalls.create, 0, 'native は呼ばない')
      },
      { fromString }
    ))

  test(`kypr の get は allowCredentials の id を base64url で送る${label}`, () =>
    withEnv(
      okReply,
      async ({ requests }) => {
        const cred = await globalThis.navigator.credentials.get(kyprGetOptions(new Uint8Array(16).fill(3)))
        assert.deepEqual(requests[0].allowCredentials, [ID])
        assert.equal(requests[0].userVerification, 'required')
        const ext = cred.getClientExtensionResults().prf
        assert.equal(ext.enabled, undefined)
        assert.deepEqual(Buffer.from(ext.results.first), Buffer.alloc(32, 9))
      },
      { fromString }
    ))
}

test('オフセット付きの TypedArray の salt・id も、指している範囲のバイト列で送る', () =>
  withEnv(okReply, async ({ requests }) => {
    const backing = new Uint8Array(64)
    backing.fill(0xaa, 0, 8)
    backing.fill(5, 8, 40)
    const salt = new Uint8Array(backing.buffer, 8, 32)
    const idBacking = new Uint8Array(40).fill(0xff)
    idBacking.fill(3, 4, 20)
    const id = new DataView(idBacking.buffer, 4, 16)
    await globalThis.navigator.credentials.get(kyprGetOptions(id, salt))
    assert.equal(requests[0].prfFirst, Buffer.alloc(32, 5).toString('base64'))
    assert.deepEqual(requests[0].allowCredentials, [ID])
  }))

test('main が not-kypr と返したら内側（webauthn-shim）に回り、platform の create は NotAllowedError', () =>
  withEnv(
    () => ({ ok: false, reason: 'not-kypr' }),
    async ({ env }) => {
      await assert.rejects(globalThis.navigator.credentials.create(kyprCreateOptions()), {
        name: 'NotAllowedError'
      })
      assert.equal(env.nativeCalls.create, 0, 'webauthn-shim が native を呼ばずに拒否する')
    }
  ))

test('main が not-allowed と返したら NotAllowedError（内側には回さない）', () =>
  withEnv(
    () => ({ ok: false, reason: 'not-allowed' }),
    async ({ env }) => {
      await assert.rejects(globalThis.navigator.credentials.get(kyprGetOptions(new Uint8Array(16))), {
        name: 'NotAllowedError'
      })
      assert.equal(env.nativeCalls.get, 0)
    }
  ))

test('PRF の無い要求は main に回さず内側へ（プラットフォーム認証器向けは今までどおり拒否）', () =>
  withEnv(okReply, async ({ requests }) => {
    const options = kyprCreateOptions()
    delete options.publicKey.extensions
    await assert.rejects(globalThis.navigator.credentials.create(options), { name: 'NotAllowedError' })
    assert.equal(requests.length, 0)
  }))

test('abort すると AbortError（前から abort 済みなら main に回さない）', () =>
  withEnv(
    () => new Promise(() => {}),
    async ({ requests }) => {
      const pre = new AbortController()
      pre.abort()
      await assert.rejects(
        globalThis.navigator.credentials.get({ ...kyprGetOptions(new Uint8Array(16)), signal: pre.signal }),
        {
          name: 'AbortError'
        }
      )
      assert.equal(requests.length, 0)
      const later = new AbortController()
      const pending = globalThis.navigator.credentials.get({
        ...kyprGetOptions(new Uint8Array(16)),
        signal: later.signal
      })
      later.abort()
      await assert.rejects(pending, { name: 'AbortError' })
    }
  ))

test('isUVPAA は true、getClientCapabilities は native の他のキーを残して PRF を true にする', () =>
  withEnv(okReply, async () => {
    assert.equal(await globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true)
    const caps = await globalThis.PublicKeyCredential.getClientCapabilities()
    assert.deepEqual(caps, {
      conditionalGet: true,
      'extension:prf': true,
      userVerifyingPlatformAuthenticator: true
    })
  }))

test('signalUnknownCredential は main に forget を送る', () =>
  withEnv(okReply, async ({ requests }) => {
    await globalThis.PublicKeyCredential.signalUnknownCredential({
      rpId: 'kypr.tools97.com',
      credentialId: ID
    })
    assert.deepEqual(requests, [{ op: 'forget', rpId: 'kypr.tools97.com', credentialId: ID }])
  }))
