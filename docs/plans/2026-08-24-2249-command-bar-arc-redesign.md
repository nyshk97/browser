# コマンドバー（⌘T / ⌘L）を Arc の見た目に寄せる

## 概要・やりたいこと

⌘T / ⌘L で開く検索窓を Arc のコマンドバーに近づける。現状は「種別バッジ + タイトル + URL」の
3カラムで、選択行は全幅の半透明ティント。Arc は **各行に favicon が並び、選択行が角丸の
塗りつぶしピルになり、その右端に「Switch to Tab →」のようなアクションが出る**。この3点が
見た目の差の大半を占める。

**候補の並びは変えない。** Arc は文脈次第で過去のタブ・履歴が最上位に来るが、Nemo は
現行どおり「先頭 = 入力内容をそのまま検索 / 開く、その下にタブ・ピン・Favorites・履歴」を
踏襲する（`suggest.ts` の `unshift` はそのまま）。今回変えるのは**見た目と行の情報設計だけ**。

## 前提・わかっていること

### 現状のコード（調査済み）

| 項目 | 現状 |
|---|---|
| コマンドバー本体 | `renderer/components/Overlay.tsx` の `CommandBar`。⌘T（`newTab`）と ⌘L（`address-bar`）で同じコンポーネントを `key` 違いで使う |
| 候補の生成 | `main/suggest.ts`。`LIMIT_PER_KIND = 4`、全体 12 件まで。並びは 検索/開く → タブ → ピン → Favorites → 履歴 |
| 行の構成 | `.sug` の中に `.k`（種別バッジ）/ `.t`（タイトル）/ `.s`（URL）。選択行は `rgba(91,157,255,.16)` のティント、角丸なし・全幅 |
| 下部の hint | `Enter で新規タブ / ⇧Enter で現在のタブ` を常時表示（`.hint`、上に区切り線） |
| favicon | **開いているタブにしか無い**（`registry.ts:481` の `page-favicon-updated` → `tab.faviconUrl`）。履歴・ピン・Favorites には保存されていない |
| `Favicon` コンポーネント | `Sidebar.tsx` にある。`src` があれば `<img>`、無い / 読み込み失敗ならホスト頭文字のレターアバター。`TabRow` / `PinnedTree` / `Library` が既に流用している |
| CSS 変数 | `--nemo-accent: #5b9dff` / `--nemo-radius: 7px` / `--nemo-radius-lg: 11px` |

### 調査で判明した実装上の前提

- **CSP は外部 favicon を既に許可している**。`electron.vite.config.ts` の `img-src 'self' crx: data: https:`。
  したがって favicon は **data URL 化せず URL 文字列のまま保存すればよく**、描画は既存の
  `Favicon` コンポーネントがそのまま使える。DESIGN.md の禁止事項は「第三者の favicon サービス
  （`google.com/s2/favicons` 等）を叩かないこと」であって、サイト自身が申告した favicon URL は
  サイドバーで既に `<img src>` として表示している。今回もその方針に揃える
- **`store/db.ts` にマイグレーション機構が無い**。`CREATE TABLE IF NOT EXISTS` だけで
  `user_version` も使っていない。列追加は `PRAGMA table_info(pages)` で有無を見てから
  `ALTER TABLE` を流す冪等な処理を自前で足す
- **FTS の rebuild は不要**。`pages_fts` は `content='pages'` の external content だが、
  インデックス対象は `url, title` の2列で、トリガも `new.url, new.title` を明示している。
  `favicon_url` を足しても FTS 側の定義は変わらない
- **`pages_fts_update` トリガは `pages` への「あらゆる UPDATE」で発火する**（`db.ts:79`）。
  delete + insert を撃つので、**中身の変わらない UPDATE を投げてはいけない**
- **履歴の SELECT は5本ある**。`searchHistory` に1本、`queryHistory` に3本
  （空クエリ / FTS join / LIKE フォールバック）、加えて FTS join だけ `p.` エイリアスが付く。
  列を足すときは**1箇所にまとめないと必ず漏れる**
- **`searchHistory` / `queryHistory` は例外を握って空配列を返す**。SQL が壊れると
  「履歴候補が出ない」ではなく「履歴機能が黙って死ぬ」形になる
