#!/usr/bin/env node
/**
 * 拡張 lock の往復テスト（初回 materialize → 更新 → ロールバック）。
 *
 * ネットワークもリポジトリ本体の lock も使わない。
 * 偽の拡張を作って zip に固め、キャッシュの置き場所に先回りで置くことで
 * `ext-fetch` のダウンロード経路だけ迂回し、それ以外は本番と同じ経路を通す。
 *
 * このテストが無い間に「`--update` で `sha256` は消したが `treeSha256` を消し忘れる」
 * バグを踏んだ。更新経路は手で回すまで気づけないので、ここで固定する。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { extensionIdFromPublicKey } from './lib/crx.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 拡張 ID を決めるための公開鍵を1つ作る（DER / base64、manifest.key と同じ形式）。 */
function makeExtensionKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return der.toString('base64')
}

/** 指定バージョンの偽拡張 zip をキャッシュの置き場所に作る。 */
function seedArchive(cacheDir, extensionId, version, body) {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({ manifest_version: 3, name: 'Fake', version, background: {} }, null, 2)
    )
  )
  zip.addFile('background.js', Buffer.from(body))
  const dest = path.join(cacheDir, extensionId, version, `fake-${version}.zip`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, zip.toBuffer())
  return dest
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-extlock-'))
  const key = makeExtensionKey()
  const extensionId = extensionIdFromPublicKey(key)
  const dirs = {
    root,
    lock: path.join(root, 'extensions.lock.json'),
    extensions: path.join(root, 'extensions'),
    cache: path.join(root, 'cache')
  }
  const lock = {
    lockfileVersion: 1,
    extensions: [
      {
        id: extensionId,
        name: 'Fake',
        version: '1.0.0',
        source: {
          type: 'github-release',
          repo: 'example/fake',
          tagTemplate: 'v{version}',
          assetTemplate: 'fake-{version}.zip',
          tag: 'v1.0.0',
          asset: 'fake-1.0.0.zip',
          url: 'https://github.com/example/fake/releases/download/v1.0.0/fake-1.0.0.zip'
        },
        sha256: '',
        treeSha256: '',
        manifestKey: key
      }
    ]
  }
  fs.writeFileSync(dirs.lock, `${JSON.stringify(lock, null, 2)}\n`)
  seedArchive(dirs.cache, extensionId, '1.0.0', '// v1\n')
  seedArchive(dirs.cache, extensionId, '2.0.0', '// v2 — 中身が違う\n')
  return { ...dirs, extensionId, key }
}

function run(script, args, ws) {
  return spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEMO_EXT_LOCK: ws.lock,
      NEMO_EXT_DIR: ws.extensions,
      NEMO_EXT_CACHE: ws.cache
    }
  })
}

const readLock = (ws) => JSON.parse(fs.readFileSync(ws.lock, 'utf8')).extensions[0]

