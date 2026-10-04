# kyprのクレジットカードを決済フォームに自動入力する

## 概要・やりたいこと

kyprのクレジットカードを、決済フォームのカードの欄に入れられるようにする。今（v1.10.9）はカードの欄にフォーカスしても候補が出ず、⌘⇧Lでも入らない。ポップアップでカード番号をコピーして貼るしかない（有効期限・名義は詳細を開いてコピー）。

不具合ではなく、最初のkypr組み込み（`docs/plans/2026-09-28-2232-kypr-integration.md:33`の「カード・メモはコピー」）で範囲の外にしたまま、その状態が続いている。Stripe・PAY.JPなど**決済代行の別オリジンのiframeの中**にカードの欄があるフォームが多いので、メインフレームの欄だけでなくそこまで届かないと実用にならない（GMO-PGのトークン型・Veritrans等はメインフレームの欄。どちらが多いかはPhase 0で確かめる）。

## 前提・わかっていること

### 今の作り（2026-10-04に調べた）

| 経路 | カードの欄での動き | 場所 |
| --- | --- | --- |
| 欄の下の候補 | 出ない。preloadがログイン欄（`type=password`と、ユーザー名らしい`text`/`email`/`tel`）にしか反応しない | `src/preload/kypr-page.ts`の`loginFieldKind` |
| 候補の中身 | `kyprMatches(url)`（ログインだけ）。0件なら閉じる | `src/main/kypr/inline.ts`の`show` |
| ⌘⇧L・ポップアップの「入力」 | ログインのユーザー名・パスワードだけ。カードの行にはコピーのボタンしか無い | `src/main/kypr/fill.ts`、`src/renderer/components/Kypr.tsx:788` |
| 右クリックの「フォーム自動入力」 | カード番号・期限・CVCは「当てはまる項目なし」にしてわざと入れない | `src/shared/autofill-match.js:141` |

- **Electronのpreloadはiframeに届かない**（`registerPreloadScript`の`type: 'frame'`でも同じ。`src/main/devtools-shim.ts:10`に2026-08-29の実測）。iframeの中の欄へのフォーカスはpreloadでは拾えない
- iframeへの流し込みは`src/main/autofill/frame-runner.ts`の`subFrameRunner`で、CDPで別オリジン（OOPIF）のiframeにもisolated worldを作れる。届くのは**メインフレームの直下のiframeまで**。親ページでiframeが見えているかの確認（`OWNER_REGION`。透明・極小・切り取りを弾く）もある
- **`subFrameRunner`はCDPの`frame.url`と`WebFrameMain.url`の完全一致でframeを探している**（`collectFrameIds`）。CDPの`Frame.url`には`#`以降が入らないので、`#`に設定を載せるStripe Elementsのiframe（`elements-inner-card-….html#…`）では見つからない見込みが高い。今の自走検証のiframeは`?mixed=1`だけで`#`付きを試していない
- **Claudeのウィンドウの伏せ字**（`src/shared/agent-page-source.js`）: `autocomplete`が`cc-number` / `cc-csc` / `cc-exp`の欄は、もう**欄そのもので**伏せている（`SENSITIVE_AUTOCOMPLETE` → `isPasswordish`。`read_page`の`value="[redacted]"`もスクショの塗りも効く）。足りないのは`autocomplete`が無く名前の手がかりしかない欄。値の一致の伏せ字（`rememberSecrets` / `redact`）は**4文字以上の値しか覚えない**ので3桁のCVCは伏せられず、番号も`digitsOf`済みの数字では、ページが`4242 4242 …`と整形したり4つの欄に分けたりしたときに一致しない
- ログインの流し込みのページ側は`src/shared/kypr-page-source.js`（`probe` / `fill` / `fillCode`。`setValue`はネイティブのsetterと`input`/`change`）
- カードの平文は`CardItem`（`cardholderName` / `brand` / `number` / `expMonth` / `expYear` / `code`。`src/vendor/kypr/crypto/item.ts`）。整形は`src/vendor/kypr/client/card.ts`（`digitsOf` / `detectBrand`）。秘密は`number` / `code`（`index.ts`の`SECRET_FIELDS`）
- Claudeのウィンドウでは、iframeの中はスクショの伏せ字が効かない（塗るのはメインフレームの要素だけ）。前例: TOTPはiframeならコピーに回す（`fill.ts`の`agent-iframe`）、フォーム自動入力はiframeの秘密の欄だけ入れない（`src/main/autofill/index.ts:281`）
- 自走検証は`mise run verify:only kypr`（`scripts/verify-kypr.mjs`）。`127.0.0.1`のトップに`localhost`のiframeを埋めて別オリジンを作る型がすでにある（「5. 別オリジンのiframe」）。欄の下の候補の検査は`/login.html?inline=1`の節

