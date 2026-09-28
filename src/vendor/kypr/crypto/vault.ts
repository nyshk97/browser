import { b64Encode, randomBytes } from "./encoding.ts";
import { KEY_BYTES, open, seal } from "./envelope.ts";
import type { Envelope } from "./envelope-shape.ts";
import { KyprCryptoError } from "./errors.ts";
import { deriveKeys } from "./kdf.ts";
import { ARGON2_VERSION, DEFAULT_KDF, type KdfParams, parseKdfParams, SALT_BYTES } from "./params.ts";

export function generateVaultKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(KEY_BYTES);
}

export function newKdfParams(opts: { m?: number; t?: number } = {}): KdfParams {
  return parseKdfParams({
    alg: "argon2id",
    v: ARGON2_VERSION,
    m: opts.m ?? DEFAULT_KDF.m,
    t: opts.t ?? DEFAULT_KDF.t,
    p: 1,
    salt: b64Encode(randomBytes(SALT_BYTES)),
  });
}

export function wrapVaultKey(wrapKey: Uint8Array, vaultKey: Uint8Array, nonce?: Uint8Array): Promise<Envelope> {
  return seal(wrapKey, vaultKey, nonce);
}

// 展開の失敗 = マスターパスワード違い（bad-password）。形の不正だけは malformed
export async function unwrapVaultKey(wrapKey: Uint8Array, wrapped: unknown): Promise<Uint8Array> {
  const vaultKey = await open(wrapKey, wrapped);
  if (vaultKey === null) throw new KyprCryptoError("bad-password", "マスターパスワードが違う");
  if (vaultKey.length !== KEY_BYTES) throw new KyprCryptoError("malformed", "保管庫鍵の長さが違う");
  return vaultKey;
}

export interface NewAccount {
  kdf: KdfParams;
  authKey: Uint8Array;
  vaultKey: Uint8Array;
  wrappedVaultKey: Envelope;
}

export async function createAccount(password: string, opts: { m?: number; t?: number } = {}): Promise<NewAccount> {
  const kdf = newKdfParams(opts);
  const { authKey, wrapKey } = await deriveKeys(password, kdf);
  const vaultKey = generateVaultKey();
  const wrappedVaultKey = await wrapVaultKey(wrapKey, vaultKey);
  wrapKey.fill(0);
  return { kdf, authKey, vaultKey, wrappedVaultKey };
}

export async function unlockVault(password: string, kdf: KdfParams, wrapped: unknown) {
  const { authKey, wrapKey } = await deriveKeys(password, kdf);
  try {
    const vaultKey = await unwrapVaultKey(wrapKey, wrapped);
    return { authKey, vaultKey };
  } finally {
    wrapKey.fill(0);
  }
}
