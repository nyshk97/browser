import { WebContentsView, session as electronSession } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { iconHost, loginIconHost } from '../../vendor/kypr/client/icon.ts'
import type { VaultSession } from '../../vendor/kypr/client/index.ts'
import { ICON_WRITE_LIMIT } from '../../vendor/kypr/client/session.ts'
import { isIconDataUri } from '../../vendor/kypr/crypto/icon.ts'
import { log, logError } from '../log.js'
import { getFaviconsForHosts } from '../store/history.js'
import { kyprDir } from './cache-store.js'

/**
 * kypr のサイトのアイコン（`type: "icon"`）を書く。Web・iOS がログインのアイコンに使う
 * （kypr の `docs/crypto-spec.md`「サイトのアイコン」）。
 *
 * - 書くのは、保管庫のログインのホストのうち **Nemo の履歴に favicon があるもの**だけ（開いたことのないサイトへは取りに行かない）
 * - favicon は一辺 64px までの正方形の PNG に描き直す（引き伸ばさない）。8KB を超えたら 32px、それでも超えたら書かない
 * - 何を書くか（無い・30 日たった・中身が違う）と 409 / 410 の扱いは kypr の `VaultSession.saveIcons`
 */

/** PNG の上限（kypr の仕様。書く側は 8KB まで）。 */
const PNG_MAX_BYTES = 8 * 1024
/** 取りに行く favicon の大きさの上限（ICO は複数の大きさを持つので少し大きめ）。 */
const FETCH_MAX_BYTES = 512 * 1024
const RENDER_TIMEOUT_MS = 5000
/** 描くためだけのセッション（保存しない。常用のページと cookie を共有しない）。 */
const RENDER_PARTITION = 'nemo-kypr-icon-render'

/** 完全削除されていて二度と作れないアイコンの id（トゥームストーンは同期で手元から消えるので、ここに覚える）。 */
function goneFile(): string {
  return path.join(kyprDir(), 'icon-gone.json')
}

function loadGone(): Set<string> {
  try {
    const list = JSON.parse(fs.readFileSync(goneFile(), 'utf8'))
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveGone(ids: Set<string>): void {
  try {
    fs.mkdirSync(kyprDir(), { recursive: true })
    fs.writeFileSync(goneFile(), JSON.stringify([...ids]))
  } catch (error) {
    logError('kypr.icon_gone_save_failed', error, {})
  }
}

/** 描けなかった favicon（起動しているあいだだけ覚えて、同期のたびに描き直さない）。取れなかった（通信の失敗）ものは入れない。 */
const failed = new Set<string>()

/**
 * favicon を、`<img>` にそのまま渡せる data: URL にする（別のオリジンの画像を canvas に描くと toDataURL が拒まれるので、
 * 中身を取ってから渡す）。
 * **常用のページのセッション（`persist:nemo`）で取らない**: 1.10.5 でそうしたら、最初の取得で main が SIGSEGV で落ちた
 * （拡張の入ったセッションで、タブを持たない要求を出すと落ちる。2026-09-30）。描くための専用のセッション（保存しない・拡張も cookie も無い）で取る
 */
async function faviconSource(url: string): Promise<string | null> {
  if (url.startsWith('data:image/')) return url.length <= FETCH_MAX_BYTES * 2 ? url : null
  if (URL.parse(url)?.protocol !== 'https:') return null
  const res = await electronSession
    .fromPartition(RENDER_PARTITION)
    .fetch(url, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) })
  if (!res.ok) return null
  // 大きすぎるものは本文を読む前にやめる（無ければ読んでから見る）
  if (Number(res.headers.get('content-length') ?? 0) > FETCH_MAX_BYTES) return null
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length === 0 || body.length > FETCH_MAX_BYTES) return null
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  // Chromium の画像のデコーダーは中身で形式を見分ける（SVG だけは MIME が要る）
  const mime = type.startsWith('image/') ? type : 'application/octet-stream'
  return `data:${mime};base64,${body.toString('base64')}`
}

/**
 * レンダラーの中で描く。nativeImage は PNG と JPEG しか読めない（ICO・SVG・GIF が空になる。2026-09-30 に確認）ので、
 * Chromium の `<img>` で読んで canvas に描く。SVG は `<img>` の中ではスクリプトが動かない
 */
