review session: 59cfc8ea-c0f9-49a6-81cf-429e1c04c035

# 実装レビューログ: peek-foreground-commands

## 1回目

````text
レビューしました。plan の Phase 1〜3 は全ステップ実装済みで、差分は plan の決定（awaiting は前面としない／導出は main・renderer 各 1 か所／昇格では閉じない）と一致しています。`getForegroundTab()` の `visibleTabKeys` への統合も旧条件と論理的に等価で、循環も踏んでいません。

## P0

## P1
- `src/renderer/components/Toolbar.tsx:Toolbar` — Peek 表示中でも戻る／進む／⟳（右クリックのスーパーリロード含む）とアドレス欄は `paneTab(state, pane)`＝親タブを対象にしたままで、⌘R / ⌘[ / ⌘L と行き先が食い違うようになった（今回の変更前は両方とも親だったので食い違いは無かった） / plan の「Toolbar は据え置き」の根拠「クリックは暗幕が食うので操作不能」は事実ではない。暗幕は `registry.ts:layout` で `pageBoundsFor(active)`（`singlePage` = `y: toolbarHeight` 以下）にしか敷かれず、ツールバー行は覆われていないので全ボタンが押せる / 据え置き自体を選び直すなら「押せる」前提で決め直す。入れるならペイン対応の導出が要る（`foregroundTab(state)` は `activeTabKey` 基準なので、右ペインのツールバーが左ペインの Peek を操作しないよう `paneTab.key === state.activeTabKey` のときだけ Peek に倒す形にする）
- `src/renderer/components/Overlay.tsx:FindBar` — 前面変化の検知が「初回 push 待ち」と区別されていない。`state` が未到着（`null`）のまま FindBar がマウントされると `activeKey` は null で始まり、最初の state push で `prev === null → activeKey` の変化として扱われて FindBar が即座に閉じる / `useWindowState` は `getWindowState()` の往復が終わるまで null を返すので、ウィンドウ生成直後に ⌘F を撃つと無症状で検索バーが消える（`stopFind` は撃たれないのでログにも出ない） / `if (prev === null) { lastKey.current = activeKey; return }` を先頭に足して、null→key の初回確定は「前面が変わった」と数えない
- `scripts/verify-peek.mjs:前面コマンドセクション` — `connectTo(CDP, 'view=overlay', { exclude: 'private=1' })` がウィンドウを名指ししていない / CLAUDE.md の「CDP の target は名指しで選ぶ。ウィンドウは `?window=N`」に反する。今は通っていても、後続でウィンドウを残すスイートが増えた瞬間に「target が1つに定まらない」で落ちる（同じ罠を今回 `connectPage('index.html')` で既に踏んでいる／`connectUi(CDP,'peek')` のフレークも同種） / `verify-switcher.mjs:50` のイディオムに揃えて `connectTo(CDP, \`view=overlay&window=${(await state()).windowId}\`)` にする

## P2
- `scripts/verify-peek.mjs:lastLog` — `lastForeground()` と同じ「診断ログを JSON.parse して最後の1件」を再実装している / 壊れ方も直し方も同じものが 2 つになる / `lastForeground` を `lastLogEntry(event, filter)` に一般化して両方から呼ぶ
- `scripts/verify-peek.mjs:前面コマンドセクション` — 「go-back で親は動かない」は親に履歴が無い（`canGoBack()` が false）ので、対象が親に戻る回帰でも PASS する空振りの検査 / 隣の「go-back は Peek に効く」が回帰を拾うので害は無いが、守っているつもりの範囲が実際より広く見える / 親を 1 回遷移させてから撃つか、検査名を実態（Peek 側だけが戻る）に寄せる
- `scripts/verify-peek.mjs:前面コマンドセクション` — `ui.error` の増分チェックは `main.tsx:reportUiError` の間引き（同一 message 60 秒 / 1 セッション 50 件）に載っているため、条件次第で空振りする / 消えた key への `stopFind` 回帰を確実に拾うなら、`nemo:stop-find` 側に key のログを出して「Peek 閉じの前後で stop_find が増えていない」を正の条件で見るほうが強い
- `src/main/menu.ts:runCommandForWindow` — `add-favorite`（⌘D）は Peek 表示中も親タブを対象にする / plan の「pin-tab は定義操作だから対象外」と同じ整理で一貫はしているが、ユーザーから見た驚きは copy-url（今回 Peek に寄せた）と同種で、見えているページと違う URL が静かに Favorites に入る / 今回の対象外で良いが、次に「定義系も前面に寄せるか」を決めるときの候補として残す

## Q
- `src/renderer/components/Overlay.tsx:FindBar` / `docs/CHANGELOG.md:[Unreleased]` — 「前面 key の変化で閉じる」は Peek の出入りだけでなく**通常のタブ切り替え**にも効く（find のオーバーレイは右上の小さいバーで、サイドバーもページも覆っていないため、検索中にサイドバーのタブ行をクリック／⌘⌥→ で切り替えられる）。この場合これまでは検索バーが残っていたが、今後は閉じて直前タブに `stopFind` が飛ぶ / この挙動を採るなら CHANGELOG に 1 行要る（現在の記述は Peek を閉じたときだけに読める）。採らないなら契機を「前面が Peek をまたいだときだけ」に絞る必要があり、実装が 1 段複雑になる
````

**対応**: P0 なし → 収束。採用した P1: FindBar の null → key（初回 push）を前面変化と数えないガードを追加 / verify の overlay 接続を `view=overlay&window=N` の名指しに変更。採用した P2: lastLog を lastLogEntry に一般化して lastForeground と統合 / 空振り検査「go-back で親は動かない」を削除（親に履歴が無く FAIL できない）。**Toolbar（P1）は見送り**: plan の決定「据え置き」の変更＋ペイン対応の導出という機能追加になるため終了報告の Q へ。plan の決定の根拠（暗幕がクリックを食う）が事実誤りだったことは plan 本文を訂正。**ui.error の間引き（P2）も見送り**: stop-find へのログ新設という追加のため終了報告へ。add-favorite（P2）は現状維持（pin-tab と同じ「定義操作は対象外」の整理）で plan に候補として残る。Q は plan の決定「契機は前面 key の変化で統一」で答えが定まるため自分で決定: タブ切り替えでも閉じる挙動を採用し、CHANGELOG を「見ているページが変わったら閉じる」に書き換え、plan の決定事項に追記。
動作確認 fail: 既存検査「Peek が出ている間は暗幕の View が表示されている」が hidden で FAIL（4 run 中 2 回、同一コードで揺れる）。renderer の document.visibilityState はウィンドウ遮蔽（別 Space・前面の他ウィンドウ）でも hidden になる環境依存の判定だった → 開き側の判定を main の実状態（splitDiagnostics.peekScrim）を正にし、visibilityState は詳細出力に降格。閉じ側の hidden 判定は従来どおり（遮蔽でも hidden のままなので偽 FAIL しない）。

## 2回目

````text
plan（決定事項 34・39 の追記、Toolbar の根拠訂正）と差分を読み直しました。FindBar の初回 push ガード、overlay の `view=overlay&window=N` 名指し、`lastLogEntry` への統合、空振り検査の削除はいずれも意図どおり入っています。ただし暗幕検査の修正に 1 件重いものがあります。

## P0
- `scripts/verify-peek.mjs:暗幕の出し入れと ⌃M（5.5 セクション）` — 暗幕セッションを `connectUi(CDP, 'peek', { waitReady: false })` で取っているが、`connectTo` は `targets.find(...)` の**先頭一致**で、複数一致しても throw しない。暗幕 View の URL は `?view=peek&window=<id>`（`ui-view.ts:createUiView`）で、直前の R9 が `moveTabToNewWindow` で作った 2 枚目のウィンドウは Peek を表示した時点で暗幕 View を作り（`registry.ts:ensurePeekChrome`）、`removeTab` は最後のタブを閉じてもウィンドウを閉じない（空状態 View に落ちるだけ）ので、5.5 に入る時点で `view=peek` の target は 2 件ある / つまり「どちらのウィンドウの暗幕を読むか」が target 列挙順しだいで、**同一コードで run ごとに揺れる**という観測（4 run 中 2 回 FAIL）は遮蔽仮説と同じくらいこの取り違えでも説明がつく。今回の変更は開き側だけを main の実状態に移したので、**取り違えを知らせていた唯一のカナリアを外したまま、閉じ側の `visibleAfterClose === 'hidden'` は取り違えうるセッションに依存し続けている**。別ウィンドウの暗幕を掴んだ run では常に `hidden` が返り、「閉じても暗幕が最前面に残る」という本来の回帰が出ていても黙って PASS する（CLAUDE.md「CDP の target は名指しで選ぶ。…ウィンドウは `?window=N` で選ぶ」に正面から反する状態でもある） / `connectUi` は `urlPart` を受けるので `connectUi(CDP, 'peek', { urlPart: \`view=peek&window=${(await state()).windowId}\`, waitReady: false })` に変えて対象を確定させる。そのうえで、遮蔽が本当に原因だったか（名指し後も visibilityState が揺れるか）を 1 度確かめてから、開き側を `peekScrim` に据える／閉じ側も `peekScrim === null` に揃えるかを決める。併せて先頭のコメント「`document.visibilityState` が View の可視性に連動する」は下の新コメントと食い違うので書き直す

## P1
- `docs/plans/2026-08-31-1514-peek-foreground-commands.md:ログ > 試したこと・わかったこと` — 暗幕 FAIL の記述が「1 度だけ FAIL・単発フレークと判断・再発するようなら要調査」のまま残っており、実際には再発（4 run 中 2 回）して判定基準を変える修正まで入ったことが記録されていない / plan のログはこの作業の唯一の durable な記録で、次に読んだ人は「単発フレークとして流した」と読む。今回いちばん時間を使った調査の結論（visibilityState を View の可視判定に使うと環境依存になる／main の `splitDiagnostics.peekScrim` を正にした）が消える / ログに 1 項目足して、再発の回数・診断・開き側だけ差し替えた理由・閉じ側を据え置いた根拠（と P0 の名指しの結論）を残す

## P2
- `CLAUDE.md:自走検証を足すとき` — 「renderer の `document.visibilityState` は View の可視性だけでなくウィンドウの遮蔽でも hidden になるので、View の出し入れの判定には使わない（main の `splitDiagnostics` を正にする）」は、CDP target の名指しや popup の初期化待ちと同じ「次の人が必ず踏む罠」の類 / この節はそういう知見を集める場所として運用されている（直近のコミットでも同様の追記をしている） / P0 の名指しで原因が確定してから、確定した内容で 1 行足す

## Q
````

**対応**: P0 反映（ただし前提の一部はログで否定を確認）: 暗幕セッションを `view=peek&window=N` の名指しに変更し、閉じ側の判定も main の実状態（`splitDiagnostics().peekScrim === null`）に揃えた。visibilityState は両側とも診断詳細に降格し、セクション先頭のコメントも書き直した。なお「R9 が 2 枚目のウィンドウを作るので target が 2 件」という前提は現行コードでは成立しない —— `moveTabToNewWindow` は `normalTabs.length <= 1` で no-op（共有タブ化で ⌘⇧N 廃止後の姿）で、全 4 run のログでも暗幕セクション時点の window.create は win1 のみ。よって取り違えは起きておらず、揺れの原因は遮蔽（環境依存）と結論。P1 反映: plan のログの「単発フレーク」記述を、再発回数・診断・対処まで書いた項に差し替え。P2 反映: CLAUDE.md の「自走検証を足すとき」に visibilityState を PASS 条件に使わない罠を追記（原因確定済みのため）。

## 3回目

````text
plan のログ（暗幕フレークの診断・R9 no-op の確認）と CLAUDE.md 追記、暗幕検査の両側 `peekScrim` 化・`view=peek&window=N` 名指しを確認しました。前回 P0 の前提（target 2 件）が否定されている件も、`ipc.ts:nemo:move-tab-to-new-window` の `normalTabs.length <= 1` ガードとログの両方で裏が取れています。ただしその事実には、まだ拾われていない帰結が 1 つあります。

## P0

## P1
- `scripts/verify-peek.mjs:R9 — Peek を持つ親タブのウィンドウ移動` — 今回ログに確定した事実「R9 の `moveTabToNewWindow` はタブ 1 枚なので no-op（暗幕セクション時点のウィンドウは 1 枚のみ）」の帰結として、R9 の 3 検査がすべて空振りしている。移動が起きなくても `sidebars` は win1 だけになり、`holder` は「親タブを含むウィンドウ」＝ win1 に解決するので、`親タブが移動先ウィンドウにいる` も `Peek も一緒に移動している` も `移動後も chrome の active が Peek を指す`（`lastForeground(win1)`）も無条件で PASS する / ファイル冒頭の docstring が「**R9**: Peek を持つ親タブを別ウィンドウへ移すと Peek も付いてくる」と宣言している不変条件が、実際には 1 度も検証されないまま緑になる —— CLAUDE.md 冒頭の「その検査が実際に走ったか」の症状（速く PASS）そのもので、共有タブ化で ⌘⇧N を廃止した時点から腐っていた可能性が高い。同じ IPC を使う `verify-phase1.mjs` / `verify-split.mjs` は「元のウィンドウからタブが消えた」を待つので no-op なら落ちる（＝安全）が、peek だけがこの守りを持っていない / 移動前に通常タブをもう 1 本用意し（同ファイルの `mruFiller` と同じ手）、`holder.s.windowId !== (await state()).windowId` と「元のウィンドウから親タブが消えた」を検査に足す。後片付けは移動先ウィンドウのタブを閉じたあと空ウィンドウが残る点も併せて見る

## P2
- `scripts/verify-peek.mjs:lastLogEntry` — docstring が「`windowId` を渡すとそのウィンドウ分だけ」とだけ書いており、**イベント側が `windowId` を detail に持っている必要がある**ことに触れていない。今回の呼び出し先のうち `copy_url.requested` と `find.requested` は `windowId` を出していないので、後から絞り込みを付けた人は例外もログも出ないまま常に null を受け取る / docstring に「windowId を出しているイベントに限る」を 1 節足す

## Q
````

**対応**: P0 なし → 収束。採用した P1（未レビュー）: R9 に詰め物タブを追加して移動が実際に起きるようにし、「親タブが元と別のウィンドウへ移った」「元のウィンドウから親タブが消えている」を検査に追加。後片付けは移動先のタブを閉じたあと空ウィンドウを close-window（evSuicidal の発火だけパターン）で閉じる形に変更。採用した P2（未レビュー）: lastLogEntry の docstring に「windowId 絞り込みは detail に windowId を出しているイベントに限る」を追記。動作確認（peek スイート）で全体を実証してから報告する。
