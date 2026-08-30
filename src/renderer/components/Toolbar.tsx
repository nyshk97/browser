import { useEffect, useMemo, useRef, useState } from 'react'
import { hostOf, prettyUrl, useSharedState, useWindowState } from '../useNemo.js'
import type { LoadedExtensionInfo, TabState } from '../../shared/types.js'

const PAGE_PARTITION = 'persist:nemo'

/**
 * `<browser-action-list>` の中で**表示する**ボタンを絞る CSS。
 *
 * electron-chrome-extensions はロード済みの拡張の action を全部並べ、絞る API は無い
 * （`browserAction.getState` は全件を返す）。ボタンは open な shadowRoot に
 * `<button id="<拡張ID>" class="action">` で入るので、こちらから `<style>` を 1 枚差し込み、
 * lock で `showInToolbar` にしたもの以外を `display: none` にする。
 * ライブラリは `.action` の追加・削除しかしないので、差し込んだ style は消えない。
 * popup の位置はボタンの rect 基準なので、隣を隠しても位置はずれない。
 */
function toolbarActionFilterCss(extensions: readonly LoadedExtensionInfo[]): string {
  const shown = extensions.filter((extension) => extension.enabled && extension.showInToolbar)
  // 対象が 0 件（Bitwarden を OFF にした端末など）は要素ごと畳む（幅 0 の要素が gap を 1 つぶん食う）
  if (shown.length === 0) return ':host { display: none !important; }'
  const keep = shown.map((extension) => `:not(#${extension.id})`).join('')
  return `.action${keep} { display: none !important; }`
}

