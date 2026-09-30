import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KyprActionResult,
  KyprInlineState,
  KyprItemDetail,
  KyprNoteField,
  KyprPanelData,
  KyprStatus,
  KyprSummary,
  KyprTotpCheck,
  KyprTotpCode,
  KyprTotpDraft,
  KyprTotpQrResult,
  KyprUnlockFailure
} from '../../shared/types.js'
import {
  GENDER_LABELS,
  MAX_PROFILE_VALUE,
  PROFILE_FIELDS,
  isValidDate
} from '../../shared/autofill-schema.js'

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
  identity: '個人情報',
  totp: 'ワンタイムコード',
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
    case 'device-required':
      return 'この Mac は kypr に登録されていません。マスターパスワードに加えて合言葉を入れてください。'
    case 'disabled':
      return 'kypr は使えません。'
    default:
      return '解除できませんでした。もう一度試してください。'
  }
}

/** Claude のウィンドウで、Claude が JS を実行したページ（`agent/fill-gate.ts`）。 */
const AGENT_SCRIPT_TEXT =
  'このページでは Claude がスクリプトを実行したため入力できません。新しいタブで開き直してから入力してください。'

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
    case 'agent-script':
      return AGENT_SCRIPT_TEXT
    case 'agent-page':
      return 'このページの状態を確かめられないため入力しませんでした。少し待ってからもう一度試してください。'
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
  identity: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <circle cx="8.5" cy="10.5" r="2.5" />
      <path d="M5 16.5a3.5 3.5 0 0 1 7 0" />
      <path d="M14.5 10h4M14.5 14h4" />
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
  check: <path d="m5 12 5 5 9-10" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" />
    </>
  )
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
 * アイテムのアイコン。ログインは favicon があればそれ、無ければ頭文字。
 * favicon は main が**履歴にあるホストだけ**付けてくる（`withKyprFavicons`）。保管庫のホストから URL を推測して
 * 取りに行かない（どのサイトを使っているかが外に漏れる）。表示のときは、開いたことのあるサイトが申告した URL へ通信が出る。
 * 頭文字の色の決め方は Web 版の `Avatar` と同じ（ドメイン、無ければ名前から）で、同じアイテムが Web と同じ色になる
 */
