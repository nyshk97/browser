// @ts-check
/**
 * キーバインド定義。
 *
 * 既定値は Arc を踏襲する。設定ファイル（`settings.json` の `keybindings`）で
 * コマンド単位に上書きできる。**上書きは検証してから採用する**
 * （不正なアクセラレータを Menu に渡すと Electron が起動時に投げる）。
 *
 * Electron 非依存にして `scripts/keybindings.test.mjs` から直接テストする。
 */

/**
 * @typedef {object} CommandDef
 * @property {string} id
 * @property {string} label メニューに出す日本語ラベル
 * @property {string} accelerator 既定のアクセラレータ
 * @property {'file'|'edit'|'view'|'navigate'|'tab'|'window'|'develop'} menu
 * @property {boolean} [needsTab] アクティブタブが要るコマンド
 */

/** @type {CommandDef[]} */
export const COMMANDS = [
  // File
  { id: 'command-bar', label: 'コマンドバー', accelerator: 'CmdOrCtrl+T', menu: 'file' },
  { id: 'new-window', label: '新規ウィンドウ', accelerator: 'CmdOrCtrl+N', menu: 'file' },
  {
    id: 'new-private-window',
    label: 'シークレットウィンドウ',
    accelerator: 'CmdOrCtrl+Shift+P',
    menu: 'file'
  },
  { id: 'close-tab', label: 'タブを閉じる', accelerator: 'CmdOrCtrl+W', menu: 'file', needsTab: true },
  { id: 'close-window', label: 'ウィンドウを閉じる', accelerator: 'CmdOrCtrl+Shift+W', menu: 'file' },
  { id: 'reopen-tab', label: '閉じたタブを開き直す', accelerator: 'CmdOrCtrl+Shift+T', menu: 'file' },

  // Edit
  { id: 'find', label: 'ページ内を検索', accelerator: 'CmdOrCtrl+F', menu: 'edit', needsTab: true },
  { id: 'find-next', label: '次を検索', accelerator: 'CmdOrCtrl+G', menu: 'edit', needsTab: true },
  { id: 'find-previous', label: '前を検索', accelerator: 'CmdOrCtrl+Shift+G', menu: 'edit', needsTab: true },

  // View
  { id: 'toggle-sidebar', label: 'サイドバーの表示', accelerator: 'CmdOrCtrl+S', menu: 'view' },
  { id: 'reload', label: '再読み込み', accelerator: 'CmdOrCtrl+R', menu: 'view', needsTab: true },
  {
    id: 'reload-ignoring-cache',
    label: 'キャッシュを無視して再読み込み',
    accelerator: 'CmdOrCtrl+Shift+R',
    menu: 'view',
    needsTab: true
  },
  { id: 'zoom-in', label: '拡大', accelerator: 'CmdOrCtrl+Plus', menu: 'view', needsTab: true },
  { id: 'zoom-out', label: '縮小', accelerator: 'CmdOrCtrl+-', menu: 'view', needsTab: true },
  { id: 'zoom-reset', label: '等倍に戻す', accelerator: 'CmdOrCtrl+0', menu: 'view', needsTab: true },
  { id: 'toggle-fullscreen', label: 'フルスクリーン', accelerator: 'Control+Command+F', menu: 'view' },

  // Navigate
  { id: 'focus-address', label: 'アドレスを編集', accelerator: 'CmdOrCtrl+L', menu: 'navigate' },
  { id: 'go-back', label: '戻る', accelerator: 'CmdOrCtrl+[', menu: 'navigate', needsTab: true },
  { id: 'go-forward', label: '進む', accelerator: 'CmdOrCtrl+]', menu: 'navigate', needsTab: true },
  {
    id: 'copy-url',
    label: 'URL をコピー',
    accelerator: 'CmdOrCtrl+Shift+C',
    menu: 'navigate',
    needsTab: true
  },

  // Tab
  { id: 'pin-tab', label: 'ピン留め / 解除', accelerator: 'CmdOrCtrl+D', menu: 'tab', needsTab: true },
  { id: 'next-tab', label: '次のタブ', accelerator: 'Control+Tab', menu: 'tab' },
  { id: 'previous-tab', label: '前のタブ', accelerator: 'Control+Shift+Tab', menu: 'tab' },
  {
    id: 'switch-tab',
    label: '直近のタブへ切り替え',
    accelerator: 'Control+M',
    menu: 'tab'
  },
  {
    id: 'move-tab-to-new-window',
    label: 'タブを新規ウィンドウへ',
    accelerator: 'CmdOrCtrl+Shift+N',
    menu: 'tab',
    needsTab: true
  },
  {
    id: 'promote-peek',
    label: 'メインウィンドウで開く',
    accelerator: 'CmdOrCtrl+O',
    menu: 'tab'
  },

  // Window
  { id: 'show-downloads', label: 'ダウンロード', accelerator: 'CmdOrCtrl+Shift+J', menu: 'window' },
  { id: 'show-library', label: '履歴とアーカイブ', accelerator: 'CmdOrCtrl+Y', menu: 'window' },
  { id: 'show-settings', label: '設定', accelerator: 'CmdOrCtrl+,', menu: 'window' },

  // Develop
  {
    id: 'toggle-devtools',
    label: 'デベロッパーツール',
    accelerator: 'CmdOrCtrl+Alt+I',
    menu: 'develop',
    needsTab: true
  },
  {
    id: 'toggle-ui-devtools',
    label: 'ブラウザ UI のデベロッパーツール',
    accelerator: 'CmdOrCtrl+Alt+Shift+I',
    menu: 'develop'
  }
]

