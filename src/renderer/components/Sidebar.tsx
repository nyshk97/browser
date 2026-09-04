import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { foregroundTab, useCommand, useSharedState, useShortcutHint, useWindowState } from '../useNemo.js'
import { PinnedTree } from './PinnedTree.js'
import { TabRow, TAB_DRAG_TYPE, useDragEnd } from './TabRow.js'
import { SplitRow } from './SplitRow.js'
import { RenameInput } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import {
  IconEdit,
  REJECTED_MESSAGE,
  TOO_LARGE_MESSAGE,
  fileToIconDataUrl,
  isImageFileDrag
} from './IconEdit.js'
import { UrlEdit } from './UrlEdit.js'
import { LiveFolder, visibleLiveRows, type LiveCollapsed } from './LiveFolder.js'
import { normalizePrUrl } from '../../shared/live-folder-schema.js'
import { FAVORITE_SECTIONS, SHORTCUT_SECTION, isImageIcon } from '../../shared/favorites.js'
import {
  currentRow,
  rowMatchesTab,
  sidebarRows,
  stepRow,
  type SidebarRow
} from '../../shared/sidebar-rows.js'
import type {
  EphemeralTabDef,
  FavoriteItem,
  FavoriteSection,
  LivePrBucket,
  TabState,
  UpdateState
} from '../../shared/types.js'

/**
 * サイドバー（DESIGN.md「3層の並び」）。
 * Live Folder → Favorites（tools / messages）→ ピン留め → 一時タブ の順で固定する。
 * **アドレスバーとナビゲーションはここには無い**（ページ領域の上端の `Toolbar`）。
 */
