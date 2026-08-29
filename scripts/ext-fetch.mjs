#!/usr/bin/env node
/**
 * lock された不変 artifact を取得し、拡張ディレクトリに materialize する。
 *
 * 設計の前提（Phase 0 で確定した内容）:
 * - Chrome Web Store の installExtension はバージョン指定ができず「常に最新版」しか取れない。
 *   よって lock からの再現インストールは Web Store 経由では成立しない。
 * - 代わりに「バージョン付き URL + sha256」を lock に持ち、そこから直接展開する。
 * - Web Store にしか無い拡張（Keepa 等）は `chrome-web-store` ソースで扱う。取れるのは常に最新版なので、
 *   **取った CRX の版が lock と違えば止める**（黙って別の版を入れない）。取れた CRX は
 *   `.ext-cache` に版付きで残るので、それ以降は Web Store が先へ進んでも同じ版を復元できる。
 *   CRX の公開鍵は lock の `manifestKey` と突き合わせ、ID が変わっていないことも見る。
 * - unpacked 拡張は ID がロード元パスから導出されるため、版が変わると ID も変わり
 *   chrome.storage（= 拡張の設定）が失われる。これを避けるため manifest.key を注入して
 *   ID を Web Store と同じ値に固定する。
 * - lock には**展開・key 注入まで済んだツリーの hash（treeSha256）**も記録する。
 *   アーカイブの hash だけでは、展開後のファイルを書き換えられても検知できないため。
 *   main プロセスは起動時にこれを照合し、一致しなければロードしない。
 *
 * 使い方:
 *   node scripts/ext-fetch.mjs                    lock どおりに materialize する
 *   node scripts/ext-fetch.mjs --update <version> 対象版へ lock を張り替える
 *   node scripts/ext-fetch.mjs --update <version> --id <extensionId>
 *   （chrome-web-store は Web Store が今配っている版しか指定できない。
 *     版は `mise run ext:outdated` で分かる）
 *
 * ロールバック:
 *   git checkout extensions.lock.json && node scripts/ext-fetch.mjs
 *   （旧 artifact は .ext-cache に残るのでネットワーク無しで戻せる）
 */
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { extensionIdFromPublicKey, parseCrx3 } from './lib/crx.mjs'
import {
  artifactDir,
  cachePath,
  download,
  webStoreDownloadUrl,
  extensionRootFor,
  extensionsDir,
  hashExtensionTree,
  readLock,
  safeJoin,
  sha256File,
  writeLock
} from './lib/lock.mjs'

const args = process.argv.slice(2)
const updateIndex = args.indexOf('--update')
const updateVersion = updateIndex === -1 ? null : args[updateIndex + 1]
const idIndex = args.indexOf('--id')
const onlyId = idIndex === -1 ? null : args[idIndex + 1]

function info(message) {
  console.log(`[ext-fetch] ${message}`)
}

/** GitHub Release のバージョン付き asset URL を組み立てる。 */
function githubAssetUrl(entry, version) {
  const { repo, tagTemplate, assetTemplate } = entry.source
  if (!repo || !tagTemplate || !assetTemplate) {
    throw new Error(`${entry.id}: source に repo / tagTemplate / assetTemplate が必要`)
  }
  const tag = tagTemplate.replaceAll('{version}', version)
  const asset = assetTemplate.replaceAll('{version}', version)
  return {
    tag,
    asset,
    url: `https://github.com/${repo}/releases/download/${tag}/${asset}`
  }
}

/**
 * lock のうち「取得した実体から決まる」フィールド。
 * 版を張り替えたらまとめて作り直す。
 * ここを1つでも消し忘れると、旧版の hash と新版の実体を突き合わせて必ず失敗する
 * （個別に `entry.sha256 = ''` と書いていて `treeSha256` を取りこぼした実績あり）。
 */
const DERIVED_FIELDS = ['sha256', 'treeSha256']

function clearDerivedFields(entry) {
  for (const field of DERIVED_FIELDS) entry[field] = ''
}

