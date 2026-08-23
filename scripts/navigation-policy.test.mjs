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
  isLoadedExtensionUrl,
  isNavigableUrl,
  normalizeNavigationInput,
  redactUrl
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
