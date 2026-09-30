// フォーム自動入力の身分証（パスポート・運転免許証・健康保険証）まわり（plan `2026-09-29-0934-kypr-identity-autofill.md`）。
// 足切り・「有効期限」だけの欄の書類の決め方・日付の分割・和暦の照合。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfile } from '../src/shared/autofill-schema.js'
import { deriveValues, formatForElement, matchSelectOption, toWareki } from '../src/shared/autofill-values.js'
import {
  CHOICE_THRESHOLD,
  DOCUMENT_THRESHOLD,
  buildFillPlan,
  buildJevRequests,
  expandGroup,
  isDateLikeField,
  normalizeCollected,
  readJevAnswers,
  resolveConflicts,
  resolveDocumentExpiry
} from '../src/shared/autofill-match.js'

const PROFILE = normalizeProfile({
  family_name: '山田',
  given_name: '太郎',
  birthday: '1989-01-07',
  passport_number: 'TK1234567',
  passport_expiry: '2031-04-30',
  license_number: '123456789012',
  license_expiry: '2029-06-15',
  insurance_symbol: '1234',
  insurance_number: '56',
  insurance_branch: '01',
  insurer_number: '06123456'
})
const VALUES = deriveValues(PROFILE)
const SECRET_VALUES = Object.values(PROFILE).filter((value) => value.length >= 2)

const el = (overrides = {}) => ({
  tag: 'input',
  type: 'text',
  placeholder: '',
  maxLength: null,
  ...overrides
})
const select = (options) => ({
  tag: 'select',
  type: '',
  placeholder: '',
  maxLength: null,
  options: options.map((text) => ({ value: text, text }))
})
const collectedOf = (fields, elements) => normalizeCollected({ pageTitle: '申し込み', elements, fields })
const jev = (option, confidence = 0.95) => ({ option, confidence, source: 'jev' })

test('足切り: 身分証の項目は DOCUMENT_THRESHOLD、ほかは CHOICE_THRESHOLD', () => {
  assert.ok(DOCUMENT_THRESHOLD > CHOICE_THRESHOLD)
  const middle = (DOCUMENT_THRESHOLD + CHOICE_THRESHOLD) / 2
  const answers = {
    f0: { choice: 'passport_number', confidence: middle },
    own0: { noul: 0.9 },
    f1: { choice: 'email', confidence: middle },
    own1: { noul: 0.9 },
    f2: { choice: 'license_number', confidence: DOCUMENT_THRESHOLD },
    own2: { noul: 0.9 },
    f3: { choice: 'document_expiry', confidence: middle },
    own3: { noul: 0.9 }
  }
  const { decisions } = readJevAnswers(answers, [0, 1, 2, 3])
  assert.deepEqual([...decisions.keys()], [1, 2], `実測の確からしさ ${middle}`)
})

test('resolveDocumentExpiry: すぐ前が身分証の番号ならその書類の期限', () => {
  const collected = collectedOf(
    [
      { label: '旅券番号', members: [0] },
      { label: '有効期限', members: [1] },
      { label: '免許証番号', members: [2] },
      { label: '有効期限', members: [3] }
    ],
    [el(), el(), el(), el()]
  )
  const decisions = new Map([
    [0, jev('passport_number')],
    [1, jev('document_expiry')],
    [2, jev('license_number')],
    [3, jev('document_expiry')]
  ])
  const resolved = resolveConflicts(resolveDocumentExpiry(decisions, collected))
  assert.equal(resolved.get(1)?.option, 'passport_expiry')
  assert.equal(resolved.get(3)?.option, 'license_expiry', '2 つの「有効期限」が重複の解消で片方消えない')
})

test('resolveDocumentExpiry: 発行日（決まらなかった日付の欄）は飛ばしてさかのぼる', () => {
  const collected = collectedOf(
    [
      { label: '旅券番号', members: [0] },
      { label: '発行日', members: [1, 2, 3] },
      { label: '有効期限', members: [4, 5, 6] }
    ],
    [el(), select(['2021']), select(['4']), select(['30']), select(['2031']), select(['4']), select(['30'])]
  )
  const decisions = new Map([
    [0, jev('passport_number')],
    [2, jev('document_expiry')]
  ])
  assert.equal(resolveDocumentExpiry(decisions, collected).get(2)?.option, 'passport_expiry')
})

