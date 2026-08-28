import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PASSPHRASE,
  MIN_PASSPHRASE,
  normalizeVaultFile,
  normalizeVaultPayload,
  validatePassphrase
} from '../src/shared/auth-vault-schema.js'
import { HTTP_AUTH_LIMITS } from '../src/shared/http-auth-rules.js'

const NOW = 1_756_000_000_000

/** 最小限の正しい封筒（`readVersioned` が剥がしたあとの `data`）。 */
function file(overrides = {}) {
  return {
    meta: { count: 2, savedAt: NOW, host: 'TsubasanoMacBook-Pro', appVersion: '0.6.0' },
    kdf: { name: 'scrypt', N: 65536, r: 8, p: 1, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' },
    iv: 'aXZpdml2aXZpdml2',
    ciphertext: 'Y2lwaGVydGV4dA==',
    tag: 'dGFndGFndGFndGFndGFndGFn',
    ...overrides
  }
}

/* ------------------------------------------------------------------ *
 * パスフレーズ
 * ------------------------------------------------------------------ */

test('短いパスフレーズは弾かれる', () => {
  assert.equal(validatePassphrase('a'.repeat(MIN_PASSPHRASE - 1)).ok, false)
  assert.equal(validatePassphrase('a'.repeat(MIN_PASSPHRASE)).ok, true)
})

test('空・非文字列・長すぎるパスフレーズは弾かれる', () => {
  for (const value of ['', undefined, null, 42, {}]) {
    assert.equal(validatePassphrase(value).ok, false)
  }
  assert.equal(validatePassphrase('a'.repeat(MAX_PASSPHRASE + 1)).ok, false)
})

/* ------------------------------------------------------------------ *
 * 封筒
 * ------------------------------------------------------------------ */

test('正しい封筒は通る', () => {
  const result = normalizeVaultFile(file())
  assert.notEqual(result, null)
  assert.equal(result.meta.count, 2)
  assert.equal(result.kdf.N, 65536)
})

test('壊れた封筒は null になる', () => {
  for (const raw of [undefined, null, 42, 'x', [], {}]) {
    assert.equal(normalizeVaultFile(raw), null)
  }
})

test('封筒のフィールドが欠けていたら null になる', () => {
  for (const key of ['meta', 'kdf', 'iv', 'ciphertext', 'tag']) {
    const broken = file()
    delete broken[key]
    assert.equal(normalizeVaultFile(broken), null, `${key} が欠けている`)
  }
})

test('KDF が scrypt 以外なら null になる', () => {
  const raw = file({ kdf: { name: 'pbkdf2', N: 65536, r: 8, p: 1, salt: 'c2FsdA==' } })
  assert.equal(normalizeVaultFile(raw), null)
})

test('KDF のパラメータが桁外れなら null になる（開いた瞬間にメモリを食わせない）', () => {
  const huge = file({ kdf: { name: 'scrypt', N: 2 ** 30, r: 8, p: 1, salt: 'c2FsdA==' } })
  assert.equal(normalizeVaultFile(huge), null)
  const wideR = file({ kdf: { name: 'scrypt', N: 65536, r: 1024, p: 1, salt: 'c2FsdA==' } })
  assert.equal(normalizeVaultFile(wideR), null)
})

test('base64 でない iv / tag / ciphertext は null になる', () => {
  for (const key of ['iv', 'tag', 'ciphertext']) {
    assert.equal(normalizeVaultFile(file({ [key]: 'not base64!!' })), null, key)
    assert.equal(normalizeVaultFile(file({ [key]: '' })), null, `${key} が空`)
  }
})

test('meta の型が違えば null になる', () => {
  assert.equal(
    normalizeVaultFile(file({ meta: { count: -1, savedAt: NOW, host: 'a', appVersion: 'b' } })),
    null
  )
  assert.equal(normalizeVaultFile(file({ meta: { count: 1, savedAt: 0, host: 'a', appVersion: 'b' } })), null)
  assert.equal(
    normalizeVaultFile(file({ meta: { count: 1, savedAt: NOW, host: 42, appVersion: 'b' } })),
    null
  )
})

/* ------------------------------------------------------------------ *
 * 復号後の中身
 * ------------------------------------------------------------------ */

test('正しいルールは通り、落ちた件数は 0', () => {
  const { rules, dropped } = normalizeVaultPayload([
    { pattern: '^https://a\\.example/', username: 'admin', password: 'pw', updatedAt: NOW },
    { pattern: '^https://b\\.example/', username: 'user', password: 'pw2' }
  ])
  assert.equal(rules.length, 2)
  assert.equal(dropped, 0)
  assert.equal(rules[0].updatedAt, NOW)
  assert.equal(rules[1].updatedAt, undefined)
})

test('配列でない中身は空になる', () => {
  for (const raw of [undefined, null, 42, 'x', {}]) {
    assert.deepEqual(normalizeVaultPayload(raw), { rules: [], dropped: 0 })
  }
})

test('危険な正規表現は落ち、落ちた件数に出る', () => {
  // `validateHttpAuthPattern` が弾く形（量化されたグループの中に alternation）
  const { rules, dropped } = normalizeVaultPayload([
    { pattern: '^(a|aa)+$', username: 'x', password: 'pw' },
    { pattern: '^https://ok\\.example/', username: 'x', password: 'pw' }
  ])
  assert.equal(rules.length, 1)
  assert.equal(dropped, 1)
})

test('長すぎるユーザー名・パスワードは落ちる', () => {
  const { rules, dropped } = normalizeVaultPayload([
    {
      pattern: '^https://a\\.example/',
      username: 'a'.repeat(HTTP_AUTH_LIMITS.MAX_USERNAME + 1),
      password: 'pw'
    },
    {
      pattern: '^https://b\\.example/',
      username: 'x',
      password: 'p'.repeat(HTTP_AUTH_LIMITS.MAX_PASSWORD + 1)
    }
  ])
  assert.equal(rules.length, 0)
  assert.equal(dropped, 2)
})

test('同じパターンが 2 件あれば後の方が落ちる', () => {
  const { rules, dropped } = normalizeVaultPayload([
    { pattern: '^https://a\\.example/', username: 'first', password: 'pw' },
    { pattern: '^https://a\\.example/', username: 'second', password: 'pw' }
  ])
  assert.equal(rules.length, 1)
  assert.equal(rules[0].username, 'first')
  assert.equal(dropped, 1)
})

test('件数の上限を超えた分は落ち、その件数が返る', () => {
  const many = Array.from({ length: HTTP_AUTH_LIMITS.MAX_RULES + 5 }, (_, i) => ({
    pattern: `^https://host${i}\\.example/`,
    username: 'x',
    password: 'pw'
  }))
  const { rules, dropped } = normalizeVaultPayload(many)
  assert.equal(rules.length, HTTP_AUTH_LIMITS.MAX_RULES)
  assert.equal(dropped, 5)
})

test('不正な updatedAt はフィールドごと落ちる（ルール自体は残る）', () => {
  for (const bad of [0, -1, 1.5, '2026', null]) {
    const { rules, dropped } = normalizeVaultPayload([
      { pattern: '^https://a\\.example/', username: 'x', password: 'pw', updatedAt: bad }
    ])
    assert.equal(rules.length, 1, `updatedAt=${String(bad)}`)
    assert.equal(dropped, 0)
    assert.equal(rules[0].updatedAt, undefined)
  }
})