function assertDerivedFieldsFilled(entry) {
  const missing = DERIVED_FIELDS.filter((field) => !entry[field])
  if (missing.length > 0) {
    throw new Error(`${entry.id}: lock の ${missing.join(' / ')} が埋まっていない`)
  }
}

/** zip 内で manifest.json があるディレクトリを探す（深さ2まで）。 */
function findManifestRoot(rootDir) {
  if (fs.existsSync(path.join(rootDir, 'manifest.json'))) return rootDir
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(rootDir, entry.name)
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate
  }
  throw new Error('manifest.json が見つからない')
}

async function materialize(entry) {
  const target = artifactDir(entry)
  const cache = cachePath(entry)
  const isWebStore = entry.source.type === 'chrome-web-store'

  // Web Store は最新版しか返さないので、版を確かめるまではキャッシュに入れない
  // （入れてしまうと「lock の版のキャッシュ」に別の版が居座る）
  let archive = cache
  if (!fs.existsSync(cache)) {
    const url = isWebStore ? webStoreDownloadUrl(entry) : entry.source.url
    info(`download ${url}`)
    archive = isWebStore ? `${cache}.download` : cache
    await download(url, archive)
  } else {
    info(`cache hit ${path.relative(process.cwd(), cache)}`)
  }

  try {
    await materializeArchive(entry, archive, cache, target)
  } finally {
    if (archive !== cache) fs.rmSync(archive, { force: true })
  }
}

