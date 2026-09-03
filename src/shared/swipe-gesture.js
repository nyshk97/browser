// @ts-check
/**
 * トラックパッドの2本指スワイプ（水平）から「戻る / 進む」を判定する。
 *
 * Electron には Chromium の overscroll history navigation を有効にする API が無く、
 * `BaseWindow` の `swipe` イベントは **3本指**（システム設定を変えた人だけ）にしか出ない。
 * `webContents.on('input-event')` も Electron 41 では `type` と `modifiers` しか渡さず、
 * **ホイールの deltaX が取れない**（実測）。
 *
 * そこでページ側の `wheel` イベントで判定する。判定と注入コードの組み立てを
 * ここに置き、`scripts/swipe-gesture.test.mjs` から直接テストできるようにしている
 * （誤爆の条件は実アプリを起動せず回帰させたい）。
 */

/**
 * @typedef {object} SwipeConfig
 * @property {number} thresholdPx 発火に必要な水平方向の累積量
 * @property {number} idleMs これだけ途切れたら次は別のジェスチャ
 * @property {number} cooldownMs 発火してから次を受け付けるまでの待ち
 * @property {number} verticalRatio `|Δy| >= |Δx| * これ` なら縦スクロールとみなす
 */

/** 既定のしきい値。macOS のページ送りと同じくらいの手応えにしてある。 */
export const SWIPE_CONFIG = Object.freeze({
  thresholdPx: 110,
  idleMs: 260,
  cooldownMs: 650,
  verticalRatio: 0.8
})

/**
 * @typedef {object} SwipeState
 * @property {number} x 現在のジェスチャの水平累積（正 = 戻る向き）
 * @property {number} y 同・垂直累積
 * @property {number} lastAt 最後にイベントを受けた時刻
 * @property {number} firedAt 最後に発火した時刻
 * @property {boolean} locked このイベント列ではもう判定しない
 * @property {boolean} armed 指が離れたのを一度でも見たか（見るまでは何があっても発火しない）
 */

/**
 * @param {number} now 作った時刻（ページ側なら `performance.now()`）
 * @returns {SwipeState}
 *
 * **`armed: false` から始める**のが肝。ページが切り替わった直後には
 * 「1つ前のページで払った指の**慣性の残り**」が流れ込んでくるので、
 * 素直に数え始めると *戻った直後にもう1ページ戻る*。
 * `idleMs` ぶん途切れる（= 指が離れた）のを見て初めて `armed` が立つ。
 *
 * 「このイベント列では判定しない」を表す `locked` とは別に持つ。
 * `locked` は横スクロールの端を追うために途中で外れることがあり、
 * 兼用にすると慣性の抑止まで一緒に解けてしまう。
 */
export function createSwipeState(now) {
  return { x: 0, y: 0, lastAt: now, firedAt: -Infinity, locked: false, armed: false }
}

/**
 * ホイールイベントを1つ積んで、ナビゲーションすべきかを返す。
 *
 * `x` は **正が「戻る」向き**（macOS のナチュラルスクロールで指を右に払う動き）。
 * 呼び出し側で符号を揃えてから渡す。
 *
 * **この関数はページへ文字列として注入する**（`buildSwipeInjection`）。
 * 外の識別子を参照すると注入先で壊れるので、引数と組み込みオブジェクトだけで完結させること。
 *
 * @param {SwipeState} state 呼び出しごとに書き換わる（フレーム1枚につき1つ持つ）
 * @param {{ x: number, y: number, at: number, scrollable?: boolean }} delta
 *   `scrollable` は「その場所をまだ横スクロールできるか」。true のあいだは数えない
 * @param {SwipeConfig} config
 * @returns {'back' | 'forward' | null}
 */
