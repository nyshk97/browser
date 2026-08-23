/**
 * popup。
 * 「開いた」だけでなく「popup から chrome.* が使えた」ことまで見えるようにする
 * （Bitwarden で踏んだ「popup がスピナーのまま止まる」は、まさにここが動かない状態）。
 */
void (async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  document.getElementById('tab').textContent = tabs[0]?.url ?? '(no tab)'
  await chrome.storage.local.set({ __nemo_ci_popup_opened__: Date.now() })
  document.getElementById('ready').textContent = 'popup-ready'
})()
