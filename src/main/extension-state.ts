import type { LoadedExtensionInfo } from '../shared/types.js'

/**
 * lock にある拡張の一覧（OFF も含む）と、その変更通知。
 *
 * `extensions.ts` が書き、`registry.ts`（SharedState）と `ipc.ts` が読む。
 * `extensions.ts` は registry を import しているので、registry から直接
 * `extensions.ts` を読むと循環する。**依存の無いこのモジュールに状態だけを置く**。
 */

let extensions: LoadedExtensionInfo[] = []
const listeners = new Set<() => void>()

export function getLoadedExtensions(): LoadedExtensionInfo[] {
  return extensions
}

/**
 * 実際にロードできた拡張だけ（起動ステータスの件数はこちらを使う）。
 * ON でもロードに失敗した行（`matchesLock: false`）は含めない。
 */
export function getLoadedOkExtensions(): LoadedExtensionInfo[] {
  return extensions.filter((extension) => extension.enabled && extension.matchesLock)
}

export function setLoadedExtensions(next: LoadedExtensionInfo[]): void {
  extensions = next
  for (const listener of listeners) listener()
}

/** 一覧が変わった（トグル・起動時のロード完了）ときに全ウィンドウへ配るための契機。 */
export function onExtensionsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
