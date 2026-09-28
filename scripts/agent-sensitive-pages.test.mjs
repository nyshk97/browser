import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sensitivePageKind, sensitivePageMessage } from '../src/shared/agent-sensitive-pages.js'

test('トークン・鍵の画面は token', () => {
  for (const url of [
    'https://github.com/settings/tokens',
    'https://github.com/settings/tokens/new?scopes=repo',
    'https://github.com/settings/personal-access-tokens/new',
    'https://github.com/settings/keys',
    'https://github.com/nyshk97/browser/settings/secrets/actions',
    'https://console.cloud.google.com/apis/credentials?project=x',
    'https://console.cloud.google.com/iam-admin/serviceaccounts/details/1/keys',
    'https://dashboard.stripe.com/apikeys',
    'https://dashboard.stripe.com/test/apikeys',
    'https://dash.cloudflare.com/profile/api-tokens',
    'https://appstoreconnect.apple.com/access/integrations/api'
  ]) {
    assert.equal(sensitivePageKind(url), 'token', url)
  }
})

test('OAuth の同意は oauth（既知の IdP と汎用の認可要求）', () => {
  assert.equal(sensitivePageKind('https://github.com/login/oauth/authorize?client_id=a&scope=repo'), 'oauth')
  assert.equal(sensitivePageKind('https://accounts.google.com/o/oauth2/v2/auth?client_id=a'), 'oauth')
  assert.equal(sensitivePageKind('https://accounts.google.com/signin/oauth/consent?x=1'), 'oauth')
  assert.equal(
    sensitivePageKind(
      'https://auth.example.com/authorize?client_id=a&redirect_uri=https%3A%2F%2Fx&response_type=code'
    ),
    'oauth'
  )
})

test('再認証・セキュリティ設定は reauth', () => {
  assert.equal(sensitivePageKind('https://github.com/sessions/sudo'), 'reauth')
  assert.equal(sensitivePageKind('https://myaccount.google.com/security'), 'reauth')
  assert.equal(sensitivePageKind('https://github.com/settings/security'), 'reauth')
})

test('ふつうのページ・ログイン画面・似た別ホストは null', () => {
  for (const url of [
    'https://github.com/nyshk97/browser',
    'https://github.com/nyshk97/browser/pulls',
    'https://github.com/login',
    'https://accounts.google.com/v3/signin/identifier',
    'https://console.cloud.google.com/run',
    'https://dashboard.stripe.com/payments',
    'https://github.com.evil.example/settings/tokens',
    'https://example.com/?client_id=a',
    'about:blank',
    'not a url'
  ]) {
    assert.equal(sensitivePageKind(url), null, url)
  }
})

test('断りの文言は request_user_action を案内する', () => {
  for (const kind of ['token', 'oauth', 'reauth']) {
    assert.match(sensitivePageMessage(kind), /request_user_action/)
  }
})
