// @ts-check
/**
 * ユーザーが書いた正規表現を**走らせる場所**。
 *
 * `worker_threads` の常駐ワーカーとして `{ eval: true }` で評価する。
 * ソースを文字列で持つのは、**electron-vite の worker artifact のパス解決を無くす**ため:
 * 別ファイルに置くと開発起動では通っても asar から読めず、
 * 「自動入力が一切効かない配布版」になりうる（読み込み経路が 1 本も無ければ壊れようがない）。
 *
 * 1 メッセージ = **ルール 1 件の照合**。まとめて渡さないのは、
 * 応答しないワーカーから「どのルールが原因か」を取り出せないと
 * 「そのルールだけ無効化」が実装できないため。
 *
 * ここは `src/shared/http-auth-rules.js` の `matchRules` と**同じ判定**でなければならない。
 * 2 つの実装が食い違わないことは `scripts/http-auth-rules.test.mjs` が
 * 実際にこのワーカーを起動して突き合わせている。
 */
export const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')

parentPort.on('message', (job) => {
  let matched = false
  let error = null
  try {
    matched = new RegExp(job.pattern).test(job.url)
  } catch (e) {
    // 壊れた正規表現は「不一致」に倒す（例外でワーカーを落とさない）
    error = String((e && e.message) || e)
  }
  parentPort.postMessage({ id: job.id, matched, error })
})
`
