import type { WebContents, WebFrameMain } from 'electron'
import { loginMatchesPage, parsePage } from '../../vendor/kypr/client/url-match.ts'
import { KYPR_PAGE_SOURCE, KYPR_WORLD_ID } from '../../shared/kypr-page-source.js'
import type { KyprActionResult, KyprDraft, KyprTotpDraft, KyprTotpQrResult } from '../../shared/types.js'
import { log, logError } from '../log.js'
import { agentFillRefusal, isAgentContents, rememberAgentSecrets } from '../agent/contents.js'
import { subFrameRunner, type PageRunner } from '../autofill/frame-runner.js'
import {
  copyKyprTotp,
  kyprLoginForFill,
  kyprParseOtpauth,
  kyprTotpForFill,
  kyprTotpMatches,
  touchKypr
} from './index.js'
import { readQrFromImage } from './qr.js'

/**
 * kypr のログインをページに入れる（⌘⇧L・ポップアップ・入力欄の下の候補）。
 *
 * **入れる先のフレーム**（plan の決定表「入れる先のフレーム」）:
 *   1. フォーカスのある直下の iframe（ログイン欄があれば）
 *   2. メインフレームで見えているパスワード欄（または、ユーザーがいまメインフレームのログイン欄にいる）
 *   3. 直下の iframe で見えているパスワード欄
 *   4. パスワード欄がどこにも無いとき（ユーザー名だけを先に聞く段）: メインフレームのユーザー名の欄 → 直下の iframe のユーザー名の欄
 * iframe へは `frame-runner.ts` と同じく CDP で isolated world を作って入れる（メインフレーム直下まで）。
 *
 * **入れる直前に、そのフレームの URL でログインを照合し直す**（トップ向けのパスワードを別オリジンの iframe に入れない）。
 * 欄が見えているかはページ側のスクリプト（`kypr-page-source.js`）が見る。
 */

interface Target {
  frame: WebFrameMain
  runner: PageRunner
  probe: { hasPassword: boolean; hasUsername: boolean; focused: boolean }
}

function mainRunner(wc: WebContents): PageRunner {
  return {
    run: (code) => wc.executeJavaScriptInIsolatedWorld(KYPR_WORLD_ID, [{ code }]),
    dispose: () => {},
    region: null
  }
}

async function probe(runner: PageRunner): Promise<Target['probe'] | null> {
  try {
    const result = (await runner.run(`${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.probe()`)) as
      Target['probe'] | null
    if (!result || typeof result !== 'object') return null
    return {
      hasPassword: result.hasPassword === true,
      hasUsername: result.hasUsername === true,
      focused: result.focused === true
    }
  } catch (error) {
    logError('kypr.probe_failed', error, {})
    return null
  }
}

const hasFields = (p: Target['probe'] | null): boolean => p !== null && (p.hasPassword || p.hasUsername)

/** 入れる先を決める。見つからなければ null。**返した runner は呼び出し側が dispose する**。 */
async function findTarget(wc: WebContents, options: { mainOnly?: boolean } = {}): Promise<Target | null> {
  if (wc.isDestroyed()) return null
  const main = wc.mainFrame
  const direct = options.mainOnly
    ? []
    : main.frames.filter((frame) => frame.parent === main && !frame.isDestroyed())

  // 1. フォーカスのあるフレーム（直下の iframe なら、そこを先に見る）
  const focused = wc.focusedFrame
  const focusedChild = focused && focused !== main ? direct.find((frame) => frame === focused) : undefined
  if (focusedChild) {
    const runner = await subFrameRunner(wc, focusedChild)
    if (runner) {
      const p = await probe(runner)
      if (hasFields(p) && p) return { frame: focusedChild, runner, probe: p }
      runner.dispose()
    }
  }

  // 2. メインフレームで見えているパスワード欄（または、ユーザーがいまメインフレームのログイン欄にいる）
  const mainR = mainRunner(wc)
  const mainProbe = await probe(mainR)
  if (mainProbe && (mainProbe.hasPassword || (mainProbe.focused && mainProbe.hasUsername))) {
    return { frame: main, runner: mainR, probe: mainProbe }
  }

  // 3. 直下の iframe で見えているパスワード欄
  const found: Target[] = []
  for (const frame of direct.slice(0, 8)) {
    if (frame === focusedChild || !parsePage(frame.url)) continue
    const runner = await subFrameRunner(wc, frame)
    if (!runner) continue
    const p = await probe(runner)
    if (hasFields(p) && p) {
      found.push({ frame, runner, probe: p })
      if (p.hasPassword) break
    } else runner.dispose()
  }
  const withPassword = found.find((t) => t.probe.hasPassword) ?? null
  // 4. パスワード欄がどこにも無い（ユーザー名だけを先に聞く段）: メインフレームのユーザー名の欄 → iframe のユーザー名の欄
  const best =
    withPassword ??
    (mainProbe?.hasUsername ? { frame: main, runner: mainR, probe: mainProbe } : null) ??
    found[0] ??
    null
  for (const t of found) if (t !== best) t.runner.dispose()
  return best
}

