review session: 2adad182-60a3-4cd2-8ab5-61e42a9519b3

## 1回目

````text
静的レビューです（`pnpm typecheck` / `pnpm test` はこの環境で実行を拒否されたため、型・テストの実走は未確認です）。

## P0
- `scripts/verify-pins.mjs:makeFavorites`（plan `Phase 4 > ステップ1`）— 「履歴からの穴埋め」の検査が丸ごと無い（旧フォーマット pins.json fixture ＋ favicon 入り履歴 DB での起動、2 回起動しての冪等）。追加されたのは「定義に写る」「再起動後も残る」までで、`src/main/store/pins.ts:backfillFavicons` と `src/main/store/history.ts:getFaviconsByUrlOrHost` は自走検証にもユニットテストにも一度も掛からない（既存 fixture の定義は起動時点で `faviconUrl` が埋まっているか、履歴に該当行が無いかのどちらかで、`filled > 0` の経路を踏む保証が無い）/ 「既存ブックマークのアイコンが起動直後から出る」が今回の主目的で、その唯一の実装経路が無検査のまま緑になる。起動時 1 回・ウィンドウ復元前という置き場所も壊れても気づけない / plan どおり `--restart` の companion か専用ブロックで、`faviconUrl` 無しの pins.json と `favicon_url` 入りの `pages` を置いて起動し、定義に入ること・2 回目の起動で変わらないこと（`pins.favicons_backfilled` が 2 回目は出ない）を見る

## P1
- `src/main/registry.ts:attachTabEvents` — `attachShortcutHint(win(), wc)` が **タブ生成時のウィンドウを固定**している（`win` は `() => tab.window` なのに 1 回だけ評価している）/ `moveTabToWindow` で別ウィンドウへ移したタブは、そのページにフォーカスがある間 ⌘ 長押しが移送先のサイドバーに届かず、旧ウィンドウが生きていればそちら側にバッジが出る（旧ウィンドウが閉じていれば `send` の `isDestroyed` ガードで黙って何も出ない）。他の購読（`paneFocusOff` 等）は移送時に張り直しているのにここだけ取り残される / `attachShortcutHint(resolveWin: () => NemoWindow, wc)` にして、`before-input-event` / `focus` の中で毎回 `tab.window` を引く
- `src/main/store/history.ts:getFaviconsByUrlOrHost` — host フォールバックが `url LIKE ? ESCAPE '\'` で、SQLite の LIKE 最適化は **ESCAPE 句が付くと無効**（索引前方一致に落ちない）。`pages(url)` は PRIMARY KEY なのに使われず、`pages_last_visited` を新しい順に走査して当たらなければ全表走査になる / 履歴に favicon が無い定義は毎回 null のままなので、**起動のたびに** origin ごとの全表走査が `initSession()` の手前（＝ウィンドウ復元前）で同期に走る。履歴が数万行・未解決の定義が数十件ある常用インスタンスがそのまま該当する / `WHERE url >= ? AND url < ?`（`origin` と終端文字を足した上限）の範囲比較にする。索引が効き、`_` / `%` のエスケープ自体が不要になる
- `src/renderer/styles.css:.label` — `text-transform: uppercase` が残ったままなので、見出しは `MESSAGES` / `TOOLS` / `BOOKMARKS` と大文字で描かれる（`.label` を使うのは今やこの 3 つだけ）/ plan（`Phase 2 > ステップ2`「薄い小文字ラベル」）と、今回自分で書き換えた `DESIGN.md` の「層の見出しは**薄い小文字のラベル**」に反する。`scripts/verify-pins.mjs` のラベル検査は `textContent` を見るので大文字化には反応せず、検査は緑のまま / `.label` から `text-transform` を落とす（大文字が要る見出しは他に無い）
- `scripts/keybindings.test.mjs`（plan `Phase 1 > ステップ8`）— ステップに挙がっているのに追加が無い / `select-favorite-N` という ID 文字列は `keybindings.js` / `menu.ts` / `ipc.ts` / `verify-pins.mjs` の 4 か所で手打ちで揃えているだけで、`SELECT_FAVORITE_ACCELERATORS` の `id` / `index` / `accelerator` の対応を固定するものが 1 つも無い / `id === 'select-favorite-' + index` と 1〜9 の 9 件であること、`COMMANDS` に含まれない（＝ユーザー再割り当て不可）ことを assert する
- `scripts/verify-pins.mjs:makeFavorites`（plan `Phase 4 > ステップ1`）— 「10 個目には効かない」が未検査。作るのが 5 件なので、`Sidebar.tsx:FavoriteGrid` の `MAX_SHORTCUT` による打ち切り（10 個目にバッジを出さない・title に ⌘N を書かない）が一度も評価されない。「対象の無い ⌘9 は何もしない」は別の分岐（`item` が undefined）で、これの代わりにならない / 10 件作って `.fav .kb` が 9 個で止まることを見る

