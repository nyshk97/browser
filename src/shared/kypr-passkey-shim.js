// @ts-check
/**
 * kypr のパスキーの認証器の、**ページの main world 側**（plan `docs/plans/2026-09-30-1700-kypr-passkeys.md`）。
 *
 * `src/preload/kypr-page.ts` が http / https のトップフレームに
 * `contextBridge.executeInMainWorld({ func: installKyprPasskey, args: [bridge] })` で入れる。
 * `bridge` は main への `ipcRenderer.invoke('nemo:kypr-passkey', req)`（ページにグローバルな名前を生やさない）。
 * 答えるかどうかの判定・鍵・Touch ID・clientDataJSON は全部 main（`src/main/kypr/passkey-authenticator.ts`）。
 *
 * - modal の `navigator.credentials.create` / `get`（`publicKey` があり `mediation: 'conditional'` でないもの）を
 *   main に回す。main が `pass` を返したら包む前の関数に渡す（その先は `webauthn-shim.js` が今までどおり扱う）。
 *   `error` なら同じ名前の DOMException（`TypeError` だけは TypeError）
 * - `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable` / `getClientCapabilities`:
 *   呼ばれるたびに main に聞く（kypr にログインしていて Touch ID が使え、答える origin なら true）。
 *   答えない origin では包む前の関数（native の false）
 * - 返すのは `PublicKeyCredential` / `Authenticator*Response` の prototype を持つオブジェクト
 *   （`instanceof` を見るサイトのため。値は自分のプロパティで持ち、prototype の getter を隠す）
 *
 * **重ね順**: 内側から `webauthn-shim.js`（extension-shim）→ この shim → kypr の Web の origin だけ PRF の shim
 * （`kypr-webauthn-shim.js`）。preload の登録順が extension-shim → kypr-page で、kypr-page の中でこれを先に入れる。
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない。
 * @param {(req: Record<string, unknown>) => Promise<any>} bridge
 */
