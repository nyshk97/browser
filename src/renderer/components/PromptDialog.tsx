import { useEffect, useRef, useState } from 'react'
import { HTTP_AUTH_LIMITS } from '../../shared/http-auth-rules.js'
import type { Prompt } from '../../shared/types.js'

/**
 * 権限要求 / HTTP 認証 / 証明書エラー / 外部 protocol のダイアログ。
 *
 * ネイティブダイアログを使わずここに出す理由は `src/main/prompts.ts` を参照
 * （自走検証から答えられるようにするため）。
 */
export function PromptDialog({ prompt }: { prompt: Prompt }): React.JSX.Element {
  switch (prompt.type) {
    case 'permission':
      return <PermissionPrompt prompt={prompt} />
    case 'auth':
      return <AuthPrompt prompt={prompt} />
    case 'certificate':
      return <CertificatePrompt prompt={prompt} />
    case 'external-protocol':
      return <ExternalProtocolPrompt prompt={prompt} />
    case 'system-media':
      return <SystemMediaPrompt prompt={prompt} />
    case 'notice':
      return <NoticePrompt prompt={prompt} />
  }
}

/**
 * 情報を伝えるだけのダイアログ。
 * **新しい通知基盤は作らない**——資格情報の保存に失敗したことなどを、
 * 既存の `ask` / `PromptDialog` に種別を 1 つ足して出す。
 */
function NoticePrompt({ prompt }: { prompt: Extract<Prompt, { type: 'notice' }> }): React.JSX.Element {
  return (
    <div className="dialog" data-testid="prompt-notice">
      <div className="dialog-title">{prompt.title}</div>
      <div className="dialog-sub">{prompt.detail}</div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void window.nemo.resolvePrompt(prompt.id, { kind: 'notice' })}
        >
          閉じる
        </button>
      </div>
    </div>
  )
}

const PERMISSION_LABEL: Record<string, string> = {
  geolocation: '現在地',
  notifications: '通知',
  media: 'カメラとマイク',
  camera: 'カメラ',
  microphone: 'マイク',
  'clipboard-read': 'クリップボードの読み取り',
  midi: 'MIDI デバイス',
  'display-capture': '画面の共有',
  'idle-detection': '操作していないことの検知'
}

function PermissionPrompt({
  prompt
}: {
  prompt: Extract<Prompt, { type: 'permission' }>
}): React.JSX.Element {
  const [remember, setRemember] = useState(true)
  return (
    <div className="dialog" data-testid="prompt-permission">
      <div className="dialog-title">
        {prompt.origin} が<b>{PERMISSION_LABEL[prompt.permission] ?? prompt.permission}</b>
        の利用を求めています
      </div>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        このサイトでは今後も同じ扱いにする
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, { kind: 'permission', allow: false, remember })
          }
        >
          許可しない
        </button>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, { kind: 'permission', allow: true, remember })
          }
        >
          許可する
        </button>
      </div>
    </div>
  )
}

const SYSTEM_MEDIA_LABEL: Record<string, string> = {
  microphone: 'マイク',
  camera: 'カメラ'
}

/**
 * macOS 側でマイク / カメラが拒否されている、という案内。
 * Nemo で許可しても OS が渡さないので、システム設定に誘導する。
 */
function SystemMediaPrompt({
  prompt
}: {
  prompt: Extract<Prompt, { type: 'system-media' }>
}): React.JSX.Element {
  const label = SYSTEM_MEDIA_LABEL[prompt.kind] ?? prompt.kind
  return (
    <div className="dialog" data-testid="prompt-system-media">
      <div className="dialog-title">
        macOS の設定で Nemo の<b>{label}</b>の使用が拒否されています
      </div>
      <div className="dialog-sub">
        システム設定 &gt; プライバシーとセキュリティ &gt; {label} で Nemo をオンにしてから、
        ページを読み込み直してください。
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, { kind: 'system-media', openSettings: false })
          }
        >
          閉じる
        </button>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, { kind: 'system-media', openSettings: true })
          }
        >
          システム設定を開く
        </button>
      </div>
    </div>
  )
}

