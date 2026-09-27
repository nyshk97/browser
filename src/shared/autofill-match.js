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
import { formatForElement, matchSelectOption } from './autofill-values.js'

/** Jev のモデル。**alias を使わない**（閾値を合わせた版から黙って中身が変わるため）。 */
export const JEV_MODEL = 'jev-1.13.0'

/** これ未満の choice は入れない（Phase 1 で決めた初期値）。 */
export const CHOICE_THRESHOLD = 0.5

/** これ未満の本人性は入れない（Phase 1 で決めた初期値）。 */
export const OWN_THRESHOLD = 0.5

/** 1 リクエストの欄数の上限。欄 1 つ ≒ 1.15k トークンで、1 リクエスト 64k まで。 */
export const MAX_FIELDS_PER_REQUEST = 40

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
  none: [
    'None of the profile items fits: free text such as inquiry body, subject, age, number of employees, how you found us, coupon codes, passwords, or anything else',
    null
  ]
}

const CHOICE_QUESTION = 'Which profile item should be entered into this form `field`?'
const OWN_QUESTION =
  "Does this form `field` ask for the form filler's OWN personal or own-company information?"
const OWN_CRITERIA = {
  true: "The filler's own name, contact, address, birthday, gender, or the filler's own company / department / title / website",
  false:
    'Information about someone or something else (a referrer, child, family member, emergency contact, workplace or delivery address that differs from home), or not personal information at all (inquiry text, budget, passwords, IDs)'
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
  sex: 'gender'
}

/** 分割後の選択肢 → 一括の選択肢（グループはこちらで持つ）。 */
const PART_TO_WHOLE = {
  tel_part1: 'tel',
  tel_part2: 'tel',
  tel_part3: 'tel',
  birthday_year: 'birthday',
  birthday_month: 'birthday',
  birthday_day: 'birthday'
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
  return { pageTitle: text(raw['pageTitle']), elements, fields }
}

/**
 * ルールで決まる選択肢。決まらなければ null（Jev に回す）。
 *
 * @param {CollectedField} field
 * @returns {string | null}
 */
export function ruleOption(field) {
  const tokens = field.autocomplete.split(/\s+/).filter(Boolean)
  const last = tokens[tokens.length - 1] ?? ''
  let option = AUTOCOMPLETE[last] ?? null
  if (!option && field.members.length === 1) {
    if (field.type === 'email') option = 'email'
    else if (field.type === 'tel') option = 'tel'
  }
  if (!option) return null

  // 分割グループは一括の側で持つ（割り当ては `expandGroup`）。収集側はルールのトークンを持つ欄を
  // まとめないので実際のページからは通らない。`normalizeCollected` に手で渡したときの保険
  if (field.members.length > 1)
    option = PART_TO_WHOLE[/** @type {keyof typeof PART_TO_WHOLE} */ (option)] ?? option

  /*
   * `autocomplete="family-name"` をフリガナ欄に付けているサイトがある。
   * 見出しがカナ / ローマ字を言っているなら、そちらに寄せる（漢字を入れると検査で弾かれる）
   */
  if (option === 'full_name' || option === 'family_name' || option === 'given_name') {
    const hints = hintText(field)
    if (/カナ|かな|フリガナ|ふりがな|kana/i.test(hints)) return `${option}_kana`
    if (/ローマ字|英字|romaji|alphabet/i.test(hints)) {
      return option === 'full_name' ? 'full_name_roman' : `${option}_roman`
    }
  }
  return option
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
  if (option === 'birthday' && count === 3) return ['birthday_year', 'birthday_month', 'birthday_day']
  if (option === 'full_name' && count === 2) return ['family_name', 'given_name']
  if (option === 'full_name_kana' && count === 2) return ['family_name_kana', 'given_name_kana']
  if (option === 'full_name_roman' && count === 2) return ['family_name_roman', 'given_name_roman']
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
 * Jev の答えを足切りする。形の違う答えは「決めない」に倒す（例外にしない）。
 *
 * @param {unknown} answers レスポンスの `answers`
 * @param {number[]} indexes このリクエストで聞いた欄
 * @returns {{ decisions: Map<number, Decision>, rejected: number }}
 */
export function readJevAnswers(answers, indexes) {
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
    const option = choice['choice']
    const confidence = choice['confidence']
    const noul = own['noul']
    if (typeof option !== 'string' || !(option in JEV_OPTIONS) || option === 'none') continue
    if (typeof confidence !== 'number' || typeof noul !== 'number') {
      rejected += 1
      continue
    }
    if (confidence < CHOICE_THRESHOLD || noul < OWN_THRESHOLD) {
      rejected += 1
      continue
    }
    decisions.set(index, { option, confidence, source: 'jev' })
  }
  return { decisions, rejected }
}

/**
 * 同じ項目を複数の欄が取り合ったら、確信度の高い 1 か所に絞る（`MULTI_USE` は除く）。
 * ルールで決めたものは確信度 1 として扱う。
 *
 * @param {Map<number, Decision>} decisions
 * @returns {Map<number, Decision>}
 */
export function resolveConflicts(decisions) {
  /** @type {Map<string, number>} */
  const best = new Map()
  for (const [index, decision] of decisions) {
    if (MULTI_USE.has(decision.option)) continue
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
    if (MULTI_USE.has(decision.option) || best.get(decision.option) === index) out.set(index, decision)
  }
  return out
}

/**
 * @typedef {{ element: number, value: string } | { element: number, optionIndex: number }} FillStep
 */

/**
 * 決まった項目を、入力欄ごとの値に落とす。
 *
 * @param {Collected} collected
 * @param {Map<number, Decision>} decisions
 * @param {Record<string, string>} values `deriveValues` の戻り
 * @returns {{ steps: FillStep[], filledFields: { rule: number, jev: number }, skipped: number }}
 */
export function buildFillPlan(collected, decisions, values) {
  /** @type {FillStep[]} */
  const steps = []
  const filledFields = { rule: 0, jev: 0 }
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
    field.members.forEach((elementIndex, position) => {
      const part = /** @type {string} */ (parts[position])
      const element = collected.elements[elementIndex]
      if (!element) return
      if (element.tag === 'select') {
        const optionIndex = matchSelectOption(element.options ?? [], part, values[part] ?? '')
        if (optionIndex >= 0) fieldSteps.push({ element: elementIndex, optionIndex })
        return
      }
      const value = formatForElement(part, values, element, hints)
      // **maxlength に収まらない値は入れない**（代入では maxlength が効かず、年が月の欄に入るような
      // 並び違いも黙って通る。分割グループなら 1 つでも収まらなければグループごと入れない）
      if (value === null || (element.maxLength !== null && value.length > element.maxLength)) return
      fieldSteps.push({ element: elementIndex, value })
    })
    // **グループは全部埋まるときだけ入れる**（電話の 3 つ目だけ空、のような半端を作らない）
    if (fieldSteps.length === 0 || fieldSteps.length !== field.members.length) {
      skipped += 1
      continue
    }
    steps.push(...fieldSteps)
    filledFields[decision.source] += 1
  }
  return { steps, filledFields, skipped }
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
