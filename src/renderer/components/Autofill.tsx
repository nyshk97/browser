import { useCallback, useEffect, useState } from 'react'
import { SettingsSection } from './SettingsSection.js'
import type { AutofillStatus } from '../../shared/types.js'

/**
 * フォーム自動入力の設定（Jev の API キー）。
 *
 * 入れる値は kypr の個人情報（ポップアップの「個人情報」で作り、「フォーム自動入力に使う」で選ぶ）。
 * ここは Jev のキーだけ。**Mac ごとに**端末鍵で暗号化して userData に置く（`jev-key.ts`）。
 * 保存 / 削除だけで、値は返ってこない。
 */
export function Autofill(): React.JSX.Element {
  const [status, setStatus] = useState<AutofillStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyMessage, setKeyMessage] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.nemo.autofillStatus().then(setStatus)
  }, [])
  useEffect(reload, [reload])

  const saveKey = (): void => {
    const key = keyDraft.trim()
    if (!key) return
    void window.nemo.saveJevKey(key).then((ok) => {
      // 失敗したときは入力を残す（貼り直さずに済むように）
      if (ok) setKeyDraft('')
      setKeyMessage(ok ? '保存しました。' : 'この Mac では暗号化を利用できないため、保存できません。')
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

  return (
    <SettingsSection
      title="フォーム自動入力"
      sub="入力欄を右クリック →「フォーム自動入力」で、空いている欄を kypr の個人情報で埋めます。欄の見出しだけを Jev（TypeSafe AI）に送って判定し、値は送りません"
    >
      <div data-testid="autofill">
        <p className="dim" data-testid="autofill-source">
          入れる値は kypr の「個人情報」です（ツールバーの kypr →
          個人情報。複数あるときは詳細の「フォーム自動入力に使う」で選びます）。
        </p>
        <div className="set-row" data-testid="autofill-jev">
          <span>Jev の API キー</span>
          <span className="dim" data-testid="autofill-jev-state">
            {status.hasJevKey ? '保存済み' : '未設定（autocomplete 属性のある欄だけ入ります）'}
          </span>
        </div>
        {!status.encryptionAvailable ? (
          <p className="warn">この Mac では暗号化を利用できないため、キーを保存できません。</p>
        ) : null}
        <div className="set-row">
          <span className="set-input wide">
            <input
              type="password"
              disabled={!status.encryptionAvailable}
              value={keyDraft}
              spellCheck={false}
              placeholder={status.hasJevKey ? '（保存済み）' : 'apikey_…'}
              data-testid="autofill-jev-input"
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey()
              }}
            />
          </span>
          <button
            type="button"
            className="btn"
            disabled={!status.encryptionAvailable || keyDraft.trim().length === 0}
            onClick={saveKey}
          >
            保存する
          </button>
          {status.hasJevKey ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void window.nemo.clearJevKey().then(() => {
                  setKeyMessage('消しました。')
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
          キーは console.typesafe.ai で発行します。この Mac にだけ保存するので、別の Mac
          ではそれぞれ保存してください。値はここには出ません。
        </p>
      </div>
    </SettingsSection>
  )
}
