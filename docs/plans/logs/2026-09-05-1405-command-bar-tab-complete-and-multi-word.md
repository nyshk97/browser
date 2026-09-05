review session: c4a59865-acb3-41da-93ad-b09698b1b7fb

## 1回目

````text
plan と実コード（`suggest.ts` / `history.ts` / `db.ts` / `Overlay.tsx` / `verify-phase1.mjs` / `verify-targets.mjs` / VERIFY.md）を突き合わせて確認した。前提の記述はほぼ正しい（`matches` の実装、`searchHistory` の LIKE 1 パターン、trigram FTS の有無、`onKeyDown` に Tab が無いこと、`PAGES` が http なので履歴に載ること、phase1 の現行 115 件、`OWNERS` 未登録＝フル落ちも実物どおり）。

## P0
- 動作確認 > 2 — 回すのが `mise run test` と `verify:only phase1` だけ / 触る 3 ファイル（`suggest.ts` `history.ts` `Overlay.tsx`）はいずれも `OWNERS` 未登録で `--changed` はフルに倒れる設計であり、VERIFY.md も「コミット前に 1 回だけ `mise run verify`」を要求している。さらに `verify:only phase1` は `restart` を随伴しないので、`--changed` なら回るはずの再起動系が 1 件も走らない。特に `Overlay.tsx` は peek / split / call / shared-tabs など全スイートが描画するファイルなので phase1 だけでは足りない / 動作確認に「[AI🤖] `mise run verify`（フル）」を足す。往復中は `verify:only phase1 restart`。あわせて VERIFY.md の作法どおり `git show HEAD:scripts/verify-phase1.mjs` と `check('…')` 名を diff して「追加 N 件 / 実行 N 件」を報告項目に書く

