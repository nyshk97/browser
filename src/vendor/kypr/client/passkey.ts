// パスキーの認証器（docs/crypto-spec.md「パスキー」）。鍵の生成・authenticatorData・attestationObject・署名と、
// 保管庫からの候補の選び方・入れるログインの判定・rpId の検証。Nemo（main の Node）と Web が使う。
// iOS は KyprCore/Passkey.swift に写しがある（バイト列はテストベクタ passkeyAuthenticator で照合する）。
//
// サインインの署名は clientDataJSON でなく **clientDataHash**（SHA-256）を受け取る。iOS は OS から clientDataHash だけが
// 来るので、入口をそれに揃えている（Nemo は組み立てた JSON を SHA-256 して渡す）。登録は attestation が none なので
// clientData に署名せず、受け取らない
import {
  b64urlDecode,
  b64urlEncode,
  bytes,
  isPasskeyOnlyLogin,
  type LoginItem,
  loginPasskeys,
  newLoginItem,
  nowIso,
  type Passkey,
  randomBytes,
  utf8Encode,
} from "../crypto/index.ts";
import { loginMatchesPage, type PublicSuffixList, publicSuffixList } from "./url-match.ts";

// 対応する方式は ES256（COSE の -7）だけ
export const ES256 = -7;

// AAGUID は 16 バイトの 0（attestation は none なので、認証器の種類は名乗らない）
export const PASSKEY_AAGUID = new Uint8Array(16);

// authenticatorData のフラグ
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;

// 同期するパスキーなので BE（バックアップ可）と BS（バックアップ済み）を立てる。本人確認（UV）は毎回する
export const ASSERTION_FLAGS = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;
export const REGISTRATION_FLAGS = ASSERTION_FLAGS | FLAG_AT;

export type PasskeyErrorCode = "not-supported" | "bad-request";

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- CBOR（書き出しだけ。整数・バイト列・文字列・配列・map） ----

export type Cbor = number | string | Uint8Array | Cbor[] | CborMap;
// map は [キー, 値] の並び。書き出すときに CTAP2 の正規の順（符号化したキーの長さ → バイト列の辞書順）に並べ替える
export interface CborMap {
  map: [number | string, Cbor][];
}

function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n <= 0xffffffff) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  throw new Error("CBOR: 32 ビットを超える長さ・整数は扱わない");
}

function cborParts(v: Cbor, out: number[]): void {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("CBOR: 整数以外の数は扱わない");
    if (v >= 0) out.push(...cborHead(0, v));
    else out.push(...cborHead(1, -1 - v));
  } else if (typeof v === "string") {
    const b = utf8Encode(v);
    out.push(...cborHead(3, b.length));
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    out.push(...cborHead(2, v.length));
    for (const x of v) out.push(x);
  } else if (Array.isArray(v)) {
    out.push(...cborHead(4, v.length));
    for (const x of v) cborParts(x, out);
  } else {
    const entries = v.map.map(([k, val]) => ({ key: cborEncode(k), val }));
    entries.sort((a, b) => a.key.length - b.key.length || compareBytes(a.key, b.key));
    out.push(...cborHead(5, entries.length));
    for (const e of entries) {
      for (const x of e.key) out.push(x);
      cborParts(e.val, out);
    }
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function cborEncode(v: Cbor): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  cborParts(v, out);
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(b: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(b)));
}

// ---- 鍵 ----

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;

export interface PasskeyKeyPair {
  // PKCS#8 の DER
  privateKey: Uint8Array<ArrayBuffer>;
  // 公開鍵の座標（それぞれ 32 バイト）
  x: Uint8Array<ArrayBuffer>;
  y: Uint8Array<ArrayBuffer>;
}

export async function generatePasskeyKey(): Promise<PasskeyKeyPair> {
  const pair = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey, x: b64urlDecode(jwk.x), y: b64urlDecode(jwk.y) };
}

