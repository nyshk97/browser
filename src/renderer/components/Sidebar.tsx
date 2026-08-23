import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { prettyUrl, useCommand, useSharedState, useWindowState } from '../useNemo.js'
import { PinnedTree } from './PinnedTree.js'
import { TabRow } from './TabRow.js'
import type { LoadedExtensionInfo, TabState, UpdateState } from '../../shared/types.js'

const PAGE_PARTITION = 'persist:nemo'

/**
 * サイドバー（DESIGN.md「3層の並び」）。
 * アドレスバー → Favorites → ピン留め → 一時タブ の順で固定する。
 */
export function Sidebar(): React.JSX.Element {
  const state = useWindowState()
  const shared = useSharedState()
  const [extensions, setExtensions] = useState<LoadedExtensionInfo[]>([])
  /**
   * アドレスバーの入力。
   * `null` は「編集していない」= 現在タブの URL をそのまま出す、という意味。
   * タブの URL を effect で state に写すと、タブを切り替えるたびに
   * 追加のレンダリングが走るうえ、編集中の内容を踏み潰す。
   */
  const [draft, setDraft] = useState<string | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.nemo.getExtensions().then(setExtensions)
  }, [])

  const activeTab = useMemo(() => state?.tabs.find((tab) => tab.key === state.activeTabKey) ?? null, [state])

  useCommand(
    useCallback(
      (command) => {
        if (command === 'copy-url' && activeTab) void window.nemo.copyUrl(activeTab.key)
      },
      [activeTab]
    )
  )

  /** ピン留めに紐づいているタブ（サイドバーで「開いている」表示に使う）。 */
  const openPinnedIds = useMemo(
    () => new Set(state?.tabs.flatMap((tab) => (tab.pinnedId ? [tab.pinnedId] : [])) ?? []),
    [state]
  )

  const pinnedTabs = useMemo(
    () => new Map((state?.tabs ?? []).flatMap((tab) => (tab.pinnedId ? [[tab.pinnedId, tab] as const] : []))),
    [state]
  )

  const ephemeral: TabState[] = useMemo(
    () => (state?.tabs ?? []).filter((tab) => tab.pinnedId === null),
    [state]
  )

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault()
    const input = draft ?? activeTab?.url ?? ''
    setDraft(null)
    addressRef.current?.blur()
    if (activeTab) void window.nemo.navigate(activeTab.key, input)
    else void window.nemo.createTab(input)
  }

  return (
    <div className="sidebar">
      <div className="drag-strip" />

      <div className="nav-row">
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
        <div className="spacer" />
        <button
          type="button"
          className="icon"
          title="サイドバーを隠す（⌘S）"
          onClick={() => void window.nemo.setSidebarVisible(false)}
        >
          ⇤
        </button>
      </div>

      <form className="address" onSubmit={submitAddress}>
        <input
          ref={addressRef}
          value={draft ?? prettyUrl(activeTab?.url ?? '')}
          spellCheck={false}
          placeholder="URL または検索"
          onFocus={(event) => {
            // 編集を始めたら、表示用に短くした形ではなく生の URL を入れる
            setDraft(activeTab?.url ?? '')
            requestAnimationFrame(() => event.target.select())
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(null)
              addressRef.current?.blur()
            }
          }}
        />
      </form>

      <div className="actions">
        {/*
          alignment は「popup がどちら向きに伸びるか」。
          electron-chrome-extensions は既定でアンカーの**右端に popup の右端を合わせる**
          （= 左へ伸びる）ので、サイドバーが左端にある Nemo では画面外へ見切れる。
          `right` を含めるとアンカーの左端に popup の左端が合い、右へ伸びる。
        */}
        <browser-action-list partition={PAGE_PARTITION} alignment="bottom right" />
        <div className="spacer" />
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
          title="新規タブ（⌘T）"
          onClick={() => void window.nemo.setOverlay('command-bar')}
        >
          ＋
        </button>
      </div>

      <FavoriteGrid favorites={shared.favorites} />

      <div className="sep" />

      <div className="scroll">
        <div className="label">
          ピン留め
          <button
            type="button"
            className="mini"
            title="フォルダを作る"
            onClick={() => void window.nemo.createFolder('新しいフォルダ')}
          >
            ＋
          </button>
        </div>
        <PinnedTree nodes={shared.pinned} openIds={openPinnedIds} tabs={pinnedTabs} />

        {/*
          ここから下が一時タブ。見出しは置かず、区切り線と「新しいタブ」行で
          ピン留めとの境目を示す（Arc と同じ並び）。
        */}
        <div className="tabs-sep" />
        <button
          type="button"
          className="row new-tab"
          onClick={() => void window.nemo.setOverlay('command-bar')}
        >
          <span className="plus">＋</span>
          <span className="tt">新しいタブ</span>
        </button>
        {ephemeral.map((tab) => (
          <TabRow key={tab.key} tab={tab} active={tab.key === state?.activeTabKey} />
        ))}
      </div>

      <ExtensionFooter extensions={extensions} version={shared.version} update={shared.update} />
    </div>
  )
}

