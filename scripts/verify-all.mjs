#!/usr/bin/env node
/**
 * 自走検証を一括で通す（`mise run verify`）。
 *
 *   ユニットテスト → ビルド → 拡張の照合 → ページサーバ → アプリ起動 →
 *   verify-spike → verify-phase1 → verify-phase2 → verify-pins → verify-switcher →
 *   verify-peek → 再起動をまたぐ永続性 → 旧版セッションからの移行 →
 *   履歴 DB の列追加 → 後片付け
 *
 * **`verify-vim-scroll`（gg / G）・`verify-slots`（セーブスロット）・
 * `verify-auth-vault`（Basic 認証の保管庫）は既定から外れている**（`OPT_IN_ONLY`）。
 * 名指し（`--only`）か `--changed` で選ばれたときだけ回る。
 * `vim-scroll` は `http-auth` の後・`restart` の前、`slots` と `auth-vault` は最後（`db` の後）に入る。
 *
 * 終了コードがそのまま合否になるので CI にも載せられる。
 *
 * `--only <名前...>` で回すものを絞れる（`mise run verify:only phase1 pins`）。
 * **1か所直して確かめ直す**ループで無関係な検証まで毎回回すと1回3分かかるが、
 * 関係するものだけなら十数秒で済む。絞ったときは**何を飛ばしたかを必ず出す**
 * （出さないと「フルで通った」と読み違える）。
 *
 * `--changed` は作業ツリーの差分から回すものを**自動で選ぶ**（`mise run verify:changed`）。
 * 逆引きは `scripts/lib/verify-targets.mjs`。担当が確定しないファイルはフルに倒し、
 * 「無関係と分かっている」パス（`docs/**` など）だけの変更は**回さずに正常終了**する。
 * 決めた集合と理由は必ず標準出力に出す（黙って絞ると「速いけど何も見ていない」に化ける）。
 *
 * 検証対象の取り違えを防ぐための決まりごと:
 * - ポートは毎回空きを採番する（固定ポートだと別プロセスを検証して PASS しうる。実際に踏んだ）
 * - 採番したエンドポイントは verify-spike に env で明示的に渡す
 * - 起動した子プロセスが生きていること・**自分が起動したサーバ**であることを確認してから進む
 * - 次の段へ進む前に、止めた子プロセスの**終了を待つ**（固定 sleep で進まない）
 * - データディレクトリは使い捨て（実 Vault の入ったプロファイルで CDP を開けない）
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNemoNotRunning,
  findUncaughtExceptions,
  getFreePort,
  isChildAlive,
  projectRoot,
  stopChildren,
  waitForHttp
} from './lib/harness.mjs'
import { KNOWN_TARGETS, NEEDS_APP, OPT_IN_ONLY, selectVerifyTargets } from './lib/verify-targets.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const onlyAt = process.argv.indexOf('--only')
const useChanged = process.argv.includes('--changed')
const only = new Set(
  onlyAt === -1 ? [] : process.argv.slice(onlyAt + 1).filter((arg) => !arg.startsWith('--'))
)
if (onlyAt !== -1 && useChanged) {
  console.error('[verify] --only と --changed は同時に指定できない（どちらが効いたか分からなくなる）')
  process.exit(2)
}
if (onlyAt !== -1 && only.size === 0) {
  console.error(`[verify] --only には回すものを渡す。使えるのは: ${KNOWN_TARGETS.join(' / ')}`)
  process.exit(2)
}
const unknown = [...only].filter((name) => !KNOWN_TARGETS.includes(name))
if (unknown.length > 0) {
  console.error(`[verify] 知らない検証名: ${unknown.join(', ')}\n  使えるのは: ${KNOWN_TARGETS.join(' / ')}`)
  process.exit(2)
}

/**
 * 作業ツリーの差分（未 commit + staged + untracked）。
 *
 * main 直コミット運用なのでコミット直後は必ず空になるが、それは
 * 「回すものが無い → 回さずに正常終了（理由: 変更なし）」で受ける。
 */
function collectChangedFiles() {
  const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).split('\n')
  return [
    ...git(['diff', '--name-only']),
    ...git(['diff', '--cached', '--name-only']),
    ...git(['ls-files', '--others', '--exclude-standard'])
  ].filter((line) => line.length > 0)
}

