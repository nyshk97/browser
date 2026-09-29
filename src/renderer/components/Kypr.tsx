import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KyprActionResult,
  KyprInlineState,
  KyprItemDetail,
  KyprPanelData,
  KyprStatus,
  KyprSummary,
  KyprUnlockFailure
} from '../../shared/types.js'

/**
 * kypr（自作のパスワードマネージャー）の UI。
 *
 * - `KyprPanel` … ツールバーの右上のアイコン / ⌘⇧L のポップアップ（オーバーレイの `kypr`）
 * - `KyprInline` … ログイン欄の下の候補（オーバーレイの `kypr-inline`。ページのフォーカスを奪わない）
 * - `KyprUnlock` … 解除の画面（ポップアップと設定画面で使う）
 *
 * **鍵と平文は main が持つ**。ここに来るのは一覧に要る項目（名前・ユーザー名・ホスト）と、
 * 詳細・編集を開いたアイテムの平文だけ。コピーは main がクリップボードに書く（値はここを通らない）。
 */

const KIND_LABEL: Record<string, string> = {
  login: 'ログイン',
  card: 'クレジットカード',
  note: 'セキュアメモ',
  unknown: '知らない種類',
  error: '開けない'
}

export function unlockFailureText(reason: KyprUnlockFailure, retryAfter?: number): string {
  switch (reason) {
    case 'bad-password':
      return 'マスターパスワードが違います。'
    case 'locked':
      return `失敗が続いたので、しばらく待ってください（${retryAfter ?? 60} 秒）。`
    case 'no-account':
      return '保管庫がまだありません。先に Web（kypr.tools97.com）で作成してください。'
    case 'offline-no-cache':
      return 'サーバーに届かず、この Mac にはまだ保管庫の控えがありません。'
    case 'weaker-params':
      return '鍵の導出の設定が前回より弱くなっています（差し替えの疑い）。開かずに止めました。'
    case 'invalid-params':
    case 'malformed':
    case 'tampered':
      return 'サーバーの保管庫のデータを読めません。'
    case 'no-device-keys':
      return 'この Mac では Touch ID の設定がまだです。マスターパスワードで解除してください。'
    case 'touch-id-failed':
      return 'Touch ID で解除できませんでした。マスターパスワードで解除してください。'
    case 'disabled':
      return 'kypr は使えません。'
    default:
      return '解除できませんでした。もう一度試してください。'
  }
}

export function actionFailureText(result: KyprActionResult): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'conflict':
      return '他の端末で更新されていました。最新の内容で読み直したので、確かめてからもう一度保存してください。'
    case 'read-only':
    case 'offline':
      return 'サーバーに届かないため、読み取り専用で開いています。'
    case 'session-expired':
      return 'サーバーがログインを受け付けませんでした。マスターパスワードで解除し直してください。'
    case 'purged':
      return 'このアイテムは完全に削除されています。'
    case 'locked':
      return 'ロックされています。'
    case 'no-target':
      return 'このページに入力できる欄が見つかりません。'
    case 'url-mismatch':
      return '入力欄のあるページ（フレーム）のアドレスが、このログインの URL と合いません。'
    case 'invalid':
      return '入力を確かめてください。'
    default:
      return 'うまくいきませんでした。'
  }
}

/* ------------------------------------------------------------------ *
 * アイコン・ロゴ・アバター
 * ------------------------------------------------------------------ */

// 線のアイコン（24px のグリッド）。形は Web 版 kypr（apps/web/src/components/Icon.tsx）と揃える
const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2M17 6l2 2M15 8l2 2" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="m15 5-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <path d="M6 15h4" />
    </>
  ),
  note: (
    <>
      <path d="M6 3h9l5 5v13H6z" />
      <path d="M14 3v6h6" />
      <path d="M9 13h8M9 17h6" />
    </>
  ),
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01" />
    </>
  ),
  fingerprint: (
    <path d="M12 11v3a8 8 0 0 1-1 4M8.5 5.5A6 6 0 0 1 18 10v2M6 9a6 6 0 0 0-.5 2.5V14a11 11 0 0 1-1 4M15 12v2a12 12 0 0 1-1.5 6M9 14a14 14 0 0 1-1 4" />
  ),
  check: <path d="m5 12 5 5 9-10" />
} as const

export type KyprIconName = keyof typeof PATHS

