// @ts-check
/**
 * HTTP Basic 認証の自動入力（MultiPass 相当）の**純粋ロジック**。
 *
 * Electron を一切 import しない。main（TS）と `scripts/*.test.mjs` の両方から
 * 同じ実装を読むため plain `.js` に置く（`settings-schema.js` / `navigation-policy.js` と同じ形）。
 *
 * ここが持つのは:
 * - ユーザーが書いた正規表現を通してよいかの判定（`validateHttpAuthPattern`）
 * - 上限（件数・長さ）の**唯一の定義**（全保存入口が同じ値を使う）
 * - 照合と優先順（`matchRules` / `rankRules`）
 * - 自動入力の可否と保存適格の**唯一の述語**（`evaluateEligibility`）
 * - MultiPass のエクスポートの取り込み（`convertMultipassPattern` / `importMultipass`）
 *
 * **実際の照合は main スレッドで走らせない**（`src/main/http-auth-matcher.ts` の
 * 常駐ワーカーを通す）。ここの `matchRules` は同期の純粋関数のまま残し、
 * 単体テストと「ワーカーと判定が食い違っていないか」の突き合わせに使う。
 */

/**
 * 件数と長さの上限。**全保存入口（ダイアログ・Settings・インポート）と
 * `normalizeRules` で共通に適用する**。
 *
 * 入口ごとに違う値を使うと、「入力した値」と「実際に保存・送信される値」が食い違う。
 * renderer の入力欄の `maxLength` にも同じ値を渡す。
 */
export const HTTP_AUTH_LIMITS = {
  /** 保存できるルールの件数。 */
  MAX_RULES: 200,
  /** パターン（正規表現）の文字数。 */
  MAX_PATTERN: 200,
  /** ユーザー名の文字数。 */
  MAX_USERNAME: 256,
  /** パスワードの文字数（**平文**の上限）。 */
  MAX_PASSWORD: 512,
  /** 保存する暗号文（base64）の文字数。平文より必ず長くなるので別に持つ。 */
  MAX_CIPHERTEXT: 8192,
  /** 照合する URL の文字数。超えたら照合しない（`canSave` も false になる）。 */
  MAX_URL: 2048
}

/**
 * 正規表現 1 件の照合に許す時間（ミリ秒）。
 *
 * **短縮できるようにはしない**。縮めると「どのルールがタイムアウトするか」= 判定の中身が
 * 変わってしまう。自走検証は既定値のまま超える敵対的パターンを撃つ。
 */
export const HTTP_AUTH_PATTERN_TIMEOUT_MS = 250

/** `disabledReason` に立てられる値。 */
export const HTTP_AUTH_DISABLED_REASONS = ['pattern-timeout', 'decrypt-failed']

/* ------------------------------------------------------------------ *
 * パターンの検証
 * ------------------------------------------------------------------ */

/**
 * 量化子を読む。
 * @param {string} pattern
 * @param {number} at
 * @returns {{ found: boolean, max: number, end: number }} `end` は量化子の次の位置
 */
function readQuantifier(pattern, at) {
  const ch = pattern[at]
  /** @type {{ found: boolean, max: number, end: number }} */
  let result = { found: false, max: 0, end: at }
  if (ch === '*' || ch === '+') result = { found: true, max: Infinity, end: at + 1 }
  else if (ch === '?') result = { found: true, max: 1, end: at + 1 }
  else if (ch === '{') {
    const close = pattern.indexOf('}', at)
    const body = close === -1 ? '' : pattern.slice(at + 1, close)
    const range = /^(\d+)(,(\d*)?)?$/.exec(body)
    if (range) {
      const min = Number(range[1])
      const max = range[2] === undefined ? min : range[3] ? Number(range[3]) : Infinity
      result = { found: true, max, end: close + 1 }
    }
  }
  // 遅延量化子（`+?`）の `?` を食う
  if (result.found && pattern[result.end] === '?') result.end += 1
  return result
}