- **favicon の記録は `remember()` の中に置く**（`registry.ts:464`）。シークレットウィンドウでは
  履歴に一切書かない約束なので、外に置くと「閉じたら跡形もなく消える」が破れる
- **`NEMO_USER_DATA_DIR` でデータディレクトリを上書きできる**（`paths.ts:86`）。旧スキーマの
  fixture を置いて起動する検証はこれで組める
- **`mise run verify` は毎回まっさらな userData を作る**（`verify-all.mjs:45` の `mkdtempSync`）。
  つまり**既存 `pages` テーブルへの `ALTER TABLE` 経路を一度も通らない**。マイグレーションは
  別建ての検証が要る
- **既存の履歴は当面アイコンが出ない**（列を足した直後は全行 NULL）。再訪問のたびに自然に埋まる

### `/dig-lite` で決めたこと

- **favicon は履歴 DB に保存する**。`pages` テーブルに `favicon_url` 列を足し、訪問のたびに更新する。
  履歴 DB を **「URL → favicon」の共通ルックアップ**として使い、ピン留め・Favorites の候補行も
  同じ経路でアイコンを引く（定義側に favicon フィールドを増やさない）
- **種別バッジ（`タブ / ピン / お気に入り / 履歴 / 検索 / 開く`）は廃止する**。左端は favicon だけにして、
  **選択行の右端にだけアクション**（`タブへ切り替え` / `検索` / `新規タブで開く` など）を出す
- **選択行の色はモックで見比べてから決める**。既存 `--nemo-accent`（#5b9dff）の塗りつぶしか、
  Arc 寄りの青紫（#5b5bd6 系）を新トークンで足すか

### この計画で採用する設計上の決めごと

#### UI

- **`.hint` は廃止し、右端アクションに情報を集約する**。Arc に下部の説明行は無い。代わりに
  **⇧ を押している間だけ右端アクションの文言を反転**させる（`新規タブで開く` ⇄ `このタブで開く`）。
  常時出る説明文より、いま Enter を押したら何が起きるかが直接読めるほうが強い
- **右端アクションは選択行にだけ出す**。全行に出すと視線が散り、Arc の見た目から離れる

  | 候補の種類 | 右端アクション（⇧なし） | ⇧を押している間 |
  |---|---|---|
  | 開いているタブ（`select-tab`） | `タブへ切り替え` | （変わらない） |
  | 検索（`search`） | ⌘T: `新規タブで検索` / ⌘L: `このタブで検索` | 逆 |
  | URL・ピン・Favorites・履歴（`navigate`） | ⌘T: `新規タブで開く` / ⌘L: `このタブで開く` | 逆 |

  `select-tab` は `run()` の中で `newTab` / Shift を見ずに `selectTab` へ倒しているので、
  文言も反転させない（実挙動と食い違わせない）

#### favicon の解決

- **`Suggestion` に `faviconUrl: string | null` を足す**。renderer 側で URL からアイコンを引く経路を
  作らない（renderer は DB を持たないし、main で決めたものを描くだけにする）
- **解決順は main の `suggest.ts` で1本にまとめる**。呼び出し側（renderer）に分岐を置かない。
  対象は **`kind: 'search'` 以外のすべての候補**（`tab` / `pinned` / `favorite` / `history` / `url`）。
  URL 直打ちの候補（`url`）も対象で、`github.com` と打てば GitHub のアイコンが出る

  1. 開いているタブの候補（`select-tab`） → そのタブの `faviconUrl`
  2. 履歴 DB の `favicon_url`（**URL 完全一致**）
  3. **同じホストで開いているタブの `faviconUrl` を借りる**
  4. 無ければ `null` → `Favicon` コンポーネントがホスト頭文字のレターアバターに落とす

- **ホスト借用は「開いているタブ」からのみで、履歴 DB はホストで引かない**。
  `pages` に host 列も対応する index も無く、`url LIKE 'https://host/%'` は既定の
  case-insensitive LIKE なので PK の index に乗らず**全履歴の走査**になる。入力1文字ごとに
  走らせる場所で払うコストではない。そもそもホスト借用は**列を足した直後の移行期間を
  埋めるためだけ**の措置で、再訪問すれば URL 完全一致で埋まって不要になる。
  常設のコストを払う価値が無い（host 列と index を足す案は、必要になってから別途検討する）
