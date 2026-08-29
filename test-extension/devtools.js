/**
 * devtools_page。DevTools を開いたときに 1 枚パネルを足す。
 *
 * パネルの中身（panel.html）は DevTools の中の `chrome-extension://` iframe として描画される。
 * Nemo の `chrome.*` 補完（`chrome.debugger` の空実装）が**この frame にも届くこと**を
 * smoke で見るためのもの（GraphQL Network Inspector が真っ白になった経路そのもの）。
 */
chrome.devtools.panels.create('Nemo CI', '', 'panel.html', () => {})
