// フォーム自動入力の英語のフォーム（氏名はローマ字・住所は英語の住所）と年齢。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfile } from '../src/shared/autofill-schema.js'
import {
  ageOn,
  deriveValues,
  formatForElement,
  matchSelectOption,
  prefectureEn
} from '../src/shared/autofill-values.js'
import {
  buildJevRequests,
  isEnglishForm,
  normalizeCollected,
  ruleOption
} from '../src/shared/autofill-match.js'

const PROFILE = normalizeProfile({
  family_name: '山田',
  given_name: '太郎',
  family_name_kana: 'ヤマダ',
  given_name_kana: 'タロウ',
  family_name_roman: 'Yamada',
  given_name_roman: 'Taro',
  postal_code: '100-0001',
  address_level1: '東京都',
  address_level2: '千代田区',
  address_line1: '千代田1-1',
  address_line2: 'サンプルタワー 1701',
  address_level2_en: 'Chiyoda-ku',
  address_line1_en: '1-1 Chiyoda',
  address_line2_en: 'Sample Tower 1701',
  birthday: '1988-07-14',
  gender: 'male'
})
const TODAY = new Date(2026, 8, 29) // 2026-09-29（ローカル）
const el = (overrides = {}) => ({
  tag: 'input',
  type: 'text',
  placeholder: '',
  maxLength: null,
  ...overrides
})
const options = (list) => list.map((text) => ({ value: text, text }))
const collected = (pageLang, labels) =>
  normalizeCollected({
    pageTitle: 'x',
    pageLang,
    elements: labels.map(() => el()),
    fields: labels.map((label, i) => ({ label, members: [i] }))
  })

test('isEnglishForm: lang が日本語でなく、見出しに日本語が無いときだけ', () => {
  assert.equal(isEnglishForm(collected('en', ['First name', 'City'])), true)
  assert.equal(isEnglishForm(collected('', ['First name', 'City'])), true, 'lang が無ければ見出しで決める')
  assert.equal(isEnglishForm(collected('ja', ['First name'])), false, 'lang="ja"')
  assert.equal(isEnglishForm(collected('en-US', ['First name', '住所'])), false, '見出しに日本語')
  assert.equal(isEnglishForm(collected('en', ['お名前（カナ）'])), false)
  assert.equal(isEnglishForm(collected('en', [''])), false, '見出しが何も無い')
})

test('deriveValues（英語）: 氏名はローマ字・住所は英語の住所・都道府県は表から・国は Japan', () => {
  const v = deriveValues(PROFILE, { english: true, today: TODAY })
  assert.equal(v['given_name'], 'Taro')
  assert.equal(v['family_name'], 'Yamada')
  assert.equal(v['full_name'], 'Taro Yamada')
  assert.equal(v['family_name_kana'], undefined, 'カナは出さない')
  assert.equal(v['address_level1'], 'Tokyo')
  assert.equal(v['address_level2'], 'Chiyoda-ku')
  assert.equal(v['address_line1'], '1-1 Chiyoda')
  assert.equal(v['address_line2'], 'Sample Tower 1701')
  assert.equal(v['address_full'], '1-1 Chiyoda, Sample Tower 1701, Chiyoda-ku, Tokyo')
  assert.equal(v['country'], 'Japan')
  assert.equal(v['postal_code'], '100-0001')
  const joined = JSON.stringify(v)
  for (const ja of ['山田', '太郎', '千代田', 'サンプルタワー', '東京都'])
    assert.equal(joined.includes(ja), false, ja)
})

test('deriveValues（英語）: 英語の住所が無ければ住所の欄は空（都道府県・郵便番号・国は出す）', () => {
  const v = deriveValues(
    normalizeProfile({ ...PROFILE, address_level2_en: '', address_line1_en: '', address_line2_en: '' }),
    { english: true, today: TODAY }
  )
  for (const key of ['address_level2', 'address_line1', 'address_line2', 'address_line1_2', 'address_full'])
    assert.equal(v[key], undefined, key)
  assert.equal(v['address_level1'], 'Tokyo')
  assert.equal(v['postal_code'], '100-0001')
  assert.equal(v['country'], 'Japan')
})

