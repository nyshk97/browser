# Live Folder の小見出し（Review requested / Created）を折りたためるようにする

## 概要・やりたいこと

サイドバーの Live Folder（GitHub の PR）にある2つの小見出し `REVIEW REQUESTED` / `CREATED` を、
それぞれ独立にクリックで開閉できるようにする。初期状態は**両方とも折りたたみ**。
PR が多いとサイドバーの大半を占めてしまうので、普段は畳んでおいて必要なときだけ開きたい。

## 前提・わかっていること

- 描画は `src/renderer/components/LiveFolder.tsx`。`groups`（`review` / `mine`）を map して
  小見出し `.lf-sub`（`.name` + `.count`）と `PrRow` を並べているだけ
- 小見出しの CSS は `src/renderer/styles.css` の `.lf-sub` 系（565行付近）
- `/dig-lite` での決定:
  - **永続化しない**。React の state だけで持ち、起動のたびに両方折りたたみから始まる（設定スキーマは触らない）
  - **折りたたみ中に未読 PR があれば、小見出しの件数の横に青ドット**を出す（既存 `.row .dot` の見た目を流用）。開いたら行側のドットだけにする
  - **開いても再取得はしない**（`liveFolderRefresh` は呼ばない）
- 付随して決めたこと:
  - 打ち切り行（`.lf-truncated`）は、そのバケットが折りたたみ中なら出さない
  - 小見出しに開閉を示す小さな矢印（`›` 回転）を付ける。ホバーで `.row` と同じ薄い背景
  - 件数（`count`）は折りたたみ中も出す（畳んでいても件数は見えるべき）。**定義は「そのバケットに割り当てられた件数 = `items.length`」で、折りたたみ状態に依存しない**（GitHub 上の総件数ではなく、検索の取得件数 `truncation.returned` とも別物。`github-pr.js` は両検索に同じ PR があると `mine` 側から落とす重複除外をしているので、`items.length` は重複除外後の値になる。打ち切り時に `returned` は `100` でも `items.length` はそれ以下になりうる。`137` は打ち切り行が担う。表示値・`aria-label`・検査・DESIGN.md・コードコメントを全部この定義に揃える）
- **既存の自走検証 `scripts/verify-live-folder.mjs` は `.lf-row` / `.lf-title` を直接数えている**
  （126・127・412行など）。初期折りたたみにすると行が DOM に無くなり全滅するので、
  検証側で「小見出しを2つともクリックして開く」ヘルパを挟む必要がある
- 動作確認は `mise run check` + `mise run verify:only live-folder restart`（VERIFY.md の表どおり）

## 実装計画

### Phase 1: 開閉 state と小見出しのトグル [AI🤖]
- [x] `LiveFolder` に `collapsed: Record<LivePrBucket, boolean>` の `useState`（初期値 `{ review: true, mine: true }`）を追加
- [x] `.lf-sub` を `<button type="button">` に変え、クリックで該当バケットだけ反転（`setCollapsed((prev) => ({ ...prev, [bucket]: !prev[bucket] }))` の関数形式。検証の `expandAll` が同一タスクで 2 つ連続クリックするので、スプレッド代入だと片方の更新が失われる）。`aria-expanded` を付ける。`data-bucket="review|mine"` は**外側のラッパー `<div className="lf-bucket" data-bucket>` だけ**に付け、ボタンには付けない（検証のセレクタは `.lf-bucket[data-bucket="review"] > .lf-sub` / `.lf-bucket[data-bucket="review"] .lf-row` の子結合子で統一）。構造は `.lf-bucket` の中に「小見出しボタン」と、その**兄弟**の内容コンテナ `<div className="lf-items" id="lf-items-<bucket>">` を置き、ボタンから `aria-controls="lf-items-<bucket>"` で参照する。**内容コンテナは常に描画**し（`aria-controls` の参照先を消さない）、折りたたみ中は `hidden` 属性を付けて中の `PrRow` を描画しない（検証は `.lf-bucket[data-bucket="review"] .lf-row` で「開いた側の行だけが DOM にある」を識別できる）
- [x] 小見出しの先頭に `<span className="chev" aria-hidden="true">›</span>` を置き、`aria-expanded="true"` のとき CSS で 90° 回転させる
- [x] 折りたたみ中は `PrRow` を描画しない（`items.map` をスキップ）
- [x] 折りたたみ中で `items.some((i) => i.unread)` なら `.count` の横に `<span className="dot" />`。ボタンの `aria-label` を `"Review requested, 3 件, 未読あり"` のように件数と未読の有無を含めた文にする（ドットは装飾なので、支援技術にはラベルで伝える）
- [x] 打ち切り行（`.lf-truncated`）は現在の位置（`StatusLine` の下）・描画条件（`truncation[bucket]` があるとき）のまま、**そのバケットの小見出しが描画されていて**（`items.length > 0`）かつ `collapsed[bucket]` なら `hidden` 属性を付ける（重複除外で `items` が空でも `truncation[bucket]` は残りうる。小見出しが無いバケットの打ち切り行を隠すと開く手段が無く永久に消えるので、その場合は従来どおり常に見せる。DOM から消さない。`aria-controls` の参照先を残すため。検証の「畳むと 0 件」は `.lf-truncated:not([hidden])` で数える）。打ち切り行に `id="lf-truncated-<bucket>"` を付け、そのバケットに打ち切りがあるときはボタンの `aria-controls` を `"lf-items-<bucket> lf-truncated-<bucket>"` の空白区切りにする（開閉で表示が変わる要素を全部制御対象として公開する。無いときは `lf-items-<bucket>` だけ）
- [x] 右クリックのセクションメニューは従来どおり。**右クリックではトグルしない**。トグルは通常の click activation（左クリック・Enter・Space）で起きる（`<button>` の `onClick` に任せれば自然にそうなる）

