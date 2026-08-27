import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  HTTP_AUTH_LIMITS,
  convertMultipassPattern,
  evaluateEligibility,
  importMultipass,
  isSameHttpOrigin,
  matchRules,
  normalizeHttpOrigin,
  normalizeRules,
  patternFromUrl,
  rankRules,
  resolveSecretBackendMode,
  validateHttpAuthPattern
} from '../src/shared/http-auth-rules.js'
import { WORKER_SOURCE } from '../src/shared/http-auth-worker-source.js'

/* ------------------------------------------------------------------ *
 * patternFromUrl
 * ------------------------------------------------------------------ */

test('patternFromUrl: 既定ポートは付けない', () => {
  assert.equal(patternFromUrl('https://example.com/a/b?x=1'), '^https://example\\.com/')
  assert.equal(patternFromUrl('http://example.com/'), '^http://example\\.com/')
})

test('patternFromUrl: 非既定ポートは付く', () => {
  assert.equal(patternFromUrl('https://staging.example.com:8443/a/b'), '^https://staging\\.example\\.com:8443/')
})

test('patternFromUrl: 日本語ドメインは punycode になる', () => {
  assert.equal(patternFromUrl('https://例え.テスト/'), '^https://xn--r8jz45g\\.xn--zckzah/')
})

test('patternFromUrl: http/https 以外と壊れた URL は null', () => {
  assert.equal(patternFromUrl('file:///etc/passwd'), null)
  assert.equal(patternFromUrl('(not a url)'), null)
})

test('patternFromUrl の結果は自分の URL にマッチし、validator を通る', () => {
  const pattern = patternFromUrl('https://staging.example.com:8443/a/b')
  assert.equal(validateHttpAuthPattern(pattern).ok, true)
  assert.equal(new RegExp(pattern).test('https://staging.example.com:8443/a/b'), true)
  // ホスト名の一部が一致する別ホストには当たらない
  assert.equal(new RegExp(pattern).test('https://staging-example.com:8443/'), false)
})

/* ------------------------------------------------------------------ *
 * validateHttpAuthPattern
 * ------------------------------------------------------------------ */

test('validateHttpAuthPattern: 危険な正規表現を拒否する', () => {
  // **長さ上限だけでは防げないもの**（どれも 10 文字未満）
  assert.equal(validateHttpAuthPattern('(a+)+$').ok, false)
  assert.equal(validateHttpAuthPattern('^(a|aa)+$').ok, false)
  assert.equal(validateHttpAuthPattern('^(a*)*$').ok, false)
  assert.equal(validateHttpAuthPattern('((a)+)+').ok, false)
  assert.equal(validateHttpAuthPattern('((a|b))+').ok, false)
  // 後方参照
  assert.equal(validateHttpAuthPattern('^(a)\\1$').ok, false)
  assert.equal(validateHttpAuthPattern('^(?<x>a)\\k<x>$').ok, false)
  // lookaround
  assert.equal(validateHttpAuthPattern('^(?=https)https://x\\.com/').ok, false)
  assert.equal(validateHttpAuthPattern('^(?!http)x').ok, false)
  assert.equal(validateHttpAuthPattern('^(?<=a)b').ok, false)
  assert.equal(validateHttpAuthPattern('^(?<!a)b').ok, false)
  // 構文エラー
  assert.equal(validateHttpAuthPattern('^https://(x').ok, false)
  // 型と長さ
  assert.equal(validateHttpAuthPattern('').ok, false)
  assert.equal(validateHttpAuthPattern(null).ok, false)
  assert.equal(validateHttpAuthPattern('a'.repeat(HTTP_AUTH_LIMITS.MAX_PATTERN + 1)).ok, false)
})

test('validateHttpAuthPattern: 上限ちょうどは通る', () => {
  assert.equal(validateHttpAuthPattern('a'.repeat(HTTP_AUTH_LIMITS.MAX_PATTERN)).ok, true)
})

