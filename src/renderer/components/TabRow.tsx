import { Favicon } from './Sidebar.js'
import type { TabState } from '../../shared/types.js'

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
  const classes = ['row']
  if (active) classes.push('active')
  if (tab.asleep) classes.push('asleep')
  if (tab.crashed) classes.push('crashed')

  return (
    <div
      className={classes.join(' ')}
      style={indent ? { marginLeft: indent * 14 } : undefined}
      title={tab.title}
      onClick={() => (onClick ? onClick() : void window.nemo.selectTab(tab.key))}
      onAuxClick={(event) => {
        // ミドルクリックで閉じる
        if (event.button === 1) (onClose ?? (() => void window.nemo.closeTab(tab.key)))()
      }}
    >
      {tab.loading ? (
        <span className="spin" />
      ) : (
        <Favicon url={tab.url} title={tab.title} src={tab.faviconUrl} />
      )}
      <span className="tt">{label ?? tab.title}</span>
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
          if (onClose) onClose()
          else void window.nemo.closeTab(tab.key)
        }}
      >
        ×
      </button>
    </div>
  )
}