### 決めたこと（/dig-lite、2026-10-04）

| 論点 | 決定 |
| --- | --- |
| 範囲 | メインフレームのカードの欄と、**メインフレームの直下のiframe**の中のカードの欄。入れ子のiframeは対象外。**欄ごとにiframeが分かれている型**（Stripeの分割型Card Element・PAY.JP v2など。番号・期限・CVCに直下のiframeが1つずつ）も範囲に入る: 入れる先・判定の単位は「フォーカスのある直下のiframeと、それと同じオリジンの直下の兄弟iframe」の組（どれも`OWNER_REGION`を通ったものだけ）。カードの欄かの判定は「組の中に番号の欄があるか」で行うので、期限・CVCのiframeにフォーカスしても候補が出る。組に入れるとき、組に無い項目（Stripe Elementsでよくある、サイトのページに置いた名義の欄など）がメインフレームのカードの欄にあれば一緒に入れる（2回目で決定） |
| 安全でないページ | **安全なコンテキスト（https、またはloopbackのhttp）のときだけ**候補を出し、入れる。候補・⌘⇧L・ポップアップ・入れる側のすべてで、各フレームの`isSecureContext`（親の状態も含めた判定で、loopbackの扱いもChromeと同じ）を見る（2回目でURLを読む形から変えた。1回目で決定。Chromeの自動入力が安全でないページではカードを入れないのに合わせる。loopbackを許すのはChromeと同じ扱いで、自走検証の模擬サーバー（`127.0.0.1` / `localhost`）もそのまま通る） |
| iframeでの候補の出し方 | メインフレームの側で「フォーカスがiframeに移った」ことを見る。iframeの中のどの欄にいるかは分からないので、**iframe全体の下に**候補を出す。全タブにCDPを常時繋ぐ案は、重さとdebuggerの取り合いの割に得るもの（欄単位の位置）が小さいので見送り |
| 何を見てカードの欄と判断するか | **iframeの中を覗いて判定する**。kyprが解除済みでカードが1件以上あるときだけ、フォーカスのあるiframeとその兄弟の組（上の行）に入り、組の中に番号の欄があるかを見る。決済代行のホスト一覧は持たない（ロック中は覗けないので、ロック中に出すのはメインフレームのカードの欄だけ。下の「ロック中」） |
| 候補に出すカード | **全部**（カードはサイトに紐づかないので照合しない）。最大5行 |
| 入れる項目 | 番号・有効期限・名義・**セキュリティコード（CVC）も入れる** |
| ⌘⇧L | カードの欄にいて、カードが1件ならそのまま入れる。2件以上ならポップアップを開く |
| ポップアップ | カードの欄にいるときは、カードの行にも「このページに入力」のボタンを出す |
| Claudeのウィンドウ | 右クリックのフォーム自動入力と同じ扱い。メインフレームの欄は**欄そのもので伏せる**（`autocomplete`のある欄は今も伏せている。`agent-page-source.js`の`isPasswordish`に番号・CVCの名前の手がかりを足し、`autocomplete`の無い欄もいつでも伏せる。値の一致では3桁のCVCと整形された番号が漏れるため）。`rememberAgentSecrets`で値を覚えさせるのは保険として残す。**iframeの中は番号・CVCを入れない**。期限・名義だけ入れても決済は終わらないので、iframeには何も入れず、候補に「普段のウィンドウで入力してください」の行だけ出す。Claudeが`javascript_tool`を実行したページでは入れない（`agentFillRefusal`。ログインと同じ） |
| 右クリックのフォーム自動入力 | 今のまま（カードの欄には入れない）。カードはkyprの候補・⌘⇧L・ポップアップの経路で入れる |

