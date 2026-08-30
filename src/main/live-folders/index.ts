import { BaseWindow, app, powerMonitor } from 'electron'
import { JsonStore } from '../store/json-store.js'
import { userDataPath } from '../paths.js'
import { log, logError } from '../log.js'
import { getSettings } from '../store/settings.js'
import { getTimings } from '../timings.js'
import {
  LIVE_FOLDER_VERSION,
  normalizeLiveFolderCache,
  normalizePrUrl
} from '../../shared/live-folder-schema.js'
import { fetchLivePullRequests, isGithubTestEndpoint } from './github-pr.js'
import { resolveToken, type TokenSource } from './token.js'
import type { LiveFolderCache, LiveFolderState } from '../../shared/types.js'

/**
 * Live Folder の心臓部。取得の間隔・キャッシュを1か所で握る。
 *
 * 「次に投げてよい時刻」を **`nextAutomaticAttemptAt` 1つに寄せている**のが肝心。
 * タイマー・focus・resume が**それぞれ別のゲートを持つと必ず食い違う**
 * （60秒タイマーと 60秒 focus ゲートは、transient 失敗後のバックオフを両方とも迂回する）。
 * タイマーは 60 秒ごとに起きて条件を確認するだけの存在で、**取得間隔を決めない**。
 */

/*
 * 取得の間隔まわりは `src/shared/timings.js` に既定値を置き、
 * 自走検証のときだけ `NEMO_VERIFY_TIMINGS` で縮める（判定の中身は変えない）。
 * ここは待ち時間そのものなので、**verify の所要時間の 89 秒分がここ 2 つで決まっていた**。
 *
 * - 自動取得の基本間隔 = `liveFolderPollMs`
 * - タイマーが起きる間隔 = `liveFolderTickMs`。**取得の間隔を決めるのは
 *   `nextAutomaticAttemptAt` の方**で、ここは「条件を見るだけ」なので短くてよい
 *   （短いほど、制限が解けた直後の復帰が速い）。poll との比は保つこと
 * - `transient` 失敗のバックオフの初期値 = `liveFolderBackoffMinMs`
 */
const pollIntervalMs = (): number => getTimings().liveFolderPollMs
const backoffMinMs = (): number => getTimings().liveFolderBackoffMinMs
/** バックオフの上限は初期値の 15 倍（本番で 60秒 → 15分）。 */
const backoffMaxMs = (): number => backoffMinMs() * 15

/** いまのバックオフ幅（まだ入っていなければ初期値を入れてから返す）。 */
function currentBackoffMs(): number {
  if (backoffMs === 0) backoffMs = backoffMinMs()
  return backoffMs
}
/** `auth` 失敗は資格情報を直すまで投げても無駄。 */
const authRetryMs = (): number => backoffMinMs() * 15
/**
 * `gh auth token` の呼び出し自体に失敗したときの再試行。
 *
 * **「本当に未設定」と同じ 60 秒待ちにしない。** 起動直後の初回 exec は遅く、
 * タイムアウトすると**起動して 60 秒間ずっと `Connect GitHub`（＝未設定）に見える**
 * （実際に踏んだ。ログでは startup の要求が取得も失敗もせず消えていた）。
 */
const tokenRetryMs = (): number => getTimings().liveFolderTickMs

/**
 * 取得の要求元。
 * - `auto` … タイマー / focus / resume。**実行中なら世代に触れず捨てる**
 * - `manual` … `Refresh` / 右クリックの「いま更新する」
 * - `credential` … 設定の再有効化・PAT の保存 / 削除
 */
type RequestKind = 'auto' | 'manual' | 'credential'

const listeners = new Set<() => void>()

let store: JsonStore<LiveFolderCache> | null = null
let cache: LiveFolderCache = normalizeLiveFolderCache(undefined)
/**
 * キャッシュが「いまの資格情報のものだ」と確かめ終わったか。
 *
 * **確かめる前に出さない。** 起動直後に読んだ JSON をそのまま描くと、
 * 外部で `gh` のアカウントが切り替わっていた場合に
 * **別アカウントの PR が一瞬出る**（そして取得が失敗すればそのまま残る）。
 */
