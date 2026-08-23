import { useState } from 'react'
import { Favicon } from './Sidebar.js'
import type { PinnedNode, TabState } from '../../shared/types.js'

/**
 * ピン留めのツリー（フォルダで入れ子）。
 *
 * 「定義」を描く。開いているタブがあれば、その状態（読み込み中・未読）を重ねて出す。
 * ピン留めタブを閉じても定義は残るので、行そのものは消えない（Arc の挙動）。
 */
export function PinnedTree({
  nodes,
  openIds,
  tabs
}: {
  nodes: PinnedNode[]
  openIds: Set<string>
  tabs: Map<string, TabState>
}): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)

  const render = (list: PinnedNode[], parentId: string | null, depth: number): React.JSX.Element[] =>
    list.map((node, index) => {
      const tab = tabs.get(node.id) ?? null
      const isOpen = openIds.has(node.id)
      const classes = ['row', 'pin']
      if (tab && tab.visible) classes.push('active')
      if (!isOpen) classes.push('closed')
      if (dropHint === node.id) classes.push('drop')

      const dragProps = {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.stopPropagation()
          setDragId(node.id)
        },
        onDragEnd: () => {
          setDragId(null)
          setDropHint(null)
        },
        onDragOver: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          setDropHint(node.id)
        },
        onDragLeave: () => setDropHint((current) => (current === node.id ? null : current)),
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          setDropHint(null)
          if (!dragId || dragId === node.id) return
          // フォルダの上に落としたら中に入れる。リンクの上なら同じ階層のその位置へ。
          if (node.kind === 'folder') void window.nemo.movePinned(dragId, node.id, 0)
          else void window.nemo.movePinned(dragId, parentId, index)
          setDragId(null)
        }
      }

      if (node.kind === 'folder') {
        return (
          <div key={node.id}>
            <div
              className={`row folder${node.collapsed ? '' : ' open'}${dropHint === node.id ? ' drop' : ''}`}
              style={depth ? { marginLeft: depth * 14 } : undefined}
              onClick={() => void window.nemo.toggleFolder(node.id)}
              {...dragProps}
            >
              <span className="caret">▶</span>
              <span className="fi letter">📁</span>
              <span className="tt">{node.title}</span>
              <button
                type="button"
                className="x"
                title="ピン留めを解除"
                onClick={(event) => {
                  event.stopPropagation()
                  void window.nemo.unpin(node.id)
                }}
              >
                ×
              </button>
            </div>
            {node.collapsed ? null : (
              <div className="children">{render(node.children, node.id, depth + 1)}</div>
            )}
          </div>
        )
      }

      return (
        <div
          key={node.id}
          className={classes.join(' ')}
          style={depth ? { marginLeft: depth * 14 } : undefined}
          title={node.title}
          onClick={() => void window.nemo.openPinned(node.id)}
          {...dragProps}
        >
          {tab?.loading ? (
            <span className="spin" />
          ) : (
            <Favicon url={node.url} title={node.title} src={tab?.faviconUrl ?? null} />
          )}
          <span className="tt">{node.title}</span>
          {tab?.audible ? <span className="mark">♪</span> : null}
          {tab?.unread ? <span className="dot" /> : null}
          <button
            type="button"
            className="x"
            title="ピン留めを解除"
            onClick={(event) => {
              event.stopPropagation()
              void window.nemo.unpin(node.id)
            }}
          >
            ×
          </button>
        </div>
      )
    })

  if (nodes.length === 0) return <div className="empty">⌘D でピン留め</div>

  return (
    <div
      className="pins"
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => {
        // 空きスペースに落としたら最上位の末尾へ
        if (dragId) void window.nemo.movePinned(dragId, null, nodes.length)
        setDragId(null)
        setDropHint(null)
      }}
    >
      {render(nodes, null, 0)}
    </div>
  )
}
