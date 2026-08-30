# サイドバー: Favorites の 2 セクション化・ファビコン保持・⌘数字の付け替え

## 概要・やりたいこと

サイドバー上段の Favorites まわりを、モック（案 B-4）で確定した形に作り替える。

1. **ファビコンが「タブを開くまで頭文字」になる問題を直す**。ピン留め / Favorite は起動時にタブを開かない
   （この挙動は維持）ので、定義そのものに favicon の URL を持たせ、閉じていてもアイコンで見分けられるようにする
2. **Favorites を `Messages` / `Tools` の 2 セクションに分ける**。Arc からの移行分・既存の Favorites・新規追加は
   すべて `Tools` に入れ、`Messages` への振り分けはユーザーが手で行う
3. **並びを Live Folder → Messages → Tools → Bookmarks（ピン留め）→ 一時タブ にする**。
   見出しは薄い小文字ラベル（`messages` / `tools` / `bookmarks`）。tools と bookmarks の間に区切り線は置かず、
   Live Folder の下の線は残す。`bookmarks` ラベルの右端に既存の「＋」を残す
4. **`⌘1〜9` を Messages → Tools のタイル順に付け替える**（一時タブの番号選択は廃止。ユーザー未使用を確認済み）。
   `⌘` を押している間だけタイル右上に番号バッジを出す。すでにそのタブがアクティブなら直前のタブへ戻る

モック: `/private/tmp/claude-501/-Users-d0ne1s-browser/fc92f906-ed29-49a3-b043-01ae81c91a13/scratchpad/sidebar-mock.html`
（セッション限りなので、着手時に消えていれば本ファイルの記述を正とする）

## 前提・わかっていること

### 現状のコード
- favicon は `registry.ts:717` の `page-favicon-updated` で `tab.faviconUrl` に入り、`recordFavicon` で履歴 DB
  `pages.favicon_url` にも書かれている（列が無い環境では黙って無効: `db.ts` の `hasFaviconColumn`）
- ピン（`PinnedTree.tsx:242`）・Favorites（`Sidebar.tsx:325`）は `src={tab?.faviconUrl ?? null}` なので、
  タブが無いと `Favicon` コンポーネント（`Sidebar.tsx:374`）が頭文字にフォールバックする
- セーブスロットは `ipc.ts:726` で `getFavicons(urls)` を引いて `icons` を焼き込んでいる（`MAX_SLOT_ICONS` で打ち切り）。
  `slots-schema.js` は `faviconUrl` を https / data: に限定し、長さ上限あり
- 定義は `src/main/store/pins.ts` の `PinsData { favorites, pinned }`（JsonStore）。型は `src/shared/types.ts` の
  `FavoriteItem` / `PinnedLink` / `PinnedFolder`
- Arc 移行は `src/shared/arc-import.js:179` で `FavoriteItem` を生成し、`favorites` にマージ
- `⌘1〜9` は `src/shared/keybindings.js:114` の `SELECT_TAB_ACCELERATORS`（`select-tab-N`）→ `menu.ts:331`
  `selectTabByIndexIn`（`win.normalTabs` の N 番目、9 は末尾）。メニューには出さずアクセラレータだけ
  （`menu.ts:298`）。`ipc.ts:354` の `nemo:run-command` 経路でも撃てる
- `scripts/verify-split.mjs:1195-1220` が `select-tab-N` でペインのフォーカス移動を検査している。
  `DESIGN.md:160` と `DESIGN.md:395` に ⌘数字の記述がある
- `registry.ts:2179` に `previousActiveKey` があるが `selectTab` 内のローカル変数（保持していない）
- UI の CSP は `img-src 'self' crx: data: https:`（http の favicon は出ない → 定義に入れるときも https / data: に限定）

### 決定事項
- **favicon URL は定義に持つ**（履歴 DB を都度引かない）。理由: 履歴は Mac ごと・`clearHistory` で消える。
  スロットが既に「定義 + icons」で持ち出しているので置き場を定義側に統合する
