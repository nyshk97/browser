import { useEffect, useState } from 'react'
import type { CallState } from '../../shared/types.js'

/**
 * 会議の小窓（DESIGN.md「会議の小窓」）。
 *
 * **このウィンドウは中身がこれ1枚だけ**（ページも他の View も無い）。
 * 置くのは **会議へ移動 / マイク / カメラ の3つだけ**。
 * **退出も ✕ も置かない** —— 退出は誤爆で会議を抜ける事故を原理的に消すため、
 * ✕ は「会議中はいつでも出ている」を崩さないため。
 *
 * 「会議へ移動」は**ドメイン名と経過時間ごと1つのボタン**にしてある。
 * 独立した「戻る」ボタンにすると、何に戻るのかがラベルからも形からも読み取れない
 * （履歴の「戻る」と混ざる）。会議の名前を押したらその会議へ行く、なら迷わない。
 *
 * 経過時間は **`joinedAt` から renderer 側で数える**（毎秒 IPC を撃たない）。
 * トグルは**楽観更新しない** —— Meet 側で弾かれることがあるので、
 * 見た目が変わるのは main からの push が返ってからにする。
 */
export function CallBar(): React.JSX.Element | null {
  const [state, setState] = useState<CallState | null>(null)

  useEffect(() => {
    // push は購読より前にも来る（ウィンドウを作った直後に送っている）ので、
    // 購読と同時に**今の状態も取りに行く**
    const unsubscribe = window.nemo.onCallState(setState)
    void window.nemo.getCallState().then((current) => {
      if (current) setState((before) => before ?? current)
    })
    return unsubscribe
  }, [])

  if (!state) return null

  return (
    /*
      地は全面がドラッグ領域。**各ボタンは no-drag**（でないと押せなくなる）。
      ボタンだけで埋めると掴む場所が無くなるので、外周の余白と
      ボタン群のあいだの隙間を**掴みしろとして意図的に広く取る**。
    */
    <div className="call-bar" data-degraded={state.degraded ? '1' : '0'}>
      <button
        type="button"
        className="call-goto"
        title="会議のタブへ移動する"
        onClick={() => void window.nemo.callFocusTab()}
      >
        <span className="call-meta">
          <span className="call-host">
            {!state.degraded && <span className="call-live" aria-hidden="true" />}
            {state.host}
          </span>
          {/*
            **`key` に `joinedAt` を入れる**。retarget や再参加で基点が変わったとき、
            `key` を変えないと `useState` の初期値が古いままで 1 秒ぶん表示がずれる
            （effect で setState して直すと cascading render になる）。
          */}
          {state.joinedAt !== null && <Elapsed key={state.joinedAt} since={state.joinedAt} />}
        </span>
        <span className="call-go" aria-hidden="true">
          <GoToIcon />
        </span>
      </button>

      {/*
        縮退（プローブが読めない）ときは**会議へ移動するボタンだけ**にする。
        状態が分からないまま押させると、ミュートしたつもりで喋り続ける事故になる。
      */}
      {!state.degraded && (
        <span className="call-devices">
          <DeviceButton
            kind="mic"
            enabled={state.micEnabled}
            onToggle={() => void window.nemo.callToggleMic()}
          />
          <DeviceButton
            kind="cam"
            enabled={state.camEnabled}
            onToggle={() => void window.nemo.callToggleCam()}
          />
        </span>
      )}
    </div>
  )
}

/**
 * マイク / カメラのボタン。
 *
 * `enabled === null`（不明）は押させない。`false`（切れている）とは別物で、
 * 混ぜると「不明なのに ON に見える」状態が生まれる。
 */
function DeviceButton({
  kind,
  enabled,
  onToggle
}: {
  kind: 'mic' | 'cam'
  enabled: boolean | null
  onToggle: () => void
}): React.JSX.Element {
  const label = kind === 'mic' ? 'マイク' : 'カメラ'
  return (
    <button
      type="button"
      className={`call-btn call-device${enabled === false ? ' off' : ''}`}
      data-device={kind}
      data-enabled={enabled === null ? 'unknown' : String(enabled)}
      title={`${label}を${enabled === false ? 'ON' : 'OFF'}にする`}
      aria-pressed={enabled === true}
      disabled={enabled === null}
      onClick={onToggle}
    >
      <span className="call-glyph">
        {kind === 'mic' ? <MicIcon /> : <CamIcon />}
        {enabled === false && <SlashIcon />}
      </span>
    </button>
  )
}

/** 経過時間。`joinedAt` から renderer 側で数える（毎秒 IPC を撃たない）。 */
function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const seconds = Math.max(Math.floor((now - since) / 1000), 0)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const text =
    hours > 0
      ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  return <span className="call-elapsed">{text}</span>
}

/* アイコンフォントも外部アセットも使わない方針なのでインライン SVG で持つ。 */

/**
 * 「そのウィンドウへ行く」。
 *
 * 履歴の「戻る」の左矢印は**使わない**。同じ形にすると
 * 「ページを1つ戻る」と読み違える（会議タブへ移動するのであって履歴は動かさない）。
 */
function GoToIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M2.5 8h7M7 5.5 9.5 8 7 10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MicIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" fill="currentColor" />
      <path
        d="M3.6 7.2a4.4 4.4 0 0 0 8.8 0M8 11.6V14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CamIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.6" y="4" width="8.8" height="8" rx="2" fill="currentColor" />
      <path d="M11.4 7.4 14.4 5.4v5.2l-3-2z" fill="currentColor" />
    </svg>
  )
}

/** 切れていることを示す斜線（色に頼りきらないため、赤と併せて出す）。 */
function SlashIcon(): React.JSX.Element {
  return (
    <svg className="call-slash" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.6 2.6 13.4 13.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
