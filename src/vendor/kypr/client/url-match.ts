// ログインの URI と、自動入力する画面の URL の照合（docs/crypto-spec.md「URL の照合」）。
// match は Bitwarden の URI 一致方式（0 ドメイン・1 ホスト・2 前方一致・3 完全一致・4 正規表現・5 一致させない。null は 0）
import { isPasskeyOnlyLogin, type LoginItem, type TotpItem } from "../crypto/index.ts";
import { PSL_RULES } from "./psl-data.ts";

// Public Suffix List で「登録可能なドメイン」（eTLD+1）を切り出す。private section（github.io 等）も含める
export class PublicSuffixList {
  #rules = new Set<string>();
  #wildcards = new Set<string>();
  #exceptions = new Set<string>();

  constructor(rules: string) {
    for (const line of rules.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("!")) this.#exceptions.add(line.slice(1));
      else if (line.startsWith("*.")) this.#wildcards.add(line.slice(2));
      else this.#rules.add(line);
    }
  }

  // 公開接尾辞のラベル数（規則に当たらなければ 1。PSL の既定の規則 "*"）
  #suffixLabelCount(labels: string[]): number {
    let best = 1;
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join(".");
      const n = labels.length - i;
      if (this.#exceptions.has(candidate)) return n - 1;
      if (this.#rules.has(candidate)) best = Math.max(best, n);
      if (i + 1 < labels.length && this.#wildcards.has(labels.slice(i + 1).join("."))) best = Math.max(best, n);
    }
    return best;
  }

  // eTLD+1。ホストそのものが公開接尾辞なら null
  registrableDomain(host: string): string | null {
    const labels = host.toLowerCase().replace(/^\.+|\.+$/g, "").split(".").filter((l) => l !== "");
    if (labels.length === 0) return null;
    const n = this.#suffixLabelCount(labels);
    if (labels.length <= n) return null;
    return labels.slice(-(n + 1)).join(".");
  }
}

let shared: PublicSuffixList | null = null;
// 規則の表は大きいので、最初に使うときに作る
export function publicSuffixList(): PublicSuffixList {
  shared ??= new PublicSuffixList(PSL_RULES);
  return shared;
}

export interface ParsedUrl {
  url: string;
  scheme: string;
  host: string;
  port: string;
}

const HTTP_SCHEMES = new Set(["http", "https"]);

// スキームが無ければ http:// を補って読む（Bitwarden と同じ）。読めなければ null
export function parseUri(raw: string): ParsedUrl | null {
  const s = raw.trim();
  if (s === "") return null;
  const withScheme = s.includes("://") ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return null;
  return { url: withScheme, scheme, host, port: u.port };
}

function isIpAddress(host: string): boolean {
  if (host.includes(":") || host.startsWith("[")) return true; // IPv6
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// IP アドレス・localhost・ドットの無いホストは、登録可能なドメインを切り出さずにホストのまま使う
export function baseDomain(host: string, psl: PublicSuffixList = publicSuffixList()): string {
  if (isIpAddress(host) || host === "localhost" || !host.includes(".")) return host;
  return psl.registrableDomain(host) ?? host;
}

// 画面の URL（http / https のページだけが対象）
export function parsePage(pageUrl: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!HTTP_SCHEMES.has(scheme)) return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return null;
  return { url: u.href, scheme, host, port: u.port };
}

// https で登録したログインを http のページに出さない（Chrome と同じ）。平文の通信にパスワードを流さないため
function schemeAllowed(item: ParsedUrl, page: ParsedUrl): boolean {
  return !(item.scheme === "https" && page.scheme === "http");
}

export function uriMatches(
  uri: string,
  match: number | null | undefined,
  page: ParsedUrl,
  psl: PublicSuffixList = publicSuffixList(),
): boolean {
  const m = match ?? 0;
  switch (m) {
    case 5:
      return false;
    case 4: {
      let re: RegExp;
      try {
        re = new RegExp(uri, "i");
      } catch {
        return false;
      }
      return re.test(page.url);
    }
    case 3:
      return page.url.toLowerCase() === uri.trim().toLowerCase();
    case 2:
      return page.url.toLowerCase().startsWith(uri.trim().toLowerCase());
    case 1: {
      const p = parseUri(uri);
      if (!p || !HTTP_SCHEMES.has(p.scheme) || !schemeAllowed(p, page)) return false;
      return p.host === page.host && p.port === page.port;
    }
    case 0: {
      const p = parseUri(uri);
      if (!p || !HTTP_SCHEMES.has(p.scheme) || !schemeAllowed(p, page)) return false;
      return baseDomain(p.host, psl) === baseDomain(page.host, psl);
    }
    default:
      // 知らない方式は一致させない
      return false;
  }
}

// そのログインが画面の URL に合うか（uris のどれか 1 つが一致すれば合う）
export function loginMatchesPage(
  item: Pick<LoginItem, "uris">,
  pageUrl: string,
  psl: PublicSuffixList = publicSuffixList(),
): boolean {
  const page = parsePage(pageUrl);
  if (!page) return false;
  return item.uris.some((u) => uriMatches(u.uri, u.match, page, psl));
}

// 保管庫のアイテムのうち、画面の URL に合うログイン（docs/crypto-spec.md「URL の照合」）。
// **ゴミ箱の中（deletedAt あり）・隔離したもの（復号できない error）・ログイン以外・パスキーだけのログイン
// （パスワードが空でパスキーを持つ。入れると空のパスワードが入る）は出さない**。
// Web・Nemo の候補とバッジはこれを通す（弾き忘れを呼び出し側に残さない）
export function matchingLogins<T extends { deletedAt: string | null; state: { kind: string } }>(
  entries: Iterable<T>,
  pageUrl: string,
  psl: PublicSuffixList = publicSuffixList(),
): T[] {
  const page = parsePage(pageUrl);
  if (!page) return [];
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.deletedAt !== null || entry.state.kind !== "login") continue;
    const item = (entry.state as { kind: "login"; item: Pick<LoginItem, "uris" | "password" | "passkeys"> }).item;
    if (isPasskeyOnlyLogin(item)) continue;
    if (item.uris.some((u) => uriMatches(u.uri, u.match, page, psl))) out.push(entry);
  }
  return out;
}

// 画面の URL に合うワンタイムコード（URL を足したものだけ）。絞り込みは matchingLogins と同じ
export function matchingTotps<T extends { deletedAt: string | null; state: { kind: string } }>(
  entries: Iterable<T>,
  pageUrl: string,
  psl: PublicSuffixList = publicSuffixList(),
): T[] {
  const page = parsePage(pageUrl);
  if (!page) return [];
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.deletedAt !== null || entry.state.kind !== "totp") continue;
    const item = (entry.state as { kind: "totp"; item: Pick<TotpItem, "uris"> }).item;
    if (item.uris.some((u) => uriMatches(u.uri, u.match, page, psl))) out.push(entry);
  }
  return out;
}
