review session: e7c7d45d-cefb-4763-8841-2b371cdd5cd3

## 1回目

````text
## P0
- Phase 1 > 2（`fillKyprCard`）・Phase 2 > 2（iframe の `probeCard`） — Stripe の iframe を `subFrameRunner` で見つけられない見込みが高い / `subFrameRunner` は `collectFrameIds` で CDP の `frame.url` と `WebFrameMain.url` が一致するかを比べている。CDP の `Page.Frame.url` には `#` 以降が入らない一方、`WebFrameMain.url`（最後に開いた URL）には入る。Stripe Elements の iframe は `elements-inner-card-….html#wait=false&componentName=…` のように `#` に設定を載せるので、`autofill.frame_not_found` で落ちて主な対象が丸ごと動かない。今の verify の iframe は `?mixed=1` だけで、`#` 付きは試していない / Phase 0 の最初に、`#` 付きの別オリジン iframe で `subFrameRunner` が付くかを実測する。落ちるなら `#` 以降を外して比べる（`url + urlFragment` でもよい）。Stripe の分割型は `#` を外すと同じ URL が並ぶので、iframe の要素（`DOM.getFrameOwner`）で引き当てる方法も一緒に決める。Phase 4 > 1 ② の模擬 iframe の `src` には `#…` を付ける

- Phase 1 > 2・Phase 2 > 2（決めたこと > 範囲） — 欄ごとに iframe が分かれているフォームでは、番号しか入らない / Stripe の分割型 Card Element（cardNumber / cardExpiry / cardCvc）や PAY.JP v2 は、欄 1 つにつき直下の iframe が 1 つある。今の plan は「フォーカスのある iframe 1 つ」にだけ入れるので、期限と CVC が残る。さらに期限や CVC の iframe にフォーカスしたときは、「番号の欄が無いフォームは対象にしない」に引っかかって候補が出ない。決めた範囲（直下の iframe まで）の中の話なのに、作りが合っていない / 入れる先を「フォーカスのある直下の iframe」と「それと同じオリジンの直下の兄弟 iframe」の組にする（どれも `OWNER_REGION` を通ったものだけ）。判定も「組の中に番号の欄があるか」に変える。Phase 0 の調査先に PAY.JP を足し、Phase 4 > 1 ② に「別オリジン iframe 3 つに欄が 1 つずつ」の型を足す

- Phase 1 > 3・Phase 4 > 2（決めたこと > Claude のウィンドウ） — `rememberAgentSecrets` では CVC と番号を伏せられない / `agent-page-source.js` の `rememberSecrets` と `redact` は、**4 文字以上の文字列が値に含まれるか**で伏せる。3 桁の CVC（Visa / Mastercard / JCB）は覚えさせても捨てられる。番号は `digitsOf` 済みの数字で覚えさせるのに、ページの表示は `4242 4242 …` のような整形や 4 つの欄への分割になりやすく、一致しない。このままだと Phase 4 > 2 の「番号・CVC が伏せられる」が落ちて作り直しになる / 値の一致ではなく欄そのもので伏せる。`agent-page-source.js` の `isPasswordish`（またはその隣）に `autocomplete=cc-number / cc-csc` と名前の手がかりを足し、そういう欄はいつでも伏せる。値を渡す今の仕組みは保険として残す。`agent-page-source.js` の `OWNERS` に `agent` が入っているかも確かめる

## P1
- Phase 2 > 1・Phase 1 > 1 — `type=password` の CVC 欄がログインの欄として扱われる / 日本の決済フォームでは CVC がよく `type=password` になっている。preload の `loginFieldKind` はこれを `'password'` と判定してログインの候補を出す。`kypr-page-source.js` の `find()` もパスワード欄として選ぶので、⌘⇧L でサイトのパスワードが CVC に、メールが前の欄（番号や期限）に入ってしまう / カードの判定をログインより先に行い、カードの欄（`cc-*` や手がかりに合う欄）は `loginFieldKind` と `find()` の対象から外す。verify に「CVC が `type=password` のフォームでログインの候補が出ない」を足す

- Phase 1 > 1・Phase 1 > 4 — 番号を 4 つの欄に分けたフォームが入っていない / 日本の EC では `maxlength=4` の欄が 4 つ並ぶ番号入力がよくある。plan の期限・名義の分割はあるのに、番号の分割が無い / `fillCard` に「並んだ `maxlength=4` の欄に 4 桁ずつ入れる」を足す（Amex の 4-6-5 も含む）。ユニットテストと、Phase 4 > 1 ① のフォームの 1 つにも加える