/**
 * ユーザーが書いた正規表現を通してよいか。
 *
 * **これが危険な正規表現を弾く唯一の関門**。編集 / インポート / `normalizeRules` /
 * テスターの**全入口**でここを通す。どれか 1 つでも迂回できると、
 * Settings が拒否したパターンが再起動後の認証照合に現れる。
 *
 * 拒否するもの:
 * - 長すぎるもの（`HTTP_AUTH_LIMITS.MAX_PATTERN` 超）
 * - `new RegExp` が受け付けないもの
 * - 後方参照（`\1` / `\k<name>`）
 * - lookaround（`(?=` / `(?!` / `(?<=` / `(?<!`）
 * - **量化されたグループの中に量化子か alternation があるもの**（`(a+)+` / `^(a|aa)+$`）。
 *   どちらも 10 文字未満なので**長さ上限だけでは防げない**
 *
 * ただし**外側の量化子が最大 1 回（`?` / `{0,1}`）なら対象外**にする。
 * 組合せ爆発を起こさないうえ、禁じると `convertMultipassPattern` が生成する
 * `^https://([^/]+\.)?example\.com/` 自身が弾かれ、変換したルールが全部落ちる。
 *
 * **これは第一の関門であって保証ではない**。ここに載っていない高コストなパターン
 * （`[a-z]+[a-z]+…` のような連続する量化子）は通る。だから照合そのものを
 * main スレッドから隔離し、タイムアウト付きで呼ぶ（`src/main/http-auth-matcher.ts`）。
 *
 * @param {unknown} pattern
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateHttpAuthPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, reason: 'empty' }
  if (pattern.length > HTTP_AUTH_LIMITS.MAX_PATTERN) return { ok: false, reason: 'too-long' }
  try {
    new RegExp(pattern)
  } catch {
    return { ok: false, reason: 'syntax' }
  }

  /** @type {{ hasQuantifier: boolean, hasAlternation: boolean }[]} */
  const stack = []
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1] ?? ''
      if (!inClass && (/[1-9]/.test(next) || next === 'k')) return { ok: false, reason: 'backreference' }
      i += 1
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      if (/^\(\?(=|!|<=|<!)/.test(pattern.slice(i))) return { ok: false, reason: 'lookaround' }
      // `(?:` / `(?<name>` のグループ種別を読み飛ばす
      const kind = /^\(\?(:|<[A-Za-z_$][A-Za-z0-9_$]*>)/.exec(pattern.slice(i))
      if (kind) i += kind[0].length - 1
      stack.push({ hasQuantifier: false, hasAlternation: false })
      continue
    }
    if (ch === ')') {
      const frame = stack.pop()
      const quantifier = readQuantifier(pattern, i + 1)
      if (frame && quantifier.max > 1 && (frame.hasQuantifier || frame.hasAlternation)) {
        return { ok: false, reason: 'nested-quantifier' }
      }
      const parent = stack[stack.length - 1]
      if (parent && frame) {
        // 中身の量化子・alternation は**親にも伝える**（`((a|b))+` を素通ししない）
        parent.hasQuantifier = parent.hasQuantifier || frame.hasQuantifier || quantifier.found
        parent.hasAlternation = parent.hasAlternation || frame.hasAlternation
      }
      i = quantifier.end - 1
      continue
    }
    if (ch === '|') {
      const frame = stack[stack.length - 1]
      if (frame) frame.hasAlternation = true
      continue
    }
    const quantifier = readQuantifier(pattern, i)
    if (quantifier.found) {
      const frame = stack[stack.length - 1]
      if (frame) frame.hasQuantifier = true
      i = quantifier.end - 1
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * オリジン
 * ------------------------------------------------------------------ */

/**
 * `https://example.com` の形にする。http/https 以外は null。
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeHttpOrigin(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * リクエストとページが同一オリジンか。
 *
 * どちらかが http/https でなければ **false**。
 * ナビゲーションが未 commit の新規タブは `about:blank` なので、
 * ここを true に倒すと同一オリジン制約が丸ごと無くなる。
 *
 * @param {string | null | undefined} requestUrl
 * @param {string | null | undefined} pageUrl
 */
export function isSameHttpOrigin(requestUrl, pageUrl) {
  const request = normalizeHttpOrigin(requestUrl)
  const page = normalizeHttpOrigin(pageUrl)
  return request !== null && page !== null && request === page
}

/* ------------------------------------------------------------------ *
 * パターンの生成と照合
 * ------------------------------------------------------------------ */

/**
 * 正規表現のメタ文字を落とす。`/` と `:` は落とさない（読める形にする）。
 * @param {string} value
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * URL から**オリジン全体を固定した**パターンを作る。
 *
 * **スキームを固定する**（#3）。`https?` にすると、https で登録した資格情報が
 * http に平文で飛ぶ事故になる。既定ポートは `URL.origin` に出ないので付かない。
 *
 * @param {string} url
 * @returns {string | null} http/https でなければ null
 */
export function patternFromUrl(url) {
  const origin = normalizeHttpOrigin(url)
  return origin === null ? null : `^${escapeRegExp(origin)}/`
}

/**
 * @typedef {object} RankableRule
 * @property {string} id
 * @property {string} pattern
 * @property {boolean} [enabled]
 * @property {string} [disabledReason]
 */

/**
 * 実効的に有効か。**`disabledReason` がある間は `enabled` に関わらず無効**
 * （両者が独立していると、理由が残ったまま ON にできる状態が生まれる）。
 * @param {RankableRule} rule
 */
export function isRuleActive(rule) {
  return rule.enabled !== false && !rule.disabledReason
}

/**
 * 照合せずに**順序だけ**決める（パターンが長いほど優先。同点は登録順）。
 *
 * 正規表現を 1 つも実行しないので、main スレッドで呼んでよい。
 * ワーカーには**この順で 1 件ずつ**渡し、最初に一致したものが勝ち。
 *
 * @template {RankableRule} T
 * @param {T[]} rules
 * @returns {T[]}
 */
export function rankRules(rules) {
  return rules
    .filter(isRuleActive)
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.pattern.length - a.rule.pattern.length || a.index - b.index)
    .map((item) => item.rule)
}

/**
 * 同期の照合（**単体テストとワーカーとの突き合わせ用**）。
 * 本番の照合はワーカー経由で行う。
 *
 * @template {RankableRule} T
 * @param {T[]} rules
 * @param {string} url
 * @returns {T[]} パターン長の降順 → 登録順
 */
export function matchRules(rules, url) {
  if (typeof url !== 'string' || url.length > HTTP_AUTH_LIMITS.MAX_URL) return []
  return rankRules(rules).filter((rule) => {
    try {
      return new RegExp(rule.pattern).test(url)
    } catch {
      // 壊れた正規表現は握り潰してスキップ（他のルールは生かす）
      return false
    }
  })
}

/* ------------------------------------------------------------------ *
 * 適格判定
 * ------------------------------------------------------------------ */

/**
 * 自動入力の可否と `canSave` を決める**唯一の述語**。
 *
 * `resolveCredential` とダイアログ生成の両方がこの戻り値を使う。
 * 別々に条件を書くと片方だけがテストされる状態に戻り、
 * 「保存できるのに次回も使われないルール」が生まれる。
 *
 * **`reason` は診断ログに出す**（`auth.not_autofilled`）。
 * 「なぜ自動入力されなかったのか」を残さないと、この機能が静かに効かなくなったときに
 * クロスオリジンなのか・非 Basic なのか・ルールが無いのかを切り分ける手段が無い。
 * だから `isTab` も畳まずに独立した理由として持つ（挙動は `isPrivate` と同じでも、
 * ログが「シークレットだった」と嘘をつかないようにする）。
 *
 * @param {object} input
 * @param {boolean} input.isProxy プロキシ認証か（#8: 対象外）
 * @param {string} input.scheme `authInfo.scheme`（`basic` のときだけ扱う）
 * @param {boolean} input.isPrivate シークレットウィンドウか（#7: 一切使わない）
 * @param {boolean} input.isTab タブとして解決できた WebContents か（拡張の popup 等は false）
 * @param {boolean} input.isSameOrigin リクエストがタブの（遷移中を含む）URL と同一オリジンか
 * @param {boolean} input.canEncrypt 端末鍵が使えるか（#13）
 * @param {boolean} input.isUrlTooLong 照合する URL が長すぎるか
 * @returns {{ canAutofill: boolean, canSave: boolean, reason: string | null }}
 */
export function evaluateEligibility({
  isProxy,
  scheme,
  isPrivate,
  isTab,
  isSameOrigin,
  canEncrypt,
  isUrlTooLong
}) {
  /** @type {string | null} */
  let reason = null
  if (isProxy) reason = 'proxy'
  else if (String(scheme ?? '').toLowerCase() !== 'basic') reason = 'scheme'
  else if (isPrivate) reason = 'private'
  else if (!isTab) reason = 'not-a-tab'
  else if (!isSameOrigin) reason = 'cross-origin'
  else if (isUrlTooLong) reason = 'url-too-long'
  if (reason !== null) return { canAutofill: false, canSave: false, reason }
  // 暗号化できない端末では**保存を断る**が、既に読めるルールがあれば使ってよい
  return { canAutofill: true, canSave: canEncrypt === true, reason: canEncrypt ? null : 'no-encryption' }
}

/* ------------------------------------------------------------------ *
 * 保存 JSON の正規化
 * ------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @typedef {object} StoredRule
 * @property {string} id
 * @property {string} pattern
 * @property {string} username
 * @property {string} password base64 の暗号文
 * @property {boolean} enabled
 * @property {string} [importedFrom] 変換元の MultiPass パターン
 * @property {string} [disabledReason] `'pattern-timeout'` / `'decrypt-failed'`
 */

/**
 * 保存 JSON を正規化する。
 * **`validateHttpAuthPattern` と上限を通らないルールは落とす**（黙って切り詰めない）。
 *
 * @param {unknown} raw
 * @returns {StoredRule[]}
 */
export function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {StoredRule[]} */
  const rules = []
  const seen = new Set()
  for (const item of raw) {
    if (rules.length >= HTTP_AUTH_LIMITS.MAX_RULES) break
    if (!isRecord(item)) continue
    const id = item['id']
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || seen.has(id)) continue
    const pattern = item['pattern']
    if (!validateHttpAuthPattern(pattern).ok) continue
    const username = item['username']
    if (typeof username !== 'string' || username.length > HTTP_AUTH_LIMITS.MAX_USERNAME) continue
    const password = item['password']
    if (typeof password !== 'string' || password.length > HTTP_AUTH_LIMITS.MAX_CIPHERTEXT) continue
    const importedFrom = item['importedFrom']
    const disabledReason = item['disabledReason']
    /** @type {StoredRule} */
    const rule = {
      id,
      pattern: /** @type {string} */ (pattern),
      username,
      password,
      enabled: item['enabled'] !== false
    }
    if (typeof importedFrom === 'string' && importedFrom.length <= HTTP_AUTH_LIMITS.MAX_PATTERN) {
      rule.importedFrom = importedFrom
    }
    if (typeof disabledReason === 'string' && HTTP_AUTH_DISABLED_REASONS.includes(disabledReason)) {
      rule.disabledReason = disabledReason
    }
    seen.add(id)
    rules.push(rule)
  }
  return rules
}

