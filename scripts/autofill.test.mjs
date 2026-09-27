import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countFilled,
  normalizeProfile,
  normalizeVaultContent,
  PROFILE_KEYS
} from '../src/shared/autofill-schema.js'
import {
  deriveValues,
  formatForElement,
  matchSelectOption,
  splitTel,
  toHiragana
} from '../src/shared/autofill-values.js'
import {
  JEV_MODEL,
  MAX_FIELDS_PER_REQUEST,
  buildFillPlan,
  buildJevRequests,
  expandGroup,
  isConfirmField,
  isExcluded,
  refineOption,
  normalizeCollected,
  readJevAnswers,
  resolveConflicts,
  ruleOption
} from '../src/shared/autofill-match.js'
import { decryptEnvelope, encryptEnvelope } from '../src/shared/auth-vault-crypto.js'
import { sanitizeDetail } from '../src/shared/log-redact.js'

const PROFILE = normalizeProfile({
  family_name: '山田',
  given_name: '太郎',
  family_name_kana: 'やまだ',
  given_name_kana: 'タロウ',
  family_name_roman: 'Yamada',
  given_name_roman: 'Taro',
  email: 'taro@example.com',
  tel: '090-1234-5678',
  postal_code: '１０００００１',
  address_level1: '東京都',
  address_level2: '千代田区',
  address_line1: '千代田1-1',
  address_line2: 'サンプルタワー 1701',
  birthday: '1988-07-14',
  gender: 'male',
  organization: '株式会社サンプル',
  department: '開発部',
  job_title: '代表',
  organization_url: 'https://example.com'
})
const VALUES = deriveValues(PROFILE)
/** プロフィールの値（**Jev に送る body に 1 つも出てはいけない**）。 */
const SECRET_VALUES = Object.values(PROFILE).filter((value) => value.length >= 2)

const el = (overrides = {}) => ({
  tag: 'input',
  type: 'text',
  placeholder: '',
  maxLength: null,
  ...overrides
})

/* ---------------- スキーマ ---------------- */

test('normalizeProfile: 知らないキー・文字列以外・壊れた日付と性別を落とす', () => {
  const profile = normalizeProfile({
    family_name: ' 山田 ',
    unknown: 'x',
    tel: 12345,
    birthday: '1988-02-30',
    gender: 'robot',
    email: 'a'.repeat(201)
  })
  assert.deepEqual(Object.keys(profile).sort(), [...PROFILE_KEYS].sort())
  assert.equal(profile['family_name'], '山田')
  assert.equal(profile['tel'], '')
  assert.equal(profile['birthday'], '')
  assert.equal(profile['gender'], '')
  assert.equal(profile['email'], '')
  assert.equal(countFilled(profile), 1)
})

test('normalizeVaultContent: キー入りの新しい形と、プロフィールだけの最初の形の両方を読む', () => {
  const wrapped = normalizeVaultContent({ profile: { family_name: '山田' }, jevKey: ' apikey_x ' })
  assert.equal(wrapped.profile['family_name'], '山田')
  assert.equal(wrapped.jevKey, 'apikey_x')
  const legacy = normalizeVaultContent({ family_name: '山田' })
  assert.equal(legacy.profile['family_name'], '山田', '最初の形（プロフィールそのもの）も読める')
  assert.equal(legacy.jevKey, null)
  assert.equal(
    normalizeVaultContent({ profile: {}, jevKey: 'x'.repeat(513) }).jevKey,
    null,
    '長すぎるキーは捨てる'
  )
  assert.equal(normalizeVaultContent({ profile: {}, jevKey: 42 }).jevKey, null)
  assert.equal(normalizeVaultContent(null).jevKey, null)
})

test('暗号の封筒: profile を入れて戻せる / パスフレーズ違いは bad-passphrase / 平文が外に出ない', async () => {
  const meta = { count: countFilled(PROFILE), savedAt: 1_756_000_000_000, host: 'mac', appVersion: '1.2.17' }
  const file = await encryptEnvelope(PROFILE, 'profile', 'correct horse battery', meta)
  const ok = await decryptEnvelope(file, 'profile', 'correct horse battery')
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok && ok.payload, PROFILE)
  const bad = await decryptEnvelope(file, 'profile', 'wrong passphrase')
  assert.deepEqual(bad, { ok: false, reason: 'bad-passphrase' })
  const whole = JSON.stringify(file)
  for (const value of SECRET_VALUES) assert.equal(whole.includes(value), false, value)
})

