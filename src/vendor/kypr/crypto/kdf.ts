import { argon2id } from "hash-wasm";
import { b64Decode, bytes, normalizePassword, utf8Encode } from "./encoding.ts";
import { type KdfParams, parseKdfParams } from "./params.ts";

export const INFO_AUTH = "kypr-auth-v1";
export const INFO_WRAP = "kypr-wrap-v1";
// 合言葉（新しい端末からログインするときの 2 つ目の要素）の検証値。暗号には使わない
export const INFO_PASSPHRASE = "kypr-passphrase-v1";

// masterKey = Argon2id(NFC(password), salt)。範囲の検証を通してから走らせる
export async function deriveMasterKey(password: string, params: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const p = parseKdfParams(params);
  const out = await argon2id({
    password: normalizePassword(password),
    salt: b64Decode(p.salt),
    iterations: p.t,
    parallelism: p.p,
    memorySize: p.m,
    hashLength: 32,
    outputType: "binary",
  });
  return bytes(out);
}

// HKDF-SHA256。salt は長さ 0（RFC 5869 により 32 バイトの 0 と同じ）、出力は 32 バイト
export async function hkdf32(ikm: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", bytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8Encode(info) },
    k,
    256,
  );
  return new Uint8Array(bits);
}

export interface DerivedKeys {
  authKey: Uint8Array<ArrayBuffer>;
  wrapKey: Uint8Array<ArrayBuffer>;
}

export async function deriveKeys(password: string, params: KdfParams): Promise<DerivedKeys> {
  const masterKey = await deriveMasterKey(password, params);
  const [authKey, wrapKey] = await Promise.all([hkdf32(masterKey, INFO_AUTH), hkdf32(masterKey, INFO_WRAP)]);
  masterKey.fill(0);
  return { authKey, wrapKey };
}

// passphraseKey = HKDF(Argon2id(NFC(合言葉), アカウントの KDF パラメータ), "kypr-passphrase-v1")。
// サーバーは SHA-256(passphraseKey) だけを持つ（authKey と同じ扱い）。合言葉は暗号には混ぜない
export async function derivePassphraseKey(passphrase: string, params: KdfParams): Promise<Uint8Array<ArrayBuffer>> {
  const stretched = await deriveMasterKey(passphrase, params);
  const key = await hkdf32(stretched, INFO_PASSPHRASE);
  stretched.fill(0);
  return key;
}
