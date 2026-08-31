# Peek 表示中のコマンド対象を前面（Peek 優先）に統一する

## 概要・やりたいこと

新規タブがポップアップ（Peek）の状態で開いているとき、⌘L のアドレスバーに裏の親タブの URL が表示されてしまう。前面に見えている Peek の URL が表示され、編集して Enter したら Peek 自身が遷移するようにしたい。

同じズレは ⌘L 以外にもあり、「いま見えているページへの操作」系コマンド（reload / go-back / go-forward / copy-url / toggle-devtools / zoom / find）はすべて Peek 表示中でも親タブを操作してしまう。今回まとめて「前面 = Peek 優先」に統一する。

## 前提・わかっていること

### 原因の構造
- Peek は `win.tabs` に入るが、設計上 `activeTabKey` には決してならない（`registry.ts:2359` の `selectTab` で親に読み替え。サイドバー一覧・⌘1〜9・セッションの activeIndex を壊さないため）。この設計自体は維持する
- main 側には既に「前面 = `active?.peek ?? active`」という正しい規則がある（`registry.ts:2331` `syncForegroundTab`、拡張の chrome.tabs 用）。renderer とメニューコマンド側だけがこの規則を持っていない
- renderer で Peek を引く既存の書き方: `Peek.tsx:16` の `state.tabs.find(t => t.peekParentKey === state.activeTabKey)`。`TabState.peekParentKey` で判別できる（`types.ts:324-327`）

### ズレている箇所
- **⌘L の URL 表示**: `Overlay.tsx:157` で `activeTabKey` 一致だけで `activeTab` を引く → 初期値（`:161`）・`focus-address` 受信時（`:165`）とも親タブの URL が入る
- **⌘L の Enter**: `Overlay.tsx` の `run()` が `window.nemo.navigate(activeTab.key, ...)` → 親タブが遷移する
- **メニューコマンド**: `menu.ts:119` の単一束縛 `const tab = win.getActiveTab()` を各 case が共有しており、reload / reload-ignoring-cache / go-back / go-forward / toggle-devtools が親タブ対象。**copy-url は main では対象が決まらない**（`menu.ts:174` は存在チェックのみで、実際に key を選ぶのは renderer の `Sidebar.tsx:41` の `activeTabKey` 一致）。例外的に Peek を見ているのは `close-tab` と `promote-peek` のみ
- **zoom-in / zoom-out / zoom-reset**（`menu.ts:152`）と **⌘F の検索**（`Overlay.tsx` の FindBar が `state.activeTabKey` で検索）も同じズレを持つ
- **⌘L の Esc 後のフォーカス復帰**: `registry.ts:1747` `setOverlay(null)` が `getActiveTab()?.webContents?.focus()` → Peek 上で ⌘L → Esc すると裏の親ページにフォーカスが入る

### コードを読んで確定している事実（確認ステップ不要）
- `nemo:navigate` は `requireTab` → `win.findTab`（`registry.ts:1884`、`tabs` 全体を見ており `normalTabs` ではない）なので Peek の key で通る
- `newTab={true}` の CommandBar が `activeTab` を読むのは `run()` の navigate 分岐だけで、`wantsNewTab` が真なら `createTab` に倒れるため影響なし
- Peek は asleep にならない: `sweepSleep` は `win.normalTabs` しか回さない（`tab.peek` を持つ親も寝かせない）。reload の `if (tab?.asleep)` 分岐は `foreground.asleep` が常に false なのでそのままでよい（コメント1行で残す）
- `syncForegroundTab` を awaiting 除外に変えると、拡張から見た active が Peek に切り替わる瞬間が `openPeek` 時点 → dom-ready（`reveal()`）に後ろへずれる。`reveal()` が親を選択中のときだけ `selectTab` 経由で再同期するので結果は成立するが、**この reveal 経由の再同期に暗黙に依存する**（崩れると `tab.foreground` が親のまま固まる）
- ⌘F の find 状態はタブごと（`found-in-page` が `tab.find` に書く）で、UI が読む `WindowState.find` は `toState()` の `find: active?.find ?? null` ＝選択タブから引いている → 検索対象 key の差し替えだけでは FindBar の `n/N` が出ない

