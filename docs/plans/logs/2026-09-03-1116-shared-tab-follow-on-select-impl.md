review session: 91b444bf-6440-472c-895c-90cffba890ba

# polish-impl review log: shared-tab-follow-on-select

## 1回目

````text
レビューしました。plan の Phase 1〜3 のチェック済みステップは実装・検証とも揃っており、決定表（追随条件・通話ガード・beforeunload の3点解除・sleep 復帰の述語共有・`resolveNavigationTarget` 経由）はコードと一致しています。`normalizeStoredUrl` の冪等性（`addEphemeralTab` / `updateEphemeralFromTab` が両方通す）と `resolveNavigationTarget` が値を変えないことも確認したので、「1 ウィンドウでは何も起きない」「起床直後の二重ロードが起きない」は成立します。

## P0

## P1
- `docs/CHANGELOG.md:[Unreleased]` — ユーザーに見える挙動変更（別ウィンドウで進んだ続きが出る／「戻る」で戻れる／Meet 参加中と `file:` は読み直さない）なのに `[Unreleased]` が空のまま。/ CHANGELOG は「GitHub Release の本文とアプリ内の更新通知の唯一の源」で `mise run release` が機械的に切り出す。直近の feat 2 本（`6de068b` / `1e72018`）はどちらもコミットに含めており、ここだけ抜けるとリリース時に無言で落ちる。/ `### 変更` に 1 行足す（`docs/operations.md` に書いた文言がそのまま使える）。
- `scripts/verify-shared-tabs.mjs:plantProbe` — JSDoc の「`ev` は isolated world で評価するので、同じ world 名で同じドキュメントなら残り」が事実と違う。`scripts/lib/cdp.mjs:connect` の `ev` は `contextId` を渡さない main world 固定で、isolated world は別関数 `evIsolated`（`Page.createIsolatedWorld` + `worldName: 'nemo-verify'`）。/ 検査自体は main world のマーカーとして正しく動く（`plantProbe` が書き戻しを読んで前提 check にしている）が、「なぜ残る／消えるか」の根拠が実在しない機構の説明になっている。次に触る人が `evIsolated` に寄せたり、「ページのスクリプトからは見えない」と誤解して動的ページに使い回す余地を残す。plan `Phase 3 > ステップ 2`。/ 「`ev` は main world なので、同じドキュメントの間だけ `window.__nemoFollowProbe` が残り、遷移で新しいドキュメントになると消える（対象は静的な test-pages なのでページ側から潰されない）」に書き換える。

## P2
- `VERIFY.md:どれを回すか` — 「一時タブのウィンドウ横断共有」の行の括弧書きが旧スコープのまま（共有定義ストア・openEphemeral / close の波及・ピン転換・シークレット / 小窓の除外・再起動復元）で、今回足した選択時追随・beforeunload 抑止・sleep 復帰・通話ガードが載っていない。/ 直下の `local-file` の行が件数まで書いているのと不揃い。人間が「何を触ったら何を回すか」を引く表なので、追随を触ったときにこの行に辿り着けるほうがよい。/ 括弧書きに「選択時追随（beforeunload 抑止・sleep 復帰・通話ガード）」を足す。
- `scripts/verify-shared-tabs.mjs:brief` — 「戻れる」ブロックの `check('前提: 追随した実体は「戻る」が押せる', …, json(before))` だけ `brief()` を通さず `TabState` を丸ごと出している（直後の check は `brief()` を使っている）。/ ログに「FAIL 詳細に `TabState` を丸ごと出すと favicon の data URL で 1 行が数 KB になる → `brief()` に絞った」と書いた当の問題が 1 箇所だけ残っている。/ `brief(before)` にする。
- `src/main/registry.ts:followEphemeralDefinition` — `tab.follow_failed` の `code` が `typeof code === 'string' ? code : String(code)` なので、`code` を持たないエラーでは文字列 `"undefined"` が載る。あわせて、beforeunload で意図的に止めたときも `tab.follow_blocked` と `tab.follow_failed`（`ERR_ABORTED`）が両方出るため、`follow_failed` の件数だけでは「本当の失敗」と「仕様どおりの中止」が切り分けられない。/ 事故調査でログを数えたときに紛れる。/ `code` が無いときはキーごと落とす、または `ERR_ABORTED` は `follow_failed` を出さない（`follow_blocked` に任せる）。
- `src/main/registry.ts:attachTabEvents`（`render-process-gone`） — `beginFollowLoad` の JSDoc は抑止フラグを畳む点を「(a) `will-prevent-unload` / (b) main frame の `did-navigate` / `did-navigate-in-page` / `did-fail-load` / (c) タイムアウト」の 3 点で網羅と書いているが、追随の読み込み中にレンダラが落ちる経路（`render-process-gone` → 500ms 後の `wc.reload()`。WebContents は生き残るので `destroyed` も来ない）がここに入っていない。/ 実害は小さい（`reload()` の `did-navigate` が数百 ms で畳む）が、コメントが「網羅」と宣言している以上、次に触る人がこの穴を前提にしない。/ `render-process-gone` ハンドラに `endFollowLoad(wc)` を 1 行足すか、JSDoc に「クラッシュ経路は reload の `did-navigate` が畳む」と書く。