/* ---------------- 値の導出 ---------------- */

test('deriveValues: 一括・分割・カナ・住所一括を作る', () => {
  assert.equal(VALUES['full_name'], '山田 太郎', '既定は半角空白')
  assert.equal(VALUES['family_name_kana'], 'ヤマダ', 'ひらがなで入れてもカタカナにそろえる')
  assert.equal(VALUES['full_name_kana'], 'ヤマダ タロウ')
  assert.equal(VALUES['full_name_roman'], 'Taro Yamada')
  assert.deepEqual([VALUES['tel_part1'], VALUES['tel_part2'], VALUES['tel_part3']], ['090', '1234', '5678'])
  assert.equal(VALUES['postal_code'], '100-0001', '全角・ハイフン無しでも整える')
  assert.deepEqual([VALUES['postal_code_part1'], VALUES['postal_code_part2']], ['100', '0001'])
  assert.equal(VALUES['address_city_line1'], '千代田区千代田1-1')
  assert.equal(VALUES['address_full'], '東京都千代田区千代田1-1 サンプルタワー 1701')
  assert.deepEqual(
    [VALUES['birthday_year'], VALUES['birthday_month'], VALUES['birthday_day']],
    ['1988', '7', '14']
  )
})

test('deriveValues: 片方しか無い氏名から一括を作らない / 空の項目を出さない', () => {
  const values = deriveValues(normalizeProfile({ family_name: '山田' }))
  assert.equal(values['full_name'], undefined)
  assert.equal(values['tel'], undefined)
  assert.deepEqual(Object.keys(values), ['family_name'])
})

test('splitTel: 区切りを信じる / 数字だけなら桁で割る', () => {
  assert.deepEqual(splitTel('03-1234-5678'), ['03', '1234', '5678'])
  assert.deepEqual(splitTel('0312345678'), ['03', '1234', '5678'])
  assert.deepEqual(splitTel('0451234567'), ['045', '123', '4567'])
  assert.deepEqual(splitTel('０９０（１２３４）５６７８'), ['090', '1234', '5678'])
  assert.equal(splitTel('123'), null)
})

test('formatForElement: 欄の手がかりで書式を変える', () => {
  assert.equal(formatForElement('tel', VALUES, el({ placeholder: '09012345678' }), '電話番号'), '09012345678')
  assert.equal(formatForElement('tel', VALUES, el({ placeholder: '090XXXXXXXX' }), '電話番号'), '09012345678')
  assert.equal(formatForElement('tel', VALUES, el(), '携帯電話（ハイフンなし）'), '09012345678')
  assert.equal(formatForElement('tel', VALUES, el({ maxLength: 11 }), '電話番号'), '09012345678')
  assert.equal(formatForElement('tel', VALUES, el(), '電話番号'), '090-1234-5678')
  assert.equal(formatForElement('postal_code', VALUES, el({ maxLength: 7 }), '郵便番号'), '1000001')
  assert.equal(formatForElement('postal_code', VALUES, el(), '郵便番号'), '100-0001')
  assert.equal(formatForElement('birthday', VALUES, el({ type: 'date' }), '生年月日'), '1988-07-14')
  assert.equal(formatForElement('birthday', VALUES, el({ placeholder: '2000年1月1日' }), ''), '1988年7月14日')
  assert.equal(formatForElement('birthday', VALUES, el(), '生年月日'), '1988/07/14')
  assert.equal(formatForElement('birthday_month', VALUES, el({ placeholder: '01' }), ''), '07')
  assert.equal(formatForElement('family_name_kana', VALUES, el(), 'ふりがな（せい）'), 'やまだ')
  assert.equal(formatForElement('family_name_kana', VALUES, el({ placeholder: 'やまだ' }), 'セイ'), 'やまだ')
  assert.equal(formatForElement('family_name_kana', VALUES, el(), 'フリガナ'), 'ヤマダ')
  assert.equal(formatForElement('gender', VALUES, el(), '性別'), '男性')
  assert.equal(formatForElement('job_title', {}, el(), '役職'), null)
  assert.equal(toHiragana('ヤマダ　タロウ'), 'やまだ　たろう')
  // 姓名の区切り: 既定は半角、全角を求める欄だけ全角
  assert.equal(formatForElement('full_name', VALUES, el(), 'お名前'), '山田 太郎')
  assert.equal(formatForElement('full_name', VALUES, el({ placeholder: '山田 太郎' }), '氏名'), '山田 太郎')
  assert.equal(formatForElement('full_name', VALUES, el(), '氏名（全角）'), '山田　太郎')
  assert.equal(
    formatForElement('full_name', VALUES, el({ placeholder: '例）山田　太郎' }), '氏名'),
    '山田　太郎'
  )
  assert.equal(formatForElement('full_name_kana', VALUES, el(), 'フリガナ'), 'ヤマダ タロウ')
  assert.equal(formatForElement('full_name_kana', VALUES, el(), 'フリガナ（全角カナ）'), 'ヤマダ　タロウ')
  assert.equal(formatForElement('full_name_kana', VALUES, el(), 'ふりがな'), 'やまだ たろう')
  assert.equal(
    formatForElement('full_name_kana', VALUES, el({ placeholder: 'やまだ　たろう' }), 'よみ'),
    'やまだ　たろう'
  )
})