export function KyprIcon({ name, size = 16 }: { name: KyprIconName; size?: number }): React.JSX.Element {
  return (
    <svg
      className="kypr-ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

/**
 * kypr のロゴ。**Web の favicon（apps/web/public/favicon.svg）・iOS のアプリアイコンと同じ図柄**
 * （青い角丸に横向きの鍵）。「kypr そのもの」を指す場所（ツールバー・ロック画面・フッター）はこれを使う。
 * 形を変えるときは kypr 側の 2 つと一緒に変える
 */
export function KyprMark({
  size = 'md',
  locked = false
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  locked?: boolean
}): React.JSX.Element {
  return (
    <span className={`kypr-mark ${size}${locked ? ' locked' : ''}`} aria-hidden="true">
      <svg viewBox="4 4 24 24" fill="none" stroke="currentColor" strokeLinecap="round">
        <circle cx="12" cy="16" r="5" />
        <path d="M17 16h10M23 16v4M26 16v3" />
      </svg>
    </span>
  )
}

/**
 * 頭文字のアイコン。色の決め方は Web 版の `Avatar` と同じ（ドメイン、無ければ名前から）で、
 * 同じアイテムが Web と同じ色になる。サイトのファビコンは読まない（どのサイトを使っているかが外に漏れる）
 */
function Avatar({
  kind,
  name,
  host,
  size = 'md'
}: {
  kind: KyprSummary['kind']
  name: string
  host: string | null
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const iconSize = size === 'lg' ? 22 : size === 'sm' ? 12 : 16
  if (kind === 'card' || kind === 'note') {
    return (
      <span className={`kypr-av ${size} ${kind}`} aria-hidden="true">
        <KyprIcon name={kind} size={iconSize} />
      </span>
    )
  }
  if (kind !== 'login') {
    return (
      <span className={`kypr-av ${size} broken`} aria-hidden="true">
        ?
      </span>
    )
  }
  let h = 7
  for (const c of (host ?? '').replace(/^www\./, '') || name) h = (h * 31 + c.codePointAt(0)!) % 360
  const letter = [...(name.trim() || '?')][0].toUpperCase()
  return (
    <span className={`kypr-av ${size}`} style={{ '--h': h } as React.CSSProperties} aria-hidden="true">
      {letter}
    </span>
  )
}

function hostOfUri(uri: string): string | null {
  try {
    return new URL(uri.includes('://') ? uri : `https://${uri}`).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 解除
 * ------------------------------------------------------------------ */

/**
 * `hero` … ポップアップのロック画面（ロゴと見出しを大きく出す）。設定画面の節では付けない
 */
export function KyprUnlock({
  status,
  onDone,
  hero = false
}: {
  status: KyprStatus
  onDone: () => void
  hero?: boolean
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const signedOut = status.state === 'signed-out'
  const canTouchId = !signedOut && status.touchIdEnrolled && status.touchIdAvailable

  useEffect(() => inputRef.current?.focus(), [])

  const signIn = (): void => {
    if (!password || busy) return
    setBusy(true)
    setMessage(null)
    void window.nemo
      .kyprSignIn(password, remember)
      .then((result) => {
        if (result.ok) {
          setPassword('')
          onDone()
        } else setMessage(unlockFailureText(result.reason, result.retryAfter))
      })
      .finally(() => setBusy(false))
  }
  const touchId = (): void => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    void window.nemo
      .kyprUnlockTouchId()
      .then((result) => {
        if (result.ok) onDone()
        else setMessage(unlockFailureText(result.reason))
      })
      .finally(() => setBusy(false))
  }

  if (status.state === 'disabled') {
    return <p className="kypr-note">kypr は使えません（{status.disabledReason ?? '理由不明'}）。</p>
  }
  return (
    <div className={`kypr-unlock${hero ? ' hero' : ''}`}>
      {hero ? (
        <>
          <KyprMark size="lg" />
          <h3>{signedOut ? 'kypr にログイン' : 'kypr はロックされています'}</h3>
          <p className="kypr-note">
            {signedOut
              ? 'Web で作った保管庫のマスターパスワードを入れてください。'
              : canTouchId
                ? 'Touch ID かマスターパスワードで解除します。'
                : 'マスターパスワードで解除します。'}
          </p>
        </>
      ) : (
        <p className="kypr-note">
          {signedOut
            ? 'kypr の保管庫にログインします。Web で作った保管庫のマスターパスワードを入れてください。'
            : 'kypr はロックされています。'}
        </p>
      )}
      {canTouchId ? (
        <button type="button" className="btn primary kypr-touchid" disabled={busy} onClick={touchId}>
          {hero ? <KyprIcon name="fingerprint" /> : null}
          Touch ID で解除
        </button>
      ) : null}
      {hero && canTouchId ? <div className="kypr-or">または</div> : null}
      <form
        className="kypr-password"
        onSubmit={(event) => {
          event.preventDefault()
          signIn()
        }}
      >
        <input
          ref={inputRef}
          type="password"
          value={password}
          placeholder="マスターパスワード"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="btn" disabled={!password || busy}>
          {busy ? '解除中…' : signedOut ? 'ログイン' : '解除'}
        </button>
      </form>
      {status.touchIdAvailable ? (
        <label className="kypr-check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          次回から Touch ID で解除する
        </label>
      ) : null}
      {message ? <p className="kypr-error">{message}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * ポップアップ
 *
 * 上に「このページ」に合うログインのカード（↵ で 1 件目を入力）、下に全件の検索と一覧。
 * **Esc では閉じない**（外をクリックすると main が閉じる。`registry.ts` の overlay の blur）。
 * 詳細の Esc は一覧へ戻るだけ
 * ------------------------------------------------------------------ */

type View =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'edit'; id: string | null; type: 'login' | 'card' | 'note' }

type Filter = 'all' | 'login' | 'card' | 'note' | 'trash'

const FILTERS: [Filter, string][] = [
  ['all', 'すべて'],
  ['login', 'ログイン'],
  ['card', 'クレジットカード'],
  ['note', 'セキュアメモ'],
  ['trash', 'ゴミ箱']
]
const FILTER_LABEL = Object.fromEntries(FILTERS) as Record<Filter, string>

const COPY_LABEL: Record<string, string> = {
  username: 'ユーザー名',
  password: 'パスワード',
  number: 'カード番号',
  code: 'セキュリティコード',
  expiry: '有効期限',
  cardholderName: '名義',
  notes: '本文'
}

export function KyprPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<KyprPanelData | null>(null)
  const [view, setView] = useState<View>({ name: 'list' })
  const [message, setMessage] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null)

  const reload = useCallback(() => {
    void window.nemo.kyprPanel().then(setData)
  }, [])
  useEffect(reload, [reload])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 1600)
    return () => clearTimeout(timer)
  }, [toast])

  const copy = useCallback((id: string, field: string) => {
    void window.nemo.kyprCopy(id, field).then((ok) => {
      if (ok)
        setToast((prev) => ({
          text: `${COPY_LABEL[field] ?? ''}をコピーしました（30 秒で消えます）`,
          n: (prev?.n ?? 0) + 1
        }))
    })
  }, [])

  const status = data?.status
  return (
    <div className="panel kypr-panel">
      {!data || !status ? (
        <div className="empty">読み込み中…</div>
      ) : status.state !== 'unlocked' ? (
        <div className="kypr-lock">
          <div className="kypr-lock-head">
            <button type="button" className="icon" title="閉じる" onClick={onClose}>
              <KyprIcon name="close" />
            </button>
          </div>
          <KyprUnlock status={status} onDone={reload} hero />
        </div>
      ) : view.name === 'list' ? (
        <KyprList
          data={data}
          message={message}
          onOpen={(id) => {
            setMessage(null)
            setView({ name: 'detail', id })
          }}
          onFill={(id) => {
            setMessage(null)
            void window.nemo.kyprFill(id).then((result) => setMessage(actionFailureText(result)))
          }}
          onNew={(type) => {
            setMessage(null)
            setView({ name: 'edit', id: null, type })
          }}
          onCopy={copy}
          onLock={() => void window.nemo.kyprLock().then(reload)}
        />
      ) : view.name === 'detail' ? (
        <KyprDetail
          id={view.id}
          readOnly={status.readOnly}
          onCopy={copy}
          onBack={() => {
            setView({ name: 'list' })
            reload()
          }}
          onEdit={(type) => setView({ name: 'edit', id: view.id, type })}
        />
      ) : (
        <KyprEditor
          id={view.id}
          type={view.type}
          onCancel={() => setView(view.id ? { name: 'detail', id: view.id } : { name: 'list' })}
          onSaved={(id) => {
            reload()
            setView({ name: 'detail', id })
          }}
        />
      )}
      {toast ? (
        <div key={toast.n} className="kypr-toast" role="status">
          <KyprIcon name="check" size={14} />
          {toast.text}
        </div>
      ) : null}
    </div>
  )
}

function KyprRow({
  item,
  selected,
  onOpen,
  onFill,
  onCopy
}: {
  item: KyprSummary
  selected: boolean
  onOpen: (id: string) => void
  onFill?: (id: string) => void
  onCopy: (id: string, field: string) => void
}): React.JSX.Element {
  const live = !item.deleted
  const copyButton = (field: string, icon: KyprIconName, title: string): React.JSX.Element => (
    <button
      type="button"
      className="icon"
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onCopy(item.id, field)
      }}
    >
      <KyprIcon name={icon} />
    </button>
  )
  return (
    <div
      className={`kypr-row${selected ? ' sel' : ''}${item.deleted ? ' deleted' : ''}`}
      data-kypr-id={item.id}
      title="開く"
      onClick={() => onOpen(item.id)}
    >
      <Avatar kind={item.kind} name={item.name} host={item.host} />
      <span className="kypr-row-text">
        <span className="kypr-row-name">{item.name || '（名前なし）'}</span>
        <span className="kypr-row-sub">{item.subtitle || item.host || KIND_LABEL[item.kind]}</span>
      </span>
      <span className="kypr-row-acts">
        {item.kind === 'login' && live ? (
          <>
            {copyButton('username', 'user', 'ユーザー名をコピー')}
            {copyButton('password', 'key', 'パスワードをコピー（30 秒で消えます）')}
          </>
        ) : null}
        {item.kind === 'card' && live
          ? copyButton('number', 'copy', 'カード番号をコピー（30 秒で消えます）')
          : null}
      </span>
      {onFill ? (
        <button
          type="button"
          className="kypr-fill"
          title="このページに入力（↵）"
          onClick={(event) => {
            event.stopPropagation()
            onFill(item.id)
          }}
        >
          入力
        </button>
      ) : null}
    </div>
  )
}

