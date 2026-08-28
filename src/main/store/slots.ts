import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { log, logError } from '../log.js'
import { USER_DATA_DIR_NAME, userDataPath } from '../paths.js'
import { isRecord, readVersioned, writeVersioned } from '../../shared/settings-schema.js'
import {
  SLOTS_VERSION,
  SLOT_COUNT,
  countPinnedLinks,
  iconCandidates,
  normalizeSlot,
  normalizeSlotName
} from '../../shared/slots-schema.js'
import type { SlotData, SlotList, SlotSummary } from '../../shared/types.js'

/**
 * ブックマークのセーブスロット（ピン留め + お気に入りの保存と読み込み）。
 *
 * **`JsonStore` を使わない。** あれは値をメモリに載せてデバウンス保存する常駐向けで、
 * スロットは「ボタンを押したときだけ読み書きする」上に **iCloud 経由で別の Mac が書き換える**。
 * キャッシュを持つと「2 台目で保存したのに古い一覧が出る」になるので、
 * **一覧を開くたびにディスクから読み直す**。
 *
 * この層は**ファイル I/O だけに閉じる**（`pins.ts` / `history.ts` を引かない）。
 * 中身は引数で受け取るので、検証の fixture 生成にも同じ関数が使える。
 */

/** 1 枠の読み取りに待つ上限。iCloud の未ダウンロードを永久に待たない。 */
const READ_TIMEOUT_MS = 4000

export type SlotsDirKind = 'env' | 'icloud' | 'fallback'

/**
 * スロットの置き場所。
 *
 * `NEMO_SLOTS_DIR` → iCloud Drive → `<userData>/slots/` の順。
 * **env の口が無いと自走検証が実 iCloud の常用スロットに書く**ので、必ず最優先で見る。
 * iCloud は channel ごとに分ける（dev の実験が常用版のスロットを壊さない）。
 */
export function slotsDir(): { dir: string; kind: SlotsDirKind } {
  const override = process.env['NEMO_SLOTS_DIR']
  if (override) return { dir: path.resolve(override), kind: 'env' }

  const iCloud = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  if (fs.existsSync(iCloud)) {
    return { dir: path.join(iCloud, USER_DATA_DIR_NAME, 'slots'), kind: 'icloud' }
  }
  // iCloud Drive が無い環境。**画面に出すパスも必ずこの値にする**（黙って別の場所に書かない）
  return { dir: userDataPath('slots'), kind: 'fallback' }
}

/** ファイル名は 1 始まり、IPC の index は 0 始まり。**変換はこの層で閉じる**。 */
function slotPath(dir: string, index: number): string {
  return path.join(dir, `slot-${index + 1}.json`)
}

function isValidIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < SLOT_COUNT
}

/** 保存の初期名。空欄で作ると毎回リネームすることになる。 */
export function defaultSlotName(now = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
  return normalizeSlotName(`${hostName()} ${date}`)
}

export function hostName(): string {
  return os.hostname().replace(/\.local$/, '')
}

/**
 * iCloud の競合コピー（`slot-1 2.json` の類）を枠ごとに数える。
 *
 * **見つけても動かさない**（勝手にリネーム / 削除しない）。放っておくと
 * 「保存したのに 2 台目で見えない」の原因に辿り着けないので、存在だけ UI に伝える。
 */
async function findConflictCopies(dir: string): Promise<Set<number>> {
  const found = new Set<number>()
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return found
  }
  for (const name of entries) {
    // 競合コピーは `slot-1 2.json` の形（数字の直後に**空白**が来る）。
    // `slot-(\d+)[^.]+` だと `slot-12.json` を「slot-1 の競合」として拾ってしまう
    const match = /^slot-(\d+) [^.]*\.json$/.exec(name)
    if (!match) continue
    const index = Number(match[1]) - 1
    if (isValidIndex(index)) found.add(index)
  }
  return found
}

/** 壊れた JSON は消さずに退避する（黙って消すと「設定が消えた」原因が追えない）。 */
async function quarantine(file: string, reason: string, error: unknown): Promise<void> {
  const backup = `${file}.broken-${Date.now()}`
  try {
    await fsp.rename(file, backup)
    logError('slots.quarantined', error, { file: path.basename(file), reason })
  } catch (renameError) {
    logError('slots.quarantine_failed', renameError, { file: path.basename(file) })
  }
}

