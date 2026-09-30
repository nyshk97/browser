// @ts-check
/**
 * 入力欄 → プロフィールのどの項目か、を決める。
 *
 * 1. `autocomplete` 属性・`type` で決まる欄はここで決める（Jev に聞かない）
 * 2. 残りを Jev に聞く。**送るのは欄の手がかりと項目名・説明だけで、値は送らない**
 *    （`buildJevRequests` は値を引数に取らない。値が混ざる経路を型の上で作らない）
 * 3. 答えを閾値で足切りし、同じ項目の取り合いを解いて、入力欄ごとの値に落とす
 *
 * Jev の書き方は Phase 1 の試し撃ちで決めた（`docs/plans/2026-09-27-2042-form-autofill-jev-impl.md`）:
 * - 欄の手がかりは**質問の `instructions.field` に直接入れる**。`state.fields[i]` で指すと後ろの欄ほど崩れた
 * - 分割された欄（電話・郵便番号・生年月日）は**グループで 1 問**。並び順の判定は Jev が苦手
 * - 「誰の情報か」は**別の noul で聞く**（紹介者・子ども・緊急連絡先を本人の値で埋めないため）
 * - 説明は英語 + 日本語の言い回しの例（日本語だけの判定は精度が落ちる）
 *
 * 純粋関数だけを置く（`scripts/autofill.test.mjs` から直接テストする）。
 */
import { DATE_KEYS, formatForElement, matchSelectOption } from './autofill-values.js'
import { PROFILE_FIELDS } from './autofill-schema.js'

/** 伏せる項目（身分証の番号。`ProfileField.secret`）。Claude のウィンドウで入れた値を read_page 等から伏せる。 */
const SECRET_KEYS = new Set(PROFILE_FIELDS.filter((field) => field.secret === true).map((field) => field.key))

/** Jev のモデル。**alias を使わない**（閾値を合わせた版から黙って中身が変わるため）。 */
export const JEV_MODEL = 'jev-1.13.0'

/** これ未満の choice は入れない（Phase 1 で決めた初期値）。 */
export const CHOICE_THRESHOLD = 0.5

/** これ未満の本人性は入れない（Phase 1 で決めた初期値）。 */
export const OWN_THRESHOLD = 0.5

/**
 * 身分証の項目（番号・期限）の choice の足切り。**ほかの項目より厳しくする**
 * （間違った欄に入ったときの影響が大きい。迷ったら空欄のまま残す）。
 * 値は plan `2026-09-29-0934-kypr-identity-autofill.md` の Phase 1（実キーの試し撃ち）で決める。
 */
export const DOCUMENT_THRESHOLD = 0.8

/** 1 リクエストの欄数の上限。欄 1 つ ≒ 1.5k トークン（身分証の候補を足した後の見込み）で、1 リクエスト 64k まで。 */
export const MAX_FIELDS_PER_REQUEST = 32

/** 1 回の自動入力で扱う欄の上限（巨大なフォームで Jev を何十回も叩かない）。 */
export const MAX_FIELDS = 120

/**
 * Jev の選択肢。`[英語の説明, 日本語の言い回しの例]`。
 * 表の出どころは plan の「選択肢の説明の最終版」（Phase 1 で 33/37 を出した形）。
 *
 * @type {Record<string, [string, string | null]>}
 */