async function materializeArchive(entry, archive, cache, target) {
  const isWebStore = entry.source.type === 'chrome-web-store'
  const actualHash = sha256File(archive)
  if (entry.sha256 && entry.sha256 !== actualHash) {
    // キャッシュが壊れている / 上流が同じ URL で差し替えた可能性
    throw new Error(`${entry.id}: sha256 mismatch\n  expected ${entry.sha256}\n  actual   ${actualHash}`)
  }
  entry.sha256 = actualHash

  // 一時ディレクトリで検証してから原子的に入れ替える
  const tmp = safeJoin(
    extensionRootFor(extensionsDir, entry),
    [`.tmp-${process.pid}-${Date.now()}`],
    'tmpDir'
  )
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  try {
    let crx = null
    if (isWebStore) {
      crx = parseCrx3(fs.readFileSync(archive))
      if (crx.extensionId !== entry.id) {
        throw new Error(`${entry.id}: CRX の ID が lock と違う (${crx.extensionId})`)
      }
      if (entry.manifestKey && entry.manifestKey !== crx.publicKey) {
        throw new Error(
          `${entry.id}: CRX の公開鍵が lock の manifestKey と違う（ID は同じでも鍵が差し替わっている）`
        )
      }
      entry.manifestKey = crx.publicKey
    }
    new AdmZip(crx ? crx.zip : archive).extractAllTo(tmp, true)
    const manifestRoot = entry.unpackedRoot
      ? safeJoin(tmp, entry.unpackedRoot.split('/').filter(Boolean), 'unpackedRoot')
      : safeJoin(tmp, [path.relative(tmp, findManifestRoot(tmp))].filter(Boolean), 'manifestRoot')
    const manifestPath = path.join(manifestRoot, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    if (manifest.version !== entry.version) {
      if (isWebStore) {
        throw new Error(
          `${entry.id}: Web Store が配っているのは ${manifest.version}（lock は ${entry.version}）。\n` +
            `  Web Store は最新版しか返さないので、この端末では lock の版を取れない。\n` +
            `  更新するなら: mise run ext:update ${manifest.version} --id ${entry.id}\n` +
            `  lock の版のまま使うなら: .ext-cache を持っている端末から ${path.relative(process.cwd(), cache)} を持ってくる`
        )
      }
      throw new Error(
        `${entry.id}: manifest version mismatch (lock ${entry.version} / artifact ${manifest.version})`
      )
    }
    // 版が lock と一致した CRX だけをキャッシュに残す
    if (archive !== cache) fs.renameSync(archive, cache)

    // 拡張 ID を版に依らず固定する
    if (entry.manifestKey) {
      const derivedId = extensionIdFromPublicKey(entry.manifestKey)
      if (derivedId !== entry.id) {
        throw new Error(`${entry.id}: manifestKey から導出される ID が一致しない (${derivedId})`)
      }
      manifest.key = entry.manifestKey
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    } else {
      console.warn(
        `[ext-fetch] 警告: ${entry.id} に manifestKey が無い。` +
          'unpacked 拡張として読み込まれ、ID がロード元パスから決まる（版を上げると設定が失われる）'
      )
    }

    // manifestRoot が zip のサブディレクトリだった場合はそこを実体にする
    const staged = manifestRoot

    // manifest.key 注入まで済んだ状態のツリー hash を lock に残す。
    // アーカイブの hash だけだと、展開後の JS を書き換えられても検知できない。
    const treeHash = hashExtensionTree(staged)
    if (entry.treeSha256 && entry.treeSha256 !== treeHash) {
      throw new Error(
        `${entry.id}: 展開後のツリー hash が lock と一致しない\n  expected ${entry.treeSha256}\n  actual   ${treeHash}`
      )
    }
    entry.treeSha256 = treeHash

    let backup = null
    if (fs.existsSync(target)) {
      backup = safeJoin(
        extensionRootFor(extensionsDir, entry),
        [`${path.basename(target)}.bak-${Date.now()}`],
        'backupDir'
      )
      fs.renameSync(target, backup)
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(staged, target)
    } catch (error) {
      if (backup) fs.renameSync(backup, target)
      throw error
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true })

    info(`materialized ${entry.id}@${entry.version} -> ${path.relative(process.cwd(), target)}`)
    info(`  archive sha256: ${entry.sha256}`)
    info(`  tree sha256:    ${treeHash}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** lock に無い版のディレクトリを掃除する（起動時に古い版が拾われるのを防ぐ）。 */
function pruneStaleVersions(entry) {
  // ここは再帰削除をするので、対象が必ず extensionsDir の中であることを resolve 後に確認する
  const dir = extensionRootFor(extensionsDir, entry)
  if (!fs.existsSync(dir)) return
  const keep = `${entry.version}_0`
  for (const name of fs.readdirSync(dir)) {
    if (name === keep) continue
    // 削除の直前にもう一度確認する。`extensions/<id>` 自体が symlink なら
    // readdir はリンク先を列挙してしまい、字句上の検証だけでは外を消せる
    const victim = safeJoin(dir, [name], 'pruneTarget')
    fs.rmSync(victim, { recursive: true, force: true })
    info(`pruned ${entry.id}/${name}`)
  }
}

const lock = readLock()
const targets = onlyId ? lock.extensions.filter((e) => e.id === onlyId) : lock.extensions
if (targets.length === 0) {
  console.error('[ext-fetch] 対象の拡張が lock にない')
  process.exit(1)
}

async function run() {
  for (const entry of targets) {
    if (updateVersion) {
      if (entry.source.type === 'github-release') {
        const { tag, asset, url } = githubAssetUrl(entry, updateVersion)
        entry.source.tag = tag
        entry.source.asset = asset
        entry.source.url = url
      } else if (entry.source.type !== 'chrome-web-store') {
        throw new Error(`${entry.id}: --update は github-release / chrome-web-store ソースのみ対応`)
      }
      // chrome-web-store は URL に版が無い。取った CRX の版が updateVersion と違えば materialize が止める
      info(`update ${entry.id}: ${entry.version} -> ${updateVersion}`)
      entry.version = updateVersion
      clearDerivedFields(entry)
    }
    await materialize(entry)
    assertDerivedFieldsFilled(entry)
    pruneStaleVersions(entry)
  }

  writeLock(lock)
  info('done')
}

try {
  await run()
} catch (error) {
  console.error(`[ext-fetch] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
