import { app } from 'electron'
import { log } from './log.js'
import { isNavigableUrl } from './security.js'
import { urlsFromArgv } from '../shared/navigation-policy.js'

/**
 * 外部アプリ（Slack・メール等）から渡された URL を開く（計画 2-5）。
 *
 * 押さえるところが3つある:
 *
 * 1. **`open-url` は `app.ready` より前に購読する**。macOS は未起動のアプリに URL を渡すとき、
 *    アプリの起動と同時にこのイベントを撃つ。ready を待ってから購読すると**起動時の URL を取りこぼす**
 *    （「Slack のリンクを踏んだら Nemo が空で立ち上がる」になる）。
 * 2. **準備できるまで queue する**。購読はできてもウィンドウはまだ無い。
 *    受け取った URL を溜めておき、準備完了後にまとめて流す。
 * 3. **起動済み / 未起動の両経路**を通す。起動済みなら `open-url` がそのまま来る。
 *    macOS 以外（と `open --args` 経由）では argv に URL が乗るので、そちらも見る。
 */

/** 準備完了までに届いた URL。 */
const pending: string[] = []

/** 準備完了後の受け皿。設定されるまでは queue に積む。 */
let target: ((url: string) => void) | null = null

/** 一度に溜め込む上限（暴発した外部アプリでメモリを食い潰さない）。 */
const MAX_PENDING = 32

function accept(url: string, source: string): void {
  // 外から渡された文字列。**必ず検証してから**扱う（`file:` や `javascript:` を通さない）
  if (!isNavigableUrl(url)) {
    log('open_url.rejected', { source })
    return
  }
  if (target) {
    log('open_url.handled', { source })
    target(url)
    return
  }
  if (pending.length >= MAX_PENDING) {
    log('open_url.dropped', { source, reason: 'queue_full' })
    return
  }
  pending.push(url)
  log('open_url.queued', { source, queued: pending.length })
}

/**
 * `app.ready` より**前**に呼ぶ。ここで購読しないと起動時の URL を取りこぼす。
 */
export function installOpenUrlHandler(): void {
  app.on('open-url', (event, url) => {
    // preventDefault しないと Electron の既定処理が走る
    event.preventDefault()
    accept(url, 'open-url')
  })

  // 未起動から argv 経由で来た分（macOS 以外や `open --args`）
  for (const url of urlsFromArgv(process.argv.slice(1))) accept(url, 'argv')
}

/** 2つ目のインスタンスが起動したときの argv（macOS 以外はこちらに URL が乗る）。 */
export function handleSecondInstance(argv: readonly string[]): boolean {
  const urls = urlsFromArgv(argv.slice(1))
  for (const url of urls) accept(url, 'second-instance')
  return urls.length > 0
}

/**
 * 受け皿を設定して、溜まっていた分を流す。
 * 起動時のウィンドウが揃ってから呼ぶ。
 */
export function flushOpenUrls(handler: (url: string) => void): void {
  target = handler
  const queued = pending.splice(0, pending.length)
  if (queued.length > 0) log('open_url.flushing', { count: queued.length })
  for (const url of queued) handler(url)
}
