import test from 'node:test'
import assert from 'node:assert/strict'
import { KDF_PARAMS, decryptVault, encryptVault } from '../src/shared/auth-vault-crypto.js'
import { normalizeVaultPayload } from '../src/shared/auth-vault-schema.js'

const NOW = 1_756_000_000_000
const PASSPHRASE = 'correct horse battery'

const RULES = [
  { pattern: '^https://stg\\.a\\.com/', username: 'admin', password: 'secret1', updatedAt: NOW },
  { pattern: '^https://dev\\.b\\.jp/', username: 'tsubasa', password: 'secret2' }
]

function meta(overrides = {}) {
  return {
    count: RULES.length,
    savedAt: NOW,
    host: 'TsubasanoMacBook-Pro',
    appVersion: '0.6.0',
    ...overrides
  }
}

test('暗号化して復号すると元に戻る', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const result = await decryptVault(file, PASSPHRASE)
  assert.equal(result.ok, true)
  assert.deepEqual(result.rules, RULES)
})

test('パスワードが暗号文の外に漏れていない', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  // 封筒（メタ・KDF・base64）を全部つないでも平文が現れてはいけない
  const envelope = JSON.stringify({ meta: file.meta, kdf: file.kdf, iv: file.iv, tag: file.tag })
  for (const rule of RULES) {
    assert.equal(envelope.includes(rule.password), false, rule.pattern)
    assert.equal(envelope.includes(rule.pattern), false, rule.pattern)
    assert.equal(envelope.includes(rule.username), false, rule.username)
  }
})

test('パスフレーズが違えば bad-passphrase になる', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const result = await decryptVault(file, 'wrong passphrase')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-passphrase')
})

test('外側の平文メタを書き換えると tampered になる（bad-passphrase に落ちない）', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const forged = { ...file, meta: { ...file.meta, count: 99 } }
  const result = await decryptVault(forged, PASSPHRASE)
  assert.equal(result.ok, false)
  /*
   * ここが `bad-passphrase` に落ちると、**改竄に対して「やり直してください」**と出る。
   * 逆に打ち間違いが `tampered` に落ちると「削除して作り直せ」と出る。どちらも直させない。
   */
  assert.equal(result.reason, 'tampered')
})

test('端末名を書き換えても tampered になる', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const forged = { ...file, meta: { ...file.meta, host: 'SomeoneElsesMac' } }
  const result = await decryptVault(forged, PASSPHRASE)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'tampered')
})

test('暗号文を書き換えると bad-passphrase になる（認証タグが落ちる）', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const bytes = Buffer.from(file.ciphertext, 'base64')
  bytes[0] ^= 0xff
  const forged = { ...file, ciphertext: bytes.toString('base64') }
  const result = await decryptVault(forged, PASSPHRASE)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'bad-passphrase')
})

test('封筒が壊れていたら復号を試みず malformed になる', async () => {
  for (const raw of [undefined, null, 42, 'x', [], {}, { meta: {} }]) {
    const result = await decryptVault(raw, PASSPHRASE)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'malformed')
  }
})

test('保存のたびに salt と iv が変わる（同じ中身でも暗号文が一致しない）', async () => {
  const a = await encryptVault(RULES, PASSPHRASE, meta())
  const b = await encryptVault(RULES, PASSPHRASE, meta())
  assert.notEqual(a.kdf.salt, b.kdf.salt)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
})

test('封筒に KDF のパラメータが載っている（復号側が既定値を決め打ちしないため）', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  assert.equal(file.kdf.N, KDF_PARAMS.N)
  assert.equal(file.kdf.name, 'scrypt')
  const result = await decryptVault(file, PASSPHRASE)
  assert.equal(result.ok, true)
})

test('復号した中身はそのまま normalizeVaultPayload に通せる', async () => {
  const file = await encryptVault(RULES, PASSPHRASE, meta())
  const result = await decryptVault(file, PASSPHRASE)
  assert.equal(result.ok, true)
  const { rules, dropped } = normalizeVaultPayload(result.rules)
  assert.equal(rules.length, 2)
  assert.equal(dropped, 0)
})
