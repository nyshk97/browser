# コマンドバーの Tab 補完と複数語マッチ

## 概要・やりたいこと

⌘T / ⌘L のコマンドバー（候補は `src/main/suggest.ts`、描画は `src/renderer/components/Overlay.tsx` の `CommandBar`）を 2 点直す。

1. **Tab で候補の URL を入力欄に入れる**（Arc の Tab 補完）。
   「amaz」と打って ↓ で `https://www.amazon.co.jp/` の候補に降り、Tab を押すと入力欄がその URL になり、末尾から続きを打てる。
2. **空白区切りの複数語で候補を引ける**ようにする。
   「github nyshk97 mobil」で `https://github.com/nyshk97/mobile-ide` が履歴から出る。今は入力全体を 1 つの部分文字列として title / URL に当てているので構造的に当たらない。

## 前提・わかっていること

### 現状のコード

- 照合は `suggest.ts` の `matches(query, ...fields)` で `fields.some(f => f.toLowerCase().includes(query))`。開いているタブ / ピン留め / Favorites がこれを使う
- 履歴は `src/main/store/history.ts` の `searchHistory` が `url LIKE '%q%' OR title LIKE '%q%'`（全文を 1 パターン）で引く。並びは `visit_count DESC, last_visited_at DESC`
- 履歴 DB には trigram の FTS5 `pages_fts`（url と title の両列、`src/main/store/db.ts` の `setUpFts`）が既にあり、履歴一覧の `queryHistory` は 3 文字以上（`FTS_MIN_LENGTH`）ならこれで引いている。FTS のクエリは `ftsQuery()` が `"…"` で括ってフレーズ 1 つにしている（構文文字を無害化するため）。trigram は既定で大文字小文字を区別しない
- `CommandBar` の `onKeyDown` は ↑↓ / ⌃P ⌃N / Enter / Escape だけ。Tab は未処理でブラウザ既定のフォーカス移動に落ちる。オーバーレイ内に他のフォーカス可能要素は無いので横取りしてよい
- 候補の先頭行（index 0）は常に「そのまま開く / 検索する」（`kind: 'url' | 'search'`、自分の入力そのもの）。↓ で降りた先が tab / pinned / favorite / history
- `Suggestion.subtitle` は search 以外では**遷移先の URL**（tab は `tab.url`）。renderer はこれを Favicon の URL としても使っている

### /dig-lite で決めたこと

- **Tab の挙動**: 選択中の候補行の URL（`subtitle`）を入力欄に入れる。**自分の入力の行（`kind` が `url` / `search`）では何もしない**（↓ で候補を選んでから Tab）。判定は位置（index 0）でなく種別で行う（`normalizeNavigationInput` が弾く入力では自分の入力の行が無く、index 0 が本物の候補になる）。入れた後はキャレットが末尾にあり、候補は新しい入力で再計算される（先頭行が「そのまま開く」になるので Enter でそこへ行ける）。Shift+Tab は値を変えないが既定動作（逆方向のフォーカス移動）だけは止める。IME 変換中（`isComposing`）の Tab は何もしない
- 「開いているタブ」の行で Tab を押しても URL 文字列を入れる（`select-tab` は捨てる）。Tab の目的は URL を編集して別の場所へ行くことで、切り替えたいなら Enter を押す（1回目で決定。根拠: /dig-lite で「Tab で入れる値は候補の `subtitle`、tab は `tab.url`」と決めている）
- Tab は 1 回で確定して終わり。連打で候補を巡回させない（補完後は cursor が先頭に戻り、2 回目の Tab は何もしない）（1回目で決定。根拠: /dig-lite の「選択行の URL だけ入れる」）
- **複数語**: 空白（半角・全角）で切って**全語 AND・順序不問**。各語が title か URL のどこか（小文字化して比較）に含まれれば当たり。開いているタブ / ピン留め / Favorites / 履歴の全部に同じ規則
- **履歴の引き方**: 3 文字以上の語は FTS の暗黙 AND（`"github" "nyshk97" "mobil"`）、2 文字以下の語は同じ SQL に `AND (url LIKE ? OR title LIKE ?)` を足して絞る。FTS が無い環境（`hasFts()` が false）は全語 LIKE の AND。並び順（訪問回数 → 最終訪問）は変えない。**1 語のクエリも FTS 経路に載る**（今まで LIKE だった `searchHistory` に FTS 経路が生えるのはこれが初めて。trigram は 3 文字以上の部分一致・大文字小文字非区別なので LIKE と実質同等。0 件なら LIKE に落ちる）
- 先頭行の「そのまま開く / 検索する」の判定（`normalizeNavigationInput`）は触らない。空白を含む入力は今までどおり検索行になる
- 履歴一覧（⌘Y の `queryHistory`）の複数語対応は**今回のスコープ外**（別件で必要なら同じ `splitTerms` を流用できる）

