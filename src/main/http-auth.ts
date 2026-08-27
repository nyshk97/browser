import { type Session, type WebContents } from 'electron'
import {
  HTTP_AUTH_LIMITS,
  evaluateEligibility,
  isSameHttpOrigin,
  patternFromUrl
} from '../shared/http-auth-rules.js'
import { matchHttpAuthRules } from './http-auth-matcher.js'
import {
  disableHttpAuthRule,
  getHttpAuthCredential,
  httpAuthEncryptionAvailable,
  matchableHttpAuthRules,
  saveHttpAuthRule
} from './store/http-auth.js'
import { httpAuthCredentialsChanged } from './http-auth-reset.js'
import { ask } from './prompts.js'
import { log, logError } from './log.js'
import { getTimings } from './timings.js'
import type { PromptAnswer } from '../shared/types.js'

/**
 * HTTP Basic 認証の自動入力（Electron 依存の薄い層）。
 *
 * Electron 固有の制約が設計の肝になっている:
 *
 * **① `requestId` が無い。** `login` イベントには MultiPass のリトライ検出に使える ID がない。
 * 代替キーは `webContents.id + authInfo.scheme + details.url`。
 * `host:port + realm` だけにすると、同じページ内で並列に飛ぶ 401（画像・API の同時取得）が
 * 「2 回目＝拒否された」と数えられてしまう。
 *
 * **② `contents.getURL()` だけで同一オリジン判定を書くと必ず壊れる。**
 * `login` が飛ぶ時点でナビゲーションが未 commit なので、`getURL()` は古いページ
 * （新規タブなら `about:blank`）を返す。「アドレスバーに URL を打って 401」という
 * 一番使う経路で判定が必ず false になる。だから `did-start-navigation` で
 * 遷移先を覚えておく（`will-navigate` では `loadURL()` が発火しないので代用できない）。
 *
 * **③ 「標準ダイアログにフォールバック」は存在しない。**
 * `preventDefault()` しなければ Electron の既定は**認証キャンセル**。
 * 諦め方は「Nemo のダイアログを出す」の一択。
 *
 * **④ Chromium の HttpAuthCache。** 一度通るとセッション内は `login` が飛ばない。
 * 資格情報を変えたら `clearAuthCache()` を呼ぶ（`http-auth-reset.ts`）。
 */

/* ------------------------------------------------------------------ *
 * WebContents ごとの状態
 * ------------------------------------------------------------------ */

/**
 * 遷移中（まだ commit されていない）のメインフレーム URL。
 * 同一オリジン判定はこれを優先して見る（②）。
 */
const pendingNavigation = new WeakMap<WebContents, string>()

/**
 * 試行回数。キーは `${wc.id}|${scheme}|${details.url}`。
 * **`details.url` を含めるのが要点**（①）。
 */
const attempts = new Map<string, number>()

/**
 * 拒否が確定した protection space（`${wc.id}|${scheme}|${host}:${port}|${realm}`）。
 *
 * **`did-start-navigation` では消さない**（消すとリロードのたびに誤パスワードが再送される）。
 * 消えるのは**資格情報の変更**と **WebContents の破棄**のときだけ。
 */
const denied = new Set<string>()

interface Waiter {
  callback: (username?: string, password?: string) => void
  /** 自動入力を送ったルール（`autofill` のときだけ）。**成功時の配布はこれで分ける**。 */
  ruleId: string | null
  /**
   * ダイアログをまとめる単位＝**この要求で勝ったルール**（拒否された要求も含む）。
   * `no-rule` は 1 グループ。
   *
   * `ruleId` と分けているのが要点。拒否された要求を `no-rule` に落とすと、
   * **同じルールで拒否された仲間と別のダイアログになり**、保護リソースの数だけ
   * ダイアログが出てしまう（1 件目で直しても残りが消えず #6 の自己修復が壊れる）。
   */
  groupId: string
  /** 拒否された保存済みルール（`rejected` のときだけ）。上書き保存の宛先になる。 */
  rejectedRule: { id: string; pattern: string } | null
  url: string
  /** `attempts` のキーに要る（配った直後の再送を抑えるため）。 */
  scheme: string
  host: string
  realm: string
  isProxy: boolean
  canSave: boolean
  rejected: boolean
  prefill: { username: string; password: string } | null
  windowId: number
}

