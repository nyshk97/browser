// kypr のカードの自動入力: 欄の見分け方（`src/shared/kypr-card-field.js`）と、入れる手順の組み立て
// （`src/shared/kypr-card-fill.js`）。plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cardFieldKind } from '../src/shared/kypr-card-field.js'
import { formatExpiry, planCardFill, splitCardNumber, splitCardholder } from '../src/shared/kypr-card-fill.js'
import { KYPR_PAGE_SOURCE } from '../src/shared/kypr-page-source.js'
import { AGENT_PAGE_SOURCE } from '../src/shared/agent-page-source.js'

/** 偽の要素（`cardFieldKind` は `tagName` / `getAttribute` / `labels` / `options` しか見ない）。 */
function el(tag, attrs = {}, { labels = [], options = [] } = {}) {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    labels: labels.map((textContent) => ({ textContent })),
    options: options.map((o) => (typeof o === 'object' ? o : { value: String(o), textContent: String(o) }))
  }
}

test('autocomplete で見分ける（Stripe の Card Element の欄）', () => {
  assert.equal(cardFieldKind(el('input', { name: 'cardnumber', autocomplete: 'cc-number' })), 'number')
  assert.equal(cardFieldKind(el('input', { name: 'exp-date', autocomplete: 'cc-exp' })), 'exp')
  assert.equal(cardFieldKind(el('input', { name: 'cvc', autocomplete: 'cc-csc' })), 'csc')
  assert.equal(cardFieldKind(el('input', { autocomplete: 'section-pay billing cc-name' })), 'name')
  assert.equal(cardFieldKind(el('select', { autocomplete: 'cc-exp-month' })), 'exp-month')
  assert.equal(cardFieldKind(el('input', { autocomplete: 'cc-given-name' })), 'given-name')
})

test('autocomplete の無い日本の決済フォームの欄', () => {
  assert.equal(cardFieldKind(el('input', { name: 'card_no1', maxlength: '4' })), 'number')
  assert.equal(cardFieldKind(el('input', { name: 'card_number' })), 'number')
  assert.equal(cardFieldKind(el('input', { name: 'x1' }, { labels: ['カード番号'] })), 'number')
  // CVC が type=password（ログインの欄にしないための判定の元）
  assert.equal(cardFieldKind(el('input', { type: 'password', name: 'security_code' })), 'csc')
  assert.equal(cardFieldKind(el('input', { type: 'tel', name: 'cvv' })), 'csc')
  assert.equal(cardFieldKind(el('input', { name: 'card_name' })), 'name')
  assert.equal(cardFieldKind(el('input', { name: 'n' }, { labels: ['カード名義'] })), 'name')
  assert.equal(cardFieldKind(el('input', { name: 'expire_month' })), 'exp-month')
  assert.equal(cardFieldKind(el('input', { name: 'expire_year' })), 'exp-year')
  assert.equal(cardFieldKind(el('input', { name: 'expiry', placeholder: 'MM/YY' })), 'exp')
})

test('有効期限の select は選択肢から月か年かを決める', () => {
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
  const years = Array.from({ length: 10 }, (_, i) => String(2026 + i))
  assert.equal(
    cardFieldKind(el('select', { name: 'exp1' }, { labels: ['有効期限'], options: months })),
    'exp-month'
  )
  assert.equal(
    cardFieldKind(el('select', { name: 'exp2' }, { labels: ['有効期限'], options: years })),
    'exp-year'
  )
  // 先頭の「--」の選択肢があっても数字の選択肢で決める
  assert.equal(
    cardFieldKind(
      el('select', { name: 'expire' }, { options: [{ value: '', textContent: '--' }, ...months] })
    ),
    'exp-month'
  )
})

test('カードの欄でないもの', () => {
  assert.equal(cardFieldKind(el('input', { type: 'email', autocomplete: 'email' })), null)
  assert.equal(cardFieldKind(el('input', { type: 'password', name: 'password' })), null)
  assert.equal(cardFieldKind(el('input', { name: 'username' })), null)
  assert.equal(cardFieldKind(el('input', { name: 'experience' })), null)
  assert.equal(cardFieldKind(el('input', { type: 'checkbox', name: 'card_number' })), null)
  assert.equal(cardFieldKind(el('textarea', { name: 'card_number' })), null)
  assert.equal(cardFieldKind(null), null)
})

test('判定の関数はそのまま文字列にしてページ側のスクリプトに埋め込める（外の変数を参照しない）', () => {
  const standalone = new Function(`return (${String(cardFieldKind)})`)()
  assert.equal(standalone(el('input', { autocomplete: 'cc-number' })), 'number')
  assert.equal(standalone(el('input', { name: 'card_name' })), 'name')
  // 3 か所のうち、文字列で持つ 2 か所に同じ関数が入っている
  assert.ok(KYPR_PAGE_SOURCE.includes(String(cardFieldKind)))
  assert.ok(AGENT_PAGE_SOURCE.includes(String(cardFieldKind)))
  new Function(KYPR_PAGE_SOURCE)
  new Function(AGENT_PAGE_SOURCE)
})