/**
 * `--changed` が絞れずフルに倒れたか。
 *
 * **`only` を埋めて表すのはやめる**（絞っていないのに「絞っている」表示になり、
 * `回さない: ` が空で尻切れになる）。フラグで持って `want()` だけを素通しにする。
 * ここを素通しにしないと、`registry.ts` のような `OWNERS` 外のファイル
 * ＝**その機能の配線を直したときに限って** `OPT_IN_ONLY` のスイートが一度も回らない。
 */
let changedFull = false

if (useChanged) {
  const changed = collectChangedFiles()
  const selection = selectVerifyTargets(changed)
  if (selection.kind === 'none') {
    // **回さずに正常終了**。前段（ユニットテスト / ビルド / 拡張の照合）も飛ばす。
    // 「変更ゼロ」も「無関係パスだけ」も**同じ結論**にする（分けると変更量に対して非単調になる）。
    console.log(`=== 自走検証: 回すものが無い（${selection.reason}）`)
    console.log('（コミット前のフルは mise run verify で回す）')
    process.exit(0)
  }
  if (selection.kind === 'full') {
    console.log(`[verify] --changed: 絞れないのでフルを回す（引き金: ${selection.triggers.join(', ')}）`)
    changedFull = true
  } else {
    console.log(`[verify] --changed: ${selection.reason} → ${selection.targets.join(' ')}`)
    for (const name of selection.targets) only.add(name)
  }
}

/**
 * その検証を回すか（`--only` も `--changed` も絞っていなければ全部回す）。
 *
 * ただし `OPT_IN_ONLY` のものは**既定から外れる**（名指ししたときだけ回る）。
 * `--changed` は選んだ名前を `only` に足してからここへ来るので、素通しでよい。
 */
const want = (name) => (only.size === 0 ? changedFull || !OPT_IN_ONLY.includes(name) : only.has(name))
if (only.size === 0 && !changedFull && OPT_IN_ONLY.length > 0) {
  // **黙って外さない。** 出さないと「回っているつもり」にも「勝手に回り始めた」にも気づけない。
  console.log(`[verify] 既定から外している: ${OPT_IN_ONLY.join(' ')}（回すなら --only で名指しする）`)
}
const needsApp = NEEDS_APP.some(want)
/** 絞り込みの出所（ログを読んだ人が `--only` と `--changed` を取り違えないため）。 */
const scopeFlag = useChanged ? '--changed' : '--only'

const debugPort = String(await getFreePort())
const pagesPort = String(await getFreePort())
/**
 * Live Folder の差し替え先。**GitHub には実際に繋がない。**
 * ポートは毎回採番し、`verify-live-folder.mjs` が同じポートで待ち受ける。
 */
const githubPort = String(await getFreePort())
const githubEndpoint = `http://127.0.0.1:${githubPort}/graphql`
const cdp = `http://127.0.0.1:${debugPort}`
const pages = `http://127.0.0.1:${pagesPort}`
/**
 * 会議として扱う URL の差し替え口（会議の小窓の検証）。
 *
 * **URL の prefix 単位**にする。origin 単位にすると `test-pages/` は単一ポートから
 * 配信されているので `index.html` や `login.html` まで会議候補になり、
 * フル検証のあいだじゅう縮退した小窓が出て他の検証に干渉する（計画 R11）。
 * 値は**採番済みのポートから組む**（固定値を書かない）。
 */
const meetPrefix = `${pages}/meet-fake.html`

/**
 * 自走検証のあいだだけ縮める「見に行く周期 / デバウンス」（`src/shared/timings.js` の既定値を上書き）。
 *
 * **検証値を決めるのはここ 1 か所**。アプリにも検証スクリプトにも同じ JSON を渡し、
 * 検証スクリプト側は `scripts/lib/timings.mjs` でこれを**読み戻して**待ちを組む
 * （決め打ちにすると、アプリを手で起動して単独で回す経路で待ちが本番値より短くなる）。
 *
 * 縮めてよいのは「いつ判定するか」だけを変えるものに限る。閾値そのもの
 * （`tabSleepMinutes` / `tabArchiveHours`）と保険のタイムアウト（`PEEK_PLACEHOLDER_TIMEOUT`）は
 * 判定の中身が変わる / 正常系が保険経路にすり替わるので**含めない**。
 */
