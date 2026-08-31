import { useEffect, useRef, useState } from 'react'

/**
 * 定義（Favorite / ピン留め）の URL を書き換える小さな枠（Arc の「Edit Pinned URL」相当）。
 *
 * 変わるのは「枠を押したとき最初に開く URL」だけで、開いているタブには効かない
 * （閉じて開き直したときから新しい URL）。u/N 形式の Google カレンダーを
 * `?authuser=` 形式に差し替える、のような用途を想定している。
 *
 * 閉じるのは Esc か枠外クリック（`IconEdit` と同じ）。main が拒否したら（false）
 * 枠の中にエラーを出す。http/https 以外だけは main へ送る前にここで弾いて、
 * 「重複」と「使えない URL」の文言を出し分ける（IPC は boolean しか返さない）。
 */
export function UrlEdit({
  url,
  onSubmit,
  onClose
}: {
  /** 今の定義の URL（初期値として全選択で出す）。 */
  url: string
  onSubmit: (url: string) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(url)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 枠外クリックと Esc で閉じる（`IconEdit` と同じ）
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

  // 典型は「丸ごと差し替え」なので全選択で出す（Arc の Edit Pinned URL と同じ）
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = async (): Promise<void> => {
    const text = value.trim()
    if (!text) return
    // `maxLength` 属性で切らない: 上限超えのペーストが黙って途中で切れ、
    // **別の URL として正規に保存されてしまう**。超過はエラーとして見せる
    if (text.length > MAX_URL_LENGTH) {
      setError(TOO_LONG_URL_MESSAGE)
      return
    }
    if (!isHttpUrl(text)) {
      setError(INVALID_URL_MESSAGE)
      return
    }
    try {
      const ok = await onSubmit(text)
      if (ok) onClose()
      else setError(URL_REJECTED_MESSAGE)
    } catch {
      // IPC 自体の失敗。枠を開いたまま黙らない
      setError(URL_REJECTED_MESSAGE)
    }
  }

  return (
    <div ref={ref} className="url-edit" onClick={(event) => event.stopPropagation()}>
      <div className="url-edit-row">
        <input
          ref={inputRef}
          className="rename url-edit-input"
          aria-label="開く URL"
          placeholder="https://…"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // 日本語入力の変換確定の Enter は送信しない（`RenameInput` と同じ規則）
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <button type="button" className="icon-edit-btn" onClick={() => void submit()}>
          保存
        </button>
      </div>
      {/* 想定ユースケース（カレンダー等）はタブを開きっぱなしなので、「効かない」と読まれないよう明記する */}
      <div className="url-edit-note">枠を押したとき最初に開く URL。開いているタブは閉じて開き直すと反映</div>
      {error ? <div className="icon-edit-error">{error}</div> : null}
    </div>
  )
}

/** `normalizeStoredUrl`（settings-schema.js）と同じ上限。 */
const MAX_URL_LENGTH = 4096

export const INVALID_URL_MESSAGE = 'http / https の URL だけ使えます'
export const TOO_LONG_URL_MESSAGE = 'URL が長すぎます（4096 文字まで）'
export const URL_REJECTED_MESSAGE = '保存できませんでした（別の枠が同じ URL を使っているかもしれません）'

/** main の `normalizeStoredUrl` と同じ入口だけ先に見る（拒否理由の出し分け用）。 */
function isHttpUrl(text: string): boolean {
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
