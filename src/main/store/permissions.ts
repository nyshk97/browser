import { JsonStore } from './json-store.js'
import { userDataPath } from '../paths.js'
import { log } from '../log.js'
import { isRecord } from '../../shared/settings-schema.js'
import type { PermissionKind } from '../../shared/types.js'

/**
 * origin 単位の権限の記憶（「今後も許可する」を選んだときだけ書く）。
 * 未設定は「毎回聞く」であって「許可」ではない。
 *
 * **scope** を持つ。`null` は常用プロファイル（`permissions.json` に永続化）、
 * 文字列はシークレットセッションの partition 名で、**メモリ上だけ**に持つ。
 * シークレットで選んだ「今後も同じ扱い」が常用プロファイルに残ると、
 * *そのサイトをシークレットで開いただけ*なのに通常ウィンドウで自動許可されてしまう
 * （ダイアログの「今後も」は既定で ON なので、まず確実に踏む）。
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

/** シークレット用の揮発ストア（partition 名 → 記憶）。ディスクには一切書かない。 */
const volatileScopes = new Map<string, PermissionsData>()

/** その scope の記憶を読む。 */
function read(scope: string | null): PermissionsData | null {
  if (scope === null) return store?.get() ?? null
  return volatileScopes.get(scope) ?? null
}

export function initPermissionStore(): void {
  store = new JsonStore<PermissionsData>(userDataPath('permissions.json'), PERMISSIONS_VERSION, normalize)
}

export function getDecision(
  origin: string,
  permission: PermissionKind,
  scope: string | null = null
): Decision | null {
  return read(scope)?.origins[origin]?.[permission] ?? null
}

export function rememberDecision(
  origin: string,
  permission: PermissionKind,
  decision: Decision,
  scope: string | null = null
): void {
  if (scope !== null) {
    const current = volatileScopes.get(scope) ?? { origins: {}, externalSchemes: {} }
    volatileScopes.set(scope, {
      ...current,
      origins: { ...current.origins, [origin]: { ...current.origins[origin], [permission]: decision } }
    })
    // origin は伏せる（シークレットでどこを開いたかをログに残さない）
    log('permission.remembered', { permission, decision, scope: 'private' })
    return
  }
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

export function getSchemeDecision(scheme: string, scope: string | null = null): Decision | null {
  return read(scope)?.externalSchemes[scheme] ?? null
}

export function rememberScheme(scheme: string, decision: Decision, scope: string | null = null): void {
  if (scope !== null) {
    const current = volatileScopes.get(scope) ?? { origins: {}, externalSchemes: {} }
    volatileScopes.set(scope, {
      ...current,
      externalSchemes: { ...current.externalSchemes, [scheme]: decision }
    })
    log('external_protocol.remembered', { scheme, decision, scope: 'private' })
    return
  }
  if (!store) return
  store.update((current) => ({
    ...current,
    externalSchemes: { ...current.externalSchemes, [scheme]: decision }
  }))
  log('external_protocol.remembered', { scheme, decision })
}

/** シークレットが終わったら、その scope の記憶ごと捨てる。 */
export function forgetPermissionScope(scope: string): void {
  if (volatileScopes.delete(scope)) log('permission.scope_forgotten', { scope: 'private' })
}

export function closePermissionStore(): void {
  store?.close()
  store = null
  volatileScopes.clear()
}
