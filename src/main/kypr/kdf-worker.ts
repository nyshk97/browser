import { parentPort } from 'node:worker_threads'
import { deriveKeys, KyprCryptoError, type KdfParams } from '../../vendor/kypr/crypto/index.ts'

/**
 * マスターパスワードから鍵を導出する（Argon2id 64MiB 以上）。**main を止めないよう worker で回す**
 * （hash-wasm の argon2id は WASM の中で同期的に回るので、main で呼ぶと全ウィンドウが 1 秒近く止まる）。
 */
parentPort?.on('message', (message: { id: number; password: string; kdf: KdfParams }) => {
  void deriveKeys(message.password, message.kdf).then(
    ({ authKey, wrapKey }) => {
      parentPort?.postMessage({ id: message.id, ok: true, authKey, wrapKey }, [
        authKey.buffer,
        wrapKey.buffer
      ])
    },
    (error: unknown) => {
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        code: error instanceof KyprCryptoError ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  )
})