## Q
- `scripts/verify-shared-tabs.mjs`（セッション復元経路） — 決定表では「セッション復元」も追随の有効経路と決めているが、自走検査は無い（polish 3 回目の P2 で「終了報告へ」と送られたまま）。`verify-shared-tabs.mjs` は再起動を扱えるので追加は可能。/ 決めないと「起動したら別ウィンドウの続きが出る（あるいは出ない）」が誰にも検査されないまま固定される。
- `docs/plans/2026-09-03-1000-shared-tab-follow-on-select.md:動作確認 [人間👨‍💻]` — 分割ビューの相方ペインは選択されないので追随せず「片側だけ古い」状態が仕様どおり残るが、人間の動作確認 3 項目に入っていない（polish 1 回目の P2 で「終了報告へ」と送られたまま）。/ 決めないと、後から片側の古さをバグとして報告・修正しにいく余地が残る。

````

**対応**: P0 なし → 収束。P1 は両方反映 — `docs/CHANGELOG.md` の `[Unreleased]` に `### 変更` を 1 行追加、`plantProbe` の JSDoc を「`ev` は main world・同じドキュメントの間だけ残る」に書き換え。P2 は 4 件とも反映 — `VERIFY.md` の shared-tabs 行に選択時追随（beforeunload 抑止・sleep 復帰・戻る・通話ガード）と件数（60 件）を追記、「戻れる」の前提 check を `brief(before)` に統一、`tab.follow_failed` は `ERR_ABORTED` を出さず（`follow_blocked` に任せる）`code` が無いときはキーごと落とす、`render-process-gone` に `endFollowLoad(wc)` を足して `beginFollowLoad` の JSDoc にも追記。Q は 2 件とも自分で閉じた — セッション復元経路の自走検査は「今回の範囲に入れない」（復元は `createTab(def.url, asleep)` → `materialize` で一致する経路で追随が起きないことをコードで確認済み。「起動したら続きが出る」は復元自体の挙動で追随の機能ではない。plan ログ > 方針変更に記録）、分割ビューの相方ペインが追随しないことは plan の人間の動作確認に 1 行追加。
 動作確認 fail: verify-all 経由の `verify:only shared-tabs` で既存の「定義への書き戻し」節が 3 回中 2 回 7 件で中断（A の実体は新 URL に到達済みなのに定義だけ古い URL。B の実体化直後の初回 `did-navigate` の書き戻しが A の遷移より後に届いて巻き戻す競合）→ 修正: 検査側で実体化後に初回読み込みの完了を待つ `openEphemeralIn` を導入し全 6 箇所を置換、`waitForDef` 失敗時に定義一覧と A 側タブの状態を出す診断を追加。verify-all 経由 3 回連続 60 件 PASS。製品側の競合（人間の操作では踏めない数十 ms の窓）は範囲外として plan ログに記録。

## 2回目

````text
再レビューしました。前回の P1 2 件・P2 4 件はいずれも反映を確認しました（`[Unreleased] > 変更` の追加、`plantProbe` の JSDoc が main world の説明に修正、`VERIFY.md` の shared-tabs 行に追随の内訳と 60 件、`brief(before)`、`ERR_ABORTED` を `follow_failed` に数えず `code` を任意化、`render-process-gone` の `endFollowLoad` と JSDoc 追記）。`check(` の数も 60 件で VERIFY.md の記載と一致します。Q 2 件の自己決着（復元経路は範囲外・分割の相方は人間の動作確認に 1 行）も妥当で、plan ログに残っています。

