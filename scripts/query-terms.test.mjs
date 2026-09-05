import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesAllTerms, splitTerms } from '../src/shared/query-terms.js'

/**
 * コマンドバーの複数語マッチ（`query-terms.js`）のテスト。
 *
 * 「github nyshk97 mobil」で https://github.com/nyshk97/mobile-ide が当たる、を
 * 分割（`splitTerms`）と照合（`matchesAllTerms`）の両面から固定する。
 */

const URL = 'https://github.com/nyshk97/mobile-ide'
const TITLE = 'nyshk97/mobile-ide: Mobile IDE'

test('1 語はそのまま 1 要素（小文字化）', () => {
  assert.deepEqual(splitTerms('GitHub'), ['github'])
})

test('半角空白で複数語に分かれる', () => {
  assert.deepEqual(splitTerms('github nyshk97 mobil'), ['github', 'nyshk97', 'mobil'])
})

test('全角空白・連続空白・前後の空白でも空要素が入らない', () => {
  assert.deepEqual(splitTerms('  github　nyshk97   mobil '), ['github', 'nyshk97', 'mobil'])
})

test('空・空白だけは語 0 個', () => {
  assert.deepEqual(splitTerms(''), [])
  assert.deepEqual(splitTerms(' 　 '), [])
})

test('全語が URL に含まれれば当たる', () => {
  assert.equal(matchesAllTerms(splitTerms('github nyshk97 mobil'), TITLE, URL), true)
})

test('順序が逆でも当たる', () => {
  assert.equal(matchesAllTerms(splitTerms('mobil github'), TITLE, URL), true)
})

test('大文字混在でも当たる（両側を小文字化）', () => {
  assert.equal(matchesAllTerms(splitTerms('GITHUB Mobile'), TITLE, URL), true)
})

test('語が別フィールドにまたがっても当たる（url に github、title だけに IDE）', () => {
  assert.equal(matchesAllTerms(splitTerms('github ide'), 'Mobile IDE', 'https://github.com/x'), true)
})

test('1 語でも当たらなければ false（AND）', () => {
  assert.equal(matchesAllTerms(splitTerms('github nyshk97 zzz-none'), TITLE, URL), false)
})

test('語 0 個は全件一致（空入力のガードは呼び出し側）', () => {
  assert.equal(matchesAllTerms([], TITLE, URL), true)
})
