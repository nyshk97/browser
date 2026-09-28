// @ts-check
/**
 * Claude in Nemo（Claude Code から Nemo を操作する口）のツール定義。**正本はここ 1 か所**。
 *
 * - Nemo の main（`src/main/agent/`）がツールの実装とこの定義の一致をテストする
 * - ブリッジ（`src/bridge/nemo-mcp-bridge.mjs`）はこのファイルを**そのまま import** して
 *   `tools/list` を静的に返す（Nemo が起動していなくても一覧は返せる）
 *
 * **このファイルは何も import しない**（パッケージ版では `Contents/Resources/` にブリッジと並べて置き、
 * ユーザーの node がそのまま読む）。
 *
 * 語彙は Claude in Chrome に寄せる（モデルの慣れを流用する）。サーバ名は `nemo`（`mcp__nemo__*`）。
 */

/**
 * ブリッジ ⇔ Nemo のプロトコル版。**既存ツールの引数を壊す変更のときだけ上げる**
 * （ツールや省略可能な引数を足すだけなら上げない）。版が合わなければ Nemo は
 * 「Claude Code を再起動してください」を返す。
 */
export const AGENT_PROTOCOL_VERSION = 1

/** MCP のサーバ名（`claude mcp add` の名前と揃える）。 */
export const AGENT_SERVER_NAME = 'nemo'

/**
 * initialize の instructions（Claude Code は 2048 文字で切る）。
 */
export const AGENT_INSTRUCTIONS = [
  'Nemo browser automation. You operate a dedicated Nemo window ("Claude — <project>") that belongs to this Claude Code session;',
  "the user's other Nemo windows are never reachable. The window is created on first use and closed when this session ends.",
  'Start with tabs_context to get tab IDs. Every page tool needs a tabId. Tab IDs become invalid when Nemo restarts: call tabs_context again.',
  'Screenshots are JPEG, scaled; pass coordinates in the screenshot pixel space.',
  'Prefer read_page (refs) + computer with ref, or form_input, over guessing coordinates.',
  'When a login, 2FA, CAPTCHA or any human decision is needed, call request_user_action with a short message, then tell the user in chat and stop.',
  "While it is the user's turn, input tools are refused. When the user says they are done, call resume and re-check the page with a screenshot.",
  'JavaScript dialogs (alert/confirm/prompt) are held for you: answer with handle_dialog.',
  'Only http(s) pages can be opened. Downloads are saved to ~/Downloads/Nemo Agent without asking.'
].join(' ')

/** @typedef {{ name: string, description: string, inputSchema: Record<string, unknown>, readOnly?: boolean }} AgentToolDef */

const tabId = { type: 'string', description: 'Tab ID from tabs_context.' }

