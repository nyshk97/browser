// @ts-check
/**
 * kypr: 決済フォームの欄がカードのどの項目かを見分ける（plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`）。
 *
 * **3 か所が同じ関数を使う**（どれか 1 か所だけ直すと「入れたのに伏せない」「カードの欄でログインの候補が出る」欄が黙ってできる）:
 * - `src/preload/kypr-page.ts` … メインフレームのカードの欄へのフォーカスを知らせる・ログイン欄の判定から外す（import して呼ぶ）
 * - `src/shared/kypr-page-source.js` … 入れる先の欄を集める・ログインの `find()` から外す（文字列にして埋め込む）
 * - `src/shared/agent-page-source.js` … Claude のウィンドウで番号・CVC の欄を欄そのもので伏せる（文字列にして埋め込む）
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない（`kypr-passkey-shim.js` と同じ）。
 * テンプレート文字列と `${` も書かない（埋め込む先が `String.raw` のテンプレート）。
 * `instanceof` を使わず `tagName` で見る（`scripts/kypr-card.test.mjs` が偽の要素で呼ぶ）。
 *
 * 見る順: `autocomplete` → `name` / `id` / `placeholder` / `aria-label` / ラベルの文字。
 * 有効期限の `select` は、手がかりで「期限」と分かったら選択肢から月か年かを決める。
 *
 * @param {any} el
 * @returns {'number' | 'exp' | 'exp-month' | 'exp-year' | 'csc' | 'name' | 'given-name' | 'family-name' | null}
 */
export function cardFieldKind(el) {
  if (!el || typeof el.getAttribute !== 'function') return null
  const tag = String(el.tagName || '').toLowerCase()
  if (tag !== 'input' && tag !== 'select') return null
  const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : 'select'
  if (tag === 'input' && ['text', 'tel', 'number', 'password', 'search'].indexOf(type) < 0) return null

  const tokens = String(el.getAttribute('autocomplete') || '')
    .toLowerCase()
    .split(/\s+/)
  /** @type {Record<string, 'number' | 'exp' | 'exp-month' | 'exp-year' | 'csc' | 'name' | 'given-name' | 'family-name'>} */
  const AC = {
    'cc-number': 'number',
    'cc-exp': 'exp',
    'cc-exp-month': 'exp-month',
    'cc-exp-year': 'exp-year',
    'cc-csc': 'csc',
    'cc-name': 'name',
    'cc-given-name': 'given-name',
    'cc-family-name': 'family-name'
  }
  for (const token of tokens) {
    const kind = Object.prototype.hasOwnProperty.call(AC, token) ? AC[token] : null
    if (kind && (tag === 'input' || kind === 'exp-month' || kind === 'exp-year')) return kind
  }

  let labelText = ''
  try {
    for (const label of el.labels || []) labelText += ' ' + String(label.textContent || '').slice(0, 80)
  } catch {
    labelText = ''
  }
  const hint = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    labelText
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 400)
  if (hint === '') return null
  // ギフトカード・プリペイド・ポイントカードの番号とコードはクレジットカードではない
  if (/gift|prepaid|point|ギフト|プリペイド|ポイント/i.test(hint)) return null

  const isExp =
    /expir|cc[\s_.-]?exp|card[\s_.-]?exp|exp[\s_.-]?(date|month|mon|mm|year|yr|yy)|^exp\b|\bexp$|有効期限|有効年月/i.test(
      hint
    )
  if (isExp) {
    if (tag === 'select') {
      // 選択肢の値か表示の数字から決める（1〜12 だけなら月、それ以外の 2 桁・4 桁の数字が並ぶなら年）
      const nums = []
      for (const option of el.options || []) {
        const m = /\d+/.exec(String(option.value || '') + ' ' + String(option.textContent || ''))
        if (m) nums.push(Number(m[0]))
      }
      if (nums.length === 0) return null
      if (nums.every((n) => n >= 1 && n <= 12)) return 'exp-month'
      if (nums.some((n) => n >= 13)) return 'exp-year'
      return null
    }
    if (/month|\bmm\b|mon\b|月/i.test(hint) && !/year|yy|年/i.test(hint)) return 'exp-month'
    if (/year|\byy|yr\b|年/i.test(hint) && !/month|\bmm\b|月/i.test(hint)) return 'exp-year'
    return 'exp'
  }
  if (tag !== 'input') return null
  if (
    /cvc|cvv|\bcsc\b|cc[\s_.-]?csc|security[\s_.-]?code|card[\s_.-]?code|セキュリティ\s*コード|セキュリティ番号/i.test(
      hint
    )
  )
    return 'csc'
  if (
    /card[\s_.-]?(num|no\b|no\d|number)|cardnumber|cc[\s_.-]?(num|no\b|no\d)|ccno|credit[\s_.-]?card[\s_.-]?(num|no)|カード番号/i.test(
      hint
    )
  )
    return 'number'
  if (
    /card[\s_.-]?holder|holder[\s_.-]?name|name[\s_.-]?on[\s_.-]?card|card[\s_.-]?name|cc[\s_.-]?name|カード名義|カード.{0,4}名義人?/i.test(
      hint
    )
  )
    return 'name'
  return null
}

/**
 * カードの欄 `el` が、**カードのフォームの欄**か（同じフォーム、フォームが無ければ同じ文書に、番号の欄と、期限か CVC の欄がそろっている）。
 * 名前の手がかりは広く拾うので（「利用者カード番号」とパスワードのログインなど）、そろっていない欄はカードの欄として扱わない。
 * 欄ごとに iframe が分かれている型（Stripe の分割型）は 1 つの文書にそろわないので、iframe の組は main が組全体で見る。
 *
 * **この関数もそのまま文字列化してページに送る**。中で呼ぶ `cardFieldKind` は、埋め込む先が同じ名前で用意する。
 * @param {any} el
 * @returns {boolean}
 */
export function cardFormComplete(el) {
  const scope = (el && el.form) || (el && el.ownerDocument)
  if (!scope || typeof scope.querySelectorAll !== 'function') return false
  let number = false
  let other = false
  for (const field of scope.querySelectorAll('input, select')) {
    const kind = cardFieldKind(field)
    if (kind === 'number') number = true
    else if (kind === 'exp' || kind === 'exp-month' || kind === 'exp-year' || kind === 'csc') other = true
    if (number && other) return true
  }
  return false
}
