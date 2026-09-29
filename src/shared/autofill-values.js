// @ts-check
/**
 * プロフィール → 入力欄に入れる値。
 *
 * **Jev は計算も生成も苦手**なので、分割・結合・書式の変換はすべてここ（コード）でやる。
 * Jev に選ばせるのは「どの項目か」だけ（`autofill-match.js`）。
 *
 * 純粋関数だけを置く（`scripts/autofill.test.mjs` から直接テストする）。
 */

import { PROFILE_FIELDS } from './autofill-schema.js'

/**
 * 収集スクリプトが返す入力欄 1 個（`autofill-collect-source.js` の `elements[]`）。
 *
 * @typedef {object} CollectedElement
 * @property {'input' | 'select' | 'textarea'} tag
 * @property {string} type input の type（小文字。select / textarea は空）
 * @property {string} placeholder
 * @property {number | null} maxLength
 * @property {{ value: string, text: string }[]} [options] select の選択肢（先頭の「選択してください」も含む）
 */

/**
 * 姓と名をつなぐ空白。既定は半角で、全角を求める欄だけ `formatForElement` が全角に替える
 * （`FULLWIDTH_SEPARATOR`）。
 */
const NAME_SEPARATOR = ' '
const FULLWIDTH_SEPARATOR = '\u3000'

/** 日付の項目（`YYYY-MM-DD`）。正は `PROFILE_FIELDS` の `type: 'date'`（`autofill-match.js` の `DATE_OPTIONS` も同じもの）。 */
export const DATE_KEYS = PROFILE_FIELDS.filter((field) => field.type === 'date').map((field) => field.key)

/** 分けた日付の部分 → 元の項目（`passport_expiry_year` → `passport_expiry`）。 */
const DATE_PART_RE = new RegExp(`^(${DATE_KEYS.join('|')})_(year|month|day)$`)

/**
 * 元号（始まりの日が早い順）。和暦の select・入力欄に合わせるため。
 * @type {readonly { name: string, letter: string, start: string }[]}
 */
const ERAS = [
  { name: '明治', letter: 'M', start: '1868-10-23' },
  { name: '大正', letter: 'T', start: '1912-07-30' },
  { name: '昭和', letter: 'S', start: '1926-12-25' },
  { name: '平成', letter: 'H', start: '1989-01-08' },
  { name: '令和', letter: 'R', start: '2019-05-01' }
]

/**
 * `YYYY-MM-DD` の和暦（元号と年）。明治より前は null。
 * @param {string} date
 * @returns {{ name: string, letter: string, year: number } | null}
 */
export function toWareki(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  for (let i = ERAS.length - 1; i >= 0; i -= 1) {
    const era = /** @type {typeof ERAS[number]} */ (ERAS[i])
    if (date >= era.start)
      return {
        name: era.name,
        letter: era.letter,
        year: Number(date.slice(0, 4)) - Number(era.start.slice(0, 4)) + 1
      }
  }
  return null
}

/** 都道府県 → 英語の表記（英語のフォームの State / Prefecture）。 */
const PREFECTURES_EN = {
  北海道: 'Hokkaido',
  青森県: 'Aomori',
  岩手県: 'Iwate',
  宮城県: 'Miyagi',
  秋田県: 'Akita',
  山形県: 'Yamagata',
  福島県: 'Fukushima',
  茨城県: 'Ibaraki',
  栃木県: 'Tochigi',
  群馬県: 'Gunma',
  埼玉県: 'Saitama',
  千葉県: 'Chiba',
  東京都: 'Tokyo',
  神奈川県: 'Kanagawa',
  新潟県: 'Niigata',
  富山県: 'Toyama',
  石川県: 'Ishikawa',
  福井県: 'Fukui',
  山梨県: 'Yamanashi',
  長野県: 'Nagano',
  岐阜県: 'Gifu',
  静岡県: 'Shizuoka',
  愛知県: 'Aichi',
  三重県: 'Mie',
  滋賀県: 'Shiga',
  京都府: 'Kyoto',
  大阪府: 'Osaka',
  兵庫県: 'Hyogo',
  奈良県: 'Nara',
  和歌山県: 'Wakayama',
  鳥取県: 'Tottori',
  島根県: 'Shimane',
  岡山県: 'Okayama',
  広島県: 'Hiroshima',
  山口県: 'Yamaguchi',
  徳島県: 'Tokushima',
  香川県: 'Kagawa',
  愛媛県: 'Ehime',
  高知県: 'Kochi',
  福岡県: 'Fukuoka',
  佐賀県: 'Saga',
  長崎県: 'Nagasaki',
  熊本県: 'Kumamoto',
  大分県: 'Oita',
  宮崎県: 'Miyazaki',
  鹿児島県: 'Kagoshima',
  沖縄県: 'Okinawa'
}

