// @ts-check
/**
 * ページの main world に入れる `navigator.credentials.get` / `create` の読み替え
 * （WebAuthn の宙吊り対策）。
 *
 * Electron 41 はプラットフォーム認証器（Touch ID / iCloud キーチェーンのパスキー）を持たず
 * `isUserVerifyingPlatformAuthenticatorAvailable()` は false を返す。ところが **modal の
 * `get({ publicKey })` / `create({ publicKey })` は解決も拒否もされず永久に宙吊りになる**
 * （`timeout` を過ぎても pending のまま。Chrome なら timeout でエラー表示 → 閉じると
 * NotAllowedError で reject されるところを、Electron には表示する UI が無いので「閉じる」が
 * 永遠に来ない。同じ frame で 2 件目を投げると "already pending" で即拒否されるので、
 * 同時に撃つ実測では「2 件目以降は即拒否」に見える。1 件ずつ別タブで撃つと全部宙吊り）。
 * login.live.com の「パスキーでサインイン」がこれを踏み、サイト側のブロッキング表示が
 * 待ち続けてページ全体がクリック無反応に見える（2026-09-01 に実地で確定。CDP の実測では
 * 8〜24 秒の timeout を過ぎても pending のまま）。
 *
 * isUVPAA() を事前に見て要求を出さないサイトなら踏まないが、パスキーボタンを出すサイトの
 * 多くは見ないので、main world 側で **Chrome が最終的に返す結果（NotAllowedError）を
 * 先に返す**:
 *
 * - `publicKey` 以外（password / federated）と `mediation: 'conditional'`（自動補完。
 *   ページが裏で待たせ続ける前提の要求で、Chrome でも timeout しない）は素通し
 * - isUVPAA() が false で、要求が **UI 無しのローミング認証器（USB / NFC / BLE の
 *   セキュリティキー）では答えられない**ものなら、native を呼ばずに NotAllowedError で
 *   即 reject する。native を呼んでから見捨てると frame に pending が残り、以後の要求が
 *   "A request is already pending" で全滅するので**呼ばない**
 *   - `get`: `allowCredentials` が空 / 無し（検出可能資格情報 = パスキー）はアカウント選択の
 *     UI が要るので答えられない → 拒否。すべての `allowCredentials` の `transports` が
 *     `internal`（端末内蔵）/ `hybrid`（スマホの QR。表示する UI が無い）だけ → 拒否。
 *     `transports` が無い・空のエントリがある、または USB 等が含まれる → 素通し
 *     （キーを挿して触れば答えられる想定。**Nemo で USB キーが実際に完了するかは未確認**、
 *     2026-09-02 時点で手元にキーが無い。確認できるまで「拒否しない」側に倒している）
 *   - `create`: `authenticatorSelection.authenticatorAttachment` が `'platform'` → 拒否。
 *     `'cross-platform'` / 無指定 → 素通し
 * - 素通しした modal の要求にも **timeout を自前で効かせる**（要求の `timeout` は Chromium の
 *   AdjustTimeout と同じ 10 秒〜10 分に丸める。無指定は Chromium なら 10 分だが、Nemo には
 *   待ちを見せる UI が無いので**意図的に 60 秒**）。期限が来たら NotAllowedError で reject し、
 *   native の要求も `AbortSignal` で abort する（放置すると frame に pending が残り、以後の
 *   要求が "A request is already pending" で全滅してサイトの「もう一度」が死ぬ）。
 *   サイトが `signal` を渡していれば `AbortSignal.any` で合成する
 * - isUVPAA() が true（`app.configureWebAuthn` を入れた将来）や例外なら判定を諦めて
 *   素通し（timeout だけ効かせる）。他サイトの挙動を「壊さない」側に倒す。判定の例外も同じ。
 *   なお `app.configureWebAuthn({ enableHybridTransport })` で hybrid（スマホ QR）だけ通す
 *   ようにしても isUVPAA() は false のままなので、そのときは hybrid を UI_ONLY から外す
 *   別のゲートが要る（今は入れていない）
 * - **isUVPAA() は preload の時点（ページ・拡張のスクリプトより前）で native を捕まえて使う**。
 *   Bitwarden の passkey 用 page script（`fido2-page-script.js`、MAIN world）は native が
 *   false だと `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable` を
 *   **true に差し替える**ので、呼び出し時に読むと Bitwarden 注入後は必ず素通しになり、
 *   Bitwarden が保管庫に無い・キャンセル等で native へ fallback したときにまた宙吊りになる。
 *   Bitwarden は注入時に `navigator.credentials.get` を bind して fallback 先に使うので、
 *   先に入っているこのシムが fallback 先になる（= fallback は即 NotAllowedError）
 *
 * **サブフレームには配られない**（Electron の preload はトップフレームだけ）。ログイン画面を
 * iframe に入れるサイトでは効かないが、login.live.com / accounts.google.com 等の主要な
 * サインインはトップフレームで完結する。
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない。
 * 配る経路は `src/preload/extension-shim.ts`（通常セッション）と
 * `src/main/page-shim.ts` の登録（シークレットセッション）。
 */
