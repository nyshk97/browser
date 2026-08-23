import { ElectronChromeExtensions } from 'electron-chrome-extensions'

import fs from 'node:fs'
import path from 'node:path'
import { extensionsDir, extensionsLockPath } from './paths.js'
import { log, logError } from './log.js'
import { hashExtensionTree } from '../shared/tree-hash.js'
import { artifactDirFor, validateLock } from '../shared/ext-lock.js'
import { redactUrl, resolveNavigationTarget, setLoadedExtensionIds } from './security.js'
import type { LoadedExtensionInfo } from '../shared/types.js'
import {
  createTab,
  createWindow,
  findWindowByBaseWindow,
  findWindowByBaseWindowId,
  focusedOrFirstWindow,
  removeTab,
  removeWindow,
  selectTab
} from './registry.js'

export interface LockedExtension {
  id: string
  name: string
  version: string
  source: {
    type: 'github-release' | 'chrome-web-store'
    url: string
    repo?: string
    tag?: string
    asset?: string
  }
  sha256: string
  /**
   * 展開・manifest.key 注入まで済んだツリー全体の sha256。
   * アーカイブの hash だけでは展開後のコード改変を検知できないため、
   * **ロード前に必ずこれを照合する**。
   */
  treeSha256?: string
  /** manifest.json に注入する公開鍵（base64）。拡張 ID を版に依らず固定するために必要。 */
  manifestKey?: string
  /** zip 内で manifest.json があるディレクトリ。既定はルート。 */
  unpackedRoot?: string
}

export interface ExtensionsLock {
  lockfileVersion: number
  extensions: LockedExtension[]
}

export function readLock(): ExtensionsLock {
  // 検証は shared/ext-lock.js に寄せる（スクリプト側と同じ実装を通す）
  return validateLock(JSON.parse(fs.readFileSync(extensionsLockPath, 'utf8'))) as ExtensionsLock
}

/** materialize 済み artifact のディレクトリ（installer と同じ <id>/<version>_0 レイアウト）。 */
export function artifactPath(entry: LockedExtension): string {
  return artifactDirFor(extensionsDir, entry)
}

/**
 * lock された artifact "だけ" をロードする。
 *
 * Web Store の installExtension は「常に最新版」しか取れず lock から復元できないため、
 * ここでは Web Store 経路を一切通らない。lock に無い ID は構造上ロードされない
 * （= allowlist が実装として保証される）。
 */
export async function loadLockedExtensions(session: Electron.Session): Promise<LoadedExtensionInfo[]> {
  const lock = readLock()
  const results: LoadedExtensionInfo[] = []

  for (const entry of lock.extensions) {
    const dir = artifactPath(entry)
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      logError('extension.load_failed', new Error('artifact not materialized'), {
        id: entry.id,
        version: entry.version,
        path: dir,
        hint: 'pnpm ext:fetch'
      })
      continue
    }

    // ロードする前に「実際に実行されるコード」を照合する。
    // ここを通らないものは loadExtension に渡さない。
    if (!entry.treeSha256) {
      logError('extension.integrity_failed', new Error('lock に treeSha256 が無い'), {
        id: entry.id,
        version: entry.version,
        hint: 'pnpm ext:fetch'
      })
      continue
    }
    let treeHash: string
    try {
      treeHash = hashExtensionTree(dir)
    } catch (error) {
      logError('extension.integrity_failed', error, { id: entry.id, version: entry.version })
      continue
    }
    if (treeHash !== entry.treeSha256) {
      logError('extension.integrity_failed', new Error('展開済みツリーが lock と一致しない'), {
        id: entry.id,
        version: entry.version,
        expected: entry.treeSha256,
        actual: treeHash
      })
      continue
    }

    try {
      const extension = await session.extensions.loadExtension(dir)
      const matchesLock = extension.id === entry.id && extension.manifest.version === entry.version

      if (!matchesLock) {
        // ID が変わると chrome.storage が別物になり、拡張の設定が失われる。
        // 検知だけでは不十分なので、ロードしたものを必ず外す。
        logError('extension.lock_mismatch', new Error('id/version mismatch'), {
          expectedId: entry.id,
          actualId: extension.id,
          expectedVersion: entry.version,
          actualVersion: extension.manifest.version
        })
        session.extensions.removeExtension(extension.id)
        continue
      }

      results.push({
        id: extension.id,
        name: extension.name,
        version: extension.manifest.version,
        matchesLock,
        path: dir
      })
      log('extension.loaded', { id: extension.id, version: extension.manifest.version })

      if (extension.manifest.manifest_version === 3 && extension.manifest.background?.service_worker) {
        const scope = `chrome-extension://${extension.id}`
        await session.serviceWorkers.startWorkerForScope(scope).catch((error: unknown) => {
          logError('extension.service_worker_start_failed', error, { id: extension.id })
        })
      }
    } catch (error) {
      logError('extension.load_failed', error, { id: entry.id, version: entry.version, path: dir })
    }
  }

  // chrome-extension:// のナビゲーションを許可する対象を、実際にロードできたものだけに絞る
  setLoadedExtensionIds(results.map((r) => r.id))

  return results
}