- ホストのマップは **`suggest` の呼び出しごとに `win.tabs` から作って使い捨てる**（キャッシュを持たない）。
  **他のウィンドウのタブは見ない**（シークレットウィンドウの favicon が通常ウィンドウの候補に
  漏れるのを防ぐ）。同じホストのタブが複数あれば、`win.tabs` の先頭にあるものを採る

#### DB

- **列の有無を capability として保持する**（`hasFts()` と同じ形）。`initDb` で
  `PRAGMA table_info(pages)` を見て `ALTER TABLE` を試み、**結果を `faviconColumnAvailable` に持つ**。
  古い SQLite・DB が読み取り専用などで列追加に失敗しても、履歴機能そのものは生かす
- **列式を1箇所に寄せる**。`faviconColumn(alias?: string)` を `db.ts` に置き、
  列がある / 無いで `p.favicon_url` / `NULL AS favicon_url` を返す。**5本の SELECT すべてが
  これを使う**。無条件に `favicon_url` を書くと、列追加に失敗した環境で例外 → `catch` →
  空配列となり、**コマンドバーの履歴候補と履歴一覧がまるごと消える**
- **`recordFavicon` / `getFavicons` は列が無ければ即 return する**（クエリを投げない）
- **`recordFavicon` は UPDATE のみで INSERT しない**。行を作るのは `recordVisit` の責務で、
  favicon だけ先に届いて行が無ければその回は捨てる（次の訪問で入る）。
  favicon 用に空の履歴行を作ると、`about:` や拡張ページを弾いている条件をすり抜ける口ができる
- **favicon が空のときは `recordFavicon` を呼ばない**（= 以前の favicon を維持する）。
  `page-favicon-updated` は読み込みの途中で一時的に空で飛ぶことがあり、そこで消しにいくと
  ちらつきと無駄な UPDATE を生む。「サイトが favicon をやめた」は次に非空が来たときに上書きされる
- **UPDATE の条件は null-safe な `IS NOT` にする**

  ```sql
  UPDATE pages SET favicon_url = ? WHERE url = ? AND favicon_url IS NOT ?
  ```

  SQLite の `IS NOT` は NULL を含めて比較できる。引数は必ず非 NULL なので、
  「今 NULL」「今 別の値」のときだけ UPDATE が走り、**同じ値なら1行も触らない**。
  `(favicon_url IS NULL OR favicon_url <> ?)` だと引数を2回渡すことになるうえ、
  将来 NULL を渡す変更が入ったときに黙って壊れる。ここを緩めると
  `pages_fts_update` トリガが**ページ遷移のたびに空撃ち**される

#### そのほか

- **`HistoryEntry` にも `faviconUrl` を載せる**。`Library.tsx` の履歴一覧が既に `Favicon` を使っており、
  今は `src` を渡していないので全部レターアバターになっている。同じ列を返すだけで実アイコンになる
  （副次的な改善だが、型を分けるほうがコストが高い）
- **検索候補（`kind: 'search'`）だけは favicon ではなく虫眼鏡アイコン**を出す（Arc と同じ）。
  SVG をインラインで描く（DESIGN.md の「アイコンフォント・外部アセットは使わない」に従う）
- **入力欄の左に、選択中の候補の favicon を出す**（Arc の特徴。スクショでも Slack のアイコンが出ている）。
  何も選ばれていない / 候補が無いときは虫眼鏡にフォールバックする

## 実装計画

### Phase 0: 選択色のモックを作る [AI🤖]

- [x] `scratchpad/command-bar-mock.html` に単一 HTML のモックを作る
  - A案（`--nemo-accent` #5b9dff の塗りつぶし）/ B案（Arc 寄りの青紫 #5b5bd6）/ C案（現状の半透明ティント）を縦に並べる
  - ダミー候補は実際に出る組み合わせに寄せる（検索行 / Slack のタブ / 履歴 / ピン / URL 直打ち）
  - 右端アクション・favicon・レターアバター混在・⇧の文言反転まで再現する
  - ↑↓ キーで選択が動くようにして、連続で押したときのちらつき・視認性まで見られるようにする
