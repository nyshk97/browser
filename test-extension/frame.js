/**
 * 公開している拡張ページ（`web_accessible_resources`）で走るスクリプト。
 *
 * 親（content script）へ nonce を返して「**拡張ページのスクリプトが実際に走った**」ことを示す。
 * iframe の `load` はエラードキュメントでも発火しうるので、読めたことの証明にはならない。
 */
;(() => {
  const nonce = new URLSearchParams(window.location.search).get('nonce')
  if (nonce) window.parent.postMessage({ nemoWar: nonce }, '*')
})()
