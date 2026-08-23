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
  const [state, setState] = useState<SharedState>({ favorites: [], pinned: [], downloads: [] })
  useEffect(() => {
    void window.nemo.getSharedState().then(setState)
    return window.nemo.onSharedState(setState)
  }, [])
  return state
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
