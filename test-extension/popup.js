/**
 * popup。
 * 「開いた」だけでなく「popup から chrome.* が使えた」ことまで見えるようにする
 * （Bitwarden で踏んだ「popup がスピナーのまま止まる」は、まさにここが動かない状態）。
 *
 * さらに **popup ↔ service worker のメッセージング** を4通り試して結果を DOM に出す。
 * Bitwarden のログインは popup が service worker からの通知を待つ作りなので、
 * どれか1つでも通らないと popup が待ちっぱなしになる。
 */
const results = {}

/** 指定時間で諦める（通らない経路を「待ちっぱなし」にしない）。 */
function within(ms, promise) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]).catch(
    (error) => `error: ${error?.message ?? error}`
  )
}

/** 1. popup → service worker（sendResponse で返る） */
async function popupToWorker() {
  const res = await chrome.runtime.sendMessage({ type: 'echo', value: 'nemo' })
  return res?.echo === 'nemo' ? 'ok' : `unexpected: ${JSON.stringify(res)}`
}

/** 2. service worker → popup（chrome.runtime.sendMessage の一斉配信） */
async function workerToPopup() {
  const received = new Promise((resolve) => {
    chrome.runtime.onMessage.addListener(function listener(message) {
      if (message?.type !== 'from-worker') return
      chrome.runtime.onMessage.removeListener(listener)
      resolve(message.value === 'nemo' ? 'ok' : `unexpected: ${JSON.stringify(message)}`)
    })
  })
  await chrome.runtime.sendMessage({ type: 'notify' })
  return received
}

/** 3. 長寿命 port（popup ↔ service worker の双方向） */
async function portRoundTrip() {
  const port = chrome.runtime.connect({ name: 'nemo-ci' })
  const received = new Promise((resolve) => {
    port.onMessage.addListener((message) => {
      resolve(message?.pong === 'nemo' ? 'ok' : `unexpected: ${JSON.stringify(message)}`)
    })
    port.onDisconnect.addListener(() => resolve('disconnected'))
  })
  port.postMessage({ ping: 'nemo' })
  return received
}

/**
 * 5. **誰も応答しないメッセージ**が Chrome と同じように決着すること。
 *
 * Bitwarden の `sendMessageWithResponse` は
 * `new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))` の形で、
 * Chrome は「listener が sendResponse を呼ばずに false を返した」ときも
 * callback を undefined で呼ぶ（`lastError` が立つ）。
 * ここが呼ばれないと、拡張は**待ちっぱなしになる**。
 */
function ignoredWithCallback() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ignored-by-worker' }, () => {
      void chrome.runtime.lastError // 参照して Unchecked にしない
      resolve('ok')
    })
  })
}

/** 6. 同じものの Promise 版（resolve / reject どちらでも決着すればよい） */
function ignoredAsPromise() {
  return chrome.runtime.sendMessage({ type: 'ignored-by-worker' }).then(
    () => 'ok',
    () => 'ok'
  )
}

/**
 * 7. **popup で WebAssembly が使える**こと。
 *
 * Bitwarden は SDK を WASM で持っていて、manifest の
 * `content_security_policy.extension_pages` に `'wasm-unsafe-eval'` を宣言している。
 * この宣言が効いていないと popup で WASM のコンパイルが CSP に弾かれ、
 * SDK の初期化を待っている処理が**永久に終わらない**。
 */
async function wasmInPopup() {
  // 中身が空の最小の valid module（ファイルを置かずにコンパイルだけ試す）
  const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  const module = await WebAssembly.compile(bytes)
  await WebAssembly.instantiate(module, {})
  return 'ok'
}

/** 4. service worker の書き込みが popup の storage.onChanged に届く */
async function storageChanged() {
  const received = new Promise((resolve) => {
    chrome.storage.onChanged.addListener(function listener(changes, area) {
      if (area !== 'local' || !changes['__nemo_ci_touch__']) return
      chrome.storage.onChanged.removeListener(listener)
      resolve('ok')
    })
  })
  await chrome.runtime.sendMessage({ type: 'touch' })
  return received
}

void (async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  document.getElementById('tab').textContent = tabs[0]?.url ?? '(no tab)'
  await chrome.storage.local.set({ __nemo_ci_popup_opened__: Date.now() })
  document.getElementById('ready').textContent = 'popup-ready'

  results.popupToWorker = await within(3000, popupToWorker())
  results.workerToPopup = await within(3000, workerToPopup())
  results.portRoundTrip = await within(3000, portRoundTrip())
  results.storageChanged = await within(3000, storageChanged())
  results.ignoredWithCallback = await within(3000, ignoredWithCallback())
  results.ignoredAsPromise = await within(3000, ignoredAsPromise())
  results.wasmInPopup = await within(3000, wasmInPopup())
  document.getElementById('messaging').textContent = JSON.stringify(results)
})()
