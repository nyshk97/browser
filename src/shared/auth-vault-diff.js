// @ts-check
/**
 * 保管庫とこの Mac のルールの突き合わせ。
 *
 * **判定はここ 1 本**。読み込みの 3 グループも、保存の「消えます」警告も、
 * **同じ向きで（第 1 引数は常に保管庫）、第 2 引数だけ変えて**呼ぶ:
 *
 * - 読み込みの 3 グループ … `diffAuthRules(vault, local)`
 * - 保存で消えるもの     … `diffAuthRules(vault, localEnabled).missing`
 *
 * 向きを取り違えると、保存の確認に**「これから追加されるもの」を「消えます」として**出す。
 *
 * 突き合わせの軸は **`pattern` の完全一致**（`importMultipass` が
 * 既存ルールを引き当てるのと同じ規則）。`store/http-auth.ts` の
 * `importHttpAuthRules` も同じ軸で置き換えるので、ここで別の軸を使うと食い違う。
 *
 * Electron を引かないので `scripts/auth-vault-diff.test.mjs` から直接テストできる。
 */

/**
 * 保管庫側の 1 件。**有効なものしか入っていない**ので `enabled` を持たない。
 *
 * @typedef {object} VaultSide
 * @property {string} pattern
 * @property {string} username
 * @property {string} password 平文
 * @property {number} [updatedAt]
 */

/**
 * この Mac 側の 1 件。**無効なものも渡す**（差分から外すと、意図して外したルールが
 * 「この Mac に無いもの」として現れ、読み込みで黙って有効に戻る）。
 *
 * @typedef {object} LocalSide
 * @property {string} pattern
 * @property {string} username
 * @property {string} password 平文
 * @property {number} [updatedAt]
 * @property {boolean} enabled
 * @property {string} [disabledReason]
 */

/**
 * @typedef {object} MissingEntry
 * @property {string} pattern
 * @property {string} username
 */

/**
 * @typedef {object} DifferingEntry
 * @property {string} pattern
 * @property {string} fromUsername 保管庫側のユーザー名
 * @property {string} toUsername この Mac 側のユーザー名
 * @property {boolean} usernameDiffers
 * @property {boolean} passwordDiffers
 * @property {'from' | 'to' | null} newer **両方に `updatedAt` があるときだけ**決まる
 * @property {number} [fromUpdatedAt]
 * @property {number} [toUpdatedAt]
 * @property {boolean} toEnabled
 * @property {string} [toDisabledReason]
 */

/**
 * @typedef {object} SameEntry
 * @property {string} pattern
 * @property {string} username
 * @property {boolean} toEnabled
 * @property {string} [toDisabledReason]
 */

/**
 * @param {VaultSide[]} from
 * @param {LocalSide[]} to
 * @returns {{ missing: MissingEntry[], differing: DifferingEntry[], same: SameEntry[] }}
 */
export function diffAuthRules(from, to) {
  const target = new Map((to ?? []).map((rule) => [rule.pattern, rule]))

  /** @type {MissingEntry[]} */
  const missing = []
  /** @type {DifferingEntry[]} */
  const differing = []
  /** @type {SameEntry[]} */
  const same = []

  for (const rule of from ?? []) {
    const match = target.get(rule.pattern)
    if (!match) {
      missing.push({ pattern: rule.pattern, username: rule.username })
      continue
    }

    const usernameDiffers = rule.username !== match.username
    const passwordDiffers = rule.password !== match.password

    if (!usernameDiffers && !passwordDiffers) {
      /** @type {SameEntry} */
      const entry = { pattern: rule.pattern, username: rule.username, toEnabled: match.enabled }
      if (match.disabledReason !== undefined) entry.toDisabledReason = match.disabledReason
      same.push(entry)
      continue
    }

    /** @type {DifferingEntry} */
    const entry = {
      pattern: rule.pattern,
      fromUsername: rule.username,
      toUsername: match.username,
      usernameDiffers,
      passwordDiffers,
      newer: compareUpdatedAt(rule.updatedAt, match.updatedAt),
      toEnabled: match.enabled
    }
    if (rule.updatedAt !== undefined) entry.fromUpdatedAt = rule.updatedAt
    if (match.updatedAt !== undefined) entry.toUpdatedAt = match.updatedAt
    if (match.disabledReason !== undefined) entry.toDisabledReason = match.disabledReason
    differing.push(entry)
  }

  return { missing, differing, same }
}

/**
 * どちらが新しいか。
 *
 * **片方でも欠けていたら `null`**。既存のルールには `updatedAt` が入っていないので、
 * 初回の移行では両側とも無い。推測で「保管庫の方が新しい」と出すと、
 * **上書きの向きを誤って案内する**。
 *
 * @param {number | undefined} fromAt
 * @param {number | undefined} toAt
 * @returns {'from' | 'to' | null}
 */
function compareUpdatedAt(fromAt, toAt) {
  if (typeof fromAt !== 'number' || typeof toAt !== 'number') return null
  if (fromAt === toAt) return null
  return fromAt > toAt ? 'from' : 'to'
}
