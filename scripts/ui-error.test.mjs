import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUiErrorDetail, formatErrorFrames, MAX_FRAMES } from '../src/shared/ui-error.js'
import { sanitizeDetail } from '../src/shared/log-redact.js'

test('行途中の URL がホストまでに落ちる', () => {
  const frames = formatErrorFrames(
    'TypeError: x\n    at Sidebar (nemo://ui/index.html?view=sidebar&token=abc:12:3)\n    at fetch (https://api.github.com/repos/x/y?access_token=zzz)'
  )
  assert.equal(frames.length, 3)
  assert.ok(!frames.join('\n').includes('token'))
  assert.ok(frames[1].includes('nemo://ui'))
  assert.ok(frames[2].includes('https://api.github.com') && !frames[2].includes('/repos'))
})

test('行数と 1 行の長さに上限がある', () => {
  const stack = Array.from({ length: 40 }, (_, i) => `    at f${i} (${'x'.repeat(300)})`).join('\n')
  const frames = formatErrorFrames(stack)
  assert.equal(frames.length, MAX_FRAMES)
  assert.ok(frames.every((f) => f.length <= 181))
})

test('detail は sanitizeDetail を素通りする（切り詰め・[deep] が出ない）', () => {
  const detail = buildUiErrorDetail(
    {
      message: 'failed https://example.com/secret/path',
      stack: 'Error\n    at a (https://example.com/p?q=1)'
    },
    'sidebar'
  )
  const before = JSON.stringify(detail)
  const after = JSON.stringify(sanitizeDetail({ ...detail }))
  assert.equal(after, before)
  assert.ok(!before.includes('/secret'))
  assert.ok(!before.includes('[deep]'))
})

test('message が文字列でなくても落ちない', () => {
  assert.equal(buildUiErrorDetail({ message: undefined }, 'x').error, 'unknown')
  assert.equal(buildUiErrorDetail({ message: 42, stack: 5 }, 'x').frames.length, 0)
})