export function Sidebar(): React.JSX.Element {
  const state = useWindowState()
  const shared = useSharedState()

  // copy-url は「いま見えているページ」の URL（Peek が出ていれば Peek）
  const foreground = useMemo(() => foregroundTab(state), [state])

  /**
   * Live Folder の小見出しの開閉。**起動のたびに両方折りたたみ**（永続化しない。PR が多いと
   * サイドバーを占領するので普段は畳む）。
   *
   * `LiveFolder` でなくここで持つのは、⌘⌥↑↓ の行の並びが「畳んだ小見出しの行は無い」を知る必要があるため。
   * `LiveFolder` 側で持っていた頃は `liveFolderEnabled` を false → true にしたときの unmount で畳み直っていたが、
   * 今は Sidebar が生きている限り開閉が残る（畳み直す契機は起動だけ）。
   */
  const [liveCollapsed, setLiveCollapsed] = useState<LiveCollapsed>({ review: true, mine: true })
  const toggleLiveBucket = useCallback(
    // 関数形式にする（同一タスクで 2 つ連続クリックされても片方の更新を落とさない）
    (bucket: LivePrBucket) => setLiveCollapsed((prev) => ({ ...prev, [bucket]: !prev[bucket] })),
    []
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
   * 一時タブの一覧。**全ウィンドウ共有の定義（`shared.ephemeralTabs`）が正**で、
   * このウィンドウのタブ実体は「実体化済みか / アクティブか」の装飾に使う
   * （ピン留め行の `openPinnedIds` と同じ型）。
   *
   * - `shared.ephemeralTabs` が来ないシークレットウィンドウは、従来どおり
   *   ウィンドウローカルのタブ一覧に倒す（private 専用の分岐を別に書かない）
   * - `ephemeralId` を持たないローカルタブ（`about:blank`・拡張ページ）は
   *   **常に一覧の末尾へ併記**する（定義化後も末尾 = 新規追加の位置なので行が飛ばない）
   * - **専用枠（ピン留め / Favorites）に属するタブと Peek は出さない**
   *   （出すと同じタブがサイドバーに2回並ぶ / Peek は親タブ1本に見せる）
   * - **Live Folder に載っている URL は出さない**（二重に並ぶ）。ただし
   *   分割に入っている実体は除外より結合行を優先する —— 除外を掛けたままだと、
   *   分割したページが PR の URL へ遷移した瞬間に結合行ごと消え、解除する導線が無くなる
   */
  const ephemeralRows = useMemo(() => {
    const tabs = (state?.tabs ?? []).filter(
      (tab) => tab.pinnedId === null && tab.favoriteId === null && tab.peekParentKey === null
    )
    const defs = shared.ephemeralTabs
    let rows: { def: EphemeralTabDef | null; tab: TabState | null }[]
    if (defs === null) {
      rows = tabs.map((tab) => ({ def: null, tab }))
    } else {
      const byDef = new Map(tabs.flatMap((tab) => (tab.ephemeralId ? [[tab.ephemeralId, tab] as const] : [])))
      const defIds = new Set(defs.map((def) => def.id))
      rows = [
        ...defs.map((def) => ({ def, tab: byDef.get(def.id) ?? null })),
        // 定義が見つからない `ephemeralId`（壊れた参照）もローカル行として出す。
        // 落とすと「サイドバーに出ないのに閉じられないタブ」になり、手がかりが残らない
        ...tabs
          .filter((tab) => tab.ephemeralId === null || !defIds.has(tab.ephemeralId))
          .map((tab) => ({ def: null, tab }))
      ]
    }
    return rows.filter((row) => {
      if (row.tab && row.tab.splitSide !== null) return true
      const key = normalizePrUrl(row.tab?.url ?? row.def?.url ?? '')
      return !(key !== null && liveUrls.has(key))
    })
  }, [state, shared.ephemeralTabs, liveUrls])

  /** このウィンドウに実体がある一時タブ（分割のドロップ判定・結合行の相方解決に使う）。 */
  const ephemeral: TabState[] = useMemo(
    () => ephemeralRows.flatMap((row) => (row.tab ? [row.tab] : [])),
    [ephemeralRows]
  )

  /**
   * 分割ペアの中での役割。**描画（結合行）と ⌘⌥↑↓ の並びの両方がこれを見る**（判定を 2 か所に書かない）。
   * 右側は自分の行を持たない（左が結合行として両方を描く）。相方が見つからないときは通常の行に落とす（保険）。
   */
  const splitRole = useCallback(
    (tab: TabState): { side: 'left' | 'right'; partner: TabState } | null => {
      if (tab.splitSide === null || !tab.splitPartnerKey) return null
      const partner = ephemeral.find((other) => other.key === tab.splitPartnerKey) ?? null
      return partner ? { side: tab.splitSide, partner } : null
    },
    [ephemeral]
  )

  /** アクティブなタブ（Peek が前面でも `activeTabKey` は親なので、⌘⌥↑↓ の現在位置は必ず親の行で解ける）。 */
  const activeTab = useMemo(() => state?.tabs.find((tab) => tab.key === state.activeTabKey) ?? null, [state])

  /**
   * ⌘⌥↑↓ が渡る「見えている行」（DESIGN.md「⌘⌥↑↓ でサイドバーの行を渡る」）。
   * 分割ペアは左 → 右の 2 行に展開する（同じキーでペイン間も移れる）。
   */
  const rows = useMemo(
    () =>
      sidebarRows({
        liveRows: visibleLiveRows(shared.liveFolder, liveCollapsed),
        favorites: shared.favorites,
        pinned: shared.pinned,
        ephemeralRows: ephemeralRows.flatMap((row): { key: string | null; defId: string | null }[] => {
          const tab = row.tab
          if (!tab) return row.def ? [{ key: null, defId: row.def.id }] : []
          const split = splitRole(tab)
          if (split?.side === 'right') return []
          const self = { key: tab.key, defId: tab.ephemeralId }
          return split ? [self, { key: split.partner.key, defId: split.partner.ephemeralId }] : [self]
        })
      }),
    [shared.liveFolder, shared.favorites, shared.pinned, liveCollapsed, ephemeralRows, splitRole]
  )

  /**
   * ⌘⌥↑↓ で自分が指した行のトレイル。
   *
   * 選択・開く API は invoke の往復 + `pushState` 経由なので、押した直後の `state` は 1 手前のまま。
   * 連打・キーリピートで毎回 `state` から解くと同じ行へ再実行して進まないので、
   * 起点はトレイルの末尾（無ければ `state` のアクティブなタブの行）にする。
   */
  const trail = useRef<SidebarRow[]>([])
  useEffect(() => {
    // アクティブが変わるたびに掃除する。トレイルのどれかに一致すれば**そこまでを確定として切り落とし**
    // （末尾はそのまま残す）、どれにも一致しなければ別経路の移動（クリック・⌃Tab）なので空にする
    const list = trail.current
    if (list.length === 0) return
    const index = activeTab ? list.findIndex((row) => rowMatchesTab(row, activeTab)) : -1
    trail.current = index < 0 ? [] : list.slice(index)
  }, [activeTab])

  const moveRow = useCallback(
    (delta: 1 | -1) => {
      const from = trail.current[trail.current.length - 1] ?? currentRow(rows, activeTab)
      const target = stepRow(rows, from, delta)
      if (!target) return
      // 1 手目は**起点も一緒に積む**。行き先だけだと、反映待ちの間に届く push（タイトル・favicon・読み込み）で
      // `activeTabKey` がまだ起点のままなのを掃除の effect が「別経路の移動」と見てトレイルを捨て、
      // 連打の出だしで 1 手落ちる
      trail.current = trail.current.length > 0 ? [...trail.current, target] : from ? [from, target] : [target]
      switch (target.kind) {
        case 'live':
          void window.nemo.liveFolderOpen(target.url)
          break
        case 'favorite':
          void window.nemo.openFavorite(target.id)
          break
        case 'pin':
          void window.nemo.openPinned(target.id)
          break
        case 'ephemeral':
          // 実体があれば選ぶだけ、無ければこのウィンドウで実体化する（クリックと同じ）
          if (target.key) void window.nemo.selectTab(target.key)
          else if (target.defId) void window.nemo.openEphemeral(target.defId)
          break
      }
      scrollRowIntoView(target)
    },
    [rows, activeTab]
  )

  useCommand(
    useCallback(
      (command) => {
        if (command === 'copy-url' && foreground) void window.nemo.copyUrl(foreground.key)
        if (command === 'select-row-below') moveRow(1)
        if (command === 'select-row-above') moveRow(-1)
      },
      [foreground, moveRow]
    )
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
            <LiveFolder
              state={shared.liveFolder}
              openUrls={openLiveUrls}
              collapsed={liveCollapsed}
              onToggle={toggleLiveBucket}
            />
            <div className="tabs-sep" />
          </>
        ) : null}

        <FavoriteSections favorites={shared.favorites} tabs={favoriteTabs} />

        {/* messages と bookmarks の間に線は引かない（ラベルだけで区切る） */}
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
          線をホバーすると右端に「↓ Clear」が出て、野良タブを全部閉じる（Arc の Clear）。
          閉じる行が無いときはボタンを出さない（線だけ）。
        */}
        <ClearSeparator count={ephemeralRows.length} />
        <button
          type="button"
          className="row new-tab"
          onClick={() => void window.nemo.setOverlay('command-bar')}
        >
          <span className="plus">＋</span>
          <span className="tt">New Tab</span>
        </button>
        {ephemeralRows.map((row) => {
          const tab = row.tab
          // このウィンドウに実体が無い共有定義の行（クリックで実体化・× で全ウィンドウから削除）
          if (!tab) return row.def ? <EphemeralDefRow key={row.def.id} def={row.def} /> : null
          // 分割の右側は自分の行を持たない（左が結合行として両方を描く）。判定は `splitRole`
          const split = splitRole(tab)
          if (split?.side === 'right') return null
          if (split) {
            return (
              <SplitRow
                key={tab.key}
                left={tab}
                right={split.partner}
                focusedKey={state?.activeTabKey ?? null}
                visible={tab.key === state?.activeTabKey || split.partner.key === state?.activeTabKey}
              />
            )
          }
          return (
            <TabRow
              key={tab.key}
              tab={tab}
              active={tab.key === state?.activeTabKey}
              // 共有定義の名前は定義が正（rename は定義へ書かれ、タブ側の customTitle は使わない）
              label={row.def?.customTitle ?? undefined}
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
 * ピン留めと一時タブの境界線。ホバーで右端に「↓ Clear」が出て、押すと**線の直下に小さな確認**が
 * 浮かぶ（ホバーで出るボタンは誤タップしやすいので 1 回だけ確認する。ページの上に出る
 * `PromptDialog` だと視線がボタンから離れるので、押した場所のすぐそばに出す）。
 *
 * - 中身は赤い「Close all tabs」ボタン 1 つだけ（問いの文言もキャンセルのボタンも置かない）。
 *   ボタンにフォーカスを置くので Enter で進む。Esc・外側クリックで何もしない
 * - 閉じる行が無いときはボタンを出さない（線だけ）
 */
function ClearSeparator({ count }: { count: number }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  // 閉じる行が無くなったら（別ウィンドウで閉じた等）確認も畳む（描画時に導出。effect で setState しない）
  const open = armed && count > 0
  const popoverRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onPointerDown = (event: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) setArmed(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setArmed(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return (
    <div className={`tabs-sep clear-sep${open ? ' armed' : ''}`}>
      {count > 0 ? (
        <button
          type="button"
          className="clear-tabs"
          title="一時タブを全部閉じる"
          onClick={() => setArmed((value) => !value)}
        >
          <span className="arrow">↓</span>
          <span>Clear</span>
        </button>
      ) : null}
      {open ? (
        <div className="clear-confirm" role="dialog" ref={popoverRef}>
          <button
            type="button"
            className="danger"
            ref={confirmRef}
            onClick={() => {
              setArmed(false)
              void window.nemo.clearEphemeralTabs()
            }}
          >
            Close all tabs
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * ⌘⌥↑↓ で入った行が画面外なら見える位置まで寄せる。
 * 手がかりは各行が自走検証用に持っている `data-*`（無ければ何もしない）。
 */
function scrollRowIntoView(row: SidebarRow): void {
  // 引用符付きの属性値なので、値は CSS 文字列として `JSON.stringify` でエスケープする（`CSS.escape` は識別子用）
  const attr = (name: string, value: string): string => `[${name}=${JSON.stringify(value)}]`
  const selector = (() => {
    switch (row.kind) {
      case 'live':
        return `.lf-row${attr('data-url', row.url)}`
      case 'favorite':
        return `.fav${attr('data-id', row.id)}`
      case 'pin':
        return `.row.pin${attr('data-pin', row.id)}`
      case 'ephemeral':
        if (row.key) return `.row${attr('data-key', row.key)}, .chip${attr('data-key', row.key)}`
        return row.defId ? `.row.remote${attr('data-def-id', row.defId)}` : null
    }
  })()
  if (!selector) return
  document.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
}

/**
 * このウィンドウに実体が無い、全ウィンドウ共有の一時タブ定義の行。
 *
 * 別ウィンドウで開いている（かもしれない）タブが Arc 風に非アクティブの見た目で並ぶ。
 * 許す操作は**クリック（このウィンドウで実体化）と ×（定義ごと削除 = 全ウィンドウから消える）**
 * の 2 つだけ。rename・分割・copy-url などは実体化してから
 * （`TabRow` / `RowMenu` は `tab.key` 前提なので、ここに口を広げない）。
 */
function EphemeralDefRow({ def }: { def: EphemeralTabDef }): React.JSX.Element {
  const name = def.customTitle ?? def.title
  return (
    <div
      className="row remote"
      title={name}
      data-def-id={def.id}
      onClick={() => void window.nemo.openEphemeral(def.id)}
    >
      <Favicon url={def.url} title={name} src={def.faviconUrl} />
      <span className="tt">{name}</span>
      <button
        type="button"
        className="x"
        title="閉じる（全ウィンドウから消える）"
        onClick={(event) => {
          event.stopPropagation()
          void window.nemo.closeEphemeral(def.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

/**
 * Favorites の 2 セクション（tools → messages）。
 *
 * ドラッグ中の Favorite の ID を**ここで**持つ。グリッドごとに持つと、
 * tools のタイルを messages へ落としたときに受け側が「何が落ちてきたか」を知らない。
 *
 * 空セクションも受け皿を出す（出さないと D&D で振り分ける入口が消える）。
 * ただし **Favorites が 1 件も無い初回だけは messages を畳む**（空箱 2 つで重くしない。
 * tools は既定の受け皿なので初回も出す）。
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

  // ⌘N が付くのは SHORTCUT_SECTION（tools）だけ（messages に番号は無い）
  const sections = FAVORITE_SECTIONS.map((section) => ({
    section,
    items: favorites.filter((item) => item.section === section)
  }))
  return (
    <>
      {sections.map(({ section, items }) => {
        if (section === 'messages' && favorites.length === 0) return null
        return (
          <FavoriteGrid
            key={section}
            section={section}
            favorites={items}
            tabs={tabs}
            dragId={dragId}
            setDragId={setDragId}
            numbered={section === SHORTCUT_SECTION}
            showKeys={keys}
          />
        )
      })}
    </>
  )
}

/** ⌘1〜9 の対象。tools の先頭からの番号で、10 個目からは番号が付かない。 */
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
  numbered,
  showKeys
}: {
  section: FavoriteSection
  favorites: FavoriteItem[]
  tabs: Map<string, TabState>
  dragId: string | null
  setDragId: (id: string | null) => void
  numbered: boolean
  showKeys: boolean
}): React.JSX.Element {
  const [dropping, setDropping] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** アイコン編集中の Favorite。`error` はドロップで拒否されたときに枠へ持ち越す文言。 */
  const [iconEdit, setIconEdit] = useState<{ id: string; error?: string } | null>(null)
  const [urlEditId, setUrlEditId] = useState<string | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
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
          const shortcut = numbered ? index + 1 : null
          return (
            <button
              key={favorite.id}
              type="button"
              className={classes.join(' ')}
              title={shortcut !== null && shortcut <= MAX_SHORTCUT ? `${name}（⌘${shortcut}）` : name}
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
              // 開いていても閉じていても即 `openFavorite`（無ければ開く / あれば選ぶ を main 側が吸収する）。
              // グリッドはダブルクリックでリネームしない（名前の変更は右クリックだけ）ので、
              // ピン行のような単クリックの遅延は要らない。ダブルクリックしても 2 発目は選ぶだけで、タブは増えない
              onClick={() => void window.nemo.openFavorite(favorite.id)}
              onContextMenu={(event) => {
                // 右クリックで即削除はしない（取り消せない操作を1クリックに置かない）
                event.preventDefault()
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
              {showKeys && shortcut !== null && shortcut <= MAX_SHORTCUT ? (
                <span className="kb">{shortcut}</span>
              ) : null}
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
