import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * サイドバーの行をその場でリネームする。
 *
 * 確定は Enter と blur、取消は Esc。**空にして確定したら解除**（`null` を送る）で、
 * 表示は実タイトルに戻る。
 */

/**
 * 単クリックを遅らせる時間。
 *
 * ブラウザは `click` → `click` → `dblclick` の順に撃つので、
 * 「編集を始めたらクリックを止める」だけでは間に合わない。
 * **1回目の click の時点で待つ**必要がある。
 */
export const CLICK_DELAY_MS = 250

/**
 * ダブルクリック待ちのために単クリックを遅らせる。
 *
 * 遅らせるのは「**閉じているピンを新しく読み込むクリック**」だけ。
 * ここを遅らせないと、リネームしようとしただけでタブが生まれて読み込みが走る
 * （＝遅延ロードの意味が消える）。
 * 逆に、既に開いている専用タブ・一時タブの選択やフォルダの開閉まで遅らせると、
 * 通常操作が常に重くなるだけなので即時のままにする。
 * Favorites のグリッドはダブルクリックでリネームしない（右クリックだけ）ので、
 * 閉じている枠でも遅らせず即時に開く。
 */
export function useDelayedClick(): {
  schedule: (run: () => void) => void
  cancel: () => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  const schedule = useCallback(
    (run: () => void) => {
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        run()
      }, CLICK_DELAY_MS)
    },
    [cancel]
  )

  useEffect(() => cancel, [cancel])

  return { schedule, cancel }
}

/**
 * 編集用の入力欄。
 *
 * Enter と blur はどちらも確定なので、**二重に発火させない**ようにする
 * （Enter で親が閉じる → その拍子に blur が飛ぶ）。
 * 日本語入力の変換確定の Enter は `isComposing` で見分ける。
 */
export function RenameInput({
  initial,
  onSubmit,
  onCancel
}: {
  initial: string
  onSubmit: (title: string | null) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.select()
  }, [])

  const submit = (): void => {
    if (done.current) return
    done.current = true
    const trimmed = value.trim()
    onSubmit(trimmed ? trimmed : null)
  }

  const cancel = (): void => {
    if (done.current) return
    done.current = true
    onCancel()
  }

  return (
    <input
      ref={ref}
      className="rename"
      value={value}
      spellCheck={false}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={submit}
      // 行のクリック（タブ選択 / フォルダ開閉）を編集中は止める
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        // 行が draggable なので、入力欄の中の選択がドラッグ扱いにならないようにする
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        // 変換確定の Enter で閉じない
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit()
        else if (event.key === 'Escape') cancel()
      }}
    />
  )
}

/**
 * 行の名前（表示 / 編集の切り替え）。
 *
 * 編集に入る操作（ダブルクリック・メニューの「名前を変更」）は行の側が持つ。
 * ここは `editing` を見て描き分けるだけにして、どの行でも同じ規則にする。
 */
export function InlineRename({
  title,
  editing,
  onSubmit,
  onCancel
}: {
  title: string
  editing: boolean
  onSubmit: (title: string | null) => void
  onCancel: () => void
}): React.JSX.Element {
  if (editing) return <RenameInput initial={title} onSubmit={onSubmit} onCancel={onCancel} />
  return <span className="tt">{title}</span>
}