test('matchSelectOption: 完全一致を優先し、部分一致は 1 つに決まるときだけ', () => {
  const prefs = [
    { value: '', text: '選択してください' },
    { value: '13', text: '東京都' },
    { value: '14', text: '神奈川県' }
  ]
  assert.equal(matchSelectOption(prefs, 'address_level1', '神奈川県'), 2)
  assert.equal(matchSelectOption([{ value: 'k', text: '神奈川' }], 'address_level1', '神奈川県'), 0)
  const days = [
    { value: '', text: '--' },
    ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), text: `${i + 1}日` }))
  ]
  assert.equal(matchSelectOption(days, 'birthday_day', '1'), 1, '「1」が「10」「11」…に部分一致しない')
  assert.equal(matchSelectOption(days, 'birthday_day', '21'), 21)
  const padded = [
    { value: '', text: '' },
    { value: '09', text: '09' }
  ]
  assert.equal(matchSelectOption(padded, 'birthday_month', '9'), 1)
  const years = [
    { value: '', text: '年' },
    { value: '1988', text: '1988年（昭和63年）' }
  ]
  assert.equal(matchSelectOption(years, 'birthday_year', '1988'), 1)
  const genders = [
    { value: '', text: '選択' },
    { value: '1', text: '男性' },
    { value: '2', text: '女性' }
  ]
  assert.equal(matchSelectOption(genders, 'gender', 'female'), 2)
  assert.equal(matchSelectOption(genders, 'gender', ''), -1)
})

/* ---------------- ルールと Jev ---------------- */

const field = (overrides = {}) => ({
  label: '',
  name: '',
  idAttr: '',
  placeholder: '',
  autocomplete: '',
  nearby: '',
  section: '',
  type: 'text',
  tag: 'input',
  members: [0],
  optionsSample: [],
  ...overrides
})

test('ruleOption: autocomplete と type で決める / カナの見出しならカナに寄せる', () => {
  assert.equal(ruleOption(field({ autocomplete: 'section-a shipping postal-code' })), 'postal_code')
  assert.equal(
    ruleOption(field({ autocomplete: 'family-name', label: 'フリガナ（セイ）' })),
    'family_name_kana'
  )
  assert.equal(ruleOption(field({ autocomplete: 'name', label: 'お名前（ローマ字）' })), 'full_name_roman')
  assert.equal(ruleOption(field({ type: 'email' })), 'email')
  assert.equal(ruleOption(field({ type: 'tel' })), 'tel')
  assert.equal(
    ruleOption(field({ type: 'tel', members: [0, 1, 2] })),
    null,
    '分割された tel はルールで決めない'
  )
  assert.equal(ruleOption(field({ autocomplete: 'tel-area-code', members: [0, 1, 2] })), 'tel')
  assert.equal(ruleOption(field({ autocomplete: 'off' })), null)
  assert.equal(ruleOption(field({ nearby: '〒' })), 'postal_code', '「〒」1 文字だけの欄')
  assert.equal(ruleOption(field({ nearby: '〒', members: [0, 1] })), 'postal_code', '「〒」の後に 2 枠')
  assert.equal(ruleOption(field({ autocomplete: 'url' })), null)
})

