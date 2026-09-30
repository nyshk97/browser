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
  type IconItem,
  iconId,
  iconIdKey,
  isIconDataUri,
  isIconHost,
  newIconItem,
  type IdentityItem,
  isWeakerKdf,
  type KdfParams,
  type KyprErrorCode,
  KyprCryptoError,
  type KyprExport,
  type LoginItem,
  newKdfParams,
  type NoteItem,
  type TotpItem,
  parseKdfParams,
  unwrapVaultKey,
  usableIcon,
  type VaultItem,
  wrapVaultKey,
} from "../crypto/index.ts";
import { type ApiCaller, ApiError, NetworkError } from "./api.ts";
import type { CachedAccount, CachedItem, CacheSnapshot, VaultCacheStore } from "./cache.ts";

export type DeriveKeys = (password: string, kdf: KdfParams) => Promise<{ authKey: Uint8Array; wrapKey: Uint8Array }>;
// 合言葉の検証値（derivePassphraseKey）を作る。Argon2id を回すので、呼び出し側が Worker などで実行する
export type DerivePassphrase = (passphrase: string, kdf: KdfParams) => Promise<Uint8Array>;

// この端末の登録（サーバーが発行した端末トークン）の置き場所（docs/crypto-spec.md「端末の登録と合言葉」）。
// 渡さなければ端末を登録しない（合言葉を設定したあとは、毎回合言葉が要る）
export interface DeviceStore {
  // 端末の一覧に出す名前
  name: string;
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

// 登録していない端末からログインするときの 2 つ目の要素。register なら、この端末を登録する
export interface SecondFactor {
  passphrase: string;
  register: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface DeviceList {
  devices: DeviceInfo[];
  // この端末の id。一時利用（登録していない端末）なら null
  currentDeviceId: string | null;
  passphraseSet: boolean;
}

interface LoginResponse {
  token: string;
  wrappedVaultKey: Envelope;
  // 古いサーバーは返さない（undefined）。null なら一時利用のセッション
  deviceId?: string | null;
  deviceToken?: string;
}

export interface ClientDeps {
  api: ApiCaller;
  cache: VaultCacheStore;
  derive: DeriveKeys;
  // 合言葉で入る・合言葉を設定するときに要る
  derivePassphrase?: DerivePassphrase;
  // この端末の登録。無ければ登録しない
  device?: DeviceStore;
  // セッションが切れたら（401）、手元の authKey で 1 回だけログインし直して続ける（Nemo）。
  // 既定は false で、切れたら SessionExpiredError を投げる（Web はロックして入れ直させる）
  reloginOnExpiry?: boolean;
}

export type EntryState =
  | { kind: "login"; item: LoginItem }
  | { kind: "note"; item: NoteItem }
  | { kind: "card"; item: CardItem }
  | { kind: "identity"; item: IdentityItem }
  | { kind: "totp"; item: TotpItem }
  | { kind: "unknown"; raw: Record<string, unknown> & { id: string } }
  | { kind: "error"; code: KyprErrorCode };

export interface VaultEntry {
  id: string;
  revision: number;
  deletedAt: string | null;
  data: Envelope;
  state: EntryState;
}

// サイトのアイコン（type: "icon"）の行。entries には入れない（一覧・検索・件数・ゴミ箱のどれにも出さない）
interface IconEntry {
  id: string;
  revision: number;
  deletedAt: string | null;
  data: Envelope;
  raw: Record<string, unknown> & { id: string };
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
  // 登録していない端末から入ろうとした（合言葉が設定済み）。合言葉を付けて送り直す
  | { code: "device-required" }
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

// サイトのアイコンを書き直すのは、前回の書き込みからこれだけたっているときだけ（docs/crypto-spec.md「サイトのアイコン」）
export const ICON_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
// 1 回の saveIcons で書く件数の上限
export const ICON_WRITE_LIMIT = 20;

export interface IconWrite {
  host: string;
  dataUri: string;
}

// saveIcons の結果（どれもホスト。gone は完全削除済みで二度と作れない id）
export interface IconWriteResult {
  created: string[];
  updated: string[];
  skipped: string[];
  gone: string[];
}
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

// サーバーが「この端末は登録されていない」と言った。取り消された端末かもしれないので、
// 端末トークンとキャッシュ（暗号文・包んだ保管庫鍵・Touch ID の鍵）を消してから知らせる
async function forgetDevice(deps: ClientDeps): Promise<never> {
  await Promise.all([deps.device?.clear(), deps.cache.clear()].map((p) => p?.catch(() => {})));
  throw new UnlockError({ code: "device-required" });
}

// POST /api/login。端末トークン・合言葉・登録の希望を添え、発行された端末トークンを保存する。
// 失敗はそのまま投げる（device-required だけは端末の記録を消して UnlockError にする）
async function loginRequest(
  deps: ClientDeps,
  authKey: Uint8Array,
  kdf: KdfParams,
  second?: SecondFactor,
): Promise<LoginResponse> {
  const body: Record<string, unknown> = { authKey: b64Encode(authKey) };
  // 読めないときは投げる（「トークン無し」と取り違えると、device-required でキャッシュまで消してしまう）
  const deviceToken = deps.device ? await deps.device.load() : null;
  if (deviceToken) body.deviceToken = deviceToken;
  if (second) {
    if (!deps.derivePassphrase) throw new Error("合言葉の鍵を作れません");
    const passphraseKey = await deps.derivePassphrase(second.passphrase, kdf).catch(asUnlockError);
    body.passphraseKey = b64Encode(passphraseKey);
    passphraseKey.fill(0);
  }
  // 合言葉が未設定のあいだに新しいクライアントで入った端末は、そのまま登録する（移行）
  if (deps.device && (second ? second.register : true)) {
    body.register = true;
    body.deviceName = deps.device.name;
  }
  let res: LoginResponse;
  try {
    res = await deps.api<LoginResponse>("/api/login", { method: "POST", body });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.code === "device-required") return forgetDevice(deps);
    throw e;
  }
  // 保存に失敗しても解除は続ける（サーバーでは登録済み。次のログインで登録し直される）
  if (res.deviceToken && deps.device) {
    await deps.device.save(res.deviceToken).catch((e) => console.error("端末トークンを保存できませんでした", e));
  }
  return res;
}

async function decryptEntry(vaultKey: Uint8Array, it: CachedItem): Promise<VaultEntry | IconEntry> {
  let state: EntryState;
  try {
    const dec = await decryptItem(vaultKey, it.id, it.data);
    if (dec.kind === "icon") return { ...it, raw: dec.raw };
    state = dec;
  } catch (e) {
    if (!(e instanceof KyprCryptoError)) throw e;
    state = { kind: "error", code: e.code };
  }
  return { ...it, state };
}

export class VaultSession {
  revision: number;
  entries = new Map<string, VaultEntry>();
  // サイトのアイコン。id → 行と、使えるものの ホスト → data: URI
  #icons = new Map<string, IconEntry>();
  #iconByHost = new Map<string, string>();
  #iconKey: Promise<CryptoKey> | null = null;
  #iconsVersion = 0;
  #deps: ClientDeps;
  #vaultKey: Uint8Array;
  #authKey: Uint8Array;
  #token: string | null;
  // 合言葉で入り、この端末を登録しなかった（一時利用）。合言葉を覚えていないのでログインし直せない
  #temporary = false;
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

