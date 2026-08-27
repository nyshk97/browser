// @ts-check
/**
 * ページの `gg` / `G` で縦方向の端へ飛ぶ（vim の作法）。
 *
 * `before-input-event` では **ページの入力欄にフォーカスがあるかを main 側から判別できない**
 * （`input.key` しか渡ってこない）。検索ボックスに `G` と打った瞬間に最下部へ飛ぶので採れない。
 * そこで判定をページ側の `keydown` に置き、`swipe-gesture.js` と同じく
 * **隔離ワールドへ文字列で注入する**。
 *
 * `gg` の状態機械（`feedVimKey`）だけをここに切り出して
 * `scripts/vim-scroll.test.mjs` から直接テストする。
 *
 * **`buildVimScrollInjection` の中のヘルパー（`isEditable` / `scrollableAncestor` /
 * `pickTarget`）は注入文字列の中にしか無く、`pnpm test` の網にかからない。**
 * あそこの回帰が効くのは `scripts/verify-vim-scroll.mjs`（実アプリに CDP でキーを撃つ）だけ。
 */

/**
 * @typedef {object} VimScrollConfig
 * @property {number} pendingMs `gg` の1打目と2打目のあいだに許す時間
 */

/** 既定のしきい値。vim 系拡張の慣例に合わせてある。 */
export const VIM_SCROLL_CONFIG = Object.freeze({ pendingMs: 1000 })

/**
 * @typedef {object} VimScrollState
 * @property {boolean} pendingG `g` を1打受けて2打目を待っているか
 * @property {number} pendingAt その1打目を受けた時刻
 */

/**
 * `pendingAt` の初期値は使われない（`pendingG` が立つまで見ないため）が、
 * 未定義を混ぜないために入れておく。
 * @returns {VimScrollState}
 */
export function createVimScrollState() {
  return { pendingG: false, pendingAt: -Infinity }
}

/**
 * キーを1つ積んで、飛ぶべき先を返す。
 *
 * **この関数はページへ文字列として注入する**（`buildVimScrollInjection`）。
 * 外の識別子を参照すると注入先で壊れるので、引数と組み込みオブジェクトだけで完結させること。
 *
 * 修飾キー（⌘ / ⌃ / ⌥）と IME 変換中の除外は**呼び出し側（注入コード）でやる**。
 * ここは `key` しか見ない。
 *
 * @param {VimScrollState} state 呼び出しごとに書き換わる（フレーム1枚につき1つ持つ）
 * @param {{ key: string, at: number }} input
 *   `at` は **`event.timeStamp` に固定する**。片方を `Date.now()` にすると猶予判定が壊れるが、
 *   **相対値で書くユニットテストは通ってしまう**ので気づけない
 * @param {VimScrollConfig} config
 * @returns {'top' | 'bottom' | null}
 */
export function feedVimKey(state, input, config) {
  // `G`（Shift+g）は単独で最下部へ。保留中の `g` は捨てる
  // （`g` → `G` で「最下部へ飛んだうえに `g` が残っている」を作らない）。
  if (input.key === 'G') {
    state.pendingG = false
    return 'bottom'
  }

  if (input.key === 'g') {
    // 猶予内の2打目だけを `gg` として扱う。
    // 猶予を設けないと「`g` を押して放置 → しばらく後の `g`」で誤爆する。
    if (state.pendingG && input.at - state.pendingAt <= config.pendingMs) {
      state.pendingG = false
      return 'top'
    }
    // 猶予切れは「1打目に戻る」。捨てて無反応にすると `g` を3回押さないと効かなくなる。
    state.pendingG = true
    state.pendingAt = input.at
    return null
  }

  // それ以外のキーは保留を解く（`g` → `x` → `g` で飛ばない）。
  state.pendingG = false
  return null
}

/**
 * ページに注入するコード（`executeJavaScriptInIsolatedWorld` で隔離ワールドに入れる）。
 *
 * `feedVimKey` の実装をそのまま埋め込むので、判定ロジックの実体は1つだけになる。
 *
 * 誤爆しないための決まりごと:
 * - **`preventDefault` を呼ばない**。GitHub の `g c`・Gmail の `g i` のような
 *   `g` プレフィックスのショートカットを潰さない（食い切ると全滅する）
 * - 入力欄・IME 変換中・修飾キー付きは早期 return
 * - スクロール対象は「フォーカス → 画面中央 → ルート」の順で、**縦の room がある最初のもの**
 *
 * @param {VimScrollConfig} [config]
 * @returns {string}
 */
