// ロックを解除した保管庫。保管庫鍵とセッショントークンはこのオブジェクトのメモリにだけ持つ
// キャッシュの実体・鍵の導出の実行場所・API の宛先は呼び出し側（Web / Nemo）が ClientDeps で渡す
import {
  b64Encode,
  buildExport,
  type CardItem,
  decryptItem,
  encryptItem,
  type Envelope,
  generateVaultKey,
  isWeakerKdf,
  type KdfParams,
  type KyprErrorCode,
  KyprCryptoError,
  type KyprExport,
  type LoginItem,
  newKdfParams,
  type NoteItem,
  parseKdfParams,
  unwrapVaultKey,
  type VaultItem,
  wrapVaultKey,
} from "../crypto/index.ts";
import { type ApiCaller, ApiError, NetworkError } from "./api.ts";
import type { CachedAccount, CachedItem, CacheSnapshot, VaultCacheStore } from "./cache.ts";

export type DeriveKeys = (password: string, kdf: KdfParams) => Promise<{ authKey: Uint8Array; wrapKey: Uint8Array }>;

export interface ClientDeps {
  api: ApiCaller;
  cache: VaultCacheStore;
  derive: DeriveKeys;
  // セッションが切れたら（401）、手元の authKey で 1 回だけログインし直して続ける（Nemo）。
  // 既定は false で、切れたら SessionExpiredError を投げる（Web はロックして入れ直させる）
  reloginOnExpiry?: boolean;
}

export type EntryState =
  | { kind: "login"; item: LoginItem }
  | { kind: "note"; item: NoteItem }
  | { kind: "card"; item: CardItem }
  | { kind: "unknown"; raw: Record<string, unknown> & { id: string } }
  | { kind: "error"; code: KyprErrorCode };

export interface VaultEntry {
  id: string;
  revision: number;
  deletedAt: string | null;
  data: Envelope;
  state: EntryState;
}

export interface WireItem {
  id: string;
  revision: number;
  data: Envelope | null;
  deletedAt: string | null;
  purgedAt: string | null;
}

export type UnlockFailure =
  | { code: "bad-password" }
  | { code: "locked"; retryAfter: number; canOpenOffline: boolean }
  | { code: "weaker-params" | "invalid-params" | "malformed" | "tampered" }
  | { code: "no-account" }
  | { code: "offline-no-cache" }
  | { code: "setup-rejected"; reason: string }
  // 通信の失敗・Worker の失敗など、やり直せば直りうるもの
  | { code: "temporary"; message: string };

export class UnlockError extends Error {
  readonly failure: UnlockFailure;