/* ------------------------------------------------------------------ *
 * MultiPass の取り込み
 * ------------------------------------------------------------------ */

/** 裸のホスト名（+ 任意ポート）。`label(.label)+` に厳密一致するものだけ。 */
const BARE_HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?$/

/**
 * MultiPass のパターンを Nemo の正規表現へ変換する。
 *
 * 当てるのは**裸のホスト名（+ 任意ポート）の形にだけ**。
 * scheme を含む / `/` を含む / IP アドレス / `.` 以外のメタ文字を含むものは**素通し**。
 * ここを緩くすると `https://example.com/` や `example.com/admin` を壊れたパターンに変換してしまう。
 *
 * **`https?` にはしない**（#17）。裸のホスト名から `https?` を作ると、
 * https で使っていた資格情報が http に平文で飛ぶ。
 *
 * @param {string} pattern
 * @returns {{ pattern: string, converted: boolean }}
 */
export function convertMultipassPattern(pattern) {
  const passthrough = { pattern, converted: false }
  if (typeof pattern !== 'string' || !BARE_HOST.test(pattern)) return passthrough
  const [host, port] = pattern.split(':')
  // IP アドレスは素通し（サブドメインの概念が無く、`([^/]+\.)?` を付けると意味が変わる）
  if (/^\d+(\.\d+)+$/.test(host)) return passthrough
  if (port !== undefined && Number(port) > 65535) return passthrough
  return { pattern: `^https://([^/]+\\.)?${escapeRegExp(pattern)}/`, converted: true }
}

