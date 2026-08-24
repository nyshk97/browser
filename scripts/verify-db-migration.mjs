#!/usr/bin/env node
/**
 * 履歴 DB のマイグレーション検証（`mise run verify:db-migration`）。
 *
 * `pages.favicon_url` は後から足した列で、**既存の DB に `ALTER TABLE` を流す**経路がある。
 * `mise run verify` は毎回まっさらな userData を作るので、この経路を一度も通らない
 * （`verify-all.mjs` の `mkdtempSync`）。ここだけは**旧スキーマの DB を置いてから起動する**。
 *
 * 見るもの:
 *   1. 列が1つだけ足される / 既存行が消えない / FTS が壊れない
 *   2. もう一度起動しても壊れない（冪等）
 *   3. `window.nemo.suggest` が履歴候補を返す（capability の分岐が SQL を壊していない）
 *   4. **列を足せない DB でも履歴が生きている**（`NULL AS favicon_url` の縮退経路）
 *
 * 使い方:
 *   node scripts/verify-db-migration.mjs        （事前に out/ がビルドされていること）
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  projectRoot,
  sleep,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const Database = require('better-sqlite3')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 投入する履歴。日本語タイトルを混ぜる（FTS の trigram が効いているかを見るため）。 */
const SEED = [
  { url: 'https://example.com/alpha', title: '議事録テンプレート', visits: 7, at: 1_700_000_000_000 },
  { url: 'https://example.org/beta', title: 'Beta Release Notes', visits: 3, at: 1_700_000_100_000 },
  { url: 'https://example.net/gamma', title: 'ガンマ線の観測', visits: 1, at: 1_700_000_200_000 }
]

/**
 * `favicon_url` を持たない**旧スキーマ**の history.db を作る。
 * DDL は当時の `src/main/store/db.ts` と同じもの（列を足す前の姿）。
 */
function seedOldSchema(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, 'history.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      visit_count INTEGER NOT NULL DEFAULT 0,
      last_visited_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pages_last_visited ON pages(last_visited_at DESC);
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      visited_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_at ON visits(visited_at DESC);
    CREATE TABLE IF NOT EXISTS archived_tabs (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      archived_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'auto'
    );
    CREATE INDEX IF NOT EXISTS archived_at_idx ON archived_tabs(archived_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      url, title, content='pages', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, url, title) VALUES (new.rowid, new.url, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, url, title) VALUES ('delete', old.rowid, old.url, old.title);
    END;
    CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, url, title) VALUES ('delete', old.rowid, old.url, old.title);
      INSERT INTO pages_fts(rowid, url, title) VALUES (new.rowid, new.url, new.title);
    END;
  `)
  const insert = db.prepare(
    'INSERT INTO pages (url, title, visit_count, last_visited_at) VALUES (?, ?, ?, ?)'
  )
  for (const row of SEED) insert.run(row.url, row.title, row.visits, row.at)
  const columns = db.prepare('PRAGMA table_info(pages)').all()
  db.close()
  if (columns.some((c) => c.name === 'favicon_url')) {
    throw new Error('fixture が旧スキーマになっていない（favicon_url が既にある）')
  }
  return dir
}

/* ------------------------------------------------------------------ *
 * アプリの起動 / 停止
 * ------------------------------------------------------------------ */

const spawned = []

async function bootApp(userDataDir) {
  const port = String(await getFreePort())
  const cdp = `http://127.0.0.1:${port}`
  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: port,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-dbmig-dl-'))
    }
  })
  spawned.push(child)
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  return { child, cdp }
}

/** サイドバー UI に CDP でつないで式を1つ評価する。 */
async function evalInUi(cdp, expression) {
  const list = await (await fetch(`${cdp}/json/list`)).json()
  const target = list.find((t) => t.url.includes('view=sidebar'))
  if (!target) throw new Error('ブラウザ UI の target が見つからない')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  try {
    const send = (method, params) =>
      new Promise((resolve) => {
        const id = 1
        ws.addEventListener('message', function onMessage(event) {
          const message = JSON.parse(event.data)
          if (message.id !== id) return
          ws.removeEventListener('message', onMessage)
          resolve(message)
        })
        ws.send(JSON.stringify({ id, method, params }))
      })
    // アプリの初期化完了を待つ（UI の target が出た時点ではまだ registry が空）
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const probe = await send('Runtime.evaluate', {
        expression: 'window.nemo?.getAppStatus?.().then((s) => JSON.stringify(s))',
        awaitPromise: true,
        returnByValue: true
      })
      const value = probe.result?.result?.value
      if (value && JSON.parse(value).ready) break
      await sleep(300)
    }
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.exception?.description ?? 'eval failed')
    }
    return result.result?.result?.value
  } finally {
    ws.close()
  }
}