test('resolveDocumentExpiry: 発行日が決まった欄に当たったら、その書類の期限（番号 → 発行日 → 有効期限）', () => {
  const collected = collectedOf(
    [
      { label: '旅券番号', members: [0] },
      { label: '発行日', members: [1] },
      { label: '有効期限', members: [2] },
      { label: '免許証番号', members: [3] },
      { label: '交付日', members: [4] },
      { label: '有効期限', members: [5] }
    ],
    [el(), el(), el(), el(), el(), el()]
  )
  const decisions = new Map([
    [0, jev('passport_number')],
    [1, jev('passport_issue_date')],
    [2, jev('document_expiry')],
    [3, jev('license_number')],
    [4, jev('license_issue_date')],
    [5, jev('document_expiry')]
  ])
  const resolved = resolveConflicts(resolveDocumentExpiry(decisions, collected))
  assert.equal(resolved.get(1)?.option, 'passport_issue_date')
  assert.equal(resolved.get(2)?.option, 'passport_expiry')
  assert.equal(resolved.get(4)?.option, 'license_issue_date')
  assert.equal(resolved.get(5)?.option, 'license_expiry')
})

test('resolveDocumentExpiry: 日付でない欄（発行国の select）・カード番号・保険証・先頭なら空欄のまま', () => {
  const collected = collectedOf(
    [
      { label: '有効期限', members: [0] },
      { label: '免許証番号', members: [1] },
      { label: '発行国', members: [2] },
      { label: '有効期限', members: [3] },
      { label: 'カード番号', members: [4] },
      { label: '有効期限', members: [5] },
      { label: '保険者番号', members: [6] },
      { label: '有効期限', members: [7] }
    ],
    [el(), el(), select(['日本', 'アメリカ']), el(), el(), el(), el(), el()]
  )
  const decisions = new Map([
    [0, jev('document_expiry')],
    [1, jev('license_number')],
    [3, jev('document_expiry')],
    [5, jev('document_expiry')],
    [6, jev('insurer_number')],
    [7, jev('document_expiry')]
  ])
  const resolved = resolveDocumentExpiry(decisions, collected)
  assert.equal(resolved.has(0), false, '先頭')
  assert.equal(resolved.has(3), false, '発行国の select を挟む（さかのぼりすぎない）')
  assert.equal(resolved.has(5), false, 'カード番号の直後（カード番号は決まらない欄）')
  assert.equal(resolved.has(7), false, '保険証には期限の項目が無い')
  assert.equal(resolved.get(1)?.option, 'license_number', 'ほかの決定はそのまま')
})

test('isDateLikeField: 日付の欄だけ（発行国は日付でない）', () => {
  const field = (label, members = [0], name = '') => ({
    label,
    name,
    idAttr: '',
    placeholder: '',
    autocomplete: '',
    nearby: '',
    section: '',
    type: 'text',
    tag: 'input',
    members,
    optionsSample: []
  })
  const elements = [
    el(),
    select(['2020']),
    select(['1']),
    select(['1']),
    el({ maxLength: 4 }),
    el({ maxLength: 2 }),
    el({ maxLength: 2 })
  ]
  assert.equal(isDateLikeField(field('発行日'), elements), true)
  assert.equal(isDateLikeField(field('交付年月日'), elements), true)
  assert.equal(isDateLikeField({ ...field('いつ'), type: 'date' }, elements), true)
  assert.equal(isDateLikeField(field('', [1, 2, 3]), elements), true, '年月日の select')
  assert.equal(isDateLikeField(field('', [4, 5, 6]), elements), true, '4 桁・2 桁・2 桁の入力')
  assert.equal(isDateLikeField(field('発行国'), elements), false)
  assert.equal(isDateLikeField(field('カード番号'), elements), false)
})

test('deriveValues: 身分証の番号と、期限の年 / 月 / 日を作る', () => {
  assert.equal(VALUES['passport_number'], 'TK1234567')
  assert.equal(VALUES['insurer_number'], '06123456')
  assert.deepEqual(
    [VALUES['passport_expiry_year'], VALUES['passport_expiry_month'], VALUES['passport_expiry_day']],
    ['2031', '4', '30']
  )
  assert.equal(VALUES['license_expiry'], '2029-06-15')
})

test('expandGroup: 日付の項目は全部年 / 月 / 日に分ける・保険証の「記号 - 番号」', () => {
  assert.deepEqual(expandGroup('license_expiry', 3), [
    'license_expiry_year',
    'license_expiry_month',
    'license_expiry_day'
  ])
  assert.deepEqual(expandGroup('insurance_number', 2), ['insurance_symbol', 'insurance_number'])
  assert.equal(expandGroup('passport_number', 2), null)
})

test('toWareki: 改元の日で分かれる・元年', () => {
  assert.deepEqual(toWareki('1989-01-07'), { name: '昭和', letter: 'S', year: 64 })
  assert.deepEqual(toWareki('1989-01-08'), { name: '平成', letter: 'H', year: 1 })
  assert.deepEqual(toWareki('2019-04-30'), { name: '平成', letter: 'H', year: 31 })
  assert.deepEqual(toWareki('2019-05-01'), { name: '令和', letter: 'R', year: 1 })
  assert.deepEqual(toWareki('2029-06-15'), { name: '令和', letter: 'R', year: 11 })
  assert.equal(toWareki('平成2年'), null)
})

