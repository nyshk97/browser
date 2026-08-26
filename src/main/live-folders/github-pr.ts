import { net } from 'electron'
import { GITHUB_GRAPHQL_ENDPOINT, fetchPullRequests } from '../../shared/github-pr.js'

/**
 * GitHub クライアントの main 側の薄い層。
 *
 * 判定・解釈はすべて `src/shared/github-pr.js`（Electron 非依存）にある。
 * ここがやるのは **`net.fetch` を渡すこと**と、**自走検証のための endpoint 差し替え**だけ。
 */

/**
 * 自走検証で向き先を差し替える口。
 *
 * **ゲートは `!app.isPackaged`**（`isDevChannel` では塞げない。
 * `paths.ts` が `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので、
 * dev パッケージでも `isDevChannel === true` になり裏口が残る）。
 *
 * **差し替えが有効なあいだは、トークンを一切読まない**（`token.ts` 側の責務）。
 * これをやらないと「環境変数1つで本物の PAT を任意のホストへ送れる」経路になる。
 */
let endpointOverride: string | null = null

export function configureGithubTestEndpoint(endpoint: string): void {
  endpointOverride = endpoint
}

/** いま差し替え中か（トークンを読んでよいかの判定に使う）。 */
export function isGithubTestEndpoint(): boolean {
  return endpointOverride !== null
}

export function githubEndpoint(): string {
  return endpointOverride ?? GITHUB_GRAPHQL_ENDPOINT
}

/**
 * PR を取ってくる。
 *
 * `net.fetch` を使う（Electron の net。**プロキシ設定を尊重する**）。
 */
export function fetchLivePullRequests(token: string): ReturnType<typeof fetchPullRequests> {
  return fetchPullRequests({
    token,
    endpoint: githubEndpoint(),
    fetchImpl: (url, init) =>
      net.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal as AbortSignal
      })
  })
}
