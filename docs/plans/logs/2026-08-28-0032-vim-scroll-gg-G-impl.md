review session: 71460a4f-7b3e-4d0e-812b-1492c26a6bb6

## 1回目

````text
## P0
- `src/main/registry.ts:VIM_SCROLL_WORLD_ID`（Phase 2 > ステップ 1） — 隔離ワールド ID に `1730` を採っているが、これは `src/main/call-coordinator.ts:CALL_WORLD_ID` が既に使っている番号（あちらのコメントは「スワイプ判定の 1729 とは別にする」と、番号を機能ごとに割り当てる前提で書いてある）。plan とログの「swipe とは別のワールドを採る／マーカー名を別にするのはワールドを寄せたとき用の保険」という前提が、Meet のタブでだけ崩れる。今日の時点で壊れはしない（両方 IIFE でトップレベル宣言が無く、名前の衝突が無い）が、`gg` のリスナーと Meet のプローブが同じワールドに同居していて、どちらかがグローバルを 1 つ増やした瞬間に**Meet のタブでだけ静かに壊れる**（再現条件が機能横断なので切り分けが最も高くつく形）。`1731` に変えて、`call-coordinator.ts:49` と同じ形の「既に使っている番号」コメントを添える。

## P1
- `scripts/verify-all.mjs:want`（Phase 3 > ステップ 4） — `--changed` が `selection.kind === 'full'` に倒れたときは `only` が空のままなので、`want()` が `OPT_IN_ONLY` を除外して **`vim-scroll` だけ回らない**。`src/main/registry.ts`（`attachVimScroll` の本体）も `test-pages/scroll-*.html` も `OWNERS` 外＝フル行きなので、**この機能の配線とフィクスチャを直したときに限ってスイートが一度も回らない**。plan は「`--only` と `--changed` では従来どおり回る」を条件にしていて、そこが満たせていない。`selection.kind === 'full'` の分岐でも `for (const name of selection.targets) only.add(name)` して `only` を埋めれば、素の `pnpm verify` は既定除外のまま `--changed` 由来のフルだけ全部入りになる（増分は実測 +10s）。
- `src/shared/vim-scroll.js:buildVimScrollInjection`（`isEditable`） — シャドウ DOM の中の入力欄を弾けない。`event.target` も `document.activeElement` も**ホスト要素に retarget される**ので、`<my-search><input></my-search>` 型の検索ボックスに `G` と打つと文字が入ったうえに最下部へ飛ぶ。plan の「入力欄にフォーカスがあるあいだは効かない」が実サイトの一部で成立しない（自走検証の fixture は素の `<input>` なので気づけない）。`document.activeElement` から `shadowRoot.activeElement` を辿り切った要素を `isEditable` に渡す形にする（closed な shadow root は辿れないので、そこは諦めるとコメントに残す）。

## P2
- `src/shared/vim-scroll.js:feedVimKey` — JSDoc の「`createVimScrollState` に渡す `performance.now()` と同じ time origin なので揃う」が実装と食い違う（`createVimScrollState()` は引数を取らず `pendingAt: -Infinity` 固定になった）。`at` を `event.timeStamp` に固定する理由は残したまま、time origin の一文を落とす。
- `src/shared/vim-scroll.js:buildVimScrollInjection`（`keydown` ハンドラ） — `event.repeat` を見ていないので、`g` を押しっぱなしにするとオートリピートの 2 発目が `gg` として発火して最上部へ飛ぶ。誤爆を避ける方針（猶予・修飾キー除外）の延長として `if (event.repeat) return` を足すのが自然。
- `scripts/verify-all.mjs`（既定実行のログ） — `only.size === 0` のときは何も出ないので、素のフルで `vim-scroll` が飛ばされたことが出力に一切現れない。plan Phase 4 の「回らないことを出力で確認する」は「ブロックの見出しが無い」ことでしか見られない。`only` が空のときに `OPT_IN_ONLY` を「既定から外している」と 1 行出すと、逆向き（黙って回り始めて 372s に戻る）にも気づける。
- 作業ツリー全体 — `vim-scroll` の差分に HTTP 認証の続き（`src/main/http-auth*.ts` / `Settings.tsx` / `verify-http-auth.mjs` ほか）と `tsconfig.web.json`・`RESTART_COMPANIONS` の整形だけの変更が混ざっている。このままだと 1 コミットに 2 機能が入るので、コミット時に分けること。

