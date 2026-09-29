// `src/shared/kypr-webauthn.js`（kypr の Web 版の Touch ID 解除に答える認証器の判定・PRF・保存ファイル）。
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import {
  KYPR_WEBAUTHN_MAX_PER_ORIGIN,
  decideCreate,
  decideGet,
  normalizeWebAuthnStore,
  prfOutput
} from '../src/shared/kypr-webauthn.js'

const HOST = 'kypr.tools97.com'
const SALT = Buffer.alloc(32, 7).toString('base64')

// kypr `798c258` の `device-unlock.ts` が渡す形を、ページ側の shim が平たくしたもの
const kyprCreate = (over = {}) => ({
  op: 'create',
  rpId: null,
  attachment: 'platform',
  userVerification: 'required',
  prf: true,
  prfFirst: SALT,
  ...over
})
const kyprGet = (over = {}) => ({
  op: 'get',
  rpId: null,
  userVerification: 'required',
  allowCredentials: ['known-id'],
  prfFirst: SALT,
  ...over
})
const KNOWN = new Set(['known-id'])

test('create: kypr の形なら答える（salt を返す）', () => {
  const d = decideCreate(kyprCreate(), HOST)
  assert.equal(d.ok, true)
  assert.deepEqual(d.ok && d.salt, Buffer.alloc(32, 7))
})

test('create: eval が無ければ salt は null（作成時に PRF の結果を返さない）', () => {
  const d = decideCreate(kyprCreate({ prfFirst: null }), HOST)
  assert.deepEqual(d, { ok: true, salt: null })
})

test('create: platform でない・UV が required でない・PRF が無いは not-kypr（包む前の関数へ）', () => {
  assert.deepEqual(decideCreate(kyprCreate({ attachment: 'cross-platform' }), HOST), {
    ok: false,
    reason: 'not-kypr'
  })
  assert.deepEqual(decideCreate(kyprCreate({ attachment: null }), HOST), { ok: false, reason: 'not-kypr' })
  assert.deepEqual(decideCreate(kyprCreate({ userVerification: 'preferred' }), HOST), {
    ok: false,
    reason: 'not-kypr'
  })
  assert.deepEqual(decideCreate(kyprCreate({ prf: false }), HOST), { ok: false, reason: 'not-kypr' })
  assert.deepEqual(decideCreate(null, HOST), { ok: false, reason: 'not-kypr' })
})

test('create: rpId が送り手の host と違えば not-allowed。同じなら通す', () => {
  assert.deepEqual(decideCreate(kyprCreate({ rpId: 'evil.example' }), HOST), {
    ok: false,
    reason: 'not-allowed'
  })
  assert.equal(decideCreate(kyprCreate({ rpId: HOST }), HOST).ok, true)
})

test('create: salt が base64 でなければ not-allowed', () => {
  assert.deepEqual(decideCreate(kyprCreate({ prfFirst: '!!!' }), HOST), { ok: false, reason: 'not-allowed' })
})

test('get: 知っているクレデンシャルなら答える', () => {
  const d = decideGet(kyprGet({ allowCredentials: [null, 'other', 'known-id'] }), HOST, KNOWN)
  assert.equal(d.ok, true)
  assert.equal(d.ok && d.id, 'known-id')
})

test('get: 知らないクレデンシャル・rpId 違いは not-allowed（kypr の形なので素通しにしない）', () => {
  assert.deepEqual(decideGet(kyprGet({ allowCredentials: ['other'] }), HOST, KNOWN), {
    ok: false,
    reason: 'not-allowed'
  })
  assert.deepEqual(decideGet(kyprGet({ rpId: 'evil.example' }), HOST, KNOWN), {
    ok: false,
    reason: 'not-allowed'
  })
})

test('get: UV が required でない・eval が無い・allowCredentials が空は not-kypr', () => {
  assert.deepEqual(decideGet(kyprGet({ userVerification: 'preferred' }), HOST, KNOWN), {
    ok: false,
    reason: 'not-kypr'
  })
  assert.deepEqual(decideGet(kyprGet({ prfFirst: null }), HOST, KNOWN), { ok: false, reason: 'not-kypr' })
  assert.deepEqual(decideGet(kyprGet({ allowCredentials: [] }), HOST, KNOWN), {
    ok: false,
    reason: 'not-kypr'
  })
})

test('PRF: 仕様どおりの計算で、同じ salt で一致し、別の salt・別の secret で変わる', () => {
  const secret = Buffer.alloc(32, 1)
  const salt = Buffer.from('salt')
  const expected = createHmac('sha256', secret)
    .update(
      createHash('sha256')
        .update(Buffer.concat([Buffer.from('WebAuthn PRF'), Buffer.from([0]), salt]))
        .digest()
    )
    .digest()
  assert.deepEqual(prfOutput(secret, salt), expected)
  assert.equal(prfOutput(secret, salt).length, 32)
  assert.deepEqual(prfOutput(secret, salt), prfOutput(Buffer.alloc(32, 1), Buffer.from('salt')))
  assert.notDeepEqual(prfOutput(secret, Buffer.from('salt2')), expected)
  assert.notDeepEqual(prfOutput(Buffer.alloc(32, 2), salt), expected)
})

const row = (id, createdAt, origin = 'https://kypr.tools97.com') => ({
  id,
  rpId: 'kypr.tools97.com',
  origin,
  encrypted: 'NEMOTEST1:xxx',
  createdAt
})

test('保存ファイル: 形の違う行・重複を捨てる', () => {
  const store = normalizeWebAuthnStore({
    version: 1,
    credentials: [
      row('a', '2026-09-01T00:00:00Z'),
      row('a', '2026-09-02T00:00:00Z'),
      { ...row('b', '2026-09-01T00:00:00Z'), encrypted: '' },
      { ...row('c', '2026-09-01T00:00:00Z'), id: 'has space' },
      { ...row('d', 'not a date') },
      'garbage',
      null
    ]
  })
  assert.deepEqual(
    store.credentials.map((r) => r.id),
    ['a']
  )
  assert.deepEqual(normalizeWebAuthnStore(null), { version: 1, credentials: [] })
  assert.deepEqual(normalizeWebAuthnStore({ credentials: 'x' }), { version: 1, credentials: [] })
})

test(`保存ファイル: origin ごとに新しい順で ${KYPR_WEBAUTHN_MAX_PER_ORIGIN} 件まで`, () => {
  const rows = []
  for (let i = 1; i <= KYPR_WEBAUTHN_MAX_PER_ORIGIN + 1; i++)
    rows.push(row(`k${i}`, `2026-09-0${i}T00:00:00Z`))
  rows.push(row('other', '2026-08-01T00:00:00Z', 'http://127.0.0.1:1234'))
  const store = normalizeWebAuthnStore({ version: 1, credentials: rows })
  const kypr = store.credentials.filter((r) => r.origin === 'https://kypr.tools97.com').map((r) => r.id)
  assert.equal(rows.length, KYPR_WEBAUTHN_MAX_PER_ORIGIN + 2)
  assert.deepEqual(kypr, ['k6', 'k5', 'k4', 'k3', 'k2'])
  assert.ok(
    store.credentials.some((r) => r.id === 'other'),
    '別の origin の行は数に入れない'
  )
})
