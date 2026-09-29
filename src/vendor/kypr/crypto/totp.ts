import { bytes } from "./encoding.ts";

// ワンタイムコード（TOTP。RFC 6238）の計算と Base32。仕様は docs/crypto-spec.md「ワンタイムコード（TOTP）」
// CLI（オフライン復号）からも使うので packages/crypto に置く。otpauth URI の読み取りなど画面寄りのものは packages/client/src/totp.ts

export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

export const TOTP_DEFAULTS = { algorithm: "SHA1", digits: 6, period: 30 } as const;

export interface TotpParams {
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
}

// コードを出せない理由。判定は仕様書の表の順
export type TotpProblem = "empty-secret" | "bad-secret" | "unknown-algorithm" | "bad-digits" | "bad-period";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// 空白・"-"・"=" を除いて大文字にする
export function normalizeTotpSecret(secret: string): string {
  return secret.replace(/[\s\-=]/g, "").toUpperCase();
}

// 正規化してから読む。読めなければ null（空文字は空の配列）。余りのビットは捨てる
export function base32Decode(secret: string): Uint8Array | null {
  const s = normalizeTotpSecret(secret);
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    buf = ((buf << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// パディング（=）なし
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = ((buf << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buf >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

export function isTotpAlgorithm(a: string): a is TotpAlgorithm {
  return (TOTP_ALGORITHMS as readonly string[]).includes(a);
}

export function totpProblem(p: TotpParams): TotpProblem | null {
  const s = normalizeTotpSecret(p.secret);
  if (s === "") return "empty-secret";
  if (base32Decode(s) === null) return "bad-secret";
  if (!isTotpAlgorithm(p.algorithm)) return "unknown-algorithm";
  if (!Number.isInteger(p.digits) || p.digits < 6 || p.digits > 8) return "bad-digits";
  if (!Number.isInteger(p.period) || p.period < 1) return "bad-period";
  return null;
}

const HASH: Record<TotpAlgorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

// unixSeconds の時点のコード。出せないパラメータなら投げる（先に totpProblem で見る）
export async function totpCode(p: TotpParams, unixSeconds: number): Promise<string> {
  const problem = totpProblem(p);
  if (problem) throw new Error(`TOTP のコードを出せない: ${problem}`);
  const key = base32Decode(p.secret)!;
  const counter = Math.floor(unixSeconds / p.period);
  const msg = new Uint8Array(8);
  // 2^53 までの整数を 8 バイトのビッグエンディアンに（上位 32 ビットと下位 32 ビットに分ける）
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey(
    "raw",
    bytes(key),
    { name: "HMAC", hash: HASH[p.algorithm as TotpAlgorithm] },
    false,
    ["sign"],
  );
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** p.digits).padStart(p.digits, "0");
}

// 今の周期が終わるまでの秒数（1〜period）
export function totpRemaining(period: number, unixSeconds: number): number {
  return period - (Math.floor(unixSeconds) % period);
}