const verifyTimings = JSON.stringify({
  sleepSweepMs: 500,
  sessionSaveDebounceMs: 300,
  sessionStoreDebounceMs: 200,
  // Live Folder の待ちは verify 全体で最も長かった（自動取得 61s + バックオフ観測 27s）。
  // **poll と tick の比（本番 1:12）は保つ** —— tick と同オーダーにすると
  // 「取得中に起きたタイマーの要求を捨てる」の検証が撃てなくなる
  liveFolderPollMs: 12_000,
  liveFolderTickMs: 1_000,
  // バックオフは失敗したときにしか効かないので、poll より深く縮めても副作用が無い
  liveFolderBackoffMinMs: 6_000,
  // パスワードの再マスク（実時間 30 秒を待たない）と、自動入力の直列化の保険
  httpAuthRevealMs: 1_500,
  httpAuthWatchdogMs: 2_000
})

/**
 * 自走検証は CDP を開けるので、**実 Vault の入ったプロファイルでは絶対に回さない**。
 * 使い捨てのデータディレクトリを毎回作って、そこで完結させる。
 */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-verify-'))
/** ダウンロードの検証で実際の ~/Downloads を汚さないための保存先。 */
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-verify-dl-'))

/**
 * 起動した子プロセスは**一度入れたら外さない**。
 * 「止める前に配列から外す」と、途中の停止に失敗したときに
 * 最後の後片付けが空配列を見て成功扱いになり、
 * **まだ使われている一時ディレクトリを消してしまう**。
 * 後片付けしてよいかは、常に生存状態そのものから判断する。
 * @type {import('node:child_process').ChildProcess[]}
 */
const spawned = []

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
  spawned.push(child)
  return child
}

function runToCompletion(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit', ...options })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** 生きている子をすべて止め、**終了を待つ**（固定 sleep だとポート再利用や一時ディレクトリ削除と競合する）。 */
async function stopAll() {
  await stopChildren(spawned.filter(isChildAlive))
}

/** ページサーバを起動し、**自分が起動したもの**が応答することを確認する。 */
async function startPagesServer() {
  const child = start(process.execPath, ['scripts/test-server.mjs'], {
    env: { ...process.env, PORT: pagesPort },
    stdio: 'ignore'
  })
  await waitForHttp(`${pages}/__nemo_test_pages__`, {
    child,
    check: async (res) => (await res.text()).startsWith(`nemo-test-pages ${child.pid}`)
  })
  return child
}

async function startApp() {
  const child = start(electronPath, ['out/main/index.js'], {
    env: {
      ...process.env,
      NEMO_REMOTE_DEBUGGING_PORT: debugPort,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: downloadDir,
      // **アプリ側へ渡すのがここ**。検証スクリプトにだけ渡しても届かない
      NEMO_MEET_TEST_URL_PREFIX: meetPrefix,
      // Live Folder は起動直後に取得しに行くので、**フル検証の間は必ずローカルへ向ける**
      // （向けないと自走検証が実 GitHub を叩く）。
      // 認証は `stored-only`（PAT の保存 / 削除で「未設定 → 取得 → 未設定」を同一プロセスで踏める）
      NEMO_GITHUB_TEST_ENDPOINT: githubEndpoint,
      NEMO_GITHUB_TEST_AUTH: 'stored-only',
      /*
       * **HTTP 認証の暗号化を Keychain に触らない backend に差し替える。**
       * 実 `safeStorage` に触ると macOS が `SecurityAgent` を上げ、
       * 自走検証が**永久に止まる**（このリポジトリで PAT のときに踏んでいる）。
       * 実際の暗号化経路は人間の動作確認に分ける（`VERIFY.md` の PAT と同じ作法）。
       */
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      // 分割ビューの検証は View の bounds を外から測れないので、
      // main に実測値を出す口を生やす。**`--only` に依存させない**
      // （条件分岐にすると「フルでは通るのに絞ると落ちる」を作る）。
      NEMO_VERIFY_DIAGNOSTICS: '1',
      // 待ちの本体である「見に行く周期」を検証中だけ縮める。
      // **`runVerify` にも同じ値を渡す**（検証側は読み戻して待ちを組む）。同じく `--only` 非依存
      NEMO_VERIFY_TIMINGS: verifyTimings
    }
  })
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => {
      const list = await res.json()
      // UI は nemo://ui/ から配信される（file:// ではない）
      return list.some((t) => t.url.startsWith('nemo://ui/'))
    }
  })
  return child
}

