import { useEffect, useRef } from 'react'

/**
 * サイドバーの行のコンテキストメニュー。
 *
 * Electron の `Menu.popup` を使わずに DOM で描く。サイドバーは
 * 独立した WebContentsView なので、ここで完結させた方が
 * 自走検証（`contextmenu` を dispatch して項目を押す）まで機械的に通せる。
 *
 * 右クリックで**即座に破壊的な操作をしない**（今までの Favorites は
 * 右クリックでいきなり削除だった）のもこのメニューに寄せる狙い。
 */

export interface RowMenuItem {
  label: string
  run: () => void
  /** 破壊的な項目（色を変える）。 */
  danger?: boolean
  /**
   * 押せない項目。
   * **「押せるのに何も起きない」を作らないため**に出し分けではなく disabled にする
   * （`rate-limit` 中の「いま更新する」など。項目ごと消すと、末尾の状態行と挙動が食い違う）。
   */
  disabled?: boolean
}

export interface RowMenuState {
  /** どの行のメニューか（行側が自分のものか判別するのに使う）。 */
  id: string
  x: number
  y: number
  items: RowMenuItem[]
}

export function RowMenu({ state, onClose }: { state: RowMenuState; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: Event): void => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    // capture で拾う。行側の onClick より先に閉じたい
    window.addEventListener('mousedown', close, true)
    window.addEventListener('contextmenu', close, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // サイドバーは狭いので、右端・下端からはみ出さない位置に寄せる
  const left = Math.min(state.x, Math.max(window.innerWidth - 176, 4))
  const top = Math.min(state.y, Math.max(window.innerHeight - (state.items.length * 26 + 12), 4))

  return (
    <div ref={ref} className="row-menu" style={{ left, top }} role="menu">
      {state.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled === true}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
