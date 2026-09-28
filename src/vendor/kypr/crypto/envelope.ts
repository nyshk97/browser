import { b64Decode, b64Encode, bytes, randomBytes } from "./encoding.ts";
import { type Envelope, NONCE_BYTES, parseEnvelope } from "./envelope-shape.ts";
import { KyprCryptoError } from "./errors.ts";

export const KEY_BYTES = 32;

function importAesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) throw new KyprCryptoError("malformed", "鍵の長さが 32 バイトでない");
  return crypto.subtle.importKey("raw", bytes(key), "AES-GCM", false, [usage]);
}

// nonce は毎回ランダム。引数で渡すのはテストベクタを作るときだけ
export async function seal(key: Uint8Array, plaintext: Uint8Array, nonce?: Uint8Array): Promise<Envelope> {
  const n = nonce ? bytes(nonce) : randomBytes(NONCE_BYTES);
  if (n.length !== NONCE_BYTES) throw new KyprCryptoError("malformed", "nonce の長さが違う");
  const k = await importAesKey(key, "encrypt");
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: n }, k, bytes(plaintext)));
  return { v: 1, alg: "A256GCM", n: b64Encode(n), c: b64Encode(c) };
}

// 認証に失敗したら null を返す。「鍵違い」か「改竄」かは呼び出し側の文脈で決める
export async function open(key: Uint8Array, envelope: unknown): Promise<Uint8Array | null> {
  const env = parseEnvelope(envelope);
  const k = await importAesKey(key, "decrypt");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64Decode(env.n) }, k, b64Decode(env.c));
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
