import { b64Decode } from "./encoding.ts";
import { KyprCryptoError } from "./errors.ts";

// KDF パラメータの許容範囲。上限はタブを落とさないため、下限はダウングレード攻撃を防ぐため
export const KDF_BOUNDS = {
  mMinKiB: 64 * 1024,
  mMaxKiB: 1024 * 1024,
  tMin: 3,
  tMax: 10,
} as const;

export const DEFAULT_KDF = { m: 64 * 1024, t: 3 } as const;
export const SALT_BYTES = 16;
export const ARGON2_VERSION = 0x13;

export interface KdfParams {
  alg: "argon2id";
  v: typeof ARGON2_VERSION;
  m: number; // KiB
  t: number;
  p: 1;
  salt: string; // base64（16 バイト）
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// 形が不正なら malformed、範囲の外なら invalid-params。KDF を走らせる前に必ず通す
export function parseKdfParams(x: unknown): KdfParams {
  if (!isObject(x)) throw new KyprCryptoError("malformed", "KDF パラメータがオブジェクトでない");
  const { alg, v, m, t, p, salt } = x;
  if (alg !== "argon2id" || v !== ARGON2_VERSION) {
    throw new KyprCryptoError("malformed", "KDF の種類かバージョンが違う");
  }
  if (!Number.isInteger(m) || !Number.isInteger(t) || !Number.isInteger(p)) {
    throw new KyprCryptoError("malformed", "KDF パラメータが整数でない");
  }
  const mm = m as number;
  const tt = t as number;
  if (mm < KDF_BOUNDS.mMinKiB || mm > KDF_BOUNDS.mMaxKiB) {
    throw new KyprCryptoError("invalid-params", `m=${mm} KiB は許容範囲の外`);
  }
  if (tt < KDF_BOUNDS.tMin || tt > KDF_BOUNDS.tMax) {
    throw new KyprCryptoError("invalid-params", `t=${tt} は許容範囲の外`);
  }
  if (p !== 1) throw new KyprCryptoError("invalid-params", `p=${String(p)} は扱えない（1 のみ）`);
  if (b64Decode(salt).length !== SALT_BYTES) {
    throw new KyprCryptoError("malformed", "salt の長さが 16 バイトでない");
  }
  return { alg, v, m: mm, t: tt, p: 1, salt: salt as string };
}

// 前回使ったパラメータより弱くなっていたら、ダウングレードを疑って止める
export function isWeakerKdf(prev: KdfParams, next: KdfParams): boolean {
  return next.m < prev.m || next.t < prev.t;
}
