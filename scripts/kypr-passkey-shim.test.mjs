// `src/shared/kypr-passkey-shim.js` を、実物と同じ重ね順（`webauthn-shim.js` → パスキーの shim → kypr の Web の origin だけ
// PRF の shim）で偽の環境に入れて叩く。installer は文字列化されてページに入るので、文字列から作り直したものでも見る。
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { installWebAuthnShim } from '../src/shared/webauthn-shim.js'
import { installKyprPasskey } from '../src/shared/kypr-passkey-shim.js'
import { installKyprWebAuthn } from '../src/shared/kypr-webauthn-shim.js'

const ORIGIN = 'https://www.example.co.jp'
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const CRED_ID = b64u(Buffer.alloc(16, 3))
const CDJ = b64u(Buffer.from('{"type":"webauthn.create"}'))

function fakeEnv() {
  const nativeCalls = { get: 0, create: 0 }
  const native = (method) =>
    function (options) {
      nativeCalls[method] += 1
      // 検査用: native がすぐ返す要求（それ以外は Electron の実挙動 = 永久に pending）
      if (options?.publicKey?.nativeResolves) return Promise.resolve('native-result')
      return new Promise(() => {})
    }
  const nav = { credentials: { get: native('get'), create: native('create') } }
  class PublicKeyCredential {
    get id() {
      throw new TypeError('Illegal invocation')
    }
    static async isUserVerifyingPlatformAuthenticatorAvailable() {
      return false
    }
    static async getClientCapabilities() {
      return { conditionalGet: true }
    }
    static async signalUnknownCredential() {}
  }
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  return {
    nav,
    PublicKeyCredential,
    AuthenticatorAttestationResponse,
    AuthenticatorAssertionResponse,
    nativeCalls
  }
}

/**
 * @param {(req: any) => any} reply パスキーの main の代わり
 * @param {{ fromString?: boolean, prf?: (req: any) => any }} opts `prf` を渡すと PRF の shim も外側に重ねる
 */
async function withEnv(reply, fn, { fromString = false, prf = null } = {}) {
  const env = fakeEnv()
  const requests = []
  const prfRequests = []
  const bridge = async (req) => {
    requests.push(req)
    return reply(req)
  }
  const keys = [
    'navigator',
    'PublicKeyCredential',
    'AuthenticatorAttestationResponse',
    'AuthenticatorAssertionResponse',
    'location'
  ]
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.defineProperty(globalThis, 'navigator', { value: env.nav, configurable: true })
  for (const key of [
    'PublicKeyCredential',
    'AuthenticatorAttestationResponse',
    'AuthenticatorAssertionResponse'
  ])
    Object.defineProperty(globalThis, key, { value: env[key], configurable: true, writable: true })
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true })
  const warn = mock.method(console, 'warn', () => {})
  try {
    installWebAuthnShim()
    const install = fromString
      ? new Function(`return (${installKyprPasskey.toString()})`)()
      : installKyprPasskey
    install(bridge)
    if (prf)
      installKyprWebAuthn(async (req) => {
        prfRequests.push(req)
        return prf(req)
      })
    return await fn({ env, requests, prfRequests })
  } finally {
    warn.mock.restore()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const createOptions = (over = {}) => ({
  publicKey: {
    rp: { id: 'example.co.jp', name: 'Example' },
    user: { id: new Uint8Array(16).fill(7), name: 'alice', displayName: 'Alice' },
    challenge: new Uint8Array(32).fill(1),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 }
    ],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: [{ type: 'public-key', id: new Uint8Array(16).fill(9), transports: ['internal'] }],
    attestation: 'none',
    extensions: { credProps: true },
    ...over
  }
})
const getOptions = (over = {}) => ({
  publicKey: {
    rpId: 'example.co.jp',
    challenge: new Uint8Array(32).fill(2),
    allowCredentials: [],
    userVerification: 'required',
    ...over
  }
})

const createReply = () => ({
  ok: true,
  op: 'create',
  credentialId: CRED_ID,
  clientDataJSON: CDJ,
  attestationObject: b64u([0xa3, 1, 2]),
  authenticatorData: b64u([4, 5, 6]),
  publicKey: b64u([0x30, 0x59]),
  publicKeyAlgorithm: -7,
  credProps: true
})
const getReply = () => ({
  ok: true,
  op: 'get',
  credentialId: CRED_ID,
  clientDataJSON: CDJ,
  authenticatorData: b64u([4, 5, 6]),
  signature: b64u([0x30, 0x44]),
  userHandle: b64u(Buffer.alloc(16, 7))
})
const answer = (req) =>
  req.op === 'create' ? createReply() : req.op === 'get' ? getReply() : { ok: true, available: true }

