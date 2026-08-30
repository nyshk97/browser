#!/usr/bin/env node
/**
 * CI 用テスト拡張を materialize して lock を書く（`mise run ext:test-build`）。
 *
 * `test-extension/` のソースを `<出力先>/<id>/<version>_0/` に展開し、
 * manifest に公開鍵を注入して**拡張 ID を固定**する。
 * ID が版ごとに変わると `chrome.storage` が別物になり、
 * 「更新をまたいで設定が残るか」の検証が成立しない。
 *
 * 公開鍵は `test-extension.key.json` に置いてコミットする（秘密鍵は使わない。
 * CRX に署名しないので不要）。無ければその場で作って書き出す。
 *
 *   node scripts/make-test-extension.mjs [出力ディレクトリ]
 *
 * 出力: <出力先>/extensions/... と <出力先>/extensions.lock.json
 */
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extensionIdFromPublicKey } from './lib/crx.mjs'
import { hashExtensionTree } from '../src/shared/tree-hash.js'
import { artifactDirFor, validateLock } from '../src/shared/ext-lock.js'
import { projectRoot } from './lib/harness.mjs'

const sourceDir = path.join(projectRoot, 'test-extension')
const keyPath = path.join(projectRoot, 'test-extension.key.json')

const outRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-test-ext-'))

/* ---- 公開鍵（無ければ作ってコミット対象として書き出す） ---- */
let publicKey
if (fs.existsSync(keyPath)) {
  publicKey = JSON.parse(fs.readFileSync(keyPath, 'utf8')).publicKey
} else {
  const { publicKey: generated } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKey = generated.export({ type: 'spki', format: 'der' }).toString('base64')
  fs.writeFileSync(
    keyPath,
    `${JSON.stringify(
      {
        comment:
          'CI 用テスト拡張の公開鍵。拡張 ID をこの鍵から導出して固定するために使う。秘密鍵は保持しない（CRX に署名しないため不要）。',
        publicKey
      },
      null,
      2
    )}\n`
  )
  console.log(`[test-ext] 公開鍵を作った: ${path.relative(projectRoot, keyPath)}`)
}

const extensionId = extensionIdFromPublicKey(publicKey)
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'))
const version = manifest.version

/* ---- 展開 ---- */
const extensionsDir = path.join(outRoot, 'extensions')
const entry = { id: extensionId, version }
const artifactDir = artifactDirFor(extensionsDir, entry)
fs.rmSync(path.join(extensionsDir, extensionId), { recursive: true, force: true })
fs.mkdirSync(artifactDir, { recursive: true })

for (const name of fs.readdirSync(sourceDir)) {
  const from = path.join(sourceDir, name)
  if (!fs.statSync(from).isFile()) continue
  fs.copyFileSync(from, path.join(artifactDir, name))
}
// manifest.key を注入して ID を固定する
fs.writeFileSync(
  path.join(artifactDir, 'manifest.json'),
  `${JSON.stringify({ ...manifest, key: publicKey }, null, 2)}\n`
)

/* ---- lock ---- */
const lock = {
  lockfileVersion: 1,
  comment: 'CI 用テスト拡張の lock。scripts/make-test-extension.mjs が生成する（手で編集しない）。',
  extensions: [
    {
      id: extensionId,
      name: manifest.name,
      version,
      source: { type: 'local', path: 'test-extension' },
      // smoke はツールバーのボタンをクリックして popup の位置を見るので、隠さない
      showInToolbar: true,
      treeSha256: hashExtensionTree(artifactDir)
    }
  ]
}
validateLock(lock)
const lockPath = path.join(outRoot, 'extensions.lock.json')
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

console.log(`[test-ext] id=${extensionId} version=${version}`)
console.log(`[test-ext] extensions: ${extensionsDir}`)
console.log(`[test-ext] lock:       ${lockPath}`)
// 呼び出し側がパスを拾えるように最後の行に出す
process.stdout.write(`${outRoot}\n`)
