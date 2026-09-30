import { utf8Decode, utf8Encode } from "./encoding.ts";
import { open, seal } from "./envelope.ts";
import type { Envelope } from "./envelope-shape.ts";
import { KyprCryptoError } from "./errors.ts";
import { TOTP_DEFAULTS } from "./totp.ts";

export interface LoginUri {
  uri: string;
  match?: number | null;
  [key: string]: unknown;
}

// ログインアイテムの平文（schema 1）。知らないキーは保存し直すときもそのまま残す
export interface LoginItem {
  id: string;
  type: "login";
  schema: 1;
  name: string;
  username: string;
  password: string;
  uris: LoginUri[];
  notes: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

// 項目（ラベル・値）。今はセキュアメモだけが読み書きする。key はテンプレートの項目の固定の名前（自分で足した項目は ""）。
// 要素の中の知らないキーは保存し直すときもそのまま残す
export interface NoteField {
  key: string;
  label: string;
  value: string;
  secret: boolean;
  multiline: boolean;
  [key: string]: unknown;
}

// セキュアメモの平文（schema 1）。本文はプレーンテキスト。template は "" でテンプレートなし（知らない値は普通のメモとして出す）
export interface NoteItem {
  id: string;
  type: "note";
  schema: 1;
  name: string;
  template: string;
  fields: NoteField[];
  notes: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

// カードの平文（schema 1）。項目は Bitwarden のカードと同じ名前にしている
export interface CardItem {
  id: string;
  type: "card";
  schema: 1;
  name: string;
  cardholderName: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  code: string;
  notes: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

// 個人情報の項目（フォームの自動入力に使う）。日付は YYYY-MM-DD、性別は "" / "male" / "female" / "other"。
// 形は読むときに検査しない（編集画面と自動入力の側で見る）。**無いキーは空文字として読む**ので、
// 項目を足しても schema を上げなくてよい
export const IDENTITY_KEYS = [
  "familyName",
  "givenName",
  "familyNameKana",
  "givenNameKana",
  "familyNameRoman",
  "givenNameRoman",
  "email",
  "tel",
  "postalCode",
  "addressLevel1",
  "addressLevel2",
  "addressLine1",
  "addressLine2",
  "addressLevel1En",
  "addressLevel2En",
  "addressLine1En",
  "addressLine2En",
  "countryEn",
  "birthday",
  "gender",
  "organization",
  "department",
  "jobTitle",
  "organizationUrl",
  "passportNumber",
  "passportIssueDate",
  "passportExpiry",
  "licenseNumber",
  "licenseIssueDate",
  "licenseExpiry",
  "licensePin1",
  "licensePin2",
  "myNumber",
  "myNumberCardExpiry",
  "myNumberCertExpiry",
  "myNumberSignPassword",
  "myNumberAuthPin",
  "myNumberResidentPin",
  "myNumberInfoPin",
  "insuranceSymbol",
  "insuranceNumber",
  "insuranceBranch",
  "insurerNumber",
  "pensionNumber",
] as const;

export type IdentityKey = (typeof IDENTITY_KEYS)[number];

// 個人情報の平文（schema 1）
export type IdentityItem = {
  id: string;
  type: "identity";
  schema: 1;
  name: string;
  notes: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
} & Record<IdentityKey, string>;

// ワンタイムコード（TOTP）の平文（schema 1）。name は発行元、account はラベル。
// 無いキーは既定値で読む（normalizeTotpItem）。値の中身（アルゴリズム名・Base32・範囲）は読むときに見ない（totpProblem で見る）
export interface TotpItem {
  id: string;
  type: "totp";
  schema: 1;
  name: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  uris: LoginUri[];
  notes: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export type VaultItem = LoginItem | NoteItem | CardItem | IdentityItem | TotpItem;

// 知らない type / schema のアイテムは読み取り専用で扱う
export type DecryptedItem =
  | { kind: "login"; item: LoginItem }
  | { kind: "note"; item: NoteItem }
  | { kind: "card"; item: CardItem }
  | { kind: "identity"; item: IdentityItem }
  | { kind: "totp"; item: TotpItem }
  | { kind: "unknown"; raw: Record<string, unknown> & { id: string } };

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function isUriList(x: unknown): x is LoginUri[] {
  return (
    Array.isArray(x) &&
    x.every(
      (u) =>
        isObject(u) &&
        typeof u.uri === "string" &&
        (u.match === undefined || u.match === null || Number.isInteger(u.match)),
    )
  );
}

export function isLoginItem(x: Record<string, unknown>): x is LoginItem {
  return (
    x.type === "login" &&
    x.schema === 1 &&
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    typeof x.username === "string" &&
    typeof x.password === "string" &&
    typeof x.notes === "string" &&
    isUriList(x.uris) &&
    isObject(x.extra) &&
    typeof x.createdAt === "string" &&
    ISO_UTC_RE.test(x.createdAt) &&
    typeof x.updatedAt === "string" &&
    ISO_UTC_RE.test(x.updatedAt)
  );
}

function hasCommonFields(x: Record<string, unknown>): boolean {
  return (
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    typeof x.notes === "string" &&
    isObject(x.extra) &&
    typeof x.createdAt === "string" &&
    ISO_UTC_RE.test(x.createdAt) &&
    typeof x.updatedAt === "string" &&
    ISO_UTC_RE.test(x.updatedAt)
  );
}

// 項目の並びとして読めるか。要素のキーの型だけを見る（無い key は ""、無い secret / multiline は false として読む）
function isFieldList(x: unknown): boolean {
  const optString = (v: unknown) => v === undefined || typeof v === "string";
  const optBool = (v: unknown) => v === undefined || typeof v === "boolean";
  return (
    Array.isArray(x) &&
    x.every(
      (f) =>
        isObject(f) &&
        optString(f.key) &&
        typeof f.label === "string" &&
        typeof f.value === "string" &&
        optBool(f.secret) &&
        optBool(f.multiline),
    )
  );
}

// セキュアメモとして読めるか。あるキーの型だけを見る（無い template / fields は normalizeNoteItem が既定値で埋める）
export function isNoteItem(x: Record<string, unknown>): boolean {
  return (
    x.type === "note" &&
    x.schema === 1 &&
    hasCommonFields(x) &&
    (x.template === undefined || typeof x.template === "string") &&
    (x.fields === undefined || isFieldList(x.fields))
  );
}

// 無いキーを既定値で埋めて NoteItem にする（知らないキーは要素の中も残す）。isNoteItem が true のものだけ渡す
export function normalizeNoteItem(x: Record<string, unknown>): NoteItem {
  const fields = ((x.fields ?? []) as Record<string, unknown>[]).map((f) => ({
    ...f,
    key: f.key ?? "",
    secret: f.secret ?? false,
    multiline: f.multiline ?? false,
  }));
  return { ...x, template: x.template ?? "", fields } as NoteItem;
}

export function newNoteItem(fields: Partial<Omit<NoteItem, "id" | "type" | "schema">> = {}): NoteItem {
  const now = nowIso();
  return {
    name: "",
    template: "",
    fields: [],
    notes: "",
    extra: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
    id: crypto.randomUUID(),
    type: "note",
    schema: 1,
  };
}

const CARD_FIELDS = ["cardholderName", "brand", "number", "expMonth", "expYear", "code"] as const;

export function isCardItem(x: Record<string, unknown>): x is CardItem {
  return x.type === "card" && x.schema === 1 && hasCommonFields(x) && CARD_FIELDS.every((k) => typeof x[k] === "string");
}

export function newCardItem(fields: Partial<Omit<CardItem, "id" | "type" | "schema">> = {}): CardItem {
  const now = nowIso();
  return {
    name: "",
    cardholderName: "",
    brand: "",
    number: "",
    expMonth: "",
    expYear: "",
    code: "",
    notes: "",
    extra: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
    id: crypto.randomUUID(),
    type: "card",
    schema: 1,
  };
}

// 個人情報として読めるか。あるキーが文字列であることだけを見る（無いキーは normalizeIdentityItem が空文字で埋める）。
// 型の判定（x is IdentityItem）にしないのは、無いキーが undefined のまま IdentityItem として出回らないようにするため
export function isIdentityItem(x: Record<string, unknown>): boolean {
  return (
    x.type === "identity" &&
    x.schema === 1 &&
    hasCommonFields(x) &&
    IDENTITY_KEYS.every((k) => x[k] === undefined || typeof x[k] === "string")
  );
}

// 無いキーを空文字で埋めて IdentityItem にする（知らないキーは残す）。isIdentityItem が true のものだけ渡す
export function normalizeIdentityItem(x: Record<string, unknown>): IdentityItem {
  const filled = { ...x };
  for (const k of IDENTITY_KEYS) if (filled[k] === undefined) filled[k] = "";
  return filled as IdentityItem;
}

export function newIdentityItem(fields: Partial<Omit<IdentityItem, "id" | "type" | "schema">> = {}): IdentityItem {
  const now = nowIso();
  const empty = Object.fromEntries(IDENTITY_KEYS.map((k) => [k, ""])) as Record<IdentityKey, string>;
  return {
    name: "",
    ...empty,
    notes: "",
    extra: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
    id: crypto.randomUUID(),
    type: "identity",
    schema: 1,
  } as IdentityItem;
}

// ワンタイムコードとして読めるか。あるキーの型だけを見る（無いキーは normalizeTotpItem が既定値で埋める）
export function isTotpItem(x: Record<string, unknown>): boolean {
  const optString = (k: string) => x[k] === undefined || typeof x[k] === "string";
  const optInt = (k: string) => x[k] === undefined || Number.isInteger(x[k]);
  return (
    x.type === "totp" &&
    x.schema === 1 &&
    hasCommonFields(x) &&
    optString("account") &&
    optString("secret") &&
    optString("algorithm") &&
    optInt("digits") &&
    optInt("period") &&
    (x.uris === undefined || isUriList(x.uris))
  );
}

// 無いキーを既定値で埋めて TotpItem にする（知らないキーは残す）。isTotpItem が true のものだけ渡す
export function normalizeTotpItem(x: Record<string, unknown>): TotpItem {
  return {
    ...x,
    account: x.account ?? "",
    secret: x.secret ?? "",
    algorithm: x.algorithm ?? TOTP_DEFAULTS.algorithm,
    digits: x.digits ?? TOTP_DEFAULTS.digits,
    period: x.period ?? TOTP_DEFAULTS.period,
    uris: x.uris ?? [],
  } as TotpItem;
}

export function newTotpItem(fields: Partial<Omit<TotpItem, "id" | "type" | "schema">> = {}): TotpItem {
  const now = nowIso();
  return {
    name: "",
    account: "",
    secret: "",
    algorithm: TOTP_DEFAULTS.algorithm,
    digits: TOTP_DEFAULTS.digits,
    period: TOTP_DEFAULTS.period,
    uris: [],
    notes: "",
    extra: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
    id: crypto.randomUUID(),
    type: "totp",
    schema: 1,
  };
}

export function newLoginItem(fields: Partial<Omit<LoginItem, "id" | "type" | "schema">> = {}): LoginItem {
  const now = nowIso();
  return {
    name: "",
    username: "",
    password: "",
    uris: [],
    notes: "",
    extra: {},
    createdAt: now,
    updatedAt: now,
    ...fields,
    id: crypto.randomUUID(),
    type: "login",
    schema: 1,
  };
}

export function encryptItem(vaultKey: Uint8Array, item: { id: string }, nonce?: Uint8Array): Promise<Envelope> {
  return seal(vaultKey, utf8Encode(JSON.stringify(item)), nonce);
}

// 保管庫鍵は展開できている前提なので、認証失敗と id の不一致は改竄（tampered）とみなす
export async function decryptItem(vaultKey: Uint8Array, id: string, envelope: unknown): Promise<DecryptedItem> {
  const pt = await open(vaultKey, envelope);
  if (pt === null) throw new KyprCryptoError("tampered", "アイテムの認証に失敗した");
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(pt));
  } catch {
    throw new KyprCryptoError("malformed", "アイテムの平文が JSON でない");
  }
  if (!isObject(parsed) || typeof parsed.id !== "string") {
    throw new KyprCryptoError("malformed", "アイテムの平文の形が不正");
  }
  if (parsed.id !== id) throw new KyprCryptoError("tampered", "アイテムの id が一致しない");
  if (parsed.type === "login" && parsed.schema === 1) {
    if (!isLoginItem(parsed)) throw new KyprCryptoError("malformed", "ログインアイテムの項目が不正");
    return { kind: "login", item: parsed };
  }
  if (parsed.type === "note" && parsed.schema === 1) {
    if (!isNoteItem(parsed)) throw new KyprCryptoError("malformed", "セキュアメモの項目が不正");
    return { kind: "note", item: normalizeNoteItem(parsed) };
  }
  if (parsed.type === "card" && parsed.schema === 1) {
    if (!isCardItem(parsed)) throw new KyprCryptoError("malformed", "カードの項目が不正");
    return { kind: "card", item: parsed };
  }
  if (parsed.type === "identity" && parsed.schema === 1) {
    if (!isIdentityItem(parsed)) throw new KyprCryptoError("malformed", "個人情報の項目が不正");
    return { kind: "identity", item: normalizeIdentityItem(parsed) };
  }
  if (parsed.type === "totp" && parsed.schema === 1) {
    if (!isTotpItem(parsed)) throw new KyprCryptoError("malformed", "ワンタイムコードの項目が不正");
    return { kind: "totp", item: normalizeTotpItem(parsed) };
  }
  return { kind: "unknown", raw: parsed as Record<string, unknown> & { id: string } };
}
