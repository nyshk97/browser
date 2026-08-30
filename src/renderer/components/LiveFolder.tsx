import { useEffect, useMemo, useState } from 'react'
import { RowMenu, type RowMenuState } from './RowMenu.js'
import type { LiveFolderState, LivePrBucket, LivePullRequest } from '../../shared/types.js'

/**
 * Live Folder — サイドバーの自動更新セクション（GitHub の Pull Request）。
 *
 * DESIGN.md の3層に**4層目として割り込む**（Favorites の直下・ピン留めより上）。
 * 親見出し（"PULL REQUESTS"）は置かず、**小見出し2つだけ**で階層を1つ減らし、
 * 区切り線に挟まれた一塊として読ませる。
 *
 * 表示の分岐は**この1つの述語（`liveFolderView`）に寄せて上から順に1つ選ぶ**。
 * 「0 件なら出さない」と「失敗したら出す」は衝突するので、各所に散らすと必ず食い違う。
 */

/* ------------------------------------------------------------------ *
 * 表示の優先順位
 * ------------------------------------------------------------------ */

type ViewKind =
  /** トークン未設定 → `Connect GitHub` の1行だけ */
  | 'connect'
  /** `auth` → `Reconnect GitHub` の1行だけ */
  | 'reconnect'
  /** 一覧 + 末尾の状態行 */
  | 'list'
  /** 成功・0 件 */
  | 'empty'
  /** 失敗していてキャッシュも無い → 末尾の状態行だけ */
  | 'status-only'

interface View {
  kind: ViewKind
  /** 失敗して古い内容を出している（行を薄くして古さを示す）。 */
  stale: boolean
}

export function liveFolderView(state: LiveFolderState): View {
  if (state.source === 'none') return { kind: 'connect', stale: false }
  // **`kind` を見て分岐し、UI で HTTP ステータスを見ない**
  if (state.failure?.kind === 'auth') return { kind: 'reconnect', stale: false }
  if (state.failure) {
    return state.items.length > 0 ? { kind: 'list', stale: true } : { kind: 'status-only', stale: true }
  }
  return state.items.length > 0 ? { kind: 'list', stale: false } : { kind: 'empty', stale: false }
}

/* ------------------------------------------------------------------ *
 * 文言
 * ------------------------------------------------------------------ */