### 検証の土台

- `scripts/verify-phase1.mjs` に「1-5 コマンドバーの補完」（`window.nemo.suggest()` の結果を見る）と「1-5c 候補の上下移動」（オーバーレイの DOM に `.cmd input` へ値を入れて `KeyboardEvent` を撃ち、`.sug.on` の位置と `defaultPrevented` を見る）がある。Tab と複数語の検査はここに相乗りする
- `suggest.ts` / `history.ts` / `Overlay.tsx` は `OWNERS` 未登録（触るとフルで回る）。**新たに載せない**（CLAUDE.md の禁止事項）
- ユニットテストは `scripts/*.test.mjs`（`node --test`）。語の分割・AND 照合は Node 非依存の純粋関数に切り出してここで固める

## 実装計画

### Phase 1: 複数語マッチ [AI🤖]

- [x] `src/shared/query-terms.js` を新設（Node 非依存）: `splitTerms(query): string[]`（半角・全角空白で分割、空要素を除く、小文字化）と `matchesAllTerms(terms, ...fields): boolean`（各 term がいずれかの field に含まれる、を全 term で AND）
- [x] `scripts/query-terms.test.mjs`: 1 語 / 複数語 / 順序逆 / 全角空白 / 連続空白 / 大文字混在 / 語が別フィールドにまたがる（url に "github"、title に "mobile"）/ 1 語だけ当たらない → false
- [x] `suggest.ts` の `matches` を `splitTerms` + `matchesAllTerms` に置き換える（query が空なら今までどおり候補ゼロ）
- [x] `history.ts` の `searchHistory` を複数語対応にする。**語の分割は `src/shared/query-terms.js` の `splitTerms` を使う**（別実装すると全角空白・小文字化の扱いがタブ / ピン側と食い違い「履歴だけ当たらない」が出る。`tsconfig.node.json` は `src/shared/**` を含むので import できる）:
  - 3 文字以上の語を `ftsQuery` で 1 語ずつ括って空白連結（暗黙 AND）、`hasFts()` かつ 1 語以上あれば FTS の JOIN で引く
  - 2 文字以下の語（と FTS 不可の環境では全語）は `AND (url LIKE ? ESCAPE '\' OR title LIKE ? ESCAPE '\')` を語数ぶん足す。LIKE パターンは**語ごとに** `%_\` をエスケープする（現行の 1 パターンぶんのエスケープをコピーし忘れやすい）
  - 1 語でも FTS に載せる理由（上の前提）を関数コメントに残す
  - 並びは `visit_count DESC, last_visited_at DESC` を維持
  - FTS で 0 件のときの LIKE フォールバック（`queryHistory` と同じ理由）も入れる。**フォールバックも全語 AND の LIKE**で、FTS 不可の環境とまったく同じ SQL 組み立て（語ごとの `AND (url LIKE ? OR title LIKE ?)`）を 1 つの関数に切って両方から呼ぶ（`queryHistory` の全文 1 パターンの形を写さない。追加する検査は肯定側が FTS で当たるのでこの分岐を通らず、壊れていても PASS する）
  - SELECT が 1 本から 2 本（FTS / LIKE）に増えるので、`db.ts` の `faviconColumn` の注記「履歴の SELECT は 5 本」の本数を更新し、FTS 側は `faviconColumn('p')` を使う
- [x] `verify-phase1.mjs` の 1-5 に検査を足す（実装前に FAIL を確認してから直す。ただし `alpha zzz-none` の否定検査は AND の担保用で、修正前も 0 件なので PASS する。FAIL を見るのは残り 3 件）:
  - 検査専用のページ（例: `${PAGES}/index.html?multi=alpha-beta-gamma`）をタブで開き、`recordVisit` は `did-navigate` 契機なので **`waitFor` で `suggest('gamma alpha')` にその URL が出るまで待ってから**閉じる（`createTab` 直後に閉じると行がまだ無く順序依存で落ちる）
  - `suggest('gamma alpha')` に history の候補としてその URL が出る（順序不問）
  - `suggest('alpha zzz-none')` にその URL が出ない（AND）
  - 開いているタブ（`${PAGES}/login.html`）に対して `suggest('login html')` で kind: 'tab' が出る（タブ側も複数語）
  - 2 文字の語を混ぜた `suggest('gamma al')` でも出る（LIKE 併用の経路）

### Phase 2: Tab 補完 [AI🤖]

- [x] `Overlay.tsx` の `CommandBar` の `onKeyDown` に Tab を足す: **先頭条件として IME 変換中（`event.nativeEvent.isComposing`）なら即 return（`preventDefault` もしない）**。それ以外の `event.key === 'Tab'` は Shift の有無によらず `preventDefault()`（フォーカスが入力欄から逃げるのを防ぐ）。Shift 無しで、選択行（`items[cursor]`、undefined あり）の `kind` が `url` / `search` 以外なら `setQuery(selected.subtitle)`
- [x] キャレットは足さずに様子を見る: 直前のコミット c1ef451 で「React が値を書いた時点でキャレットは末尾に戻る」と実測済みなので、まず `setQuery` だけで検査を回し、`selectionStart === value.length` が通ればキャレット用の `useLayoutEffect` は足さない。落ちたときだけ足す
- [x] `verify-phase1.mjs` の 1-5c に検査を足す（実装前に FAIL を確認）:
  - `cursor` ページを 3 件開いた状態で入力欄に `cursor` を入れ、先頭行（search 行）で Tab → 入力値が `cursor` のまま・`defaultPrevented === true`（`document.activeElement` は合成イベントではフォーカス移動が起きず修正前でも PASS するので検査に入れない。実キーでのフォーカス逃げは人間の目視に回す）
  - Shift+Tab → 入力値は変わらず `defaultPrevented === true`
  - ↓ で 1 つ降りて Tab → `waitFor` で入力値が変わるのを待ち、その候補の `subtitle`（`.sug.on .s` のテキスト）と一致・`selectionStart === value.length`
  - Tab の後に候補が再計算され、先頭行が `url` 種別になる。判定は**検索行だけ副題 `.s` を描かない**ことを使い、`.cmd .sug:first-child .s` が存在すること（`GlassIcon` には DOM の目印が無い）

### Phase 3: ドキュメント [AI🤖]

- [x] `DESIGN.md` のコマンドバー節に「Tab は選択中の候補の URL を入力欄に入れる（自分の入力の行＝検索 / URL 行では何もしない。位置でなく種別で判定する理由も添える）」「Shift+Tab は値を変えず既定動作だけ止める」「候補は空白区切りの全語 AND」を追記
- [x] `VERIFY.md` の「補完候補を見る」の例に複数語の例を 1 行足す
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に追加 2 件: Tab 補完・複数語マッチ

### 動作確認 [AI🤖 → 人間👨‍💻]

- [x] [AI🤖] `mise run test`（query-terms のユニットテスト）
- [x] [AI🤖] 往復中は `mise run verify:only phase1 restart`。足した検査は `src` を HEAD に戻して FAIL することを先に確認する。報告には `git show HEAD:scripts/verify-phase1.mjs` と `check('…')` 名を diff して「追加 N 件 / 実行 N 件」（現行 115 件）を書く
- [x] [AI🤖] コミット前に `mise run verify`（フル）を 1 回（既存の FAIL 9 件と揺れ 5 件を HEAD 比較・再実行で切り分け済み）。触る 3 ファイルは `OWNERS` 未登録で `--changed` はフルに倒れる設計であり、`Overlay.tsx` は peek / split / call / shared-tabs など全スイートが描画する
- [ ] [人間👨‍💻] 常用の Nemo で ⌘T →「amaz」→ ↓ → Tab で URL が入って続きを打てること（実キーの Tab / Shift+Tab でフォーカスが入力欄から逃げないこと）、「github nyshk97 mobil」で該当リポジトリが出ることを目視

## ログ
### 試したこと・わかったこと
- 検査の「履歴に載るのを待つ」を `suggest()` の候補で待つと、**開いているタブの候補**で即満たされて did-navigate 前（作成から 4ms 後）に閉じ、履歴に載らなかった。履歴一覧の `queryHistory` で行の存在を待つ形に直した（2026-09-05）
- キャレットは `setQuery` だけで末尾に来た（検査 42 / 42）ので、キャレット用の `useLayoutEffect` は足していない
- フル `mise run verify`（自分の版）は 873 PASS / 14 FAIL。src を HEAD に戻して回したフルでも pins の ⌘⌥↓ 行移動 6 件と live-folder の 3 件は同じ名前で FAIL するので、この 9 件は**今回の変更と無関係な既存の FAIL**（前のスイートが残した一時タブが 2 行の前提を崩す作り。`（前提）… 一時タブは 2 行` が `ephemeral: 4` で落ちている）。残る http-auth 3 件・phase1 2 件（sticky activation・離脱確認）は HEAD の run では通っており、自分の版で `verify:only http-auth phase1` を再実行すると 202 / 202 PASS（5 件とも通る）。フル run のときだけ落ちる揺れで、今回の変更とは無関係
- 修正前の src で phase1 を回すと新規 9 件が FAIL（追加 15 件のうち、否定検査と「値が変わらない」「先頭行から始める」系の 6 件は想定どおり PASS）。修正後は phase1 126 件 + restart 6 件 = 132 / 132 PASS。`check()` の静的な数は 110 → 125（+15）

### 方針変更
（実装中に随時追記）
