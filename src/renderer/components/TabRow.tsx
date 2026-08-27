import { useCallback, useEffect, useState } from 'react'
import { Favicon } from './Sidebar.js'
import { InlineRename } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import type { TabState } from '../../shared/types.js'

/**
 * タブ行をドラッグしていることを表す DataTransfer の型。
 *
 * ピン留めツリー側は `dragover` の時点で「タブを掴んでいるのか」を知る必要があるが、
 * その段階では `getData` が読めない（HTML5 の DnD 仕様）。`types` に出るこの型で見分ける。
 */
export const TAB_DRAG_TYPE = 'application/x-nemo-tab'

/**
 * いま掴んでいるタブの key。
 *
 * **`dragover` の時点では `DataTransfer.getData()` が読めない**（HTML5 の仕様）。
 * `types` を見れば「タブを掴んでいる」は分かるが、**どのタブか**が分からないので、
 * 「自分自身の上か」「ドラッグ元が既に分割に入っているか」を判定できない。
 * サイドバーは 1 枚の View なので、ここに置けば行の間で共有できる。
 * `drop` 側は今までどおり `getData` を正とする。
 */
let draggingTabKey: string | null = null

export function setDraggingTabKey(key: string | null): void {
  draggingTabKey = key
}

export function getDraggingTabKey(): string | null {
  return draggingTabKey
}

/** 行の上でどこに落とそうとしているか。上下端は**将来の並べ替え用に空けてある死に帯**。 */
export type DropZone = 'before' | 'split' | 'after'

/** 上下端の帯の厚み。ここに落としても今は何も起きない。 */
const EDGE = 8

export function dropZoneOf(event: React.DragEvent, element: HTMLElement): DropZone {
  const rect = element.getBoundingClientRect()
  const offset = event.clientY - rect.top
  if (offset < EDGE) return 'before'
  if (offset > rect.height - EDGE) return 'after'
  return 'split'
}

/**
 * その 2 本を左右に並べてよいか。**受け付ける条件はここ 1 つ**（main 側と揃える）。
 *
 * 対象は野良の一時タブだけ。ピン留め / Favorites の行や Live Folder の行は
 * そもそもこの受け口を持たないので、ここで見るのは
 * 「自分自身でないか」「両方とも専用枠に属していないか」「どちらも未分割か」。
 */
export function canSplitWith(draggedKey: string | null, target: TabState, tabs: TabState[]): boolean {
  if (!draggedKey || draggedKey === target.key) return false
  if (target.pinnedId !== null || target.favoriteId !== null) return false
  if (target.splitSide !== null) return false
  const dragged = tabs.find((tab) => tab.key === draggedKey)
  if (!dragged) return false
  if (dragged.pinnedId !== null || dragged.favoriteId !== null) return false
  if (dragged.splitSide !== null) return false
  return true
}

/**
 * ドラッグが終わったら（落としても取り消しても）落とす側の表示を戻す。
 *
 * `dragend` は**掴んだ側の要素**でしか起きない。タブ行を掴んでピン留めや Favorites の上で
 * 離した / 取り消した場合、落とす側は自分の `dragend` を受け取れないので、
 * ドロップ線や受け皿のハイライトが**出したまま残る**。window で拾って必ず戻す。
 */
export function useDragEnd(reset: () => void): void {
  useEffect(() => {
    window.addEventListener('dragend', reset)
    return () => window.removeEventListener('dragend', reset)
  }, [reset])
}

