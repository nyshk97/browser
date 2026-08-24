import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Favicon } from './Sidebar.js'
import { prettyUrl } from '../useNemo.js'
import type { ArchivedTab, HistoryEntry } from '../../shared/types.js'

/**
 * ライブラリ（履歴 / アーカイブ）。計画 2-4。
 *
 * 「一時タブは放っておくと片付く」が成立するには、**片付いたものを掘り返せる**必要がある。
 * 履歴とアーカイブは性質が違う（履歴＝見たページ / アーカイブ＝開いていたタブ）ので
 * 同じパネルの中でタブを分ける。
 */

type Mode = 'history' | 'archive'

export function Library({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('history')
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [archive, setArchive] = useState<ArchivedTab[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    // どちらのタブに切り替えても待たずに出せるよう、両方まとめて引く
    void window.nemo.queryHistory(query).then(setHistory)
    void window.nemo.queryArchive(query).then(setArchive)
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    // 入力のたびに IPC を撃たない（打っている最中は待つ）
    const timer = setTimeout(reload, 120)
    return () => clearTimeout(timer)
  }, [reload])

  const items = mode === 'history' ? history : archive
  const open = (url: string): void => {
    onClose()
    void window.nemo.createTab(url)
  }

  return (
    <div className="panel library">
      <div className="panel-head">
        <div className="seg">
          <button type="button" className={mode === 'history' ? 'on' : ''} onClick={() => setMode('history')}>
            履歴 {history.length > 0 ? `(${history.length})` : ''}
          </button>
          <button type="button" className={mode === 'archive' ? 'on' : ''} onClick={() => setMode('archive')}>
            アーカイブ {archive.length > 0 ? `(${archive.length})` : ''}
          </button>
        </div>
        <div className="spacer" />
        <button
          type="button"
          className="icon"
          title={mode === 'history' ? '履歴をすべて消す' : 'アーカイブをすべて消す'}
          onClick={() => {
            const clear = mode === 'history' ? window.nemo.clearHistory() : window.nemo.clearArchive()
            void clear.then(reload)
          }}
        >
          🗑
        </button>
        <button type="button" className="icon" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="lib-search">
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={mode === 'history' ? '履歴を検索（3文字以上で全文検索）' : 'アーカイブを検索'}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
        />
      </div>

      <div className="lib-list">
        {items.length === 0 ? (
          <div className="empty">
            {query
              ? '見つかりませんでした'
              : mode === 'history'
                ? 'まだ履歴がありません'
                : 'アーカイブは空です'}
          </div>
        ) : null}

        {mode === 'history'
          ? history.map((entry) => (
              <LibraryRow
                key={entry.url}
                url={entry.url}
                title={entry.title}
                faviconUrl={entry.faviconUrl}
                meta={`${formatWhen(entry.lastVisitedAt)}・${entry.visitCount} 回`}
                onOpen={() => open(entry.url)}
                onRemove={() => void window.nemo.removeHistory(entry.url).then(reload)}
              />
            ))
          : archive.map((entry) => (
              <LibraryRow
                key={entry.url}
                url={entry.url}
                title={entry.title}
                meta={`${formatWhen(entry.archivedAt)}・${REASON_LABEL[entry.reason] ?? entry.reason}`}
                onOpen={() => open(entry.url)}
                onRemove={() => void window.nemo.removeArchived(entry.url).then(reload)}
              />
            ))}
      </div>
    </div>
  )
}

const REASON_LABEL: Record<string, string> = {
  auto: '自動',
  closed: '閉じた',
  imported: '取り込み'
}

function LibraryRow({
  url,
  title,
  faviconUrl,
  meta,
  onOpen,
  onRemove
}: {
  url: string
  title: string
  /** 履歴には記録がある。アーカイブは持っていないので省略（頭文字に落ちる）。 */
  faviconUrl?: string | null
  meta: string
  onOpen: () => void
  onRemove: () => void
}): React.JSX.Element {
  const shown = useMemo(() => prettyUrl(url), [url])
  return (
    <div className="lib-row" onDoubleClick={onOpen}>
      <button type="button" className="lib-main" onClick={onOpen} title={url}>
        <Favicon url={url} title={title} src={faviconUrl} />
        <span className="lib-title">{title || shown}</span>
        <span className="lib-url">{shown}</span>
      </button>
      <span className="lib-meta">{meta}</span>
      <button type="button" className="icon" title="この行を消す" onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

/** 「いつ見たか」は分単位まで要らない。人が思い出せる粒度で出す。 */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `今日 ${time}`
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000)
  if (days < 7) return `${days} 日前 ${time}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}
