#!/usr/bin/env node
/**
 * リリース（`mise run release [patch|minor|major|x.y.z]`、既定 patch）。
 *
 * ビルド → 署名 → notarize → staple → 成果物の検査 → GitHub Release → タグ、までを1コマンドにする。
 * **リリースの経路はこれ1つだけ**にする（手順を書き写したドキュメントは「第2のリリース経路」になり、
 * そちらを辿ると未署名のまま公開される）。
 *
 * 設計:
 * - **preflight で壊す前に全部検査する**。途中まで進んで失敗するのが一番厄介
 * - 「リリース済みか」の判定は必ず**リモート**に聞く（ローカルのタグは平気で嘘をつく）
 * - **対話を置かない**。セッションから無人で叩ける
 * - バージョン bump は**ビルドの前に commit** し、push 前に失敗したら巻き戻す
 * - Release は **draft で作ってから資産を上げ、最後に publish する**。
 *   draft の間はタグが実体化しないので、途中で落ちても「リリース物のないタグ」が残らない
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectRoot } from './lib/harness.mjs'
import { loadReleaseConfig } from './lib/release-config.mjs'
import { findSection, releaseSection, changelogPath } from './changelog.mjs'

const REPO = 'nyshk97/nemo'
const CHANNEL = 'stable'
const PRODUCT_NAME = 'Nemo'

const packageJsonPath = path.join(projectRoot, 'package.json')

function fail(message) {
  console.error(`\n[release] ${message}`)
  process.exit(1)
}

/** 失敗を呼び出し側で判別したいコマンド（`gh` の「無い」と「障害」の区別など）。 */
function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 失敗したらそこで止まるコマンド。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} が失敗した（exit ${result.status}）`)
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: projectRoot, encoding: 'utf8' }).trim()
}

/* ------------------------------------------------------------------ *
 * バージョン
 * ------------------------------------------------------------------ */

function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec
  const [major, minor, patch] = current.split('.').map(Number)
  if (spec === 'major') return `${major + 1}.0.0`
  if (spec === 'minor') return `${major}.${minor + 1}.0`
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`
  fail(`バージョンの指定が不正: ${spec}（patch / minor / major / x.y.z）`)
}