## Q
- `docs/plans/2026-08-27-2138-vim-scroll-gg-G.md:動作確認` — 実機の確認が全項目未着手で、特に **smooth の手触りを `'auto'` に倒すか**が未決。plan の通り倒すと `behavior` だけでなく自走検証の到達 polling・固定待ち・`VERIFY.md` の記述がまとめて変わるので、コミット後に倒すと同じ範囲をもう一度触り直すことになる。
- `docs/plans/2026-08-27-2138-vim-scroll-gg-G.md:ログ > 試したこと・わかったこと`（フル 1 回目の `FAIL あり`） — 出力を保存しておらず、どのスイートが落ちたか切り分けが付いていない（再走 2 回は全 PASS）。既存スイートの flake として飲んで進めるのか、フルをもう一度出力付きで回して特定するのかを決める必要がある。飲む場合、次に同じ形で落ちたときに「vim-scroll の合成キーが原因か」を疑うところからやり直しになる。

````

**対応**: P0 反映。`VIM_SCROLL_WORLD_ID` を 1730 → **1731**。1730 は `call-coordinator.ts:CALL_WORLD_ID` が既に使っていることを実際に確認した（`src/main/call-coordinator.ts:49`）。使用済み番号を挙げるコメントを添えた。

P1 は 2 件とも反映（どちらも書き換え）。① `--changed` が `full` に倒れたとき `only` が空のままで、`want()` が `OPT_IN_ONLY` を外すため **`registry.ts` や fixture を触ったときに限って vim-scroll が回らない**。`full` の分岐で `only` を `KNOWN_TARGETS` 全部で埋めるようにした。② shadow DOM の入力欄が弾けない件は `deepActiveElement()` を足し、`isEditable` とスクロール対象の選択の両方をそれ経由にした（closed な shadow root は辿れない旨をコメントに残した）。

P2 は 3 件反映。JSDoc の time origin の記述が実装（`createVimScrollState()` は引数なし）と食い違っていたので落とした。`event.repeat` の早期 return を足した（押しっぱなしの 2 発目が `gg` として発火する）。素のフルで「既定から外している」を 1 行出すようにした。

作業ツリーに HTTP 認証の続きが混ざっている件は**コミット時に分ける**（今回の差分の問題ではないので実装は触らない）。

Q は 2 件とも保留（人間の判断待ち）。

typecheck / lint / 関連ユニットテスト通過。注入コードの構文も `new Function` で確認した。

## 2回目

````text
再レビュー完了。前回の P0 / P1 / P2 はすべて意図どおり入っている（`1731` が未使用であること、`deepActiveElement` が `isEditable` と `pickTarget` の両方を通っていること、`full` 分岐の `only` 充填が `want()` を素通しにすることを確認した）。以下は今回の修正で新しく見えたものだけ。

## P0

## P1
- `src/shared/vim-scroll.js:buildVimScrollInjection`（`scrollableAncestor`） — `deepActiveElement()` が shadow tree の内側の要素を返すようになったのに、祖先を辿るのは `parentElement` のままなので**shadow 境界で打ち止めになる**。shadow tree の最上位要素は `parentNode` が `ShadowRoot`（Element ではない）で `parentElement` が `null` になるため、ホストより外の内側スクローラへ辿り着かない。フォーカス起点の探索は Gmail / Slack 型の内側スクローラを掴むためのもので、Web Components で組まれたアプリはまさにその対象。壊れはせず「画面中央 → ルート」の候補に落ちるが、plan のケース 4 が示すとおり**中央に無いスクローラはそこで拾えない**ので、shadow DOM のアプリだけ静かに 1 段目が死ぬ。`node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null)` の形で境界を跨ぐ（`deepActiveElement` の逆向きなので、コメントも対にしておくと読み手が追える）。