  constructor(failure: UnlockFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

export class ConflictError extends Error {}
export class SessionExpiredError extends Error {}

// この端末で覚えておく鍵（Nemo の Touch ID・iOS の Face ID）。マスターパスワードの代わりに解除できる
export interface DeviceKeys {
  vaultKey: Uint8Array;
  authKey: Uint8Array;
}

// D1 は1つの値を 2MB までしか受けないので、件数（サーバーの上限 500）とバイト数の両方で分ける
const CREATE_CHUNK_ITEMS = 500;
const CREATE_CHUNK_BYTES = 1024 * 1024;

function asUnlockError(e: unknown, mapBadPassword: "bad-password" | "tampered" = "bad-password"): never {
  if (e instanceof KyprCryptoError) {
    const code = e.code === "bad-password" ? mapBadPassword : e.code;
    throw new UnlockError({ code } as UnlockFailure);
  }
  throw e;
}

async function decryptEntry(vaultKey: Uint8Array, it: CachedItem): Promise<VaultEntry> {
  let state: EntryState;
  try {
    state = await decryptItem(vaultKey, it.id, it.data);
  } catch (e) {
    if (!(e instanceof KyprCryptoError)) throw e;
    state = { kind: "error", code: e.code };
  }
  return { ...it, state };
}

export class VaultSession {
  revision: number;
  entries = new Map<string, VaultEntry>();
  #deps: ClientDeps;
  #vaultKey: Uint8Array;
  #authKey: Uint8Array;
  #token: string | null;
  #account: CachedAccount;
  #listeners = new Set<() => void>();

  private constructor(
    deps: ClientDeps,
    keys: DeviceKeys,
    token: string | null,
    account: CachedAccount,
    revision: number,
  ) {
    this.#deps = deps;
    this.#vaultKey = keys.vaultKey;
    this.#authKey = keys.authKey;
    this.#token = token;
    this.#account = account;
    this.revision = revision;
  }

  // サーバーに届かずキャッシュから開いたときは読み取り専用
  get readOnly(): boolean {
    return this.#token === null;
  }

  // 初回登録。SETUP_TOKEN はサーバーの secret と照合される
  static async setup(deps: ClientDeps, setupToken: string, password: string): Promise<VaultSession> {
    const kdf = newKdfParams();
    const { authKey, wrapKey } = await deps.derive(password, kdf);
    const vaultKey = generateVaultKey();
    const wrappedVaultKey = await wrapVaultKey(wrapKey, vaultKey);
    wrapKey.fill(0);
    let res: { token: string };
    try {
      res = await deps.api("/api/setup", {
        method: "POST",
        body: { setupToken, kdf, authKey: b64Encode(authKey), wrappedVaultKey },
      });
    } catch (e) {
      if (e instanceof ApiError) throw new UnlockError({ code: "setup-rejected", reason: e.code });
      throw e;
    }
    const account = { kdf, wrappedVaultKey };
    await deps.cache.clear();
    await deps.cache.saveAccount(account);
    await deps.cache.apply(0, [], [], true);
    return new VaultSession(deps, { vaultKey, authKey }, res.token, account, 0);
  }

  // オンラインならログインして同期する。サーバーに届かなければキャッシュから読み取り専用で開く
  static async unlock(deps: ClientDeps, password: string): Promise<VaultSession> {
    const cache = await deps.cache.load();
    let kdf: KdfParams;
    try {
      const pre = await deps.api<{ kdf: unknown }>("/api/prelogin");
      kdf = parseKdfParams(pre.kdf);
    } catch (e) {
      if (e instanceof NetworkError) return VaultSession.unlockOffline(deps, password);
      if (e instanceof ApiError && e.status === 404) throw new UnlockError({ code: "no-account" });
      return asUnlockError(e);
    }
    const sameAccount = cache.account?.kdf.salt === kdf.salt;
    // 導出済みの鍵をキャッシュに使い回してよいのは、KDF パラメータが丸ごと同じときだけ
    const sameKdf = cache.account !== null && JSON.stringify(cache.account.kdf) === JSON.stringify(kdf);
    // salt ごと差し替えられても検出できるよう、別アカウントに見えるときも弱化は止める
    if (cache.account && isWeakerKdf(cache.account.kdf, kdf)) {
      throw new UnlockError({ code: "weaker-params" });
    }

    const { authKey, wrapKey } = await deps.derive(password, kdf).catch(asUnlockError);
    let res: { token: string; wrappedVaultKey: Envelope };
    try {
      res = await deps.api("/api/login", { method: "POST", body: { authKey: b64Encode(authKey) } });
    } catch (e) {
      if (e instanceof NetworkError && cache.account && sameKdf) {
        // 導出済みの wrapKey でキャッシュを開く（Argon2 を二度回さない）
        return VaultSession.#openCached(deps, cache, wrapKey, authKey);
      }
      wrapKey.fill(0);
      authKey.fill(0);
      if (e instanceof NetworkError) return VaultSession.unlockOffline(deps, password);
      if (e instanceof ApiError && e.status === 401) throw new UnlockError({ code: "bad-password" });
      if (e instanceof ApiError && e.status === 429) {
        throw new UnlockError({ code: "locked", retryAfter: e.retryAfter ?? 60, canOpenOffline: cache.account !== null });
      }
      throw e;
    }
    // サーバーが認めたのに展開できないなら、サーバー側のデータが壊れている
    const vaultKey = await unwrapVaultKey(wrapKey, res.wrappedVaultKey).catch((e) => {
      authKey.fill(0);
      return asUnlockError(e, "tampered");
    });
    wrapKey.fill(0);

    const account = { kdf, wrappedVaultKey: res.wrappedVaultKey };
    if (!sameAccount) await deps.cache.clear();
    await deps.cache.saveAccount(account);
    const session = new VaultSession(deps, { vaultKey, authKey }, res.token, account, sameAccount ? cache.revision : 0);
    return VaultSession.#finishOnline(session, sameAccount ? cache.items : []);
  }

  // この端末で覚えておいた鍵で解除する（マスターパスワードも Argon2 も要らない）。
  // サーバーが authKey を認めなければ（401。マスターパスワードが変わった等）bad-password を投げるので、
  // 呼び出し側は覚えた鍵を捨ててマスターパスワードに回す。サーバーに届かなければキャッシュから読み取り専用で開く
  static async unlockWithDeviceKeys(deps: ClientDeps, keys: DeviceKeys): Promise<VaultSession> {
    const cache = await deps.cache.load();
    if (!cache.account) throw new UnlockError({ code: "offline-no-cache" });
    const vaultKey = keys.vaultKey.slice();
    const authKey = keys.authKey.slice();
    let res: { token: string; wrappedVaultKey: Envelope };
    try {
      res = await deps.api("/api/login", { method: "POST", body: { authKey: b64Encode(authKey) } });
    } catch (e) {
      if (e instanceof NetworkError) {
        const session = new VaultSession(deps, { vaultKey, authKey }, null, cache.account, cache.revision);
        await session.#loadEntries(cache.items);
        return session;
      }
      vaultKey.fill(0);
      authKey.fill(0);
      if (e instanceof ApiError && e.status === 401) throw new UnlockError({ code: "bad-password" });
      if (e instanceof ApiError && e.status === 429) {
        throw new UnlockError({ code: "locked", retryAfter: e.retryAfter ?? 60, canOpenOffline: true });
      }
      throw e;
    }
    // 包んだ保管庫鍵が変わっていたら（別のアカウント・作り直し）、手元の鍵では開けない
    if (JSON.stringify(res.wrappedVaultKey) !== JSON.stringify(cache.account.wrappedVaultKey)) {
      vaultKey.fill(0);
      authKey.fill(0);
      if (res.token) deps.api("/api/logout", { method: "POST", token: res.token }).catch(() => {});
      throw new UnlockError({ code: "bad-password" });
    }
    const session = new VaultSession(deps, { vaultKey, authKey }, res.token, cache.account, cache.revision);
    return VaultSession.#finishOnline(session, cache.items);
  }

  static async unlockOffline(deps: ClientDeps, password: string): Promise<VaultSession> {
    const cache = await deps.cache.load();
    if (!cache.account) throw new UnlockError({ code: "offline-no-cache" });
    const { authKey, wrapKey } = await deps.derive(password, cache.account.kdf).catch(asUnlockError);
    return VaultSession.#openCached(deps, cache, wrapKey, authKey);
  }

  static async #openCached(
    deps: ClientDeps,
    cache: CacheSnapshot,
    wrapKey: Uint8Array,
    authKey: Uint8Array,
  ): Promise<VaultSession> {
    const account = cache.account!;
    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKey(wrapKey, account.wrappedVaultKey).catch(asUnlockError);
    } finally {
      wrapKey.fill(0);
    }
    const session = new VaultSession(deps, { vaultKey, authKey }, null, account, cache.revision);
    await session.#loadEntries(cache.items);
    return session;
  }

