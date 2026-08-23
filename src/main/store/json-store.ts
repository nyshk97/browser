import fs from 'node:fs'
import path from 'node:path'
import { log, logError } from '../log.js'
import { readVersioned, writeVersioned } from '../../shared/settings-schema.js'

/**
 * `{ version, data }` 形式の JSON を原子的に読み書きする小さなストア。
 *
 * - 書き込みは一時ファイル + rename（途中で落ちても半端な JSON を残さない）
 * - 読み込みは**必ず normalize を通す**（手で編集された JSON でアプリを壊さない）
 * - 壊れた JSON は `.broken-<時刻>` に退避してから既定値で作り直す
 *   （黙って消すと「設定が消えた」原因が追えない）
 * - 保存はデバウンスする（タブ切り替えのたびに fsync しない）
 */
export class JsonStore<T> {
  private value: T
  private saveTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(
    private readonly filePath: string,
    private readonly version: number,
    private readonly normalize: (raw: unknown) => T,
    private readonly debounceMs = 400
  ) {
    this.value = this.load()
  }

  private load(): T {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logError('store.read_failed', error, { file: path.basename(this.filePath) })
      }
      return this.normalize(undefined)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.quarantine('parse_failed', error)
      return this.normalize(undefined)
    }

    const versioned = readVersioned(parsed, this.version)
    if (!versioned) {
      this.quarantine('unsupported_version', new Error('version が無い / 未来の版'))
      return this.normalize(undefined)
    }
    return this.normalize(versioned.data)
  }

  private quarantine(reason: string, error: unknown): void {
    const backup = `${this.filePath}.broken-${Date.now()}`
    try {
      fs.renameSync(this.filePath, backup)
      logError('store.quarantined', error, {
        file: path.basename(this.filePath),
        reason,
        backup: path.basename(backup)
      })
    } catch (renameError) {
      logError('store.quarantine_failed', renameError, { file: path.basename(this.filePath) })
    }
  }

  get(): T {
    return this.value
  }

  set(next: T): void {
    this.value = next
    this.scheduleSave()
  }

  update(mutate: (current: T) => T): T {
    this.value = mutate(this.value)
    this.scheduleSave()
    return this.value
  }

  private scheduleSave(): void {
    if (this.closed) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, this.debounceMs)
  }

  /** 終了時など、確実に書き切りたいときに呼ぶ。 */
  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const tmp = `${this.filePath}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(writeVersioned(this.version, this.value), null, 2)}\n`)
      fs.renameSync(tmp, this.filePath)
    } catch (error) {
      logError('store.write_failed', error, { file: path.basename(this.filePath) })
      fs.rmSync(tmp, { force: true })
    }
  }

  close(): void {
    this.saveNow()
    this.closed = true
    log('store.closed', { file: path.basename(this.filePath) })
  }
}
