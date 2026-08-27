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
  /** `commit()` を直列化するキュー（同じ旧値から作った更新が互いを消さないように）。 */
  private queue: Promise<unknown> = Promise.resolve()

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

  /** 実際にディスクへ書く。**失敗は投げる**（握り潰す判断は呼び出し側に持たせる）。 */
  private writeToDisk(value: T): void {
    const tmp = `${this.filePath}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(writeVersioned(this.version, value), null, 2)}\n`)
      fs.renameSync(tmp, this.filePath)
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      throw error
    }
  }

  /** 終了時など、確実に書き切りたいときに呼ぶ。 */
  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      this.writeToDisk(this.value)
    } catch (error) {
      logError('store.write_failed', error, { file: path.basename(this.filePath) })
    }
  }

  /**
   * **書き切ってから commit する**更新。
   *
   * `set()` / `update()` は 400ms デバウンスで、`saveNow()` は書き込み失敗を握り潰す。
   * そのままだと **IPC が成功を返したあとに書き込みが失敗する**構造が残るので、
   * 資格情報のように「保存できたか」を返さなければならないものはこちらを使う。
   *
   * - **次の値を先にディスクへ書き切り、成功したときだけメモリへ commit する。**
   *   `set()` してから flush する形にすると、失敗したのにメモリには新しい値が残り、
   *   次の別の更新が成功したときに一緒に永続化されてしまう。
   * - **キューで直列化し、常に直前の commit 済み値から次の値を作る。**
   *   複数タブの保存や複数ルールの自動無効化が並ぶと、
   *   同じ旧値から作った更新が互いを上書きして片方が消える。
   *
   * @returns 書き込めたか（false なら**メモリも変わっていない**）
   */
  commit(mutate: (current: T) => T): Promise<boolean> {
    const run = this.queue.then((): boolean => {
      if (this.closed) return false
      const next = mutate(this.value)
      try {
        this.writeToDisk(next)
      } catch (error) {
        logError('store.commit_failed', error, { file: path.basename(this.filePath) })
        return false
      }
      // 書けたときだけメモリへ反映する（順序を逆にしない）
      this.value = next
      // デバウンス中の保存はもう不要（同じ値をもう一度書くだけ）
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      return true
    })
    // 1 件失敗しても後続を止めない
    this.queue = run.catch(() => false)
    return run
  }

  close(): void {
    this.saveNow()
    this.closed = true
    log('store.closed', { file: path.basename(this.filePath) })
  }
}
