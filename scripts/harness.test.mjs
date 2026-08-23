#!/usr/bin/env node
/**
 * 検証ハーネス自体のテスト。
 *
 * ここは「stale マーカーの削除」と「子プロセスの停止」という
 * **破壊的な操作**を持つので、暴発しないことを固定する。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * harness は projectRoot 直下の `.nemo-run` を見るので、
 * リポジトリを汚さないよう使い捨ての「リポジトリもどき」を作ってそこで実行する。
 */
function makeFakeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-harness-')))
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true })
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'lib', 'harness.mjs'),
    path.join(root, 'scripts', 'lib', 'harness.mjs')
  )
  return root
}

/**
 * 子プロセスを起動して追跡し、テスト終了時に必ず片付けるヘルパを作る。
 *
 * このファイルは「SIGTERM を握り潰す子」や「kill を差し替えた子」を意図的に作る。
 * assert が落ちた経路で後始末に到達しないと、**回帰を検出したときに限って
 * 子が生き残りテストランナーが終われなくなる**（実際に孤児プロセスを残した）。
 * 片付けは必ず t.after() に置く。
 *
 * @param {import('node:test').TestContext} t
 */
function childTracker(t) {
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = []

  t.after(async () => {
    for (const child of children) {
      // kill を差し替えていても確実に殺せるよう、プロセスグループでなく実体を叩く
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          /* すでに死んでいる */
        }
        await new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          child.once('exit', resolve)
          setTimeout(resolve, 3000).unref()
        })
      }
    }
  })

  /** 子が 'ready' と言うまで待って返す。 */
  return async function spawnReady(code) {
    const child = spawn(process.execPath, ['-e', `${code}; console.log('ready')`])
    children.push(child)
    await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ready')) resolve()
      })
    })
    return child
  }
}

/** 偽リポジトリの中で findRunningNemo() を実行し、結果か例外メッセージを返す。 */
function runFindRunningNemo(root) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `import('./scripts/lib/harness.mjs').then(m => {
         try { process.stdout.write(JSON.stringify({ ok: m.findRunningNemo() })) }
         catch (e) { process.stdout.write(JSON.stringify({ error: e.message })) }
       })`
    ],
    { cwd: root, encoding: 'utf8' }
  )
  return JSON.parse(result.stdout)
}

