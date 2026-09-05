import { getFavorites, getPinned } from './store/pins.js'
import { getFavicons, searchHistory } from './store/history.js'
import { normalizeNavigationInput } from './security.js'
import { localPathToFileUrl } from './local-path.js'
import { getSettings } from './store/settings.js'
import { tabDisplayName } from './registry.js'
import type { NemoWindow } from './registry.js'
import { matchesAllTerms, splitTerms } from '../shared/query-terms.js'
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

export function suggest(win: NemoWindow, rawQuery: string): Suggestion[] {
  const query = rawQuery.trim()
  const results: Suggestion[] = []

  // 空白区切りの**全語 AND・順序不問**（「github nyshk97 mobil」で該当リポジトリが出る）。
  // 履歴（`searchHistory`）も同じ `splitTerms` で切る。
  const terms = splitTerms(query)
  const matches = (...fields: string[]): boolean => matchesAllTerms(terms, ...fields)

  if (query) {
    // Peek はコマンドバーの「開いているタブ」に出さない（一覧に無いものへ飛ばさない）
    for (const tab of win.normalTabs.slice(0, 200)) {
      // 専用タブの名前は**定義側が正**。タブの `customTitle` を直接見ると、
      // リネーム後も古い名前で引っかかり、新しい名前では候補に出ない。
      const label = tabDisplayName(tab)
      if (!matches(label, tab.url)) continue
      results.push({
        kind: 'tab',
        title: label,
        subtitle: tab.url,
        faviconUrl: tab.faviconUrl,
        target: { type: 'select-tab', key: tab.key }
      })
      if (results.length >= LIMIT_PER_KIND) break
    }

    let count = 0
    for (const pin of flattenPinned(getPinned())) {
      if (!matches(pin.title, pin.url)) continue
      results.push({
        kind: 'pinned',
        title: pin.title,
        subtitle: pin.url,
        faviconUrl: null,
        target: { type: 'navigate', url: pin.url }
      })
      if (++count >= LIMIT_PER_KIND) break
    }

    count = 0
    for (const favorite of getFavorites()) {
      const label = displayName(favorite)
      if (!matches(label, favorite.url)) continue
      results.push({
        kind: 'favorite',
        title: label,
        subtitle: favorite.url,
        faviconUrl: null,
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
        faviconUrl: page.favicon_url,
        target: { type: 'navigate', url: page.url }
      })
      if (results.filter((item) => item.kind === 'history').length >= LIMIT_PER_KIND) break
    }
  }

  // 「そのまま実行」は常に1件出す（候補が無くても Enter で必ず何かが起きる）。
  // コマンドバーは人間の入力が起点なので `file:` を通す（ローカルパスは `file://` に変換してから。
  // 行の `target.url` が `file://` になり、`nemo:navigate` 側の `resolveInput` がそのまま受ける）
  const decision = normalizeNavigationInput(
    localPathToFileUrl(query) ?? query,
    getSettings().searchTemplate,
    {
      allowFile: true
    }
  )
  if (query && decision.allowed) {
    const isSearch = decision.url.startsWith(getSettings().searchTemplate.split('{q}')[0])
    // タイトルは入力そのまま。「検索する / 開く」は選択行の右端のアクションが担う
    results.unshift({
      kind: isSearch ? 'search' : 'url',
      title: query,
      subtitle: decision.url,
      // 検索行は虫眼鏡（renderer が描く）。URL 直打ちは後段でアイコンを引く。
      faviconUrl: null,
      target: { type: 'navigate', url: decision.url }
    })
  }

  const trimmed = results.slice(0, 12)
  resolveFavicons(win, trimmed)
  return trimmed
}

/**
 * 行頭のアイコンを埋める。
 *
 * **候補を組み終わってから最後に1回だけ回す**。kind ごとに散らすと、
 * 先頭へ `unshift` する URL 候補が漏れる。
 *
 * 解決の順番:
 *   1. 開いているタブ … その `faviconUrl`（`suggest` の中で入れ済み）
 *   2. 履歴 … URL 完全一致で引いた `favicon_url`
 *   3. **同じホストで開いているタブ**から借りる
 *   4. 無ければ null（renderer がホスト頭文字のレターアバターに落とす）
 *
 * 3 は `favicon_url` 列を足した直後の移行期間を埋めるための措置。
 * 再訪問すれば 2 で埋まるので、**履歴をホストで引く経路は作らない**
 * （`pages` に host 列も index も無く、既定の LIKE は PK の index に乗らないので
 * 全履歴の走査になる。入力1文字ごとに走る場所で払うコストではない）。
 */
function resolveFavicons(win: NemoWindow, items: Suggestion[]): void {
  const pending = items.filter((item) => item.kind !== 'search' && !item.faviconUrl)
  if (pending.length === 0) return

  const fromHistory = getFavicons(pending.map((item) => item.subtitle))
  for (const item of pending) {
    item.faviconUrl = fromHistory.get(item.subtitle) ?? null
  }

  const stillEmpty = pending.filter((item) => !item.faviconUrl)
  if (stillEmpty.length === 0) return

  // ホスト → favicon は**このウィンドウのタブからだけ**作る。
  // 他のウィンドウを覗くと、シークレットウィンドウの favicon が通常の候補に漏れる。
  const byHost = new Map<string, string>()
  for (const tab of win.tabs) {
    if (!tab.faviconUrl) continue
    const host = hostOf(tab.url)
    if (host && !byHost.has(host)) byHost.set(host, tab.faviconUrl)
  }
  if (byHost.size === 0) return

  for (const item of stillEmpty) {
    const host = hostOf(item.subtitle)
    if (host) item.faviconUrl = byHost.get(host) ?? null
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}