const field = (i, kind, extra = {}) => ({ i, kind, tag: 'input', maxLength: -1, placeholder: '', ...extra })
const CARD = {
  number: '4242424242424242',
  expMonth: '3',
  expYear: '2031',
  code: '123',
  cardholderName: 'TARO YAMADA'
}

test('有効期限の 1 つの欄の形', () => {
  const at = (maxLength, placeholder = '') =>
    formatExpiry(3, 2031, { i: 0, kind: 'exp', tag: 'input', maxLength, placeholder })
  assert.equal(at(-1), '03/31')
  assert.equal(at(-1, '月 / 年'), '03 / 31')
  assert.equal(at(5, 'MM/YY'), '03/31')
  assert.equal(at(7, 'MM/YYYY'), '03/2031')
  assert.equal(at(7, 'MM / YY'), '03 / 31')
  assert.equal(at(4), '0331')
  assert.equal(at(6), '032031')
  assert.equal(at(-1, 'MM/YYYY'), '03/2031')
})

test('番号の分割（maxlength の順・無ければ 4 桁ずつ・Amex は 4-6-5）', () => {
  const four = [0, 1, 2, 3].map((i) => field(i, 'number', { maxLength: 4 }))
  assert.deepEqual(splitCardNumber('4242424242424242', four), ['4242', '4242', '4242', '4242'])
  const amex = [0, 1, 2].map((i) => field(i, 'number'))
  assert.deepEqual(splitCardNumber('378282246310005', amex), ['3782', '822463', '10005'])
  assert.deepEqual(splitCardNumber('4242424242424242', [field(0, 'number')]), ['4242424242424242'])
})

test('名義の分割', () => {
  assert.deepEqual(splitCardholder('TARO YAMADA'), { given: 'TARO', family: 'YAMADA' })
  assert.deepEqual(splitCardholder('  MARY ANN SMITH '), { given: 'MARY ANN', family: 'SMITH' })
  assert.deepEqual(splitCardholder('TARO'), { given: 'TARO', family: '' })
})

test('メインフレームのフォーム: 月と年が別の select', () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), text: `${i + 1}月` }))
  const years = Array.from({ length: 10 }, (_, i) => ({ value: String(26 + i), text: `${2026 + i}年` }))
  const { steps, kinds } = planCardFill(
    [
      {
        key: 'main',
        fields: [
          field(0, 'number'),
          field(1, 'exp-month', { tag: 'select', options: months }),
          field(2, 'exp-year', { tag: 'select', options: years }),
          field(3, 'csc'),
          field(4, 'name')
        ]
      }
    ],
    CARD
  )
  assert.deepEqual(steps['main'], [
    { i: 0, value: '4242424242424242' },
    { i: 1, value: '3' },
    { i: 2, value: '31' },
    { i: 3, value: '123' },
    { i: 4, value: 'TARO YAMADA' }
  ])
  assert.deepEqual(kinds.sort(), ['csc', 'exp-month', 'exp-year', 'name', 'number'])
})

test('分割型の iframe の組と、メインフレームの名義（組が先・同じ項目は 1 回）', () => {
  const { steps } = planCardFill(
    [
      { key: 'exp-frame', fields: [field(0, 'exp', { placeholder: '月 / 年' })] },
      { key: 'num-frame', fields: [field(0, 'number')] },
      { key: 'cvc-frame', fields: [field(0, 'csc')] },
      // メインフレームにも番号の欄があるが、組で入れたので入れない。名義だけ入れる
      { key: 'main', fields: [field(0, 'number'), field(1, 'name')] }
    ],
    CARD
  )
  assert.deepEqual(steps, {
    'exp-frame': [{ i: 0, value: '03 / 31' }],
    'num-frame': [{ i: 0, value: '4242424242424242' }],
    'cvc-frame': [{ i: 0, value: '123' }],
    main: [{ i: 1, value: 'TARO YAMADA' }]
  })
})

test('期限・名義が空のカード・年の選択肢に無いときは、その欄を入れない', () => {
  const years = [{ value: '2026', text: '2026' }]
  const { steps, kinds } = planCardFill(
    [
      {
        key: 'main',
        fields: [
          field(0, 'number'),
          field(1, 'exp-year', { tag: 'select', options: years }),
          field(2, 'name')
        ]
      }
    ],
    { ...CARD, cardholderName: '' }
  )
  assert.deepEqual(steps['main'], [{ i: 0, value: '4242424242424242' }])
  assert.deepEqual(kinds, ['number'])
})