/** 検証スクリプトには採番したエンドポイントを必ず明示的に渡す。 */
const runVerify = (script, args = []) =>
  runToCompletion(process.execPath, [script, ...args], {
    // **userData も渡す**。診断ログ・session.json を読む検証（Peek / 小窓）が
    // 「どのプロファイルを見ればよいか」を知る手段がこれしか無い。
    env: {
      ...process.env,
      NEMO_CDP: cdp,
      NEMO_TEST_PAGES: pages,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_DOWNLOAD_DIR: downloadDir,
      NEMO_MEET_TEST_URL_PREFIX: meetPrefix,
      NEMO_GITHUB_TEST_ENDPOINT: githubEndpoint,
      // **アプリに渡すだけでは届かない**。検証スクリプトは別の env で起動されるので、
      // ここにも同じ値を載せる（載せ忘れると verify だけ本番値で待ち、無駄に遅くなる）
      NEMO_VERIFY_TIMINGS: verifyTimings
    }
  })

const spike = (args) => runVerify('scripts/verify-spike.mjs', args)
const phase1 = (args) => runVerify('scripts/verify-phase1.mjs', args)
const phase2 = (args) => runVerify('scripts/verify-phase2.mjs', args)
const pins = (args) => runVerify('scripts/verify-pins.mjs', args)
const switcher = (args) => runVerify('scripts/verify-switcher.mjs', args)
const peek = (args) => runVerify('scripts/verify-peek.mjs', args)
const split = (args) => runVerify('scripts/verify-split.mjs', args)
const call = (args) => runVerify('scripts/verify-call.mjs', args)
const liveFolder = (args) => runVerify('scripts/verify-live-folder.mjs', args)
const httpAuth = (args) => runVerify('scripts/verify-http-auth.mjs', args)
const vimScroll = (args) => runVerify('scripts/verify-vim-scroll.mjs', args)

