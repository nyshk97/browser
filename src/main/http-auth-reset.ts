import fs from 'node:fs'
import { app, session } from 'electron'
import { PAGE_PARTITION, userDataPath } from './paths.js'
import { resetHttpAuthRuntime } from './http-auth.js'
import { log, logError } from './log.js'

/**
 * 「資格情報が変わった」ときの後始末を **1 か所に集約する**。
 *
 * `attempts` を持つ `http-auth.ts` と永続化の `store/http-auth.ts` が
 * 相互に import しないよう、**両者の外側に置いて両方を呼ぶ**。
 *
 * 削除だけでなく**無効化・pattern / username / password の編集・インポート**でも、
 * 次の 2 つを必ず**両方**行う（#19）:
 *
 * 1. `session.fromPartition(PAGE_PARTITION).clearAuthCache()`
 *    （`defaultSession` を消しても常用タブの `persist:` セッションには効かない）
 * 2. `attempts` / `denied` / 直列化キューの全消し
 *
 * **全消しは `finally` で行う。** `clearAuthCache()` が reject したときに
 * 直列実装だと消去が丸ごと飛び、「両方必ず行う」が破れる。
 * キャッシュ消去に失敗しても**保存は成立している**ので、IPC はエラーにせず
 * `authCacheCleared: false` の**判別できる成功結果**を返す
 * （エラーにすると renderer が「保存も失敗した」と誤って表示を巻き戻す）。
 */
export async function httpAuthCredentialsChanged(reason: string): Promise<boolean> {
  let cleared = false
  try {
    if (failCacheClearForTest()) throw new Error('test: clearAuthCache を失敗させた')
    await session.fromPartition(PAGE_PARTITION).clearAuthCache()
    cleared = true
  } catch (error) {
    logError('http_auth.clear_cache_failed', error, { reason })
  } finally {
    resetHttpAuthRuntime()
  }
  log('http_auth.credentials_changed', { reason, authCacheCleared: cleared })
  return cleared
}

/**
 * 自走検証から「キャッシュ消去だけを失敗させる」ための口。
 *
 * ゲートは **`!app.isPackaged`**（`timings.ts` / `ipc.ts` と同じ流儀）。
 * この経路は**まっさらな状態からの検証では一度も通らない**ので、
 * 差し込めるようにしておかないと `authCacheCleared: false` の側が無検証で残る。
 *
 * **env ではなくマーカーファイルで切り替える。** env にすると起動から終了まで
 * 効きっぱなしになり、同じ起動の中で回している他の検証から
 * 認証キャッシュの消去が丸ごと失われる（＝それらが偽 PASS になる）。
 */
function failCacheClearForTest(): boolean {
  if (app.isPackaged) return false
  try {
    fs.accessSync(userDataPath(FAIL_CACHE_CLEAR_MARKER))
    return true
  } catch {
    return false
  }
}

/** 検証スクリプトが作る / 消すファイル名。 */
export const FAIL_CACHE_CLEAR_MARKER = '.nemo-fail-auth-cache-clear'
