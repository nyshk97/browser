review session: e0fd23d6-3e85-41b5-817a-cdbff8fdbf59

## 1回目

````text
## P0
- Phase 2 > 2 — ツールバーの kypr アイコンを出すために `Toolbar.tsx:309` を変えることになっているが、ここ（と「調べてわかったこと」の同じ行）は kypr ではなく**拡張の `<browser-action-list partition={PAGE_PARTITION}>`**の分岐になっている。kypr のアイコンは `state.kypr` があれば出る作りで、agent 窓で null にしているのは `registry.ts:2364`（`kypr: this.isAgent ? null : kyprBadge(...)`）/ plan のとおりに `isAgent` を外すと、Claude の窓に**通常セッションの拡張アイコン**が出てしまう。つまり壊れる / `Toolbar.tsx` には触らず `registry.ts:2364` だけ直す。「調べてわかったこと」の記述と、Phase 4 > 3 の OWNERS の対象からも `Toolbar.tsx` を外す

## P1
- Phase 2 > 1 — `noteCredentialsEntered` を「入れたあと」に呼ぶ順番になっている / ユーザーがいる間も Claude の読み取り（read_page・スクショ）は通る（`withAgentActive` のコメントのとおり、様子見はよくある）。値を流し込んでから `rememberSecrets` が届くまでの間に、`type=text` の欄に入ったコードや身分証の番号が読まれうる。`rememberSecrets` が失敗したとき（注入前など）にどう扱うかも書かれていない / 流し込む**前に**伏せる値を登録し、登録に失敗したら入れない（fail-closed）。Phase 3 > 1 も同じ順番にする
- Phase 1 > 1 — 「JS を実行した」の記録を main 側の `AgentPage` に持たせ、`did-navigate` で解く案になっている / taint と伏せる値は isolated world の中（`agent-page-source.js` の `tainted`・`secrets`）にあるので、そもそも document ごとに分かれている。main 側で持つと、document と記録がずれる経路（bfcache で戻ったとき、`did-navigate` の順番が前後するとき）で穴になる / 記録も isolated world に持つ（`__nemoAgent.markScriptRan()` を足し、`state()` で返す）。そうすれば「taint の解き方に揃える」がそのまま成り立ち、ナビゲーションを見張る処理も要らない
- Phase 1 > 2 — 記録は document 単位だが、その document が `window.open` で開いた**同じオリジンのタブ**は opener から DOM を触れる。JS を入れた document から開いたタブには記録が無く、そこで入れた値をフックされる / 「新しいタブで開き直して」という案内が、JS で開かれたタブでは守りにならない / agent 窓では、記録のある document が開いたタブ（`setWindowOpenHandler` / `did-create-window` の経路）にも記録を引き継ぐ。Phase 4 > 1 に検査を 1 件足す
- Phase 2 > 1 — iframe を伏せられるかは「確かめる」扱いだが、コードを読めば分かる。read_page / get_page_text はメインフレームの DOM しか読まないので、iframe の値はそもそも出ない。一方、スクショには iframe の中身が写るのに、`maskSecrets` が黒く塗るのはメインフレームの要素だけ / 今のままだと、iframe の中の `type=text` の欄（コード・身分証の番号）の値がスクショに写る。逆に「断る方に倒す」を選ぶと、埋め込みフォームへの自動入力が agent 窓で全部使えなくなる / パスワード（`type=password` は伏せ字で描かれる）は iframe でも入れてよい。コードと身分証の番号を iframe に入れたときは、メインフレーム側で**その iframe の要素の矩形を丸ごと**塗る（`frame-runner` の `OWNER_REGION` と同じやり方で要素は特定できる）。どちらにするかをここで決めて書く
- Phase 2 > 1 / 決定表「伏せる値」 — ログイン後の自動コピー（`copyKyprTotp(..., 'after-login')`）と、コードの入力に失敗したときのコピーでは、Nemo 側が何も入れないので `noteCredentialsEntered` を呼ぶ機会が無い。さらにコードを貼るのはログインの**次の document** で、前の document の `secrets` は引き継がれない / 決定表で「コードは伏せる」としたのに、自動コピーの経路では伏せられない（`autocomplete=one-time-code` でない欄なら素通しになる） / agent 窓でコピーしたときは、コードを `AgentPage` にコードの有効期間だけ持っておき、次の document に注入するときに `rememberSecrets` へ渡す。やらないなら、agent 窓では自動コピーを止めることを明記する
- Phase 3 > 1 — 伏せる値の取り出し元が「`result.documents` / 流し込んだ値から」になっているが、`result.documents` は `buildFillPlan` の**件数**（`plan.documents: number`）で値を持っていない / このままでは実装できない / `buildFillPlan` の `steps` のうち、option が `autofill-schema.js` の `secret: true` の項目に当たるものの**実際に流し込む値**を渡す（分割欄・整形後の値も拾える）
- Phase 1 > 3 — 「kypr の `identity.ts` から引く。Nemo 側に一覧を持たない」とあるが、Nemo にはすでに `src/shared/autofill-schema.js` の `ProfileField.secret`（旅券・免許証・保険証の記号・番号）がある / 新しく引く口を作ると、同じ一覧が 2 か所になる / 既存の `autofill-schema.js` の `secret` を使う（kypr 側と揃っていることは既存のテストで見る）と書き換える
- Phase 2 > 6 — 確かめる対象が `attachedHere = false` の経路だけになっている。agent は `if (!dbg.isAttached()) dbg.attach()` と遅れて attach するので、agent の debugger が外れている間に `subFrameRunner` が先に attach すると、その後の `dispose` の `detach()` で agent の debugger（ダイアログの横取り・ガード）ごと外れる。また agent の `debugger.on('message')` は `sessionId` を捨てるので、auto-attach した子セッションのイベントがメインのものとして処理される / どちらもコードから確定する問題で、「確かめる」で済む話ではない。ポップアップを開くたびに `kyprTargetUrl` → `findTarget` でこの経路が走る / agent 窓では `subFrameRunner` の前に agent の `ensureDebugger()` を通す（`attachedHere` を必ず false にする）。agent の CDP の受け口で、`sessionId` 付きのイベントは捨てる

