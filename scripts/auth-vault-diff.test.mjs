import test from 'node:test'
import assert from 'node:assert/strict'
import { diffAuthRules } from '../src/shared/auth-vault-diff.js'

const OLD = 1_756_000_000_000
const NEW = 1_756_900_000_000

/** 保管庫側の 1 件。 */
function vault(pattern, overrides = {}) {
  return { pattern, username: 'admin', password: 'pw', ...overrides }
}

/** この Mac 側の 1 件。 */
function local(pattern, overrides = {}) {
  return { pattern, username: 'admin', password: 'pw', enabled: true, ...overrides }
}

const A = '^https://a\\.example/'
const B = '^https://b\\.example/'
const C = '^https://c\\.example/'

test('3 グループに振り分ける', () => {
  const result = diffAuthRules([vault(A), vault(B, { username: 'admin2' }), vault(C)], [local(B), local(C)])
  assert.deepEqual(
    result.missing.map((entry) => entry.pattern),
    [A]
  )
  assert.deepEqual(
    result.differing.map((entry) => entry.pattern),
    [B]
  )
  assert.deepEqual(
    result.same.map((entry) => entry.pattern),
    [C]
  )
})

test('ユーザー名だけ / パスワードだけ / 両方が違うのを見分ける', () => {
  const result = diffAuthRules(
    [
      vault(A, { username: 'other' }),
      vault(B, { password: 'other' }),
      vault(C, { username: 'x', password: 'y' })
    ],
    [local(A), local(B), local(C)]
  )
  assert.equal(result.differing.length, 3)
  const [a, b, c] = result.differing
  assert.deepEqual([a.usernameDiffers, a.passwordDiffers], [true, false])
  assert.deepEqual([b.usernameDiffers, b.passwordDiffers], [false, true])
  assert.deepEqual([c.usernameDiffers, c.passwordDiffers], [true, true])
})

test('両側のユーザー名を返す（画面に admin → admin2 と出すため）', () => {
  const result = diffAuthRules([vault(A, { username: 'admin2' })], [local(A, { username: 'admin' })])
  assert.equal(result.differing[0].fromUsername, 'admin2')
  assert.equal(result.differing[0].toUsername, 'admin')
})

/* ------------------------------------------------------------------ *
 * 無効なルール —— 「黙って復活しない」の要
 * ------------------------------------------------------------------ */

test('この Mac で無効なルールは missing に落ちず same に入る', () => {
  const result = diffAuthRules([vault(A)], [local(A, { enabled: false })])
  assert.deepEqual(result.missing, [])
  assert.equal(result.same.length, 1)
  assert.equal(result.same[0].toEnabled, false)
})

test('この Mac で無効かつ内容が違うルールは differing に入り、無効だと分かる', () => {
  const result = diffAuthRules([vault(A, { password: 'other' })], [local(A, { enabled: false })])
  assert.deepEqual(result.missing, [])
  assert.equal(result.differing.length, 1)
  assert.equal(result.differing[0].toEnabled, false)
})

test('disabledReason も差分に出る（実効無効なので有効フラグだけでは足りない）', () => {
  const result = diffAuthRules(
    [vault(A), vault(B, { password: 'other' })],
    [local(A, { disabledReason: 'pattern-timeout' }), local(B, { disabledReason: 'decrypt-failed' })]
  )
  assert.equal(result.same[0].toDisabledReason, 'pattern-timeout')
  assert.equal(result.differing[0].toDisabledReason, 'decrypt-failed')
})

/* ------------------------------------------------------------------ *
 * updatedAt の向き
 * ------------------------------------------------------------------ */

test('両方に updatedAt があるときだけ向きが出る', () => {
  const newer = diffAuthRules([vault(A, { password: 'x', updatedAt: NEW })], [local(A, { updatedAt: OLD })])
  assert.equal(newer.differing[0].newer, 'from')

  const older = diffAuthRules([vault(A, { password: 'x', updatedAt: OLD })], [local(A, { updatedAt: NEW })])
  assert.equal(older.differing[0].newer, 'to')
})

test('片方に updatedAt が無ければ向きは null（初回移行はこれに当たる）', () => {
  const onlyVault = diffAuthRules([vault(A, { password: 'x', updatedAt: NEW })], [local(A)])
  assert.equal(onlyVault.differing[0].newer, null)

  const onlyLocal = diffAuthRules([vault(A, { password: 'x' })], [local(A, { updatedAt: NEW })])
  assert.equal(onlyLocal.differing[0].newer, null)

  const neither = diffAuthRules([vault(A, { password: 'x' })], [local(A)])
  assert.equal(neither.differing[0].newer, null)
})

test('updatedAt が同じなら向きは出ない', () => {
  const result = diffAuthRules([vault(A, { password: 'x', updatedAt: NEW })], [local(A, { updatedAt: NEW })])
  assert.equal(result.differing[0].newer, null)
})

/* ------------------------------------------------------------------ *
 * 保存側 —— 向きを取り違えると「追加されるもの」を「消えます」と出す
 * ------------------------------------------------------------------ */

test('保存で消えるものは diffAuthRules(vault, localEnabled).missing で得られる', () => {
  // 保管庫には A と B。この Mac の有効なルールは B と C。
  // 保存すると保管庫は B + C になるので、**消えるのは A だけ**
  const vaultRules = [vault(A), vault(B)]
  const localEnabled = [local(B), local(C)]

  const disappearing = diffAuthRules(vaultRules, localEnabled).missing
  assert.deepEqual(
    disappearing.map((entry) => entry.pattern),
    [A]
  )

  // 向きを逆にすると **C（これから追加されるもの）** が出る。これを「消えます」と出してはいけない
  const wrongWay = diffAuthRules(
    localEnabled,
    vaultRules.map((rule) => ({ ...rule, enabled: true }))
  ).missing
  assert.deepEqual(
    wrongWay.map((entry) => entry.pattern),
    [C]
  )
})

test('この Mac で無効なルールは保存で消える側に数えられる', () => {
  // 無効なルールは保管庫に入らない（保存は有効なものだけ）ので、
  // 保管庫にあって手元で無効化したものは**保存すると保管庫から消える**
  const disappearing = diffAuthRules([vault(A)], []).missing
  assert.deepEqual(
    disappearing.map((entry) => entry.pattern),
    [A]
  )
})

/* ------------------------------------------------------------------ *
 * 端 --------------------------------------------------------------- */

test('空の入力でも落ちない', () => {
  assert.deepEqual(diffAuthRules([], []), { missing: [], differing: [], same: [] })
  assert.deepEqual(diffAuthRules(undefined, undefined), { missing: [], differing: [], same: [] })
})