/** サイドバーの1行（タブ実体）。DESIGN.md「状態の見せ方」に対応する。 */
export function TabRow({
  tab,
  active,
  indent = 0,
  label,
  onClick,
  onClose,
  splitTargets
}: {
  tab: TabState
  active: boolean
  indent?: number
  label?: string
  onClick?: () => void
  onClose?: () => void
  /**
   * 分割のドロップを受け付けるなら、判定に使うタブの一覧。
   * **渡さない行は受け口を持たない**（ピン留めツリー・Favorites・Live Folder の行）。
   */
  splitTargets?: TabState[]
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const [dropping, setDropping] = useState(false)

  // ドラッグは掴んだ側でしか `dragend` が起きないので、window で拾って必ず戻す
  useDragEnd(
    useCallback(() => {
      setDropping(false)
      setDraggingTabKey(null)
    }, [])
  )

  const classes = ['row']
  if (active) classes.push('active')
  if (tab.asleep) classes.push('asleep')
  if (tab.crashed) classes.push('crashed')
  if (dropping) classes.push('drop-split')

  // ユーザーが付けた名前があればそれを出す（ページ遷移しても変わらない）
  const name = label ?? tab.customTitle ?? tab.title
  const close = onClose ?? ((): void => void window.nemo.closeTab(tab.key))

  return (
    <>
      <div
        className={classes.join(' ')}
        style={indent ? { marginLeft: indent * 14 } : undefined}
        title={name}
        // 自走検証が行をタブ key で引くための手がかり。
        // D&D は合成イベントで撃つしかなく、並び順から当てるのは壊れやすい。
        data-key={tab.key}
        // 編集中はドラッグさせない（入力欄の中で文字を選べなくなる）
        draggable={!editing}
        onDragStart={(event) => {
          event.dataTransfer.setData(TAB_DRAG_TYPE, tab.key)
          event.dataTransfer.effectAllowed = 'move'
          setDraggingTabKey(tab.key)
        }}
        onDragOver={(event) => {
          if (!splitTargets) return
          if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
          // **`preventDefault` するのは「中央帯 かつ 受け付けられる相手」のときだけ**。
          // 全域で受けると、上下端に落として何も起きない「無反応なドロップ」ができる。
          // 受けないときは伝播も止めない（ピン留めツリー側の判定を邪魔しない）。
          const ok =
            dropZoneOf(event, event.currentTarget) === 'split' &&
            canSplitWith(getDraggingTabKey(), tab, splitTargets)
          if (!ok) {
            if (dropping) setDropping(false)
            return
          }
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          if (!dropping) setDropping(true)
        }}
        onDragLeave={(event) => {
          // 行の中の子要素（favicon・タイトル）へ入るときにも `dragleave` は飛ぶ。
          // 無条件に消すと、行の上を横切るあいだ枠が明滅する。
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDropping(false)
        }}
        onDrop={(event) => {
          if (!splitTargets) return
          const draggedKey = event.dataTransfer.getData(TAB_DRAG_TYPE)
          setDropping(false)
          if (!draggedKey) return
          if (dropZoneOf(event, event.currentTarget) !== 'split') return
          if (!canSplitWith(draggedKey, tab, splitTargets)) return
          event.preventDefault()
          // 受けた側が処理したので、祖先（ピン留めツリー等）には渡さない
          event.stopPropagation()
          // **ドロップ先が左・ドラッグしてきたタブが右**
          void window.nemo.splitTabs(tab.key, draggedKey)
        }}
        // 一時タブの選択は**即時**。実体はもう在るので、遅らせても得が無い
        onClick={() => {
          if (editing) return
          if (onClick) onClick()
          else void window.nemo.selectTab(tab.key)
        }}
        onDoubleClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setEditing(true)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({
            id: tab.key,
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: '名前を変更', run: () => setEditing(true) },
              { label: 'ピン留め', run: () => void window.nemo.pinTab(tab.key) },
              { label: 'Favorites に追加', run: () => void window.nemo.addFavorite(tab.key) },
              { label: '閉じる', danger: true, run: close }
            ]
          })
        }}
        onAuxClick={(event) => {
          // ミドルクリックで閉じる
          if (event.button === 1) close()
        }}
      >
        {tab.loading ? (
          <span className="spin" />
        ) : (
          <Favicon url={tab.url} title={name} src={tab.faviconUrl} />
        )}
        <InlineRename
          title={name}
          editing={editing}
          onSubmit={(title) => {
            setEditing(false)
            void window.nemo.renameTab(tab.key, title)
          }}
          onCancel={() => setEditing(false)}
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
            close()
          }}
        >
          ×
        </button>
      </div>
      {menu ? <RowMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </>
  )
}