- [x] `open` で開き、**返答に絶対パスを明記する**

### Phase 0 後の確定 [人間👨‍💻]

- [x] モックを見て A / B / C を選ぶ（角丸・行高・インセット量に注文があればここで出す）

### Phase 1: 履歴 DB に favicon を持たせる [AI🤖]

- [x] `store/db.ts`: 列追加を冪等に行い、**結果を capability として持つ**
  - `initDb` の `exec` 後に `PRAGMA table_info(pages)` を見て、`favicon_url` が無ければ
    `ALTER TABLE pages ADD COLUMN favicon_url TEXT`
  - 成否をモジュール変数に持ち、`hasFaviconColumn()` で公開する（`hasFts()` と同じ形）
  - 失敗しても DB 全体を落とさない（`logError('db.favicon_column_unavailable')` して続行）
  - `log('db.opened', { fts, favicon })` に載せて、起動ログから判別できるようにする
- [x] `store/db.ts`: 列式のヘルパ `faviconColumn(alias?: string)` を足す
  - 列があれば `` `${alias}favicon_url` ``、無ければ `NULL AS favicon_url`
- [x] `store/history.ts`: **5本の SELECT すべて**を `faviconColumn()` 経由にする
  - `searchHistory` の1本
  - `queryHistory` の3本（空クエリ / FTS join（`p.` エイリアス付き）/ LIKE フォールバック）
  - `HistoryRow` に `favicon_url: string | null` を足し、`toEntries` で写す
- [x] `store/history.ts`: `recordFavicon(url, faviconUrl)` を足す
  - `hasFaviconColumn()` が false なら即 return
  - `http(s)` 以外の URL は弾く（`recordVisit` と同じ条件）
  - 引数が空文字 / null なら**呼ばれても何もしない**（呼び出し側でも弾くが、二重に守る）
  - `UPDATE pages SET favicon_url = ? WHERE url = ? AND favicon_url IS NOT ?`
- [x] `store/history.ts`: `getFavicons(urls: string[]): Map<string, string>` を足す
  - `hasFaviconColumn()` が false なら空 Map
  - `WHERE url IN (...)` の一括引き（1件ずつ引かない）。`favicon_url IS NOT NULL` の行だけ返す
  - **ホストで引く API は作らない**（上の決めごとのとおり）
- [x] `shared/types.ts`: `HistoryEntry` に `faviconUrl: string | null` を足す
- [x] `registry.ts`: `page-favicon-updated` を書き換える
  - `const next = favicons[0] ?? null` が**空なら `tab.faviconUrl` を書き換えない**（維持する）
  - 非空のときだけ `tab.faviconUrl = next` と `remember(() => recordFavicon(tab.url, next))`
  - **`remember` の外に出さない**（シークレットで書かない）
- [x] `Library.tsx`: 履歴行の `<Favicon>` に `src={entry.faviconUrl}` を渡す

### Phase 2: suggest に favicon とアクションを載せる [AI🤖]

- [x] `shared/types.ts`: `Suggestion` に `faviconUrl: string | null` を足す
- [x] `main/suggest.ts`: 上の「解決順」を1つのヘルパに実装する
  - `kind: 'search'` 以外の**すべての候補**（`tab` / `pinned` / `favorite` / `history` / `url`）が対象
  - タブ候補は `tab.faviconUrl` をそのまま
  - 残りは、候補の URL をまとめて1回 `getFavicons` に渡す
  - 埋まらなかったものを、**`win.tabs` から作ったホスト → favicon のマップ**で借りる
  - `kind: 'search'` は常に `null`（renderer 側で虫眼鏡を描く）
  - 解決は**候補を組み終わってから最後に1回**回す（`results` を走査して `faviconUrl` を詰める）。
    kind ごとに散らすと `url` 候補の `unshift` で漏れる
- [x] `SuggestionKind` は**変えない**（`search` / `url` の区別は右端アクションの文言に使う）

