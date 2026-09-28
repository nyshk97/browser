import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDetail } from '../src/shared/log-redact.js'
import {
  applyCookieChange,
  cookieKey,
  parseSavedCookies,
  toSavedCookie,
  toSetDetails
} from '../src/shared/session-cookies.js'

const base = {
  name: 'sid',
  value: 'abc',
  domain: 'example.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: 'lax'
}

test('セッション cookie だけを保存の形にする（期限付き・壊れたものは null）', () => {
  assert.deepEqual(toSavedCookie(base), {
    name: 'sid',
    value: 'abc',
    domain: 'example.com',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  })
  assert.equal(toSavedCookie({ ...base, session: false, expirationDate: 2e9 }), null)
  assert.equal(toSavedCookie({ ...base, domain: '' }), null)
  assert.equal(toSavedCookie({ ...base, value: 1 }), null)
  assert.equal(toSavedCookie({ ...base, sameSite: 'weird' })?.sameSite, 'unspecified')
})

test('写しは追加・上書き・削除・期限付きへの変化を反映する', () => {
  const mirror = new Map()
  assert.equal(applyCookieChange(mirror, base, false), true)
  assert.equal(mirror.size, 1)
  // 同じ値の再通知は変化なし
  assert.equal(applyCookieChange(mirror, base, false), false)
  // 上書き（消える → 足される）
  assert.equal(applyCookieChange(mirror, base, true), true)
  assert.equal(applyCookieChange(mirror, { ...base, value: 'def' }, false), true)
  assert.equal(mirror.get(cookieKey(base)).value, 'def')
  // 期限付きになったら写しから外す（保存しない）
  assert.equal(applyCookieChange(mirror, { ...base, session: false, expirationDate: 2e9 }, false), true)
  assert.equal(mirror.size, 0)
  // 同じ名前でも domain / path が違えば別の cookie
  applyCookieChange(mirror, base, false)
  applyCookieChange(mirror, { ...base, path: '/app' }, false)
  applyCookieChange(mirror, { ...base, domain: '.example.com', hostOnly: false }, false)
  assert.equal(mirror.size, 3)
})

test('cookies.set の引数: host-only は domain を渡さない・domain cookie は渡す・expirationDate を付けない', () => {
  const hostOnly = toSetDetails(toSavedCookie(base))
  assert.equal(hostOnly.url, 'https://example.com/')
  assert.equal('domain' in hostOnly, false)
  assert.equal('expirationDate' in hostOnly, false)
  const shared = toSetDetails(
    toSavedCookie({ ...base, domain: '.example.com', hostOnly: false, secure: false, path: '/a' })
  )
  assert.equal(shared.url, 'http://example.com/a')
  assert.equal(shared.domain, '.example.com')
  assert.equal(shared.httpOnly, true)
  assert.equal(shared.sameSite, 'lax')
})

test('復号した中身の検査: 配列でなければ空、壊れた要素だけ捨てる', () => {
  assert.deepEqual(parseSavedCookies({}), [])
  assert.deepEqual(parseSavedCookies(null), [])
  const saved = toSavedCookie(base)
  const parsed = parseSavedCookies([saved, null, { name: 'x' }, 'y', { ...saved, name: 'other' }])
  assert.deepEqual(
    parsed.map((c) => c.name),
    ['sid', 'other']
  )
})

test('ログの detail が sanitizeDetail で変わらない', () => {
  for (const detail of [
    { profile: 'page', count: 3, failed: 0, timedOut: false, ms: 12 },
    { phase: 'restore' },
    { profile: 'agent', error: '復号できない' }
  ]) {
    assert.deepEqual(sanitizeDetail(detail), detail)
  }
})
