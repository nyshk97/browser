import { log, logError } from '../log.js'
import { FTS_MIN_LENGTH, getDb } from './db.js'
import type { ArchivedTab } from '../../shared/types.js'

/**
 * 一時タブのアーカイブ（計画 2-4）。
 *
 * Arc と同じで、放っておいた一時タブは自動的に片付ける。ただし**消さずに残す**。
 * 「片付いたのに掘り返せる」が Arc の一時タブの肝で、
 * ここが無いと怖くて一時タブを使えない。
 *
 * 同じ URL は1行に畳む（同じページを何度も開いて閉じても増えない）。
 * 履歴と同じ DB に置く（`store/db.ts`）。**端末ローカルで同期しない**。
 */

interface ArchiveRow {
  url: string
  title: string
  archived_at: number
  reason: string
}

/** 保持する件数の上限。超えた分は古いものから消す。 */
const MAX_ROWS = 5000

export type ArchiveReason = 'auto' | 'closed' | 'imported'

export function archiveTab(url: string, title: string, reason: ArchiveReason = 'auto'): void {
  const db = getDb()
  if (!db) return
  if (!/^https?:\/\//.test(url)) return
  try {
    db.prepare(
      `INSERT INTO archived_tabs (url, title, archived_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE archived_tabs.title END,
         archived_at = excluded.archived_at,
         reason = excluded.reason`
    ).run(url, title ?? '', Date.now(), reason)
  } catch (error) {
    logError('archive.write_failed', error)
  }
}

/** 上限を超えた古い行を落とす（起動時と自動アーカイブのたびに呼ぶ）。 */
export function pruneArchive(): void {
  const db = getDb()
  if (!db) return
  try {
    const { n } = db.prepare('SELECT count(*) AS n FROM archived_tabs').get() as { n: number }
    if (n <= MAX_ROWS) return
    db.prepare(
      `DELETE FROM archived_tabs WHERE url IN (
         SELECT url FROM archived_tabs ORDER BY archived_at ASC LIMIT ?
       )`
    ).run(n - MAX_ROWS)
    log('archive.pruned', { removed: n - MAX_ROWS })
  } catch (error) {
    logError('archive.write_failed', error)
  }
}

/**
 * アーカイブの検索。
 * 空クエリなら新しい順（開いた瞬間に何も出ないのを避ける）。
 *
 * 件数が履歴ほど多くならないので LIKE で足りる（FTS のインデックスは張らない）。
 */
export function queryArchive(query: string, limit = 200): ArchivedTab[] {
  const db = getDb()
  if (!db) return []
  const text = query.trim()
  try {
    const rows = text
      ? (db
          .prepare(
            `SELECT url, title, archived_at, reason FROM archived_tabs
             WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
             ORDER BY archived_at DESC LIMIT ?`
          )
          .all(likePattern(text), likePattern(text), limit) as ArchiveRow[])
      : (db
          .prepare(
            `SELECT url, title, archived_at, reason FROM archived_tabs
             ORDER BY archived_at DESC LIMIT ?`
          )
          .all(limit) as ArchiveRow[])
    return rows.map((row) => ({
      url: row.url,
      title: row.title,
      archivedAt: row.archived_at,
      reason: row.reason
    }))
  } catch (error) {
    logError('archive.query_failed', error)
    return []
  }
}

function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
}

export function removeArchived(url: string): void {
  const db = getDb()
  if (!db) return
  try {
    db.prepare('DELETE FROM archived_tabs WHERE url = ?').run(url)
  } catch (error) {
    logError('archive.write_failed', error)
  }
}

export function clearArchive(): void {
  const db = getDb()
  if (!db) return
  try {
    db.exec('DELETE FROM archived_tabs')
  } catch (error) {
    logError('archive.write_failed', error)
  }
}

/** 検索語が短いときに UI へ出す注意書きの閾値（履歴側の FTS と合わせる）。 */
export { FTS_MIN_LENGTH }