let cacheVerified = false

let source: TokenSource = 'none'
let loading = false
let failure: LiveFolderState['failure'] = null

let nextAutomaticAttemptAt = 0
/**
 * いまの `transient` バックオフ幅。**0 は「まだ初期値を入れていない」**。
 * 初期値は `timings` 由来なので、モジュール読み込み時ではなく初めて使うときに入れる
 * （`initTimings()` はアプリ起動時に走るので、モジュール初期化では上書きが間に合わない）。
 */
let backoffMs = 0

/** single-flight。実行中は1本だけ。 */
let running = false
/** 「一覧を置き換えてよいか」だけを制御する世代番号。 */
let generation = 0
/** 予約は1件に畳む。ここに来られるのは**手動と設定・トークンの変更だけ**。 */
let pending: RequestKind | null = null

/** `rate-limit` を観測したときの資格情報。**同じ資格情報では `resetAt` まで投げない**。 */
let rateLimitedCredentialKey: string | null = null

let timer: NodeJS.Timeout | null = null

/* ------------------------------------------------------------------ *
 * 外向きの状態
 * ------------------------------------------------------------------ */

export function onLiveFolderChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * サイドバーに渡す状態。
 * **設定で無効なら null**（シークレットウィンドウの除外は呼び出し側で行う）。
 */
export function getLiveFolderState(): LiveFolderState | null {
  if (!getSettings().liveFolderEnabled) return null
  return {
    source,
    // 照合が済むまでは「読み込み中」として扱う（古い一覧を出さない）
    items: cacheVerified ? cache.items : [],
    truncation: cache.truncation,
    updatedAt: cache.updatedAt,
    loading,
    failure,
    login: cache.login
  }
}

/**
 * タブの URL を Live Folder の自然キーに直す（一致しなければ null）。
 * **タブとの突き合わせはこの正準形どうしで行う**（renderer 側の除外と同じ規則）。
 */
export function liveFolderKeyOf(url: string): string | null {
  return normalizePrUrl(url)
}

/** いま一覧に載っている URL か（`live-folder-open` の照合に使う）。 */
export function isLiveFolderUrl(url: string): boolean {
  return cache.items.some((item) => item.url === url)
}

/**
 * そのタブの URL が、**サイドバーにいま出ている** Live Folder の PR か。
 *
 * **サイドバーと同じ見え方で判定する**（`getLiveFolderState()` を通す）。
 * 生キャッシュを見ると、設定で無効・照合前（`cacheVerified === false`）・
 * シークレットウィンドウでは一覧に 1 件も出ていないのに main だけがそのタブを
 * 「Live Folder の行」と見なし、**ドロップできる見た目なのに黙って何も起きない**になる。
 *
 * **正準形どうしで照合する**（サイドバーが一時タブを一覧から外すのと同じ規則）。
 * `isLiveFolderUrl` は完全一致で、通知から開いた `?notification_referrer_id=…` 付きを拾えない。
 *
 * @param isPrivate シークレットウィンドウか（`liveFolder` を null で渡す側と同じ除外）
 */
export function isLiveFolderTabUrl(url: string, isPrivate: boolean): boolean {
  if (isPrivate) return false
  const key = normalizePrUrl(url)
  if (!key) return false
  const state = getLiveFolderState()
  if (!state) return false
  return state.items.some((item) => normalizePrUrl(item.url) === key)
}

/* ------------------------------------------------------------------ *
 * 起動と停止
 * ------------------------------------------------------------------ */

