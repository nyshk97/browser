import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Overlay } from './components/Overlay.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

/**
 * ブラウザ UI は 2 つの WebContentsView に分かれている（DESIGN.md「オーバーレイ」）。
 * どちらを描くかは main が付けたクエリで決める。
 */
const view = new URLSearchParams(location.search).get('view')
document.body.dataset['view'] = view ?? 'sidebar'

createRoot(root).render(<StrictMode>{view === 'overlay' ? <Overlay /> : <Sidebar />}</StrictMode>)
