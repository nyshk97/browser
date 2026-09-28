// 失敗の理由。UI はこのコードで出し分ける（docs/crypto-spec.md「失敗の分類」）
// - bad-password: やり直せば直る（保管庫鍵の展開に失敗した）
// - tampered: 鍵は正しいが中身が食い違う（GCM の認証失敗・id の不一致）
// - malformed: 形式が壊れている（JSON・base64・封筒の形）
// - invalid-params: KDF パラメータが許容範囲の外
// - weaker-params: KDF パラメータが前回より弱くなった（ダウングレードの疑い）
export type KyprErrorCode = "bad-password" | "tampered" | "malformed" | "invalid-params" | "weaker-params";

export class KyprCryptoError extends Error {
  readonly code: KyprErrorCode;

  constructor(code: KyprErrorCode, message: string) {
    super(message);
    this.name = "KyprCryptoError";
    this.code = code;
  }
}