interface Space {
  key: string
  wcId: number
  /** `autofill` … 自動入力を送って応答待ち。`dialog` … ダイアログで捌く。 */
  mode: 'autofill' | 'dialog'
  ruleId: string | null
  /** 自動入力を送ったリクエスト URL（応答の照合に使う）。 */
  url: string
  credential: { username: string; password: string } | null
  waiters: Waiter[]
  watchdog: NodeJS.Timeout | null
  dialogRunning: boolean
}

/**
 * protection space 単位の直列化。
 *
 * **キーに `ruleId` を含めない** —— HTTP の protection space はルール単位ではないので、
 * 含めると同じ origin / realm でも勝つルールが違う URL が別キューになり、
 * 並列に送信されて**アカウントロック回避を迂回する**。
 * 採用した rule ID はキーではなく値として持つ。
 */
const spaces = new Map<string, Space>()

/** マッチするルールが無かった要求をまとめるグループ名（ルール ID と衝突しない形にする）。 */
const NO_RULE_GROUP = '@no-rule'

const attemptKeyOf = (wcId: number, scheme: string, url: string): string => `${wcId}|${scheme}|${url}`
const spaceKeyOf = (wcId: number, info: Electron.AuthInfo): string =>
  `${wcId}|${info.scheme}|${info.host}:${info.port}|${info.realm}`

/* ------------------------------------------------------------------ *
 * ナビゲーションの追跡
 * ------------------------------------------------------------------ */

/** 各タブの WebContents 生成時に呼ぶ。 */
export function trackNavigationForHttpAuth(contents: WebContents): void {
  const wcId = contents.id

  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    pendingNavigation.set(contents, details.url)
    // 試行回数はここでリセットする（`denied` は消さない）
    forgetAttempts(wcId)
  })

  // **サーバ側 302 は `did-start-navigation` では通知されない。**
  // 付け忘れると `http://x` → `https://x` → 401 で pending が旧オリジンのまま残り、
  // 自動入力も保存も拒否される（この 301 は日常的に踏む）。
  contents.on('did-redirect-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    pendingNavigation.set(contents, details.url)
  })

  /*
   * **イベントの URL が今記録している pending と一致するときだけ消す。**
   * 無条件に消すと、B を開いた直後に C へ遷移したときに
   * B の失敗イベントが C の pending を消し、正しい自動入力がダイアログに退行する。
   */
  const clearIfCurrent = (url: string): void => {
    if (pendingNavigation.get(contents) === url) pendingNavigation.delete(contents)
  }
  contents.on('did-navigate', (_event, url) => clearIfCurrent(url))
  contents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
    // 消し忘れると、B への遷移が失敗して A に留まったあと、A のページが出す
    // B のサブリソース認証を「遷移中の B」と誤認して同一オリジン制約をすり抜ける
    if (isMainFrame) clearIfCurrent(url)
  })

  contents.once('destroyed', () => forgetWebContents(wcId))
}

/**
 * 同一オリジン判定に使う「このタブの URL」。
 *
 * **遷移中の URL を使ってよいのは、メインフレームがまだ読み込み中のときだけ**。
 * ナビゲーションが**中断**されたとき（204 / ダウンロードへの切り替え等）は
 * `did-navigate` も `did-fail-load` も飛ばず、**イベントでは pending を消せない**
 * （Electron の `loadURL` も `did-stop-loading` 経由で `ERR_FAILED` を返してくる）。
 * 消し忘れた pending をそのまま信じると、元のページに留まったあと、
 * 同一オリジンのサブリソースが「クロスオリジン」と判定されて
 * **正しい自動入力がダイアログに退行する**。
 *
 * 読み込みが止まっているなら、確定している `getURL()` の方が常に正しい。
 */