/**
 * HTTP 認証。
 *
 * 保存チェックは**既定 OFF**（`permissions.ts` の「今後も許可」は既定 ON だが、
 * パスワードは取り消しコストが違う）。`canSave` が false のときは**出さない**。
 * ただし**チェックボックスを出さないことは認可にならない**ので、
 * 実際に保存してよいかは main が `eligibility.canSave` で持っている。
 *
 * このコンポーネントは `prompt.id` を key に再マウントされる（`Overlay.tsx`）。
 * 使い回すと前のホストの入力値とチェック状態が次のホストに残る。
 */
function AuthPrompt({ prompt }: { prompt: Extract<Prompt, { type: 'auth' }> }): React.JSX.Element {
  // 拒否された保存済みルールがあれば、その値で埋めて直せるようにする（#6 の自己修復）
  const [username, setUsername] = useState(prompt.prefill?.username ?? '')
  const [password, setPassword] = useState(prompt.prefill?.password ?? '')
  const [save, setSave] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    void window.nemo.resolvePrompt(prompt.id, { kind: 'auth', username, password, save })
  }

  return (
    <form className="dialog" onSubmit={submit} data-testid="prompt-auth">
      <div className="dialog-title">
        {prompt.isProxy ? 'プロキシ' : prompt.host} がユーザー名とパスワードを求めています
      </div>
      {prompt.rejected ? (
        <div className="dialog-sub warn" data-testid="prompt-auth-rejected">
          保存されている資格情報が拒否されました。直して保存し直すと上書きされます。
        </div>
      ) : null}
      {prompt.realm ? <div className="dialog-sub">realm: {prompt.realm}</div> : null}
      <input
        ref={first}
        value={username}
        placeholder="ユーザー名"
        autoComplete="username"
        maxLength={HTTP_AUTH_LIMITS.MAX_USERNAME}
        onChange={(event) => setUsername(event.target.value)}
      />
      <input
        value={password}
        type="password"
        placeholder="パスワード"
        autoComplete="current-password"
        maxLength={HTTP_AUTH_LIMITS.MAX_PASSWORD}
        onChange={(event) => setPassword(event.target.value)}
      />
      {prompt.canSave ? (
        <label className="check">
          <input
            type="checkbox"
            checked={save}
            data-testid="prompt-auth-save"
            onChange={(event) => setSave(event.target.checked)}
          />
          次回から自動で入力する
        </label>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() => void window.nemo.resolvePrompt(prompt.id, { kind: 'auth-cancel' })}
        >
          キャンセル
        </button>
        <button type="submit" className="primary">
          送信
        </button>
      </div>
    </form>
  )
}

function CertificatePrompt({
  prompt
}: {
  prompt: Extract<Prompt, { type: 'certificate' }>
}): React.JSX.Element {
  return (
    <div className="dialog danger" data-testid="prompt-certificate">
      <div className="dialog-title">{prompt.host} の証明書に問題があります</div>
      <div className="dialog-sub">
        {prompt.errorCode} / 発行者: {prompt.issuerName || '不明'} / 対象: {prompt.subjectName || '不明'}
      </div>
      <div className="dialog-sub dim">
        通信が第三者に読まれている可能性があります。続行するのは、原因が分かっている場合だけにしてください。
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void window.nemo.resolvePrompt(prompt.id, { kind: 'certificate', proceed: false })}
        >
          戻る
        </button>
        <button
          type="button"
          onClick={() => void window.nemo.resolvePrompt(prompt.id, { kind: 'certificate', proceed: true })}
        >
          このまま続行
        </button>
      </div>
    </div>
  )
}

function ExternalProtocolPrompt({
  prompt
}: {
  prompt: Extract<Prompt, { type: 'external-protocol' }>
}): React.JSX.Element {
  const [remember, setRemember] = useState(false)
  return (
    <div className="dialog" data-testid="prompt-external">
      <div className="dialog-title">
        <b>{prompt.scheme}</b> を別のアプリで開きますか？
      </div>
      <div className="dialog-sub">{prompt.display}</div>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        この種類のリンクは今後も開く
      </label>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, {
              kind: 'external-protocol',
              open: false,
              remember: false
            })
          }
        >
          開かない
        </button>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void window.nemo.resolvePrompt(prompt.id, { kind: 'external-protocol', open: true, remember })
          }
        >
          開く
        </button>
      </div>
    </div>
  )
}
