import { useCallback, useEffect, useRef, useState } from 'react'
import type { SlotList, SlotSummary } from '../../shared/types.js'
import { Favicon } from './Sidebar.js'
import { SettingsSection } from './SettingsSection.js'

/**
 * ブックマークのセーブスロット（設定 › ブックマークのセーブスロット）。
 *
 * 3 枠のカードに「保存 / 読み込み」を出す。**上書き保存の導線は置かない** ——
 * 上書きは「削除 → 保存」の 2 手にして、うっかり潰せないようにする。
 *
 * 一覧は**開くたびに取り直す**。iCloud 経由で別の Mac が書き換えるので、
 * 画面を開いたまま古い一覧を持ち続けると「保存したのに空きに見える」が起きる。
 *
 * 破壊的な操作（読み込み / 削除 / 保存）は必ず確認ダイアログを 1 回挟む。
 * undo が無いので、ここが最後の関門になる。
 */

type Confirm =
  | { kind: 'save'; index: number }
  | { kind: 'apply'; slot: SlotSummary }
  | { kind: 'delete'; slot: SlotSummary }

export function Slots(): React.JSX.Element {
  const [list, setList] = useState<SlotList | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 一覧そのものが取れなかった。**`list` に偽の値を入れて表さない**。 */
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    // IPC が落ちても**画面が黙って空になる**のは避ける（カード 0 枚と区別が付かない）。
    // **偽の `SlotList` を作らない** —— `kind` や `dir` を勝手に埋めると、
    // 保存先について事実でない案内（fallback の注記）が出て誤診の元になる
    void window.nemo.listSlots().then(
      (next) => {
        setFailed(false)
        setList(next)
      },
      (error: unknown) => {
        console.error('listSlots failed', error)
        setFailed(true)
        setError('スロットの一覧を読めませんでした。')
      }
    )
  }, [])

  useEffect(refresh, [refresh])

  const run = useCallback(
    async (action: () => Promise<boolean>, failure: string) => {
      setBusy(true)
      setError(null)
      // **失敗しても必ず busy を戻す**（戻さないとダイアログのボタンが押せないまま固まる）
      let ok = false
      try {
        ok = await action()
      } catch (error) {
        console.error('slot action failed', error)
      }
      setBusy(false)
      setConfirm(null)
      if (!ok) setError(failure)
      refresh()
    },
    [refresh]
  )

  // 「現在」はスロットの合計ではなく**いまのブラウザの中身**。main が数えたものを使う
  // （ピン留めの数え方をここで書き直すと、フォルダの扱いが静かに食い違う）
  const current = list?.current ?? null

  return (
    <SettingsSection
      title="ブックマークの持ち出し"
      sub="ピン留めとお気に入りを 3 つのスロットに保存し、別の Mac で読み込みます。保存先は iCloud Drive です"
    >
      <div className="slots" data-testid="slots">
        {list === null && !failed && <p className="dim">読み込み中…</p>}
        {(list?.slots ?? []).map((slot) => (
          <SlotCard
            key={slot.index}
            slot={slot}
            busy={busy}
            onSave={() => setConfirm({ kind: 'save', index: slot.index })}
            onApply={() => setConfirm({ kind: 'apply', slot })}
            onDelete={() => setConfirm({ kind: 'delete', slot })}
            onRename={(name) =>
              void run(() => window.nemo.renameSlot(slot.index, name), '名前を変更できませんでした。')
            }
            onRetry={refresh}
            onOpenFolder={() => void window.nemo.openSlotsFolder()}
          />
        ))}
      </div>

      {error !== null && (
        <p className="slots-error" data-testid="slots-error">
          {error}
        </p>
      )}

      <div className="slots-path">
        <span className="dim">保存先</span>
        <code data-testid="slots-dir">{list ? shorten(list.dir) : '…'}</code>
        <button type="button" className="btn" onClick={() => void window.nemo.openSlotsFolder()}>
          フォルダを開く
        </button>
      </div>

      {/* iCloud に保存したつもりでこの Mac の中だけ、を黙って起こさない */}
      {list?.kind === 'fallback' && (
        <p className="dim" data-testid="slots-fallback">
          iCloud Drive が見つからないので、この Mac の中に保存します。ほかの Mac からは見えません。
        </p>
      )}

      {confirm !== null && (
        <ConfirmDialog
          confirm={confirm}
          current={current}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onSave={(index) =>
            void run(
              () => window.nemo.saveSlot(index),
              '保存できませんでした。フォルダの状態を確認してください。'
            )
          }
          onApply={(index) =>
            void run(() => window.nemo.applySlot(index), '読み込めませんでした。何も変わっていません。')
          }
          onDelete={(index) => void run(() => window.nemo.deleteSlot(index), '削除できませんでした。')}
        />
      )}
    </SettingsSection>
  )
}

/** ホームディレクトリは `~` に畳む（設定画面にフルパスを晒さない）。 */
function shorten(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+/, '~')
}

function formatDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function SlotCard({
  slot,
  busy,
  onSave,
  onApply,
  onDelete,
  onRename,
  onRetry,
  onOpenFolder
}: {
  slot: SlotSummary
  busy: boolean
  onSave: () => void
  onApply: () => void
  onDelete: () => void
  onRename: (name: string) => void
  onRetry: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [menuUp, setMenuUp] = useState(false)

  // メニューはカード外クリックと Esc で閉じる
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      // **止めないと `Overlay` の window リスナーが設定パネルごと閉じる**（1 段だけ戻したい）
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenuOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const openMenu = (event: React.MouseEvent): void => {
    event.stopPropagation()
    // パネルの下端に収まらないなら上向きに出す（設定パネルは overflow で切れる）
    const rect = cardRef.current?.getBoundingClientRect()
    setMenuUp(rect ? rect.bottom + 120 > window.innerHeight : false)
    setMenuOpen((open) => !open)
  }

  const label = `SLOT ${slot.index + 1}`

  if (slot.state === 'empty') {
    return (
      <div className="slot empty" data-testid={`slot-${slot.index}`} ref={cardRef}>
        <div className="slot-head">
          <span className="slot-no">{label}</span>
        </div>
        <div className="slot-blank">空き</div>
        {slot.hasConflictCopy && <ConflictNote onOpenFolder={onOpenFolder} />}
        <button
          type="button"
          className="btn slot-action"
          disabled={busy}
          onClick={onSave}
          data-testid={`slot-save-${slot.index}`}
        >
          保存
        </button>
      </div>
    )
  }

  if (slot.state === 'unreadable') {
    return (
      <div className="slot broken" data-testid={`slot-${slot.index}`} ref={cardRef}>
        <div className="slot-head">
          <span className="slot-no">{label}</span>
          <div className="spacer" />
          <MenuButton onClick={openMenu} open={menuOpen} index={slot.index} />
          {menuOpen && (
            <div className={`slot-menu${menuUp ? ' up' : ''}`} onClick={(e) => e.stopPropagation()}>
              {/* 読めない枠は read-modify-write のリネームができない。削除だけ出す */}
              <button type="button" className="danger" onClick={onDelete}>
                削除
              </button>
            </div>
          )}
        </div>
        <div className="slot-blank warn" data-testid={`slot-reason-${slot.index}`}>
          {slot.reason ?? '読み込めませんでした'}
        </div>
        {slot.hasConflictCopy && <ConflictNote onOpenFolder={onOpenFolder} />}
        {/*
         * 常時無効の「読み込む」は、パネルを開き直すまで絶対に有効化されない死んだボタン。
         * **一覧はキャッシュを持たず毎回ディスクを読む**ので、押し直せば直る場面がある:
         *   - iCloud の未ダウンロード → 落ち終われば読める
         *   - 中身が壊れていた → 読んだ時点で退避済みなので、次は「空き」に戻る
         * 権限拒否だけは押しても同じ表示に戻るが、害は無い。
         */}
        <button
          type="button"
          className="btn slot-action"
          disabled={busy}
          onClick={onRetry}
          data-testid={`slot-retry-${slot.index}`}
        >
          再試行
        </button>
      </div>
    )
  }

  return (
    <div className="slot" data-testid={`slot-${slot.index}`} ref={cardRef}>
      <div className="slot-head">
        <span className="slot-no">{label}</span>
        <div className="spacer" />
        <MenuButton onClick={openMenu} open={menuOpen} index={slot.index} />
        {menuOpen && (
          <div className={`slot-menu${menuUp ? ' up' : ''}`} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                setEditing(true)
              }}
            >
              名前を変更…
            </button>
            <div className="sep" />
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenuOpen(false)
                onDelete()
              }}
              data-testid={`slot-delete-${slot.index}`}
            >
              削除
            </button>
          </div>
        )}
      </div>

      <SlotName
        name={slot.name}
        editing={editing}
        onDone={(name) => {
          setEditing(false)
          if (name !== null && name !== slot.name) onRename(name)
        }}
        onStart={() => setEditing(true)}
      />

      <div className="slot-meta">
        {formatDate(slot.savedAt)}
        {slot.host ? ` ・ ${slot.host}` : ''}
      </div>
      <div className="slot-counts">
        ピン <b>{slot.pins}</b> 件・お気に入り <b>{slot.favs}</b> 件
      </div>

      <div className="slot-icons">
        {slot.icons.map((icon) => (
          <Favicon key={icon.url} url={icon.url} title={icon.url} src={icon.faviconUrl} />
        ))}
        {/* 打ち切ったときだけ出す。件数は main が数える（`MAX_SLOT_ICONS` を
            renderer に持ち込むと `slots-schema.js` を web の tsconfig に入れることになる） */}
        {slot.moreIcons > 0 && (
          <span className="slot-icons-more" data-testid={`slot-icons-more-${slot.index}`}>
            +{slot.moreIcons}
          </span>
        )}
      </div>

      {slot.hasConflictCopy && <ConflictNote onOpenFolder={onOpenFolder} />}

      <button
        type="button"
        className="btn primary slot-action"
        disabled={busy}
        onClick={onApply}
        data-testid={`slot-load-${slot.index}`}
      >
        読み込む
      </button>
    </div>
  )
}

