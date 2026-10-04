// @ts-check
/**
 * kypr: カードを決済フォームに入れる手順を組み立てる純粋関数（plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`）。
 *
 * ページ側（`kypr-page-source.js` の `probeCard()`）は欄の記述（種類・`maxlength`・`placeholder`・`select` の選択肢）だけを返し、
 * ここで欄ごとに入れる値を決める。ページ側の `fillCard(steps)` は値を入れるだけ。
 * 欄ごとに iframe が分かれている型（Stripe の分割型など）は、組の各フレームの記述をまとめて渡す。
 * Electron 非依存。`scripts/kypr-card.test.mjs` からテストする。
 */

/**
 * @typedef {'number' | 'exp' | 'exp-month' | 'exp-year' | 'csc' | 'name' | 'given-name' | 'family-name'} CardFieldKind
 * @typedef {{ i: number, kind: CardFieldKind, tag: 'input' | 'select', maxLength: number, placeholder: string,
 *   options?: { value: string, text: string }[] }} CardFieldDesc
 * @typedef {{ key: string, fields: CardFieldDesc[] }} CardFrameDesc
 * @typedef {{ number: string, expMonth: string, expYear: string, code: string, cardholderName: string }} CardValues
 * @typedef {{ i: number, value: string }} CardFillStep
 */

/** 月（1〜12）。読めなければ null。 */
function monthOf(/** @type {string} */ value) {
  const n = Number(String(value).trim())
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null
}

/** 西暦 4 桁。2 桁は 2000 年代とみなす。読めなければ null。 */
function yearOf(/** @type {string} */ value) {
  const s = String(value).trim()
  if (/^\d{4}$/.test(s)) return Number(s)
  if (/^\d{2}$/.test(s)) return 2000 + Number(s)
  return null
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0')

/**
 * 番号を欄の並びに割る（1 欄なら全部。並んだ欄は `maxlength` の順。`maxlength` が無ければ 4 桁ずつ、Amex は 4-6-5）。
 * @param {string} digits
 * @param {CardFieldDesc[]} fields
 * @returns {string[]}
 */
export function splitCardNumber(digits, fields) {
  if (fields.length <= 1) return [digits]
  const lengths = fields.map((f) => (f.maxLength > 0 ? f.maxLength : 0))
  const fallback = /^3[47]/.test(digits) && fields.length === 3 ? [4, 6, 5] : fields.map(() => 4)
  /** @type {string[]} */
  const parts = []
  let at = 0
  fields.forEach((_, index) => {
    const isLast = index === fields.length - 1
    const len = lengths[index] || fallback[index] || 4
    parts.push(isLast ? digits.slice(at) : digits.slice(at, at + len))
    at += len
  })
  return parts
}

/**
 * 1 つの欄の有効期限（`MM/YY` を既定に、`maxlength` と `placeholder` から形を決める）。
 * `maxlength` 4 → `MMYY`、6 → `MMYYYY`、7 → `MM/YYYY`（`placeholder` が ` / ` なら `MM / YY`）、9 → `MM / YYYY`。
 * @param {number} month
 * @param {number} year
 * @param {CardFieldDesc} field
 */
export function formatExpiry(month, year, field) {
  const ml = field.maxLength
  const spacedPh = /\s\/\s/.test(field.placeholder)
  const yyyy = String(year)
  const yy = pad2(year % 100)
  if (ml === 4) return pad2(month) + yy
  if (ml === 6) return pad2(month) + yyyy
  const four = /yyyy/i.test(field.placeholder) || ml === 9 || (ml === 7 && !spacedPh)
  const spaced = spacedPh || ml === 9
  return pad2(month) + (spaced ? ' / ' : '/') + (four ? yyyy : yy)
}

/**
 * `select` の選択肢から、数値が `want` の選択肢の value を探す（値 → 表示の順。2 桁の年も見る）。
 * @param {{ value: string, text: string }[]} options
 * @param {(n: number, digits: string) => boolean} match
 */
function pickOption(options, match) {
  for (const key of /** @type {const} */ (['value', 'text'])) {
    for (const option of options) {
      const m = /\d+/.exec(option[key])
      if (m && match(Number(m[0]), m[0])) return option.value
    }
  }
  return null
}

/**
 * 名義を姓と名に割る（カードの表記は「名 姓」の順。空白が無ければ全体を両方には入れず、名だけに入れる）。
 * @param {string} name
 */
export function splitCardholder(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { given: parts[0] ?? '', family: '' }
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] ?? '' }
}