test('ruleOption: 実サイト調査で見つけた組み方（type=tel の郵便番号・かなの例・3 桁 / 4 桁の 2 分割）', () => {
  assert.equal(ruleOption(field({ type: 'tel', label: '郵便番号（半角数字）' })), 'postal_code')
  assert.equal(ruleOption(field({ type: 'tel', label: '電話番号' })), 'tel')
  assert.equal(
    ruleOption(field({ autocomplete: 'family-name', label: '名前の姓', placeholder: '例：みらい' })),
    'family_name_kana'
  )
  assert.equal(
    ruleOption(field({ autocomplete: 'family-name', label: '名前の姓', placeholder: '例：山田' })),
    'family_name'
  )
  const els = [el({ maxLength: 3 }), el({ maxLength: 4 }), el({ maxLength: 4 }), el({ maxLength: 4 })]
  assert.equal(ruleOption(field({ members: [0, 1] }), els), 'postal_code')
  assert.equal(ruleOption(field({ members: [1, 2] }), els), null, '4 桁 / 4 桁は郵便番号と決めない')
})

test('refineOption / expandGroup: 番地と建物をまとめた欄・「ご住所」「建物名称」の 2 枠', () => {
  assert.equal(refineOption('address_line2', field({ label: '番地・マンション名' })), 'address_line1_2')
  assert.equal(refineOption('address_line1', field({ label: '番地以降' })), 'address_line1_2')
  assert.equal(refineOption('address_line1', field({ label: '町名番地' })), 'address_line1')
  assert.equal(refineOption('tel', field({ label: '番地・マンション名' })), 'tel')
  assert.equal(
    refineOption('address_line1', field({ nearby: '町名番地・建物名', autocomplete: 'address-line1' })),
    'address_line1',
    'address-line1 と明示された欄は番地だけ'
  )
  assert.deepEqual(expandGroup('address_full', 2), ['address_without_building', 'address_line2'])
  assert.equal(VALUES['address_line1_2'], '千代田1-1 サンプルタワー 1701')
  assert.equal(VALUES['address_without_building'], '東京都千代田区千代田1-1')
})

test('isExcluded / isConfirmField: FAX は入れない・確認用は 2 か所目にも入れる', () => {
  assert.equal(isExcluded(field({ label: 'FAX番号' })), true)
  assert.equal(isExcluded(field({ name: 'fax_01' })), true)
  assert.equal(isExcluded(field({ label: '電話番号' })), false)
  assert.equal(isConfirmField(field({ label: '携帯電話番号 確認用' })), true)
  assert.equal(isConfirmField(field({ label: '電話番号' })), false)
})

test('expandGroup: 並び順で割り当てる / 決められない組は null', () => {
  assert.deepEqual(expandGroup('tel', 3), ['tel_part1', 'tel_part2', 'tel_part3'])
  assert.deepEqual(expandGroup('full_name', 2), ['family_name', 'given_name'])
  assert.deepEqual(expandGroup('email', 2), ['email', 'email'])
  assert.equal(expandGroup('tel', 2), null)
  assert.equal(expandGroup('organization', 2), null)
})

function collectedOf(fields, elements) {
  return normalizeCollected({ pageTitle: 'お問い合わせ', elements, fields })
}

