/**
 * **公開していない**拡張ページで走るスクリプト（`frame.js` と同じ handshake）。
 *
 * これが親に届いてしまったら、`web_accessible_resources` に無いページまで
 * ページ側から埋め込めているということ。Nemo が `chrome-extension:` のサブフレームを
 * 通す判断は「非公開の resource は Chromium が拒否する」ことに依存しているので、
 * その前提が崩れたらここで気づけるようにする。
 */
;(() => {
  const nonce = new URLSearchParams(window.location.search).get('nonce')
  if (nonce) window.parent.postMessage({ nemoWar: nonce }, '*')
})()