- Phase 1 > 4 — 純粋関数を切り出してテストする、の形が今の作りと合わない / `KYPR_PAGE_SOURCE` はビルドを通さない `String.raw` の文字列で、`${` も書けない。Node 側の関数を import して使うことはできない / 自動入力の「collect → `buildFillPlan`」と同じ分け方にする。`probeCard()` は欄の記述（種類・`maxlength`・`placeholder`・`select` の選択肢）だけを返す。整形と組み立ては `src/shared` の純粋関数で main が行う。`fillCard(steps)` は値を入れるだけにする。新しいファイルは `OWNERS` に登録する

- Phase 0 > 3・Phase 4 > 1 — verify のクリックが main の `input-event` に届くか分からない / 今の `verify-kypr.mjs` は CDP の `Input.dispatchMouseEvent` でクリックしている。CLAUDE.md には、CDP のキーは main の `before-input-event` に届かないという実例がある。`input-event` も同じなら、②⑤ が実装のバグと見分けのつかない FAIL になる / Phase 0 の項目に「CDP のクリックで `input-event` の `mouseDown` が届くか」を足す。届かなければ `pressKeyForVerify` と同じ形の `sendInputEvent` の口（`clickForVerify`）を足して、それで撃つ

- 実装で決めること > ユーザーの操作によるフォーカスか — 当たり判定にページから来た矩形を使っていて、「矩形は位置合わせだけに使う」と食い違う / ページは、ユーザーがどこかをクリックした直後に `iframe.focus()` を呼び、その位置の矩形を送れば判定を通せる。座標の単位も、`input-event` は DIP、preload はズーム前の CSS px でずれる / 当たり判定には CDP で取った iframe 要素の矩形を使う（`subFrameRunner` は owner の node を既に解決しているので、親の座標の矩形も一緒に返させる）。preload の矩形は表示位置にだけ使い、`getZoomFactor` で単位をそろえる

- Phase 2 > 2 — iframe の候補をいつ閉じるかが決まっていない / iframe の中の Esc やクリックは親の preload に届かない。今の `blur` は 200ms 待ってから閉じる仕組みだが、iframe に移った時点で親の `window` の `blur` はもう出ているので、そのままでは使えない / main の `input-event` で閉じる条件を決める（Esc の `keyDown`、iframe の矩形の外での `mouseDown`）。`focusedFrame` が変わったときと、その iframe が移動（`did-frame-navigate`）したときも閉じる。verify にも「Esc で閉じる」を足す

- Phase 3 > 1・Phase 3 > 2 — 「カードの欄にいる」の判定方法と、判定する場所が決まっていない / ポップアップや候補の View を開くとページはフォーカスを失う。ログインの `probe` と同じく `document.hasFocus()` を見ると、ポップアップの「入力」ボタンが出ない。⌘⇧L・ポップアップ・候補の選択がそれぞれ別に `findTarget` と `subFrameRunner` を回すと、1 回ごとに debugger の attach と 150ms の待ちが重なる / `probeCard` のフォーカス判定は `activeElement` だけで行う。入れる先の判定は `findCardTarget(wc)` 1 つにまとめて 3 つの経路で共有する。⌘⇧L ではログインの `kyprTargetUrl` との順番（カードが先）も明記する

## P2
- Phase 4 > 3 — 広げるべき `OWNERS` の既存エントリを具体的に書いておく / 書いていないと、作業の途中で見落としやすい / `src/shared/kypr-page-source.js` は `['kypr']` に `agent` を足す。`src/preload/kypr-page.ts` は `['kypr','phase1']` に `agent` を足す。`src/renderer/components/Kypr.tsx` は、`verify-agent.mjs` が案内の行の描画まで見る場合だけ `agent` を足す

- Phase 2 > 2 — iframe にフォーカスが移るたびに debugger を付けて調べるのは重い / 分割型で欄を移るたび、また広告や YouTube の埋め込みをクリックするたびに、attach・150ms の待ち・detach が走る / 同じ frame・同じ document の `probeCard` の結果を覚えておき、移動したら捨てる

- Phase 0 > 1 — 調査先が偏っている。概要の「GMO-PG は iframe」も怪しい / GMO-PG のトークン型や Veritrans はメインフレームの欄で、別オリジンの iframe を使う代表は Stripe と PAY.JP / 調査先に PAY.JP・Veritrans・SBペイメントを足し、結果に合わせて概要の書き方を直す

## Q
- 決めたこと（表に行が無い） — `http:`（https でない）のページ・iframe でもカードの候補を出し、値を入れるかが決まっていない / 決めないと、暗号化されずに送られるフォームへ番号と CVC まで入れてしまう。Chrome の自動入力は安全でないページではカードを入れない。トップが https で iframe だけ http の場合も含めて決める

````

