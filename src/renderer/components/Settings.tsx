import { useCallback, useEffect, useState } from 'react'
import { HTTP_AUTH_LIMITS } from '../../shared/http-auth-rules.js'
import { Slots } from './Slots.js'
import type {
  DefaultBrowserStatus,
  GithubTokenStatus,
  HttpAuthImportResult,
  HttpAuthRule,
  HttpAuthTestResult,
  HttpAuthWriteResult,
  LoadedExtensionInfo,
  NemoSettings
} from '../../shared/types.js'

/**
 * 設定画面（計画 2-4）。
 *
 * 設定の実体は `settings.json`（`~/Library/Application Support/Nemo/`）で、
 * ここはその**一部を触るための窓**。キーバインドのように項目数が多いものは
 * ファイルを直接編集する前提にして、ここには「今どうなっているか」だけ出す。
 * 画面で全部を編集できるようにすると、同期リポジトリと二重管理になる。
 */
export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<NemoSettings | null>(null)
  const [extensions, setExtensions] = useState<LoadedExtensionInfo[]>([])
  const [defaultBrowser, setDefaultBrowser] = useState<DefaultBrowserStatus | null>(null)

  useEffect(() => {
    void window.nemo.getSettings().then(setSettings)
    void window.nemo.getExtensions().then(setExtensions)
    void window.nemo.getDefaultBrowserStatus().then(setDefaultBrowser)
  }, [])

  const patch = useCallback((next: Partial<NemoSettings>) => {
    // main が正規化した結果で state を作り直す（範囲外の値を入れても画面と実体がズレない）
    void window.nemo.updateSettings(next).then(setSettings)
  }, [])

  return (
    <div className="panel settings">
      <div className="panel-head">
        <span>設定</span>
        <div className="spacer" />
        <button type="button" className="icon" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="set-body">
        {settings === null ? (
          <div className="empty">読み込み中…</div>
        ) : (
          <>
            <section>
              <h3>タブ</h3>
              <Field
                label="使っていないタブを sleep させるまで"
                hint="メモリを解放する。開き直せば元に戻る。0 で無効"
              >
                <NumberInput
                  value={settings.tabSleepMinutes}
                  min={0}
                  max={1440}
                  unit="分"
                  onCommit={(value) => patch({ tabSleepMinutes: value })}
                />
              </Field>
              <Field
                label="触っていない一時タブを自動でアーカイブするまで"
                hint="タブは閉じるが消えない。⌘Y のアーカイブから開き直せる。0 で無効"
              >
                <NumberInput
                  value={settings.tabArchiveHours}
                  min={0}
                  max={720}
                  unit="時間"
                  onCommit={(value) => patch({ tabArchiveHours: value })}
                />
              </Field>
            </section>

            <section>
              <h3>起動と検索</h3>
              <Toggle
                label="起動時に前回のタブを復元する"
                checked={settings.restoreSession}
                onChange={(checked) => patch({ restoreSession: checked })}
              />
              <Toggle
                label="ダウンロード先を毎回聞く"
                checked={settings.askDownloadLocation}
                onChange={(checked) => patch({ askDownloadLocation: checked })}
              />
              <Field label="検索エンジン" hint="https で、{q} を含むこと">
                <TextInput
                  value={settings.searchTemplate}
                  onCommit={(value) => patch({ searchTemplate: value })}
                />
              </Field>
            </section>

            <section>
              <h3>GitHub の Pull Request（サイドバー）</h3>
              <Toggle
                label="サイドバーに Pull Request を出す"
                checked={settings.liveFolderEnabled}
                onChange={(checked) => patch({ liveFolderEnabled: checked })}
              />
              <GithubToken />
            </section>

            <section>
              <h3>HTTP 認証</h3>
              <HttpAuthRules />
            </section>

            <section>
              <h3>既定のブラウザ</h3>
              {defaultBrowser === null ? (
                <p className="dim">確認中…</p>
              ) : defaultBrowser.isDefault ? (
                <p className="ok">Nemo が既定のブラウザになっている</p>
              ) : (
                <>
                  <p className="dim">
                    {defaultBrowser.canRequest
                      ? '他のアプリのリンクは、いまは別のブラウザで開く'
                      : defaultBrowser.reason}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    disabled={!defaultBrowser.canRequest}
                    onClick={() => void window.nemo.requestDefaultBrowser().then(setDefaultBrowser)}
                  >
                    Nemo を既定のブラウザにする
                  </button>
                </>
              )}
            </section>

            <section>
              <h3>拡張</h3>
              {extensions.length === 0 ? (
                <p className="dim">ロードされている拡張はない</p>
              ) : (
                extensions.map((extension) => (
                  <div key={extension.id} className="set-row">
                    <span>
                      {extension.name} <span className="dim">{extension.version}</span>
                      {extension.matchesLock ? '' : <span className="warn"> lock 不一致</span>}
                    </span>
                    <div className="spacer" />
                    {extension.optionsUrl ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void window.nemo.openExtensionOptions(extension.id)}
                      >
                        設定を開く
                      </button>
                    ) : null}
                  </div>
                ))
              )}
              <p className="dim">
                拡張は <code>extensions.lock.json</code> に書いたものだけをロードする。追加・更新は{' '}
                <code>mise run ext:outdated</code> / <code>ext:update</code> から行う。
              </p>
              <button type="button" className="btn" onClick={() => void window.nemo.restartServiceWorkers()}>
                拡張の service worker を再起動する
              </button>
            </section>

            <section>
              <h3>キーバインド</h3>
              <p className="dim">
                <code>settings.json</code> の <code>keybindings</code> で上書きできる（
                <code>&quot;pin-tab&quot;: &quot;CmdOrCtrl+D&quot;</code> の形）。 不正な値と重複は採用せず、
                診断ログに <code>keybinding.rejected</code> として残る。
              </p>
              {Object.keys(settings.keybindings).length === 0 ? (
                <p className="dim">いまは上書きなし（すべて既定）</p>
              ) : (
                Object.entries(settings.keybindings).map(([command, accelerator]) => (
                  <div key={command} className="set-row">
                    <span>{command}</span>
                    <div className="spacer" />
                    <code>{accelerator || '（割り当てなし）'}</code>
                  </div>
                ))
              )}
            </section>

            <Slots />

            <section>
              <h3>データ</h3>
              <p className="dim">履歴とアーカイブは端末ごとに持つので、スロットには含まれません。</p>
              <button type="button" className="btn" onClick={() => void window.nemo.openLogFolder()}>
                診断ログのフォルダを開く
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * GitHub の資格情報。
 *
 * **PAT は `settings.json` に置かない**（設定は端末をまたいで持ち出されうる一方、
 * `safeStorage` は端末鍵なので、持ち出し先では復号できない暗号文が配られるだけ）。
 * 専用ストア（`github-token.json`）に暗号化して置く。
 *
 * ここに**トークンの値は出ない**。出せるのは「いま何が使われているか」だけ。
 */
function GithubToken(): React.JSX.Element {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.nemo.getGithubTokenStatus().then(setStatus)
  }, [])
  useEffect(reload, [reload])

  const save = (): void => {
    const token = draft.trim()
    if (!token) return
    void window.nemo.saveGithubToken(token).then((saved) => {
      setDraft('')
      setMessage(saved ? '保存した' : '保存できなかった（この端末では暗号化が使えない）')
      reload()
    })
  }

  const label =
    status === null
      ? '確認中…'
      : status.source === 'pat'
        ? '設定した PAT を使っている'
        : status.source === 'gh'
          ? 'gh auth token を使っている'
          : '未設定（サイドバーには Connect GitHub と出る）'

  return (
    <>
      <p className={status?.source === 'none' ? 'dim' : 'ok'}>{label}</p>
      {status !== null && !status.encryptionAvailable ? (
        <p className="warn">
          この端末では暗号化ストレージが使えないので、貼っても PAT は保存されない（平文では置かない）。
          <code>gh auth login</code> の方を使う。
        </p>
      ) : null}
      <Field
        label="Personal Access Token"
        hint="貼ると端末鍵で暗号化して保存する。gh より優先される。値はここには出ない"
      >
        <span className="set-input wide">
          <input
            type="password"
            value={draft}
            spellCheck={false}
            placeholder={status?.hasStoredPat ? '（保存済み）' : 'ghp_… / github_pat_…'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
        </span>
      </Field>
      <div className="set-row">
        <button type="button" className="btn" disabled={draft.trim().length === 0} onClick={save}>
          保存する
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={status?.hasStoredPat !== true}
          onClick={() => {
            void window.nemo.clearGithubToken().then(() => {
              setMessage('消した（gh があればそちらに戻る）')
              reload()
            })
          }}
        >
          保存した PAT を消す
        </button>
      </div>
      {message ? <p className="dim">{message}</p> : null}
      <p className="dim">
        必要な scope は <code>repo</code> / <code>read:org</code>。 取得は 60 秒ごと +
        ウィンドウをアクティブにしたときで、GraphQL を1リクエストだけ投げる。
      </p>
    </>
  )
}

