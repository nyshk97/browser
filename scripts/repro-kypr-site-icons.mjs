#!/usr/bin/env node
/**
 * kypr のサイトのアイコン（`src/main/kypr/site-icons.ts`）を、**実際の履歴**で書かせて落ちないかを見る。
 *
 * `verify-kypr.mjs` の favicon は data: の SVG 1 件だけで、https の favicon を取りに行く経路を通らない。
 * 1.10.5 はその経路（常用のページのセッションでの `session.fetch`）で解除の直後に main が SIGSEGV で落ち、
 * 自走検証では見つからなかった（2026-09-30）。これはその再現に使った手順を残したもの。
 *
 *   pnpm build && node scripts/repro-kypr-site-icons.mjs [履歴の DB] [ログインの件数]
 *
 * - 履歴の DB の既定は常用版の `~/Library/Application Support/Nemo/history.db`。`sqlite3 .backup` で使い捨ての userData に写す
 *   （常用版は起動したままでよい。触るのは写しだけ）
 * - 偽の kypr サーバーに、履歴で https の favicon を持つホストのログインを作り、使い捨ての dev 版で解除して 15 秒待つ
 * - PASS の条件: 落ちない・アイコンが 1 件以上書かれる・書かれたアイコンは全部 64px 以下の正方形の PNG
 * - 落ちると macOS の「Electron が予期しない理由で終了しました」が出る。**閉じるまで次の Electron が起動しない**
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectUi } from './lib/cdp.mjs'
import { getFreePort, projectRoot, sleep, waitForHttp } from './lib/harness.mjs'
import { createKyprMockServer } from './lib/kypr-mock-server.mjs'
import { createApi, MemoryCacheStore, VaultSession } from '../src/vendor/kypr/client/index.ts'
import {
  b64Encode,
  deriveKeys,
  generateVaultKey,
  newKdfParams,
  newLoginItem,
  wrapVaultKey
} from '../src/vendor/kypr/crypto/index.ts'

const historyDb = process.argv[2] ?? path.join(os.homedir(), 'Library/Application Support/Nemo/history.db')
const limit = Number(process.argv[3] ?? 60)
const PASSWORD = 'repro-site-icons'
const electronPath = createRequire(import.meta.url)('electron')

if (!fs.existsSync(path.join(projectRoot, 'out/main/index.js')))
  throw new Error('out/ が無い。先に pnpm build する')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-repro-icons-'))
execFileSync('sqlite3', [historyDb, `.backup '${path.join(userData, 'history.db')}'`])
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ version: 1, data: { liveFolderEnabled: false } })
)
const urls = execFileSync('sqlite3', [
  path.join(userData, 'history.db'),
  "SELECT url FROM pages WHERE favicon_url LIKE 'https:%' ORDER BY last_visited_at DESC LIMIT 5000"
])
  .toString()
  .trim()
  .split('\n')
const hosts = [...new Set(urls.map((u) => URL.parse(u)?.hostname).filter(Boolean))].slice(0, limit)

const mock = createKyprMockServer({})
const origin = `http://127.0.0.1:${await mock.listen()}`
const kdf = newKdfParams({ t: 3 })
const derived = await deriveKeys(PASSWORD, kdf)
await fetch(`${origin}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    setupToken: 'x',
    kdf,
    authKey: b64Encode(derived.authKey),
    wrappedVaultKey: await wrapVaultKey(derived.wrapKey, generateVaultKey())
  })
})
const other = await VaultSession.unlock(
  { api: createApi(origin), cache: new MemoryCacheStore(), derive: deriveKeys },
  PASSWORD
)
await other.create(
  hosts.map((h) => newLoginItem({ name: h, username: 'u', password: 'p', uris: [{ uri: `https://${h}/` }] }))
)

const port = String(await getFreePort())
const cdp = `http://127.0.0.1:${port}`
const child = spawn(electronPath, ['out/main/index.js'], {
  cwd: projectRoot,
  stdio: 'ignore',
  env: {
    ...process.env,
    NEMO_REMOTE_DEBUGGING_PORT: port,
    NEMO_USER_DATA_DIR: userData,
    NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
    NEMO_VERIFY_DIAGNOSTICS: '1',
    NEMO_KYPR_TEST_SERVER: origin,
    NEMO_KYPR_TEST_TOUCHID: 'ok',
    NEMO_KYPR_TEST_CLIPBOARD: 'memory'
  }
})
let exit = null
child.on('exit', (code, signal) => {
  exit = { code, signal }
})
try {
  await waitForHttp(`${cdp}/json/list`, {
    child,
    check: async (res) => (await res.json()).some((t) => t.url.startsWith('nemo://ui/'))
  })
  const ui = await connectUi(cdp)
  const signIn = await ui.ev(`window.nemo.kyprSignIn(${JSON.stringify(PASSWORD)}, true).then(JSON.stringify)`)
  for (let i = 0; i < 30 && !exit; i++) await sleep(500)
  await other.sync()
  const icons = hosts.map((h) => other.iconFor(h.replace(/^www\./, ''))).filter(Boolean)
  const shapes = icons.map((d) => {
    const png = Buffer.from(d.slice(d.indexOf(',') + 1), 'base64')
    return [png.readUInt32BE(16), png.readUInt32BE(20)]
  })
  const ok = exit === null && icons.length > 0 && shapes.every(([w, h]) => w === h && w > 0 && w <= 64)
  console.log(
    JSON.stringify({ hosts: hosts.length, signIn: JSON.parse(signIn), exit, icons: icons.length, shapes })
  )
  console.log(ok ? 'PASS' : 'FAIL')
  process.exitCode = ok ? 0 : 1
} finally {
  if (!exit) child.kill('SIGKILL')
  await mock.close?.()
  fs.rmSync(userData, { recursive: true, force: true })
}
process.exit()
