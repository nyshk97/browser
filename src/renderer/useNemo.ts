import { useEffect, useState } from 'react'
import type { NemoUiApi, SharedState, TabState, WindowState } from '../shared/types.js'

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
    extensions: [],
    ephemeralTabs: null
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

/**
 * アクティブタブの Peek（表示待ちも含む）。無ければ null。
 *
 * Peek の暗幕・プレースホルダー（`Peek.tsx`）はこちらを使う
 * （awaiting 中も「窓の形」を描く必要がある）。
 */
export function peekTab(state: WindowState | null): TabState | null {
  return state?.tabs.find((tab) => tab.peekParentKey === state.activeTabKey) ?? null
}

/**
 * 前面のタブ（= ユーザーが「今見ているページ」）。**表示中の Peek 優先**。
 *
 * ⌘L・copy-url・find など「いま見えているページへの操作」はこちらを対象にする。
 * main 側の `NemoWindow.getForegroundTab()` と同じ意味（あちらは
 * `peekAwaitingDocument`、こちらは push 済みの `visible` で判定する）。
 */
export function foregroundTab(state: WindowState | null): TabState | null {
  const peek = peekTab(state)
  if (peek?.visible) return peek
  return state?.tabs.find((tab) => tab.key === state.activeTabKey) ?? null
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
