// @ts-check
/**
 * Claude in Nemo のページ側スクリプト（**isolated world で走らせる**）。
 *
 * isolated world にする理由は自動入力（`autofill-collect-source.js`）と同じ:
 * - ページの JS から `__nemoAgent` が見えない（ref の表・覚えた秘密の値をページに渡さない）
 * - `getComputedStyle` / `getBoundingClientRect` をページに差し替えられない
 * - isolated world から native setter で値を入れると React の制御コンポーネントが変更として拾う
 *
 * 持つもの（document ごと。遷移すると world ごと消える）:
 * - ref の表（`ref_N` → WeakRef<Element>）。read_page が振り、computer / form_input が引く
 * - **秘密の値**。Claude が操作していない間（= ユーザーの操作・パスワードマネージャー等の自動入力）に
 *   パスワード系の欄へ入った値を覚え、read_page / get_page_text / スクショの伏せ字に使う。
 *   キー入力を経ない自動入力（untrusted な input / change）も拾う（`before-input-event` だけだと取りこぼす。実測）
 * - taint（この document でユーザーがパスワード系の欄に入力した）。javascript_tool を断る根拠
 * - scriptRan（この document で Claude が javascript_tool を実行した / opener でつながったページで実行した）。
 *   kypr・フォーム自動入力がこの document に値を入れない根拠（仕込まれた JS に拾わせない）。遷移で消える
 * - 「一度でもパスワード欄だった要素」（「パスワードを表示」で type=text に変わっても伏せる。実測で漏れた）
 *
 * ソースを文字列で持つのは `autofill-collect-source.js` と同じ理由（ビルドの変換を通さない）。
 * **テンプレート文字列と `${` を中に書かない**（`String.raw` の外に漏れる）。
 */
import { cardFieldKind } from './kypr-card-field.js'

export const AGENT_WORLD_ID = 1733