### Phase 3: コマンドバーの UI を Arc 化する [AI🤖]

- [x] `Overlay.tsx` の `CommandBar`
  - [x] `KIND_LABEL` と `.k` の描画を削除する
  - [x] 各行を `<Favicon url={item.subtitle} title={item.title} src={item.faviconUrl} />` + タイトル + サブタイトル に組み替える
        （`kind: 'search'` の行だけインライン SVG の虫眼鏡）
  - [x] 選択行の右端にアクションラベル + 矢印アイコンを出す（上の表のとおり）
  - [x] ⇧ の押下状態を `keydown` / `keyup` で state に持ち、アクション文言を反転させる
        （オーバーレイが閉じるときに解除する。押しっぱなしのまま Esc で閉じても残らないようにする）
  - [x] 入力欄の左に、選択中候補の favicon（無ければ虫眼鏡）を出す
  - [x] `.hint` の要素を削除する
- [x] `styles.css`
  - [x] `.cmd` の角丸を Arc 寄りに上げる（モックで確定した値）。`--nemo-radius-lg` を変えると
        ダイアログ・パネルにも波及するので、**コマンドバー専用の値にするか全体を上げるかはモックで判断する**
  - [x] `.sugs` に左右 6px のインセットを入れ、`.sug` を角丸 8px・行高 34px にする
  - [x] `.sug.on` を塗りつぶし（Phase 0 で確定した色）+ 文字を白にする
  - [x] `.sug .act`（右端アクション）を足す。選択行以外では出さない
  - [x] `.hint` のルールを削除する
  - [x] 入力欄の `font-size` / `padding` を Arc 寄りに上げる
- [x] `pnpm typecheck` / `pnpm lint` を通す

### Phase 4: マイグレーションの検証を足す [AI🤖]

`mise run verify` は毎回まっさらな userData を作るので、**この計画で最も壊れると痛い経路
（既存 DB への `ALTER TABLE`）を通らない**。専用の検証を建てる。

- [x] `scripts/verify-db-migration.mjs` を新設する
  - [x] fixture を組む: 一時ディレクトリに **旧スキーマの `history.db`** を作る
        （`better-sqlite3` を直接使い、`favicon_url` の**無い** `pages` / `visits` / `archived_tabs` /
        `pages_fts` とトリガを、現行 `db.ts` と同じ DDL で作る）。`pages` に日本語タイトルを含む
        数行と、対応する `visits` を入れて FTS も張っておく
  - [x] `NEMO_USER_DATA_DIR=<fixture>` でアプリを起動し、CDP がつながるまで待って終了させる
  - [x] 起動後の DB を検証する
    - `PRAGMA table_info(pages)` に `favicon_url` が**1つだけ**あること
    - **既存行が保持されている**こと（`url` / `title` / `visit_count` / `last_visited_at` が投入値と一致）
    - `pages_fts` が壊れていないこと（投入した日本語タイトルの部分一致で引けること）
  - [x] **同じ fixture でもう一度起動**し、エラーログが無く列が増えていないこと（冪等性）
  - [x] 起動中に CDP から `window.nemo.suggest('<投入したタイトルの一部>')` を叩き、
        **履歴候補が返る**ことを確認する（capability の分岐が SQL を壊していないことの直接確認）
  - [x] **列追加できない場合の縮退**も見る: fixture の `history.db` を読み取り専用にして起動し、
        アプリが立ち上がり、かつ `window.nemo.suggest` が履歴候補を返すこと
        （= `NULL AS favicon_url` の経路が生きていること）
- [x] `.mise.toml` に `verify:db-migration` タスクを足し、`verify-all.mjs` の並びにも入れる
      （既存の `verify-spike` / `verify-phase1` などと同じ形で呼ぶ）
- [x] `VERIFY.md` にこの手順を追記する

### Phase 5: DESIGN.md を更新する [AI🤖]

