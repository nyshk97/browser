// @ts-check
/**
 * フォーム自動入力のプロフィールのスキーマ。値の正は kypr の個人情報（`type: "identity"`）。
 *
 * **renderer も読む**（kypr のポップアップの個人情報の並び・見出し）ので、node 組み込みも
 * `settings-schema.js`（`ext-lock.js` → `node:fs` に触る）も import しない。
 *
 * kypr に持つのは**元の値だけ**。氏名一括・電話の分割・日付の年月日などの導出形は
 * `autofill-values.js` が使うたびに作る（持つと、元を直したときに導出形だけ古いまま残る）。
 */

/** 1 項目の上限。住所でも十分な長さ。 */
export const MAX_PROFILE_VALUE = 200

/**
 * 性別の値。select / radio の照合は `autofill-values.js` の候補表で行う。
 * @type {readonly string[]}
 */
export const GENDERS = ['', 'male', 'female', 'other']

/**
 * プロフィールの項目（**kypr の個人情報の編集画面に出す順**）。
 *
 * 値の正は kypr の個人情報（`type: "identity"`）。`kypr` はその平文のキー（camelCase）で、
 * 並び・見出し・伏せる項目は kypr の `packages/client/src/identity.ts`（Nemo には `src/vendor/kypr/client/identity.ts`）と揃える
 * （`scripts/kypr-identity.test.mjs` が突き合わせる）。
 *
 * `key` は Jev の選択肢・`autocomplete` の対応表と同じ名前空間（snake_case）。
 * `hint` は入力欄の placeholder（形式の例）。`type: 'date'` は `YYYY-MM-DD`。
 * `document` は身分証の項目（Jev の足切りを上げる・`document_expiry` の書類を決める）。
 * `noAutofill` は自動入力に一切出さない項目（kypr の `noAutofill`。免許の暗証番号とマイナンバーカードの全部）。
 * ポップアップの表示・編集には出すが、自動入力のプロフィール（`AUTOFILL_FIELDS` / `PROFILE_KEYS`）には入れない。
 *
 * @typedef {'passport' | 'license' | 'insurance'} DocumentKind
 * @typedef {{ key: string, kypr: string, label: string, hint: string, group: string, type: 'text' | 'date' | 'gender', secret?: true, document?: DocumentKind, noAutofill?: true }} ProfileField
 * @type {readonly ProfileField[]}
 */
