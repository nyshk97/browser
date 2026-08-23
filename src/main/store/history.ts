import Database from 'better-sqlite3'
import { userDataPath } from '../paths.js'
import { log, logError } from '../log.js'

/**
 * 履歴（ローカル SQLite）。
 *
 * 同期対象ではない（計画の決定事項: 履歴・アーカイブはローカルのみ）。
 * Phase 1 で必要なのは「記録する」ことと「コマンドバーの補完に使う」ことだけで、
 * 検索 UI は Phase 2。
 */

interface HistoryRow {
  url: string
  title: string
  visit_count: number
  last_visited_at: number
}

let db: Database.Database | null = null

export function initHistory(): void {
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
    `)
    log('history.opened', {})
  } catch (error) {
    // 履歴が開けないことでブラウザ自体を止めない
    logError('history.open_failed', error)
    db = null
  }
}

export function recordVisit(url: string, title: string): void {
  if (!db) return
  // http / https 以外は記録しない（about:blank や拡張ページを履歴に残さない）
  if (!/^https?:\/\//.test(url)) return
  const now = Date.now()
  try {
    db.prepare(
      `INSERT INTO pages (url, title, visit_count, last_visited_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE pages.title END,
         visit_count = pages.visit_count + 1,
         last_visited_at = excluded.last_visited_at`
    ).run(url, title ?? '', now)
    db.prepare('INSERT INTO visits (url, visited_at) VALUES (?, ?)').run(url, now)
  } catch (error) {
    logError('history.write_failed', error)
  }
}

/** タイトルだけ後から届くことがある（did-navigate の時点では空）。 */
export function updateTitle(url: string, title: string): void {
  if (!db || !title) return
  if (!/^https?:\/\//.test(url)) return
  try {
    db.prepare('UPDATE pages SET title = ? WHERE url = ?').run(title, url)
  } catch (error) {
    logError('history.write_failed', error)
  }
}

/**
 * コマンドバーの補完候補。
 * 訪問回数と最終訪問の新しさで並べる（頻繁に使うものが上に来る）。
 */
export function searchHistory(query: string, limit = 8): HistoryRow[] {
  if (!db || !query.trim()) return []
  const pattern = `%${query.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`
  try {
    return db
      .prepare(
        `SELECT url, title, visit_count, last_visited_at FROM pages
         WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
         ORDER BY visit_count DESC, last_visited_at DESC
         LIMIT ?`
      )
      .all(pattern, pattern, limit) as HistoryRow[]
  } catch (error) {
    logError('history.query_failed', error)
    return []
  }
}

export function closeHistory(): void {
  try {
    db?.close()
  } catch (error) {
    logError('history.close_failed', error)
  }
  db = null
}