function pageUrlFor(contents: WebContents): string {
  const pending = pendingNavigation.get(contents)
  if (pending !== undefined && contents.isLoadingMainFrame()) return pending
  return contents.getURL()
}

function forgetAttempts(wcId: number): void {
  const prefix = `${wcId}|`
  for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key)
}

/** WebContents が消えたら、その wc のキューを**明示的にキャンセルする**。 */
function forgetWebContents(wcId: number): void {
  const prefix = `${wcId}|`
  forgetAttempts(wcId)
  for (const key of [...denied]) if (key.startsWith(prefix)) denied.delete(key)
  for (const [key, space] of [...spaces]) {
    if (space.wcId !== wcId) continue
    spaces.delete(key)
    if (space.watchdog) clearTimeout(space.watchdog)
    // 保留 callback を解決する（やらないと閉じたタブ由来のダイアログを出しに行く）
    const waiters = space.waiters
    space.waiters = []
    for (const waiter of waiters) waiter.callback()
  }
}

/* ------------------------------------------------------------------ *
 * 資格情報の解決
 * ------------------------------------------------------------------ */

export type Resolution =
  | { kind: 'autofill'; ruleId: string; credential: { username: string; password: string } }
  /** 適格だが、そのリクエストで 2 回目 or `denied` に入っている。**prefill はここにだけ載せる**。 */
  | {
      kind: 'rejected'
      rule: { id: string; pattern: string } | null
      prefill: { username: string; password: string } | null
    }
  /** 適格だがマッチするルールが無い（`reason` は診断ログ用）。 */
  | { kind: 'no-rule'; reason: 'no-match' | 'pattern-timeout' | 'decrypt-failed' }
  /** `evaluateEligibility` が落とした（プロキシ / 非 Basic / シークレット / クロスオリジン等）。 */
  | { kind: 'ineligible'; reason: string }

export interface LoginContext {
  contents: WebContents
  /** リクエスト URL（`login` の `details.url`）。 */
  url: string
  authInfo: Electron.AuthInfo
  isPrivate: boolean
  /** タブとして厳密に解決できたか。できなければ自動入力しない。 */
  isTab: boolean
  /** 手動ダイアログの宛先。 */
  windowId: number
}

/**
 * このリクエストに何を返すかを**判別可能な union**で決める。
 *
 * 全部 `null` にすると後段が `rejected` / prefill / `canSave` を作り分けられず、
 * シークレットで保存済みルールを読み直す実装にもなりうる。
 */
export async function resolveCredential(
  ctx: LoginContext
): Promise<{ resolution: Resolution; canSave: boolean }> {
  const pageUrl = pageUrlFor(ctx.contents)
  const eligibility = evaluateEligibility({
    isProxy: ctx.authInfo.isProxy,
    scheme: ctx.authInfo.scheme,
    isPrivate: ctx.isPrivate,
    // タブとして解決できない WebContents（拡張の popup など）は自動入力しない。
    // **シークレットと畳まない**（挙動は同じでも、ログが「シークレットだった」と嘘をつく）
    isTab: ctx.isTab,
    isSameOrigin: isSameHttpOrigin(ctx.url, pageUrl),
    canEncrypt: httpAuthEncryptionAvailable(),
    isUrlTooLong: ctx.url.length > HTTP_AUTH_LIMITS.MAX_URL
  })
  if (!eligibility.canAutofill) {
    // **ルールを読みにも行かない**
    return { resolution: { kind: 'ineligible', reason: eligibility.reason ?? 'ineligible' }, canSave: false }
  }

  const spaceKey = spaceKeyOf(ctx.contents.id, ctx.authInfo)
  const attemptKey = attemptKeyOf(ctx.contents.id, ctx.authInfo.scheme, ctx.url)
  const previous = attempts.get(attemptKey) ?? 0
  attempts.set(attemptKey, previous + 1)

  const matched = await matchHttpAuthRules(matchableHttpAuthRules(), ctx.url, 'runtime')
  for (const id of matched.timedOutIds) {
    // **`runtime` のタイムアウトだけ**が自動無効化の対象（テスターでは無効化しない）
    await disableHttpAuthRule(id, 'pattern-timeout')
  }
  const winner = matched.winner
  if (!winner) {
    const reason = matched.timedOutIds.length > 0 ? 'pattern-timeout' : 'no-match'
    return { resolution: { kind: 'no-rule', reason }, canSave: eligibility.canSave }
  }

  const credential = await getHttpAuthCredential(winner.id)
  // 復号に失敗したルールは無効化済み。ルール無しとして扱う
  if (!credential) {
    return { resolution: { kind: 'no-rule', reason: 'decrypt-failed' }, canSave: eligibility.canSave }
  }

  if (previous > 0 || denied.has(spaceKey)) {
    denied.add(spaceKey)
    return {
      resolution: {
        kind: 'rejected',
        rule: { id: winner.id, pattern: winner.pattern },
        prefill: credential
      },
      canSave: eligibility.canSave
    }
  }
  return { resolution: { kind: 'autofill', ruleId: winner.id, credential }, canSave: eligibility.canSave }
}