test('validateHttpAuthPattern: 自動生成パターンとよくあるワイルドカードは通る', () => {
  // **これが落ちると変換したルールが全部消える**
  assert.equal(validateHttpAuthPattern('^https://([^/]+\\.)?example\\.com/').ok, true)
  assert.equal(validateHttpAuthPattern('^https://.*\\.example\\.com/').ok, true)
  assert.equal(validateHttpAuthPattern('^https://example\\.com:8443/').ok, true)
  // 量化されていないグループの alternation は許す
  assert.equal(validateHttpAuthPattern('^https://(www|api)\\.example\\.com/').ok, true)
  // 外側の量化子が最大 1 回なら中の量化子を許す
  assert.equal(validateHttpAuthPattern('^https://(x+\\.){0,1}example\\.com/').ok, true)
})

/* ------------------------------------------------------------------ *
 * matchRules / rankRules
 * ------------------------------------------------------------------ */

const rule = (id, pattern, extra = {}) => ({
  id,
  pattern,
  username: 'u',
  password: 'p',
  enabled: true,
  ...extra
})

test('matchRules: 長いパターンが勝つ', () => {
  const rules = [
    rule('short', '^https://example\\.com/'),
    rule('long', '^https://example\\.com/admin/')
  ]
  const matched = matchRules(rules, 'https://example.com/admin/x')
  assert.deepEqual(
    matched.map((r) => r.id),
    ['long', 'short']
  )
})

test('matchRules: 同点は登録順', () => {
  const rules = [rule('first', '^https://a\\.example\\.com/'), rule('second', '^https://a\\.example\\.co./')]
  const matched = matchRules(rules, 'https://a.example.com/')
  assert.deepEqual(
    matched.map((r) => r.id),
    ['first', 'second']
  )
})

test('matchRules: enabled: false と disabledReason 付きは除外', () => {
  const rules = [
    rule('off', '^https://example\\.com/', { enabled: false }),
    rule('broken-reason', '^https://example\\.com/', { disabledReason: 'decrypt-failed' }),
    rule('on', '^https://example\\.com/')
  ]
  assert.deepEqual(
    matchRules(rules, 'https://example.com/').map((r) => r.id),
    ['on']
  )
})

test('matchRules: 壊れた正規表現があっても他のルールは生きる', () => {
  const rules = [rule('broken', '^https://(x'), rule('ok', '^https://example\\.com/')]
  assert.deepEqual(
    matchRules(rules, 'https://example.com/').map((r) => r.id),
    ['ok']
  )
})

test('matchRules: 長すぎる URL は照合しない', () => {
  const url = `https://example.com/${'a'.repeat(HTTP_AUTH_LIMITS.MAX_URL)}`
  assert.deepEqual(matchRules([rule('ok', '^https://example\\.com/')], url), [])
})

test('rankRules は照合せずに順序だけを決める（実行前に順序が確定する）', () => {
  const rules = [rule('a', '^https://x\\.com/'), rule('b', '^https://x\\.com/deep/')]
  assert.deepEqual(
    rankRules(rules).map((r) => r.id),
    ['b', 'a']
  )
})

/* ------------------------------------------------------------------ *
 * ワーカーのソース（main で走らせる正規表現の実体）
 * ------------------------------------------------------------------ */

test('WORKER_SOURCE の照合結果は matchRules と一致する', async () => {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const ask = (pattern, url) =>
    new Promise((resolve) => {
      worker.once('message', resolve)
      worker.postMessage({ id: 1, pattern, url })
    })
  try {
    const table = [
      ['^https://example\\.com/', 'https://example.com/a', true],
      ['^https://example\\.com/', 'http://example.com/a', false],
      ['^https://([^/]+\\.)?example\\.com/', 'https://www.example.com/', true],
      ['^https://([^/]+\\.)?example\\.com/', 'https://notexample.com/', false],
      ['^https://(x', 'https://x', false]
    ]
    for (const [pattern, url, expected] of table) {
      const reply = await ask(pattern, url)
      assert.equal(reply.matched, expected, `${pattern} vs ${url}`)
      // 同じ判定を同期の純粋関数でも確かめる（2 つの実装が食い違わないことの回帰）
      assert.equal(matchRules([rule('x', pattern)], url).length > 0, expected)
    }
  } finally {
    await worker.terminate()
  }
})

/* ------------------------------------------------------------------ *
 * evaluateEligibility
 * ------------------------------------------------------------------ */