  // 合言葉で一時的に入った（この端末を登録していない）。キャッシュは呼び出し側がメモリにする
  get temporary(): boolean {
    return this.#temporary;
  }

  // 初回登録。SETUP_TOKEN はサーバーの secret と照合される
  static async setup(deps: ClientDeps, setupToken: string, password: string): Promise<VaultSession> {
    const kdf = newKdfParams();
    const { authKey, wrapKey } = await deps.derive(password, kdf);
    const vaultKey = generateVaultKey();
    const wrappedVaultKey = await wrapVaultKey(wrapKey, vaultKey);
    wrapKey.fill(0);
    let res: { token: string; deviceId?: string; deviceToken?: string };
    try {
      res = await deps.api("/api/setup", {
        method: "POST",
        body: { setupToken, kdf, authKey: b64Encode(authKey), wrappedVaultKey, deviceName: deps.device?.name },
      });
    } catch (e) {
      if (e instanceof ApiError) throw new UnlockError({ code: "setup-rejected", reason: e.code });
      throw e;
    }
    const account = { kdf, wrappedVaultKey };
    await deps.cache.clear();
    // 保管庫を作った端末はそのまま登録済みになる
    if (res.deviceToken && deps.device) await deps.device.save(res.deviceToken);
    await deps.cache.saveAccount(account);
    await deps.cache.apply(0, [], [], true);
    return new VaultSession(deps, { vaultKey, authKey }, res.token, account, 0);
  }

