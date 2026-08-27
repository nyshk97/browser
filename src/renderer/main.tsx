import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Toolbar } from './components/Toolbar.js'
import { Overlay } from './components/Overlay.js'
import { EmptyState } from './components/EmptyState.js'
import { Peek } from './components/Peek.js'
import { MiniBar } from './components/MiniBar.js'
import { CallBar } from './components/CallBar.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

/**
 * ブラウザ UI は複数の WebContentsView に分かれている（DESIGN.md「オーバーレイ」）。
 * どれを描くかは main が付けたクエリで決める。
 *
 * - `sidebar` … 常時表示のサイドバー
 * - `toolbar` … ページ領域の上端のアドレスバー（通常ウィンドウのみ）
 * - `overlay` … コマンドバー・検索バー・ダイアログ（必要なときだけ）
 * - `peek` … Peek の暗幕と ✕ / ⌘O（Peek が出ているときだけ）
 * - `empty` … タブが 1 つも無いときの画面（そのときだけ）
 * - `mini` … 小窓の上部バー
 * - `call` … 会議の小窓（他アプリの上に浮くバー。**ウィンドウの中身がこれ1枚だけ**）
 */
const params = new URLSearchParams(location.search)
const view = params.get('view')
/** 分割ビューでどちらのペインを担当するか（`toolbar` のときだけ意味を持つ）。 */
const pane = params.get('pane') === 'right' ? 'right' : 'left'
document.body.dataset['view'] = view ?? 'sidebar'
document.body.dataset['pane'] = pane

function Root(): React.JSX.Element | null {
  if (view === 'toolbar') return <Toolbar pane={pane} />
  if (view === 'overlay') return <Overlay />
  if (view === 'peek') return <Peek />
  if (view === 'empty') return <EmptyState />
  if (view === 'mini') return <MiniBar />
  if (view === 'call') return <CallBar />
  return <Sidebar />
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
