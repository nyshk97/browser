/**
 * Google Meet のアダプタ。
 *
 * **Meet の DOM に触るのはこのファイルだけ**にする。UI が変わったときに
 * 直す場所を 1 か所に閉じ込めるのが目的なので、
 * セレクタも属性名も**外へ出さない**（外に出すのは意味の側だけ）。
 *
 * ## 真偽の向き
 *
 * Meet の DOM は `data-is-muted="true"` が「**切れている**」で、
 * Nemo が UI へ出す `micEnabled` / `camEnabled` とは**向きが逆**。
 * 反転は下の `PROBE_SOURCE` の中の 1 か所だけで行い、
 * ここから外へは `*Enabled`（true = 生きている = UI の「ON」）しか出さない。
 * `mic` のような向きの分からない名前を使うと、反転事故が起きたときに
 * **見た目では気づけない**（ミュートしたつもりで喋り続ける）。
 *
 * ## 言語非依存であること
 *
 * `aria-label` / `title` は表示言語で変わるので**判定に使わない**。
 * 使うのは属性（`data-is-muted`）と、Material Icons の**合字テキスト**
 * （`mic` / `mic_off` / `videocam` / `videocam_off`。これは英語の語だが
 * アイコンフォントの合字名なので UI 言語では変わらない）。
 */

/** 会議として扱うホスト。 */
const MEET_HOST = 'meet.google.com'

/**
 * 判定 URL の差し替え口（自走検証用）。
 *
 * **origin 単位にしない**（計画 R11）。`test-server.mjs` は `test-pages/` 全体を
 * 単一ポートから配信しているので、origin で見ると `index.html` や `login.html` まで
 * 会議候補になり、フル検証のあいだじゅう縮退した小窓が出て他の検証に干渉する。
 *
 * ゲートは **`!app.isPackaged`**。`isDevChannel` では塞げない
 * （`paths.ts` は `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので、
 * **dev パッケージでも `isDevChannel === true`** になり裏口が残る）。
 */
let testUrlPrefix: string | null = null

export function configureMeetTestUrlPrefix(prefix: string | null): void {
  testUrlPrefix = prefix && /^https?:\/\//.test(prefix) ? prefix : null
}

/** この URL を会議のページとして扱うか。 */
export function isMeetUrl(url: string): boolean {
  if (!url) return false
  if (testUrlPrefix && url.startsWith(testUrlPrefix)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.host !== MEET_HOST) return false
  // ルート（会議一覧）は会議ではない。会議コードのパスだけを候補にする
  return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(parsed.pathname)
}

/** 小窓に出すホスト名。 */
export function meetDisplayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return MEET_HOST
  }
}

/** プローブが読み取った状態。読めなかったときは `null`（＝縮退の合図）。 */
export interface CallProbe {
  inCall: boolean
  /** true = マイクが生きている（UI の「ON」）。 */
  micEnabled: boolean
  /** true = カメラが生きている（UI の「ON」）。 */
  camEnabled: boolean
}

/**
 * Meet の DOM を 1 往復で読む式。**隔離ワールドで評価する**。
 *
 * 返すもの:
 * - 読めた … `{ inCall, micEnabled, camEnabled }`
 * - 読めない … `null`（縮退へ落とす合図。呼び出し側が戻るボタンだけの小窓にする）
 *
 * **参加中の判定**は「マイク / カメラのボタンが在ること」だけでは足りない。
 * 待機画面（グリーンルーム）にも同じボタンが在るので、
 * **参加者タイルが在ること**を併せて見る（待機画面には無い）。
 * Meet は待機画面から会議へ**同じ URL・同じ document のまま**移るので、
 * ナビゲーションイベントでは参加の開始を拾えない（計画 R9）。
 */
export const PROBE_SOURCE = `(() => {
  try {
    // 参加者タイル。待機画面には存在しない（＝これが参加中の目印）
    const inCall =
      document.querySelector('[data-participant-id]') !== null ||
      document.querySelector('[data-initial-participant-id]') !== null

    // マイク / カメラのボタン。**data-is-muted は「切れている」が true**
    const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-is-muted]'))
    if (buttons.length === 0) return null

    // 見分けは Material Icons の合字テキスト（UI 言語で変わらない）。
    // 取れなければ DOM 順（Meet は マイク → カメラ の順）に落とす
    const iconsOf = (el) =>
      Array.prototype.slice
        .call(el.querySelectorAll('i, [class*="material-icons"]'))
        .map((node) => (node.textContent || '').trim())
    const kindOf = (el) => {
      const icons = iconsOf(el)
      if (icons.indexOf('mic') !== -1 || icons.indexOf('mic_off') !== -1) return 'mic'
      if (icons.indexOf('videocam') !== -1 || icons.indexOf('videocam_off') !== -1) return 'cam'
      return null
    }
    let mic = null
    let cam = null
    for (const el of buttons) {
      const kind = kindOf(el)
      if (kind === 'mic' && mic === null) mic = el
      else if (kind === 'cam' && cam === null) cam = el
    }
    if (mic === null && cam === null && buttons.length >= 2) {
      mic = buttons[0]
      cam = buttons[1]
    }
    if (mic === null || cam === null) return null

    // ここが向きを反転させる唯一の場所（muted = 切れている → enabled は反対）
    const enabled = (el) => el.getAttribute('data-is-muted') !== 'true'
    return { inCall: inCall, micEnabled: enabled(mic), camEnabled: enabled(cam) }
  } catch (error) {
    return null
  }
})()`

/**
 * マイク / カメラを切り替える式。**隔離ワールドで評価する**。
 *
 * 押した結果は返さない（`true` = ボタンを押せた、だけ）。
 * **UI は押した直後に楽観更新してはいけない** —— Meet 側が弾くことがあるので、
 * 表示は次のプローブの結果を待つ。
 */
export function buildToggleSource(kind: 'mic' | 'cam'): string {
  return `(() => {
  try {
    const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-is-muted]'))
    if (buttons.length === 0) return false
    const iconsOf = (el) =>
      Array.prototype.slice
        .call(el.querySelectorAll('i, [class*="material-icons"]'))
        .map((node) => (node.textContent || '').trim())
    const kindOf = (el) => {
      const icons = iconsOf(el)
      if (icons.indexOf('mic') !== -1 || icons.indexOf('mic_off') !== -1) return 'mic'
      if (icons.indexOf('videocam') !== -1 || icons.indexOf('videocam_off') !== -1) return 'cam'
      return null
    }
    let target = null
    for (const el of buttons) {
      if (kindOf(el) === ${JSON.stringify(kind)}) { target = el; break }
    }
    if (target === null) {
      const index = ${kind === 'mic' ? 0 : 1}
      target = buttons.length >= 2 ? buttons[index] : null
    }
    if (target === null) return false
    target.click()
    return true
  } catch (error) {
    return false
  }
})()`
}

/** プローブの戻り値を検証する（隔離ワールドから来る値を素通しにしない）。 */
export function parseProbe(raw: unknown): CallProbe | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value['inCall'] !== 'boolean' ||
    typeof value['micEnabled'] !== 'boolean' ||
    typeof value['camEnabled'] !== 'boolean'
  ) {
    return null
  }
  return {
    inCall: value['inCall'],
    micEnabled: value['micEnabled'],
    camEnabled: value['camEnabled']
  }
}
