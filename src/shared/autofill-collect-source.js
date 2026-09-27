// @ts-check
import { AUTOCOMPLETE } from './autofill-match.js'

/**
 * フォーム自動入力のページ側スクリプト（**isolated world で走らせる**）。
 *
 * isolated world にする理由:
 * - ページの JS から `__nemoAutofill` が見えない（収集した要素の参照をページに渡さない）
 * - `getComputedStyle` / `getBoundingClientRect` をページに差し替えられない。
 *   メインワールドで走らせると、ページが可視判定を偽って**見えない欄に値を入れさせる**ことができる
 * - React の制御コンポーネントは value の変更を「メインワールドの setter を通ったか」で見ているので、
 *   isolated world から native setter で入れると変更として拾われる
 *
 * ソースを文字列で持つのは `http-auth-worker-source.js` と同じ理由（ビルドの変換を通さない）。
 * **テンプレート文字列と `${` を中に書かない**（`String.raw` の外に漏れる）。
 *
 * - `__nemoAutofillCollect(x, y)` … 右クリックした位置の欄を含むフォームから、空の欄を集める
 * - `__nemoAutofillFill(steps)` … 集めた欄に値を入れる。**収集のあとに値が入った欄は触らない**
 */
export const AUTOFILL_WORLD_ID = 1732

/**
 * ルールで決まる `autocomplete` の値（`autofill-match.js` の対応表と同じもの）。
 * **`const` で宣言しない**（同じ world で 2 回目に注入すると `already been declared` で落ちる）。
 */
const RULE_TOKENS = `globalThis.__nemoAutofillRuleTokens = ${JSON.stringify(Object.keys(AUTOCOMPLETE))};\n`