/**
 * 時間内に読めないファイルを待ち続けない（evicted なファイルはダウンロードを伴う）。
 *
 * **保管庫（`store/auth-vault.ts`）も同じものを使う。** 同じ iCloud のフォルダを読むので、
 * 待ち方が違うと「スロットは諦めるのに保管庫は固まる」が起きる。
 *
 * **`AbortSignal` だけでは足りない** —— Node は chunk の切れ目でしか signal を見ないので、
 * 最初の read がカーネルで止まっていると `abort()` しても戻ってこない。
 * `Promise.race` で**呼び出し側は必ず期限内に決着させ**、abort は後片付けとして残す。
 */
export async function readWithTimeout(file: string): Promise<string> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const error: NodeJS.ErrnoException = new Error(`read timed out: ${path.basename(file)}`)
      error.code = 'ABORT_ERR'
      reject(error)
    }, READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([fsp.readFile(file, { encoding: 'utf8', signal: controller.signal }), expired])
  } finally {
    clearTimeout(timer)
  }
}

function emptySummary(index: number, hasConflictCopy: boolean): SlotSummary {
  return {
    index,
    state: 'empty',
    name: '',
    savedAt: 0,
    host: '',
    pins: 0,
    favs: 0,
    icons: [],
    moreIcons: 0,
    hasConflictCopy
  }
}

function summarize(index: number, data: SlotData, hasConflictCopy: boolean): SlotSummary {
  return {
    index,
    state: 'ok',
    name: data.name,
    savedAt: data.savedAt,
    host: data.host,
    pins: countPinnedLinks(data.pinned),
    favs: data.favorites.length,
    icons: data.icons,
    // 「候補の総数 − 並べた数」。件数から引くと、重複を落とした分まで `+N` に化ける
    moreIcons: Math.max(0, iconCandidates(data.favorites, data.pinned).length - data.icons.length),
    hasConflictCopy
  }
}

/**
 * 1 枠を読む。
 *
 * **`ENOENT` だけが「空き」**。それ以外（権限拒否・タイムアウト・壊れ）は `unreadable` にする。
 * ここで空きに倒すとボタンが「保存」になり、押した瞬間に
 * **別の Mac のスロットを黙って潰す**（undo が無い）。
 */
