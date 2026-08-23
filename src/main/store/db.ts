import Database from 'better-sqlite3'
import { userDataPath } from '../paths.js'
import { log, logError } from '../log.js'

/**
 * ローカル SQLite（履歴とアーカイブ）。
 *
 * 履歴もアーカイブも**端末ローカル**で、設定同期には載せない（計画の決定事項）。
 * どちらも同じ DB ファイルに置く。別ファイルにすると、
 * 「片方だけ開けた」状態を考える羽目になるうえ、WAL のファイルも倍になる。
 *
 * **DB が開けないことでブラウザ自体を止めない**。開けなければ null のまま動き、
 * 履歴の記録と検索だけが効かなくなる。
 */

let db: Database.Database | null = null

/** 全文検索（FTS5）が使えるか。使えなければ LIKE 検索に落ちる。 */
let ftsAvailable = false

export function initDb(): void {
  try {
    db = new Database(userDataPath('history.db'))
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

      -- 自動アーカイブされた / 閉じた一時タブ。同じ URL は1行に畳む
      CREATE TABLE IF NOT EXISTS archived_tabs (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        archived_at INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT 'auto'
      );
      CREATE INDEX IF NOT EXISTS archived_at_idx ON archived_tabs(archived_at DESC);
    `)
    ftsAvailable = setUpFts(db)
    log('db.opened', { fts: ftsAvailable })
  } catch (error) {
    logError('db.open_failed', error)
    db = null
    ftsAvailable = false
  }
}

/**
 * 履歴の全文検索用インデックス。
 *
 * tokenizer は **trigram**。既定の unicode61 は空白で単語を切るので、
 * 日本語のタイトルが1語になって部分一致しない（「議事録」で「今週の議事録」が出ない）。
 * trigram なら3文字以上の部分一致が引ける。
 *
 * 実体テーブルとの同期はトリガに任せる（アプリ側で書き忘れる余地を残さない）。
 */
function setUpFts(database: Database.Database): boolean {
  try {
    database.exec(`
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
    // 既存の履歴が入っている DB に後から足したときのために、空なら作り直す
    const indexed = database.prepare('SELECT count(*) AS n FROM pages_fts').get() as { n: number }
    const pages = database.prepare('SELECT count(*) AS n FROM pages').get() as { n: number }
    if (indexed.n === 0 && pages.n > 0) {
      database.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')")
      log('db.fts_rebuilt', { pages: pages.n })
    }
    return true
  } catch (error) {
    // FTS5 が無い SQLite でも履歴自体は使える（検索が LIKE に落ちるだけ）
    logError('db.fts_unavailable', error)
    return false
  }
}

export function getDb(): Database.Database | null {
  return db
}

export function hasFts(): boolean {
  return ftsAvailable
}

/** trigram は3文字未満だとマッチしない。短い語は LIKE に落とす。 */
export const FTS_MIN_LENGTH = 3

export function closeDb(): void {
  try {
    db?.close()
  } catch (error) {
    logError('db.close_failed', error)
  }
  db = null
  ftsAvailable = false
}