const BASE = {
  isProxy: false,
  scheme: 'basic',
  isPrivate: false,
  isTab: true,
  isSameOrigin: true,
  canEncrypt: true,
  isUrlTooLong: false
}

test('evaluateEligibility: 保存適格と自動入力可否を表で固定する', () => {
  const table = [
    ['正常系', {}, { canAutofill: true, canSave: true }],
    ['暗号化不可', { canEncrypt: false }, { canAutofill: true, canSave: false }],
    ['シークレット', { isPrivate: true }, { canAutofill: false, canSave: false }],
    ['タブでない', { isTab: false }, { canAutofill: false, canSave: false }],
    ['プロキシ', { isProxy: true }, { canAutofill: false, canSave: false }],
    ['非 Basic', { scheme: 'digest' }, { canAutofill: false, canSave: false }],
    ['クロスオリジン', { isSameOrigin: false }, { canAutofill: false, canSave: false }],
    ['URL が長すぎる', { isUrlTooLong: true }, { canAutofill: false, canSave: false }]
  ]
  for (const [name, patch, expected] of table) {
    const actual = evaluateEligibility({ ...BASE, ...patch })
    assert.equal(actual.canAutofill, expected.canAutofill, `${name}: canAutofill`)
    assert.equal(actual.canSave, expected.canSave, `${name}: canSave`)
  }
})

test('evaluateEligibility: scheme の大文字小文字は問わない', () => {
  assert.equal(evaluateEligibility({ ...BASE, scheme: 'Basic' }).canAutofill, true)
})

test('evaluateEligibility: 理由は畳まずに区別できる（診断ログに出すため）', () => {
  // シークレットとタブでないのは**挙動が同じでも理由を分ける**。
  // 畳むとログが「シークレットだった」と嘘をつく
  assert.equal(evaluateEligibility({ ...BASE, isPrivate: true }).reason, 'private')
  assert.equal(evaluateEligibility({ ...BASE, isTab: false }).reason, 'not-a-tab')
  assert.equal(evaluateEligibility({ ...BASE, isProxy: true }).reason, 'proxy')
  assert.equal(evaluateEligibility({ ...BASE, scheme: 'digest' }).reason, 'scheme')
  assert.equal(evaluateEligibility({ ...BASE, isSameOrigin: false }).reason, 'cross-origin')
  assert.equal(evaluateEligibility({ ...BASE, isUrlTooLong: true }).reason, 'url-too-long')
  assert.equal(evaluateEligibility({ ...BASE, canEncrypt: false }).reason, 'no-encryption')
  assert.equal(evaluateEligibility(BASE).reason, null)
})

/* ------------------------------------------------------------------ *
 * オリジン
 * ------------------------------------------------------------------ */

test('normalizeHttpOrigin / isSameHttpOrigin', () => {
  assert.equal(normalizeHttpOrigin('https://example.com/a/b?x'), 'https://example.com')
  assert.equal(normalizeHttpOrigin('file:///x'), null)
  assert.equal(normalizeHttpOrigin('about:blank'), null)
  assert.equal(isSameHttpOrigin('https://example.com/img.png', 'https://example.com/page'), true)
  assert.equal(isSameHttpOrigin('https://other.com/img.png', 'https://example.com/page'), false)
  // ポート違い・スキーム違いは別オリジン
  assert.equal(isSameHttpOrigin('https://example.com:8443/x', 'https://example.com/x'), false)
  assert.equal(isSameHttpOrigin('http://example.com/x', 'https://example.com/x'), false)
  // 片方が about:blank（ナビゲーション未 commit の新規タブ）なら同一オリジンにしない
  assert.equal(isSameHttpOrigin('https://example.com/x', 'about:blank'), false)
})

/* ------------------------------------------------------------------ *
 * convertMultipassPattern
 * ------------------------------------------------------------------ */

test('convertMultipassPattern: 裸のホスト名だけを変換する', () => {
  assert.deepEqual(convertMultipassPattern('example.com'), {
    pattern: '^https://([^/]+\\.)?example\\.com/',
    converted: true
  })
  assert.deepEqual(convertMultipassPattern('example.com:8443'), {
    pattern: '^https://([^/]+\\.)?example\\.com:8443/',
    converted: true
  })
})

