import { SettingsSection } from './SettingsSection.js'
import { useCallback, useEffect, useState } from 'react'
import type {
  AuthVaultFailure,
  AuthVaultLoadPreview,
  AuthVaultSavePreview,
  AuthVaultStatus
} from '../../shared/types.js'

/**
 * Basic 認証の保管庫（設定 › Basic 認証）。
 *
 * セーブスロットと違って**枠は 1 つ**。認証は「メイン / 実験用」と使い分けるものではなく
 * 積み上げるものなので、枠を増やすと「どの枠が最新か」を人間が覚える羽目になる。
 *
 * **ダイアログは 2 段**（パスフレーズ →（下見）→ 中身）。
 * 保管庫はパスフレーズを受け取るまで中身を出せないので、
 * 1 画面にすると「記憶していない Mac ＝ 新しい Mac」で開いた直後に出せる情報が無くなる。
 * 記憶しているときだけ 1 段目を自動で通過する。
 *
 * 状態は**開くたびに取り直す**（iCloud 経由で別の Mac が書き換える）。
 */

type DialogKind = 'save' | 'load' | 'delete'
type Stage = 'passphrase' | 'body'

export function AuthVault(): React.JSX.Element {
  const [status, setStatus] = useState<AuthVaultStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [stage, setStage] = useState<Stage>('passphrase')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [remember, setRemember] = useState(true)
  /** 実際に使うパスフレーズ。`null` は「この Mac が覚えているものを使う」。 */
  const [entered, setEntered] = useState<string | null>(null)
  const [savePreview, setSavePreview] = useState<AuthVaultSavePreview | null>(null)
  const [loadPreview, setLoadPreview] = useState<AuthVaultLoadPreview | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [passphraseError, setPassphraseError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    // **偽の状態を作らない**（`state` を勝手に埋めると、無い保管庫に「保存」を出す）
    void window.nemo.authVaultStatus().then(
      (next) => {
        setFailed(false)
        setStatus(next)
      },
      (cause: unknown) => {
        console.error('authVaultStatus failed', cause)
        setFailed(true)
        setError('保管庫の状態を読めませんでした。')
      }
    )
  }, [])

  useEffect(refresh, [refresh])

  const close = useCallback(() => {
    setDialog(null)
    setSavePreview(null)
    setLoadPreview(null)
    setPassphrase('')
    setConfirmPassphrase('')
    setPassphraseError(null)
    setEntered(null)
  }, [])

  /** パスフレーズの最小長は main が持つ（renderer に定数を置かない）。 */
  const minPassphrase = status?.minPassphrase ?? 8

  /** 下見を撃つ。失敗の種類で 1 段目へ戻すか、中身の段でエラーを出すかを分ける。 */
  const preview = useCallback(
    async (kind: 'save' | 'load', value: string | null) => {
      setBusy(true)
      setPassphraseError(null)
      let result: AuthVaultSavePreview | AuthVaultLoadPreview
      try {
        result =
          kind === 'save'
            ? await window.nemo.authVaultPreviewSave(value)
            : await window.nemo.authVaultPreviewLoad(value)
      } catch (cause) {
        console.error('auth vault preview failed', cause)
        setBusy(false)
        setStage('body')
        setSavePreview(null)
        setLoadPreview(null)
        setError('保管庫を開けませんでした。')
        return
      }
      setBusy(false)

      if (!result.ok && retryable(result.reason)) {
        /*
         * **1 段目に戻す。** 記憶した値が古いとき（別の Mac で作り直した / 変えた）に当たり、
         * 戻さないと「パスフレーズが違います」と出たまま入力欄が無い行き止まりになる。
         */
        setStage('passphrase')
        setPassphraseError(
          result.reason === 'no-passphrase' ? null : messageFor(result.reason, minPassphrase)
        )
        return
      }

      setEntered(value)
      setStage('body')
      if (kind === 'save') setSavePreview(result as AuthVaultSavePreview)
      else {
        const load = result as AuthVaultLoadPreview
        setLoadPreview(load)
        // 「無いもの」は既定 ON、「内容が違うもの」は既定 OFF
        setChecked(load.ok ? new Set(load.missing.map((item) => item.pattern)) : new Set())
      }
    },
    [minPassphrase]
  )

  const open = useCallback(
    (kind: DialogKind) => {
      setDialog(kind)
      setError(null)
      setNotice(null)
      setPassphrase('')
      setConfirmPassphrase('')
      setPassphraseError(null)
      setEntered(null)
      setSavePreview(null)
      setLoadPreview(null)
      setRemember(status?.encryptionAvailable !== false)
      if (kind === 'delete') {
        setStage('body')
        return
      }
      if (status?.hasPassphrase) {
        // 覚えているなら 1 段目を飛ばす
        setStage('body')
        void preview(kind, null)
        return
      }
      setStage('passphrase')
    },
    [preview, status]
  )

  const run = useCallback(
    async (action: () => Promise<string | null>) => {
      setBusy(true)
      setError(null)
      let failure: string | null = '実行できませんでした。'
      try {
        failure = await action()
      } catch (cause) {
        console.error('auth vault action failed', cause)
      }
      setBusy(false)
      close()
      if (failure !== null) setError(failure)
      refresh()
    },
    [close, refresh]
  )

  const onSave = useCallback(
    () =>
      void run(async () => {
        const result = await window.nemo.authVaultSave(entered, remember)
        if (!result.ok) return messageFor(result.reason)
        setNotice(
          result.skipped > 0
            ? `${result.saved} 件を保存しました。${result.skipped} 件は読めなかったので除外しました。`
            : `${result.saved} 件を保存しました。`
        )
        return null
      }),
    [entered, remember, run]
  )

  const onLoad = useCallback(
    () =>
      void run(async () => {
        const result = await window.nemo.authVaultLoad(entered, [...checked], remember)
        if (!result.ok) return messageFor(result.reason)
        const parts = [`${result.imported} 件を読み込みました。`]
        if (result.stale > 0) {
          parts.push(`${result.stale} 件は保管庫が更新されていたため取り込みませんでした。`)
        }
        if (!result.authCacheCleared) parts.push('反映には再起動が必要です。')
        setNotice(parts.join(''))
        return null
      }),
    [checked, entered, remember, run]
  )

  const onDelete = useCallback(
    () =>
      void run(async () => {
        const ok = await window.nemo.authVaultDelete()
        if (!ok) return '削除できませんでした。'
        setNotice('保管庫を削除しました。')
        return null
      }),
    [run]
  )

  return (
    <SettingsSection
      title="HTTP 認証の持ち出し"
      sub="上の HTTP 認証のルールをパスフレーズで暗号化して保管庫に保存し、別の Mac で読み込みます"
    >
      <div className="vault" data-testid="auth-vault">
        {status === null && !failed && <p className="dim">読み込み中…</p>}
        {status !== null && (
          <VaultCard
            status={status}
            busy={busy}
            onSave={() => open('save')}
            onLoad={() => open('load')}
            onDelete={() => open('delete')}
            onRetry={refresh}
            onOpenFolder={() => void window.nemo.openSlotsFolder()}
          />
        )}
      </div>

      {status !== null && (
        <p className="dim vault-local" data-testid="auth-vault-local">
          この Mac には有効な認証ルールが {status.localCount} 件あります。
        </p>
      )}

      {/* パスフレーズを変える手段は用意していないので、変えたいときの道を出しておく */}
      {status?.state === 'ok' && (
        <p className="dim">パスフレーズを変更するには、保管庫を削除してから保存し直してください。</p>
      )}

      {notice !== null && (
        <p className="vault-notice" data-testid="auth-vault-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="slots-error" data-testid="auth-vault-error">
          {error}
        </p>
      )}

      {dialog !== null && (
        <VaultDialog
          kind={dialog}
          stage={stage}
          status={status}
          busy={busy}
          passphrase={passphrase}
          confirmPassphrase={confirmPassphrase}
          passphraseError={passphraseError}
          remember={remember}
          savePreview={savePreview}
          loadPreview={loadPreview}
          checked={checked}
          onPassphrase={setPassphrase}
          onConfirmPassphrase={setConfirmPassphrase}
          onRemember={setRemember}
          onToggle={(pattern) =>
            setChecked((current) => {
              const next = new Set(current)
              if (next.has(pattern)) next.delete(pattern)
              else next.add(pattern)
              return next
            })
          }
          onSubmitPassphrase={() => void preview(dialog === 'save' ? 'save' : 'load', passphrase)}
          onCancel={close}
          onSave={onSave}
          onLoad={onLoad}
          onDelete={onDelete}
        />
      )}
    </SettingsSection>
  )
}