/**
 * `⌘1`〜`⌘9` = Favorites の N 番目（`messages` → `tools` の通し番号）。
 * コマンド表には載せず、番号でまとめて扱う（ユーザーの再割り当ては不可）。
 * 旧 `select-tab-N`（一時タブの N 番目）は廃止。設定に残っていても `unknown_command` で弾かれる。
 */
export const SELECT_FAVORITE_ACCELERATORS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => ({
  id: `select-favorite-${n}`,
  accelerator: `CmdOrCtrl+${n}`,
  index: Number(n)
}))

const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id))

/** Electron のアクセラレータとして受け付ける形（過度に厳しくせず、明らかな壊れだけ弾く）。 */
const MODIFIERS = new Set([
  'Command',
  'Cmd',
  'Control',
  'Ctrl',
  'CommandOrControl',
  'CmdOrCtrl',
  'Alt',
  'Option',
  'AltGr',
  'Shift',
  'Super',
  'Meta'
])

/**
 * `CmdOrCtrl+Shift+T` のような文字列を検査する。
 * @param {string} accelerator
 * @returns {boolean}
 */
export function isValidAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return false
  const parts = accelerator.split('+')
  if (parts.length === 0 || parts.length > 5) return false
  const key = parts[parts.length - 1]
  if (!key || key.length === 0) return false
  // 最後のキー以外はすべて修飾キーであること
  for (const part of parts.slice(0, -1)) {
    if (!MODIFIERS.has(part)) return false
  }
  if (MODIFIERS.has(key)) return false
  // キー本体に空白・記号の並びが混ざっていないこと
  return /^[A-Za-z0-9]$|^F[0-9]{1,2}$|^(Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen)$|^[-=[\];',./`\\]$/.test(
    key
  )
}

/**
 * 既定値に設定ファイルの上書きを重ねて、実際に使うキーバインド表を作る。
 *
 * 不正な上書きは**採用せず理由を返す**（黙って既定に戻すと、
 * 「設定したのに効かない」の原因が分からなくなる）。
 *
 * @param {Record<string, string>} overrides
 * @returns {{ bindings: Record<string, string>, problems: {command: string, accelerator: string, reason: string}[] }}
 */
export function resolveKeybindings(overrides = {}) {
  /** @type {Record<string, string>} */
  const bindings = {}
  for (const command of COMMANDS) bindings[command.id] = command.accelerator

  /** @type {{command: string, accelerator: string, reason: string}[]} */
  const problems = []

  for (const [command, accelerator] of Object.entries(overrides ?? {})) {
    if (!COMMAND_IDS.has(command)) {
      problems.push({ command, accelerator, reason: 'unknown_command' })
      continue
    }
    if (accelerator === '') {
      // 空文字は「割り当てなし」。メニュー項目は残すがアクセラレータを外す。
      bindings[command] = ''
      continue
    }
    if (!isValidAccelerator(accelerator)) {
      problems.push({ command, accelerator, reason: 'invalid_accelerator' })
      continue
    }
    bindings[command] = accelerator
  }

  // 重複は後勝ちにせず**両方とも既定に戻す**。
  // 片方だけ生かすと、どちらが効くかが設定ファイルの記述順に依存して分かりにくい。
  /** @type {Map<string, string[]>} */
  const byAccelerator = new Map()
  for (const [command, accelerator] of Object.entries(bindings)) {
    if (!accelerator) continue
    const list = byAccelerator.get(accelerator) ?? []
    list.push(command)
    byAccelerator.set(accelerator, list)
  }
  for (const [accelerator, commands] of byAccelerator) {
    if (commands.length < 2) continue
    for (const command of commands) {
      const def = COMMANDS.find((c) => c.id === command)
      if (def) bindings[command] = def.accelerator
      problems.push({ command, accelerator, reason: 'duplicate_accelerator' })
    }
  }

  return { bindings, problems }
}

/**
 * アクセラレータの修飾キーのうち、「押しっぱなしで循環し、**離したら確定**」の
 * 判定に使うもの（⌘Tab と同じ操作感を作る）。
 *
 * **Shift は含めない**。`Control+Shift+M` のような割り当てのとき、
 * Shift を先に離しただけで確定してしまい「⇧ を足して逆回し」ができなくなる。
 * 押しっぱなしの土台になるのは ⌃ / ⌘ / ⌥ の側なので、そこだけを見る。
 *
 * 返す名前は `KeyboardEvent.key`（Electron の `before-input-event` の `input.key`）に合わせる。
 *
 * @param {string} accelerator
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]} 離したら確定する修飾キー。無ければ空配列（＝押しっぱなしにできない割り当て）
 */
export function holdModifiersFor(accelerator, platform = process.platform) {
  if (typeof accelerator !== 'string' || accelerator === '') return []
  /** @type {string[]} */
  const keys = []
  for (const part of accelerator.split('+').slice(0, -1)) {
    let key = null
    if (part === 'Command' || part === 'Cmd' || part === 'Super' || part === 'Meta') key = 'Meta'
    else if (part === 'Control' || part === 'Ctrl') key = 'Control'
    else if (part === 'CommandOrControl' || part === 'CmdOrCtrl')
      key = platform === 'darwin' ? 'Meta' : 'Control'
    else if (part === 'Alt' || part === 'Option' || part === 'AltGr') key = 'Alt'
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}
