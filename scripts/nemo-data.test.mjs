import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `scripts/lib/nemo-data.mjs` のテスト。
 *
 * 元は `config-sync.test.mjs` の一部。設定同期はセーブスロットに置き換わって廃止したが、
 * ここで守っているのは**「起動中の Nemo を書き潰さない」「書き換える前に控えを取る」**という
 * 同期に固有ではない性質で、実際に事故った経路そのもの。同期と一緒に消すと次に壊れても鳴らない。
 */

/** テストごとに使い捨ての控え置き場を作り、env で差し替える。 */
function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-data-'))
  const previous = { home: process.env['NEMO_SYNC_HOME'], userData: process.env['NEMO_USER_DATA_DIR'] }
  process.env['NEMO_SYNC_HOME'] = path.join(root, 'sync')
  process.env['NEMO_USER_DATA_DIR'] = path.join(root, 'userdata')
  fs.mkdirSync(process.env['NEMO_USER_DATA_DIR'], { recursive: true })
  return (async () => {
    try {
      // env を見てからモジュールを読む必要があるので、毎回読み直す
      const lib = await import(`./lib/nemo-data.mjs?t=${Date.now()}-${Math.random()}`)
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

/* ------------------------------------------------------------------ *
 * 「起動中か」の判定（Nemo と Nemo-dev を取り違えない）
 * ------------------------------------------------------------------ */

test('--user-data-dir は引数まるごとで一致させる（Nemo と Nemo-dev を混同しない）', async () => {
  const { matchesUserDataArg } = await import('./lib/nemo-data.mjs')
  const support = '/Users/someone/Library/Application Support'
  // 実際の ps 出力に近い形（パスに空白が入るのが厄介なところ）
  const devLine =
    `123 /Applications/Nemo Dev.app/Contents/Frameworks/Nemo Dev Helper.app/Contents/MacOS/Nemo Dev Helper` +
    ` --type=gpu-process --user-data-dir=${support}/Nemo-dev --gpu-preferences=X`
  const stableLine =
    `456 /Applications/Nemo.app/Contents/Frameworks/Nemo Helper.app/Contents/MacOS/Nemo Helper` +
    ` --type=gpu-process --user-data-dir=${support}/Nemo --gpu-preferences=X`

  // ここが前方一致だと、Nemo Dev を開いているだけで常用側の操作が止まる
  assert.equal(matchesUserDataArg(devLine, `${support}/Nemo`), false)
  assert.equal(matchesUserDataArg(devLine, `${support}/Nemo-dev`), true)
  assert.equal(matchesUserDataArg(stableLine, `${support}/Nemo`), true)
  assert.equal(matchesUserDataArg(stableLine, `${support}/Nemo-dev`), false)

  // 行末で終わる場合も拾う
  assert.equal(matchesUserDataArg(`789 x --user-data-dir=${support}/Nemo`, `${support}/Nemo`), true)
  // 別プロファイルには一致しない
  assert.equal(matchesUserDataArg(`789 x --user-data-dir=/tmp/other`, `${support}/Nemo`), false)
})

test('Nemo Dev だけが動いていても stable の操作は止まらない', () =>
  withSandbox(async ({ root, lib }) => {
    // 実プロセスは使えないので、アプリが書くマーカーで作る
    const markerDir = path.join(lib.projectRoot, '.nemo-run')
    fs.mkdirSync(markerDir, { recursive: true })
    const marker = path.join(markerDir, `${process.pid}.json`)
    const existed = fs.existsSync(marker)
    const saved = existed ? fs.readFileSync(marker, 'utf8') : null
    // 自分の pid で「dev のデータディレクトリを使って起動中」を作る
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, userData: path.join(root, 'Nemo-dev') }))
    try {
      process.env['NEMO_USER_DATA_DIR'] = path.join(root, 'Nemo')
      const fresh = await import(`./lib/nemo-data.mjs?marker=${Date.now()}`)
      assert.deepEqual(fresh.findRunningForChannel('stable'), [], 'dev のマーカーで stable を止めない')
      process.env['NEMO_USER_DATA_DIR'] = path.join(root, 'Nemo-dev')
      const forDev = await import(`./lib/nemo-data.mjs?marker=${Date.now()}-2`)
      assert.equal(forDev.findRunningForChannel('dev').length, 1, 'dev は自分のマーカーで止まる')
      assert.throws(() => forDev.assertNotRunning('dev', 'Arc 取り込み'), /起動していると実行できない/)
    } finally {
      if (saved === null) fs.rmSync(marker, { force: true })
      else fs.writeFileSync(marker, saved)
    }
  }))