export const AUTOFILL_PAGE_SOURCE =
  RULE_TOKENS +
  String.raw`
(() => {
  const g = globalThis
  if (g.__nemoAutofillCollect) return
  const MAX_ELEMENTS = 300
  const TEXT_TYPES = new Set(['text', 'email', 'tel', 'number', 'url', 'date'])

  const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
  // placeholder は全角空白を残す（\s は U+3000 も拾う。例の姓名の区切りが全角かを formatForElement が見る）
  const cleanKeepingFullwidthSpace = (value, max) =>
    String(value || '')
      .replace(/[^\S\u3000]+/g, ' ')
      .trim()
      .slice(0, max)

  // ルールで決まる autocomplete か（off / on / nope や知らない値は「無し」と同じ扱い）
  const hasRuleToken = (autocomplete) => {
    const tokens = autocomplete.toLowerCase().split(/\s+/).filter(Boolean)
    return g.__nemoAutofillRuleTokens.includes(tokens[tokens.length - 1])
  }

  const kindOf = (el) => {
    if (el instanceof HTMLTextAreaElement) return 'textarea'
    if (el instanceof HTMLSelectElement) return el.multiple ? null : 'select'
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return TEXT_TYPES.has(type) ? 'input' : null
    }
    return null
  }

  const isEmpty = (el) => {
    if (el instanceof HTMLSelectElement) return el.selectedIndex <= 0 || el.value === ''
    return el.value === ''
  }

  // **見えない欄には入れない**（見えない欄に個人情報を入れさせて抜き取る手口がある）
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
    // 祖先の overflow: hidden / clip で切られている（auto / scroll はスクロールすれば見えるので切らない）
    for (let p = el.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
      const style = getComputedStyle(p)
      const clips = /hidden|clip/.test(style.overflowX + ' ' + style.overflowY)
      if (!clips) continue
      const box = p.getBoundingClientRect()
      const w = Math.min(rect.right, box.right) - Math.max(rect.left, box.left)
      const h = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)
      if (w < 4 || h < 4) return false
    }
    return true
  }

  const textWithout = (node) => {
    const copy = node.cloneNode(true)
    for (const inner of copy.querySelectorAll('input, select, textarea, option, script, style')) inner.remove()
    return copy.textContent || ''
  }

  const labelOf = (el) => {
    const parts = []
    if (el.labels) for (const label of el.labels) parts.push(textWithout(label))
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const target = document.getElementById(id)
        if (target) parts.push(textWithout(target))
      }
    }
    if (parts.length === 0 && el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'))
    return clean(parts.join(' '), 60)
  }

  // 表の見出し（td なら同じ行の th、dd なら直前の dt）
  const headingOf = (el) => {
    const cell = el.closest('td, dd')
    if (cell && cell.tagName === 'TD') {
      const row = cell.closest('tr')
      const th = row && row.querySelector('th')
      if (th) return clean(textWithout(th), 40)
      // th の無い表（官公庁のフォーム等）は左隣の td が見出し
      let prev = cell.previousElementSibling
      while (prev && prev.tagName === 'TD' && prev.querySelector('input, select, textarea')) prev = prev.previousElementSibling
      // 極端に長い td は見出しでない（表で組んだページの左のナビなど）。見出しの説明が続く td
      // （「メールアドレス（参加可否連絡用）ログインの際に…」）は拾いたいので、しきい値は緩くして頭の 40 字を使う
      const text = prev && prev.tagName === 'TD' ? clean(textWithout(prev), 201) : ''
      if (text && text.length <= 200) return text.slice(0, 40)
    }
    if (cell && cell.tagName === 'DD') {
      let prev = cell.previousElementSibling
      while (prev && prev.tagName !== 'DT') prev = prev.previousElementSibling
      if (prev) return clean(textWithout(prev), 40)
    }
    return ''
  }

  // 見出しが無い欄の近くの文字。**欄のすぐ前の文字を表の見出しより優先する**
  // （th「ご住所」の中に「郵便番号」「市区町村」… と並ぶフォームで、th を拾うと全部同じ見出しになる）。
  // kind: 'element'（label / span などの見出し）/ 'text'（地の文）/ 'control'（すぐ前が別の欄）/ 'heading'（th / dt）
  const nearbyOf = (el) => {
    const heading = headingOf(el)
    const cell = el.closest('td, dd')
    let node = el
    for (let depth = 0; depth < 4 && node && node !== cell && node !== document.body; depth += 1) {
      for (let prev = node.previousSibling; prev; prev = prev.previousSibling) {
        if (prev.nodeType === Node.TEXT_NODE) {
          const t = clean(prev.textContent, 40)
          // 「-」「〜」のような区切りは見出しにしない（「〒」は記号だが郵便番号の見出し）
          if (t && /[\p{L}\p{N}〒]/u.test(t)) return { text: t, kind: 'text', heading }
          continue
        }
        if (prev.nodeType !== Node.ELEMENT_NODE) continue
        if (prev.matches('input, select, textarea') || prev.querySelector('input, select, textarea')) {
          return { text: '', kind: 'control', heading }
        }
        const t = clean(textWithout(prev), 40)
        if (t) return { text: t, kind: 'element', heading }
      }
      node = node.parentElement
    }
    return { text: heading, kind: 'heading', heading }
  }

  const sampleOf = (el) => {
    if (!(el instanceof HTMLSelectElement)) return []
    const out = []
    for (const option of el.options) {
      const t = clean(option.text, 30)
      if (!t || option.value === '' || /選択|選んで|^[-ー―]+$/.test(t)) continue
      out.push(t)
      if (out.length >= 5) break
    }
    return out
  }

  // region: iframe のとき、親ページで見えている範囲（iframe の表示領域の座標）。この外の欄は集めない
  const inRegion = (el, region) => {
    if (!region) return true
    const r = el.getBoundingClientRect()
    // 親で縮小されていると、中では大きくても見た目は潰れている
    if (r.width * region.scaleX < 4 || r.height * region.scaleY < 4) return false
    // 見えている範囲（表示領域の座標）を、**中をスクロールして届く範囲まで**文書の座標で広げる。
    // 位置で絞るのをやめると、親が iframe の上の帯だけを見せる手口が通る（帯の外は中をスクロールしても帯に入らない）
    const doc = document.scrollingElement || document.documentElement
    const clips = (node) => /hidden|clip/.test(getComputedStyle(node).overflowX + ' ' + getComputedStyle(node).overflowY)
    const scrolls = region.scrollable && !clips(document.documentElement) && !clips(document.body)
    const maxX = scrolls ? Math.max(0, doc.scrollWidth - doc.clientWidth) : window.scrollX
    const maxY = scrolls ? Math.max(0, doc.scrollHeight - doc.clientHeight) : window.scrollY
    const minX = scrolls ? 0 : window.scrollX
    const minY = scrolls ? 0 : window.scrollY
    const left = r.left + window.scrollX
    const top = r.top + window.scrollY
    const w = Math.min(left + r.width, region.right + maxX) - Math.max(left, region.left + minX)
    const h = Math.min(top + r.height, region.bottom + maxY) - Math.max(top, region.top + minY)
    return w >= 4 && h >= 4
  }

  // 分割欄の区切りとみなす 1 文字: 文字でも数字でもない記号（「〒」は見出しなので除く）か単位。
  // 「姓」「名」の 1 文字は区切りでなく見出し（区切り扱いにすると前の欄とまとめてしまう）
  // 必須の印（* ※）も区切りでない
  const SEPARATOR = /^(?:(?![〒*＊※])[^\p{L}\p{N}]|[年月日時分秒])$/u

  g.__nemoAutofillCollect = (x, y, region) => {
    const active = document.activeElement
    const anchor = active && kindOf(active) ? active : document.elementFromPoint(x, y)
    // フォームが無いページはページ全体（Jev が関係ない欄を none で落とす）
    const root = (anchor && anchor.closest('form')) || document.body
    const els = []
    const elements = []
    const raw = []
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (els.length >= MAX_ELEMENTS) break
      const tag = kindOf(el)
      if (!tag || !isEmpty(el) || !isVisible(el) || !inRegion(el, region)) continue
      els.push(el)
      const maxLength = el instanceof HTMLSelectElement ? -1 : el.maxLength
      const element = {
        tag,
        type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
        placeholder: cleanKeepingFullwidthSpace(el.getAttribute('placeholder'), 60),
        maxLength: maxLength > 0 ? maxLength : null
      }
      if (tag === 'select') {
        element.options = Array.from(el.options)
          .slice(0, 500)
          .map((option) => ({ value: clean(option.value, 60), text: clean(option.text, 60) }))
      }
      elements.push(element)
      raw.push({
        index: els.length - 1,
        el,
        tag,
        label: labelOf(el),
        near: nearbyOf(el),
        name: clean(el.getAttribute('name'), 60),
        idAttr: clean(el.id, 60),
        autocomplete: clean(el.getAttribute('autocomplete'), 60),
        placeholder: element.placeholder
      })
    }

    // 分割された欄（電話 3 つ・郵便番号 2 つ・生年月日 3 つ・姓名 2 つ）を 1 つにまとめる。
    // 続く欄が**自分の見出しを持たない**もの（label が無く、すぐ前が別の欄か「年」「-」のような
    // 1 文字の区切り）で、近い祖先を共有しているもの。見出しが同じだけではまとめない
    // （th「ご住所」の中に「市区町村」「町名番地」… と並ぶ欄をまとめてしまう）。
    // **ルールで決まる autocomplete を持つ欄はまとめない**（欄ごとにルールで決まる。まとめると先頭の欄の
    // family-name だけで決まり、2 欄に割れずに両方空になる）。off などはまとめる（電話 3 分割によく付く）
    const fields = []
    for (let i = 0; i < raw.length; ) {
      const head = raw[i]
      // 区切りは地の文でも要素（<span>年</span>）でもよい（SEPARATOR）
      const headless = (m) =>
        !m.label &&
        (m.near.kind === 'control' ||
          ((m.near.kind === 'text' || m.near.kind === 'element') && SEPARATOR.test(m.near.text)))
      let j = i + 1
      if (head.tag !== 'textarea' && !hasRuleToken(head.autocomplete)) {
        while (
          j < raw.length &&
          j - i < 3 &&
          raw[j].tag !== 'textarea' &&
          headless(raw[j]) &&
          !hasRuleToken(raw[j].autocomplete) &&
          commonDepth(head.el, raw[j].el) <= 2
        ) {
          j += 1
        }
      }
      const members = raw.slice(i, j)
      fields.push({
        label: head.label,
        nearby: head.near.text,
        // 表の見出し（「ご住所」など）。欄の見出しと別のときだけ渡す
        section: head.near.kind === 'heading' ? '' : head.near.heading,
        name: members.map((m) => m.name).filter(Boolean).join(' / '),
        idAttr: head.idAttr,
        autocomplete: head.autocomplete,
        placeholder: members.map((m) => m.placeholder).filter(Boolean).join(' / '),
        members: members.map((m) => m.index),
        optionsSample: sampleOf(head.el)
      })
      i = j
    }

    g.__nemoAutofill = { els }
    return { pageTitle: clean(document.title, 100), elements, fields }
  }

  // 2 つの要素の共通の祖先まで、b から何段上がるか
  function commonDepth(a, b) {
    let depth = 0
    for (let p = b.parentElement; p; p = p.parentElement, depth += 1) {
      if (p.contains(a)) return depth
    }
    return Infinity
  }

  const valueSetter = (el) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    return Object.getOwnPropertyDescriptor(proto, 'value').set
  }

  g.__nemoAutofillFill = (steps) => {
    const state = g.__nemoAutofill
    let filled = 0
    let skipped = 0
    for (const step of steps) {
      const el = state && state.els[step.element]
      // 収集のあとに消えた / 人が入れた欄は触らない
      if (!el || !el.isConnected || !isEmpty(el)) {
        skipped += 1
        continue
      }
      if (el instanceof HTMLSelectElement) {
        if (typeof step.optionIndex !== 'number' || step.optionIndex < 0 || step.optionIndex >= el.options.length) {
          skipped += 1
          continue
        }
        el.selectedIndex = step.optionIndex
      } else {
        if (typeof step.value !== 'string') {
          skipped += 1
          continue
        }
        valueSetter(el).call(el, step.value)
        // type=number にハイフン入りを入れると空になる。入っていないものを数えない
        if (el.value === '' && step.value !== '') {
          skipped += 1
          continue
        }
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled += 1
    }
    g.__nemoAutofill = null
    return { filled, skipped }
  }
})()
`
