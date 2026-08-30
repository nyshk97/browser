import { useCallback, useMemo, useState } from 'react'
import { useCommand, useSharedState, useWindowState } from '../useNemo.js'
import { PinnedTree } from './PinnedTree.js'
import { TabRow, TAB_DRAG_TYPE, useDragEnd } from './TabRow.js'
import { SplitRow } from './SplitRow.js'
import { RenameInput, useDelayedClick } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import { LiveFolder } from './LiveFolder.js'
import { normalizePrUrl } from '../../shared/live-folder-schema.js'
import type { FavoriteItem, TabState, UpdateState } from '../../shared/types.js'

/**
 * サイドバー（DESIGN.md「3層の並び」）。
 * Favorites → ピン留め → 一時タブ の順で固定する。
 * **アドレスバーとナビゲーションはここには無い**（ページ領域の上端の `Toolbar`）。
 */
export function Sidebar(): React.JSX.Element {
  const state = useWindowState()
  const shared = useSharedState()

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

  /** Favorite に紐づいているタブ（グリッドに状態を重ねて出す）。 */
  const favoriteTabs = useMemo(
    () =>
      new Map((state?.tabs ?? []).flatMap((tab) => (tab.favoriteId ? [[tab.favoriteId, tab] as const] : []))),
    [state]
  )

  /**
   * Live Folder に載っている PR の URL。
   *
   * PR がマージされて一覧から消えると、その URL は載らなくなり、
   * **開いていたタブは自動的に「今日のタブ」に現れる**（降格処理を書かずに降格と同じ結果になる）。
   */
  const liveUrls = useMemo(
    () => new Set((shared.liveFolder?.items ?? []).map((item) => item.url)),
    [shared.liveFolder]
  )

  /**
   * 一時タブ。**専用枠（ピン留め / Favorites）に属するタブはここに出さない**
   * （出すと同じタブがサイドバーに2回並ぶ）。
   *
   * **Peek も出さない**。Peek は親タブの上に浮いているだけで、
   * 一覧では親タブが1本出ているように見せる。
   *
   * **Live Folder に載っている URL のタブも出さない**（同じ理由で二重に並ぶ）。
   */
  const ephemeral: TabState[] = useMemo(
    () =>
      (state?.tabs ?? []).filter((tab) => {
        if (tab.pinnedId !== null || tab.favoriteId !== null || tab.peekParentKey !== null) return false
        // **分割に入っているタブは Live Folder の除外より結合行を優先する**。
        // 除外を掛けたままだと、分割したページが PR の URL へ遷移した瞬間に
        // 結合行ごと消え、画面には分割が出ているのに解除する導線が無くなる。
        if (tab.splitSide !== null) return true
        const key = normalizePrUrl(tab.url)
        return !(key !== null && liveUrls.has(key))
      }),
    [state, liveUrls]
  )

  /** Live Folder の行を「開いている」表示にするための URL 集合。 */
  const openLiveUrls = useMemo(() => {
    const open = new Set<string>()
    for (const tab of state?.tabs ?? []) {
      const key = normalizePrUrl(tab.url)
      if (key) open.add(key)
    }
    return open
  }, [state])

  const isPrivate = state?.isPrivate === true

  return (
    <div className={`sidebar${isPrivate ? ' private' : ''}`}>
      <div className="drag-strip" />

      {/*
        シークレットウィンドウでは拡張がロードされない
        （electron-chrome-extensions は non-persistent セッションに拡張を載せられない）。
        つまり Bitwarden の自動入力が効かない。**黙って効かないのが一番困る**ので必ず出す。
      */}
      {isPrivate ? (
        <div className="private-note">
          <b>シークレットウィンドウ</b>
          <span>履歴・cookie を残さない。閉じると跡形もなく消える</span>
          <span>拡張は動かない（Bitwarden の自動入力は使えない）</span>
        </div>
      ) : null}

      <FavoriteGrid favorites={shared.favorites} tabs={favoriteTabs} />

      <div className="sep" />

      <div className="scroll">
        {/*
          Live Folder は DESIGN.md の3層に**4層目として割り込む**
          （Favorites の直下・ピン留めの見出しより上）。
          シークレットウィンドウと設定で無効のときは `liveFolder` が null で来る。
        */}
        {shared.liveFolder ? (
          <>
            <LiveFolder state={shared.liveFolder} openUrls={openLiveUrls} />
            <div className="tabs-sep" />
          </>
        ) : null}

        <div className="label">
          <PinIcon />
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
          ここから下が一時タブ。見出しは置かず、区切り線と「New Tab」行で
          ピン留めとの境目を示す（Arc と同じ並び）。
        */}
        <div className="tabs-sep" />
        <button
          type="button"
          className="row new-tab"
          onClick={() => void window.nemo.setOverlay('command-bar')}
        >
          <span className="plus">＋</span>
          <span className="tt">New Tab</span>
        </button>
        {ephemeral.map((tab) => {
          // 分割の右側は自分の行を持たない（左が結合行として両方を描く）。
          // 相方が見つからないときだけ通常の行に落とす（保険）。
          const partner = tab.splitPartnerKey
            ? (ephemeral.find((other) => other.key === tab.splitPartnerKey) ?? null)
            : null
          if (tab.splitSide === 'right' && partner) return null
          if (tab.splitSide === 'left' && partner) {
            return (
              <SplitRow
                key={tab.key}
                left={tab}
                right={partner}
                focusedKey={state?.activeTabKey ?? null}
                visible={tab.key === state?.activeTabKey || partner.key === state?.activeTabKey}
              />
            )
          }
          return (
            <TabRow
              key={tab.key}
              tab={tab}
              active={tab.key === state?.activeTabKey}
              splitTargets={ephemeral}
            />
          )
        })}
      </div>

      <Footer version={shared.version} update={shared.update} />
    </div>
  )
}

