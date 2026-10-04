/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import { KYPR_PRODUCTION_SERVER } from '../shared/kypr-config.js'
import { cardFieldKind, cardFormComplete } from '../shared/kypr-card-field.js'
import { installKyprPasskey } from '../shared/kypr-passkey-shim.js'
import { installKyprWebAuthn } from '../shared/kypr-webauthn-shim.js'

/**
 * kypr: ログイン欄の下に候補を出すための見張り（ページ向けの preload。isolated world で走る）。
 *
 * - **メインフレームだけ**（Electron の session の preload はサブフレームに届かない。届いても念のため弾く）
 * - **ユーザーの操作によるフォーカスだけ**を知らせる。`el.focus()` でも `focus` の `isTrusted` は true になるので、
 *   「直前にその欄へ向いた trusted な pointerdown か、Tab の keydown があったか」で見分ける
 * - 送るのは欄の位置と種類だけ。**値は送らない**
 * - スクロール・リサイズ・Esc・フォーカスが外れたら閉じるよう知らせる
 *
 * ページのメインワールドからはこのスクリプトも ipcRenderer も見えない（contextIsolation）。
 *
 * もう 1 つ、kypr の Web 版の Touch ID 解除に答える認証器（`src/shared/kypr-webauthn-shim.js`）を、
 * kypr の origin のメインフレームにだけ main world へ入れる。**全サイトで同期 IPC を撃たない**よう、
 * 本番の kypr と模擬サーバー（`127.0.0.1` / `localhost` の http）の候補のときだけ main に聞く。
 * 最終的な判定は main（`src/main/kypr/web-authenticator.ts`。シークレット・エージェントのセッションでは入れない）。
 */

function kyprWebAuthnCandidate(): boolean {
  if (location.origin === KYPR_PRODUCTION_SERVER) return true
  return (
    location.protocol === 'http:' && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
  )
}

/*
 * kypr のパスキーの認証器（`src/shared/kypr-passkey-shim.js`）を http / https のメインフレームに入れる。
 * 入れるだけなら IPC は撃たない（main に聞くのはページが WebAuthn を呼んだときだけ）。答えるかどうかは main
 * （`src/main/kypr/passkey-authenticator.ts`。Claude のウィンドウ・kypr の Web の origin では答えずに内側へ渡す）。
 * **PRF の認証器より先に入れる**（PRF の shim が外側で、kypr の形でない要求をこちらに渡す）
 */
if (window.top === window && (location.protocol === 'https:' || location.protocol === 'http:')) {
  try {
    contextBridge.executeInMainWorld({
      func: installKyprPasskey,
      args: [(req: Record<string, unknown>) => ipcRenderer.invoke('nemo:kypr-passkey', req)]
    })
  } catch (error) {
    console.error('[nemo] kypr passkey failed', error)
  }
}

if (window.top === window && kyprWebAuthnCandidate()) {
  let enabled: boolean
  try {
    enabled = ipcRenderer.sendSync('nemo:kypr-webauthn-enabled') === true
  } catch {
    enabled = false
  }
  if (enabled) {
    try {
      contextBridge.executeInMainWorld({
        func: installKyprWebAuthn,
        args: [(req: Record<string, unknown>) => ipcRenderer.invoke('nemo:kypr-webauthn', req)]
      })
    } catch (error) {
      console.error('[nemo] kypr webauthn failed', error)
    }
  }
}

const CHANNEL = 'nemo:kypr-field'
/** 直前の操作を「このフォーカスの原因」とみなす時間。 */
const GESTURE_MS = 1000
const USER_TYPES = new Set(['text', 'email', 'tel'])

/**
 * 欄の種類。**カードの欄を先に見る**（CVC が `type=password` の決済フォームで、ログインの候補を出さない）。
 * カードは安全なコンテキスト（https・loopback の http）のときだけ（plan `2026-10-04-1606-kypr-card-autofill.md`）。
 */
