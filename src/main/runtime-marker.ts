import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { extensionsDir, extensionsLockPath, projectRoot } from './paths.js'
import { log, logError } from './log.js'

/**
 * 起動中の Nemo を外から確実に見つけられるようにするマーカー。
 *
 * `ps` のコマンドラインを見る方式は当てにならない。
 * electron-vite dev は `Electron .` として起動するため
 * `out/main/index.js` を含まず、検出をすり抜けた（実際に踏んだ）。
 *
 * 検証スクリプトは拡張や lock を書き換えるので、
 * 「起動中の Nemo がいるか」を取りこぼすと稼働中のインスタンスを壊す。
 */

export const runtimeMarkerDir = path.join(projectRoot, '.nemo-run')

let markerPath: string | null = null
let cleanedUp = false

/** マーカー置き場が「普通のディレクトリ」であることを確認する（symlink なら作り直さず諦める）。 */
function ensureMarkerDir(): boolean {
  try {
    const stat = fs.lstatSync(runtimeMarkerDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      logError('app.runtime_marker_failed', new Error('マーカー置き場が通常のディレクトリでない'), {
        path: runtimeMarkerDir
      })
      return false
    }
    return true
  } catch {
    fs.mkdirSync(runtimeMarkerDir, { recursive: true })
    return true
  }
}

export function writeRuntimeMarker(): void {
  try {
    if (!ensureMarkerDir()) return
    markerPath = path.join(runtimeMarkerDir, `${process.pid}.json`)
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          userData: app.getPath('userData'),
          extensionsDir,
          extensionsLockPath,
          remoteDebuggingPort: process.env['NEMO_REMOTE_DEBUGGING_PORT'] ?? null
        },
        null,
        2
      )}\n`
    )
    log('app.runtime_marker_written', { path: markerPath })
  } catch (error) {
    // マーカーが書けなくても起動は続ける（検証側は ps へフォールバックする）
    logError('app.runtime_marker_failed', error)
  }
}

export function removeRuntimeMarker(): void {
  if (cleanedUp || !markerPath) return
  cleanedUp = true
  try {
    fs.rmSync(markerPath, { force: true })
  } catch {
    /* 落とせなくても致命的ではない（次回起動時に stale として掃除される） */
  }
}

export function installRuntimeMarker(): void {
  writeRuntimeMarker()
  app.on('will-quit', removeRuntimeMarker)
  process.on('exit', removeRuntimeMarker)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      removeRuntimeMarker()
      app.quit()
    })
  }
}
