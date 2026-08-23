import type { NemoWindow } from './registry.js'
import { log } from './log.js'

/**
 * アプリの初期化が終わったか。
 *
 * 「ウィンドウの UI が表示された」と「起動時のタブが揃った」はズレる。
 * タブは `whenUiReady()` の中で作られるので、UI が出た瞬間に外から見ると
 * **registry が空**に見える（自走検証がここで間欠的に落ちた）。
 *
 * 外から「もう見てよい」と判断できる合図をアプリ自身が持つ。
 */

export interface AppStatus {
  /** 起動時のウィンドウとタブが揃ったか。 */
  ready: boolean
  windows: number
  tabs: number
  /** ロードできた拡張の数。 */
  extensions: number
}

let ready = false
let extensionCount = 0

export function setExtensionCount(count: number): void {
  extensionCount = count
}

/** 起動時に用意したウィンドウの UI がすべて出そろうまで待ってから ready にする。 */
export async function markReadyWhen(windows: readonly NemoWindow[]): Promise<void> {
  await Promise.all(
    windows.map(
      (win) =>
        new Promise<void>((resolve) => {
          // 「準備できた」か「閉じられた」かのどちらかで必ず解決する。
          // whenUiReady だけだと、準備前に閉じられたウィンドウを永久に待って
          // ready が立たなくなる。
          // コールバックは登録順に走るので、createWindow が先に登録した
          // 「初期タブを作る」処理の後にこれが呼ばれる。
          win.whenUiSettled(() => resolve())
        })
    )
  )
  ready = true
  log('app.initialized', { windows: windows.length })
}

export function getAppStatus(windows: readonly NemoWindow[]): AppStatus {
  return {
    ready,
    windows: windows.length,
    tabs: windows.reduce((total, win) => total + win.tabs.length, 0),
    extensions: extensionCount
  }
}
