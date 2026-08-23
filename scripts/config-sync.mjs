#!/usr/bin/env node
/**
 * 設定同期の CLI（計画 2-1）。手動トリガーで動かす。
 *
 *   node scripts/config-sync.mjs init [--repo <url>]
 *   node scripts/config-sync.mjs status [--channel stable|dev]
 *   node scripts/config-sync.mjs push   [--channel ...] [--message <text>]
 *   node scripts/config-sync.mjs pull   [--channel ...] [--dry-run]
 *   node scripts/config-sync.mjs restore [--channel ...] [--backup <stamp>]
 *
 * 同期するのは設定・ピン留め / Favorites（キーバインドは設定に含まれる）。
 * 履歴・セッション・権限・ダウンロードは端末ローカルなので同期しない。
 * 拡張の lock は**参照用の写し**だけ置く（source of truth はアプリ同梱の lock）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { REFERENCE_FILES, SYNCED_FILES } from '../src/shared/sync-schema.js'
import {
  DEFAULT_REPO,
  aheadBehind,
  assertNotRunning,
  assertStaging,
  backupLiveData,
  backupsDir,
  buildSnapshot,
  currentBranch,
  diffAgainstStaging,
  fetchOrigin,
  git,
  hasRemote,
  headCommit,
  importPayloads,
  listBackups,
  localConfigPath,
  managedFiles,
  projectRoot,
  readBase,
  readLocalConfig,
  remoteHead,
  repoUrl,
  restoreBackup,
  stagingDir,
  stagingExists,
  syncHome,
  timestamp,
  unmanagedChanges,
  unmergedPaths,
  userDataDirFor,
  validateStaging,
  writeBase,
  writeLocalConfig
} from './lib/config-sync.mjs'

const args = process.argv.slice(2)
const command = args[0] ?? 'status'

function flag(name) {
  return args.includes(`--${name}`)
}

function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const channel = option('channel', 'stable')
if (channel !== 'dev' && channel !== 'stable') {
  console.error(`[config-sync] --channel は dev / stable のみ (${channel})`)
  process.exit(1)
}

function info(message) {
  console.log(`[config-sync] ${message}`)
}

/** 例外を人が読める形にする（cause の連鎖まで出す。原因が消えると調べようがない）。 */
function describe(error) {
  const parts = []
  let current = error
  while (current) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : null
  }
  return parts.join('\n  原因: ')
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

/**
 * origin を取り直す。
 * **失敗は握りつぶさない**（古い追跡情報で「最新」と判断して古い JSON を入れないため）。
 * ネットワークが無いと分かっていて手元の staging をそのまま使いたいときだけ `--offline`。
 */
function syncWithOrigin(what) {
  if (!hasRemote()) {
    info('origin が無いので手元の staging をそのまま使う')
    return false
  }
  if (flag('offline')) {
    info('--offline: origin を取りに行かない（手元の staging をそのまま使う）')
    return false
  }
  try {
    fetchOrigin()
  } catch (error) {
    throw new Error(
      `origin を取得できないので ${what} を中止する。\n` +
        '  ネットワークや認証を確認する。手元の staging をそのまま使うなら --offline を付ける。',
      { cause: error }
    )
  }
  return true
}

/** 未解決のコンフリクトがある間は import も push もしない。 */
function assertNoConflict() {
  const unmerged = unmergedPaths()
  if (unmerged.length === 0) return
  throw new Error(
    `同期リポジトリにコンフリクトが残っている:\n` +
      unmerged.map((file) => `    ${file}`).join('\n') +
      `\n  ${stagingDir()} で git を使って解決する:\n` +
      `    cd '${stagingDir()}'\n` +
      '    git status                  # どのファイルが競合しているか見る\n' +
      '    # 中身を直してから\n' +
      '    git add -A && git commit\n' +
      '  解決するまで pull / push は動かない（競合した JSON をアプリに読ませないため）。'
  )
}

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */

function cmdInit() {
  const url = option('repo', repoUrl())
  fs.mkdirSync(syncHome(), { recursive: true })

  if (stagingExists()) {
    info(`作業コピーは既にある: ${stagingDir()}`)
    const current = git(['remote', 'get-url', 'origin'], { allowFail: true })
    if (current && current !== url) {
      git(['remote', 'set-url', 'origin', url])
      info(`origin を ${url} に張り替えた`)
    }
  } else {
    info(`clone: ${url}`)
    try {
      execFileSync('git', ['clone', url, stagingDir()], { stdio: 'inherit' })
    } catch {
      // 空リポジトリだと clone に失敗することがある（warning のみで成功する版もある）。
      // 手元で作って origin を張るところまでやれば push で追いつける。
      info('clone できなかったので、空の作業コピーを作って origin だけ張る')
      fs.mkdirSync(stagingDir(), { recursive: true })
      git(['init', '-b', 'main'], { cwd: stagingDir() })
      git(['remote', 'add', 'origin', url])
    }
  }

  const config = { ...readLocalConfig(), repo: url }
  writeLocalConfig(config)
  info(`手元の設定: ${localConfigPath()}`)

  const readme = path.join(stagingDir(), 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# nemo-config',
        '',
        'Nemo（自作ブラウザ）の設定同期用リポジトリ。**private のまま運用する**。',
        '',
        '- `settings.json` … 設定（キーバインドを含む）',
        '- `pins.json` … ピン留め / Favorites',
        '- `extensions.lock.json` … 拡張の lock の**写し**（参照用。source of truth はアプリ同梱の lock）',
        '- `manifest.json` … 同期スキーマの版と更新時刻',
        '',
        '直接編集してもよいが、`git` で競合を解決してから Nemo 側で pull すること。',
        '',
        '```bash',
        'mise run config:pull   # このリポジトリ → 常用データ',
        'mise run config:push   # 常用データ → このリポジトリ',
        '```',
        ''
      ].join('\n')
    )
    info('README.md を置いた（まだ commit はしていない）')
  }

  info('done. 次は mise run config:push で今の設定を上げる')
}

/* ------------------------------------------------------------------ *
 * status
 * ------------------------------------------------------------------ */