新しく入った `openEphemeralIn` は、`loading === false` を待つことで実体化の初回コミット（`did-navigate` → 書き戻し）が確定してから他ウィンドウの遷移を撃つ形になっており、報告された競合を検査側で正しく塞いでいます。

## P0

## P1
- `src/main/registry.ts:syncEphemeralDefinition` — 実体化（`openEphemeral` → `createTab`）の初回コミットによる書き戻しが、その間に他ウィンドウが進めた定義 URL を巻き戻す競合。plan ログでは「検査側の問題・人間の操作では踏めない数十 ms の窓・製品側は範囲外」として閉じているが、**選択時追随が入ったことで結果の重さが変わっている**。/ 追随が無かったときの巻き戻しの影響は「サイドバーの行が古い URL を出す」だけだった。今は def が古いまま残ると、**先へ進んだ側のウィンドウ（A）自身が次にその行を選んだ瞬間に古い URL へ引き戻される**（`normalizeStoredUrl(tab.url) !== def.url` が成立するため）。しかも追随後の `did-navigate` が def を古い URL で確定させるので、自動では復旧せず、A が見ていたページは履歴の「戻る」でしか取り戻せない。契機は人間のクリックのタイミングだけでなく、A 側ページのクライアントリダイレクトのような人間が制御しない遷移でも成立する。/ 最小の対応は、親 plan（`docs/plans/2026-08-31-1241-arc-style-shared-tabs.md`）の決定表「定義への書き戻し」行に「実体化の初回コミットは他ウィンドウの新しい URL を巻き戻しうる（追随と組むと巻き戻し先へ引かれる）」を 1 行残すこと（本タスクの plan ログは archive 側なので、次に追随を触る人が読むのは決定表）。塞ぐなら `materialize` が読み込んだ URL を覚えて初回コミットだけ `syncEphemeralDefinition` の url 書き戻しをスキップする。

## P2
- `docs/plans/2026-09-03-1000-shared-tab-follow-on-select.md:ログ > 方針変更` — 「追随の `loadURL` が reject したときは `tab.follow_failed`（`code` 付き）を残す」が実装とずれた。今の `followEphemeralDefinition` は `ERR_ABORTED` では `follow_failed` を出さず（`follow_blocked` に任せる）、`code` が文字列でなければキーごと落とす。/ ログを読む側が「reject したら必ず 1 件出る」を前提に不在を異常と読む余地が残る。/ 該当行を「`ERR_ABORTED`（仕様どおりの中止）以外の reject だけ `tab.follow_failed` に残す」に直す。
- `scripts/verify-shared-tabs.mjs:openEphemeralIn` — beforeunload ブロックだけ戻り値を捨てて `instBU_A` を `state()` から取り直し、`waitForLoaded` をもう一度呼んでいる（`openEphemeralIn` が既に両方やっている）。/ 他の 5 箇所は戻り値を使う形に揃っているので、ここだけ「なぜ二重に待つのか」が読めない。/ `const instBU_A = await openEphemeralIn(uiA, defBU.id)` にして重複した `waitForLoaded` を落とす。

## Q

````

**対応**: P0 なし → 収束。P1 は最小対応を反映 — 親 plan の決定表「定義への書き戻し」行に「実体化の初回コミットが他ウィンドウの新しい URL を巻き戻しうる。追随と組むと進めた側が次の選択で古い URL へ引かれる。塞ぐなら materialize が読んだ URL の初回コミットだけ url 書き戻しをスキップ」を追記。製品側の修正（初回コミットの書き戻しスキップ）は仕組みの追加なのでループ中は見送り、終了報告へ。P2 は 2 件とも反映 — plan ログ > 方針変更の `tab.follow_failed` の記述を「ERR_ABORTED 以外だけ・code は取れたときだけ」に修正、beforeunload ブロックの `instBU_A` を `openEphemeralIn` の戻り値に揃えて重複した `waitForLoaded` を削除。
