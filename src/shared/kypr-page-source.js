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
 * - `__nemoKypr.fillCode(code)` … ワンタイムコードを入れる（フォーカス中の入力欄 → 見えている `autocomplete=one-time-code`
 *   の欄の順）。入れたら true
 * - `__nemoKypr.read()` … 新規作成の下書きに使う。いまの欄の値を 1 回だけ読む
 * - `__nemoKypr.probeCard()` … カードの欄の記述（種類・`maxlength`・`placeholder`・`select` の選択肢）。値は返さない。
 *   入れる値は main が `kypr-card-fill.js` で組み立てる（plan `docs/plans/2026-10-04-1606-kypr-card-autofill.md`）
 * - `__nemoKypr.fillCard(steps)` … 直前の `probeCard()` で集めた欄に、手順どおり値を入れる。入れた欄の数を返す
 * - `__nemoKypr.activeFrame()` … メインフレームでフォーカスのある iframe の位置（無ければ null）
 *
 * 欄の選び方: フォーカスのある欄のフォーム → ページで最初に見えているパスワード欄 の順で、
 * パスワード欄と、その直前にある見えているユーザー名らしい欄を組にする。
 * パスワード欄が無いページ（ユーザー名だけを先に聞く段）は、フォーカスのある欄か、
 * `autocomplete` / `type` がユーザー名・メールの欄だけを対象にする。
 * **カードのフォームの欄（`cardFieldKind` かつ `cardFormComplete`）はログインの欄にしない**（CVC が `type=password` の決済フォームで、サイトのパスワードを入れない）。
 */
import { cardFieldKind, cardFormComplete } from './kypr-card-field.js'

export const KYPR_WORLD_ID = 1733

export const KYPR_PAGE_SOURCE =
  String.raw`
(() => {
  const g = globalThis
  if (g.__nemoKypr) return
  const USER_TYPES = new Set(['text', 'email', 'tel'])
  const cardFieldKind = (` +
  String(cardFieldKind) +
  String.raw`)
  const cardFormComplete = (` +
  String(cardFormComplete) +
  String.raw`)
  const isCardField = (el) => Boolean(cardFieldKind(el)) && cardFormComplete(el)

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

  const visibleInputs = () => [...document.querySelectorAll('input')].filter((el) => isVisible(el) && !isCardField(el))
  let cardEls = []
  const docId = Math.random().toString(36).slice(2)

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
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
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
    fillCode(code) {
      if (typeof code !== 'string' || !/^[0-9]{6,8}$/.test(code)) return false
      const active = document.activeElement
      const typeOk = (el) => ['text', 'tel', 'number', 'password'].includes(typeOf(el))
      let el = null
      if (active instanceof HTMLInputElement && typeOk(active) && isVisible(active)) el = active
      else {
        el =
          visibleInputs().find(
            (i) => typeOk(i) && autocompleteOf(i).split(/\s+/).includes('one-time-code')
          ) || null
      }
      if (!el) return false
      setValue(el, code)
      el.focus()
      return true
    },
    probeCard() {
      const list = []
      const fields = []
      for (const el of document.querySelectorAll('input, select')) {
        if (fields.length >= 40) break
        const kind = cardFieldKind(el)
        if (!kind || !isVisible(el)) continue
        list.push(el)
        const select = el instanceof HTMLSelectElement
        fields.push({
          i: list.length - 1,
          kind,
          tag: select ? 'select' : 'input',
          maxLength: select ? -1 : el.maxLength,
          placeholder: String(el.getAttribute('placeholder') || '').slice(0, 40),
          options: select
            ? [...el.options].slice(0, 150).map((o) => ({
                value: String(o.value).slice(0, 20),
                text: String(o.textContent || '').trim().slice(0, 20)
              }))
            : undefined
        })
      }
      cardEls = list
      const active = document.activeElement
      // 番号・期限・CVC の有無は、フォーカスのある欄のフォーム（無ければ文書）の中で数える（preload の判定と同じ範囲）
      const scope = active && active.form ? active.form : document
      const inScope = fields.filter((f) => scope.contains(list[f.i]))
      return {
        fields,
        hasNumber: inScope.some((f) => f.kind === 'number'),
        // 期限か CVC の欄（メインフレームは番号の欄とそろってカードのフォーム）
        hasOther: inScope.some((f) => f.kind === 'exp' || f.kind === 'exp-month' || f.kind === 'exp-year' || f.kind === 'csc'),
        focused: active !== null && list.includes(active) && isCardField(active),
        secure: g.isSecureContext === true
      }
    },
    fillCard(steps) {
      let n = 0
      for (const step of Array.isArray(steps) ? steps : []) {
        const el = cardEls[step && step.i]
        if (!el || !el.isConnected || !isVisible(el) || typeof step.value !== 'string') continue
        setValue(el, step.value)
        n++
      }
      return n
    },
    activeFrame() {
      const active = document.activeElement
      if (!(active instanceof HTMLIFrameElement)) return null
      const r = active.getBoundingClientRect()
      return {
        doc: docId,
        index: [...document.querySelectorAll('iframe')].indexOf(active),
        src: String(active.src || '').slice(0, 300),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height }
      }
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