test('buildJevRequests: 欄の手がかりだけを送り、プロフィールの値を含まない', () => {
  const collected = collectedOf(
    [
      { label: 'フリガナ（セイ）', name: 'kana1', placeholder: 'ヤマダ', members: [0] },
      { nearby: '郵便番号', section: 'ご住所', members: [5] },
      { label: '電話番号', members: [1, 2, 3] },
      { label: '都道府県', members: [4], optionsSample: ['北海道', '青森県'] }
    ],
    [el(), el(), el(), el(), { tag: 'select', type: '', placeholder: '', maxLength: null, options: [] }, el()]
  )
  const [chunk] = buildJevRequests(collected, [0, 1, 2, 3])
  assert.equal(chunk.body.model, JEV_MODEL)
  const questions = chunk.body.questions
  assert.deepEqual(Object.keys(questions).sort(), ['f0', 'f1', 'f2', 'f3', 'own0', 'own1', 'own2', 'own3'])
  assert.deepEqual(questions.f1.instructions.field, {
    nearby_text: '郵便番号',
    section: 'ご住所',
    type: 'text'
  })
  assert.equal(questions.f2.instructions.field.split_into_boxes, 3)
  assert.deepEqual(questions.f3.instructions.field.options_sample, ['北海道', '青森県'])
  assert.equal(questions.f0.type, 'choice')
  assert.equal(questions.own0.type, 'noul')
  assert.ok('none' in questions.f0.criteria)
  const body = JSON.stringify(chunk.body)
  for (const value of SECRET_VALUES) assert.equal(body.includes(value), false, `値が送られている: ${value}`)
})

test('buildJevRequests: 上限を超えたら分けて送る', () => {
  const count = MAX_FIELDS_PER_REQUEST + 5
  const collected = collectedOf(
    Array.from({ length: count }, (_, i) => ({ label: `欄${i}`, members: [i] })),
    Array.from({ length: count }, () => el())
  )
  const chunks = buildJevRequests(
    collected,
    collected.fields.map((_, i) => i)
  )
  assert.deepEqual(
    chunks.map((chunk) => chunk.indexes.length),
    [MAX_FIELDS_PER_REQUEST, 5]
  )
})

test('readJevAnswers: none・閾値未満・本人でない・形の違う答えは入れない', () => {
  const answers = {
    f0: { type: 'choice', choice: 'full_name', confidence: 0.9 },
    own0: { type: 'noul', noul: 0.9 },
    f1: { type: 'choice', choice: 'full_name', confidence: 0.9 },
    own1: { type: 'noul', noul: 0.05 },
    f2: { type: 'choice', choice: 'tel', confidence: 0.3 },
    own2: { type: 'noul', noul: 0.9 },
    f3: { type: 'choice', choice: 'none', confidence: 0.99 },
    own3: { type: 'noul', noul: 0.1 },
    f4: { type: 'choice', choice: 'password', confidence: 0.99 },
    own4: { type: 'noul', noul: 0.9 }
  }
  const { decisions } = readJevAnswers(answers, [0, 1, 2, 3, 4, 5])
  assert.deepEqual([...decisions.keys()], [0])
  assert.equal(readJevAnswers(null, [0]).decisions.size, 0)
})

test('readJevAnswers: 2 枠以上の欄では姓・名・一括を同じ答えとみなして確率を合算する', () => {
  // 実 Jev の答え（2026-09-27、姓 / 名の 2 枠）: family_name 0.53 / full_name 0.47、確信度 0.49
  const answers = {
    f0: { choice: 'family_name', confidence: 0.49, probabilities: { family_name: 0.53, full_name: 0.47 } },
    own0: { noul: 0.95 },
    f1: {
      choice: 'family_name_kana',
      confidence: 0.75,
      probabilities: { family_name_kana: 0.77, full_name_kana: 0.21 }
    },
    own1: { noul: 0.95 },
    f2: { choice: 'family_name', confidence: 0.9, probabilities: { family_name: 0.95 } },
    own2: { noul: 0.95 }
  }
  const { decisions } = readJevAnswers(answers, [0, 1, 2], new Set([0, 1]))
  assert.equal(decisions.get(0)?.option, 'full_name')
  assert.ok((decisions.get(0)?.confidence ?? 0) >= 0.99)
  assert.equal(decisions.get(1)?.option, 'full_name_kana')
  assert.equal(decisions.get(2)?.option, 'family_name', '1 枠の欄は寄せない')
  assert.equal(readJevAnswers(answers, [0], new Set()).decisions.size, 0, 'グループでなければ 0.49 は足切り')
})

test('resolveConflicts: 確認用の欄は取り合いに加わらず、そのまま入れる', () => {
  const decisions = new Map([
    [0, { option: 'tel', confidence: 1, source: 'rule' }],
    [1, { option: 'tel', confidence: 1, source: 'rule' }]
  ])
  assert.deepEqual([...resolveConflicts(decisions, new Set([1])).keys()], [0, 1])
  assert.deepEqual([...resolveConflicts(decisions).keys()], [0])
})

