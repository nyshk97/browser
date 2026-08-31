review session: c2bf8daf-590b-49ef-b205-1c7b4786eaf6

# レビューログ: peek-foreground-commands

## 1回目

````text
レビュー結果です。plan の記述はコードに当たって全部確認しました。

## P0
- **Phase 1 > 2** — `copy-url` は main では対象が決まらない。`menu.ts:174` は `if (tab) sendToUi(win, 'copy-url')` で存在チェックしかせず、実際に key を選ぶのは renderer の `Sidebar.tsx:41`（`tab.key === state.activeTabKey` で引く＝親）。Phase 1 で `getForegroundTab()` に替えても copy-url の挙動は 1 ミリも変わらず、Phase 3 の検証で FAIL して戻ってくる。`Sidebar.tsx` の `activeTab` 導出を foreground に寄せる作業を Phase 2 に足す。
- **Phase 1 > 2** — 「reload / go-back / … の対象を `getActiveTab()` → `getForegroundTab()` に差し替える」と読めるが、実際の `getActiveTab()` 呼び出しは各 case ではなく `menu.ts:119` の単一束縛 `const tab` 1 個だけ（`menu.ts:~253` という位置指定も誤りで、253 行は `installApplicationMenu` の中）。ここを丸ごと差し替えると `pin-tab` / `add-favorite` / `zoom-*` / `next-tab` まで Peek 対象になり、決定事項「pin-tab は対象外」と正面から矛盾する。`const foreground = win.getForegroundTab()` を別に足し、対象コマンドの case だけ `foreground` を読む、と明記する。
- **Phase 1 > 1** — 述語を足すだけで、既存 16 箇所の `getActiveTab()` を「選択（activeTabKey 由来）」と「前面」に仕分けるステップが無い。少なくとも `registry.ts:1747`（`setOverlay(null)` の focus 復帰が `getActiveTab()?.webContents?.focus()`）は今回直す ⌘L 経路そのもので、Peek 上で ⌘L → Esc するとフォーカスが裏の親ページへ戻り、以後のキー入力が見えないページに入る。仕分け表を作るステップを Phase 1 に足し、`setOverlay` の focus 復帰は foreground に差し替える（`layout` / `visibleSplit` / `toSaved` / `mruTabs` は「選択」のままが正しい）。

## P1
- **Phase 1 > 2** — 対象一覧に `reload-ignoring-cache`（⇧⌘R、`menu.ts:150`）が無い。reload の 1 行下・同じ束縛を読むので、片方だけ前面にすると「⌘R は Peek、⇧⌘R は親」という説明不能な差が残る。一覧に足す。
- **Phase 1 > 2** — reload の case は 2 分岐で、`if (tab?.asleep) selectTab(win, tab.key)` を含む。ここに Peek の key を渡すと `selectTab` の `peekOf` 読み替え（`registry.ts:2350` 付近）で**親が選び直される**。Peek は asleep にならない想定なら `foreground.asleep` 側は早期 return にする、と分岐の扱いまで書く。
- **Phase 1 > 1 / Phase 2 > 1** — 前面の定義が main と renderer で揃わない。main の `active?.peek ?? active` は `peekAwaitingDocument` の Peek も前面として返すが、`visibleTabKeys`（`registry.ts:1792`）はそれを表示対象から外し、`Peek.tsx` は `!peek.visible` の間プレースホルダーを描く。つまり `window.open` 直後に ⌘L を押すと、まだ何も見えていない Peek の `about:blank`／空 URL がアドレスバーに入りうる。述語の条件を `visibleTabKeys` と揃える（`peekAwaitingDocument` の Peek は前面としない）ことを決めて両側に書く。
- **Phase 2 > 1** — 「共通化できるなら導出関数を 1 つに切り出す」が努力目標になっている。今回で renderer 側の同じ導出が `Peek.tsx` / `Overlay.tsx` / `Sidebar.tsx` の 3 箇所になり、決定事項「判定は述語 1 つに寄せる」と食い違う。`foregroundTab(state)` を `useNemo.ts` あたりに 1 つ置き、既存の `Peek.tsx:16` もそこ経由に書き換える、と確定させる。
- **Phase 3 > 2〜5** — 合成キー前提の手順に見えるが、`ipc.ts:382` に `nemo:run-command-for-verify`（`NEMO_VERIFY_DIAGNOSTICS=1` で有効、`COMMANDS` に載っている id をそのまま実行）がある。合成キーは `verify-targets.mjs` の `OPT_IN_ONLY` docstring が「後続スイートを壊す回帰」として名指ししている手段なので、わざわざそちらを増やす理由がない。この IPC でコマンドを撃つ、と手順に明記する。
- **Phase 3 > 2〜5** — 一回きりの目視確認で終わり、`scripts/verify-peek.mjs` に恒久ケースを足すステップが無い。Peek は既に専用スイートがあり、「前面 = Peek」は次に `getActiveTab()` を触った誰かが黙って壊せる不変条件。verify-peek に「Peek 表示中の focus-address / reload / go-back / copy-url が Peek を対象にする」ケースを足す。判定手段として、`syncForegroundTab` の `tab.foreground` ログはコマンド経路では出ないので、コマンドの対象 key を 1 行ログに出す（`log('command.target', { command, key, peek })`）と拡張の有無に依存せず読める — このイディオムは `registry.ts:2344` に前例がある。
- **Phase 3 > 6** — 「`OWNERS` に今回触るファイルのエントリがあれば広げる」は方向が逆になりうる。`menu.ts` / `Overlay.tsx` / `Sidebar.tsx` は複数スイートが依存するので、`verify-targets.mjs` の方針（「そのスイートしか見ていないと確かめたものだけ」）では**載せない＝フルに倒れるのが正解**。「OWNERS には追加せず、`--changed` がフルに倒れることを確認する」に書き換える。

