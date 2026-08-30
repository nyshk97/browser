// @ts-check
/**
 * 拡張コンテキスト向けの `chrome.storage.*.onChanged` 補完。
 *
 * Electron 41 は **service worker では `chrome.storage.onChanged` / `chrome.storage.<area>.onChanged` を
 * 鳴らさない**（popup 等の frame で受ける側は鳴る。2026-08-30 に実測）。Bitwarden の状態管理は
 * `storageArea.onChanged` で「他コンテキストでの変更」を知る作りなので、popup で Vault を解除しても
 * SW が知らず、アイコンがロックのまま・インラインメニューが「Unlock」のままになる。
 *
 * ここでは **polyfill を唯一のディスパッチャ**にする:
 * - `onChanged` の `addListener` / `removeListener` / `hasListener` を横取りして自前の Set に持つ
 *   （拡張のリスナーはネイティブに登録しない）
 * - 書き込み側（`set` / `remove` / `clear`）をラップし、完了後に自コンテキストへ配り、
 *   `chrome.runtime.sendMessage({ __nemo: 'storage-changed', area, keys, type })` で他コンテキストへ配る。
 *   **値は載せない**（受け側が `get` し直す。`storage.session` の中身を読めないコンテキストへ運ばない）
 * - ネイティブの `chrome.storage.onChanged` には**転送用リスナーを 1 本だけ**登録し、鳴った分も自前リスナーへ転送する
 * - 自己配信・native 転送・ブロードキャストの 3 経路は**件数を突き合わせる台帳**で重複排除する:
 *   先に来たものを配って台帳に 1 件積み、後から来た同一内容は未消化 1 件だけ消して捨てる。
 *   「内容一致で捨てる」ではないので、同じ値の N 連続書き込みは N 回配られる。
 *   台帳への登録は**受け取った同期の時点**で行い、配信はそのあと（`get` を伴う経路は `get` 完了後）
 *
 * 既知の仕様差分: `oldValue` は付けない。`remove` は実在するキーだけで鳴らす（Chrome と同じ）。
 *
 * 配る経路は 3 つ（どれもこの 1 つの関数を使う）:
 * - 拡張ページのトップフレーム: `src/preload/extension-shim.ts`
 * - 拡張の service worker: 同じ `src/preload/extension-shim.ts`（`type: 'service-worker'` で登録）
 * - DevTools の中の拡張 frame: `src/main/devtools-shim.ts`（CDP で注入）
 *
 * **この関数はそのまま文字列化して送る**ので、外側の変数・import を参照しない。
 * 戻り値は検査用（台帳・配信をユニットテストから直接叩く）。
 */