  static async #finishOnline(session: VaultSession, cachedItems: CachedItem[]): Promise<VaultSession> {
    try {
      await session.#loadEntries(cachedItems);
      await session.sync();
    } catch (e) {
      // 同期だけ届かないときは、キャッシュを読み込んだまま開く（次の書き込みや同期でやり直せる）
      if (e instanceof NetworkError) return session;
      session.lock();
      throw e;
    }
    return session;
  }

  // この端末で覚えておく鍵の写し（Touch ID・Face ID の解除用）。受け取った側が保存して、要らなくなったら 0 で埋める
  deviceKeys(): DeviceKeys {
    // ロックしたあとは 0 で埋めた鍵しか無い。保存されると Touch ID / Face ID で開けなくなる
    if (this.#vaultKey.every((b) => b === 0)) throw new Error("ロックされています");
    return { vaultKey: this.#vaultKey.slice(), authKey: this.#authKey.slice() };
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) fn();
  }

  async #loadEntries(items: CachedItem[]) {
    for (const it of items) this.entries.set(it.id, await decryptEntry(this.#vaultKey, it));
  }

  // cursor は同期の位置（GET /api/items の revision）。書き込みの応答では進めない
  // （進めると、その間に他の端末が加えた変更を次の差分で取りこぼす）
  async #apply(cursor: number | null, wire: WireItem[], full = false) {
    const upserts: CachedItem[] = [];
    const removals: string[] = [];
    if (full) this.entries.clear();
    for (const w of wire) {
      if (w.purgedAt !== null || w.data === null) {
        removals.push(w.id);
        this.entries.delete(w.id);
        continue;
      }
      const it: CachedItem = { id: w.id, revision: w.revision, deletedAt: w.deletedAt, data: w.data };
      upserts.push(it);
      this.entries.set(it.id, await decryptEntry(this.#vaultKey, it));
    }
    if (cursor !== null) this.revision = full ? cursor : Math.max(this.revision, cursor);
    await this.#deps.cache.apply(this.revision, upserts, removals, full);
    this.#emit();
  }

  // 手元の authKey でログインし直す（切れたセッション・読み取り専用で開いた後にサーバーに届くようになったとき）
  async #relogin(): Promise<void> {
    let res: { token: string; wrappedVaultKey: Envelope };
    try {
      res = await this.#deps.api("/api/login", { method: "POST", body: { authKey: b64Encode(this.#authKey) } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new SessionExpiredError("ログインし直せませんでした");
      throw e;
    }
    if (JSON.stringify(res.wrappedVaultKey) !== JSON.stringify(this.#account.wrappedVaultKey)) {
      this.#deps.api("/api/logout", { method: "POST", token: res.token }).catch(() => {});
      throw new SessionExpiredError("保管庫が変わりました");
    }
    this.#token = res.token;
  }

  // 読み取り専用で開いたあと、サーバーに届くようになったら書き込めるようにする（authKey でログインし直して同期する）
  async goOnline(): Promise<void> {
    if (!this.readOnly) return;
    await this.#relogin();
    this.#emit();
    await this.sync();
  }

  async #call<T>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
    if (this.#token === null) throw new Error("読み取り専用で開いています");
    try {
      return await this.#deps.api<T>(path, { ...opts, token: this.#token });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (this.#deps.reloginOnExpiry && !retried) {
          await this.#relogin();
          return this.#call<T>(path, opts, true);
        }
        throw new SessionExpiredError("セッションが切れました");
      }
      if (e instanceof ApiError && e.status === 409 && e.body.item) {
        await this.#apply(null, [e.body.item as WireItem]);
        throw new ConflictError("他の端末で更新されました");
      }
      throw e;
    }
  }

  async sync(): Promise<void> {
    const res = await this.#call<{ revision: number; items: WireItem[] }>(`/api/items?since=${this.revision}`);
    if (res.revision < this.revision) {
      // サーバーが巻き戻っている（Time Travel での復元など）。全部取り直す
      const all = await this.#call<{ revision: number; items: WireItem[] }>("/api/items?since=0");
      await this.#apply(all.revision, all.items, true);
      return;
    }
    await this.#apply(res.revision, res.items);
  }

  // 1回のリクエストの中は原子的。上限（500件・1MB）を超える取り込みは分けて送る
  async create(items: VaultItem[], onProgress?: (done: number) => void): Promise<void> {
    const encrypted = await Promise.all(
      items.map(async (it) => ({ id: it.id, data: await encryptItem(this.#vaultKey, it) })),
    );
    let done = 0;
    while (done < encrypted.length) {
      const chunk: typeof encrypted = [];
      let bytes = 0;
      for (const it of encrypted.slice(done)) {
        const size = JSON.stringify(it).length;
        if (chunk.length > 0 && (chunk.length >= CREATE_CHUNK_ITEMS || bytes + size > CREATE_CHUNK_BYTES)) break;
        chunk.push(it);
        bytes += size;
      }
      const res = await this.#call<{ revision: number; items: WireItem[] }>("/api/items", {
        method: "POST",
        body: { items: chunk },
      });
      await this.#apply(null, res.items);
      done += chunk.length;
      onProgress?.(done);
    }
  }

  async update(item: VaultItem, baseRevision: number): Promise<void> {
    const data = await encryptItem(this.#vaultKey, item);
    const res = await this.#call<{ item: WireItem }>(`/api/items/${item.id}`, {
      method: "PUT",
      body: { baseRevision, data },
    });
    await this.#apply(null, [res.item]);
  }

  async #action(id: string, action: "trash" | "restore" | "purge") {
    const entry = this.entries.get(id);
    if (!entry) return;
    const res = await this.#call<{ item: WireItem }>(`/api/items/${id}/${action}`, {
      method: "POST",
      body: { baseRevision: entry.revision },
    });
    await this.#apply(null, [res.item]);
  }

  trash(id: string) {
    return this.#action(id, "trash");
  }

  restore(id: string) {
    return this.#action(id, "restore");
  }

  purge(id: string) {
    return this.#action(id, "purge");
  }

  // kypr-export v1。ゴミ箱の中身は含め、トゥームストーンは（キャッシュに無いので）含まれない
  buildExport(): KyprExport {
    return buildExport({
      exportedAt: new Date().toISOString(),
      revision: this.revision,
      kdf: this.#account.kdf,
      wrappedVaultKey: this.#account.wrappedVaultKey,
      items: [...this.entries.values()]
        .sort((a, b) => a.revision - b.revision)
        .map((e) => ({ id: e.id, revision: e.revision, deletedAt: e.deletedAt, data: e.data })),
    });
  }

  lock(): void {
    this.#vaultKey.fill(0);
    this.#authKey.fill(0);
    this.entries.clear();
    const token = this.#token;
    this.#token = null;
    if (token) this.#deps.api("/api/logout", { method: "POST", token }).catch(() => {});
    this.#emit();
  }
}
