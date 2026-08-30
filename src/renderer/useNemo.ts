import { useEffect, useState } from 'react'
import type { NemoUiApi, SharedState, WindowState } from '../shared/types.js'

declare global {
  interface Window {
    nemo: NemoUiApi
  }
}

/** main から push される window の状態。 */
export function useWindowState(): WindowState | null {
  const [state, setState] = useState<WindowState | null>(null)
  useEffect(() => {
    void window.nemo.getWindowState().then(setState)
    return window.nemo.onWindowState(setState)
  }, [])
  return state
}

/** 全ウィンドウ共有の定義（Favorites / ピン留め / ダウンロード）。 */
export function useSharedState(): SharedState {
  const [state, setState] = useState<SharedState>({
    favorites: [],
    pinned: [],
    downloads: [],
    version: '',
    update: { status: 'idle', version: null, percent: null, error: null },
    liveFolder: null,
    extensions: []
  })
  useEffect(() => {
    void window.nemo.getSharedState().then(setState)
    return window.nemo.onSharedState(setState)
  }, [])
  return state
}

/**
 * ⌘ を押し続けている間だけ true（Favorites のタイルに ⌘1〜9 の番号を重ねる）。
 * 判定は main（ページ側にフォーカスがあると renderer には keydown が来ない）。
 */
export function useShortcutHint(): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => window.nemo.onShortcutHint(setVisible), [])
  return visible
}

/** main のメニューから飛んでくるコマンド。 */
export function useCommand(handler: (command: string) => void): void {
  useEffect(() => window.nemo.onCommand(handler))
}

/** URL を人が読む形にする（scheme と末尾スラッシュを落とす）。 */
export function prettyUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search}`
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