/* ------------------------------------------------------------------ *
 * 応答の監視（成功の判定はタイマーではなく実際の応答で行う）
 * ------------------------------------------------------------------ */

const watchedSessions = new WeakSet<Session>()

/**
 * 対象 WebContents のセッションで `onResponseStarted` を張る。
 *
 * **時間経過は成功の証拠にならない。** 応答の遅いサーバーでは
 * タイマー満了後に失敗が届き、待機中の全員へ誤資格情報を送ることになる。
 */
function watchSession(target: Session): void {
  if (watchedSessions.has(target)) return
  watchedSessions.add(target)
  target.webRequest.onResponseStarted((details) => {
    if (details.statusCode === 401) return
    if (details.webContentsId === undefined) return
    for (const space of [...spaces.values()]) {
      if (space.mode !== 'autofill') continue
      if (space.wcId !== details.webContentsId || space.url !== details.url) continue
      releaseAfterSuccess(space)
    }
  })
}

/* ------------------------------------------------------------------ *
 * login の処理
 * ------------------------------------------------------------------ */

/** `app.on('login')` から呼ぶ。**必ず callback を解決する**。 */
export async function handleHttpAuthLogin(
  ctx: LoginContext,
  callback: (username?: string, password?: string) => void
): Promise<void> {
  let resolved: { resolution: Resolution; canSave: boolean }
  try {
    resolved = await resolveCredential(ctx)
  } catch (error) {
    logError('auth.resolve_failed', error, {})
    resolved = { resolution: { kind: 'ineligible', reason: 'resolve-failed' }, canSave: false }
  }
  const { resolution, canSave } = resolved

  /*
   * **自動入力しなかったときは理由を 1 行残す。**
   * 残さないと、この機能が静かに効かなくなったときに
   * 「クロスオリジンなのか / 非 Basic なのか / ルールが無いのか / 拒否済みなのか」を
   * 切り分ける手段が無い（`auth.requested` には `isProxy` しか出ていなかった）。
   * `reason` は列挙値だけなので URL も資格情報も載らない。
   */
  if (resolution.kind !== 'autofill') {
    log('auth.not_autofilled', {
      kind: resolution.kind,
      reason: resolution.kind === 'rejected' ? 'rejected' : resolution.reason
    })
  }

  const waiter: Waiter = {
    callback,
    ruleId: resolution.kind === 'autofill' ? resolution.ruleId : null,
    groupId:
      resolution.kind === 'autofill'
        ? resolution.ruleId
        : (resolution.kind === 'rejected' ? resolution.rule?.id : null) ?? NO_RULE_GROUP,
    rejectedRule: resolution.kind === 'rejected' ? resolution.rule : null,
    url: ctx.url,
    scheme: ctx.authInfo.scheme,
    host: `${ctx.authInfo.host}:${ctx.authInfo.port}`,
    realm: ctx.authInfo.realm,
    isProxy: ctx.authInfo.isProxy,
    canSave,
    rejected: resolution.kind === 'rejected',
    prefill: resolution.kind === 'rejected' ? resolution.prefill : null,
    windowId: ctx.windowId
  }

  // プロキシ / 非 Basic / シークレット / クロスオリジンは直列化に混ぜない（従来どおりダイアログ）
  if (resolution.kind === 'ineligible') {
    await runSingleDialog(waiter)
    return
  }

  const key = spaceKeyOf(ctx.contents.id, ctx.authInfo)
  const existing = spaces.get(key)

  if (existing) {
    existing.waiters.push(waiter)
    if (existing.mode === 'autofill' && resolution.kind === 'rejected') {
      // 送った資格情報が拒否された ＝ この protection space は諦める
      failAutofill(existing)
    } else if (existing.mode === 'dialog') {
      void runDialogRounds(existing)
    }
    return
  }

  if (resolution.kind === 'autofill') {
    const space: Space = {
      key,
      wcId: ctx.contents.id,
      mode: 'autofill',
      ruleId: resolution.ruleId,
      url: ctx.url,
      credential: resolution.credential,
      waiters: [],
      watchdog: null,
      dialogRunning: false
    }
    space.watchdog = setTimeout(() => {
      // **成功に倒さず、ダイアログに倒す**（諦め方は Nemo のダイアログの一択）
      log('auth.autofill_watchdog', {})
      failAutofill(space)
    }, getTimings().httpAuthWatchdogMs)
    spaces.set(key, space)
    watchSession(ctx.contents.session)
    log('auth.autofilled', { ruleId: resolution.ruleId })
    callback(resolution.credential.username, resolution.credential.password)
    return
  }

  const space: Space = {
    key,
    wcId: ctx.contents.id,
    mode: 'dialog',
    ruleId: null,
    url: ctx.url,
    credential: null,
    waiters: [waiter],
    watchdog: null,
    dialogRunning: false
  }
  spaces.set(key, space)
  void runDialogRounds(space)
}

