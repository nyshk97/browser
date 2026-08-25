import { shell, systemPreferences } from 'electron'
import { log, logError } from './log.js'

/**
 * macOS のメディア権限（TCC）。
 *
 * **Nemo が permission を許可しても、それだけではページに音も映像も渡らない。**
 * Electron のアプリでは Chromium が OS のダイアログを出してくれないので、
 * `systemPreferences.askForMediaAccess()` をアプリ側から呼ぶ必要がある。
 * これを呼ばないと TCC には項目すら現れず（＝ system settings にも出てこない）、
 * ページ側は「ブロックされています」のまま何もできない。
 */

export type MediaKind = 'microphone' | 'camera'

/** システム設定の該当ペインを開く URL。 */
const SETTINGS_URL: Record<MediaKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
}

/**
 * permission 要求から、OS 側に要る許可の種類を割り出す。
 * `media` は `mediaTypes` を見る（audio → マイク / video → カメラ）。
 */
export function mediaKindsFor(
  permission: string,
  details?: Electron.MediaAccessPermissionRequest
): MediaKind[] {
  if (permission === 'microphone') return ['microphone']
  if (permission === 'camera') return ['camera']
  if (permission !== 'media') return []
  const types = details?.mediaTypes ?? []
  const kinds: MediaKind[] = []
  if (types.includes('audio')) kinds.push('microphone')
  if (types.includes('video')) kinds.push('camera')
  return kinds
}

/**
 * permission **check** の details から OS 側に要る許可の種類を割り出す。
 *
 * `mediaKindsFor` と分けてあるのは、**check と request で details の形が違う**ため。
 * request は `mediaTypes`（配列）、check は `mediaType`（単数）で来る。
 * 同じ関数で受けようとすると check 側が常に空を返し、
 * **OS 側の拒否を見ているつもりのコードが何も見ていない**状態になる（実際にそうなっていた）。
 */
export function mediaCheckKinds(
  permission: string,
  details?: { mediaType?: 'video' | 'audio' | 'unknown' }
): MediaKind[] {
  if (permission === 'microphone') return ['microphone']
  if (permission === 'camera') return ['camera']
  if (permission !== 'media') return []
  if (details?.mediaType === 'audio') return ['microphone']
  if (details?.mediaType === 'video') return ['camera']
  return []
}

/** OS 側で拒否されているか（同期・ダイアログを出さない）。permission check 用。 */
export function isSystemMediaDenied(kind: MediaKind): boolean {
  if (process.platform !== 'darwin') return false
  const status = systemPreferences.getMediaAccessStatus(kind)
  return status === 'denied' || status === 'restricted'
}

/**
 * OS 側の許可を確かめる。まだ聞いていなければ **OS のダイアログを出して待つ**。
 * 拒否された種類だけを返す（空なら全部使える）。
 */
export async function ensureSystemMediaAccess(kinds: readonly MediaKind[]): Promise<MediaKind[]> {
  if (process.platform !== 'darwin') return []
  const denied: MediaKind[] = []
  for (const kind of kinds) {
    const status = systemPreferences.getMediaAccessStatus(kind)
    if (status === 'granted') continue
    if (status === 'not-determined') {
      let granted = false
      try {
        granted = await systemPreferences.askForMediaAccess(kind)
      } catch (error) {
        logError('media.os_access_failed', error, { kind })
      }
      log('media.os_access', { kind, status, granted })
      if (!granted) denied.push(kind)
      continue
    }
    log('media.os_access', { kind, status, granted: false })
    denied.push(kind)
  }
  return denied
}

/** システム設定の該当ペインを開く。 */
export function openMediaSettings(kind: MediaKind): void {
  void shell.openExternal(SETTINGS_URL[kind]).catch((error: unknown) => {
    logError('media.settings_open_failed', error, { kind })
  })
}
