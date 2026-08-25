import { useMemo, useRef, useState } from 'react'
import { hostOf, prettyUrl, useSharedState, useWindowState } from '../useNemo.js'
import type { TabState } from '../../shared/types.js'

const PAGE_PARTITION = 'persist:nemo'

/**
 * ページ領域の上端に敷くツールバー（DESIGN.md「ツールバー」）。
 *
 * ナビゲーション・アドレスバー・拡張・ダウンロード・履歴をここに集約し、
 * サイドバーは「枠とタブの一覧」だけを持つ。**サイドバーの右側**に敷かれる
 * 別の WebContentsView なので、サイドバーと状態は共有せず、どちらも
 * `useWindowState()` で main から同じ状態を受け取る。
 */
export function Toolbar(): React.JSX.Element {
  const state = useWindowState()
  const shared = useSharedState()
  /**
   * アドレスバーの入力。
   * `null` は「編集していない」= 現在タブの URL を読む形で出す、という意味。
   * タブの URL を effect で写すと、タブを切り替えるたびに再レンダリングが増え、
   * 編集中の内容も踏み潰す。
   */
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeTab: TabState | null = useMemo(
    () => state?.tabs.find((tab) => tab.key === state.activeTabKey) ?? null,
    [state]
  )

  const isPrivate = state?.isPrivate === true
  const sidebarVisible = state?.sidebarVisible !== false

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const input = draft ?? activeTab?.url ?? ''
    setDraft(null)
    inputRef.current?.blur()
    if (activeTab) void window.nemo.navigate(activeTab.key, input)
    else void window.nemo.createTab(input)
  }

  return (
    /*
     * サイドバーを隠しているときは、この View がウィンドウの左端まで伸びる。
     * 信号機ボタンはウィンドウ側に描かれるので、そのぶんの余白をここで空ける
     * （空けないと戻る・進むボタンが信号機の下に潜る）。
     */
    <div className={`toolbar${sidebarVisible ? '' : ' inset'}${isPrivate ? ' private' : ''}`}>
      <button
        type="button"
        className="icon"
        title={sidebarVisible ? 'サイドバーを隠す（⌘S）' : 'サイドバーを出す（⌘S）'}
        onClick={() => void window.nemo.setSidebarVisible(!sidebarVisible)}
      >
        {sidebarVisible ? '⇤' : '⇥'}
      </button>
      <button
        type="button"
        className="icon nav"
        title="戻る"
        disabled={!activeTab?.canGoBack}
        onClick={() => activeTab && void window.nemo.goBack(activeTab.key)}
      >
        ‹
      </button>
      <button
        type="button"
        className="icon nav"
        title="進む"
        disabled={!activeTab?.canGoForward}
        onClick={() => activeTab && void window.nemo.goForward(activeTab.key)}
      >
        ›
      </button>
      <button
        type="button"
        className="icon nav"
        title={activeTab?.loading ? '停止' : '再読み込み（右クリックでキャッシュを無視）'}
        disabled={!activeTab}
        onClick={() =>
          activeTab &&
          void (activeTab.loading ? window.nemo.stop(activeTab.key) : window.nemo.reload(activeTab.key))
        }
        onContextMenu={(event) => {
          // スーパーリロード。⌘⇧R と同じ経路（キャッシュを捨てて読み直す）
          event.preventDefault()
          if (activeTab) void window.nemo.reload(activeTab.key, { ignoreCache: true })
        }}
      >
        {activeTab?.loading ? '×' : '⟳'}
      </button>

      {draft === null ? (
        <button
          type="button"
          className="addr"
          title={activeTab?.url ?? ''}
          onClick={() => setDraft(activeTab?.url ?? '')}
        >
          <Address tab={activeTab} />
        </button>
      ) : (
        <form className="addr editing" onSubmit={submit}>
          <input
            ref={inputRef}
            value={draft}
            spellCheck={false}
            placeholder="URL または検索"
            // 編集は「クリックした瞬間」に始まる。開いた直後に全選択して、
            // そのまま打ち始められるようにする（⌘L のコマンドバーと同じ感覚）。
            autoFocus
            onFocus={(event) => event.target.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(null)
                inputRef.current?.blur()
              }
            }}
          />
        </form>
      )}

      {/* アドレスバーと右のアイコンの間。ここを掴んでウィンドウを動かせる */}
      <div className="spacer" />

      {/*
        alignment は「popup がどちら向きに伸びるか」。既定は**アンカーの右端に
        popup の右端を合わせる**（= 左へ伸びる）で、ツールバーの右端に置く
        ここではそれが正しい（右へ伸ばすと画面外に見切れる）。
        なお popup の位置はこの View のクライアント座標を基準に決まるので、
        サイドバーぶんのオフセットは main 側（`extensions.ts`）で足し戻している。
      */}
      {/*
        シークレットウィンドウには拡張がロードされていない。
        ここにアイコンを出すと「押せるのに何も起きない」ので、そもそも出さない
        （partition が違うため、押しても通常セッションのタブを対象にしてしまう）。
      */}
      {isPrivate ? null : <browser-action-list partition={PAGE_PARTITION} />}
      <button
        type="button"
        className="icon"
        title="ダウンロード（⌘⇧J）"
        onClick={() => void window.nemo.setOverlay('downloads')}
      >
        ↓{shared.downloads.some((item) => item.state === 'progressing') ? <span className="badge" /> : null}
      </button>
      <button
        type="button"
        className="icon"
        title="履歴とアーカイブ（⌘Y）"
        onClick={() => void window.nemo.setOverlay('library')}
      >
        🕘
      </button>
      <button
        type="button"
        className="icon"
        title="新規タブ（⌘T）"
        onClick={() => void window.nemo.setOverlay('command-bar')}
      >
        ＋
      </button>
    </div>
  )
}

/**
 * 編集していないときの表示。**ホストだけを白く**して、残りは沈める
 * （どのサイトを見ているかが、長い URL でも一目で分かるようにする）。
 */
function Address({ tab }: { tab: TabState | null }): React.JSX.Element {
  const url = tab?.url ?? ''
  const pretty = prettyUrl(url)
  if (!pretty) return <span className="u dim">URL または検索</span>

  const host = hostOf(url)
  const rest = host && pretty.startsWith(host) ? pretty.slice(host.length) : ''
  return (
    <>
      {url.startsWith('https://') ? <LockIcon /> : null}
      <span className="u">
        {host ? <b>{host}</b> : null}
        {host ? rest : pretty}
      </span>
    </>
  )
}

/** 鍵（https）。絵文字だとそこだけ極彩色になるので SVG で描く。 */
function LockIcon(): React.JSX.Element {
  return (
    <svg className="lock" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5a3.2 3.2 0 0 0-3.2 3.2V6.5H4a.9.9 0 0 0-.9.9v6.2c0 .5.4.9.9.9h8a.9.9 0 0 0 .9-.9V7.4a.9.9 0 0 0-.9-.9h-.8V4.7A3.2 3.2 0 0 0 8 1.5Zm0 1.6c.9 0 1.6.7 1.6 1.6V6.5H6.4V4.7c0-.9.7-1.6 1.6-1.6Z" />
    </svg>
  )
}
