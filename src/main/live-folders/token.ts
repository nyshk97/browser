import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { log } from '../log.js'
import {
  clearStoredToken,
  hasStoredToken,
  isTokenStorageAvailable,
  readStoredToken,
  saveStoredToken
} from '../store/github-token.js'
import { resolveGhPath } from './gh-path.js'

/**
 * Live Folder が使う資格情報の解決。
 *
 * **優先順位は「設定した PAT」→「`gh auth token`」。**
 * 明示的に設定したものが必ず勝つ（暗黙の gh が優先すると、
 * PAT を貼っても効かない事故になる）。
 */

export type TokenSource = 'pat' | 'gh' | 'none'

export interface ResolvedToken {
  source: TokenSource
  /** `source: 'none'` なら null。**renderer へは絶対に渡さない**。 */
  token: string | null
  /**
   * トークンの非可逆 fingerprint（`sha256(token)` の先頭 16 文字）。
   *
   * キャッシュが「誰のものか」を**取得の前に**照合するために使う。
   * `viewer.login` は API が成功しないと分からないので事前照合には使えず、
   * メモリ上の連番は再起動で振り直されて正しいキャッシュまで弾く。
   */
  credentialKey: string | null
  /**
   * `source: 'none'` になった理由。
   *
   * **「本当に未設定」と「解決に失敗した」を分ける。**
   * 一緒くたにすると、`gh` の呼び出しがたまたま失敗しただけで
   * 60 秒間 `Connect GitHub`（＝未設定）を出し続けることになる
   * （**起動直後の初回 exec は遅く、実際に踏んだ**）。
   */
  reason: 'ok' | 'not-configured' | 'gh-failed'
}

const NONE: ResolvedToken = {
  source: 'none',
  token: null,
  credentialKey: null,
  reason: 'not-configured'
}

/** `gh` の呼び出しそのものに失敗した（＝すぐ retry する価値がある）。 */
const GH_FAILED: ResolvedToken = {
  source: 'none',
  token: null,
  credentialKey: null,
  reason: 'gh-failed'
}

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/**
 * 自走検証で認証状態を注入する口（`NEMO_GITHUB_TEST_AUTH`）。
 *
 * **どの値でも `gh auth token` は絶対に呼ばない**。差し替え中に本物の PAT を
 * 任意のホストへ送る経路を作らないため。
 *
 * - `dummy` … 固定のダミー文字列を送る（＝トークンありの経路）
 * - `none` … トークン無しとして振る舞う（＝未設定の経路）
 * - `stored-only` … **テスト用データディレクトリの PAT ストアだけを読む**
 *   （保存されていなければ未設定。`gh` は呼ばない）
 *
 * `stored-only` が要るのは、`dummy` 固定だと
 * 「PAT を保存 → 取得が走る → 消す → `Connect GitHub` に戻る」を
 * **同一プロセスで再現できない**から（保存も削除も結果が変わらない）。
 */
export type TestAuthMode = 'dummy' | 'none' | 'stored-only'

let testAuthMode: TestAuthMode | null = null

/**
 * 差し替え中の PAT 置き場（**プロセス内のメモリだけ**）。
 *
 * 実ストアは `safeStorage`（macOS では Keychain）を使うので、
 * 自走検証がそこに触ると **OS の許可ダイアログが出て永久に止まる**
 * （実際に踏んだ。`SecurityAgent` が上がったまま検証が固まる）。
 *
 * ここを分けることで「差し替え中は実トークンにも実ストアにも一切触らない」も同時に満たせる。
 * **代わりに「`github-token.json` に平文の PAT が無い」ことは自走検証では見られない**ので、
 * それは人間の確認に回す（`VERIFY.md`）。
 */
let testStoredToken: string | null = null

/** この3値以外は `dummy` に倒す。 */
export function configureTestAuth(mode: string): void {
  testAuthMode =
    mode === 'none' ? 'none' : mode === 'stored-only' ? 'stored-only' : mode === 'dummy' ? 'dummy' : 'dummy'
  log('live_folder.test_auth', { mode: testAuthMode })
}

const DUMMY_TOKEN = 'nemo-test-token'