/**
 * 都道府県の英語の表記（「東京」のように都府県を省いた書き方も受ける）。知らない値は空。
 * @param {string} prefecture
 */
export function prefectureEn(prefecture) {
  const name = prefecture.trim()
  const table = /** @type {Record<string, string>} */ (PREFECTURES_EN)
  return table[name] ?? table[`${name}都`] ?? table[`${name}府`] ?? table[`${name}県`] ?? ''
}

/**
 * 満年齢（`today` の日付で数える。2 月 29 日生まれは平年では 3 月 1 日に 1 つ増える）。形が違えば空。
 * @param {string} birthday `YYYY-MM-DD`
 * @param {Date} today
 */
export function ageOn(birthday, today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday)
  if (!match) return ''
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const [ty, tm, td] = [today.getFullYear(), today.getMonth() + 1, today.getDate()]
  const age = ty - year - (tm < month || (tm === month && td < day) ? 1 : 0)
  return age >= 0 && age < 150 ? String(age) : ''
}

/**
 * @param {Record<string, string>} profile `normalizeProfile` 済み
 * @param {{ english?: boolean, today?: Date }} [options]
 *   `english` … 英語のフォーム（`isEnglishForm`）。氏名はローマ字、住所は英語の住所にする。
 *   **英語の住所が無ければ住所の値は出さない**（英語のフォームに日本語の住所を入れない）。郵便番号・国・都道府県は出す
 *   （都道府県と国は、英語の値を保存していればそれ、無ければ対応表 / Japan）
 *   `today` … 年齢を数える日（既定は今日）
 * @returns {Record<string, string>} 選択肢のキー → 値（**空の項目から導く値は出さない**）
 */
export function deriveValues(profile, options = {}) {
  /** @type {Record<string, string>} */
  const out = {}
  const put = (/** @type {string} */ key, /** @type {string | undefined} */ value) => {
    if (value) out[key] = value
  }
  const get = (/** @type {string} */ key) => profile[key] ?? ''

  for (const key of [
    'family_name',
    'given_name',
    'family_name_roman',
    'given_name_roman',
    'email',
    'address_level1',
    'address_level2',
    'address_line1',
    'address_line2',
    'gender',
    'organization',
    'department',
    'job_title',
    'organization_url',
    'passport_number',
    'license_number',
    'insurance_symbol',
    'insurance_number',
    'insurance_branch',
    'insurer_number'
  ]) {
    put(key, get(key))
  }
  put('family_name_kana', toKatakana(get('family_name_kana')))
  put('given_name_kana', toKatakana(get('given_name_kana')))

  // 一括は**両方あるときだけ**（片方だけを「氏名」に入れると姓だけの氏名になる）
  if (get('family_name') && get('given_name'))
    put('full_name', `${get('family_name')}${NAME_SEPARATOR}${get('given_name')}`)
  if (out['family_name_kana'] && out['given_name_kana']) {
    put('full_name_kana', `${out['family_name_kana']}${NAME_SEPARATOR}${out['given_name_kana']}`)
  }
  // ローマ字の一括は欧文の順（名 姓）。日本語フォームでも英字氏名はこの順が多い
  if (get('family_name_roman') && get('given_name_roman')) {
    put('full_name_roman', `${get('given_name_roman')} ${get('family_name_roman')}`)
  }

  const tel = splitTel(get('tel'))
  if (tel) {
    put('tel', get('tel'))
    put('tel_part1', tel[0])
    put('tel_part2', tel[1])
    put('tel_part3', tel[2])
  }

  const postal = digitsOf(get('postal_code'))
  if (postal.length === 7) {
    put('postal_code', `${postal.slice(0, 3)}-${postal.slice(3)}`)
    put('postal_code_part1', postal.slice(0, 3))
    put('postal_code_part2', postal.slice(3))
  }

  if (get('address_level2') && get('address_line1'))
    put('address_city_line1', `${get('address_level2')}${get('address_line1')}`)
  if (get('address_line1')) {
    put(
      'address_line1_2',
      get('address_line2') ? `${get('address_line1')} ${get('address_line2')}` : get('address_line1')
    )
  }
  const address = [get('address_level1'), get('address_level2'), get('address_line1')].join('')
  put('address_without_building', address)
  if (address) put('address_full', get('address_line2') ? `${address} ${get('address_line2')}` : address)

  // 日付（生年月日・パスポートと免許証の有効期限）は年 / 月 / 日にも分ける
  for (const key of DATE_KEYS) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(get(key))
    if (!date) continue
    put(key, get(key))
    put(`${key}_year`, date[1])
    put(`${key}_month`, String(Number(date[2])))
    put(`${key}_day`, String(Number(date[3])))
  }

  put('age', ageOn(get('birthday'), options.today ?? new Date()))
  // 住所の国（日本語のフォームは「日本」、英語のフォームは Japan。select は両方の書き方で照合する）
  if (address || get('postal_code')) put('country', options.english ? get('country_en') || 'Japan' : '日本')

  if (options.english) {
    // 氏名はローマ字（カナは英語のフォームで使わないので出さない）
    for (const key of ['family_name', 'given_name', 'full_name']) delete out[key]
    for (const key of Object.keys(out)) if (key.endsWith('_kana')) delete out[key]
    put('family_name', get('family_name_roman'))
    put('given_name', get('given_name_roman'))
    put('full_name', out['full_name_roman'])
    // 住所は英語の住所（無ければ出さない）。都道府県は表から作る
    for (const key of [
      'address_level1',
      'address_level2',
      'address_line1',
      'address_line2',
      'address_line1_2',
      'address_city_line1',
      'address_without_building',
      'address_full'
    ])
      delete out[key]
    const [city, line1, line2] = [get('address_level2_en'), get('address_line1_en'), get('address_line2_en')]
    const prefecture = get('address_level1_en') || prefectureEn(get('address_level1'))
    put('address_level1', prefecture)
    // select の照合で、保存した書き方（Tokyo-to など）が選択肢に無いときに対応表の書き方でも探す
    put('address_level1_table', prefectureEn(get('address_level1')))
    put('address_level2', city)
    put('address_line1', line1)
    put('address_line2', line2)
    if (line1) put('address_line1_2', line2 ? `${line1}, ${line2}` : line1)
    // 英語の住所は小さい単位から（1-1 Chiyoda, Sample Tower 1701, Chiyoda-ku, Tokyo）
    if (line1 && city) {
      put('address_city_line1', `${line1}, ${city}`)
      put('address_without_building', [line1, city, prefecture].filter(Boolean).join(', '))
      put('address_full', [line1, line2, city, prefecture].filter(Boolean).join(', '))
    }
    if (out['gender']) put('gender_display', ENGLISH_GENDER[out['gender']] ?? '')
  }
  return out
}

