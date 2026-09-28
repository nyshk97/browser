import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  CachedAccount,
  CachedItem,
  CacheSnapshot,
  VaultCacheStore
} from '../../vendor/kypr/client/index.ts'
import { isRecord } from '../../shared/settings-schema.js'
import { log, logError } from '../log.js'
import { userDataPath } from '../paths.js'

/**
 * kypr のオフラインのキャッシュ（`userData/kypr/cache.json`）。
 *
 * **置くのは暗号文・包んだ保管庫鍵・KDF パラメータ・revision だけ**（Web の IndexedDB と同じ中身）。
 * 平文や展開した鍵は置かない。書き込みは tmp + rename（書きかけのファイルを読まない）。
 * 中身はメモリにも持ち、読むのは最初の 1 回だけ（書き込みのたびにファイルを読み直さない）。
 */

const VERSION = 1
const EMPTY: CacheSnapshot = { account: null, revision: 0, items: [] }

export function kyprDir(): string {
  return userDataPath('kypr')
}

function cacheFile(): string {
  return path.join(kyprDir(), 'cache.json')
}

function parse(raw: string): CacheSnapshot | null {
  const data: unknown = JSON.parse(raw)
  if (!isRecord(data) || data['version'] !== VERSION) return null
  const account = data['account']
  const revision = data['revision']
  const items = data['items']
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null
  if (!Array.isArray(items)) return null
  return {
    account: isRecord(account) ? (account as unknown as CachedAccount) : null,
    revision,
    items: items.filter(isRecord) as unknown as CachedItem[]
  }
}

export class FileCacheStore implements VaultCacheStore {
  #snapshot: CacheSnapshot | null = null
  #writing: Promise<void> = Promise.resolve()

  #read(): CacheSnapshot {
    if (this.#snapshot) return this.#snapshot
    try {
      const parsed = parse(fs.readFileSync(cacheFile(), 'utf8'))
      if (!parsed) log('kypr.cache_ignored', { reason: 'shape' })
      this.#snapshot = parsed ?? { ...EMPTY }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError('kypr.cache_read_failed', error, {})
      this.#snapshot = { ...EMPTY }
    }
    return this.#snapshot
  }

  /** キャッシュにアカウントがあるか（= この Mac で一度ログインした）。同期的に答える。 */
  hasAccount(): boolean {
    return this.#read().account !== null
  }

  itemCount(): number {
    return this.#read().items.length
  }

  async load(): Promise<CacheSnapshot> {
    const s = this.#read()
    return { account: s.account, revision: s.revision, items: [...s.items] }
  }

  async saveAccount(account: CachedAccount): Promise<void> {
    this.#snapshot = { ...this.#read(), account }
    await this.#write()
  }

  async apply(revision: number, upserts: CachedItem[], removals: string[], full = false): Promise<void> {
    const current = this.#read()
    const map = new Map(full ? [] : current.items.map((it) => [it.id, it] as const))
    for (const it of upserts) map.set(it.id, it)
    for (const id of removals) map.delete(id)
    this.#snapshot = { account: current.account, revision, items: [...map.values()] }
    await this.#write()
  }

  async clear(): Promise<void> {
    this.#snapshot = { ...EMPTY }
    await this.#write()
  }

  /** 書き込みは順番に（前の書き込みの rename と追い越さない）。 */
  #write(): Promise<void> {
    const snapshot = this.#snapshot ?? EMPTY
    const next = this.#writing.then(async () => {
      const file = cacheFile()
      const tmp = `${file}.tmp-${process.pid}`
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fsp.writeFile(tmp, `${JSON.stringify({ version: VERSION, ...snapshot })}\n`, { mode: 0o600 })
      await fsp.rename(tmp, file)
    })
    // 失敗しても次の書き込みは続ける（呼び出し側にはこの回の失敗を返す）
    this.#writing = next.catch((error: unknown) => logError('kypr.cache_write_failed', error, {}))
    return next
  }
}