/**
 * @typedef {object} ImportEntry
 * @property {string | null} id 既存の同じパターンのルール ID（無ければ null＝新規採番）
 * @property {string} pattern
 * @property {string} username
 * @property {string} password **平文**（暗号化はストアが行う）
 * @property {string | null} importedFrom 変換したときだけ変換元を残す
 */

/**
 * MultiPass のエクスポートを取り込む。
 *
 * 受け付ける形は**オブジェクトと配列の両方**。実際のエクスポートは
 * `JSON.stringify(credentials)` でハッシュをキーにしたオブジェクトだが、
 * ドキュメントの例は配列（MultiPass の `parse_json` が `for...in` なので両方通る）。
 *
 * **拒否があっても中止しない**（#22）。通ったものだけ取り込み、
 * 拒否分はパターンと理由付きで返す（1 件のせいで移行が丸ごと止まらないように）。
 *
 * priority は捨てる。**実効値（`Number(priority ?? 1)`）が一様でなければ一括で警告**する。
 * どのルールの順序が変わるかは特定しない（任意の正規表現が重なるかの判定は定義できない）。
 *
 * @param {unknown} json JSON テキスト / 配列 / オブジェクト
 * @param {{ id: string, pattern: string }[]} existing 既存ルール（同じパターンは上書き）
 * @returns {{ entries: ImportEntry[], rejected: { pattern: string, reason: string }[], priorityWarning: boolean }}
 */
