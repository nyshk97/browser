/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import { KYPR_PRODUCTION_SERVER } from '../shared/kypr-config.js'
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

function loginFieldKind(el: EventTarget | null): 'username' | 'password' | null {
  if (!(el instanceof HTMLInputElement)) return null
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
    const password = form.querySelector('input[type="password" i]')
    if (password && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) return 'username'
  }
  return null
}

if (window.top === window && /^https?:$/.test(location.protocol)) {
  let gesture: { target: EventTarget | null; tab: boolean; at: number } = { target: null, tab: false, at: 0 }
  let current: HTMLInputElement | null = null

  const send = (message: Record<string, unknown>): void => ipcRenderer.send(CHANNEL, message)
  const hide = (): void => {
    if (!current) return
    current = null
    send({ type: 'hide' })
  }

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted) gesture = { target: event.target, tab: false, at: performance.now() }
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
      const kind = loginFieldKind(el)
      if (!kind || !(el instanceof HTMLInputElement)) return
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
  })
  window.addEventListener('scroll', hide, { capture: true, passive: true })
  window.addEventListener('resize', hide, { passive: true })
  window.addEventListener('pagehide', hide)
}
