import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { getTimings } from '../timings.js'

/**
 * セッション復元。
 *
 * 「正常終了後」も「クラッシュ後」も同じ経路で復元する。
 * そのために**定期的に書く**（終了時にだけ書くとクラッシュで丸ごと失う）。
 * `cleanExit` は復元の可否ではなく、UI に「前回は異常終了した」と出すためだけに使う。
 */

export type { SavedTab, SavedWindow, SessionData } from '../../shared/settings-schema.js'
import {
  SESSION_VERSION,
  normalizeSession,
  type SavedWindow,
  type SessionData
} from '../../shared/settings-schema.js'

let store: JsonStore<SessionData> | null = null
/** 起動時に読んだ内容（復元に使う）。以降の保存で上書きされないよう別に持つ。 */
let restored: SessionData = { windows: [], cleanExit: true, savedAt: 0 }

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