## P2
- **前提・わかっていること > ズレている箇所** — Peek 表示中も `Toolbar` のアドレス欄は暗幕（`.peek-back` は `inset: 0`）越しに見えたままで、親の URL を表示し続ける。クリックは暗幕が食うので操作はできないが、⌘L と表示が食い違う状態が残る。今回の対象外にするなら「Toolbar は据え置き」と決定事項に 1 行残しておく。
- **Phase 1 > 3** — 確認するまでもなく答えが出ている。`nemo:navigate` は `requireTab` → `win.findTab`（`registry.ts:1884`、`tabs` 全体を見ており `normalTabs` ではない）なので Peek の key で通る。ステップではなく「前提」の事実に畳める。
- **Phase 2 > 3** — `newTab={true}` の CommandBar が `activeTab` を読むのは `run()` の navigate 分岐だけで、そこは `wantsNewTab` が真なら `createTab` に倒れる。影響が無いことは読めば分かるので、確認ステップではなく前提として書ける。

## Q
- **決定事項（/dig-lite） > スコープ** — `zoom-in` / `zoom-out` / `zoom-reset`（`menu.ts:152`）と `find`（`Overlay.tsx` の FindBar が `state.activeTabKey` で検索）が同じズレを持つが、スコープ表に載っていない。決めないと「前面統一」が中途半端に残り、⌘F で見えないページを検索する・見えないページを拡大するという同種のバグ報告でもう一度同じ往復になる。推奨は両方入れる（どちらも「いま見えているページ」への操作で、⌘L と同じ理屈がそのまま通る）。
- **決定事項（/dig-lite） > Enter の遷移先** — Peek を別 URL へ遷移させた後、その View を Peek のまま維持するかが未定。維持なら「window.open 由来の覗き見」という素性を失った窓が暗幕付きで残り、破棄／自動昇格ならユーザーの明示操作なしにタブが増える。推奨は Peek のまま維持（昇格は ⌘O が既にあり、暗黙昇格は「閉じたら消える」という Peek の約束を壊す）。
````

