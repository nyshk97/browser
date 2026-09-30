// kypr のパスキーの認証器の純粋ロジック（`src/shared/kypr-passkey.js`）と、kypr の `client/passkey.ts`（vendored）で
// 作った応答をサイト側のライブラリ（`@simplewebauthn/server`）で検証する。
// main（`src/main/kypr/passkey-authenticator.ts`）と同じ順で関数をつなぐ: 要求を読む → clientDataJSON を組み立てる →
// create は `createPasskey`、get は clientDataJSON の SHA-256 を `assertPasskey` に渡す。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import {
  clientDataJSON,
  effectiveRpId,
  passBeforeVault,
  passkeyTouchIdReason,
  readPasskeyRequest,
  securityKeyOnly
} from '../src/shared/kypr-passkey.js'
import { assertPasskey, createPasskey, rpIdAllowed } from '../src/vendor/kypr/client/passkey.ts'

const ORIGIN = 'https://www.example.co.jp'
const KYPR = 'https://kypr.tools97.com'
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const CHALLENGE = b64u(Buffer.alloc(32, 1))

const createReq = (over = {}) => ({
  op: 'create',
  rpId: 'example.co.jp',
  rpName: 'Example',
  userId: b64u(Buffer.alloc(16, 7)),
  userName: 'alice',
  userDisplayName: 'Alice',
  algs: [-7, -257],
  challenge: CHALLENGE,
  attachment: null,
  excludeCredentials: [],
  prf: false,
  credProps: true,
  ...over
})
const getReq = (over = {}) => ({
  op: 'get',
  rpId: 'example.co.jp',
  challenge: CHALLENGE,
  allowCredentials: [],
  prf: false,
  ...over
})

test('readPasskeyRequest: create / get の形を読む', () => {
  const c = readPasskeyRequest(createReq({ excludeCredentials: [{ id: 'AAAA', transports: ['internal'] }] }))
  assert.equal(c.ok, true)
  assert.deepEqual(c.value.excludeCredentials, ['AAAA'])
  assert.equal(c.value.credProps, true)
  const g = readPasskeyRequest(getReq({ allowCredentials: [{ id: 'AAAA', transports: null }], rpId: null }))
  assert.equal(g.ok, true)
  assert.equal(g.value.rpId, null)
  assert.deepEqual(g.value.allowCredentials, [{ id: 'AAAA', transports: null }])
})

test('readPasskeyRequest: 形が違えば TypeError', () => {
  const bad = [
    null,
    'x',
    { ...createReq(), op: 'delete' },
    createReq({ challenge: '' }),
    createReq({ challenge: 'a+b' }),
    createReq({ userId: 5 }),
    createReq({ algs: '-7' }),
    createReq({ userName: 5 }),
    createReq({ excludeCredentials: [{ id: '' }] }),
    createReq({ excludeCredentials: Array.from({ length: 65 }, () => ({ id: 'AAAA' })) }),
    getReq({ allowCredentials: 'AAAA' }),
    getReq({ rpId: 5 })
  ]
  for (const req of bad)
    assert.deepEqual(readPasskeyRequest(req), { ok: false, error: 'TypeError' }, JSON.stringify(req))
})

test('readPasskeyRequest: 長い名前は切り詰め、整数でない alg は捨てる（断らない）', () => {
  const r = readPasskeyRequest(
    createReq({ userName: 'x'.repeat(600), rpName: 'y'.repeat(600), algs: ['-7', -7, 1.5] })
  )
  assert.equal(r.ok, true)
  assert.equal(r.value.userName.length, 512)
  assert.equal(r.value.rpName.length, 512)
  assert.deepEqual(r.value.algs, [-7])
})

test('passBeforeVault: kypr の Web の origin・cross-platform の create・セキュリティキー向けだけの get は答えない', () => {
  const read = (r) => readPasskeyRequest(r).value
  assert.equal(passBeforeVault(read(createReq()), KYPR, KYPR), 'kypr-origin')
  assert.equal(passBeforeVault(read(getReq()), KYPR, KYPR), 'kypr-origin')
  assert.equal(
    passBeforeVault(read(createReq({ attachment: 'cross-platform' })), ORIGIN, KYPR),
    'cross-platform'
  )
  assert.equal(passBeforeVault(read(createReq({ attachment: 'platform' })), ORIGIN, KYPR), null)
  assert.equal(passBeforeVault(read(createReq()), ORIGIN, null), null)
  // PRF 付きでも kypr 以外の origin なら答える（prf は無視する）
  assert.equal(passBeforeVault(read(createReq({ prf: true })), ORIGIN, KYPR), null)
  const usb = getReq({ allowCredentials: [{ id: 'AAAA', transports: ['usb'] }] })
  assert.equal(passBeforeVault(read(usb), ORIGIN, KYPR), 'security-key')
  assert.equal(passBeforeVault(read(getReq()), ORIGIN, KYPR), null)
})