/**
 * HTTP 認証の自動入力の管理画面。
 *
 * 主な導線は**認証ダイアログの「次回から自動で入力する」**で、ここは管理画面。
 * ワイルドカードに広げる・インポートしたパターンを確かめる、といった編集を行う。
 *
 * **パスワードは一覧に載せない**。「表示」を押したときだけ 1 件取得し、
 * Settings を閉じたとき / 別のルールを表示したとき / 一定時間で**平文の state ごと消す**
 * （CSS で隠すだけだと取得済みの平文が残る）。
 */
function HttpAuthRules(): React.JSX.Element {
  const [rules, setRules] = useState<HttpAuthRule[]>([])
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({})
  const [revealed, setRevealed] = useState<{ id: string; password: string } | null>(null)
  const [revealMs, setRevealMs] = useState(30_000)
  const [message, setMessage] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState<HttpAuthImportResult | null>(null)
  const [testUrls, setTestUrls] = useState('')
  const [testResults, setTestResults] = useState<HttpAuthTestResult[] | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.nemo.listHttpAuthRules().then((state) => {
      setRules(state.rules)
      setEncryptionAvailable(state.encryptionAvailable)
    })
  }, [])
  useEffect(reload, [reload])
  useEffect(() => {
    void window.nemo.getHttpAuthRevealMs().then(setRevealMs)
  }, [])

  /*
   * **再マスクは表示の切り替えではなく平文 state を消す。**
   * 3 経路とも同じ `setRevealed(null)` に集約する:
   * ① Settings を閉じたとき（このコンポーネントのアンマウント）
   * ② 別のルールを表示したとき（`reveal` が上書きする）
   * ③ 表示から一定時間（下のタイマー。**長さは検証から短縮できる**）
   */
  useEffect(() => {
    if (revealed === null) return undefined
    const timer = setTimeout(() => setRevealed(null), revealMs)
    return () => clearTimeout(timer)
  }, [revealed, revealMs])
  useEffect(() => () => setRevealed(null), [])

  const draftOf = (rule: HttpAuthRule): RuleDraft =>
    drafts[rule.id] ?? { pattern: rule.pattern, username: rule.username, password: null }

  const setDraft = (id: string, patch: Partial<RuleDraft>): void =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { pattern: '', username: '', password: null }), ...patch }
    }))

  /** 下書きを捨てる（キーごと消す。`undefined` を入れて型を偽らない）。 */
  const clearDraft = (id: string): void =>
    setDrafts((current) => {
      const { [id]: _removed, ...rest } = current
      return rest
    })

  const applyResult = (result: HttpAuthWriteResult, done: string): void => {
    if (!result.saved) {
      setMessage(`保存できなかった（${result.reason ?? '不明'}）`)
      reload()
      return
    }
    setMessage(result.authCacheCleared ? done : `${done}（反映には Nemo の再起動が必要）`)
    reload()
  }

  const save = (rule: HttpAuthRule): void => {
    const draft = draftOf(rule)
    void window.nemo
      .saveHttpAuthRule({
        id: rule.id,
        pattern: draft.pattern,
        username: draft.username,
        // **省略と空文字を区別する**（空文字は「空のパスワードに変更」）
        ...(draft.password === null ? {} : { password: draft.password })
      })
      .then((result) => {
        if (result.saved) clearDraft(rule.id)
        applyResult(result, '保存した')
      })
  }

  const reveal = (rule: HttpAuthRule): void => {
    // 別のルールを表示した時点で前の平文は消える
    setRevealed(null)
    void window.nemo.revealHttpAuthPassword(rule.id).then((password) => {
      if (password === null) {
        // 端末鍵が使えない環境では**無効化していない**（再保存も断られて回復手段が無くなるため）。
        // 同じ文言にすると事実と食い違う
        setMessage(
          encryptionAvailable
            ? 'パスワードを復号できなかった（ルールを無効化した）'
            : 'この端末では暗号化ストレージが使えないので、保存済みのパスワードを取り出せない'
        )
        reload()
        return
      }
      setRevealed({ id: rule.id, password })
    })
  }

  const runImport = (): void => {
    void window.nemo.importMultipassJson(importText).then((result) => {
      setImportResult(result)
      // **成功したら textarea を直ちに空にする**（全資格情報の平文が貼られたまま残らないように）
      if (!result.failed) setImportText('')
      reload()
    })
  }

  const runTest = (): void => {
    const urls = testUrls
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    setTestError(null)
    /*
     * 編集中の**未保存の**パターンも足して照合できる形にする。
     * 保存済みと同じ値の下書きは足さない（同じパターンが 2 回マッチしたように見えるため）。
     */
    const dirty = rules.find((rule) => {
      const draft = drafts[rule.id]
      return draft !== undefined && draft.pattern.length > 0 && draft.pattern !== rule.pattern
    })
    void window.nemo
      .testHttpAuthPattern(urls, dirty ? drafts[dirty.id].pattern : null)
      .then(setTestResults)
      .catch((error: unknown) => {
        setTestResults(null)
        setTestError(error instanceof Error ? error.message : String(error))
      })
  }

  const nameOf = (id: string): string =>
    id === 'draft' ? '（編集中のパターン）' : (rules.find((rule) => rule.id === id)?.pattern ?? id)

  return (
    <div className="http-auth">
      {!encryptionAvailable ? (
        <p className="warn ha-no-encryption">
          この端末では暗号化ストレージが使えないので、資格情報は保存できません（平文では置きません）。
        </p>
      ) : null}
      {rules.length === 0 ? (
        <p className="dim">
          保存された資格情報はない。認証ダイアログの「次回から自動で入力する」を選ぶと、
          そのオリジンのルールがここに並ぶ。
        </p>
      ) : (
        rules.map((rule) => {
          const draft = draftOf(rule)
          const dirty =
            draft.pattern !== rule.pattern || draft.username !== rule.username || draft.password !== null
          return (
            <div key={rule.id} className="ha-row" data-rule-id={rule.id}>
              <div className="set-row">
                <span className="set-input wide">
                  <input
                    className="ha-pattern"
                    value={draft.pattern}
                    spellCheck={false}
                    maxLength={HTTP_AUTH_LIMITS.MAX_PATTERN}
                    onChange={(event) => setDraft(rule.id, { pattern: event.target.value })}
                  />
                </span>
                <span className="set-input">
                  <input
                    className="ha-username"
                    value={draft.username}
                    spellCheck={false}
                    maxLength={HTTP_AUTH_LIMITS.MAX_USERNAME}
                    onChange={(event) => setDraft(rule.id, { username: event.target.value })}
                  />
                </span>
              </div>
              <div className="set-row">
                {draft.password === null ? (
                  <>
                    <code className="ha-password">
                      {revealed?.id === rule.id ? revealed.password : '••••••'}
                    </code>
                    <button type="button" className="btn ha-reveal" onClick={() => reveal(rule)}>
                      表示
                    </button>
                    <button
                      type="button"
                      className="btn ha-change-password"
                      onClick={() => setDraft(rule.id, { password: '' })}
                    >
                      パスワードを変更
                    </button>
                  </>
                ) : (
                  <span className="set-input">
                    <input
                      className="ha-new-password"
                      type="password"
                      value={draft.password}
                      maxLength={HTTP_AUTH_LIMITS.MAX_PASSWORD}
                      placeholder="新しいパスワード（空も可）"
                      onChange={(event) => setDraft(rule.id, { password: event.target.value })}
                    />
                  </span>
                )}
                <div className="spacer" />
                <label className="check">
                  <input
                    type="checkbox"
                    className="ha-toggle"
                    checked={rule.enabled && !rule.disabledReason}
                    disabled={Boolean(rule.disabledReason)}
                    onChange={(event) => {
                      void window.nemo
                        .saveHttpAuthRule({
                          id: rule.id,
                          username: rule.username,
                          enabled: event.target.checked
                        })
                        .then((result) => applyResult(result, '切り替えた'))
                    }}
                  />
                  有効
                </label>
                <button type="button" className="btn ha-save" disabled={!dirty} onClick={() => save(rule)}>
                  保存
                </button>
                <button
                  type="button"
                  className="btn ha-delete"
                  onClick={() => {
                    void window.nemo
                      .deleteHttpAuthRule(rule.id)
                      .then((result) => applyResult(result, '削除した'))
                  }}
                >
                  削除
                </button>
              </div>
              {rule.disabledReason ? (
                <p className="warn ha-reason">
                  {rule.disabledReason === 'pattern-timeout'
                    ? '照合に時間がかかりすぎたので自動で無効にした。パターンを直すと再び有効にできる。'
                    : 'パスワードを復号できなかったので自動で無効にした。パスワードを保存し直すと再び有効にできる。'}
                </p>
              ) : null}
              {rule.importedFrom ? (
                <p className="dim ha-imported">
                  MultiPass の <code>{rule.importedFrom}</code> から変換
                </p>
              ) : null}
            </div>
          )
        })
      )}
      {message ? <p className="dim ha-message">{message}</p> : null}

      <Field label="正規表現テスター" hint="URL を1行に1つ。保存済みルール全体に当てて勝者を出す">
        <textarea
          className="ha-test-urls"
          rows={2}
          spellCheck={false}
          value={testUrls}
          onChange={(event) => setTestUrls(event.target.value)}
        />
      </Field>
      <button type="button" className="btn ha-test-run" onClick={runTest}>
        試す
      </button>
      {testError ? <p className="warn ha-test-error">照合できなかった: {testError}</p> : null}
      {testResults?.map((result) => (
        <p key={result.url} className="dim ha-test-result">
          <code>{result.url}</code>{' '}
          {result.winnerId === null
            ? '→ マッチなし'
            : result.matchedIds.length > 1
              ? `→ この URL には ${result.matchedIds.length} 件マッチします。${nameOf(result.winnerId)} が使われます`
              : `→ ${nameOf(result.winnerId)} が使われます`}
          {result.timedOutIds.length > 0 ? `（${result.timedOutIds.length} 件は照合がタイムアウトした）` : ''}
        </p>
      ))}

      <Field label="MultiPass の JSON を取り込む" hint="エクスポートした内容をそのまま貼る">
        <textarea
          className="ha-import-text"
          rows={3}
          spellCheck={false}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
      </Field>
      <button
        type="button"
        className="btn ha-import-run"
        disabled={importText.trim().length === 0}
        onClick={runImport}
      >
        取り込む
      </button>
      {importResult ? (
        <div className="ha-import-result">
          <p className={importResult.failed ? 'warn' : 'dim'}>
            {importResult.failed ? '取り込みに失敗した' : `${importResult.imported} 件を取り込んだ`}
            {importResult.failed || importResult.authCacheCleared ? '' : '（反映には Nemo の再起動が必要）'}
          </p>
          {importResult.priorityWarning ? (
            <p className="warn ha-priority-warning">
              MultiPass の優先度は取り込まれません。Nemo はパターンが長いほうを使います。
            </p>
          ) : null}
          {importResult.rejected.map((item, index) => (
            <p key={`${item.pattern}-${index}`} className="warn ha-rejected">
              取り込めなかった: <code>{item.pattern || '(不明)'}</code> — {item.reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface RuleDraft {
  pattern: string
  username: string
  /** `null` は「変更しない」。空文字は**有効な新パスワード**。 */
  password: string | null
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-field">
      <div className="set-label">
        <span>{label}</span>
        {hint ? <span className="dim">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * 数値の入力。
 * **入力中に確定しない**（`3` と打つ途中の空文字で 0 に落ちて設定が消える）。
 * blur と Enter で確定する。
 */
function NumberInput({
  value,
  min,
  max,
  unit,
  onCommit
}: {
  value: number
  min: number
  max: number
  unit: string
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const parsed = Number(draft)
    setDraft(null)
    if (!Number.isFinite(parsed)) return
    onCommit(Math.min(Math.max(Math.round(parsed), min), max))
  }
  return (
    <span className="set-input">
      <input
        type="number"
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
      <span className="dim">{unit}</span>
    </span>
  )
}

function TextInput({
  value,
  onCommit
}: {
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <span className="set-input wide">
      <input
        value={draft ?? value}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) onCommit(draft)
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    </span>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="set-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}