function readDb(dir) {
  const db = new Database(path.join(dir, 'history.db'), { readonly: true })
  try {
    return {
      columns: db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name),
      rows: db
        .prepare('SELECT url, title, visit_count, last_visited_at FROM pages ORDER BY url')
        .all(),
      ftsHits: db
        .prepare("SELECT p.url FROM pages_fts f JOIN pages p ON p.rowid = f.rowid WHERE pages_fts MATCH ?")
        .all('"議事録"')
        .map((r) => r.url)
    }
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

const dirs = []
const makeDir = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nemo-dbmig-${tag}-`))
  dirs.push(dir)
  return dir
}

/** 読み取り専用にしたファイル。後片付けの前に戻さないと消せない。 */
const lockedFiles = []

try {
  assertNemoNotRunning('verify:db-migration')

  /* --- 1回目の起動: 旧スキーマ → 列が足される --- */
  const dir = seedOldSchema(makeDir('main'))
  {
    const { cdp } = await bootApp(dir)
    const suggested = await evalInUi(
      cdp,
      "window.nemo.suggest('議事録').then((r) => JSON.stringify(r.map((s) => s.kind + ':' + s.subtitle)))"
    )
    check(
      'suggest が履歴候補を返す（capability 分岐が SQL を壊していない）',
      typeof suggested === 'string' && suggested.includes('https://example.com/alpha'),
      String(suggested)
    )
    await stopChildren(spawned.splice(0))
  }

  const after = readDb(dir)
  const faviconColumns = after.columns.filter((name) => name === 'favicon_url')
  check('favicon_url が1つだけ足される', faviconColumns.length === 1, after.columns.join(', '))
  check('既存行が消えていない', after.rows.length === SEED.length, `${after.rows.length} 行`)
  const preserved = SEED.every((seed) => {
    const row = after.rows.find((r) => r.url === seed.url)
    return (
      row &&
      row.title === seed.title &&
      row.visit_count === seed.visits &&
      row.last_visited_at === seed.at
    )
  })
  check('既存行の内容（title / visit_count / last_visited_at）が保たれている', preserved)
  check('FTS が壊れていない（日本語の部分一致が引ける）', after.ftsHits.includes('https://example.com/alpha'), after.ftsHits.join(', '))

  /* --- 2回目の起動: 冪等 --- */
  {
    const { cdp } = await bootApp(dir)
    await evalInUi(cdp, '1')
    await stopChildren(spawned.splice(0))
  }
  const again = readDb(dir)
  check(
    '2回目の起動でも列が増えない（冪等）',
    again.columns.filter((name) => name === 'favicon_url').length === 1,
    again.columns.join(', ')
  )
  check('2回目の起動でも行が消えない', again.rows.length === SEED.length, `${again.rows.length} 行`)
  check('2回目の起動で未捕捉例外が出ていない', findUncaughtExceptions(dir).length === 0)

  /* --- 列を足せない DB での縮退 --- */
  const readonlyDir = seedOldSchema(makeDir('ro'))
  for (const name of fs.readdirSync(readonlyDir)) {
    if (!name.startsWith('history.db')) continue
    const file = path.join(readonlyDir, name)
    fs.chmodSync(file, 0o444)
    lockedFiles.push(file)
  }
  {
    const { cdp } = await bootApp(readonlyDir)
    const suggested = await evalInUi(
      cdp,
      "window.nemo.suggest('議事録').then((r) => JSON.stringify(r.map((s) => s.kind + ':' + s.subtitle)))"
    )
    check(
      '列を足せなくても履歴候補は返る（NULL AS favicon_url の縮退）',
      typeof suggested === 'string' && suggested.includes('https://example.com/alpha'),
      String(suggested)
    )
    await stopChildren(spawned.splice(0))
  }
  const readonlyAfter = readDb(readonlyDir)
  check(
    '読み取り専用の DB に列は足されない',
    !readonlyAfter.columns.includes('favicon_url'),
    readonlyAfter.columns.join(', ')
  )
} catch (error) {
  failures += 1
  console.error(`FAIL  例外で中断 — ${error?.stack ?? error}`)
} finally {
  await stopChildren(spawned.splice(0))
  // 読み取り専用にした**ファイルだけ**を戻す。ディレクトリまで 0644 にすると
  // 実行ビットが落ちて中をたどれなくなり、rmSync が ENOTEMPTY で落ちる。
  for (const file of lockedFiles) {
    try {
      fs.chmodSync(file, 0o644)
    } catch {
      /* すでに消えている */
    }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全て PASS' : `\n${failures} 件 FAIL`)
process.exit(failures === 0 ? 0 : 1)
