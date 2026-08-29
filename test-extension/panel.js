/**
 * DevTools パネルの frame から見えた chrome.* を DOM に書く（CDP で読む）。
 *
 * - `chrome.debugger`（Nemo の空実装）が生えているか
 * - `chrome.webRequest.onBeforeRequest` を `{ tabId }` で絞った listener に、
 *   inspected tab のリクエストが届くか（Electron は `tabId: -1` で流すので、Nemo が filter から
 *   `tabId` を外していないと**一度も発火しない**）
 */
;(() => {
  const info = {
    debugger: typeof chrome.debugger,
    onEvent: typeof chrome.debugger?.onEvent?.addListener,
    runtimeId: chrome.runtime?.id ?? null,
    devtools: typeof chrome.devtools
  }
  try {
    chrome.debugger?.onEvent?.addListener(() => {})
    info.addListenerOk = true
  } catch (error) {
    info.addListenerOk = false
    info.error = String(error)
  }
  document.getElementById('panel-apis').textContent = JSON.stringify(info)

  const seen = []
  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        seen.push(`${details.method} ${details.url}`)
        document.getElementById('panel-webrequest').textContent = JSON.stringify(seen)
      },
      { urls: ['<all_urls>'], tabId: chrome.devtools.inspectedWindow.tabId },
      ['requestBody']
    )
    document.getElementById('panel-webrequest').textContent = '[]'
  } catch (error) {
    document.getElementById('panel-webrequest').textContent = `ERR ${String(error)}`
  }
})()