/** 自動入力が通った。**先頭と同じ rule ID が勝った要求にだけ**配る。 */
function releaseAfterSuccess(space: Space): void {
  if (space.watchdog) clearTimeout(space.watchdog)
  spaces.delete(space.key)
  const waiters = space.waiters
  space.waiters = []
  const credential = space.credential
  for (const waiter of waiters) {
    if (credential && waiter.ruleId !== null && waiter.ruleId === space.ruleId) {
      waiter.callback(credential.username, credential.password)
    } else {
      // 別のルールが勝った要求と `no-rule` の要求は自動入力せず手動ダイアログへ回す
      enqueueDialog(space.key, space.wcId, waiter)
    }
  }
}

/**
 * 自動入力が拒否された / 応答が来ない。ダイアログへ倒す。
 *
 * **ここでは `denied` に入れない。** 拒否が確定した protection space は
 * `resolveCredential` が 2 回目の `login` を見た時点で既に `denied` へ入れている。
 * ここでも入れると **watchdog の満了（＝応答が遅いだけ）まで「拒否された」扱い**になり、
 * 正しい資格情報でもタブを閉じるか資格情報を変えるまで自動入力されなくなる。
 */
function failAutofill(space: Space): void {
  if (space.watchdog) clearTimeout(space.watchdog)
  space.watchdog = null
  space.mode = 'dialog'
  space.credential = null
  void runDialogRounds(space)
}

/** 単独のダイアログ（直列化に混ぜないもの）。 */
async function runSingleDialog(waiter: Waiter): Promise<void> {
  const answer = await askAuth(waiter)
  deliver([waiter], answer)
}

/** 同じ protection space のキューに積み直す（無ければ作る）。 */
function enqueueDialog(key: string, wcId: number, waiter: Waiter): void {
  const existing = spaces.get(key)
  if (existing) {
    existing.waiters.push(waiter)
    void runDialogRounds(existing)
    return
  }
  const space: Space = {
    key,
    wcId,
    mode: 'dialog',
    ruleId: null,
    url: waiter.url,
    credential: null,
    waiters: [waiter],
    watchdog: null,
    dialogRunning: false
  }
  spaces.set(key, space)
  void runDialogRounds(space)
}