for (const fromString of [false, true]) {
  const label = fromString ? '（文字列から作り直したもの）' : ''

  test(`create は平たい要求で main に回り、PublicKeyCredential の形で返る${label}`, () =>
    withEnv(
      answer,
      async ({ env, requests }) => {
        const cred = await globalThis.navigator.credentials.create(createOptions())
        assert.equal(requests.length, 1)
        const req = requests[0]
        assert.equal(req.op, 'create')
        assert.equal(req.rpId, 'example.co.jp')
        assert.equal(req.rpName, 'Example')
        assert.equal(req.userId, b64u(Buffer.alloc(16, 7)))
        assert.equal(req.userName, 'alice')
        assert.deepEqual(req.algs, [-7, -257])
        assert.equal(req.challenge, b64u(Buffer.alloc(32, 1)))
        assert.deepEqual(req.excludeCredentials, [
          { id: b64u(Buffer.alloc(16, 9)), transports: ['internal'] }
        ])
        assert.equal(req.credProps, true)
        assert.equal(req.prf, false)
        assert.ok(cred instanceof globalThis.PublicKeyCredential, 'instanceof PublicKeyCredential')
        assert.ok(cred.response instanceof globalThis.AuthenticatorAttestationResponse)
        assert.equal(cred.id, CRED_ID, 'prototype の getter を隠す')
        assert.equal(cred.type, 'public-key')
        assert.equal(cred.authenticatorAttachment, 'platform')
        assert.deepEqual(Buffer.from(cred.rawId), Buffer.alloc(16, 3))
        assert.deepEqual(Buffer.from(cred.response.attestationObject), Buffer.from([0xa3, 1, 2]))
        assert.deepEqual(Buffer.from(cred.response.getAuthenticatorData()), Buffer.from([4, 5, 6]))
        assert.deepEqual(Buffer.from(cred.response.getPublicKey()), Buffer.from([0x30, 0x59]))
        assert.equal(cred.response.getPublicKeyAlgorithm(), -7)
        assert.deepEqual(cred.response.getTransports(), ['hybrid', 'internal'])
        assert.deepEqual(cred.getClientExtensionResults(), { credProps: { rk: true } })
        const json = cred.toJSON()
        assert.equal(json.id, CRED_ID)
        assert.equal(json.rawId, CRED_ID)
        assert.equal(json.response.clientDataJSON, CDJ)
        assert.equal(json.response.attestationObject, b64u([0xa3, 1, 2]))
        assert.equal(json.response.publicKeyAlgorithm, -7)
        assert.deepEqual(json.clientExtensionResults, { credProps: { rk: true } })
        assert.equal(env.nativeCalls.create, 0)
      },
      { fromString }
    ))

  test(`get は allowCredentials の id と transports を送り、署名と userHandle が返る${label}`, () =>
    withEnv(
      answer,
      async ({ requests }) => {
        const backing = new Uint8Array(40).fill(0xff)
        backing.fill(3, 4, 20)
        const cred = await globalThis.navigator.credentials.get(
          getOptions({ allowCredentials: [{ type: 'public-key', id: new DataView(backing.buffer, 4, 16) }] })
        )
        assert.deepEqual(requests[0].allowCredentials, [{ id: CRED_ID, transports: null }])
        assert.equal(requests[0].rpId, 'example.co.jp')
        assert.ok(cred instanceof globalThis.PublicKeyCredential)
        assert.ok(cred.response instanceof globalThis.AuthenticatorAssertionResponse)
        assert.deepEqual(Buffer.from(cred.response.signature), Buffer.from([0x30, 0x44]))
        assert.deepEqual(Buffer.from(cred.response.userHandle), Buffer.alloc(16, 7))
        assert.deepEqual(cred.getClientExtensionResults(), {})
        assert.equal(cred.toJSON().response.userHandle, b64u(Buffer.alloc(16, 7)))
      },
      { fromString }
    ))
}

test('pass なら内側（webauthn-shim）へ: platform の create は NotAllowedError、cross-platform は native に届く', () =>
  withEnv(
    () => ({ ok: false, pass: true }),
    async ({ env }) => {
      await assert.rejects(
        globalThis.navigator.credentials.create(
          createOptions({ authenticatorSelection: { authenticatorAttachment: 'platform' } })
        ),
        { name: 'NotAllowedError' }
      )
      assert.equal(env.nativeCalls.create, 0)
      const result = await globalThis.navigator.credentials.create(
        createOptions({
          authenticatorSelection: { authenticatorAttachment: 'cross-platform' },
          nativeResolves: true
        })
      )
      assert.equal(result, 'native-result')
      assert.equal(env.nativeCalls.create, 1, 'セキュリティキーの経路は native に届く')
    }
  ))

