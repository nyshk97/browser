import { useState } from 'react'
import { prettyUrl, useWindowState } from '../useNemo.js'

/**
 * 小窓（Little Nemo）の上部バー（DESIGN.md「小窓」）。
 *
 * 並びは 戻る / 進む / リロード → URL（**表示のみ**・クリックでコピー）→ ⌘O。
 * ✕ は信号機の赤で兼ねるので置かない。
 *
 * **アドレスバーは持たない**（⌘L も効かない）。小窓は「今踏んだ URL をざっと見る」
 * ためのもので、ここで別のページへ行きたくなったらタブに昇格させる、という分け方。
 */
export function MiniBar(): React.JSX.Element {
  const state = useWindowState()
  const tab = state?.tabs[0] ?? null
  const [copied, setCopied] = useState(false)

  const copyUrl = (): void => {
    if (!tab) return
    void window.nemo.copyUrl(tab.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="mini-bar">
      {/* 信号機ボタンぶんの掴みしろ。ここを掴んで小窓を動かせる */}
      <div className="mini-drag" />
      <button
        type="button"
        className="icon nav"
        title="戻る"
        disabled={!tab?.canGoBack}
        onClick={() => tab && void window.nemo.goBack(tab.key)}
      >
        ‹
      </button>
      <button
        type="button"
        className="icon nav"
        title="進む"
        disabled={!tab?.canGoForward}
        onClick={() => tab && void window.nemo.goForward(tab.key)}
      >
        ›
      </button>
      <button
        type="button"
        className="icon nav"
        title={tab?.loading ? '停止' : '再読み込み'}
        disabled={!tab}
        onClick={() => tab && void (tab.loading ? window.nemo.stop(tab.key) : window.nemo.reload(tab.key))}
      >
        {tab?.loading ? '×' : '⟳'}
      </button>
      <button type="button" className="mini-url" title="URL をコピー" onClick={copyUrl}>
        {copied ? 'コピーした' : prettyUrl(tab?.url ?? '') || '読み込み中…'}
      </button>
      <button
        type="button"
        className="mini-open"
        title="メインウィンドウのタブで開く（⌘O）"
        onClick={() => void window.nemo.promoteForegroundView()}
      >
        ⌘O
      </button>
    </div>
  )
}