  // オンラインならログインして同期する。サーバーに届かなければキャッシュから読み取り専用で開く。
  // 登録していない端末で合言葉が要れば device-required を投げるので、second を付けて呼び直す
  static async unlock(deps: ClientDeps, password: string, second?: SecondFactor): Promise<VaultSession> {
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
    let res: LoginResponse;
    try {
      res = await loginRequest(deps, authKey, kdf, second);
    } catch (e) {
      if (e instanceof NetworkError && cache.account && sameKdf) {
        // 導出済みの wrapKey でキャッシュを開く（Argon2 を二度回さない）
        return VaultSession.#openCached(deps, cache, wrapKey, authKey);
      }
      wrapKey.fill(0);
      authKey.fill(0);
      if (e instanceof UnlockError) throw e;
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
    session.#temporary = second !== undefined && res.deviceId === null;
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
    let res: LoginResponse;
    try {
      res = await loginRequest(deps, authKey, cache.account.kdf);
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
    for (const it of items) this.#put(await decryptEntry(this.#vaultKey, it));
    await this.#rebuildIcons();
  }

  #put(e: VaultEntry | IconEntry) {
    if ("raw" in e) {
      this.entries.delete(e.id);
      this.#icons.set(e.id, e);
    } else {
      this.#icons.delete(e.id);
      this.entries.set(e.id, e);
    }
  }

  // アイコンの id（ホストから決まる。docs/crypto-spec.md「サイトのアイコン」）。保管庫鍵はこのオブジェクトの外に出さない
  async iconId(host: string): Promise<string> {
    // ロックしたあとは 0 で埋めた鍵しか無い（そこから作った id は、ほかの端末の id と合わない）
    if (this.#vaultKey.every((b) => b === 0)) throw new Error("ロックされています");
    this.#iconKey ??= iconIdKey(this.#vaultKey);
    return iconId(await this.#iconKey, host);
  }

  // 使えるアイコンの表を作り直す。形が違う・ゴミ箱の中・id がホストから作った id と合わないものは使わない
  async #rebuildIcons() {
    const byHost = new Map<string, string>();
    for (const e of this.#icons.values()) {
      const icon = e.deletedAt === null ? usableIcon(e.raw) : null;
      if (icon && (await this.iconId(icon.host)) === e.id) byHost.set(icon.host, icon.dataUri);
    }
    this.#iconByHost = byHost;
    this.#iconsVersion++;
  }

  // アイコンの表を作り直すたびに増える（画面が描き直しの要否を見る）
  get iconsVersion(): number {
    return this.#iconsVersion;
  }

  // ホスト（loginIconHost で作ったもの）のアイコンの data: URI。無ければ null
  iconFor(host: string | null): string | null {
    return host === null ? null : (this.#iconByHost.get(host) ?? null);
  }

  // そのホストのアイコンを書く（favicon を描く）必要があるか。無い・使えない・前回の書き込みから ICON_REFRESH_MS たった。
  // 中身が同じかは描いてから saveIcons が見る。ゴミ箱の中・知らない schema のものは書かない
  async iconNeedsWrite(host: string, now = Date.now()): Promise<boolean> {
    const row = this.#icons.get(await this.iconId(host));
    if (!row) return true;
    if (row.deletedAt !== null || row.raw.schema !== 1) return false;
    const icon = usableIcon(row.raw);
    if (!icon || icon.host !== host) return true;
    const at = Date.parse(icon.updatedAt);
    return !Number.isFinite(at) || now - at >= ICON_REFRESH_MS;
  }

  // サイトのアイコンを作る・書き直す（書くのは Nemo だけ）。1 回に limit 件まで。
  // まとめて作って 409 / 410 なら（サーバーはどの id かを返さない）、同期してから 1 件ずつ送り直す。
  // 410 の id は結果の gone に入れる（トゥームストーンは同期で手元から消えるので、呼び出し側が覚えて skipIds に渡す）
  async saveIcons(
    icons: IconWrite[],
    opts: { skipIds?: ReadonlySet<string>; limit?: number; now?: number } = {},
  ): Promise<IconWriteResult> {
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? ICON_WRITE_LIMIT;
    const result: IconWriteResult = { created: [], updated: [], skipped: [], gone: [] };
    const creates: IconItem[] = [];
    const updates: { item: IconItem; revision: number }[] = [];
    for (const { host, dataUri } of icons) {
      if (creates.length + updates.length >= limit) break;
      const id = isIconHost(host) && isIconDataUri(dataUri) ? await this.iconId(host) : null;
      if (id === null || opts.skipIds?.has(id) || !(await this.iconNeedsWrite(host, now))) {
        result.skipped.push(host);
        continue;
      }
      const row = this.#icons.get(id);
      if (!row) {
        creates.push(newIconItem(id, host, dataUri));
        continue;
      }
      if (usableIcon(row.raw)?.dataUri === dataUri) {
        result.skipped.push(host);
        continue;
      }
      const at = new Date(now).toISOString();
      updates.push({ item: { ...row.raw, type: "icon", schema: 1, host, dataUri, updatedAt: at } as IconItem, revision: row.revision });
    }

    if (creates.length > 0) {
      try {
        await this.create(creates);
        result.created.push(...creates.map((c) => c.host));
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 409 || e.status === 410))) throw e;
        await this.sync();
        for (const c of creates) {
          if (this.#icons.has(c.id)) {
            result.skipped.push(c.host);
            continue;
          }
          try {
            await this.create([c]);
            result.created.push(c.host);
          } catch (e1) {
            if (e1 instanceof ApiError && e1.status === 410) result.gone.push(c.id);
            else if (e1 instanceof ApiError && e1.status === 409) result.skipped.push(c.host);
            else throw e1;
          }
        }
      }
    }
    for (const { item, revision } of updates) {
      try {
        await this.update(item, revision);
        result.updated.push(item.host);
      } catch (e) {
        if (e instanceof ConflictError) result.skipped.push(item.host);
        else if (e instanceof ApiError && e.status === 410) result.gone.push(item.id);
        else throw e;
      }
    }
    return result;
  }