/** ポップアップの中だけで開く小さいメニュー（ネイティブの `<select>` は使わない。開くと View のフォーカスが外れうる）。 */
function KyprMenu({
  open,
  onClose,
  children
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className="kypr-menu" role="menu">
      {children}
    </div>
  )
}

function KyprList({
  data,
  message,
  onOpen,
  onFill,
  onNew,
  onCopy,
  onLock
}: {
  data: KyprPanelData
  message: string | null
  onOpen: (id: string) => void
  onFill: (id: string) => void
  onNew: (type: 'login' | 'card' | 'note') => void
  onCopy: (id: string, field: string) => void
  onLock: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<'filter' | 'new' | null>(null)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.items.filter((item) => {
      if (filter === 'trash' ? !item.deleted : item.deleted) return false
      if (filter !== 'all' && filter !== 'trash' && item.kind !== filter) return false
      if (!q) return true
      return [item.name, item.subtitle, item.host ?? ''].some((text) => text.toLowerCase().includes(q))
    })
  }, [data.items, query, filter])

  // 検索中は「このページ」のカードを畳む（検索の結果だけを見せる）
  const showPage = data.page !== null && query.trim() === ''
  const matches = showPage ? data.matches : []
  const shown = items.slice(0, 200)
  const rowCount = matches.length + shown.length
  const selected = Math.min(sel, Math.max(rowCount - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector('.kypr-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSel(Math.max(0, Math.min(rowCount - 1, selected + step)))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (selected < matches.length) onFill(matches[selected].id)
      else {
        const item = shown[selected - matches.length]
        if (item) onOpen(item.id)
      }
    }
  }

  const readOnly = data.status.readOnly
  return (
    <div className="kypr-list">
      <div className="kypr-scroll" ref={listRef}>
        {showPage && data.page ? (
          <section className="kypr-hero">
            <div className="kypr-hero-site">
              <Avatar kind="login" name={data.page.host} host={data.page.host} size="sm" />
              <span className="kypr-row-text">
                <span className="kypr-hero-host">{data.page.host}</span>
                <span className="kypr-row-sub">
                  {matches.length > 0 ? `一致 ${matches.length} 件 · ↵ で 1 件目を入力` : '一致 0 件'}
                </span>
              </span>
            </div>
            {matches.length === 0 ? (
              <div className="kypr-hero-none">
                <span>このサイトのログインはまだありません。</span>
                {readOnly ? null : (
                  <button type="button" className="kypr-btn" onClick={() => onNew('login')}>
                    <KyprIcon name="plus" size={14} />
                    保存
                  </button>
                )}
              </div>
            ) : (
              matches.map((item, i) => (
                <KyprRow
                  key={item.id}
                  item={item}
                  selected={selected === i}
                  onOpen={onOpen}
                  onFill={onFill}
                  onCopy={onCopy}
                />
              ))
            )}
          </section>
        ) : null}
        {message ? <p className="kypr-error kypr-pad">{message}</p> : null}
        <div className="kypr-bar">
          <label className="kypr-search">
            <KyprIcon name="search" />
            <input
              ref={inputRef}
              value={query}
              placeholder="すべてから検索"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value)
                setSel(0)
              }}
              onKeyDown={onKeyDown}
            />
          </label>
          <div className="kypr-menu-anchor">
            <button
              type="button"
              className="kypr-select"
              aria-haspopup="menu"
              onClick={() => setMenu((m) => (m === 'filter' ? null : 'filter'))}
            >
              {FILTER_LABEL[filter]}
              <KyprIcon name="chevron" size={14} />
            </button>
            <KyprMenu open={menu === 'filter'} onClose={closeMenu}>
              {FILTERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filter === id}
                  className={`kypr-menu-item${filter === id ? ' on' : ''}`}
                  onClick={() => {
                    setFilter(id)
                    setSel(0)
                    setMenu(null)
                    inputRef.current?.focus()
                  }}
                >
                  {label}
                  {filter === id ? <KyprIcon name="check" size={14} /> : null}
                </button>
              ))}
            </KyprMenu>
          </div>
          <div className="kypr-menu-anchor">
            <button
              type="button"
              className="icon"
              disabled={readOnly}
              title={readOnly ? '読み取り専用で開いています' : '新規作成'}
              onClick={() => setMenu((m) => (m === 'new' ? null : 'new'))}
            >
              <KyprIcon name="plus" />
            </button>
            <KyprMenu open={menu === 'new'} onClose={closeMenu}>
              {(['login', 'card', 'note'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  role="menuitem"
                  className="kypr-menu-item"
                  onClick={() => {
                    setMenu(null)
                    onNew(type)
                  }}
                >
                  {KIND_LABEL[type]}
                </button>
              ))}
            </KyprMenu>
          </div>
        </div>
        <div className="kypr-section-label">
          {FILTER_LABEL[filter]}
          <span className="kypr-count">{items.length}</span>
        </div>
        {items.length === 0 ? <p className="kypr-note kypr-pad">見つかりません。</p> : null}
        {shown.map((item, i) => (
          <KyprRow
            key={item.id}
            item={item}
            selected={selected === matches.length + i}
            onOpen={onOpen}
            onCopy={onCopy}
          />
        ))}
      </div>
      <div className="kypr-foot">
        <span className="kypr-brand">
          <KyprMark size="xs" />
          kypr
        </span>
        <span>
          <b>↑↓</b> 選択
        </span>
        <span>
          <b>↵</b> {matches.length > 0 && selected < matches.length ? '入力' : '開く'}
        </span>
        {readOnly ? <span className="kypr-tag">読み取り専用</span> : null}
        <span className="spacer" />
        <button type="button" className="icon" title="ロックする" onClick={onLock}>
          <KyprIcon name="lock" />
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 詳細
 * ------------------------------------------------------------------ */