test('resolveConflicts: 同じ項目は確信度の高い 1 か所に / email は重複可', () => {
  const decisions = new Map([
    [0, { option: 'full_name', confidence: 0.6, source: 'jev' }],
    [1, { option: 'full_name', confidence: 0.9, source: 'jev' }],
    [2, { option: 'email', confidence: 1, source: 'rule' }],
    [3, { option: 'email', confidence: 0.8, source: 'jev' }],
    [4, { option: 'tel', confidence: 1, source: 'rule' }],
    [5, { option: 'tel', confidence: 0.99, source: 'jev' }]
  ])
  assert.deepEqual([...resolveConflicts(decisions).keys()].sort(), [1, 2, 3, 4])
})

test('buildFillPlan: 分割グループは全部埋まるときだけ / select は照合 / 書式を当てる', () => {
  const collected = collectedOf(
    [
      { label: '電話番号', members: [0, 1, 2] },
      { label: '都道府県', members: [3] },
      { label: '生年月日', members: [4, 5] },
      { label: '会社名', members: [6] }
    ],
    [
      el({ maxLength: 4 }),
      el({ maxLength: 4 }),
      el({ maxLength: 4 }),
      {
        tag: 'select',
        type: '',
        placeholder: '',
        maxLength: null,
        options: [
          { value: '', text: '選択' },
          { value: '13', text: '東京都' }
        ]
      },
      el(),
      el(),
      el()
    ]
  )
  const decisions = new Map([
    [0, { option: 'tel', confidence: 0.9, source: 'jev' }],
    [1, { option: 'address_level1', confidence: 1, source: 'rule' }],
    [2, { option: 'birthday', confidence: 0.9, source: 'jev' }],
    [3, { option: 'organization', confidence: 0.9, source: 'jev' }]
  ])
  const plan = buildFillPlan(collected, decisions, VALUES)
  assert.deepEqual(plan.steps, [
    { element: 0, value: '090' },
    { element: 1, value: '1234' },
    { element: 2, value: '5678' },
    { element: 3, optionIndex: 1 },
    { element: 6, value: '株式会社サンプル' }
  ])
  assert.deepEqual(plan.filledFields, { rule: 1, jev: 2 })
  assert.equal(plan.skipped, 1, '2 つに割れた生年月日は決められないので入れない')
})

test('buildFillPlan: maxlength に収まらない値は入れない（並び違いの分割グループはグループごと）', () => {
  // 月 / 日 / 年の順に並んだ 3 分割。並び順で年を先頭に入れようとすると maxlength 2 に収まらない
  const collected = collectedOf(
    [
      { label: '生年月日', members: [0, 1, 2] },
      { label: '郵便番号', members: [3] }
    ],
    [el({ maxLength: 2 }), el({ maxLength: 2 }), el({ maxLength: 4 }), el({ maxLength: 5 })]
  )
  const decisions = new Map([
    [0, { option: 'birthday', confidence: 0.9, source: 'jev' }],
    [1, { option: 'postal_code', confidence: 1, source: 'rule' }]
  ])
  const plan = buildFillPlan(collected, decisions, VALUES)
  assert.deepEqual(plan.steps, [])
  assert.equal(plan.skipped, 2)
})

test('normalizeCollected: 形の違う戻りは null / 範囲外の要素番号は捨てる', () => {
  assert.equal(normalizeCollected(null), null)
  assert.equal(normalizeCollected({ elements: [{ tag: 'script' }], fields: [] }), null)
  const collected = normalizeCollected({
    elements: [el()],
    fields: [{ label: 'a', members: [0, 9] }, { members: [5] }]
  })
  assert.deepEqual(
    collected.fields.map((f) => f.members),
    [[0]]
  )
})

test('自動入力のログは sanitizeDetail を素通りする（[deep] / [redacted] / 切り詰めが出ない）', () => {
  const detail = {
    ok: true,
    fields: 12,
    rule: 3,
    jev: 7,
    left: 2,
    filled: 11,
    jevMs: 480,
    jevError: 'http-529',
    reason: 'no-fields'
  }
  const after = JSON.stringify(sanitizeDetail({ ...detail }))
  assert.equal(after, JSON.stringify(detail))
})