export function installStorageOnChangedPolyfill() {
  'use strict'
  const scope = /** @type {{ chrome?: Record<string, any> }} */ (globalThis)
  const chrome = scope.chrome
  if (!chrome || !chrome.storage || !chrome.runtime) return null
  const storage = chrome.storage
  // 二重 install の印は **area オブジェクト**に置く。ece の preload が `chrome.storage` を `{...base}` で
  // 作り直すので、`storage` 自身に付けた印は差し替え後から見えない（area オブジェクトは引き継がれる）
  const marker = storage.local ?? storage.session
  if (marker?.__nemoOnChangedPolyfill) return marker.__nemoOnChangedPolyfill

  /** 台帳の窓。IPC 往復（数 ms〜数十 ms）の数十倍を取る。超えた項目は独立したイベントとして扱う。 */
  const WINDOW_MS = 1500
  const AREAS = ['local', 'session', 'sync', 'managed']

  /** @type {Set<Function>} */
  const globalListeners = new Set()
  /** @type {Record<string, Set<Function>>} */
  const areaListeners = {}
  /** @type {{ sig: string, at: number, source: string }[]} */
  const ledger = []

  /** 台帳の照合キー。キーごとに save(+) / remove(-) を付ける。 */
  /** @param {string} area @param {Record<string, any>} changes */
  const signature = (area, changes) =>
    `${area}|${Object.keys(changes)
      .map((key) => `${key}${'newValue' in changes[key] ? '+' : '-'}`)
      .sort()
      .join(',')}`

  /**
   * 台帳に突き合わせる。**別の経路**（self / native / broadcast）から来た同じ内容の未消化項目が
   * あれば消して `true`（＝もう配った）、無ければ積んで `false`（＝これを配る）。**同期で呼ぶ**。
   * 突き合わせるのは **native と組になるもの**（native ↔ self、native ↔ broadcast）だけ:
   * - 同じ経路どうしは突き合わせない: SW のように native が鳴かないコンテキストで自分の書き込みが
   *   積んだ項目を、次の同値の書き込みが消してしまう（2 回目が配られない）のを防ぐ
   * - self ↔ broadcast も突き合わせない: 自分の broadcast は自分に返ってこないので、この 2 つが同じ内容で
   *   並ぶのは「別コンテキストが同じキーを書いた」ときだけ。消すと popup の解除が SW に届かない再発になる
   */
  /** @param {string} sig @param {string} source */
  function ledgerTake(sig, source) {
    const now = Date.now()
    for (let i = ledger.length - 1; i >= 0; i -= 1) {
      if (now - ledger[i].at > WINDOW_MS) ledger.splice(i, 1)
    }
    const index = ledger.findIndex(
      (entry) =>
        entry.sig === sig && entry.source !== source && (entry.source === 'native' || source === 'native')
    )
    if (index >= 0) {
      ledger.splice(index, 1)
      return true
    }
    ledger.push({ sig, at: now, source })
    return false
  }

  /** @param {string} area @param {Record<string, any>} changes */
  function dispatch(area, changes) {
    const call = (/** @type {Function} */ listener) => {
      try {
        listener(changes, area)
      } catch (error) {
        console.error('[nemo] storage.onChanged listener threw', error)
      }
    }
    for (const listener of globalListeners) call(listener)
    for (const listener of areaListeners[area] ?? []) call(listener)
  }

  /** `chrome.events.Event` の形をした自前イベント。 */
  const makeEvent = (/** @type {Set<Function>} */ set) => ({
    /** @param {Function} fn */
    addListener(fn) {
      set.add(fn)
    },
    /** @param {Function} fn */
    removeListener(fn) {
      set.delete(fn)
    },
    /** @param {Function} fn */
    hasListener(fn) {
      return set.has(fn)
    },
    hasListeners() {
      return set.size > 0
    }
  })

  const nativeOnChanged = storage.onChanged
  Object.defineProperty(storage, 'onChanged', {
    value: makeEvent(globalListeners),
    enumerable: true,
    configurable: true
  })
  // ネイティブが鳴った分も自前リスナーへ（転送用はこの 1 本だけ。area 別には付けない）
  try {
    nativeOnChanged?.addListener?.(
      (/** @type {Record<string, any>} */ changes, /** @type {string} */ area) => {
        /** @type {Record<string, any>} */
        const stripped = {}
        for (const key of Object.keys(changes ?? {})) {
          stripped[key] = 'newValue' in changes[key] ? { newValue: changes[key].newValue } : {}
        }
        if (ledgerTake(signature(area, stripped), 'native')) return
        dispatch(area, stripped)
      }
    )
  } catch (error) {
    console.error('[nemo] native storage.onChanged に転送用リスナーを付けられない', error)
  }

  /** @param {string} area @param {string[]} keys @param {'save' | 'remove'} type */
  const broadcast = (area, keys, type) => {
    try {
      chrome.runtime.sendMessage({ __nemo: 'storage-changed', area, keys, type }, () => {
        // 受け手が居ない（拡張ページが開いていない）のは常態。lastError を読んで握る
        void chrome.runtime.lastError
      })
    } catch {
      /* SW の終了間際など。通知は落としてよい（起きた SW は storage を読み直す） */
    }
  }

  /** 自コンテキストの書き込み完了時。同期で台帳に積み、配って、他コンテキストへ投げる。 */
  /** @param {string} area @param {Record<string, any>} changes */
  const afterWrite = (area, changes) => {
    const keys = Object.keys(changes)
    if (keys.length === 0) return
    const type = 'newValue' in changes[keys[0]] ? 'save' : 'remove'
    if (!ledgerTake(signature(area, changes), 'self')) dispatch(area, changes)
    broadcast(area, keys, type)
  }

  /**
   * callback 形式と Promise 形式の両方を通し、完了時に `done()` を呼ぶ。
   * @param {Function} original @param {any[]} args @param {Function | undefined} callback @param {() => void} done
   */
  const wrapCall = (original, args, callback, done) => {
    if (typeof callback === 'function') {
      return original(...args, (/** @type {any[]} */ ...cbArgs) => {
        // 書けていない（quota 超過等で lastError が立つ）なら配らない（Promise 形式の reject と揃える）
        if (!chrome.runtime.lastError) done()
        callback(...cbArgs)
      })
    }
    const result = original(...args)
    if (result && typeof result.then === 'function') {
      return result.then((/** @type {any} */ value) => {
        done()
        return value
      })
    }
    done()
    return result
  }

  /** @param {any} area @param {any} keys @returns {Promise<Record<string, any>>} */
  const getAsync = (area, keys) =>
    new Promise((resolve) => {
      try {
        area.get(keys, (/** @type {any} */ items) => {
          void chrome.runtime.lastError
          resolve(items ?? {})
        })
      } catch {
        resolve({})
      }
    })

  // 他コンテキストからの通知。台帳は受け取った同期の時点で突き合わせ、配るのは get のあと
  /** @param {any} message */
  const onBroadcast = (message) => {
    if (!message || message.__nemo !== 'storage-changed') return false
    const area = storage[message.area]
    const keys = Array.isArray(message.keys) ? message.keys : []
    if (!area || keys.length === 0) return false
    /** @type {Record<string, any>} */
    const expected = {}
    for (const key of keys) expected[key] = message.type === 'save' ? { newValue: undefined } : {}
    if (ledgerTake(signature(message.area, expected), 'broadcast')) return false
    void getAsync(area, keys).then((items) => {
      // changes は必ず get の結果から作る（type はヒントに過ぎない。save なのに無ければ remove 扱い）
      /** @type {Record<string, any>} */
      const changes = {}
      for (const key of keys) changes[key] = key in items ? { newValue: items[key] } : {}
      dispatch(message.area, changes)
    })
    return false
  }
  try {
    chrome.runtime.onMessage.addListener(onBroadcast)
  } catch (error) {
    console.error('[nemo] runtime.onMessage に storage 通知の受け口を付けられない', error)
  }

  // area ごとのラップ。1 つの area で失敗しても残りを巻き込まない（'use strict' なので代入の失敗は throw する）
  for (const name of AREAS) {
    try {
      const area = storage[name]
      if (!area || typeof area.set !== 'function') continue
      // `sync` / `managed` は `local` と同じオブジェクトになりうる（ece の差し替え）。最初の名前で固定する
      if (area.__nemoStorageWrapped) continue
      Object.defineProperty(area, '__nemoStorageWrapped', { value: name })
      const areaName = name
      areaListeners[areaName] = new Set()
      Object.defineProperty(area, 'onChanged', {
        value: makeEvent(areaListeners[areaName]),
        enumerable: true,
        configurable: true
      })

      const originalSet = area.set.bind(area)
      const originalRemove = area.remove.bind(area)
      const originalClear = area.clear.bind(area)

      /** @param {Record<string, any>} items @param {Function} [callback] */
      area.set = function set(items, callback) {
        /** @type {Record<string, any>} */
        const changes = {}
        for (const key of Object.keys(items ?? {})) changes[key] = { newValue: items[key] }
        return wrapCall(originalSet, [items], callback, () => afterWrite(areaName, changes))
      }

      /** @param {string | string[]} keys @param {Function} [callback] */
      area.remove = function remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys]
        // 実在するキーだけで鳴らす（Chrome も存在しないキーの remove では鳴らない。台帳の照合が native と揃う）。
        // **`get` を待たずに同じターンで削除を出す**: storage の操作は FIFO なので snapshot は削除前の状態を返し、
        // `remove('a')` 直後の `set({a})` の順序も保たれる（await すると set が先に処理されて値が消える）
        const snapshot = getAsync(area, list)
        return wrapCall(
          originalRemove,
          [keys],
          callback,
          () =>
            void snapshot.then((existing) => {
              /** @type {Record<string, any>} */
              const changes = {}
              for (const key of list) if (key in existing) changes[key] = {}
              afterWrite(areaName, changes)
            })
        )
      }

      /** @param {Function} [callback] */
      area.clear = function clear(callback) {
        const snapshot = getAsync(area, null)
        return wrapCall(
          originalClear,
          [],
          callback,
          () =>
            void snapshot.then((existing) => {
              /** @type {Record<string, any>} */
              const changes = {}
              for (const key of Object.keys(existing)) changes[key] = {}
              afterWrite(areaName, changes)
            })
        )
      }
    } catch (error) {
      console.error(`[nemo] chrome.storage.${name} のラップに失敗した`, error)
    }
  }

  const api = { ledgerTake, signature, dispatch, afterWrite, onBroadcast, WINDOW_MS }
  if (marker) Object.defineProperty(marker, '__nemoOnChangedPolyfill', { value: api })
  return api
}

/** CDP の `Page.addScriptToEvaluateOnNewDocument` に渡す形。 */
export const CHROME_STORAGE_ONCHANGED_SOURCE = `(${installStorageOnChangedPolyfill.toString()})();`