export const JEV_OPTIONS = {
  full_name: ['Full name (family name and given name together) in kanji', '氏名, お名前, 名前, ご担当者名'],
  family_name: ['Family name only (surname) in kanji', '姓, 氏, 苗字'],
  given_name: ['Given name only (first name) in kanji', '名, 下の名前'],
  full_name_kana: [
    'Full name reading in katakana or hiragana, family and given together',
    'フリガナ, ふりがな, カナ氏名, お名前（カナ）'
  ],
  family_name_kana: ['Family name reading only, in katakana or hiragana', 'セイ, せい, 姓（フリガナ）'],
  given_name_kana: ['Given name reading only, in katakana or hiragana', 'メイ, めい, 名（フリガナ）'],
  full_name_roman: ['Full name in Latin alphabet (romaji)', 'ローマ字, 英字氏名, Name'],
  email: ['Email address (also use for a "confirm email" field)', 'メールアドレス, E-mail, メール（確認用）'],
  tel: [
    'Phone number (the whole number, even if the form splits it into several boxes)',
    '電話番号, TEL, 携帯電話, 連絡先電話番号'
  ],
  postal_code: [
    'Postal code (the whole code, even if the form splits it into several boxes)',
    '郵便番号, 〒'
  ],
  address_level1: ['Prefecture only', '都道府県'],
  address_level2: ['City, ward, town or village only', '市区町村'],
  address_line1: [
    'Street address after the city: town name, block and house number',
    '番地, 町名番地, 丁目・番地'
  ],
  address_line2: ['Building name, floor and room number', '建物名, マンション名, 部屋番号, ビル名'],
  address_line1_2: [
    'Street address and building name together in one field (after the city)',
    '番地・建物名, 番地・マンション名, 番地以降, 町名番地・建物名'
  ],
  address_city_line1: [
    'City / ward and street address together in one field, without the prefecture and without the building',
    '市区町村番地, 市区町村・番地, 住所（都道府県以降）'
  ],
  address_full: [
    'Whole address after the postal code in one field (prefecture to building)',
    '住所, ご住所, 所在地'
  ],
  birthday: [
    'Date of birth (the whole date, even if the form splits it into year / month / day)',
    '生年月日'
  ],
  gender: ['Gender / sex', '性別'],
  organization: ['Company or organization name', '会社名, 貴社名, 法人名, 団体名, 屋号'],
  department: ['Department or division within the company', '部署名, 所属'],
  job_title: ['Job title or position', '役職'],
  organization_url: ['Company website URL', '会社URL, ホームページ, WebサイトURL'],
  age: ['Age in years (a number)', '年齢, 満年齢, 歳'],
  country: [
    "Country of the filler's address (not a nationality or issuing country of a document)",
    '国, 国名, Country'
  ],
  passport_number: ["The filler's passport number", '旅券番号, パスポート番号, Passport No.'],
  passport_issue_date: [
    'Issue date of the passport (not the expiry date; the whole date, even if the form splits it into year / month / day). Only when the label or the surrounding fields show it is the passport',
    'パスポートの発行日, 旅券の発行年月日'
  ],
  passport_expiry: [
    'Expiry date of the passport (not the issue date; the whole date, even if the form splits it into year / month / day)',
    'パスポートの有効期限, 旅券の有効期間満了日'
  ],
  license_number: [
    "The filler's driver's license number (12 digits in Japan)",
    '運転免許証番号, 免許証番号, 免許番号'
  ],
  license_issue_date: [
    "Issue date of the driver's license (not the expiry date; the whole date, even if the form splits it into year / month / day). Only when the label or the surrounding fields show it is the driver's license",
    '免許証の交付日, 運転免許証の交付年月日'
  ],
  license_expiry: [
    "Expiry date of the driver's license (not the issue date; the whole date, even if the form splits it into year / month / day)",
    '免許証の有効期限, 運転免許証の有効期間'
  ],
  insurance_symbol: [
    'Health insurance card symbol (kigo): the short code printed before the insured number',
    '記号, 被保険者記号, 保険証の記号'
  ],
  insurance_number: [
    'Health insurance card number (bango) of the insured person (not the insurer number)',
    '番号, 被保険者番号, 保険証の番号'
  ],
  insurance_branch: ['Health insurance card branch number (edaban), usually 2 digits', '枝番'],
  insurer_number: ['Insurer number printed on the health insurance card (6 or 8 digits)', '保険者番号'],
  document_expiry: [
    "Expiry date of an identity document (passport or driver's license) when the label does not say which document. Not a credit card expiry and not an issue date",
    '有効期限, 有効期間'
  ],
  none: [
    'None of the profile items fits: free text such as inquiry body, subject, number of employees, how you found us, coupon codes, passwords, membership / reservation / order / employee numbers, My Number (individual number), credit card number / expiry / security code, an issue date that does not say which document, issuing country, license color, or anything else',
    null
  ]
}

/**
 * 身分証の項目（`DOCUMENT_THRESHOLD` で足切りする）と、その書類。
 * @type {Record<string, 'passport' | 'license' | 'insurance'>}
 */
export const DOCUMENT_OPTIONS = {
  passport_number: 'passport',
  passport_expiry: 'passport',
  passport_issue_date: 'passport',
  license_number: 'license',
  license_expiry: 'license',
  license_issue_date: 'license',
  insurance_symbol: 'insurance',
  insurance_number: 'insurance',
  insurance_branch: 'insurance',
  insurer_number: 'insurance',
  document_expiry: 'passport' // 書類は `resolveDocumentExpiry` が決め直す（ここは足切りのためだけ）
}

/**
 * 書類の番号・発行日の選択肢 → その書類の期限（期限の無い書類は null）。
 * 発行日も引く（「番号 → 発行日 → 有効期限」で、発行日が決まるとさかのぼりがそこで止まるため）。
 * @type {Record<string, string | null>}
 */