export const AGENT_PAGE_SOURCE =
  String.raw`
(() => {
  const g = globalThis
  if (g.__nemoAgent) return
  const MAX_NODES = 4000
  const INVISIBLE = /[\u2800\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8]/g
  const SENSITIVE_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i
  // カードの番号・CVC の欄は autocomplete が無くても伏せる（kypr のカードの自動入力と同じ判定。kypr-card-field.js）
  const cardFieldKind = (` +
  String(cardFieldKind) +
  String.raw`)

  let agentActive = false
  let tainted = false
  let scriptRan = false
  const secrets = new Set()
  const everPassword = new WeakSet()
  const refs = new Map()
  const refOf = new WeakMap()
  let refCounter = 0

  const clean = (value, max) =>
    String(value == null ? '' : value)
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)

  const redact = (text) => {
    let out = String(text == null ? '' : text)
    for (const secret of secrets) {
      if (secret.length >= 4 && out.includes(secret)) out = out.split(secret).join('[redacted]')
    }
    return out
  }

  const isPasswordish = (el) => {
    if (!(el instanceof HTMLInputElement)) return false
    if (el.type === 'password') return true
    if (everPassword.has(el)) return true
    const ac = el.getAttribute('autocomplete') || ''
    if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true
    const card = cardFieldKind(el)
    return card === 'number' || card === 'csc'
  }

  const markPasswords = (root) => {
    const list = (root || document).querySelectorAll ? (root || document).querySelectorAll('input[type=password]') : []
    for (const el of list) everPassword.add(el)
  }
  markPasswords(document)
  try {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLInputElement) {
          if (record.oldValue === 'password' || record.target.type === 'password') everPassword.add(record.target)
        }
        for (const node of record.addedNodes || []) {
          if (node instanceof Element) {
            if (node instanceof HTMLInputElement && node.type === 'password') everPassword.add(node)
            markPasswords(node)
          }
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true })
  } catch (e) {}

  // Claude が操作していない間に、パスワード系の欄へ入った値を覚える（ユーザーの手入力・自動入力）
  const onUserValue = (event) => {
    if (agentActive) return
    const el = event.target
    if (!(el instanceof HTMLInputElement) || !isPasswordish(el)) return
    const value = el.value
    if (value && value.length >= 4) secrets.add(value)
    tainted = true
  }
  document.addEventListener('input', onUserValue, true)
  document.addEventListener('change', onUserValue, true)

  // Claude の操作中は、閉じられないネイティブ UI（select の NSMenu・日付 / 色のピッカー）を開かせない（実測で画面に残った）
  const PICKER_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'color'])
  const blockNativePicker = (event) => {
    if (!agentActive) return
    const el = event.target
    if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && PICKER_TYPES.has(el.type))) {
      event.preventDefault()
    }
  }
  document.addEventListener('mousedown', blockNativePicker, true)

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false
    const rects = el.getClientRects()
    if (rects.length === 0) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    return true
  }

  const refFor = (el) => {
    let ref = refOf.get(el)
    if (ref && refs.get(ref) && refs.get(ref).deref() === el) return ref
    refCounter += 1
    ref = 'ref_' + refCounter
    refs.set(ref, new WeakRef(el))
    refOf.set(el, ref)
    return ref
  }

  const resolve = (ref) => {
    const holder = refs.get(String(ref))
    const el = holder ? holder.deref() : null
    return el && el.isConnected ? el : null
  }

  const textOf = (el) => clean(el.innerText || el.textContent || '', 120)

  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria, 120)
    const labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
      const text = parts.map((node) => node.textContent || '').join(' ')
      if (text.trim()) return clean(text, 120)
    }
    if (el.id) {
      try {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (label) return clean(label.textContent, 120)
      } catch (e) {}
    }
    const wrapping = el.closest('label')
    if (wrapping) {
      // 包んでいる label の文字から、欄そのもの（select の選択肢など）の文字を除く
      let own = ''
      const walker = document.createTreeWalker(wrapping, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (el.contains(node)) continue
        const parent = node.parentElement
        if (parent && parent.closest('select, option, textarea')) continue
        own += node.textContent
      }
      if (own.trim()) return clean(own, 120)
    }
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return clean(placeholder, 120)
    const title = el.getAttribute('title')
    if (title) return clean(title, 120)
    if (el instanceof HTMLImageElement) return clean(el.alt, 120)
    return ''
  }

  const INPUT_ROLE = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    file: 'file',
    search: 'searchbox'
  }
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'listbox', 'treeitem', 'file'
  ])

  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').split(/\s+/)[0]
    if (explicit) return explicit
    const tag = el.tagName
    if (tag === 'A' && el.hasAttribute('href')) return 'link'
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button'
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'INPUT') {
      if (el.type === 'hidden') return null
      return INPUT_ROLE[el.type] || 'textbox'
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox'
    if (/^H[1-6]$/.test(tag)) return 'heading'
    if (tag === 'IMG') return 'img'
    if (tag === 'IFRAME') return 'iframe'
    return null
  }

  const describe = (el, role) => {
    const parts = []
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        parts.push(el.checked ? 'checked' : 'unchecked')
      } else if (el instanceof HTMLInputElement && el.type === 'file') {
        parts.push('files=' + (el.files ? el.files.length : 0))
      } else {
        const value = el.value
        if (value) parts.push('value="' + (isPasswordish(el) ? '[redacted]' : redact(clean(value, 200))) + '"')
        if (el instanceof HTMLInputElement && el.type !== 'text') parts.push('type=' + el.type)
      }
      if (el.required) parts.push('required')
    } else if (el instanceof HTMLSelectElement) {
      const selected = [...el.selectedOptions].map((option) => clean(option.label || option.text, 60))
      parts.push('selected=' + JSON.stringify(selected))
      const options = [...el.options].slice(0, 30).map((option) => clean(option.label || option.text, 40))
      parts.push('options=' + JSON.stringify(options) + (el.options.length > 30 ? '…' : ''))
    } else if (el.isContentEditable) {
      const text = clean(el.innerText, 200)
      if (text) parts.push('value="' + redact(text) + '"')
    }
    if (role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript:')) parts.push('href=' + clean(href, 120))
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) parts.push('expanded=' + expanded)
    return parts.join(' ')
  }

  const inViewport = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
  }

  const tree = (options) => {
    const filter = options && options.filter === 'all' ? 'all' : 'interactive'
    const maxDepth = Math.max(1, Math.min(Number(options && options.depth) || 25, 40))
    const maxChars = Math.max(1000, Math.min(Number(options && options.maxChars) || 20000, 100000))
    const root = options && options.ref ? resolve(options.ref) : document.body
    if (!root) return { error: 'ref が見つかりません（ページが変わった可能性。read_page をやり直してください）' }
    const lines = []
    let count = 0
    let truncated = false
    const walk = (el, depth, printedDepth) => {
      if (truncated || depth > maxDepth) return
      if (count >= MAX_NODES) {
        truncated = true
        return
      }
      if (!(el instanceof Element)) return
      const tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'svg') return
      if (el.getAttribute('aria-hidden') === 'true') return
      const role = roleOf(el)
      let printed = false
      if (role && (INTERACTIVE_ROLES.has(role) || filter === 'all' || role === 'heading' || role === 'iframe') && isVisible(el)) {
        count += 1
        const name = role === 'textbox' || role === 'searchbox' ? labelOf(el) : labelOf(el) || textOf(el)
        const extra = describe(el, role)
        const flag = inViewport(el) ? '' : ' (offscreen)'
        lines.push(
          '  '.repeat(printedDepth) + '- ' + role + (name ? ' "' + redact(name) + '"' : '') +
          ' [' + refFor(el) + ']' + (extra ? ' ' + extra : '') + flag
        )
        printed = true
      } else if (filter === 'all' && isVisible(el)) {
        let own = ''
        for (const child of el.childNodes) if (child.nodeType === 3) own += child.textContent
        own = clean(own, 200)
        if (own) {
          count += 1
          lines.push('  '.repeat(printedDepth) + '- text "' + redact(own) + '"')
        }
      }
      const next = printed && filter === 'all' ? printedDepth + 1 : printedDepth
      const children = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : el.children
      for (const child of children) walk(child, depth + 1, next)
    }
    walk(root, 0, 0)
    let text = lines.join('\n')
    if (text.length > maxChars) {
      text = text.slice(0, maxChars)
      truncated = true
    }
    return {
      url: location.href,
      title: redact(clean(document.title, 200)),
      viewport: innerWidth + 'x' + innerHeight,
      scroll: Math.round(scrollX) + ',' + Math.round(scrollY) + ' of ' + document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight,
      tree: text,
      truncated
    }
  }

  const pageText = (options) => {
    const maxChars = Math.max(1000, Math.min(Number(options && options.maxChars) || 20000, 100000))
    const main = document.querySelector('main, article, [role=main]')
    let text = (main && main.innerText && main.innerText.trim().length > 200 ? main.innerText : document.body ? document.body.innerText : '') || ''
    text = redact(String(text).replace(INVISIBLE, ''))
    const truncated = text.length > maxChars
    return { url: location.href, title: redact(clean(document.title, 200)), text: text.slice(0, maxChars), truncated }
  }

  // 要素の中心（CSS px、ビューポート座標）。画面外なら中央へスクロールしてから測る
  const point = (ref) => {
    const el = resolve(ref)
    if (!el) return { error: 'ref が見つかりません（ページが変わった可能性。read_page をやり直してください）' }
    let rect = el.getBoundingClientRect()
    if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      rect = el.getBoundingClientRect()
    }
    if (rect.width === 0 && rect.height === 0) return { error: '要素が表示されていません' }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  const scrollTo = (ref) => {
    const el = resolve(ref)
    if (!el) return { error: 'ref が見つかりません' }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    return { ok: true }
  }

  const nativeSetter = (el) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    return desc && desc.set ? (value) => desc.set.call(el, value) : (value) => { el.value = value }
  }

  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const setValue = (ref, value) => {
    const el = resolve(ref)
    if (!el) return { error: 'ref が見つかりません（read_page をやり直してください）' }
    if (el instanceof HTMLSelectElement) {
      const wanted = String(value)
      const option = [...el.options].find((o) => o.value === wanted) || [...el.options].find((o) => clean(o.label || o.text, 200) === clean(wanted, 200))
      if (!option) return { error: '選択肢が見つかりません: ' + wanted }
      el.value = option.value
      fire(el)
      return { ok: true, value: clean(option.label || option.text, 80) }
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = value === true || value === 'true' || value === 1
      if (el.checked !== want) {
        el.checked = want
        fire(el)
      }
      return { ok: true, value: el.checked }
    }
    if (el instanceof HTMLInputElement && el.type === 'file') return { error: 'ファイルは file_upload を使ってください' }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus()
      nativeSetter(el)(String(value))
      fire(el)
      return { ok: true }
    }
    if (el.isContentEditable) {
      el.focus()
      el.textContent = String(value)
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return { ok: true }
    }
    return { error: '値を入れられる要素ではありません' }
  }

  // file_upload: CDP から引けるよう一時的な印を付ける
  const markFileInput = (ref, nonce) => {
    const el = resolve(ref)
    if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { error: 'input[type=file] ではありません' }
    el.setAttribute('data-nemo-agent-upload', nonce)
    return { ok: true, multiple: el.multiple }
  }
  const unmarkFileInput = (nonce) => {
    const el = document.querySelector('[data-nemo-agent-upload="' + nonce + '"]')
    if (el) el.removeAttribute('data-nemo-agent-upload')
    return { ok: true }
  }

  // スクショの前に秘密が見えている場所を塗る（type=password は元から伏せ字なので対象外）
  let masks = []
  const maskSecrets = () => {
    unmaskSecrets()
    const targets = []
    for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
      if (!isVisible(el)) continue
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText
      const revealed = el instanceof HTMLInputElement && el.type !== 'password' && isPasswordish(el) && value
      let hasSecret = false
      for (const secret of secrets) if (secret.length >= 4 && String(value || '').includes(secret)) hasSecret = true
      if (revealed || hasSecret) targets.push(el.getBoundingClientRect())
    }
    for (const rect of targets) {
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;background:#000;pointer-events:none;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'
      document.documentElement.appendChild(box)
      masks.push(box)
    }
    return { masked: masks.length }
  }
  const unmaskSecrets = () => {
    for (const box of masks) box.remove()
    masks = []
    return { ok: true }
  }

  g.__nemoAgent = {
    setActive: (value) => {
      agentActive = value === true
      return { ok: true }
    },
    state: () => ({ tainted, scriptRan, secrets: secrets.size, url: location.href }),
    // Nemo の UI（kypr・フォーム自動入力）がこのページに値を入れる**前に**呼ぶ。
    // **scriptRan と tainted は同じ world の中で排他に立てる**（main 側で確かめてから立てると、その間に
    // javascript_tool が割り込める）。Claude が JS を実行した document では覚えずに断る
    rememberSecrets: (values) => {
      if (scriptRan) return { ok: false, reason: 'script' }
      for (const value of Array.isArray(values) ? values : []) {
        if (typeof value === 'string' && value.length >= 4) secrets.add(value)
      }
      tainted = true
      return { ok: true }
    },
    // javascript_tool の実行前に main が呼ぶ（この document には kypr が値を入れない）。
    // 実行する document（onlyIfClean）では、ユーザーが秘密を入れていたら立てずに断る。
    // opener でつながったページには taint によらず立てる
    markScriptRan: (onlyIfClean) => {
      if (onlyIfClean === true && tainted) return { ok: false, reason: 'tainted' }
      scriptRan = true
      return { ok: true }
    },
    tree,
    pageText,
    point,
    scrollTo,
    setValue,
    markFileInput,
    unmarkFileInput,
    maskSecrets,
    unmaskSecrets
  }
})()
`