### 実装で決めること（plan時点の既定）

- **ユーザーの操作によるフォーカスか**: iframeの中の`pointerdown`は親に届かないので、ログイン欄と同じ見分け方（直前のtrustedな`pointerdown`）が使えない。mainの`before-mouse-event`（クリック）・`before-input-event`（Tab）を**起点**にし、少し待ってからメインフレームの`document.activeElement`がiframeかを見る。クリックは、preloadが知らせるメインフレームのtrustedな`pointerdown`が来なかった（= メインフレームの文書に届かず、iframeの中を押した）ときだけ数える（ログ「方針変更」の1件目・3件目）。ページが`iframe.focus()`を呼んだだけでは出さない。Claudeのウィンドウはさらに`agentUserAtWindow`（ウィンドウがkeyのとき）を見る（ログインと同じ）
- **どのiframeか**: ページから来た値は使わない。フォーカスのあるiframeはメインフレームのisolated worldで見る`document.activeElement`。候補の位置は同じworldで見るiframe要素の矩形
- **カードの欄の見分け方**（**メインフレームは、番号の欄と、期限かCVCの欄が同じフォーム（無ければ同じ文書）にそろっているときだけカードの欄にする**。`cardFormComplete`。ギフト・プリペイド・ポイントの手がかりの欄は外す。iframeの組は「組の中に番号の欄があるか」のまま）: `autocomplete`の`cc-number` / `cc-exp` / `cc-exp-month` / `cc-exp-year` / `cc-csc` / `cc-name`（`cc-given-name` / `cc-family-name`）を第一にし、無ければ`name` / `id` / `placeholder` / `aria-label`の手がかり（`cardnumber` `card_number` `cc_num` `cvc` `cvv` `security_code` `exp` `有効期限` `セキュリティコード`など）。番号の欄が無いフォーム（iframeは組の中に無いもの）は対象にしない
- **カードの判定はログインより先に行う**: 日本の決済フォームはCVCが`type=password`のことが多い。カードの欄（上の見分け方に合う欄）はpreloadの`loginFieldKind`と`kypr-page-source.js`の`find()`の対象から外す（外さないと、CVCでログインの候補が出て、⌘⇧LでサイトのパスワードがCVCに入る）
- **番号の形**: 1つの欄、または`maxlength=4`前後の欄が並ぶ分割型（Amexの4-6-5も含む。欄の`maxlength`の並びで割る）
- **有効期限の形**: 1つの欄（`MM / YY`・`MM/YYYY`。`maxlength`と`placeholder`から決める）、月と年が別の欄（`input`か`select`。年は2桁か4桁かを選択肢・`maxlength`から決める）。名義が姓と名に分かれていれば空白で割って入れる（kyprの`cardholderName`は1つの文字列）
- **ページ側と整形の分け方**: `KYPR_PAGE_SOURCE`はビルドを通さない文字列で、Nodeの関数をimportできない。右クリックの自動入力の「collect → `buildFillPlan`」と同じく、ページ側は欄の記述（種類・`maxlength`・`placeholder`・`select`の選択肢）を返すだけ・値を入れるだけにし、番号の割り方・期限の整形・名義の分割は`src/shared`の純粋関数でmainが組み立てる
- **ログに値を出さない**: `log('kypr.fill_card', { ok, fields: [...入れた欄の種類], inSubFrame })`。番号・下4桁・CVCは出さない

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] なし（kypr側の変更は要らない。カードの形式は今のままでよい）