## P2
- Phase 4 > 1 — 検査が「key でないときは効かない」だけで、**key でない窓への最初の実クリック**（`before-mouse-event` → `makeWindowFocusable` → `focus()`）の直後に、候補・右クリックのメニューがちゃんと出るか（key の判定が間に合うか）を見ていない / 動作確認に「Claude の番のあと、最初のクリックで欄の下に候補が出る・右クリックで自動入力が出る」を足す
- Phase 3 > 2 — 項目が「フォーム自動入力」だけになるので、フォームでない場所を右クリックしたときに空のメニューを出さないことも書いておく（`buildContextMenuTemplate` に agent 用の分岐が要る）
- Phase 4 > 3 — `context-menu.ts` は `verify-targets.mjs` で意図して載せていない（フルに倒す）。`page-shim.ts` は未登録で、`Toolbar.tsx` は P0 のとおり触らない。`agent` を足す対象は `kypr/fill.ts`・`kypr/inline.ts`・`autofill/index.ts`・`autofill/frame-runner.ts` と具体的に書いた方が迷わない
- 決定表「`javascript_tool` を実行したページ」 — 「本当のナビゲーションで解ける」は、Claude の JS が Service Worker を登録していると成り立たない（ナビゲーションをまたいで残り、ログインの POST を読める）。ただしこれは今の手入力の運用でも同じ穴なので、将来課題としてログに残しておけば足りる

## Q
- 決定表「伏せる値」 — `rememberSecrets` は 4 文字未満の値を捨てる。そのため保険証の番号（例 `56`）のような短い身分証の値は伏せられず、read_page やスクショに出る。「そのまま見える」を受け入れるのか、agent 窓ではその欄にだけ入れないのか / 決めないと、Phase 3 > 1 の実装と Phase 4 > 1 の「身分証の番号が伏せられる」検査の期待値が決まらない

````

**対応**:
- P0 Toolbar: `Toolbar.tsx:309` は拡張の分岐と確認（registry.ts:2364 が kypr を null にしている）。「調べてわかったこと」・Phase 2 > 2・OWNERS を registry.ts に直した
- P1 伏せる順番: 決定表に「流し込む前に登録・失敗したら入れない」を足し、Phase 2 > 1・Phase 3 > 1 を書き換えた
- P1 JS 実行の記録: isolated world に持つ形に Phase 1 > 1 を書き換えた
- P1 iframe: 決定 = iframe にはパスワードだけ、コード・身分証の番号は入れない（コードはコピーに回す）/ 根拠: スクショの伏せ字はメインフレームの要素だけ（レビュー）。iframe の矩形を塗る仕組みは足す修正なので採らず、断る側に倒した
- P1 自動コピーのコード: 決定 = 伏せずに受け入れる（使い終わった 30 秒のコード。one-time-code の欄は既存の伏せ字が効く）/ 根拠: 決定表の「伏せる値」の趣旨。コードを持ち越す仕組みは足す修正なので採らない
- P1 result.documents: 件数と確認。buildFillPlan の結果から secret の値を取る形に書き換えた
- P1 autofill-schema.js の secret: 既存の一覧を使う形に決定表・Phase 1 > 3 を書き換えた
- P1 debugger の相乗り: 「確かめる」を、確定した 2 つの問題と対処（先に agent の debugger を付ける・sessionId 付きのイベントを捨てる）に書き換えた
- P2 空のメニュー: Phase 3 > 2 の条件に「フォームの欄のときだけ」を足した（条件の修正）
- P2 OWNERS: 具体的なファイルに書き換えた
- Q 4 文字未満: 決定 = 伏せずに入れるのを受け入れる / 根拠: rememberSecrets の閾値は短い文字列の過剰な伏せ字を避けるため。保険証の記号単独の価値は低い
- 見送り（足す修正）: P1 window.open で開いたタブへの記録の引き継ぎ・P2 最初の実クリック直後の key 判定の確認・P2 Service Worker の将来課題 → 終了報告へ

