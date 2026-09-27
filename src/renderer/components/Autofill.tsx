import { useCallback, useEffect, useState } from 'react'
import { PROFILE_FIELDS } from '../../shared/autofill-schema.js'
import { SettingsSection } from './SettingsSection.js'
import type { AutofillFailure, AutofillProfile, AutofillStatus } from '../../shared/types.js'

/**
 * フォーム自動入力の設定（プロフィールの保管庫と Jev の API キー）。
 *
 * プロフィールは iCloud Drive の保管庫（`autofill.json`）にパスフレーズで暗号化して置く。
 * **値が renderer に来るのは「編集する」を押したときだけ**で、閉じたら state ごと捨てる。
 * Jev のキーは保存 / 削除だけで、値は返ってこない。
 */
export function Autofill(): React.JSX.Element {
  const [status, setStatus] = useState<AutofillStatus | null>(null)
  /** 編集中のプロフィール（平文）。null なら閉じている。 */
  const [profile, setProfile] = useState<AutofillProfile | null>(null)
  /** 新しく作る（保管庫がまだ無い）ときだけ true。パスフレーズを 2 回入れてもらう。 */
  const [creating, setCreating] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(true)
  const [message, setMessage] = useState<{ text: string; warn: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyMessage, setKeyMessage] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.nemo.autofillStatus().then(setStatus)
  }, [])
  useEffect(reload, [reload])

  const close = (): void => {
    setProfile(null)
    setCreating(false)
    setPassphrase('')
    setConfirm('')
    setDeleteArmed(false)
  }

  const open = (usePassphrase: string | null): void => {
    setBusy(true)
    setMessage(null)
    void window.nemo
      .autofillOpen(usePassphrase, remember)
      .then((result) => {
        if (result.ok) {
          setProfile(result.profile)
          setCreating(false)
          setPassphrase('')
          reload()
        } else {
          setMessage({ text: failureText(result.reason, result.detail), warn: true })
        }
      })
      .finally(() => setBusy(false))
  }

  const save = (): void => {
    if (!profile) return
    if (creating && passphrase !== confirm) {
      setMessage({ text: 'パスフレーズが一致しません。', warn: true })
      return
    }
    setBusy(true)
    setMessage(null)
    const usePassphrase = creating || !status?.hasPassphrase ? passphrase : null
    void window.nemo
      .autofillSave(profile, usePassphrase, remember)
      .then((result) => {
        if (result.ok) {
          setMessage({ text: '保存しました。', warn: false })
          setCreating(false)
          setPassphrase('')
          setConfirm('')
          reload()
        } else {
          setMessage({ text: failureText(result.reason), warn: true })
        }
      })
      .finally(() => setBusy(false))
  }

  const remove = (): void => {
    void window.nemo.autofillDelete().then((ok) => {
      close()
      setMessage(
        ok ? { text: '保管庫を削除しました。', warn: false } : { text: '削除できませんでした。', warn: true }
      )
      reload()
    })
  }

  const saveKey = (): void => {
    const key = keyDraft.trim()
    if (!key) return
    void window.nemo.saveJevKey(key).then((result) => {
      if (result.ok) setKeyDraft('')
      setKeyMessage(result.ok ? '保管庫に保存しました。' : failureText(result.reason))
      reload()
    })
  }

  if (status === null) {
    return (
      <SettingsSection title="フォーム自動入力">
        <p className="dim">読み込み中…</p>
      </SettingsSection>
    )
  }

  const needsPassphrase = profile !== null && (creating || !status.hasPassphrase)
  /** キーの保存・削除は保管庫の書き直しなので、パスフレーズを覚えている Mac でだけできる。 */
  const canSaveKey = status.state === 'ok' && status.hasPassphrase && !status.isFutureVersion

  return (
    <SettingsSection
      title="フォーム自動入力"
      sub="入力欄を右クリック →「フォーム自動入力」で、空いている欄をプロフィールで埋めます。欄の見出しだけを Jev（TypeSafe AI）に送って判定し、値は送りません"
    >
      <div data-testid="autofill">
        <p className={status.state === 'unreadable' ? 'warn' : 'dim'} data-testid="autofill-state">
          {status.state === 'empty'
            ? 'プロフィールはまだありません'
            : status.state === 'ok'
              ? `${status.meta?.count ?? 0} 項目・${formatDate(status.meta?.savedAt)}・${status.meta?.host ?? ''}`
              : (status.reason ?? '読み込めません')}
        </p>
        {status.hasConflictCopy ? (
          <p className="warn">
            iCloud の競合コピー（autofill 2.json など）があります。保存先のフォルダで確かめてください。
          </p>
        ) : null}
        {!status.encryptionAvailable ? (
          <p className="warn">
            この Mac では暗号化を利用できないため、保存もパスフレーズの記憶もできません。
          </p>
        ) : null}

        {profile === null ? (
          <div className="set-row">
            {status.state === 'empty' ? (
              <button
                type="button"
                className="btn primary"
                data-testid="autofill-create"
                onClick={() => {
                  setProfile(Object.fromEntries(PROFILE_FIELDS.map((field) => [field.key, ''])))
                  setCreating(true)
                  setMessage(null)
                }}
              >
                プロフィールを作る
              </button>
            ) : status.state === 'ok' && status.hasPassphrase ? (
              <button
                type="button"
                className="btn"
                data-testid="autofill-edit"
                disabled={busy}
                onClick={() => open(null)}
              >
                編集する
              </button>
            ) : status.state === 'ok' ? (
              <>
                <span className="set-input wide">
                  <input
                    type="password"
                    value={passphrase}
                    placeholder="パスフレーズ"
                    data-testid="autofill-passphrase"
                    onChange={(event) => setPassphrase(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && passphrase) open(passphrase)
                    }}
                  />
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !passphrase}
                  onClick={() => open(passphrase)}
                >
                  開く
                </button>
              </>
            ) : null}
            <div className="spacer" />
            {status.state !== 'empty' && !status.isFutureVersion ? (
              deleteArmed ? (
                <button
                  type="button"
                  className="btn danger"
                  data-testid="autofill-delete-confirm"
                  onClick={remove}
                >
                  本当に削除する
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => setDeleteArmed(true)}>
                  削除…
                </button>
              )
            ) : null}
          </div>
        ) : (
          <ProfileForm profile={profile} onChange={setProfile} />
        )}

        {profile !== null ? (
          <>
            {needsPassphrase ? (
              <>
                <input
                  className="vault-input"
                  type="password"
                  value={passphrase}
                  placeholder={
                    creating ? `パスフレーズ（${status.minPassphrase} 文字以上）` : '保管庫のパスフレーズ'
                  }
                  data-testid="autofill-new-passphrase"
                  onChange={(event) => setPassphrase(event.target.value)}
                />
                {creating ? (
                  <input
                    className="vault-input"
                    type="password"
                    value={confirm}
                    placeholder="もう一度"
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                ) : null}
                {creating ? (
                  <p className="dim">忘れると開けなくなります（削除して作り直すことになります）。</p>
                ) : null}
                <label className="vault-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  この Mac で覚える（右クリックの自動入力に必要です）
                </label>
              </>
            ) : null}
            <div className="set-row">
              <button
                type="button"
                className="btn primary"
                data-testid="autofill-save"
                disabled={busy || (needsPassphrase && passphrase.length < status.minPassphrase)}
                onClick={save}
              >
                保存する
              </button>
              <button type="button" className="btn" onClick={close}>
                閉じる
              </button>
            </div>
          </>
        ) : null}
        {message ? <p className={message.warn ? 'warn' : 'dim'}>{message.text}</p> : null}
        <p className="dim">
          保存先: <code>{status.dir}</code>
        </p>

        <div className="set-row" data-testid="autofill-jev">
          <span>Jev の API キー</span>
          <span className="dim" data-testid="autofill-jev-state">
            {status.hasJevKey ? '保存済み' : '未設定（autocomplete 属性のある欄だけ入ります）'}
          </span>
        </div>
        {!canSaveKey ? (
          <p className="dim" data-testid="autofill-jev-locked">
            {status.state === 'empty'
              ? 'キーは保管庫の中に入れるので、先にプロフィールを作ってください。'
              : 'キーは保管庫の中に入れるので、上でパスフレーズを入れて「この Mac で覚える」と保存・削除できます。'}
          </p>
        ) : null}
        <div className="set-row">
          <span className="set-input wide">
            <input
              type="password"
              disabled={!canSaveKey}
              value={keyDraft}
              spellCheck={false}
              placeholder={status.hasJevKey ? '（保存済み）' : 'apikey_…'}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey()
              }}
            />
          </span>
          <button
            type="button"
            className="btn"
            disabled={!canSaveKey || keyDraft.trim().length === 0}
            onClick={saveKey}
          >
            保存する
          </button>
          {status.hasJevKey ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.nemo.clearJevKey().then((result) => {
                  setKeyMessage(result.ok ? '消しました。' : failureText(result.reason))
                  reload()
                })
              }}
            >
              消す
            </button>
          ) : null}
        </div>
        {keyMessage ? <p className="dim">{keyMessage}</p> : null}
        <p className="dim">
          キーは console.typesafe.ai
          で発行します。プロフィールと一緒に保管庫へパスフレーズで暗号化して入れるので、 別の Mac
          でもパスフレーズを入れるだけで使えます。値はここには出ません。
        </p>
      </div>
    </SettingsSection>
  )
}