## P1
- Phase 1 > 4 — `searchHistory` の語分割に `splitTerms` を使うと明示していない / ここで `/\s+/` などを別実装すると、全角空白・小文字化の扱いがタブ / ピン / Favorites 側（`matchesAllTerms`）と食い違い、「同じ入力なのに履歴だけ当たらない」が出る。`history.ts` は main の TS だが `tsconfig.node.json` が `src/shared/**` を含み `allowJs` / `checkJs` なので import 自体は問題ない / ステップに「`src/shared/query-terms.js` の `splitTerms` を `history.ts` からも使う」と書き、LIKE パターンは語ごとに `%_\` をエスケープする（現行の 1 パターンぶんのエスケープをコピーし忘れやすい）
- Phase 2 > 1 — 「先頭行では何もしない」を `cursor > 0` の位置で判定している / 先頭行が自己入力行なのは `query && decision.allowed` のときだけで、`normalizeNavigationInput` が弾く入力ではその行が `unshift` されず index 0 が本物の候補になる。そのとき Tab が最初の候補にだけ効かない、という説明のつかない穴が残る / 判定を種別に寄せる（`selected && selected.kind !== 'search' && selected.kind !== 'url'`）。`items[cursor]` が undefined のときの optional chaining も入れる
- Phase 2 > 1 — Shift+Tab を「扱わない」としか書いておらず `preventDefault` の有無が決まっていない / 素通しすると Chromium の逆方向フォーカス移動でキャレットが入力欄から抜け、以降の打鍵が候補に入らない（オーバーレイ内に他のフォーカス可能要素が無いぶん、行き先が読めない） / Shift 付きも `preventDefault()` だけはして値は変えない、と明記する
- Phase 2 > 1 — IME 変換中の Tab を除外していない / macOS の日本語 IME は変換中に Tab を候補操作として使い、Chromium は `isComposing: true` の keydown をページに配る。変換中に URL で入力欄が丸ごと置き換わると入力が壊れる（既存の Enter / ↑↓ も同じ穴だが、Tab は踏む頻度が高い） / `event.nativeEvent.isComposing` なら何もしない、を条件に足す
- Phase 2 > 2 — キャレットを末尾へ置く `useLayoutEffect` を無条件に足す前提になっている / 直前のコミット c1ef451 で「React が値を書いた時点でキャレットは末尾に戻る」ことを実測済みで、Tab 補完が欲しいのはまさにその末尾。追加の tick は死にコードになり、Phase 2 > 3 の `selectionStart === value.length` は実装前でも PASS しうる（=「実装前に FAIL」の門をすり抜ける） / まず Tab の `setQuery` だけ入れて検査を回し、末尾に来ていれば tick を足さない。落ちたときだけ足す
- Phase 2 > 3 — `document.activeElement` が入力欄のまま、という検査 / `dispatchEvent` の合成イベントは既定のフォーカス移動を起こさないので、修正前でも必ず PASS する（署名だけ増えて信号は増えない） / この 1 件は落として `defaultPrevented === true` に寄せる。実キーでのフォーカス逃げは人間確認（動作確認 > 3）の項目に回す
- Phase 1 > 5 — 検査ページを「開いて閉じる」だけで履歴に入る前提になっている / `recordVisit` は `did-navigate` 契機なので、`createTab` の解決直後に `closeTab` → `suggest` すると行がまだ無く、順序依存で落ちる / `waitFor` で `suggest('gamma alpha')` にその URL が出るまで待ってから閉じる（このスイートは `sleep(400)` / `waitFor` を使う作法になっている）
- Phase 2 > 3 — 「虫眼鏡でなく favicon」の判定方法が決まっていない / `GlassIcon` に DOM 上の目印が無ければ検査が書けず、実装時に詰まる / 検索行だけ `.s`（副題）を描かないことを使い、`.cmd .sug:first-child .s` の有無で `url` 種別を判定する。Tab 後は `suggest` の往復を挟むので `waitFor` で入力値と候補の再計算を待つ

## P2
- Phase 1 > 2 — ユニットテストの列挙に `matchesAllTerms([], …)` が無い / 現実には `suggest` / `searchHistory` の空クエリガードで届かないが、`every` の空配列は true なので「語 0 個 = 全件一致」が仕様として固定されていないと後で踏む / ケースを 1 件足して意図を固定する
- Phase 1 > 4 — 1 語だけのクエリ（`login` など）もこれまでの LIKE から FTS 経路に移る / trigram は 3 文字以上の部分一致・大文字小文字非区別なので実質同等だが、`searchHistory` に FTS 経路が生えるのは今回が初めてで、既存の 1-5c「縦位置」検査が見る候補件数に効きうる / 「1 語でも FTS に載せる（0 件なら LIKE に落ちる）」と決めた理由を関数コメントに残しておく
- Phase 3 > 2 — `docs/operations.md` にコマンドバーのキー記述は無い（`file:` の遷移許可の文脈で名前が出るだけ） / 「該当箇所があれば」で探し直す手間が出る / 該当なしと書き切って DESIGN.md だけに寄せる

## Q
- /dig-lite で決めたこと > Tab の挙動 — 「開いているタブ」の行で Tab を押したときに、その行が持つ `select-tab` を捨てて URL 文字列にしてよいか。補完後の Enter は `navigate` / `createTab` になるので、⌘T 経由だと既に開いているページをもう 1 枚開くことになる / 決めないと、Arc 的には自然でも「タブへ切り替え」を期待した操作が二重タブを作る挙動になり、後から tab 行だけ除外する差分が要る
- /dig-lite で決めたこと > Tab の挙動 — Tab 連打の意味。補完後は `setCursor(0)` が走って先頭に戻るので、2 回目の Tab は何も起きない（シェルの「次の候補へ回す」にはならない） / 決めないと、実装は「1 回で確定して終わり」に倒れる。連打で候補を巡回させたいなら Tab 後に cursor を保つ設計が要り、Phase 2 の構造ごと変わる

````

**対応**:
- P0 動作確認 > 2: 往復中は `verify:only phase1 restart`、コミット前に `mise run verify`（フル）を追加。件数報告（追加 N 件 / 実行 N 件、現行 115）も明記
- P1 Phase 1 > 4: `splitTerms` を history.ts からも使う・LIKE のエスケープは語ごと・1 語でも FTS に載せる理由をコメントに残す、と書き換え
- P1 Phase 2 > 1: 判定を `cursor > 0` から `kind` が `url` / `search` 以外へ変更。Shift+Tab は preventDefault のみ。`isComposing` 中は何もしない、を追記
- P1 Phase 2 > 2: キャレット用 tick は「まず足さず、検査が落ちたときだけ足す」に書き換え
- P1 Phase 2 > 3: `activeElement` の検査を削除し人間の目視へ。`url` 種別の判定は `.sug:first-child .s` の有無、Tab 後は `waitFor` で待つ、Shift+Tab の検査 1 件を明記
- P1 Phase 1 > 5: 閉じる前に `waitFor` で履歴に載るのを待つ、に修正
- P2 Phase 3 > 2: operations.md のステップを削除（該当箇所なし）
- P2 Phase 1 > 4: 「1 語でも FTS」を前提に明記
- P2 Phase 1 > 2（`matchesAllTerms([])` のケース追加）: 検査項目の追加なのでループ中は見送り、終了報告に回す
- Q「開いているタブ」の行の Tab: URL を入れる（`select-tab` は捨てる）と決定。根拠: /dig-lite で「Tab で入れる値は候補の `subtitle`、tab は `tab.url`」と決めていた。反映先: 前提 > /dig-lite で決めたこと
- Q Tab 連打: 1 回で確定・巡回しない、と決定。根拠: /dig-lite の「選択行の URL だけ入れる」。反映先: 同上

## 2回目

````text
plan の改訂版と実コードを再度突き合わせた。前回の P0（フル verify・件数報告）、Phase 1 > 4 の `splitTerms` 共有、Phase 2 の種別判定 / Shift+Tab / isComposing / キャレット後回し、Phase 2 > 3 の検査差し替え、Phase 1 > 5 の `waitFor` はいずれも反映済み。`waitFor` に Promise 式を渡す形は `connectUi` の `getAppStatus().then(...)` で実績があり、そのまま使える。Tab 後の `.cmd .sug:first-child .s` 判定も、`cursor` ページのタブが開いたままでも先頭は自己入力の `url` 行になるので成立する。

## P0

## P1
- Phase 1 > 4 — 「FTS で 0 件のときの LIKE フォールバック（`queryHistory` と同じ理由）」が理由しか書いておらず、`queryHistory` の**形**（全文 1 パターンの `%text%`）まで写した実装になりうる / そうなると FTS が 0 件を返した経路だけ全語 AND が消え、`hasFts()` が false の環境（読み取り専用 DB など）と同じ入力で結果が食い違う。しかも追加する 4 件の検査は肯定側が FTS でヒットするためこの分岐を一度も通らず、壊れていても PASS する / 「フォールバックも**全語 AND の LIKE**。FTS 不可の環境とまったく同じ SQL 組み立て（語ごとの `AND (url LIKE ? ESCAPE '\' OR title LIKE ? ESCAPE '\')`）を関数に切って両方から呼ぶ」と明記する

## P2
- Phase 3 > 1 — DESIGN.md へ書く文言が「Tab は選択中の候補の URL を入力欄に入れる（**先頭行では何もしない**）」のままで、決定した種別ベースの規則とズレている / 位置ではなく `kind` で判定する、と決めた理由（`normalizeNavigationInput` が弾く入力では自己入力行が出ない）が設計文書に残らない / 「自分の入力の行（検索 / URL 行）では何もしない」に書き換え、Shift+Tab は値を変えず既定動作だけ止めることも 1 行足す
- Phase 2 > 1 — `preventDefault()` と `isComposing` の判定順が文面上あいまい（「Shift の有無によらず preventDefault。IME 変換中は何もしない」の並び） / 素直に読むと preventDefault が先になり、変換中の Tab を IME から奪う / 「`isComposing` なら即 return（preventDefault もしない）」を先頭条件として書く
- Phase 1 > 5 — 「実装前に FAIL を確認してから直す」が 4 件すべてに掛かる書き方だが、`suggest('alpha zzz-none')` の否定検査は修正前も 0 件（LIKE 全文で当たらない）なので必ず PASS する / 実装前 FAIL を全件に期待すると、ここで原因を探して 1 往復無駄になる / 「否定検査は AND の担保用で実装前も PASS。FAIL を見るのは残り 3 件」と注記する
- Phase 1 > 4 — `searchHistory` の SELECT が 1 本から 2 本（FTS / LIKE）に増えるのに、`db.ts` の `faviconColumn` の注記「履歴の SELECT は5本あり（`searchHistory` に1本・`queryHistory` に3本）、うち FTS の JOIN だけ別名が要る」を直す手が入っていない / この注記は「列名を直に書くと必ずどれかが漏れる」という運用の根拠なので、本数が合わないまま腐る / 本数を更新し、FTS 側は `faviconColumn('p')` を使うことをステップに書く

## Q

````

**対応**: P0 なしで収束。以下の P1/P2 を反映した（未レビュー）
- P1 Phase 1 > 4: フォールバックも全語 AND の LIKE で、FTS 不可環境と同じ SQL 組み立てを 1 関数に切って両方から呼ぶ、と明記
- P2 Phase 3 > 1: DESIGN.md の文言を「自分の入力の行（検索 / URL 行）では何もしない」に変え、Shift+Tab の 1 行も足す
- P2 Phase 2 > 1: `isComposing` なら即 return（preventDefault もしない）を先頭条件に
- P2 Phase 1 > 5: 否定検査は修正前も PASS する注記
- P2 Phase 1 > 4: `faviconColumn` の注記の本数更新と FTS 側の `faviconColumn('p')` をステップに追加
