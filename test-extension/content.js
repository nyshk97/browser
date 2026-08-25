/**
 * content script。
 *
 * - **メインワールドから観測できる印**を DOM に付ける（isolated world の変数は外から見えない）
 * - service worker へ ping を送る（idle 停止からの復帰の確認に使う）
 * - `/war-frame.html` でだけ、拡張ページを iframe で読めるかを試す
 *
 * `all_frames: true` なので iframe にも入る。印にフレームの深さを載せて、
 * トップと iframe の両方に入ったことを区別できるようにする。
 */
;(() => {
  const depth = window === window.top ? 'top' : 'frame'
  document.documentElement.setAttribute('data-nemo-ci', depth)
  void chrome.runtime.sendMessage({ type: 'ping' }).then(
    (response) => {
      document.documentElement.setAttribute('data-nemo-ci-ping', String(response?.ok === true))
    },
    () => {
      document.documentElement.setAttribute('data-nemo-ci-ping', 'error')
    }
  )

  // 拡張 iframe を挿すのは専用ページのトップフレームだけ。
  // どのページでも挿すと、`/iframe.html` の「content script が iframe にも入る」検査に
  // cross-origin の iframe が混ざって落ちる。
  if (depth === 'top' && window.location.pathname === '/war-frame.html') {
    probeExtensionFrames()
  }

  /**
   * 拡張ページを iframe で読めるかを、**公開 / 非公開の両方**について試す。
   *
   * 判定は `load` ではなく iframe 側からの postMessage（nonce 一致）で行う。
   * `load` はエラードキュメントでも発火しうるので、中身が走ったことの証明にならない。
   *
   * 期待する結果:
   * - `frame.html`（`web_accessible_resources` に載せた）→ `ok`
   * - `private-frame.html`（載せていない）→ `timeout`（Chromium が拒否する）
   */
  function probeExtensionFrames() {
    const probes = [
      { file: 'frame.html', attribute: 'data-nemo-ci-war' },
      { file: 'private-frame.html', attribute: 'data-nemo-ci-war-private' }
    ]
    /** nonce -> 属性名。返ってきた nonce でどちらの iframe かを見分ける。 */
    const pending = new Map()

    window.addEventListener('message', (event) => {
      const nonce = event.data?.nemoWar
      const attribute = typeof nonce === 'string' ? pending.get(nonce) : undefined
      if (!attribute) return
      pending.delete(nonce)
      document.documentElement.setAttribute(attribute, 'ok')
    })

    // 2 つは**並行して**待つ。非公開側の timeout を待つあいだ公開側の判定を止めない。
    for (const { file, attribute } of probes) {
      const nonce = crypto.randomUUID()
      pending.set(nonce, attribute)
      document.documentElement.setAttribute(attribute, 'pending')

      const resourceUrl = chrome.runtime.getURL(file)
      if (file === 'frame.html') {
        // `use_dynamic_url: true` だとホストが拡張 ID ではなく UUID になる。
        // ホストで allowlist する実装に戻っていないかを検証側から見るために残す。
        document.documentElement.setAttribute('data-nemo-ci-war-host', new URL(resourceUrl).hostname)
      }

      const frame = document.createElement('iframe')
      frame.src = `${resourceUrl}?nonce=${encodeURIComponent(nonce)}`
      document.body.appendChild(frame)

      setTimeout(() => {
        if (!pending.has(nonce)) return
        pending.delete(nonce)
        document.documentElement.setAttribute(attribute, 'timeout')
      }, 5000)
    }
  }
})()