/** 入れる先のフレームの URL（ポップアップの「このページ」の照合に使う）。欄が無ければトップの URL。 */
export async function kyprTargetUrl(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null
  const target = await findTarget(wc)
  if (!target) return parsePage(wc.getURL()) ? wc.getURL() : null
  const url = target.frame.url
  target.runner.dispose()
  return parsePage(url) ? url : null
}

export async function fillKyprLogin(
  wc: WebContents,
  itemId: string,
  options: { mainOnly?: boolean } = {}
): Promise<KyprActionResult> {
  // エージェント窓: Claude が JS を実行した document には入れない（`agent/fill-gate.ts`）
  const refused = await agentFillRefusal(wc)
  if (refused) {
    log('kypr.fill', { ok: false, reason: refused })
    return { ok: false, reason: refused }
  }
  const login = kyprLoginForFill(itemId)
  if (!login) return { ok: false, reason: 'not-found' }
  const target = await findTarget(wc, options)
  if (!target) {
    log('kypr.fill', { ok: false, reason: 'no-target' })
    return { ok: false, reason: 'no-target' }
  }
  try {
    // **入れる直前に、入れる先のフレームの URL で照合し直す**
    if (target.frame.isDestroyed() || !loginMatchesPage(login, target.frame.url)) {
      log('kypr.fill', { ok: false, reason: 'url-mismatch', inSubFrame: target.frame !== wc.mainFrame })
      return { ok: false, reason: 'url-mismatch' }
    }
    // エージェント窓: **流し込む直前に**パスワードを伏せる値として覚えさせる（read_page / スクショに出さない・
    // taint して javascript_tool を断る）。入口の後に Claude が JS を実行していたらここで断る。覚えさせられなければ入れない。
    // iframe にも入れてよい（type=password は伏せ字で描かれ、read_page / get_page_text はメインフレームしか読まない）
    const refusedNow = login.password
      ? await rememberAgentSecrets(wc, [login.password])
      : await agentFillRefusal(wc)
    if (refusedNow) {
      log('kypr.fill', { ok: false, reason: refusedNow })
      return { ok: false, reason: refusedNow }
    }
    const result = (await target.runner.run(
      `${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.fill(${JSON.stringify(login.username)}, ${JSON.stringify(login.password)})`
    )) as { username?: boolean; password?: boolean } | null
    const filled = { username: result?.username === true, password: result?.password === true }
    touchKypr()
    log('kypr.fill', {
      ok: filled.username || filled.password,
      ...filled,
      inSubFrame: target.frame !== wc.mainFrame
    })
    if (!filled.username && !filled.password) return { ok: false, reason: 'no-target' }
    // 入れた先のフレームに合うワンタイムコードが 1 件だけなら、コードをコピーしておく（2FA の欄は多くのサイトで次の画面に出る）
    const totps = target.frame.isDestroyed() ? [] : kyprTotpMatches(target.frame.url)
    const totpCopied = totps.length === 1 && totps[0] ? await copyKyprTotp(totps[0].id, 'after-login') : false
    return totpCopied ? { ok: true, id: itemId, totpCopied } : { ok: true, id: itemId }
  } catch (error) {
    logError('kypr.fill_failed', error, {})
    return { ok: false, reason: 'failed' }
  } finally {
    target.runner.dispose()
  }
}

/**
 * ワンタイムコードを入れる（ポップアップから）。入れる先は**フォーカスのあるフレーム**（メインか直下の iframe）の
 * 「フォーカス中の入力欄 → 見えている `autocomplete=one-time-code` の欄」。
 * **そのフレームの URL にワンタイムコードの URL が合うときだけ入れる**（ログインと同じ。別オリジンの iframe に
 * 別のサイトのコードを入れない）。合わない・欄が無いときはコピーする（`copied: true`）。
 */
