import { KyprCryptoError } from "./errors.ts";

// WebCrypto の型（BufferSource）は ArrayBuffer 裏付けの view しか受けないので、ここで揃える
export function bytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

export function utf8Encode(s: string): Uint8Array<ArrayBuffer> {
  // Workers の型定義（@cloudflare/workers-types）では ArrayBufferLike に広がるので揃える
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    throw new KyprCryptoError("malformed", "UTF-8 として読めない");
  }
}

// マスターパスワードは NFC に正規化してから UTF-8 にする。trim はしない
export function normalizePassword(password: string): Uint8Array<ArrayBuffer> {
  return utf8Encode(password.normalize("NFC"));
}

export function b64Encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// 標準のアルファベット・パディングありの正規形だけを受け付ける
export function b64Decode(s: unknown): Uint8Array<ArrayBuffer> {
  if (typeof s !== "string" || !B64_RE.test(s)) {
    throw new KyprCryptoError("malformed", "base64 の形式が不正");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64Encode(out) !== s) {
    throw new KyprCryptoError("malformed", "base64 が正規形でない");
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new KyprCryptoError("malformed", "hex の形式が不正");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}
