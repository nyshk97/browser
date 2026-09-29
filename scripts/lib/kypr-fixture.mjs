/**
 * kypr の模擬サーバーに保管庫を 1 つ作る（自動入力の自走検証・実サイト調査で、値の元の個人情報を置くため）。
 *
 * 戻りの `other` は「別の端末」（Web と同じクライアント）。個人情報はこれで足す
 * （`other.create([newIdentityItem({ ... })])`）。Nemo は `NEMO_KYPR_TEST_SERVER=origin` で起動し、
 * `window.nemo.kyprSignIn(password, true)` でログインする。
 */
import { createKyprMockServer } from './kypr-mock-server.mjs'
import { createApi, MemoryCacheStore, VaultSession } from '../../src/vendor/kypr/client/index.ts'
import {
  b64Encode,
  deriveKeys,
  generateVaultKey,
  newKdfParams,
  wrapVaultKey
} from '../../src/vendor/kypr/crypto/index.ts'
import { PROFILE_FIELDS } from '../../src/shared/autofill-schema.js'

/**
 * @param {string} password
 * @returns {Promise<{ mock: ReturnType<typeof createKyprMockServer>, origin: string, other: VaultSession }>}
 */
export async function createKyprVault(password) {
  const mock = createKyprMockServer()
  const origin = `http://127.0.0.1:${await mock.listen()}`
  const kdf = newKdfParams({ t: 3 })
  const derived = await deriveKeys(password, kdf)
  const setup = await fetch(`${origin}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: 'x',
      kdf,
      authKey: b64Encode(derived.authKey),
      wrappedVaultKey: await wrapVaultKey(derived.wrapKey, generateVaultKey())
    })
  })
  if (setup.status !== 201) throw new Error(`kypr の setup 失敗: ${setup.status}`)
  const other = await VaultSession.unlock(
    { api: createApi(origin), cache: new MemoryCacheStore(), derive: deriveKeys },
    password
  )
  return { mock, origin, other }
}

/**
 * プロフィール（snake_case。自動入力の選択肢のキー）→ kypr の個人情報の平文（camelCase）。
 * @param {Record<string, string>} profile
 */
export function profileToKypr(profile) {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f.kypr, profile[f.key] ?? '']))
}
