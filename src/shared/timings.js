// @ts-check
/**
 * 「見に行く周期」「書くまでのデバウンス」の**本番既定値の唯一の置き場**。
 *
 * 自走検証は待ち時間の大半をここに払っている（設定は既に極小なのに、次の掃除まで
 * 最大 5 秒待たされる、など）。検証のときだけ縮められるようにするための土台。
 *
 * **plain .js に置くのは main（TS）と scripts（mjs）の両方から同じ値を読むため**。
 * 二重に持つと「verify は既定値 A で待ちを組み、アプリは既定値 B で動く」が黙って起きる。
 * `src/shared/settings-schema.js` と同じ形（`src/main/store/session.ts` と
 * `scripts/arc-import.mjs` が同じファイルを import している）。
 *
 * ここに載せてよいのは **「いつ判定するか」だけを変え、判定の中身を変えないもの**に限る。
 * 閾値そのもの（`tabSleepMinutes` など）や保険のタイムアウト
 * （`PEEK_PLACEHOLDER_TIMEOUT`。縮めると正常系が保険経路にすり替わる）は載せない。
 */

/**
 * @typedef {object} Timings
 * @property {number} sleepSweepMs 「寝かせるべきタブ / 閉じるべきタブ」を見に行く周期。
 *   設定より短い周期で見に行かないと「30分後に寝る」が最大1分ずれる。
 * @property {number} sessionSaveDebounceMs セッションを集めて書きに行くまでのデバウンス（registry 側）。
 * @property {number} sessionStoreDebounceMs `session.json` を実際に書くまでのデバウンス（JsonStore 側）。
 *   **上と2段になっている**ので、片方だけ縮めても下限がもう片方に張り付く。
 * @property {number} liveFolderPollMs Live Folder の自動取得の基本間隔（`nextAutomaticAttemptAt` を決める側）。
 * @property {number} liveFolderTickMs Live Folder のタイマーが起きて条件を見る間隔。
 *   **`liveFolderPollMs` との比を保つこと**（tick と同オーダーにすると「取得中に起きたタイマーを捨てる」の
 *   検証が撃てなくなる）。既定は 1:12。
 * @property {number} liveFolderBackoffMinMs `transient` 失敗のバックオフの初期値（以降 2 倍ずつ伸びる）。
 * @property {number} httpAuthRevealMs Settings で「表示」したパスワードを再マスクするまで。
 *   **判定の中身ではなく「いつ再マスクするか」だけ**を変えるので、ここに載せてよい。
 * @property {number} httpAuthWatchdogMs 自動入力を送ったあと、応答も 2 回目の `login` も
 *   来ないまま待つ上限。満了したら**ダイアログに倒す**（成功にはしない）。
 *   縮めても倒す先は変わらない（保険経路への「すり替わり」が起きない）ので載せている。
 */

/** @type {Timings} */
export const DEFAULT_TIMINGS = {
  sleepSweepMs: 5_000,
  sessionSaveDebounceMs: 2_000,
  sessionStoreDebounceMs: 1_000,
  liveFolderPollMs: 60_000,
  liveFolderTickMs: 5_000,
  liveFolderBackoffMinMs: 60_000,
  httpAuthRevealMs: 30_000,
  httpAuthWatchdogMs: 10_000
}

/** 上書きに使える名前。 */
export const TIMING_KEYS = /** @type {(keyof Timings)[]} */ (Object.keys(DEFAULT_TIMINGS))

/**
 * `timings.resolved` ログの `effective` を組み立てる。
 *
 * **1本の JSON 文字列にしない**: 8キーで 212 文字になり、`sanitizeDetail` の
 * 200 文字切りで `…` が付いて JSON として読めなくなる（httpAuth のキー追加で
 * 閾値を越え、CI の verify-packaged が落ち続けた実例）。
 * キーを平たく展開もしない（`sessionSaveDebounceMs` の `session` が
 * キー名 redaction に食われる）。`key=value` の文字列配列なら要素ごとに短く、
 * キー名は値の中身なので redaction も素通りする。
 *
 * @param {Timings} timings
 * @returns {string[]}
 */
export function formatTimingsLogDetail(timings) {
  return TIMING_KEYS.map((key) => `${key}=${timings[key]}`)
}

/**
 * `formatTimingsLogDetail` の逆。ログから実効値を読み戻す（verify-packaged が使う）。
 * 配列でない・壊れた要素は黙って捨てる（検査側が既定値との不一致として検出する）。
 *
 * @param {unknown} entries
 * @returns {Partial<Record<keyof Timings, number>>}
 */
export function parseTimingsLogDetail(entries) {
  /** @type {Partial<Record<keyof Timings, number>>} */
  const result = {}
  if (!Array.isArray(entries)) return result
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    const value = Number(entry.slice(eq + 1))
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TIMINGS, key) || !Number.isFinite(value)) continue
    result[/** @type {keyof Timings} */ (key)] = value
  }
  return result
}

/**
 * `NEMO_VERIFY_TIMINGS`（JSON）を既定値に重ねる。
 *
 * **パース失敗・知らないキー・数値でない値はすべて即エラー**にする。
 * 黙って既定値へフォールバックすると、キーの書き違い1つで
 * 「アプリは本番値・verify は縮めたつもり」のズレが静かに生まれ、
 * この仕組みが塞ごうとしている失敗モードそのものになる。
 *
 * @param {string | undefined | null} raw
 * @returns {Timings}
 */
export function resolveTimings(raw) {
  if (raw === undefined || raw === null || raw === '') return { ...DEFAULT_TIMINGS }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`NEMO_VERIFY_TIMINGS が JSON として読めない: ${raw}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`NEMO_VERIFY_TIMINGS はオブジェクトで渡す: ${raw}`)
  }

  const resolved = { ...DEFAULT_TIMINGS }
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TIMINGS, key)) {
      throw new Error(`NEMO_VERIFY_TIMINGS: 知らないキー ${key}（使えるのは ${TIMING_KEYS.join(' / ')}）`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`NEMO_VERIFY_TIMINGS: ${key} は正の数で渡す（受け取った値: ${JSON.stringify(value)}）`)
    }
    resolved[/** @type {keyof Timings} */ (key)] = value
  }
  return resolved
}