function ProfileForm({
  profile,
  onChange
}: {
  profile: AutofillProfile
  onChange: (profile: AutofillProfile) => void
}): React.JSX.Element {
  const set = (key: string, value: string): void => onChange({ ...profile, [key]: value })
  return (
    <div className="autofill-form" data-testid="autofill-form">
      {PROFILE_FIELDS.map((field) => (
        <label key={field.key} className="autofill-field">
          <span className="dim">{field.label}</span>
          {field.key === 'gender' ? (
            <select
              className="vault-input"
              value={profile[field.key] ?? ''}
              data-testid={`autofill-field-${field.key}`}
              onChange={(event) => set(field.key, event.target.value)}
            >
              <option value="">（入れない）</option>
              <option value="male">男性</option>
              <option value="female">女性</option>
              <option value="other">その他</option>
            </select>
          ) : (
            <input
              className="vault-input"
              type={field.key === 'birthday' ? 'date' : 'text'}
              value={profile[field.key] ?? ''}
              placeholder={field.hint}
              spellCheck={false}
              data-testid={`autofill-field-${field.key}`}
              onChange={(event) => set(field.key, event.target.value)}
            />
          )}
        </label>
      ))}
    </div>
  )
}

function failureText(reason: AutofillFailure | undefined, detail?: string): string {
  switch (reason) {
    case 'bad-passphrase':
      return 'パスフレーズが違います。'
    case 'weak-passphrase':
      return 'パスフレーズが短すぎます。'
    case 'no-passphrase':
      return 'パスフレーズを入れてください。'
    case 'tampered':
    case 'malformed':
      return '保管庫の中身が壊れています。削除して作り直してください。'
    case 'unreadable':
      return detail ?? '保管庫を読み込めません。'
    case 'future-version':
      return '新しい版の Nemo で保存されています。この Nemo を更新してください。'
    case 'no-encryption':
      return 'この Mac では暗号化を利用できません。'
    case 'write-failed':
      return '保存に失敗しました。'
    case 'empty':
      return '保管庫がありません。'
    default:
      return '失敗しました。'
  }
}

function formatDate(time: number | undefined): string {
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