/** 英語のフォームの性別の書き方。 */
const ENGLISH_GENDER = /** @type {Record<string, string>} */ ({
  male: 'Male',
  female: 'Female',
  other: 'Other'
})

/**
 * 電話番号を 3 つに割る。**区切りがあればそれを信じる**（市外局番の桁は地域で違うので、
 * 数字だけから割るのは最後の手段）。
 *
 * @param {string} tel
 * @returns {[string, string, string] | null}
 */
export function splitTel(tel) {
  const parts = normalizeWidth(tel)
    .split(/[^0-9]+/)
    .filter(Boolean)
  if (parts.length === 3) return /** @type {[string, string, string]} */ (parts)
  const digits = parts.join('')
  if (digits.length === 11) return [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7)]
  if (digits.length === 10) {
    // 03 / 06 は 2 桁の市外局番。それ以外は 3-3-4 に倒す（完全ではないが、区切りを入れてもらえば済む）
    if (/^0[36]/.test(digits)) return [digits.slice(0, 2), digits.slice(2, 6), digits.slice(6)]
    return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
  }
  return null
}

/**
 * 入力欄 1 個に入れる文字列を、その欄の手がかりに合わせて整える。
 *
 * @param {string} option 選択肢のキー（`tel_part1` のような分割後のものも来る）
 * @param {Record<string, string>} values `deriveValues` の戻り
 * @param {CollectedElement} element
 * @param {string} hintText label・placeholder・近傍テキストをつないだもの（書式の手がかり）
 * @returns {string | null} 入れる値。値が無ければ null
 */
