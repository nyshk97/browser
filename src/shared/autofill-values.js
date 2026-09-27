// @ts-check
/**
 * プロフィール → 入力欄に入れる値。
 *
 * **Jev は計算も生成も苦手**なので、分割・結合・書式の変換はすべてここ（コード）でやる。
 * Jev に選ばせるのは「どの項目か」だけ（`autofill-match.js`）。
 *
 * 純粋関数だけを置く（`scripts/autofill.test.mjs` から直接テストする）。
 */

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

/**
 * @param {Record<string, string>} profile `normalizeProfile` 済み
 * @returns {Record<string, string>} 選択肢のキー → 値（**空の項目から導く値は出さない**）
 */
export function deriveValues(profile) {
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
    'organization_url'
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

  const birthday = /^(\d{4})-(\d{2})-(\d{2})$/.exec(get('birthday'))
  if (birthday) {
    put('birthday', get('birthday'))
    put('birthday_year', birthday[1])
    put('birthday_month', String(Number(birthday[2])))
    put('birthday_day', String(Number(birthday[3])))
  }
  return out
}

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
  if (option === 'birthday') {
    const [year, month, day] = value.split('-')
    if (element.type === 'date') return value
    if (/年/.test(element.placeholder)) return `${year}年${Number(month)}月${Number(day)}日`
    if (element.maxLength === 8 || /^\d{8}$/.test(normalizeWidth(element.placeholder))) {
      return `${year}${month}${day}`
    }
    if (/\d{4}-\d/.test(element.placeholder)) return value
    return `${year}/${month}/${day}`
  }
  if (option === 'birthday_month' || option === 'birthday_day') {
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
  if (option === 'gender') return genderText(value)
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
 * @returns {number} 選ぶ option の添字。無ければ -1
 */
export function matchSelectOption(options, option, value) {
  const candidates = selectCandidates(option, value).map(normalizeOptionText).filter(Boolean)
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
 * @returns {string[]}
 */
function selectCandidates(option, value) {
  if (option === 'gender') return GENDER_WORDS[value] ?? []
  if (option === 'address_level1') {
    // 「神奈川県」と「神奈川」の揺れ。北海道は「道」を落とすと別物になるので落とさない
    const short = value === '北海道' ? value : value.replace(/[都府県]$/, '')
    return [value, short]
  }
  if (option === 'birthday_year') return [value, `${value}年`]
  if (option === 'birthday_month')
    return [value, value.padStart(2, '0'), `${value}月`, `${value.padStart(2, '0')}月`]
  if (option === 'birthday_day')
    return [value, value.padStart(2, '0'), `${value}日`, `${value.padStart(2, '0')}日`]
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
