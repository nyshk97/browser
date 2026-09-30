// ログインのアイコンのホスト（docs/crypto-spec.md「サイトのアイコン」）。Web・Nemo・iOS（KyprCore の写し）で揃える
import type { LoginUri } from "../crypto/index.ts";
import { parseUri } from "./url-match.ts";

// アイコンのホストの正規化: 小文字の ASCII（parseUri が済ませる）から先頭の `www.` を外す
export function iconHost(host: string): string {
  const bare = host.replace(/^www\./, "");
  return bare === "" ? host : bare;
}

// 最初の http(s) の URI のホスト（URL の照合と同じ読み方。スキームが無ければ http:// を補う）。無ければ null
export function loginIconHost(uris: readonly LoginUri[]): string | null {
  for (const u of uris) {
    const p = parseUri(u.uri);
    if (p && (p.scheme === "http" || p.scheme === "https")) return iconHost(p.host);
  }
  return null;
}