/**
 * iCloud の競合コピーがある枠。
 * **勝手に直さず、気づける形にだけする** —— 放っておくと
 * 「保存したのに 2 台目で見えない」の原因に辿り着けない。
 */
function ConflictNote({ onOpenFolder }: { onOpenFolder: () => void }): React.JSX.Element {
  return (
    <p className="slot-conflict" data-testid="slot-conflict">
      同じ枠に別の Mac からも保存されています。
      <button type="button" className="link" onClick={onOpenFolder}>
        フォルダを開く
      </button>
    </p>
  )
}

function MenuButton({
  onClick,
  open,
  index
}: {
  onClick: (event: React.MouseEvent) => void
  open: boolean
  index: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`slot-menu-btn${open ? ' on' : ''}`}
      onClick={onClick}
      aria-label="このスロットの操作"
      data-testid={`slot-menu-${index}`}
    >
      {/* アイコンフォントも絵文字も使わない（DESIGN.md）。3 点はインライン SVG で描く */}
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="3" cy="7" r="1.2" fill="currentColor" />
        <circle cx="7" cy="7" r="1.2" fill="currentColor" />
        <circle cx="11" cy="7" r="1.2" fill="currentColor" />
      </svg>
    </button>
  )
}

/** 名前はクリックでその場編集。Enter / blur で確定、Esc で取消。 */
function SlotName({
  name,
  editing,
  onDone,
  onStart
}: {
  name: string
  editing: boolean
  onDone: (name: string | null) => void
  onStart: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!editing) return
    cancelled.current = false
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <button type="button" className="slot-name" onClick={onStart}>
        {name}
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      className="slot-name editing"
      defaultValue={name}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          // 設定パネルまで閉じない（取消はこの入力欄で止める）
          event.stopPropagation()
          cancelled.current = true
          event.currentTarget.blur()
        }
      }}
      onBlur={(event) => onDone(cancelled.current ? null : event.currentTarget.value)}
    />
  )
}

/**
 * 確認ダイアログ。
 *
 * 文面は「何が消えるか」を先に言う。**`data-testid` を付けて自走検証から押せる形**にする
 * （`PromptDialog` と同じ流儀。押せないと通しの確認が組めない）。
 */
function ConfirmDialog({
  confirm,
  current,
  busy,
  onCancel,
  onSave,
  onApply,
  onDelete
}: {
  confirm: Confirm
  current: { pins: number; favs: number } | null
  busy: boolean
  onCancel: () => void
  onSave: (index: number) => void
  onApply: (index: number) => void
  onDelete: (index: number) => void
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

  const body = (): React.JSX.Element => {
    if (confirm.kind === 'save') {
      return (
        <>
          <h4>スロット {confirm.index + 1} に保存する</h4>
          <p>現在のピン留めとお気に入りを、このスロットに保存します。</p>
        </>
      )
    }
    if (confirm.kind === 'apply') {
      return (
        <>
          <h4>このスロットを読み込む</h4>
          <p>
            <strong>「{confirm.slot.name}」</strong>の内容で、現在のピン留めとお気に入りを
            <strong>まるごと置き換えます</strong>。
          </p>
          <div className="dlg-diff">
            {current !== null && (
              <div>
                <span className="k">現在</span>
                ピン <b>{current.pins}</b> 件・お気に入り <b>{current.favs}</b> 件
              </div>
            )}
            <div>
              <span className="k">読み込み後</span>
              ピン <b>{confirm.slot.pins}</b> 件・お気に入り <b>{confirm.slot.favs}</b> 件
            </div>
          </div>
          <div className="dlg-warn">
            現在のピン留めとお気に入りは<strong>元に戻せません</strong>
            。残しておきたいときは、先に空きスロットへ保存してください。
            <br />
            現在開いているピン留め・お気に入りのタブは、すべて「今日のタブ」に移ります（ページは閉じません）。
          </div>
        </>
      )
    }
    return (
      <>
        <h4>スロット {confirm.slot.index + 1} を削除する</h4>
        <p>
          <strong>「{confirm.slot.name}」</strong>（ピン {confirm.slot.pins} 件・お気に入り{' '}
          {confirm.slot.favs} 件）を削除します。元には戻せません。削除しますか？
        </p>
        <p className="dim">現在開いているピン留めとお気に入りには影響しません。</p>
      </>
    )
  }

  const confirmLabel =
    confirm.kind === 'save' ? '保存する' : confirm.kind === 'apply' ? '読み込む' : '削除する'
  const danger = confirm.kind !== 'save'

  return (
    <div className="slot-scrim" onClick={onCancel}>
      <div
        className="slot-dlg"
        onClick={(event) => event.stopPropagation()}
        data-testid={`slot-confirm-${confirm.kind}`}
      >
        {body()}
        <div className="dlg-foot">
          <button type="button" className="btn" onClick={onCancel} data-testid="slot-confirm-cancel">
            キャンセル
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy}
            data-testid="slot-confirm-ok"
            onClick={() => {
              if (confirm.kind === 'save') onSave(confirm.index)
              else if (confirm.kind === 'apply') onApply(confirm.slot.index)
              else onDelete(confirm.slot.index)
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
