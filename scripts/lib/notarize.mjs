/**
 * notarize + staple の共通処理。
 *
 * 対象は2つあり、**両方やらないと配布物として完結しない**:
 * - `.app`（`afterSign`）… これが無いと Gatekeeper に弾かれる
 * - `.dmg`（`afterAllArtifactBuild`）… これが無いと dmg を開く時点で警告が出る
 *   （中の .app が公証済みでも、dmg 自体にチケットが無ければ dmg の検証はオフラインで通らない）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {string} target 公証したいもの（.app か .dmg）
 * @param {string} notaryProfile keychain の notarytool プロファイル名
 */
export function notarizeAndStaple(target, notaryProfile) {
  if (!fs.existsSync(target)) throw new Error(`[notarize] 対象が無い: ${target}`)

  const isApp = target.endsWith('.app')
  // notarytool はディレクトリを受け取れないので、.app は ZIP に固めて出す。
  // **提出用の ZIP は配る ZIP とは別名・別の場所**に作る（未検証の中身が配布物の名前を占めないため）。
  const submitPath = isApp
    ? path.join(os.tmpdir(), `${path.basename(target, '.app')}-notarize-${process.pid}.zip`)
    : target

  try {
    if (isApp) {
      console.log(`[notarize] 提出用の ZIP を作る: ${submitPath}`)
      execFileSync('ditto', ['-c', '-k', '--keepParent', target, submitPath])
    }

    console.log(`[notarize] Apple に提出する（数分かかる）: ${path.basename(target)}`)
    const output = execFileSync(
      'xcrun',
      [
        'notarytool',
        'submit',
        submitPath,
        '--keychain-profile',
        notaryProfile,
        '--wait',
        '--output-format',
        'json'
      ],
      { encoding: 'utf8' }
    )

    const result = JSON.parse(output)
    console.log(`[notarize] status=${result.status} id=${result.id}`)
    if (result.status !== 'Accepted') {
      // 何が弾かれたかはログを見ないと分からない
      try {
        console.error(
          execFileSync('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', notaryProfile], {
            encoding: 'utf8'
          })
        )
      } catch (error) {
        console.error(`[notarize] ログを取得できなかった: ${error.message}`)
      }
      throw new Error(`[notarize] 公証が通らなかった（status=${result.status}）`)
    }

    console.log(`[notarize] チケットを staple する: ${path.basename(target)}`)
    execFileSync('xcrun', ['stapler', 'staple', target], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', target], { stdio: 'inherit' })
  } finally {
    if (isApp) fs.rmSync(submitPath, { force: true })
  }
}

/** このビルドで notarize するか（既定はしない）。 */
export function shouldNotarize() {
  return process.env['NEMO_NOTARIZE'] === '1'
}
