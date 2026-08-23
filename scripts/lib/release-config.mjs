/**
 * 配布に必要な「マシンではなく自分に紐づく値」の解決。
 *
 * **public repo なので Team ID も notarytool のプロファイル名も書かない**。
 * 解決の優先順は 環境変数 → `.release.local.json`（gitignore）→ keychain からの自動解決。
 *
 * `.release.local.json` の例:
 *   { "teamId": "XXXXXXXXXX", "notaryProfile": "..." }
 *
 * 新しい Mac での用意は README「リリース」を参照。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { projectRoot } from './harness.mjs'

const localConfigPath = path.join(projectRoot, '.release.local.json')

function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`.release.local.json を読めない: ${error.message}`, { cause: error })
  }
}

/**
 * Developer ID Application の署名 ID（`security` の出力そのままの共通名）。
 *
 * **見つからない・複数あって絞れないときは明示的に失敗させる**。
 * 空のまま electron-builder に渡すと、署名の失敗が不可解な形で後段に出る。
 */
export function resolveSigningIdentity(teamId) {
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  const all = [...output.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((m) => m[1])
  const candidates = teamId ? all.filter((name) => name.includes(`(${teamId})`)) : all

  if (candidates.length === 0) {
    throw new Error(
      teamId
        ? `Developer ID Application（Team ${teamId}）が keychain に無い`
        : 'Developer ID Application 証明書が keychain に無い'
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `Developer ID Application が複数ある。.release.local.json の teamId で絞る:\n  ${candidates.join('\n  ')}`
    )
  }
  return candidates[0]
}

/**
 * @param {{ notary?: boolean }} options `notary: false` なら notarytool の
 *   プロファイル名が無くても通す（署名だけして notarize しないビルド用）。
 */
export function loadReleaseConfig({ notary = true } = {}) {
  const local = readLocalConfig()
  const teamId = process.env['NEMO_TEAM_ID'] || local.teamId || null
  const notaryProfile = process.env['NEMO_NOTARY_PROFILE'] || local.notaryProfile || null

  if (notary && !notaryProfile) {
    throw new Error(
      'notarytool のプロファイル名が決まらない。' +
        '.release.local.json に {"notaryProfile": "..."} を書くか NEMO_NOTARY_PROFILE を渡す'
    )
  }

  return { teamId, notaryProfile, identity: resolveSigningIdentity(teamId) }
}