test('初回 materialize で sha256 と treeSha256 が埋まり、ID が manifestKey どおりになる', () => {
  const ws = makeWorkspace()
  try {
    const result = run('ext-fetch.mjs', [], ws)
    assert.equal(result.status, 0, result.stdout + result.stderr)

    const entry = readLock(ws)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.match(entry.treeSha256, /^[0-9a-f]{64}$/)

    const manifest = JSON.parse(
      fs.readFileSync(path.join(ws.extensions, ws.extensionId, '1.0.0_0', 'manifest.json'), 'utf8')
    )
    assert.equal(manifest.key, ws.key)
    assert.equal(extensionIdFromPublicKey(manifest.key), ws.extensionId)

    assert.equal(run('ext-verify.mjs', [], ws).status, 0)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('--update は派生フィールドを作り直す（旧版の hash を持ち越さない）', () => {
  const ws = makeWorkspace()
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)
    const before = readLock(ws)

    const updated = run('ext-fetch.mjs', ['--update', '2.0.0'], ws)
    assert.equal(updated.status, 0, updated.stdout + updated.stderr)

    const after = readLock(ws)
    assert.equal(after.version, '2.0.0')
    assert.equal(after.source.tag, 'v2.0.0')
    assert.equal(after.source.asset, 'fake-2.0.0.zip')
    // 中身が違うので両方の hash が変わっていること
    assert.notEqual(after.sha256, before.sha256)
    assert.notEqual(after.treeSha256, before.treeSha256)
    // 拡張 ID は版に依らず不変（chrome.storage を失わないための肝）
    assert.equal(after.id, before.id)

    assert.equal(run('ext-verify.mjs', [], ws).status, 0)
    // 旧版のディレクトリは掃除されている
    assert.deepEqual(fs.readdirSync(path.join(ws.extensions, ws.extensionId)), ['2.0.0_0'])
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('lock を書き戻せばロールバックできる（キャッシュから復元・ネットワーク不要）', () => {
  const ws = makeWorkspace()
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)
    const v1 = readLock(ws)
    assert.equal(run('ext-fetch.mjs', ['--update', '2.0.0'], ws).status, 0)

    // `mise run ext:rollback` は git で lock を戻して ext:fetch するだけ
    fs.writeFileSync(
      ws.lock,
      `${JSON.stringify({ lockfileVersion: 1, extensions: [v1] }, null, 2)}\n`
    )
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)

    const restored = readLock(ws)
    assert.equal(restored.version, '1.0.0')
    assert.equal(restored.treeSha256, v1.treeSha256)
    assert.equal(run('ext-verify.mjs', [], ws).status, 0)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('展開後のファイルを書き換えると ext-verify が落ちる', () => {
  const ws = makeWorkspace()
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)
    const target = path.join(ws.extensions, ws.extensionId, '1.0.0_0', 'background.js')
    fs.appendFileSync(target, '\n// tampered\n')

    const verified = run('ext-verify.mjs', [], ws)
    assert.equal(verified.status, 1)
    assert.match(verified.stdout + verified.stderr, /展開済みツリーが lock と違う/)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('lock の sha256 を書き換えると ext-fetch が止まる', () => {
  const ws = makeWorkspace()
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)
    const entry = readLock(ws)
    entry.sha256 = '0'.repeat(64)
    fs.writeFileSync(
      ws.lock,
      `${JSON.stringify({ lockfileVersion: 1, extensions: [entry] }, null, 2)}\n`
    )

    const result = run('ext-fetch.mjs', [], ws)
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /sha256 mismatch/)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

// --- lock のスキーマ検証（壊れた lock で再帰削除されないこと）

test('壊れた lock は読み込み時に弾かれる', async () => {
  const { validateLock, artifactDirFor } = await import('../src/shared/ext-lock.js')
  const valid = {
    lockfileVersion: 1,
    extensions: [
      {
        id: 'a'.repeat(32),
        name: 'x',
        version: '1.0.0',
        source: { type: 'github-release', url: 'https://example.com/x.zip' },
        sha256: '',
        treeSha256: ''
      }
    ]
  }
  assert.doesNotThrow(() => validateLock(structuredClone(valid)))

  const cases = [
    ['id が ..', (l) => (l.extensions[0].id = '..')],
    ['id にスラッシュ', (l) => (l.extensions[0].id = `${'a'.repeat(32)}/..`)],
    ['id が短い', (l) => (l.extensions[0].id = 'abc')],
    ['id に許可外の文字', (l) => (l.extensions[0].id = 'z'.repeat(32))],
    ['version にパス', (l) => (l.extensions[0].version = '../../etc')],
    ['version が空', (l) => (l.extensions[0].version = '')],
    ['url が http', (l) => (l.extensions[0].source.url = 'http://example.com/x.zip')],
    ['url が file', (l) => (l.extensions[0].source.url = 'file:///etc/passwd')],
    ['unpackedRoot が絶対パス', (l) => (l.extensions[0].unpackedRoot = '/etc')],
    ['unpackedRoot が親を指す', (l) => (l.extensions[0].unpackedRoot = '../..')],
    ['sha256 が hex でない', (l) => (l.extensions[0].sha256 = 'ZZZZ')],
    ['lockfileVersion が違う', (l) => (l.lockfileVersion = 2)],
    ['extensions が配列でない', (l) => (l.extensions = {})]
  ]
  for (const [label, mutate] of cases) {
    const broken = structuredClone(valid)
    mutate(broken)
    assert.throws(() => validateLock(broken), undefined, `${label} が通ってしまった`)
  }

  // パス組み立ても単体で防ぐ
  assert.throws(() => artifactDirFor('/tmp/base', { id: '..', version: '1.0.0' }))
  assert.throws(() => artifactDirFor('/tmp/base', { id: 'a'.repeat(32), version: '../x' }))
  assert.equal(
    artifactDirFor('/tmp/base', { id: 'a'.repeat(32), version: '1.2.3' }),
    `/tmp/base/${'a'.repeat(32)}/1.2.3_0`
  )
})

test('壊れた lock を置いても ext-fetch / ext-verify が何も消さずに止まる', () => {
  const ws = makeWorkspace()
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)
    const canary = path.join(ws.root, 'canary.txt')
    fs.writeFileSync(canary, 'これが消えたら再帰削除が効いている')

    const entry = readLock(ws)
    entry.id = '..'
    fs.writeFileSync(
      ws.lock,
      `${JSON.stringify({ lockfileVersion: 1, extensions: [entry] }, null, 2)}\n`
    )

    const fetched = run('ext-fetch.mjs', [], ws)
    assert.equal(fetched.status, 1)
    const verified = run('ext-verify.mjs', [], ws)
    assert.equal(verified.status, 1)
    assert.ok(fs.existsSync(canary), 'canary が消えている（再帰削除が走った）')
    assert.ok(fs.existsSync(path.join(ws.extensions, ws.extensionId, '1.0.0_0', 'manifest.json')))
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('extensions/<id> が symlink でも外部を削除しない（canary）', () => {
  const ws = makeWorkspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-outside-'))
  try {
    assert.equal(run('ext-fetch.mjs', [], ws).status, 0)

    // リポジトリ外を模したディレクトリに canary を置く
    const canary = path.join(outside, 'canary.txt')
    fs.writeFileSync(canary, 'これが消えたら symlink 経由で外を消している')
    fs.mkdirSync(path.join(outside, 'victim'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'victim', 'data.txt'), 'x')

    // extensions/<正しい形式の id> を外部ディレクトリへの symlink にすり替える
    const extRoot = path.join(ws.extensions, ws.extensionId)
    fs.rmSync(extRoot, { recursive: true, force: true })
    fs.symlinkSync(outside, extRoot)

    // prune が走る経路（--update）を通す
    const result = run('ext-fetch.mjs', ['--update', '2.0.0'], ws)
    assert.equal(result.status, 1, 'symlink を通してしまった')
    assert.match(result.stdout + result.stderr, /シンボリックリンク/)

    assert.ok(fs.existsSync(canary), 'canary が消えた（外部を削除している）')
    assert.ok(fs.existsSync(path.join(outside, 'victim', 'data.txt')), 'victim が消えた')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('safeJoin は base より下の symlink を拒否し、base 上の symlink は許す', async () => {
  const { safeJoin } = await import('../src/shared/ext-lock.js')
  // macOS の一時ディレクトリは /var -> /private/var を経由する。
  // base より上の symlink まで拒否すると何も通らなくなるので、そこは許す。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-safejoin-'))
  try {
    assert.ok(root.startsWith('/var/') || root.startsWith('/private/var/'))
    assert.doesNotThrow(() => safeJoin(root, ['a', 'b']))

    fs.mkdirSync(path.join(root, 'real'), { recursive: true })
    fs.symlinkSync('/etc', path.join(root, 'link'))
    assert.throws(() => safeJoin(root, ['link']), /シンボリックリンク/)
    assert.throws(() => safeJoin(root, ['link', 'passwd']), /シンボリックリンク/)
    assert.doesNotThrow(() => safeJoin(root, ['real']))

    assert.throws(() => safeJoin(root, ['..']), /想定ディレクトリの外/)
    assert.throws(() => safeJoin(root, ['a', '..', '..']), /想定ディレクトリの外/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
