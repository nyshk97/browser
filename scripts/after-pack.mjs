/**
 * dev 版から更新 feed を取り除く（electron-builder の `afterPack` フック）。
 *
 * electron-builder は `publish` を書いていなくても **git remote から GitHub を推測して**
 * `app-update.yml` を成果物に埋め込む。これが dev 版に入っていると、
 * dev で更新チェックが走った瞬間に常用版のビルドで dev が置き換わる。
 * `--config.publish=null` では打ち消せない（"null" という publisher を探して落ちる）ので、
 * **埋め込まれたものを署名より前に消す**。
 *
 * ここで消すので dmg の中身も揃う（`afterSign` でやると dmg には残ってしまう）。
 * 消えていることは `scripts/check-package.mjs` が成果物に対して検査する。
 */
import fs from 'node:fs'
import path from 'node:path'

export default async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return
  if (process.env['NEMO_BUILD_CHANNEL'] === 'stable') return

  const appName = packager.appInfo.productFilename
  const feed = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app-update.yml')
  if (fs.existsSync(feed)) {
    fs.rmSync(feed)
    console.log(`[after-pack] dev 版なので更新 feed を外した: ${feed}`)
  }
}