const DOCUMENT_EXPIRY = {
  passport_number: 'passport_expiry',
  passport_issue_date: 'passport_expiry',
  license_number: 'license_expiry',
  license_issue_date: 'license_expiry',
  insurance_symbol: null,
  insurance_number: null,
  insurance_branch: null,
  insurer_number: null
}

/** 日付の項目（`YYYY-MM-DD`。年 / 月 / 日に分けられる）。正は `PROFILE_FIELDS` の `type: 'date'`。 */
export const DATE_OPTIONS = DATE_KEYS

/** @param {string} option */
function thresholdFor(option) {
  return option in DOCUMENT_OPTIONS ? DOCUMENT_THRESHOLD : CHOICE_THRESHOLD
}

const CHOICE_QUESTION = 'Which profile item should be entered into this form `field`?'
const OWN_QUESTION =
  "Does this form `field` ask for the form filler's OWN personal or own-company information?"
const OWN_CRITERIA = {
  true: "The filler's own name, contact, address, birthday, gender, the filler's own company / department / title / website, or the filler's own passport / driver's license / health insurance card numbers, issue dates and expiry dates",
  false:
    "Information about someone or something else (a referrer, child, family member, fellow traveler's passport, emergency contact, workplace or delivery address that differs from home), or not personal information at all (inquiry text, budget, passwords, membership / reservation / order / employee numbers)"
}

/** 2 か所以上に入れてよい項目（確認用メールアドレス）。それ以外は 1 か所だけ。 */
const MULTI_USE = new Set(['email'])

/**
 * `autocomplete` のトークン → 選択肢。
 * `section-*` / `shipping` / `billing` / `home` / `work` などの修飾は最後のトークンだけ見るので無視される。
 * `url` は「会社の URL」とは限らないので載せない。
 *
 * @type {Record<string, string>}
 */
export const AUTOCOMPLETE = {
  name: 'full_name',
  'family-name': 'family_name',
  'given-name': 'given_name',
  email: 'email',
  tel: 'tel',
  'tel-national': 'tel',
  'tel-area-code': 'tel_part1',
  'tel-local-prefix': 'tel_part2',
  'tel-local-suffix': 'tel_part3',
  'postal-code': 'postal_code',
  'address-level1': 'address_level1',
  'address-level2': 'address_level2',
  'address-line1': 'address_line1',
  'street-address': 'address_line1',
  'address-line2': 'address_line2',
  organization: 'organization',
  'organization-title': 'job_title',
  bday: 'birthday',
  'bday-year': 'birthday_year',
  'bday-month': 'birthday_month',
  'bday-day': 'birthday_day',
  sex: 'gender',
  country: 'country',
  'country-name': 'country'
}

/**
 * 分割後の選択肢 → 一括の選択肢（グループはこちらで持つ）。日付は `DATE_OPTIONS` の全部の年 / 月 / 日。
 * @type {Record<string, string>}
 */
const PART_TO_WHOLE = {
  tel_part1: 'tel',
  tel_part2: 'tel',
  tel_part3: 'tel',
  ...Object.fromEntries(
    DATE_OPTIONS.flatMap((option) => ['year', 'month', 'day'].map((part) => [`${option}_${part}`, option]))
  )
}

/**
 * 収集スクリプトの戻り（`autofill-collect-source.js`）。
 *
 * @typedef {object} CollectedField
 * @property {string} label
 * @property {string} name
 * @property {string} idAttr
 * @property {string} placeholder
 * @property {string} autocomplete
 * @property {string} nearby 見出しが無いときの近傍テキスト
 * @property {string} section 欄が属する表の見出し（th / dt。近傍テキストと別のときだけ）
 * @property {string} type
 * @property {'input' | 'select' | 'textarea'} tag
 * @property {number[]} members `elements` の添字（分割グループなら 2〜3 個）
 * @property {string[]} optionsSample select の選択肢の見本（「選択してください」を除く先頭数個）
 *
 * @typedef {object} Collected
 * @property {string} pageTitle
 * @property {string} pageLang `<html lang>`（無ければ空）
 * @property {import('./autofill-values.js').CollectedElement[]} elements
 * @property {CollectedField[]} fields
 */

const MAX_TEXT = 200
const MAX_ELEMENTS = 400
const MAX_OPTIONS = 500

/**
 * 収集スクリプトの戻りを検査する。**ページの中で走った結果なので信用しない**
 * （isolated world でも DOM の中身はページが書いたもの）。長さを切り、形の違うものは捨てる。
 *
 * @param {unknown} raw
 * @returns {Collected | null}
 */