**対応**: P0の3件を反映（① 前提に`subFrameRunner`の`#`の件を書き、Phase 0 > 3に`#`付きiframeの実測、Phase 1の先頭に探し方の修正、Phase 4 > 1 ②の模擬iframeに`#…`を足した ② 決定表の範囲に「同じオリジンの兄弟iframeの組」を入れ、判定を「組の中に番号の欄があるか」に、Phase 0の調査先にPAY.JP、Phase 4 > 1 ②に兄弟iframeの型 ③ 前提に伏せ字が値の一致で4文字以上の件を書き、決定表のClaudeのウィンドウを「欄そのもので伏せる（`isPasswordish`の並びに足す）、`rememberAgentSecrets`は保険」に変えた）。P1は書き換えで済むものを反映: CVCが`type=password`の件（実装で決めることに「カードの判定はログインより先」）、番号の4分割（実装で決めることの「番号の形」とユニットテスト）、ページ側と整形の分け方（実装で決めること・Phase 1を「記述を返す/値を入れるだけ＋`src/shared`の純粋関数」に）、CDPのクリックと`input-event`（Phase 0 > 3 ③）、当たり判定の矩形（実装で決めることを「CDPで取ったiframe要素の矩形・単位をそろえる」に）、iframeの候補を閉じる条件（Phase 2に1項目）、⌘⇧L・ポップアップの判定（`activeElement`だけで見る・判定を1つにまとめて3経路で共有・⌘⇧Lはログインより先）。P2はOWNERSの具体（Phase 4 > 3）と調査先・概要の書き方を反映。見送り: P1の「CVCが`type=password`のフォームでログインの候補が出ない」の検査の追加と、P2のprobe結果のキャッシュ（どちらも足す修正。終了報告に回す）。Q（httpのページ）: 決定「安全なコンテキスト（https、またはloopbackのhttp）のときだけ。トップとiframeの両方で見る」/ 根拠: Chromeの自動入力の扱い・自走検証の模擬サーバーが`127.0.0.1` / `localhost`のhttp（`verify-kypr.mjs`）/ 反映先: 決定表「安全でないページ」・Phase 1 > 4

## 2回目

````text
## P0

## P1
- Phase 1 > 1 — 「iframe要素で引き当てる」の方法が決まっておらず、分割型では今の選び方に戻ると決まらない / `subFrameRunner` は、同じ URL のフレームが複数あると `document.hasFocus()` と `activeElement` の点数で 1 つを選ぶ。候補の View やポップアップにフォーカスが移ると、どの iframe も `hasFocus()` は false になる。分割型ではどの iframe にも入力欄の `activeElement` が残っているので、点数が並んで `frame_ambiguous` になる。結果として、候補から選んだときに分割型だけ入らない / URL で探すのをやめる。メインフレームの isolated world で兄弟の iframe 要素を集め、CDP の `DOM.describeNode` でそれぞれの `frameId` を取る。フォーカスのある iframe は、メインフレームの `document.activeElement` の iframe 要素から引く。別プロセスの iframe は、`targetId` がその `frameId` に一致する子セッションに付く。点数で選ぶのはやめる

- Phase 1 > 4・Phase 2 > 2 — 組の iframe ごとに `subFrameRunner` を呼ぶと、遅さがフレームの数だけ掛け算になる / `subFrameRunner` は 1 回ごとに attach・`setAutoAttach`・150ms の待ち・frame tree の取得・detach を行う。Stripe のページには見える iframe 3 つのほかに、同じ `js.stripe.com` の見えない controller の iframe もある。見えない iframe は `OWNER_REGION` で弾かれるが、弾かれるまでに 1 回分の時間がかかるので、候補が出るまで 1 秒近く待つことになる / 組を一度の attach で扱う口（例: `frameGroupRunner(wc, frameIds)`）を作る。1 つのセッションの中で、各フレームの `OWNER_REGION` の確認と world の作成をまとめて行う

- Phase 1 > 4 — 記述を取ってから値を入れるまでの順番と、組を丸ごとまとめて組み立てることが書かれていない / 自動入力は「同じ runner で集めてから入れる」（`frame-runner.ts` の冒頭）ことで、要素を取り違えないようにしている。候補を出したときの `probeCard` の結果で手順を作ると、選ぶまでの間に DOM が変わったとき、別の欄に入ってしまう。分割型では、番号は A、期限は B のようにフレームをまたぐ / `fillKyprCard` は、入れる直前に組の各フレームで同じ runner を使って `probeCard` → 整形の関数に組全体の記述（フレームの識別子付き）を渡して手順を作る → 各フレームで `fillCard(steps)`、の順に行う。これを Phase 1 > 4 に書く

