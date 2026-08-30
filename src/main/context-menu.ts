import { clipboard, Menu, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { log } from './log.js'

/**
 * ページ本体の右クリックメニュー。
 *
 * Electron はページの右クリックに何も出さない（`context-menu` を拾って自分で出す契約）。
 * 項目は**ショートカットで代用できないものだけ**に絞る:
 * 戻る/進む/再読み込み/コピー系はキーで済むので載せない。
 *
 * - 画像の上: 名前を付けて画像を保存 / 画像をコピー / 画像アドレスをコピー
 * - 常に: 検証（その座標の要素を DevTools で開く）
 *
 * 「画像を保存」は `downloadURL` で通常のダウンロード経路（`will-download`）に流す。
 * 保存先の確認・一覧への掲載は既存の handler がそのまま面倒を見る。
 */
export function attachContextMenu(wc: WebContents, window: () => BaseWindow | null): void {
  wc.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(wc, params)
    log('context_menu.open', { mediaType: params.mediaType, items: template.length })
    const target = window()
    if (!target || target.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window: target })
  })
}

export function buildContextMenuTemplate(
  wc: WebContents,
  params: Pick<Electron.ContextMenuParams, 'x' | 'y' | 'mediaType' | 'srcURL'>
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

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
