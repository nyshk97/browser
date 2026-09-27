// @ts-check
/**
 * フォーム自動入力の保管庫に入れるプロフィールのスキーマ。
 *
 * **renderer も読む**（設定画面の入力欄の並び・見出し）ので、node 組み込みも
 * `settings-schema.js`（`ext-lock.js` → `node:fs` に触る）も import しない。
 *
 * 保管庫に持つのは**元の値だけ**。氏名一括・電話の分割・生年月日の年月日などの導出形は
 * `autofill-values.js` が使うたびに作る（持つと、元を直したときに導出形だけ古いまま残る）。
 */

/** 保管庫ファイルのスキーマ版。 */
export const AUTOFILL_VERSION = 1

/** 1 項目の上限。住所でも十分な長さ。 */
export const MAX_PROFILE_VALUE = 200

/**
 * 性別の値。select / radio の照合は `autofill-values.js` の候補表で行う。
 * @type {readonly string[]}
 */
export const GENDERS = ['', 'male', 'female', 'other']

/**
 * プロフィールの項目（**設定画面に出す順**）。
 *
 * `key` は Jev の選択肢・`autocomplete` の対応表と同じ名前空間。
 * `hint` は入力欄の placeholder（形式の例）。
 *
 * @type {readonly { key: string, label: string, hint: string, group: string }[]}
 */
export const PROFILE_FIELDS = [
  { key: 'family_name', label: '姓', hint: '山田', group: '氏名' },
  { key: 'given_name', label: '名', hint: '太郎', group: '氏名' },
  { key: 'family_name_kana', label: 'セイ（カタカナ）', hint: 'ヤマダ', group: '氏名' },
  { key: 'given_name_kana', label: 'メイ（カタカナ）', hint: 'タロウ', group: '氏名' },
  { key: 'family_name_roman', label: '姓（ローマ字）', hint: 'Yamada', group: '氏名' },
  { key: 'given_name_roman', label: '名（ローマ字）', hint: 'Taro', group: '氏名' },
  { key: 'email', label: 'メールアドレス', hint: 'taro@example.com', group: '連絡先' },
  { key: 'tel', label: '電話番号', hint: '090-1234-5678', group: '連絡先' },
  { key: 'postal_code', label: '郵便番号', hint: '100-0001', group: '住所' },
  { key: 'address_level1', label: '都道府県', hint: '東京都', group: '住所' },
  { key: 'address_level2', label: '市区町村', hint: '千代田区', group: '住所' },
  { key: 'address_line1', label: '町名・番地', hint: '千代田1-1', group: '住所' },
  { key: 'address_line2', label: '建物名・部屋番号', hint: '〇〇タワー 1701', group: '住所' },
  { key: 'birthday', label: '生年月日', hint: '2000-01-01', group: 'その他' },
  { key: 'gender', label: '性別', hint: '', group: 'その他' },
  { key: 'organization', label: '会社名', hint: '株式会社〇〇', group: '勤務先' },
  { key: 'department', label: '部署', hint: '開発部', group: '勤務先' },
  { key: 'job_title', label: '役職', hint: '代表取締役', group: '勤務先' },
  { key: 'organization_url', label: '会社 URL', hint: 'https://example.com', group: '勤務先' }
]

/** @type {readonly string[]} */
export const PROFILE_KEYS = PROFILE_FIELDS.map((field) => field.key)

/**
 * @typedef {Record<string, string>} AutofillProfile
 *   `PROFILE_KEYS` の全キーを持つ。未入力は空文字列。
 */

/**
 * プロフィールを正規化する。**保存前と復号後の両方で通す**。
 *
 * - 知らないキーは捨てる（古い / 新しい Nemo が書いた余計なキーで UI が崩れない）
 * - 文字列以外・上限超えは空にする（黙って切ると、別の値に化ける）
 * - `birthday` は `YYYY-MM-DD` で実在する日付だけ
 * - `gender` は `GENDERS` のどれか
 *
 * @param {unknown} raw
 * @returns {AutofillProfile}
 */
export function normalizeProfile(raw) {
  /** @type {AutofillProfile} */
  const profile = {}
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  for (const key of PROFILE_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (source)[key]
    profile[key] = typeof value === 'string' && value.length <= MAX_PROFILE_VALUE ? value.trim() : ''
  }
  if (profile['birthday'] && !isValidDate(profile['birthday'])) profile['birthday'] = ''
  if (!GENDERS.includes(profile['gender'] ?? '')) profile['gender'] = ''
  return profile
}

/**
 * 入っている項目の数（保管庫の平文メタの `count`）。
 * @param {AutofillProfile} profile
 */
export function countFilled(profile) {
  return PROFILE_KEYS.filter((key) => (profile[key] ?? '') !== '').length
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Jev の API キーの上限。 */
export const MAX_JEV_KEY = 512

/**
 * 保管庫の中身（暗号の中）。**Jev の API キーもここに入れる**ので、別の Mac でもパスフレーズを
 * 入れるだけでキーまで使える（端末鍵で暗号化したキーは Mac ごとに入れ直しになる）。
 *
 * @typedef {object} AutofillVaultContent
 * @property {AutofillProfile} profile
 * @property {string | null} jevKey
 */

/**
 * 復号した中身を正規化する。**最初の形（プロフィールそのもの）も読む**
 * （キーを保管庫に入れる前に保存した保管庫。次に保存したときに新しい形になる）。
 *
 * @param {unknown} raw
 * @returns {AutofillVaultContent}
 */
export function normalizeVaultContent(raw) {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const content = /** @type {Record<string, unknown>} */ (record)
  const wrapped = typeof content['profile'] === 'object' && content['profile'] !== null
  if (!wrapped) return { profile: normalizeProfile(raw), jevKey: null }
  const key = content['jevKey']
  return {
    profile: normalizeProfile(content['profile']),
    jevKey: typeof key === 'string' && key.trim() !== '' && key.length <= MAX_JEV_KEY ? key.trim() : null
  }
}