/** 1 段目に戻して直せる失敗か。**壊れている系はやり直しても直らない**ので戻さない。 */
function retryable(reason: AuthVaultFailure): boolean {
  return reason === 'bad-passphrase' || reason === 'no-passphrase' || reason === 'weak-passphrase'
}

function messageFor(reason: AuthVaultFailure | undefined, minPassphrase = 8, detail?: string): string {
  switch (reason) {
    case 'bad-passphrase':
      return 'パスフレーズが違います。'
    case 'weak-passphrase':
      return `パスフレーズは ${minPassphrase} 文字以上にしてください。`
    case 'no-passphrase':
      return 'パスフレーズを入力してください。'
    case 'tampered':
    case 'malformed':
      return '保管庫が壊れています。削除して保存し直してください。'
    case 'unreadable':
      // main が理由を運んできているなら**そちらを出す**（「新しい版の Nemo で保存されています」等）
      return detail ?? '保管庫を読めませんでした。'
    case 'empty':
      return '保管庫がまだありません。'
    case 'no-encryption':
      return 'この Mac では暗号化を利用できないため保存できません。'
    case 'write-failed':
      return '書き込みに失敗しました。'
    default:
      return '実行できませんでした。'
  }
}

function VaultCard({
  status,
  busy,
  onSave,
  onLoad,
  onDelete,
  onRetry,
  onOpenFolder
}: {
  status: AuthVaultStatus
  busy: boolean
  onSave: () => void
  onLoad: () => void
  onDelete: () => void
  onRetry: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const conflict = status.hasConflictCopy ? <ConflictNote onOpenFolder={onOpenFolder} /> : null

  if (status.state === 'empty') {
    return (
      <div className="slot empty vault-card" data-testid="auth-vault-card">
        <div className="slot-blank">まだ保存されていません</div>
        {conflict}
        <button
          type="button"
          className="btn slot-action"
          disabled={busy || status.localCount === 0}
          onClick={onSave}
          data-testid="auth-vault-save"
        >
          保存
        </button>
      </div>
    )
  }

  if (status.state === 'unreadable') {
    return (
      <div className="slot broken vault-card" data-testid="auth-vault-card">
        <div className="slot-head">
          <div className="spacer" />
          {/*
           * **新しい版の Nemo が書いたものには削除を出さない。** 退避しないのは
           * 「古い Nemo が新しい方の保管庫を全件消さない」ためなのに、
           * 削除ボタンを出すと同じ結果へのワンクリックの近道になる。
           */}
          {!status.isFutureVersion && <VaultMenu busy={busy} onDelete={onDelete} />}
        </div>
        <div className="slot-blank warn" data-testid="auth-vault-reason">
          {status.reason ?? '読み込めませんでした'}
        </div>
        {status.isFutureVersion && (
          <p className="vault-note" data-testid="auth-vault-update-note">
            Nemo を更新すると読めるようになります。
          </p>
        )}
        {conflict}
        {/*
         * 状態はキャッシュを持たず毎回読み直すので、押し直せば直る場面がある
         * （iCloud の未ダウンロード → 落ち終われば読める）。
         */}
        <button
          type="button"
          className="btn slot-action"
          disabled={busy}
          onClick={onRetry}
          data-testid="auth-vault-retry"
        >
          再試行
        </button>
      </div>
    )
  }

  return (
    <div className="slot vault-card" data-testid="auth-vault-card">
      <div className="slot-head">
        <div className="vault-count" data-testid="auth-vault-count">
          {status.meta?.count ?? 0} 件
        </div>
        <div className="spacer" />
        {/* 削除は「···」に隠す。「読み込む」の隣に不可逆な操作を並べない（undo が無い） */}
        <VaultMenu busy={busy} onDelete={onDelete} />
      </div>
      <div className="vault-meta">
        <span>{formatDate(status.meta?.savedAt ?? 0)}</span>
        <span className="dim">・{status.meta?.host ?? ''}</span>
      </div>
      {conflict}
      <div className="vault-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || status.localCount === 0}
          onClick={onSave}
          data-testid="auth-vault-save"
        >
          保存
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={onLoad}
          data-testid="auth-vault-load"
        >
          読み込む
        </button>
      </div>
    </div>
  )
}

/**
 * 「···」メニュー（削除だけ）。`Slots.tsx` の `slot-menu` と同じ作法で、
 * **hover で現れる**（削除は全ての Mac から見えなくなるうえ undo が無い）。
 */
function VaultMenu({ busy, onDelete }: { busy: boolean; onDelete: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      // **止めないと `Overlay` の window リスナーが設定パネルごと閉じる**（1 段だけ戻したい）
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`slot-menu-btn${open ? ' on' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        aria-label="保管庫の操作"
        data-testid="auth-vault-menu"
      >
        {/* アイコンフォントも絵文字も使わない（DESIGN.md）。3 点はインライン SVG で描く */}
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="3" cy="7" r="1.2" fill="currentColor" />
          <circle cx="7" cy="7" r="1.2" fill="currentColor" />
          <circle cx="11" cy="7" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="slot-menu" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            data-testid="auth-vault-delete"
          >
            削除
          </button>
        </div>
      )}
    </>
  )
}

function ConflictNote({ onOpenFolder }: { onOpenFolder: () => void }): React.JSX.Element {
  return (
    <p className="slot-conflict" data-testid="auth-vault-conflict">
      保管庫が別の Mac からも保存されています。
      <button type="button" className="link" onClick={onOpenFolder}>
        フォルダを開く
      </button>
    </p>
  )
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 2 段のダイアログ。**段ごとに `data-testid` を持たせる**
 * （持たせないと CDP から通しの確認が組めない）。
 */
function VaultDialog({
  kind,
  stage,
  status,
  busy,
  passphrase,
  confirmPassphrase,
  passphraseError,
  remember,
  savePreview,
  loadPreview,
  checked,
  onPassphrase,
  onConfirmPassphrase,
  onRemember,
  onToggle,
  onSubmitPassphrase,
  onCancel,
  onSave,
  onLoad,
  onDelete
}: {
  kind: DialogKind
  stage: Stage
  status: AuthVaultStatus | null
  busy: boolean
  passphrase: string
  confirmPassphrase: string
  passphraseError: string | null
  remember: boolean
  savePreview: AuthVaultSavePreview | null
  loadPreview: AuthVaultLoadPreview | null
  checked: Set<string>
  onPassphrase: (value: string) => void
  onConfirmPassphrase: (value: string) => void
  onRemember: (value: boolean) => void
  onToggle: (pattern: string) => void
  onSubmitPassphrase: () => void
  onCancel: () => void
  onSave: () => void
  onLoad: () => void
  onDelete: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ダイアログを閉じるだけ。設定パネルまで巻き込まない
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  /** 初回の保存＝パスフレーズを新しく決める。**2 回入力**を求める。 */
  const first = kind === 'save' && status?.state === 'empty'
  const mismatched = first && confirmPassphrase.length > 0 && passphrase !== confirmPassphrase
  const canSubmit = passphrase.length > 0 && (!first || passphrase === confirmPassphrase)

  const title =
    kind === 'save' ? '保管庫に保存する' : kind === 'load' ? '保管庫を読み込む' : '保管庫を削除する'

  return (
    <div className="slot-scrim" onClick={onCancel}>
      <div
        className="slot-dlg vault-dlg"
        onClick={(event) => event.stopPropagation()}
        data-testid={`auth-vault-dlg-${kind}`}
      >
        <h4>{title}</h4>

        {kind === 'delete' && (
          <>
            <p>保管庫を削除します。ほかの Mac からも見えなくなります。</p>
            <p className="dim">この Mac に覚えているパスフレーズも一緒に消えます。</p>
          </>
        )}

        {kind !== 'delete' && stage === 'passphrase' && (
          <div data-testid="auth-vault-stage-passphrase">
            <p>
              {first
                ? 'パスフレーズを決めてください。ほかの Mac で読み込むときに必要になります。'
                : 'パスフレーズを入力してください。'}
            </p>
            <input
              type="password"
              className="vault-input"
              value={passphrase}
              autoFocus
              placeholder={`${status?.minPassphrase ?? 8} 文字以上`}
              onChange={(event) => onPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) onSubmitPassphrase()
              }}
              data-testid="auth-vault-passphrase"
            />
            {first && (
              <input
                type="password"
                className="vault-input"
                value={confirmPassphrase}
                placeholder="もう一度入力"
                onChange={(event) => onConfirmPassphrase(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canSubmit) onSubmitPassphrase()
                }}
                data-testid="auth-vault-passphrase-confirm"
              />
            )}
            {mismatched && (
              <p className="dlg-warn" data-testid="auth-vault-passphrase-mismatch">
                2 つのパスフレーズが一致しません。
              </p>
            )}
            {passphraseError !== null && (
              <p className="dlg-warn" data-testid="auth-vault-passphrase-error">
                {passphraseError}
              </p>
            )}
            {first && (
              <p className="dim">忘れると保管庫を開けなくなります（削除して作り直すことになります）。</p>
            )}
            {status?.encryptionAvailable !== false && (
              <label className="vault-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => onRemember(event.target.checked)}
                  data-testid="auth-vault-remember"
                />
                この Mac に覚える
              </label>
            )}
          </div>
        )}

        {kind === 'save' && stage === 'body' && <SaveBody preview={savePreview} busy={busy} />}
        {kind === 'load' && stage === 'body' && (
          <LoadBody preview={loadPreview} busy={busy} checked={checked} onToggle={onToggle} />
        )}

        <div className="dlg-foot">
          <button type="button" className="btn" onClick={onCancel} data-testid="auth-vault-cancel">
            キャンセル
          </button>
          {kind !== 'delete' && stage === 'passphrase' && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !canSubmit}
              onClick={onSubmitPassphrase}
              data-testid="auth-vault-next"
            >
              次へ
            </button>
          )}
          {kind === 'save' && stage === 'body' && savePreview?.ok === true && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={onSave}
              data-testid="auth-vault-confirm"
            >
              保存する
            </button>
          )}
          {kind === 'load' && stage === 'body' && loadPreview?.ok === true && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || checked.size === 0}
              onClick={onLoad}
              data-testid="auth-vault-confirm"
            >
              読み込む
            </button>
          )}
          {kind === 'delete' && (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={onDelete}
              data-testid="auth-vault-confirm"
            >
              削除する
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SaveBody({
  preview,
  busy
}: {
  preview: AuthVaultSavePreview | null
  busy: boolean
}): React.JSX.Element {
  if (preview === null) return <p className="dim">{busy ? '確認しています…' : '…'}</p>
  if (!preview.ok) {
    return (
      <p className="dlg-warn" data-testid="auth-vault-body-error">
        {messageFor(preview.reason, undefined, preview.detail)}
      </p>
    )
  }
  return (
    <div data-testid="auth-vault-stage-body">
      <p>
        この Mac の有効な認証ルール <b>{preview.count}</b> 件で保管庫を置き換えます。
      </p>
      {preview.skipped > 0 && <p className="dim">{preview.skipped} 件は読めなかったので保存されません。</p>}
      {preview.disappearing.length > 0 && (
        <div className="dlg-warn" data-testid="auth-vault-disappearing">
          <p>次の {preview.disappearing.length} 件は保管庫から消えます。</p>
          <ul className="vault-list">
            {preview.disappearing.map((item) => (
              <li key={item.pattern}>
                <code>{item.pattern}</code> <span className="dim">{item.username}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function LoadBody({
  preview,
  busy,
  checked,
  onToggle
}: {
  preview: AuthVaultLoadPreview | null
  busy: boolean
  checked: Set<string>
  onToggle: (pattern: string) => void
}): React.JSX.Element {
  if (preview === null) return <p className="dim">{busy ? '確認しています…' : '…'}</p>
  if (!preview.ok) {
    return (
      <p className="dlg-warn" data-testid="auth-vault-body-error">
        {messageFor(preview.reason, undefined, preview.detail)}
      </p>
    )
  }

  const nothing = preview.missing.length === 0 && preview.differing.length === 0 && preview.same.length === 0

  return (
    <div className="vault-groups" data-testid="auth-vault-stage-body">
      {nothing && <p className="dim">保管庫は空です。</p>}

      {preview.missing.length > 0 && (
        <div className="vault-group" data-testid="auth-vault-missing">
          <h5>この Mac に無いもの ({preview.missing.length})</h5>
          {preview.missing.map((item) => (
            <label key={item.pattern} className="vault-row">
              <input
                type="checkbox"
                checked={checked.has(item.pattern)}
                onChange={() => onToggle(item.pattern)}
              />
              <code>{item.pattern}</code>
              <span className="dim">{item.username}</span>
            </label>
          ))}
        </div>
      )}

      {preview.differing.length > 0 && (
        <div className="vault-group" data-testid="auth-vault-differing">
          <h5>内容が違うもの ({preview.differing.length})</h5>
          {preview.differing.map((item) => (
            <label key={item.pattern} className="vault-row">
              <input
                type="checkbox"
                checked={checked.has(item.pattern)}
                onChange={() => onToggle(item.pattern)}
              />
              <span className="vault-row-body">
                <code>{item.pattern}</code>
                {item.usernameDiffers && (
                  <span className="vault-note">
                    ユーザー名: この Mac <b>{item.toUsername}</b> → 保管庫 <b>{item.fromUsername}</b>
                  </span>
                )}
                {/* **値は出さない**（違うことだけ伝える） */}
                {item.passwordDiffers && <span className="vault-note">パスワードが違います</span>}
                {item.newer !== null && (
                  <span className="vault-note dim">
                    {item.newer === 'from' ? '保管庫の方が新しい' : 'この Mac の方が新しい'}
                  </span>
                )}
                {/* 意図して外したルールが読み込みで黙って有効に戻らないよう明示する */}
                {!item.toEnabled && (
                  <span className="vault-note warn">この Mac では無効です（読み込むと有効に戻ります）</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      {preview.same.length > 0 && (
        <div className="vault-group" data-testid="auth-vault-same">
          <h5>既にあるもの ({preview.same.length})</h5>
          {preview.same.map((item) => (
            <div key={item.pattern} className="vault-row static">
              <code>{item.pattern}</code>
              <span className="dim">{item.username}</span>
              {!item.toEnabled && <span className="vault-note warn">この Mac では無効です</span>}
            </div>
          ))}
        </div>
      )}

      {preview.dropped > 0 && (
        <p className="dim">{preview.dropped} 件は読み取れない内容だったので除外しました。</p>
      )}
    </div>
  )
}
