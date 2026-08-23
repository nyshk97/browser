import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoadedExtensionInfo, NemoUiApi, WindowState } from '../shared/types.js'

declare global {
  interface Window {
    nemo: NemoUiApi
  }
}

const PAGE_PARTITION = 'persist:nemo'

export function App(): React.JSX.Element {
  const [state, setState] = useState<WindowState | null>(null)
  const [extensions, setExtensions] = useState<LoadedExtensionInfo[]>([])
  const [address, setAddress] = useState('')
  const [swMessage, setSwMessage] = useState<string | null>(null)
  const addressEditing = useRef(false)

  useEffect(() => {
    void window.nemo.getWindowState().then(setState)
    void window.nemo.getExtensions().then(setExtensions)
    return window.nemo.onWindowState(setState)
  }, [])

  const activeTab = useMemo(
    () => state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state]
  )

  useEffect(() => {
    if (!addressEditing.current) setAddress(activeTab?.url ?? '')
  }, [activeTab?.id, activeTab?.url])

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      if (!activeTab) return
      addressEditing.current = false
      void window.nemo.navigate(activeTab.id, address).catch((error: unknown) => {
        console.error(error)
      })
    },
    [activeTab, address]
  )

  return (
    <div className="chrome">
      <div className="toolbar">
        <div className="nav">
          <button
            type="button"
            disabled={!activeTab?.canGoBack}
            onClick={() => activeTab && void window.nemo.goBack(activeTab.id)}
            title="戻る"
          >
            ‹
          </button>
          <button
            type="button"
            disabled={!activeTab?.canGoForward}
            onClick={() => activeTab && void window.nemo.goForward(activeTab.id)}
            title="進む"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() =>
              activeTab &&
              void (activeTab.loading
                ? window.nemo.stop(activeTab.id)
                : window.nemo.reload(activeTab.id))
            }
            title={activeTab?.loading ? '停止' : '再読み込み'}
          >
            {activeTab?.loading ? '×' : '⟳'}
          </button>
        </div>

        <form className="address" onSubmit={submit}>
          <input
            value={address}
            spellCheck={false}
            placeholder="URL または検索語"
            onChange={(event) => {
              addressEditing.current = true
              setAddress(event.target.value)
            }}
            onBlur={() => {
              addressEditing.current = false
              setAddress(activeTab?.url ?? '')
            }}
          />
        </form>

        {/* 仮のツールバー: 拡張の browser action アイコンと popup */}
        <browser-action-list partition={PAGE_PARTITION} alignment="bottom right" />

        <div className="tools">
          <button type="button" onClick={() => void window.nemo.createWindow()} title="新規ウィンドウ">
            ⧉
          </button>
          <button
            type="button"
            onClick={() => activeTab && void window.nemo.toggleDevTools(activeTab.id)}
            title="DevTools"
          >
            {'</>'}
          </button>
          <button
            type="button"
            title="service worker を起動し直す"
            onClick={() => {
              void window.nemo.restartServiceWorkers().then((count) => {
                setSwMessage(`SW restarted: ${count}`)
                setTimeout(() => setSwMessage(null), 2000)
              })
            }}
          >
            ↺SW
          </button>
        </div>
      </div>

      <div className="tabstrip">
        {state?.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === state.activeTabId ? ' active' : ''}`}
            onClick={() => void window.nemo.selectTab(tab.id)}
          >
            <span className="title">{tab.loading ? '… ' : ''}{tab.title}</span>
            <button
              type="button"
              className="close"
              onClick={(event) => {
                event.stopPropagation()
                void window.nemo.closeTab(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="newtab" onClick={() => void window.nemo.createTab()}>
          ＋
        </button>
        <div className="status">
          {swMessage ??
            (extensions.length === 0
              ? '拡張なし（pnpm ext:fetch）'
              : extensions
                  .map((ext) => `${ext.name} ${ext.version}${ext.matchesLock ? '' : ' ⚠lock不一致'}`)
                  .join(' / '))}
        </div>
      </div>
    </div>
  )
}
