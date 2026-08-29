import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, versionFromCrxFilename, versionsFromTags } from './lib/ext-version.mjs'

test('バージョンは桁ごとに数値で比べる', () => {
  assert.equal(compareVersions('2026.9.0', '2026.8.0'), 1)
  assert.equal(compareVersions('2026.8.0', '2026.8.0'), 0)
  assert.equal(compareVersions('2026.8.1', '2026.8.0'), 1)
  // 文字列比較だと逆になるところ。ここを間違えると新しい版を見落とす
  assert.equal(compareVersions('2026.10.0', '2026.9.0'), 1)
  // 桁数が違っても比べられる
  assert.equal(compareVersions('2026.8', '2026.8.0'), 0)
  assert.equal(compareVersions('2026.8.0.1', '2026.8.0'), 1)
})

test('並べ替えると最新が末尾に来る', () => {
  const sorted = ['2026.9.0', '2026.10.0', '2026.8.1'].sort(compareVersions)
  assert.equal(sorted.at(-1), '2026.10.0')
})

test('タグは接頭辞で絞る（同じリポジトリの別プロダクトを拾わない）', () => {
  const tags = [
    'browser-v2026.8.0',
    'desktop-v2026.9.0',
    'cli-v2026.12.0',
    'browser-v2026.7.1',
    'web-v2026.11.0',
    'browser-vlatest'
  ]
  assert.deepEqual(versionsFromTags(tags, 'browser-v{version}'), ['2026.8.0', '2026.7.1'])
})

test('オブジェクト形式のタグも読める / 版の形式でないものは落とす', () => {
  const tags = [{ name: 'browser-v2026.8.0' }, { name: 'browser-v../../etc' }, { other: 1 }, null]
  assert.deepEqual(versionsFromTags(tags, 'browser-v{version}'), ['2026.8.0'])
})

test('接尾辞つきのテンプレートにも対応する', () => {
  const tags = ['v1.2.3-browser', 'v1.2.3-desktop']
  assert.deepEqual(versionsFromTags(tags, 'v{version}-browser'), ['1.2.3'])
})

test('Web Store のリダイレクト先ファイル名から版を読む', () => {
  assert.equal(
    versionFromCrxFilename(
      'https://clients2.googleusercontent.com/crx/blobs/AbC-_x/NEEBPLGAKAAHBHDPHMKCKJJCEGOIIJJO_5_64_0_0.crx'
    ),
    '5.64.0.0'
  )
  // manifest の `5.64` と同じ版として比べられる（4 桁に揃えられても新しいと誤認しない）
  assert.equal(compareVersions('5.64.0.0', '5.64'), 0)
  assert.equal(versionFromCrxFilename('https://example.com/not-a-crx.zip'), null)
  assert.equal(versionFromCrxFilename('https://example.com/ABC_1_2.crx'), null)
})