## P2
- `scripts/verify-all.mjs:want`（`--changed` の `full` 分岐） — `only` を `KNOWN_TARGETS` 全部で埋めた副作用で、絞っていないのに「絞っている」表示になる。冒頭が `（--changed spike … db … 回さない: ）`（`skipped` が空で末尾が尻切れ）、末尾のサマリが `（--changed spike … db だけ）` で「だけ」が全部を指す。動作は正しいので実害は出力の読みにくさだけ。`only` を埋めずに `const changedFull = selection.kind === 'full'` を持ち、`want = (name) => (only.size === 0 ? changedFull || !OPT_IN_ONLY.includes(name) : only.has(name))` にすると、`only.size === 0` を「絞っていない」の意味のまま保てて表示も元に戻る。
- `scripts/lib/verify-targets.mjs:OPT_IN_ONLY` — JSDoc と `VERIFY.md`（「`verify:only vim-scroll` か、`src/shared/vim-scroll.js` などを触った `--changed` のときだけ回る」）が、今回足した「`--changed` がフルに倒れたときも回る」経路を書いていない。`registry.ts` のような `OWNERS` 外のファイルを触るたびに +10s 乗るのはこの記述からは読めず、次にフルの時間を測る人が原因を探すことになる。両方に 1 行足す（`--only` / 担当スイート / **`--changed` のフル**の 3 経路で回る、と書く）。

## Q
- `docs/plans/2026-08-27-2138-vim-scroll-gg-G.md:動作確認` — smooth の手触りを `'auto'` に倒すかが未決のまま。倒すと `behavior`・自走検証の到達 polling・固定待ち・`VERIFY.md` の記述がまとめて変わるので、コミット後の判断だと同じ範囲を触り直しになる。
- `docs/plans/2026-08-27-2138-vim-scroll-gg-G.md:ログ > 試したこと・わかったこと`（フル 1 回目の `FAIL あり`） — 既存スイートの flake として飲むか、出力付きでフルをもう一度回して特定するかが未決。飲む場合、次に同じ形で落ちたときに「vim-scroll の合成キーが原因か」を疑うところからやり直しになる。

````

**対応**: P0 が空なので収束。P1 / P2 は 3 件とも書き換えで済むので反映した。

P1: `scrollableAncestor` の登り方が `parentElement` のままで **shadow 境界で打ち止め**になっていた（`deepActiveElement` で内側へ入れるようにした副作用）。`getRootNode()` が `ShadowRoot` ならその `host` へ跨ぐようにし、`deepActiveElement` の逆向きである旨をコメントに書いた。

P2: ① `--changed` のフル落ちを `only` を埋めて表していたのをやめ、`changedFull` フラグに変えた（絞っていないのに「絞っている」表示になり `回さない: ` が空で尻切れになっていた）。`want()` だけを素通しにする形なので表示は元のまま。② `OPT_IN_ONLY` が回る 3 経路（`--only` / 担当スイートとして `--changed` / `--changed` のフル落ち）を `verify-targets.mjs` の JSDoc と `VERIFY.md` の両方に書いた。

typecheck / lint 通過。注入コードの構文も確認。

### 動作確認（2回目の収束後）

- `pnpm test` 253 件 PASS / `pnpm typecheck` / `pnpm lint` 通過
- `pnpm verify --only vim-scroll` **5/5 PASS**（値は 1 回目の実装時と同じ。round 2 の修正で回帰していない）
- `want()` の 4 分岐をアプリ抜きで確認: 素のフル → vim-scroll:false / `--only` → true /
  `--changed`（担当）→ true / `--changed`（フル落ち）→ true, phase1:true
- 素の `pnpm verify` の先頭に `[verify] 既定から外している: vim-scroll（回すなら --only で名指しする）` が出る
- `--changed` のフル落ちで `（--changed … 回さない: ）` の尻切れ表示が消えた
- **shadow DOM は使い捨てプロファイルの素の Electron で別途確認**（常用インスタンスには触らない）。
  `shadow 境界を跨いで light DOM のスクローラを掴む` は**境界跨ぎを外すと FAIL**
  （`outer 0 → 0 / max 13990`）、入れると PASS（`0 → 13989.5`）で非空を確認した。
  最初に作った fixture（スクローラ自身が shadow tree の中）は**空検査だった**（自身から探索を
  始めるので境界を跨がずに当たる）ため作り直した。
- **`event.repeat` は検証できていない**。Electron の `sendInputEvent` は `isAutoRepeat` を
  `KeyboardEvent.repeat` にマップしない（true/false とも `repeat=false` を実測）。
- 判定: **pass**