const groupKeyOf = (waiter: Waiter): string => waiter.groupId

/**
 * ダイアログは**照合結果のグループごとに 1 つ**。
 *
 * protection space 全体で 1 つにすると、先頭ルールが拒否されたときに
 * その手入力を別ルール・`no-rule` の URL にも送ってしまう。
 * 逆に集約しないと、既存の `ask` は要求ごとに直列表示するので
 * **保護リソースの数だけ同じダイアログが出て**、1 件目で直しても残りが消えず
 * #6 の自己修復が壊れる。
 */
async function runDialogRounds(space: Space): Promise<void> {
  if (space.dialogRunning) return
  space.dialogRunning = true
  try {
    while (space.waiters.length > 0) {
      const groupKey = groupKeyOf(space.waiters[0])
      /*
       * **回答を受ける前に callback 群を切り離す。**
       * そのあとの保存は #19 の「資格情報変更 → 実行時状態の全消し」を呼ぶので、
       * 切り離していないと配る相手を自分で消してしまう。
       */
      const group = space.waiters.filter((waiter) => groupKeyOf(waiter) === groupKey)
      space.waiters = space.waiters.filter((waiter) => groupKeyOf(waiter) !== groupKey)

      /*
       * **代表は「拒否された要求」を優先して選ぶ。**
       * 保護サブリソースが複数あるページでは、先頭は「自動入力の順番待ちだった要求」で、
       * `rejected: false` / `prefill: null` / `rejectedRule: null` を持つ。
       * それを代表にすると、prefill も「拒否されました」の表示も出ないうえ、
       * 保存が **`patternFromUrl` からの新規作成**に倒れて元ルールが残り、
       * 別 URL では再び誤った資格情報が飛ぶ（#6 の自己修復が成立しない）。
       */
      const head = group.find((waiter) => waiter.rejected) ?? group[0]

      const answer = await askAuth(head)
      try {
        if (answer?.kind === 'auth' && answer.save) await saveFromDialog(head, answer)
      } finally {
        // **配布は finally で行い、保存の成否に依存させない。**
        // 保存失敗がページの認証そのものを失敗させてはいけない
        deliver(group, answer)
        if (answer?.kind === 'auth') markDelivered(space, group)
      }
    }
  } finally {
    space.dialogRunning = false
    if (space.waiters.length === 0 && spaces.get(space.key) === space) spaces.delete(space.key)
  }
}

function askAuth(waiter: Waiter): Promise<PromptAnswer | null> {
  return ask(waiter.windowId, {
    type: 'auth',
    host: waiter.host,
    realm: waiter.realm,
    isProxy: waiter.isProxy,
    canSave: waiter.canSave,
    rejected: waiter.rejected,
    ...(waiter.prefill ? { prefill: waiter.prefill } : {})
  })
}

/**
 * たった今配った資格情報を、**直後に自動入力でもう一度送らない**ようにする。
 *
 * ダイアログで保存すると `httpAuthCredentialsChanged()` が `attempts` / `denied` を全消しする
 * （#19: 資格情報を変えたら両方必ず）。その直後に `deliver` するので、
 * **打ち直したパスワードも間違っていた場合、同じ値が「手入力の 1 回」と
 * 「直後の自動入力の 1 回」で 2 回飛ぶ**——#11 のアカウントロック回避に反する。
 *
 * 抑止は**配った URL 単位**にする。`denied`（protection space 単位）を残す形にすると、
 * 正しく直したあとも同じタブの別パス階層で 401 が出るたびにダイアログが出続ける
 * （Chromium の認証キャッシュはパス接頭辞単位なので実際に起こる）。
 *
 * 打ち直しが正しければ 200 で終わって `login` が飛ばないので何も起きず、
 * ここで立てた値は次の `did-start-navigation` で消える。
 */