test('convertMultipassPattern: それ以外はすべて素通し', () => {
  // **素通しになるケースこそ本命の回帰テスト**
  for (const input of [
    'https://example.com/',
    'example.com/admin',
    '192.168.1.1',
    '192.168.1.1:8080',
    '^https://x\\.com/',
    '.*\\.example\\.com',
    'localhost',
    'example.com:99999'
  ]) {
    assert.deepEqual(convertMultipassPattern(input), { pattern: input, converted: false }, input)
  }
})

test('convertMultipassPattern: 変換の意味が保たれる', () => {
  const { pattern } = convertMultipassPattern('example.com')
  const re = new RegExp(pattern)
  assert.equal(re.test('https://www.example.com/'), true)
  assert.equal(re.test('https://example.com/'), true)
  assert.equal(re.test('https://notexample.com/'), false)
  // #17 のスキーム固定: http には当たらない
  assert.equal(re.test('http://www.example.com/'), false)
})

/* ------------------------------------------------------------------ *
 * importMultipass
 * ------------------------------------------------------------------ */

const entry = (url, extra = {}) => ({ url, username: 'u', password: 'p', ...extra })

test('importMultipass: オブジェクト形式と配列形式の両方が読める', () => {
  const asArray = importMultipass([entry('example.com')], [])
  const asObject = importMultipass({ hash1: entry('example.com') }, [])
  assert.equal(asArray.entries.length, 1)
  assert.deepEqual(asObject.entries, asArray.entries)
})

test('importMultipass: JSON テキストも受ける / 壊れていれば理由を返す', () => {
  assert.equal(importMultipass(JSON.stringify([entry('example.com')]), []).entries.length, 1)
  const broken = importMultipass('{', [])
  assert.equal(broken.entries.length, 0)
  assert.equal(broken.rejected[0].reason, 'parse-failed')
})

test('importMultipass: 拒否が混ざっていても通った分は取り込まれる', () => {
  const result = importMultipass(
    [
      entry('example.com'),
      { url: 'nouser.example.com', password: 'p' },
      entry('(a+)+$'),
      entry('ok2.example.com'),
      entry('long.example.com', { password: 'p'.repeat(HTTP_AUTH_LIMITS.MAX_PASSWORD + 1) })
    ],
    []
  )
  assert.deepEqual(
    result.entries.map((e) => e.importedFrom),
    ['example.com', 'ok2.example.com']
  )
  assert.deepEqual(
    result.rejected.map((r) => [r.pattern, r.reason]),
    [
      ['nouser.example.com', 'missing-fields'],
      ['(a+)+$', 'invalid-pattern'],
      ['long.example.com', 'too-long']
    ]
  )
})

test('importMultipass: priority は捨てる。一様でなければ警告する', () => {
  assert.equal(importMultipass([entry('a.example.com', { priority: 1 })], []).priorityWarning, false)
  assert.equal(
    importMultipass(
      [entry('a.example.com', { priority: 1 }), entry('b.example.com', { priority: 5 })],
      []
    ).priorityWarning,
    true
  )
})

test('importMultipass: 欠損・数値 1・文字列 "1" が混在しても警告は出ない', () => {
  const result = importMultipass(
    [entry('a.example.com'), entry('b.example.com', { priority: 1 }), entry('c.example.com', { priority: '1' })],
    []
  )
  assert.equal(result.priorityWarning, false)
  assert.equal(result.entries.length, 3)
})

test('importMultipass: 同じパターンは既存を上書きする（id を引き継ぐ）', () => {
  const existing = [{ id: 'keep-me', pattern: '^https://([^/]+\\.)?example\\.com/' }]
  const result = importMultipass([entry('example.com', { username: 'new' })], existing)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].id, 'keep-me')
  assert.equal(result.entries[0].username, 'new')
  // 既存に無いものは id なし（ストア側で採番する）
  assert.equal(importMultipass([entry('other.example.com')], existing).entries[0].id, null)
})

test('importMultipass: 素通しされたパターンには importedFrom を付けない', () => {
  const result = importMultipass([entry('^https://x\\.com/')], [])
  assert.equal(result.entries[0].pattern, '^https://x\\.com/')
  assert.equal(result.entries[0].importedFrom, null)
})