- 外部の favicon サービス（Google s2 等）は使わない（URL を外に送らない）。画像の data URL キャッシュもしない
  （失敗時は既存の頭文字フォールバックで十分）
- 既存エントリの穴埋めは**起動時に一度**、履歴から `url` 完全一致 → 同 host の最新行 の順で引く
- `Messages` / `Tools` は `FavoriteItem.section: 'messages' | 'tools'`。既定（欠損・Arc 移行・新規追加）は `tools`。
  グリッドへの明示的なドロップだけは落とした側が勝つ
- 定義側の `faviconUrl` の長さ上限はスロットの `MAX_FAVICON_LENGTH`（8KB × 6 件前提）とは別に持つ:
  `data:` は 2KB まで、`https:` はそのまま（pins.json はタイトル更新のたびに全体を書き直すため）。
  `MAX_FAVICON_LENGTH` のコメントに「定義側は別上限」と追記する（2 回目で決定）
- 旧形式スロット（`section` 無し）の判定は**スロット単位**で行う: `readSlot` の raw（正規化前）で favorites のどれかに
  `section` キーがあるかを見てフラグを立て、適用側へ渡す。`SLOTS_VERSION` は上げない（旧版の Mac で `bad_version`
  になる）（2 回目で決定）
- セクション間の移動はタイルのドラッグと、タイルの右クリックメニュー（「Messages へ移動」「Tools へ移動」）
- `⌘N` の番号は Messages の並び → Tools の並び の通し。10 個目以降は番号なし（バッジも出さない）
- 一時タブの `⌘数字` は**廃止**（`select-tab-N` を `select-favorite-N` に置き換える。旧 ID は設定の keybindings に
  残っていても無視する）
- 「同じキーを 2 度押すと直前のタブへ戻る」はウィンドウごとに `previousActiveKey` を保持して実現する。
  直前のタブが閉じられていれば何もしない
- `⌘` 長押しバッジ: サイドバーは別 View なのでページ側にフォーカスがあると keydown が来ない。
  main が各 webContents の `before-input-event` で Meta の down/up を拾ってサイドバーへ通知する。
  **押下から 350ms 経ってから出す**（⌘L / ⌘T / ⌘W のたびに一瞬光らせない）。消す条件は keyUp に加え、
  `browser-window-blur`・webContents のフォーカス移動・表示から 5 秒 の 3 つを安全弁にする
  （keyUp はメニュー展開・拡張ポップアップ・⌘⇥ で取りこぼす）
- 分割ペイン間のキーボード移動は `⌃Tab` / `⌃M`（2 つのタブとして数える。`DESIGN.md:395`）で引き続き可能なので、
  ⌘数字の廃止で専用キーは新設しない（1 回目で決定）
- スロット適用時の `section`: スロット側に `section` があればそれで上書き（スロットはスナップショット）。
  旧形式で `section` が無いエントリは、適用先に同じ `url` の Favorite があればその section を引き継ぎ、
  無ければ `tools`（1 回目で決定。旧スロットの適用で手作業の振り分けが黙って戻らないように）
- `moveFavorite` は `(id, section, index)` の 1 本に統合する。index は**セクション内の相対位置**で、
  main 側でフラット配列の位置に解決する。右クリックの「◯◯ へ移動」は index 省略（末尾）で同じ API を呼ぶ

## 実装計画

### Phase 1: データモデルと favicon の保持 [AI🤖]
- [x] `types.ts`: `FavoriteItem` に `section: 'messages' | 'tools'` と `faviconUrl: string | null`、
      `PinnedLink` に `faviconUrl: string | null` を足す
- [x] 正規化は `settings-schema.js` の `normalizeFavorite`（`section` / `faviconUrl`）と `normalizePinnedList` の
      link 分岐（`faviconUrl`）に足す（`initPins` が `JsonStore(..., PINS_VERSION, normalizePins)` で通しており、
      ここに無いフィールドは次回起動で消える。`normalizeSlot` も `normalizePins` を呼ぶので slots-schema 側には足さない）。
      `normalizeFaviconUrl` は `settings-schema.js` に置き、`slots-schema.js` から import する（逆は循環）。
      定義用の長さ上限は決定事項どおり