export function normalizeCollected(raw) {
  if (!isRecord(raw) || !Array.isArray(raw['elements']) || !Array.isArray(raw['fields'])) return null
  /** @type {import('./autofill-values.js').CollectedElement[]} */
  const elements = []
  for (const item of raw['elements'].slice(0, MAX_ELEMENTS)) {
    if (!isRecord(item)) return null
    const tag = item['tag']
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return null
    const maxLength = item['maxLength']
    /** @type {import('./autofill-values.js').CollectedElement} */
    const element = {
      tag,
      type: text(item['type']).toLowerCase(),
      placeholder: text(item['placeholder']),
      maxLength:
        typeof maxLength === 'number' && Number.isInteger(maxLength) && maxLength > 0 ? maxLength : null
    }
    if (tag === 'select') {
      const options = Array.isArray(item['options']) ? item['options'] : []
      element.options = options
        .slice(0, MAX_OPTIONS)
        .filter(isRecord)
        .map((option) => ({ value: text(option['value']), text: text(option['text']) }))
    }
    elements.push(element)
  }
  /** @type {CollectedField[]} */
  const fields = []
  for (const item of raw['fields'].slice(0, MAX_FIELDS)) {
    if (!isRecord(item) || !Array.isArray(item['members'])) return null
    const members = item['members'].filter(
      (index) => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < elements.length
    )
    if (members.length === 0 || members.length > 3) continue
    const first = /** @type {import('./autofill-values.js').CollectedElement} */ (elements[members[0]])
    fields.push({
      label: text(item['label']),
      name: text(item['name']),
      idAttr: text(item['idAttr']),
      placeholder: text(item['placeholder']),
      autocomplete: text(item['autocomplete']).toLowerCase(),
      nearby: text(item['nearby']),
      section: text(item['section']),
      type: first.type,
      tag: first.tag,
      members,
      optionsSample: Array.isArray(item['optionsSample']) ? item['optionsSample'].slice(0, 6).map(text) : []
    })
  }
  return {
    pageTitle: text(raw['pageTitle']),
    pageLang: text(raw['pageLang']).toLowerCase(),
    elements,
    fields
  }
}

/** ひらがな・カタカナ・漢字。 */
const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff]/

/**
 * 英語のフォームか。**ページの `lang` が日本語でなく、フォームの見出しに日本語が 1 つも無い**とき。
 * 英語のフォームでは氏名をローマ字、住所を英語の住所にする（`deriveValues` の `english`）。
 * `lang` が無いページは見出しだけで決める（日本語のページの多くは `lang="ja"` を書くが、書かないものもある）。
 *
 * @param {Collected} collected
 */
export function isEnglishForm(collected) {
  if (collected.pageLang.startsWith('ja')) return false
  const texts = collected.fields.flatMap((field) => [
    field.label,
    field.nearby,
    field.section,
    field.placeholder
  ])
  if (texts.every((value) => value === '')) return false
  return !texts.some((value) => JAPANESE_RE.test(value))
}

/**
 * 入れない欄（Jev にも聞かない）。FAX は本物の Jev が電話番号と答えるので、見出しで先に外す。
 *
 * @param {CollectedField} field
 */
export function isExcluded(field) {
  // 「TEL/FAX」のように電話とまとめた欄は外さない（電話の欄がほかに無いフォームで電話が入らなくなる）。
  // 電話かどうかは画面の見出しだけで見る（見出しが「FAX番号」で name が tel2 の古いフォームがある）
  const visible = `${field.label} ${field.nearby}`
  return /fax|ファックス|ファクス/i.test(`${visible} ${field.name}`) && !/電話|tel(?!ex)/i.test(visible)
}

/**
 * 同じ項目を 2 か所に入れてよい欄（「電話番号（確認用）」「メールアドレス 確認」）。
 *
 * @param {CollectedField} field
 */
export function isConfirmField(field) {
  return /確認|再入力|もう一度|confirm/i.test(`${field.label} ${field.nearby} ${field.name}`)
}

/**
 * 例の文字列がかな（ひらがな / カタカナ）だけか（「例：やまだ」の「例：」は外す）。
 * @param {string} placeholder
 */
function isKanaExample(placeholder) {
  const example = placeholder.replace(/^例\s*[)）:：]?\s*/, '').replace(/[\s\u3000]/g, '')
  return example.length > 0 && /^[\u3041-\u3096\u30a1-\u30faー]+$/.test(example)
}

/**
 * ルールで決まる選択肢。決まらなければ null（Jev に回す）。
 *
 * @param {CollectedField} field
 * @param {import('./autofill-values.js').CollectedElement[]} [elements] 分割グループの桁数を見る
 * @returns {string | null}
 */