/** shadowRoot に 1 枚だけ持つ `<style>` を作る／更新する。 */
function applyToolbarActionFilter(list: HTMLElement, css: string): boolean {
  const root = list.shadowRoot
  if (!root) return false
  let style = root.querySelector<HTMLStyleElement>('style[data-nemo-action-filter]')
  if (!style) {
    style = document.createElement('style')
    style.dataset['nemoActionFilter'] = ''
    root.appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
  return true
}

/**
 * `<browser-action-list>` に表示フィルタを当て続ける。
 * shadowRoot はカスタム要素が定義（upgrade）されてから付くので、`whenDefined` を待つ。
 */
function useToolbarActionFilter(
  listRef: React.RefObject<HTMLElement | null>,
  extensions: readonly LoadedExtensionInfo[]
): void {
  const css = useMemo(() => toolbarActionFilterCss(extensions), [extensions])
  useEffect(() => {
    let cancelled = false
    const apply = (): void => {
      const list = listRef.current
      if (cancelled || !list) return
      if (!applyToolbarActionFilter(list, css)) {
        // 定義済みなのに shadowRoot が無い = まだ upgrade されていない。次のフレームで再試行
        requestAnimationFrame(apply)
      }
    }
    void customElements.whenDefined('browser-action-list').then(apply)
    return () => {
      cancelled = true
    }
  }, [listRef, css])
}

/**
 * ページ領域の上端に敷くツールバー（DESIGN.md「ツールバー」）。
 *
 * ナビゲーション・アドレスバー・拡張・ダウンロード・履歴をここに集約し、
 * サイドバーは「枠とタブの一覧」だけを持つ。**サイドバーの右側**に敷かれる
 * 別の WebContentsView なので、サイドバーと状態は共有せず、どちらも
 * `useWindowState()` で main から同じ状態を受け取る。
 */
export function Toolbar({ pane = 'left' }: { pane?: 'left' | 'right' }): React.JSX.Element {
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
  const actionListRef = useRef<HTMLElement>(null)
  useToolbarActionFilter(actionListRef, shared.extensions)

  /**
   * このツールバーが担当するタブ。
   *
   * **基準は必ず `activeTabKey`**。1 ウィンドウに分割ペアは複数ありうるので、
   * 「`splitSide === 'right'` の最初のタブ」のような探し方をすると、
   * いま見えていない別のペアのツールバーが出る。
   */
  const activeTab: TabState | null = useMemo(() => paneTab(state, pane), [state, pane])

  const isPrivate = state?.isPrivate === true
  const sidebarVisible = state?.sidebarVisible !== false
  /** 分割中か（✕ を出すかどうかの判定に使う）。 */
  const inSplit = activeTab?.splitSide !== null && activeTab?.splitSide !== undefined

  /**
   * **ペイン固有の操作はフォーカスも移す**。
   * 通さないと「左のアドレスバーを触ったのにフォーカス枠・⌘W・⌘F・拡張の対象は右のまま」になる。
   * ウィンドウ共通の操作（サイドバー開閉・拡張・ダウンロード・履歴・＋）では呼ばない。
   */
  const focusPane = (): void => {
    if (activeTab && state && activeTab.key !== state.activeTabKey) {
      void window.nemo.selectTab(activeTab.key)
    }
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const input = draft ?? activeTab?.url ?? ''
    setDraft(null)
    inputRef.current?.blur()
    focusPane()
    if (activeTab) void window.nemo.navigate(activeTab.key, input)
    else void window.nemo.createTab(input)
  }

  return (
    /*
     * サイドバーを隠しているときは、この View がウィンドウの左端まで伸びる。
     * 信号機ボタンはウィンドウ側に描かれるので、そのぶんの余白をここで空ける
     * （空けないと戻る・進むボタンが信号機の下に潜る）。
     *
     * **分割中は左ペインが `SPLIT_INSET` ぶん右から始まる**ので、
     * 余白は窓の左端基準で測り直す（`.inset-split`）。付けないと 8px ぶん余分に空く。
     */
    <div
      className={`toolbar${sidebarVisible || pane === 'right' ? '' : ' inset'}${
        !sidebarVisible && pane === 'left' && inSplit ? ' inset-split' : ''
      }${isPrivate ? ' private' : ''}`}
    >
      {/*
        サイドバーの開閉は**ウィンドウ共通**なので左だけに置く。
        右にも置くと同じボタンが 2 つ並ぶし、`.inset`（信号機ぶんの余白）も
        右に付けると画面の真ん中に理由の無い余白ができる。
      */}
      {pane === 'left' ? (
        <button
          type="button"
          className="icon"
          title={sidebarVisible ? 'サイドバーを隠す（⌘S）' : 'サイドバーを出す（⌘S）'}
          onClick={() => void window.nemo.setSidebarVisible(!sidebarVisible)}
        >
          {sidebarVisible ? '⇤' : '⇥'}
        </button>
      ) : null}
      <button
        type="button"
        className="icon nav"
        title="戻る"
        disabled={!activeTab?.canGoBack}
        onClick={() => {
          focusPane()
          if (activeTab) void window.nemo.goBack(activeTab.key)
        }}
      >
        ‹
      </button>
      <button
        type="button"
        className="icon nav"
        title="進む"
        disabled={!activeTab?.canGoForward}
        onClick={() => {
          focusPane()
          if (activeTab) void window.nemo.goForward(activeTab.key)
        }}
      >
        ›
      </button>
      <button
        type="button"
        className="icon nav"
        title={activeTab?.loading ? '停止' : '再読み込み（右クリックでキャッシュを無視）'}
        disabled={!activeTab}
        onClick={() => {
          focusPane()
          if (!activeTab) return
          void (activeTab.loading ? window.nemo.stop(activeTab.key) : window.nemo.reload(activeTab.key))
        }}
        onContextMenu={(event) => {
          // スーパーリロード。⌘⇧R と同じ経路（キャッシュを捨てて読み直す）
          event.preventDefault()
          focusPane()
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
          onClick={() => {
            focusPane()
            setDraft(activeTab?.url ?? '')
          }}
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
      {/*
        拡張・ダウンロード・履歴・＋ は**ウィンドウ共通**なので左だけに置く。
        特に `<browser-action-list>` は、同じ partition のものを 2 枚出すと
        popup がどちらの View に属するのか曖昧になり、位置合わせ（`popupAnchorOffset`）が
        当てにならなくなる。
      */}
      {pane === 'left' ? (
        <>
          {isPrivate ? null : <browser-action-list ref={actionListRef} partition={PAGE_PARTITION} />}
          <button
            type="button"
            className="icon"
            title="ダウンロード（⌘⇧J）"
            onClick={() => void window.nemo.setOverlay('downloads')}
          >
            ↓
            {shared.downloads.some((item) => item.state === 'progressing') ? (
              <span className="badge" />
            ) : null}
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
        </>
      ) : null}
      {/*
        このペインを閉じる。**⌘W とは別経路**にする。
        ⌘W は「Peek が出ていれば Peek を閉じる」規則を持っているが、
        こちらは担当ペインのタブそのものを閉じる（浮いている Peek は
        `removeTab` が親と一緒に閉じるので、ここで書き足す処理は無い）。
      */}
      {inSplit ? (
        <button
          type="button"
          className="icon"
          title="このペインを閉じる"
          onClick={() => {
            // **ペイン固有の操作なのでフォーカスも移す**（戻る / 進む / リロード /
            // アドレスバーと同じ規則）。閉じる直前に担当ペインへ移しておかないと、
            // 相方に Peek が出ている場面で「どのタブの Peek を巻き添えにするか」が
            // 押した側と食い違う。
            focusPane()
            if (activeTab) void window.nemo.closeTab(activeTab.key)
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  )
}

/**
 * このツールバーが担当するタブを決める。**規則はここ 1 つ**。
 *
 * 分割していなければ左が `activeTabKey`・右は担当なし（View ごと隠れる）。
 * 分割していれば `splitSide` と `splitPartnerKey` から左右を導く。
 */
function paneTab(state: ReturnType<typeof useWindowState>, pane: 'left' | 'right'): TabState | null {
  if (!state) return null
  const active = state.tabs.find((tab) => tab.key === state.activeTabKey) ?? null
  if (!active) return null
  if (active.splitSide === null) return pane === 'left' ? active : null
  const partner = state.tabs.find((tab) => tab.key === active.splitPartnerKey) ?? null
  if (!partner) return pane === 'left' ? active : null
  const left = active.splitSide === 'left' ? active : partner
  const right = active.splitSide === 'left' ? partner : active
  return pane === 'left' ? left : right
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
