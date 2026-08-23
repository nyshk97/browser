/**
 * `.dmg` の notarize + staple（electron-builder の `afterAllArtifactBuild` フック）。
 *
 * .app を公証しただけでは足りない。**dmg 自体にチケットが無いと、
 * ダウンロードした dmg を開く時点で Gatekeeper の警告が出る**
 * （0.1.0 を配った直後に `spctl` が `rejected: no usable signature` を返して分かった）。
 *
 * zip には staple できない（アーカイブ形式が対応していない）が、
 * 中の .app が staple 済みなので展開後は検証を通る。
 */
import { loadReleaseConfig } from './lib/release-config.mjs'
import { notarizeAndStaple, shouldNotarize } from './lib/notarize.mjs'

export default async function afterAllArtifactBuild(buildResult) {
  if (!shouldNotarize()) return []

  const dmgs = buildResult.artifactPaths.filter((artifact) => artifact.endsWith('.dmg'))
  if (dmgs.length === 0) return []

  const { notaryProfile } = loadReleaseConfig()
  for (const dmg of dmgs) notarizeAndStaple(dmg, notaryProfile)

  // 追加の artifact は無い（既存のパスを作り変えてもいない）
  return []
}
