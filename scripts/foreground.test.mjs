/**
 * main で「前面を奪いうる呼び出し」を `src/main/foreground.ts` 以外に書いていないことの検査。
 *
 * `webContents.focus()` / `baseWindow.focus()` / `baseWindow.show()` / `app.focus({ steal: true })` は、
 * macOS では Nemo をアクティブにして打鍵を吸う（自走検証の背面モードで実測）。
 * 直接呼ぶ代わりに `focusContents` / `focusWindow` / `bringToFront` を通す（CLAUDE.md「自走検証を足すとき」）。
 *
 * `mise run verify` の「アクティブ化 N 回」でも同じ逸脱は見つかるが、フルを回すまで 10 分かかる。
 * ここで数秒で落とす。コメント中の言及は除く（規約の説明に書かれる）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = path.join(root, 'src', 'main')
const ALLOWED = path.join(mainDir, 'foreground.ts')

function listTs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listTs(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/** コメントを落とす（ブロックコメントは中身を空行に、行コメントは `//` 以降を切る）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

const FORBIDDEN = [
  { re: /\.focus\(\)/, what: '.focus()（focusContents / focusWindow を通す）' },
  { re: /\.show\(\)/, what: '.show()（bringToFront を通す。背面で出すなら showInactive）' },
  { re: /app\.focus\(/, what: 'app.focus(（bringToFront を通す）' }
]

test('前面を奪いうる呼び出しは src/main/foreground.ts にだけある', () => {
  const files = listTs(mainDir).filter((file) => file !== ALLOWED)
  assert.ok(files.length > 10, `src/main の .ts が少なすぎる（${files.length} 件）。探す場所を間違えている`)
  const offenders = []
  for (const file of files) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const { re, what } of FORBIDDEN) {
        if (re.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1}: ${what}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `foreground.ts の関数を通していない呼び出し:\n  ${offenders.join('\n  ')}`)
})

test('foreground.ts 自身は 3 つの呼び出しを持っている（検査の対象を見失っていない）', () => {
  const source = stripComments(fs.readFileSync(ALLOWED, 'utf8'))
  assert.match(source, /\.focus\(\)/)
  assert.match(source, /\.show\(\)/)
  assert.match(source, /app\.focus\(\{ steal: true \}\)/)
})
