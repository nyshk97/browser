import { useEffect } from 'react'
import { hostOf, peekTab, useWindowState } from '../useNemo.js'

/**
 * Peek（ウィンドウ内ポップアップ）の暗幕と操作ボタン（DESIGN.md「Peek」）。
 *
 * **Peek の中身そのものはここには無い**。中身は普通のタブと同じ `WebContentsView` で、
 * main が z 順を「ページ → この View → Peek の View → オーバーレイ」に並べる。
 * ここが描くのは**その下に敷く暗幕**と、**Peek の外側に置く ✕ / ⌘O ボタン**だけ。
 *
 * ボタンを Peek の外側に置くので、main 側は Peek の上下に
 * `PEEK_TOOL_BAND` ぶんの余白を必ず残す（足りないとボタンが Peek の下に潜る）。
 */
export function Peek(): React.JSX.Element | null {
  const state = useWindowState()
  const peek = peekTab(state)

  // Esc は main 側（ページの `before-input-event`）で拾う。
  // フォーカスは Peek のページにあることが多く、ここの keydown には来ないため。
  // ただし暗幕をクリックしてこちらにフォーカスが来ている場合もあるので、両方で受ける。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.nemo.closePeek()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!peek) return null

  return (
    <div className="peek-back">
      {/*
        暗幕は**クリックしても閉じない**。ページ内のテキスト選択でドラッグが
        Peek の外へはみ出したときに、意図せず閉じてしまうのを避ける。
      */}
      {/*
        中身が来るまでの間に置く「窓の形」。main は Peek の View を
        `dom-ready` まで出さない（`peekAwaitingDocument`）ので、その間ここが見える。
        これが無いと、リンクを踏んでも暗幕だけが出て窓が数百 ms〜数秒あらわれない。
      */}
      {!peek.visible && (
        <div className="peek-placeholder">
          <PeekLoading url={peek.url} />
        </div>
      )}
      <div className="peek-tools">
        <button
          type="button"
          className="peek-promote"
          title="タブにする（⌘O）"
          onClick={() => void window.nemo.promoteForegroundView()}
        >
          <ExpandIcon />
          タブにする
        </button>
        <button
          type="button"
          className="peek-close"
          title="閉じる（Esc / ⌘W）"
          onClick={() => void window.nemo.closePeek()}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * プレースホルダーの上に置く「待っている」表現: 行き先ホストの頭文字・ホスト名・ドット。
 *
 * **favicon は出さない**。ページが申告する favicon（`page-favicon-updated`）は `dom-ready` の
 * 前後に来るので、プレースホルダーが出ている間にはまず届かない。履歴から引く手もあるが
 * 画像の取得は別に走るので、待ち途中に差し込まれてチラつく。ここで使うのは
 * Peek を開いた瞬間に手元にある URL だけにし、板が出た時点で完成形にする。
 *
 * 出るのはリンク先の URL のホストなので、短縮 URL やリダイレクト経由だと中継ホストになる。
 *
 * **`pointer-events: none`**（CSS 側）。プレースホルダーはクリックを受けないので当たり判定に
 * 参加させない（自走検証は `elementFromPoint` で「中央がプレースホルダー」を見ている）。
 */
function PeekLoading({ url }: { url: string }): React.JSX.Element {
  const host = hostOf(url).replace(/^www\./, '')
  const initial = host.slice(0, 1).toUpperCase()
  return (
    <div className="peek-loading" aria-hidden="true">
      {host && <span className="peek-loading-letter">{initial}</span>}
      {host && <span className="peek-loading-host">{host}</span>}
      <span className="peek-loading-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

/** 「大きく開く」を表す矢印（アイコンフォントは使わない方針なのでインライン SVG）。 */
function ExpandIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M7 1h4v4M11 1 6.6 5.4M5 11H1V7M1 11l4.4-4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
