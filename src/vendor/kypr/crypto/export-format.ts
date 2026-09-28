import { type Envelope, parseEnvelope } from "./envelope-shape.ts";
import { KyprCryptoError } from "./errors.ts";
import { isUuidV4 } from "./ids.ts";
import { type KdfParams, parseKdfParams } from "./params.ts";

// kypr-export v1。Web のエクスポートと R2 のバックアップが同じ形式を使う
// ゴミ箱の中のアイテムは含め、完全削除の印（トゥームストーン）は含めない
export interface ExportItem {
  id: string;
  revision: number;
  deletedAt: string | null;
  data: Envelope;
}

export interface KyprExport {
  format: "kypr-export";
  v: 1;
  exportedAt: string;
  revision: number;
  kdf: KdfParams;
  wrappedVaultKey: Envelope;
  items: ExportItem[];
}

export function buildExport(input: Omit<KyprExport, "format" | "v">): KyprExport {
  return { format: "kypr-export", v: 1, ...input };
}

export function parseExport(x: unknown): KyprExport {
  if (typeof x !== "object" || x === null) throw new KyprCryptoError("malformed", "エクスポートがオブジェクトでない");
  const o = x as Record<string, unknown>;
  if (o.format !== "kypr-export" || o.v !== 1) {
    throw new KyprCryptoError("malformed", "kypr-export v1 ではない");
  }
  if (typeof o.exportedAt !== "string" || !Number.isInteger(o.revision) || !Array.isArray(o.items)) {
    throw new KyprCryptoError("malformed", "エクスポートの項目が不正");
  }
  const items = o.items.map((it: unknown): ExportItem => {
    const i = it as Record<string, unknown>;
    if (!isUuidV4(i?.id) || !Number.isInteger(i.revision) || !(i.deletedAt === null || typeof i.deletedAt === "string")) {
      throw new KyprCryptoError("malformed", "エクスポートのアイテムが不正");
    }
    return { id: i.id, revision: i.revision as number, deletedAt: i.deletedAt, data: parseEnvelope(i.data) };
  });
  return {
    format: "kypr-export",
    v: 1,
    exportedAt: o.exportedAt,
    revision: o.revision as number,
    kdf: parseKdfParams(o.kdf),
    wrappedVaultKey: parseEnvelope(o.wrappedVaultKey),
    items,
  };
}
