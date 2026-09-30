import createKdfWorker from './kdf-worker?nodeWorker'
import {
  deriveKeys,
  derivePassphraseKey,
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
    const reply = await runWorker('password', password, kdf)
    if (!('authKey' in reply)) throw new Error('鍵の導出の応答が違う')
    return reply
  } catch (error) {
    if (error instanceof KyprCryptoError) throw error
    // worker を起動できない（パッケージ版で asar の中から読めない等）ときは main で導出する。
    // 1 秒近く main が止まるが、解除できないよりよい。ログで気づけるようにする
    log('kypr.kdf_worker_fallback', {})
    return deriveKeys(password, kdf)
  }
}

/** 合言葉の検証値（kypr の「端末の登録と合言葉」）。worker を起動できなければ main で導出する（上と同じ理由）。 */
export async function derivePassphraseInWorker(passphrase: string, kdf: KdfParams): Promise<Uint8Array> {
  try {
    const reply = await runWorker('passphrase', passphrase, kdf)
    if (!('passphraseKey' in reply)) throw new Error('鍵の導出の応答が違う')
    return reply.passphraseKey
  } catch (error) {
    if (error instanceof KyprCryptoError) throw error
    log('kypr.kdf_worker_fallback', {})
    return derivePassphraseKey(passphrase, kdf)
  }
}

type WorkerReply = { authKey: Uint8Array; wrapKey: Uint8Array } | { passphraseKey: Uint8Array }

function runWorker(kind: 'password' | 'passphrase', password: string, kdf: KdfParams): Promise<WorkerReply> {
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
          | { ok: true; passphraseKey: Uint8Array }
          | { ok: false; code: string; message: string }
      ) => {
        done()
        if (reply.ok && 'passphraseKey' in reply)
          resolve({ passphraseKey: new Uint8Array(reply.passphraseKey) })
        else if (reply.ok)
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
    worker.postMessage({ id: 1, kind, password, kdf })
  })
}