function cmdStatus() {
  const userDataDir = userDataDirFor(channel)
  console.log(`  channel      : ${channel}`)
  console.log(`  常用データ   : ${userDataDir}${fs.existsSync(userDataDir) ? '' : '（まだ無い）'}`)
  console.log(`  staging      : ${stagingDir()}${stagingExists() ? '' : '（まだ無い）'}`)
  console.log(`  同期リポジトリ: ${repoUrl()}${repoUrl() === DEFAULT_REPO ? '（既定）' : ''}`)

  if (!stagingExists()) {
    console.log('\n  → mise run config:init で作業コピーを用意する')
    return
  }

  const unmerged = unmergedPaths()
  if (unmerged.length > 0) {
    console.log(`\n  ⚠ コンフリクト中: ${unmerged.join(', ')}`)
    console.log('    解決するまで pull / push は動かない')
  }

  const dirty = git(['status', '--porcelain=v1'], { allowFail: true }) ?? ''
  const branch = currentBranch()
  console.log(`  branch       : ${branch}`)
  if (hasRemote()) {
    const tracking = aheadBehind()
    if (tracking) console.log(`  origin       : ahead ${tracking.ahead} / behind ${tracking.behind}`)
    else console.log('  origin       : 追跡ブランチがまだ無い（初回 push 前）')
  } else {
    console.log('  origin       : 未設定')
  }
  console.log(`  未コミット   : ${dirty ? dirty.split('\n').length + ' 件' : 'なし'}`)

  const unmanaged = unmanagedChanges()
  if (unmanaged.length > 0) console.log(`  ⚠ 管理外の変更: ${unmanaged.join(', ')}（push は止まる）`)

  // 「別の端末の変更を消さずに push できるか」
  const base = readBase(channel)
  const remote = hasRemote() ? remoteHead(branch) : null
  console.log(
    `  最後に同期   : ${base ? base.slice(0, 8) : '（未同期）'}` +
      (remote ? ` / origin: ${remote.slice(0, 8)}` : '')
  )
  if (remote && base !== remote) {
    console.log(`    → 先に mise run config:pull ${channel}（このままでは push できない）`)
  }

  const differs = diffAgainstStaging(userDataDir, stagingDir())
  console.log('\n  常用データ vs staging:')
  for (const spec of SYNCED_FILES) {
    const changed = differs.includes(spec.name)
    console.log(`    ${changed ? '差分あり' : '同じ    '}  ${spec.name}  (${spec.label})`)
  }

  // 拡張の lock は import しないが、2台で版がズレていたら必ず気づけるようにする
  for (const ref of REFERENCE_FILES) {
    const staged = readJson(path.join(stagingDir(), ref.name))
    const local = readJson(path.join(projectRoot, ref.name))
    if (!staged || !local) continue
    const versionOf = (lock) =>
      (lock.extensions ?? []).map((entry) => `${entry.name} ${entry.version}`).join(', ')
    const same = versionOf(staged) === versionOf(local)
    console.log(`\n  ${ref.label}: ${same ? '一致' : '不一致'}`)
    console.log(`    staging: ${versionOf(staged) || '（無し）'}`)
    console.log(`    手元   : ${versionOf(local) || '（無し）'}`)
    if (!same) console.log('    → 片方の Nemo が古い。両方を同じ版に更新してから使う')
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * push
 * ------------------------------------------------------------------ */

function cmdPush() {
  assertStaging()
  assertNoConflict()
  const fetched = syncWithOrigin('push')

  const branch = currentBranch()
  const remote = fetched ? remoteHead(branch) : null
  const base = readBase(channel)

  // **origin が進んでいたら push しない**。
  // ここを通すと、別の Mac の変更を「無競合の正常なコミット」として消せてしまう
  // （staging を ff してから古い常用データで上書きするため）。
  if (remote) {
    if (base === null) {
      throw new Error(
        `この端末の ${channel} はまだ一度も同期していないのに、origin には内容がある。\n` +
          `  先に取り込む: mise run config:pull ${channel}\n` +
          '  （取り込まずに push すると、別の端末の変更を消す）'
      )
    }
    if (base !== remote) {
      throw new Error(
        `origin が進んでいる（この端末が最後に同期したのは ${base.slice(0, 8)} / origin は ${remote.slice(0, 8)}）。\n` +
          `  先に取り込む: mise run config:pull ${channel}`
      )
    }
  }

  // 管理外のファイルを巻き込まない（手で置いたものまで commit しない）
  const unmanaged = unmanagedChanges()
  if (unmanaged.length > 0) {
    throw new Error(
      '同期が管理していないファイルが staging で変更されている:\n' +
        unmanaged.map((file) => `    ${file}`).join('\n') +
        `\n  ${stagingDir()} で commit するか元に戻してから push し直す。\n` +
        `  同期が扱うのは ${managedFiles().join(' / ')} だけ。`
    )
  }

  const userDataDir = userDataDirFor(channel)
  if (!fs.existsSync(userDataDir)) {
    throw new Error(`常用データが無い: ${userDataDir}（その channel の Nemo をまだ起動していない）`)
  }

  const files = buildSnapshot(userDataDir, { appVersion: appVersion() })

  // manifest は **中身が変わったときだけ**書く。
  // `updatedAt` を毎回書くと差分が必ず出て、内容が同じでも空コミットが積み上がる。
  const manifest = files.find((file) => file.name === 'manifest.json')
  for (const file of files) {
    if (file === manifest) continue
    fs.writeFileSync(path.join(stagingDir(), file.name), file.text)
    if (file.missing) info(`${file.name} が常用データに無いので既定値で書き出した`)
  }

  const dirty = git(['status', '--porcelain=v1'], { allowFail: true }) ?? ''
  if (!dirty) {
    info('差分なし。何も commit しなかった')
    // 内容が同じなら「この commit と一致している」と記録してよい
    const head = headCommit()
    if (head) writeBase(channel, head)
    return
  }
  if (manifest) fs.writeFileSync(path.join(stagingDir(), manifest.name), manifest.text)

  // 管理対象だけを add する（`-A` にしない）
  git(['add', '--', ...managedFiles()])
  const message = option('message', `chore(config): ${channel} の設定を同期`)
  git(['commit', '-m', message])
  info(`commit: ${message}`)

  if (!hasRemote()) {
    info('origin が無いので push しなかった（mise run config:init で設定する）')
    const local = headCommit()
    if (local) writeBase(channel, local)
    return
  }
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: stagingDir(), stdio: 'inherit' })
  info('push した')
  const head = headCommit()
  if (head) writeBase(channel, head)
}