test('matchSelectOption: 年の select が和暦でも選べる（元号は元の日付で決める）', () => {
  const years = (list) => list.map((text) => ({ value: text, text }))
  assert.equal(
    matchSelectOption(years(['令和10', '令和11', '令和12']), 'license_expiry_year', '2029', VALUES),
    1
  )
  assert.equal(matchSelectOption(years(['R10年', 'R11年']), 'license_expiry_year', '2029', VALUES), 1)
  assert.equal(
    matchSelectOption(years(['2028（令和10）', '2029（令和11）']), 'license_expiry_year', '2029', VALUES),
    1
  )
  // 1989-01-07 は昭和64年（同じ 1989 年でも平成元年を選ばない）
  assert.equal(
    matchSelectOption(years(['昭和63', '昭和64', '平成元', '平成2']), 'birthday_year', '1989', VALUES),
    1
  )
  const heisei = deriveValues(normalizeProfile({ birthday: '1989-01-08' }))
  assert.equal(matchSelectOption(years(['昭和64', '平成元', '平成2']), 'birthday_year', '1989', heisei), 1)
})

test('formatForElement: 日付の欄は例・見出しが和暦なら和暦で書く', () => {
  assert.equal(
    formatForElement('license_expiry', VALUES, el({ placeholder: '令和◯年◯月◯日' }), '有効期限'),
    '令和11年6月15日'
  )
  assert.equal(
    formatForElement('passport_expiry', VALUES, el({ placeholder: '2031/04/30' }), '有効期限'),
    '2031/04/30'
  )
  assert.equal(formatForElement('passport_expiry', VALUES, el({ type: 'date' }), '有効期限'), '2031-04-30')
  // 年だけの入力欄が和暦（「令和[  ]年」）なら元号の年
  assert.equal(formatForElement('license_expiry_year', VALUES, el({ maxLength: 2 }), '有効期限 令和'), '11')
  assert.equal(formatForElement('license_expiry_year', VALUES, el({ maxLength: 4 }), '有効期限'), '2029')
})

test('buildFillPlan: 期限の年月日の select に入れ、身分証の数を数える', () => {
  const collected = collectedOf(
    [
      { label: '免許証番号', members: [0] },
      { label: '有効期限', members: [1, 2, 3] }
    ],
    [el(), select(['令和10', '令和11']), select(['5', '6']), select(['14', '15'])]
  )
  const decisions = new Map([
    [0, jev('license_number')],
    [1, jev('license_expiry')]
  ])
  const plan = buildFillPlan(collected, decisions, VALUES)
  assert.deepEqual(plan.steps, [
    { element: 0, value: '123456789012' },
    { element: 1, optionIndex: 1 },
    { element: 2, optionIndex: 1 },
    { element: 3, optionIndex: 1 }
  ])
  assert.equal(plan.documents, 2)
  // 伏せる値（Claude のウィンドウ用）は番号だけ。期限は伏せない
  assert.deepEqual(plan.secretValues, ['123456789012'])
  assert.deepEqual(plan.secretElements, [0])
})

test('buildFillPlan: 伏せる値は secret の項目の実際に入れる値（保険証の記号・番号の分割も）で、入れない欄の分は外す', () => {
  const collected = collectedOf(
    [
      { label: '氏名', members: [0] },
      { label: '記号・番号', members: [1, 2] },
      { label: '旅券番号', members: [3] }
    ],
    // 旅券番号の欄は maxlength が足りず入れない（伏せる値にも入れない）
    [el(), el(), el(), el({ maxLength: 3 })]
  )
  const decisions = new Map([
    [0, jev('family_name')],
    [1, jev('insurance_symbol')],
    [2, jev('passport_number')]
  ])
  const plan = buildFillPlan(collected, decisions, VALUES)
  assert.deepEqual(plan.secretValues, ['1234', '56'])
  assert.deepEqual(plan.secretElements, [1, 2])
  assert.equal(
    plan.steps.some((step) => step.element === 3),
    false
  )
  assert.equal(plan.secretValues.includes('山田'), false)
})

test('buildJevRequests: 身分証の候補を出し、身分証の値は送らない', () => {
  const collected = collectedOf([{ label: '旅券番号', members: [0] }], [el()])
  const [chunk] = buildJevRequests(collected, [0])
  const criteria = chunk.body.questions.f0.criteria
  for (const option of [
    'passport_number',
    'passport_expiry',
    'license_number',
    'license_expiry',
    'insurance_symbol',
    'insurance_number',
    'insurance_branch',
    'insurer_number',
    'document_expiry'
  ])
    assert.ok(option in criteria, option)
  assert.match(criteria.none, /My Number/)
  assert.match(chunk.body.questions.own0.criteria.true, /passport/)
  const body = JSON.stringify(chunk.body)
  for (const value of SECRET_VALUES) assert.equal(body.includes(value), false, `値が送られている: ${value}`)
})