## P2
- `src/main/store/pins.ts:moveFavorite` — `log('favorite.moved', { index: insertAt })` の `index` が**フラット配列の位置**で、引数の `index`（セクション内相対）と別物。ログだけ読むと呼び出しと突き合わせられない。`{ section, at: insertAt }` のように名前を変える
- `src/main/ipc.ts:registerIpcHandlers`（`nemo:move-favorite` / `nemo:add-favorite`）— 省略引数の判定が `!== undefined` のみ。同ファイルの `optionalString` / `optionalTitle` は `null` も「未指定」として受けている。将来 renderer が `null` を渡した瞬間に `invalid index` で落ちるので、ヘルパと同じ規則に寄せる
- `src/main/registry.ts:NemoWindow`（コンストラクタの `attachShortcutHint` ループ）— 対象が `chromeView` / `toolbarView` / `overlayView` とタブだけ。`ensurePeekChrome()` の Peek 用 View・`emptyView`・`splitToolbarView` は遅延生成なので抜けており、そこにフォーカスがある間は ⌘ 長押しでバッジが出ない（解除側の `focus` も張られない）。生成箇所で同じ `attachShortcutHint` を呼ぶだけで揃う
- `src/main/registry.ts:addFavoriteFromTab` — グリッドへのドロップで `addFavoriteDefinition` → `moveFavoriteDefinition` と **commit が 2 回**走り、pins.json を 2 度書いて state も 2 度押し出す。`addFavorite(url, title, customTitle, section)` に畳めば 1 回で済む

## Q

````

**対応**: P0 を反映（`verify-db-migration.mjs` に「faviconUrl 無しの pins.json ＋ favicon 入り履歴 DB で起動 → 完全一致 / 同 host の最近の行で埋まる / `_` の別 host は拾わない / 2 回目の起動で走らない」のブロックを追加。`mise run verify:only db` で 8 件 PASS を確認）。P1: `attachShortcutHint` をウィンドウを毎回引く `resolve` 方式に / host フォールバックを `url >= ? AND url < ?` の範囲比較に（ESCAPE 付き LIKE を廃止）/ `keybindings.test.mjs` に id・index・accelerator の対応と旧 `select-tab-N` の拒否を追加。`.label` の `uppercase` はモック B-4 の見た目（ユーザーが選んだ案）そのものなので残し、plan と DESIGN.md の「小文字」の記述を「CSS で大文字化」に直した。「10 個目には効かない」の検査は追加になるので見送り（終了報告に回す）。P2: `favorite.moved` のログを `at` に改名 / IPC の省略引数を `optionalSection` に寄せて `null` も未指定扱いに。Peek / empty / split-toolbar の View への attach と `addFavorite` の commit 2 回化は追加・リファクタなので見送り。

## 2回目

````text
前回の指摘の対応を確認しました（`shortcut-hint.ts` の `resolve` 化、範囲比較への置き換え、`keybindings.test.mjs`、`verify-db-migration.mjs` の穴埋めブロック、`optionalSection`、`favorite.moved` の `at`、ラベル大文字化の決定と DESIGN.md 反映）。いずれも意図どおり入っています。`db` は `OPT_IN_ONLY` ではなく `verify-all.mjs` に `want('db')` の配線もあるので、追加した 8 件はフル実行にも乗ります。今回も静的レビューです（`pnpm typecheck` / `pnpm test` はこの環境で実行を拒否されました）。

## P0