  // cursor は同期の位置（GET /api/items の revision）。書き込みの応答では進めない
  // （進めると、その間に他の端末が加えた変更を次の差分で取りこぼす）
  async #apply(cursor: number | null, wire: WireItem[], full = false) {
    const upserts: CachedItem[] = [];
    const removals: string[] = [];
    if (full) {
      this.entries.clear();
      this.#icons.clear();
    }
    for (const w of wire) {
      if (w.purgedAt !== null || w.data === null) {
        removals.push(w.id);
        this.entries.delete(w.id);
        this.#icons.delete(w.id);
        continue;
      }
      const it: CachedItem = { id: w.id, revision: w.revision, deletedAt: w.deletedAt, data: w.data };
      upserts.push(it);
      this.#put(await decryptEntry(this.#vaultKey, it));
    }
    if (full || wire.length > 0) await this.#rebuildIcons();
    if (cursor !== null) this.revision = full ? cursor : Math.max(this.revision, cursor);
    await this.#deps.cache.apply(this.revision, upserts, removals, full);
    this.#emit();
  }

  // 手元の authKey でログインし直す（切れたセッション・読み取り専用で開いた後にサーバーに届くようになったとき）
  // 一時利用（合言葉で入った）のセッションは合言葉を覚えていないので、ログインし直せない
  async #relogin(): Promise<void> {
    if (this.temporary) throw new SessionExpiredError("一時利用のセッションが切れました");
    let res: LoginResponse;
    try {
      res = await loginRequest(this.#deps, this.#authKey, this.#account.kdf);
    } catch (e) {
      if (e instanceof UnlockError || (e instanceof ApiError && e.status === 401)) {
        throw new SessionExpiredError("ログインし直せませんでした");
      }
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
  async create(items: (VaultItem | IconItem)[], onProgress?: (done: number) => void): Promise<void> {
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

  async update(item: VaultItem | IconItem, baseRevision: number): Promise<void> {
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

  // 登録済みの端末の一覧と、合言葉が設定済みか
  devices(): Promise<DeviceList> {
    return this.#call<DeviceList>("/api/devices");
  }

  // 端末を取り消す（その端末のセッションも切れる）。この端末自身は取り消せない
  async revokeDevice(id: string): Promise<void> {
    await this.#call(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // 合言葉を設定する・変える。マスターパスワードを入れ直してもらい、サーバーが authKey で確かめる
  // （手元の authKey を送ると、開いたままの画面だけで変えられてしまう）。違えば UnlockError（bad-password）
  async setPassphrase(password: string, passphrase: string): Promise<void> {
    if (!this.#deps.derivePassphrase) throw new Error("合言葉の鍵を作れません");
    if (passphrase === "") throw new Error("合言葉が空です");
    if (passphrase.normalize("NFC") === password.normalize("NFC")) throw new Error("合言葉はマスターパスワードと別のものにしてください");
    const kdf = this.#account.kdf;
    const { authKey, wrapKey } = await this.#deps.derive(password, kdf).catch(asUnlockError);
    wrapKey.fill(0);
    let passphraseKey: Uint8Array | null = null;
    try {
      passphraseKey = await this.#deps.derivePassphrase(passphrase, kdf).catch(asUnlockError);
      await this.#call("/api/passphrase", {
        method: "PUT",
        body: { authKey: b64Encode(authKey), passphraseKey: b64Encode(passphraseKey) },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.code === "bad-password") throw new UnlockError({ code: "bad-password" });
      if (e instanceof ApiError && e.status === 429) {
        throw new UnlockError({ code: "locked", retryAfter: e.retryAfter ?? 60, canOpenOffline: false });
      }
      throw e;
    } finally {
      authKey.fill(0);
      passphraseKey?.fill(0);
    }
  }

  // kypr-export v1。ゴミ箱の中身は含め、トゥームストーンは（キャッシュに無いので）含まれない
  buildExport(): KyprExport {
    return buildExport({
      exportedAt: new Date().toISOString(),
      revision: this.revision,
      kdf: this.#account.kdf,
      wrappedVaultKey: this.#account.wrappedVaultKey,
      items: [...this.entries.values(), ...this.#icons.values()]
        .sort((a, b) => a.revision - b.revision)
        .map((e) => ({ id: e.id, revision: e.revision, deletedAt: e.deletedAt, data: e.data })),
    });
  }

  lock(): void {
    this.#vaultKey.fill(0);
    this.#authKey.fill(0);
    this.entries.clear();
    this.#icons.clear();
    this.#iconByHost.clear();
    this.#iconKey = null;
    const token = this.#token;
    this.#token = null;
    if (token) this.#deps.api("/api/logout", { method: "POST", token }).catch(() => {});
    this.#emit();
  }
}