test('securityKeyOnly: transports が全部そろってキー向けのときだけ', () => {
  assert.equal(securityKeyOnly([]), false)
  assert.equal(securityKeyOnly([{ id: 'A', transports: ['usb', 'nfc'] }]), true)
  assert.equal(
    securityKeyOnly([
      { id: 'A', transports: ['usb'] },
      { id: 'B', transports: null }
    ]),
    false
  )
  assert.equal(securityKeyOnly([{ id: 'A', transports: ['usb', 'hybrid'] }]), false)
  assert.equal(securityKeyOnly([{ id: 'A', transports: ['internal'] }]), false)
  assert.equal(securityKeyOnly([{ id: 'A', transports: [] }]), false)
})

test('effectiveRpId と rpIdAllowed: 要求に無ければ origin のホスト。親ドメインは可、公開接尾辞・別ドメインは不可', () => {
  assert.equal(effectiveRpId(null, ORIGIN), 'www.example.co.jp')
  assert.equal(effectiveRpId('example.co.jp', ORIGIN), 'example.co.jp')
  assert.equal(rpIdAllowed(ORIGIN, 'example.co.jp'), true)
  assert.equal(rpIdAllowed(ORIGIN, 'co.jp'), false)
  assert.equal(rpIdAllowed(ORIGIN, 'evil.com'), false)
  assert.equal(rpIdAllowed('http://example.com', 'example.com'), false)
  assert.equal(rpIdAllowed('http://localhost:8123', 'localhost'), true)
})

test('clientDataJSON: type → challenge → origin → crossOrigin の並び', () => {
  assert.equal(
    clientDataJSON('webauthn.get', 'AQID', ORIGIN),
    `{"type":"webauthn.get","challenge":"AQID","origin":"${ORIGIN}","crossOrigin":false}`
  )
})

test('passkeyTouchIdReason: rpId とユーザー名が入る', () => {
  assert.equal(
    passkeyTouchIdReason('get', 'example.co.jp', 'alice'),
    'example.co.jp にパスキーでサインイン（alice）'
  )
  assert.equal(passkeyTouchIdReason('create', 'example.co.jp', ''), 'example.co.jp のパスキーを作る')
  assert.match(
    passkeyTouchIdReason('unlock-get', 'example.co.jp', ''),
    /example\.co\.jp.*kypr のロックを解除/
  )
})

test('作った登録とサインインの応答が @simplewebauthn/server の検証を通る（challenge・origin・rpId・UV・署名・counter 0）', async () => {
  const req = readPasskeyRequest(createReq()).value
  const rpId = effectiveRpId(req.rpId, ORIGIN)
  const created = await createPasskey({ ...req, rpId })
  const createCdj = clientDataJSON('webauthn.create', req.challenge, ORIGIN)
  const reg = await verifyRegistrationResponse({
    response: {
      id: b64u(created.credentialId),
      rawId: b64u(created.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(createCdj).toString('base64url'),
        attestationObject: b64u(created.attestationObject),
        transports: ['hybrid', 'internal']
      }
    },
    expectedChallenge: CHALLENGE,
    expectedOrigin: ORIGIN,
    expectedRPID: rpId,
    requireUserVerification: true
  })
  assert.equal(reg.verified, true)
  const info = reg.registrationInfo
  assert.equal(info.credentialBackedUp, true)
  assert.equal(info.credentialDeviceType, 'multiDevice')

  const challenge2 = b64u(Buffer.alloc(32, 2))
  const getCdj = clientDataJSON('webauthn.get', challenge2, ORIGIN)
  const assertion = await assertPasskey(created.passkey, createHash('sha256').update(getCdj).digest())
  const auth = await verifyAuthenticationResponse({
    response: {
      id: b64u(assertion.credentialId),
      rawId: b64u(assertion.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(getCdj).toString('base64url'),
        authenticatorData: b64u(assertion.authenticatorData),
        signature: b64u(assertion.signature),
        userHandle: b64u(assertion.userHandle)
      }
    },
    expectedChallenge: challenge2,
    expectedOrigin: ORIGIN,
    expectedRPID: rpId,
    credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: 0 },
    requireUserVerification: true
  })
  assert.equal(auth.verified, true)
  assert.equal(auth.authenticationInfo.newCounter, 0)
  assert.equal(b64u(assertion.userHandle), req.userId)

  // 別の origin で組み立てた clientDataJSON は通らない
  await assert.rejects(
    verifyAuthenticationResponse({
      response: {
        id: b64u(assertion.credentialId),
        rawId: b64u(assertion.credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: Buffer.from(
            clientDataJSON('webauthn.get', challenge2, 'https://evil.example')
          ).toString('base64url'),
          authenticatorData: b64u(assertion.authenticatorData),
          signature: b64u(assertion.signature)
        }
      },
      expectedChallenge: challenge2,
      expectedOrigin: ORIGIN,
      expectedRPID: rpId,
      credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: 0 },
      requireUserVerification: true
    })
  )
})