export function ruleOption(field, elements = []) {
  const tokens = field.autocomplete.split(/\s+/).filter(Boolean)
  const last = tokens[tokens.length - 1] ?? ''
  let option = AUTOCOMPLETE[last] ?? null
  // 「〒」だけが手がかりの欄（`<p>〒 <input></p>`）。1 文字だと Jev は住所全体と取り違える
  if (
    !option &&
    field.members.length <= 2 &&
    [field.label, field.nearby].some((text) => /^〒[\s:：]*$/.test(text))
  ) {
    option = 'postal_code'
  }
  // 3 桁 / 4 桁の 2 分割は郵便番号（本物の Jev は見出しの無い 2 分割を電話と取り違えた）
  if (!option && field.members.length === 2) {
    const lengths = field.members.map((index) => elements[index]?.maxLength ?? null)
    // ただし見出しが郵便番号以外の番号だとはっきりしている欄（「会員番号」など）は除く
    const hints = hintText(field)
    const otherNumber = /番号|コード|id/i.test(hints) && !/郵便|〒|zip|postal/i.test(hints)
    if (lengths[0] === 3 && lengths[1] === 4 && !otherNumber) option = 'postal_code'
  }
  if (!option && field.members.length === 1) {
    if (field.type === 'email') option = 'email'
    // type=tel は郵便番号にも使われる（数字キーボードを出すため）。見出しが郵便番号なら郵便番号
    else if (field.type === 'tel')
      option = /郵便|〒|zip|postal/i.test(hintText(field)) ? 'postal_code' : 'tel'
  }
  if (!option) return null

  // 分割グループは一括の側で持つ（割り当ては `expandGroup`）。収集側はルールのトークンを持つ欄を
  // まとめないので実際のページからは通らない。`normalizeCollected` に手で渡したときの保険
  if (field.members.length > 1) option = PART_TO_WHOLE[option] ?? option

  /*
   * `autocomplete="family-name"` をフリガナ欄に付けているサイトがある。
   * 見出しがカナ / ローマ字を言っているなら、そちらに寄せる（漢字を入れると検査で弾かれる）
   */
  if (option === 'full_name' || option === 'family_name' || option === 'given_name') {
    const hints = hintText(field)
    // 見出しがカナ、または例がかなだけ（「名前の姓」「例：やまだ」）ならふりがなの欄
    if (/カナ|かな|フリガナ|ふりがな|kana/i.test(hints) || isKanaExample(field.placeholder))
      return `${option}_kana`
    if (/ローマ字|英字|romaji|alphabet/i.test(hints)) {
      return option === 'full_name' ? 'full_name_roman' : `${option}_roman`
    }
  }
  return option
}

/**
 * 欄の見出しを見て選択肢を直す。「番地・マンション名」「番地以降」のように**番地と建物をまとめた欄**は、
 * autocomplete が address-line2 でも Jev が address_line1 / 2 と答えても、両方をまとめた値を入れる。
 *
 * @param {string} option
 * @param {CollectedField} field
 * @returns {string}
 */
export function refineOption(option, field) {
  if (option !== 'address_line1' && option !== 'address_line2') return option
  // サイトが番地だけ（address-line1）と明示している欄はそのまま
  if (/(^|\s)address-line1$/.test(field.autocomplete)) return option
  const hints = `${field.label} ${field.nearby}`
  // 「以下」は「全角 30 文字以下」のような字数の注記にも当たるので使わない
  return /番地/.test(hints) && /建物|マンション|ビル|以降/.test(hints) ? 'address_line1_2' : option
}

/**
 * 分割グループの割り当て。**並び順で決める**（Jev は並び順の判定が苦手）。
 * 決められない組み合わせは null（そのグループは空欄のまま）。
 *
 * @param {string} option
 * @param {number} count
 * @returns {string[] | null}
 */
export function expandGroup(option, count) {
  if (count === 1) return [option]
  // 「メールアドレス」「確認用」が同じ行に並ぶと 1 グループに見える。どちらにも同じ値
  if (MULTI_USE.has(option)) return Array.from({ length: count }, () => option)
  if (option === 'tel' && count === 3) return ['tel_part1', 'tel_part2', 'tel_part3']
  if (option === 'postal_code' && count === 2) return ['postal_code_part1', 'postal_code_part2']
  if (DATE_OPTIONS.includes(option) && count === 3)
    return [`${option}_year`, `${option}_month`, `${option}_day`]
  // 保険証の「記号 [ ] - [ ] 番号」
  if ((option === 'insurance_symbol' || option === 'insurance_number') && count === 2)
    return ['insurance_symbol', 'insurance_number']
  if (option === 'full_name' && count === 2) return ['family_name', 'given_name']
  if (option === 'full_name_kana' && count === 2) return ['family_name_kana', 'given_name_kana']
  if (option === 'full_name_roman' && count === 2) return ['family_name_roman', 'given_name_roman']
  // 「ご住所」「建物名称」の 2 枠
  if (option === 'address_full' && count === 2) return ['address_without_building', 'address_line2']
  return null
}