## 2回目

````text
## P0

## P1
- Phase 1 > 3（表の「コード」の行） — 決定表の「コピーで渡るコード」では、自動コピーのコードは伏せないと決めた。ところが表の「コード」の行では `fillKyprTotp / ログイン後の自動コピー` が同じ行にまとまっていて、伏せる値が「コード」になっている / 実装する人はこの表を見て差し替えていく（Phase 1 > 2）ので、自動コピーのほうでも伏せ字を作ろうとしてしまう / 行を分ける。自動コピーの行は「key 不要・JS 実行済みなら断る（`fillKyprLogin` の判定に含まれる）・伏せる値は —（決定表「コピーで渡るコード」）」にする
- Phase 2 > 1 — 「伏せる値の登録に失敗したら入れない」と決めたが、今の `noteCredentialsEntered` は `Promise<void>` を返す。タブが見つからない（`found` が null）ときは何もせずに戻り、失敗したことを呼び出し側に伝えない / このままだと、fail-closed の決定を実装できない / `noteCredentialsEntered` が成否（`boolean`）を返すように変える。タブ・ページが見つからないときと `rememberSecrets` が例外を投げたときを失敗として扱い、呼び出し側（`fill.ts`・`runAutofill`）はそれを見て入力をやめる。Phase 1 > 1 で作る問い合わせ口と同じ場所で直すと書いておく
- Phase 4 > 2 — 修正前の FAIL を「伏せる値の登録を外すと『パスワードが出ない』が FAIL になる」で確かめる計画になっているが、これは FAIL にならない。kypr の入力は `input` / `change` イベントを発火し（`kypr-page-source.js`）、agent 側の `onUserValue` がパスワードの欄の値を拾って `secrets` に入れる。read_page も `isPasswordish` の欄の値を `[redacted]` にする。`noteCredentialsEntered` を外しても、パスワードは既存の仕組みで伏せられる / このままでは、今回の配線が効いていることを確かめられない / FAIL を確かめる対象を、既存の仕組みでは拾えない値に替える。たとえば `autocomplete` の無い `type=text` の欄に入れたコードや、自動入力で入れた身分証の番号を、get_page_text やページの文字として出す検査にする
- Phase 4 > 1 — 1 回目のレビューのあとで決めたことが、検査の一覧に入っていない / このままでは、決めたとおりに動いているかどうかが自走検証で分からない / 次の 3 件を足す
  - iframe のコードの欄では、コードを入れずにコピーに回る
  - 自動入力は、iframe の中の身分証の番号の欄を空のまま残す
  - iframe に入れたあとも agent の debugger が付いたまま（ダイアログの横取りが効く）で、`sessionId` 付きのイベントを処理しない

## P2
- Phase 2 > 1 — 流し込む前に伏せる値を登録すると、その時点でページは taint される。登録を `findTarget` の前に置いてしまうと、入れる先が無い・URL が合わない（`no-target` / `url-mismatch`）で終わったときにも、`javascript_tool` が使えなくなる / 登録するのは、入れる先のフレームを決めて URL を照合し直したあと、実際に流し込む直前だと書いておく

## Q

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P1 Phase 1 > 3 の表: 「コード」と「ログイン後の自動コピー」の行を分け、自動コピーの伏せる値を —（決定表「コピーで渡るコード」）にした
- P1 Phase 2 > 1: `noteCredentialsEntered` を成否を返す形に変え、失敗したら入れないと書いた
- P1 Phase 4 > 2: 修正前の FAIL の対照を、既存の伏せ字で拾えない値（type=text の欄のコード・身分証の番号）に替えた
- P2 Phase 2 > 1: 登録はフレームの決定と URL の照合のあと、流し込む直前にすると書いた（taint が早く立たないように）
- 見送り（足す修正）: P1 Phase 4 > 1 の検査 3 件（iframe のコードはコピーに回る・iframe の身分証の欄は空のまま・相乗り後も agent の debugger が付いたまま）→ 終了報告へ