function today() {
  // ログや CHANGELOG の日付は手元の暦（JST）に合わせる
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

/* ------------------------------------------------------------------ *
 * preflight
 * ------------------------------------------------------------------ */

function preflight(version, tag) {
  console.log('=== preflight')

  if (process.platform !== 'darwin') fail('macOS でしか配布物を作れない')

  // 画面がロックされていると notarytool の資格情報（data-protection keychain）に届かない。
  // 署名だけは通るので「署名はできるのに notarize だけ落ちる」という分かりにくい失敗になる。
  const locked = tryRun('/bin/sh', [
    '-c',
    'ioreg -n Root -d1 -a | plutil -extract IOConsoleLocked xml1 -o - - 2>/dev/null'
  ])
  if (locked.stdout.includes('<true/>')) {
    fail('画面がロックされている。解除してからやり直す（notarize が資格情報に届かない）')
  }

  const auth = tryRun('gh', ['auth', 'status'])
  if (auth.code !== 0) fail(`gh の認証が通っていない:\n${auth.stderr}`)

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') fail(`main ブランチでリリースする（今: ${branch}）`)

  // 未追跡ファイルも含めて clean であること。
  // ビルド定義に入っている新規ファイルが未追跡だと、成果物には入るのにタグの commit には無い、
  // という乖離が起きる。
  const status = capture('git', ['status', '--porcelain'])
  if (status) fail(`作業ツリーが clean でない:\n${status}`)

  // 遅れたクローンで bump すると、同じバージョンを二重に切ろうとする
  run('git', ['fetch', 'origin', '--tags', '--quiet'])
  const head = capture('git', ['rev-parse', 'HEAD'])
  const remoteHead = capture('git', ['rev-parse', 'origin/main'])
  if (head !== remoteHead)
    fail(`HEAD が origin/main と違う（${head.slice(0, 7)} vs ${remoteHead.slice(0, 7)}）`)

  // CHANGELOG のゲート。空で叩かれたのは手順を飛ばしたサイン
  const changelog = fs.readFileSync(changelogPath, 'utf8')
  const unreleased = findSection(changelog, 'Unreleased')
  if (!unreleased?.body) fail('docs/CHANGELOG.md の [Unreleased] が空。リリースする内容を書いてからやり直す')
  if (findSection(changelog, version)) fail(`docs/CHANGELOG.md に [${version}] が既にある`)

  // 拡張は成果物に同梱されるので、lock とズレたまま配らない
  run(process.execPath, ['scripts/ext-verify.mjs'])

  // 署名と公証の資格情報（**ビルドを始める前に**確かめる）
  const { identity, notaryProfile } = loadReleaseConfig()
  console.log(`[release] 署名: ${identity}`)
  const notary = tryRun('xcrun', ['notarytool', 'history', '--keychain-profile', notaryProfile])
  if (notary.code !== 0) fail(`notarytool のプロファイル（${notaryProfile}）に届かない:\n${notary.stderr}`)

  /* ---- リリース済みかはリモートに聞く ---- */
  const remoteTag = tryRun('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  if (remoteTag.code !== 0) fail(`リモートのタグを確認できない（ネットワーク障害？）:\n${remoteTag.stderr}`)
  if (remoteTag.stdout.trim()) fail(`タグ ${tag} は既にリモートにある`)

  const release = tryRun('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName'])
  if (release.code === 0) fail(`Release ${tag} は既にある`)
  if (!/release not found|not found/i.test(release.stderr)) {
    // 「無い」と「gh が失敗した」を区別する。握りつぶすと既存 Release を見逃して進む
    fail(`Release の有無を確認できない（ネットワーク障害？）:\n${release.stderr}`)
  }

  console.log('[release] preflight OK')
  return { notaryProfile }
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

const spec = process.argv[2] ?? 'patch'
const currentVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
const version = nextVersion(currentVersion, spec)
const tag = `v${version}`

console.log(`=== Nemo ${currentVersion} → ${version} をリリースする`)
preflight(version, tag)

/** bump commit を作る前の HEAD（push 前に失敗したらここへ戻す）。 */
const baseCommit = capture('git', ['rev-parse', 'HEAD'])
let bumped = false
let draftCreated = false
const notesPath = path.join(os.tmpdir(), `nemo-release-notes-${process.pid}.md`)

try {
  /* ---- 1. bump（ビルドの前に commit する） ---- */
  // ビルド後に commit すると、成果物が dirty な作業ツリーから作られたことになり、
  // 「どの commit のビルドか」を一意に指せなくなる。
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  pkg.version = version
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  fs.writeFileSync(changelogPath, releaseSection(fs.readFileSync(changelogPath, 'utf8'), version, today()))
  run('git', ['add', 'package.json', 'docs/CHANGELOG.md'])
  run('git', ['commit', '-m', `chore(release): ${tag}`])
  bumped = true

  /* ---- 2. ビルド → 署名 → notarize → staple → 検査 ---- */
  console.log('\n=== ビルド（署名 + notarize つき。数分かかる）')
  run(process.execPath, ['scripts/package.mjs', CHANNEL], {
    env: { ...process.env, NEMO_SIGN: '1', NEMO_NOTARIZE: '1' }
  })

  /* ---- 3. 配る資産を集める ---- */
  const outDir = path.join(projectRoot, 'dist', CHANNEL)
  const assets = fs
    .readdirSync(outDir)
    .filter((name) => /\.(dmg|zip|blockmap)$/.test(name) || name === 'latest-mac.yml')
    .map((name) => path.join(outDir, name))

  const hasZip = assets.some((asset) => asset.endsWith('.zip'))
  const hasFeed = assets.some((asset) => asset.endsWith('latest-mac.yml'))
  const hasDmg = assets.some((asset) => asset.endsWith('.dmg'))
  if (!hasZip || !hasFeed || !hasDmg) {
    // zip と latest-mac.yml が無いと**アプリ内更新が動かない**（dmg だけでは更新できない）
    throw new Error(`配る資産が足りない（dmg=${hasDmg} zip=${hasZip} latest-mac.yml=${hasFeed}）`)
  }
  console.log(`\n=== 配る資産:\n  ${assets.map((a) => path.basename(a)).join('\n  ')}`)

  /* ---- 4. リリースノート ---- */
  const notes = findSection(fs.readFileSync(changelogPath, 'utf8'), version)
  if (!notes?.body) throw new Error(`CHANGELOG から [${version}] のノートを取り出せない`)
  fs.writeFileSync(notesPath, `${notes.body}\n`)

  /* ---- 5. push → draft Release → 資産 → publish（ここでタグが実体化する） ---- */
  console.log('\n=== push')
  run('git', ['push', 'origin', 'main'])

  console.log('=== GitHub Release を draft で作る')
  run('gh', [
    'release',
    'create',
    tag,
    '--repo',
    REPO,
    '--title',
    `${PRODUCT_NAME} ${version}`,
    '--notes-file',
    notesPath,
    '--target',
    capture('git', ['rev-parse', 'HEAD']),
    '--draft'
  ])
  draftCreated = true

  console.log('=== 資産をアップロードする')
  run('gh', ['release', 'upload', tag, '--repo', REPO, ...assets])

  console.log('=== Release を公開する（ここでタグが作られる）')
  run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false'])
  draftCreated = false

  // 公開されたタグを手元にも取り込む
  run('git', ['fetch', 'origin', '--tags', '--quiet'])

  const url = capture('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'url', '--jq', '.url'])
  console.log(`\n[release] 完了: ${PRODUCT_NAME} ${version}\n${url}`)
} catch (error) {
  console.error(`\n[release] 失敗: ${error.message}`)

  if (draftCreated) {
    console.error('[release] 作りかけの draft Release を消す')
    tryRun('gh', ['release', 'delete', tag, '--repo', REPO, '--yes'])
  }

  if (bumped) {
    const pushed = tryRun('git', ['rev-list', `origin/main..HEAD`, '--count'])
    if (pushed.stdout.trim() === '0') {
      console.error('[release] push 済みなので bump は巻き戻さない（手で直す）')
    } else {
      console.error(`[release] bump commit を巻き戻す（${baseCommit.slice(0, 7)} へ）`)
      tryRun('git', ['reset', '--hard', baseCommit])
    }
  }
  process.exitCode = 1
} finally {
  fs.rmSync(notesPath, { force: true })
}