**対応**: P0×3 反映（copy-url の対象決定は renderer `Sidebar.tsx` にあるため Phase 2 にステップ追加 / `menu.ts` は単一束縛を差し替えず `foreground` を別束縛して対象 case だけ読む方式に明記 / `getActiveTab()` 16箇所の仕分けステップを Phase 1 に追加、`setOverlay(null)` のフォーカス復帰を前面に差し替え）。P1 全反映（reload-ignoring-cache をスコープに追加 / reload の asleep 分岐の扱いを明記 / 前面の定義を `visibleTabKeys` と揃える＝`peekAwaitingDocument` は前面としない、を決定事項に追加 / renderer は `foregroundTab(state)` 1 関数に確定し `Peek.tsx` も寄せる / 検証は合成キーでなく `nemo:run-command-for-verify` を明記 / verify-peek への恒久ケース追加を Phase 3 に1行追加 / OWNERS は「追加せずフルに倒れることを確認」に書き換え）。P2 全反映（Toolbar 据え置きを決定事項に追加 / nemo:navigate と newTab CommandBar の2件は確認ステップを消して「コードを読んで確定している事実」に畳んだ）。Q×2 は自分で決定: zoom / find もスコープに入れる（ユーザーが dig-lite で「全部揃える＝一貫性重視」を選択済みで同じ理屈が通る）、遷移後も Peek のまま維持（⌘O 昇格が既にあり、暗黙昇格は「閉じたら消える」約束を壊す）。

## 2回目

````text
plan を読み直し、新しく入ったスコープ（zoom / find）と新しい決定（awaiting は前面としない / renderer 1 関数）をコードに当てて確認しました。前回分の対応はすべて反映されています。新たに 2 件の P0 が出ています。

## P0
- **Phase 2 > 1（`Peek.tsx` も `foregroundTab(state)` 経由に）** — 決定事項「前面の定義は `visibleTabKeys` と揃える（awaiting は前面としない）」と正面から矛盾する。`Peek.tsx` は**まだ表示されていない Peek を必要とする**コンポーネントで、`!peek.visible` の間だけプレースホルダーを描く（`visible` は `view.getVisible()` 由来＝`visibleTabKeys` と同条件なので、awaiting の Peek は `visible: false`）。awaiting を除外する関数に寄せると dom-ready まで Peek を引けず暗幕もプレースホルダーも出ない上、`foregroundTab(state)` は Peek が無ければ**親タブを返す**ので `if (!peek) return null` が効かず、Peek が無い通常状態でも暗幕が出っぱなしになる。renderer には 2 つ置く: `peekTab(state)`（`visible` を問わず Peek を返す。`Peek.tsx` 用）と `foregroundTab(state)` = `visible` な Peek ?? activeTab（コマンド用）。前者の上に後者を組む形にすれば「述語 1 つ」の意図も保てる。
- **Phase 2 > 3（FindBar の検索対象を前面に）** — 検索対象 key の差し替えだけでは ⌘F は動かない。`find` 状態は**タブごと**で（`found-in-page` ハンドラが `tab.find` に書く）、UI が読む `WindowState.find` は `toState()` の `find: active?.find ?? null` ＝**選択タブ**から引いている。Peek を検索すると結果は `peek.find` に入り、FindBar の `n/N` は常に空／0 のまま出ない。`toState()` の `find` を前面タブから引くステップを Phase 1（main 側）に足す。

## P1
- **Phase 3 > 4（判定はコマンドの対象 key を 1 行ログに出す）** — copy-url と find は main のコマンド分岐では対象 key が決まらない（key を渡すのは renderer）。`menu.ts` にログを 1 行足すだけでは、今回スコープに入れた 2 つがどちらも判定できない。ログの置き場所を「key を受け取る IPC」に決める: `nemo:copy-url`（現状ログ無し）と `nemo:find`（`find.requested` は length だけで key が無い）に key を出す、とステップに書く。
- **Phase 1 > 1（`syncForegroundTab` の導出もこれに寄せる）** — awaiting 除外に変えると、拡張から見た active が Peek へ切り替わる瞬間が `openPeek` 時点 → dom-ready（`reveal()`）へ後ろにずれる（＝`window.open` 直後の数百 ms は親が chrome の active）。`reveal()` が親を選択中のときだけ `selectTab` 経由で再同期するので結果は成立するが、暗黙の依存で、ここが崩れると `tab.foreground` が親のまま固まる。「reveal 経由の再同期に依存する」と前提に明記し、Phase 3 で既存 verify-peek の fg アサーション（`lastForeground()`）が通ることを確認対象に含める。
- **Phase 1 > 4（reload の asleep 分岐）** — 分岐を足す必要が無い。`sweepSleep` は `win.normalTabs` しか回さないので Peek は構造上 asleep にならない（`tab.peek` を持つ親も寝かせない）。「確認して早期スキップ」だと使われないガードが 1 本残る。ステップを消して「Peek は `normalTabs` に入らないため asleep にならない → `foreground.asleep` は常に false、分岐はそのままでよい」を前提の事実に畳み、コメント 1 行に落とす。
- **Phase 3 > 6（verify-peek の恒久ケース）** — 恒久ケースの一覧が focus-address / reload / go-back / copy-url の 4 つで、今回スコープに追加した find と zoom が入っていない。上の P0（`toState().find`）は恒久ケースが無いと次に必ず再発する箇所なので、「Peek を検索したとき `n/N` が Peek 側の件数を出す」を必ず入れる。

