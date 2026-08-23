import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCommand, useSharedState, useWindowState } from '../useNemo.js'
import { PromptDialog } from './PromptDialog.js'
import type { Prompt, Suggestion, WindowState } from '../../shared/types.js'

/**
 * オーバーレイ（コマンドバー / 検索バー / ダウンロード / ダイアログ）。
 *
 * どれを出すかは main が決めて `nemo:overlay` で送ってくる。
 * ダイアログだけは `nemo:prompt` が優先で、来ている間は必ずそれを出す。
 */
export function Overlay(): React.JSX.Element | null {
  const [kind, setKind] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  /**
   * 状態はここで持つ。
   * バーの中で購読すると、**開いた瞬間はまだ `null`**（取得は IPC の往復）で、
   * ⌘L が現在の URL ではなく空欄で開く。ここは常時マウントされているので、
   * 開くころには必ず埋まっている。
   */
  const state = useWindowState()

  // push が先に届いていたら、後から返ってきた初期値で上書きしない
  const pushedKind = useRef(false)
  const pushedPrompt = useRef(false)

  useEffect(
    () =>
      window.nemo.onOverlay((next) => {
        pushedKind.current = true
        setKind(next)
      }),
    []
  )
  useEffect(
    () =>
      window.nemo.onPrompt((next) => {
        pushedPrompt.current = true
        setPrompt(next)
      }),
    []
  )

  // 購読するだけだと、**購読より前に**出たダイアログを取りこぼす。
  // 起動直後に復元したタブが権限要求を出すと実際に起こりうる。
  // 取りこぼすと permission / auth の callback が未解決のまま残り、ページが止まる。
  useEffect(() => {
    void window.nemo.getOverlayState().then((state) => {
      if (!pushedKind.current) setKind(state.kind)
      if (!pushedPrompt.current) setPrompt(state.prompt)
    })
  }, [])

  const close = useCallback(() => void window.nemo.setOverlay(null), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !prompt) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, prompt])

  if (prompt) return <PromptDialog prompt={prompt} />
  // 同じコマンドバーだが、⌘T（新規タブ）と ⌘L（現在のタブ）で既定の行き先が違う。
  // key を分けて、開き直すたびに入力を初期化する。
  if (kind === 'command-bar') return <CommandBar key="command-bar" onClose={close} state={state} newTab />
  if (kind === 'address-bar')
    return <CommandBar key="address-bar" onClose={close} state={state} newTab={false} />
  if (kind === 'find') return <FindBar onClose={close} state={state} />
  if (kind === 'downloads') return <Downloads onClose={close} />
  return null
}

/* ------------------------------------------------------------------ *
 * コマンドバー（⌘T / ⌘L）
 * ------------------------------------------------------------------ */

/**
 * @param newTab 既定の行き先。⌘T / ＋ ボタンは新規タブ、⌘L は現在のタブ。
 *   Shift を押しながら決定すると、その場で逆にできる。
 */
