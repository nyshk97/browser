import { useCallback, useEffect, useState } from 'react'
import { SettingsSection } from './SettingsSection.js'
import { actionFailureText, KyprUnlock } from './Kypr.js'
import type { KyprStatus } from '../../shared/types.js'

/**
 * 設定画面の「kypr」の節。ログイン（初回はここかポップアップ）・Touch ID・ロック・ログアウト・同期。
 * 値（鍵・平文）は受け取らない。
 */
export function KyprSettings(): React.JSX.Element {
  const [status, setStatus] = useState<KyprStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [signOutArmed, setSignOutArmed] = useState(false)
  const reload = useCallback(() => {
    void window.nemo.kyprStatus().then(setStatus)
  }, [])
  useEffect(reload, [reload])

  return (
    <SettingsSection title="kypr" sub="パスワードマネージャー。ツールバーの 🔑 と ⌘⇧L から使います">
      {!status ? null : status.state === 'unlocked' ? (
        <>
          <p className="ok">
            解除中{status.readOnly ? '（サーバーに届かないため読み取り専用）' : ''}・{status.itemCount} 件
          </p>
          <p className="dim">
            Touch ID:{' '}
            {status.touchIdEnrolled
              ? '使える'
              : status.touchIdAvailable
                ? '未設定（マスターパスワードで解除し直すと設定できます）'
                : 'この Mac では使えません'}
            {' ／ '}最後の同期:{' '}
            {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ja-JP') : 'まだ'}
          </p>
          <div className="set-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.nemo.kyprSync().then((result) => {
                  setMessage(result.ok ? '同期しました。' : actionFailureText(result))
                  reload()
                })
              }
            >
              今すぐ同期
            </button>
            <button type="button" className="btn" onClick={() => void window.nemo.kyprLock().then(reload)}>
              ロック
            </button>
          </div>
        </>
      ) : (
        <KyprUnlock status={status} onDone={reload} />
      )}
      {status && status.state !== 'signed-out' && status.state !== 'disabled' ? (
        <div className="set-row">
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              if (!signOutArmed) {
                setSignOutArmed(true)
                return
              }
              setSignOutArmed(false)
              void window.nemo.kyprSignOut().then(reload)
            }}
          >
            {signOutArmed ? 'この Mac からログアウトする（控えと Touch ID の設定を消す）' : 'ログアウト'}
          </button>
        </div>
      ) : null}
      {message ? <p className="dim">{message}</p> : null}
      {status?.server ? <p className="dim">サーバー: {status.server}</p> : null}
    </SettingsSection>
  )
}