export function initLiveFolders(): void {
  store = new JsonStore<LiveFolderCache>(
    userDataPath('live-folders.json'),
    LIVE_FOLDER_VERSION,
    normalizeLiveFolderCache
  )
  // **起動直後はキャッシュを即座に出す**（ネットワークを待たない）。
  // 表示してよいかは `credentialKey` の照合が済むまで分からないので、
  // 照合が終わるまでは「読み込み中」として扱う。
  cache = store.get()
  loading = true

  timer = setInterval(tick, getTimings().liveFolderTickMs)
  timer.unref?.()

  // focus / resume も**同じゲート**（`now >= nextAutomaticAttemptAt`）だけを見る
  app.on('browser-window-focus', () => requestAutomatic('focus'))
  powerMonitor.on('resume', () => requestAutomatic('resume'))
  powerMonitor.on('suspend', () => {
    // スリープ中は投げない。起きたら `resume` が条件を見る
    log('live_folder.suspended', {})
  })

  requestFetch('credential', 'startup')
}

export function stopLiveFolders(): void {
  if (timer) clearInterval(timer)
  timer = null
  store?.close()
  store = null
}

/** 全ウィンドウが隠れているなら止める。 */
function anyWindowVisible(): boolean {
  return BaseWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible())
}

function tick(): void {
  requestAutomatic('timer')
}

/**
 * タイマー・focus・resume。**「`now >= nextAutomaticAttemptAt` か」だけを見る。**
 *
 * **可視性の判定もここに置く**（呼び出し口ごとに書くと必ずどれかで漏れる。
 * 実際、タイマーにしか無かったせいで **`resume` だけが「全ウィンドウが隠れている」を
 * 迂回して**、隠したままスリープ復帰すると取得が走っていた）。
 */
function requestAutomatic(reason: string): void {
  if (!getSettings().liveFolderEnabled) return
  if (!anyWindowVisible()) return
  if (Date.now() < nextAutomaticAttemptAt) return
  requestFetch('auto', reason)
}

/** 手動更新（`Refresh` / 右クリック）。`transient` / `auth` のバックオフは上書きできる。 */
export function refreshLiveFolderNow(): void {
  if (!getSettings().liveFolderEnabled) return
  requestFetch('manual', 'manual')
}

/**
 * 設定・トークンが変わったとき。
 *
 * - 無効にした → **push だけ**（取得はしない）
 * - 有効に戻した / PAT を保存・削除した → push + **即時に1回取得**
 */
export function liveFolderCredentialsChanged(reason: string): void {
  if (!getSettings().liveFolderEnabled) {
    loading = false
    notify()
    return
  }
  requestFetch('credential', reason)
}

/** 設定トグルの変更を反映する。 */
export function liveFolderSettingChanged(enabled: boolean): void {
  if (!enabled) {
    // **立っている予約も捨てる。** 残すと、いま走っている取得が終わった瞬間に
    // 予約ぶんが送信され、**無効にしたのに GitHub へ1回つなぎに行く**
    pending = null
    loading = false
    notify()
    return
  }
  notify()
  requestFetch('credential', 'setting-enabled')
}

/* ------------------------------------------------------------------ *
 * 取得（single-flight）
 * ------------------------------------------------------------------ */

