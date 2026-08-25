/**
 * タブが 1 つも無いときにページ領域へ出す画面（DESIGN.md「空状態」）。
 *
 * **この View は状態を購読しない**。出すか出さないかは main 側（`layout()`）が
 * View ごと出し入れして決めるので、ここは常に同じものを描く。
 *
 * 置くのは魚のマークとキーの表記だけにする。ここに押せるものを増やすと、
 * タブが無いだけの画面が「もう一つのホーム画面」になっていく。
 */
export function EmptyState(): React.JSX.Element {
  return (
    <div className="empty-state">
      <FishMark />
      <p className="empty-keys">
        <span>
          <kbd>⌘T</kbd>New Tab
        </span>
        <span>
          <kbd>⌘⇧T</kbd>Reopen Closed Tab
        </span>
      </p>
    </div>
  )
}

/**
 * 魚のマーク。Lucide の `fish-symbol`（ISC）。
 * アイコンフォントも外部アセットも使わない方針なのでインラインで持つ。
 * 出典とライセンスは `docs/licenses.md` の「コードに埋め込んだ第三者アセット」に書いてある。
 */
function FishMark(): React.JSX.Element {
  return (
    <svg
      className="empty-mark"
      width="64"
      height="64"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 16s9-15 20-4C11 23 2 8 2 8" />
    </svg>
  )
}
