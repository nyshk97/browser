import { Fragment, useCallback, useState } from 'react'
import { DefinitionIcon } from './Sidebar.js'
import { IconEdit } from './IconEdit.js'
import { InlineRename, useDelayedClick } from './InlineRename.js'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import { TAB_DRAG_TYPE, useDragEnd } from './TabRow.js'
import type { PinnedNode, TabState } from '../../shared/types.js'

/** 掴んでいるのがタブ行か（ピン留め同士の並べ替えと区別する）。 */
function isTabDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(TAB_DRAG_TYPE)
}

/**
 * フォルダのアイコン（Arc のサイドバーに寄せたフラットな塗り）。
 *
 * **開いているか閉じているかを形そのもので示す**ので、左のキャレット（▶）は置かない。
 * 絵文字（📁）だとプラットフォームの絵文字フォントに引きずられて質感が揃わないため、
 * パスを持つ。色はトークン（`--nemo-folder`）で CSS 側から与える。
 */
const FOLDER_CLOSED =
  'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'
const FOLDER_OPEN =
  'M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.2c.4 0 .8.1 1.1.4L12 6h8a2 2 0 0 1 2 2H4v10l2.4-8h17.1l-2.6 8.6c-.2.6-.7 1-1.3 1.4H4z'

function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className="fi folder-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={open ? FOLDER_OPEN : FOLDER_CLOSED} />
    </svg>
  )
}

/** 表示名。ユーザーが付けた名前があればそれ、無ければ既定名。 */
function displayName(node: { title: string; customTitle: string | null }): string {
  return node.customTitle ?? node.title
}