/**
 * main world に入れる**ガード**（`Page.addScriptToEvaluateOnNewDocument`）。
 * 閉じられないネイティブ UI（印刷パネル・`showPicker`）とクリップボードの上書き（`execCommand('copy')` は
 * permission handler を通らない。実測）を、エージェント窓のページでは起こさせない。
 */
export const AGENT_MAIN_WORLD_GUARD = String.raw`
(() => {
  if (window.__nemoAgentGuardInstalled) return
  Object.defineProperty(window, '__nemoAgentGuardInstalled', { value: true })
  try {
    window.print = function () { console.warn('[Nemo] window.print() は Claude の操作ウィンドウでは使えません') }
  } catch (e) {}
  try {
    const refuse = function () { throw new DOMException('showPicker は Claude の操作ウィンドウでは使えません', 'NotAllowedError') }
    HTMLInputElement.prototype.showPicker = refuse
    if (window.HTMLSelectElement && HTMLSelectElement.prototype.showPicker) HTMLSelectElement.prototype.showPicker = refuse
  } catch (e) {}
  try {
    const original = Document.prototype.execCommand
    Document.prototype.execCommand = function (command) {
      const name = String(command).toLowerCase()
      if (name === 'copy' || name === 'cut' || name === 'paste') return false
      return original.apply(this, arguments)
    }
  } catch (e) {}
})()
`
