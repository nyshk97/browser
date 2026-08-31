import { useCallback, useMemo, useState } from 'react'
import { useCommand, useSharedState, useShortcutHint, useWindowState } from '../useNemo.js'
import { PinnedTree } from './PinnedTree.js'
import { TabRow, TAB_DRAG_TYPE, useDragEnd } from './TabRow.js'
import { SplitRow } from './SplitRow.js'
import { RenameInput, useDelayedClick } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import {
  IconEdit,
  REJECTED_MESSAGE,
  TOO_LARGE_MESSAGE,
  fileToIconDataUrl,
  isImageFileDrag
} from './IconEdit.js'
import { UrlEdit } from './UrlEdit.js'
import { LiveFolder } from './LiveFolder.js'
import { normalizePrUrl } from '../../shared/live-folder-schema.js'
import { FAVORITE_SECTIONS, isImageIcon } from '../../shared/favorites.js'
import type { FavoriteItem, FavoriteSection, TabState, UpdateState } from '../../shared/types.js'

/**
 * サイドバー（DESIGN.md「3層の並び」）。
 * Live Folder → Favorites（messages / tools）→ ピン留め → 一時タブ の順で固定する。
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

      <div className="scroll">
        {/*
          Live Folder は最上段（Favorites より上）。定義を持たない自動生成の層なので、
          手で並べる層（Favorites / ピン留め）の上にまとめて置く。
          シークレットウィンドウと設定で無効のときは `liveFolder` が null で来る。
        */}
        {shared.liveFolder ? (
          <>
            <LiveFolder state={shared.liveFolder} openUrls={openLiveUrls} />
            <div className="tabs-sep" />
          </>
        ) : null}

        <FavoriteSections favorites={shared.favorites} tabs={favoriteTabs} />

        {/* tools と bookmarks の間に線は引かない（ラベルだけで区切る） */}
        <div className="label">
          <span>bookmarks</span>
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
 * Favorites の 2 セクション（messages → tools）。
 *
 * ドラッグ中の Favorite の ID を**ここで**持つ。グリッドごとに持つと、
 * messages のタイルを tools へ落としたときに受け側が「何が落ちてきたか」を知らない。
 *
 * **tools が空ならラベルごと畳む**（空になるのは実質初回だけで、上段を空箱 2 つで重くしない）。
 * messages は空でも受け皿を出す（振り分けはここへドロップするのが入口）。
 */
function FavoriteSections({
  favorites,
  tabs
}: {
  favorites: FavoriteItem[]
  tabs: Map<string, TabState>
}): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  // タブ行を掴んだドラッグは、グリッド側では `dragend` を受け取れない
  useDragEnd(useCallback(() => setDragId(null), []))
  const keys = useShortcutHint()

  // ⌘N は messages → tools の通し番号なので、tools の番号は messages の件数ぶんずれる
  const sections = FAVORITE_SECTIONS.map((section) => ({
    section,
    items: favorites.filter((item) => item.section === section)
  }))
  return (
    <>
      {sections.map(({ section, items }, position) => {
        if (section === 'tools' && items.length === 0) return null
        const shortcutOffset = sections.slice(0, position).reduce((sum, prior) => sum + prior.items.length, 0)
        return (
          <FavoriteGrid
            key={section}
            section={section}
            favorites={items}
            tabs={tabs}
            dragId={dragId}
            setDragId={setDragId}
            shortcutOffset={shortcutOffset}
            showKeys={keys}
          />
        )
      })}
    </>
  )
}

/** ⌘1〜9 の対象。messages → tools の通し番号で、10 個目からは番号が付かない。 */
const MAX_SHORTCUT = 9

/**
 * Favorites の 1 セクション（アイコングリッド）。
 *
 * ピン留めと同じ**専用枠**として描く。押すと Favorite 定義に属するタブが開き、
 * 下の一時タブ一覧には出ない。閉じてもグリッドからは消えない。
 * 状態（読み込み中 / アクティブ / 音）もピン留め行と同じ規則で重ねる。
 *
 * ドロップの `index` は**このセクション内の相対位置**（main がフラット配列の位置へ解く）。
 */