/** @type {AgentToolDef[]} */
export const AGENT_TOOLS = [
  {
    name: 'tabs_context',
    description:
      "List the tabs in this session's Nemo window (creates the window with one blank tab if it does not exist yet). Returns tabId, url, title, which tab is active, whether it is the user's turn, and pending dialogs.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'tabs_create',
    description:
      "Open a new tab in this session's Nemo window and return its tabId. If the user closed the window, this re-creates it.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional http(s) URL to open.' } },
      additionalProperties: false
    }
  },
  {
    name: 'tabs_close',
    description: 'Close a tab of this session.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'], additionalProperties: false }
  },
  {
    name: 'navigate',
    description:
      'Navigate a tab to a URL (http/https only; a bare host gets https://), or go "back" / "forward". Waits for the load. If the page asks "Leave site?" the navigation stops unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        url: { type: 'string', description: 'URL, or "back" / "forward".' },
        force: { type: 'boolean', description: 'Leave the page even if it has unsaved changes.' }
      },
      required: ['tabId', 'url'],
      additionalProperties: false
    }
  },
  {
    name: 'computer',
    description: [
      'Mouse / keyboard / screenshot on a tab, without taking focus from the user.',
      'Actions: screenshot, left_click, right_click, double_click, triple_click, hover, type, key, scroll, scroll_to, wait, left_click_drag, zoom.',
      'Coordinates are in screenshot pixels. For clicks you can pass ref (from read_page) instead of coordinate.',
      'key: space separated keys or combos, e.g. "Enter", "Tab Tab", "cmd+a", "shift+ArrowDown". Clipboard shortcuts (cmd+c/x/v) are not available.',
      'scroll: scroll_direction up/down/left/right and scroll_amount (1-10) at coordinate.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        action: {
          type: 'string',
          enum: [
            'screenshot',
            'left_click',
            'right_click',
            'double_click',
            'triple_click',
            'hover',
            'type',
            'key',
            'scroll',
            'scroll_to',
            'wait',
            'left_click_drag',
            'zoom'
          ]
        },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        ref: { type: 'string', description: 'Element ref from read_page (e.g. "ref_12").' },
        text: { type: 'string', description: 'Text for type, or keys for key.' },
        modifiers: { type: 'string', description: 'Modifier keys for clicks, e.g. "shift", "cmd+shift".' },
        repeat: { type: 'number', minimum: 1, maximum: 100 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', minimum: 1, maximum: 10 },
        duration: { type: 'number', minimum: 0, maximum: 10, description: 'Seconds for wait.' },
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'zoom: [x0, y0, x1, y1] in screenshot pixels.'
        }
      },
      required: ['tabId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'read_page',
    description:
      'Accessibility-like tree of the page with refs (ref_N) for elements. filter "interactive" (default) lists only controls and links; "all" includes text. Password / one-time-code / card values are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        filter: { type: 'string', enum: ['interactive', 'all'] },
        ref_id: { type: 'string', description: 'Only the subtree of this ref.' },
        depth: { type: 'number', minimum: 1, maximum: 40 },
        max_chars: { type: 'number', minimum: 1000, maximum: 100000 }
      },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'get_page_text',
    description: 'Visible text of the page (main content first). Secrets are redacted.',
    inputSchema: {
      type: 'object',
      properties: { tabId, max_chars: { type: 'number', minimum: 1000, maximum: 100000 } },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'form_input',
    description:
      'Set the value of a form control by ref (text, textarea, select option value or label, checkbox/radio true/false, date, range, number). Fires input and change events.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        ref: { type: 'string' },
        value: { type: ['string', 'number', 'boolean'] }
      },
      required: ['tabId', 'ref', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'javascript_tool',
    description:
      'Run JavaScript in the page (main world) and return the result (JSON-serialisable, awaited if a promise). Refused on a page where the user just typed a password.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        text: { type: 'string', description: 'Expression or statements; the last value is returned.' }
      },
      required: ['tabId', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'read_console_messages',
    description:
      'Console messages and uncaught errors of the tab, recorded from the first call on (call once to start recording).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        onlyErrors: { type: 'boolean' },
        pattern: { type: 'string', description: 'Regular expression filter.' },
        clear: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 500 }
      },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'read_network_requests',
    description:
      'Network requests of the tab (URL, method, status, type; no bodies or headers), recorded from the first call on.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        urlPattern: { type: 'string', description: 'Substring filter.' },
        clear: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 500 }
      },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'handle_dialog',
    description: 'Answer a pending JavaScript dialog (alert / confirm / prompt) on the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        accept: { type: 'boolean' },
        promptText: { type: 'string' }
      },
      required: ['tabId', 'accept'],
      additionalProperties: false
    }
  },
  {
    name: 'file_upload',
    description:
      'Attach local files (absolute paths readable by this session, 10MB total) to a file input by ref. The files are read by the Claude Code side, not by Nemo.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        ref: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1 }
      },
      required: ['tabId', 'ref', 'paths'],
      additionalProperties: false
    }
  },
  {
    name: 'resize_window',
    description: "Resize this session's Nemo window (content size in CSS pixels).",
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', minimum: 400, maximum: 3000 },
        height: { type: 'number', minimum: 300, maximum: 2000 }
      },
      required: ['width', 'height'],
      additionalProperties: false
    }
  },
  {
    name: 'request_user_action',
    description:
      'Hand the tab to the user (login, 2FA, CAPTCHA, payment, any decision). Shows your message in the Nemo window and makes it the user\'s turn (input tools are refused until you call resume). After calling it, tell the user in chat and stop; they reply "done" in chat when finished, then call resume.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        message: { type: 'string', description: 'Short instruction for the user (Japanese).' }
      },
      required: ['tabId', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'resume',
    description:
      'Take the turn back after the user said they finished (in chat). Call screenshot afterwards to see what the user did.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

/** 名前 → 定義。 */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name)
