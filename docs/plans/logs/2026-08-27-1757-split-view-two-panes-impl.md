review session: 0514bc56-0641-4934-a3a2-6008f21de76d

## 1回目

````text
静的レビューです（`mise run check` / verify 一式はコマンド承認が下りなかったため未実行。以下はコードと plan の突き合わせのみ）。

## P0

## P1

- `src/main/registry.ts:NemoWindow.ensureSplitToolbar` — 遅延生成した View を同じ `layout()` の中で `setVisible(true)` しているが、`createUiView()` の `loadURL()` はまだ終わっておらず、背景色も敷いていない（`createUiView` が `setBackgroundColor` するのは transparent な `overlay` / `peek` だけ）/ 既存のツールバーはウィンドウ生成時＝ウィンドウを見せる前に作るのでこの穴が無く、**初めて分割を作った瞬間だけ右ペインのツールバー帯が白く出る**（直前のコミット「Peek を開いた瞬間に窓の形を出す」と同種の抜け）/ `ensureSplitToolbar()` では `setVisible(false)` のままにして、その View の `onUiViewLoaded('toolbar')` が来た時点で `layout()` を回し直す。あるいは生成時にツールバーの地色を `setBackgroundColor` で敷く。plan の `Phase 2 > ステップ 5`

- `src/main/registry.ts:NemoTab.sleep` — `paneFocusOff` を落としていない / `syncPaneFocusWatchers` の再購読条件が `wants && !tab.paneFocusOff && wc` なので、**古い（破棄済み WebContents に張った）購読が残ったまま materialize されると新しい WebContents に張り直されず、そのペインをクリックしてもフォーカスが移らなくなる**。いまは `sweepSleep` が `visibleTabKeys` を除外するので踏まないが、`removeTab` / `moveTabToWindow` が同じ後始末を書いているのにここだけ抜けていて、sleep の除外条件を将来触った瞬間に黙って壊れる形になっている / `sleep()` の `this.view = null` の隣で `this.paneFocusOff?.(); this.paneFocusOff = null` を呼ぶ。plan の `Phase 1 > ステップ 9`

## P2

- `src/main/registry.ts:paneInnerBounds` — `TOOLBAR_HEIGHT` を直書きしているが、`layout()` は同じ高さを `this.toolbarView ? TOOLBAR_HEIGHT : 0` で出している / いまは `toolbarView` が null になるのは `kind === 'mini'` だけで、mini は `splitTabs` が弾くので不整合は表に出ないが、2 か所で高さの出所が違う / `paneInnerBounds(outer, toolbarHeight)` にして呼び出し側の値を渡す。plan の `Phase 2 > ステップ 2`

- `src/renderer/components/Toolbar.tsx:Toolbar` — サイドバー非表示（`SIDEBAR_HIDDEN_WIDTH = 0`）かつ分割中は、左ツールバーの左端が `SPLIT_INSET` ぶん右にずれたうえに `.inset` の 82px が乗る / 信号機ぶんの余白として測った 82px が 90px 相当になり、戻る／進むが 8px 右へ寄る / `.inset` の値をペインの左端基準にするか、分割中だけ左ペインの `SPLIT_INSET` を 0 にする。plan の `Phase 3 > ステップ 5`

- `src/renderer/components/TabRow.tsx:TabRow` — `onDragLeave={() => setDropping(false)}` が無条件 / Chrome では親要素から子要素（favicon・タイトル）へ入るときにも `dragleave` が飛ぶので、行の中を横切るあいだ `.drop-split` が明滅する / `event.currentTarget.contains(event.relatedTarget as Node)` のときは無視する。plan の `Phase 4 > ステップ 6`

- `src/main/registry.ts:splitTabs` — `not_in_window` の early return が死に枝 / IPC 側の `requireTab(event, leftKey)` が先に throw するので、左 key が別ウィンドウ／存在しない場合は `split.rejected` が出ず、`void window.nemo.splitTabs(...)` 側で unhandled rejection になる（`types.ts` の「main 側で黙って捨てる」という契約とも食い違う）/ 左右とも `win.findTab()` で引いて `splitTabs` に判定を任せるか、`types.ts` の記述を実挙動に合わせる。plan の `Phase 5 > ステップ 2`