test('deriveValues（英語）: 都道府県と国は保存した英語の値を優先し、無ければ対応表 / Japan', () => {
  const stored = deriveValues(
    normalizeProfile({ ...PROFILE, address_level1_en: 'Tokyo-to', country_en: 'JAPAN' }),
    { english: true, today: TODAY }
  )
  assert.equal(stored['address_level1'], 'Tokyo-to')
  assert.equal(stored['country'], 'JAPAN')
  assert.equal(stored['address_full'], '1-1 Chiyoda, Sample Tower 1701, Chiyoda-ku, Tokyo-to')
  // 保存した書き方が選択肢に無ければ、対応表の書き方（Tokyo）で選ぶ
  assert.equal(
    matchSelectOption(options(['Osaka', 'Tokyo']), 'address_level1', stored['address_level1'], stored),
    1
  )
  const derived = deriveValues(PROFILE, { english: true, today: TODAY })
  assert.equal(derived['address_level1'], 'Tokyo')
  assert.equal(derived['country'], 'Japan')
})

test('deriveValues（日本語）: 今までどおり。国は「日本」', () => {
  const v = deriveValues(PROFILE, { today: TODAY })
  assert.equal(v['full_name'], '山田 太郎')
  assert.equal(v['address_level2'], '千代田区')
  assert.equal(v['country'], '日本')
})

test('ageOn: 誕生日の前日・当日・2 月 29 日生まれ', () => {
  assert.equal(ageOn('1988-07-14', new Date(2026, 6, 13)), '37')
  assert.equal(ageOn('1988-07-14', new Date(2026, 6, 14)), '38')
  assert.equal(ageOn('2000-02-29', new Date(2027, 1, 28)), '26')
  assert.equal(ageOn('2000-02-29', new Date(2027, 2, 1)), '27')
  assert.equal(ageOn('', TODAY), '')
  assert.equal(deriveValues(PROFILE, { today: TODAY })['age'], '38')
})

test('prefectureEn: 都府県を省いた書き方も受ける・北海道・知らない値は空', () => {
  assert.equal(prefectureEn('東京都'), 'Tokyo')
  assert.equal(prefectureEn('東京'), 'Tokyo')
  assert.equal(prefectureEn('大阪'), 'Osaka')
  assert.equal(prefectureEn('北海道'), 'Hokkaido')
  assert.equal(prefectureEn('沖縄県'), 'Okinawa')
  assert.equal(prefectureEn('どこか'), '')
})

test('matchSelectOption: 国・英語の州・年齢の select', () => {
  const v = deriveValues(PROFILE, { english: true, today: TODAY })
  assert.equal(
    matchSelectOption(
      [
        { value: '', text: 'Select' },
        { value: 'US', text: 'United States' },
        { value: 'JP', text: 'Japan' }
      ],
      'country',
      v['country'],
      v
    ),
    2
  )
  assert.equal(matchSelectOption(options(['日本', 'アメリカ']), 'country', '日本'), 0)
  assert.equal(matchSelectOption(options(['Osaka-fu', 'Tokyo-to']), 'address_level1', 'Tokyo', v), 1)
  assert.equal(matchSelectOption(options(['37歳', '38歳']), 'age', '38'), 1)
})

test('formatForElement: 英語のフォームの性別は Male', () => {
  const v = deriveValues(PROFILE, { english: true, today: TODAY })
  assert.equal(formatForElement('gender', v, el(), 'Gender'), 'Male')
  assert.equal(formatForElement('gender', deriveValues(PROFILE, { today: TODAY }), el(), '性別'), '男性')
})

test('ruleOption / buildJevRequests: autocomplete=country は国・候補に年齢と国があり、none は年齢を挙げない', () => {
  const c = collected('en', ['Country'])
  assert.equal(ruleOption({ ...c.fields[0], autocomplete: 'country' }, c.elements), 'country')
  const [chunk] = buildJevRequests(c, [0])
  const criteria = chunk.body.questions.f0.criteria
  assert.ok('age' in criteria && 'country' in criteria)
  assert.doesNotMatch(criteria.none, /\bage\b/)
})
