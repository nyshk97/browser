import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { foregroundTab, useCommand, useSharedState, useWindowState } from '../useNemo.js'
import { PromptDialog } from './PromptDialog.js'
import { Library } from './Library.js'
import { Favicon } from './Sidebar.js'
import { Settings } from './Settings.js'
import type { Prompt, Suggestion, SwitcherState, WindowState } from '../../shared/types.js'

/**
 * オーバーレイ（コマンドバー / 検索バー / ダウンロード / ダイアログ）。
 *
 * どれを出すかは main が決めて `nemo:overlay` で送ってくる。
 * ダイアログだけは `nemo:prompt` が優先で、来ている間は必ずそれを出す。
 */
export function Overlay(): React.JSX.Element | null {
  const [kind, setKind] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null)
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
  const pushedSwitcher = useRef(false)

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
  useEffect(
    () =>
      window.nemo.onSwitcher((next) => {
        pushedSwitcher.current = true
        setSwitcher(next)
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
      if (!pushedSwitcher.current) setSwitcher(state.switcher)
    })
  }, [])

  const close = useCallback(() => void window.nemo.setOverlay(null), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // スイッチャーの Esc は main 側（`before-input-event`）で取消に落とす。
      // ここで閉じると「オーバーレイだけ消えて押しっぱなしの状態が残る」ことになる。
      if (event.key === 'Escape' && !prompt && kind !== 'tab-switcher') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, prompt, kind])

  // **`prompt.id` を key にして再マウントする。** 認証ダイアログが連続すると
  // React が同じコンポーネントを使い回し、前のホストの入力値とチェック状態が次のホストに残る
  if (prompt) return <PromptDialog key={prompt.id} prompt={prompt} />
  // 同じコマンドバーだが、⌘T（新規タブ）と ⌘L（現在のタブ）で既定の行き先が違う。
  // key を分けて、開き直すたびに入力を初期化する。
  if (kind === 'command-bar') return <CommandBar key="command-bar" onClose={close} state={state} newTab />
  if (kind === 'address-bar')
    return <CommandBar key="address-bar" onClose={close} state={state} newTab={false} />
  // Esc・確定・ハイライトの移動は main が握る（⌃ を離した瞬間の確定と同じ経路に乗せる）
  if (kind === 'tab-switcher') return switcher ? <TabSwitcher state={switcher} /> : null
  if (kind === 'find') return <FindBar onClose={close} state={state} />
  if (kind === 'downloads') return <Downloads onClose={close} />
  if (kind === 'library') return <Library onClose={close} />
  if (kind === 'settings') return <Settings onClose={close} />
  return null
}

/* ------------------------------------------------------------------ *
 * タブスイッチャー（⌃M）
 * ------------------------------------------------------------------ */

/**
 * 直近に使ったタブの帯。**表示するだけ**で、並びもハイライト位置も main が持つ。
 * ここで状態を持つと、⌃ を離した瞬間の確定と食い違う。
 */