- [x] 「コマンドバー」の節を新設し、行の構成・選択ピル・右端アクションの文言表を書く
- [x] 選択色を新トークンにした場合はカラートークンの表に足す
- [x] 「書かないもの」の **「アイコンフォント・外部アセットは使わない」に favicon の扱いを明記する**
      （サイト自身が申告した favicon URL は使う / 第三者の favicon サービスは使わない）。
      書かないと後のレビューで矛盾と見なされる
- [x] 「オーバーレイ」の節で、コマンドバーの hint 行が無くなったことに触れる

### 動作確認 [AI🤖]

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test`
- [x] `mise run verify`（コマンドバーの既存回帰。決定先 ⌘T / ⌘L / ⇧Enter が壊れていないこと）
- [x] `mise run verify:db-migration`（Phase 4 で足したもの）
- [x] `mise run dev` + CDP で確認する
  - [x] 数サイトを訪問 → `sqlite3 <userData>/history.db "SELECT url, favicon_url FROM pages LIMIT 10"` で列が埋まること
  - [x] **同じページを再読み込みしても UPDATE が走らない**こと
        （`IS NOT` の効き。`sqlite3` で `PRAGMA data_version` か、`pages_fts` の行数が増えないことで見る）
  - [x] **シークレットウィンドウで訪問しても `favicon_url` が入らない**こと
  - [x] overlay の target につないで `window.nemo.setOverlay('command-bar')` → 文字を入れて
        スクリーンショットを撮り、Arc のスクショと見比べる
  - [x] 未訪問ホストの候補がレターアバターに落ちること（`<img>` が壊れアイコンにならないこと）

### 実機での確認 [人間👨‍💻]

- [ ] ⌘T / ⌘L を実際に叩いて、Arc からの乗り換えで違和感が無いか見る
- [ ] ⇧ を押したときのアクション文言の反転が分かりやすいか
- [ ] 選択色・角丸・行間の最終確認

## ログ

### 試したこと・わかったこと

- **Phase 0 の結果**: A案（`--nemo-accent` #5b9dff の塗りつぶし）を採用。
  併せて コマンドバーの角丸 14px / 行の角丸 8px / 行高 40px / 左右インセット 6px /
  入力欄 16px に確定した。角丸は**コマンドバー専用**にした（`--nemo-radius-lg` を上げると
  ダイアログ・ダウンロードパネルまで丸くなる）
- `verify-db-migration.mjs` の後片付けで、fixture を消す前に `chmod 0644` を
  **ディレクトリにも当てて実行ビットを落とし**、`rmSync` が ENOTEMPTY で落ちた。
  読み取り専用にしたファイルだけを覚えて戻すようにした
- `.glass`（虫眼鏡）のサイズ指定を最初 `.sug .glass` に閉じてしまい、
  入力欄の左に置いた分にサイズが効かなかった。スコープを外して1つにまとめた
- シークレットの favicon は既存の `verify-phase2.mjs` に足した。
  「タブには出るが履歴には書かれない」を両側から見ている（片方だけだと、
  そもそも favicon が取れていないのか記録を止められているのかが区別できない）

### 方針変更

- **検索候補のタイトルを `“tim” を検索` から入力そのまま（`tim`）に変えた**。
  右端のアクションが `新規タブで検索` と言うので、タイトル側の「検索」は重複になる。
  Phase 0 のモックがこの形で、それを見て確定した
- **検索候補の副題（検索エンジンの URL）を出さないことにした**。
  `https://www.google.com/search?q=...` が行の大半を占めて読めない。Arc も出していない
- **`getFaviconsByHost` を作らないことにした**（レビュー指摘を受けて）。
  `pages` に host 列も index も無く、既定の LIKE は PK の index に乗らないので
  入力1文字ごとに全履歴を走査することになる。ホスト借用は**開いているタブから**だけ行う。
  そもそも列を足した直後の移行期間を埋めるための措置で、再訪問すれば URL 完全一致で埋まる
- **`recordFavicon` は「空なら呼ばない（以前の値を維持）」に倒した**。
  `page-favicon-updated` は読み込み途中に空で飛ぶことがあり、消しにいくとちらつく。
  UPDATE の条件も null-safe な `IS NOT` にして、同じ値なら1行も触らないようにした
  （`pages_fts_update` トリガが `pages` へのあらゆる UPDATE で発火するため）