export const PROFILE_FIELDS = [
  { key: 'family_name', kypr: 'familyName', label: '姓', hint: '山田', group: '氏名', type: 'text' },
  { key: 'given_name', kypr: 'givenName', label: '名', hint: '太郎', group: '氏名', type: 'text' },
  {
    key: 'family_name_kana',
    kypr: 'familyNameKana',
    label: 'セイ（カタカナ）',
    hint: 'ヤマダ',
    group: '氏名',
    type: 'text'
  },
  {
    key: 'given_name_kana',
    kypr: 'givenNameKana',
    label: 'メイ（カタカナ）',
    hint: 'タロウ',
    group: '氏名',
    type: 'text'
  },
  {
    key: 'family_name_roman',
    kypr: 'familyNameRoman',
    label: '姓（ローマ字）',
    hint: 'Yamada',
    group: '氏名',
    type: 'text'
  },
  {
    key: 'given_name_roman',
    kypr: 'givenNameRoman',
    label: '名（ローマ字）',
    hint: 'Taro',
    group: '氏名',
    type: 'text'
  },
  {
    key: 'email',
    kypr: 'email',
    label: 'メールアドレス',
    hint: 'taro@example.com',
    group: '連絡先',
    type: 'text'
  },
  { key: 'tel', kypr: 'tel', label: '電話番号', hint: '090-1234-5678', group: '連絡先', type: 'text' },
  {
    key: 'postal_code',
    kypr: 'postalCode',
    label: '郵便番号',
    hint: '100-0001',
    group: '住所',
    type: 'text'
  },
  {
    key: 'address_level1',
    kypr: 'addressLevel1',
    label: '都道府県',
    hint: '東京都',
    group: '住所',
    type: 'text'
  },
  {
    key: 'address_level2',
    kypr: 'addressLevel2',
    label: '市区町村',
    hint: '千代田区',
    group: '住所',
    type: 'text'
  },
  {
    key: 'address_line1',
    kypr: 'addressLine1',
    label: '町名・番地',
    hint: '千代田1-1',
    group: '住所',
    type: 'text'
  },
  {
    key: 'address_line2',
    kypr: 'addressLine2',
    label: '建物名・部屋番号',
    hint: '〇〇タワー 1701',
    group: '住所',
    type: 'text'
  },
  // 英語のフォームで使う（`deriveValues` が英語のフォームのときだけ住所の値を差し替える）。
  // 都道府県と国は空なら作る（都道府県は日本語の都道府県から対応表、国は Japan）
  {
    key: 'address_level1_en',
    kypr: 'addressLevel1En',
    label: '都道府県',
    hint: 'Tokyo',
    group: '住所（英語）',
    type: 'text'
  },
  {
    key: 'address_level2_en',
    kypr: 'addressLevel2En',
    label: '市区町村',
    hint: 'Chiyoda-ku',
    group: '住所（英語）',
    type: 'text'
  },
  {
    key: 'address_line1_en',
    kypr: 'addressLine1En',
    label: '町名・番地',
    hint: '1-1 Chiyoda',
    group: '住所（英語）',
    type: 'text'
  },
  {
    key: 'address_line2_en',
    kypr: 'addressLine2En',
    label: '建物名・部屋番号',
    hint: 'Sample Tower 1701',
    group: '住所（英語）',
    type: 'text'
  },
  { key: 'country_en', kypr: 'countryEn', label: '国', hint: 'Japan', group: '住所（英語）', type: 'text' },
  { key: 'birthday', kypr: 'birthday', label: '生年月日', hint: '2000-01-01', group: 'その他', type: 'date' },
  { key: 'gender', kypr: 'gender', label: '性別', hint: '', group: 'その他', type: 'gender' },
  {
    key: 'organization',
    kypr: 'organization',
    label: '会社名',
    hint: '株式会社〇〇',
    group: '勤務先',
    type: 'text'
  },
  { key: 'department', kypr: 'department', label: '部署', hint: '開発部', group: '勤務先', type: 'text' },
  { key: 'job_title', kypr: 'jobTitle', label: '役職', hint: '代表取締役', group: '勤務先', type: 'text' },
  {
    key: 'organization_url',
    kypr: 'organizationUrl',
    label: '会社 URL',
    hint: 'https://example.com',
    group: '勤務先',
    type: 'text'
  },
  {
    key: 'passport_number',
    kypr: 'passportNumber',
    label: '旅券番号',
    hint: 'TK1234567',
    group: 'パスポート',
    type: 'text',
    secret: true,
    document: 'passport'
  },
  {
    key: 'passport_issue_date',
    kypr: 'passportIssueDate',
    label: '発行日',
    hint: '2021-04-30',
    group: 'パスポート',
    type: 'date',
    document: 'passport'
  },
  {
    key: 'passport_expiry',
    kypr: 'passportExpiry',
    label: '有効期限',
    hint: '2031-04-30',
    group: 'パスポート',
    type: 'date',
    document: 'passport'
  },
  {
    key: 'license_number',
    kypr: 'licenseNumber',
    label: '免許証番号',
    hint: '123456789012',
    group: '運転免許証',
    type: 'text',
    secret: true,
    document: 'license'
  },
  {
    key: 'license_issue_date',
    kypr: 'licenseIssueDate',
    label: '交付日',
    hint: '2024-05-10',
    group: '運転免許証',
    type: 'date',
    document: 'license'
  },
  {
    key: 'license_expiry',
    kypr: 'licenseExpiry',
    label: '有効期限',
    hint: '2029-06-15',
    group: '運転免許証',
    type: 'date',
    document: 'license'
  },
  {
    key: 'license_pin1',
    kypr: 'licensePin1',
    label: '暗証番号 1',
    hint: '1234',
    group: '運転免許証',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'license_pin2',
    kypr: 'licensePin2',
    label: '暗証番号 2',
    hint: '5678',
    group: '運転免許証',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  // マイナンバーカードは全部自動入力に出さない（個人番号はポップアップの詳細からコピーして入れる）
  {
    key: 'my_number',
    kypr: 'myNumber',
    label: '個人番号',
    hint: '123456789012',
    group: 'マイナンバーカード',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'my_number_card_expiry',
    kypr: 'myNumberCardExpiry',
    label: 'カードの有効期限',
    hint: '2028-09-21',
    group: 'マイナンバーカード',
    type: 'date',
    noAutofill: true
  },
  {
    key: 'my_number_cert_expiry',
    kypr: 'myNumberCertExpiry',
    label: '電子証明書の有効期限',
    hint: '2028-09-21',
    group: 'マイナンバーカード',
    type: 'date',
    noAutofill: true
  },
  {
    key: 'my_number_sign_password',
    kypr: 'myNumberSignPassword',
    label: '署名用電子証明書のパスワード',
    hint: '英大文字と数字 6〜16 文字',
    group: 'マイナンバーカード',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'my_number_auth_pin',
    kypr: 'myNumberAuthPin',
    label: '利用者証明用の暗証番号',
    hint: '数字 4 桁',
    group: 'マイナンバーカード',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'my_number_resident_pin',
    kypr: 'myNumberResidentPin',
    label: '住民基本台帳用の暗証番号',
    hint: '数字 4 桁',
    group: 'マイナンバーカード',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'my_number_info_pin',
    kypr: 'myNumberInfoPin',
    label: '券面事項入力補助用の暗証番号',
    hint: '数字 4 桁',
    group: 'マイナンバーカード',
    type: 'text',
    secret: true,
    noAutofill: true
  },
  {
    key: 'insurance_symbol',
    kypr: 'insuranceSymbol',
    label: '記号',
    hint: '1234',
    group: '健康保険証',
    type: 'text',
    secret: true,
    document: 'insurance'
  },
  {
    key: 'insurance_number',
    kypr: 'insuranceNumber',
    label: '番号',
    hint: '56',
    group: '健康保険証',
    type: 'text',
    secret: true,
    document: 'insurance'
  },
  {
    key: 'insurance_branch',
    kypr: 'insuranceBranch',
    label: '枝番',
    hint: '01',
    group: '健康保険証',
    type: 'text',
    document: 'insurance'
  },
  {
    key: 'insurer_number',
    kypr: 'insurerNumber',
    label: '保険者番号',
    hint: '06123456',
    group: '健康保険証',
    type: 'text',
    document: 'insurance'
  },
  // 自動入力の候補にはしない（`JEV_OPTIONS` に無く、`deriveValues` も値を出さない）。kypr では `noAutofill` ではない
  {
    key: 'pension_number',
    kypr: 'pensionNumber',
    label: '基礎年金番号',
    hint: '1234-567890',
    group: '年金',
    type: 'text',
    secret: true
  }
]

/**
 * 自動入力に使う項目（`noAutofill` を除く）。プロフィール・日付の導出（`DATE_KEYS`）・Jev に伏せる値はこちらから作る。
 * @type {readonly ProfileField[]}
 */
export const AUTOFILL_FIELDS = PROFILE_FIELDS.filter((field) => field.noAutofill !== true)

/** @type {readonly string[]} */
export const PROFILE_KEYS = AUTOFILL_FIELDS.map((field) => field.key)

/**
 * @typedef {Record<string, string>} AutofillProfile
 *   `PROFILE_KEYS` の全キーを持つ（`noAutofill` の項目は持たない）。未入力は空文字列。
 */

/** 性別の表示名（kypr の `GENDER_LABELS` と同じ）。 */
export const GENDER_LABELS = /** @type {Record<string, string>} */ ({
  '': '未設定',
  male: '男性',
  female: '女性',
  other: 'その他'
})

/**
 * kypr の個人情報の平文（camelCase）をプロフィール（snake_case）にする。`normalizeProfile` を通す
 * （日付・性別の形が違う値・上限を超えた値は空にする。kypr は読むときに形を見ないので、ここで見る）。
 *
 * @param {Record<string, unknown>} values
 * @returns {AutofillProfile}
 */
export function profileFromKypr(values) {
  /** @type {Record<string, unknown>} */
  const raw = {}
  for (const field of AUTOFILL_FIELDS) raw[field.key] = values[field.kypr]
  return normalizeProfile(raw)
}

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
  for (const field of AUTOFILL_FIELDS) {
    if (field.type === 'date' && profile[field.key] && !isValidDate(profile[field.key] ?? ''))
      profile[field.key] = ''
  }
  if (!GENDERS.includes(profile['gender'] ?? '')) profile['gender'] = ''
  return profile
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