export function installKyprPasskey(bridge) {
  const g = /** @type {any} */ (globalThis)
  const credentials = g.navigator?.credentials
  const PKC = g.PublicKeyCredential
  const DOMExceptionCtor = g.DOMException
  if (!credentials || typeof credentials.get !== 'function' || !PKC || typeof DOMExceptionCtor !== 'function')
    return
  if (typeof bridge !== 'function') return

  // Chrome と同じ文言（サイト側の分岐が message を見ていても揃う）
  /** @type {Record<string, string>} */
  const MESSAGES = {
    NotAllowedError:
      'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.',
    InvalidStateError:
      'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.',
    NotSupportedError:
      'The specified `userVerification` requirement cannot be fulfilled by this device unless the device is secured with a screen lock.',
    SecurityError:
      'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.'
  }
  /** @param {unknown} name */
  const errorOf = (name) => {
    if (name === 'TypeError')
      return new TypeError('Failed to execute on CredentialsContainer: invalid options.')
    const key = typeof name === 'string' && name in MESSAGES ? name : 'NotAllowedError'
    return new DOMExceptionCtor(MESSAGES[key], key)
  }

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
  const toB64url = (bytes) => {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(/** @type {number} */ (bytes[i]))
    return g.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  /** @param {string} b64url @returns {ArrayBuffer} */
  const bufferOf = (b64url) => {
    const bin = g.atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  }
  /** @param {unknown} v 読めなければ例外（包む前の関数に渡す） */
  const b64urlOf = (v) => {
    const bytes = bytesOf(v)
    if (!bytes) throw new Error('not a BufferSource')
    return toB64url(bytes)
  }
  /** @param {unknown} list */
  const descriptors = (list) =>
    list == null
      ? []
      : Array.from(/** @type {Iterable<any>} */ (list), (c) => ({
          id: b64urlOf(c?.id),
          transports: Array.isArray(c?.transports) ? c.transports.map(String) : null
        }))

  /**
   * main に回す要求（平たいデータだけ。options を丸ごと渡すと signal 等が world をまたげない）。
   * 読めない options は例外（包む前の関数に渡し、native が正しいエラーを出す）。
   * @param {'create' | 'get'} op @param {any} publicKey
   */
  const requestOf = (op, publicKey) => {
    const extensions = publicKey.extensions ?? {}
    const base = {
      op,
      challenge: b64urlOf(publicKey.challenge),
      prf: extensions.prf != null
    }
    if (op === 'create') {
      const selection = publicKey.authenticatorSelection ?? {}
      const params = Array.isArray(publicKey.pubKeyCredParams) ? publicKey.pubKeyCredParams : []
      return {
        ...base,
        rpId: typeof publicKey.rp?.id === 'string' ? publicKey.rp.id : null,
        rpName: typeof publicKey.rp?.name === 'string' ? publicKey.rp.name : '',
        userId: b64urlOf(publicKey.user?.id),
        userName: typeof publicKey.user?.name === 'string' ? publicKey.user.name : '',
        userDisplayName: typeof publicKey.user?.displayName === 'string' ? publicKey.user.displayName : '',
        algs: params
          .filter((/** @type {any} */ p) => p?.type === 'public-key')
          .map((/** @type {any} */ p) => p.alg),
        attachment:
          typeof selection.authenticatorAttachment === 'string' ? selection.authenticatorAttachment : null,
        excludeCredentials: descriptors(publicKey.excludeCredentials),
        credProps: extensions.credProps === true
      }
    }
    return {
      ...base,
      rpId: typeof publicKey.rpId === 'string' ? publicKey.rpId : null,
      allowCredentials: descriptors(publicKey.allowCredentials)
    }
  }

  /**
   * `proto` を持つオブジェクトに、値を自分のプロパティとして載せる（prototype の getter を隠す）。
   * prototype が無い環境では素のオブジェクト。
   * @param {any} Ctor @param {Record<string, unknown>} props
   */
  const shaped = (Ctor, props) => {
    const obj = Ctor && Ctor.prototype ? Object.create(Ctor.prototype) : {}
    for (const [key, value] of Object.entries(props)) {
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: false })
    }
    return obj
  }

  /** @param {any} r main の応答（create） */
  const registrationFrom = (r) => {
    const transports = ['hybrid', 'internal']
    const extensionResults = r.credProps ? { credProps: { rk: true } } : {}
    const response = shaped(g.AuthenticatorAttestationResponse, {
      clientDataJSON: bufferOf(r.clientDataJSON),
      attestationObject: bufferOf(r.attestationObject),
      getTransports: () => transports.slice(),
      getAuthenticatorData: () => bufferOf(r.authenticatorData),
      getPublicKey: () => bufferOf(r.publicKey),
      getPublicKeyAlgorithm: () => r.publicKeyAlgorithm
    })
    return shaped(PKC, {
      id: r.credentialId,
      rawId: bufferOf(r.credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => JSON.parse(JSON.stringify(extensionResults)),
      toJSON: () => ({
        id: r.credentialId,
        rawId: r.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: JSON.parse(JSON.stringify(extensionResults)),
        response: {
          clientDataJSON: r.clientDataJSON,
          attestationObject: r.attestationObject,
          authenticatorData: r.authenticatorData,
          transports: transports.slice(),
          publicKey: r.publicKey,
          publicKeyAlgorithm: r.publicKeyAlgorithm
        }
      })
    })
  }

  /** @param {any} r main の応答（get） */
  const assertionFrom = (r) => {
    const response = shaped(g.AuthenticatorAssertionResponse, {
      clientDataJSON: bufferOf(r.clientDataJSON),
      authenticatorData: bufferOf(r.authenticatorData),
      signature: bufferOf(r.signature),
      userHandle: bufferOf(r.userHandle)
    })
    return shaped(PKC, {
      id: r.credentialId,
      rawId: bufferOf(r.credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: r.credentialId,
        rawId: r.credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: r.clientDataJSON,
          authenticatorData: r.authenticatorData,
          signature: r.signature,
          userHandle: r.userHandle
        }
      })
    })
  }

  /** @param {any} signal */
  const abortError = (signal) =>
    signal?.reason !== undefined
      ? signal.reason
      : new DOMExceptionCtor('The operation was aborted.', 'AbortError')

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
                if (reply?.ok === true && reply.op === method) {
                  finish(() => {
                    try {
                      resolve(method === 'create' ? registrationFrom(reply) : assertionFrom(reply))
                    } catch {
                      reject(errorOf('NotAllowedError'))
                    }
                  })
                } else if (reply?.ok === false && reply.pass === true) {
                  finish(() => {
                    try {
                      resolve(inner(...args))
                    } catch (error) {
                      reject(error)
                    }
                  })
                } else {
                  finish(() => reject(errorOf(reply?.error)))
                }
              },
              () => finish(() => reject(errorOf('NotAllowedError')))
            )
        })
      },
      original
    )
  }
  wrap('create')
  wrap('get')

  /** main に「このページでパスキーを出せるか」を聞く（失敗は false）。 */
  const available = async () => {
    try {
      const reply = await bridge({ op: 'available' })
      return reply?.ok === true && reply.available === true
    } catch {
      return false
    }
  }

  const isUVPAA = PKC.isUserVerifyingPlatformAuthenticatorAvailable
  if (typeof isUVPAA === 'function') {
    PKC.isUserVerifyingPlatformAuthenticatorAvailable = mask(
      async () => ((await available()) ? true : isUVPAA.call(PKC)),
      isUVPAA
    )
  }

  const capabilities = PKC.getClientCapabilities
  if (typeof capabilities === 'function') {
    PKC.getClientCapabilities = mask(async () => {
      const base = await capabilities.call(PKC)
      if (!(await available())) return base
      return { ...(base ?? {}), userVerifyingPlatformAuthenticator: true, passkeyPlatformAuthenticator: true }
    }, capabilities)
  }
}
