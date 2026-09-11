// @ts-check
/**
 * 画面共有（`getDisplayMedia`）の純粋関数。Electron 非依存。
 * `scripts/display-share.test.mjs` からテストする。
 *
 * Nemo の画面共有は**常にディスプレイ全体**を渡す（ウィンドウ単位は無い）。
 * macOS のネイティブ共有ピッカーは使わない: 2 画面で「画面全体を共有」を選ぶには
 * 共有したい側のディスプレイのバー右上まで持っていく必要があり、しかも 10 秒以内に
 * 選ばないと `AbortError: Timeout starting video source` で落ちる（実測 10002 ms）。
 * 代わりにディスプレイが 2 枚以上のときだけ Nemo のダイアログでどの画面かを選ばせる。
 */

/**
 * @typedef {object} ShareDisplay
 * @property {number} id Electron の `Display.id`
 * @property {string} label 「Studio Display」「内蔵ディスプレイ」など
 * @property {number} width
 * @property {number} height
 */

/**
 * Electron は `getDisplayMedia` を `setPermissionRequestHandler` に **`media`（`mediaTypes` 空）** として
 * 先に投げてくる（Electron 41 で実測）。そのままだとダイアログが「カメラとマイク」の文言になり、
 * 「今後も同じ扱い」で許可すると `media` として記憶されて、その origin のマイク・カメラも確認なしで通ってしまう。
 * ここで `display-capture` に読み替える。
 *
 * **配列で空のときだけ**読み替える。`mediaTypes` が無い（undefined）ときは触らない —— Chromium 側で形が変わったら
 * 「カメラとマイク」の確認が出る側（今と同じ挙動）に倒れ、デバイスが同意なしに通る側には倒れない。
 * @param {string} permission
 * @param {readonly string[] | undefined} mediaTypes
 * @returns {string}
 */
export function effectivePermission(permission, mediaTypes) {
  if (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0) return 'display-capture'
  return permission
}

/** ディスプレイを選ばせる必要があるか（1 枚なら聞かない）。 @param {readonly ShareDisplay[]} displays */
export function needsDisplayChoice(displays) {
  return displays.length >= 2
}

/**
 * ダイアログに出す並び: 要求元のタブが乗っているディスプレイ**以外**を先頭に（元の順のまま）、
 * 要求元を末尾に `isRequester: true` を付けて置く。共有したいのはたいてい Meet が無い側なので、
 * 既定（先頭 = Enter）がそちらになる。要求元が分からなければ元の順で全部 false。
 * @template {ShareDisplay} T
 * @param {readonly T[]} displays
 * @param {number | null} requesterDisplayId
 * @returns {(T & { isRequester: boolean })[]}
 */
export function orderDisplaysForShare(displays, requesterDisplayId) {
  const others = displays
    .filter((d) => d.id !== requesterDisplayId)
    .map((d) => ({ ...d, isRequester: false }))
  const requester = displays
    .filter((d) => d.id === requesterDisplayId)
    .map((d) => ({ ...d, isRequester: true }))
  return [...others, ...requester]
}

/**
 * `desktopCapturer.getSources` の source（`display_id` は文字列）を `Display.id`（数値）で引く。
 * @template {{ display_id: string }} S
 * @param {readonly S[]} sources
 * @param {number} displayId
 * @returns {S | null}
 */
export function matchSourceForDisplay(sources, displayId) {
  return sources.find((s) => s.display_id === String(displayId)) ?? null
}

/**
 * ログ用: ディスプレイ一覧を**フラットな文字列配列**にする。
 * `sanitizeDetail` は深さ 4 でオブジェクトを `[deep]` に潰し、文字列は 200 文字で切るので、
 * 要素をオブジェクトにしない・1 要素を短く保つ。
 * @param {readonly ShareDisplay[]} displays
 * @returns {string[]}
 */
export function displayLabelsForLog(displays) {
  return displays.map((d) => `${d.label || '?'} ${d.width}x${d.height}`.slice(0, 60))
}
