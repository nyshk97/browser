// @ts-check
/**
 * Claude の窓の状態バーに出す「今やっていること」の文言（Claude in Nemo）。
 *
 * ツール名と引数から Nemo が作る（Claude が書いた文は出さない。ページに誘導された文言を帯に載せないため）。
 * 出すのは操作の種類と、navigate の行き先のホストだけ。Electron に依存しない（`scripts/agent-activity.test.mjs`）。
 */

/** @type {Record<string, string>} */
const COMPUTER = {
  screenshot: 'スクリーンショット',
  left_click: 'クリック',
  right_click: 'クリック',
  double_click: 'クリック',
  triple_click: 'クリック',
  hover: 'カーソルを合わせています',
  type: '入力しています',
  key: 'キー入力',
  scroll: 'スクロール',
  scroll_to: 'スクロール',
  wait: '待っています',
  left_click_drag: 'ドラッグ',
  zoom: '拡大して確認しています'
}

/** @type {Record<string, string>} */
const TOOLS = {
  tabs_context: 'タブを確認しています',
  tabs_create: 'タブを開いています',
  tabs_close: 'タブを閉じています',
  read_page: 'ページを読んでいます',
  get_page_text: 'ページを読んでいます',
  form_input: 'フォームに入力しています',
  javascript_tool: 'JavaScript を実行しています',
  read_console_messages: 'コンソールを確認しています',
  read_network_requests: '通信を確認しています',
  handle_dialog: 'ダイアログに答えています',
  file_upload: 'ファイルを添付しています',
  resize_window: 'ウィンドウの大きさを変えています'
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @returns {string | null} 出さないもの（引き継ぎの呼び出し・知らないツール）は null
 */
export function agentActivityLabel(tool, args) {
  if (tool === 'navigate') {
    const url = typeof args['url'] === 'string' ? args['url'] : ''
    if (url === 'back') return '前のページに戻っています'
    if (url === 'forward') return '次のページに進んでいます'
    const host = hostOf(url)
    return host ? `${host} を開いています` : 'ページを開いています'
  }
  if (tool === 'computer') {
    const action = typeof args['action'] === 'string' ? args['action'] : ''
    return COMPUTER[action] ?? '操作しています'
  }
  return TOOLS[tool] ?? null
}

/** 行き先のホスト（scheme を省いた指定も読む。読めなければ null）。長いものは切る。 */
function hostOf(/** @type {string} */ url) {
  if (!url) return null
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`)
    const host = parsed.hostname
    if (!host) return null
    return host.length > 40 ? `${host.slice(0, 39)}…` : host
  } catch {
    return null
  }
}
