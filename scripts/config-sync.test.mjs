import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  SYNC_SCHEMA_VERSION,
  hasConflictMarkers,
  stringify,
  validateManifest,
  validateSyncedFile
} from '../src/shared/sync-schema.js'
import {
  PINS_VERSION,
  SETTINGS_VERSION,
  normalizePins,
  normalizeSettings
} from '../src/shared/settings-schema.js'

const SETTINGS_SPEC = { name: 'settings.json', version: SETTINGS_VERSION, normalize: normalizeSettings }
const PINS_SPEC = { name: 'pins.json', version: PINS_VERSION, normalize: normalizePins }

/* ------------------------------------------------------------------ *
 * スキーマ検証
 * ------------------------------------------------------------------ */

test('コンフリクトマーカーの残った JSON は読まない', () => {
  const text = [
    '{',
    '<<<<<<< HEAD',
    '  "version": 1,',
    '=======',
    '  "version": 1,',
    '>>>>>>> origin/main',
    '  "data": {}',
    '}'
  ].join('\n')
  assert.equal(hasConflictMarkers(text), true)
  assert.throws(() => validateSyncedFile(SETTINGS_SPEC, text), /コンフリクトマーカー/)
})

test('マーカーに見える文字列でも行頭でなければ通す', () => {
  const text = stringify({ version: 1, data: { searchTemplate: 'https://example.com/?q={q}&x=<<<<<<<' } })
  assert.equal(hasConflictMarkers(text), false)
})

test('version の無い JSON は拒否する', () => {
  assert.throws(() => validateSyncedFile(SETTINGS_SPEC, JSON.stringify({ data: {} })), /version/)
})

test('この Nemo より新しい version は拒否する（古い Nemo が新しい JSON を壊さない）', () => {
  const text = JSON.stringify({ version: SETTINGS_VERSION + 1, data: {} })
  assert.throws(() => validateSyncedFile(SETTINGS_SPEC, text), /新しい/)
})

test('壊れた値は正規化されて既定値に落ちる', () => {
  const text = JSON.stringify({
    version: SETTINGS_VERSION,
    data: { tabSleepMinutes: 'あ', searchTemplate: 'ftp://x/{q}' }
  })
  const result = validateSyncedFile(SETTINGS_SPEC, text)
  assert.equal(result.data.tabSleepMinutes, 30)
  assert.equal(result.data.searchTemplate, 'https://www.google.com/search?q={q}')
})

test('ピン留めの URL は http/https 以外を落とす', () => {
  const text = JSON.stringify({
    version: PINS_VERSION,
    data: {
      favorites: [{ id: 'a', url: 'file:///etc/passwd', title: 'x' }],
      pinned: [{ id: 'b', kind: 'link', url: 'https://example.com/', title: 'ok' }]
    }
  })
  const result = validateSyncedFile(PINS_SPEC, text)
  assert.equal(result.data.favorites.length, 0)
  assert.equal(result.data.pinned.length, 1)
})

test('manifest は未来の syncSchemaVersion を拒否する', () => {
  assert.deepEqual(
    validateManifest({ syncSchemaVersion: SYNC_SCHEMA_VERSION, updatedAt: 'x', appVersion: '1' })
      .syncSchemaVersion,
    SYNC_SCHEMA_VERSION
  )
  assert.throws(() => validateManifest({ syncSchemaVersion: SYNC_SCHEMA_VERSION + 1 }), /新しい/)
  assert.throws(() => validateManifest(null), /オブジェクト/)
})

/* ------------------------------------------------------------------ *
 * export / import（実ファイルを使う）
 * ------------------------------------------------------------------ */