// PKCS#8 の秘密鍵から公開鍵の座標を出す
export async function passkeyPublicKey(privateKey: Uint8Array): Promise<{ x: Uint8Array<ArrayBuffer>; y: Uint8Array<ArrayBuffer> }> {
  const key = await crypto.subtle.importKey("pkcs8", bytes(privateKey), EC, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { x: b64urlDecode(jwk.x), y: b64urlDecode(jwk.y) };
}

// COSE_Key（EC2・P-256・ES256）: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
export function cosePublicKey(x: Uint8Array, y: Uint8Array): Uint8Array<ArrayBuffer> {
  return cborEncode({
    map: [
      [1, 2],
      [3, ES256],
      [-1, 1],
      [-2, x],
      [-3, y],
    ],
  });
}

// SubjectPublicKeyInfo の DER（PublicKeyCredential の response.getPublicKey() が返すもの）
export async function spkiPublicKey(x: Uint8Array, y: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", concat(new Uint8Array([4]), x, y), EC, true, ["verify"]);
  return new Uint8Array(await crypto.subtle.exportKey("spki", key));
}

// ---- authenticatorData・attestationObject・署名 ----

// rpIdHash(32) ‖ flags(1) ‖ signCount(4、常に 0) ‖ [AAGUID(16) ‖ credentialId の長さ(2) ‖ credentialId ‖ COSE の公開鍵]
export async function authenticatorData(
  rpId: string,
  flags: number,
  attested?: { credentialId: Uint8Array; cosePublicKey: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  const head = concat(await sha256(utf8Encode(rpId)), new Uint8Array([flags, 0, 0, 0, 0]));
  if (!attested) return head;
  const len = attested.credentialId.length;
  return concat(head, PASSKEY_AAGUID, new Uint8Array([len >> 8, len & 0xff]), attested.credentialId, attested.cosePublicKey);
}

// attestation は none: {"fmt": "none", "attStmt": {}, "authData": <authenticatorData>}
export function attestationObject(authData: Uint8Array): Uint8Array<ArrayBuffer> {
  return cborEncode({
    map: [
      ["fmt", "none"],
      ["attStmt", { map: [] }],
      ["authData", authData],
    ],
  });
}

// WebCrypto の ECDSA の署名（r ‖ s、それぞれ 32 バイト）を DER（SEQUENCE { INTEGER r, INTEGER s }）にする
export function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (raw.length !== 64) throw new Error("ECDSA の署名の長さが 64 バイトでない");
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0]! & 0x80 ? concat(new Uint8Array([0]), v) : v;
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

// authenticatorData ‖ clientDataHash を ES256 で署名し、DER で返す
export async function signAssertion(privateKey: Uint8Array, authData: Uint8Array, clientDataHash: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("pkcs8", bytes(privateKey), EC, false, ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, concat(authData, clientDataHash)));
  return derSignature(raw);
}

// ---- 登録とサインイン ----

export interface PasskeyCreateRequest {
  rpId: string;
  rpName: string;
  // user.id（base64url）
  userId: string;
  userName: string;
  userDisplayName: string;
  // pubKeyCredParams の alg の並び
  algs: number[];
}

export interface PasskeyCreated {
  passkey: Passkey;
  credentialId: Uint8Array<ArrayBuffer>;
  authenticatorData: Uint8Array<ArrayBuffer>;
  attestationObject: Uint8Array<ArrayBuffer>;
  publicKeySpki: Uint8Array<ArrayBuffer>;
  alg: number;
}

// 登録の要求から、保管庫に入れるパスキーと応答を作る（保管庫への書き込みは呼び出し側）。
// 鍵と credentialId は普通は新しく作る（テストベクタのときだけ渡す）
export async function createPasskey(
  req: PasskeyCreateRequest,
  fixed?: { privateKey: Uint8Array; credentialId: Uint8Array; createdAt: string },
): Promise<PasskeyCreated> {
  if (!req.algs.includes(ES256)) throw new PasskeyError("not-supported", "ES256（-7）に対応していないサイト");
  let userHandle: Uint8Array;
  try {
    userHandle = b64urlDecode(req.userId);
  } catch {
    throw new PasskeyError("bad-request", "user.id が読めない");
  }
  if (userHandle.length < 1 || userHandle.length > 64) throw new PasskeyError("bad-request", "user.id は 1〜64 バイト");
  if (req.rpId === "") throw new PasskeyError("bad-request", "rpId が空");

  const privateKey = fixed ? bytes(fixed.privateKey) : (await generatePasskeyKey()).privateKey;
  const { x, y } = await passkeyPublicKey(privateKey);
  const credentialId = fixed ? bytes(fixed.credentialId) : randomBytes(16);
  const cose = cosePublicKey(x, y);
  const authData = await authenticatorData(req.rpId, REGISTRATION_FLAGS, { credentialId, cosePublicKey: cose });
  const passkey: Passkey = {
    credentialId: b64urlEncode(credentialId),
    rpId: req.rpId,
    userHandle: req.userId,
    userName: req.userName,
    userDisplayName: req.userDisplayName,
    rpName: req.rpName,
    privateKey: b64urlEncode(privateKey),
    alg: ES256,
    counter: 0,
    discoverable: true,
    createdAt: fixed?.createdAt ?? nowIso(),
  };
  return {
    passkey,
    credentialId,
    authenticatorData: authData,
    attestationObject: attestationObject(authData),
    publicKeySpki: await spkiPublicKey(x, y),
    alg: ES256,
  };
}

export interface PasskeyAssertion {
  credentialId: Uint8Array<ArrayBuffer>;
  authenticatorData: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  userHandle: Uint8Array<ArrayBuffer>;
}

// サインインの応答を作る（counter は 0 のまま。保管庫には書かない）
export async function assertPasskey(passkey: Passkey, clientDataHash: Uint8Array): Promise<PasskeyAssertion> {
  if (passkey.alg !== ES256) throw new PasskeyError("not-supported", "ES256 以外のパスキー");
  const authData = await authenticatorData(passkey.rpId, ASSERTION_FLAGS);
  return {
    credentialId: b64urlDecode(passkey.credentialId),
    authenticatorData: authData,
    signature: await signAssertion(b64urlDecode(passkey.privateKey), authData, clientDataHash),
    userHandle: b64urlDecode(passkey.userHandle),
  };
}