### Phase 0: 実物の決済フォームの作りを確かめる [AI🤖]
- [x] Stripe（Card Element・分割型Card Element・Payment Element）・PAY.JP・Veritrans・SBペイメント・GMO-PGのテスト用の公開デモや決済フォームを、agent-browserで開いて欄の属性（`autocomplete` / `name` / `placeholder` / 番号と期限の形・CVCの`type`）とiframeの入れ子・iframeのURL（`#`の有無）を記録する（**Nemoの常用版・`mcp__nemo`は使わない**。CLAUDE.md「起動中のNemoに触らない」）
- [x] 外から入れた値を受け付けるかを確かめる: iframeの中でネイティブのsetter + `input`/`change`だけで、Stripeが番号・期限・CVCを受け取るか（ブランドのアイコンが変わる・エラーが消える）。足りなければ`keydown` / `beforeinput`も要るかを見る
- [x] 使い捨てのuserDataで立てたdev版で確かめる: ① `#`付きの別オリジンiframeに`subFrameRunner`が付くか ② cross-originのiframeにフォーカスが移ったとき、親のメインフレームで何が起きるか（`window`の`blur`、`document.activeElement`がそのiframe要素になる時機） ③ 人のクリックと、自走検証が使う**CDPの`Input.dispatchMouseEvent`のクリック**のそれぞれで、mainの`input-event`に`mouseDown`が届くか → **OOPIFの中のクリックは`input-event`に届かない**（メインフレームのクリックは届く）。`before-mouse-event`はOOPIFの中のクリックでも飛ぶ（座標はiframeの中の座標。CDPのクリックでも飛ぶ）。人のクリックは動作確認で見る（ログ「方針変更」の3件目）
- [x] 結果をログ「試したこと・わかったこと」に書き、上の「実装で決めること」の既定と食い違えば、先に「前提」の表を書き換える

### Phase 1: カードの欄を見つけて入れる（ページ側とmain） [AI🤖]
- [x] ~~`subFrameRunner`のframeの探し方を、`#`付きのiframeと分割型でも決まるようにする~~ → カード用に、組を1回のCDPの接続で扱う`src/main/kypr/card-frames.ts`を別に作った（メインフレームのiframe要素からCDPの`frameId`を引いて付く）。`subFrameRunner`は変えない（ログ「方針変更」の2件目）
- [x] ページ側: `src/shared/kypr-page-source.js`に`probeCard()`（カードの欄の記述・番号の欄が見えているか・`activeElement`がカードの欄か。ポップアップを開くとページはフォーカスを失うので`document.hasFocus()`は見ない）と、mainが組み立てた手順どおりに値を入れる`fillCard(steps)`を足す。可視判定は今の`isVisible`を使う。カードの欄はログインの`find()`の対象から外す
- [x] 整形の純粋関数（`src/shared`の新しいファイル）: 欄の記述とカードから、欄ごとに入れる値（番号の分割・期限の形・`select`の選択肢の値・名義の分割）を組み立てる
- [x] main: `src/main/kypr/fill.ts`に、入れる先（フォーカスのある直下のiframeとその同じオリジンの兄弟の組 → メインフレームのカードの欄）を決める判定を1つ作り、候補の選択・⌘⇧L・ポップアップの3つの経路で共有する。`fillKyprCard(wc, itemId)`はその判定を使い、**入れる直前に**組の各フレームで同じrunnerを使って`probeCard()` → 組全体の記述（フレームの識別子付き）から整形の関数で手順を作る → 各フレームで`fillCard(steps)`、の順に入れる（候補を出したときの記述は使わない。選ぶまでにDOMが変わると別の欄に入るため）。iframeは`subFrameRunner`（`OWNER_REGION`で見えていないiframeは弾かれる）。値は`index.ts`に`kyprCardForFill(id)`を足して取る。安全なコンテキストでないフレームには入れない
- [x] Claudeのウィンドウ: `agent-page-source.js`でカードの番号・CVCの欄を欄そのもので伏せる（決定表）。メインフレームなら入れる直前に`rememberAgentSecrets`（保険）。iframeなら入れずに`agent-iframe`を返す
- [x] ユニットテスト: 整形の純粋関数（`MM / YY`・`MM/YYYY`・月と年の`select`（`1`〜`12`・`01`〜`12`、`27`・`2027`）・番号の4分割とAmexの4-6-5・名義の分割）を`scripts/`の既存の`*.test.mjs`に合わせて書く