/** テストごとに使い捨ての HOME 相当を作り、env で同期先を差し替える。 */
function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-sync-'))
  const previous = { home: process.env['NEMO_SYNC_HOME'], userData: process.env['NEMO_USER_DATA_DIR'] }
  process.env['NEMO_SYNC_HOME'] = path.join(root, 'sync')
  process.env['NEMO_USER_DATA_DIR'] = path.join(root, 'userdata')
  fs.mkdirSync(process.env['NEMO_USER_DATA_DIR'], { recursive: true })
  return (async () => {
    try {
      // env を見てからモジュールを読む必要があるので、毎回読み直す
      const lib = await import(`./lib/config-sync.mjs?t=${Date.now()}-${Math.random()}`)
      await fn({ root, lib, userDataDir: process.env['NEMO_USER_DATA_DIR'] })
    } finally {
      if (previous.home === undefined) delete process.env['NEMO_SYNC_HOME']
      else process.env['NEMO_SYNC_HOME'] = previous.home
      if (previous.userData === undefined) delete process.env['NEMO_USER_DATA_DIR']
      else process.env['NEMO_USER_DATA_DIR'] = previous.userData
      fs.rmSync(root, { recursive: true, force: true })
    }
  })()
}

test('snapshot は常用データを正規化して書き出す', () =>
  withSandbox(({ lib, userDataDir }) => {
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      stringify({ version: SETTINGS_VERSION, data: { tabSleepMinutes: 45, unknownKey: 'x' } })
    )
    const files = lib.buildSnapshot(userDataDir, { appVersion: '9.9.9' })
    const names = files.map((file) => file.name)
    assert.ok(names.includes('settings.json'))
    assert.ok(names.includes('pins.json'))
    assert.ok(names.includes('manifest.json'))

    const settings = JSON.parse(files.find((file) => file.name === 'settings.json').text)
    assert.equal(settings.data.tabSleepMinutes, 45)
    assert.equal('unknownKey' in settings.data, false, '知らないキーは落とす')

    // 常用データに pins.json が無くても既定値で書き出す（2台目が pull して空になるのを防ぐ）
    const pins = files.find((file) => file.name === 'pins.json')
    assert.equal(pins.missing, true)
    assert.deepEqual(JSON.parse(pins.text).data, { favorites: [], pinned: [] })

    const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json').text)
    assert.equal(manifest.syncSchemaVersion, SYNC_SCHEMA_VERSION)
    assert.equal(manifest.appVersion, '9.9.9')
  }))

test('pull は検証 → バックアップ → 原子的 import の順で、失敗したら元に戻る', () =>
  withSandbox(({ root, lib, userDataDir }) => {
    const staging = path.join(root, 'staged')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      stringify({ syncSchemaVersion: 1, updatedAt: 'x', appVersion: '1' })
    )
    fs.writeFileSync(
      path.join(staging, 'settings.json'),
      stringify({ version: SETTINGS_VERSION, data: { tabSleepMinutes: 10 } })
    )
    fs.writeFileSync(
      path.join(staging, 'pins.json'),
      stringify({
        version: PINS_VERSION,
        data: { favorites: [], pinned: [{ id: 'x', kind: 'link', url: 'https://example.com/', title: 'e' }] }
      })
    )

    // 元の常用データ
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      stringify({ version: SETTINGS_VERSION, data: { tabSleepMinutes: 99 } })
    )

    const { payloads } = lib.validateStaging(staging)
    const backup = lib.backupLiveData(userDataDir, 'stamp-1')
    lib.importPayloads(userDataDir, payloads)

    const after = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert.equal(after.data.tabSleepMinutes, 10)
    assert.equal(fs.existsSync(path.join(userDataDir, 'pins.json')), true)

    lib.restoreBackup(backup.dir)
    const restored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert.equal(restored.data.tabSleepMinutes, 99)
    // 元は存在しなかったファイルは、戻したときに消える
    assert.equal(fs.existsSync(path.join(userDataDir, 'pins.json')), false)
  }))

test('staging に必要なファイルが無ければ import しない', () =>
  withSandbox(({ root, lib }) => {
    const staging = path.join(root, 'staged2')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'manifest.json'), stringify({ syncSchemaVersion: 1 }))
    assert.throws(() => lib.validateStaging(staging), /settings\.json が無い/)
  }))

