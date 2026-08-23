#!/usr/bin/env node
/**
 * Chrome Web Store の CRX から拡張の公開鍵を1回だけ抜き出す。
 *
 * GitHub Release の dist-chrome.zip には manifest.key が入っていないため、
 * そのままロードすると unpacked 拡張としてロード元パスから ID が導出され、
 * バージョンを上げるたびに ID が変わって chrome.storage（拡張の設定）が失われる。
 * ここで得た鍵を extensions.lock.json の manifestKey に記録し、
 * ext-fetch が manifest.json へ注入することで ID を Web Store と同じ値に固定する。
 *
 * 使い方: node scripts/ext-webstore-key.mjs <extensionId> [chromeVersion]
 */
import { parseCrx3, webStoreCrxUrl } from './lib/crx.mjs'

const extensionId = process.argv[2]
const chromeVersion = process.argv[3] ?? '132.0.0.0'

if (!extensionId) {
  console.error('使い方: node scripts/ext-webstore-key.mjs <extensionId> [chromeVersion]')
  process.exit(1)
}

const url = webStoreCrxUrl(extensionId, chromeVersion)
console.error(`[ext-webstore-key] GET ${url}`)
const response = await fetch(url, { redirect: 'follow' })
if (!response.ok) {
  console.error(`ダウンロード失敗: ${response.status}`)
  process.exit(1)
}

const crx = parseCrx3(Buffer.from(await response.arrayBuffer()))
if (crx.extensionId !== extensionId) {
  console.error(`ID 不一致: 要求 ${extensionId} / CRX ${crx.extensionId}`)
  process.exit(1)
}

console.error(`[ext-webstore-key] extensionId: ${crx.extensionId}`)
process.stdout.write(`${crx.publicKey}\n`)