### Phase 2: CSS [AI🤖]
- [x] `.lf-sub` を button 化に伴いリセット（`appearance: none; background: none; border: 0; width: 100%; text-align: left; cursor: default`）、ホバー背景を `.row:hover` と揃える
- [x] 矢印 `.lf-sub .chev`（`display: inline-block`（インラインのままだと `transform` が効かない）・10px の `›`、`.lf-sub[aria-expanded="true"] .chev { transform: rotate(90deg) }`、`transition` 短め）
- [x] `.lf-sub .dot`（`.row .dot` と同じ色・サイズ。`count` の右に 6px 空けて置く）

### Phase 3: 自走検証の追従 [AI🤖]
- [x] `scripts/verify-live-folder.mjs` に非同期ヘルパ `expandAll(ui)` を追加: `.lf-sub[aria-expanded="false"]` を全部 `click()` → `aria-expanded="false"` が 0 件になるまで `until` で待つ（小見出し自体が無ければ即 return）。冪等なので毎回呼んでよい
- [x] `.lf-row` 配下を読む既存の取得（`ROW_TITLES` / `STALE_ROWS` / `TRUNCATED` / `.lf-row .lf-sub-line` の直接取得など、`grep -n 'lf-row' scripts/verify-live-folder.mjs` で洗い出した全部）のうち**「行が見えている前提」の既存検査**だけを、直前に `await expandAll(ui)` してから評価する共通ヘルパ `readExpanded(ui, expr)` に寄せる。`until(...)` の述語もこのヘルパ経由にする。**開閉状態そのものを検査する新規の取得（折りたたみ中の `.lf-row` 0 件・`.lf-truncated` 0 件など）は raw の `ui.ev` で読む**（`readExpanded` を通すと直前に再展開して検査が成立しない）（設定の再有効化・`--restart-read` での再マウントのたびに state が畳まれるので、どの検査が再マウント後かを追わずに済むよう**読むたびに開き直す**。通常の再描画では state は保たれる）。`until` を経ずに `ROW_TITLES` を読んでいる箇所も直前に `expandAll` を入れる
- [x] 追加の検査は**独立した状態から始める**: 状態正規化ヘルパ `collapseAll(ui)`（`aria-expanded="true"` を全部クリックして `true` が 0 件になるまで待つ）を用意し、下の各検査の冒頭で呼ぶ（検査間で開閉状態が漏れて「開くつもりが閉じる」を防ぐ）。順序は「初期折りたたみ → 外観 → 独立開閉 → 未読 → 右クリック → 再取得しない → アクセシビリティ」（`serve(okBody(BASE))` で一覧が初めて出た場面。`expandAll` を呼ぶ**前**に、まず `.lf-sub` が 2 件になるまで `until` で待つ専用条件を置く。起動直後は `Connect GitHub` なので小見出しが無く、`waitRequests` だけでは描画が保証されない）:
  - 一覧初回表示時: `.lf-sub[aria-expanded="false"]` が 2 件・`.lf-row` が 0 件・各 `.lf-sub .count` の文字が BASE の件数（review 2 / mine 1）と一致し `offsetParent !== null`（畳んでいても件数は見える）
  - 外観: 同じ場面で `.lf-sub .chev` の `getComputedStyle().transform` が閉時 `none`、開時は `until` で最終値 `matrix(0, 1, -1, 0, 0, 0)` になるまで待って一致すること（`transition` 中の中間値で判定しない）。`.lf-sub:hover` の背景が `.row:hover` と同じ値であること（手順: まず閉じたままの小見出しへ `Input.dispatchMouseEvent` でホバーして `background-color` を読む → review を開いて実在する `.lf-row` にホバーして読む → 比較。初期状態では `.lf-row` が無いので順序が要る。各ホバー後に対象が `matches(':hover')` であること、ホバー前と後で `background-color` が変わったことも検査する。`.row` には `background 0.12s` の transition があるので、読み取りは `until` で最終色（`--nemo-hover` の計算値）に達するまで待ってから行う（合成マウスが当たらず両方透明で「一致」しても通ってしまうのを弾く））（スクショは下の `NEMO_VERIFY_SHOTS` の opt-in で撮る）
  - `review` の小見出しだけクリック → `.lf-bucket[data-bucket="review"] .lf-row` が BASE の review 件数・`.lf-bucket[data-bucket="mine"] .lf-row` が 0 件・`mine` の `aria-expanded` は `false` のまま
  - 未読: 期待値は固定数でなく `liveState` から出す（初回 `BASE` 取得は `withUnread` で 3 件すべて未読になるので「1 件」を決め打ちしない）。両方畳んだ状態で `N = state.items.filter(i => i.bucket === 'review' && i.unread).length` を取り、`N >= 1` を前提として、閉時は `.lf-bucket[data-bucket="review"] > .lf-sub .dot` が 1 件・`.lf-row .dot` が 0 件 → review を開くと `.lf-bucket[data-bucket="review"] > .lf-sub .dot` が 0 件・`.lf-bucket[data-bucket="review"] .lf-row .dot` が `N` 件（`mine` 側は畳んだままなので `.lf-bucket[data-bucket="mine"] > .lf-sub .dot` は未読があれば 1 件のまま。全体の `.lf-sub .dot` を 0 件と決め打ちしない）（ヘッダーと行の両方から消す誤実装を弾く）。PR_12 の既読化（既存の「選ぶと unread が落ちる」検査）の後は review を開いたまま `.lf-bucket[data-bucket="review"] .lf-row .dot` が `N-1` 件になることだけを見る（PR_41 / PR_88 は未読のままなので「0 件」は期待しない）
  - 右クリック: 小見出しを `Input.dispatchMouseEvent`（button: right）で右クリック → `RowMenu` が出て、`aria-expanded` とリクエスト数 `total` が変わらないこと。末尾で Escape（`Input.dispatchKeyEvent`）を送り、メニュー要素が消えるまで `until` で待ってから次の検査へ（メニューが残ると後続の `click()` の前提が崩れる）
  - 再取得しない: `resetCounters()` 後に両方の小見出しを開いて閉じ、1 秒待って `total`（擬似サーバーへのリクエスト数）が 0 のままであること
  - アクセシビリティ: 各ボタンの `aria-label` に件数（`2`/`1`）と未読の有無が入っていること。未読ありだけでなく、`mine` に既読の PR しか無い状態（既読化済みの PR_12 だけを `mine` 検索に返し `review` 検索からは外す制御レスポンスで作る。PR_88 を実際に開いて既読化すると GitHub へ実接続するタブが増えるので使わない）で `.lf-bucket[data-bucket="mine"] > .lf-sub .dot` が 0 件かつ `aria-label` に「未読あり」が含まれないことも見る（固定文言で通る誤実装を弾く）・`aria-controls` の参照先 ID（空白区切りで複数）がすべて `document.getElementById` で実在すること（打ち切りあり・なしの両場面で）・ボタンに focus して `Input.dispatchKeyEvent` を `keyDown` → `keyUp` の対で送る（Enter: `key:'Enter', code:'Enter', windowsVirtualKeyCode:13`／Space: `key:' ', code:'Space', windowsVirtualKeyCode:32`。Enter は押下・Space は解放で発火するので対で送る）と、Enter と Space を**別々の検査**として**その**バケットだけ `aria-expanded` が反転すること
  - 打ち切り: 既存の `truncation.mine` 検査（`mineTotal: 137`）の場面で、`mine` を畳むと `.lf-truncated:not([hidden])` が 0 件（`.lf-truncated` 自体は 1 件残る）・開き直すと `:not([hidden])` が 1 件。加えて、`mine` 検索の返却が全部 `review` と重複する制御レスポンス（`mine` の `issueCount` は `nodes` より大きくする）で、`mine` の小見出しが 0 件のまま `.lf-truncated:not([hidden])` が 1 件見えていること（小見出しの無いバケットの打ち切り行が初期折りたたみで消えない）
  - 再起動経路（`--restart-read`）: キャッシュ復元で `.lf-sub` が 1 件以上出るまで待ち、`expandAll` を呼ぶ**前**に「`.lf-sub` の全部が `aria-expanded="false"`」かつ `.lf-row` が 0 件を検査してから行数検査へ進む（「起動のたびに折りたたみ」がキャッシュ復元でも成り立つこと）。**fixture は review 1000 件が先頭にあり 200 件で打ち切られるので `mine` の小見出しは出ない**。2 件を期待しない（fixture の組み替えは本件のスコープ外）