/* ------------------------------------------------------------------ *
 * 控え（バックアップ）
 * ------------------------------------------------------------------ */

test('バックアップは channel と用途で分かれ、別 channel には戻せない', () =>
  withSandbox(({ lib, userDataDir }) => {
    fs.writeFileSync(path.join(userDataDir, 'pins.json'), lib.stringify({ version: 1, data: {} }))
    const one = lib.backupLiveData(userDataDir, 'stamp-1', {
      channel: 'dev',
      kind: 'arc-import',
      files: ['pins.json']
    })
    const two = lib.backupLiveData(userDataDir, 'stamp-2', {
      channel: 'stable',
      kind: 'arc-import',
      files: ['pins.json']
    })

    assert.ok(one.dir.includes(path.join('backups', 'dev', 'arc-import-stamp-1')))
    assert.ok(two.dir.includes(path.join('backups', 'stable', 'arc-import-stamp-2')))
    assert.deepEqual(lib.listBackups('dev', 'arc-import'), ['arc-import-stamp-1'])
    assert.deepEqual(lib.listBackups('stable', 'arc-import'), ['arc-import-stamp-2'])
    assert.deepEqual(lib.listBackups('dev', 'pull'), [], '別の用途には見えない')

    // channel / 戻し先が食い違ったら戻さない
    assert.throws(() => lib.restoreBackup(one.dir, { expectedChannel: 'stable' }), /channel が違う/)
    assert.throws(
      () => lib.restoreBackup(one.dir, { expectedUserDataDir: '/somewhere/else' }),
      /戻し先が想定と違う/
    )
    lib.restoreBackup(one.dir, { expectedChannel: 'dev', expectedUserDataDir: userDataDir })
  }))

test('backupLiveData は files が無いと実行しない（黙って何も控えない、を防ぐ）', () =>
  withSandbox(({ lib, userDataDir }) => {
    assert.throws(
      () => lib.backupLiveData(userDataDir, 's', { channel: 'dev', kind: 'arc-import' }),
      /files が要る/
    )
    assert.throws(
      () => lib.backupLiveData(userDataDir, 's', { channel: 'dev', kind: 'arc-import', files: [] }),
      /files が要る/
    )
    assert.throws(() => lib.backupLiveData(userDataDir, 's', { kind: 'arc-import', files: ['a'] }), /channel/)
  }))

test('元が無かったファイルは existed: false で記録され、戻すと消える', () =>
  withSandbox(({ lib, userDataDir }) => {
    fs.writeFileSync(path.join(userDataDir, 'pins.json'), lib.stringify({ version: 1, data: {} }))
    const backup = lib.backupLiveData(userDataDir, 'stamp-1', {
      channel: 'dev',
      kind: 'arc-import',
      files: ['pins.json', 'favicons.json']
    })
    assert.deepEqual(backup.files, [
      { name: 'pins.json', existed: true },
      { name: 'favicons.json', existed: false }
    ])

    // 取り込みが作ったファイルは、戻したときに消える
    fs.writeFileSync(path.join(userDataDir, 'favicons.json'), '{}')
    lib.restoreBackup(backup.dir, { expectedChannel: 'dev', expectedUserDataDir: userDataDir })
    assert.equal(fs.existsSync(path.join(userDataDir, 'favicons.json')), false)
    assert.equal(fs.existsSync(path.join(userDataDir, 'pins.json')), true)
  }))
