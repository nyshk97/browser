import { randomUUID } from 'node:crypto'
import { JsonStore } from './json-store.js'
import { getSecretBackend } from './secret-backend.js'
import { userDataPath } from '../paths.js'
import { log, logError } from '../log.js'
import {
  HTTP_AUTH_LIMITS,
  normalizeRules,
  validateHttpAuthPattern,
  type ImportEntry,
  type StoredRule
} from '../../shared/http-auth-rules.js'
import type { HttpAuthRule } from '../../shared/types.js'

/**
 * HTTP Basic 認証の資格情報を置く専用ストア（`http-auth.json`）。
 *
 * **端末をまたいで持ち出さない。** `safeStorage` は端末鍵なので、
 * 暗号文を他端末へ配っても復号できない（`github-token.ts` と同じ理由）。
 * セーブスロット（ピン留め / お気に入り）にも含めない。
 *
 * 決めごと:
 * - `pattern` / `username` は平文、`password` だけ暗号化して持つ
 * - 端末鍵が使えなければ**保存を断る**（#13。平文では絶対に置かない）
 * - 復号に失敗したルールは**そのルールだけ無効化**して残りは生かす
 *   （PAT と違い 1 件壊れても他が使えるべき）
 * - `disabledReason` がある間は `enabled` に関わらず**実効無効**で、有効トグルも禁止する
 * - 一覧（`listHttpAuthRules`）は**パスワードを含まない**。値を返す口は
 *   `revealHttpAuthPassword`（1 件だけ）に分ける
 */

const HTTP_AUTH_VERSION = 1

interface HttpAuthData {
  rules: StoredRule[]
}

function normalize(raw: unknown): HttpAuthData {
  const rules = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['rules'] : undefined
  return { rules: normalizeRules(rules) }
}

let store: JsonStore<HttpAuthData> | null = null

function rules(): StoredRule[] {
  return store?.get().rules ?? []
}

/** 一覧・照合に使う形（**パスワードを含まない**）。 */
function toPublic(rule: StoredRule): HttpAuthRule {
  return {
    id: rule.id,
    pattern: rule.pattern,
    username: rule.username,
    enabled: rule.enabled,
    ...(rule.importedFrom === undefined ? {} : { importedFrom: rule.importedFrom }),
    ...(rule.disabledReason === undefined
      ? {}
      : { disabledReason: rule.disabledReason as HttpAuthRule['disabledReason'] })
  }
}

export function initHttpAuthStore(): void {
  store = new JsonStore<HttpAuthData>(userDataPath('http-auth.json'), HTTP_AUTH_VERSION, normalize)
  void validateStoredCredentials()
}

export function closeHttpAuthStore(): void {
  store?.close()
  store = null
}

/**
 * 起動時に 1 回、保存済みの暗号文が読めるかを確かめる。
 *
 * **まっさらな状態からの検証では一度も通らない経路**（別端末の暗号文・鍵の入れ替え・
 * ファイルの破損）をここで拾い、読めないルールだけ `decrypt-failed` で無効化する。
 * 端末鍵そのものが使えないときは走らせない（全ルールが道連れになる）。
 */
async function validateStoredCredentials(): Promise<void> {
  const backend = getSecretBackend()
  if (!backend.isAvailable()) return
  const broken: string[] = []
  for (const rule of rules()) {
    if (rule.disabledReason) continue
    try {
      backend.decrypt(rule.password)
    } catch {
      broken.push(rule.id)
    }
  }
  if (broken.length === 0) return
  const ok = await commitRules((current) =>
    current.map((rule) => (broken.includes(rule.id) ? { ...rule, disabledReason: 'decrypt-failed' } : rule))
  )
  log('http_auth.decrypt_failed', { count: broken.length, persisted: ok })
}

function commitRules(mutate: (current: StoredRule[]) => StoredRule[]): Promise<boolean> {
  if (!store) return Promise.resolve(false)
  return store.commit((data) => ({ rules: normalizeRules(mutate(data.rules)) }))
}

/* ------------------------------------------------------------------ *
 * 読み取り
 * ------------------------------------------------------------------ */

