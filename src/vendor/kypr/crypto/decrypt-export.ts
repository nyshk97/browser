import { KyprCryptoError, type KyprErrorCode } from "./errors.ts";
import { type DecryptedItem, decryptItem } from "./item.ts";
import { parseExport } from "./export-format.ts";
import { unlockVault } from "./vault.ts";

export type DecryptedExportItem =
  | { id: string; deletedAt: string | null; ok: true; item: DecryptedItem }
  | { id: string; deletedAt: string | null; ok: false; error: KyprErrorCode };

// kypr-export を丸ごと復号する。壊れたアイテムがあっても止めず、そのアイテムだけ error で返す
export async function decryptExport(password: string, input: unknown) {
  const exp = parseExport(input);
  const { authKey, vaultKey } = await unlockVault(password, exp.kdf, exp.wrappedVaultKey);
  authKey.fill(0);
  const items: DecryptedExportItem[] = [];
  try {
    for (const it of exp.items) {
      try {
        items.push({ id: it.id, deletedAt: it.deletedAt, ok: true, item: await decryptItem(vaultKey, it.id, it.data) });
      } catch (e) {
        if (!(e instanceof KyprCryptoError)) throw e;
        items.push({ id: it.id, deletedAt: it.deletedAt, ok: false, error: e.code });
      }
    }
  } finally {
    vaultKey.fill(0);
  }
  return { exportedAt: exp.exportedAt, revision: exp.revision, items };
}