export function installWebAuthnShim() {
  const g = /** @type {any} */ (globalThis)
  const credentials = g.navigator?.credentials
  const PublicKeyCredential = g.PublicKeyCredential
  const DOMExceptionCtor = g.DOMException
  // secure context でない（素の http）・WebAuthn を持たない環境では何もしない
  if (
    !credentials ||
    typeof credentials.get !== 'function' ||
    typeof PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable !== 'function' ||
    typeof DOMExceptionCtor !== 'function'
  ) {
    return
  }

  // native の isUVPAA を今（ページ・拡張のスクリプトより前）1 回だけ呼んで結果を持つ。
  // 後から差し替えられても影響を受けず、frame の寿命中に変わる値でもない。失敗は null（素通し側）
  // **同期で呼ぶ**（マイクロタスクに遅らせると、その前に走った差し替えを拾う）
  /** @type {Promise<boolean | null>} */
  let uvpaaOnce
  try {
    uvpaaOnce = Promise.resolve(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).then(
      (available) => (typeof available === 'boolean' ? available : null),
      () => null
    )
  } catch {
    uvpaaOnce = Promise.resolve(null)
  }

  // Chrome が timeout / 拒否で返すのと同じ文言（サイト側の分岐が message を見ていても揃う）
  const NOT_ALLOWED_MESSAGE =
    'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.'
  const notAllowed = () => new DOMExceptionCtor(NOT_ALLOWED_MESSAGE, 'NotAllowedError')

  // 指定ありは Chromium の AdjustTimeout と同じ丸め（10 秒〜10 分）。
  // 無指定は Chromium なら上限の 10 分（AdjustTimeout は未指定で kAdjustedTimeoutUpper を返す）だが、
  // Nemo には待ちを見せる UI が無いので、ここだけ意図的に短い 60 秒にしている（Chrome には合わせていない）
  const TIMEOUT_MIN = 10_000
  const TIMEOUT_MAX = 600_000
  const TIMEOUT_DEFAULT = 60_000
  /** @param {unknown} value */
  const clampTimeout = (value) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : TIMEOUT_DEFAULT
    return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, n))
  }

  /** UI が無いと答えられない transport（端末内蔵・スマホ QR） */
  const UI_ONLY_TRANSPORTS = new Set(['internal', 'hybrid'])
  /**
   * ローミング認証器（USB / NFC / BLE 等）で答えられる可能性があるか。
   * 無い（= 端末内蔵かパスキーの UI が要る）なら Electron では永遠に答えが出ない。
   * @param {unknown} allowCredentials
   */
  const roamingPossible = (allowCredentials) => {
    if (allowCredentials == null) return false // 検出可能資格情報（パスキー）
    /** @type {unknown[]} */
    let list
    const iterator = /** @type {any} */ (allowCredentials)[Symbol.iterator]
    if (Array.isArray(allowCredentials)) list = allowCredentials
    else if (typeof iterator === 'function') {
      try {
        list = Array.from(/** @type {Iterable<unknown>} */ (allowCredentials))
      } catch {
        return true // 読めないものは判定しない（素通し）
      }
    } else return true
    if (list.length === 0) return false
    for (const cred of list) {
      const transports = /** @type {any} */ (cred)?.transports
      if (!Array.isArray(transports) || transports.length === 0) return true // 不明 → 素通し
      if (transports.some((t) => !UI_ONLY_TRANSPORTS.has(String(t)))) return true
    }
    return false
  }

  /**
   * 差し替えた関数の見た目を元の関数に寄せる（name / length / toString）。
   * anti-bot が `toString()` の `[native code]` を見ることがあるので、露出面を減らす
   * @param {Function} fn @param {Function} original
   */
  const mask = (fn, original) => {
    try {
      Object.defineProperty(fn, 'name', { value: original.name })
      Object.defineProperty(fn, 'length', { value: original.length })
      fn.toString = original.toString.bind(original)
    } catch {
      /* 見た目の話なので失敗しても機能は変わらない */
    }
    return fn
  }

  /**
   * @param {'get' | 'create'} method
   * @param {(publicKey: any) => boolean} answerable UI 無しのローミング認証器で答えられるか
   */
  const wrap = (method, answerable) => {
    const original = credentials[method]
    if (typeof original !== 'function') return
    const real = original.bind(credentials)

    /**
     * @param {unknown[]} args
     * @param {number} timeoutMs
     */
    const callWithTimeout = (args, timeoutMs) =>
      new Promise((resolve, reject) => {
        // timeout で native の要求も abort する（pending を残すと以後の要求が "already pending" になる）。
        // サイトが signal を渡していれば合成する。合成できない環境ではサイトの signal を優先して abort は諦める
        const options = /** @type {any} */ (args[0])
        const siteSignal = options?.signal
        const controller = typeof g.AbortController === 'function' ? new g.AbortController() : null
        let signal = controller?.signal ?? null
        if (siteSignal && signal) {
          signal = typeof g.AbortSignal?.any === 'function' ? g.AbortSignal.any([siteSignal, signal]) : null
        }
        const callArgs = signal ? [{ ...options, signal }, ...args.slice(1)] : args
        const timer = setTimeout(() => {
          console.warn(
            `[nemo] WebAuthn の ${method}() が ${Math.round(timeoutMs / 1000)} 秒以内に完了しなかったので NotAllowedError で打ち切った（Nemo は Touch ID / iCloud パスキーに未対応。パスワード等の別の方法でサインインする）`
          )
          reject(notAllowed())
          if (signal && controller) controller.abort()
        }, timeoutMs)
        let result
        try {
          result = real(...callArgs)
        } catch (error) {
          clearTimeout(timer)
          reject(error)
          return
        }
        Promise.resolve(result).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          }
        )
      })

    credentials[method] = mask(
      /** @param {unknown[]} args */ (...args) => {
        const options = /** @type {any} */ (args[0])
        const publicKey = options?.publicKey
        if (!publicKey || typeof publicKey !== 'object' || options.mediation === 'conditional') {
          return real(...args)
        }
        return (async () => {
          const uvpaa = await uvpaaOnce
          let ok = true
          if (uvpaa === false) {
            try {
              ok = answerable(publicKey)
            } catch {
              ok = true // 判定できないオプション（getter が投げる等）は素通し側に倒す
            }
          }
          if (!ok) {
            console.warn(
              `[nemo] WebAuthn の ${method}() を NotAllowedError で拒否した（Nemo は Touch ID / iCloud パスキーに未対応で、この要求はセキュリティキーでも答えられない。パスワード等の別の方法でサインインする）`
            )
            throw notAllowed()
          }
          return await callWithTimeout(args, clampTimeout(publicKey.timeout))
        })()
      },
      original
    )
  }

  wrap('get', (publicKey) => roamingPossible(publicKey.allowCredentials))
  wrap('create', (publicKey) => publicKey.authenticatorSelection?.authenticatorAttachment !== 'platform')
}
