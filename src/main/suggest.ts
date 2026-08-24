import { getFavorites, getPinned } from './store/pins.js'
import { searchHistory } from './store/history.js'
import { normalizeNavigationInput } from './security.js'
import { getSettings } from './store/settings.js'
import { tabDisplayName } from './registry.js'
import type { NemoWindow } from './registry.js'
import type { PinnedNode, Suggestion } from '../shared/types.js'

/**
 * コマンドバーの候補（計画 1-5）。
 *
 * 「URL を開く / 検索する / 開いているタブへ切り替える」を1つの入力欄で扱う。
 * 候補の順番は固定にする（入力のたびに並びが変わると、目で追って選べない）:
 *   1. 開いているタブ
 *   2. ピン留め
 *   3. Favorites
 *   4. 履歴
 *   5. そのまま開く / 検索する
 */

const LIMIT_PER_KIND = 4

/** 表示名。ユーザーが付けた名前があればそちらで引けないと意味が無い。 */
function displayName(node: { title: string; customTitle: string | null }): string {
  return node.customTitle ?? node.title
}

function flattenPinned(nodes: PinnedNode[], prefix = ''): { title: string; url: string }[] {
  return nodes.flatMap((node) =>
    node.kind === 'folder'
      ? flattenPinned(node.children, `${prefix}${displayName(node)} / `)
      : [{ title: `${prefix}${displayName(node)}`, url: node.url }]
  )
}

function matches(query: string, ...fields: string[]): boolean {
  const needle = query.toLowerCase()
  return fields.some((field) => field.toLowerCase().includes(needle))
}

export function suggest(win: NemoWindow, rawQuery: string): Suggestion[] {
  const query = rawQuery.trim()
  const results: Suggestion[] = []

  if (query) {
    for (const tab of win.tabs.slice(0, 200)) {
      // 専用タブの名前は**定義側が正**。タブの `customTitle` を直接見ると、
      // リネーム後も古い名前で引っかかり、新しい名前では候補に出ない。
      const label = tabDisplayName(tab)
      if (!matches(query, label, tab.url)) continue
      results.push({
        kind: 'tab',
        title: label,
        subtitle: tab.url,
        target: { type: 'select-tab', key: tab.key }
      })
      if (results.length >= LIMIT_PER_KIND) break
    }

    let count = 0
    for (const pin of flattenPinned(getPinned())) {
      if (!matches(query, pin.title, pin.url)) continue
      results.push({
        kind: 'pinned',
        title: pin.title,
        subtitle: pin.url,
        target: { type: 'navigate', url: pin.url }
      })
      if (++count >= LIMIT_PER_KIND) break
    }

    count = 0
    for (const favorite of getFavorites()) {
      const label = displayName(favorite)
      if (!matches(query, label, favorite.url)) continue
      results.push({
        kind: 'favorite',
        title: label,
        subtitle: favorite.url,
        target: { type: 'navigate', url: favorite.url }
      })
      if (++count >= LIMIT_PER_KIND) break
    }

    const seen = new Set(results.map((item) => item.subtitle))
    for (const page of searchHistory(query, LIMIT_PER_KIND * 2)) {
      if (seen.has(page.url)) continue
      seen.add(page.url)
      results.push({
        kind: 'history',
        title: page.title || page.url,
        subtitle: page.url,
        target: { type: 'navigate', url: page.url }
      })
      if (results.filter((item) => item.kind === 'history').length >= LIMIT_PER_KIND) break
    }
  }

  // 「そのまま実行」は常に1件出す（候補が無くても Enter で必ず何かが起きる）
  const decision = normalizeNavigationInput(query, getSettings().searchTemplate)
  if (query && decision.allowed) {
    const isSearch = decision.url.startsWith(getSettings().searchTemplate.split('{q}')[0])
    results.unshift({
      kind: isSearch ? 'search' : 'url',
      title: isSearch ? `“${query}” を検索` : query,
      subtitle: decision.url,
      target: { type: 'navigate', url: decision.url }
    })
  }

  return results.slice(0, 12)
}
