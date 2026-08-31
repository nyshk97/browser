import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { getTimings } from '../timings.js'
import { log } from '../log.js'
import { addEphemeralTab, flushEphemeralTabs } from './ephemeral-tabs.js'

/**
 * セッション復元。
 *
 * 「正常終了後」も「クラッシュ後」も同じ経路で復元する。
 * そのために**定期的に書く**（終了時にだけ書くとクラッシュで丸ごと失う）。
 * `cleanExit` は復元の可否ではなく、UI に「前回は異常終了した」と出すためだけに使う。
 *
 * 版 5 から野良タブの正は共有定義ストア（`ephemeral-tabs.json`）にあり、
 * ここに残るのはウィンドウごとの bounds・アクティブ定義・分割の組だけ。
 */

export type { SavedTab, SavedWindow, SessionData } from '../../shared/settings-schema.js'
import {
  SESSION_VERSION,
  normalizeSession,
  type LegacySavedWindow,
  type SavedWindow,
  type SessionData
} from '../../shared/settings-schema.js'

let store: JsonStore<SessionData> | null = null
/** 起動時に読んだ内容（復元に使う）。以降の保存で上書きされないよう別に持つ。 */
let restored: SessionData = { windows: [], cleanExit: true, savedAt: 0, legacyWindows: null }

/**
 * **`initEphemeralTabs()` の後・ウィンドウ復元の前**に呼ぶこと。
 * 旧版（版 4 以前）のセッションを読んだら、この場で共有ストアへ移行する。
 * 復元より後だと初回起動でサイドバーが空のまま立ち上がり、その状態が保存される。
 */
export function initSession(): SessionData {
  // 起動直後に「前回の状態」を確定させたいのでデバウンスは短め（`JsonStore` の既定 400 ではない）。
  // **2 段あるデバウンスの 2 段目**（1 段目は `registry.ts` の `scheduleSessionSave`）。
  store = new JsonStore<SessionData>(
    userDataPath('session.json'),
    SESSION_VERSION,
    normalizeSession,
    getTimings().sessionStoreDebounceMs
  )
  restored = store.get()

  /*
   * 旧版からの一度きりの移行。冪等判定は **`legacyWindows` の有無**
   * （旧版を読んだときだけ `normalizeSession` が付ける。`JsonStore` は normalize に
   * 版番号を渡さない契約なので、版番号では判定できない）。
   * 移行を終えたら**その場で `saveNow()` で確定させる** —— デバウンス保存任せだと
   * 移行直後に落ちたとき次回起動で再移行になり、定義が二重登録される。
   */
  if (restored.legacyWindows) {
    const windows = migrateLegacyWindows(restored.legacyWindows)
    flushEphemeralTabs()
    const migrated: SessionData = {
      windows,
      cleanExit: restored.cleanExit,
      savedAt: restored.savedAt,
      legacyWindows: null
    }
    store.set(migrated)
    store.saveNow()
    log('session.migrated', {
      windows: windows.length,
      tabs: restored.legacyWindows.reduce((n, win) => n + win.tabs.length, 0)
    })
    restored = migrated
  }

  // 起動した瞬間に cleanExit を落とす。ここで落とさないと、
  // クラッシュしたのに「正常終了だった」と記録が残る。
  store.update((current) => ({ ...current, cleanExit: false }))
  return restored
}

/**
 * 版 4 以前のウィンドウを共有ストアへ移す。
 *
 * 全ウィンドウの野良タブを**出現順に**定義化する（重複 URL もそのまま。
 * タブは URL の実体なので重複排除しない）。`lastActiveAt` もそのまま持ち込み、
 * 移行直後の行数の伸びは定義基準の自動アーカイブに素直に任せる（間引きは書かない）。
 */
function migrateLegacyWindows(legacy: LegacySavedWindow[]): SavedWindow[] {
  return legacy.map((win) => {
    const defIds = win.tabs.map(
      (tab) =>
        addEphemeralTab({
          url: tab.url,
          title: tab.title,
          customTitle: tab.customTitle,
          lastActiveAt: tab.lastActiveAt
        })?.id ?? null
    )
    const activeEphemeralId = defIds[win.activeIndex] ?? defIds.find((id) => id !== null) ?? null
    const splits = win.splits.flatMap(([leftIndex, rightIndex]): [string, string][] => {
      const left = defIds[leftIndex]
      const right = defIds[rightIndex]
      return left && right ? [[left, right]] : []
    })
    return { bounds: win.bounds, activeEphemeralId, splits }
  })
}

export function getRestoredSession(): SessionData {
  return restored
}

export function saveSession(windows: SavedWindow[]): void {
  store?.set({ windows, cleanExit: false, savedAt: Date.now(), legacyWindows: null })
}

/** 正常終了。`cleanExit` を立てて即座に書き切る。 */
export function markCleanExit(windows: SavedWindow[]): void {
  store?.set({ windows, cleanExit: true, savedAt: Date.now(), legacyWindows: null })
  store?.saveNow()
}

export function closeSession(): void {
  store?.close()
  store = null
}