/* ------------------------------------------------------------------ *
 * pull
 * ------------------------------------------------------------------ */

function cmdPull() {
  assertStaging()
  const dryRun = flag('dry-run')
  if (!dryRun) assertNotRunning(channel, 'config:pull')
  assertNoConflict()

  if (syncWithOrigin('pull')) {
    const tracking = aheadBehind()
    if (tracking && tracking.behind > 0) {
      const merged = git(['merge', '--ff-only', tracking.upstream], { allowFail: true })
      if (merged === null) {
        throw new Error(
          `origin と手元の staging が分岐していて fast-forward できない。\n` +
            `  ${stagingDir()} で git を使って解決する:\n` +
            `    cd '${stagingDir()}' && git pull --rebase\n` +
            '  解決したら config:pull をやり直す。'
        )
      }
      info(`staging を更新した（${tracking.behind} コミット）`)
    } else {
      info('staging は最新')
    }
  }

  // 検証を全部通してから初めて常用データに触る
  const { manifest, payloads } = validateStaging(stagingDir())
  info(`検証 OK（syncSchemaVersion ${manifest.syncSchemaVersion} / 更新 ${manifest.updatedAt || '不明'}）`)

  const userDataDir = userDataDirFor(channel)
  const differs = diffAgainstStaging(userDataDir, stagingDir())
  const head = headCommit()

  if (differs.length === 0) {
    info('常用データは staging と同じ。import は不要')
    // 内容が一致しているなら、この commit を見たものとして記録する。
    // ここで記録しないと push が永久に「先に pull しろ」と言い続ける。
    if (!dryRun && head) writeBase(channel, head)
    return
  }
  info(`import 対象: ${differs.join(', ')}`)

  if (dryRun) {
    info('--dry-run なので書き込まなかった')
    return
  }

  const stamp = timestamp()
  const backup = backupLiveData(userDataDir, stamp, { channel, kind: 'pull' })
  info(`バックアップ: ${backup.dir}`)
  try {
    importPayloads(userDataDir, payloads)
  } catch (error) {
    restoreBackup(backup.dir, { expectedUserDataDir: userDataDir, expectedChannel: channel })
    throw new Error('import に失敗したのでバックアップから戻した', { cause: error })
  }
  if (head) writeBase(channel, head)
  info('import した。Nemo を起動すると反映される')
  info(`戻したいときは: node scripts/config-sync.mjs restore --channel ${channel} --backup pull-${stamp}`)
}

/* ------------------------------------------------------------------ *
 * restore
 * ------------------------------------------------------------------ */

function cmdRestore() {
  assertNotRunning(channel, 'config:restore')
  const userDataDir = userDataDirFor(channel)
  // その channel の pull バックアップだけを対象にする。
  // 用途も channel も混ぜると、**別のプロファイルを上書きしうる**。
  const backups = listBackups(channel, 'pull')
  if (backups.length === 0) {
    throw new Error(`${channel} の pull バックアップが無い（${backupsDir(channel)}）`)
  }
  const stamp = option('backup', backups[0])
  const dir = path.join(backupsDir(channel), stamp)
  if (!fs.existsSync(path.join(dir, 'backup.json'))) {
    throw new Error(`そのバックアップが無い: ${stamp}\n  ある分: ${backups.slice(0, 10).join(', ')}`)
  }
  // 戻し先は必ず突き合わせる（backup.json の値を鵜呑みにしない）
  const meta = restoreBackup(dir, { expectedUserDataDir: userDataDir, expectedChannel: channel })
  info(`${meta.userDataDir} を ${stamp} の状態に戻した`)
}

/* ------------------------------------------------------------------ *
 * 実行
 * ------------------------------------------------------------------ */

const COMMANDS = { init: cmdInit, status: cmdStatus, push: cmdPush, pull: cmdPull, restore: cmdRestore }

try {
  const run = COMMANDS[command]
  if (!run) {
    console.error(`[config-sync] 不明なコマンド: ${command}`)
    console.error(`  使える: ${Object.keys(COMMANDS).join(' / ')}`)
    process.exit(1)
  }
  run()
} catch (error) {
  console.error(`[config-sync] ${describe(error)}`)
  process.exit(1)
}
