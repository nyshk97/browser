import { useEffect, useRef, useState } from 'react'
import { MAX_CUSTOM_ICON_LENGTH, isImageIcon } from '../../shared/favorites.js'
import { Favicon } from './Sidebar.js'

/**
 * 定義（Favorite / ピン留め）のカスタムアイコンを編集する小さな枠。
 *
 * 見た目は「今のアイコン（設定済みなら角に ×）」「絵文字の狭い入力欄（placeholder 😀）」「🖼 画像…」の 1 行。
 * 絵文字は入力欄に 1 個入れて Enter（⌃⌘Space の絵文字パネルやペーストでもよい）。
 * `app.showEmojiPanel()` でパネルを開いて自動保存する形は、パネルの挿入先が安定せず
 * （フォーカスの所在で開いたり開かなかったりする）やめた。
 *
 * 閉じるのは Esc か枠外クリック。main が拒否したら（false）枠の中にエラーを出す。
 */
export function IconEdit({
  url,
  title,
  current,
  fallback,
  error: outerError = null,
  onSubmit,
  onClose
}: {
  url: string
  title: string
  /** 今のカスタムアイコン。null なら未設定。 */
  current: string | null
  /** 未設定のときプレビューに出す favicon（タブ → 定義の順で拾ったもの）。 */
  fallback: string | null
  /**
   * 親から渡すエラー（ドロップで拒否されたとき）。**props として毎レンダー反映する**。
   * 初期値にしか読まないと、枠を開いた状態でドロップして拒否されたときに
   * （同じ ID なので再マウントが起きず）何も出ない。
   */
  error?: string | null
  onSubmit: (icon: string | null) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  // 枠内で出したエラーは「どの親エラーのときに出したか」を添えて持つ。親のエラーが更新されたら
  // 古い枠内エラーは自然に負ける（effect で setState し直すより単純で、余計な再描画も無い）
  const [inner, setInner] = useState<{ message: string; over: string | null } | null>(null)
  const setInnerError = (message: string): void => setInner({ message, over: outerError })
  const error = inner && inner.over === outerError ? inner.message : outerError
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 枠外クリックと Esc で閉じる（`RowMenu` と同じ）。window の blur では閉じない:
  // ファイルダイアログや絵文字パネルを開くとフォーカスが外れるので、そこで閉じると操作が続かない
  useEffect(() => {
    const onMouseDown = (event: Event): void => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const [value, setValue] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const apply = async (icon: string | null): Promise<void> => {
    try {
      const ok = await onSubmit(icon)
      if (ok) setValue('')
      else setInnerError(icon === null ? '戻せませんでした' : REJECTED_MESSAGE)
    } catch {
      // `optionalIcon` の暴走止め（数倍超）や IPC 自体の失敗。枠を開いたまま黙らない
      setInnerError(REJECTED_MESSAGE)
    }
  }

  const submitEmoji = (): void => {
    const text = value.trim()
    if (text) void apply(text)
  }

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    let icon: string | null
    try {
      icon = await fileToIconDataUrl(file)
    } catch {
      setInnerError(REJECTED_MESSAGE)
      return
    }
    if (!icon) {
      setInnerError(TOO_LARGE_MESSAGE)
      return
    }
    void apply(icon)
  }

  const image = isImageIcon(current)
  return (
    <div ref={ref} className="icon-edit" data-icon-edit onClick={(event) => event.stopPropagation()}>
      <div className="icon-edit-row">
        <span className="icon-edit-prev" title={current ? '今のアイコン' : 'favicon（未設定）'}>
          {current && !image ? (
            <span className="fi def-emoji">{current}</span>
          ) : (
            <Favicon url={url} title={title} src={current ?? fallback} />
          )}
          {current ? (
            <button
              type="button"
              className="icon-edit-clear"
              title="favicon に戻す"
              onClick={() => void apply(null)}
            >
              ×
            </button>
          ) : null}
        </span>
        {/* 絵文字 1 個ぶんの狭い欄。placeholder の 😀 で「ここに絵文字」と分かるようにする */}
        <input
          ref={inputRef}
          className="rename icon-edit-input"
          aria-label="絵文字を入力して Enter"
          title="絵文字を入力して Enter"
          placeholder="😀"
          // 絵文字の UTF-16 長の上限（`normalizeCustomIcon`）。data URL を貼っても IPC の暴走止めに当たらない
          maxLength={32}
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // 日本語入力の変換確定の Enter は送信しない（`RenameInput` と同じ規則）
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submitEmoji()
            }
          }}
        />
        <button type="button" className="icon-edit-btn" onClick={() => fileRef.current?.click()}>
          <span className="icon-edit-glyph">🖼</span>画像…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            void pickFile(file)
          }}
        />
      </div>
      {error ? <div className="icon-edit-error">{error}</div> : null}
    </div>
  )
}

export const REJECTED_MESSAGE = '絵文字 1 つか、小さな画像だけ使えます'
export const TOO_LARGE_MESSAGE = '画像が大きすぎます（縮めても 16KB に収まりません）'

/** 縮小の候補。最初に上限に収まったものを使う。 */
const ICON_SIZES = [64, 48, 32]

/**
 * ドロップ / 選択された画像ファイルを、上限に収まる PNG の data URL にする。
 *
 * `createImageBitmap` は SVG を扱えず、UI の CSP に `blob:` が無いので object URL も使えない。
 * `FileReader` の data URL を `<img>` に読ませる（data: は CSP で許可済み）。
 * 写真やグラデーションは 64×64 でも 16KB を超えることがあるので、段階的に縮める。
 *
 * @returns 収まらなければ null
 */
export async function fileToIconDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null
  const source = await readAsDataUrl(file)
  const img = new Image()
  img.src = source
  try {
    await img.decode()
  } catch {
    return null
  }
  for (const size of ICON_SIZES) {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // アスペクト比を保って中央に収める（透過を残すので背景は塗らない）。
    // intrinsic size を持たない SVG は naturalWidth/Height が 0 で scale が Infinity になり、
    // `drawImage` が何も描かずに**透明な PNG が正規のアイコンとして保存される**ので、箱いっぱいに描く
    const srcW = img.naturalWidth || size
    const srcH = img.naturalHeight || size
    const scale = Math.min(size / srcW, size / srcH)
    const w = Math.max(1, Math.round(srcW * scale))
    const h = Math.max(1, Math.round(srcH * scale))
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
    const out = canvas.toDataURL('image/png')
    if (out.length <= MAX_CUSTOM_ICON_LENGTH) return out
  }
  return null
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('unexpected reader result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** ドラッグ中のものに画像ファイルが含まれるか（dragover では `files` は読めないが `items` の type は読める）。 */
export function isImageFileDrag(event: React.DragEvent): boolean {
  if (!event.dataTransfer.types.includes('Files')) return false
  return Array.from(event.dataTransfer.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
}