test('.nemo-run が symlink なら検証を止める（無関係なファイルを消さない）', () => {
  const root = makeFakeRepo()
  try {
    // .nemo-run -> リポジトリルート という細工
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"canary"}')
    fs.writeFileSync(path.join(root, 'extensions.lock.json'), '{"lockfileVersion":1}')
    fs.symlinkSync(root, path.join(root, '.nemo-run'))

    const result = runFindRunningNemo(root)
    assert.ok(result.error, '例外にならず素通りした')
    assert.match(result.error, /symlink/)

    // 巻き添えで消えていないこと
    assert.ok(fs.existsSync(path.join(root, 'package.json')), 'package.json が消えた')
    assert.ok(fs.existsSync(path.join(root, 'extensions.lock.json')), 'lock が消えた')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('.nemo-run がファイルでも安全側に落ちる', () => {
  const root = makeFakeRepo()
  try {
    fs.writeFileSync(path.join(root, '.nemo-run'), 'not a directory')
    const result = runFindRunningNemo(root)
    assert.ok(result.error)
    assert.match(result.error, /ディレクトリでない/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('<pid>.json 以外は掃除対象にしない', () => {
  const root = makeFakeRepo()
  const markerDir = path.join(root, '.nemo-run')
  try {
    fs.mkdirSync(markerDir, { recursive: true })
    // 名前が規約に合わないもの / 通常ファイルでないものは触らない
    fs.writeFileSync(path.join(markerDir, 'package.json'), '{}')
    fs.writeFileSync(path.join(markerDir, 'notes.txt'), 'x')
    fs.mkdirSync(path.join(markerDir, '1234.json'), { recursive: true }) // ディレクトリ
    fs.writeFileSync(path.join(root, 'target.json'), '{}')
    fs.symlinkSync(path.join(root, 'target.json'), path.join(markerDir, '4321.json'))
    // 死んだ PID の通常ファイルだけが消える
    fs.writeFileSync(path.join(markerDir, '999999.json'), '{"pid":999999}')

    const result = runFindRunningNemo(root)
    assert.deepEqual(result.ok, [])

    assert.ok(fs.existsSync(path.join(markerDir, 'package.json')))
    assert.ok(fs.existsSync(path.join(markerDir, 'notes.txt')))
    assert.ok(fs.existsSync(path.join(markerDir, '1234.json')))
    assert.ok(fs.existsSync(path.join(root, 'target.json')), 'symlink 先が消えた')
    assert.ok(fs.existsSync(path.join(markerDir, '4321.json')), 'symlink が消えた')
    assert.ok(!fs.existsSync(path.join(markerDir, '999999.json')), 'stale が残っている')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('中身が壊れていても PID が生きていれば起動中として扱う（消さない）', () => {
  const root = makeFakeRepo()
  const markerDir = path.join(root, '.nemo-run')
  try {
    fs.mkdirSync(markerDir, { recursive: true })
    const alive = path.join(markerDir, `${process.pid}.json`)
    fs.writeFileSync(alive, 'これは JSON ではない')

    const result = runFindRunningNemo(root)
    assert.equal(result.ok.length, 1)
    assert.equal(result.ok[0].pid, process.pid)
    assert.ok(fs.existsSync(alive), '生きている PID のマーカーを消した')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stopChild は終了を待ち、確認できなければ投げる', async (t) => {
  const { stopChild } = await import('../scripts/lib/harness.mjs')
  const spawnReady = childTracker(t)

  // 素直に終了する子
  const normal = await spawnReady('setInterval(() => {}, 1000)')
  await stopChild(normal)
  assert.notEqual(normal.exitCode ?? normal.signalCode, null, '終了を待てていない')

  // SIGTERM を無視する子でも SIGKILL で落ちる
  const stubborn = await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")
  await stopChild(stubborn, { timeoutMs: 500 })
  assert.equal(stubborn.signalCode, 'SIGKILL')

  // 既に死んでいる子は何もしない
  await stopChild(normal)
})

test('マーカー置き場が読めない（EACCES）なら fail-open しない', () => {
  const root = makeFakeRepo()
  const markerDir = path.join(root, '.nemo-run')
  try {
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, '999999.json'), '{"pid":999999}')
    // ディレクトリ自体を読めなくする（root は cwd に使うので実行権限を残す）
    fs.chmodSync(markerDir, 0o000)

    const result = runFindRunningNemo(root)
    if (result.ok) {
      // root 権限で走っていると EACCES にならない
      assert.equal(process.getuid?.(), 0, 'EACCES を再現できていないのに素通りした')
      return
    }
    assert.match(result.error, /EACCES|permission denied/i)
  } finally {
    fs.chmodSync(markerDir, 0o755)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('lstat が ENOENT 以外で失敗したら検証を中止する', async (t) => {
  const harness = await import('../scripts/lib/harness.mjs')
  const realFs = (await import('node:fs')).default

  // ENOENT は「まだ誰も起動していない」なので素通りしてよい
  t.mock.method(realFs, 'lstatSync', () => {
    const error = new Error('no such file')
    error.code = 'ENOENT'
    throw error
  })
  assert.doesNotThrow(() => harness.findRunningNemo())
  t.mock.restoreAll()

  // それ以外は「起動中か判定できない」ので投げる
  t.mock.method(realFs, 'lstatSync', () => {
    const error = new Error('permission denied')
    error.code = 'EACCES'
    throw error
  })
  assert.throws(() => harness.findRunningNemo(), /判定できない|EACCES/)
  t.mock.restoreAll()
})

test('途中の停止に失敗しても、生き残りがいる限り後片付けしない', async (t) => {
  const { stopChildren, isChildAlive } = await import('../scripts/lib/harness.mjs')
  const spawnReady = childTracker(t)

  // verify-all と同じ構造: 起動した子は配列から外さない
  const spawned = []
  spawned.push(await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"))

  // SIGKILL も届かない状況を模して、停止が失敗するケースを作る。
  // 差し替えた kill は assert が落ちても t.after() の process.kill で回収される。
  const failing = spawned[0]
  failing.kill = () => true // シグナルを握り潰す

  let threw = false
  try {
    // わざとコピーでなく実体を渡す。呼び出し側の配列を壊さない契約を固定するため
    await stopChildren(spawned, { timeoutMs: 200, killTimeoutMs: 200 })
  } catch {
    threw = true
  }
  assert.ok(threw, '停止失敗が投げられていない')

  // 「止める前に splice する」実装だとここが 0 になり、後片付けが走ってしまう
  assert.equal(spawned.length, 1, 'stopChildren が呼び出し側の配列を壊している')
  assert.equal(spawned.filter(isChildAlive).length, 1, '生き残りを見失っている')
})

test('stopChild は exit 後にタイマーを残さない（プロセスが即終われる）', () => {
  // await が短いだけでは不十分。タイムアウト用のタイマーが残っていると
  // イベントループが空にならず、**プロセス自体が終われない**（テスト全体が10秒待たされていた）。
  // 子プロセスの総実行時間で測る。
  // 内側の子（setInterval を持つ孫プロセス）も必ず殺す。
  // stopChild が壊れていると孫が孤児になり、テスト実行のたびに増える。
  const script = `
    const { spawn } = require('node:child_process')
    const harness = ${JSON.stringify(path.join(projectRoot, 'scripts', 'lib', 'harness.mjs'))}
    import(harness).then(async (m) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      await new Promise((r) => child.once('spawn', r))
      try {
        await m.stopChild(child, { timeoutMs: 15000 })
      } finally {
        try { process.kill(child.pid, 'SIGKILL') } catch {}
      }
      // ここで明示的に exit しない。タイマーが残っていれば終われない
    }).catch((e) => { console.error(e); process.exit(1) })
  `

  const started = Date.now()
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
  const elapsed = Date.now() - started

  assert.equal(result.status, 0, result.stderr)
  assert.ok(elapsed < 5000, `タイマーが残っている（プロセスが ${elapsed}ms 終われなかった）`)
})

test('検証スクリプトは「止める前に配列から外す」書き方をしていない', () => {
  // ここだけソースを読む。過去に `running.splice(0)` で
  // 「途中の停止失敗 → 最後の後片付けが空配列を見て成功扱い →
  //  使用中の一時ディレクトリを削除」という事故を踏んだ。
  // 実行時のテストで再現しづらいので、危険な書き方そのものを禁止する。
  for (const name of ['verify-all.mjs', 'verify-ext-update.mjs']) {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', name), 'utf8')

    assert.doesNotMatch(source, /spawned\.splice\(/, `${name}: spawned を splice している`)
    assert.doesNotMatch(source, /running\.splice\(/, `${name}: 追跡配列を splice している`)

    // 後片付けは「生き残りがいないこと」で判断していること
    assert.match(
      source,
      /const alive = spawned\.filter\(isChildAlive\)/,
      `${name}: 後片付けの前に生存確認をしていない`
    )
    assert.match(
      source,
      /if \(alive\.length === 0\) \{[\s\S]{0,200}?rmSync/,
      `${name}: 生き残りがいても削除しうる`
    )
  }
})
