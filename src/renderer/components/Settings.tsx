import { useCallback, useEffect, useState } from 'react'
import type { DefaultBrowserStatus, LoadedExtensionInfo, NemoSettings } from '../../shared/types.js'

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

            <section>
              <h3>データ</h3>
              <p className="dim">
                設定とピン留めは <code>mise run config:push</code> / <code>config:pull</code> で 2
                台目と同期できる。履歴とアーカイブは端末ローカルで、同期には載せない。
              </p>
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
