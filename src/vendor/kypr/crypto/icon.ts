// サイトのアイコン（type: "icon"）。Nemo が履歴の favicon を PNG にして書き、Web・iOS・Nemo がログインのアイコンに使う。
// 形は docs/crypto-spec.md「サイトのアイコン」
import { b64Decode, bytes, utf8Encode } from "./encoding.ts";
import { hkdf32 } from "./kdf.ts";

export const INFO_ICON_ID = "kypr-icon-id-v1";

// data: URI の長さの上限（書く側は PNG を 8KB までにする。base64 にすると 11,000 文字ほど）
export const ICON_DATA_URI_MAX = 12000;

const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// アイコンの平文（schema 1）。知らないキーは保存し直すときもそのまま残す
export interface IconItem {
  id: string;
  type: "icon";
  schema: 1;
  host: string;
  dataUri: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

// 使えるアイコン（読む側の検査を通ったもの）
export interface UsableIcon {
  host: string;
  dataUri: string;
  updatedAt: string;
}

// 正規化したホストの形か（小文字の ASCII・空白や / を含まない・先頭に www. が無い）
export function isIconHost(host: unknown): host is string {
  return typeof host === "string" && /^[\x21-\x7e]+$/.test(host) && !/[A-Z/?#@\\]/.test(host) && !host.startsWith("www.");
}

// PNG の data: URI で、上限の長さ以内か
export function isIconDataUri(x: unknown): x is string {
  if (typeof x !== "string" || x.length > ICON_DATA_URI_MAX || !x.startsWith(PNG_PREFIX)) return false;
  let png: Uint8Array;
  try {
    png = b64Decode(x.slice(PNG_PREFIX.length));
  } catch {
    return false;
  }
  return png.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => png[i] === b);
}

// 読んだアイコンの平文を、使えるなら host・dataUri にする。形が違えば null（アイテムは壊れた扱いにせず、使わないだけ）。
// id がホストから作った id と合うかは、鍵が要るので呼び出し側（VaultSession）が見る
export function usableIcon(raw: Record<string, unknown>): UsableIcon | null {
  if (raw.schema !== 1 || !isIconHost(raw.host) || !isIconDataUri(raw.dataUri) || typeof raw.updatedAt !== "string") {
    return null;
  }
  return { host: raw.host, dataUri: raw.dataUri, updatedAt: raw.updatedAt };
}

// アイコンの id のための HMAC の鍵（iconKey = HKDF(vaultKey, "kypr-icon-id-v1")）
export async function iconIdKey(vaultKey: Uint8Array): Promise<CryptoKey> {
  const iconKey = await hkdf32(vaultKey, INFO_ICON_ID);
  try {
    return await crypto.subtle.importKey("raw", iconKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  } finally {
    iconKey.fill(0);
  }
}

// id = HMAC-SHA256(iconKey, UTF-8(host)) の先頭 16 バイトに UUIDv4 の version / variant のビットを立てたもの。
// ホストから決まるので、複数の端末が同じホストのアイコンを作っても重複しない（後の側が 409 になる）
export async function iconId(key: CryptoKey, host: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(utf8Encode(host))));
  const b = mac.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newIconItem(id: string, host: string, dataUri: string): IconItem {
  const now = new Date().toISOString();
  return { id, type: "icon", schema: 1, host, dataUri, createdAt: now, updatedAt: now };
}