export async function fillKyprTotp(wc: WebContents, itemId: string): Promise<KyprActionResult> {
  // エージェント窓: Claude が JS を実行した document には入れない（コピーにも回さない。コピーはポップアップのボタンで）
  const refused = await agentFillRefusal(wc)
  if (refused) {
    log('kypr.fill_totp', { ok: false, reason: refused })
    return { ok: false, reason: refused }
  }
  const totp = await kyprTotpForFill(itemId)
  if (!totp) return { ok: false, reason: 'not-found' }
  const fallback = async (reason: string): Promise<KyprActionResult> => {
    log('kypr.fill_totp', { ok: false, reason })
    return (await copyKyprTotp(itemId, 'fallback'))
      ? { ok: true, id: itemId, copied: true }
      : { ok: false, reason: 'failed' }
  }
  if (wc.isDestroyed()) return fallback('destroyed')
  const main = wc.mainFrame
  const focused = wc.focusedFrame
  const frame =
    focused && focused !== main && focused.parent === main && !focused.isDestroyed() ? focused : main
  // エージェント窓: iframe の中はスクショの伏せ字が効かない（塗るのはメインフレームの要素だけ）ので入れずにコピーに回す
  if (frame !== main && isAgentContents(wc)) return fallback('agent-iframe')
  const runner = frame === main ? mainRunner(wc) : await subFrameRunner(wc, frame)
  if (!runner) return fallback('no-runner')
  try {
    // **入れる直前に、入れる先のフレームの URL で照合し直す**
    if (frame.isDestroyed() || !loginMatchesPage({ uris: totp.uris }, frame.url))
      return await fallback('url-mismatch')
    // エージェント窓: 流し込む直前にコードを伏せる値として覚えさせる（入口の後に Claude が JS を実行していたら断る。
    // 覚えさせられなければ入れない）
    const refusedNow = await rememberAgentSecrets(wc, [totp.code])
    if (refusedNow) {
      log('kypr.fill_totp', { ok: false, reason: refusedNow })
      return { ok: false, reason: refusedNow }
    }
    const ok =
      (await runner.run(
        `${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.fillCode(${JSON.stringify(totp.code)})`
      )) === true
    if (!ok) return await fallback('no-target')
    log('kypr.fill_totp', { ok: true, inSubFrame: frame !== main })
    return { ok: true, id: itemId }
  } catch (error) {
    logError('kypr.fill_totp_failed', error, {})
    return fallback('failed')
  } finally {
    runner.dispose()
  }
}

/** 新規のワンタイムコードの下書き（URL は今のページのオリジン）。 */
export function kyprTotpDraftFrom(wc: WebContents | null): KyprTotpDraft {
  const empty: KyprTotpDraft = {
    name: '',
    account: '',
    secret: '',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    uri: ''
  }
  if (!wc || wc.isDestroyed()) return empty
  const page = parsePage(wc.getURL())
  return page ? { ...empty, uri: new URL(page.url).origin } : empty
}

/**
 * 表示中の範囲を撮って QR を読み、ワンタイムコードの登録の下書きにする（2FA の設定画面の QR）。
 * `otpauth://totp/` として読める QR だけを拾う。URL はページのオリジン
 */
export async function kyprTotpFromPageQr(wc: WebContents | null): Promise<KyprTotpQrResult> {
  if (!wc || wc.isDestroyed()) return { ok: false, reason: 'no-page' }
  const page = parsePage(wc.getURL())
  if (!page) return { ok: false, reason: 'no-page' }
  try {
    const image = await wc.capturePage()
    const data = readQrFromImage(image)
    if (data === null) {
      log('kypr.page_qr', { ok: false, reason: 'not-found', ...image.getSize() })
      return { ok: false, reason: 'not-found' }
    }
    const draft = kyprParseOtpauth(data, new URL(page.url).origin)
    log('kypr.page_qr', { ok: draft !== null })
    return draft ? { ok: true, draft } : { ok: false, reason: 'not-otpauth' }
  } catch (error) {
    logError('kypr.page_qr_failed', error, {})
    return { ok: false, reason: 'failed' }
  }
}

/** ⌘⇧L: 入れる先のフレームに合うログインが 1 件ならそのまま入れる。それ以外は null（ポップアップを開く）。 */
export async function quickFillKypr(
  wc: WebContents,
  matchesFor: (url: string) => { id: string }[]
): Promise<KyprActionResult | null> {
  const url = await kyprTargetUrl(wc)
  if (!url) return null
  const matches = matchesFor(url)
  if (matches.length !== 1 || !matches[0]) return null
  return fillKyprLogin(wc, matches[0].id)
}

/** 新規作成の下書き（今のページのオリジン・ホスト名、メインフレームのログイン欄の値を 1 回だけ読む）。 */
export async function kyprDraftFrom(wc: WebContents | null): Promise<KyprDraft> {
  const empty: KyprDraft = { name: '', uri: '', username: '', password: '' }
  if (!wc || wc.isDestroyed()) return empty
  const page = parsePage(wc.getURL())
  if (!page) return empty
  const origin = new URL(page.url).origin
  const draft: KyprDraft = { ...empty, name: page.host.replace(/^www\./, ''), uri: origin }
  try {
    const read = (await mainRunner(wc).run(`${KYPR_PAGE_SOURCE};globalThis.__nemoKypr.read()`)) as {
      username?: unknown
      password?: unknown
    } | null
    if (typeof read?.username === 'string') draft.username = read.username
    if (typeof read?.password === 'string') draft.password = read.password
  } catch (error) {
    logError('kypr.draft_read_failed', error, {})
  }
  return draft
}