/* ------------------------------------------------------------------ *
 * normalizeRules
 * ------------------------------------------------------------------ */

test('normalizeRules: 壊れたルールを落とし、既定値を埋める', () => {
  const normalized = normalizeRules([
    { id: 'a', pattern: '^https://example\\.com/', username: 'u', password: 'c' },
    { id: 'b', pattern: '(a+)+$', username: 'u', password: 'c' },
    { id: 'c', pattern: '^https://x\\.com/', username: 123, password: 'c' },
    { id: '', pattern: '^https://y\\.com/', username: 'u', password: 'c' },
    { id: 'd', pattern: '^https://z\\.com/', username: 'u', password: 'c', disabledReason: 'nonsense' }
  ])
  assert.deepEqual(
    normalized.map((r) => r.id),
    ['a', 'd']
  )
  assert.equal(normalized[0].enabled, true)
  assert.equal(normalized[0].disabledReason, undefined)
  assert.equal(normalized[1].disabledReason, undefined)
})

test('normalizeRules: id の重複は先勝ち、件数は上限で切る', () => {
  const dup = normalizeRules([
    { id: 'a', pattern: '^https://one\\.com/', username: 'u', password: 'c' },
    { id: 'a', pattern: '^https://two\\.com/', username: 'u', password: 'c' }
  ])
  assert.equal(dup.length, 1)
  assert.equal(dup[0].pattern, '^https://one\\.com/')

  const many = Array.from({ length: HTTP_AUTH_LIMITS.MAX_RULES + 5 }, (_, i) => ({
    id: `r${i}`,
    pattern: `^https://h${i}\\.com/`,
    username: 'u',
    password: 'c'
  }))
  assert.equal(normalizeRules(many).length, HTTP_AUTH_LIMITS.MAX_RULES)
})

test('normalizeRules: 上限ちょうどの username / pattern は残る', () => {
  const normalized = normalizeRules([
    {
      id: 'a',
      pattern: `^https://${'a'.repeat(HTTP_AUTH_LIMITS.MAX_PATTERN - 9)}`,
      username: 'u'.repeat(HTTP_AUTH_LIMITS.MAX_USERNAME),
      password: 'c'
    }
  ])
  assert.equal(normalized.length, 1)
})

test('normalizeRules: 上限超過の username は落とす（黙って切り詰めない）', () => {
  const normalized = normalizeRules([
    {
      id: 'a',
      pattern: '^https://example\\.com/',
      username: 'u'.repeat(HTTP_AUTH_LIMITS.MAX_USERNAME + 1),
      password: 'c'
    }
  ])
  assert.equal(normalized.length, 0)
})

/* ------------------------------------------------------------------ *
 * 結合（変換器と validator が互いを弾き合わないこと）
 * ------------------------------------------------------------------ */

test('結合: 裸のホスト名が 変換 → validate → import → normalize を通って生き残る', () => {
  const imported = importMultipass([entry('example.com')], [])
  assert.equal(imported.entries.length, 1)
  const normalized = normalizeRules(
    imported.entries.map((e) => ({
      id: 'x',
      pattern: e.pattern,
      username: e.username,
      // 実際は暗号文が入る場所。ここでは平文のまま通す
      password: e.password,
      enabled: true,
      importedFrom: e.importedFrom ?? undefined
    }))
  )
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].importedFrom, 'example.com')
  assert.equal(matchRules(normalized, 'https://www.example.com/private/').length, 1)
})

/* ------------------------------------------------------------------ *
 * テスト用 backend のゲート
 * ------------------------------------------------------------------ */

test('resolveSecretBackendMode: パッケージ版では env を無視する', () => {
  assert.equal(resolveSecretBackendMode('memory', false), 'memory')
  assert.equal(resolveSecretBackendMode('unavailable', false), 'unavailable')
  // **パッケージ版では必ず real**（実運用のパスワードが Keychain を使わない形式で保存されない）
  assert.equal(resolveSecretBackendMode('memory', true), 'real')
  assert.equal(resolveSecretBackendMode('unavailable', true), 'real')
  // 知らない値・未設定は real
  assert.equal(resolveSecretBackendMode('nonsense', false), 'real')
  assert.equal(resolveSecretBackendMode(undefined, false), 'real')
})
