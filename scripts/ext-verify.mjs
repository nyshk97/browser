#!/usr/bin/env node
/**
 * materialize 済みの拡張が lock と一致しているか検証する。
 * 起動前・CI で回して「lock と実体が乖離した状態で動いていた」を防ぐ。
 *
 * 検証するのは3層:
 *   1. 展開済みツリー全体の hash（= 実際に実行されるコード）
 *   2. manifest の version と、manifest.key から導出される拡張 ID
 *   3. 取得元アーカイブの sha256（キャッシュが残っている場合）
 *
 * 1 が本命。2 と 3 だけだと展開後の JS を書き換えられても PASS してしまう。
 */
import fs from 'node:fs'
import path from 'node:path'
import { extensionIdFromPublicKey } from './lib/crx.mjs'
import { artifactDir, cachePath, hashExtensionTree, readLock, sha256File } from './lib/lock.mjs'

const lock = readLock()
let failed = 0

function fail(message) {
  console.error(`✗ ${message}`)
  failed += 1
}

function pass(message) {
  console.log(`✓ ${message}`)
}

for (const entry of lock.extensions) {
  const dir = artifactDir(entry)
  const manifestPath = path.join(dir, 'manifest.json')

  if (!fs.existsSync(manifestPath)) {
    fail(`${entry.id}@${entry.version}: artifact が無い (${dir}) — pnpm ext:fetch を実行する`)
    continue
  }

  // 1. 実際に実行されるコードの検証
  if (!entry.treeSha256) {
    fail(`${entry.id}: lock に treeSha256 が無い — pnpm ext:fetch で作り直す`)
  } else {
    let actual = null
    try {
      actual = hashExtensionTree(dir)
    } catch (error) {
      fail(`${entry.id}: ツリーの hash を計算できない (${error.message})`)
    }
    if (actual !== null) {
      if (actual !== entry.treeSha256) {
        fail(
          `${entry.id}: 展開済みツリーが lock と違う（展開後のコードが書き換わっている）\n` +
            `    expected ${entry.treeSha256}\n    actual   ${actual}`
        )
      } else {
        pass(`${entry.id}: 展開済みツリーの sha256 一致`)
      }
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  // 2. manifest の中身
  if (manifest.version !== entry.version) {
    fail(`${entry.id}: version 不一致 (lock ${entry.version} / artifact ${manifest.version})`)
  } else {
    pass(`${entry.id}: version ${manifest.version}`)
  }

  if (entry.manifestKey) {
    if (manifest.key !== entry.manifestKey) {
      fail(`${entry.id}: manifest.key が lock の manifestKey と違う`)
    } else if (extensionIdFromPublicKey(manifest.key) !== entry.id) {
      fail(`${entry.id}: manifest.key から導出される ID が lock と違う`)
    } else {
      pass(`${entry.id}: manifest.key から導出される ID が一致`)
    }
  } else {
    fail(`${entry.id}: manifestKey が未設定（unpacked 扱いになり ID が安定しない）`)
  }

  // 3. 取得元アーカイブ
  const cache = cachePath(entry)
  if (!fs.existsSync(cache)) {
    console.warn(`  … アーカイブのキャッシュが無いので sha256 は未検証 (${cache})`)
  } else {
    const hash = sha256File(cache)
    if (hash !== entry.sha256) fail(`${entry.id}: アーカイブの sha256 不一致`)
    else pass(`${entry.id}: アーカイブ sha256 一致`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 件の不一致`)
  process.exit(1)
}
console.log('\nlock と実体は一致している')
