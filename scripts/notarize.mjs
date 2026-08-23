/**
 * notarize + staple（electron-builder の `afterSign` フック）。
 *
 * **署名の直後・dmg / zip を作る前**に走る必要がある。ここで staple した .app が
 * そのまま dmg と zip に詰められるので、配る成果物すべてに公証のチケットが乗る。
 *
 * 既定では**何もしない**。`NEMO_NOTARIZE=1` のときだけ実行する
 * （notarize は数分かかり keychain の資格情報も要るので、
 * 「署名が壊れていないか」だけ確かめたいときはここまで来ずに済ませたい）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadReleaseConfig } from './lib/release-config.mjs'

export default async function notarizeHook(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  if (process.env['NEMO_NOTARIZE'] !== '1') {
    console.log('[notarize] NEMO_NOTARIZE=1 でないので飛ばす（配布物には使えない）')
    return
  }

  const { notaryProfile } = loadReleaseConfig()
  const appName = packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) throw new Error(`[notarize] .app が無い: ${appPath}`)

  // 提出用の ZIP は **配る ZIP とは別名・別の場所**に作る。
  // 途中で失敗したときに、未検証の中身が配布物の名前を一瞬でも占めないようにするため。
  const zipPath = path.join(os.tmpdir(), `${appName}-notarize-${process.pid}.zip`)

  try {
    console.log(`[notarize] 提出用の ZIP を作る: ${zipPath}`)
    execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath])

    console.log('[notarize] Apple に提出する（数分かかる）…')
    const output = execFileSync(
      'xcrun',
      [
        'notarytool',
        'submit',
        zipPath,
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
        const log = execFileSync(
          'xcrun',
          ['notarytool', 'log', result.id, '--keychain-profile', notaryProfile],
          { encoding: 'utf8' }
        )
        console.error(log)
      } catch (error) {
        console.error(`[notarize] ログを取得できなかった: ${error.message}`)
      }
      throw new Error(`[notarize] 公証が通らなかった（status=${result.status}）`)
    }

    console.log('[notarize] チケットを .app に staple する')
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
    console.log(`[notarize] 完了: ${appPath}`)
  } finally {
    // 提出用 ZIP は必ず片付ける（残すと次回の成果物と紛らわしい）
    fs.rmSync(zipPath, { force: true })
  }
}