### Phase 2: 欄の下の候補を出す [AI🤖]
- [x] preload（`src/preload/kypr-page.ts`）: カードの判定をログインより先に行い、メインフレームのカードの欄へのユーザーの操作によるフォーカスで`{ type: 'focus', kind: 'card', rect }`を送る。~~iframeへフォーカスが移ったら`{ type: 'frame-focus', rect }`を送る~~ → 送らない（iframeからiframeへの移りは親に何も届かないので、mainの`input-event`を起点にした。ログ「方針変更」の1件目）。iframeにフォーカスがある間のスクロールでは閉じるよう`hide`を送る
- [x] main（`src/main/kypr/inline.ts`）: タブの`before-mouse-event`（クリック）・`before-input-event`（Tab）を受けたら、少し待ってメインフレームでフォーカスのあるiframeを見て（クリックはメインフレームの文書に届かなかったときだけ）、kyprが解除済みでカードが1件以上あれば組を`probeCard()`し、組に番号の欄があればフォーカスのあるiframeの下に候補を出す（同じiframeの結果は覚えておく）
- [x] iframeの候補を閉じる条件: mainの`before-input-event`（Esc）・`before-mouse-event`（メインフレームを押した）、スクロール（preloadの`hide`）、タブの切り替え・ページの遷移（出している間だけ回す見張り）で閉じる
- [x] 候補の状態（`KyprInlineState`）に種類（ログインかカードか）と、Claudeのウィンドウのiframeのときの案内の行を足す。`kyprInlinePick`は種類で`fillKyprLogin` / `fillKyprCard`に振り分ける。選ぶ直前にタブ・URL・フォーカスのフレームが出したときと同じかを確かめる（今の`kyprInlineTarget`と同じ考え）
- [x] ロック中: メインフレームのカードの欄では「解除」の1行を出す（ログインと同じ）。iframeは中を覗けないので出さない（⌘⇧Lで解除して入れる経路は残る）
- [x] renderer（`Kypr.tsx`の`KyprInline`）: カードの行（名前・ブランド・`•••• 1234`。`summaryOf`の`subtitle`をそのまま使う）と案内の行を描く

### Phase 3: ⌘⇧Lとポップアップ [AI🤖]
- [x] ⌘⇧L（`quickFillKypr`）: **ログインより先に**Phase 1の入れる先の判定を見て、カードの欄にいれば、カードが1件なら`fillKyprCard`、2件以上・0件ならポップアップを開く。ロック中は今と同じく解除してから
- [x] ポップアップ: 同じ判定でカードの欄にいるときは、カードの行に「このページに入力」（↵）を出す。ログインの「このページ」の段と混ぜない

