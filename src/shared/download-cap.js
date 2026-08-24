// @ts-check
/**
 * ダウンロード一覧の件数上限の判定。
 *
 * **上限は scope（常用 / シークレット）ごとに掛ける**。
 * 全部を混ぜて上限を掛けると、シークレット側で大量に落としただけで
 * 通常側の古い履歴が押し出されて消える。
 *
 * Electron 非依存にして `scripts/download-cap.test.mjs` から直接テストする。
 */

/** scope ごとに保持する件数の上限。 */
export const MAX_ENTRIES = 50

/**
 * 上限を超えた分として捨ててよい id を返す。
 *
 * - **同じ scope の中だけ**で数える
 * - 新しい順に残す（`startedAt` の降順）
 * - 進行中 / 一時停止は捨てない（数には入れる。終わるのを待つ）
 *
 * @param {{ id: string, scope: string | null, startedAt: number, state: string }[]} entries
 * @param {string | null} scope 上限を掛ける対象
 * @param {number} [max]
 * @returns {string[]} 捨ててよい id
 */
export function idsOverCap(entries, scope, max = MAX_ENTRIES) {
  return entries
    .filter((entry) => entry.scope === scope)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(max)
    .filter((entry) => entry.state !== 'progressing' && entry.state !== 'paused')
    .map((entry) => entry.id)
}
