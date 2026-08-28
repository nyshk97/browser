// @ts-check
/**
 * スロットを読み込むときに「どのタブを一時タブへ降格させるか」の判定。
 *
 * 読み込みは定義（ピン留め + お気に入り）を**丸ごと置き換える**。置き換えたあと、
 * 消えた定義に紐づいたままのタブが残ると**サイドバーのどの層にも出ない不可視タブ**になる。
 * その始末は `demoteEverywhere` が既に持っているので、ここは「渡す材料」だけを作る。
 *
 * **全部を降格させない**のが肝。自分の Mac で保存した枠を読み込むと ID がそのまま一致するので、
 * 全部降格させると「定義はサイドバーに残ったまま、同じ URL の一時タブが並ぶ」
 * （枠を押すと 2 個目のタブが開く）状態になる。
 *
 * 逆に **ID の一致だけで残す判断をしない**。同じ ID が
 * ピン留め ⇄ お気に入りに移った / URL が差し替わった / link が folder になった場合、
 * タブは「別物になった枠」に紐づいたままになり、行と開いているページが食い違う。
 *
 * Electron 非依存にして `scripts/slot-apply.test.mjs` から直接テストする
 * （`store/pins.ts` も `registry.ts` も `electron` を引くので node:test から触れない）。
 */

/**
 * @typedef {object} DefinitionEntry
 * @property {string} id
 * @property {'favorite' | 'pinned-link' | 'pinned-folder'} kind 種別が変わったら別物として扱う
 * @property {string | null} url フォルダは null
 * @property {string} title
 * @property {string | null} customTitle
 */

/**
 * お気に入り + ピン留め（フォルダの子孫も含む）を、ID で引ける平らな一覧にする。
 *
 * @param {import('./types.js').FavoriteItem[]} favorites
 * @param {import('./types.js').PinnedNode[]} pinned
 * @returns {Map<string, DefinitionEntry>}
 */
export function flattenDefinitions(favorites, pinned) {
  /** @type {Map<string, DefinitionEntry>} */
  const entries = new Map()

  for (const item of favorites) {
    entries.set(item.id, {
      id: item.id,
      kind: 'favorite',
      url: item.url,
      title: item.title,
      customTitle: item.customTitle
    })
  }

  /** @param {import('./types.js').PinnedNode[]} nodes */
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        entries.set(node.id, {
          id: node.id,
          kind: 'pinned-folder',
          url: null,
          title: node.title,
          customTitle: node.customTitle
        })
        walk(node.children)
        continue
      }
      entries.set(node.id, {
        id: node.id,
        kind: 'pinned-link',
        url: node.url,
        title: node.title,
        customTitle: node.customTitle
      })
    }
  }
  walk(pinned)

  return entries
}

/**
 * 差し替えで**実質的に消える定義**を返す。
 *
 * 「同じ ID・同じ種別・同じ URL」で新しい側に残っているものだけを生き残りとみなし、
 * それ以外は消えたものとして返す。名前（`title` / `customTitle`）は**旧定義のもの**を返す
 * —— 降格したタブに写す名前の出どころがここしかない。
 *
 * @param {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }} before
 * @param {{ favorites: import('./types.js').FavoriteItem[], pinned: import('./types.js').PinnedNode[] }} after
 * @returns {import('./types.js').RemovedDefinition[]}
 */
export function definitionsRemovedBySlot(before, after) {
  const oldEntries = flattenDefinitions(before.favorites, before.pinned)
  const newEntries = flattenDefinitions(after.favorites, after.pinned)

  /** @type {import('./types.js').RemovedDefinition[]} */
  const removed = []
  for (const entry of oldEntries.values()) {
    const survivor = newEntries.get(entry.id)
    if (survivor && survivor.kind === entry.kind && survivor.url === entry.url) continue
    removed.push({ id: entry.id, title: entry.title, customTitle: entry.customTitle })
  }
  return removed
}