test('差分判定は空白の違いを無視する', () =>
  withSandbox(({ root, lib, userDataDir }) => {
    const staging = path.join(root, 'staged3')
    fs.mkdirSync(staging, { recursive: true })
    const data = { version: SETTINGS_VERSION, data: { tabSleepMinutes: 12 } }
    fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(data))
    fs.writeFileSync(path.join(staging, 'settings.json'), stringify(data))
    fs.writeFileSync(
      path.join(userDataDir, 'pins.json'),
      stringify({ version: PINS_VERSION, data: { favorites: [], pinned: [] } })
    )
    fs.writeFileSync(
      path.join(staging, 'pins.json'),
      stringify({ version: PINS_VERSION, data: { favorites: [], pinned: [] } })
    )
    assert.deepEqual(lib.diffAgainstStaging(userDataDir, staging), [])
  }))

/* ------------------------------------------------------------------ *
 * git を挟んだ通し（ローカルの bare repo を origin にする）
 * ------------------------------------------------------------------ */

test('push → 別端末で pull、で設定が渡る', () =>
  withSandbox(async ({ root, userDataDir }) => {
    const bare = path.join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })

    const cli = path.join(import.meta.dirname, 'config-sync.mjs')
    const env = {
      ...process.env,
      NEMO_SYNC_HOME: process.env['NEMO_SYNC_HOME'],
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_CONFIG_REPO: bare,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
    const run = (args, overrides = {}) =>
      execFileSync('node', [cli, ...args], { encoding: 'utf8', env: { ...env, ...overrides } })

    fs.writeFileSync(
      path.join(userDataDir, 'pins.json'),
      stringify({
        version: PINS_VERSION,
        data: { favorites: [{ id: 'f1', url: 'https://example.com/', title: 'Example' }], pinned: [] }
      })
    )

    run(['init'])
    run(['push', '--message', 'test: 初回'])

    // 2台目に見立てて、別の staging と別の常用データで pull する
    const second = path.join(root, 'second')
    const secondData = path.join(second, 'userdata')
    fs.mkdirSync(secondData, { recursive: true })
    const secondEnv = { NEMO_SYNC_HOME: path.join(second, 'sync'), NEMO_USER_DATA_DIR: secondData }
    run(['init'], secondEnv)
    run(['pull'], secondEnv)

    const pins = JSON.parse(fs.readFileSync(path.join(secondData, 'pins.json'), 'utf8'))
    assert.equal(pins.data.favorites[0].url, 'https://example.com/')

    // 2 回目の pull は「同じなので import 不要」で終わる
    const again = run(['pull'], secondEnv)
    assert.match(again, /import は不要/)
  }))

test('コンフリクトが残っていたら push も pull も止まる', () =>
  withSandbox(async ({ root, userDataDir }) => {
    const bare = path.join(root, 'origin2.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    const cli = path.join(import.meta.dirname, 'config-sync.mjs')
    const env = {
      ...process.env,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_CONFIG_REPO: bare,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
    execFileSync('node', [cli, 'init'], { env, encoding: 'utf8' })
    execFileSync('node', [cli, 'push'], { env, encoding: 'utf8' })

    // 作業コピーに未解決コンフリクトを作る
    const staging = path.join(process.env['NEMO_SYNC_HOME'], 'repo')
    const gitIn = (args) => execFileSync('git', args, { cwd: staging, encoding: 'utf8' })
    gitIn(['checkout', '-b', 'side'])
    fs.writeFileSync(
      path.join(staging, 'settings.json'),
      stringify({ version: SETTINGS_VERSION, data: { tabSleepMinutes: 1 } })
    )
    gitIn(['commit', '-am', 'side'])
    gitIn(['checkout', 'main'])
    fs.writeFileSync(
      path.join(staging, 'settings.json'),
      stringify({ version: SETTINGS_VERSION, data: { tabSleepMinutes: 2 } })
    )
    gitIn(['commit', '-am', 'main'])
    try {
      gitIn(['merge', 'side'])
    } catch {
      /* 競合するのが目的 */
    }

    for (const command of ['push', 'pull']) {
      assert.throws(
        () => execFileSync('node', [cli, command], { env, encoding: 'utf8', stdio: 'pipe' }),
        (error) => /コンフリクト/.test(String(error.stderr)),
        `${command} はコンフリクト中に走ってはいけない`
      )
    }
  }))