function FavoriteGrid({
  section,
  favorites,
  tabs,
  dragId,
  setDragId,
  shortcutOffset,
  showKeys
}: {
  section: FavoriteSection
  favorites: FavoriteItem[]
  tabs: Map<string, TabState>
  dragId: string | null
  setDragId: (id: string | null) => void
  shortcutOffset: number
  showKeys: boolean
}): React.JSX.Element {
  const [dropping, setDropping] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** アイコン編集中の Favorite。`error` はドロップで拒否されたときに枠へ持ち越す文言。 */
  const [iconEdit, setIconEdit] = useState<{ id: string; error?: string } | null>(null)
  const [urlEditId, setUrlEditId] = useState<string | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const { schedule, cancel } = useDelayedClick()

  useDragEnd(useCallback(() => setDropping(false), []))

  const editing = favorites.find((favorite) => favorite.id === editingId) ?? null
  const iconEditing = favorites.find((favorite) => favorite.id === iconEdit?.id) ?? null
  const urlEditing = favorites.find((favorite) => favorite.id === urlEditId) ?? null

  // 名前・アイコン・URL の編集枠は同じ場所（グリッドの下）に出すので排他にする
  // （複数開くと枠が並び、どれもマウント時にフォーカスを取り合う）
  const editName = (id: string | null): void => {
    setIconEdit(null)
    setUrlEditId(null)
    setEditingId(id)
  }
  const editIcon = (next: { id: string; error?: string } | null): void => {
    setEditingId(null)
    setUrlEditId(null)
    setIconEdit(next)
  }
  const editUrl = (id: string | null): void => {
    setEditingId(null)
    setIconEdit(null)
    setUrlEditId(id)
  }

  /** セルに落とされた画像ファイルをアイコンにする。拒否されたら編集枠を開いて理由を出す。 */
  const dropImage = (favoriteId: string, file: File): void => {
    void (async () => {
      try {
        const icon = await fileToIconDataUrl(file)
        const ok = icon ? await window.nemo.setCustomIcon(favoriteId, icon) : false
        if (!ok) editIcon({ id: favoriteId, error: TOO_LARGE_MESSAGE })
      } catch {
        editIcon({ id: favoriteId, error: REJECTED_MESSAGE })
      }
    })()
  }

  /** 一時タブをグリッドへ落として、**このセクション**の Favorites に足す。 */
  const dropTab = (event: React.DragEvent): boolean => {
    const tabKey = event.dataTransfer.getData(TAB_DRAG_TYPE)
    if (!tabKey) return false
    void window.nemo.addFavorite(tabKey, section)
    return true
  }

  const isTabDrag = (event: React.DragEvent): boolean => event.dataTransfer.types.includes(TAB_DRAG_TYPE)
  const acceptsDrag = (event: React.DragEvent): boolean =>
    isTabDrag(event) || dragId !== null || isImageFileDrag(event)

  const other: FavoriteSection = section === 'messages' ? 'tools' : 'messages'
  const label = <div className="label">{section}</div>

  // 空のときも受け皿を出す（出さないと最初の1件を D&D で作れない）
  if (favorites.length === 0) {
    return (
      <>
        {label}
        <div
          className={`fav-empty droppable${dropping ? ' drop' : ''}`}
          data-section={section}
          onDragOver={(event) => {
            if (!acceptsDrag(event)) return
            event.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDropping(false)
            // 画像ファイルは受け皿には落とせない（付ける先の定義が無い）。ページ遷移にしない
            if (event.dataTransfer.files.length > 0) return
            if (dropTab(event)) return
            if (dragId) void window.nemo.moveFavorite(dragId, section)
            setDragId(null)
          }}
        >
          タブをここへドラッグ
        </div>
      </>
    )
  }

  return (
    <>
      {label}
      <div
        className={`fav-grid${dropping ? ' drop' : ''}`}
        data-section={section}
        onDragOver={(event) => {
          if (!acceptsDrag(event)) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          // 個々のセルで処理されなかったぶん（隙間へのドロップ）を拾う → 末尾へ
          event.preventDefault()
          setDropping(false)
          // 隙間に落ちた画像ファイルは飲み込むだけ（既定動作のファイル遷移を `will-navigate` に弾かせない）
          if (event.dataTransfer.files.length > 0) return
          if (dropTab(event)) return
          if (dragId) void window.nemo.moveFavorite(dragId, section)
          setDragId(null)
        }}
      >
        {favorites.map((favorite, index) => {
          const tab = tabs.get(favorite.id) ?? null
          const name = favorite.customTitle ?? favorite.title
          const classes = ['fav']
          if (tab?.visible) classes.push('active')
          if (!tab) classes.push('closed')
          const shortcut = shortcutOffset + index + 1
          return (
            <button
              key={favorite.id}
              type="button"
              className={classes.join(' ')}
              title={shortcut <= MAX_SHORTCUT ? `${name}（⌘${shortcut}）` : name}
              data-id={favorite.id}
              draggable
              onDragStart={() => setDragId(favorite.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropping(false)
                const file = event.dataTransfer.files[0]
                if (file) {
                  if (file.type.startsWith('image/')) dropImage(favorite.id, file)
                  return
                }
                if (dropTab(event)) return
                if (dragId && dragId !== favorite.id) void window.nemo.moveFavorite(dragId, section, index)
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
                editName(favorite.id)
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
                    { label: '名前を変更', run: () => editName(favorite.id) },
                    { label: 'アイコンを変更…', run: () => editIcon({ id: favorite.id }) },
                    { label: 'URLを変更…', run: () => editUrl(favorite.id) },
                    // 「このページに更新」は**開いているときだけ**出す（ピン留め行と同じ規則）
                    ...(tab
                      ? [
                          {
                            label: 'このページに更新',
                            run: () => void window.nemo.updateFavoriteUrl(tab.key)
                          }
                        ]
                      : []),
                    {
                      label: `${other === 'messages' ? 'Messages' : 'Tools'} へ移動`,
                      run: () => void window.nemo.moveFavorite(favorite.id, other)
                    },
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
                <DefinitionIcon
                  url={favorite.url}
                  title={name}
                  customIcon={favorite.customIcon}
                  src={tab?.faviconUrl ?? favorite.faviconUrl}
                />
              )}
              {tab?.audible ? <span className="fav-mark">♪</span> : null}
              {showKeys && shortcut <= MAX_SHORTCUT ? <span className="kb">{shortcut}</span> : null}
            </button>
          )
        })}
      </div>
      {/*
        グリッドのセルは小さすぎて中で名前やアイコンを編集できないので、
        編集中だけグリッドの下に入力欄を出す（名前 / アイコンの 2 モード）。
      */}
      {iconEditing ? (
        <div className="fav-edit">
          <IconEdit
            key={iconEditing.id}
            url={iconEditing.url}
            title={iconEditing.customTitle ?? iconEditing.title}
            current={iconEditing.customIcon}
            fallback={tabs.get(iconEditing.id)?.faviconUrl ?? iconEditing.faviconUrl}
            error={iconEdit?.error ?? null}
            onSubmit={(icon) => window.nemo.setCustomIcon(iconEditing.id, icon)}
            onClose={() => editIcon(null)}
          />
        </div>
      ) : null}
      {urlEditing ? (
        <div className="fav-edit">
          <UrlEdit
            key={urlEditing.id}
            url={urlEditing.url}
            onSubmit={(url) => window.nemo.setDefinitionUrl(urlEditing.id, url)}
            onClose={() => editUrl(null)}
          />
        </div>
      ) : null}
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
 * 定義のアイコン。ユーザーの上書き（`customIcon`）があればそれ、無ければ favicon → 頭文字。
 *
 * 画像の customIcon は `Favicon` の `src` に**畳んで**渡す（`Favicon` は読み込み失敗で
 * 頭文字へ落ちるので、別に渡すと壊れた customIcon が favicon の段を飛ばす）。
 */
export function DefinitionIcon({
  url,
  title,
  customIcon,
  src
}: {
  url: string
  title: string
  customIcon: string | null
  src: string | null
}): React.JSX.Element {
  if (customIcon && !isImageIcon(customIcon)) {
    return <span className="fi def-emoji">{customIcon}</span>
  }
  return <Favicon url={url} title={title} src={customIcon ?? src} />
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
