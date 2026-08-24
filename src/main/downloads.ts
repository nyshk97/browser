import { app, dialog, shell, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { log, logError, redactUrl } from './log.js'
import { getSettings } from './store/settings.js'
import type { DownloadState } from '../shared/types.js'

/**
 * 保存先の既定。
 * `NEMO_DOWNLOAD_DIR` で差し替えられる。
 * 自走検証が**実際の ~/Downloads を汚さない**ために必要
 * （検証のたびに `nemo-verify (2).bin` が増えていくのを踏んだ）。
 */
function downloadDir(): string {
  const override = process.env['NEMO_DOWNLOAD_DIR']
  return override ? path.resolve(override) : app.getPath('downloads')
}

/**
 * ダウンロード（計画 1-6）。
 *
 * 一覧は起動中だけ保持する（履歴として残すのは Phase 2 以降の話）。
 * ログにはファイル名も URL のパスも載せない（`redactUrl` でホストまで）。
 */

interface Entry {
  state: DownloadState
  item: Electron.DownloadItem
  /**
   * どのセッションのダウンロードか。`null` は常用、文字列はシークレットの partition 名。
   *
   * **一覧は全ウィンドウ共通**なので、印を付けておかないと
   * シークレットで落としたファイル名と保存先が、シークレットを閉じた後も
   * 通常ウィンドウの一覧から見えて Finder で開けてしまう。
   */
  scope: string | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const MAX_ENTRIES = 50

export function onDownloadsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function listDownloads(): DownloadState[] {
  return [...entries.values()].map((entry) => entry.state).sort((a, b) => b.startedAt - a.startedAt)
}

export function installDownloadHandler(pageSession: Session, scope: string | null = null): void {
  pageSession.on('will-download', (_event, item) => {
    const id = randomUUID()
    const host = redactUrl(item.getURL())

    if (getSettings().askDownloadLocation) {
      // 保存先を聞く。ここは OS のファイル選択なのでネイティブダイアログでよい
      // （ブラウザ UI に置き換えられる類のものではない）。
      const chosen = dialog.showSaveDialogSync({
        defaultPath: path.join(downloadDir(), item.getFilename())
      })
      if (!chosen) {
        item.cancel()
        log('download.cancelled_by_user', { host })
        return
      }
      item.setSavePath(chosen)
    } else {
      item.setSavePath(uniquePath(path.join(downloadDir(), item.getFilename())))
    }

    const state: DownloadState = {
      id,
      filename: path.basename(item.getSavePath()),
      savePath: item.getSavePath(),
      receivedBytes: 0,
      totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
      state: 'progressing',
      startedAt: Date.now(),
      host
    }
    entries.set(id, { state, item, scope })
    trim()
    log('download.started', { host })
    notify()

    item.on('updated', (__event, updatedState) => {
      const entry = entries.get(id)
      if (!entry) return
      entry.state = {
        ...entry.state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
        state: updatedState === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      }
      notify()
    })

    item.once('done', (__event, doneState) => {
      const entry = entries.get(id)
      if (!entry) return
      entry.state = {
        ...entry.state,
        receivedBytes: item.getReceivedBytes(),
        state:
          doneState === 'completed' ? 'completed' : doneState === 'cancelled' ? 'cancelled' : 'interrupted'
      }
      log(doneState === 'completed' ? 'download.completed' : 'download.failed', { host, result: doneState })
      notify()
    })
  })
}

/** 同名ファイルがあれば `name (2).ext` にずらす。 */
function uniquePath(target: string): string {
  // fs は同期で軽く見るだけ（保存直前に競合したら Electron 側が上書きする）
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return target
}

function trim(): void {
  const sorted = listDownloads()
  for (const state of sorted.slice(MAX_ENTRIES)) {
    if (state.state === 'progressing' || state.state === 'paused') continue
    entries.delete(state.id)
  }
}

export function cancelDownload(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.state.state === 'progressing' || entry.state.state === 'paused') {
    entry.item.cancel()
    return
  }
  entries.delete(id)
  notify()
}

export function revealDownload(id: string): void {
  const entry = entries.get(id)
  if (!entry || entry.state.state !== 'completed') return
  try {
    shell.showItemInFolder(entry.state.savePath)
  } catch (error) {
    logError('download.reveal_failed', error)
  }
}

/**
 * その scope のダウンロードを一覧から消す（シークレットが終わったとき）。
 *
 * **保存したファイル自体は消さない**（Chrome と同じ。落としたものは残る）。
 * 消すのは「何を落としたか」が分かるメタデータの方。
 * 進行中のものはセッションごと消えるので中止する。
 */
export function forgetDownloadsForScope(scope: string): void {
  let removed = 0
  for (const [id, entry] of entries) {
    if (entry.scope !== scope) continue
    if (entry.state.state === 'progressing' || entry.state.state === 'paused') {
      try {
        entry.item.cancel()
      } catch {
        // セッションが落ちた後は cancel が投げることがある。一覧から消せれば目的は足りる
      }
    }
    entries.delete(id)
    removed += 1
  }
  if (removed > 0) log('download.scope_forgotten', { removed })
  notify()
}

/** 終わったものだけ消す（進行中は残す）。 */
export function clearDownloads(): void {
  for (const [id, entry] of entries) {
    if (entry.state.state === 'progressing' || entry.state.state === 'paused') continue
    entries.delete(id)
  }
  notify()
}
