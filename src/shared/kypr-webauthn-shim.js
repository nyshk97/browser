// @ts-check
/**
 * kypr の Web 版の Touch ID 解除に答える認証器の、**ページの main world 側**。
 *
 * `src/preload/kypr-page.ts` が、main が「kypr の origin のメインフレーム」と答えた frame にだけ
 * `contextBridge.executeInMainWorld({ func: installKyprWebAuthn, args: [bridge] })` で入れる。
 * `bridge` は main への `ipcRenderer.invoke('nemo:kypr-webauthn', req)`（ページにグローバルな名前を生やさない）。
 * 答えるかどうかの判定・秘密・Touch ID は全部 main（`src/main/kypr/web-authenticator.ts`）。
 *
 * - `navigator.credentials.create` / `get`: `publicKey.extensions.prf` がある要求だけ main に回す。
 *   main が `not-kypr` を返したら包む前の関数に渡す（その先は `webauthn-shim.js` が今までどおり扱う）。
 *   `not-allowed` なら NotAllowedError
 * - `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable` → true、
 *   `getClientCapabilities` → native の結果に `extension:prf` / `userVerifyingPlatformAuthenticator` を true で足す
 * - `PublicKeyCredential.signalUnknownCredential` → main に保存した秘密を消させる
 * - 返すのは kypr が読むところだけを持つオブジェクト（`PublicKeyCredential` のインスタンスではない。署名は空）
 *
 * **`webauthn-shim.js` より外側（後）に入る前提**（preload の登録順が extension-shim → kypr-page）。
 * 内側だと kypr の要求がそこで NotAllowedError になる。`scripts/verify-kypr.mjs` が実物で押さえている。
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない。
 * @param {(req: Record<string, unknown>) => Promise<any>} bridge
 */