/**
 * Jev に送る欄の手がかり。**値は含めない**（収集は空の欄だけなので、ページの既存値も無い）。
 *
 * @param {CollectedField} field
 */
function fieldHint(field) {
  /** @type {Record<string, unknown>} */
  const hint = {}
  if (field.label) hint['label'] = field.label
  if (field.nearby) hint['nearby_text'] = field.nearby
  if (field.section) hint['section'] = field.section
  if (field.placeholder) hint['placeholder'] = field.placeholder
  if (field.name) hint['name'] = field.name
  if (field.idAttr && field.idAttr !== field.name) hint['id'] = field.idAttr
  hint['type'] = field.tag === 'input' ? field.type || 'text' : field.tag
  if (field.members.length > 1) hint['split_into_boxes'] = field.members.length
  if (field.optionsSample.length > 0) hint['options_sample'] = field.optionsSample
  return hint
}

/** @returns {Record<string, string>} */
function choiceCriteria() {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, [en, ja]] of Object.entries(JEV_OPTIONS))
    out[key] = ja ? `${en}. Japanese labels: ${ja}` : en
  return out
}

/**
 * Jev へのリクエスト本体を作る。**引数に値（プロフィール）を取らない**ので、値が混ざる経路が無い。
 *
 * @param {Collected} collected
 * @param {number[]} fieldIndexes Jev に聞く欄（`collected.fields` の添字）
 * @returns {{ indexes: number[], body: Record<string, unknown> }[]} `MAX_FIELDS_PER_REQUEST` ごとに分けたもの
 */
export function buildJevRequests(collected, fieldIndexes) {
  const criteria = choiceCriteria()
  const state = {
    page_title: collected.pageTitle,
    form_labels: collected.fields.map((field) => field.label || field.nearby || field.placeholder)
  }
  const chunks = []
  for (let start = 0; start < fieldIndexes.length; start += MAX_FIELDS_PER_REQUEST) {
    const indexes = fieldIndexes.slice(start, start + MAX_FIELDS_PER_REQUEST)
    /** @type {Record<string, unknown>} */
    const questions = {}
    for (const index of indexes) {
      const field = /** @type {CollectedField} */ (collected.fields[index])
      const hint = fieldHint(field)
      questions[`f${index}`] = {
        type: 'choice',
        instructions: { field: hint, question: CHOICE_QUESTION },
        criteria
      }
      questions[`own${index}`] = {
        type: 'noul',
        instructions: { field: hint, question: OWN_QUESTION },
        criteria: OWN_CRITERIA
      }
    }
    chunks.push({ indexes, body: { model: JEV_MODEL, state, questions } })
  }
  return chunks
}

/**
 * @typedef {{ option: string, confidence: number, source: 'rule' | 'jev' }} Decision
 */

/**
 * 分割グループ（2 枠以上）で**同じ答えとみなす**選択肢。一括 → [一括, 部分...]。
 *
 * 「姓」「名」の 2 枠に分かれた氏名を聞くと、Jev は 1 枠目の例「姓」に引っ張られて
 * `family_name` と答える（実在の問い合わせフォームで family_name 0.53 / full_name 0.47。
 * 確信度 0.49 で足切りにも掛かった）。グループ全体としてはどれも「氏名」なので、確率を合算して一括に寄せる。
 */
const GROUP_EQUIVALENTS = {
  full_name: ['full_name', 'family_name', 'given_name'],
  full_name_kana: ['full_name_kana', 'family_name_kana', 'given_name_kana'],
  full_name_roman: ['full_name_roman', 'family_name_roman', 'given_name_roman']
}

/**
 * Jev の答えを足切りする。形の違う答えは「決めない」に倒す（例外にしない）。
 *
 * @param {unknown} answers レスポンスの `answers`
 * @param {number[]} indexes このリクエストで聞いた欄
 * @param {Set<number>} [groups] 分割グループ（2 枠以上）の欄。`GROUP_EQUIVALENTS` で答えを寄せる
 * @returns {{ decisions: Map<number, Decision>, rejected: number }}
 */