function fieldKind(el: EventTarget | null): 'username' | 'password' | 'card' | null {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return null
  // 番号の欄と期限か CVC の欄がそろったフォームの欄だけをカードの欄にする（そろっていなければログインの判定に回す）
  if (cardFieldKind(el) && cardFormComplete(el)) return window.isSecureContext ? 'card' : null
  return el instanceof HTMLInputElement ? loginFieldKind(el) : null
}

function loginFieldKind(el: HTMLInputElement): 'username' | 'password' | null {
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  if (type === 'password') return 'password'
  if (!USER_TYPES.has(type)) return null
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
  const hint = `${el.name || ''} ${el.id || ''}`
  if (/\b(username|email)\b/.test(autocomplete) || type === 'email') return 'username'
  if (/user|login|mail|account|signin/i.test(hint)) return 'username'
  // パスワード欄と同じフォームにある、パスワード欄より前の欄もユーザー名とみなす
  const form = el.form
  if (form) {
    // CVC が type=password のカードの欄は数えない（決済フォームのメール欄をユーザー名にしない）
    const password = Array.from(form.querySelectorAll('input[type="password" i]')).find(
      (p) => !(cardFieldKind(p) && cardFormComplete(p))
    )
    if (password && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) return 'username'
  }
  return null
}

if (window.top === window && /^https?:$/.test(location.protocol)) {
  let gesture: { target: EventTarget | null; tab: boolean; at: number } = { target: null, tab: false, at: 0 }
  let current: HTMLInputElement | HTMLSelectElement | null = null
  // フォーカスが iframe に移った（カードの候補を iframe の下に出しているかもしれない）。
  // 候補を出すかは main が `input-event` から決めるので、ここではスクロール等で閉じるよう知らせるためだけに覚える
  let inFrame = false

  const send = (message: Record<string, unknown>): void => ipcRenderer.send(CHANNEL, message)
  const hide = (): void => {
    if (!current && !inFrame) return
    current = null
    inFrame = false
    send({ type: 'hide' })
  }

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isTrusted) return
      gesture = { target: event.target, tab: false, at: performance.now() }
      // main に「このクリックはメインフレームの文書に届いた」と知らせる（iframe の中のクリックとの見分けに使う。
      // main の before-mouse-event は iframe の中のクリックでも飛ぶが、座標が iframe の中の座標で来るので見分けられない）
      send({ type: 'pointer' })
    },
    true
  )
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) return
      if (event.key === 'Tab') gesture = { target: null, tab: true, at: performance.now() }
      else if (event.key === 'Escape') hide()
    },
    true
  )
  window.addEventListener(
    'focusin',
    (event) => {
      const el = event.target
      inFrame = false
      const kind = fieldKind(el)
      if (!kind || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return
      const fresh = performance.now() - gesture.at < GESTURE_MS
      const target = gesture.target
      const byPointer =
        fresh &&
        target instanceof Node &&
        (target === el ||
          el.contains(target) ||
          (target instanceof HTMLLabelElement && target.control === el) ||
          (target instanceof Element && target.closest('label')?.control === el))
      if (!event.isTrusted || !(byPointer || (fresh && gesture.tab))) return
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) return
      current = el
      send({
        type: 'focus',
        kind,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })
    },
    true
  )
  window.addEventListener(
    'focusout',
    (event) => {
      if (event.target === current) send({ type: 'blur' })
    },
    true
  )
  // タブの切り替え・ウィンドウの切り替えで、ページ自体がフォーカスを失ったとき
  window.addEventListener('blur', () => {
    if (current) send({ type: 'blur' })
    if (document.activeElement instanceof HTMLIFrameElement) inFrame = true
  })
  window.addEventListener('scroll', hide, { capture: true, passive: true })
  window.addEventListener('resize', hide, { passive: true })
  window.addEventListener('pagehide', hide)
}
