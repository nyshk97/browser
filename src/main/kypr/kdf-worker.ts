import { parentPort } from 'node:worker_threads'
import {
  deriveKeys,
  derivePassphraseKey,
  KyprCryptoError,
  type KdfParams
} from '../../vendor/kypr/crypto/index.ts'

/**
 * マスターパスワードから鍵を導出する（Argon2id 64MiB 以上）。**main を止めないよう worker で回す**
 * （hash-wasm の argon2id は WASM の中で同期的に回るので、main で呼ぶと全ウィンドウが 1 秒近く止まる）。
 * `kind: 'passphrase'` なら合言葉の検証値（kypr の「端末の登録と合言葉」。同じ重さの Argon2id）。
 */
parentPort?.on(
  'message',
  (message: { id: number; kind?: 'password' | 'passphrase'; password: string; kdf: KdfParams }) => {
    const fail = (error: unknown): void => {
      parentPort?.postMessage({
        id: message.id,
        ok: false,
        code: error instanceof KyprCryptoError ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error)
      })
    }
    if (message.kind === 'passphrase') {
      void derivePassphraseKey(message.password, message.kdf).then((passphraseKey) => {
        parentPort?.postMessage({ id: message.id, ok: true, passphraseKey }, [passphraseKey.buffer])
      }, fail)
      return
    }
    void deriveKeys(message.password, message.kdf).then(({ authKey, wrapKey }) => {
      parentPort?.postMessage({ id: message.id, ok: true, authKey, wrapKey }, [
        authKey.buffer,
        wrapKey.buffer
      ])
    }, fail)
  }
)
