import { b64Decode } from "./encoding.ts";
import { KyprCryptoError } from "./errors.ts";

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

// 暗号文の封筒。c は暗号文の末尾に 16 バイトの認証タグを付けたもの
export interface Envelope {
  v: 1;
  alg: "A256GCM";
  n: string;
  c: string;
}

export function parseEnvelope(x: unknown): Envelope {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new KyprCryptoError("malformed", "封筒がオブジェクトでない");
  }
  const { v, alg, n, c } = x as Record<string, unknown>;
  if (v !== 1 || alg !== "A256GCM") throw new KyprCryptoError("malformed", "封筒の版か方式が違う");
  if (b64Decode(n).length !== NONCE_BYTES) throw new KyprCryptoError("malformed", "nonce の長さが違う");
  if (b64Decode(c).length < TAG_BYTES) throw new KyprCryptoError("malformed", "暗号文が短すぎる");
  return { v, alg, n: n as string, c: c as string };
}