## P2
- **Phase 3 > 4（toggle-devtools）** — Peek に対する `openDevTools({ mode: 'right' })` の見え方が未検証。Peek は `WebContentsView` の小さな窓で、docked DevTools が Peek の bounds をどう食うか（別ウィンドウに出るのか）が分からない。Phase 3 に 1 項目足して、壊れた見た目になるなら Peek のときだけ `mode: 'detach'` にする、という逃げ道を用意しておく。
- **決定事項 > 遷移後も Peek のまま維持する** — 維持する場合、⌘L で別サイトへ飛ばした Peek も `ephemeralId` を持たない（定義が作られるのは `promotePeek` の `ensureEphemeralDefinition`）ため、セッション保存にもウィンドウ横断の共有一覧にも出ない。決定どおりだが「別サイトへ遷移させた Peek を閉じると履歴以外に何も残らない」ことになるので、決定に 1 行添えて人間の動作確認の観点に入れておく。
- **Phase 2 > 2（⌘L の初期値）** — `useState(() => ...)` はオーバーレイのマウント時に 1 回だけ評価される。awaiting を前面としない決定の帰結として、`window.open` 直後に素早く ⌘L を押すと親の URL が入り、その後 Peek が出ても書き換わらない。決定どおりの挙動だが Phase 3 で「既知の挙動」として 1 行残しておくと、後で回帰と誤認しない。

## Q
- **決定事項 > スコープ（find を追加）** — Peek を検索している最中に Peek が閉じた／⌘O で昇格したときの FindBar の扱いが未定。前面が親へ戻るため、バーは開いたまま `0/0` を表示し、Peek 側に張ったハイライトも `stopFind` されずに消える経路になる。決めないと「検索したまま Esc で Peek を閉じる」という普通の操作で毎回この状態が出る。推奨は「前面が変わったら FindBar を閉じて `stopFind` を撃つ」。
````

**対応**: P0×2 反映（renderer の導出を `peekTab(state)`（visible 不問、Peek.tsx 用）と `foregroundTab(state)`（visible な Peek ?? activeTab、コマンド用）の 2 つに分ける形へ書き換え / `toState()` の `find` を前面タブから引くステップを Phase 1 に追加）。P1 反映: 対象 key のログは IPC 側（nemo:copy-url・nemo:find）に出すと明記 / syncForegroundTab の awaiting 除外が reveal 経由の再同期に暗黙依存する旨を前提に明記し、既存 verify-peek の `lastForeground()` アサーション確認を Phase 3 に追加 / reload の asleep 分岐ステップは削除して前提の事実（Peek は sweepSleep の対象外）に畳んだ / verify-peek の恒久ケースに find（n/N）を追加、確認対象に zoom も追加。P2: 遷移後の Peek が ephemeralId を持たない帰結を決定事項に1行追記し人間の確認観点へ / ⌘L 初期値の既知挙動（awaiting 中は親 URL のまま）を Phase 3 のリグレッション項目に注記。**見送り**: toggle-devtools の docked DevTools が Peek の bounds をどう食うかの検証項目追加（P2）— 何かを足す修正なので終了報告に回す。Q は自分で決定: 前面が変わったら FindBar を閉じて stopFind を撃つ（0/0 表示とハイライト残留の経路を塞ぐ。決定事項に追記済み）。

