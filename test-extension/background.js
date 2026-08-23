/**
 * CI 用テスト拡張の service worker。
 *
 * 検証側（scripts/verify-ext-smoke.mjs）は
 * - この worker に CDP でつないで chrome.* を直接叩く
 * - content script からのメッセージで worker が起きることを確かめる
 * の2通りで使う。**状態はすべて chrome.storage.local に置く**
 * （worker は idle で止まるので、メモリ上の変数は当てにできない）。
 */

const MARKER_KEY = '__nemo_ci_marker__'

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ [MARKER_KEY]: 'installed' })
})

/** content script からの ping。worker が idle 停止から起きたことの確認に使う。 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ping') {
    void chrome.storage.local.get('__nemo_ci_wakes__').then(async (stored) => {
      const wakes = (stored['__nemo_ci_wakes__'] ?? 0) + 1
      await chrome.storage.local.set({ __nemo_ci_wakes__: wakes, __nemo_ci_last_ping__: Date.now() })
      sendResponse({ ok: true, wakes, frameId: sender.frameId })
    })
    return true // 非同期で応答する
  }
  if (message?.type === 'echo') {
    sendResponse({ ok: true, echo: message.value })
    return false
  }
  return false
})