export function readJevAnswers(answers, indexes, groups = new Set()) {
  /** @type {Map<number, Decision>} */
  const decisions = new Map()
  let rejected = 0
  if (!isRecord(answers)) return { decisions, rejected: indexes.length }
  for (const index of indexes) {
    const choice = answers[`f${index}`]
    const own = answers[`own${index}`]
    if (!isRecord(choice) || !isRecord(own)) {
      rejected += 1
      continue
    }
    let option = choice['choice']
    let confidence = choice['confidence']
    const noul = own['noul']
    const probabilities = choice['probabilities']
    if (groups.has(index) && typeof option === 'string' && isRecord(probabilities)) {
      const answered = option
      for (const [whole, parts] of Object.entries(GROUP_EQUIVALENTS)) {
        if (!parts.includes(answered)) continue
        // 合算した確率を確信度の代わりにする（一括・姓・名に割れた分布は、グループとしては 1 つの答え）
        const sum = parts.reduce((total, part) => {
          const p = probabilities[part]
          return total + (typeof p === 'number' ? p : 0)
        }, 0)
        option = whole
        confidence = Math.max(typeof confidence === 'number' ? confidence : 0, Math.min(sum, 1))
      }
    }
    if (typeof option !== 'string' || !(option in JEV_OPTIONS) || option === 'none') continue
    if (typeof confidence !== 'number' || typeof noul !== 'number') {
      rejected += 1
      continue
    }
    if (confidence < thresholdFor(option) || noul < OWN_THRESHOLD) {
      rejected += 1
      continue
    }
    decisions.set(index, { option, confidence, source: 'jev' })
  }
  return { decisions, rejected }
}

/**
 * 書類を決めて日付を入れる欄か（`resolveDocumentExpiry` がさかのぼるときに**飛ばしてよい**欄）。
 * 「番号 → 発行日 → 有効期限」の発行日のような欄。**日付でない欄（発行国の select など）は飛ばさない**
 * （飛ばすとさかのぼりすぎて、カードの期限に免許証の期限が入る）。
 *
 * @param {CollectedField} field
 * @param {import('./autofill-values.js').CollectedElement[]} elements
 */
export function isDateLikeField(field, elements) {
  if (field.type === 'date') return true
  // name は単語の区切りで見る（`update_flag` や `candidate_id` の date に当てない）
  if (
    /発行日|発行年月日|交付日|交付年月日|取得日|取得年月日|年月日|日付|date/i.test(hintText(field)) ||
    /(^|[^a-z])date([^a-z]|$)/i.test(field.name)
  )
    return true
  // 年 / 月 / 日の 3 つに分かれた欄（select か、4 桁・2 桁・2 桁の入力）
  if (field.members.length === 3) {
    const parts = field.members.map((index) => elements[index])
    const lengths = parts.map((element) => element?.maxLength ?? null)
    if (parts.every((element) => element?.tag === 'select')) return true
    if (lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 2) return true
  }
  return false
}

/**
 * 「有効期限」とだけ書いた欄（`document_expiry`）の書類をコードで決める。**`readJevAnswers` の後・`resolveConflicts` の前**に呼ぶ
 * （`document_expiry` のまま重複を解くと、パスポートと免許証の 2 つの「有効期限」の片方が消える）。
 *
 * 前の欄へさかのぼり、**Jev・ルールで決まらなかった日付の欄だけ飛ばす**。最初に当たった欄が身分証の番号・発行日なら
 * その書類の期限（`passport_expiry` / `license_expiry`）。それ以外（カード番号・ほかの項目・日付でない未決定の欄）や、
 * 期限の無い書類（保険証）なら捨てる（空欄のまま）。
 *
 * @param {Map<number, Decision>} decisions
 * @param {Collected} collected
 * @returns {Map<number, Decision>}
 */
export function resolveDocumentExpiry(decisions, collected) {
  /** @type {Map<number, Decision>} */
  const out = new Map()
  /** `document_expiry` の欄ごとに決めた期限（null = 決まらなかった）。年と月が別の欄に分かれた期限で引き継ぐ */
  /** @type {Map<number, string | null>} */
  const decided = new Map()
  // フォームの上から順に見る（前の `document_expiry` の結果を後ろの欄が引き継ぐため）
  for (const index of [...decisions.keys()].sort((a, b) => a - b)) {
    const decision = /** @type {Decision} */ (decisions.get(index))
    if (decision.option !== 'document_expiry') {
      out.set(index, decision)
      continue
    }
    let expiry = null
    for (let prev = index - 1; prev >= 0; prev -= 1) {
      const before = decisions.get(prev)
      const field = collected.fields[prev]
      if (!field) break
      if (!before) {
        if (isDateLikeField(field, collected.elements)) continue
        break
      }
      // すぐ前も書類名の無い「有効期限」（年と月が別の欄）なら、その欄の結果を引き継ぐ
      expiry =
        before.option === 'document_expiry'
          ? (decided.get(prev) ?? null)
          : (DOCUMENT_EXPIRY[before.option] ?? null)
      break
    }
    decided.set(index, expiry)
    if (expiry) out.set(index, { ...decision, option: expiry })
  }
  return out
}