- `src/main/registry.ts:NemoWindow.syncPaneFocusWatchers` — `input-event` は `mouseMove` / `mouseWheel` でも飛ぶ / 分割中は 2 つの WebContents ぶん、マウスを動かすたびに main のリスナが呼ばれる（中身は即 return なので実害は小さいが、常時走る唯一のホットパスになる）/ 気になるなら `wc.on('input-event')` の代わりに `before-input-event` との併用や、`mouseDown` 以外を早期に捨てていることをコメントで明示しておく。plan の `Phase 1 > ステップ 9`

- `src/renderer/components/SplitRow.tsx:SplitRow` — `focused={visible && tab.key === focusedKey}` なので、**表示中でないペアはどちらのチップにもアクセントバーが出ない** / 結合行を見ても「戻ったときどちら側にフォーカスが戻るか」が読めない / 非表示のときは薄いアクセントで最後にフォーカスしていた側を残す、が候補。plan の `Phase 4 > ステップ 3`

## Q

- `src/main/registry.ts:NemoWindow.applyVisibility` — 未読落としを `visibleTabKeys` 基準にしたことで、**フォーカス中タブの Peek の URL まで `markLiveFolderRead()` の対象になった**（`startBackgroundWork` の `activeUrls` も同様）。従来は `getActiveTab().url` だけだったので、Peek で PR を覗いても Live Folder の未読は残っていた / 「リンクを Peek で一瞬覗いただけの PR を既読にしてよいか」は plan の決定表に無い。既読にしないなら `applyVisibility` / `activeUrls` の両方で `tab.peekOf === null` を条件に足す必要があり、片方だけ直すと落としたそばから付け直される（`Phase 1 > ステップ 4` と同じ罠）

````

**対応**: P0 なしで収束。反映したもの — P1 `ensureSplitToolbar`（右ペインのツールバーに `TOOLBAR_GROUND_COLOR = '#1b1b20'` を敷き、初回分割時の白フラッシュを消した。View を後から出す案ではなく、DESIGN の Peek の注記どおり「新規生成の View なら背景色を敷ける」方を採った）、P1 `NemoTab.sleep`（`paneFocusOff` を落として `syncPaneFocusWatchers` の再購読条件を壊さないようにした）、P2 `Toolbar`（分割中かつサイドバー非表示のとき `.inset-split` で `padding-left` を 82px → 74px にし、`SPLIT_INSET` ぶんの二重余白を消した）、P2 `TabRow`（`dragleave` で `relatedTarget` が行の内側なら無視し、行内を横切るときの `.drop-split` の明滅を止めた）。見送り — P2 `paneInnerBounds` の `TOOLBAR_HEIGHT` 直書き（`toolbarView` が null になるのは mini だけで、mini は `splitTabs` が弾くため到達不能。引数を1本増やす方が読み手の負担が大きい）、P2 `splitTabs` の `not_in_window` 死に枝（D&D はサイドバー内＝同一ウィンドウしか起こせず実害なし。IPC の検証は plan の「main 側で照合する」に沿っており、契約の文言差だけなので触らない）、P2 `input-event` のホットパス（実害なしと指摘者自身が書いている。`before-input-event` は `mouseDown` を拾えないので置き換えられない）、P2 `SplitRow` の非表示ペアのフォーカス表示（plan の決定表に無い仕様追加なので Q に回す）。

**動作確認**: `mise run check` PASS（unit 188/188）→ `NEMO_VERIFY_SHOTS=... mise run verify:only split restart` すべて PASS（128 検査）→ スクショ 3 枚を目視。
`sleep 明け: 起きたペインのクリックでフォーカスが移る` を `verify-split.mjs` に足したが、**`sleep()` の `paneFocusOff` 修正を外しても PASS する**ことを実測した
（寝る前に必ず非表示化を通り、そこで `syncPaneFocusWatchers` が購読を外すため。修正は将来の保険という位置づけに直し、コメントにもそう書いた）。
検査自体は「起きたペインのクリックでフォーカスが移る」という bounds に出ない壊れ方を押さえるので残した。最終の `verify:only split restart` も 126 検査すべて PASS。

**Q への回答（ユーザー判断）**:
- `applyVisibility` の Peek 既読 → **現状維持（既読にする）**。「どっちでもいい。実装楽な方で」。除外する側は `applyVisibility` と `activeUrls` の両方を直す必要があり高くつく。plan の決定表と DESIGN.md に規則として書き残した（コード変更なし）
- `SplitRow` の非表示ペアのフォーカス表示 → **見送り**。薄いアクセントを残すと「今フォーカスがある」と紛らわしく、ズレが効くのは ⌃M / ⌃Tab / ⌘数字 で戻る経路だけ。戻った瞬間に枠とチップで分かる
