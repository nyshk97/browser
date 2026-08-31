// @ts-check
/**
 * ページの main world に入れる `navigator.permissions.query` の読み替え。
 *
 * Electron の permission check handler は boolean しか返せず「未決定（prompt）」を
 * 表現できない。Nemo は未決定の query に granted と答える（`src/main/security.ts` の
 * `isPermissionsQueryCheck`。denied に倒すと query でゲートするサイトが getUserMedia を
 * 呼ばなくなる）が、未決定のうちは `enumerateDevices()` の label を伏せているため、
 * ページからは「query = granted なのに label が全部空」という実 Chrome ではあり得ない
 * 組み合わせに見える。Google Meet はこれを**デバイスが存在しない**と解釈して
 * getUserMedia を呼ばずに「マイクが見つかりません」で詰む（2026-08-31 に実地で確定）。
 *
 * この矛盾した組み合わせ自体が「Nemo 未決定」の証明（本当に granted なら label が出る、
 * OS 拒否なら check handler が denied に倒す）なので、main world 側だけで読み替えられる:
 *
 * - `query({name: microphone | camera})` の実結果が granted かつ該当 kind の label が
 *   全部空なら `'prompt'` に読み替える。それ以外（denied / prompt / label あり）は素通し
 * - 「今後も同じ扱いにする」を**外して**許可すると Nemo の decision は null のままで
 *   label も空のまま（= 読み替えが自然には外れない）。**アクティブなキャプチャ中でも
 *   label は空のまま**（露出は Chromium 一般の「キャプチャ中は出す」でなく Nemo の
 *   check handler を通るため。remember を外した許可で実測、2026-08-31）。そのため
 *   `getUserMedia` もラップし、成功した stream の track.kind から導いた kind を
 *   ページ内（メモリ）で覚えて以後は実 state を素通しする——**これが唯一の経路**。
 *   constraints からの推測はしない（`{audio:true, video:true}` で片方しか取れない
 *   ケースで外れる）
 * - 読み替え中に返す status は実 PermissionStatus を包む Proxy。実 status は
 *   granted→granted で変わらず change を発火しないので、`devicechange`・
 *   getUserMedia 成功・実 status の change を機に再評価し、実効 state が変わったら
 *   自前で change を発火する
 * - 失敗はすべて素通しに倒す（`mediaDevices` 不在（素の http は secure context でない）・
 *   `enumerateDevices` の reject・その他の例外）。Meet と無関係なサイトの
 *   `permissions.query` を壊さない
 *
 * **この関数はそのまま文字列化してページに送る**ので、外側の変数・import を参照しない。
 * 配る経路は `src/preload/extension-shim.ts`（通常セッション）と
 * `src/main/page-shim.ts` の登録（シークレットセッション）。
 */