/**
 * 組の各フレームに入れる手順。**先に並んだフレームが優先**（フォーカスのあるフレーム → 兄弟 → メインフレーム）。
 * 同じ項目は 1 回だけ入れる（番号の分割だけは同じフレームの並んだ欄に割る）。
 * @param {CardFrameDesc[]} frames
 * @param {CardValues} card
 * @returns {{ steps: Record<string, CardFillStep[]>, kinds: CardFieldKind[] }}
 */
export function planCardFill(frames, card) {
  const digits = String(card.number || '').replace(/[\s-]/g, '')
  const month = monthOf(card.expMonth)
  const year = yearOf(card.expYear)
  const holder = splitCardholder(String(card.cardholderName || ''))
  /** @type {Record<string, CardFillStep[]>} */
  const steps = {}
  /** @type {Set<CardFieldKind>} */
  const done = new Set()
  // 有効期限は「1 つの欄」と「月・年」のどちらかで入れる（両方の形の欄が別のフレームにあれば、先に見つけた方）
  const expDone = () => done.has('exp') || done.has('exp-month') || done.has('exp-year')

  for (const frame of frames) {
    /** @type {CardFillStep[]} */
    const list = []
    const byKind = (/** @type {CardFieldKind} */ kind) => frame.fields.filter((f) => f.kind === kind)
    const push = (
      /** @type {CardFieldDesc} */ f,
      /** @type {string} */ value,
      /** @type {CardFieldKind} */ kind
    ) => {
      if (value === '') return
      list.push({ i: f.i, value })
      done.add(kind)
    }

    const numbers = byKind('number')
    if (!done.has('number') && digits !== '' && numbers.length > 0) {
      const parts = splitCardNumber(digits, numbers)
      numbers.forEach((f, index) => push(f, parts[index] ?? '', 'number'))
    }

    // 有効期限は、このフレームに月・年の欄があればそちら、無ければ 1 つの欄
    if (!expDone() && month !== null && year !== null) {
      const m = byKind('exp-month')[0]
      const y = byKind('exp-year')[0]
      const single = byKind('exp')[0]
      if (m || y) {
        const mv = !m
          ? null
          : m.tag === 'select'
            ? pickOption(m.options ?? [], (n) => n === month)
            : pad2(month)
        const yv = !y
          ? null
          : y.tag === 'select'
            ? pickOption(y.options ?? [], (n, d) => n === year || (d.length === 2 && n === year % 100))
            : y.maxLength === 2 || /^yy$/i.test(y.placeholder.trim())
              ? pad2(year % 100)
              : String(year)
        if (m && mv !== null) push(m, mv, 'exp-month')
        if (y && yv !== null) push(y, yv, 'exp-year')
      } else if (single) {
        push(single, formatExpiry(month, year, single), 'exp')
      }
    }

    const csc = byKind('csc')[0]
    if (csc && !done.has('csc')) push(csc, String(card.code || ''), 'csc')

    const name = byKind('name')[0]
    if (name && !done.has('name')) push(name, String(card.cardholderName || '').trim(), 'name')
    const given = byKind('given-name')[0]
    if (given && !done.has('given-name')) push(given, holder.given, 'given-name')
    const family = byKind('family-name')[0]
    if (family && !done.has('family-name')) push(family, holder.family, 'family-name')

    if (list.length > 0) steps[frame.key] = list
  }
  return { steps, kinds: [...done] }
}
