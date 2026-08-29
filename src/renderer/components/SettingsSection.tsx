/**
 * 設定画面の 1 節。macOS のシステム設定と同じ 2 カラムで、
 * **左に見出しと一言説明（固定幅）、右に中身**を置く。
 *
 * 見出しと本文を色・大きさで区別すると本文が長い節で差が消えるので、
 * 位置で分ける。節の追加はこのコンポーネントを通す（`section > h3` を直に書かない）。
 */
export function SettingsSection({
  title,
  sub,
  children
}: {
  title: string
  /** 見出しの下に出す一言。無ければ見出しだけ。 */
  sub?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="set-head">
        <h3>{title}</h3>
        {sub ? <p className="set-sub">{sub}</p> : null}
      </div>
      <div className="set-content">{children}</div>
    </section>
  )
}
