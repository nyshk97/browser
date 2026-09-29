// kypr の個人情報のうち、フォーム自動入力に使う 1 件の決め方（`src/shared/kypr-identity.js`）と、
// Nemo の項目表（`autofill-schema.js` の `PROFILE_FIELDS`）が kypr の平文・並びと揃っているか。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickAutofillIdentity } from '../src/shared/kypr-identity.js'
import { PROFILE_FIELDS, profileFromKypr } from '../src/shared/autofill-schema.js'
import { normalizeSettings } from '../src/shared/settings-schema.js'
import { IDENTITY_KEYS } from '../src/vendor/kypr/crypto/index.ts'
import { IDENTITY_FIELDS } from '../src/vendor/kypr/client/identity.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const identity = (id, createdAt, deleted = false) => ({ id, kind: 'identity', deleted, createdAt })

test('設定で選んだ 1 件を使う', () => {
  const list = [identity(A, '2026-01-01T00:00:00.000Z'), identity(B, '2026-02-01T00:00:00.000Z')]
  assert.equal(pickAutofillIdentity(list, B), B)
})

test('未設定なら一番古い 1 件（createdAt の昇順）', () => {
  const list = [identity(B, '2026-02-01T00:00:00.000Z'), identity(A, '2026-01-01T00:00:00.000Z')]
  assert.equal(pickAutofillIdentity(list, null), A)
})

test('選んだものが消えた・ゴミ箱の中なら一番古い 1 件に戻る', () => {
  const list = [identity(A, '2026-01-01T00:00:00.000Z'), identity(B, '2026-02-01T00:00:00.000Z', true)]
  assert.equal(pickAutofillIdentity(list, B), A, 'ゴミ箱の中')
  assert.equal(pickAutofillIdentity(list, C), A, '消えた')
})

test('ゴミ箱の中・個人情報以外（読めないアイテムを含む）は候補にしない', () => {
  const list = [
    { id: A, kind: 'error', deleted: false, createdAt: '' },
    { id: B, kind: 'login', deleted: false, createdAt: '2020-01-01T00:00:00.000Z' },
    identity(C, '2026-03-01T00:00:00.000Z', true)
  ]
  assert.equal(pickAutofillIdentity(list, null), null)
  assert.equal(pickAutofillIdentity(list, B), null, 'ログインの ID を選んでいても使わない')
})

test('同じ時刻なら id の小さい方（毎回同じ 1 件になる）', () => {
  const at = '2026-01-01T00:00:00.000Z'
  assert.equal(pickAutofillIdentity([identity(B, at), identity(A, at)], null), A)
})

test('設定: kyprAutofillIdentityId は UUID だけ（小文字にそろえる）', () => {
  assert.equal(normalizeSettings({}).kyprAutofillIdentityId, null)
  assert.equal(normalizeSettings({ kyprAutofillIdentityId: A.toUpperCase() }).kyprAutofillIdentityId, A)
  assert.equal(normalizeSettings({ kyprAutofillIdentityId: 'nope' }).kyprAutofillIdentityId, null)
  assert.equal(normalizeSettings({ kyprAutofillIdentityId: 42 }).kyprAutofillIdentityId, null)
})

test('PROFILE_FIELDS は kypr の平文のキーを過不足なく持ち、並び・見出し・伏せる項目が kypr と同じ', () => {
  assert.deepEqual(
    PROFILE_FIELDS.map((f) => f.kypr),
    [...IDENTITY_KEYS]
  )
  assert.deepEqual(
    PROFILE_FIELDS.map((f) => [f.kypr, f.label, f.group, f.type, f.secret === true]),
    IDENTITY_FIELDS.map((f) => [f.key, f.label, f.group, f.kind, f.secret === true])
  )
})

test('profileFromKypr: camelCase → snake_case。形の違う日付・知らない性別は空にする', () => {
  const profile = profileFromKypr({
    familyName: '山田',
    passportNumber: 'TK1234567',
    passportExpiry: '2031/04/30',
    licenseExpiry: '2029-06-15',
    gender: 'unknown',
    somethingElse: 'x'
  })
  assert.equal(profile['family_name'], '山田')
  assert.equal(profile['passport_number'], 'TK1234567')
  assert.equal(profile['passport_expiry'], '', 'YYYY-MM-DD でない日付')
  assert.equal(profile['license_expiry'], '2029-06-15')
  assert.equal(profile['gender'], '')
  assert.equal(profile['given_name'], '', '無い項目は空')
  assert.equal(Object.keys(profile).length, PROFILE_FIELDS.length)
})
