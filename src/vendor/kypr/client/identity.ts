// 個人情報の表示と入力の並び。保存する値は crypto-spec.md の個人情報の節に従う
import type { IdentityItem, IdentityKey } from "../crypto/index.ts";

export type IdentityFieldKind = "text" | "date" | "gender";

export interface IdentityField {
  key: IdentityKey;
  label: string;
  group: string;
  hint: string;
  kind: IdentityFieldKind;
  // 詳細画面で伏せて表示し、表示・コピーの操作で出す（身分証の番号）
  secret?: true;
}

// 編集画面・詳細画面に出す順。グループはこの順で見出しになる
export const IDENTITY_FIELDS: readonly IdentityField[] = [
  { key: "familyName", label: "姓", group: "氏名", hint: "山田", kind: "text" },
  { key: "givenName", label: "名", group: "氏名", hint: "太郎", kind: "text" },
  { key: "familyNameKana", label: "セイ（カタカナ）", group: "氏名", hint: "ヤマダ", kind: "text" },
  { key: "givenNameKana", label: "メイ（カタカナ）", group: "氏名", hint: "タロウ", kind: "text" },
  { key: "familyNameRoman", label: "姓（ローマ字）", group: "氏名", hint: "Yamada", kind: "text" },
  { key: "givenNameRoman", label: "名（ローマ字）", group: "氏名", hint: "Taro", kind: "text" },
  { key: "email", label: "メールアドレス", group: "連絡先", hint: "taro@example.com", kind: "text" },
  { key: "tel", label: "電話番号", group: "連絡先", hint: "090-1234-5678", kind: "text" },
  { key: "postalCode", label: "郵便番号", group: "住所", hint: "100-0001", kind: "text" },
  { key: "addressLevel1", label: "都道府県", group: "住所", hint: "東京都", kind: "text" },
  { key: "addressLevel2", label: "市区町村", group: "住所", hint: "千代田区", kind: "text" },
  { key: "addressLine1", label: "町名・番地", group: "住所", hint: "千代田1-1", kind: "text" },
  { key: "addressLine2", label: "建物名・部屋番号", group: "住所", hint: "〇〇タワー 1701", kind: "text" },
  // 英語のフォーム（海外のサービスの請求先など）で使う。都道府県（Tokyo）と国（Japan）は使う側が作る
  { key: "addressLevel2En", label: "市区町村", group: "住所（英語）", hint: "Chiyoda-ku", kind: "text" },
  { key: "addressLine1En", label: "町名・番地", group: "住所（英語）", hint: "1-1 Chiyoda", kind: "text" },
  { key: "addressLine2En", label: "建物名・部屋番号", group: "住所（英語）", hint: "Sample Tower 1701", kind: "text" },
  { key: "birthday", label: "生年月日", group: "その他", hint: "2000-01-01", kind: "date" },
  { key: "gender", label: "性別", group: "その他", hint: "", kind: "gender" },
  { key: "organization", label: "会社名", group: "勤務先", hint: "株式会社〇〇", kind: "text" },
  { key: "department", label: "部署", group: "勤務先", hint: "開発部", kind: "text" },
  { key: "jobTitle", label: "役職", group: "勤務先", hint: "代表取締役", kind: "text" },
  { key: "organizationUrl", label: "会社 URL", group: "勤務先", hint: "https://example.com", kind: "text" },
  { key: "passportNumber", label: "旅券番号", group: "パスポート", hint: "TK1234567", kind: "text", secret: true },
  { key: "passportExpiry", label: "有効期限", group: "パスポート", hint: "2031-04-30", kind: "date" },
  { key: "licenseNumber", label: "免許証番号", group: "運転免許証", hint: "123456789012", kind: "text", secret: true },
  { key: "licenseExpiry", label: "有効期限", group: "運転免許証", hint: "2029-06-15", kind: "date" },
  { key: "insuranceSymbol", label: "記号", group: "健康保険証", hint: "1234", kind: "text", secret: true },
  { key: "insuranceNumber", label: "番号", group: "健康保険証", hint: "56", kind: "text", secret: true },
  { key: "insuranceBranch", label: "枝番", group: "健康保険証", hint: "01", kind: "text" },
  { key: "insurerNumber", label: "保険者番号", group: "健康保険証", hint: "06123456", kind: "text" },
];

export const GENDER_LABELS: Record<string, string> = { "": "未設定", male: "男性", female: "女性", other: "その他" };

// 見出しごとに並べる（IDENTITY_FIELDS の順を保つ）
export function identityGroups(): { group: string; fields: IdentityField[] }[] {
  const out: { group: string; fields: IdentityField[] }[] = [];
  for (const f of IDENTITY_FIELDS) {
    const last = out[out.length - 1];
    if (last && last.group === f.group) last.fields.push(f);
    else out.push({ group: f.group, fields: [f] });
  }
  return out;
}

// 日付は YYYY-MM-DD で実在する日だけ。空は許す
export function isValidIdentityDate(value: string): boolean {
  if (value === "") return true;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// 一覧の 2 行目: 氏名（無ければメール）
export function identitySummary(item: IdentityItem): string {
  const name = [item.familyName, item.givenName].filter(Boolean).join(" ");
  return name || item.email || "個人情報";
}