## P1
- `scripts/verify-db-migration.mjs:（5. 旧データの pins.json を埋めるブロック）`（plan `Phase 4 > ステップ1`）— fixture が経路を弁別しないので、2 つの check が実装を壊しても PASS する。①「完全一致の URL は履歴の favicon で埋まる」: `example.com` の行は `/alpha` 1 本だけなので、`getFaviconsByUrlOrHost` から完全一致引き（`getFavicons`）を丸ごと落としても host フォールバックが同じ `alpha.png` を返して通る。②「`_` の別 host は拾わない」: ワイルドカードが危ないのは**定義側の origin に `_` があるとき**で、いまの定義は `https://example.org/`（`.`）なので、エスケープ無し `LIKE 'https://example.org/%'` でも `https://example_org/x` には当たらない（`.` は LIKE のリテラル）。つまり範囲比較を LIKE に戻しても落ちない / いちばん壊れやすい 2 経路が「速く PASS」側に倒れており、`ESCAPE` を外した実装に戻す変更を止められない / ①は `https://example.com/zzz` を**より新しい** `last_visited_at` と別 favicon で足し、完全一致がその行に勝つことを見る。②は定義側を `https://example_org/` にして `trap.png` が入ることを見る（`https://example.org/beta2` を**より新しく**しておくと、エスケープ無し LIKE なら `new.png` を拾って FAIL する＝弁別できる）
- `docs/plans/2026-08-30-1641-sidebar-favorites-sections.md:Phase 4 > ステップ1` — 「履歴からの穴埋め」の検査は `scripts/verify-pins.mjs` に足すと書いてあるのに、実際は `scripts/verify-db-migration.mjs` に入った。ステップ本文も「ログ / 方針変更」も書き換わっていない / このファイルは `addFavorite(key, section?)` の追加や診断 IPC の新設のような逸脱を全部「方針変更」に残す運用になっており、ここだけ抜けると次に読む人が verify-pins を探して見つけられない（`db` は履歴 DB 用のスイートなので置き場としては妥当）/ ステップを「`verify-db-migration.mjs` に追加（DB fixture を作る仕掛けが既にあるため）」に直し、「方針変更」に 1 行残す
- `VERIFY.md:（履歴 DB の列追加の節）` — 追加した 8 件が VERIFY.md に載っていない。スクリプト冒頭のコメントには「5. 旧データの pins.json が履歴の favicon で埋まる」を足したのに、VERIFY.md 側は 1〜4 のまま（同じ変更で pins / slots の節には新しい check を全部書き足している）/ VERIFY.md が「どのスイートが何を見ているか」の索引なので、載せ忘れると穴埋めの検査が存在しないものとして扱われ、二重に書かれる・消される / 「`faviconUrl` 無しの pins.json ＋ favicon 入り履歴 DB で起動 → 完全一致 / 同 host の最近の行で埋まる / 履歴に無いものは null のまま / 2 回目の起動では走らない（冪等）」を db の節に足す

## P2
- `src/renderer/styles.css:.label` — 直上のコメントが「**薄い小文字のラベル**」のままで、2 行下の `text-transform: uppercase` と真っ向から食い違う（plan と DESIGN.md は「CSS で大文字化」に直した）。あわせて `DESIGN.md` の UI トークン表の「ラベルは 10px・大文字・letter-spacing .09em」も、`.label` が .06em になったことで実装とずれた（.09em のままなのは `.lf-bucket` / `.slot-no`）。コメントを「薄い小さなラベル（`uppercase` で大文字化）」に、表の行を「層の見出しは .06em / Live Folder の小見出しは .09em」に直す

## Q

````

**対応**: P0 なしで収束。P1 3 件を反映（fixture に `example.com/zzz`（より新しい行）と定義側 `https://example_org/` を足して完全一致 / `_` の経路を弁別 / plan の Phase 4 ステップ 1 を「`verify-db-migration.mjs` に追加」に書き換え＋方針変更に 1 行 / VERIFY.md の db 節に 8 件を追記）。P2 も反映（`.label` のコメントと DESIGN.md のトークン表の letter-spacing）。動作確認: `mise run verify:only pins db` → pins 94 件・db 16 件 PASS。
