// ワンタイムコード（TOTP）の画面寄りの処理: otpauth URI の読み取り・見出し・並び・重複・検索・表示。
// コードの計算と Base32 は @kypr/crypto（CLI も使うため）。仕様は docs/crypto-spec.md「ワンタイムコード（TOTP）」。
// iOS に写しがある（apps/ios/KyprCore/TOTP.swift）。ここを変えたらそちらも直す
import {
  base32Decode,
  isTotpAlgorithm,
  normalizeTotpSecret,
  totpCode,
  totpProblem,
  totpRemaining,
  type TotpAlgorithm,
  type TotpItem,
  type TotpProblem,
} from "../crypto/index.ts";

export interface OtpauthParams {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const OTPAUTH_RE = /^otpauth:\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;
const INT_MAX = 2 ** 31 - 1;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// 10 進の数字だけの文字列を整数に。32 ビットに収まらなければ null（Swift の Int32 と揃える）
function parseDecimal(s: string): number | null {
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return n <= INT_MAX ? n : null;
}

// QR の中身や貼り付けた文字列を読む。読めなければ null（部分的には読まない）
export function parseOtpauthUri(input: string): OtpauthParams | null {
  const m = OTPAUTH_RE.exec(input.trim());
  if (!m || m[1]!.toLowerCase() !== "totp") return null;

  const label = decode((m[2] ?? "").slice(1));
  if (label === null) return null;
  let labelIssuer = "";
  let account = label;
  const colon = label.indexOf(":");
  if (colon >= 0) {
    labelIssuer = label.slice(0, colon);
    account = label.slice(colon + 1).replace(/^ +/, "");
  }

  const params = new Map<string, string>();
  for (const part of (m[3] ?? "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const name = decode((eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, " "));
    const value = decode((eq >= 0 ? part.slice(eq + 1) : "").replace(/\+/g, " "));
    if (name === null || value === null) return null;
    const key = name.toLowerCase();
    if (!params.has(key)) params.set(key, value);
  }

  const secret = normalizeTotpSecret(params.get("secret") ?? "");
  const decoded = base32Decode(secret);
  if (secret === "" || decoded === null) return null;
  const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();
  if (!isTotpAlgorithm(algorithm)) return null;
  const digits = params.has("digits") ? parseDecimal(params.get("digits")!) : 6;
  if (digits === null || digits < 6 || digits > 8) return null;
  const period = params.has("period") ? parseDecimal(params.get("period")!) : 30;
  if (period === null || period < 1) return null;

  const issuerParam = params.get("issuer") ?? "";
  return { issuer: issuerParam !== "" ? issuerParam : labelIssuer, account, secret, algorithm, digits, period };
}

// 見出し。「発行元: ラベル」（片方が空ならもう片方だけ）
export function totpTitle(item: Pick<TotpItem, "name" | "account">): string {
  if (item.name && item.account) return `${item.name}: ${item.account}`;
  return item.name || item.account;
}

const collator = new Intl.Collator("ja");

// 発行元 → ラベルの順。発行元が空のものは末尾
export function compareTotp(a: Pick<TotpItem, "name" | "account">, b: Pick<TotpItem, "name" | "account">): number {
  if ((a.name === "") !== (b.name === "")) return a.name === "" ? 1 : -1;
  return collator.compare(a.name, b.name) || collator.compare(a.account, b.account);
}

// 取り込みで飛ばす「同じもの」。発行元・ラベルは見ない（取り込んだ後に名前を直しても重複と分かるように）
export function sameTotp(
  a: Pick<TotpItem, "secret" | "algorithm" | "digits" | "period">,
  b: Pick<TotpItem, "secret" | "algorithm" | "digits" | "period">,
): boolean {
  // 文字列でなくバイト列で比べる（余りのビットだけが違う書き方でも同じ鍵）。読めない秘密鍵どうしは文字列で比べる
  const ka = base32Decode(a.secret);
  const kb = base32Decode(b.secret);
  const sameKey =
    ka && kb ? ka.length === kb.length && ka.every((x, i) => x === kb[i]) : normalizeTotpSecret(a.secret) === normalizeTotpSecret(b.secret);
  return (
    sameKey &&
    a.algorithm === b.algorithm &&
    a.digits === b.digits &&
    a.period === b.period
  );
}

// 検索の対象は発行元・ラベル・URL
export function totpMatchesQuery(item: Pick<TotpItem, "name" | "account" | "uris">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.name.toLowerCase().includes(q) ||
    item.account.toLowerCase().includes(q) ||
    item.uris.some((u) => u.uri.toLowerCase().includes(q))
  );
}

// 6 桁は 3 + 3、8 桁は 4 + 4 で区切る（7 桁は区切らない）。コピーするときは区切らない
export function formatTotpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export const TOTP_PROBLEM_TEXT: Record<TotpProblem, string> = {
  "empty-secret": "秘密鍵が空です",
  "bad-secret": "秘密鍵が Base32 として読めません",
  "unknown-algorithm": "対応していないアルゴリズムです",
  "bad-digits": "桁数は 6〜8 にしてください",
  "bad-period": "周期は 1 秒以上にしてください",
};

export type TotpNow = { code: string; remaining: number; period: number } | { problem: TotpProblem };

// その時点のコードと残り秒数。出せなければ理由
export async function totpNow(
  item: Pick<TotpItem, "secret" | "algorithm" | "digits" | "period">,
  nowMs: number = Date.now(),
): Promise<TotpNow> {
  const problem = totpProblem(item);
  if (problem) return { problem };
  const t = Math.floor(nowMs / 1000);
  return { code: await totpCode(item, t), remaining: totpRemaining(item.period, t), period: item.period };
}