export function importMultipass(json, existing) {
  /** @type {ImportEntry[]} */
  const entries = []
  /** @type {{ pattern: string, reason: string }[]} */
  const rejected = []

  let source = json
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return { entries: [], rejected: [{ pattern: '', reason: 'parse-failed' }], priorityWarning: false }
    }
  }
  /** @type {unknown[]} */
  let items
  if (Array.isArray(source)) items = source
  else if (isRecord(source)) items = Object.values(source)
  else return { entries: [], rejected: [{ pattern: '', reason: 'parse-failed' }], priorityWarning: false }

  const priorities = new Set()
  const current = existing ?? []
  const byPattern = new Map(current.map((rule) => [rule.pattern, rule.id]))
  /** このファイルの中で既に作ったパターン → `entries` の添字。 */
  const seen = new Map()
  /*
   * 件数上限は**既存との合算**で見る。取り込む件数だけで見ると、
   * 既存 100 件 + 取り込み 150 件のときに `normalizeRules` が末尾を黙って切り、
   * 「取り込んだと表示されたのに存在しないルール」ができる（拒否理由も出ない）。
   */
  let total = current.length

  for (const raw of items) {
    if (!isRecord(raw)) {
      rejected.push({ pattern: '', reason: 'missing-fields' })
      continue
    }
    const item = raw
    const url = item['url']
    const username = item['username']
    const password = item['password']
    const shown = typeof url === 'string' ? url.slice(0, HTTP_AUTH_LIMITS.MAX_PATTERN) : ''
    if (typeof url !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
      rejected.push({ pattern: shown, reason: 'missing-fields' })
      continue
    }
    const priority = Number(item['priority'] ?? 1)
    priorities.add(Number.isFinite(priority) ? priority : 1)

    if (username.length > HTTP_AUTH_LIMITS.MAX_USERNAME || password.length > HTTP_AUTH_LIMITS.MAX_PASSWORD) {
      rejected.push({ pattern: shown, reason: 'too-long' })
      continue
    }
    const converted = convertMultipassPattern(url)
    const check = validateHttpAuthPattern(converted.pattern)
    if (!check.ok) {
      rejected.push({ pattern: shown, reason: check.reason === 'too-long' ? 'too-long' : 'invalid-pattern' })
      continue
    }
    const existingId = byPattern.get(converted.pattern) ?? null
    const at = seen.get(converted.pattern)
    if (at !== undefined) {
      /*
       * **同じファイルの中で同じパターンが 2 回出てきたら後勝ちで上書きする。**
       * MultiPass は url + username でキーが割れるので実際に起こる。
       * 2 件目を新規採番すると同一パターンのルールが 2 件並び、
       * `matchRules` は同点なら登録順で先勝ちなので**2 件目は永久に使われない**
       * （一覧には出るのに効かないルールができる）。
       */
      entries[at] = {
        ...entries[at],
        username,
        password,
        importedFrom: converted.converted ? url : null
      }
      continue
    }
    // 既存を上書きする分は件数が増えない
    const grows = existingId === null
    if (grows && total >= HTTP_AUTH_LIMITS.MAX_RULES) {
      rejected.push({ pattern: shown, reason: 'too-many' })
      continue
    }
    if (grows) total += 1
    seen.set(converted.pattern, entries.length)
    entries.push({
      id: existingId,
      pattern: converted.pattern,
      username,
      password,
      importedFrom: converted.converted ? url : null
    })
  }

  return { entries, rejected, priorityWarning: priorities.size > 1 }
}

/* ------------------------------------------------------------------ *
 * テスト用 backend のゲート
 * ------------------------------------------------------------------ */

/**
 * `NEMO_HTTP_AUTH_TEST_CRYPTO` を実効モードに落とす。
 *
 * **`isPackaged` を必須ゲートにする**。このリポジトリはパッケージ済みの dev 版も配っているので、
 * env だけを条件にすると実運用のパスワードが Keychain を使わない形式で保存されうる。
 *
 * ここに置いているのは**「パッケージ版では env を無視する」を単体テストで固定するため**
 * （main の TS は `node --test` から直接叩けない）。
 *
 * @param {string | undefined | null} envValue
 * @param {boolean} isPackaged
 * @returns {'real' | 'memory' | 'unavailable'}
 */
export function resolveSecretBackendMode(envValue, isPackaged) {
  if (isPackaged) return 'real'
  if (envValue === 'memory' || envValue === 'unavailable') return envValue
  return 'real'
}
