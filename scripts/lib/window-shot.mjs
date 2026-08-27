/**
 * ウィンドウを**合成後の絵**で撮る（macOS の `screencapture -l`）。
 *
 * CDP の `Page.captureScreenshot` は**その WebContents 自身しか撮らない**。
 * Nemo のページ・ツールバー・サイドバーは別々の `WebContentsView` で、
 * フォーカス枠や器は `WebContents` を持たない素の `View` なので、
 * 分割ビューの見た目（枠・隔間・角丸）は CDP では 1 枚も写らない。
 *
 * 撮る対象は `BaseWindow.getMediaSourceId()`（`window:<CGWindowID>:0`）で指す。
 * renderer からは CGWindowID を知りようがないので、
 * 自走検証は検証専用の診断 IPC 越しにこの ID をもらってからここへ渡す。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `window:12345:0` から CGWindowID を取り出す。
 * @param {string} mediaSourceId
 * @returns {number | null}
 */
export function windowIdOf(mediaSourceId) {
  if (typeof mediaSourceId !== 'string') return null
  const matched = /^window:(\d+):/.exec(mediaSourceId)
  if (!matched) return null
  const id = Number(matched[1])
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * ウィンドウ 1 枚を PNG に撮る。撮れたパスを返す（撮れなければ null）。
 *
 * **画面収録の許可が要る**。許可が無いと `screencapture` は成功したふりをして
 * デスクトップの絵を返すことがあるので、**サイズが極端に小さいものは失敗として扱う**。
 *
 * @param {string} mediaSourceId `BaseWindow.getMediaSourceId()` の値
 * @param {string} filePath 保存先（ディレクトリは作る）
 * @returns {string | null}
 */
export function captureWindow(mediaSourceId, filePath) {
  const id = windowIdOf(mediaSourceId)
  if (id === null) return null
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // オプションはファイル名より**前**に置く（後ろだとファイル名扱いされる）。
  // `-o` は影を落とす（枠の太さを測るときに影が混ざらないように）。
  const result = spawnSync('/usr/sbin/screencapture', ['-l', String(id), '-x', '-o', '-t', 'png', filePath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) return null
  if (!fs.existsSync(filePath)) return null
  if (fs.statSync(filePath).size < 1024) {
    fs.rmSync(filePath, { force: true })
    return null
  }
  return filePath
}