/**
 * Favorites（サイドバー上部のアイコングリッド）。
 *
 * ピン留めと同じ**専用枠**として描く。押すと Favorite 定義に属するタブが開き、
 * 下の一時タブ一覧には出ない。閉じてもグリッドからは消えない。
 * 状態（読み込み中 / アクティブ / 音）もピン留め行と同じ規則で重ねる。
 */
function FavoriteGrid({
  favorites,
  tabs
}: {
  favorites: FavoriteItem[]
  tabs: Map<string, TabState>
}): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const { schedule, cancel } = useDelayedClick()

  // タブ行を掴んだドラッグは、グリッド側では `dragend` を受け取れない
  useDragEnd(
    useCallback(() => {
      setDragId(null)
      setDropping(false)
    }, [])
  )

  const editing = favorites.find((favorite) => favorite.id === editingId) ?? null

  /** 一時タブをグリッドへ落として Favorites に足す。 */
  const dropTab = (event: React.DragEvent): boolean => {
    const tabKey = event.dataTransfer.getData(TAB_DRAG_TYPE)
    if (!tabKey) return false
    void window.nemo.addFavorite(tabKey)
    return true
  }

  const isTabDrag = (event: React.DragEvent): boolean => event.dataTransfer.types.includes(TAB_DRAG_TYPE)

  // 空のときも受け皿を出す（出さないと最初の1件を D&D で作れない）
  if (favorites.length === 0) {
    return (
      <div
        className={`fav-empty droppable${dropping ? ' drop' : ''}`}
        onDragOver={(event) => {
          if (!isTabDrag(event)) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDropping(false)
          dropTab(event)
        }}
      >
        タブをここへドラッグして Favorites に追加
      </div>
    )
  }

  return (
    <>
      <div
        className={`fav-grid${dropping ? ' drop' : ''}`}
        onDragOver={(event) => {
          if (!isTabDrag(event)) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          // 個々のセルで処理されなかったぶん（隙間へのドロップ）を拾う
          event.preventDefault()
          setDropping(false)
          dropTab(event)
        }}
      >
        {favorites.map((favorite, index) => {
          const tab = tabs.get(favorite.id) ?? null
          const name = favorite.customTitle ?? favorite.title
          const classes = ['fav']
          if (tab?.visible) classes.push('active')
          if (!tab) classes.push('closed')
          return (
            <button
              key={favorite.id}
              type="button"
              className={classes.join(' ')}
              title={name}
              draggable
              onDragStart={() => setDragId(favorite.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropping(false)
                if (dropTab(event)) return
                if (dragId && dragId !== favorite.id) void window.nemo.moveFavorite(dragId, index)
                setDragId(null)
              }}
              onClick={() => {
                // 閉じている枠のクリックだけ遅らせる（ダブルクリックでのリネームを
                // 拾うため。遅らせないと、名前を変えようとしただけで読み込みが走る）
                if (tab) void window.nemo.openFavorite(favorite.id)
                else schedule(() => void window.nemo.openFavorite(favorite.id))
              }}
              onDoubleClick={(event) => {
                event.preventDefault()
                cancel()
                setEditingId(favorite.id)
              }}
              onContextMenu={(event) => {
                // 右クリックで即削除はしない（取り消せない操作を1クリックに置かない）
                event.preventDefault()
                cancel()
                setMenu({
                  id: favorite.id,
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { label: '名前を変更', run: () => setEditingId(favorite.id) },
                    {
                      label: 'Favorites から外す',
                      danger: true,
                      run: () => void window.nemo.removeFavorite(favorite.id)
                    }
                  ]
                })
              }}
            >
              {tab?.loading ? (
                <span className="spin" />
              ) : (
                <Favicon url={favorite.url} title={name} src={tab?.faviconUrl ?? null} />
              )}
              {tab?.audible ? <span className="fav-mark">♪</span> : null}
            </button>
          )
        })}
      </div>
      {/*
        グリッドのセルは小さすぎて中で名前を編集できないので、
        編集中だけグリッドの下に入力欄を出す。
      */}
      {editing ? (
        <div className="fav-edit">
          <RenameInput
            initial={editing.customTitle ?? editing.title}
            onSubmit={(title) => {
              setEditingId(null)
              void window.nemo.renameNode(editing.id, title)
            }}
            onCancel={() => setEditingId(null)}
          />
        </div>
      ) : null}
      {menu ? <RowMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </>
  )
}

/**
 * ピン留めの見出しに出すピンのアイコン。
 *
 * 文字（"ピン留め"）より視線の邪魔にならず、Favorites との層の区別も付く。
 * 絵文字ではなく **`currentColor` を継ぐ SVG** にして、見出しの色（`--nemo-ink-dim`）と
 * 揃うようにする（絵文字だとここだけ極彩色になる）。
 */
function PinIcon(): React.JSX.Element {
  return (
    <svg className="label-icon" viewBox="0 0 24 24" role="img" aria-label="ピン留め">
      <title>ピン留め</title>
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
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

/**
 * サイドバーの足元。設定への導線とバージョン表示だけ。
 *
 * 拡張の一覧はここには出さない（設定画面に ON/OFF 付きの一覧がある。
 * 「lock 不一致」の警告もそちらに出る）。
 */
function Footer({ version, update }: { version: string; update: UpdateState }): React.JSX.Element {
  return (
    <div className="footer">
      <div className="spacer" />
      <button
        type="button"
        className="icon"
        title="設定（⌘,）"
        onClick={() => void window.nemo.setOverlay('settings')}
      >
        ⚙
      </button>
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
