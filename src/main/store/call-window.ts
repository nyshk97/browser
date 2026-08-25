import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import {
  CALL_WINDOW_VERSION,
  normalizeCallWindow,
  type CallWindowData,
  type CallWindowPosition
} from '../../shared/settings-schema.js'

export type { CallWindowPosition } from '../../shared/settings-schema.js'

/**
 * 会議の小窓の位置。
 *
 * **サイズは保存しない**（固定なので覚える意味がない）。
 * 保存の契機はドラッグの**終了時**（`moved`）だけで、ドラッグ中に書き続けない。
 */
let store: JsonStore<CallWindowData> | null = null

export function initCallWindowStore(): void {
  store = new JsonStore<CallWindowData>(
    userDataPath('call-window.json'),
    CALL_WINDOW_VERSION,
    normalizeCallWindow
  )
}

export function getCallWindowPosition(): CallWindowPosition | null {
  return store?.get().position ?? null
}

export function saveCallWindowPosition(position: CallWindowPosition): void {
  store?.set({ position })
}

export function closeCallWindowStore(): void {
  store?.close()
  store = null
}