export function formatForElement(option, values, element, hintText) {
  const value = values[option]
  if (!value) return null
  const hints = normalizeWidth(`${hintText} ${element.placeholder}`)
  const noHyphen = /ハイフン(なし|無し|不要)|半角数字のみ|-なし/.test(hints)

  if (option === 'tel') {
    const digits = digitsOf(value)
    if (noHyphen || (element.maxLength !== null && element.maxLength <= 11)) return digits
    if (/\d-\d/.test(element.placeholder)) return (splitTel(value) ?? [digits]).join('-')
    // 「09012345678」「090XXXXXXXX」のように区切りの無い例ならハイフンなし
    if (/^[0-9X]{10,11}$/i.test(normalizeWidth(element.placeholder))) return digits
    return value
  }
  if (option === 'postal_code') {
    if (noHyphen || element.maxLength === 7 || /^[0-9X]{7}$/i.test(normalizeWidth(element.placeholder))) {
      return digitsOf(value)
    }
    return value
  }
  if (DATE_KEYS.includes(option)) {
    const [year, month, day] = value.split('-')
    if (element.type === 'date') return value
    // 和暦の例・見出し（「令和◯年◯月◯日」「和暦で」）なら和暦で書く
    const wareki = toWareki(value)
    if (wareki && /令和|平成|昭和|和暦/.test(`${hints} ${element.placeholder}`)) {
      return `${wareki.name}${wareki.year === 1 ? '元' : wareki.year}年${Number(month)}月${Number(day)}日`
    }
    if (/年/.test(element.placeholder)) return `${year}年${Number(month)}月${Number(day)}日`
    if (element.maxLength === 8 || /^\d{8}$/.test(normalizeWidth(element.placeholder))) {
      return `${year}${month}${day}`
    }
    if (/\d{4}-\d/.test(element.placeholder)) return value
    return `${year}/${month}/${day}`
  }
  const datePart = DATE_PART_RE.exec(option)
  if (datePart?.[2] === 'year') {
    // 年だけの欄が和暦（「令和[  ]年」「和暦で」）なら元号の年。元号は元の日付で決める（改元の年は日付で分かれる）
    const wareki = toWareki(values[/** @type {string} */ (datePart[1])] ?? '')
    if (wareki && /令和|平成|昭和|和暦/.test(`${hints} ${element.placeholder}`)) return String(wareki.year)
    return value
  }
  if (datePart?.[2] === 'month' || datePart?.[2] === 'day') {
    // 「01」のような 2 桁の例があるときだけ 0 埋め
    if (/^0\d$/.test(normalizeWidth(element.placeholder)) || /^(MM|DD)$/i.test(element.placeholder)) {
      return value.padStart(2, '0')
    }
    return value
  }
  if (option === 'full_name' || option === 'full_name_kana') {
    // 置換でなくつなぎ直す（姓に半角空白を含む名前で、区切りでない空白を全角にしない）
    const [family, given] =
      option === 'full_name'
        ? [values['family_name'], values['given_name']]
        : [values['family_name_kana'], values['given_name_kana']]
    const spaced =
      family && given && wantsFullwidthSpace(hintText, element.placeholder)
        ? `${family}${FULLWIDTH_SEPARATOR}${given}`
        : value
    return option === 'full_name_kana' && wantsHiragana(hintText, element.placeholder)
      ? toHiragana(spaced)
      : spaced
  }
  if (option.endsWith('_kana') && wantsHiragana(hintText, element.placeholder)) return toHiragana(value)
  if (option === 'gender') return values['gender_display'] ?? genderText(value)
  return value
}

/**
 * select の選択肢から入れるものを選ぶ。
 *
 * **完全一致（正規化後）を優先し、部分一致は候補が 1 つに決まるときだけ**使う
 * （「1」が「10」「11」…に部分一致して別の日を選ばないように）。
 *
 * @param {{ value: string, text: string }[]} options
 * @param {string} option 選択肢のキー
 * @param {string} value `formatForElement` を通す前の値
 * @param {Record<string, string>} [values] `deriveValues` の戻り（年の欄を和暦で選ぶときに元の日付を見る）
 * @returns {number} 選ぶ option の添字。無ければ -1
 */
export function matchSelectOption(options, option, value, values = {}) {
  const candidates = selectCandidates(option, value, values).map(normalizeOptionText).filter(Boolean)
  if (candidates.length === 0) return -1

  const texts = options.map((entry) => [normalizeOptionText(entry.text), normalizeOptionText(entry.value)])
  for (const candidate of candidates) {
    const exact = texts.findIndex(([text, val]) => text === candidate || val === candidate)
    if (exact !== -1) return exact
  }
  // 部分一致は 2 文字以上の候補だけ（数字 1 桁の月日は完全一致しか許さない）
  for (const candidate of candidates) {
    if (candidate.length < 2) continue
    const hits = texts.flatMap(([text], index) => (text.includes(candidate) ? [index] : []))
    if (hits.length === 1) return /** @type {number} */ (hits[0])
  }
  return -1
}