// ---- rpId の検証（Nemo だけ。iOS は OS がやる） ----

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// origin で rpId を使ってよいか。origin は https（http は localhost だけ）。rpId は小文字で末尾のドットが無く、
// origin のホストと同じか、その親ドメインで公開接尾辞（PSL）でないもの。IP アドレスは使えない
export function rpIdAllowed(origin: string, rpId: string, psl: PublicSuffixList = publicSuffixList()): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (url.origin !== origin.replace(/\/$/, "")) return false;
  if (url.protocol === "http:") {
    if (host !== "localhost") return false;
  } else if (url.protocol !== "https:") {
    return false;
  }
  if (rpId === "" || rpId !== rpId.toLowerCase() || rpId.endsWith(".") || rpId.startsWith(".")) return false;
  if (host.startsWith("[") || IPV4_RE.test(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return rpId === host;
  if (rpId !== host && !host.endsWith(`.${rpId}`)) return false;
  return psl.registrableDomain(rpId) !== null;
}

// ---- 保管庫からの選び方 ----

interface Entry {
  id: string;
  deletedAt: string | null;
  state: { kind: string };
}

export interface PasskeyMatch<T> {
  entry: T;
  item: LoginItem;
  passkey: Passkey;
}

// ゴミ箱に入っていないログインのパスキーを、アイテムの id の昇順で並べる。同じ credentialId は最初のものだけ
function livePasskeys<T extends Entry>(entries: Iterable<T>): PasskeyMatch<T>[] {
  const live: T[] = [];
  for (const e of entries) if (e.deletedAt === null && e.state.kind === "login") live.push(e);
  live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  const out: PasskeyMatch<T>[] = [];
  for (const entry of live) {
    const item = (entry.state as { kind: "login"; item: LoginItem }).item;
    for (const passkey of loginPasskeys(item)) {
      if (seen.has(passkey.credentialId)) continue;
      seen.add(passkey.credentialId);
      out.push({ entry, item, passkey });
    }
  }
  return out;
}

// サインインの候補。allowCredentials（credentialId の base64url の並び）が空か null なら rpId が一致する全部
export function passkeyCandidates<T extends Entry>(entries: Iterable<T>, rpId: string, allowCredentials: string[] | null): PasskeyMatch<T>[] {
  const allow = allowCredentials && allowCredentials.length > 0 ? new Set(allowCredentials) : null;
  return livePasskeys(entries).filter((m) => m.passkey.rpId === rpId && (allow === null || allow.has(m.passkey.credentialId)));
}

// excludeCredentials に載っているパスキー（rpId も一致するもの）を持っているか
export function hasExcludedPasskey<T extends Entry>(entries: Iterable<T>, rpId: string, excludeCredentials: string[]): boolean {
  if (excludeCredentials.length === 0) return false;
  return passkeyCandidates(entries, rpId, excludeCredentials).length > 0;
}

// 作ったパスキーを入れるログインの候補。rpId のドメインに URL の照合で合うログイン（ゴミ箱を除く）のうち、
// ユーザー名が一致するものが 1 件だけなら exact。そうでなければ matches から選ばせる（新しいログインも選べる）。
// matches が空なら新しいログインを作る
export function passkeyTargets<T extends Entry>(
  entries: Iterable<T>,
  rpId: string,
  userName: string,
  psl: PublicSuffixList = publicSuffixList(),
): { exact: T | null; matches: T[] } {
  const matches: T[] = [];
  for (const e of entries) {
    if (e.deletedAt !== null || e.state.kind !== "login") continue;
    const item = (e.state as { kind: "login"; item: LoginItem }).item;
    if (loginMatchesPage(item, `https://${rpId}/`, psl)) matches.push(e);
  }
  // 選ぶ画面の並びを iOS（id の昇順）と揃える
  matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const same = matches.filter((e) => (e.state as { kind: "login"; item: LoginItem }).item.username === userName);
  return { exact: same.length === 1 ? same[0]! : null, matches };
}

// パスキーを足したログイン（知らないキーは残す）
export function withPasskey(item: LoginItem, passkey: Passkey): LoginItem {
  return { ...item, passkeys: [...loginPasskeys(item), passkey], updatedAt: nowIso() };
}

// パスキーを消したログイン。消した結果が空でも passkeys: [] として書く
export function withoutPasskey(item: LoginItem, credentialId: string): LoginItem {
  return { ...item, passkeys: loginPasskeys(item).filter((p) => p.credentialId !== credentialId), updatedAt: nowIso() };
}

// パスキーだけを入れる新しいログイン。名前は rp.name（無ければ rpId）、URI は https://<rpId>
export function newPasskeyLogin(passkey: Passkey): LoginItem {
  return newLoginItem({
    name: passkey.rpName || passkey.rpId,
    username: passkey.userName,
    uris: [{ uri: `https://${passkey.rpId}`, match: null }],
    passkeys: [passkey],
  });
}

export { isPasskeyOnlyLogin };