export function feedSwipe(state, delta, config) {
  // 指を離した（＝イベントが途切れた）ら、次のスワイプとして数え直す。
  // これが無いと、細かい水平スクロールが何分もかけて閾値に届いてしまう。
  // **ここを通ることが「指が離れたのを見た」ことの証明**なので、あわせて armed を立てる。
  if (delta.at - state.lastAt > config.idleMs) {
    state.x = 0
    state.y = 0
    state.locked = false
    state.armed = true
  }
  state.lastAt = delta.at

  // まだその場所を横スクロールできるなら、スワイプではなく**スクロールしたい**。
  // 端に着いてから数え始める。
  //
  // **捨てるのは積んだぶんだけ**。`armed`（指が離れたのを見たか）も
  // `locked`（このイベント列では判定しない）も戻さない。戻すと、
  // 遷移直後の慣性や「縦に流れている」と判断したジェスチャの抑止が、
  // 横スクロールできる場所を通り抜けただけで解けてしまう。
  // このあいだは累積しないので、ここで `locked` が立つこともない。
  if (delta.scrollable) {
    state.x = 0
    state.y = 0
    return null
  }

  state.x += delta.x
  state.y += delta.y

  if (state.locked || !state.armed) return null
  // 斜めに動いているものは縦スクロールとして扱う（ページを読んでいる最中に飛ばさない）。
  // 一度そう判定したらジェスチャが終わるまで戻さない。
  if (Math.abs(state.y) >= Math.abs(state.x) * config.verticalRatio) {
    state.locked = true
    return null
  }
  if (Math.abs(state.x) < config.thresholdPx) return null
  if (delta.at - state.firedAt < config.cooldownMs) {
    state.locked = true
    return null
  }

  state.locked = true
  state.firedAt = delta.at
  return state.x > 0 ? 'back' : 'forward'
}

/**
 * ページに注入するコード（`executeJavaScriptInIsolatedWorld` で隔離ワールドに入れる）。
 *
 * `feedSwipe` の実装をそのまま埋め込むので、判定ロジックの実体は1つだけになる。
 *
 * 誤爆しないための決まりごと:
 * - `passive: true`（ページのスクロールを邪魔しない）
 * - 発火する直前に「その場所がまだ横スクロールできるか」を見る。
 *   できるならスワイプではなく**横スクロールしたい**ので何もしない
 *   （Chromium 本来の overscroll と同じ考え方。端まで来て初めて履歴が動く）
 *
 * @param {SwipeConfig} [config]
 * @returns {string}
 */
export function buildSwipeInjection(config = SWIPE_CONFIG) {
  return `(() => {
  const MARK = '__nemoSwipeAttached'
  if (window[MARK]) return 'already'
  window[MARK] = true

  const config = ${JSON.stringify(config)}
  const feedSwipe = ${feedSwipe.toString()}
  const state = (${createSwipeState.toString()})(performance.now())

  /** その要素を dx 方向へまだ横スクロールできるか。 */
  const canScroll = (node, dx) => {
    const style = getComputedStyle(node)
    const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll'
    const room = node.scrollWidth - node.clientWidth
    if (!(scrolls || node === document.scrollingElement) || room <= 1) return false
    if (dx < 0 && node.scrollLeft > 1) return true
    if (dx > 0 && node.scrollLeft < room - 1) return true
    return false
  }

  /**
   * そのイベントの位置から見て、まだ dx 方向へ横スクロールできる要素があるか。
   *
   * 祖先を親方向へ辿り、**辿り終えてから** document.scrollingElement を 1 回だけ見る
   * （祖先に含まれていれば見ない）。「親が無くなったら scrollingElement へ飛ぶ」形にしてはいけない:
   * DOCTYPE の無い quirks mode の文書では scrollingElement が <html> ではなく <body> なので、
   * html → body → html … と永遠に回り、**wheel を 1 回受けただけでレンダラが固まる**
   * （フォームのプレビューを DOCTYPE 無しで描画する埋め込みで実際に踏んだ）。
   */
  const hasScrollRoom = (target, dx) => {
    let root = document.scrollingElement
    for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
      if (node === root) root = null
      if (canScroll(node, dx)) return true
    }
    return root ? canScroll(root, dx) : false
  }

  addEventListener(
    'wheel',
    (event) => {
      // DOM の deltaX は「スクロール量」。指を右に払うと負になるので符号を反転して
      // 「正 = 戻る」に揃える。
      // 「まだ横スクロールできるか」も一緒に渡す（判定は feedSwipe に寄せる。
      //  ここで先に return すると、指が離れたかどうかの見張りまで飛ばしてしまう）
      const action = feedSwipe(
        state,
        {
          x: -event.deltaX,
          y: event.deltaY,
          at: event.timeStamp,
          scrollable: hasScrollRoom(event.target, event.deltaX)
        },
        config
      )
      if (!action) return
      if (action === 'back') history.back()
      else history.forward()
    },
    { passive: true, capture: true }
  )
  return 'attached'
})()`
}