/* ------------------------------------------------------------------ *
 * 保存・削除（実ストアと差し替え中のストアを1か所で選ぶ）
 * ------------------------------------------------------------------ */

/** @returns 保存できたか */
export function saveToken(token: string, useTestAuth: boolean): boolean {
  if (useTestAuth) {
    const trimmed = token.trim()
    if (!trimmed) return false
    testStoredToken = trimmed
    return true
  }
  return saveStoredToken(token)
}

export function clearToken(useTestAuth: boolean): void {
  if (useTestAuth) {
    testStoredToken = null
    return
  }
  clearStoredToken()
}

export function hasToken(useTestAuth: boolean): boolean {
  return useTestAuth ? testStoredToken !== null : hasStoredToken()
}

export function tokenStorageAvailable(useTestAuth: boolean): boolean {
  return useTestAuth ? true : isTokenStorageAvailable()
}

/** `gh auth token` の待ち時間。 */
/**
 * `gh auth token` の待ち時間。
 *
 * **3 秒では短すぎた。** 起動直後の1回目は初回 exec のぶんだけ遅く（Gatekeeper の評価など）、
 * タイムアウトして「未設定」に落ちる。ターミナルからの実測は 20〜30ms なので、
 * ここを伸ばしても通常は待たない。
 */
const GH_TIMEOUT_MS = 10_000

/**
 * `gh auth token --hostname github.com` を叩く。
 *
 * **ホストを固定する。** gh に GHE のログインが混ざっていると、
 * 既定のアクティブアカウントが GHE 側になりうる。
 *
 * gh が無い / 未ログインは**失敗ではなく null**（PAT も gh も無いのは正常な状態）。
 */
function readGhToken(): Promise<{ token: string | null; failed: boolean }> {
  const ghPath = resolveGhPath()
  if (!ghPath) {
    log('live_folder.gh', { found: false })
    return Promise.resolve({ token: null, failed: false })
  }
  const startedAt = Date.now()
  return new Promise((resolve) => {
    execFile(
      ghPath,
      ['auth', 'token', '--hostname', 'github.com'],
      { timeout: GH_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => {
        const elapsedMs = Date.now() - startedAt
        if (error) {
          // **タイムアウト（`killed`）と「未ログイン」（非ゼロ終了）を分ける。**
          // 前者はこちら側の都合なのですぐ retry してよく、後者は待っても直らない。
          const timedOut = (error as { killed?: boolean }).killed === true
          log('live_folder.gh', { found: true, ok: false, timedOut, elapsedMs })
          resolve({ token: null, failed: timedOut })
          return
        }
        const token = stdout.trim()
        log('live_folder.gh', { found: true, ok: token.length > 0, elapsedMs })
        resolve({ token: token.length > 0 ? token : null, failed: false })
      }
    )
  })
}

/**
 * いま使う資格情報を解決する。
 *
 * **endpoint を差し替えているあいだは、実トークンを一切読まない**
 * （`NEMO_GITHUB_TEST_AUTH` の経路に閉じる）。
 */
export async function resolveToken(useTestAuth: boolean): Promise<ResolvedToken> {
  if (useTestAuth) {
    const mode = testAuthMode ?? 'dummy'
    if (mode === 'none') return NONE
    if (mode === 'stored-only') {
      // **実ストア（Keychain）は読まない。** 差し替え中の置き場だけを見る
      if (!testStoredToken) return NONE
      return {
        source: 'pat',
        token: testStoredToken,
        credentialKey: fingerprint(testStoredToken),
        reason: 'ok'
      }
    }
    return { source: 'pat', token: DUMMY_TOKEN, credentialKey: fingerprint(DUMMY_TOKEN), reason: 'ok' }
  }

  // **明示的に設定した PAT が必ず勝つ**
  const stored = readStoredToken()
  if (stored) return { source: 'pat', token: stored, credentialKey: fingerprint(stored), reason: 'ok' }

  const gh = await readGhToken()
  if (gh.token) {
    return { source: 'gh', token: gh.token, credentialKey: fingerprint(gh.token), reason: 'ok' }
  }
  return gh.failed ? GH_FAILED : NONE
}
