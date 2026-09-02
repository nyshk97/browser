import fs from 'node:fs'
import path from 'node:path'
import { preloadDir } from './paths.js'
import { log, logError } from './log.js'

/**
 * ページ向け main world シム（`extension-shim.cjs` の http/https 分岐 =
 * `permissions.query` の「未決定 = prompt」読み替えと、WebAuthn の modal 要求の宙吊り対策
 * `src/shared/webauthn-shim.js`）をセッションに配る。
 *
 * 通常のページセッションには `extensions.ts` の `registerExtensionShim` が同じファイルを
 * 配っているのでこれを呼ぶ必要はない。**シークレットセッション用**:
 * 拡張は動かさないので service worker 向けの登録はせず、frame だけ配る
 * （`registerExtensionShim` を再利用すると service worker の登録とログが
 * 実態に合わないまま増える）。
 *
 * `extensions.ts` に置かないのは、`extensions.ts` → `registry.ts` の import が既にあり、
 * `ensurePrivateSession`（registry.ts）から呼ぶと循環 import になるため。
 */
export function registerPageShim(session: Electron.Session): void {
  const filePath = path.join(preloadDir, 'extension-shim.cjs')
  // パッケージの同梱漏れは `exists: false` のログで捕まえる（extensions.ts と同じ扱い）
  const exists = fs.existsSync(filePath)
  if (exists) {
    session.registerPreloadScript({ id: 'nemo-page-shim', type: 'frame', filePath })
  } else {
    logError('page.shim_missing', new Error('extension-shim.cjs が無い'), { path: filePath })
  }
  log('page.shim_registered', { exists })
}