function TabSwitcher({ state }: { state: SwitcherState }): React.JSX.Element {
  const strip = useRef<HTMLDivElement>(null)

  // 端のカードが隠れていたら寄せる（帯は横に溢れることがある）
  useEffect(() => {
    strip.current?.querySelector('.switch-card.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [state.index])

  return (
    <div
      className="backdrop switch-back"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void window.nemo.cancelSwitcher()
      }}
    >
      <div className="switch-strip" ref={strip}>
        {state.tabs.map((tab, index) => (
          <button
            key={tab.key}
            className={`switch-card${index === state.index ? ' on' : ''}`}
            onClick={() => void window.nemo.pickSwitcherTab(tab.key)}
          >
            <Favicon url={tab.url} title={tab.title} src={tab.faviconUrl} />
            <span className="switch-title">{tab.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
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

  // ⌘L の対象は前面（Peek が出ていれば Peek）。表示する URL と Enter の遷移先を揃える
  const activeTab = useMemo(() => foregroundTab(state), [state])

  // ⌘L は現在の URL を入れた状態で開く（コマンドが届く前に描画されても空欄にならないよう初期値で入れる）。
  const [query, setQuery] = useState(() => (newTab ? '' : (activeTab?.url ?? '')))

  /**
   * 入力を全選択するタイミング。マウント時（0）と、コマンドが届いて値を入れ直したとき。
   * ⌘L の URL は**開いた瞬間に全選択**にして、⌘A を押さずに打ち直せるようにする。
   * `setQuery` と同じ同期区間で `select()` を呼んでも DOM の値はまだ前のままで、React が
   * 値を書き込んだ時点でキャレットが末尾に戻るので、描画後の layout effect で選ぶ。
   */
  const [selectTick, bumpSelect] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [selectTick])

  // コマンドは**マウントより先に届くことがある**（オーバーレイの表示とコマンドは別の IPC）。
  // 届いても届かなくても同じ姿になるよう、初期値とマウント時の全選択に寄せ、届いた側は
  // 値を入れ直して選び直すだけにする。
  useCommand(
    useCallback(
      (command) => {
        if (command === 'focus-address') setQuery(activeTab?.url ?? '')
        if (command === 'command-bar') setQuery('')
        bumpSelect()
      },
      [activeTab]
    )
  )

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

  /**
   * ⇧ を押している「間」の表示用。決定時の判定は上の ref（イベントの `shiftKey`）が正で、
   * こちらは右端のアクション文言を反転させるためだけに持つ。
   * **キーを押したままバーが閉じたときに残らないよう** blur でも倒す。
   */
  const [shiftDown, setShiftDown] = useState(false)
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Shift') setShiftDown(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'Shift') setShiftDown(false)
    }
    const clear = (): void => setShiftDown(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  const selected = items[cursor]

  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div
        className="cmd"
        data-mode={newTab ? 'new-tab' : 'address'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmd-input">
          {selected && selected.kind !== 'search' ? (
            <Favicon url={selected.subtitle} title={selected.title} src={selected.faviconUrl} />
          ) : (
            <GlassIcon />
          )}
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder={
              newTab ? '新しいタブで開く / 検索する / タブを探す' : 'URL を開く / 検索する / タブを探す'
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // ↑↓ のほかに ⌃P / ⌃N でも動かせる。
              // **macOS の入力欄はこの2つを既定で行移動として食う**ので、
              // preventDefault を必ず通す（そうしないとキャレットだけ動いて候補が動かない）。
              const emacs = event.ctrlKey && !event.metaKey && !event.altKey
              const moveDown = event.key === 'ArrowDown' || (emacs && event.key.toLowerCase() === 'n')
              const moveUp = event.key === 'ArrowUp' || (emacs && event.key.toLowerCase() === 'p')
              if (moveDown) {
                event.preventDefault()
                setCursor((current) => Math.min(current + 1, items.length - 1))
              } else if (moveUp) {
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
        </div>
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
              {item.kind === 'search' ? (
                <GlassIcon />
              ) : (
                <Favicon url={item.subtitle} title={item.title} src={item.faviconUrl} />
              )}
              <span className="t">{item.title}</span>
              {/* 検索行の副題は検索エンジンの長い URL になるので出さない（Arc も出さない） */}
              {item.kind === 'search' ? null : <span className="s">{item.subtitle}</span>}
              {index === cursor ? (
                <span className="act">
                  {actionLabel(item, newTab, shiftDown)}
                  <EnterIcon />
                </span>
              ) : null}
            </div>
          ))}
          {items.length === 0 ? <div className="sug dim">入力すると候補が出ます</div> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * 選択行の右端に出す「Enter を押したら何が起きるか」。
 *
 * 下部の説明行の代わりで、⇧ を押している間だけ行き先が反転する。
 * **開いているタブへの切り替えだけは反転しない** —— `run()` が `select-tab` を
 * `newTab` / Shift を見ずに `selectTab` へ倒しているので、文言だけ変えると実挙動と食い違う。
 */
function actionLabel(item: Suggestion, newTab: boolean, shift: boolean): string {
  if (item.target.type === 'select-tab') return 'タブへ切り替え'
  const verb = item.kind === 'search' ? '検索' : '開く'
  return `${newTab !== shift ? '新規タブで' : 'このタブで'}${verb}`
}

/** 検索候補の行頭。favicon の代わりに置く。 */
function GlassIcon(): React.JSX.Element {
  return (
    <svg className="glass" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 14 14" strokeLinecap="round" />
    </svg>
  )
}

/** 右端のアクションに添える「実行」の記号。 */
function EnterIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="3.4" />
      <path d="M5.6 8h4.8M8.3 5.9 10.5 8l-2.2 2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 * ページ内検索（⌘F）
 * ------------------------------------------------------------------ */

function FindBar({ onClose, state }: { onClose: () => void; state: WindowState | null }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 検索対象は前面（Peek が出ていれば Peek）。n/N も main が前面の find を送ってくる
  const activeKey = foregroundTab(state)?.key ?? null
  const find = state?.find ?? null

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  /**
   * 前面が変わったら（Peek が閉じた・親を検索中に Peek が開いた等）検索を終える。
   * 開いたまま残すと n/N が 0/0 のまま、前のページにハイライトが残る。
   *
   * `stopFind` は**直前の前面**に向ける（activeKey はもう新しい前面を指している）。
   * ただしタブごと消えた場合（Peek を閉じた）は撃たない —— `nemo:stop-find` は
   * `requireTab` で throw するし、WebContents ごと破棄されるのでハイライトも残らない。
   */
  const lastKey = useRef(activeKey)
  useEffect(() => {
    if (lastKey.current === activeKey) return
    const prev = lastKey.current
    lastKey.current = activeKey
    // null → key は「前面が変わった」ではなく初回 push の到着（`useWindowState` は
    // IPC の往復が終わるまで null）。ここで閉じるとウィンドウ生成直後の ⌘F が無症状で消える
    if (prev === null) return
    if (state?.tabs.some((tab) => tab.key === prev)) void window.nemo.stopFind(prev)
    onClose()
  }, [activeKey, state, onClose])

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