/**
 * 同じ項目を複数の欄が取り合ったら、確信度の高い 1 か所に絞る（`MULTI_USE` と確認用の欄は除く）。
 * ルールで決めたものは確信度 1 として扱う。
 *
 * @param {Map<number, Decision>} decisions
 * @param {Set<number>} [confirms] 確認用の欄（`isConfirmField`）。取り合いに加わらず、そのまま入れる
 * @returns {Map<number, Decision>}
 */
export function resolveConflicts(decisions, confirms = new Set()) {
  /** @type {Map<string, number>} */
  const best = new Map()
  for (const [index, decision] of decisions) {
    if (MULTI_USE.has(decision.option) || confirms.has(index)) continue
    const current = best.get(decision.option)
    if (current === undefined) {
      best.set(decision.option, index)
      continue
    }
    const held = /** @type {Decision} */ (decisions.get(current))
    // 同点は先に出てくる欄（フォームの上の方）を残す
    if (decision.confidence > held.confidence) best.set(decision.option, index)
  }
  /** @type {Map<number, Decision>} */
  const out = new Map()
  for (const [index, decision] of decisions) {
    if (MULTI_USE.has(decision.option) || confirms.has(index) || best.get(decision.option) === index) {
      out.set(index, decision)
    }
  }
  return out
}

/**
 * @typedef {{ element: number, value: string } | { element: number, optionIndex: number }} FillStep
 */

/**
 * 決まった項目を、入力欄ごとの値に落とす。
 *
 * `secretValues` / `secretElements` は伏せる項目（`ProfileField.secret`）に入れる値と入力要素（Claude のウィンドウ用）。
 *
 * @param {Collected} collected
 * @param {Map<number, Decision>} decisions
 * @param {Record<string, string>} values `deriveValues` の戻り
 * @returns {{ steps: FillStep[], filledFields: { rule: number, jev: number }, documents: number, skipped: number, secretValues: string[], secretElements: number[] }}
 */
export function buildFillPlan(collected, decisions, values) {
  /** @type {FillStep[]} */
  const steps = []
  /** @type {string[]} */
  const secretValues = []
  /** @type {number[]} */
  const secretElements = []
  const filledFields = { rule: 0, jev: 0 }
  let documents = 0
  let skipped = 0
  for (const [index, decision] of decisions) {
    const field = collected.fields[index]
    if (!field) continue
    const parts = expandGroup(decision.option, field.members.length)
    if (!parts) {
      skipped += 1
      continue
    }
    const hints = hintText(field)
    /** @type {FillStep[]} */
    const fieldSteps = []
    const secretsBefore = secretValues.length
    field.members.forEach((elementIndex, position) => {
      const part = /** @type {string} */ (parts[position])
      const element = collected.elements[elementIndex]
      if (!element) return
      if (element.tag === 'select') {
        const optionIndex = matchSelectOption(element.options ?? [], part, values[part] ?? '', values)
        if (optionIndex >= 0) fieldSteps.push({ element: elementIndex, optionIndex })
        return
      }
      const value = formatForElement(part, values, element, hints)
      // **maxlength に収まらない値は入れない**（代入では maxlength が効かず、年が月の欄に入るような
      // 並び違いも黙って通る。分割グループなら 1 つでも収まらなければグループごと入れない）
      if (value === null || (element.maxLength !== null && value.length > element.maxLength)) return
      fieldSteps.push({ element: elementIndex, value })
      if (SECRET_KEYS.has(part)) {
        secretValues.push(value)
        secretElements.push(elementIndex)
      }
    })
    // **グループは全部埋まるときだけ入れる**（電話の 3 つ目だけ空、のような半端を作らない）
    if (fieldSteps.length === 0 || fieldSteps.length !== field.members.length) {
      // 入れないグループの分は伏せる値からも外す
      secretValues.length = secretsBefore
      secretElements.length = secretsBefore
      skipped += 1
      continue
    }
    steps.push(...fieldSteps)
    filledFields[decision.source] += 1
    if (decision.option in DOCUMENT_OPTIONS) documents += 1
  }
  return { steps, filledFields, documents, skipped, secretValues, secretElements }
}

/** @param {CollectedField} field */
function hintText(field) {
  return `${field.label} ${field.nearby} ${field.placeholder}`
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : ''
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
