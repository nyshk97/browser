import { logError } from '../log.js'
import { FTS_MIN_LENGTH, getDb, hasFts } from './db.js'
import type { HistoryEntry } from '../../shared/types.js'

/**
 * 履歴（ローカル SQLite）。
 *
 * 同期対象ではない（計画の決定事項: 履歴・アーカイブはローカルのみ）。
 * DB そのものの開閉は `store/db.ts` が持つ。
 */

interface HistoryRow {
  url: string
  title: string
  visit_count: number
  last_visited_at: number
}

export function recordVisit(url: string, title: string): void {
  const db = getDb()
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
  const db = getDb()
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
  const db = getDb()
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

/**
 * 履歴の検索 UI 用（計画 2-4）。
 *
 * 3文字以上なら FTS5（trigram）で引く。日本語のタイトルは空白で切れないので、
 * 既定の tokenizer だと部分一致しない。
 * 短い語と FTS が無い環境では LIKE に落ちる（結果が返らないより落ちた方がよい）。
 *
 * 空クエリは「最近見たページ」を返す（開いた瞬間に何も出ないのを避ける）。
 */
export function queryHistory(query: string, limit = 200): HistoryEntry[] {
  const db = getDb()
  if (!db) return []
  const text = query.trim()
  try {
    if (!text) {
      return toEntries(
        db
          .prepare(
            `SELECT url, title, visit_count, last_visited_at FROM pages
             ORDER BY last_visited_at DESC LIMIT ?`
          )
          .all(limit) as HistoryRow[]
      )
    }

    if (hasFts() && text.length >= FTS_MIN_LENGTH) {
      const rows = db
        .prepare(
          `SELECT p.url, p.title, p.visit_count, p.last_visited_at
           FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
           WHERE pages_fts MATCH ?
           ORDER BY p.last_visited_at DESC
           LIMIT ?`
        )
        .all(ftsQuery(text), limit) as HistoryRow[]
      if (rows.length > 0) return toEntries(rows)
      // FTS で0件でも LIKE なら拾えることがある（記号だけの語など）
    }

    const pattern = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    return toEntries(
      db
        .prepare(
          `SELECT url, title, visit_count, last_visited_at FROM pages
           WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
           ORDER BY last_visited_at DESC LIMIT ?`
        )
        .all(pattern, pattern, limit) as HistoryRow[]
    )
  } catch (error) {
    logError('history.query_failed', error)
    return []
  }
}

/**
 * 入力を FTS5 のクエリ文字列にする。
 *
 * `"` で括って**フレーズ1つ**として渡す。括らないと `AND` / `*` / `:` などが
 * 検索構文として解釈され、ユーザーの入力次第で例外になる。
 */
function ftsQuery(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

function toEntries(rows: HistoryRow[]): HistoryEntry[] {
  return rows.map((row) => ({
    url: row.url,
    title: row.title,
    visitCount: row.visit_count,
    lastVisitedAt: row.last_visited_at
  }))
}

/** 履歴から1件消す。 */
export function removeHistory(url: string): void {
  const db = getDb()
  if (!db) return
  try {
    db.prepare('DELETE FROM pages WHERE url = ?').run(url)
    db.prepare('DELETE FROM visits WHERE url = ?').run(url)
  } catch (error) {
    logError('history.write_failed', error)
  }
}

/** 履歴を全部消す。 */
export function clearHistory(): void {
  const db = getDb()
  if (!db) return
  try {
    db.exec('DELETE FROM pages; DELETE FROM visits;')
  } catch (error) {
    logError('history.write_failed', error)
  }
}
