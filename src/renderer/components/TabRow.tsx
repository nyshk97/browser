import { useEffect, useState } from 'react'
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
  onClose
}: {
  tab: TabState
  active: boolean
  indent?: number
  label?: string
  onClick?: () => void
  onClose?: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<RowMenuState | null>(null)

  const classes = ['row']
  if (active) classes.push('active')
  if (tab.asleep) classes.push('asleep')
  if (tab.crashed) classes.push('crashed')

  // ユーザーが付けた名前があればそれを出す（ページ遷移しても変わらない）
  const name = label ?? tab.customTitle ?? tab.title
  const close = onClose ?? ((): void => void window.nemo.closeTab(tab.key))

  return (
    <>
      <div
        className={classes.join(' ')}
        style={indent ? { marginLeft: indent * 14 } : undefined}
        title={name}
        // 編集中はドラッグさせない（入力欄の中で文字を選べなくなる）
        draggable={!editing}
        onDragStart={(event) => {
          event.dataTransfer.setData(TAB_DRAG_TYPE, tab.key)
          event.dataTransfer.effectAllowed = 'move'
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