const FIELD_LABEL: Record<string, string> = {
  username: 'ユーザー名',
  password: 'パスワード',
  cardholderName: '名義',
  brand: 'ブランド',
  number: 'カード番号',
  expiry: '有効期限',
  code: 'セキュリティコード',
  notes: 'メモ'
}
const SECRET_FIELDS = new Set(['password', 'number', 'code'])
const COPYABLE_FIELDS = new Set(['username', 'password', 'number', 'code', 'expiry', 'cardholderName'])

function KyprDetail({
  id,
  readOnly,
  onCopy,
  onBack,
  onEdit
}: {
  id: string
  readOnly: boolean
  onCopy: (id: string, field: string) => void
  onBack: () => void
  onEdit: (type: 'login' | 'card' | 'note') => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<KyprItemDetail | null | undefined>(undefined)
  /** 「表示」で main から取った秘密の項目（閉じたら捨てる。詳細は秘密を空にして受け取る）。 */
  const [revealed, setRevealed] = useState<Map<string, string>>(new Map())
  const [message, setMessage] = useState<string | null>(null)
  const [purgeArmed, setPurgeArmed] = useState(false)

  const load = useCallback(() => {
    void window.nemo.kyprItem(id).then(setDetail)
  }, [id])
  useEffect(load, [load])

  // Esc は一覧へ戻る（ポップアップは閉じない）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  if (detail === undefined) return <div className="empty">読み込み中…</div>
  if (detail === null) {
    return (
      <div className="kypr-body">
        <p className="kypr-note">見つかりません（削除されたかもしれません）。</p>
        <button type="button" className="kypr-btn" onClick={onBack}>
          <KyprIcon name="back" size={14} />
          一覧へ
        </button>
      </div>
    )
  }
  const item = detail.item ?? {}
  const str = (key: string): string => {
    const value = item[key]
    return typeof value === 'string' ? value : ''
  }
  const fields: { key: string; value: string }[] = []
  if (detail.kind === 'login') {
    fields.push({ key: 'username', value: str('username') }, { key: 'password', value: str('password') })
  } else if (detail.kind === 'card') {
    const month = str('expMonth')
    const year = str('expYear')
    fields.push(
      { key: 'cardholderName', value: str('cardholderName') },
      { key: 'brand', value: str('brand') },
      { key: 'number', value: str('number') },
      {
        key: 'expiry',
        value: [month.padStart(2, '0'), year.slice(-2)].filter((v) => v && v !== '00').join('/')
      },
      { key: 'code', value: str('code') }
    )
  }
  const uris = (
    detail.kind === 'login' && Array.isArray(item['uris']) ? (item['uris'] as { uri?: unknown }[]) : []
  )
    .map((u) => (typeof u.uri === 'string' ? u.uri : ''))
    .filter(Boolean)
  const host = uris[0] ? hostOfUri(uris[0]) : null
  const act = (run: () => Promise<KyprActionResult>, after?: () => void): void => {
    setMessage(null)
    void run().then((result) => {
      if (result.ok) {
        if (after) after()
        else load()
      } else setMessage(actionFailureText(result))
    })
  }
  const editable = detail.editable && !readOnly
  const visibleFields = fields.filter((f) => f.value !== '' || detail.secrets.includes(f.key))

  return (
    <div className="kypr-body kypr-detail">
      <div className="kypr-detail-head">
        <button type="button" className="icon" title="一覧へ（Esc）" onClick={onBack}>
          <KyprIcon name="back" />
        </button>
        <span className="spacer" />
        {editable && !detail.deleted ? (
          <button
            type="button"
            className="kypr-btn"
            onClick={() => onEdit(detail.kind as 'login' | 'card' | 'note')}
          >
            編集
          </button>
        ) : null}
        {!readOnly && !detail.deleted ? (
          <button
            type="button"
            className="icon"
            title="ゴミ箱へ"
            onClick={() => act(() => window.nemo.kyprTrash(detail.id))}
          >
            <KyprIcon name="trash" />
          </button>
        ) : null}
      </div>
      <div className="kypr-detail-hero">
        <Avatar kind={detail.kind} name={str('name')} host={host} size="lg" />
        <span className="kypr-row-text">
          <span className="kypr-detail-name">{str('name') || '（名前なし）'}</span>
          <span className="kypr-row-sub">
            {host ?? KIND_LABEL[detail.kind]}
            {detail.deleted ? <span className="kypr-tag warn">ゴミ箱</span> : null}
          </span>
        </span>
      </div>
      {detail.error ? <p className="kypr-error">このアイテムは開けません（{detail.error}）。</p> : null}
      {detail.kind === 'unknown' ? (
        <p className="kypr-note">この版の Nemo が知らない種類です（読み取り専用）。</p>
      ) : null}
      {visibleFields.length > 0 || uris.length > 0 || str('notes') ? (
        <div className="kypr-fields">
          {visibleFields.map((f) => {
            const secret = SECRET_FIELDS.has(f.key)
            const visible = !secret || revealed.has(f.key)
            return (
              <div key={f.key} className="kypr-field">
                <span className="kypr-field-text">
                  <span className="kypr-field-label">{FIELD_LABEL[f.key]}</span>
                  <span className={`kypr-field-value${secret ? ' mono' : ''}`}>
                    {!secret ? f.value : visible ? revealed.get(f.key) : '••••••••••'}
                  </span>
                </span>
                {secret ? (
                  <button
                    type="button"
                    className="icon"
                    title={visible ? '隠す' : '表示'}
                    onClick={() => {
                      if (revealed.has(f.key)) {
                        setRevealed((prev) => {
                          const next = new Map(prev)
                          next.delete(f.key)
                          return next
                        })
                        return
                      }
                      void window.nemo.kyprReveal(detail.id, f.key).then((value) => {
                        if (value === null) return
                        setRevealed((prev) => new Map(prev).set(f.key, value))
                      })
                    }}
                  >
                    <KyprIcon name={visible ? 'eyeOff' : 'eye'} />
                  </button>
                ) : null}
                {COPYABLE_FIELDS.has(f.key) ? (
                  <button
                    type="button"
                    className="icon"
                    title="コピー（30 秒で消えます）"
                    onClick={() => onCopy(detail.id, f.key)}
                  >
                    <KyprIcon name="copy" />
                  </button>
                ) : null}
              </div>
            )
          })}
          {uris.length > 0 ? (
            <div className="kypr-field">
              <span className="kypr-field-text">
                <span className="kypr-field-label">URL</span>
                {uris.map((uri, i) => (
                  <span key={i} className="kypr-field-value kypr-uri">
                    {uri}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {str('notes') ? (
            <div className="kypr-field notes">
              <span className="kypr-field-text">
                <span className="kypr-field-label">メモ</span>
                <span className="kypr-field-value pre">{str('notes')}</span>
              </span>
              {detail.kind === 'note' ? (
                <button
                  type="button"
                  className="icon"
                  title="コピー（30 秒で消えます）"
                  onClick={() => onCopy(detail.id, 'notes')}
                >
                  <KyprIcon name="copy" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {message ? <p className="kypr-error">{message}</p> : null}
      <div className="kypr-actions">
        {detail.kind === 'login' && !detail.deleted ? (
          <button
            type="button"
            className="kypr-primary"
            onClick={() =>
              act(
                () => window.nemo.kyprFill(detail.id),
                () => {}
              )
            }
          >
            このページに入力
          </button>
        ) : null}
        {!readOnly && detail.deleted ? (
          <>
            <button
              type="button"
              className="kypr-btn"
              onClick={() => act(() => window.nemo.kyprRestore(detail.id))}
            >
              元に戻す
            </button>
            <button
              type="button"
              className="kypr-btn danger"
              onClick={() => {
                if (!purgeArmed) {
                  setPurgeArmed(true)
                  return
                }
                act(() => window.nemo.kyprPurge(detail.id), onBack)
              }}
            >
              {purgeArmed ? '本当に完全に削除する（取り消せません）' : '完全に削除'}
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 作成・編集
 * ------------------------------------------------------------------ */

const EDIT_FIELDS: Record<
  'login' | 'card' | 'note',
  { key: string; label: string; secret?: boolean; multiline?: boolean }[]
> = {
  login: [
    { key: 'name', label: '名前' },
    { key: 'username', label: 'ユーザー名' },
    { key: 'password', label: 'パスワード', secret: true },
    { key: 'uri', label: 'URL' },
    { key: 'notes', label: 'メモ', multiline: true }
  ],
  card: [
    { key: 'name', label: '名前' },
    { key: 'cardholderName', label: '名義' },
    { key: 'brand', label: 'ブランド' },
    { key: 'number', label: 'カード番号', secret: true },
    { key: 'expMonth', label: '有効期限（月）' },
    { key: 'expYear', label: '有効期限（年）' },
    { key: 'code', label: 'セキュリティコード', secret: true },
    { key: 'notes', label: 'メモ', multiline: true }
  ],
  note: [
    { key: 'name', label: '名前' },
    { key: 'notes', label: '本文', multiline: true }
  ]
}

function KyprEditor({
  id,
  type,
  onCancel,
  onSaved
}: {
  id: string | null
  type: 'login' | 'card' | 'note'
  onCancel: () => void
  onSaved: (id: string) => void
}): React.JSX.Element {
  // 既存の編集と新規のログインは main から読んでから埋める。カード・メモの新規は空で始める
  const [values, setValues] = useState<Record<string, string> | null>(() =>
    id || type === 'login' ? null : Object.fromEntries(EDIT_FIELDS[type].map((f) => [f.key, '']))
  )
  /** 2 つ目以降の URI（編集画面は最初の 1 つだけ編集する。残りはそのまま保つ）。 */
  const [otherUris, setOtherUris] = useState<unknown[]>([])
  /** 最初の URI の元の要素（`match` と知らないキーを保つため。uri だけ差し替えて返す）。新規は `match: null`。 */
  const [firstUri, setFirstUri] = useState<Record<string, unknown>>({ match: null })
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** 他の端末で更新されていた（409）ときに、最新の内容で読み直すための合図。 */
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (id) {
      // 編集は秘密の項目も含めて受け取る（詳細とは別の口）
      void window.nemo.kyprItemForEdit(id).then((detail) => {
        if (cancelled || !detail?.item) return
        const item = detail.item
        const next: Record<string, string> = {}
        for (const f of EDIT_FIELDS[type]) {
          if (f.key === 'uri') continue
          const value = item[f.key]
          next[f.key] = typeof value === 'string' ? value : ''
        }
        const uris = Array.isArray(item['uris']) ? (item['uris'] as Record<string, unknown>[]) : []
        const first = uris[0]
        next['uri'] = typeof first?.['uri'] === 'string' ? first['uri'] : ''
        setFirstUri(first ? { ...first } : { match: null })
        setOtherUris(uris.slice(1))
        setValues(next)
      })
    } else if (type === 'login') {
      // 新規のログインは今のページから下書きを作る（URL・名前と、ログイン欄にいま入っている値）
      void window.nemo.kyprDraft().then((draft) => {
        if (cancelled) return
        setValues({
          name: draft.name,
          username: draft.username,
          password: draft.password,
          uri: draft.uri,
          notes: ''
        })
      })
    }
    return () => {
      cancelled = true
    }
  }, [id, type, reloadTick])

  if (!values) return <div className="empty">読み込み中…</div>

  const set = (key: string, value: string): void => setValues((prev) => ({ ...(prev ?? {}), [key]: value }))
  const save = (): void => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const fields: Record<string, unknown> = { ...values }
    if (type === 'login') {
      delete fields['uri']
      const first = values['uri']?.trim() ? [{ ...firstUri, uri: values['uri'].trim() }] : []
      fields['uris'] = [...first, ...otherUris]
    }
    void window.nemo
      .kyprSave({ id, type, fields })
      .then((result) => {
        if (result.ok && result.id) onSaved(result.id)
        else {
          setMessage(actionFailureText(result))
          // 古い入力のまま保存し直すと、他の端末の変更を上書きする。最新の内容で読み直して見てもらう
          if (!result.ok && result.reason === 'conflict') setReloadTick((n) => n + 1)
        }
      })
      .finally(() => setBusy(false))
  }
  const generate = (): void => {
    void window.nemo.kyprGeneratePassword(20, ['lower', 'upper', 'digits', 'symbols']).then((pw) => {
      set('password', pw)
      setShown(true)
    })
  }

  return (
    <form
      className="kypr-body kypr-editor"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div className="kypr-detail-head">
        <button type="button" className="icon" title="やめる" onClick={onCancel}>
          <KyprIcon name="back" />
        </button>
        <span className="kypr-editor-title">{id ? '編集' : `新規（${KIND_LABEL[type]}）`}</span>
      </div>
      {EDIT_FIELDS[type].map((f) => (
        <label key={f.key} className="kypr-edit-field">
          <span className="kypr-field-label">{f.label}</span>
          {f.multiline ? (
            <textarea
              value={values[f.key] ?? ''}
              rows={4}
              spellCheck={false}
              onChange={(event) => set(f.key, event.target.value)}
            />
          ) : (
            <span className="kypr-edit-input">
              <input
                name={`kypr-${f.key}`}
                type={f.secret && !shown ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => set(f.key, event.target.value)}
              />
              {f.key === 'password' ? (
                <button type="button" className="icon" title="強いパスワードを生成" onClick={generate}>
                  <KyprIcon name="dice" />
                </button>
              ) : null}
              {f.secret ? (
                <button
                  type="button"
                  className="icon"
                  title={shown ? '隠す' : '表示'}
                  onClick={() => setShown((v) => !v)}
                >
                  <KyprIcon name={shown ? 'eyeOff' : 'eye'} />
                </button>
              ) : null}
            </span>
          )}
        </label>
      ))}
      {message ? <p className="kypr-error">{message}</p> : null}
      <div className="kypr-actions">
        <button type="submit" className="kypr-primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="kypr-btn" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------ *
 * ログイン欄の下の候補
 * ------------------------------------------------------------------ */

/** 出た直後のクリックを無視する時間（ページが欄を動かして、候補を押させる手口の対策。Chrome と同じ）。 */
const INLINE_GUARD_MS = 500
const isGuarded = (shownAt: number): boolean => Date.now() - shownAt < INLINE_GUARD_MS

export function KyprInline(): React.JSX.Element | null {
  const [state, setState] = useState<KyprInlineState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.nemo.kyprInlineState().then((next) => {
      setState(next)
      setMessage(null)
    })
  }, [])
  useEffect(load, [load])
  useEffect(() => window.nemo.onKyprInline(load), [load])

  if (!state) return null
  const guarded = (): boolean => isGuarded(state.shownAt)

  if (state.locked) {
    return (
      <div className="kypr-inline">
        <button
          type="button"
          className="kypr-inline-row"
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (guarded() || busy) return
            setBusy(true)
            void window.nemo
              .kyprUnlockTouchId()
              .then((result) => {
                if (result.ok) {
                  // 解除できたら候補を出し直すため、いったん閉じる（欄をもう一度押すと出る）
                  void window.nemo.kyprInlineDismiss()
                } else {
                  // Touch ID が使えない・通らないときは、ポップアップでマスターパスワードを入れてもらう
                  void window.nemo.setOverlay('kypr')
                }
              })
              .finally(() => setBusy(false))
          }}
        >
          <KyprMark size="sm" locked />
          <span className="kypr-row-text">
            <span className="kypr-row-name">kypr のロックを解除</span>
            <span className="kypr-row-sub">{busy ? '解除中…' : 'Touch ID'}</span>
          </span>
        </button>
      </div>
    )
  }
  return (
    <div className="kypr-inline">
      {state.rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="kypr-inline-row"
          data-kypr-id={row.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (guarded()) return
            void window.nemo.kyprInlinePick(row.id).then((result) => setMessage(actionFailureText(result)))
          }}
        >
          <Avatar kind={row.kind} name={row.name} host={row.host} size="sm" />
          <span className="kypr-row-text">
            <span className="kypr-row-name">{row.name || '（名前なし）'}</span>
            <span className="kypr-row-sub">{row.subtitle}</span>
          </span>
        </button>
      ))}
      {message ? <p className="kypr-error">{message}</p> : null}
    </div>
  )
}