test('error はその名前で返す（DOMException。TypeError だけは TypeError）', () =>
  withEnv(
    (req) => ({ ok: false, error: req.op === 'create' ? 'InvalidStateError' : 'SecurityError' }),
    async () => {
      await assert.rejects(globalThis.navigator.credentials.create(createOptions()), (e) => {
        assert.equal(e.name, 'InvalidStateError')
        assert.ok(e instanceof DOMException)
        return true
      })
      await assert.rejects(globalThis.navigator.credentials.get(getOptions()), { name: 'SecurityError' })
    }
  ))

test('TypeError と、知らない error 名（NotAllowedError に倒す）', () =>
  withEnv(
    (req) => ({ ok: false, error: req.op === 'create' ? 'TypeError' : 'Whatever' }),
    async () => {
      await assert.rejects(globalThis.navigator.credentials.create(createOptions()), TypeError)
      await assert.rejects(globalThis.navigator.credentials.get(getOptions()), { name: 'NotAllowedError' })
    }
  ))

test('conditional と、読めない options（challenge が BufferSource でない）は main に回さない', () =>
  withEnv(answer, async ({ requests }) => {
    void globalThis.navigator.credentials.get({ ...getOptions(), mediation: 'conditional' })
    await assert.rejects(
      globalThis.navigator.credentials.get(getOptions({ challenge: 'not-bytes' })),
      { name: 'NotAllowedError' } // 内側の webauthn-shim が空の allowCredentials を拒否する
    )
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(requests.length, 0)
  }))

test('main が落ちた（invoke が reject）ら NotAllowedError', () =>
  withEnv(
    () => {
      throw new Error('ipc failed')
    },
    async () => {
      await assert.rejects(globalThis.navigator.credentials.get(getOptions()), { name: 'NotAllowedError' })
    }
  ))

test('abort すると AbortError（前から abort 済みなら main に回さない）', () =>
  withEnv(
    () => new Promise(() => {}),
    async ({ requests }) => {
      const pre = new AbortController()
      pre.abort()
      await assert.rejects(globalThis.navigator.credentials.get({ ...getOptions(), signal: pre.signal }), {
        name: 'AbortError'
      })
      assert.equal(requests.length, 0)
      const later = new AbortController()
      const pending = globalThis.navigator.credentials.get({ ...getOptions(), signal: later.signal })
      later.abort()
      await assert.rejects(pending, { name: 'AbortError' })
    }
  ))

test('isUVPAA / getClientCapabilities: main が available なら true、そうでなければ native の値', async () => {
  await withEnv(answer, async ({ requests }) => {
    assert.equal(await globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), true)
    assert.deepEqual(await globalThis.PublicKeyCredential.getClientCapabilities(), {
      conditionalGet: true,
      userVerifyingPlatformAuthenticator: true,
      passkeyPlatformAuthenticator: true
    })
    assert.deepEqual(
      requests.map((r) => r.op),
      ['available', 'available']
    )
  })
  await withEnv(
    () => ({ ok: true, available: false }),
    async () => {
      assert.equal(
        await globalThis.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
        false
      )
      assert.deepEqual(await globalThis.PublicKeyCredential.getClientCapabilities(), { conditionalGet: true })
    }
  )
})

test('3 層（kypr の Web の origin）: PRF の shim が答えたものはパスキーの shim に来ず、PRF の無い要求は届く', () =>
  withEnv(
    () => ({ ok: false, pass: true }),
    async ({ requests, prfRequests }) => {
      const cred = await globalThis.navigator.credentials.create(
        createOptions({
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          extensions: { prf: {} }
        })
      )
      assert.equal(cred.id, CRED_ID)
      assert.equal(prfRequests.length, 1, 'PRF 付きは PRF の shim')
      assert.equal(requests.length, 0, 'PRF の shim が答えたものはパスキーの shim に来ない')
      await assert.rejects(globalThis.navigator.credentials.get(getOptions()), { name: 'NotAllowedError' })
      assert.equal(requests.length, 1, 'PRF の無い要求はパスキーの shim に届く')
      assert.equal(prfRequests.length, 1)
    },
    { prf: () => ({ ok: true, id: CRED_ID, prf: null }) }
  ))

test('3 層: PRF の main が not-kypr を返したら、パスキーの shim に回る', () =>
  withEnv(
    answer,
    async ({ requests, prfRequests }) => {
      const cred = await globalThis.navigator.credentials.create(
        createOptions({
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          extensions: { prf: {} }
        })
      )
      assert.equal(prfRequests.length, 1)
      assert.equal(requests.length, 1)
      assert.equal(
        requests[0].prf,
        true,
        'prf を要求したことは main に伝わる（main は kypr の origin なら pass）'
      )
      assert.ok(cred instanceof globalThis.PublicKeyCredential)
    },
    { prf: () => ({ ok: false, reason: 'not-kypr' }) }
  ))