function FavoriteGrid({
  favorites
}: {
  favorites: { id: string; url: string; title: string }[]
}): React.JSX.Element | null {
  const [dragId, setDragId] = useState<string | null>(null)
  if (favorites.length === 0) return null
  return (
    <div className="fav-grid">
      {favorites.map((favorite, index) => (
        <button
          key={favorite.id}
          type="button"
          className="fav"
          title={favorite.title}
          draggable
          onDragStart={() => setDragId(favorite.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (dragId && dragId !== favorite.id) void window.nemo.moveFavorite(dragId, index)
            setDragId(null)
          }}
          onClick={() => void window.nemo.openFavorite(favorite.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            void window.nemo.removeFavorite(favorite.id)
          }}
        >
          <Favicon url={favorite.url} title={favorite.title} />
        </button>
      ))}
    </div>
  )
}

/**
 * favicon。
 * ページから取れた favicon URL が無いときは、ホスト名の頭文字で代用する
 * （外部の favicon サービスは使わない。CSP と、どこに何を見に行ったかが漏れるのを避ける）。
 */
export function Favicon({
  url,
  title,
  src
}: {
  url: string
  title: string
  src?: string | null
}): React.JSX.Element {
  // 「どの src が失敗したか」を覚える。真偽値だと src が変わっても失敗のままになり、
  // かといって effect でリセットすると余計なレンダリングが挟まる。
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (src && failedSrc !== src) {
    return <img className="fi" src={src} alt="" onError={() => setFailedSrc(src)} />
  }
  let initial = title.trim().slice(0, 1)
  try {
    initial =
      new URL(url).host
        .replace(/^www\./, '')
        .slice(0, 1)
        .toUpperCase() || initial
  } catch {
    /* URL でなければタイトルの頭文字のまま */
  }
  return <span className="fi letter">{initial || '·'}</span>
}

function ExtensionFooter({
  extensions,
  version,
  update
}: {
  extensions: LoadedExtensionInfo[]
  version: string
  update: UpdateState
}): React.JSX.Element {
  const mismatched = extensions.filter((extension) => !extension.matchesLock)
  return (
    <div className="footer">
      {extensions.length === 0 ? (
        <span className="dim">拡張なし</span>
      ) : (
        extensions.map((extension) => (
          <button
            key={extension.id}
            type="button"
            className="ext"
            title={`${extension.name} ${extension.version}${extension.optionsUrl ? '（クリックで設定）' : ''}`}
            disabled={!extension.optionsUrl}
            onClick={() => void window.nemo.openExtensionOptions(extension.id)}
          >
            {extension.name}
          </button>
        ))
      )}
      {mismatched.length > 0 ? <span className="warn">lock 不一致</span> : null}
      <div className="spacer" />
      <VersionBadge version={version} update={update} />
    </div>
  )
}

/**
 * バージョン表示（0クリックで目に入る導線）。
 *
 * 見るのはほぼ「更新が当たったか」を確かめるときなので、メニューを辿らせない。
 * 更新を落とし終えたら**適用は再起動待ち**なので、ここがそのまま導線になる。
 */
function VersionBadge({ version, update }: { version: string; update: UpdateState }): React.JSX.Element {
  if (update.status === 'ready') {
    return (
      <button
        type="button"
        className="version ready"
        title={`${update.version} をインストールする準備ができた`}
        onClick={() => void window.nemo.restartForUpdate()}
      >
        {update.version} に更新
      </button>
    )
  }
  if (update.status === 'downloading') {
    return (
      <span className="version dim" title={`${update.version} を取得中`}>
        更新 {update.percent ?? 0}%
      </span>
    )
  }
  return (
    <button
      type="button"
      className="version dim"
      title="クリックで更新を確認する"
      onClick={() => void window.nemo.checkForUpdates()}
    >
      v{version}
    </button>
  )
}
