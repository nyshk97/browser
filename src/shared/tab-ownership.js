// @ts-check
/**
 * タブの「所属」（ピン留め / Favorite のどちらの定義に属するか）の正規化。
 *
 * `createTab` は復元・⌘⇧T・変換・拡張の popup など**あちこちから呼ばれる**ので、
 * 不変条件は呼び出し側ではなくここで1度だけ保証する。
 *
 *  1. `pinnedId` と `favoriteId` は**排他**（両方来たら `pinnedId` を優先する）
 *  2. **存在する定義の ID だけ**受け付ける（消えた ID は null に倒す）
 *  3. **1 ウィンドウにつき 1 定義 1 タブ**（同じ定義のタブが既にあるなら所属を付けない）
 *
 * Electron 非依存にして `scripts/tab-ownership.test.mjs` から直接テストする
 * （`CreateTabOptions` は preload に公開していないので CDP からは叩けない）。
 */

/**
 * @typedef {object} OwnershipRequest
 * @property {string | null | undefined} [pinnedId]
 * @property {string | null | undefined} [favoriteId]
 */

/**
 * @typedef {object} OwnershipContext
 * @property {(id: string) => boolean} pinnedExists ピン留め定義が実在するか
 * @property {(id: string) => boolean} favoriteExists Favorite 定義が実在するか
 * @property {{ pinnedId: string | null, favoriteId: string | null }[]} windowTabs
 *   これから足すウィンドウに既にあるタブ（自分自身は含めない）
 */

/**
 * @typedef {object} OwnershipResult
 * @property {string | null} pinnedId
 * @property {string | null} favoriteId
 * @property {string[]} dropped 落とした理由（ログに残す）
 */

/**
 * @param {OwnershipRequest} requested
 * @param {OwnershipContext} context
 * @returns {OwnershipResult}
 */
export function resolveTabOwnership(requested, context) {
  /** @type {string[]} */
  const dropped = []
  let pinnedId = typeof requested.pinnedId === 'string' && requested.pinnedId ? requested.pinnedId : null
  let favoriteId =
    typeof requested.favoriteId === 'string' && requested.favoriteId ? requested.favoriteId : null

  // 1. 排他。両方来たらピン留めを優先する（どちらかを黙って捨てず必ずログに残す）
  if (pinnedId && favoriteId) {
    favoriteId = null
    dropped.push('both_ids')
  }

  // 2. 消えた定義への紐付けを持ち込ませない。
  //    紐付いたままだと、サイドバーのどの層にも出ないタブになる。
  if (pinnedId && !context.pinnedExists(pinnedId)) {
    pinnedId = null
    dropped.push('missing_pinned')
  }
  if (favoriteId && !context.favoriteExists(favoriteId)) {
    favoriteId = null
    dropped.push('missing_favorite')
  }

  // 3. 同じ定義のタブが同じウィンドウに既にあるなら所属を付けない
  //    （呼び出し側の取りこぼしをここで止める）
  if (pinnedId && context.windowTabs.some((tab) => tab.pinnedId === pinnedId)) {
    pinnedId = null
    dropped.push('duplicate_pinned')
  }
  if (favoriteId && context.windowTabs.some((tab) => tab.favoriteId === favoriteId)) {
    favoriteId = null
    dropped.push('duplicate_favorite')
  }

  return { pinnedId, favoriteId, dropped }
}

/**
 * ⌘⇧T（閉じたタブを開き直す）の判定。
 *
 * 基本は「閉じた瞬間の状態（URL / 名前 / 所属）をそのまま戻す」。
 * 「登録 URL に戻る」のはサイドバーの枠をクリックしたときの規則で、ここには適用しない。
 * ただし所属の不変条件が優先なので、例外が2つある。
 *
 * - **同じ定義のタブが復元先ウィンドウに既に開いている**（閉じた後に枠から開き直した）
 *   → 新しく作らず、そのタブを選ぶだけ。作ると同じ枠に2つぶら下がる
 * - **定義が既に消えている**（閉じた後に解除した）→ 所属を外して一時タブとして戻す。
 *   消えた ID のまま戻すと、どの層にも出ない不可視タブになる
 *
 * メニューのアクセラレータからしか叩けない経路なので、判定だけを純粋関数にして
 * `scripts/tab-ownership.test.mjs` から直接確かめる。
 *
 * @typedef {object} ClosedTabEntry
 * @property {string} url
 * @property {string} title
 * @property {string | null} pinnedId
 * @property {string | null} favoriteId
 * @property {string | null} customTitle
 *
 * @param {ClosedTabEntry} entry
 * @param {{
 *   pinnedExists: (id: string) => boolean,
 *   favoriteExists: (id: string) => boolean,
 *   windowTabs: { key: string, pinnedId: string | null, favoriteId: string | null }[]
 * }} context
 * @returns {{ action: 'select', key: string }
 *   | { action: 'create', url: string, title: string, customTitle: string | null,
 *       pinnedId: string | null, favoriteId: string | null }}
 */
export function resolveReopen(entry, context) {
  const pinnedId = entry.pinnedId && context.pinnedExists(entry.pinnedId) ? entry.pinnedId : null
  const favoriteId = entry.favoriteId && context.favoriteExists(entry.favoriteId) ? entry.favoriteId : null
  const definitionId = pinnedId ?? favoriteId

  if (definitionId) {
    const existing = context.windowTabs.find(
      (tab) => tab.pinnedId === definitionId || tab.favoriteId === definitionId
    )
    if (existing) return { action: 'select', key: existing.key }
  }

  return {
    action: 'create',
    url: entry.url,
    title: entry.title,
    customTitle: entry.customTitle,
    pinnedId,
    favoriteId
  }
}
