import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, normalizeSettings } from '../../shared/settings-schema.js'
import { resolveKeybindings } from '../../shared/keybindings.js'
import type { NemoSettings } from '../../shared/types.js'

let store: JsonStore<NemoSettings> | null = null
const listeners = new Set<(settings: NemoSettings) => void>()

export function initSettings(): void {
  store = new JsonStore<NemoSettings>(userDataPath('settings.json'), SETTINGS_VERSION, normalizeSettings)
  const { problems } = resolveKeybindings(store.get().keybindings)
  for (const problem of problems) {
    // 「設定したのに効かない」を黙って起こさない
    log('keybinding.rejected', problem)
  }
}

export function getSettings(): NemoSettings {
  return store?.get() ?? DEFAULT_SETTINGS
}

export function updateSettings(patch: Partial<NemoSettings>): NemoSettings {
  if (!store) return DEFAULT_SETTINGS
  const next = store.update((current) => normalizeSettings({ ...current, ...patch }))
  for (const listener of listeners) listener(next)
  return next
}

export function onSettingsChanged(listener: (settings: NemoSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function closeSettings(): void {
  store?.close()
  store = null
}
