import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Overlay } from './components/Overlay.js'
import { Peek } from './components/Peek.js'
import { MiniBar } from './components/MiniBar.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

/**
 * ブラウザ UI は複数の WebContentsView に分かれている（DESIGN.md「オーバーレイ」）。
 * どれを描くかは main が付けたクエリで決める。
 *
 * - `sidebar` … 常時表示のサイドバー
 * - `overlay` … コマンドバー・検索バー・ダイアログ（必要なときだけ）
 * - `peek` … Peek の暗幕と ✕ / ⌘O（Peek が出ているときだけ）
 * - `mini` … 小窓の上部バー
 */
const view = new URLSearchParams(location.search).get('view')
document.body.dataset['view'] = view ?? 'sidebar'

function Root(): React.JSX.Element | null {
  if (view === 'overlay') return <Overlay />
  if (view === 'peek') return <Peek />
  if (view === 'mini') return <MiniBar />
  return <Sidebar />
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