/**
 * ピン留めのツリー（フォルダは1階層まで）。
 *
 * 「定義」を描く。開いているタブがあれば、その状態（読み込み中・音）を重ねて出す。
 * ピン留めタブを閉じても定義は残るので、行そのものは消えない（Arc の挙動）。
 *
 * 落とせるものは2種類ある。ピン留め同士の並べ替えと、下の一時タブからの移動
 * （= その場でピン留めして、落とした位置に置く）。
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [iconEditingId, setIconEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const { schedule, cancel } = useDelayedClick()

  // タブ行を掴んだドラッグは、こちらの行では `dragend` を受け取れない
  useDragEnd(
    useCallback(() => {
      setDragId(null)
      setDropHint(null)
    }, [])
  )

  /** 掴んでいるのがフォルダか（フォルダは root 直下にしか無いので、最上位だけ見ればよい）。 */
  const draggingFolder = (event: React.DragEvent): boolean =>
    !isTabDrag(event) && nodes.some((node) => node.id === dragId && node.kind === 'folder')

  /**
   * その行に落とせるか。**ドロップ線を出すかどうかと、実際に落とすかどうかで同じ判定を使う**
   * （分けると「線は出るのに何も起きない」ができる）。
   *
   * フォルダはフォルダの**中**へは入れられない（1階層）。行がフォルダのときだけでなく、
   * **フォルダの中のリンク行**（落とすとそのフォルダの中に入る）も弾く必要がある。
   */
  const canDrop = (event: React.DragEvent, node: PinnedNode, parentId: string | null): boolean => {
    if (isTabDrag(event)) return true
    if (!dragId || dragId === node.id) return false
    if (!draggingFolder(event)) return true
    return node.kind !== 'folder' && parentId === null
  }

  /** 落とされたものを、指定の位置に置く。タブならピン留めしてから動かす。 */
  const drop = (event: React.DragEvent, parentId: string | null, index: number): void => {
    const tabKey = event.dataTransfer.getData(TAB_DRAG_TYPE)
    if (tabKey) {
      void window.nemo.pinTabAt(tabKey, parentId, index)
      return
    }
    if (dragId) void window.nemo.movePinned(dragId, parentId, index)
  }

  const openMenu = (event: React.MouseEvent, id: string, items: RowMenuState['items']): void => {
    event.preventDefault()
    event.stopPropagation()
    cancel()
    setMenu({ id, x: event.clientX, y: event.clientY, items })
  }

  const rename = (id: string) => (title: string | null) => {
    setEditingId(null)
    void window.nemo.renameNode(id, title)
  }

  const render = (list: PinnedNode[], parentId: string | null, depth: number): React.JSX.Element[] =>
    list.map((node, index) => {
      const tab = tabs.get(node.id) ?? null
      const isOpen = openIds.has(node.id)
      const editing = editingId === node.id
      const name = displayName(node)
      const classes = ['row', node.kind === 'folder' ? 'folder' : 'pin']
      if (node.kind === 'folder' && !node.collapsed) classes.push('open')
      if (tab && tab.visible) classes.push('active')
      if (node.kind === 'link' && !isOpen) classes.push('closed')
      if (dropHint === node.id) classes.push('drop')

      const dragProps = {
        // 編集中はドラッグさせない（入力欄の中で文字を選べなくなる）
        draggable: !editing,
        onDragStart: (event: React.DragEvent) => {
          event.stopPropagation()
          setDragId(node.id)
        },
        onDragEnd: () => {
          setDragId(null)
          setDropHint(null)
        },
        onDragOver: (event: React.DragEvent) => {
          // 落とせない位置には線を出さない（main 側でも弾くが、UI 上で成功しそうに見せない）
          if (!canDrop(event, node, parentId)) return
          event.preventDefault()
          event.stopPropagation()
          setDropHint(node.id)
        },
        onDragLeave: () => setDropHint((current) => (current === node.id ? null : current)),
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          event.stopPropagation()
          setDropHint(null)
          if (!canDrop(event, node, parentId)) return
          // フォルダの上に落としたら中に入れる。リンクの上なら同じ階層のその位置へ。
          if (node.kind === 'folder') drop(event, node.id, 0)
          else drop(event, parentId, index)
          setDragId(null)
        }
      }

      /**
       * ダブルクリックで編集に入る。**待たせておいた単クリックは捨てる**。
       * **フォルダには付けない**（開閉と取り合いになるので、リネームは右クリックだけ）。
       */
      const onDoubleClick = (event: React.MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        cancel()
        setEditingId(node.id)
      }

      if (node.kind === 'folder') {
        return (
          <div key={node.id}>
            <div
              className={classes.join(' ')}
              style={depth ? { marginLeft: depth * 14 } : undefined}
              // フォルダの開閉は即時でよい（2回のクリックで開いて閉じ、元に戻る）
              onClick={() => {
                if (editing) return
                void window.nemo.toggleFolder(node.id)
              }}
              onContextMenu={(event) =>
                openMenu(event, node.id, [
                  { label: '名前を変更', run: () => setEditingId(node.id) },
                  { label: 'フォルダを削除', danger: true, run: () => void window.nemo.unpin(node.id) }
                ])
              }
              {...dragProps}
            >
              <FolderIcon open={!node.collapsed} />
              <InlineRename
                title={name}
                editing={editing}
                onSubmit={rename(node.id)}
                onCancel={() => setEditingId(null)}
              />
              <button
                type="button"
                className="x"
                title="フォルダを削除"
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
        <Fragment key={node.id}>
          <div
            className={classes.join(' ')}
            style={depth ? { marginLeft: depth * 14 } : undefined}
            title={name}
            // 自走検証がピン留め行を引くための手がかり（一時タブ行の `data-key` と同じ理由）。
            // ピン留め行はタブ key ではなく**定義の ID**で並ぶので、こちらを出す。
            data-pin={node.id}
            onClick={() => {
              if (editing) return
              // **閉じている行のクリックだけ**を遅らせる。ここを遅らせないと、
              // リネームしようとしただけでタブが生まれて読み込みが走る。
              // 既に開いている行の選択は即時（遅らせると通常操作が重くなるだけ）。
              if (isOpen) void window.nemo.openPinned(node.id)
              else schedule(() => void window.nemo.openPinned(node.id))
            }}
            onDoubleClick={onDoubleClick}
            onContextMenu={(event) =>
              openMenu(event, node.id, [
                // 名前とアイコンの編集は排他（両方開くとフォーカスを取り合う）
                {
                  label: '名前を変更',
                  run: () => {
                    setIconEditingId(null)
                    setEditingId(node.id)
                  }
                },
                {
                  label: 'アイコンを変更…',
                  run: () => {
                    setEditingId(null)
                    setIconEditingId(node.id)
                  }
                },
                // 「このページに更新」は**開いているときだけ**出す（閉じていたら対象タブが無い）
                ...(tab
                  ? [{ label: 'このページに更新', run: () => void window.nemo.updatePinnedUrl(tab.key) }]
                  : []),
                { label: 'ピン留めを解除', danger: true, run: () => void window.nemo.unpin(node.id) }
              ])
            }
            {...dragProps}
          >
            {tab?.loading ? (
              <span className="spin" />
            ) : (
              <DefinitionIcon
                url={node.url}
                title={name}
                customIcon={node.customIcon}
                src={tab?.faviconUrl ?? node.faviconUrl}
              />
            )}
            <InlineRename
              title={name}
              editing={editing}
              onSubmit={rename(node.id)}
              onCancel={() => setEditingId(null)}
            />
            {tab?.audible ? <span className="mark">♪</span> : null}
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
          {/* アイコン編集は行内に収まらないので、対象行の直下に枠を出す */}
          {iconEditingId === node.id ? (
            <div className="pin-icon-edit" style={depth ? { marginLeft: depth * 14 } : undefined}>
              <IconEdit
                url={node.url}
                title={name}
                current={node.customIcon}
                fallback={tab?.faviconUrl ?? node.faviconUrl}
                onSubmit={(icon) => window.nemo.setCustomIcon(node.id, icon)}
                onClose={() => setIconEditingId(null)}
              />
            </div>
          ) : null}
        </Fragment>
      )
    })

  const rowMenu = menu ? <RowMenu state={menu} onClose={() => setMenu(null)} /> : null

  // 空のときも受け皿は要る（最初の1件はここへドラッグして作る）
  if (nodes.length === 0) {
    return (
      <>
        <div
          className={`empty droppable${dropHint === 'root' ? ' drop' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDropHint('root')
          }}
          onDragLeave={() => setDropHint(null)}
          onDrop={(event) => {
            event.preventDefault()
            setDropHint(null)
            drop(event, null, 0)
            setDragId(null)
          }}
        >
          ⌘D かドラッグでピン留め
        </div>
        {rowMenu}
      </>
    )
  }

  return (
    <>
      <div
        className="pins"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          // 空きスペースに落としたら最上位の末尾へ
          event.preventDefault()
          drop(event, null, nodes.length)
          setDragId(null)
          setDropHint(null)
        }}
      >
        {render(nodes, null, 0)}
      </div>
      {rowMenu}
    </>
  )
}
