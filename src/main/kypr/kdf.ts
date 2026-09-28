import createKdfWorker from './kdf-worker?nodeWorker'
import {
  deriveKeys,
  KyprCryptoError,
  type KdfParams,
  type KyprErrorCode
} from '../../vendor/kypr/crypto/index.ts'
import { log, logError } from '../log.js'

/**
 * 鍵の導出を worker で回す（`kdf-worker.ts`）。**使うたびに作って終わったら止める**
 * （マスターパスワードを入れるのは初回・Touch ID が使えないときだけで、常駐させる理由が無い。
 * 導出に 64MiB 以上使うので、残しておくとそのぶんメモリを握り続ける）。
 */
export async function deriveInWorker(
  password: string,
  kdf: KdfParams
): Promise<{ authKey: Uint8Array; wrapKey: Uint8Array }> {
  try {
    return await runWorker(password, kdf)
  } catch (error) {
    if (error instanceof KyprCryptoError) throw error
    // worker を起動できない（パッケージ版で asar の中から読めない等）ときは main で導出する。
    // 1 秒近く main が止まるが、解除できないよりよい。ログで気づけるようにする
    log('kypr.kdf_worker_fallback', {})
    return deriveKeys(password, kdf)
  }
}

function runWorker(password: string, kdf: KdfParams): Promise<{ authKey: Uint8Array; wrapKey: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let worker: ReturnType<typeof createKdfWorker>
    try {
      worker = createKdfWorker({})
    } catch (error) {
      logError('kypr.kdf_worker_error', error, {})
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const done = (): void => void worker.terminate()
    worker.once(
      'message',
      (
        reply:
          | { ok: true; authKey: Uint8Array; wrapKey: Uint8Array }
          | { ok: false; code: string; message: string }
      ) => {
        done()
        if (reply.ok)
          resolve({ authKey: new Uint8Array(reply.authKey), wrapKey: new Uint8Array(reply.wrapKey) })
        else if (reply.code === 'internal') reject(new Error(reply.message))
        else reject(new KyprCryptoError(reply.code as KyprErrorCode, reply.message))
      }
    )
    worker.once('error', (error) => {
      logError('kypr.kdf_worker_error', error, {})
      done()
      reject(error)
    })
    worker.postMessage({ id: 1, password, kdf })
  })
}