## 3回目

````text
plan を読み直し、新規追加分（決定事項の FindBar 挙動、`toState().find`、`peekTab`/`foregroundTab` の 2 段化、Phase 3 の追加項目）をコードに当てて確認しました。

## P0
- **決定事項 > 前面が変わったら FindBar は閉じて `stopFind` を撃つ** — 決定表に入ったが、対応する実装ステップが Phase 2 に無い（Phase 2 は導出関数・CommandBar・FindBar の検索対象・Sidebar の 4 つで、いずれも「対象 key の差し替え」だけ）。決定が実装計画に落ちていないので、実装時に丸ごと落ちるか、Phase 3 で気付いて後付けになる。加えてこの挙動には素直に書くと踏む罠がある: 前面変化を `foregroundTab(state)?.key` の変化で検知すると、`close()` が読む key は**もう新しい前面**になっており、撃ち先を間違える。さらに Peek が閉じた場合は対象タブが `state.tabs` から消えていて、`nemo:stop-find` は `requireTab` で throw する（`void` した invoke が unhandled rejection になる）。Phase 2 にステップを足し、「直前の前面 key を ref で保持」「その key が `state.tabs` に残っているときだけ `stopFind`、消えていれば `onClose()` のみ（WebContents ごと破棄されるのでハイライトも消える）」「⌘O 昇格時はタブが残るので `stopFind` を撃つ」まで書く。

## P1
- **Phase 1 > 1（`peekAwaitingDocument` の Peek は前面としない＝`visibleTabKeys` と同条件）** — 「同条件」を人手で二重に書くことになる。`visibleTabKeys` は `if (active.peek && !active.peek.peekAwaitingDocument)` を自前で持っており、片方だけ条件を足すと前面と表示がズレる（ズレたときの症状は「見えていないページに ⌘L や reload が向く」で、まさに今回直しているバグの再発）。`visibleTabKeys` 側を `getForegroundTab()` 経由に書き換えて条件の実体を 1 か所にする、とステップに書く。
- **Phase 1 > 2（`getActiveTab()` 16箇所の仕分け）** — 名指しされているのは「選択のまま」の 4 つと「前面へ」の 1 つだけで、`extensions.ts` の拡張アイコン再描画の nudge（`focusedOrFirstWindow()?.getActiveTab()?.webContents` に `tab-updated` を撃つ箇所）が宙に浮いている。ここは `syncForegroundTab` と同じ「chrome から見た active」を狙う場所なので方針上は前面側で、放置すると「拡張の active は Peek なのに再描画のつつきは親へ飛ぶ」不一致が残る。仕分け表の結論として前面側に入る見込みだと名指ししておく。

## P2
- **決定事項 > 判定は述語 1 つに寄せる** — 「renderer は `foregroundTab(state)` の 1 関数」という文言が、Phase 2 > 1 の 2 関数（`peekTab` / `foregroundTab`）と食い違ったまま残っている。後から読んだ人が「1 関数に戻す」方向へ直しかねないので、「`peekTab` の上に `foregroundTab` を組む 2 段（実体の導出は 1 か所）」に文言を合わせる。

## Q
````

**対応**: P0 反映（FindBar を閉じる決定の実装ステップを Phase 2 に追加。直前の前面 key を ref で保持 / key が state.tabs に残るときだけ stopFind / 消えていれば onClose のみ / ⌘O 昇格は stopFind、まで明記）。P1×2 反映（`visibleTabKeys` の自前条件を `getForegroundTab()` 経由に書き換えて条件の実体を1か所にする、を Phase 1 のステップに追記 / extensions.ts の拡張アイコン再描画 nudge は前面側に入る見込みと仕分けステップに名指し）。P2 反映（決定事項の「renderer は 1 関数」の文言を「peekTab の上に foregroundTab を組む 2 段（実体の導出は 1 か所）」に修正）。

## 4回目

````text
plan を読み直し、今回追加された 3 箇所（Phase 1 > 1 の `visibleTabKeys` 統合、Phase 1 > 2 の nudge 名指し、Phase 2 > 5 の FindBar）をコードに当てて確認しました。前回分はすべて反映されています。P0 はありません。