- [x] `pins.ts`: `setFaviconForDefinition(id, url)`（ピン留めのフォルダの中まで再帰して探す。`iconCandidates` の
      `walk` と同じ）を追加し、`moveFavorite` を `(id, section, index)` に変える
      （呼び出し側の `ipc.ts` ハンドラの引数検証・`preload/ui.ts` の signature・`window.nemo` の型も一緒に）
- [x] `registry.ts` `page-favicon-updated`: `tab.pinnedId` / `tab.favoriteId` があれば定義側にも書く。
      **必ず `remember(() => ...)` の中で呼ぶ**（シークレットウィンドウで永続の pins.json を書かない。
      直上の `page-title-updated` と同じ不変条件）。値が同じなら commit しない
- [x] `convertPinToFavorite` / `convertFavoriteToPin`: 変換元の `faviconUrl` をそのまま移す（既存を再利用する分岐では
      既存側を優先。名前と同じ規則）。新規 Favorite の `section` は `tools`
- [x] 起動時の穴埋め: `faviconUrl` が null の定義を集め、`history.ts` に `getFaviconsByUrlOrHost(urls)` を足して
      引く（完全一致 → 同 host の `last_visited_at` 降順先頭。LIKE は `ESCAPE` 付きで `_` / `%` を逃がす）。
      `hasFaviconColumn()` が false なら即 return。取得値は https / data: に正規化してから書く。1 回で commit。
      実行位置は**履歴 DB 初期化後・ウィンドウ復元前**
- [x] `arc-import.js`: 生成する `FavoriteItem` に `section: 'tools'`, `faviconUrl: null` を付ける
- [x] スロット: `save-slot` の icons は定義の `faviconUrl` を優先し、履歴引きは無いものだけ補完。
      `slot-apply.js` の差分では `section` を同一判定に使わない（`kind` + `url` が同じなら同一物）。
      適用時の section は決定事項（スロット側優先、無ければ同 url を引き継ぎ、無ければ tools）に従う。
      旧形式フラグは `readSlot` の戻りに載せて適用側へ渡す。**`renameSlot` は raw JSON の `name` だけ差し替えて
      書き戻す**（`normalizeSlot` で作り直すと旧形式スロットに `section: 'tools'` が焼き込まれ、以後「新形式」に見える）。
      `MAX_FAVICON_LENGTH`（8KB）のコメントは「履歴補完で入る分の上限」と用途を書き切る
- [x] ユニットテスト: `scripts/settings-schema.test.mjs` / `keybindings.test.mjs` / `arc-import` / `slots-schema` の
      テストに既定値・正規化・旧形式スロットの判定を足す

### Phase 2: サイドバーの並びと見出し [AI🤖]
- [x] `Sidebar.tsx`: 描画順を Live Folder → `FavoriteGrid section="messages"` → `FavoriteGrid section="tools"`
      → `PinnedTree` に変更。Live Folder が無い（GitHub 未接続）ときは Messages が先頭になる
- [x] 薄いラベル `.label`（10px / `uppercase` で大文字化（モック B-4 と同じ見た目）/ letter-spacing / dim / opacity .7）を messages / tools / bookmarks に。
      bookmarks ラベルの右端に既存の「＋」を移す。tools ↔ bookmarks 間の `.sep` を外し、10px の余白にする。
      `PinIcon` は未使用になるので削除し、`Sidebar.tsx` のコメントと DESIGN.md の該当記述も落とす
- [x] 空のセクションの扱い: `Messages` が 0 件でもラベルと小さな空表示（既存「タブをここへドラッグ」の流用）を出す。
      `Tools` は 0 件ならラベルごと畳む（空になるのは実質初回だけ。上段を空箱 2 つで重くしない）
