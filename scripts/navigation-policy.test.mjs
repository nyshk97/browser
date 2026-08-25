#!/usr/bin/env node
/**
 * ナビゲーション許可判定の回帰テスト（計画 1-0「許可外 scheme を拒否する回帰テスト」）。
 * Electron を起動せずに回せるので CI の必須チェックに置ける。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BLANK_URL,
  DENIED_SCHEMES,
  UI_SCHEME_URL_PREFIX,
  isLoadedExtensionUrl,
  isNavigableUrl,
  normalizeNavigationInput,
  redactUrl,
  urlsFromArgv
} from '../src/shared/navigation-policy.js'

const LOADED = new Set(['nngceckbapebfimnlniiiahkandclblb'])
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

test('http / https は通常ページとして許可する', () => {
  assert.equal(isNavigableUrl('http://example.com/'), true)
  assert.equal(isNavigableUrl('https://example.com/a?b=c#d'), true)
})

test('about:blank は厳密一致のときだけ許可する', () => {
  assert.equal(isNavigableUrl(BLANK_URL), true)
  assert.equal(isNavigableUrl('about:srcdoc'), false)
  assert.equal(isNavigableUrl('about:blank#x'), false)
  assert.equal(isNavigableUrl('about:config'), false)
})

test('危険な scheme はすべて拒否する', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'devtools://devtools/bundled/devtools_app.html',
    'blob:https://example.com/abc',
    'ws://example.com/',
    'chrome://settings',
    'mailto:a@example.com'
  ]) {
    assert.equal(isNavigableUrl(url), false, `${url} が許可されている`)
  }
})

test('chrome-extension: は allowExtensionPages かつロード済み ID のときだけ許可する', () => {
  const url = `chrome-extension://${[...LOADED][0]}/popup/index.html`
  // 既定（ページ・コマンドバー経由）では拒否
  assert.equal(isNavigableUrl(url), false)
  assert.equal(isNavigableUrl(url, { extensionIds: LOADED }), false)
  // 拡張自身の経路でのみ許可
  assert.equal(isNavigableUrl(url, { allowExtensionPages: true, extensionIds: LOADED }), true)
  // ロードしていない拡張 ID は許可しない
  assert.equal(
    isNavigableUrl(`chrome-extension://${OTHER}/x.html`, {
      allowExtensionPages: true,
      extensionIds: LOADED
    }),
    false
  )
  // extensionIds を渡し忘れたら通さない（fail-closed）
  assert.equal(isNavigableUrl(url, { allowExtensionPages: true }), false)
})

test('拡張がロードされていなければ chrome-extension: は一切通らない', () => {
  const empty = new Set()
  assert.equal(
    isNavigableUrl(`chrome-extension://${[...LOADED][0]}/popup/index.html`, {
      allowExtensionPages: true,
      extensionIds: empty
    }),
    false
  )
})

test('サブフレームは chrome-extension: をホストを問わず許可する（web_accessible_resources）', () => {
  // use_dynamic_url: true の resource はホストが拡張 ID ではなく UUID になるので、
  // ID との照合ができない。サブフレームに限ってホストを見ずに通す。
  const dynamic = 'chrome-extension://0b7c6bfb-c70e-456f-983f-46249db7a010/overlay/menu.html'
  assert.equal(isNavigableUrl(dynamic, { subframe: true, extensionIds: LOADED }), true)
  assert.equal(
    isNavigableUrl(`chrome-extension://${OTHER}/x.html`, { subframe: true, extensionIds: LOADED }),
    true
  )

  // トップレベル遷移では今までどおり拒否する（ここが緩むと Web ページから拡張ページへ飛べる）
  assert.equal(isNavigableUrl(dynamic, { extensionIds: LOADED }), false)
  assert.equal(isNavigableUrl(dynamic, { subframe: false, extensionIds: LOADED }), false)

  // 拡張が 1 つもロードされていなければサブフレームでも通さない
  assert.equal(isNavigableUrl(dynamic, { subframe: true, extensionIds: new Set() }), false)
  assert.equal(isNavigableUrl(dynamic, { subframe: true }), false)
})

test('サブフレームでも chrome-extension: 以外の許可外 scheme は拒否する', () => {
  // 「iframe なら通す」が他の scheme に波及していないこと
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'devtools://devtools/bundled/devtools_app.html',
    'chrome://settings',
    'nemo://ui/index.html'
  ]) {
    assert.equal(
      isNavigableUrl(url, { subframe: true, extensionIds: LOADED }),
      false,
      `${url} がサブフレームで許可されている`
    )
  }
})

test('isLoadedExtensionUrl はロード済み拡張のページだけ true', () => {
  assert.equal(isLoadedExtensionUrl(`chrome-extension://${[...LOADED][0]}/a.html`, LOADED), true)
  assert.equal(isLoadedExtensionUrl(`chrome-extension://${OTHER}/a.html`, LOADED), false)
  assert.equal(isLoadedExtensionUrl('https://example.com/', LOADED), false)
  assert.equal(isLoadedExtensionUrl('not a url', LOADED), false)
})

test('コマンドバーは http/https 以外の scheme を拒否する', () => {
  for (const input of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'devtools://devtools/bundled/devtools_app.html',
    `chrome-extension://${[...LOADED][0]}/popup/index.html`
  ]) {
    const decision = normalizeNavigationInput(input)
    assert.equal(decision.allowed, false, `${input} が許可されている`)
    assert.match(decision.reason ?? '', /^scheme_not_allowed:/)
  }
})

test('コマンドバーはドメインらしい入力に https を補い、それ以外は検索に回す', () => {
  assert.deepEqual(normalizeNavigationInput('example.com'), {
    allowed: true,
    url: 'https://example.com'
  })
  // localhost / 127.0.0.1 は http を補う（ローカル開発の期待値に合わせる）
  assert.deepEqual(normalizeNavigationInput('localhost:8787'), {
    allowed: true,
    url: 'http://localhost:8787'
  })
  assert.deepEqual(normalizeNavigationInput('127.0.0.1:8787/login.html'), {
    allowed: true,
    url: 'http://127.0.0.1:8787/login.html'
  })
  assert.deepEqual(normalizeNavigationInput('example.com:8080/x'), {
    allowed: true,
    url: 'https://example.com:8080/x'
  })
  const search = normalizeNavigationInput('自作 ブラウザ')
  assert.equal(search.allowed, true)
  assert.match(search.url, /^https:\/\/www\.google\.com\/search\?q=/)
  assert.equal(normalizeNavigationInput('   ').allowed, false)
})

test('ログ用の URL はパス・クエリ・フラグメントを落とす', () => {
  assert.equal(redactUrl('https://example.com/secret?token=abc#frag'), 'https://example.com')
  assert.equal(redactUrl('http://127.0.0.1:8787/login.html?password=x'), 'http://127.0.0.1:8787')
  assert.equal(redactUrl('file:///etc/passwd'), 'file:')
  assert.equal(redactUrl('javascript:alert(document.cookie)'), 'javascript:')
  assert.equal(redactUrl(BLANK_URL), 'about:')
  assert.equal(redactUrl('まったく URL でない'), '(unparsable)')
})

test('明示的に拒否する scheme は1つも通らない（計画 1-0）', () => {
  for (const scheme of DENIED_SCHEMES) {
    const url = `${scheme}${scheme === 'javascript:' ? 'alert(1)' : '//example.com/x'}`
    assert.equal(isNavigableUrl(url), false, url)
    assert.equal(
      isNavigableUrl(url, { allowExtensionPages: true, extensionIds: new Set(['abc']) }),
      false,
      url
    )
    assert.equal(normalizeNavigationInput(url).allowed, false, url)
  }
})

test('ブラウザ UI の origin はページ側からもコマンドバーからも開けない', () => {
  const url = `${UI_SCHEME_URL_PREFIX}index.html`
  assert.equal(isNavigableUrl(url), false)
  assert.equal(normalizeNavigationInput(url).allowed, false)
})

test('検索テンプレートは差し替えられるが https 以外は既定に落ちる', () => {
  assert.equal(
    normalizeNavigationInput('猫', 'https://duckduckgo.com/?q={q}').url,
    'https://duckduckgo.com/?q=%E7%8C%AB'
  )
  assert.ok(normalizeNavigationInput('猫', 'ftp://x/{q}').url.startsWith('https://www.google.com/'))
})

/* ------------------------------------------------------------------ *
 * 外部アプリから渡された URL（計画 2-5）
 * ------------------------------------------------------------------ */

test('argv から http/https の引数だけを拾う', () => {
  assert.deepEqual(
    urlsFromArgv(['--flag', 'https://example.com/a', '/tmp/file.txt', 'http://example.org/']),
    ['https://example.com/a', 'http://example.org/']
  )
  // 拾わないもの（開いてよいかの判定は isNavigableUrl が別途行う）
  assert.deepEqual(urlsFromArgv(['file:///etc/passwd', 'javascript:alert(1)', 'nemo://ui/index.html']), [])
  assert.deepEqual(urlsFromArgv([]), [])
})

test('argv で拾った URL も isNavigableUrl を通す前提になっている', () => {
  // 形だけ http でも、拒否する scheme に化けるものは通さない
  const [picked] = urlsFromArgv(['HTTPS://Example.com/'])
  assert.equal(picked, 'HTTPS://Example.com/')
  assert.equal(isNavigableUrl(picked), true)
})
