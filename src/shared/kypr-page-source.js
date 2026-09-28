// @ts-check
/**
 * kypr のログインの入力で、ページ側で走らせるスクリプト（**isolated world で走らせる**）。
 *
 * isolated world にする理由は `autofill-collect-source.js` と同じ（ページが可視判定を偽って見えない欄に
 * パスワードを入れさせる・入れた値を横取りする、をさせない。React の制御コンポーネントも native setter で拾われる）。
 *
 * ソースを文字列で持つのも同じ理由（ビルドの変換を通さない）。**テンプレート文字列と `${` を中に書かない**。
 *
 * - `__nemoKypr.probe()` … 入れる先の欄があるか（`{ hasPassword, hasUsername, focused }`）。値は返さない
 * - `__nemoKypr.fill(username, password)` … 欄に入れる（見えている欄だけ）。入れた欄を返す
 * - `__nemoKypr.read()` … 新規作成の下書きに使う。いまの欄の値を 1 回だけ読む
 *
 * 欄の選び方: フォーカスのある欄のフォーム → ページで最初に見えているパスワード欄 の順で、
 * パスワード欄と、その直前にある見えているユーザー名らしい欄を組にする。
 * パスワード欄が無いページ（ユーザー名だけを先に聞く段）は、フォーカスのある欄か、
 * `autocomplete` / `type` がユーザー名・メールの欄だけを対象にする。
 */
export const KYPR_WORLD_ID = 1733

export const KYPR_PAGE_SOURCE = String.raw`
(() => {
  const g = globalThis
  if (g.__nemoKypr) return
  const USER_TYPES = new Set(['text', 'email', 'tel'])

  // **見えない欄には入れない**（autofill-collect-source.js の isVisible と同じ基準）
  const isVisible = (el) => {
    if (el.disabled || el.readOnly) return false
    if (el.closest('[aria-hidden="true"], [inert]')) return false
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
      return false
    }
    const rect = el.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return false
    const doc = document.documentElement
    const left = rect.left + window.scrollX
    const top = rect.top + window.scrollY
    if (left + rect.width <= 0 || top + rect.height <= 0) return false
    if (left >= Math.max(doc.scrollWidth, doc.clientWidth) || top >= Math.max(doc.scrollHeight, doc.clientHeight)) {
      return false
    }
    for (let p = el.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
      const style = getComputedStyle(p)
      if (!/hidden|clip/.test(style.overflowX + ' ' + style.overflowY)) continue
      const box = p.getBoundingClientRect()
      const w = Math.min(rect.right, box.right) - Math.max(rect.left, box.left)
      const h = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)
      if (w < 4 || h < 4) return false
    }
    return true
  }

  const typeOf = (el) => (el.getAttribute('type') || 'text').toLowerCase()
  const isPassword = (el) => el instanceof HTMLInputElement && typeOf(el) === 'password'
  const isUserLike = (el) => el instanceof HTMLInputElement && USER_TYPES.has(typeOf(el))
  const autocompleteOf = (el) => (el.getAttribute('autocomplete') || '').toLowerCase()
  const looksLikeUsername = (el) =>
    isUserLike(el) &&
    (/\b(username|email)\b/.test(autocompleteOf(el)) ||
      typeOf(el) === 'email' ||
      /user|login|mail|account|signin|id$/i.test((el.name || '') + ' ' + (el.id || '')))

  const visibleInputs = () => [...document.querySelectorAll('input')].filter(isVisible)

  const find = () => {
    const inputs = visibleInputs()
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
    const passwords = inputs.filter(isPassword)
    let password = null
    if (active && isPassword(active) && isVisible(active)) password = active
    else if (active && active.form) password = passwords.find((p) => p.form === active.form) || null
    if (!password) {
      // 新規登録の「新しいパスワード」より、ログインの欄を先に選ぶ
      password =
        passwords.find((p) => autocompleteOf(p).includes('current-password')) ||
        passwords.find((p) => !autocompleteOf(p).includes('new-password')) ||
        passwords[0] ||
        null
    }
    let username = null
    if (password) {
      const scope = password.form ? inputs.filter((el) => el.form === password.form) : inputs
      const before = scope.filter(
        (el) => isUserLike(el) && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING
      )
      username = before.length > 0 ? before[before.length - 1] : null
    } else if (active && isUserLike(active) && isVisible(active)) {
      username = active
    } else {
      username = inputs.find(looksLikeUsername) || null
    }
    return { username, password }
  }

  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  g.__nemoKypr = {
    probe() {
      const f = find()
      const active = document.activeElement
      return {
        hasPassword: f.password !== null,
        hasUsername: f.username !== null,
        // ユーザーがいまその欄にいる（ユーザー名だけを先に聞く段でも、このフレームを入れる先にする）
        focused: document.hasFocus() && active !== null && (active === f.password || active === f.username)
      }
    },
    fill(username, password) {
      const f = find()
      const out = { username: false, password: false }
      if (f.username && typeof username === 'string' && username !== '') {
        setValue(f.username, username)
        out.username = true
      }
      if (f.password && typeof password === 'string' && password !== '') {
        setValue(f.password, password)
        out.password = true
      }
      const last = out.password ? f.password : out.username ? f.username : null
      if (last) last.focus()
      return out
    },
    read() {
      const f = find()
      return {
        username: f.username ? String(f.username.value || '').slice(0, 1000) : '',
        password: f.password ? String(f.password.value || '').slice(0, 1000) : ''
      }
    }
  }
})()
`