/**
 * @param {string} option
 * @param {string} value
 * @param {Record<string, string>} values
 * @returns {string[]}
 */
function selectCandidates(option, value, values) {
  if (option === 'gender') return GENDER_WORDS[value] ?? []
  if (option === 'country') return ['Japan', '日本', 'JP', 'JPN', '日本国']
  if (option === 'age') return [value, `${value}歳`, `${value}才`]
  if (option === 'address_level1' && /^[A-Za-z]/.test(value)) {
    // 英語のフォーム（Tokyo / Tokyo-to / Tokyo Prefecture）
    const table = values['address_level1_table'] ?? ''
    return [
      value,
      `${value} Prefecture`,
      `${value}-to`,
      `${value}-fu`,
      `${value}-ken`,
      ...(table ? [table, `${table} Prefecture`] : [])
    ]
  }
  if (option === 'address_level1') {
    // 「神奈川県」と「神奈川」の揺れ。北海道は「道」を落とすと別物になるので落とさない
    const short = value === '北海道' ? value : value.replace(/[都府県]$/, '')
    return [value, short]
  }
  const part = DATE_PART_RE.exec(option)
  if (part?.[2] === 'year') {
    // 和暦の選択肢（「令和11」「令和11年」「R11」「令和元年」）。元号は元の日付で決める（改元の年は日付で分かれる）
    const wareki = toWareki(values[/** @type {string} */ (part[1])] ?? '')
    const eraYears = wareki
      ? [String(wareki.year), ...(wareki.year === 1 ? ['元'] : [])].flatMap((y) => [
          `${wareki.name}${y}`,
          `${wareki.name}${y}年`,
          `${wareki.letter}${y}`,
          `${wareki.letter}${y}年`
        ])
      : []
    return [value, `${value}年`, ...eraYears]
  }
  if (part?.[2] === 'month')
    return [value, value.padStart(2, '0'), `${value}月`, `${value.padStart(2, '0')}月`]
  if (part?.[2] === 'day') return [value, value.padStart(2, '0'), `${value}日`, `${value.padStart(2, '0')}日`]
  return [value]
}

/** @type {Record<string, string[]>} */
const GENDER_WORDS = {
  male: ['男性', '男', 'male', 'man', 'M'],
  female: ['女性', '女', 'female', 'woman', 'F'],
  other: ['その他', '回答しない', '答えない', 'other']
}

/** @param {string} value */
function genderText(value) {
  return GENDER_WORDS[value]?.[0] ?? value
}

/** @param {string} text */
function normalizeOptionText(text) {
  return normalizeWidth(text).replace(/\s+/g, '').toLowerCase()
}

/**
 * 全角英数・全角記号を半角に（NFKC）。カタカナの半角化はしない（NFKC は半角カナを全角にする向き）。
 * @param {string} text
 */
export function normalizeWidth(text) {
  return text.normalize('NFKC')
}

/** @param {string} text */
function digitsOf(text) {
  return normalizeWidth(text).replace(/[^0-9]/g, '')
}

/**
 * ひらがなを求めている欄か。見出しの「ふりがな」「ひらがな」か、例がひらがなだけのとき。
 * @param {string} hintText
 * @param {string} placeholder
 */
function wantsHiragana(hintText, placeholder) {
  if (/ふりがな|ひらがな/.test(hintText)) return true
  const example = placeholder.replace(/^例\s*[)）:：]?\s*/, '').replace(/[\s\u3000]/g, '')
  return example.length > 0 && /^[ぁ-ゖー]+$/.test(example)
}

/**
 * 姓と名の間を全角空白にすべき欄か。見出しに「全角」がある（「氏名（全角）」「全角スペースで区切って」）か、
 * 例が全角空白で区切られているとき（「山田[全角空白]太郎」のような例）。**placeholder は NFKC 前の生の文字列で見る**（NFKC は全角空白を半角にする。収集側も placeholder の全角空白は残す）。
 * 「全角スペース不可」のような否定の言い回しでも全角にするのは割り切り（見かけたら除外を足す）。
 * @param {string} hintText
 * @param {string} placeholder
 */
function wantsFullwidthSpace(hintText, placeholder) {
  if (/全角/.test(`${hintText} ${placeholder}`)) return true
  return /\S\u3000+\S/.test(placeholder)
}

/** @param {string} text */
export function toKatakana(text) {
  return text.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60))
}

/** @param {string} text */
export function toHiragana(text) {
  return text.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
}