export function installKyprWebAuthn(bridge) {
  const g = /** @type {any} */ (globalThis)
  const credentials = g.navigator?.credentials
  const PKC = g.PublicKeyCredential
  const DOMExceptionCtor = g.DOMException
  if (!credentials || typeof credentials.get !== 'function' || !PKC || typeof DOMExceptionCtor !== 'function')
    return
  if (typeof bridge !== 'function') return

  const NOT_ALLOWED_MESSAGE =
    'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.'
  const notAllowed = () => new DOMExceptionCtor(NOT_ALLOWED_MESSAGE, 'NotAllowedError')

  /** @param {Function} fn @param {Function} original */
  const mask = (fn, original) => {
    try {
      Object.defineProperty(fn, 'name', { value: original.name })
      Object.defineProperty(fn, 'length', { value: original.length })
      fn.toString = original.toString.bind(original)
    } catch {
      /* 見た目の話なので失敗しても機能は変わらない */
    }
    return fn
  }

  /** BufferSource をバイト列にする（オフセット付きの TypedArray / DataView も正しい範囲で読む）。 */
  /** @param {unknown} v @returns {Uint8Array | null} */
  const bytesOf = (v) => {
    if (v instanceof ArrayBuffer) return new Uint8Array(v)
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return null
  }
  /** @param {Uint8Array} bytes */
  const toB64 = (bytes) => {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(/** @type {number} */ (bytes[i]))
    return g.btoa(bin)
  }
  /** @param {Uint8Array} bytes */
  const toB64url = (bytes) => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  /** @param {string} b64 @returns {ArrayBuffer} */
  const bufferFromB64 = (b64) => {
    const bin = g.atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  }
  /** @param {unknown} v */
  const b64OrNull = (v) => {
    const bytes = bytesOf(v)
    return bytes ? toB64(bytes) : null
  }

  /** @param {'webauthn.create' | 'webauthn.get'} type @param {unknown} challenge */
  const clientData = (type, challenge) => {
    const bytes = bytesOf(challenge) ?? new Uint8Array(0)
    const json = JSON.stringify({
      type,
      challenge: toB64url(bytes),
      origin: g.location.origin,
      crossOrigin: false
    })
    return new TextEncoder().encode(json).buffer
  }

  /**
   * @param {'create' | 'get'} op
   * @param {{ id: string, prf: string | null }} reply
   * @param {unknown} challenge
   */
  const credentialFrom = (op, reply, challenge) => {
    const rawId = bufferFromB64(reply.id)
    const prfFirst = reply.prf ? bufferFromB64(reply.prf) : null
    const response =
      op === 'create'
        ? {
            clientDataJSON: clientData('webauthn.create', challenge),
            attestationObject: new ArrayBuffer(0),
            getTransports: () => ['internal'],
            getAuthenticatorData: () => new ArrayBuffer(0),
            getPublicKey: () => null,
            getPublicKeyAlgorithm: () => -7
          }
        : {
            clientDataJSON: clientData('webauthn.get', challenge),
            authenticatorData: new ArrayBuffer(0),
            signature: new ArrayBuffer(0),
            userHandle: null
          }
    const extensionResults = () => {
      /** @type {Record<string, unknown>} */
      const prf = {}
      if (op === 'create') prf['enabled'] = true
      if (prfFirst) prf['results'] = { first: prfFirst.slice(0) }
      return { prf }
    }
    return {
      id: reply.id,
      rawId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: extensionResults,
      toJSON: () => ({
        id: reply.id,
        rawId: reply.id,
        type: 'public-key',
        authenticatorAttachment: 'platform'
      })
    }
  }

  /** @param {any} signal */
  const abortError = (signal) =>
    signal?.reason !== undefined
      ? signal.reason
      : new DOMExceptionCtor('The operation was aborted.', 'AbortError')

  /**
   * main に回す要求（平たいデータだけ。options を丸ごと渡すと signal 等が world をまたげない）。
   * 読めない options は null（包む前の関数に渡す）。
   * @param {'create' | 'get'} op @param {any} publicKey
   */
  const requestOf = (op, publicKey) => {
    const prf = publicKey.extensions?.prf
    if (!prf || typeof prf !== 'object') return null
    const first = prf.eval?.first
    if (op === 'create') {
      const selection = publicKey.authenticatorSelection ?? {}
      return {
        op,
        rpId: typeof publicKey.rp?.id === 'string' ? publicKey.rp.id : null,
        attachment: selection.authenticatorAttachment ?? null,
        userVerification: selection.userVerification ?? null,
        prf: true,
        prfFirst: first === undefined ? null : b64OrNull(first)
      }
    }
    const allow = Array.isArray(publicKey.allowCredentials) ? publicKey.allowCredentials : []
    return {
      op,
      rpId: typeof publicKey.rpId === 'string' ? publicKey.rpId : null,
      userVerification: publicKey.userVerification ?? null,
      allowCredentials: allow.map((/** @type {any} */ c) => {
        const bytes = bytesOf(c?.id)
        return bytes ? toB64url(bytes) : null
      }),
      prfFirst: first === undefined ? null : b64OrNull(first)
    }
  }

  /** @param {'create' | 'get'} method */
  const wrap = (method) => {
    const original = credentials[method]
    if (typeof original !== 'function') return
    const inner = original.bind(credentials)
    credentials[method] = mask(
      /** @param {unknown[]} args */ (...args) => {
        const options = /** @type {any} */ (args[0])
        /** @type {Record<string, unknown> | null} */
        let req = null
        try {
          const publicKey = options?.publicKey
          if (publicKey && typeof publicKey === 'object' && options.mediation !== 'conditional') {
            req = requestOf(method, publicKey)
          }
        } catch {
          req = null
        }
        if (!req) return inner(...args)
        const signal = options.signal
        const challenge = options.publicKey.challenge
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError(signal))
            return
          }
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            reject(abortError(signal))
          }
          signal?.addEventListener?.('abort', onAbort, { once: true })
          const finish = (/** @type {() => void} */ fn) => {
            if (settled) return
            settled = true
            signal?.removeEventListener?.('abort', onAbort)
            fn()
          }
          Promise.resolve()
            .then(() => bridge(/** @type {Record<string, unknown>} */ (req)))
            .then(
              (reply) => {
                if (reply?.ok === true && typeof reply.id === 'string') {
                  finish(() => resolve(credentialFrom(method, reply, challenge)))
                } else if (reply?.ok === false && reply.reason === 'not-kypr') {
                  finish(() => {
                    try {
                      resolve(inner(...args))
                    } catch (error) {
                      reject(error)
                    }
                  })
                } else {
                  finish(() => reject(notAllowed()))
                }
              },
              () => finish(() => reject(notAllowed()))
            )
        })
      },
      original
    )
  }
  wrap('create')
  wrap('get')

  const isUVPAA = PKC.isUserVerifyingPlatformAuthenticatorAvailable
  if (typeof isUVPAA === 'function') {
    PKC.isUserVerifyingPlatformAuthenticatorAvailable = mask(async () => true, isUVPAA)
  }

  const capabilities = PKC.getClientCapabilities
  if (typeof capabilities === 'function') {
    PKC.getClientCapabilities = mask(async () => {
      let base
      try {
        base = (await capabilities.call(PKC)) ?? {}
      } catch {
        base = {}
      }
      return { ...base, 'extension:prf': true, userVerifyingPlatformAuthenticator: true }
    }, capabilities)
  }

  const signal = PKC.signalUnknownCredential
  /** @param {any} options */
  const signalUnknown = async (options) => {
    const credentialId = typeof options?.credentialId === 'string' ? options.credentialId : null
    const rpId = typeof options?.rpId === 'string' ? options.rpId : null
    if (credentialId) {
      try {
        await bridge({ op: 'forget', rpId, credentialId })
      } catch {
        /* 消せなくても、上限（origin ごとに 5 件）で古いものから落ちる */
      }
    }
  }
  PKC.signalUnknownCredential = typeof signal === 'function' ? mask(signalUnknown, signal) : signalUnknown
}
