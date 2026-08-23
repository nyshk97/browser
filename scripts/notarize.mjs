/**
 * `.app` の notarize + staple（electron-builder の `afterSign` フック）。
 *
 * **署名の直後・dmg / zip を作る前**に走る必要がある。ここで staple した .app が
 * そのまま dmg と zip に詰められるので、配る成果物すべてに公証のチケットが乗る。
 * dmg 自体への staple は `scripts/notarize-dmg.mjs`（`afterAllArtifactBuild`）で行う。
 *
 * 既定では**何もしない**。`NEMO_NOTARIZE=1` のときだけ実行する
 * （notarize は数分かかり keychain の資格情報も要るので、
 * 「署名が壊れていないか」だけ確かめたいときはここまで来ずに済ませたい）。
 */
import path from 'node:path'
import { loadReleaseConfig } from './lib/release-config.mjs'
import { notarizeAndStaple, shouldNotarize } from './lib/notarize.mjs'

export default async function notarizeHook(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  if (!shouldNotarize()) {
    console.log('[notarize] NEMO_NOTARIZE=1 でないので飛ばす（配布物には使えない）')
    return
  }

  const { notaryProfile } = loadReleaseConfig()
  notarizeAndStaple(path.join(appOutDir, `${packager.appInfo.productFilename}.app`), notaryProfile)
}
