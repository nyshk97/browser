import { logError } from '../log.js'
import { FTS_MIN_LENGTH, faviconColumn, getDb, hasFaviconColumn, hasFts } from './db.js'
import { splitTerms } from '../../shared/query-terms.js'
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
  /** 列が無い環境では `NULL AS favicon_url` が返るので、常に読める。 */
  favicon_url: string | null
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
 * ページが申告した favicon の URL を覚える（コマンドバーの候補に出すため）。
 *
 * **行は作らない**（INSERT しない）。行を作るのは `recordVisit` の責務で、
 * ここで作ると `about:` や拡張ページを弾いている条件をすり抜ける口ができる。
 * favicon だけ先に届いて行が無ければその回は捨てる（次の訪問で入る）。
 *
 * 条件の `IS NOT` は **NULL を含めて比較できる**（`<>` は NULL に対して NULL を返す）。
 * 引数は必ず非 NULL なので「今 NULL」「今 別の値」のときだけ UPDATE が走り、
 * **同じ値なら1行も触らない**。ここを緩めると `pages_fts` の同期トリガが
 * ページ遷移のたびに空撃ちされる（`pages` への UPDATE すべてで発火するため）。
 */
export function recordFavicon(url: string, faviconUrl: string | null): void {
  const db = getDb()
  if (!db || !hasFaviconColumn() || !faviconUrl) return
  if (!/^https?:\/\//.test(url)) return
  try {
    db.prepare('UPDATE pages SET favicon_url = ? WHERE url = ? AND favicon_url IS NOT ?').run(
      faviconUrl,
      url,
      faviconUrl
    )
  } catch (error) {
    logError('history.write_failed', error)
  }
}

/**
 * 定義の穴埋め用: URL → favicon を「完全一致 → 同 host の最近の行」の順で引く。
 *
 * ブックマークの URL は入口（`https://x/`）で、履歴に残っているのはログイン後の
 * 深い URL だけ、がよくある。完全一致で無ければ同 host で最後に見たページの favicon を使う。
 * host の絞り込みは **`url >= origin AND url < origin の次`** の範囲比較にする。`LIKE` は `ESCAPE` を
 * 付けると索引の前方一致最適化が外れ、`pages(url)` の主キーが使われず全表走査になる
 * （起動のたびに・ウィンドウ復元の前に・同期で走る場所なので効く）。範囲比較なら `_` / `%` の
 * エスケープも要らない。**列が無い環境では何もしない**（`recordFavicon` と同じ）。
 */
export function getFaviconsByUrlOrHost(urls: string[]): Map<string, string> {
  const found = getFavicons(urls)
  const db = getDb()
  if (!db || !hasFaviconColumn()) return found
  const missing = [...new Set(urls)].filter((url) => !found.has(url))
  if (missing.length === 0) return found
  try {
    const byHost = db.prepare(
      `SELECT favicon_url FROM pages
       WHERE url >= ? AND url < ? AND favicon_url IS NOT NULL
       ORDER BY last_visited_at DESC LIMIT 1`
    )
    const cache = new Map<string, string | null>()
    for (const url of missing) {
      let origin: string
      try {
        const parsed = new URL(url)
        origin = `${parsed.protocol}//${parsed.host}/`
      } catch {
        continue
      }
      if (!cache.has(origin)) {
        // `origin` は `/` で終わるので、上限は末尾を `/` の次の文字（`0`）に置き換えたもの
        const upper = `${origin.slice(0, -1)}0`
        const row = byHost.get(origin, upper) as { favicon_url: string } | undefined
        cache.set(origin, row?.favicon_url ?? null)
      }
      const favicon = cache.get(origin)
      if (favicon) found.set(url, favicon)
    }
  } catch (error) {
    logError('history.query_failed', error)
  }
  return found
}

/**
 * URL → favicon をまとめて引く（コマンドバーの候補用）。
 *
 * 1件ずつ引かない。候補は最大 12 件で、入力1文字ごとに走る場所なので
 * 往復の回数がそのまま入力の重さになる。
 */
export function getFavicons(urls: string[]): Map<string, string> {
  const found = new Map<string, string>()
  const db = getDb()
  if (!db || !hasFaviconColumn() || urls.length === 0) return found
  const unique = [...new Set(urls)]
  try {
    const rows = db
      .prepare(
        `SELECT url, favicon_url FROM pages
         WHERE favicon_url IS NOT NULL AND url IN (${unique.map(() => '?').join(', ')})`
      )
      .all(...unique) as { url: string; favicon_url: string }[]
    for (const row of rows) found.set(row.url, row.favicon_url)
  } catch (error) {
    logError('history.query_failed', error)
  }
  return found
}

/**
 * コマンドバーの補完候補。
 * 訪問回数と最終訪問の新しさで並べる（頻繁に使うものが上に来る）。
 *
 * 入力は空白区切りの**全語 AND・順序不問**（`splitTerms`。タブ / ピン留め側の照合と同じ分割）。
 * 3 文字以上の語は FTS5（trigram）の暗黙 AND で引き、2 文字以下の語は同じ SQL に
 * 語ごとの LIKE を足して絞る。**1 語のクエリも FTS に載せる**（従来は LIKE 1 本だったが、
 * trigram は 3 文字以上の部分一致・大文字小文字非区別なので LIKE と実質同等。
 * 既定の LIKE は PK の index に乗らず全走査になるので、入力 1 文字ごとに走るここでは
 * FTS に寄せる価値がある）。
 *
 * FTS が 0 件のとき・FTS が無い環境では**全語 AND の LIKE** に落ちる。両方とも
 * `likeClauses` が組む同じ条件で、`queryHistory` の「全文 1 パターン」の形は写さない
 * （写すと FTS で 0 件だった経路だけ AND が消え、入力によって結果が食い違う）。
 */
export function searchHistory(query: string, limit = 8): HistoryRow[] {
  const db = getDb()
  const terms = splitTerms(query)
  if (!db || terms.length === 0) return []
  try {
    const ftsTerms = terms.filter((term) => term.length >= FTS_MIN_LENGTH)
    const shortTerms = terms.filter((term) => term.length < FTS_MIN_LENGTH)
    if (hasFts() && ftsTerms.length > 0) {
      const like = likeClauses(shortTerms, 'p')
      const rows = db
        .prepare(
          `SELECT p.url, p.title, p.visit_count, p.last_visited_at, ${faviconColumn('p')}
           FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
           WHERE pages_fts MATCH ?${like.sql}
           ORDER BY p.visit_count DESC, p.last_visited_at DESC
           LIMIT ?`
        )
        .all(ftsTerms.map(ftsQuery).join(' '), ...like.params, limit) as HistoryRow[]
      if (rows.length > 0) return rows
      // FTS で0件でも LIKE なら拾えることがある（記号だけの語など）
    }

    const like = likeClauses(terms)
    return db
      .prepare(
        `SELECT url, title, visit_count, last_visited_at, ${faviconColumn()} FROM pages
         WHERE 1${like.sql}
         ORDER BY visit_count DESC, last_visited_at DESC
         LIMIT ?`
      )
      .all(...like.params, limit) as HistoryRow[]
  } catch (error) {
    logError('history.query_failed', error)
    return []
  }
}

/**
 * 語ごとの `AND (url LIKE ? OR title LIKE ?)` を組む。
 *
 * `%` `_` `\` は**語ごとに**エスケープする（1 パターンぶんのエスケープを写すと
 * 2 語目以降が素通りする）。`WHERE 1` / `MATCH ?` の後ろにそのまま連結できるよう
 * 先頭に ` AND` を付けた形で返す。語が無ければ空。
 */
function likeClauses(terms: string[], alias?: string): { sql: string; params: string[] } {
  const col = (name: string): string => (alias ? `${alias}.${name}` : name)
  const sql = terms
    .map(() => ` AND (${col('url')} LIKE ? ESCAPE '\\' OR ${col('title')} LIKE ? ESCAPE '\\')`)
    .join('')
  const params = terms.flatMap((term) => {
    const pattern = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    return [pattern, pattern]
  })
  return { sql, params }
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
            `SELECT url, title, visit_count, last_visited_at, ${faviconColumn()} FROM pages
             ORDER BY last_visited_at DESC LIMIT ?`
          )
          .all(limit) as HistoryRow[]
      )
    }

    if (hasFts() && text.length >= FTS_MIN_LENGTH) {
      const rows = db
        .prepare(
          `SELECT p.url, p.title, p.visit_count, p.last_visited_at, ${faviconColumn('p')}
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
          `SELECT url, title, visit_count, last_visited_at, ${faviconColumn()} FROM pages
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
    lastVisitedAt: row.last_visited_at,
    faviconUrl: row.favicon_url
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