async function readSummary(dir: string, index: number, hasConflictCopy: boolean): Promise<SlotSummary> {
  const file = slotPath(dir, index)
  let raw: string
  try {
    raw = await readWithTimeout(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return emptySummary(index, hasConflictCopy)
    const reason =
      code === 'ABORT_ERR' || (error as Error).name === 'AbortError'
        ? 'iCloud から取得できませんでした'
        : code === 'EPERM' || code === 'EACCES'
          ? '読み取りを許可されていません'
          : '読み込みに失敗しました'
    logError('slots.read_failed', error, { index, code: code ?? 'unknown' })
    return { ...emptySummary(index, hasConflictCopy), state: 'unreadable', reason }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    await quarantine(file, 'parse_failed', error)
    return { ...emptySummary(index, hasConflictCopy), state: 'unreadable', reason: '中身が壊れていました' }
  }

  const versioned = readVersioned(parsed, SLOTS_VERSION)
  if (!versioned) {
    /*
     * `readVersioned` は「未来の版」でも「version が壊れている」でも null を返すので、
     * **自分で見分ける**。一緒くたにすると、手で壊れた JSON が
     * 「新しい版の Nemo で保存されています」と表示されたまま退避もされず、
     * その枠が永久に読めも保存もできなくなる。
     */
    const version = isRecord(parsed) ? parsed['version'] : undefined
    if (typeof version === 'number' && Number.isInteger(version) && version > SLOTS_VERSION) {
      // 未来の版は退避しない（新しい Nemo が書いたものを古い Nemo が捨てない）
      return {
        ...emptySummary(index, hasConflictCopy),
        state: 'unreadable',
        reason: '新しい版の Nemo で保存されています'
      }
    }
    await quarantine(file, 'bad_version', new Error(`version=${String(version)}`))
    return { ...emptySummary(index, hasConflictCopy), state: 'unreadable', reason: '中身が壊れていました' }
  }
  return summarize(index, normalizeSlot(versioned.data), hasConflictCopy)
}

/**
 * 3 枠ぶんを毎回ディスクから読む。
 *
 * 「いまのブラウザの件数」（`SlotList.current`）は**この層では持たない**
 * —— `pins.ts` を引かず、ファイル I/O だけに閉じておく。IPC 側で足す。
 */
export async function listSlots(): Promise<Omit<SlotList, 'current'>> {
  const { dir, kind } = slotsDir()
  const conflicts = await findConflictCopies(dir)
  const slots = await Promise.all(
    Array.from({ length: SLOT_COUNT }, (_, index) => readSummary(dir, index, conflicts.has(index)))
  )
  return { dir, kind, slots }
}

/** 1 枠の中身を読む（読み込み＝適用の前段）。読めなければ null。 */
export async function readSlot(index: number): Promise<SlotData | null> {
  if (!isValidIndex(index)) return null
  const { dir } = slotsDir()
  const file = slotPath(dir, index)
  try {
    const versioned = readVersioned(JSON.parse(await readWithTimeout(file)), SLOTS_VERSION)
    return versioned ? normalizeSlot(versioned.data) : null
  } catch (error) {
    logError('slots.read_failed', error, { index })
    return null
  }
}

/**
 * 1 枠に書く。
 *
 * tmp + rename。**rename の直前に既存ファイルの有無を確かめる**
 * （一覧を出したあとに別の Mac が保存していたら、空きだと思って潰すことになる）。
 */
export async function saveSlot(index: number, data: SlotData): Promise<boolean> {
  if (!isValidIndex(index)) return false
  const { dir, kind } = slotsDir()
  const file = slotPath(dir, index)
  const tmp = `${file}.tmp-${process.pid}`
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(tmp, `${JSON.stringify(writeVersioned(SLOTS_VERSION, data), null, 2)}\n`)
    // **rename の直前に見る**。一覧を出したあとに別の Mac が保存していたら潰すことになる
    if (fs.existsSync(file)) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      log('slots.save_rejected', { index, reason: 'already_exists' })
      return false
    }
    await fsp.rename(tmp, file)
    log('slots.saved', { index, kind, pins: countPinnedLinks(data.pinned), favs: data.favorites.length })
    return true
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    logError('slots.save_failed', error, { index })
    return false
  }
}

/** 1 枠を消す。**「削除 → 保存」が上書きの経路**なので、消せないと詰む。 */
export async function deleteSlot(index: number): Promise<boolean> {
  if (!isValidIndex(index)) return false
  const { dir } = slotsDir()
  try {
    await fsp.rm(slotPath(dir, index), { force: true })
    log('slots.deleted', { index })
    return true
  } catch (error) {
    logError('slots.delete_failed', error, { index })
    return false
  }
}

/**
 * 名前だけ変える。
 *
 * read-modify-write なので、**読めない枠では実行できない**（UI 側でも「削除」だけ出す）。
 */
export async function renameSlot(index: number, name: string): Promise<boolean> {
  if (!isValidIndex(index)) return false
  const current = await readSlot(index)
  if (!current) return false
  const { dir } = slotsDir()
  const file = slotPath(dir, index)
  const tmp = `${file}.tmp-${process.pid}`
  try {
    const next: SlotData = { ...current, name: normalizeSlotName(name) }
    await fsp.writeFile(tmp, `${JSON.stringify(writeVersioned(SLOTS_VERSION, next), null, 2)}\n`)
    await fsp.rename(tmp, file)
    log('slots.renamed', { index })
    return true
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    logError('slots.rename_failed', error, { index })
    return false
  }
}

/** 保存先をユーザーに見せる（Finder で開く）。 */
export async function ensureSlotsDir(): Promise<string> {
  const { dir } = slotsDir()
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** アプリの版（スロットに焼き込む）。 */
export function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return ''
  }
}