export function installPermissionsQueryShim() {
  const nav = /** @type {any} */ (globalThis).navigator
  // secure context でない・そもそも無い環境では何もしない（query は実装のまま）
  if (!nav?.permissions?.query || !nav.mediaDevices?.enumerateDevices) return

  const permissions = nav.permissions
  const mediaDevices = nav.mediaDevices
  const KIND = { microphone: 'audioinput', camera: 'videoinput' }

  /** getUserMedia が成功した device kind（このページ内でだけ覚える） */
  const capturedKinds = new Set()
  /**
   * name ごとに 1 つだけ持つファサード（再評価と change 発火のため）。
   * query のたびに作ると、繰り返し query するページ（Meet）で Proxy と
   * 実 status への change リスナーが増える一方になる
   */
  const facades = new Map()

  /**
   * 差し替えた関数の見た目を元の関数に寄せる（name / length / toString）。
   * anti-bot が `toString()` の `[native code]` を見ることがあるので、露出面を減らす
   * @param {Function} fn @param {Function} original
   */
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

  /**
   * 実 status と列挙から、ページに見せる state を導く
   * @param {{ state: string }} status
   * @param {string} name
   */
  const effectiveState = async (status, name) => {
    const kind = KIND[/** @type {'microphone' | 'camera'} */ (name)]
    if (!kind || status.state !== 'granted') return status.state
    if (capturedKinds.has(kind)) return 'granted'
    const devices = await mediaDevices.enumerateDevices()
    const labeled = devices.some(
      (/** @type {{ kind: string, label: string }} */ d) => d.kind === kind && d.label
    )
    return labeled ? 'granted' : 'prompt'
  }

  /** @param {{ status: any, name: string, local: { state: string, listeners: Set<any>, onchange: any }, facade: any }} entry */
  const reevaluate = async (entry) => {
    let next
    try {
      next = await effectiveState(entry.status, entry.name)
    } catch {
      return
    }
    if (next === entry.local.state) return
    entry.local.state = next
    const event = new Event('change')
    try {
      // 素の `new Event` は target が null。`e.target.state` を読むハンドラを壊さない
      Object.defineProperty(event, 'target', { value: entry.facade })
      Object.defineProperty(event, 'currentTarget', { value: entry.facade })
    } catch {
      /* target が null のまま発火する（読むハンドラだけが影響を受ける） */
    }
    for (const listener of [...entry.local.listeners]) {
      try {
        listener.call(entry.facade, event)
      } catch {
        /* ページ側のリスナーの失敗はページの問題 */
      }
    }
    if (typeof entry.local.onchange === 'function') {
      try {
        entry.local.onchange.call(entry.facade, event)
      } catch {
        /* 同上 */
      }
    }
  }

  const reevaluateAll = () => {
    for (const entry of facades.values()) void reevaluate(entry)
  }

  try {
    mediaDevices.addEventListener?.('devicechange', reevaluateAll)
  } catch {
    /* 再評価の契機が減るだけ（query し直せば正しい値になる） */
  }

  // getUserMedia のラップ: 成功した stream の track.kind を覚えて読み替えを外す。
  // reject は素通し（記憶しない）。
  if (typeof mediaDevices.getUserMedia === 'function') {
    const originalGetUserMedia = mediaDevices.getUserMedia
    const realGetUserMedia = originalGetUserMedia.bind(mediaDevices)
    mediaDevices.getUserMedia = mask(
      /** @param {unknown[]} args */ (...args) =>
        realGetUserMedia(...args).then((/** @type {any} */ stream) => {
          try {
            for (const track of stream.getTracks()) {
              if (track.kind === 'audio') capturedKinds.add('audioinput')
              if (track.kind === 'video') capturedKinds.add('videoinput')
            }
            reevaluateAll()
          } catch {
            /* 記憶に失敗しても stream は返す */
          }
          return stream
        }),
      originalGetUserMedia
    )
  }

  /**
   * 実 PermissionStatus を包む Proxy。`state` と change の経路だけ差し込み、
   * それ以外は実物に bind して返す（素の object literal だと `addEventListener` の
   * this が外れて Illegal invocation になる）。
   * @param {any} status
   * @param {string} name
   * @param {string} initialState
   */
  const makeFacade = (status, name, initialState) => {
    const local = { state: initialState, listeners: new Set(), onchange: null }
    const facade = new Proxy(status, {
      get(target, prop) {
        if (prop === 'state') return local.state
        if (prop === 'onchange') return local.onchange
        // change はファサード側だけで扱う。実 status にも転送すると、実 status が
        // 本当に change したとき（Nemo の decision 変化）にページのリスナーが 2 回呼ばれ、
        // 実イベント側の `e.target.state` に**読み替え前の値**が見えてしまう。
        // 実 status への購読は makeFacade 内の再評価用リスナー 1 本だけに寄せる
        if (prop === 'addEventListener') {
          return /** @param {unknown[]} args */ (...args) => {
            const [type, listener] = args
            if (type === 'change') {
              if (typeof listener === 'function') local.listeners.add(listener)
              return
            }
            return target.addEventListener(...args)
          }
        }
        if (prop === 'removeEventListener') {
          return /** @param {unknown[]} args */ (...args) => {
            const [type, listener] = args
            if (type === 'change') {
              local.listeners.delete(listener)
              return
            }
            return target.removeEventListener(...args)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, prop, value) {
        if (prop === 'onchange') {
          local.onchange = value
          return true
        }
        return Reflect.set(target, prop, value)
      }
    })
    const entry = { status, name, local, facade }
    facades.set(name, entry)
    // Electron 側の遷移（Nemo の decision 変化）も再評価の契機にする
    try {
      status.addEventListener('change', () => void reevaluate(entry))
    } catch {
      /* 契機が減るだけ */
    }
    return facade
  }

  const originalQuery = permissions.query
  const realQuery = originalQuery.bind(permissions)
  permissions.query = mask(async (/** @type {any} */ descriptor) => {
    const name = descriptor?.name
    if (name !== 'microphone' && name !== 'camera') return realQuery(descriptor)
    // 2 回目以降は同じファサードを返す（PermissionStatus は live なので実 status も
    // 使い回せる）。返す前に再評価して、契機を取りこぼしていても最新の値にする
    const existing = facades.get(name)
    if (existing) {
      await reevaluate(existing)
      return existing.facade
    }
    const status = await realQuery(descriptor)
    try {
      const state = await effectiveState(status, name)
      return makeFacade(status, name, state)
    } catch {
      // 列挙に失敗したら実結果を素通し（読み替えより壊さないことを優先）
      return status
    }
  }, originalQuery)
}
