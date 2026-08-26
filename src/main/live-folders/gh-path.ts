import fs from 'node:fs'
import path from 'node:path'

/**
 * `gh` の実行ファイルを**絶対パスで**解決する。
 *
 * **`'gh'` をそのまま `execFile` に渡さない。** Finder から起動した macOS アプリの
 * `PATH` には Homebrew の `/opt/homebrew/bin`（Apple Silicon）や `/usr/local/bin`
 * （Intel）が**入っていないことがある**。ターミナルから `pnpm dev` で動かしている
 * あいだは通るので、**packaged 版を Finder から起動して初めて「gh が無い」ことになる**。
 *
 * 解決の順序:
 * 1. 継承した `PATH` から探す
 * 2. `/opt/homebrew/bin/gh`（Apple Silicon の Homebrew）
 * 3. `/usr/local/bin/gh`（Intel の Homebrew）
 * 4. どれも無ければ null
 *
 * main 側に `execFile` の前例が無いので、この解決だけを単独で置いてある
 * （他から使うときに拾える）。
 */

const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/** 実行できるファイルか（存在 + 実行権）。 */
function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * @param env `PATH` を持つ環境（テストから差し替えられるように引数にしている）
 */
export function resolveGhPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromPath = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of [...fromPath, ...FALLBACK_DIRS]) {
    const candidate = path.join(dir, 'gh')
    if (isExecutable(candidate)) return candidate
  }
  return null
}
