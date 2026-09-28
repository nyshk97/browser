/**
 * `computer` の key アクションの文字列（"cmd+a" / "Enter" / "shift+ArrowDown Tab"）を
 * CDP の `Input.dispatchKeyEvent` の引数に写す。
 *
 * **クリップボードは触らせない**（cmd+c / cmd+x / cmd+v と `commands: copy/cut/paste` は拒否）。
 * CDP の key に `commands: ['paste']` を付けると `clipboard-read` を拒否していてもシステムの
 * クリップボードが貼られた（実測。Bitwarden の TOTP 自動コピーや、ユーザーがコピーしたパスワードが入りうる）。
 */

export interface KeyStroke {
  key: string
  code: string
  keyCode: number
  /** CDP の modifiers ビット（Alt=1, Ctrl=2, Meta=4, Shift=8）。 */
  modifiers: number
  /** keyDown に付ける文字（修飾なしの印字可能キーのときだけ）。 */
  text: string | undefined
  /** mac の editing commands（cmd+a → selectAll 等）。 */
  commands: string[]
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  opt: 1,
  ctrl: 2,
  control: 2,
  cmd: 4,
  command: 4,
  meta: 4,
  super: 4,
  shift: 8
}

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  f1: { key: 'F1', code: 'F1', keyCode: 112 },
  f2: { key: 'F2', code: 'F2', keyCode: 113 },
  f3: { key: 'F3', code: 'F3', keyCode: 114 },
  f4: { key: 'F4', code: 'F4', keyCode: 115 },
  f5: { key: 'F5', code: 'F5', keyCode: 116 }
}

/** mac の editing commands（Chromium は cmd+a を keyDown だけでは全選択しない。実測で `commands` が要る）。 */
const MAC_COMMANDS: Record<string, string> = {
  'meta+a': 'selectAll',
  'meta+z': 'undo',
  'meta+shift+z': 'redo',
  'meta+arrowleft': 'moveToBeginningOfLine',
  'meta+arrowright': 'moveToEndOfLine',
  'meta+arrowup': 'moveToBeginningOfDocument',
  'meta+arrowdown': 'moveToEndOfDocument',
  'meta+backspace': 'deleteToBeginningOfLine',
  'alt+backspace': 'deleteWordBackward',
  'alt+arrowleft': 'moveWordLeft',
  'alt+arrowright': 'moveWordRight'
}

const FORBIDDEN = new Set(['meta+c', 'meta+x', 'meta+v', 'ctrl+c', 'ctrl+x', 'ctrl+v', 'meta+shift+v'])

export class KeyParseError extends Error {}

/** "cmd+shift" のような修飾だけの文字列を CDP の modifiers ビットに。 */
export function parseModifiers(text: string | undefined): number {
  if (!text) return 0
  let bits = 0
  for (const part of text.toLowerCase().split('+')) {
    const name = part.trim()
    if (!name) continue
    const bit = MODIFIER_BITS[name]
    if (bit === undefined) throw new KeyParseError(`不明な修飾キー: ${part}`)
    bits |= bit
  }
  return bits
}

function canonicalName(bits: number, base: string): string {
  const parts: string[] = []
  if (bits & 4) parts.push('meta')
  if (bits & 2) parts.push('ctrl')
  if (bits & 1) parts.push('alt')
  if (bits & 8) parts.push('shift')
  parts.push(base.toLowerCase())
  return parts.join('+')
}

/** 1 つの組み合わせ（"cmd+shift+ArrowDown"）を解釈する。 */
export function parseCombo(combo: string): KeyStroke {
  const parts = combo.split('+').map((part) => part.trim())
  const last = parts.pop()
  if (!last) throw new KeyParseError(`キーが空です: ${combo}`)
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIER_BITS[part.toLowerCase()]
    if (bit === undefined) throw new KeyParseError(`不明な修飾キー: ${part}`)
    modifiers |= bit
  }
  const named = NAMED[last.toLowerCase()]
  let stroke: Omit<KeyStroke, 'modifiers' | 'commands'>
  if (named) {
    stroke = { key: named.key, code: named.code, keyCode: named.keyCode, text: named.text }
  } else if ([...last].length === 1) {
    const char = last
    const upper = char.toUpperCase()
    const isLetter = /^[a-z]$/i.test(char)
    const isDigit = /^[0-9]$/.test(char)
    stroke = {
      key: modifiers & 8 && isLetter ? upper : char,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${char}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: char
    }
  } else {
    throw new KeyParseError(`不明なキー: ${last}`)
  }
  const name = canonicalName(modifiers, named ? named.key : last)
  if (FORBIDDEN.has(name)) {
    throw new KeyParseError(
      'クリップボードのショートカット（cmd+c / cmd+x / cmd+v）は使えません。文字は type で入れてください'
    )
  }
  const command = MAC_COMMANDS[name]
  // 修飾付き（shift だけは除く）の印字キーは文字を入れない
  const printable = stroke.text !== undefined && (modifiers & ~8) === 0
  return {
    ...stroke,
    text: printable ? (modifiers & 8 && stroke.text ? stroke.text.toUpperCase() : stroke.text) : undefined,
    modifiers,
    commands: command ? [command] : []
  }
}

/** "Tab Tab Enter" のような空白区切りを順に解釈する。 */
export function parseKeySequence(text: string): KeyStroke[] {
  const combos = text.trim().split(/\s+/).filter(Boolean)
  if (combos.length === 0) throw new KeyParseError('key が空です')
  if (combos.length > 50) throw new KeyParseError('キーが多すぎます（50 まで）')
  return combos.map(parseCombo)
}
