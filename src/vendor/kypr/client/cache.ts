// オフラインのキャッシュの口。置くのは暗号文・包んだ保管庫鍵・KDF パラメータ・revision だけ
// 平文や展開した鍵は置かない。実体は Web が IndexedDB、Nemo が userData のファイル
import type { Envelope, KdfParams } from "../crypto/index.ts";

export interface CachedAccount {
  kdf: KdfParams;
  wrappedVaultKey: Envelope;
}

export interface CachedItem {
  id: string;
  revision: number;
  deletedAt: string | null;
  data: Envelope;
}

export interface CacheSnapshot {
  account: CachedAccount | null;
  revision: number;
  items: CachedItem[];
}

export interface VaultCacheStore {
  // 読めないときはキャッシュ無し（account: null）として返す。書き込みの失敗はそのまま投げる
  load(): Promise<CacheSnapshot>;
  saveAccount(account: CachedAccount): Promise<void>;
  // 差分を原子的に反映する。full なら先に全部消す（サーバーの巻き戻し・別アカウント）
  apply(revision: number, upserts: CachedItem[], removals: string[], full?: boolean): Promise<void>;
  clear(): Promise<void>;
}

// テストと、キャッシュを持たない使い方のためのメモリ上の実装
export class MemoryCacheStore implements VaultCacheStore {
  #account: CachedAccount | null = null;
  #revision = 0;
  #items = new Map<string, CachedItem>();

  async load(): Promise<CacheSnapshot> {
    return { account: this.#account, revision: this.#revision, items: [...this.#items.values()] };
  }

  async saveAccount(account: CachedAccount): Promise<void> {
    this.#account = account;
  }

  async apply(revision: number, upserts: CachedItem[], removals: string[], full = false): Promise<void> {
    if (full) this.#items.clear();
    for (const it of upserts) this.#items.set(it.id, it);
    for (const id of removals) this.#items.delete(id);
    this.#revision = revision;
  }

  async clear(): Promise<void> {
    this.#account = null;
    this.#revision = 0;
    this.#items.clear();
  }
}