let exitCode = 0
try {
  assertNemoNotRunning('verify')
  console.log(`（CDP ${cdp} / テストページ ${pages} / userData ${userDataDir}）`)
  if (only.size > 0) {
    const skipped = KNOWN_TARGETS.filter((name) => !only.has(name))
    console.log(`（${scopeFlag} ${[...only].join(' ')} … 回さない: ${skipped.join(' ')}）`)
  }

  console.log('\n=== ユニットテスト')
  if ((await runToCompletion(process.execPath, ['--test', 'scripts/*.test.mjs'])) !== 0) {
    throw new Error('ユニットテスト失敗')
  }

  console.log('\n=== ビルド')
  if ((await runToCompletion('pnpm', ['exec', 'electron-vite', 'build'])) !== 0) {
    throw new Error('ビルド失敗')
  }

  console.log('\n=== 拡張の照合')
  if ((await runToCompletion(process.execPath, ['scripts/ext-verify.mjs'])) !== 0) {
    throw new Error('拡張が lock と一致しない')
  }

  if (needsApp) {
    console.log('\n=== ページサーバ')
    await startPagesServer()

    console.log('=== Nemo 起動')
    await startApp()
  }

  if (want('spike')) {
    console.log('\n=== 自走検証（Phase 0: 拡張）')
    const spikeCode = await spike([])
    if (spikeCode !== 0) exitCode = spikeCode
  }

  if (want('phase1')) {
    console.log('\n=== 自走検証（Phase 1: ブラウザ本体）')
    const phase1Code = await phase1([])
    if (phase1Code !== 0) exitCode = phase1Code
  }

  if (want('phase2')) {
    console.log('\n=== 自走検証（Phase 2: ライブラリ・アーカイブ・シークレット）')
    const phase2Code = await phase2([])
    if (phase2Code !== 0) exitCode = phase2Code
  }

  if (want('pins')) {
    console.log('\n=== 自走検証（ピン留め / Favorites）')
    const pinsCode = await pins([])
    if (pinsCode !== 0) exitCode = pinsCode
  }

  if (want('switcher')) {
    console.log('\n=== 自走検証（タブスイッチャー ⌃M）')
    const switcherCode = await switcher([])
    if (switcherCode !== 0) exitCode = switcherCode
  }

  if (want('peek')) {
    console.log('\n=== 自走検証（Peek と小窓）')
    const peekCode = await peek([])
    if (peekCode !== 0) exitCode = peekCode
  }

  if (want('split')) {
    console.log('\n=== 自走検証（分割ビュー）')
    const splitCode = await split([])
    if (splitCode !== 0) exitCode = splitCode
  }

  if (want('call')) {
    console.log('\n=== 自走検証（会議の小窓）')
    const callCode = await call([])
    if (callCode !== 0) exitCode = callCode
  }

  if (want('live-folder')) {
    console.log('\n=== 自走検証（Live Folder: GitHub の PR）')
    const liveFolderCode = await liveFolder([])
    if (liveFolderCode !== 0) exitCode = liveFolderCode
  }

  if (want('http-auth')) {
    console.log('\n=== 自走検証（HTTP Basic 認証の自動入力）')
    const httpAuthCode = await httpAuth([])
    if (httpAuthCode !== 0) exitCode = httpAuthCode
  }

  /*
   * **実行順の最後に置く**（`restart` の前）。CDP の合成キーは撃った先へフォーカスが移るので
   * （`verify-switcher.mjs` の 7 に実測）、キーを大量に撃つこのスイートを前に置くと
   * 後続のキー検証が原因不明で落ちる。落ちても自分の変更に見えないのが厄介。
   */
  if (want('vim-scroll')) {
    console.log('\n=== 自走検証（ページの gg / G）')
    const vimScrollCode = await vimScroll([])
    if (vimScrollCode !== 0) exitCode = vimScrollCode
  }

  if (want('restart')) {
    /*
     * **中身も `want()` で絞る**。ここは spike / phase1 / pins / split / call / live-folder が
     * 1 回の再起動に相乗りする場所で、以前は spike / phase1 / pins を無条件に回していた。
     * `restart` は随伴ルールで事実上ほぼ毎回選ばれるので、その無条件分がそのまま
     * `--changed` の下限コストになっていた。再起動そのもの（`stopAll()` → `startApp()`）は
     * 1 回のままにする（write と read を分ける構造は崩さない）。
     */
    console.log('\n=== 再起動をまたぐ永続性')
    if (want('spike')) await spike(['--storage-write'])
    if (want('phase1')) await phase1(['--session-write'])
    // ピン / Favorites の遅延ロードも再起動をまたぐので、同じ再起動に相乗りする
    if (want('pins')) {
      const lazyWriteCode = await pins(['--lazy-write'])
      if (lazyWriteCode !== 0) exitCode = lazyWriteCode
    }
    // **分割はアプリが動いているうちに作る**（セッションに書かせる）。
    // 止めてから仕込む会議 / Live Folder の plant とは違うので、`stopAll()` より前に置く。
    if (want('split')) {
      const splitWriteCode = await split(['--restart-write'])
      if (splitWriteCode !== 0) exitCode = splitWriteCode
    }
    // 資格情報は**アプリが動いているうちに**作る（暗号文はプロセス内の backend で作られる）
    if (want('http-auth')) {
      const authWriteCode = await httpAuth(['--restart-write'])
      if (authWriteCode !== 0) exitCode = authWriteCode
    }
    await stopAll()

    // 暗号文を壊すのは**アプリを止めてから**（起動中に書くと終了時の close が上書きする）
    if (want('http-auth')) {
      const plantCode = await httpAuth(['--restart-plant'])
      if (plantCode !== 0) exitCode = plantCode
    }

    // 会議の小窓の位置は**アプリを止めてから**仕込む。
    // 起動中に書くと、終了時の `closeCallWindowStore()` が上書きしてしまう。
    if (want('call')) {
      const plantCode = await call(['--position-plant'])
      if (plantCode !== 0) exitCode = plantCode
    }
    // 壊れたキャッシュも**アプリを止めてから**仕込む（終了時の close が上書きする）
    if (want('live-folder')) {
      const plantCode = await liveFolder(['--restart-write'])
      if (plantCode !== 0) exitCode = plantCode
    }

    await startPagesServer()
    await startApp()
    if (want('spike')) {
      const storageCode = await spike(['--storage-read'])
      if (storageCode !== 0) exitCode = storageCode
    }
    if (want('phase1')) {
      const sessionCode = await phase1(['--session-read'])
      if (sessionCode !== 0) exitCode = sessionCode
    }
    if (want('pins')) {
      const lazyReadCode = await pins(['--lazy-read'])
      if (lazyReadCode !== 0) exitCode = lazyReadCode
    }
    if (want('live-folder')) {
      const liveReadCode = await liveFolder(['--restart-read'])
      if (liveReadCode !== 0) exitCode = liveReadCode
    }
    if (want('split')) {
      const splitReadCode = await split(['--restart-read'])
      if (splitReadCode !== 0) exitCode = splitReadCode
    }
    if (want('http-auth')) {
      const authReadCode = await httpAuth(['--restart-read'])
      if (authReadCode !== 0) exitCode = authReadCode
    }
    // **タブを作る検証はいちばん最後に置く**。会議の小窓を出すには会議タブが要るが、
    // その1枚が「復元直後のタブは sleep 状態」の検査に混ざって落とす（実際に踏んだ）。
    if (want('call')) {
      const positionCode = await call(['--position-read'])
      if (positionCode !== 0) exitCode = positionCode
    }
  }

  if (want('shared-tabs')) {
    // 野良タブのウィンドウ横断共有は**自分でアプリを起動して**確かめる（別プロファイル）。
    // 2 枚目のウィンドウ・再起動・第 2 インスタンス起動（小窓）を伴うので相乗りしない。
    await stopAll()
    console.log('\n=== 野良タブのウィンドウ横断共有')
    const sharedTabsCode = await runToCompletion(process.execPath, ['scripts/verify-shared-tabs.mjs'])
    if (sharedTabsCode !== 0) exitCode = sharedTabsCode
  }

  if (want('migration')) {
    // 旧版セッションからの移行は**自分でアプリを起動して**確かめる（別プロファイル）。
    // ここまでの起動を止めてから回す（同時に2つの Nemo を立てない）。
    await stopAll()
    console.log('\n=== 旧版セッションからの移行')
    const migrationCode = await runToCompletion(process.execPath, ['scripts/verify-session-migration.mjs'])
    if (migrationCode !== 0) exitCode = migrationCode
  }

  if (want('db')) {
    // 履歴 DB の列追加も同じ理由で別建て。ここまでの userData は毎回まっさらなので、
    // **既存の pages テーブルへの ALTER TABLE を一度も通らない**。
    await stopAll()
    console.log('\n=== 旧スキーマの履歴 DB からの移行')
    const dbMigrationCode = await runToCompletion(process.execPath, ['scripts/verify-db-migration.mjs'])
    if (dbMigrationCode !== 0) exitCode = dbMigrationCode
  }

  if (want('slots')) {
    // セーブスロットも別建て。**`NEMO_SLOTS_DIR` を自分で振る**必要があるので
    // （渡し忘れると実 iCloud の常用スロットに書く）、ここまでの起動は止めてから回す。
    await stopAll()
    console.log('\n=== ブックマークのセーブスロット')
    const slotsCode = await runToCompletion(process.execPath, ['scripts/verify-slots.mjs'])
    if (slotsCode !== 0) exitCode = slotsCode
  }

  if (want('metrics')) {
    // メモリ・CPU の定期記録。**間隔を環境変数で縮める**ので共有アプリでは回せない。自分で起動する
    await stopAll()
    console.log('\n=== メモリ・CPU の定期記録と UI 例外')
    const metricsCode = await runToCompletion(process.execPath, ['scripts/verify-metrics.mjs'])
    if (metricsCode !== 0) exitCode = metricsCode
  }

  if (want('auth-vault')) {
    // 保管庫も別建て。**`NEMO_SLOTS_DIR` を自分で振る**必要があるうえ、
    // 「別の Mac」を模すのに `NEMO_USER_DATA_DIR` を 2 つ使うので、ここまでの起動は止めてから回す。
    await stopAll()
    console.log('\n=== Basic 認証の保管庫')
    const vaultCode = await runToCompletion(process.execPath, ['scripts/verify-auth-vault.mjs'])
    if (vaultCode !== 0) exitCode = vaultCode
  }
} catch (error) {
  console.error(`\n[verify] ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  try {
    await stopAll()
  } catch (error) {
    exitCode = 1
    console.error(`\n[verify] ${error instanceof Error ? error.message : String(error)}`)
  }

  // main プロセスの例外は握ってログに落としている（ブラウザごと止めないため）。
  // 握ったまま気づかないと意味がないので、検証の最後に必ず見る。
  const uncaught = findUncaughtExceptions(userDataDir)
  if (uncaught.length > 0) {
    exitCode = 1
    console.error(`\n[verify] main プロセスの例外がログに残っている:\n  ${uncaught.join('\n  ')}`)
  }

  // 消してよいかは「生き残りがいないこと」だけで判断する。
  // stopAll が成功したかどうかでは判断しない（途中で止め損ねた子を見落とす）。
  const alive = spawned.filter(isChildAlive)
  if (alive.length === 0) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  } else {
    exitCode = 1
    console.error(
      `[verify] 生き残ったプロセスがある (pid ${alive.map((c) => c.pid).join(', ')})。` +
        `一時ディレクトリを残した: ${userDataDir}`
    )
  }
}

const scope = only.size > 0 ? `（${scopeFlag} ${[...only].join(' ')} だけ）` : ''
console.log(exitCode === 0 ? `\n=== 自走検証: すべて PASS${scope}` : `\n=== 自走検証: FAIL あり${scope}`)
process.exit(exitCode)
