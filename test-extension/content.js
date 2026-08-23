/**
 * content script。
 *
 * - **メインワールドから観測できる印**を DOM に付ける（isolated world の変数は外から見えない）
 * - service worker へ ping を送る（idle 停止からの復帰の確認に使う）
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
})()
