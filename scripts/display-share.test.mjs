#!/usr/bin/env node
/**
 * 画面共有の純粋関数のテスト（`src/shared/display-share.js`）。Electron 不要。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  displayLabelsForLog,
  effectivePermission,
  matchSourceForDisplay,
  needsDisplayChoice,
  orderDisplaysForShare
} from '../src/shared/display-share.js'
import { sanitizeDetail } from '../src/shared/log-redact.js'

const d = (id, label = `D${id}`) => ({ id, label, width: 1920, height: 1080 })

test('getDisplayMedia 由来の media（mediaTypes 空配列）だけ display-capture に読み替える', () => {
  assert.equal(effectivePermission('media', []), 'display-capture')
  assert.equal(effectivePermission('media', ['audio']), 'media')
  assert.equal(effectivePermission('media', ['audio', 'video']), 'media')
  // 形が変わったら「カメラとマイク」の確認が出る側（今と同じ）に倒れる
  assert.equal(effectivePermission('media', undefined), 'media')
  assert.equal(effectivePermission('camera', []), 'camera')
  assert.equal(effectivePermission('geolocation', undefined), 'geolocation')
})

test('1 枚なら選ばせない、2 枚以上で選ばせる', () => {
  assert.equal(needsDisplayChoice([]), false)
  assert.equal(needsDisplayChoice([d(1)]), false)
  assert.equal(needsDisplayChoice([d(1), d(2)]), true)
})

test('要求元のディスプレイを末尾に回し、印を付ける', () => {
  const ordered = orderDisplaysForShare([d(1), d(2)], 1)
  assert.deepEqual(
    ordered.map((x) => [x.id, x.isRequester]),
    [
      [2, false],
      [1, true]
    ]
  )
})

test('3 枚: 要求元以外は元の順のまま先頭、要求元が末尾', () => {
  const ordered = orderDisplaysForShare([d(1), d(2), d(3)], 2)
  assert.deepEqual(
    ordered.map((x) => [x.id, x.isRequester]),
    [
      [1, false],
      [3, false],
      [2, true]
    ]
  )
})

test('要求元が分からなければ元の順のまま、印は全部 false', () => {
  const ordered = orderDisplaysForShare([d(1), d(2)], null)
  assert.deepEqual(
    ordered.map((x) => [x.id, x.isRequester]),
    [
      [1, false],
      [2, false]
    ]
  )
})

test('source は display_id（文字列）と Display.id（数値）で突き合わせる', () => {
  const sources = [
    { id: 'screen:1:0', display_id: '69734406' },
    { id: 'screen:2:0', display_id: '4' }
  ]
  assert.equal(matchSourceForDisplay(sources, 4)?.id, 'screen:2:0')
  assert.equal(matchSourceForDisplay(sources, 69734406)?.id, 'screen:1:0')
  assert.equal(matchSourceForDisplay(sources, 5), null)
  assert.equal(matchSourceForDisplay([], 4), null)
})

test('ログ用の一覧は sanitizeDetail を素通りする（[deep] / 切り詰めが出ない）', () => {
  const labels = displayLabelsForLog([d(1, 'Studio Display'), d(2, '内蔵ディスプレイ'), d(3, '')])
  const detail = { allowed: true, displays: labels.length, labels }
  const before = JSON.stringify(detail)
  const after = JSON.stringify(sanitizeDetail({ ...detail }))
  assert.equal(after, before)
  assert.equal(labels[2], '? 1920x1080')
  assert.ok(!after.includes('[deep]'))
  assert.ok(!after.includes('…'))
})
