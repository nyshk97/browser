#!/usr/bin/env node
/**
 * `NEMO_VERIFY_TIMINGS` の解決のテスト。
 *
 * ここが黙ってフォールバックすると「アプリは本番値・verify は縮めたつもり」の
 * ズレが静かに生まれる（＝この仕組みが塞ごうとしている失敗モードそのもの）。
 * だから**エラーになること**を主に固定する。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIMINGS, TIMING_KEYS, resolveTimings } from '../src/shared/timings.js'

test('env が無ければ本番既定値', () => {
  for (const raw of [undefined, null, '']) {
    assert.deepEqual(resolveTimings(raw), DEFAULT_TIMINGS)
  }
})

test('渡したキーだけ上書きされ、残りは既定値のまま', () => {
  const resolved = resolveTimings(JSON.stringify({ sleepSweepMs: 500 }))
  assert.equal(resolved.sleepSweepMs, 500)
  assert.equal(resolved.sessionSaveDebounceMs, DEFAULT_TIMINGS.sessionSaveDebounceMs)
  assert.equal(resolved.sessionStoreDebounceMs, DEFAULT_TIMINGS.sessionStoreDebounceMs)
})

test('既定値を書き換えない（呼ぶたびに新しいオブジェクトを返す）', () => {
  const resolved = resolveTimings(JSON.stringify({ sleepSweepMs: 500 }))
  resolved.sleepSweepMs = 1
  assert.equal(DEFAULT_TIMINGS.sleepSweepMs, 5000)
})

test('知らないキーはエラー（黙って無視しない）', () => {
  assert.throws(() => resolveTimings(JSON.stringify({ sleepSweepMS: 500 })), /知らないキー/)
})

test('JSON として読めなければエラー', () => {
  assert.throws(() => resolveTimings('{sleepSweepMs: 500}'), /JSON として読めない/)
})

test('オブジェクトでなければエラー', () => {
  for (const raw of ['500', '[500]', '"x"', 'null']) {
    assert.throws(() => resolveTimings(raw), /オブジェクトで渡す|JSON として読めない/, raw)
  }
})

test('数値でない値・0 以下・NaN はエラー', () => {
  for (const value of ['"500"', '0', '-1', 'null', 'true']) {
    assert.throws(() => resolveTimings(`{"sleepSweepMs": ${value}}`), /正の数で渡す/, value)
  }
})

test('TIMING_KEYS は既定値のキーと一致する', () => {
  assert.deepEqual([...TIMING_KEYS].sort(), Object.keys(DEFAULT_TIMINGS).sort())
})