/** 受け入れ基準の「service worker を停止・再起動しても動く」検証用。 */
export async function restartServiceWorkers(session: Electron.Session): Promise<number> {
  let started = 0
  for (const extension of session.extensions.getAllExtensions()) {
    if (extension.manifest.manifest_version !== 3) continue
    if (!extension.manifest.background?.service_worker) continue
    try {
      await session.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`)
      started += 1
    } catch (error) {
      logError('extension.service_worker_start_failed', error, { id: extension.id })
    }
  }
  log('extension.service_workers_restarted', { started })
  return started
}

export function watchServiceWorkerStatus(session: Electron.Session): void {
  session.serviceWorkers.on('running-status-changed', (details) => {
    log('extension.service_worker_status', {
      versionId: details.versionId,
      status: details.runningStatus
    })
  })
}

/**
 * 拡張の popup（browser action）を診断できるようにする。
 *
 * popup はタブではないので ⌘⌥I の対象にならず、
 * メニューから開こうとすると blur で popup 自体が閉じてしまう。
 * `PopupView.maybeClose` は DevTools が開いていれば閉じないので、
 * **生成された瞬間に開く**のが確実。dev で明示的に有効にしたときだけ動く。
 */
export function watchExtensionPopups(extensions: ElectronChromeExtensions): void {
  const openDevTools = process.env['NEMO_POPUP_DEVTOOLS'] === '1'

  // PopupView の型は package の exports から取れないので最小限だけ受ける
  interface PopupLike {
    extensionId: string
    browserWindow?: Electron.BrowserWindow
    whenReady(): Promise<void>
  }

  extensions.on('browser-action-popup-created', (popup: PopupLike) => {
    const contents: Electron.WebContents | undefined = popup.browserWindow?.webContents
    if (!contents) return

    log('extension.popup_created', { extensionId: popup.extensionId, devtools: openDevTools })

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logError('extension.popup_load_failed', new Error(errorDescription), {
        extensionId: popup.extensionId,
        errorCode,
        target: redactUrl(validatedURL)
      })
    })

    if (!openDevTools) return

    contents.on('console-message', (event) => {
      // popup のコンソール**本文は出さない**。
      // dev:popup は実 Vault で使う想定なので、本文にはメールアドレス・レスポンス・
      // トークンが載りうる（計画 1-9 の「ログに出さない」ルールに従う）。
      // 「どこで何件エラーが出たか」だけ残し、中身は DevTools で見る。
      if (event.level !== 'error' && event.level !== 'warning') return
      log('extension.popup_console', {
        extensionId: popup.extensionId,
        level: event.level,
        source: event.sourceId ? path.basename(event.sourceId) : '(unknown)',
        line: event.lineNumber
      })
    })

    void popup.whenReady().then(() => {
      if (!contents.isDestroyed()) contents.openDevTools({ mode: 'detach' })
    })
  })
}

/** Nemo のタブ / ウィンドウモデルと chrome.tabs / chrome.windows を接続する。 */
export function createExtensions(session: Electron.Session): ElectronChromeExtensions {
  return new ElectronChromeExtensions({
    // electron-chrome-extensions は GPL-3.0 / Patron License のデュアル。
    // Nemo 本体を GPL-3.0 で配布することで前者に準拠する。
    license: 'GPL-3.0',
    session,

    async createTab(details) {
      // details.windowId は chrome 側の windowId = BaseWindow.id
      const win =
        (typeof details.windowId === 'number' ? findWindowByBaseWindowId(details.windowId) : null) ??
        focusedOrFirstWindow()
      if (!win) throw new Error('no window available')

      // 拡張から渡された URL もナビゲーション検証を必ず通す。
      // 拡張は自分のページ（chrome-extension://<ロード済み ID>/）だけ追加で開ける。
      const url = resolveNavigationTarget(
        details.url,
        { allowExtensionPages: true },
        'chrome.tabs.create'
      )
      if (url === null) throw new Error('navigation rejected')

      const background = details.active === false
      const tab = createTab(win, url, { background })
      if (!background) selectTab(win, tab.id)
      return [tab.webContents, win.baseWindow]
    },

    selectTab(tab, baseWindow) {
      const win = findWindowByBaseWindow(baseWindow)
      if (win) selectTab(win, tab.id)
    },

    removeTab(tab, baseWindow) {
      const win = findWindowByBaseWindow(baseWindow)
      if (win) removeTab(win, tab.id)
    },

    async createWindow(details) {
      const requested = Array.isArray(details.url) ? details.url[0] : details.url
      const url = resolveNavigationTarget(
        requested,
        { allowExtensionPages: true },
        'chrome.windows.create'
      )
      if (url === null) throw new Error('navigation rejected')
      const win = createWindow(url)
      return win.baseWindow
    },

    removeWindow(baseWindow) {
      const win = findWindowByBaseWindow(baseWindow)
      if (win) removeWindow(win)
    },

    // Phase 0 では拡張からの追加権限要求は拒否する（Phase 1-8 で UI を付ける）
    async requestPermissions(extension, permissions) {
      log('extension.permissions_denied', { id: extension.id, permissions: permissions.permissions })
      return false
    }
  })
}