## P0

## P1
- **Phase 3 > 5（Peek 表示中の … find が Peek を対象にすることを確認）と Phase 3 > 7（恒久ケース）** — find の検証手段が 1 段しかなく、renderer の導出を守れない。既存の find 検証イディオムは `verify-phase1.mjs` の `window.nemo.find(key, 'Nemo')` 直叩きで、**key を検証側が渡すため `foregroundTab(state)` を一切通らない**。これを真似ると恒久ケースは Phase 1 > 4（`toState().find`）しか守らず、Phase 2 > 3 が壊れても緑のままになる。恒久ケースを 2 段に分けると書く: (a) `window.nemo.find(peekKey, …)` 直叩きで `n/N` が Peek 側の件数を返すこと（main 側）、(b) `find` コマンドを撃って FindBar 経由で検索し、新設する `nemo:find` の key ログが Peek を指すこと（renderer 側）。
- **Phase 2 > 5（FindBar を閉じて `stopFind`）** — 実装ステップはできたが、対応する確認項目が Phase 3 に無く、決定→実装→検証の鎖が最後で切れている。しかもこの経路の失敗は画面上ほぼ無症状で、「消えた key に `stopFind` を撃つ」は renderer の unhandled rejection になり `main.tsx` の `unhandledrejection` → `nemo:report-ui-error` → **`ui.error` ログ**にしか出ない。Phase 3 に 2 項目足す: 「Peek を検索中に Peek を閉じる → FindBar が閉じ、`ui.error` が出ていない」「⌘O 昇格 → `nemo:stop-find` が昇格後の key で 1 回だけ飛ぶ」。
- **決定事項 > 前面の定義は `visibleTabKeys` と揃える（main / renderer 両側で同じ条件にする）** — 「同じ条件」を式の同一と読むと事故る。main 側の判定は `peekAwaitingDocument` でなければならず、`view.getVisible()`（＝`TabState.visible` の出どころ）を条件に使うと `getForegroundTab()` → `visibleTabKeys` → `applyVisibility` → `getVisible()` の循環になる。Phase 1 > 1 で `visibleTabKeys` を述語経由に書き換える以上、この取り違えは実際に起きうる。「同じなのは意味であって式ではない。main は `peekAwaitingDocument`、renderer は push 済みの `TabState.visible` を見る（後者は結果なので循環しない）」と 1 行明記する。

## P2
- **決定事項 > 前面が変わったら FindBar は閉じて `stopFind` を撃つ** — 決定文が挙げる契機は「Peek が閉じた・⌘O 昇格した」の 2 つだけだが、Phase 2 > 5 の実装（前面 key の変化で検知）は **Peek が開いた**向き（親を検索中にリンクを踏んで Peek が出る）にも効く。挙動としては妥当なので実装はそのままでよいが、決定文が実装より狭いままだと、後から読んだ人が「開いたときは閉じないのが正では」と揺り戻しかねない。決定文に「開いたときも同じ（前面が変われば閉じる）」を 1 行足す。
- **Phase 3 > 5（判定ログを `nemo:copy-url` に足す）** — `nemo:find` には既に `find.requested` があるが `nemo:copy-url` はログが 1 行も無く、そこへ検証のためのログを新設することになる。このリポジトリのログは自走検証が読む前提で書かれている（`tab.foreground` の docstring がその例）ので方針としては合っているが、`copy-url` にだけ唐突に生えて見えるため、「何を判定するためのログか」を実装時にコメントで残す。

## Q
````

**対応**: P0 なし → 収束。採用した P1/P2（未レビュー）: find の恒久ケースを 2 段（main 直叩き + FindBar 経由で nemo:find の key ログ判定）に書き換え / FindBar 閉じ経路の確認 2 項目（Peek 閉じ → ui.error なし、⌘O 昇格 → stop-find 1 回）を Phase 3 に追加 / 「同じ条件」は意味であって式ではない（main は peekAwaitingDocument、renderer は push 済み TabState.visible。getVisible() だと循環）を決定事項に明記 / FindBar 決定文の契機に「親を検索中に Peek が開いた」を追加 / nemo:copy-url のログ新設に目的コメントを残す旨を追記。
