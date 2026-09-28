const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// アイテムの id は小文字の UUIDv4。クライアントが作る
export function isUuidV4(s: unknown): s is string {
  return typeof s === "string" && UUID_V4_RE.test(s);
}