- Phase 1 > 4（決めたこと > 範囲） — Stripe Elements で名義がメインフレームにある型を考えていない / Stripe の Card Element には名義の欄が無いので、多くのサイトは名義の欄を自分のページ（メインフレーム）に置く。今の入れる先は「組 → メインフレーム」という順の片方だけなので、組に入れると名義が残る。決定表の「入れる項目: 名義」が満たせない / 組に入れるとき、組に無い項目（名義など）がメインフレームのカードの欄にあれば一緒に入れる。Claude のウィンドウは決定表のとおり何も入れない。Phase 4 > 1 ② の型の 1 つで、名義をメインフレームに置く

- 前提 > 伏せ字の行・Phase 4 > 2 — 前提が実際と違い、Claude のウィンドウの検査も変更が無くても通ってしまう / `agent-page-source.js` の `SENSITIVE_AUTOCOMPLETE` には `cc-number|cc-csc|cc-exp` がもう入っている。`isPasswordish` も、read_page の `value="[redacted]"` も、スクショの塗りも欄で効いている。足りないのは `autocomplete` が無く、名前の手がかりしかない欄だけ。検査のフォームが Phase 4 > 1 ① と同じく `autocomplete` 付きなら、手がかりを足さなくても PASS する / 前提の書き方を「`autocomplete` のある欄はもう欄で伏せている。足すのは名前の手がかり」に直す。Phase 4 > 2 の検査のフォームは、`autocomplete` が無く、`name` の手がかりだけで、CVC が 3 桁の型にする

- Phase 0 > 3 — 候補を選ぶときに `wc.focusedFrame` がまだ iframe を指しているかを、まだ確かめていない / 選ぶ直前の確認（Phase 2 > 4）も入れる先の判定（Phase 1 > 4）も `focusedFrame` に頼っている。ほかの webContents（候補の View・ポップアップ）にフォーカスが移ったとき、これが null やメインフレームに変わると、どちらも成り立たない。今の検査は、iframe で候補の View から選ぶ経路を通っていない / Phase 0 > 3 に「候補の View やポップアップにフォーカスがあるときの `focusedFrame`」を足す。変わってしまうなら、候補を出したときに組（`frameId` と document）を覚えておき、選ぶときはそれが同じかを確かめる形にする

## P2
- Phase 2 > 2 — 候補の経路では、安全なコンテキストかどうかを見ていない / 決定表は「候補を出し、入れる」の両方に効く決まりだが、Phase 1 > 4（入れる側）にしか書いていない / `probeCard` が `isSecureContext` を返すようにし、候補・⌘⇧L・ポップアップ・入れる側のすべてでそれを見る。`isSecureContext` は親の状態も含めて判定し、loopback の扱いも Chrome と同じなので、URL を自分で読み解くより確実

- 決めたこと > 何を見てカードの欄と判断するか — 「フォーカスされたiframeに`subFrameRunner`で入り」が、範囲の行（組で判定する）と食い違っている / 実装するときにどちらに従うか迷う / 「フォーカスのある iframe とその兄弟の組に入り、組の中に番号の欄があるかを見る」に書き換える

- 実装で決めること > カードの欄の見分け方 — 名前の手がかりの一覧を、3 か所の文字列のソースで別々に持つことになる / preload、`kypr-page-source.js`、`agent-page-source.js` のどれかだけを直すと、「入れたのに伏せない」欄が黙ってできる / 3 か所にお互いを参照するコメントを置く。ユニットテストで 3 つのソースに同じ欄の例を通し、判定がそろっていることを見る

## Q

````

**対応**: P0は空で収束。書き換えで済むP1/P2を反映: P1 framesの探し方（Phase 1 > 1を「URLの一致と点数で選ぶのをやめ、iframe要素から`frameId`を引く」に）、P1 入れる順番（Phase 1 > 4に「入れる直前に同じrunnerでprobe → 組全体で手順 → fill」）、P1 名義がメインフレームにある型（決定表の範囲に「組に無い項目はメインフレームの欄にも入れる」）、P1 伏せ字の前提（前提を「`autocomplete`のある欄はもう欄で伏せている」に直し、決定表のClaudeのウィンドウと、Phase 4 > 2の検査のフォームを「`autocomplete`無し・名前の手がかりだけ・CVC3桁」に）、P2 安全なコンテキスト（決定表を「全経路で各フレームの`isSecureContext`を見る」に）、P2 判定の行の食い違い（決定表「何を見て…」を組の判定に）。見送り（足す修正のため終了報告へ）: P1 組を一度のattachで扱う口（`subFrameRunner`をフレームの数だけ呼ぶと遅い）、P1 候補のViewにフォーカスがあるときの`focusedFrame`の実測（Phase 0 > 3への追加）、P2 名前の手がかりを3か所で持つことへの相互参照とユニットテスト。前回見送ったP1（CVCが`type=password`のフォームの検査）とP2（probe結果のキャッシュ）も終了報告へ