const RENDER = `async (src, sizes) => {
  const img = new Image()
  await new Promise((ok, ng) => {
    img.onload = ok
    img.onerror = ng
    setTimeout(ng, ${RENDER_TIMEOUT_MS})
    img.src = src
  })
  const w = img.naturalWidth || sizes[0]
  const h = img.naturalHeight || sizes[0]
  return sizes.map((max) => {
    const size = Math.min(max, Math.max(w, h))
    const c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    const k = size / Math.max(w, h)
    g.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k)
    return c.toDataURL('image/png')
  })
}`

function pngBytes(dataUri: string): number {
  return Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64').length
}

/**
 * 描き直した PNG の data: URI（64px、大きすぎれば 32px）。取れなかった（通信の失敗。次の同期でやり直す）ときは
 * `fetchFailed`、描けなかったときは `png: null`
 */
type Rasterized = { png: string | null } | { fetchFailed: true }

async function rasterize(view: WebContentsView, url: string): Promise<Rasterized> {
  const src = await faviconSource(url).catch(() => null)
  if (!src) return { fetchFailed: true }
  // 描く側のプロセスが落ちると executeJavaScript が返らないので、上限を付ける
  const pngs = (await Promise.race([
    view.webContents.executeJavaScript(`(${RENDER})(${JSON.stringify(src)}, [64, 32])`),
    new Promise((resolve) => setTimeout(() => resolve(null), RENDER_TIMEOUT_MS * 2))
  ])) as unknown
  if (!Array.isArray(pngs)) return { png: null }
  for (const png of pngs) {
    if (typeof png === 'string' && pngBytes(png) <= PNG_MAX_BYTES && isIconDataUri(png)) return { png }
  }
  return { png: null }
}

let writing: Promise<void> | null = null

/** 解除中の同期の後に呼ぶ（待たない）。書いている最中なら何もしない。 */
export function writeKyprSiteIcons(session: VaultSession): void {
  if (writing || session.readOnly) return
  writing = write(session)
    .catch((error) => logError('kypr.icon_write_failed', error, {}))
    .finally(() => {
      writing = null
    })
}

async function write(session: VaultSession): Promise<void> {
  const hosts = new Set<string>()
  for (const entry of session.entries.values()) {
    if (entry.deletedAt !== null || entry.state.kind !== 'login') continue
    const host = loginIconHost(entry.state.item.uris)
    if (host) hosts.add(host)
  }
  const gone = loadGone()
  const favicons = getFaviconsForHosts([...hosts])
  const targets: { host: string; url: string }[] = []
  for (const [host, url] of favicons) {
    if (failed.has(url)) continue
    if (gone.has(await session.iconId(host))) continue
    if (!(await session.iconNeedsWrite(host))) continue
    targets.push({ host, url })
    if (targets.length >= ICON_WRITE_LIMIT) break
  }
  if (targets.length === 0) return

  const view = new WebContentsView({
    webPreferences: {
      partition: RENDER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const icons: { host: string; dataUri: string }[] = []
  try {
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event) => event.preventDefault())
    await view.webContents.loadURL('about:blank')
    for (const t of targets) {
      const r = await rasterize(view, t.url).catch((): Rasterized => ({ png: null }))
      if ('fetchFailed' in r) continue
      if (r.png) icons.push({ host: t.host, dataUri: r.png })
      else failed.add(t.url)
    }
  } finally {
    view.webContents.close()
  }
  // 描いている間にロックされた（トークンが無い）なら書かない（「ロックされています」をエラーとして残さない）
  if (icons.length === 0 || session.readOnly) return

  const result = await session.saveIcons(icons, { skipIds: gone })
  if (result.gone.length > 0) {
    for (const id of result.gone) gone.add(id)
    saveGone(gone)
  }
  log('kypr.icons_written', {
    targets: targets.length,
    drawn: icons.length,
    created: result.created.length,
    updated: result.updated.length,
    gone: result.gone.length
  })
}

/** 保管庫のアイコン（別の Mac の Nemo が書いたもの）。行のホスト（URL のホスト）から引く。 */
export function vaultIconFor(session: VaultSession | null, host: string | null): string | null {
  return session && host ? session.iconFor(iconHost(host)) : null
}
