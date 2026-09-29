import { clipboard, Menu, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { log } from './log.js'
import { runAutofill } from './autofill/index.js'

/**
 * ページ本体の右クリックメニュー。
 *
 * Electron はページの右クリックに何も出さない（`context-menu` を拾って自分で出す契約）。
 * 項目は**ショートカットで代用できないものだけ**に絞る:
 * 戻る/進む/再読み込み/コピー系はキーで済むので載せない。
 *
 * - 入力欄の上（iframe の中も）: フォーム自動入力
 * - リンクの上: リンクのアドレスをコピー
 * - 画像の上: 名前を付けて画像を保存 / 画像をコピー / 画像アドレスをコピー
 * - 常に: 検証（その座標の要素を DevTools で開く）
 *
 * 「画像を保存」は `downloadURL` で通常のダウンロード経路（`will-download`）に流す。
 * 保存先の確認・一覧への掲載は既存の handler がそのまま面倒を見る。
 */
export function attachContextMenu(
  wc: WebContents,
  window: () => BaseWindow | null,
  /** kypr のポップアップを開く（自動入力の値の元が使えないとき）。 */
  openKypr: () => void,
  /** エージェント窓があるときだけ関数を返す（リンクを Claude のウィンドウで開く）。 */
  openInAgent: () => ((url: string) => void) | undefined = () => undefined
): void {
  wc.on('context-menu', (_event, params) => {
    /*
     * iframe の中の入力欄でも出す（Brevo や Google フォームなどの埋め込みフォーム）。iframe では
     * CDP で isolated world を作って走らせる（`autofill/frame-runner.ts`。メインワールドは使わない）。
     * **メインフレーム直下の iframe まで**（入れ子は親で可視判定ができないので `subFrameRunner` が止める）
     */
    const frame = params.frame
    const autofill =
      isAutofillTarget(params.formControlType) &&
      frame !== null &&
      (frame.parent === null || frame.parent.parent === null)
        ? () => {
            void runAutofill(wc, params.x, params.y, frame).then((result) => {
              // kypr を開けない（ロック中で Touch ID が通らない・未ログイン）・個人情報が無いときは kypr のポップアップへ
              if (
                result.reason === 'kypr-locked' ||
                result.reason === 'kypr-signed-out' ||
                result.reason === 'no-identity'
              ) {
                openKypr()
              }
            })
          }
        : undefined
    const template = buildContextMenuTemplate(wc, params, { autofill, openInAgent: openInAgent() })
    log('context_menu.open', {
      mediaType: params.mediaType,
      link: Boolean(params.linkURL),
      autofill: autofill !== undefined,
      // 自動入力を出さなかった理由を後から追えるように（値は含まない）
      formControlType: params.formControlType,
      editable: params.isEditable,
      frame: params.frame === null ? 'none' : params.frame.parent === null ? 'main' : 'sub',
      items: template.length
    })
    const target = window()
    if (!target || target.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window: target })
  })
}

/** 自動入力を出す入力欄の種類（収集スクリプトが扱うものと揃える）。 */
const AUTOFILL_CONTROLS = new Set([
  'input-text',
  'input-email',
  'input-telephone',
  'input-number',
  'input-url',
  'input-date',
  'select-one',
  'text-area'
])

export function isAutofillTarget(formControlType: string | undefined): boolean {
  return formControlType !== undefined && AUTOFILL_CONTROLS.has(formControlType)
}

export function buildContextMenuTemplate(
  wc: WebContents,
  params: Pick<Electron.ContextMenuParams, 'x' | 'y' | 'mediaType' | 'srcURL' | 'linkURL'>,
  actions: { autofill?: (() => void) | undefined; openInAgent?: ((url: string) => void) | undefined } = {}
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (actions.autofill) {
    template.push({ label: 'フォーム自動入力', click: actions.autofill }, { type: 'separator' })
  }

  // `<a href>` の上（画像リンクなら画像の項目より前に出す。Chrome と同じ並び）
  if (params.linkURL) {
    const href = params.linkURL
    template.push({ label: 'リンクのアドレスをコピー', click: () => clipboard.writeText(href) })
    const openInAgent = actions.openInAgent
    if (openInAgent && /^https?:\/\//.test(href)) {
      template.push({ label: 'Claude のウィンドウで開く', click: () => openInAgent(href) })
    }
    template.push({ type: 'separator' })
  }

  if (params.mediaType === 'image' && params.srcURL) {
    const src = params.srcURL
    template.push(
      {
        label: '名前を付けて画像を保存...',
        click: () => {
          log('context_menu.save_image', {})
          wc.downloadURL(src)
        }
      },
      { label: '画像をコピー', click: () => wc.copyImageAt(params.x, params.y) },
      { label: '画像アドレスをコピー', click: () => clipboard.writeText(src) },
      { type: 'separator' }
    )
  }

  template.push({ label: '検証', click: () => wc.inspectElement(params.x, params.y) })
  return template
}
