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
 * 解除
 * ------------------------------------------------------------------ */

export function KyprUnlock({
  status,
  onDone
}: {
  status: KyprStatus
  onDone: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const signedOut = status.state === 'signed-out'

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
    <div className="kypr-unlock">
      <p className="kypr-note">
        {signedOut
          ? 'kypr の保管庫にログインします。Web で作った保管庫のマスターパスワードを入れてください。'
          : 'kypr はロックされています。'}
      </p>
      {!signedOut && status.touchIdEnrolled && status.touchIdAvailable ? (
        <button type="button" className="btn primary kypr-touchid" disabled={busy} onClick={touchId}>
          Touch ID で解除
        </button>
      ) : null}
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
 * ------------------------------------------------------------------ */

type View =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'edit'; id: string | null; type: 'login' | 'card' | 'note' }

type Filter = 'all' | 'login' | 'card' | 'note' | 'trash'

export function KyprPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<KyprPanelData | null>(null)
  const [view, setView] = useState<View>({ name: 'list' })
  const [message, setMessage] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.nemo.kyprPanel().then(setData)
  }, [])
  useEffect(reload, [reload])

  const status = data?.status
  return (
    <div className="panel kypr-panel">
      <div className="panel-head">
        <span className="kypr-title">kypr</span>
        {status?.readOnly ? <span className="kypr-tag">読み取り専用</span> : null}
        <div className="spacer" />
        {status?.state === 'unlocked' ? (
          <button
            type="button"
            className="icon"
            title="ロックする"
            onClick={() => void window.nemo.kyprLock().then(reload)}
          >
            🔒
          </button>
        ) : null}
        <button type="button" className="icon" title="閉じる（Esc）" onClick={onClose}>
          ×
        </button>
      </div>
      {!data || !status ? (
        <div className="empty">読み込み中…</div>
      ) : status.state !== 'unlocked' ? (
        <div className="kypr-body">
          <KyprUnlock status={status} onDone={reload} />
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
        />
      ) : view.name === 'detail' ? (
        <KyprDetail
          id={view.id}
          readOnly={status.readOnly}
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
    </div>
  )
}

function KyprRow({
  item,
  onOpen,
  onFill
}: {
  item: KyprSummary
  onOpen: (id: string) => void
  onFill?: (id: string) => void
}): React.JSX.Element {
  return (
    <div className={`kypr-row${item.deleted ? ' deleted' : ''}`}>
      <button
        type="button"
        className="kypr-row-main"
        data-kypr-id={item.id}
        onClick={() => (onFill ? onFill(item.id) : onOpen(item.id))}
        title={onFill ? 'このページに入力する' : '開く'}
      >
        <span className={`kypr-kind ${item.kind}`}>{kindGlyph(item.kind)}</span>
        <span className="kypr-row-text">
          <span className="kypr-row-name">{item.name || '（名前なし）'}</span>
          <span className="kypr-row-sub">{item.subtitle || item.host || KIND_LABEL[item.kind]}</span>
        </span>
      </button>
      {item.kind === 'login' && !item.deleted ? (
        <>
          <button
            type="button"
            className="icon"
            title="ユーザー名をコピー"
            onClick={() => void window.nemo.kyprCopy(item.id, 'username')}
          >
            👤
          </button>
          <button
            type="button"
            className="icon"
            title="パスワードをコピー（30 秒で消えます）"
            onClick={() => void window.nemo.kyprCopy(item.id, 'password')}
          >
            🔑
          </button>
        </>
      ) : null}
      <button type="button" className="icon" title="開く" onClick={() => onOpen(item.id)}>
        ›
      </button>
    </div>
  )
}

function kindGlyph(kind: KyprSummary['kind']): string {
  if (kind === 'login') return '🔑'
  if (kind === 'card') return '💳'
  if (kind === 'note') return '📝'
  return '？'
}

function KyprList({
  data,
  message,
  onOpen,
  onFill,
  onNew
}: {
  data: KyprPanelData
  message: string | null
  onOpen: (id: string) => void
  onFill: (id: string) => void
  onNew: (type: 'login' | 'card' | 'note') => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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

  const readOnly = data.status.readOnly
  return (
    <div className="kypr-body">
      {data.page ? (
        <section className="kypr-section">
          <h4>このページ（{data.page.host}）</h4>
          {data.matches.length === 0 ? (
            <p className="kypr-note">このページに合うログインはありません。</p>
          ) : (
            data.matches.map((item) => <KyprRow key={item.id} item={item} onOpen={onOpen} onFill={onFill} />)
          )}
        </section>
      ) : null}
      {message ? <p className="kypr-error">{message}</p> : null}
      <div className="kypr-search">
        <input
          ref={inputRef}
          value={query}
          placeholder="検索（名前・ユーザー名・URL）"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={readOnly}
          title={readOnly ? '読み取り専用で開いています' : '新規作成'}
          onClick={() => setCreating((v) => !v)}
        >
          ＋ 新規
        </button>
      </div>
      {creating ? (
        <div className="kypr-new">
          {(['login', 'card', 'note'] as const).map((type) => (
            <button key={type} type="button" className="btn" onClick={() => onNew(type)}>
              {KIND_LABEL[type]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="kypr-filters">
        {(
          [
            ['all', 'すべて'],
            ['login', 'ログイン'],
            ['card', 'カード'],
            ['note', 'メモ'],
            ['trash', 'ゴミ箱']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`kypr-filter${filter === id ? ' on' : ''}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="kypr-section kypr-all">
        {items.length === 0 ? <p className="kypr-note">見つかりません。</p> : null}
        {items.slice(0, 200).map((item) => (
          <KyprRow key={item.id} item={item} onOpen={onOpen} />
        ))}
      </section>
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

function KyprDetail({
  id,
  readOnly,
  onBack,
  onEdit
}: {
  id: string
  readOnly: boolean
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

  if (detail === undefined) return <div className="empty">読み込み中…</div>
  if (detail === null) {
    return (
      <div className="kypr-body">
        <p className="kypr-note">見つかりません（削除されたかもしれません）。</p>
        <button type="button" className="btn" onClick={onBack}>
          ‹ 一覧へ
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
  const uris =
    detail.kind === 'login' && Array.isArray(item['uris']) ? (item['uris'] as { uri?: unknown }[]) : []
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

  return (
    <div className="kypr-body">
      <div className="kypr-detail-head">
        <button type="button" className="icon" title="一覧へ" onClick={onBack}>
          ‹
        </button>
        <span className="kypr-detail-name">{str('name') || '（名前なし）'}</span>
        <span className="kypr-tag">{KIND_LABEL[detail.kind]}</span>
        {detail.deleted ? <span className="kypr-tag warn">ゴミ箱</span> : null}
      </div>
      {detail.error ? <p className="kypr-error">このアイテムは開けません（{detail.error}）。</p> : null}
      {detail.kind === 'unknown' ? (
        <p className="kypr-note">この版の Nemo が知らない種類です（読み取り専用）。</p>
      ) : null}
      {fields
        .filter((f) => f.value !== '' || detail.secrets.includes(f.key))
        .map((f) => {
          const secret = SECRET_FIELDS.has(f.key)
          const visible = !secret || revealed.has(f.key)
          return (
            <div key={f.key} className="kypr-field">
              <span className="kypr-field-label">{FIELD_LABEL[f.key]}</span>
              <span className={`kypr-field-value${secret ? ' mono' : ''}`}>
                {!secret ? f.value : visible ? revealed.get(f.key) : '••••••••'}
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
                  {visible ? '◡' : '👁'}
                </button>
              ) : null}
              {['username', 'password', 'number', 'code', 'expiry', 'cardholderName'].includes(f.key) ? (
                <button
                  type="button"
                  className="icon"
                  title="コピー（30 秒で消えます）"
                  onClick={() => void window.nemo.kyprCopy(detail.id, f.key)}
                >
                  ⧉
                </button>
              ) : null}
            </div>
          )
        })}
      {uris.length > 0 ? (
        <div className="kypr-field">
          <span className="kypr-field-label">URL</span>
          <span className="kypr-field-value">
            {uris.map((u, i) => (
              <span key={i} className="kypr-uri">
                {typeof u.uri === 'string' ? u.uri : ''}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {str('notes') ? (
        <div className="kypr-field notes">
          <span className="kypr-field-label">メモ</span>
          <span className="kypr-field-value pre">{str('notes')}</span>
          {detail.kind === 'note' ? (
            <button
              type="button"
              className="icon"
              title="コピー（30 秒で消えます）"
              onClick={() => void window.nemo.kyprCopy(detail.id, 'notes')}
            >
              ⧉
            </button>
          ) : null}
        </div>
      ) : null}
      {message ? <p className="kypr-error">{message}</p> : null}
      <div className="kypr-actions">
        {detail.kind === 'login' && !detail.deleted ? (
          <button
            type="button"
            className="btn primary"
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
        {editable && !detail.deleted ? (
          <button
            type="button"
            className="btn"
            onClick={() => onEdit(detail.kind as 'login' | 'card' | 'note')}
          >
            編集
          </button>
        ) : null}
        {!readOnly && !detail.deleted ? (
          <button type="button" className="btn" onClick={() => act(() => window.nemo.kyprTrash(detail.id))}>
            ゴミ箱へ
          </button>
        ) : null}
        {!readOnly && detail.deleted ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => act(() => window.nemo.kyprRestore(detail.id))}
            >
              元に戻す
            </button>
            <button
              type="button"
              className="btn danger"
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
          ‹
        </button>
        <span className="kypr-detail-name">{id ? '編集' : `新規（${KIND_LABEL[type]}）`}</span>
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
                  ⚄
                </button>
              ) : null}
              {f.secret ? (
                <button
                  type="button"
                  className="icon"
                  title={shown ? '隠す' : '表示'}
                  onClick={() => setShown((v) => !v)}
                >
                  {shown ? '◡' : '👁'}
                </button>
              ) : null}
            </span>
          )}
        </label>
      ))}
      {message ? <p className="kypr-error">{message}</p> : null}
      <div className="kypr-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
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
          <span className="kypr-kind">🔒</span>
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
          <span className="kypr-kind">🔑</span>
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
