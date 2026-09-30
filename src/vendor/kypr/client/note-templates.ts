// セキュアメモのテンプレート（銀行口座・Wi-Fi など）と、項目の扱い（検索・Wi-Fi の QR・振込先のまとめコピー）。
// 平文の形は crypto-spec.md の「セキュアメモ」。テンプレートの中身（ラベル・並び）は形式ではなく、この表が正。
// iOS に写しがある（apps/ios/KyprCore/NoteTemplates.swift）。表を変えたらそちらも直す（テンプレートの表はテストベクタ noteTemplates で照合する）
import type { NoteField, NoteItem } from "../crypto/index.ts";

export interface NoteTemplateField {
  key: string;
  label: string;
  secret?: true;
  multiline?: true;
}

export interface NoteTemplate {
  id: string;
  name: string;
  fields: readonly NoteTemplateField[];
}

// 新規作成で選ぶ順
export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: "bank",
    name: "銀行口座",
    fields: [
      { key: "bankName", label: "銀行名" },
      { key: "bankCode", label: "金融機関コード" },
      { key: "branchName", label: "支店名" },
      { key: "branchCode", label: "支店番号" },
      { key: "accountType", label: "口座種別" },
      { key: "accountNumber", label: "口座番号" },
      { key: "accountHolder", label: "口座名義（カナ）" },
      { key: "pin", label: "キャッシュカードの暗証番号", secret: true },
      { key: "contractNumber", label: "ネットバンキングの契約番号" },
    ],
  },
  {
    id: "brokerage",
    name: "証券口座",
    fields: [
      { key: "company", label: "証券会社" },
      { key: "branchName", label: "支店" },
      { key: "accountNumber", label: "口座番号" },
      { key: "accountKind", label: "口座区分" },
      { key: "tradePin", label: "取引暗証番号", secret: true },
    ],
  },
  {
    id: "wifi",
    name: "Wi-Fi",
    fields: [
      { key: "ssid", label: "ネットワーク名" },
      { key: "password", label: "パスワード", secret: true },
      { key: "security", label: "暗号化方式" },
      { key: "routerModel", label: "ルーターの機種" },
      { key: "adminUrl", label: "管理画面の URL" },
      { key: "adminPassword", label: "管理者パスワード", secret: true },
    ],
  },
  {
    id: "apiKey",
    name: "API キー",
    fields: [
      { key: "service", label: "サービス" },
      { key: "key", label: "キー", secret: true },
      { key: "envName", label: "環境変数名" },
      { key: "scope", label: "権限・スコープ" },
      { key: "expiry", label: "有効期限" },
      { key: "consoleUrl", label: "発行した管理画面の URL" },
    ],
  },
  {
    id: "server",
    name: "データベース・サーバー",
    fields: [
      { key: "kind", label: "種類" },
      { key: "host", label: "ホスト" },
      { key: "port", label: "ポート" },
      { key: "username", label: "ユーザー名" },
      { key: "password", label: "パスワード", secret: true },
      { key: "database", label: "データベース名" },
      { key: "connectionString", label: "接続文字列", secret: true },
    ],
  },
  {
    id: "license",
    name: "ソフトウェアライセンス",
    fields: [
      { key: "product", label: "製品名" },
      { key: "licenseKey", label: "ライセンスキー", multiline: true },
      { key: "email", label: "登録メールアドレス" },
      { key: "purchasedAt", label: "購入日" },
      { key: "order", label: "購入元・注文番号" },
    ],
  },
  {
    id: "recovery",
    name: "リカバリーコード",
    fields: [
      { key: "service", label: "サービス" },
      { key: "codes", label: "コード", secret: true, multiline: true },
      { key: "issuedAt", label: "発行日" },
    ],
  },
];

// 知らない id・"" は null（普通のメモとして出す）
export function noteTemplate(id: string): NoteTemplate | null {
  return NOTE_TEMPLATES.find((t) => t.id === id) ?? null;
}

// テンプレートから空の項目を作る
export function templateFields(id: string): NoteField[] {
  return (noteTemplate(id)?.fields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    value: "",
    secret: f.secret ?? false,
    multiline: f.multiline ?? false,
  }));
}

// 自分で足す項目
export function customField(label = ""): NoteField {
  return { key: "", label, value: "", secret: false, multiline: false };
}

// key で値を探す（ラベルは書き換えられるので key で見る）。同じ key が 2 つあれば最初のもの。無ければ ""
export function fieldValue(fields: readonly NoteField[], key: string): string {
  return fields.find((f) => f.key === key)?.value ?? "";
}

// 一覧の 2 行目: テンプレート名。テンプレートなし（知らないものを含む）は「セキュアメモ」
export function noteSummary(item: Pick<NoteItem, "template">): string {
  return noteTemplate(item.template)?.name ?? "セキュアメモ";
}

// 検索の対象に足す文字列: 伏せ字でない項目の値（口座番号・ホスト名で引けるように）。伏せ字の値は対象にしない
export function noteSearchText(item: Pick<NoteItem, "fields">): string {
  return item.fields
    .filter((f) => !f.secret)
    .map((f) => f.value)
    .join("\n");
}

// Wi-Fi の QR の文字列（WIFI:T:…;S:…;P:…;;）。ネットワーク名が空なら null（QR を出さない）
export function wifiQrText(fields: readonly NoteField[]): string | null {
  const ssid = fieldValue(fields, "ssid");
  if (ssid === "") return null;
  const password = fieldValue(fields, "password");
  const type = password === "" ? "nopass" : /WEP/i.test(fieldValue(fields, "security")) ? "WEP" : "WPA";
  const esc = (s: string) => s.replace(/[\\;,:"]/g, (c) => `\\${c}`);
  return `WIFI:T:${type};S:${esc(ssid)};${type === "nopass" ? "" : `P:${esc(password)};`};`;
}

// 振込先のまとめコピー（銀行名 支店名 口座種別 口座番号 口座名義。空の項目は詰める）。口座番号が空なら null（ボタンを出さない）
export function bankTransferText(fields: readonly NoteField[]): string | null {
  if (fieldValue(fields, "accountNumber").trim() === "") return null;
  return ["bankName", "branchName", "accountType", "accountNumber", "accountHolder"]
    .map((k) => fieldValue(fields, k).trim())
    .filter((v) => v !== "")
    .join(" ");
}