/** 1分未満 `just now` → `3m ago` → `2h ago`。**1分ごとに再描画する**（止まると表示が嘘になる）。 */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** 時刻（`19:12`）。失敗中に「いつの内容か」を出す。 */
function clockTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 残り時間（`12m` / `45s`）。`resetAt` から1分ごとに詰まる。 */
function remainingTime(resetAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((resetAt - now) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.ceil(seconds / 60)}m`
}

const BUCKET_LABEL: Record<LivePrBucket, string> = {
  review: 'Review requested',
  mine: 'Created'
}

/* ------------------------------------------------------------------ *
 * アイコン
 * ------------------------------------------------------------------ */

const GITHUB_MARK =
  'M8 .5a7.5 7.5 0 0 0-2.37 14.62c.37.07.5-.16.5-.36l-.01-1.26c-2.09.45-2.53-1-2.53-1-.34-.87-.83-1.1-.83-1.1-.68-.47.05-.46.05-.46.75.05 1.15.77 1.15.77.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.43-.84-3.43-3.73 0-.82.3-1.5.77-2.02-.08-.19-.34-.95.07-1.99 0 0 .63-.2 2.06.77a7.1 7.1 0 0 1 3.75 0c1.43-.97 2.06-.77 2.06-.77.41 1.04.15 1.8.08 1.99.48.52.77 1.2.77 2.02 0 2.9-1.76 3.53-3.44 3.72.27.23.51.69.51 1.39l-.01 2.06c0 .2.13.44.51.36A7.5 7.5 0 0 0 8 .5Z'

function GithubMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={GITHUB_MARK} />
    </svg>
  )
}

/**
 * 更新の矢印（円弧 + 矢じり）。
 * **中心対称にしてある**ので、回しても重心がブレない。
 */
function SyncIcon(): React.JSX.Element {
  return (
    <svg className="lf-sync" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 7.2A5.3 5.3 0 0 0 3.6 4.9" />
      <path d="M2.8 7.2A5.3 5.3 0 0 0 12.4 9.5" />
      <path d="M3.6 1.9v3h3" />
      <path d="M12.4 12.5v-3h-3" />
    </svg>
  )
}

/**
 * 状態バッジ。**バッジ無し = レビュー待ち**（`waiting`）。
 * 縁はサイドバーの地の色で 2px 抜いて、アイコンから浮かせる。
 */
function StateBadge({ state }: { state: LivePullRequest['state'] }): React.JSX.Element | null {
  if (state === 'waiting') return null
  if (state === 'approved') {
    return (
      <span className="lf-badge ok" title="Approved">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.4 6.3 11.6 13 4.8" />
        </svg>
      </span>
    )
  }
  if (state === 'changes-requested') {
    return (
      <span className="lf-badge warn" title="Changes requested">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h.01M8 8h.01M12 8h.01" />
        </svg>
      </span>
    )
  }
  // 鉛筆は**塗りで描く**。8px で線画にすると形が潰れて「禁止マーク」に見える
  return (
    <span className="lf-badge draft" title="Draft">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M11.2 1.6 14.4 4.8 6 13.2 2 14.2l1-4z" />
      </svg>
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

export function LiveFolder({
  state,
  openUrls
}: {
  state: LiveFolderState
  /** いま開いているタブの URL（一致する行をアクティブに見せる）。 */
  openUrls: Set<string>
}): React.JSX.Element {
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  // 相対時刻は**1分ごとに再描画する**（`3m ago` のまま止まると表示自体が嘘になる）
  const [now, setNow] = useState(() => Date.now())
  // **小見出しは起動のたびに両方折りたたみ**（永続化しない。PR が多いとサイドバーを占領するので普段は畳む）
  const [collapsed, setCollapsed] = useState<Record<LivePrBucket, boolean>>({ review: true, mine: true })
  const toggleBucket = (bucket: LivePrBucket): void =>
    // 関数形式にする（同一タスクで 2 つ連続クリックされても片方の更新を落とさない）
    setCollapsed((prev) => ({ ...prev, [bucket]: !prev[bucket] }))
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const view = liveFolderView(state)
  // **`rate-limit` 中は手動更新を出さない**（押しても投げないので、押せること自体が嘘になる）
  const rateLimited = state.failure?.kind === 'rate-limit'

  const groups = useMemo(
    () =>
      (['review', 'mine'] as const).map((bucket) => ({
        bucket,
        items: state.items.filter((item) => item.bucket === bucket)
      })),
    [state.items]
  )

  const sectionMenuItems = (): RowMenuState['items'] => [
    {
      label: 'いま更新する',
      disabled: rateLimited,
      run: () => void window.nemo.liveFolderRefresh()
    }
  ]

  const openSectionMenu = (event: React.MouseEvent, id: string, extra: RowMenuState['items'] = []): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ id, x: event.clientX, y: event.clientY, items: [...extra, ...sectionMenuItems()] })
  }

  return (
    <div className="live-folder" onContextMenu={(event) => openSectionMenu(event, 'live-folder')}>
      {view.kind === 'connect' ? (
        <button type="button" className="row lf-cta" onClick={() => void window.nemo.setOverlay('settings')}>
          <span className="lf-disc">
            <GithubMark />
          </span>
          <span className="tt">Connect GitHub</span>
        </button>
      ) : null}

      {view.kind === 'reconnect' ? (
        <button
          type="button"
          className="row lf-cta danger"
          onClick={() => void window.nemo.setOverlay('settings')}
        >
          <span className="lf-disc">
            <GithubMark />
          </span>
          <span className="tt">Reconnect GitHub</span>
        </button>
      ) : null}

      {view.kind === 'empty' ? <div className="lf-empty">No open pull requests</div> : null}

      {view.kind === 'list'
        ? groups.map(({ bucket, items }) =>
            // グループが 0 件ならその小見出しごと出さない
            items.length === 0 ? null : (
              <div key={bucket} className="lf-bucket" data-bucket={bucket}>
                <BucketHeading
                  bucket={bucket}
                  count={items.length}
                  collapsed={collapsed[bucket]}
                  truncated={state.truncation[bucket] !== null}
                  onToggle={() => toggleBucket(bucket)}
                />
                {/* 内容コンテナは常に描画する（`aria-controls` の参照先を消さない）。畳んだら中の行を描画しない */}
                <div className="lf-items" id={`lf-items-${bucket}`} hidden={collapsed[bucket]}>
                  {collapsed[bucket]
                    ? null
                    : items.map((item) => (
                        <PrRow
                          key={item.url}
                          item={item}
                          stale={view.stale}
                          active={openUrls.has(item.url)}
                          onContextMenu={(event) =>
                            openSectionMenu(event, item.url, [
                              { label: 'GitHub で開く', run: () => void window.nemo.liveFolderOpen(item.url) }
                            ])
                          }
                        />
                      ))}
                </div>
              </div>
            )
          )
        : null}

      {view.kind === 'list' || view.kind === 'empty' || view.kind === 'status-only' ? (
        <StatusLine state={state} now={now} />
      ) : null}

      {/*
        打ち切りは**末尾の状態行の下に別の1行**として出す。
        検索の話は検索の言葉（fetched）で書き、表示行数とは別の場所に置く
        （バケットに割り当てられた件数 `items.length` と `search.total` は別の母集団なので、同じ表記に混ぜない）。
        小見出しが畳まれていれば `hidden` で隠す（DOM からは消さない。`aria-controls` の参照先を残す）。
        **小見出しが無いバケット（重複除外で `items` が空）の打ち切り行は隠さない**（開く手段が無く永久に消える）。
      */}
      {view.kind === 'list'
        ? (['review', 'mine'] as const).flatMap((bucket) => {
            const truncation = state.truncation[bucket]
            if (!truncation) return []
            const hasHeading = groups.some((group) => group.bucket === bucket && group.items.length > 0)
            return [
              <div
                key={bucket}
                className="lf-truncated"
                id={`lf-truncated-${bucket}`}
                hidden={hasHeading && collapsed[bucket]}
              >
                First {truncation.returned} of {truncation.total} fetched for{' '}
                <span className="lf-bucket">{BUCKET_LABEL[bucket]}</span>
              </div>
            ]
          })
        : null}

      {menu ? <RowMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}

/**
 * 小見出し（`REVIEW REQUESTED` / `CREATED`）。クリックでそのバケットだけ開閉する。
 *
 * - 右の数字は**バケットに割り当てられた件数**（`items.length`。重複除外後の値で、折りたたみ状態にも
 *   DOM 上の行数にも検索の取得件数 `returned` にも依存しない）。打ち切りは末尾に別行で出す
 * - 支援技術には `aria-label` で件数を伝える
 */
function BucketHeading({
  bucket,
  count,
  collapsed,
  truncated,
  onToggle
}: {
  bucket: LivePrBucket
  count: number
  collapsed: boolean
  truncated: boolean
  onToggle: () => void
}): React.JSX.Element {
  const controls = truncated ? `lf-items-${bucket} lf-truncated-${bucket}` : `lf-items-${bucket}`
  const label = `${BUCKET_LABEL[bucket]}, ${count} 件`
  return (
    <button
      type="button"
      className="lf-sub"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      onClick={onToggle}
    >
      <span className="chev" aria-hidden="true">
        ›
      </span>
      <span className="name">{BUCKET_LABEL[bucket]}</span>
      <span className="count">{count}</span>
    </button>
  )
}

function PrRow({
  item,
  stale,
  active,
  onContextMenu
}: {
  item: LivePullRequest
  stale: boolean
  active: boolean
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const classes = ['row', 'lf-row']
  if (active) classes.push('active')
  if (stale) classes.push('stale')
  // **2行目は文脈で変える**。レビュー依頼は著者名、自分の PR はリポジトリ名
  // （自分の PR に自分の名前を並べても情報がない）
  const subline = item.bucket === 'review' ? item.author : item.repo
  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={item.title}
      onClick={() => void window.nemo.liveFolderOpen(item.url)}
      onContextMenu={onContextMenu}
    >
      <span className="lf-avatar">
        <span className="lf-disc">
          <GithubMark />
        </span>
        <StateBadge state={item.state} />
      </span>
      <span className="lf-text">
        <span className="lf-title">{item.title}</span>
        <span className="lf-sub-line">{subline}</span>
      </span>
    </button>
  )
}

/**
 * 末尾の状態行。
 *
 * **失敗しても一覧は空にしない方針なので、この行が無いと
 * 古い一覧を最新だと誤読する。**
 */
function StatusLine({ state, now }: { state: LiveFolderState; now: number }): React.JSX.Element {
  if (state.loading) {
    return (
      <div className="lf-foot">
        <span className="when">Refreshing…</span>
        <span className="act spin">
          <SyncIcon />
        </span>
      </div>
    )
  }

  if (state.failure?.kind === 'rate-limit') {
    // **`Retry` は出さない**（押しても投げない仕様なので、出すと「押せば直る」という嘘になる）
    const left = state.failure.resetAt ? ` · retrying in ${remainingTime(state.failure.resetAt, now)}` : ''
    return (
      <div className="lf-foot err">
        <span className="when">Rate limited{left}</span>
      </div>
    )
  }

  if (state.failure) {
    const showing = state.updatedAt ? ` · showing ${clockTime(state.updatedAt)}` : ''
    return (
      <div className="lf-foot err">
        <span className="when">Couldn&apos;t refresh{showing}</span>
        <button type="button" className="act" onClick={() => void window.nemo.liveFolderRefresh()}>
          <SyncIcon /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="lf-foot">
      <span className="when">
        {state.updatedAt ? `Updated ${relativeTime(state.updatedAt, now)}` : 'Not updated yet'}
      </span>
      <button type="button" className="act" onClick={() => void window.nemo.liveFolderRefresh()}>
        <SyncIcon /> Refresh
      </button>
    </div>
  )
}