function CommandBar({
  onClose,
  state,
  newTab
}: {
  onClose: () => void
  state: WindowState | null
  newTab: boolean
}): React.JSX.Element {
  const [items, setItems] = useState<Suggestion[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeTab = useMemo(() => state?.tabs.find((tab) => tab.key === state.activeTabKey) ?? null, [state])

  // ⌘L は現在の URL を入れた状態で開く（コマンドが届く前に描画されても空欄にならないよう初期値で入れる）。
  const [query, setQuery] = useState(() => (newTab ? '' : (activeTab?.url ?? '')))

  useCommand(
    useCallback(
      (command) => {
        if (command === 'focus-address') setQuery(activeTab?.url ?? '')
        if (command === 'command-bar') setQuery('')
        inputRef.current?.focus()
        inputRef.current?.select()
      },
      [activeTab]
    )
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.nemo.suggest(query).then((result) => {
      if (cancelled) return
      setItems(result)
      setCursor(0)
    })
    return () => {
      cancelled = true
    }
  }, [query])

  const run = (item: Suggestion | undefined): void => {
    if (!item) return
    onClose()
    if (item.target.type === 'select-tab') {
      void window.nemo.selectTab(item.target.key)
      return
    }
    // どこで開くかは「開き方」で決まる（⌘T / ＋ は新規タブ、⌘L は現在のタブ）。
    // Shift を押しながら決定したときだけ逆にする。
    const wantsNewTab = newTab !== shiftHeld.current
    if (activeTab && !wantsNewTab) void window.nemo.navigate(activeTab.key, item.target.url)
    else void window.nemo.createTab(item.target.url)
  }

  /** 決定時に Shift が押されていたか（既定の行き先を反転させる）。 */
  const shiftHeld = useRef(false)

  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div
        className="cmd"
        data-mode={newTab ? 'new-tab' : 'address'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          placeholder={
            newTab ? '新しいタブで開く / 検索する / タブを探す' : 'URL を開く / 検索する / タブを探す'
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor((current) => Math.min(current + 1, items.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              shiftHeld.current = event.shiftKey
              run(items[cursor])
            } else if (event.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="sugs">
          {items.map((item, index) => (
            <div
              key={`${item.kind}-${item.subtitle}-${index}`}
              className={`sug${index === cursor ? ' on' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                shiftHeld.current = event.shiftKey
                run(item)
              }}
            >
              <span className="k">{KIND_LABEL[item.kind]}</span>
              <span className="t">{item.title}</span>
              <span className="s">{item.subtitle}</span>
            </div>
          ))}
          {items.length === 0 ? <div className="sug dim">入力すると候補が出ます</div> : null}
        </div>
        <div className="hint">
          {newTab ? 'Enter で新規タブ / ⇧Enter で現在のタブ' : 'Enter で現在のタブ / ⇧Enter で新規タブ'}
        </div>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  tab: 'タブ',
  pinned: 'ピン',
  favorite: 'お気に入り',
  history: '履歴',
  search: '検索',
  url: '開く'
}

/* ------------------------------------------------------------------ *
 * ページ内検索（⌘F）
 * ------------------------------------------------------------------ */

function FindBar({ onClose, state }: { onClose: () => void; state: WindowState | null }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const activeKey = state?.activeTabKey ?? null
  const find = state?.find ?? null

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const search = useCallback(
    (text: string, options: { forward?: boolean; findNext?: boolean } = {}) => {
      if (!activeKey) return
      if (!text) {
        void window.nemo.stopFind(activeKey)
        return
      }
      void window.nemo.find(activeKey, text, options)
    },
    [activeKey]
  )

  useCommand(
    useCallback(
      (command) => {
        if (command === 'find') {
          inputRef.current?.focus()
          inputRef.current?.select()
        }
        if (command === 'find-next') search(query, { findNext: true, forward: true })
        if (command === 'find-previous') search(query, { findNext: true, forward: false })
      },
      [query, search]
    )
  )

  const close = (): void => {
    if (activeKey) void window.nemo.stopFind(activeKey)
    onClose()
  }

  return (
    <div className="findbar">
      <input
        ref={inputRef}
        value={query}
        spellCheck={false}
        placeholder="ページ内を検索"
        onChange={(event) => {
          setQuery(event.target.value)
          search(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            search(query, { findNext: true, forward: !event.shiftKey })
          } else if (event.key === 'Escape') {
            close()
          }
        }}
      />
      <span className="count">
        {find && find.totalMatches > 0 ? `${find.activeMatch}/${find.totalMatches}` : query ? '0/0' : ''}
      </span>
      <button
        type="button"
        className="icon"
        onClick={() => search(query, { findNext: true, forward: false })}
      >
        ‹
      </button>
      <button type="button" className="icon" onClick={() => search(query, { findNext: true, forward: true })}>
        ›
      </button>
      <button type="button" className="icon" onClick={close}>
        ×
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * ダウンロード（⌘⇧J）
 * ------------------------------------------------------------------ */

function Downloads({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { downloads } = useSharedState()
  return (
    <div className="panel">
      <div className="panel-head">
        <span>ダウンロード</span>
        <div className="spacer" />
        <button
          type="button"
          className="icon"
          title="履歴を消す"
          onClick={() => void window.nemo.clearDownloads()}
        >
          🗑
        </button>
        <button type="button" className="icon" onClick={onClose}>
          ×
        </button>
      </div>
      {downloads.length === 0 ? <div className="empty">まだ何もダウンロードしていません</div> : null}
      {downloads.map((item) => {
        const ratio = item.totalBytes ? item.receivedBytes / item.totalBytes : null
        return (
          <div key={item.id} className={`dl ${item.state}`}>
            <div className="dl-main">
              <span className="dl-name" title={item.filename}>
                {item.filename}
              </span>
              <span className="dl-host">{item.host}</span>
            </div>
            {item.state === 'progressing' || item.state === 'paused' ? (
              <div className="dl-bar">
                <div className="dl-fill" style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} />
              </div>
            ) : (
              <span className="dl-state">{DOWNLOAD_LABEL[item.state]}</span>
            )}
            {item.state === 'completed' ? (
              <button
                type="button"
                className="icon"
                title="Finder で表示"
                onClick={() => void window.nemo.revealDownload(item.id)}
              >
                📂
              </button>
            ) : (
              <button
                type="button"
                className="icon"
                title="やめる"
                onClick={() => void window.nemo.cancelDownload(item.id)}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const DOWNLOAD_LABEL: Record<string, string> = {
  completed: '完了',
  cancelled: '中止',
  interrupted: '失敗',
  progressing: '',
  paused: '一時停止'
}
