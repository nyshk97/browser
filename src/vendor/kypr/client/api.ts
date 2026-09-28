// API の呼び出し。ネットワークに届かないときは NetworkError を投げる（オフラインの判定に使う）
// 宛先（baseUrl）と fetch は呼び出し側が決める。Web は同じオリジンの相対パス、Nemo は main の fetch で本番の URL

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  readonly retryAfter: number | null;

  constructor(status: number, body: Record<string, unknown>, retryAfter: number | null) {
    const code = typeof body.error === "string" ? body.error : `http-${status}`;
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends Error {}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

export type ApiCaller = <T>(path: string, opts?: ApiOptions) => Promise<T>;

export function createApi(baseUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiCaller {
  return async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: "no-store",
      });
    } catch {
      throw new NetworkError("サーバーに届かない");
    }
    // Cloudflare ごと落ちているときは HTML の 5xx が返るので、届かないのと同じに扱う
    if (res.status >= 500) throw new NetworkError(`サーバーが応答しない（${res.status}）`);
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok) throw new NetworkError("応答が JSON でない");
    }
    if (!res.ok) {
      const ra = res.headers.get("Retry-After");
      throw new ApiError(res.status, body, ra === null ? null : Number(ra));
    }
    return body as T;
  };
}