export function buildVimScrollInjection(config = VIM_SCROLL_CONFIG) {
  return `(() => {
  const MARK = '__nemoVimScrollAttached'
  if (window[MARK]) return 'already'
  window[MARK] = true

  const config = ${JSON.stringify(config)}
  const feedVimKey = ${feedVimKey.toString()}
  const state = (${createVimScrollState.toString()})()

  /** 文字を打ち込む場所か。ここに乗っているあいだは何もしない。 */
  const isEditable = (el) => {
    if (!(el instanceof Element)) return false
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return el.getAttribute('role') === 'textbox'
  }

  /**
   * 渡された要素**自身から**祖先を辿って、縦にスクロールできる要素を返す。
   *
   * **\`body\` と \`documentElement\` は採らない。** \`body { overflow-y: scroll }\`
   * （スクロールバー常時表示のためによく使われる）は条件に合致するのに、overflow の
   * viewport 伝播で実際に動くのは \`scrollingElement\` 側なので \`body.scrollTo()\` は
   * 何もしない。何もフォーカスしていない初期状態の \`activeElement\` は \`body\` そのものなので、
   * ここを素通しにすると**そういうサイトで常に無反応**になる。
   *
   * \`scrollingElement\` の特例（swipe の \`hasScrollRoom\` が持っているもの）も入れない。
   * 入れると \`html\` に数 px の余りがあるページでルートが先に採られ、
   * 内側スクローラまで辿り着かない。通常ページは最後の候補で拾えるので要らない。
   */
  const scrollableAncestor = (el) => {
    let node = el instanceof Element ? el : null
    while (node) {
      if (node !== document.body && node !== document.documentElement) {
        const overflowY = getComputedStyle(node).overflowY
        if (overflowY === 'auto' || overflowY === 'scroll') {
          if (node.scrollHeight - node.clientHeight > 1) return node
        }
      }
      // **shadow 境界を跨ぐ**（\`deepActiveElement\` の逆向き）。shadow tree の最上位要素は
      // \`parentNode\` が \`ShadowRoot\` で \`parentElement\` が null になるため、これが無いと
      // Web Components で組まれたアプリでフォーカス起点の探索がホストの手前で打ち止めになる。
      const root = node.parentElement ? null : node.getRootNode()
      node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    return null
  }

  /**
   * shadow DOM の中まで辿った、実際にフォーカスされている要素。
   *
   * \`document.activeElement\` も \`event.target\` も**ホスト要素に retarget される**ので、
   * これが無いと \`<my-search><input></my-search>\` 型の検索ボックスで \`G\` を打ったときに
   * 文字が入ったうえに最下部へ飛ぶ。**closed な shadow root は辿れない**ので、そこは諦める。
   */
  const deepActiveElement = () => {
    let node = document.activeElement
    while (node && node.shadowRoot && node.shadowRoot.activeElement) {
      node = node.shadowRoot.activeElement
    }
    return node
  }

  /** 縦の room がある最初の候補を採る（room の無い候補で確定して無反応になるのを防ぐ）。 */
  const pickTarget = () => {
    const fromFocus = scrollableAncestor(deepActiveElement())
    if (fromFocus) return fromFocus
    const center = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    const fromCenter = scrollableAncestor(center)
    if (fromCenter) return fromCenter
    const root = document.scrollingElement
    if (root && root.scrollHeight - root.clientHeight > 1) return root
    return null
  }

  addEventListener(
    'keydown',
    (event) => {
      // **\`feedVimKey\` は \`key\` しか見ない**ので、ここで落とさないと
      // ⌘G（Chromium の「次を検索」）で最下部へ飛ぶ。
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // 押しっぱなしのオートリピート。2発目が \`gg\` として発火して最上部へ飛ぶ。
      if (event.repeat) return
      if (event.isComposing) return
      if (isEditable(event.target) || isEditable(deepActiveElement())) return

      const action = feedVimKey(state, { key: event.key, at: event.timeStamp }, config)
      if (!action) return

      const target = pickTarget()
      if (!target) return
      // **\`preventDefault\` は呼ばない**（ページ側の \`g\` プレフィックスを潰さない）。
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      // \`G\` は**押した時点の \`scrollHeight\`** まで。無限スクロールで伸びても追わない。
      target.scrollTo({ top: action === 'top' ? 0 : target.scrollHeight, behavior })
    },
    { capture: true }
  )
  return 'attached'
})()`
}
