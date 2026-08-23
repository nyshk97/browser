import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { isRecord, normalizeStoredUrl } from '../../shared/settings-schema.js'

/**
 * セッション復元。
 *
 * 「正常終了後」も「クラッシュ後」も同じ経路で復元する。
 * そのために**定期的に書く**（終了時にだけ書くとクラッシュで丸ごと失う）。
 * `cleanExit` は復元の可否ではなく、UI に「前回は異常終了した」と出すためだけに使う。
 */

const SESSION_VERSION = 1

export interface SavedTab {
  url: string
  title: string
  pinnedId: string | null
}

export interface SavedWindow {
  bounds: { x: number; y: number; width: number; height: number } | null
  tabs: SavedTab[]
  activeIndex: number
}

export interface SessionData {
  windows: SavedWindow[]
  cleanExit: boolean
  savedAt: number
}

function normalize(raw: unknown): SessionData {
  const input = isRecord(raw) ? raw : {}
  const windows = Array.isArray(input['windows'])
    ? input['windows'].flatMap((value) => {
        if (!isRecord(value)) return []
        const tabs = Array.isArray(value['tabs'])
          ? value['tabs'].flatMap((tab) => {
              if (!isRecord(tab)) return []
              const url = normalizeStoredUrl(tab['url'])
              if (!url) return []
              return [
                {
                  url,
                  title: typeof tab['title'] === 'string' ? tab['title'].slice(0, 300) : '',
                  pinnedId: typeof tab['pinnedId'] === 'string' ? tab['pinnedId'] : null
                }
              ]
            })
          : []
        if (tabs.length === 0) return []
        const activeIndex =
          typeof value['activeIndex'] === 'number' && Number.isInteger(value['activeIndex'])
            ? Math.min(Math.max(value['activeIndex'], 0), tabs.length - 1)
            : 0
        return [{ bounds: normalizeBounds(value['bounds']), tabs, activeIndex }]
      })
    : []
  return {
    windows,
    cleanExit: input['cleanExit'] === true,
    savedAt: typeof input['savedAt'] === 'number' ? input['savedAt'] : 0
  }
}

function normalizeBounds(raw: unknown): SavedWindow['bounds'] {
  if (!isRecord(raw)) return null
  const values = ['x', 'y', 'width', 'height'].map((key) => raw[key])
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [x, y, width, height] = values as number[]
  if (width < 200 || height < 200) return null
  return { x, y, width, height }
}

let store: JsonStore<SessionData> | null = null
/** 起動時に読んだ内容（復元に使う）。以降の保存で上書きされないよう別に持つ。 */
let restored: SessionData = { windows: [], cleanExit: true, savedAt: 0 }

export function initSession(): SessionData {
  // 起動直後に「前回の状態」を確定させたいのでデバウンスは短め
  store = new JsonStore<SessionData>(userDataPath('session.json'), SESSION_VERSION, normalize, 1000)
  restored = store.get()
  // 起動した瞬間に cleanExit を落とす。ここで落とさないと、
  // クラッシュしたのに「正常終了だった」と記録が残る。
  store.update((current) => ({ ...current, cleanExit: false }))
  return restored
}

export function getRestoredSession(): SessionData {
  return restored
}

export function saveSession(windows: SavedWindow[]): void {
  store?.set({ windows, cleanExit: false, savedAt: Date.now() })
}

/** 正常終了。`cleanExit` を立てて即座に書き切る。 */
export function markCleanExit(windows: SavedWindow[]): void {
  store?.set({ windows, cleanExit: true, savedAt: Date.now() })
  store?.saveNow()
}

export function closeSession(): void {
  store?.close()
  store = null
}
