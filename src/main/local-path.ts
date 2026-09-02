import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * アドレスバー / コマンドバーの入力で「ローカルパス」に見えるものを `file://` に変換する
 * （2026-09-02 の plan「ローカルファイル」）。
 *
 * **実在するパスのときだけ**変換する。`/` で始まる検索語（`/etc 設定` 等）は今までどおり検索へ落とす。
 * 存在しないパスを `file://` にすると全部 ERR_FILE_NOT_FOUND のエラーページになり、既存挙動が劣化する。
 *
 * 呼び出し側は変換後の URL を `normalizeNavigationInput(..., { allowFile: true })` に渡す
 * （`ipc.ts` の `resolveInput` と `suggest.ts` の「そのまま実行」行の 2 箇所。人間の入力が起点の経路だけ）。
 */
export function localPathToFileUrl(input: string): string | null {
  let filePath: string
  if (input.startsWith('/')) filePath = input
  else if (input === '~' || input.startsWith('~/')) filePath = homedir() + input.slice(1)
  else return null
  try {
    return existsSync(filePath) ? pathToFileURL(filePath).href : null
  } catch {
    return null
  }
}
