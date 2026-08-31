import { app, dialog, shell, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { log, logError, redactUrl } from './log.js'
import { idsOverCap } from '../shared/download-cap.js'
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

export function onDownloadsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * そのウィンドウに見せてよいダウンロードだけを返す。
 *
 * **一覧は scope で必ず絞る**。絞らないと、シークレット窓を開いている間、
 * 通常ウィンドウの一覧からファイル名・ホスト・保存先が見えてしまう
 * （Finder で開けるし、キャンセルもできる）。
 *
 * @param scope `null` は常用、文字列はシークレットの partition 名
 */
export function listDownloads(scope: string | null = null): DownloadState[] {
  return [...entries.values()]
    .filter((entry) => entry.scope === scope)
    .map((entry) => entry.state)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * その id を、その scope から操作してよいか。
 * **操作系は必ずこれを通す**（一覧に出さなくても id を知っていれば叩けてしまうため）。
 */
function ownedBy(id: string, scope: string | null): Entry | null {
  const entry = entries.get(id)
  if (!entry || entry.scope !== scope) return null
  return entry
}

export function installDownloadHandler(pageSession: Session, scope: string | null = null): void {
  pageSession.on('will-download', (_event, item) => {
    const id = randomUUID()
    const host = redactUrl(item.getURL())

    // 保存先は**毎回ダイアログで選ぶ**（設定 `askDownloadLocation` は廃止した。OFF にする理由が無い）。
    // 例外は `NEMO_DOWNLOAD_DIR`（自走検証）があるときだけ:
    // `showSaveDialogSync` は main を止めるので CDP からは操作できず検証が固まるし、
    // env で保存先が決まっているならユーザーに聞く意味もない。
    if (!process.env['NEMO_DOWNLOAD_DIR']) {
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
    trim(scope)
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
      // **終わった時点でもう一度上限を掛ける**。
      // 上限判定は「終わっていないものは落とさない」ので、
      // 長く走っている1件は超過していても保護される。
      // 開始時にしか掛けないと、それが終わった後も上限を超えたまま残り続ける。
      trim(entry.scope)
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

/**
 * 件数の上限を掛ける。**scope ごとに**掛けるのが肝。
 * 全部を混ぜて数えると、シークレット側で大量に落としただけで
 * 通常側の古い履歴が押し出されて消える。
 *
 * 呼ぶのは「開始時」と「終わった時」の両方。終わった時に掛けないと、
 * 上限超過中は保護されていた進行中の項目が、完了後もそのまま残る。
 */
function trim(scope: string | null): void {
  const snapshot = [...entries.values()].map((entry) => ({
    id: entry.state.id,
    scope: entry.scope,
    startedAt: entry.state.startedAt,
    state: entry.state.state
  }))
  for (const id of idsOverCap(snapshot, scope)) entries.delete(id)
}

export function cancelDownload(id: string, scope: string | null = null): void {
  const entry = ownedBy(id, scope)
  if (!entry) return
  if (entry.state.state === 'progressing' || entry.state.state === 'paused') {
    entry.item.cancel()
    return
  }
  entries.delete(id)
  notify()
}

export function revealDownload(id: string, scope: string | null = null): void {
  const entry = ownedBy(id, scope)
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

/** 終わったものだけ消す（進行中は残す）。**自分の scope の分だけ**。 */
export function clearDownloads(scope: string | null = null): void {
  for (const [id, entry] of entries) {
    if (entry.scope !== scope) continue
    if (entry.state.state === 'progressing' || entry.state.state === 'paused') continue
    entries.delete(id)
  }
  notify()
}
