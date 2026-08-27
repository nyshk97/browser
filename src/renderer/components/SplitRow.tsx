import { useCallback, useState } from 'react'
import { Favicon } from './Sidebar.js'
import { InlineRename } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import { TAB_DRAG_TYPE, setDraggingTabKey, useDragEnd } from './TabRow.js'
import type { TabState } from '../../shared/types.js'

/**
 * 左右に並べた 2 本を表す**結合行**（DESIGN.md「分割ビュー」）。
 *
 * 通常のタブ行と同じ 40px の器の中に、小さな面を 2 つ並べる。
 * 器は左タブがいた位置に出て、右タブは自分の行を持たない。
 * 解除すると**その場で 2 行に割れる**（左が上・右が下）—— main 側で
 * 右タブを左の直後へ並べてあるので、ここで並べ替えは要らない。
 */
export function SplitRow({
  left,
  right,
  focusedKey,
  visible
}: {
  left: TabState
  right: TabState
  /** いまフォーカスを持っている側（アクティブなタブ）。 */
  focusedKey: string | null
  /** このペアが画面に出ているか（出ていなければ通常行と同じ地にする）。 */
  visible: boolean
}): React.JSX.Element {
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)

  // チップを掴んだドラッグも**共有 state を必ず戻す**。戻さないと、
  // 取り消した後も古い key が残り、次の `dragover` が「分割に入っているタブを
  // 掴んでいる」と誤判定して受け皿を出さなくなる（`dragover` では `getData` が
  // 読めないので、判定はこの共有 state が正）。
  useDragEnd(useCallback(() => setDraggingTabKey(null), []))

  return (
    <>
      <div className={`split-row${visible ? ' active' : ''}`}>
        {[left, right].map((tab) => (
          <Chip
            key={tab.key}
            tab={tab}
            focused={visible && tab.key === focusedKey}
            editing={editingKey === tab.key}
            onEdit={() => setEditingKey(tab.key)}
            onEditDone={() => setEditingKey(null)}
            onMenu={(event) =>
              setMenu({
                id: tab.key,
                x: event.clientX,
                y: event.clientY,
                items: [
                  { label: '名前を変更', run: () => setEditingKey(tab.key) },
                  { label: 'ピン留め', run: () => void window.nemo.pinTab(tab.key) },
                  { label: 'Favorites に追加', run: () => void window.nemo.addFavorite(tab.key) },
                  { label: '分割を解除', run: () => void window.nemo.separateSplit(tab.key) },
                  { label: '閉じる', danger: true, run: () => void window.nemo.closeTab(tab.key) }
                ]
              })
            }
          />
        ))}
      </div>
      {menu ? <RowMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </>
  )
}

/** 結合行の片側。中身は通常のタブ行と同じ規則（favicon → 名前 → 未読 / ♪ → ×）。 */
function Chip({
  tab,
  focused,
  editing,
  onEdit,
  onEditDone,
  onMenu
}: {
  tab: TabState
  focused: boolean
  editing: boolean
  onEdit: () => void
  onEditDone: () => void
  onMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const name = tab.customTitle ?? tab.title
  return (
    <div
      className={`chip${focused ? ' focus' : ''}${tab.asleep ? ' asleep' : ''}`}
      title={name}
      // 自走検証が引くための手がかり（`TabRow` と同じ）
      data-key={tab.key}
      // **器ごとではなくチップ単位で掴む**。ピン留めツリー / Favorites への
      // ドロップは既存の経路のまま効き、main 側で先に分割が解ける。
      draggable={!editing}
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_DRAG_TYPE, tab.key)
        event.dataTransfer.effectAllowed = 'move'
        setDraggingTabKey(tab.key)
      }}
      onClick={() => {
        if (editing) return
        void window.nemo.selectTab(tab.key)
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onEdit()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(event)
      }}
      onAuxClick={(event) => {
        // ミドルクリックで閉じる（通常のタブ行と同じ）
        if (event.button === 1) void window.nemo.closeTab(tab.key)
      }}
    >
      {tab.loading ? <span className="spin" /> : <Favicon url={tab.url} title={name} src={tab.faviconUrl} />}
      <InlineRename
        title={name}
        editing={editing}
        onSubmit={(title) => {
          onEditDone()
          void window.nemo.renameTab(tab.key, title)
        }}
        onCancel={onEditDone}
      />
      {tab.audible ? (
        <span className="mark" title="音が鳴っている">
          ♪
        </span>
      ) : null}
      {tab.unread ? <span className="dot" title="未読" /> : null}
      <button
        type="button"
        className="x"
        title="閉じる"
        onClick={(event) => {
          event.stopPropagation()
          void window.nemo.closeTab(tab.key)
        }}
      >
        ×
      </button>
    </div>
  )
}
