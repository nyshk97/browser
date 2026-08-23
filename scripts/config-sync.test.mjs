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

test('バックアップは channel と用途で分かれ、別 channel には戻せない', () =>
  withSandbox(({ lib, userDataDir }) => {
    fs.writeFileSync(
      path.join(userDataDir, 'pins.json'),
      stringify({ version: PINS_VERSION, data: { favorites: [], pinned: [] } })
    )
    const pull = lib.backupLiveData(userDataDir, 'stamp-1', { channel: 'dev', kind: 'pull' })
    const arc = lib.backupLiveData(userDataDir, 'stamp-2', { channel: 'dev', kind: 'arc-import' })

    assert.ok(pull.dir.includes(path.join('backups', 'dev', 'pull-stamp-1')))
    assert.ok(arc.dir.includes(path.join('backups', 'dev', 'arc-import-stamp-2')))

    // 用途で絞れる（config:restore が Arc 取り込みの分を拾わない）
    assert.deepEqual(lib.listBackups('dev', 'pull'), ['pull-stamp-1'])
    assert.deepEqual(lib.listBackups('dev', 'arc-import'), ['arc-import-stamp-2'])
    assert.deepEqual(lib.listBackups('stable', 'pull'), [], '別 channel には見えない')

    // channel / 戻し先が食い違ったら戻さない
    assert.throws(() => lib.restoreBackup(pull.dir, { expectedChannel: 'stable' }), /channel が違う/)
    assert.throws(
      () => lib.restoreBackup(pull.dir, { expectedUserDataDir: '/somewhere/else' }),
      /戻し先が想定と違う/
    )
    // 一致していれば戻せる
    lib.restoreBackup(pull.dir, { expectedChannel: 'dev', expectedUserDataDir: userDataDir })
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
    const backup = lib.backupLiveData(userDataDir, 'stamp-1', { channel: 'dev', kind: 'pull' })
    lib.importPayloads(userDataDir, payloads)

    const after = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert.equal(after.data.tabSleepMinutes, 10)
    assert.equal(fs.existsSync(path.join(userDataDir, 'pins.json')), true)

    lib.restoreBackup(backup.dir, { expectedChannel: 'dev', expectedUserDataDir: userDataDir })
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

/* ------------------------------------------------------------------ *
 * 2台で押し合ったときに変更が消えないこと
 * ------------------------------------------------------------------ */

/** テスト用の CLI 実行環境（1台ぶん）を作る。 */
function machine(root, name, bare) {
  const home = path.join(root, name, 'sync')
  const data = path.join(root, name, 'userdata')
  fs.mkdirSync(data, { recursive: true })
  const env = {
    ...process.env,
    NEMO_SYNC_HOME: home,
    NEMO_USER_DATA_DIR: data,
    NEMO_CONFIG_REPO: bare,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: `${name}@example.com`,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: `${name}@example.com`
  }
  const cli = path.join(import.meta.dirname, 'config-sync.mjs')
  return {
    home,
    data,
    env,
    run: (args, overrides = {}) =>
      execFileSync('node', [cli, ...args], { encoding: 'utf8', env: { ...env, ...overrides } }),
    /** 失敗を期待して実行する。stderr を返す。 */
    expectFail: (args) => {
      try {
        execFileSync('node', [cli, ...args], { encoding: 'utf8', env, stdio: 'pipe' })
      } catch (error) {
        return String(error.stderr)
      }
      throw new Error(`失敗するはずのコマンドが成功した: ${args.join(' ')}`)
    },
    setFavorite: (id, url) =>
      fs.writeFileSync(
        path.join(data, 'pins.json'),
        stringify({
          version: PINS_VERSION,
          data: { favorites: [{ id, url, title: id }], pinned: [] }
        })
      ),
    favorites: () => JSON.parse(fs.readFileSync(path.join(data, 'pins.json'), 'utf8')).data.favorites
  }
}

test('origin が進んでいたら push を拒否する（別 Mac の変更を消さない）', () =>
  withSandbox(async ({ root }) => {
    const bare = path.join(root, 'origin-lost.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })

    const a = machine(root, 'macA', bare)
    const b = machine(root, 'macB', bare)

    // 初期状態を A が作り、B はそれを取り込む
    a.setFavorite('shared', 'https://shared.example.com/')
    a.run(['init'])
    a.run(['push'])
    b.run(['init'])
    b.run(['pull'])
    assert.equal(b.favorites()[0].id, 'shared')

    // A が更新して push
    a.setFavorite('from-a', 'https://a.example.com/')
    a.run(['push'])

    // B は A の更新を知らないまま push しようとする → **止まること**
    b.setFavorite('from-b', 'https://b.example.com/')
    const stderr = b.expectFail(['push'])
    assert.match(stderr, /origin が進んでいる/)

    // origin には A の内容が残っている（消されていない）
    const check = machine(root, 'checker', bare)
    check.run(['init'])
    check.run(['pull'])
    assert.equal(check.favorites()[0].id, 'from-a', 'A の変更が生きている')

    // B は pull してからなら push できる
    b.run(['pull'])
    assert.equal(b.favorites()[0].id, 'from-a', 'pull で A の内容が入る')
    b.setFavorite('from-b', 'https://b.example.com/')
    b.run(['push'])
  }))

test('一度も同期していない端末は、内容のある origin へ push できない', () =>
  withSandbox(async ({ root }) => {
    const bare = path.join(root, 'origin-fresh.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })

    const a = machine(root, 'first', bare)
    a.setFavorite('a', 'https://a.example.com/')
    a.run(['init'])
    a.run(['push'])

    const b = machine(root, 'second', bare)
    b.setFavorite('b', 'https://b.example.com/')
    b.run(['init'])
    assert.match(b.expectFail(['push']), /まだ一度も同期していない/)
  }))

test('管理外のファイルが staging にあると push を止める', () =>
  withSandbox(async ({ root }) => {
    const bare = path.join(root, 'origin-unmanaged.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    const m = machine(root, 'unmanaged', bare)
    m.setFavorite('x', 'https://x.example.com/')
    m.run(['init'])
    m.run(['push'])

    fs.writeFileSync(path.join(m.home, 'repo', 'my-notes.txt'), 'ここに手でメモを置いた')
    const stderr = m.expectFail(['push'])
    assert.match(stderr, /管理していないファイル/)
    assert.match(stderr, /my-notes\.txt/)

    // 消せば通る（メモを勝手に commit していないこと）
    fs.rmSync(path.join(m.home, 'repo', 'my-notes.txt'))
    m.setFavorite('y', 'https://y.example.com/')
    m.run(['push'])
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: path.join(m.home, 'repo'),
      encoding: 'utf8'
    })
    assert.equal(tracked.includes('my-notes.txt'), false)
  }))

test('origin を取得できないときは pull を中止する（古い JSON を入れない）', () =>
  withSandbox(async ({ root }) => {
    const bare = path.join(root, 'origin-gone.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    const m = machine(root, 'offline', bare)
    m.setFavorite('before', 'https://before.example.com/')
    m.run(['init'])
    m.run(['push'])

    // origin を消す = fetch が失敗する状況
    fs.rmSync(bare, { recursive: true, force: true })

    const stderr = m.expectFail(['pull'])
    assert.match(stderr, /origin を取得できないので pull を中止/)

    // --offline なら手元の staging をそのまま使う（明示したときだけ）
    const out = m.run(['pull', '--offline'])
    assert.match(out, /--offline/)
  }))

test('内容が同じなら push は空コミットを積まない', () =>
  withSandbox(async ({ root }) => {
    const bare = path.join(root, 'origin-noop.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
    const m = machine(root, 'noop', bare)
    m.setFavorite('x', 'https://x.example.com/')
    m.run(['init'])
    m.run(['push'])

    const count = () =>
      Number(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], {
          cwd: path.join(m.home, 'repo'),
          encoding: 'utf8'
        }).trim()
      )
    const before = count()
    // manifest の updatedAt を毎回書くと、ここで必ず1つ増えてしまう
    const out = m.run(['push'])
    assert.match(out, /差分なし/)
    assert.equal(count(), before)

    // 中身が変われば commit される
    m.setFavorite('y', 'https://y.example.com/')
    m.run(['push'])
    assert.equal(count(), before + 1)
  }))