function Avatar({
  kind,
  name,
  host,
  favicon,
  size = 'md'
}: {
  kind: KyprSummary['kind']
  name: string
  host: string | null
  favicon?: string | null
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  // 失敗した src を覚える（`Favicon` と同じ。真偽値だと src が変わっても失敗のままになる）
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (kind === 'login' && favicon && failedSrc !== favicon) {
    return (
      <span className={`kypr-av ${size} fav`} aria-hidden="true">
        <img src={favicon} alt="" draggable={false} onError={() => setFailedSrc(favicon)} />
      </span>
    )
  }
  const iconSize = size === 'lg' ? 22 : size === 'sm' ? 12 : 16
  if (kind === 'card' || kind === 'note' || kind === 'identity' || kind === 'totp') {
    return (
      <span className={`kypr-av ${size} ${kind}`} aria-hidden="true">
        <KyprIcon name={kind === 'totp' ? 'clock' : kind} size={iconSize} />
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
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const signedOut = status.state === 'signed-out'
  const canTouchId = !signedOut && status.touchIdEnrolled && status.touchIdAvailable
  // この Mac が kypr に登録されていない（合言葉が設定済み）。合言葉を入れて入ると、この Mac を登録する
  const needsPassphrase = status.needsPassphrase

  useEffect(() => inputRef.current?.focus(), [])

  const signIn = (): void => {
    if (!password || busy || (needsPassphrase && !passphrase)) return
    setBusy(true)
    setMessage(null)
    void window.nemo
      .kyprSignIn(password, remember, needsPassphrase ? passphrase : undefined)
      .then((result) => {
        if (result.ok) {
          setPassword('')
          setPassphrase('')
          onDone()
        } else if (result.reason === 'device-required') {
          // 合言葉の欄を出す（状態は main が持つので読み直す）。マスターパスワードは残す
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
        // device-required は合言葉の欄の案内が出るので、同じ文言を重ねない
        if (result.ok || result.reason === 'device-required') onDone()
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
      {needsPassphrase ? (
        <p className="kypr-note kypr-passphrase-note">
          この Mac は kypr
          に登録されていません。マスターパスワードに加えて合言葉を入れてください。入れると、この Mac
          を登録します。
        </p>
      ) : null}
      <form
        className={`kypr-password${needsPassphrase ? ' stacked' : ''}`}
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
        {needsPassphrase ? (
          <input
            className="kypr-passphrase"
            type="password"
            value={passphrase}
            placeholder="合言葉"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        ) : null}
        <button
          type="submit"
          className="btn"
          disabled={!password || (needsPassphrase && !passphrase) || busy}
        >
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

type EditType = 'login' | 'card' | 'note' | 'identity' | 'totp'

type View =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'edit'; id: string | null; type: EditType; draft?: KyprTotpDraft }

/* ---------------- ワンタイムコード ---------------- */

/** 6 桁は 3 + 3、8 桁は 4 + 4 で区切る（kypr の `formatTotpCode` と同じ。renderer は kypr のコードを読まない）。 */
function formatTotp(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`
  return code
}

/** 表示中のワンタイムコードのコードを 1 秒ごとに main に聞く（秘密鍵は main から出さない）。 */
function useTotpCodes(ids: string[]): Record<string, KyprTotpCode> {
  const key = ids.join(',')
  const [codes, setCodes] = useState<Record<string, KyprTotpCode>>({})
  useEffect(() => {
    if (key === '') return
    const list = key.split(',')
    let alive = true
    const tick = (): void => {
      void window.nemo.kyprTotpCodes(list).then((next) => {
        if (alive) setCodes(next)
      })
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [key])
  return codes
}

/** 残り時間の円（残り 5 秒からは赤）。 */
function TotpRing({
  remaining,
  period,
  size = 16
}: {
  remaining: number
  period: number
  size?: number
}): React.JSX.Element {
  return (
    <svg
      className={`kypr-ring${remaining <= 5 ? ' ending' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <circle className="kypr-ring-bg" cx="10" cy="10" r="7" />
      <circle
        className="kypr-ring-fg"
        cx="10"
        cy="10"
        r="7"
        strokeDasharray="44"
        strokeDashoffset={44 * (1 - remaining / Math.max(period, 1))}
      />
    </svg>
  )
}

function qrFailureText(result: KyprTotpQrResult): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'not-found':
      return 'このページの表示中の範囲に QR コードが見つかりません（QR コードが画面に出るまでスクロールしてください）。'
    case 'not-otpauth':
      return 'この QR コードはワンタイムコード（otpauth://totp/）ではありません。'
    case 'no-page':
      return 'このページでは QR コードを読めません。'
    default:
      return 'QR コードを読めませんでした。'
  }
}

type Filter = 'all' | 'login' | 'card' | 'note' | 'identity' | 'trash'

const FILTERS: [Filter, string][] = [
  ['all', 'すべて'],
  ['login', 'ログイン'],
  ['card', 'クレジットカード'],
  ['note', 'セキュアメモ'],
  ['identity', '個人情報'],
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
  notes: '本文',
  secret: '秘密鍵',
  // 個人情報（キーは kypr の平文の名前）
  ...Object.fromEntries(
    PROFILE_FIELDS.map((f) => [
      f.kypr,
      `${f.group === 'パスポート' || f.group === '運転免許証' || f.group === '健康保険証' ? `${f.group}の` : ''}${f.label}`
    ])
  )
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

  const showToast = useCallback((text: string) => {
    setToast((prev) => ({ text, n: (prev?.n ?? 0) + 1 }))
  }, [])
  const copyNoteField = useCallback(
    (id: string, field: KyprNoteField) => {
      void window.nemo
        .kyprCopyNoteField(id, { index: field.index, key: field.key, label: field.label })
        .then((ok) => {
          // 開いてから同期で項目が変わると main が断る（隣の項目の値を出さない）
          showToast(
            ok
              ? `${field.label || '項目'}をコピーしました（30 秒で消えます）`
              : 'この項目は変わりました。開き直してください'
          )
        })
    },
    [showToast]
  )
  const copyTotp = useCallback(
    (id: string) => {
      void window.nemo.kyprCopyTotp(id).then((ok) => {
        if (ok) showToast('コードをコピーしました（30 秒で消えます）')
      })
    },
    [showToast]
  )
  // 入れられない（URL が合わない・欄が無い）ときは main がコピーに回す
  const fillTotp = useCallback(
    (id: string) => {
      setMessage(null)
      void window.nemo.kyprFillTotp(id).then((result) => {
        if (result.ok && result.copied)
          showToast('このページには入れられないので、コードをコピーしました（30 秒で消えます）')
        else setMessage(actionFailureText(result))
      })
    },
    [showToast]
  )
  const readQr = useCallback(() => {
    setMessage(null)
    void window.nemo.kyprTotpFromPageQr().then((result) => {
      if (result.ok) setView({ name: 'edit', id: null, type: 'totp', draft: result.draft })
      else setMessage(qrFailureText(result))
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
          onFillTotp={fillTotp}
          onCopyTotp={copyTotp}
          onReadQr={readQr}
          onLock={() => void window.nemo.kyprLock().then(reload)}
        />
      ) : view.name === 'detail' ? (
        <KyprDetail
          id={view.id}
          favicon={data.items.find((item) => item.id === view.id)?.faviconUrl ?? null}
          readOnly={status.readOnly}
          autofillIdentityId={data.autofillIdentityId}
          onAutofillChanged={reload}
          onCopy={copy}
          onCopyNoteField={copyNoteField}
          onFillTotp={fillTotp}
          onCopyTotp={copyTotp}
          onBack={() => {
            setView({ name: 'list' })
            reload()
          }}
          onEdit={(type) => setView({ name: 'edit', id: view.id, type })}
        />
      ) : view.type === 'totp' ? (
        <KyprTotpEditor
          id={view.id}
          draft={view.draft}
          onCancel={() => setView(view.id ? { name: 'detail', id: view.id } : { name: 'list' })}
          onSaved={(id) => {
            reload()
            setView({ name: 'detail', id })
          }}
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
      <Avatar kind={item.kind} name={item.name} host={item.host} favicon={item.faviconUrl} />
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

/** ワンタイムコードの行。コードを押すとこのページに入れる（入れられなければコピー）。 */
function KyprTotpRow({
  item,
  code,
  selected,
  onOpen,
  onFill,
  onCopy
}: {
  item: KyprSummary
  code: KyprTotpCode | undefined
  selected: boolean
  onOpen: (id: string) => void
  onFill: (id: string) => void
  onCopy: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`kypr-row kypr-totp-row${selected ? ' sel' : ''}`}
      data-kypr-id={item.id}
      title="開く"
      onClick={() => onOpen(item.id)}
    >
      <Avatar kind="totp" name={item.name} host={item.host} />
      <span className="kypr-row-text">
        <span className="kypr-row-name">{item.name || '（名前なし）'}</span>
        <span className="kypr-row-sub">{item.host ?? KIND_LABEL.totp}</span>
      </span>
      <span className="kypr-row-acts">
        <button
          type="button"
          className="icon"
          title="コードをコピー（30 秒で消えます）"
          onClick={(event) => {
            event.stopPropagation()
            onCopy(item.id)
          }}
        >
          <KyprIcon name="copy" />
        </button>
      </span>
      {code && 'code' in code ? (
        <button
          type="button"
          className="kypr-totp-code"
          data-kypr-totp-code={code.code}
          title="このページに入力（入れられなければコピー）"
          onClick={(event) => {
            event.stopPropagation()
            onFill(item.id)
          }}
        >
          <span className="mono">{formatTotp(code.code)}</span>
          <TotpRing remaining={code.remaining} period={code.period} />
        </button>
      ) : code ? (
        <span className="kypr-totp-code problem" title={code.text}>
          —
        </span>
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
  onFillTotp,
  onCopyTotp,
  onReadQr,
  onLock
}: {
  data: KyprPanelData
  message: string | null
  onOpen: (id: string) => void
  onFill: (id: string) => void
  onNew: (type: EditType) => void
  onCopy: (id: string, field: string) => void
  onFillTotp: (id: string) => void
  onCopyTotp: (id: string) => void
  onReadQr: () => void
  onLock: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // 「保管庫」（ワンタイムコード以外）と「コード」（ワンタイムコード）を切り替える（kypr の iOS のタブと同じ分け方）
  const [mode, setMode] = useState<'vault' | 'codes'>('vault')
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState<'filter' | 'new' | null>(null)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useEffect(() => inputRef.current?.focus(), [])
  // セキュアメモの本文・伏せ字でない項目の値での一致（main で探す。平文を renderer に持たない）
  // （結果は探した語と組で持ち、今の語と違う結果は使わない）
  const [noteHits, setNoteHits] = useState<{ q: string; ids: ReadonlySet<string> }>({ q: '', ids: new Set() })
  useEffect(() => {
    const q = query.trim()
    if (q === '' || q.length > 4096) return
    let alive = true
    void window.nemo.kyprSearchNotes(q).then((ids) => {
      if (alive) setNoteHits({ q, ids: new Set(ids) })
    })
    return () => {
      alive = false
    }
  }, [query, data.items])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.items.filter((item) => {
      if (mode === 'codes') {
        if (item.kind !== 'totp' || item.deleted) return false
      } else {
        if (filter === 'trash' ? !item.deleted : item.deleted) return false
        // ワンタイムコードは「コード」に出す（ゴミ箱だけは戻せるようにここにも出す）
        if (item.kind === 'totp' && filter !== 'trash') return false
        if (filter !== 'all' && filter !== 'trash' && item.kind !== filter) return false
      }
      if (!q) return true
      // ワンタイムコードの名前は「発行元: ラベル」、host は URL のホスト（検索の対象は発行元・ラベル・URL）。
      // メモの subtitle はテンプレート名。本文・項目の値は main で探した `noteHits`
      return (
        [item.name, item.subtitle, item.host ?? ''].some((text) => text.toLowerCase().includes(q)) ||
        (noteHits.q === query.trim() && noteHits.ids.has(item.id))
      )
    })
  }, [data.items, query, filter, mode, noteHits])

  // 検索中は「このページ」のカードを畳む（検索の結果だけを見せる）
  const showPage = data.page !== null && query.trim() === ''
  const matches = showPage ? data.matches : []
  const totpMatches = showPage ? data.totpMatches : []
  const shown = items.slice(0, 200)
  const heroCount = matches.length + totpMatches.length
  const rowCount = heroCount + shown.length
  const codes = useTotpCodes([
    ...totpMatches.map((item) => item.id),
    ...(mode === 'codes' ? shown.map((item) => item.id) : [])
  ])
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
      else if (selected < heroCount) onFillTotp(totpMatches[selected - matches.length].id)
      else {
        const item = shown[selected - heroCount]
        if (item?.kind === 'totp' && !item.deleted) onFillTotp(item.id)
        else if (item) onOpen(item.id)
      }
    }
  }

  const readOnly = data.status.readOnly
  return (
    <div className="kypr-list">
      <div className="kypr-scroll" ref={listRef}>
        {data.agentRefusal === 'agent-script' ? (
          <p className="kypr-error kypr-pad" id="kypr-agent-refusal">
            {AGENT_SCRIPT_TEXT}
          </p>
        ) : null}
        {showPage && data.page ? (
          <section className="kypr-hero">
            <div className="kypr-hero-site">
              <Avatar
                kind="login"
                name={data.page.host}
                host={data.page.host}
                favicon={data.page.faviconUrl}
                size="sm"
              />
              <span className="kypr-row-text">
                <span className="kypr-hero-host">{data.page.host}</span>
                <span className="kypr-row-sub">
                  {heroCount > 0 ? `一致 ${heroCount} 件 · ↵ で 1 件目を入力` : '一致 0 件'}
                </span>
              </span>
            </div>
            {heroCount === 0 ? (
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
              <>
                {matches.map((item, i) => (
                  <KyprRow
                    key={item.id}
                    item={item}
                    selected={selected === i}
                    onOpen={onOpen}
                    onFill={onFill}
                    onCopy={onCopy}
                  />
                ))}
                {totpMatches.map((item, i) => (
                  <KyprTotpRow
                    key={item.id}
                    item={item}
                    code={codes[item.id]}
                    selected={selected === matches.length + i}
                    onOpen={onOpen}
                    onFill={onFillTotp}
                    onCopy={onCopyTotp}
                  />
                ))}
              </>
            )}
          </section>
        ) : null}
        {message ? <p className="kypr-error kypr-pad">{message}</p> : null}
        <div className="kypr-seg kypr-mode" role="tablist" aria-label="表示">
          {(
            [
              ['vault', '保管庫'],
              ['codes', 'コード']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className={mode === id ? 'on' : ''}
              data-kypr-mode={id}
              onClick={() => {
                setMode(id)
                setSel(0)
                inputRef.current?.focus()
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="kypr-bar">
          <label className="kypr-search">
            <KyprIcon name="search" />
            <input
              ref={inputRef}
              value={query}
              placeholder={mode === 'codes' ? 'コードを検索（発行元・ラベル・URL）' : 'すべてから検索'}
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value)
                setSel(0)
              }}
              onKeyDown={onKeyDown}
            />
          </label>
          {mode === 'codes' ? (
            <button
              type="button"
              className="icon"
              id="kypr-read-qr"
              disabled={readOnly}
              title={readOnly ? '読み取り専用で開いています' : 'このページの QR コードを読んで登録'}
              onClick={onReadQr}
            >
              <KyprIcon name="qr" />
            </button>
          ) : null}
          <div className="kypr-menu-anchor" hidden={mode === 'codes'}>
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
              {(['login', 'card', 'note', 'identity', 'totp'] as const).map((type) => (
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
          {mode === 'codes' ? KIND_LABEL.totp : FILTER_LABEL[filter]}
          <span className="kypr-count">{items.length}</span>
        </div>
        {items.length === 0 ? <p className="kypr-note kypr-pad">見つかりません。</p> : null}
        {shown.map((item, i) =>
          item.kind === 'totp' && !item.deleted ? (
            <KyprTotpRow
              key={item.id}
              item={item}
              code={codes[item.id]}
              selected={selected === heroCount + i}
              onOpen={onOpen}
              onFill={onFillTotp}
              onCopy={onCopyTotp}
            />
          ) : (
            <KyprRow
              key={item.id}
              item={item}
              selected={selected === heroCount + i}
              onOpen={onOpen}
              onCopy={onCopy}
            />
          )
        )}
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
          <b>↵</b> {selected < heroCount || (mode === 'codes' && shown.length > 0) ? '入力' : '開く'}
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
const SECRET_FIELDS = new Set(['password', 'number', 'code', 'secret'])
const COPYABLE_FIELDS = new Set([
  'username',
  'password',
  'number',
  'code',
  'expiry',
  'cardholderName',
  'secret'
])

/** 詳細で大きく出すワンタイムコード（押すとこのページに入れる）。 */
function KyprTotpBig({
  id,
  onFill,
  onCopy
}: {
  id: string
  onFill: (id: string) => void
  onCopy: (id: string) => void
}): React.JSX.Element | null {
  const code = useTotpCodes([id])[id]
  if (!code) return null
  if (!('code' in code))
    return <p className="kypr-error">このコードは出せません（{code.text}）。編集で直せます。</p>
  return (
    <div className="kypr-totp-big" data-kypr-totp-code={code.code}>
      <button
        type="button"
        className="kypr-totp-big-code mono"
        title="このページに入力（入れられなければコピー）"
        onClick={() => onFill(id)}
      >
        {formatTotp(code.code)}
      </button>
      <span className="kypr-totp-left">
        <TotpRing remaining={code.remaining} period={code.period} size={18} />
        {code.remaining} 秒
      </span>
      <button
        type="button"
        className="icon"
        title="コードをコピー（30 秒で消えます）"
        onClick={() => onCopy(id)}
      >
        <KyprIcon name="copy" />
      </button>
    </div>
  )
}

/** パスキーを作った日時（ローカルの日付だけ。読めなければそのまま）。 */
function formatPasskeyDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function KyprDetail({
  id,
  favicon,
  readOnly,
  autofillIdentityId,
  onAutofillChanged,
  onCopy,
  onCopyNoteField,
  onFillTotp,
  onCopyTotp,
  onBack,
  onEdit
}: {
  id: string
  /** 一覧で付いていた favicon（ログインで、履歴にあるホストのときだけ）。 */
  favicon: string | null
  readOnly: boolean
  /** フォーム自動入力に使う個人情報（この Mac の設定。無ければ一番古いもの）。 */
  autofillIdentityId: string | null
  onAutofillChanged: () => void
  onCopy: (id: string, field: string) => void
  onCopyNoteField: (id: string, field: KyprNoteField) => void
  onFillTotp: (id: string) => void
  onCopyTotp: (id: string) => void
  onBack: () => void
  onEdit: (type: EditType) => void
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
  const fields: { key: string; value: string; label?: string; group?: string; secret?: boolean }[] = []
  if (detail.kind === 'identity') {
    // 見出しごとに並べる（並び・伏せる項目は `PROFILE_FIELDS`。キーは kypr の平文の名前）
    for (const f of PROFILE_FIELDS) {
      const value = str(f.kypr)
      fields.push({
        key: f.kypr,
        // 未入力の性別は空のまま（表示名「未設定」にすると空の項目として隠れない）
        value: f.type === 'gender' && value !== '' ? (GENDER_LABELS[value] ?? value) : value,
        label: f.label,
        group: f.group,
        secret: f.secret === true
      })
    }
  } else if (detail.kind === 'totp') {
    fields.push(
      { key: 'name', value: str('name'), label: '発行元' },
      { key: 'account', value: str('account'), label: 'ラベル' },
      { key: 'secret', value: str('secret'), label: '秘密鍵' }
    )
    // 既定（SHA1・6 桁・30 秒）と違うときだけ出す
    const algorithm = str('algorithm')
    if (algorithm !== 'SHA1') fields.push({ key: 'algorithm', value: algorithm, label: 'アルゴリズム' })
    if (item['digits'] !== 6)
      fields.push({ key: 'digits', value: `${String(item['digits'])} 桁`, label: '桁数' })
    if (item['period'] !== 30)
      fields.push({ key: 'period', value: `${String(item['period'])} 秒`, label: '周期' })
  } else if (detail.kind === 'login') {
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
    (detail.kind === 'login' || detail.kind === 'totp') && Array.isArray(item['uris'])
      ? (item['uris'] as { uri?: unknown }[])
      : []
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
  // セキュアメモの項目は値のあるものだけ（伏せ字の値は main が空にして渡すので `hasValue` で見る）
  const noteFields = detail.kind === 'note' ? (detail.noteFields ?? []).filter((f) => f.hasValue) : []
  const isAutofill = detail.kind === 'identity' && !detail.deleted && autofillIdentityId === detail.id
  // パスキーの削除は kypr の Web / iOS で行う（ここでは見せるだけ）
  const passkeys = detail.passkeys ?? []

  return (
    <div className="kypr-body kypr-detail">
      <div className="kypr-detail-head">
        <button type="button" className="icon" title="一覧へ（Esc）" onClick={onBack}>
          <KyprIcon name="back" />
        </button>
        <span className="spacer" />
        {editable && !detail.deleted ? (
          <button type="button" className="kypr-btn" onClick={() => onEdit(detail.kind as EditType)}>
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
        <Avatar kind={detail.kind} name={str('name')} host={host} favicon={favicon} size="lg" />
        <span className="kypr-row-text">
          <span className="kypr-detail-name">
            {(detail.kind === 'totp'
              ? [str('name'), str('account')].filter(Boolean).join(': ')
              : str('name')) || '（名前なし）'}
          </span>
          <span className="kypr-row-sub">
            {host ?? detail.noteTemplateName ?? KIND_LABEL[detail.kind]}
            {detail.deleted ? <span className="kypr-tag warn">ゴミ箱</span> : null}
            {isAutofill ? <span className="kypr-tag on">フォーム自動入力に使う</span> : null}
          </span>
        </span>
      </div>
      {detail.error ? <p className="kypr-error">このアイテムは開けません（{detail.error}）。</p> : null}
      {detail.kind === 'unknown' ? (
        <p className="kypr-note">この版の Nemo が知らない種類です（読み取り専用）。</p>
      ) : null}
      {detail.kind === 'totp' && !detail.deleted ? (
        <KyprTotpBig id={detail.id} onFill={onFillTotp} onCopy={onCopyTotp} />
      ) : null}
      {visibleFields.length > 0 ||
      noteFields.length > 0 ||
      uris.length > 0 ||
      passkeys.length > 0 ||
      str('notes') ? (
        <div className="kypr-fields">
          {visibleFields.map((f, i) => {
            const secret = f.secret ?? SECRET_FIELDS.has(f.key)
            const visible = !secret || revealed.has(f.key)
            const heading = f.group !== undefined && f.group !== visibleFields[i - 1]?.group ? f.group : null
            return (
              <Fragment key={f.key}>
                {heading ? <div className="kypr-field-group">{heading}</div> : null}
                <div className="kypr-field" data-kypr-field={f.key}>
                  <span className="kypr-field-text">
                    <span className="kypr-field-label">{f.label ?? FIELD_LABEL[f.key]}</span>
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
                  {COPYABLE_FIELDS.has(f.key) || (detail.kind === 'identity' && f.key !== 'gender') ? (
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
              </Fragment>
            )
          })}
          {noteFields.map((f) => {
            // 「表示」で取った値は `revealed` に `note:<位置>` で持つ（上の段のキーと混ざらない）
            const revealKey = `note:${f.index}`
            const visible = !f.secret || revealed.has(revealKey)
            return (
              <div key={revealKey} className="kypr-field" data-kypr-note-field={f.index}>
                <span className="kypr-field-text">
                  <span className="kypr-field-label">{f.label || '（ラベルなし）'}</span>
                  <span className={`kypr-field-value${f.secret ? ' mono' : ''}${f.multiline ? ' pre' : ''}`}>
                    {!f.secret ? f.value : visible ? revealed.get(revealKey) : '••••••••••'}
                  </span>
                </span>
                {f.secret ? (
                  <button
                    type="button"
                    className="icon"
                    title={visible ? '隠す' : '表示'}
                    onClick={() => {
                      if (revealed.has(revealKey)) {
                        setRevealed((prev) => {
                          const next = new Map(prev)
                          next.delete(revealKey)
                          return next
                        })
                        return
                      }
                      void window.nemo
                        .kyprRevealNoteField(detail.id, { index: f.index, key: f.key, label: f.label })
                        .then((value) => {
                          if (value === null) {
                            setMessage('この項目は変わりました。開き直してください')
                            return
                          }
                          setRevealed((prev) => new Map(prev).set(revealKey, value))
                        })
                    }}
                  >
                    <KyprIcon name={visible ? 'eyeOff' : 'eye'} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon"
                  title="コピー（30 秒で消えます）"
                  onClick={() => onCopyNoteField(detail.id, f)}
                >
                  <KyprIcon name="copy" />
                </button>
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
          {passkeys.length > 0 ? (
            <div className="kypr-field" data-kypr-passkeys={passkeys.length}>
              <span className="kypr-field-text">
                <span className="kypr-field-label">パスキー</span>
                {passkeys.map((p, i) => (
                  <span key={i} className="kypr-field-value">
                    {p.rpId}
                    {p.userName ? ` · ${p.userName}` : ''}
                    <span className="kypr-passkey-date">{formatPasskeyDate(p.createdAt)}</span>
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
        {detail.kind === 'login' && !detail.deleted && !detail.passkeyOnly ? (
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
        {detail.kind === 'totp' && !detail.deleted ? (
          <button type="button" className="kypr-primary" onClick={() => onFillTotp(detail.id)}>
            このページに入力
          </button>
        ) : null}
        {detail.kind === 'identity' && !detail.deleted && !isAutofill ? (
          <button
            type="button"
            className="kypr-btn"
            title="右クリックの「フォーム自動入力」でこの個人情報を使う（この Mac の設定）"
            onClick={() =>
              void window.nemo.updateSettings({ kyprAutofillIdentityId: detail.id }).then(onAutofillChanged)
            }
          >
            フォーム自動入力に使う
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
  EditType,
  {
    key: string
    label: string
    secret?: boolean
    multiline?: boolean
    group?: string
    hint?: string
    kind?: 'text' | 'date' | 'gender'
  }[]
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
  ],
  // キーは kypr の平文の名前（並び・見出し・伏せる項目は `PROFILE_FIELDS`）
  identity: [
    { key: 'name', label: '名前', hint: '自分' },
    ...PROFILE_FIELDS.map((f) => ({
      key: f.kypr,
      label: f.label,
      secret: f.secret === true,
      group: f.group,
      hint: f.hint,
      kind: f.type
    })),
    { key: 'notes', label: 'メモ', multiline: true }
  ],
  // ワンタイムコードは KyprTotpEditor（項目の並びが違う）
  totp: []
}

interface TotpValues {
  secret: string
  name: string
  account: string
  uri: string
  algorithm: string
  digits: string
  period: string
  notes: string
}

const totpValuesOf = (d: KyprTotpDraft, notes = ''): TotpValues => ({
  secret: d.secret,
  name: d.name,
  account: d.account,
  uri: d.uri,
  algorithm: d.algorithm,
  digits: String(d.digits),
  period: String(d.period),
  notes
})

/** 数字だけの文字列を整数に（それ以外は NaN。main がコードを出せない値として断る）。 */
const toInt = (s: string): number => (/^[0-9]+$/.test(s.trim()) ? Number(s.trim()) : NaN)

/**
 * ワンタイムコードの作成・編集。秘密鍵か otpauth URI を貼る・このページの QR を読む・手で入れる。
 * 入力のたびに main で検査し（コードを出せるか・同じ秘密鍵のものがあるか）、今のコードを出す
 */
function KyprTotpEditor({
  id,
  draft,
  onCancel,
  onSaved
}: {
  id: string | null
  draft?: KyprTotpDraft
  onCancel: () => void
  onSaved: (id: string) => void
}): React.JSX.Element {
  const [values, setValues] = useState<TotpValues | null>(() => (draft ? totpValuesOf(draft) : null))
  const [otherUris, setOtherUris] = useState<unknown[]>([])
  const [firstUri, setFirstUri] = useState<Record<string, unknown>>({ match: null })
  // 新規は打ちながら確かめるので見せる。既存は伏せる
  const [shown, setShown] = useState(id === null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [check, setCheck] = useState<KyprTotpCheck | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (id) {
      void window.nemo.kyprItemForEdit(id).then((detail) => {
        if (cancelled || !detail?.item) return
        const item = detail.item
        const s = (key: string): string => (typeof item[key] === 'string' ? item[key] : '')
        const uris = Array.isArray(item['uris']) ? (item['uris'] as Record<string, unknown>[]) : []
        const first = uris[0]
        setFirstUri(first ? { ...first } : { match: null })
        setOtherUris(uris.slice(1))
        setValues({
          secret: s('secret'),
          name: s('name'),
          account: s('account'),
          uri: typeof first?.['uri'] === 'string' ? first['uri'] : '',
          algorithm: s('algorithm'),
          digits: String(item['digits']),
          period: String(item['period']),
          notes: s('notes')
        })
      })
    } else if (!draft) {
      void window.nemo.kyprTotpDraft().then((d) => {
        if (!cancelled) setValues(totpValuesOf(d))
      })
    }
    return () => {
      cancelled = true
    }
  }, [id, draft, reloadTick])

  // 入力のたびに（と 1 秒ごとに）main で検査する。今のコードもここで出す
  const checkKey = values
    ? JSON.stringify([values.secret, values.algorithm, values.digits, values.period])
    : ''
  useEffect(() => {
    if (checkKey === '') return
    const [secret, algorithm, digits, period] = JSON.parse(checkKey) as string[]
    let alive = true
    const tick = (): void => {
      void window.nemo
        .kyprTotpCheck({ id, secret, algorithm, digits: toInt(digits), period: toInt(period) })
        .then((next) => {
          if (alive) setCheck(next)
        })
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [checkKey, id])

  if (!values) return <div className="empty">読み込み中…</div>

  const set = (key: keyof TotpValues, value: string): void =>
    setValues((prev) => (prev ? { ...prev, [key]: value } : prev))
  // otpauth URI を貼ったら、発行元・ラベル・詳細設定まで埋める（URL はそのまま）
  const onSecret = (text: string): void => {
    set('secret', text)
    if (!text.trim().toLowerCase().startsWith('otpauth')) return
    void window.nemo.kyprParseOtpauth(text).then((d) => {
      if (d) setValues((prev) => (prev ? { ...totpValuesOf(d, prev.notes), uri: prev.uri } : prev))
    })
  }
  const readQr = (): void => {
    setMessage(null)
    void window.nemo.kyprTotpFromPageQr().then((result) => {
      if (result.ok)
        setValues((prev) =>
          prev ? { ...totpValuesOf(result.draft, prev.notes), uri: prev.uri || result.draft.uri } : prev
        )
      else setMessage(qrFailureText(result))
    })
  }
  const looksUri = values.secret.trim().toLowerCase().startsWith('otpauth')
  const save = (): void => {
    if (busy) return
    if (!values.name.trim() && !values.account.trim()) {
      setMessage('発行元かラベルを入れてください。')
      return
    }
    if (looksUri) {
      setMessage('otpauth URI として読めません。')
      return
    }
    if (check?.problem) {
      setMessage(check.problem)
      return
    }
    setBusy(true)
    setMessage(null)
    const first = values.uri.trim() ? [{ ...firstUri, uri: values.uri.trim() }] : []
    const fields = {
      name: values.name,
      account: values.account,
      secret: values.secret,
      algorithm: values.algorithm,
      digits: toInt(values.digits),
      period: toInt(values.period),
      notes: values.notes,
      uris: [...first, ...otherUris]
    }
    void window.nemo
      .kyprSave({ id, type: 'totp', fields })
      .then((result) => {
        if (result.ok && result.id) onSaved(result.id)
        else {
          setMessage(actionFailureText(result))
          if (!result.ok && result.reason === 'conflict') setReloadTick((n) => n + 1)
        }
      })
      .finally(() => setBusy(false))
  }
  const algorithms = ['SHA1', 'SHA256', 'SHA512']
  if (!algorithms.includes(values.algorithm)) algorithms.push(values.algorithm)

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
        <span className="kypr-editor-title">{id ? '編集' : '新規（ワンタイムコード）'}</span>
        <span className="spacer" />
        <button type="button" className="kypr-btn" id="kypr-editor-read-qr" onClick={readQr}>
          <KyprIcon name="qr" size={14} />
          このページの QR を読む
        </button>
      </div>
      <label className="kypr-edit-field">
        <span className="kypr-field-label">秘密鍵か otpauth URI</span>
        <span className="kypr-edit-input">
          <input
            name="kypr-secret"
            type={shown || looksUri ? 'text' : 'password'}
            value={values.secret}
            placeholder="JBSW Y3DP EHPK 3PXP または otpauth://totp/…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onSecret(event.target.value)}
          />
          <button
            type="button"
            className="icon"
            title={shown ? '隠す' : '表示'}
            onClick={() => setShown((v) => !v)}
          >
            <KyprIcon name={shown ? 'eyeOff' : 'eye'} />
          </button>
        </span>
      </label>
      {values.secret.trim() === '' ? null : looksUri ? (
        <p className="kypr-error">
          otpauth URI として読めません（TOTP
          で、秘密鍵・アルゴリズム・桁数・周期が正しいか確かめてください）。
        </p>
      ) : check?.problem ? (
        <p className="kypr-error">{check.problem}</p>
      ) : check?.code ? (
        <div className="kypr-totp-big" data-kypr-totp-code={check.code}>
          <span className="kypr-field-label">今のコード</span>
          <span className="kypr-totp-big-code mono">{formatTotp(check.code)}</span>
          <span className="kypr-totp-left">
            <TotpRing remaining={check.remaining} period={check.period} size={18} />
            {check.remaining} 秒
          </span>
        </div>
      ) : null}
      {check?.duplicateOf ? (
        <p className="kypr-note" id="kypr-totp-duplicate">
          同じ秘密鍵のワンタイムコードがすでにあります（{check.duplicateOf}）。
        </p>
      ) : null}
      {(
        [
          ['name', '発行元', '例: GitHub'],
          ['account', 'ラベル', '例: 個人'],
          ['uri', 'URL（任意。このページの候補になる）', 'https://']
        ] as const
      ).map(([key, label, hint]) => (
        <label key={key} className="kypr-edit-field">
          <span className="kypr-field-label">{label}</span>
          <span className="kypr-edit-input">
            <input
              name={`kypr-${key}`}
              value={values[key]}
              placeholder={hint}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set(key, event.target.value)}
            />
          </span>
        </label>
      ))}
      <span className="kypr-edit-group">詳細設定（ふつうは変えない）</span>
      <div className="kypr-edit-field">
        <span className="kypr-field-label">アルゴリズム</span>
        <span className="kypr-seg" role="radiogroup" aria-label="アルゴリズム">
          {algorithms.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={values.algorithm === a}
              className={values.algorithm === a ? 'on' : ''}
              onClick={() => set('algorithm', a)}
            >
              {a}
            </button>
          ))}
        </span>
      </div>
      {(
        [
          ['digits', '桁数'],
          ['period', '周期（秒）']
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="kypr-edit-field">
          <span className="kypr-field-label">{label}</span>
          <span className="kypr-edit-input">
            <input
              name={`kypr-${key}`}
              value={values[key]}
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) => set(key, event.target.value)}
            />
          </span>
        </label>
      ))}
      <label className="kypr-edit-field">
        <span className="kypr-field-label">メモ</span>
        <textarea
          value={values.notes}
          rows={3}
          spellCheck={false}
          onChange={(event) => set('notes', event.target.value)}
        />
      </label>
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

function KyprEditor({
  id,
  type,
  onCancel,
  onSaved
}: {
  id: string | null
  type: EditType
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
    // 日付は YYYY-MM-DD（自動入力が年・月・日に分けて使う。main も同じ検査で断る）
    const badDate = EDIT_FIELDS[type].find(
      (f) =>
        f.kind === 'date' && (values[f.key] ?? '').trim() !== '' && !isValidDate((values[f.key] ?? '').trim())
    )
    if (badDate) {
      setMessage(
        `${badDate.group ?? ''}の${badDate.label}は YYYY-MM-DD（例: ${badDate.hint ?? '2031-04-30'}）で入力してください。`
      )
      return
    }
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
      {EDIT_FIELDS[type].map((f, i, all) => {
        // 性別は button の並びなので label で包まない（見出しを押すと先頭の「未設定」が押されたことになる）
        const Row = f.kind === 'gender' ? 'div' : 'label'
        return (
          <Fragment key={f.key}>
            {f.group !== undefined && f.group !== all[i - 1]?.group ? (
              <span className="kypr-edit-group">{f.group}</span>
            ) : null}
            <Row className="kypr-edit-field">
              <span className="kypr-field-label">{f.label}</span>
              {f.kind === 'gender' ? (
                // ネイティブの `<select>` は使わない（開くと View のフォーカスが外れうる）
                <span className="kypr-seg" role="radiogroup" aria-label={f.label}>
                  {Object.entries(GENDER_LABELS).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={(values[f.key] ?? '') === value}
                      className={(values[f.key] ?? '') === value ? 'on' : ''}
                      onClick={() => set(f.key, value)}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              ) : f.multiline ? (
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
                    placeholder={f.hint}
                    maxLength={type === 'identity' ? MAX_PROFILE_VALUE : undefined}
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
            </Row>
          </Fragment>
        )
      })}
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
          <Avatar kind={row.kind} name={row.name} host={row.host} favicon={row.faviconUrl} size="sm" />
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
