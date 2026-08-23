import test from 'node:test'
import assert from 'node:assert/strict'
import { redactUrl, sanitizeDetail } from '../src/shared/log-redact.js'

/**
 * 計画 1-9 のルール（URL のパス以降・フォーム入力値・Vault 情報をログに出さない）を
 * 「書く側の注意」ではなく**出口の変換**で保証していることの回帰テスト。
 */

test('URL は scheme とホストまでに落ちる', () => {
  assert.equal(redactUrl('https://example.com/secret/path?token=abc#frag'), 'https://example.com')
  assert.equal(redactUrl('mailto:someone@example.com'), 'mailto:')
  assert.equal(redactUrl('not a url'), '(unparsable)')
})

test('detail に混ざった URL も自動で落ちる', () => {
  const out = sanitizeDetail({ target: 'https://example.com/a/b?token=xyz' })
  assert.equal(out.target, 'https://example.com')
})

test('秘密になりうるキーは中身を出さない', () => {
  const out = sanitizeDetail({
    password: 'hunter2',
    authorization: 'Bearer x',
    query: '会社の給与',
    title: 'ページのタイトル',
    username: 'me@example.com',
    cookie: 'a=b'
  })
  for (const value of Object.values(out)) assert.equal(value, '[redacted]')
})

test('長い文字列は打ち切る', () => {
  const out = sanitizeDetail({ note: 'x'.repeat(500) })
  assert.ok(String(out.note).length <= 201, String(out.note).length)
})

test('入れ子でも効く', () => {
  const out = sanitizeDetail({ a: { b: { url: 'https://x.example/p?q=1', password: 'p' } } })
  assert.equal(out.a.b.url, 'https://x.example')
  assert.equal(out.a.b.password, '[redacted]')
})

test('深すぎる入れ子は打ち切る', () => {
  const deep = { a: { b: { c: { d: { e: 'x' } } } } }
  assert.equal(sanitizeDetail(deep).a.b.c.d, '[deep]')
})
