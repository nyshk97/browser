/**
 * 診断ログ（Phase 1-9 でファイル出力・ローテーションに育てる）。
 * イベント名は安定した文字列にする。URL 以外の入力値・Vault 情報は載せない。
 */
export function log(event: string, detail: Record<string, unknown> = {}): void {
  const payload = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : ''
  console.log(`[nemo] ${event}${payload}`)
}

export function logError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[nemo] ${event} ${JSON.stringify({ ...detail, error: message })}`)
}
