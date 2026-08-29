// @ts-check
/**
 * renderer（ブラウザ UI）で起きた例外を、診断ログの `ui.error` に載せられる形へ落とす。
 *
 * `sanitizeDetail` は**文字列の先頭が scheme のときだけ** URL と見なし、文字列を 200 文字で切る。
 * スタックトレースは `at foo (nemo://ui/...?view=sidebar)` のように行の途中に URL を持つので、
 * あちらに任せると URL が素通りする。**送る前にここで行単位に潰す**。
 */
import { redactUrl } from './log-redact.js'

/** 残す行数。 */
export const MAX_FRAMES = 10
/** 1 行の長さ（`sanitizeDetail` の 200 文字切りに当たらないよう手前で切る）。 */
export const MAX_FRAME_LENGTH = 180

const URL_IN_TEXT = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s)'"]+/g

/**
 * 文中の URL を全部ホストまでに落とす。
 * @param {string} text
 * @returns {string}
 */
export function redactUrlsInText(text) {
  return text.replace(URL_IN_TEXT, (url) => redactUrl(url))
}

/**
 * @param {string | null | undefined} stack
 * @returns {string[]}
 */
export function formatErrorFrames(stack) {
  if (!stack) return []
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_FRAMES)
    .map((line) => {
      const redacted = redactUrlsInText(line)
      return redacted.length > MAX_FRAME_LENGTH ? `${redacted.slice(0, MAX_FRAME_LENGTH)}…` : redacted
    })
}

/**
 * `ui.error` の detail を組み立てる。
 * @param {{ message?: unknown, stack?: unknown }} input
 * @param {string} view
 * @returns {{ error: string, frames: string[], view: string }}
 */
export function buildUiErrorDetail(input, view) {
  const message = typeof input.message === 'string' ? input.message : String(input.message ?? 'unknown')
  const stack = typeof input.stack === 'string' ? input.stack : null
  return {
    error: redactUrlsInText(message).slice(0, MAX_FRAME_LENGTH),
    frames: formatErrorFrames(stack),
    view
  }
}