export function httpAuthEncryptionAvailable(): boolean {
  return getSecretBackend().isAvailable()
}

/** **パスワードを含まない**一覧。 */
export function listHttpAuthRules(): HttpAuthRule[] {
  return rules().map(toPublic)
}

/** 照合に使う（同じくパスワードを含まない）。 */
export function matchableHttpAuthRules(): HttpAuthRule[] {
  return listHttpAuthRules()
}

/**
 * 1 件だけパスワードを返す（Settings の「表示」）。
 * 復号に失敗したらそのルールを無効化して null を返す。
 */
export async function revealHttpAuthPassword(id: string): Promise<string | null> {
  const credential = await getHttpAuthCredential(id)
  return credential?.password ?? null
}

/**
 * 自動入力に使う資格情報。復号に失敗したら**そのルールだけ**無効化する。
 */
export async function getHttpAuthCredential(
  id: string
): Promise<{ username: string; password: string } | null> {
  const rule = rules().find((item) => item.id === id)
  if (!rule || rule.disabledReason) return null
  const backend = getSecretBackend()
  /*
   * **端末鍵が使えないときは無効化しない。** ここで `decrypt-failed` を立てると、
   * 照合が当たったルールから順に恒久的に無効化されていく一方、
   * password の再保存も `no-encryption` で断られるので**理由を消す手段が無くなる**
   * （`validateStoredCredentials` が同じ理由で `isAvailable()` を見ているのと揃える）。
   */
  if (!backend.isAvailable()) return null
  try {
    return { username: rule.username, password: backend.decrypt(rule.password) }
  } catch (error) {
    logError('http_auth.decrypt_failed', error, { id })
    await disableHttpAuthRule(id, 'decrypt-failed')
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 書き込み
 * ------------------------------------------------------------------ */

export interface SaveRuleInput {
  /** 既存を更新するなら ID。省略すると新規（同じパターンがあれば上書き）。 */
  id?: string | null
  pattern: string
  username: string
  /** **省略したら既存の暗号文を保持する**（patch semantics）。空文字は「空に変更」。 */
  password?: string | null
  enabled?: boolean
  importedFrom?: string | null
}

export type SaveRuleResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'no-encryption' | 'invalid-pattern' | 'too-long' | 'too-many' | 'write-failed' }

/**
 * ルールを 1 件保存する（新規 / 更新の両方）。
 *
 * `disabledReason` は**原因に対応するフィールドを変更したときだけ**消す
 * （`pattern-timeout` は pattern の変更、`decrypt-failed` は password の再保存）。
 * それ以外の編集で消すと、同じ原因で毎回無効化され直す。
 */
export async function saveHttpAuthRule(input: SaveRuleInput): Promise<SaveRuleResult> {
  const backend = getSecretBackend()
  if (!validateHttpAuthPattern(input.pattern).ok) return { ok: false, reason: 'invalid-pattern' }
  if (input.username.length > HTTP_AUTH_LIMITS.MAX_USERNAME) return { ok: false, reason: 'too-long' }
  if (typeof input.password === 'string' && input.password.length > HTTP_AUTH_LIMITS.MAX_PASSWORD) {
    return { ok: false, reason: 'too-long' }
  }

  const current = rules()
  const existing =
    (input.id ? current.find((rule) => rule.id === input.id) : undefined) ??
    // 同じパターンのルールが既にあれば上書きする（#6 の自己修復に必要）
    current.find((rule) => rule.pattern === input.pattern)

  const changesPassword = typeof input.password === 'string'
  if (!existing && !changesPassword) return { ok: false, reason: 'invalid-pattern' }
  if (changesPassword && !backend.isAvailable()) return { ok: false, reason: 'no-encryption' }
  if (!existing && current.length >= HTTP_AUTH_LIMITS.MAX_RULES) return { ok: false, reason: 'too-many' }

  let encrypted: string
  try {
    encrypted = changesPassword
      ? backend.encrypt(input.password as string)
      : (existing as StoredRule).password
  } catch (error) {
    logError('http_auth.encrypt_failed', error, {})
    return { ok: false, reason: 'no-encryption' }
  }
  if (encrypted.length > HTTP_AUTH_LIMITS.MAX_CIPHERTEXT) return { ok: false, reason: 'too-long' }

  const id = existing?.id ?? randomUUID()
  const next: StoredRule = {
    id,
    pattern: input.pattern,
    username: input.username,
    password: encrypted,
    enabled: input.enabled ?? existing?.enabled ?? true
  }
  const importedFrom =
    input.importedFrom === undefined ? existing?.importedFrom : (input.importedFrom ?? undefined)
  if (importedFrom !== undefined) next.importedFrom = importedFrom

  // 原因が直ったときだけ理由を消す
  const reason = existing?.disabledReason
  const patternChanged = existing !== undefined && existing.pattern !== input.pattern
  const keepReason =
    reason === 'pattern-timeout' ? !patternChanged : reason === 'decrypt-failed' ? !changesPassword : false
  if (reason && keepReason) next.disabledReason = reason

  const ok = await commitRules((list) => {
    const collides = (rule: StoredRule): boolean => rule.id === id || rule.pattern === input.pattern
    const at = list.findIndex(collides)
    const kept = list.filter((rule) => !collides(rule))
    // **位置を保つ**（登録順は同点時の優先順なので、編集で順序を動かさない）
    return at === -1 ? [...kept, next] : [...kept.slice(0, at), next, ...kept.slice(at)]
  })
  if (!ok) return { ok: false, reason: 'write-failed' }
  log('http_auth.rule_saved', { id, created: existing === undefined, passwordChanged: changesPassword })
  return { ok: true, id }
}

export async function deleteHttpAuthRule(id: string): Promise<boolean> {
  const ok = await commitRules((list) => list.filter((rule) => rule.id !== id))
  if (ok) log('http_auth.rule_deleted', { id })
  return ok
}

/**
 * 有効 / 無効の切り替え。
 * **`disabledReason` がある間は有効にできない**（理由を消せるのは原因の修正だけ）。
 */
export async function setHttpAuthRuleEnabled(id: string, enabled: boolean): Promise<boolean> {
  const rule = rules().find((item) => item.id === id)
  if (!rule) return false
  if (enabled && rule.disabledReason) return false
  return commitRules((list) => list.map((item) => (item.id === id ? { ...item, enabled } : item)))
}

/** 自動無効化（照合のタイムアウト / 復号失敗）。理由を残す。 */
export async function disableHttpAuthRule(
  id: string,
  reason: 'pattern-timeout' | 'decrypt-failed'
): Promise<boolean> {
  const rule = rules().find((item) => item.id === id)
  if (!rule || rule.disabledReason === reason) return false
  const ok = await commitRules((list) =>
    list.map((item) => (item.id === id ? { ...item, disabledReason: reason } : item))
  )
  if (ok) log('http_auth.rule_disabled', { id, reason })
  return ok
}

/**
 * MultiPass の取り込み。**全体を 1 回のトランザクションで永続化する**。
 * @returns 書けたか
 */
export async function importHttpAuthRules(entries: ImportEntry[]): Promise<boolean> {
  const backend = getSecretBackend()
  if (entries.length === 0) return true
  if (!backend.isAvailable()) return false

  let prepared: StoredRule[]
  try {
    prepared = entries.map((entry) => {
      const rule: StoredRule = {
        id: entry.id ?? randomUUID(),
        pattern: entry.pattern,
        username: entry.username,
        password: backend.encrypt(entry.password),
        enabled: true
      }
      if (entry.importedFrom !== null) rule.importedFrom = entry.importedFrom
      return rule
    })
  } catch (error) {
    // 暗号化が途中で失敗しても**投げない**（renderer 側に catch が無く、
    // 未処理の rejection になって画面に何も出ない）
    logError('http_auth.encrypt_failed', error, {})
    return false
  }

  const ok = await commitRules((list) => {
    const replaced = new Set(prepared.map((rule) => rule.id))
    const patterns = new Set(prepared.map((rule) => rule.pattern))
    const kept = list.filter((rule) => !replaced.has(rule.id) && !patterns.has(rule.pattern))
    return [...kept, ...prepared]
  })
  log('http_auth.imported', { count: prepared.length, persisted: ok })
  return ok
}
