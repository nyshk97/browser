// kypr からコピーした暗号（src/vendor/kypr）が、kypr のテストベクタと一致するか。
// Nemo の CI には kypr（private）が無いので、ここでベクタを回して「コピーが壊れていない・Node で同じ結果になる」を固定する。
// ベクタは kypr の `packages/crypto/test-vectors/v1.json` の写し（src/vendor/kypr/test-vectors）
import assert from 'node:assert/strict'
import { createCipheriv, hkdfSync } from 'node:crypto'
import fs from 'node:fs'
import { test } from 'node:test'
import {
  b64Decode,
  decryptItem,
  deriveKeys,
  deriveMasterKey,
  fromHex,
  INFO_AUTH,
  INFO_WRAP,
  seal,
  toHex,
  unwrapVaultKey,
  utf8Encode
} from '../src/vendor/kypr/crypto/index.ts'
import { loginMatchesPage } from '../src/vendor/kypr/client/url-match.ts'

const V = JSON.parse(
  fs.readFileSync(new URL('../src/vendor/kypr/test-vectors/v1.json', import.meta.url), 'utf8')
)

function nodeGcm(keyHex, nonceHex, pt) {
  const cipher = createCipheriv('aes-256-gcm', fromHex(keyHex), fromHex(nonceHex))
  return Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

test('KDF のベクタ（Argon2id → HKDF）が一致する', async () => {
  assert.ok(V.kdf.length >= 2, `ベクタが少なすぎる（${V.kdf.length} 件）`)
  for (const c of V.kdf) {
    assert.equal(toHex(await deriveMasterKey(c.password, c.kdf)), c.masterKey, c.password)
    const { authKey, wrapKey } = await deriveKeys(c.password, c.kdf)
    assert.equal(toHex(authKey), c.authKey)
    assert.equal(toHex(wrapKey), c.wrapKey)
    // node:crypto の HKDF でも同じ
    const nodeHkdf = (info) =>
      toHex(new Uint8Array(hkdfSync('sha256', fromHex(c.masterKey), new Uint8Array(0), info, 32)))
    assert.equal(nodeHkdf(INFO_AUTH), c.authKey)
    assert.equal(nodeHkdf(INFO_WRAP), c.wrapKey)
    if (c.passwordNfc) assert.equal(toHex(await deriveMasterKey(c.passwordNfc, c.kdf)), c.masterKey)
    assert.equal(b64Decode(c.kdf.salt).length, 16)
  }
})

test('保管庫鍵の包み込みのベクタが一致し、展開できる', async () => {
  const w = V.wrap
  const env = await seal(fromHex(w.wrapKey), fromHex(w.vaultKey), fromHex(w.nonce))
  assert.deepEqual(env, w.envelope)
  assert.equal(env.c, nodeGcm(w.wrapKey, w.nonce, fromHex(w.vaultKey)))
  assert.equal(toHex(await unwrapVaultKey(fromHex(w.wrapKey), w.envelope)), w.vaultKey)
})

test('アイテム（ログイン・メモ・カード）のベクタが一致し、復号できる', async () => {
  for (const [key, kind] of [
    ['item', 'login'],
    ['noteItem', 'note'],
    ['cardItem', 'card']
  ]) {
    const it = V[key]
    const env = await seal(fromHex(it.vaultKey), utf8Encode(it.plaintext), fromHex(it.nonce))
    assert.deepEqual(env, it.envelope, key)
    assert.equal(env.c, nodeGcm(it.vaultKey, it.nonce, utf8Encode(it.plaintext)))
    assert.deepEqual(await decryptItem(fromHex(it.vaultKey), it.id, it.envelope), {
      kind,
      item: JSON.parse(it.plaintext)
    })
  }
})

test('URL の照合（コピーの抜き取り確認。網羅は kypr の url-match.test.ts）', () => {
  const login = (uri, match) => ({ uris: [{ uri, match }] })
  assert.equal(
    loginMatchesPage(login('https://example.co.jp', null), 'https://www.example.co.jp/login'),
    true
  )
  assert.equal(loginMatchesPage(login('https://alice.github.io', 0), 'https://bob.github.io/'), false)
  assert.equal(loginMatchesPage(login('https://example.com', 0), 'http://example.com/'), false)
})

test('VENDORED.md にコピー元のコミットが書いてある', () => {
  const md = fs.readFileSync(new URL('../src/vendor/kypr/VENDORED.md', import.meta.url), 'utf8')
  assert.match(md, /コピー元のコミット: `[0-9a-f]{40}`/)
})