- [x] タブ → グリッドへのドロップは落とした側の section に入れる。タイル間ドラッグで section をまたげる
      （グリッドはセクション内の相対 index を渡す。`moveFavorite(id, section, index)`）
- [x] タイルの右クリックメニューに「Messages へ移動」「Tools へ移動」（現在の側は無効。index 省略で末尾へ）
- [x] `FavoriteGrid` / `PinnedTree` の `Favicon` に `src={tab?.faviconUrl ?? item.faviconUrl}`
- [x] `DESIGN.md` のサイドバー構成の記述を更新

### Phase 3: ⌘1〜9 の付け替えとバッジ [AI🤖]
- [x] `keybindings.js`: `SELECT_TAB_ACCELERATORS` → `SELECT_FAVORITE_ACCELERATORS`（`select-favorite-N`）。
      従来どおりコマンド表には載せない（ユーザー再割り当て不可。設定に残った `select-tab-N` は既存の
      `unknown_command` 経路で弾かれる）
- [x] `menu.ts`: `selectFavoriteByIndexIn(win, n)`。先頭で `canHostAdditionalTabs(win)` でなければ return
      （Peek / 小窓で `createTab` に入らない）。Messages → Tools の通し順で n 番目の Favorite を
      `openFavorite`（既存のタイルクリックと同じ経路）。すでにその Favorite のタブがアクティブなら
      直前のタブへ `selectTab`。9 の「末尾」特例は廃止（素直に 9 番目）
- [x] `registry.ts`: ウィンドウに「直前のアクティブタブ」を持つ（`createTab` 内のローカル `previousActiveKey` と
      別名にする）。`selectTab` で `key === win.activeTabKey` のときは更新しない。タブの close と
      別ウィンドウへの移送で該当すれば null に
- [x] `ipc.ts:354` の番号経路を新 ID に差し替え。メニューのラベルは「N 番目のお気に入り」
- [x] バッジ: main が各 tab / sidebar / overlay の webContents の `before-input-event` で `Meta` の
      keyDown / keyUp を拾い、決定事項のホールド閾値・解除条件でサイドバーへ表示/非表示を送る
      （main ハンドラ → `preload/ui.ts` の購読ラッパ → `window.nemo` の型 の 3 点を配線する）。
      renderer は `body.meta` を立て、`.fav .kb` を 1〜9 のタイルにだけ描く
- [x] `scripts/verify-split.mjs:1195-1220` の「⌘数字でペイン切替」の検査を削除（`window.nemo.selectTab` 直叩きに
      置き換え、⌘数字の 3 check は落とす）。`DESIGN.md:160` / `:395` の ⌘数字の記述を直す
      （ペイン移動は ⌃Tab / ⌃M が残る旨に書き換える）。`registry.ts:2387` 付近のコメントの「⌘1〜9」も落とす

### Phase 4: 自走検証 [AI🤖]
- [x] `scripts/verify-pins.mjs` に追加:
  - 定義に favicon が保持され、**再起動後にタブを開かなくても** `<img class="fi">` で描画される
    （`restart` の companion で書いて読む。修正前は頭文字 `.fi.letter` になることを先に確認する）
  - 履歴からの穴埋めは **`scripts/verify-db-migration.mjs`（`db` スイート）に追加**（DB fixture を作る仕掛けが既にある）:
    旧フォーマット（`faviconUrl` 無し）の pins.json ＋ favicon 入りの履歴 DB を置いて起動し、完全一致 / 同 host の最近の行で
    埋まること・`_` を含む host を別 host に当てないこと・2 回目の起動で走らないこと（冪等）
  - `section` の既定・移動（メニュー / ドラッグ相当の IPC）・描画順（DOM の上から live-folder → messages → tools → bookmarks）
  - 相対 index の解決: Messages 2 件・Tools 3 件で Tools の 2 番目へ移すと Tools 内で 2 番目になり Messages は動かない。
    Messages → Tools 末尾へ移すと ⌘N の番号が期待どおりずれる
  - `select-favorite-N` で N 番目が開く／2 度押しで直前へ戻る／10 個目には効かない
  - バッジ: ハーネスはキーを撃てない（`VERIFY.md:400`）ので、`NEMO_VERIFY_DIAGNOSTICS` 下の診断 IPC で main の
    Meta down / up の状態機械を直接叩き、「350ms 未満では出ない」「keyUp で消える」「blur で消える」「5 秒で自動解除」を見る
  - シークレットウィンドウで Favorite を開いて favicon が届いても pins.json が変わらない