### 決定事項（/dig-lite + レビュー）
- **Enter の遷移先**: Peek 自身を遷移させる（アドレスバーは「いま見ているページ」を編集するもの、という一貫性。表示と操作対象を揃える）
- **遷移後も Peek のまま維持する**（1回目レビューで決定）: 昇格は ⌘O が既にあり、暗黙昇格は「閉じたら消える」という Peek の約束を壊す。帰結として、⌘L で別サイトへ飛ばした Peek も `ephemeralId` を持たず（定義が作られるのは `promotePeek` のみ）、閉じると履歴以外に何も残らない — 人間の動作確認で違和感がないか見る観点に入れる
- **前面が変わったら（Peek が閉じた・⌘O 昇格した・親を検索中に Peek が開いた）FindBar は閉じて `stopFind` を撃つ**（2回目レビューで決定）: 開いたまま `0/0` を表示し Peek 側のハイライトが残る経路を塞ぐ。契機は「前面 key が変わったら」で統一（開いた向きにも効くのは意図どおり）
- 検索中に通常のタブ切り替え（サイドバークリック・⌘⌥→ 等）をした場合も同じ契機で FindBar が閉じる（実装レビュー1回目で決定。従来はバーが残っていたが、「前面 key の変化で統一」の帰結として採用。CHANGELOG に記載）。ただし **state の初回 push（null → key）は前面の変化と数えない**（ウィンドウ生成直後の ⌘F が無症状で閉じるため）
- **スコープ**: ⌘L だけでなく reload / reload-ignoring-cache / go-back / go-forward / copy-url / toggle-devtools / zoom-in / zoom-out / zoom-reset / ⌘F（find）も foreground（Peek 優先）に統一する（zoom と find は1回目レビューで追加。ユーザーが「全部揃える＝いま見えているページへの操作は前面に統一」を選択済みで、同じ理屈がそのまま通る）
- **前面の定義は `visibleTabKeys` と揃える**（1回目レビューで決定）: `peekAwaitingDocument` の Peek（まだ表示されていない）は前面としない。`window.open` 直後の ⌘L で `about:blank` がアドレスバーに入るのを防ぐ。main / renderer 両側で同じ条件にする。**同じなのは意味であって式ではない**: main は `peekAwaitingDocument` を見る（`view.getVisible()` を条件に使うと `getForegroundTab()` → `visibleTabKeys` → `applyVisibility` → `getVisible()` の循環になる）。renderer は push 済みの `TabState.visible` を見る（結果なので循環しない）
- **pin-tab は対象外**: ピン留めはタブの定義操作であり Peek には概念が合わない（Peek は `normalTabs` に入らない）。親タブ対象のまま
- **小窓（mini）は対象外**: ⌘L は `MINI_BLOCKED_COMMANDS`（`menu.ts:57`）と `setOverlay`（`registry.ts:1742`）の二重で意図的に無効。MiniBar の docstring にも明記された設計なので触らない
- **Toolbar のアドレス欄・戻る / 進む / ⟳ は据え置き（親タブ対象のまま）**（1回目レビューで決定、実装レビュー1回目で根拠を訂正）: 当初の根拠「クリックは暗幕が食うので操作不能」は誤り —— 暗幕は `pageBoundsFor`（ツールバーの下）にしか敷かれず、Peek 表示中もツールバーのボタンは押せる。つまり ⌘R / ⌘[ は Peek・ツールバーのボタンは親、という食い違いが残っている。前面に寄せるにはペイン対応の導出（右ペインのツールバーが左の Peek を操作しない形）が要るため今回の範囲外。**据え置きでユーザー確定**（実装レビュー終了報告への回答）。前面に寄せるなら別タスクに切る
- 判定は寄せる: main は `NemoWindow` の述語 1 つ、renderer は `peekTab(state)` の上に `foregroundTab(state)` を組む 2 段（実体の導出は 1 か所。同じ導出をコマンドごとに書き散らさない）

## 実装計画

### Phase 1: main 側 — foreground 述語の導入とメニューコマンドの統一 [AI🤖]
- [x] `NemoWindow` に前面タブを返す述語を 1 つ用意する（`getForegroundTab(): NemoTab | null`。導出は `active?.peek ?? active` だが `peekAwaitingDocument` の Peek は前面としない。`registry.ts:2331` `syncForegroundTab` の導出もこれに寄せ、**`visibleTabKeys` の自前条件 `if (active.peek && !active.peek.peekAwaitingDocument)` も `getForegroundTab()` 経由に書き換えて条件の実体を 1 か所にする**。片方だけ条件を触ると「見えていないページにコマンドが向く」という今回のバグが再発する）
- [x] 既存の `getActiveTab()` 呼び出し（16箇所）を「選択（activeTabKey 由来）」と「前面」に仕分けする表を作り、ログに残す。`layout` / `visibleSplit` / `toSaved` / `mruTabs` は「選択」のまま。`registry.ts:1747` `setOverlay(null)` のフォーカス復帰は「前面」に差し替える（⌘L → Esc で裏の親ページにフォーカスが入るのを防ぐ）。`extensions.ts` の拡張アイコン再描画 nudge（`focusedOrFirstWindow()?.getActiveTab()?.webContents` に `tab-updated`）は `syncForegroundTab` と同じ「chrome から見た active」を狙う場所なので前面側に入る見込み
- [x] `menu.ts` は単一束縛 `const tab`（`:119`）を丸ごと差し替えず、`const foreground = win.getForegroundTab()` を別に足して対象コマンド（reload / reload-ignoring-cache / go-back / go-forward / toggle-devtools / zoom-in / zoom-out / zoom-reset）の case だけ `foreground` を読む（pin-tab / add-favorite / next-tab 等は `tab` のまま）
- [x] `toState()` の `find: active?.find ?? null` を前面タブから引くよう変える（⌘F の `n/N` 表示のため。前提の「find 状態はタブごと」を参照）

### Phase 2: renderer 側 — ⌘L・copy-url・find の対象 [AI🤖]
- [x] renderer 側の導出は 2 つに分ける: `peekTab(state)`（`visible` を問わず Peek を返す。`Peek.tsx` 用 — awaiting 中もプレースホルダー・暗幕を描く必要があり、かつ Peek が無いとき null を返す必要がある）と `foregroundTab(state)` = visible な Peek ?? activeTab（コマンド用）。後者は前者の上に組む
- [x] `Overlay.tsx` の CommandBar の `activeTab` 導出を `foregroundTab(state)` に差し替える。初期値（`:161`）・`focus-address` 受信時（`:165`）・`run()` の `navigate()` 先がすべて同じ foreground タブを指すようにする
- [x] `Overlay.tsx` の FindBar（⌘F）の検索対象も `foregroundTab(state)` に差し替える
- [x] `Sidebar.tsx:41` の copy-url の対象タブ導出も `foregroundTab(state)` に差し替える（copy-url の key 選択は renderer 側にある）
- [x] 決定「前面が変わったら FindBar を閉じて `stopFind`」を実装する。罠に注意: 前面変化を `foregroundTab(state)?.key` の変化で検知すると `close()` 時点の key はもう新しい前面なので、**直前の前面 key を ref で保持**する。その key が `state.tabs` に残っているときだけ `stopFind` を撃ち（⌘O 昇格はタブが残るのでこちら）、消えていれば `onClose()` のみ（Peek が閉じた場合は WebContents ごと破棄されるのでハイライトも消える。`nemo:stop-find` は `requireTab` で throw するため撃たない）

### Phase 3: 自走検証 [AI🤖]
- [x] 使い捨てプロファイル（`NEMO_USER_DATA_DIR`）で別インスタンスを起動する（**起動中の常用 Nemo は絶対に操作しない**）。コマンドの発火は合成キーでなく `nemo:run-command-for-verify`（`ipc.ts:382`、`NEMO_VERIFY_DIAGNOSTICS=1` で有効）で撃つ
- [x] `window.open` で Peek を開いた状態で focus-address → アドレスバーに Peek の URL が出ることを確認する（修正前に FAIL することを先に確認してから直す）
- [x] その状態で URL を書き換えて確定 → Peek 側の WebContents が遷移し、親タブの URL が変わらず、Peek のまま維持されることを確認する
- [x] Peek 表示中の reload / go-back / copy-url / find / zoom が Peek を対象にすることを確認する。判定はコマンドの対象 key を 1 行ログに出して読む（`registry.ts:2344` にイディオムの前例あり）。copy-url と find は main のコマンド分岐では key が決まらないので、ログは key を受け取る IPC 側（`nemo:copy-url`・`nemo:find`）に出す（`nemo:copy-url` はログ新設になるため「検証が対象 key を判定するためのログ」とコメントを残す）
- [x] Peek を検索中に Peek を閉じる → FindBar が閉じ、`ui.error` ログが出ていないことを確認する（消えた key への `stopFind` は renderer の unhandled rejection → `ui.error` にしか出ず画面上は無症状）
- ~~[ ] Peek 検索中に ⌘O 昇格 → `nemo:stop-find` が昇格後の key で 1 回だけ飛ぶことを確認する~~（`promotePeek` は key を変えないため前面 key の変化が起きない。ログ > 方針変更 参照）
- [x] 既存 verify-peek の fg アサーション（`lastForeground()`）が awaiting 除外後も通ることを確認する（reveal 経由の再同期への暗黙依存を検知するため）
- [x] Peek が無い通常状態で ⌘L・reload 等が従来どおり動くことを確認する（リグレッション）。既知の挙動: `window.open` 直後（awaiting 中）に ⌘L を押すと親の URL が入り、Peek が出ても書き換わらない — 決定「awaiting は前面としない」の帰結であり回帰ではない
- [x] `scripts/verify-peek.mjs` に恒久ケースを足す（次に `getActiveTab()` や `toState().find` を触った誰かが黙って壊せる不変条件のため）: 「Peek 表示中の focus-address / reload / go-back / copy-url が Peek を対象にする」に加え、find は 2 段に分ける — (a) `window.nemo.find(peekKey, …)` 直叩きで `n/N` が Peek 側の件数を返す（main 側 `toState().find` を守る）、(b) `find` コマンドを撃って FindBar 経由で検索し `nemo:find` の key ログが Peek を指す（renderer 側 `foregroundTab` を守る。`verify-phase1.mjs` の直叩きイディオムだけだと renderer の導出を一切通らない）
- [x] 既存の検証スイートを回す。`menu.ts` / `Overlay.tsx` / `Sidebar.tsx` は複数スイートが依存するため **`OWNERS` には追加せず**、`--changed` がフルに倒れることを確認する（実行件数を必ず出す）→ フル実行 856 検査すべて PASS。`selectVerifyTargets` に今回の差分を渡すと `kind: 'full'`（reason: 担当スイートが確定できない）になることを確認済み

### 動作確認 [人間👨‍💻]
- [ ] 実際の利用フロー（ポップアップを開くサイト）で ⌘L の表示・遷移が期待どおりか目視確認

## ログ
### 試したこと・わかったこと
- 修正前 FAIL の確認: src/ だけ stash して peek スイートを実行（97 検査）。新設 8 検査がすべて期待どおり FAIL（⌘L に親 URL・copy-url ログ無し・zoom が親に効く・find n/N=0・FindBar が親対象・reload が親に効く・go-back が Peek に効かない・Peek 閉じで FindBar 残留）。pop 後の再実行で 97 件 PASS
- フル実行（848 検査）で新セクションの `connectPage('index.html')` が「target が1つに定まらない（2件）」で例外 → peek スイートが途中終了。他スイートの残タブと URL が衝突するのが原因（--only 実行では 1 件で通るため気づけない）。子 URL を `index.html?peek-foreground` に一意化して解消
- 既存検査「Peek が出ている間は暗幕の View が表示されている」が同一コードで 4 run 中 2 回 FAIL（hidden）。診断の結論: 判定に使っていた renderer の `document.visibilityState` は **View の可視性だけでなく検証ウィンドウ自体の遮蔽（別 Space・前面の他ウィンドウ）でも hidden になる**環境依存の信号だった。target 取り違え説（`view=peek` が複数）は否定 —— 全 run のログで暗幕セクション時点のウィンドウは 1 枚のみ（R9 の `moveTabToNewWindow` はタブ 1 枚だと no-op）。対処: 開き・閉じ両側の判定を main の実状態（`splitDiagnostics().peekScrim` = `getVisible()`）に差し替え、visibilityState は診断詳細に降格。暗幕セッションの接続も `view=peek&window=N` の名指しに変更
- `getActiveTab()` 16箇所の仕分け表:
  - **前面へ**: `registry.ts` setOverlay(null) フォーカス復帰 / `extensions.ts` 拡張アイコン nudge
  - **述語へ統合**: `registry.ts` visibleTabKeys / syncForegroundTab（`getForegroundTab()` 経由に）
  - **find だけ前面**: `registry.ts` toState()（`activeTabKey` は選択のまま）
  - **選択のまま**: layout / splitDiagnostics / visibleSplit / applyVisibility / toSaved / `tab-switcher.ts` mruTabs / `menu.ts` の find ゲート（存在チェックのみ）と `const tab`（対象コマンドだけ `foreground` を別束縛）
  - **据え置き（Peek 直接参照）**: `registry.ts` promoteForegroundView / `ipc.ts` close-peek — `getActiveTab()?.peek` のまま。awaiting 中の Peek も昇格・閉じ操作の対象にする必要があるため `getForegroundTab()` に寄せない

- 実装レビューで見送った「`nemo:stop-find` への key ログ追加（ui.error 増分チェックの強化）」は**やらないでユーザー確定**

### 方針変更
- ⌘O 昇格時の FindBar: plan は「stopFind が昇格後の key で飛ぶ」を想定したが、`promotePeek` は **key を変えずに** Peek を通常タブ化して選択するため、前面 key は変わらない。決定「契機は前面 key の変化」に従い、**昇格では FindBar は閉じず検索がそのまま続く**（n/N は同じタブの値で正しく出続ける）。閉じる経路が動くのは Peek を閉じた・親検索中に Peek が開いた場合