function markDelivered(space: Space, group: Waiter[]): void {
  for (const waiter of group) {
    attempts.set(attemptKeyOf(space.wcId, waiter.scheme, waiter.url), 1)
  }
}

function deliver(group: Waiter[], answer: PromptAnswer | null): void {
  if (answer?.kind === 'auth') {
    log('auth.submitted', { count: group.length })
    for (const waiter of group) waiter.callback(answer.username, answer.password)
  } else {
    log('auth.cancelled', { count: group.length })
    for (const waiter of group) waiter.callback()
  }
}

/**
 * ダイアログの「次回から自動で入力する」。
 *
 * **保存条件は main が保持する `waiter.canSave && answer.save`。**
 * `answer.save` だけを信じると、renderer の不具合や改変された IPC から
 * プロキシ・シークレット・クロスオリジンの資格情報も保存できてしまう。
 * チェックボックスを出さないことは認可にならない。
 */
async function saveFromDialog(
  waiter: Waiter,
  answer: Extract<PromptAnswer, { kind: 'auth' }>
): Promise<void> {
  if (!waiter.canSave) {
    log('http_auth.save_refused', { reason: 'not-eligible' })
    return
  }
  /*
   * **`rejected` なら採用されたルールを更新する。**
   * ここで `patternFromUrl` から新規作成すると、ワイルドカードやインポート済みのルールを
   * 直しても元ルールが残り、別 URL では再び誤った資格情報が飛ぶ（#6 の自己修復が成立しない）。
   */
  const existing = waiter.rejected ? waiter.rejectedRule : null
  const pattern = existing ? existing.pattern : patternFromUrl(waiter.url)
  if (pattern === null) return
  const result = await saveHttpAuthRule({
    id: existing?.id ?? null,
    pattern,
    username: answer.username,
    password: answer.password
  })
  if (result.ok) {
    await httpAuthCredentialsChanged('dialog-save')
    return
  }
  /*
   * **保存に失敗したら Nemo の UI で知らせる。** この時点では callback に資格情報を
   * 渡すだけで**認証成功はまだ確定していない**ので、「認証は続行中」と書く
   * （「認証は通ったが保存できなかった」だと、誤った資格情報のときに直後の拒否ダイアログと矛盾する）。
   * 黙って落とすと、チェックを付けた本人は保存済みだと思ったまま再起動後に同じ入力を求められる。
   */
  log('http_auth.save_failed', { reason: result.reason })
  void ask(waiter.windowId, {
    type: 'notice',
    title: '資格情報を保存できませんでした（認証は続行中）',
    detail:
      result.reason === 'no-encryption'
        ? 'この端末では暗号化ストレージが使えないため、パスワードを保存しませんでした。'
        : `保存に失敗しました（${result.reason}）。設定 > HTTP 認証 から登録し直せます。`
  })
}

/* ------------------------------------------------------------------ *
 * 資格情報が変わったときの実行時状態の掃除
 * ------------------------------------------------------------------ */

/**
 * `attempts` / `denied` / 直列化キューを全消しする。
 *
 * **`clearAuthCache()` と必ず両方行う**（`http-auth-reset.ts` が `finally` で呼ぶ）。
 * 片方だけだと、一度成功した URL の `attempts` が残ったまま認証キャッシュだけ消え、
 * 次の 401 が「2 回目＝拒否された」と判定されて新しい資格情報が使われない。
 *
 * **未解決の callback は残さない。** 自動入力待ちの space はダイアログへ倒す
 * （キャンセルすると、進行中のページの認証を資格情報の編集が壊す）。
 */
export function resetHttpAuthRuntime(): void {
  attempts.clear()
  denied.clear()
  for (const space of [...spaces.values()]) {
    if (space.mode !== 'autofill') continue
    if (space.watchdog) clearTimeout(space.watchdog)
    space.watchdog = null
    space.mode = 'dialog'
    space.credential = null
    void runDialogRounds(space)
  }
}