- [x] `mise run check` → `mise run verify:only live-folder restart` を通す
- [x] 見た目の自己確認: `verify-live-folder.mjs` に opt-in の環境変数 `NEMO_VERIFY_SHOTS=<dir>` を足し、指定されたときだけ「両方閉（初回 `BASE` は全件未読なので小見出し側にドットあり）」「review だけ開（未読ドットが行側・mine は小見出し側）」「両方開」の 3 場面で `Page.captureScreenshot`（サイドバー領域を `clip`）を `<dir>/live-folder-<場面>.png` に保存する。撮影の直前に、矢印の `transform` が最終値になるまで `until` で待ち、`Input.dispatchMouseEvent` でマウスをサイドバー外へ退避して `:hover` の要素が 0 件になったことを確認する（回転途中や hover 中を撮らない）（未指定なら何も撮らず、通常の検証には影響しない。指定時は読んだ時点で `mkdirSync(dir, { recursive: true })` し、ディレクトリでなければ明示的に失敗させる）。実行は `NEMO_VERIFY_SHOTS=<scratchpad>/shots mise run verify:only live-folder` で、撮れた PNG を Read して矢印・件数・ドットの配置を目視し、報告に絶対パスを載せる（擬似サーバーはスクリプトが立てるので手動起動は不要）
- [x] VERIFY.md の Live Folder 節に「小見出しは初期折りたたみ。表示行を前提とする既存検査だけ `readExpanded`（直前に `expandAll`）で読み、折りたたみ状態そのものの検査は raw の `ui.ev` で読む」を追記
- [x] DESIGN.md の Live Folder の記述に、小見出しの独立開閉・初期折りたたみ・閉時の未読ドット・矢印の規則を追記し、既存の「右端は常に描画行数」「下に何行あるか」の定義を「バケットに割り当てられた件数（`items.length`。重複除外後の値で、折りたたみ状態に依存せず、DOM 上の行数でも検索の取得件数 `returned` でもない）」に**置き換える**。`git grep -n '描画行数\|rendered'` で該当を洗い出し（`LiveFolder.tsx` の小見出し・打ち切りの説明、`styles.css` の `.lf-sub .count` / `.lf-truncated` コメント、`src/shared/types.ts` / `src/shared/github-pr.js` の `truncation` 周辺、`verify-live-folder.mjs` の検査名）、「バケットに割り当てられた件数」と検索側の `returned` / `total`（取得件数・総件数）を区別する文言に更新する（折りたたみ中は描画行数が 0 なので「描画行数」の語は残さない）

### 動作確認 [人間👨‍💻]
- [ ] `mise run dev` で実アカウントの一覧を出し、2つの小見出しが独立に開閉すること・未読ドットが件数横に出ることを目視

## ログ
### 試したこと・わかったこと
- 2026-08-26: 自走検証は 98 PASS / 0 FAIL（SKIP は既存の ⑱ だけ）。新規検査はすべて実測値付きで通過
- スクショ（`NEMO_VERIFY_SHOTS`）には右クリック後のフォーカスリングと hover 背景のフェードが写るので、撮影前に `blur()` と 300ms 待ちを入れた

### 方針変更
- 初期折りたたみの検査は ⑫ 直後（最初の `readExpanded` より前）に raw で置く（Codex レビュー: 後から畳み直して検査すると初期値の退行に気づけない）
- 「未読なし」の場面は、既読済み PR_12 を `mine` 検索に返す制御レスポンスを ⑩ の直後に置いて作った（main は URL キーで未読を引き継ぐので bucket が変わっても既読のまま）
