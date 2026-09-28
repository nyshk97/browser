import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KYPR_PRODUCTION_SERVER,
  resolveKyprServer,
  resolveKyprTouchIdMode
} from '../src/shared/kypr-config.js'

test('パッケージ版は env があっても本番に向ける', () => {
  assert.deepEqual(
    resolveKyprServer({ testServer: 'http://127.0.0.1:1234', isPackaged: true, verifyMode: true }),
    {
      ok: true,
      url: KYPR_PRODUCTION_SERVER,
      testing: false
    }
  )
})

test('dev 版は env の模擬サーバーへ向ける（オリジンだけ使う）', () => {
  assert.deepEqual(
    resolveKyprServer({ testServer: 'http://127.0.0.1:1234/x', isPackaged: false, verifyMode: true }),
    {
      ok: true,
      url: 'http://127.0.0.1:1234',
      testing: true
    }
  )
})

test('検証モードで宛先が無ければ起動しない（本番に届かない）', () => {
  assert.deepEqual(resolveKyprServer({ testServer: undefined, isPackaged: false, verifyMode: true }), {
    ok: false,
    reason: 'verify-without-server'
  })
  assert.deepEqual(resolveKyprServer({ testServer: '', isPackaged: false, verifyMode: true }), {
    ok: false,
    reason: 'verify-without-server'
  })
})

test('検証モードでない dev 版は本番に向ける（dev 版を常用するため）', () => {
  assert.equal(resolveKyprServer({ testServer: undefined, isPackaged: false, verifyMode: false }).ok, true)
})

test('模擬サーバーは手元の http だけ（外のサーバーへ向けられない）', () => {
  for (const bad of ['https://evil.example', 'http://10.0.0.1:80', 'not a url', 'file:///tmp/x']) {
    assert.deepEqual(
      resolveKyprServer({ testServer: bad, isPackaged: false, verifyMode: true }),
      {
        ok: false,
        reason: 'bad-test-server'
      },
      bad
    )
  }
})

test('Touch ID の差し替えはパッケージ版では効かない', () => {
  assert.equal(resolveKyprTouchIdMode('ok', true), 'real')
  assert.equal(resolveKyprTouchIdMode('ok', false), 'ok')
  assert.equal(resolveKyprTouchIdMode('fail', false), 'fail')
  assert.equal(resolveKyprTouchIdMode('unavailable', false), 'unavailable')
  assert.equal(resolveKyprTouchIdMode('yes', false), 'real')
  assert.equal(resolveKyprTouchIdMode(undefined, false), 'real')
})