function requestFetch(kind: RequestKind, reason: string): void {
  // 0. **無効なら何も要求しない。** 呼び出し口ごとに書くと必ずどれかで漏れるので、
  //    「投げてよいか」の判定はここ1か所に置く（予約の実行経路もここを通る）。
  if (!getSettings().liveFolderEnabled) return

  // 1. **実行中に来た自動の要求は、世代番号に触れずその場で捨てる。**
  //    `nextAutomaticAttemptAt` は取得が完了するまで更新されないので、
  //    ここが無いと1回目の取得中に来た2回目の focus が古い期限を通過して予約を立て、
  //    続けてもう1回走る（focus 連打が抑えられない）。
  if (running && kind === 'auto') return

  // 2. **ここまで来た要求だけが世代番号を1つ進める。**
  //    1 と 2 の順序が逆だと、捨てるはずの自動要求が世代番号だけ進めてしまい、
  //    いま走っている取得が完了時に「自分の世代は最新でない」と判定されて
  //    正常な結果まで捨てられる（一覧が永久に更新されない）。
  generation += 1

  // 3. 実行中なら**予約を1つ立てるだけ**（何回来ても1件に畳む）。
  //
  //    **`credential` の予約は手動で上書きしない。** 単純に最後の種類で上書きすると、
  //    「新 PAT を保存（credential）→ 手動更新（manual）→ 走っていた旧 PAT の取得が
  //    `rate-limit` を返す」の順で **manual として扱われた予約がキャンセルされ、
  //    新しい資格情報で1度も取得されないまま**旧アカウントのキャッシュが
  //    `resetAt` まで残る。資格情報の変更は「誰のものか」を確かめるまで捨てられない。
  if (running) {
    if (pending !== 'credential') pending = kind
    log('live_folder.reserved', { kind, pending, reason })
    return
  }
  log('live_folder.requested', { kind, reason })
  void run(kind, generation, reason)
}

async function run(kind: RequestKind, myGeneration: number, reason: string): Promise<void> {
  running = true
  loading = true
  notify()
  try {
    const resolved = await resolveToken(isGithubTestEndpoint())
    source = resolved.source

    // **キャッシュは「誰のものか」を持つ。** fingerprint が一致しないキャッシュは
    // 表示せず破棄する（別アカウントの PAT に貼り替えて取得が失敗したときに、
    // 前のアカウントの PR が「前回の内容」として出続けるのを防ぐ）。
    //
    // **資格情報が無いとき（null）は「別人」ではなく「まだ分からない」**なので捨てない。
    // ここで捨てると、gh が一時的に見つからないだけでキャッシュが消える。
    // 未設定のあいだ UI は `Connect GitHub` の1行なので、持っていても表に出ない。
    if (resolved.credentialKey !== null && cache.credentialKey !== resolved.credentialKey) {
      log('live_folder.cache_discarded', { reason: 'credential_changed' })
      writeCache({
        credentialKey: resolved.credentialKey,
        login: null,
        items: [],
        truncation: { review: null, mine: null },
        updatedAt: null
      })
    }
    // ここまで来れば「いまの資格情報のキャッシュ」だと言えるので、表に出してよい
    cacheVerified = true

    if (!resolved.token) {
      // 未設定は失敗ではない（UI は `Connect GitHub` の1行だけを出す）。
      // ただし**「解決に失敗した」だけは短く retry する**（未設定と同じ扱いにしない）。
      failure = null
      const wait = resolved.reason === 'gh-failed' ? tokenRetryMs() : pollIntervalMs()
      nextAutomaticAttemptAt = Date.now() + wait
      log('live_folder.no_token', { reason: resolved.reason, retryInMs: wait })
      return
    }

    // **`rate-limit` は手動でも上書きできない。** ここを破れると、
    // 制限中に押し続けて復帰をさらに遅らせる。
    // ただし**トークンが変わったときだけ 1 回投げてよい**
    // （新しいトークンが誰のものかは取得するまで分からない）。
    const now = Date.now()
    if (failure?.kind === 'rate-limit' && failure.resetAt !== null && now < failure.resetAt) {
      const differentCredential = resolved.credentialKey !== rateLimitedCredentialKey
      if (!(kind === 'credential' && differentCredential)) {
        log('live_folder.skipped', { reason: 'rate_limited', kind })
        return
      }
    }

    // **送信の直前にもう一度見る。** `resolveToken()` は `gh auth token` を待つと
    // 最大 3 秒かかるので、そのあいだに無効化されることがある
    if (!getSettings().liveFolderEnabled) {
      log('live_folder.skipped', { reason: 'disabled', kind })
      return
    }

    const result = await fetchLivePullRequests(resolved.token)
    applyResult(result, resolved.credentialKey, myGeneration, reason)
  } catch (error) {
    logError('live_folder.fetch_failed', error)
    recordFailure({ kind: 'transient', resetAt: null, retryAfterMs: null }, null)
  } finally {
    running = false
    const next = pending
    pending = null
    // 予約があれば続けて1回だけ実行する。
    // **実行してよいかをここでも見る**（`requestFetch` が弾いたときに
    // `loading` を畳み損ねて「取得中」のまま止まるのを防ぐ）。
    if (next && getSettings().liveFolderEnabled) {
      requestFetch(next, 'pending')
    } else {
      loading = false
      notify()
    }
  }
}