### Phase 4: 自走検証とドキュメント [AI🤖]
- [x] `scripts/verify-kypr.mjs`にカードの節を足す（模擬サーバーにカードを2件置く）: ① メインフレームのカードのフォーム（`autocomplete`あり、月と年が別の`select`）で候補が出て、選ぶと4項目が入る ② `localhost`の別オリジンのiframe（`src`に`#…`を付ける。Stripeを真似た1つの欄の`MM / YY`の型と、番号・期限・CVCを別々の兄弟iframeに分けた型）で、クリックでフォーカスすると候補がiframeの下に出て、選ぶとiframeの中に入る ③ ページが`iframe.focus()`を呼んだだけでは出ない ④ 透明なiframe（`opacity: 0`）には入らない ⑤ ⌘⇧Lで、1件なら入り、2件ならポップアップが開く ⑥ ログに番号・CVCが出ない（`kypr.fill_card`の`detail`に数字の並びが無い）
- [x] Claudeのウィンドウの検査（`mise run verify:only agent`の`scripts/verify-agent.mjs`）: **`autocomplete`が無く`name`の手がかりだけで、CVCが3桁のフォーム**で（`autocomplete`付きは今のコードでも伏せられるので、変更が無くても通ってしまう）、メインフレームのカードの欄には入り、`read_page` / スクショで番号・CVC（3桁を含む）が伏せられる。iframeには入らず案内の行が出る
- [x] 足した検査が実際に走ったことを件数で示す。`OWNERS`（`scripts/lib/verify-targets.mjs`）の既存エントリを広げる: `src/shared/kypr-page-source.js`（今`['kypr']`）と`src/preload/kypr-page.ts`（今`['kypr', 'phase1']`）に`agent`を足す。`src/shared/agent-page-source.js`（今`['agent']`）は`agent`のままでよい。`src/renderer/components/Kypr.tsx`は`verify-agent.mjs`が案内の行の描画まで見るときだけ`agent`を足す。新規ファイルは登録する
- [x] VERIFY.mdの「kypr」の節に、カードの自走検証の範囲と件数・人が見ること（下の動作確認）を足す
- [x] `docs/CHANGELOG.md`の`[Unreleased]`に書く

### 動作確認 [人間👨‍💻]
- [ ] 常用版のNemoの普段のウィンドウで、Stripeのテスト用の決済フォームのカードの欄をクリックし、候補からkyprのカードを選んで番号・期限・CVCが入ること（テスト用のカードで。送信はしない）
- [ ] 日本のECの決済画面（GMO-PG等のiframeか、メインフレームのフォーム）で同じこと。月と年が別の`select`のフォームで期限が正しく選ばれること
- [ ] 1枚の画面（MacBook Pro内蔵）と2枚の画面のどちらでも、候補がiframe・欄の下に出て画面からはみ出さないこと

## ログ
### 試したこと・わかったこと
- 2026-10-04 Phase 0（agent-browserのChromeに、Stripe.jsの公開のテスト用キーでCard Elementと分割型を置いた手元のページ）:
  - Card Elementは1つのiframe（`js.stripe.com/v3/elements-inner-card-….html#__shared_params__…`）に番号（`name=cardnumber` `autocomplete=cc-number`）・期限（`exp-date` `cc-exp` placeholder「月 / 年」）・CVC（`cvc` `cc-csc`）が並ぶ。分割型は欄ごとに同じURLのiframe。どちらにも2×2pxの隠れた欄（`cc-exp-month`等。ブラウザの自動入力の受け口）があり、`isVisible`で外れる
  - CDPの`Frame.url`には`#`以降が入らない（`subFrameRunner`のURLの一致では見つからない）。OOPIFの`targetId`は`frameId`と同じ
  - iframeの中でネイティブのsetter + `input`/`change`だけで、Stripeは番号・期限（`12/34`を`12 / 34`に整える）・CVCを受け取った（`change`が`complete: true`・`brand: visa`。Card Elementも分割型も）
  - 親のメインフレームでは、メインフレームからiframeへ移ったときだけ`window`の`blur`が出て（その時点で`activeElement`はiframe。`focusin`は出ない）、**iframeからiframeへ移ったときは何も出ない**（`activeElement`だけ変わる）
  - PAY.JP・Veritrans・SBペイメント・GMO-PGの実物は見ていない（公開のデモを探すより、自走検証の模擬ページで型を押さえた。人の動作確認で日本のECを見る）
