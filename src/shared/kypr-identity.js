// @ts-check
/**
 * kypr の個人情報のうち、フォーム自動入力に使う 1 件を決める（plan `2026-09-29-0934-kypr-identity-autofill.md`）。
 *
 * Electron にも kypr の暗号にも依存しない純粋な関数だけを置き、`scripts/kypr-identity.test.mjs` からテストする。
 */

/**
 * @typedef {{ id: string, kind: string, deleted: boolean, createdAt: string }} IdentityCandidate
 */

/**
 * 設定で選んだ 1 件 → 無ければ（未設定・消した・ゴミ箱の中）一番古い 1 件 → 0 件なら null。
 * ゴミ箱の中・個人情報以外（読めないアイテムを含む）は候補にしない。
 *
 * @param {readonly IdentityCandidate[]} candidates
 * @param {string | null} preferredId
 * @returns {string | null}
 */
export function pickAutofillIdentity(candidates, preferredId) {
  const live = candidates.filter((c) => c.kind === 'identity' && !c.deleted)
  if (preferredId !== null) {
    const preferred = live.find((c) => c.id === preferredId)
    if (preferred) return preferred.id
  }
  if (live.length === 0) return null
  // createdAt は ISO 8601 UTC なので文字列の比較で古い順になる。同時刻なら id で決める（毎回同じ 1 件にする）
  const sorted = [...live].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1
  )
  return sorted[0]?.id ?? null
}
