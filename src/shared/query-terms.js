// @ts-check
/**
 * コマンドバーの入力を「語」に分けて照合する純粋関数。
 *
 * 「github nyshk97 mobil」のように空白区切りで打った語を**全部含む**もの（順序不問）を
 * 候補にする。開いているタブ / ピン留め / Favorites（`main/suggest.ts`）と
 * 履歴（`main/store/history.ts`）が同じ分割を使う。別々に実装すると、全角空白や
 * 小文字化の扱いが食い違って「同じ入力なのに履歴だけ当たらない」が出る。
 *
 * Electron / Node 非依存。`scripts/query-terms.test.mjs` からテストする。
 */

/**
 * 入力を語に分ける。半角・全角の空白で切り、空要素を除き、小文字にする。
 *
 * @param {string} query
 * @returns {string[]}
 */
export function splitTerms(query) {
  return query
    .split(/[\s\u3000]+/)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase())
}

/**
 * 全部の語が、いずれかのフィールドに含まれるか（語ごとに OR、語をまたいで AND）。
 *
 * **語が 0 個なら true**（`every` の空配列）。「空の入力は候補ゼロ」は呼び出し側の
 * ガード（`suggest` / `searchHistory` の `query.trim()`）が担うので、ここでは
 * 「絞り込み条件が無い = 全件一致」に倒しておく。
 *
 * @param {string[]} terms `splitTerms` の結果（小文字化済み）
 * @param {...string} fields 照合するフィールド（タイトル・URL など）
 * @returns {boolean}
 */
export function matchesAllTerms(terms, ...fields) {
  const haystacks = fields.map((field) => field.toLowerCase())
  return terms.every((term) => haystacks.some((haystack) => haystack.includes(term)))
}