- [x] `scripts/verify-slots.mjs`: 新フィールド入りのスロットの保存 → 読み込みで `section` / `faviconUrl` が残る。
      旧形式スロット（フィールド無し）を読んで既定値になる。
      適用時の引き継ぎ: 適用先で `messages` にした Favorite と同じ `url` を持つ旧形式スロット（リネーム済みも含む）を
      適用しても `messages` のまま / 新形式スロットなら `section` はスロット側で上書きされる
- [x] `scripts/lib/verify-targets.mjs`: `OWNERS` は `src/shared/slots-schema.js` を `['slots']` → `['slots', 'pins']`
      に広げるだけ。`types.ts` / `pins.ts` / `Sidebar.tsx` / `menu.ts` 等は複数スイートが見るので載せない
      （＝`--changed` はフルに倒す）。`verify-targets.test.mjs` も合わせる。
      **新しい検査は配線を外して検査 0 件になることを見てから戻し、実行件数を報告する**（CLAUDE.md）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に記入（破壊的: ⌘1〜9 の意味が変わる）

### 動作確認 [人間👨‍💻]
- [ ] 常用インスタンスを更新して、既存の Favorites がすべて Tools に入り、favicon が出ていること
- [ ] Messages へ手で振り分け、`⌘1〜` の並びが Messages → Tools になっていること
- [ ] Slack 等を `⌘1` → もう一度 `⌘1` で元の作業タブに戻れること
- [ ] `⌘` を 350ms 以上押すとバッジが出て、`⌘L` 等の一瞬の押下では出ないこと。離す・別アプリへ切り替え・拡張ポップアップへフォーカスが移った後に消えること
- [ ] Arc からの再移行を行う場合、Favorites が Tools に入ること

## ログ
### 試したこと・わかったこと
- 2026-08-30: `settings-schema.js` は `ext-lock.js` 経由で Node API に触るため renderer から import できない。
  セクション定数と並び順の純粋関数は `src/shared/favorites.js` に切り出し、settings-schema から re-export した
  （`tsconfig.web.json` の include に追加）
- 2026-08-30: `page-favicon-updated` で定義に favicon を写すとき、**ページの host が定義の host と違えば書かない**
  ガードを足した（ピン留めのタブで別サイトへ遷移するとブックマークのアイコンが化ける）。タイトルは従来どおり追従

### 方針変更
- 2026-08-30: 履歴からの穴埋めの検査は verify-pins ではなく `verify-db-migration.mjs`（`db`）に置いた（履歴 DB の fixture を作る仕掛けがそこにしか無い。レビュー 2 回目）
- 2026-08-30: ラベルの文字はモック B-4 どおり CSS で大文字化して描く（plan の「小文字ラベル」は HTML 上の表記のこと。レビュー 1 回目の指摘に対する判断）
- 2026-08-30: グリッドへのタブのドロップで section を指定できるよう `addFavorite(key, section?)` に引数を足した
  （plan では `moveFavorite` だけの想定だったが、追加と同時に落とした側へ入れるには追加 API 側に要る）
- 2026-08-30: バッジの検査用に `shortcutHintForVerify('down' | 'up' | 'blur' | 'query')` を診断 IPC として生やした
  （`NEMO_VERIFY_DIAGNOSTICS=1` かつ未パッケージのときだけ）