- 2026-10-04 自走検証: `verify:only kypr agent phase1 autofill`で kypr 170件・agent 96件・autofill 149件がPASS。カードの節は6回目の起動の15件と、agentの2件。agentの伏せ字の検査は、`agent-page-source.js`だけHEADに戻すと3桁のCVCが`read_page`に`value="737"`と出てFAILする（変更前のFAILを確認）。phase1の画面共有・ディスプレイ選択の5件は、Studio Displayがつながっていて実ディスプレイが2枚のためにFAIL（「1枚のとき」の前提の検査。カードとは無関係）
- 2026-10-04 実装のレビュー（2回で収束）の修正の後に、自走検証をやり直した: kypr 170件・agent 96件・autofill 149件がPASS、ユニットテスト580件がPASS。phase1は同じ環境依存の5件だけFAIL
- Claudeのウィンドウのiframeで出す案内の行（`Kypr.tsx`の`kypr-inline-note`）の描画は自走検証で見ていない（Claudeのウィンドウで人がiframeを押す経路を撃てない）

### 方針変更
- 2026-10-04 実装のレビュー（`/polish-impl`）で、名前の手がかりが広すぎると分かった（「利用者カード番号」とパスワードのログイン・「予約確認番号」・口座の「名義」）。メインフレームでは、番号の欄と、期限かCVCの欄が同じフォーム（無ければ同じ文書）にそろっているときだけカードの欄にする（`cardFormComplete`）。preloadの欄の判定・ログインの`find()`・`probeCard`（フォーカスのある欄のフォームの中で数える）・⌘⇧L・ポップアップで同じ範囲にした。そろっていない欄はログインの判定に回る。iframeの組は決定表どおり「組の中に番号の欄があるか」のまま（期限・CVCがサイトのページ側にある型があり、別オリジンの決済代行のiframeでは誤判定の心配が小さい）。`確認番号`と単独の`名義`を手がかりから外し、ギフト・プリペイド・ポイントの手がかりの欄は外した
- 2026-10-04 iframeへのフォーカスはpreloadの`frame-focus`ではなく、mainの`input-event`を起点に拾う。Phase 0で、iframeからiframeへの移りは親に何も届かないと分かったため（分割型で期限の欄からCVCの欄へ移ったときに拾えない）。`input-event`は合成のクリックでも飛ぶ（`registry.ts`の`syncPaneFocusWatchers`のコメント）ので自走検証から撃てる。全タブに付けるが、クリック・Tab・Esc以外はすぐ返す
- 2026-10-04 `subFrameRunner`は変えず、カード用に`card-frames.ts`を作った。組を1回のattachで扱う（兄弟のiframeごとにattachと150msの待ちが重なるのを避ける。レビューで見送った指摘）ためと、右クリックの自動入力・ログインの入力の経路を巻き込まないため。`#`付きのiframeのログインの入力が`subFrameRunner`で見つからない件は今回の範囲に入れない
- 2026-10-04 iframeの中のクリックの起点を`input-event`から`before-mouse-event`に変えた。OOPIFの中のクリックは`input-event`に届かないと自走検証で分かったため（`before-mouse-event`は届く）。座標はiframeの中の座標で来てメインフレームの`elementFromPoint`に使えないので、「iframeの上を押したか」は**preloadが知らせるメインフレームのtrustedな`pointerdown`（`pointer`）が来なかった = メインフレームの文書に届かなかった**で見分ける。Tab・Escは`before-input-event`（iframeの中のキーも届く）
- 2026-10-04 候補から選ぶと候補のViewが閉じてページへフォーカスが戻り、直前のクリックの`pointerdown`がまだ新しいので同じ候補がまた出ていた（カードの自走検証で見えた。ログインの候補も同じ）。選んでから1.5秒は、押し直していなければ（`pointer`が来ていなければ）出し直さない
