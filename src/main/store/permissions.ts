import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import { isRecord } from '../../shared/settings-schema.js'
import type { PermissionKind } from '../../shared/types.js'

/**
 * origin 単位の権限の記憶（「今後も許可する」を選んだときだけ書く）。
 * 未設定は「毎回聞く」であって「許可」ではない。
 */

export type Decision = 'allow' | 'deny'

interface PermissionsData {
  /** `https://example.com` → { geolocation: 'allow' } */
  origins: Record<string, Partial<Record<PermissionKind, Decision>>>
  /** 外部 protocol の allowlist（`mailto:` など。ユーザーが「今後も開く」を選んだもの）。 */
  externalSchemes: Record<string, Decision>
}

const PERMISSIONS_VERSION = 1

function normalize(raw: unknown): PermissionsData {
  const input = isRecord(raw) ? raw : {}
  const origins: PermissionsData['origins'] = {}
  if (isRecord(input['origins'])) {
    for (const [origin, value] of Object.entries(input['origins'])) {
      if (!/^https?:\/\/[^/]+$/.test(origin) || !isRecord(value)) continue
      const entry: Partial<Record<PermissionKind, Decision>> = {}
      for (const [permission, decision] of Object.entries(value)) {
        if (decision === 'allow' || decision === 'deny') {
          entry[permission as PermissionKind] = decision
        }
      }
      origins[origin] = entry
    }
  }
  const externalSchemes: Record<string, Decision> = {}
  if (isRecord(input['externalSchemes'])) {
    for (const [scheme, decision] of Object.entries(input['externalSchemes'])) {
      if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) continue
      if (decision === 'allow' || decision === 'deny') externalSchemes[scheme] = decision
    }
  }
  return { origins, externalSchemes }
}

let store: JsonStore<PermissionsData> | null = null

export function initPermissionStore(): void {
  store = new JsonStore<PermissionsData>(userDataPath('permissions.json'), PERMISSIONS_VERSION, normalize)
}

export function getDecision(origin: string, permission: PermissionKind): Decision | null {
  return store?.get().origins[origin]?.[permission] ?? null
}

export function rememberDecision(origin: string, permission: PermissionKind, decision: Decision): void {
  if (!store) return
  store.update((current) => ({
    ...current,
    origins: {
      ...current.origins,
      [origin]: { ...current.origins[origin], [permission]: decision }
    }
  }))
  log('permission.remembered', { origin, permission, decision })
}

export function getSchemeDecision(scheme: string): Decision | null {
  return store?.get().externalSchemes[scheme] ?? null
}

export function rememberScheme(scheme: string, decision: Decision): void {
  if (!store) return
  store.update((current) => ({
    ...current,
    externalSchemes: { ...current.externalSchemes, [scheme]: decision }
  }))
  log('external_protocol.remembered', { scheme, decision })
}

export function closePermissionStore(): void {
  store?.close()
  store = null
}