type FetchResult = Awaited<ReturnType<typeof fetchLivePullRequests>>

function applyResult(
  result: FetchResult,
  credentialKey: string | null,
  myGeneration: number,
  reason: string
): void {
  if (!result.ok) {
    // **失敗の分類・`nextAutomaticAttemptAt`・レート制限を観測したという事実は、
    // 世代が古くても必ず記録する。** これは「誰が投げたか」に関係なく真だから。
    // 記録しないと、制限中なのに予約ぶんが即座に送信される。
    recordFailure(result.failure, credentialKey)
    log('live_folder.failed', { kind: result.failure.kind, status: result.status, reason })
    return
  }

  const now = Date.now()
  failure = null
  backoffMs = backoffMinMs()
  nextAutomaticAttemptAt = now + pollIntervalMs()
  rateLimitedCredentialKey = null
  log('live_folder.fetched', {
    count: result.items.length,
    cost: result.cost,
    remaining: result.remaining,
    reason
  })

  // **世代番号が制御するのは「一覧を置き換えてよいか」だけ。**
  if (myGeneration !== generation) {
    log('live_folder.stale_result', { myGeneration, generation })
    return
  }

  writeCache({
    credentialKey,
    login: result.login,
    items: result.items,
    truncation: result.truncation,
    updatedAt: now
  })
  notify()
}

function recordFailure(
  classification: {
    kind: 'auth' | 'rate-limit' | 'transient'
    resetAt: number | null
    retryAfterMs: number | null
  },
  credentialKey: string | null
): void {
  const now = Date.now()
  failure = { kind: classification.kind, resetAt: classification.resetAt }
  if (classification.kind === 'rate-limit') {
    nextAutomaticAttemptAt = classification.resetAt ?? now + pollIntervalMs()
    rateLimitedCredentialKey = credentialKey
    // **同じ資格情報の予約はキャンセルする。** そうしないと
    // 「古い世代の結果を捨てる → 予約ぶんが即送信される」で
    // 「`rate-limit` は手動でも上書き不可」が破れる。
    // **トークン変更で立った予約は 1 回だけ実行してよい**ので残す
    // （判定は run() 側で `credentialKey` の一致を見る）。
    if (pending !== null && pending !== 'credential') pending = null
    log('live_folder.backoff', { kind: 'rate-limit', waitMs: nextAutomaticAttemptAt - now })
    return
  }
  if (classification.kind === 'auth') {
    nextAutomaticAttemptAt = now + authRetryMs()
    log('live_folder.backoff', { kind: 'auth', waitMs: authRetryMs() })
    return
  }
  // `transient` でも `retry-after` は待機時刻として尊重する
  // （503 + `Retry-After: 120` を無視して 60 秒で叩きに行かない）
  const wait = classification.retryAfterMs ?? currentBackoffMs()
  nextAutomaticAttemptAt = now + wait
  backoffMs = Math.min(currentBackoffMs() * 2, backoffMaxMs())
  // **待ち時間そのものをログに出す。** 「120 秒待つこと」を外から確かめるのに
  // 実際に 120 秒待つのは検証が重すぎるので、値で見られるようにしておく
  log('live_folder.backoff', { kind: classification.kind, waitMs: wait })
}

function writeCache(next: LiveFolderCache): void {
  cache = next
  store?.set(next)
}
