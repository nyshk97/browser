# ⌘⌥↑ / ⌘⌥↓ でサイドバーの行を縦に渡り歩く（Arc の Go to Next / Previous Tab）

## 概要・やりたいこと

Arc と同じく **⌘⌥↓ / ⌘⌥↑ でサイドバーの見た目の並びどおりに 1 行ずつ選択を移す**。
既存の ⌃Tab（`next-tab`）はタブの内部配列（`win.normalTabs`）の順で、Favorites・ピン留め・Live Folder を
横断しないし、閉じたフォルダの中身をスキップする概念も無い。

- 野良タブ（一時タブ）・ピン留め・Favorites・Live Folder を横断して移動できる
- ピン留めのフォルダが閉じているときはフォルダごとスキップ、開いているときは中の行も対象
- Live Folder（GitHub PR）の小見出しも同様（開いている小見出しの行だけ対象）
- 一番下（野良タブの一番下）で ⌘⌥↓ → 一番上へ。一番上で ⌘⌥↑ → 一番下へ（両方向に循環）

## 前提・わかっていること

### コード調査で確認済みの事実

- **サイドバーの縦順**（`src/renderer/components/Sidebar.tsx` の `.scroll` 内・DESIGN.md「3層の並び」）:
  1. Live Folder（最上段。`LiveFolder.tsx`。小見出し `review` → `mine`。**小見出しの開閉は renderer の
     `useState` で、起動時は両方畳み・永続化しない**。畳んでいる間は行を描画しない）
  2. Favorites グリッド（`FavoriteSections` → `FavoriteGrid`。`tools` → `messages` の順、5 列のアイコングリッド。
     DOM は `.fav[data-id]`）
  3. ピン留め（`PinnedTree.tsx`。フォルダは 1 階層、`node.collapsed` は main の `pins.json` に永続化。
     閉じたフォルダは `children` を描画しない。DOM は `.row.pin[data-pin]`）
  4. 「New Tab」行（タブではない）→ 一時タブ（`ephemeralRows`: `TabRow` / 分割は左タブの位置に `SplitRow` 1 つ /
     このウィンドウに実体が無い共有定義は `EphemeralDefRow`。DOM は `.row[data-key]` / `.row.remote[data-def-id]`）
- **Live Folder に載っている URL の一時タブは `ephemeralRows` から除外される**（二重に並ばない）。ただし分割に
  入っている実体は結合行を優先して残す。よって Live Folder 由来のタブは「小見出しを畳むと行が無い」状態になりうる
- **見た目の順を知っているのは renderer だけ**（Live Folder の開閉 state・グリッド順・結合行）。main の `next-tab` の
  ように `win.normalTabs` で解くと見た目とズレる。既存の `copy-url` が「main は accelerator を受けて
  `sendToUi` → 対象は Sidebar が決める」の前例（`copy-url` は `UI_COMMANDS` には入っておらず、`runCommand` の switch で
  `foreground` の存在を見てから `sendToUi` している。今回は main 側のチェックが要らないので `UI_COMMANDS` に入れる）
- **Live Folder の行が描画されるのは `liveFolderView(state).kind === 'list'` のときだけ**。`failure.kind === 'auth'` は
  `items` より先に見るので、キャッシュが残ったままトークンが切れると `reconnect`（行 0 本）なのに `state.items` は非空。
  `items` だけを見て並びを作ると見えない行へ飛ぶ
- Live Folder の行 `PrRow` は `<button className="row lf-row">` で、URL を引ける `data-*` 属性が無い（他の行は
  `data-key` / `data-pin` / `data-id` / `data-def-id` を持つ）
- Favorites のセクション順は `FAVORITE_SECTIONS`（`src/shared/favorites.js`）が唯一の定義
- **選択・開く API はすべて invoke の往復 + `pushState` 経由**なので、押した直後の `state` は 1 手前のまま。連打・キーリピートで
  同じ `state` から解くと同じ行へ再実行して進まない
- キーバインドは `src/shared/keybindings.js` の `COMMANDS` が唯一の定義（メニュー登録・`settings.json` の上書き検証・
  `runCommandForVerify` の許可リストが全部ここから出る）。`isValidAccelerator` は `Up` / `Down` を通す
- `runCommandForWindow`（`menu.ts:94`）は `MINI_BLOCKED_COMMANDS` で小窓を弾き、`UI_COMMANDS` にあるものは
  `sendToUi` で renderer へ送る。`nemo:run-command-for-verify`（`ipc.ts:411`）は `COMMANDS` に載っている ID だけ
  この関数に通すので、**表に足せば自走検証からそのまま撃てる**
- アクティブは `WindowState.activeTabKey` の 1 つだけ。分割の右ペインにフォーカスがあるときも `activeTabKey` は右タブの key
  （`SplitRow` は `focusedKey` で描き分け、クリックは `window.nemo.selectTab(tab.key)`）
- 行を開く renderer API: `openFavorite(id)` / `openPinned(id)` / `openEphemeral(defId)` / `selectTab(key)` /
  `liveFolderOpen(url)`（main 側で URL 一致のタブがあれば選択、無ければ `createTab`。一覧に無い URL は弾く）。
  いずれも既に開いていれば選ぶだけで冪等
- 行の「開いている」判定: 一時タブ `tab.key === activeTabKey`、ピン `tab.pinnedId`、Favorite `tab.favoriteId`、
  Live Folder は `normalizePrUrl(tab.url)` の一致（`openLiveUrls`）
- Peek はサイドバーに行が無い（`peekParentKey !== null` を除外）。`next-tab` も Peek を行き先にしない。
  **Peek が前面でも `activeTabKey` は親タブ**（`selectTab` が Peek を親に倒す）なので、現在位置は必ず親の行で解ける
- `tsconfig.web.json` の `include` は列挙式。renderer から shared を import するなら Node 非依存のファイルを
  ここに足す（`favorites.js` が例）。ユニットテストは `scripts/*.test.mjs`（`node --test`）から直接 import できる
- `OWNERS`（`scripts/lib/verify-targets.mjs`）: `Sidebar.tsx` / `LiveFolder.tsx` / `keybindings.js` / `menu.ts` は未登録
  （`kind: 'full'` に倒れる安全側）。**新たに載せない**。`SplitRow.tsx` は `['split']` で登録済みだが今回は触らない
- `scripts/verify-live-folder.mjs` は小見出しの開閉を `.lf-sub[aria-expanded]` の `click()` で操作する
  `expandAll` / `collapseAll` を持つ（開閉が React state なので「読むたびに開き直す」作り）
- `closeTab` は `ephemeralId` を持つタブでは `removeEphemeralEverywhere` に委譲して**共有定義ごと全ウィンドウから消す**。
  「定義はあるがこのウィンドウに実体が無い」行（`EphemeralDefRow`）は、**別ウィンドウで作ったタブ**でしか生まれない
- DESIGN.md の分割「ほかの決めごと」に「⌃Tab / ⌃M は 2 つのタブのまま数える」の記述がある。VERIFY.md の split 節に
  「キー操作は撃てない」の注意がある

### 決定事項（/dig-lite で確定）

| 論点 | 決定 |
| --- | --- |
| キー | ⌘⌥↓ = 下の行へ / ⌘⌥↑ = 上の行へ。`COMMANDS` に `CmdOrCtrl+Alt+Down` / `CmdOrCtrl+Alt+Up` で登録（設定で上書き可） |
| 行の並び | Live Folder（開いている小見出しの行）→ Favorites（tools → messages、グリッドは左→右・上→下の読み順で 1 セル 1 行）→ ピン留め（閉じたフォルダは中身ごとスキップ。フォルダ行自体は対象外）→ 一時タブ |
| 対象外 | 「New Tab」行・フォルダ行・Live Folder の小見出し・Peek |
| 閉じた定義の行 | **その場で開く**（クリックと同じ。通り過ぎるだけでもタブが実体化する。Arc と同じ） |
| 循環 | **両方向**。最下段で ↓ → 最上段、最上段で ↑ → 最下段 |
| 分割ペア | **左 → 右の 2 ステップ**。上から入ると左、もう一度 ↓ で右、さらに ↓ で次の行。下から入ると右。同じキーでペイン間の移動もできる |
| 現在位置が行に無いとき | （Live Folder 由来のタブで小見出しが畳まれているとき。Peek 前面は親タブの行があるので該当しない）↓ は先頭行、↑ は末尾行へ |
| 連打・キーリピート | renderer が「最後に確定してから自分が指した行のトレイル（配列）」を持つ。届いた `activeTabKey` がトレイルのどれかに一致する限り反映待ちとみなし、トレイル末尾から進める。一致しない行が active になったら（行クリック・⌃Tab 等の別経路）トレイルを捨てて `state` から解き直す |
| 一時タブ行の同一性 | 行は `key`（実体があれば）と `defId`（共有定義があれば）を両方持ち、**どちらか一致で同一行**。閉じた定義の行を通過して実体化した瞬間に行の形が変わっても（`def` → `tab`・ローカル行が定義を得る）トレイルが追随する |
| 押しっぱなしで閉じた定義を通過 | 間引かない（Arc と同じ。閉じたピンを押し切れば枚数分の実タブが立つ。「その場で開く」の決定と一貫させる。1 回目のレビューで決定） |
| サイドバー非表示（⌘S）中 | 効かせる（⌃Tab と同じく見えなくても選択は意味を持つ。renderer は生きているのでコマンドは届く。1 回目のレビューで決定） |
| Peek が出ている間の移動 | Peek は親タブに付いたまま裏に回る（⌃Tab と同じ。特別扱いしない） |
| 実装の置き場 | main は accelerator を受けて `sendToUi` するだけ。**行リストの構築と行き先の決定は renderer（Sidebar）**。並びの計算は Node 非依存の純粋関数 `src/shared/sidebar-rows.js` に切り出してユニットテストする |
| Live Folder の開閉 state | `LiveFolder.tsx` の `collapsed` を **Sidebar へ持ち上げる**（props で渡す）。永続化しない・起動時は両方畳む規則は変えない |
| 小窓 | `MINI_BLOCKED_COMMANDS` に入れる（サイドバー前提） |
| オーバーレイ（コマンドバー / ライブラリ / 設定）表示中 | 効かせる（⌃Tab と同じ。裏で行が移り閉じた枠なら実体化する。コマンドバーの入力欄がコマンド受信で全選択に戻るのは既存の `CommandBar` の挙動で今回の範囲に入れない。実装レビュー 1 回目で決定） |

## 実装計画

### Phase 1: 並びの純粋関数とキーバインド [AI🤖]

- [x] `src/shared/sidebar-rows.js`（Node 非依存・`// @ts-check`）を新規作成
  - [x] `sidebarRows({ liveRows, favorites, pinned, ephemeralRows })` → 行の配列
    `{ kind: 'live', url } | { kind: 'favorite', id } | { kind: 'pin', id } | { kind: 'ephemeral', key: string | null, defId: string | null }`
    （一時タブ由来は 1 種類にまとめ、`key` / `defId` を両方持つ。実体化・定義化で形が変わっても同じ行として追える）。
    Live の入力は **Sidebar 側が `liveFolderView(state).kind === 'list'` のときだけ、開いている小見出しの項目を review → mine で組み立てて渡す**
    （`list` 以外・`liveFolder === null` なら空）。Favorites の順は `FAVORITE_SECTIONS` を import して使う（書き写さない）。
    分割ペアは呼び出し側が `ephemeralRows` を `[left, right]` の 2 行に展開して渡す（Sidebar が結合行を作るのと同じ判定）
  - [x] `sameRow(a, b)`: 同一行の述語。ephemeral 行は `key` か `defId` のどちらか一致で同一
  - [x] `rowMatchesTab(row, tab)`: 行とタブの照合。`tab.key` → `tab.ephemeralId` → `pinnedId` → `favoriteId` → `normalizePrUrl(url)` の順
    （分割の相方が Live Folder の URL でも結合行側の ephemeral 行が勝つ）
  - [x] `currentRow(rows, activeTab) → row | null`（`rowMatchesTab` で先勝ち。index は返さない）
  - [x] `stepRow(rows, from, delta) → row | null`: **`from` は「前回指した行（or null）」で受ける**（トレイルの末尾をそのまま渡せる形）。
    `sameRow` で `rows` の中の `from` を探し、無ければ `delta > 0` で先頭・`< 0` で末尾、あれば両端で折り返す。`rows` が空なら `null`
  - [x] `normalizePrUrl` は `live-folder-schema.js`（既に `tsconfig.web.json` に入っている）から import する。**`settings-schema.js` は import しない**（`node:fs` に届く）
- [x] `tsconfig.web.json` の `include` に `src/shared/sidebar-rows.js` を足す
- [x] `scripts/sidebar-rows.test.mjs`: 並び順（Live → tools → messages → ピン → 一時タブ）、閉じたフォルダの中身が消える・開いたフォルダは入る、
  畳んだ小見出しの行が消える、分割の 2 行、両端の折り返し、現在位置が無いときの先頭 / 末尾、空のときの `null`、
  照合の優先順（分割の相方が PR URL）、`from` が rows から消えた（行を閉じた）ときの扱い、
  **def 行が実体化しても `from` が追随する**（`{ key: null, defId }` → `{ key, defId }`）、**ローカル行が定義を得ても追随する**（`{ key, defId: null }` → `{ key, defId }`）
- [x] `src/shared/keybindings.js` の `COMMANDS`（Tab 節、`next-tab` の隣）に
  `{ id: 'select-row-below', label: 'サイドバーの下の行へ', accelerator: 'CmdOrCtrl+Alt+Down', menu: 'tab' }` と
  `{ id: 'select-row-above', label: 'サイドバーの上の行へ', accelerator: 'CmdOrCtrl+Alt+Up', menu: 'tab' }` を追加。
  コメントに「見た目の並びは renderer が握るので main では解かない」を書く
- [x] `scripts/keybindings.test.mjs` に既定値と `isValidAccelerator` が通ることの検査を足す
- [x] `src/main/menu.ts`: `UI_COMMANDS` と `MINI_BLOCKED_COMMANDS` に 2 つを追加（`runCommand` の switch には書かない。`copy-url` と違って main 側の存在チェックは不要）
- [x] `mise run test` / `mise run typecheck` / `mise run lint`

### Phase 2: renderer（Sidebar / LiveFolder） [AI🤖]

- [x] `LiveFolder.tsx`: `collapsed` の `useState` と `toggleBucket` を Sidebar へ持ち上げ、`collapsed` / `onToggle` を props で受ける。
  「起動のたびに両方折りたたみ・永続化しない」のコメントは Sidebar 側の `useState` に移す。持ち上げると
  `liveFolderEnabled` を false → true したときの unmount で畳み直る副作用が消える（以前の開閉が残る）ので、その旨をコメントに残す
  （既存の verify-live-folder は `readExpanded` が毎回開き直すので落ちない）
- [x] `LiveFolder.tsx` の `PrRow` に `data-url={item.url}` を足す（`PinnedTree` の `data-pin` と同じ「検証が引くための手がかり」コメント付き。
  追従スクロールと自走検証の名指しに使う）
- [x] `Sidebar.tsx`
  - [x] `liveCollapsed` state を持ち、`LiveFolder` に渡す
  - [x] `useMemo` で `sidebarRows(...)` の入力を組み立てる。`ephemeralRows` は既存の結合行の判定（`splitSide === 'left'` かつ相方あり → `[left, right]`、
    `right` かつ相方あり → 出さない）を**そのまま流用して** 2 行に展開する（判定を 2 か所に書かない。描画側と同じヘルパにする）
  - [x] `useCommand` の handler に `select-row-below` / `select-row-above` を足す: 起点は **`useRef` のトレイル（自分が指した行の配列）の末尾**、
    トレイルが空なら `currentRow(rows, activeTab)` → `stepRow(rows, from, delta)` → 行の種類ごとに
    `liveFolderOpen(url)` / `openFavorite(id)` / `openPinned(id)` / ephemeral 行は **`key` があれば `selectTab(key)`、無ければ `openEphemeral(defId)`**。
    撃ったら行き先をトレイルに積む。`null` なら何もしない
  - [x] トレイルの掃除: `activeTabKey` が変わるたびに、そのタブがトレイルのどれかに `rowMatchesTab` で一致すれば**そこまでを確定として切り落とし**
    （末尾はそのまま残す）、どれにも一致しなければ別経路の移動なのでトレイルを空にする。「未来を見る」規定は置かない
  - [x] 現在位置の照合に使うのは `activeTabKey` のタブ（Peek ではない。`foregroundTab` は使わない）
- [x] 移動先の行が画面外なら `scrollIntoView({ block: 'nearest' })` する（DOM の手がかり `.fav[data-id]` / `[data-pin]` / `[data-key]` / `[data-def-id]` / `.lf-row[data-url]` を
  選択後に引く。無ければ何もしない。URL をセレクタに埋めるので `CSS.escape` を通す）
- [x] `mise run typecheck` / `mise run lint`

### Phase 3: 自走検証 [AI🤖]

**先に検査を書いて実装前に FAIL を見る**（新機能なので HEAD にはコマンドが無く、`runCommandForVerify` が `false` を返して選択が動かない。
Phase 1 / 2 の実装を `git show HEAD:<path>` で戻して回すのではなく、**Phase 3 の検査を Phase 1 より先に書いて一度回す**方が安い。
順序を入れ替えて、ここを最初に着手する）

- [x] `scripts/verify-pins.mjs` に節「⌘⌥↑↓ でサイドバーの行を縦に渡る」を追加（Favorites・ピン・フォルダ・一時タブ・循環）
  - [x] 状態を作る: Favorites 2 件（tools 1・messages 1、どちらも閉じている）、ピン留め: リンク A・閉じたフォルダ（中にリンク B）・開いたフォルダ（中にリンク C）、一時タブ 2 枚
  - [x] 先頭の Favorite を開いて起点にし、`runCommandForVerify('select-row-below')` を 1 手ずつ撃って **`state()` の `activeTabKey` のタブが
    `favoriteId` / `pinnedId` / `key` の順で期待どおり進む**ことを check（B の pinnedId が一度も来ないこと・A → C → 一時タブ 1 → 2 の順）。
    **各手のあいだに `until(activeTabKey === 期待値)` を挟む**（`runCommandForVerify` は main の処理完了までしか待たず、renderer の反映は待たない。
    続けて撃つと連打の経路を踏んで run ごとに揺れる）
  - [x] 連打の検査を 1 件だけ別に置く: **1 つの `ev` の式の中で** 3〜4 連射して **連射した数だけ進む**（`ev` を分けると間に再描画が挟まり、
    トレイルの無い実装でも通ってしまい「実装前 FAIL」が見られない）。起点と到達行を明記し、**全部開いている区間**（ピン A → C → 一時タブ 1 → 2）で撃つ
    （閉じた定義を含む区間だとタブが増えて枚数の検査と干渉する）
  - [x] 閉じた共有定義の行（`EphemeralDefRow`）を通過してから次の一手で先頭へ飛ばないこと（行の同一性）。def 行は 1 ウィンドウでは作れないので、
    ファイルにある `openSecondWindow()` で 2 枚目を開き**そちらで `createTab`** して window 1 に def 行を出す。撃つのは window 1 の `ui`。
    後始末は既存ブロックに倣って `closeEphemeralTabs(other)` + `other.close()`
  - [x] Live Folder の前提 check は DOM で `.lf-row` が 0 本であることを見る（view の種類に依存しない）
  - [x] 閉じている messages の Favorite に到達した手でタブが**ちょうど 1 枚**増える（`前 -> 後` を detail に出す）。
    起点が tools の先頭なので**縦断の最初の ↓ がこの手**。増分は縦断の中でその手の前後で測る（後から独立に測ると増分 0 で FAIL する）
  - [x] 一時タブ 2（最下段）で ↓ → 先頭の Favorite（循環）。先頭の Favorite で ↑ → 一時タブ 2（逆方向の循環）
  - [x] フォルダを開いてから同じ経路を撃つと B が入る（`toggleFolder` 後）
  - [x] 末尾で開いたタブ・定義を片付ける（`resetDefinitions` だけだと定義を失ったタブが残る。既存節の後始末に倣う）
- [x] `scripts/verify-split.mjs` に「分割ペアは左 → 右の 2 ステップ」の節（4 件程度）: 分割の直前行から ↓ で `activeTabKey` が左、もう一度 ↓ で右、さらに ↓ で次の行。
  下の行から ↑ で右。**各手のあいだに `until(activeTabKey === 期待値)`**（pins 節と同じ理由）
- [x] `scripts/verify-live-folder.mjs` に「小見出しを畳んでいれば飛ばし、開いていれば PR の行へ入る」の節（3〜4 件）: 先に回る verify-pins の
  `resetDefinitions()` で Favorites / ピンは 0 件になっている公算が高いので、節の頭で一時タブを 2 枚作り、
  **前提 check（`shared.favorites` / `shared.pinned` が 0 件・`.lf-row` が 0 本・一時タブが 2 行）を置いたうえで**
  `collapseAll` 後に最下段の一時タブから ↓ で**並びの先頭 = 最上段の一時タブへ回り**（1 行以下だと出発点と到達点が同じで何も見ずに PASS する）、PR タブが増えない（`activeTabKey` の URL が `normalizePrUrl` で null）。
  `expandAll` 後に同じ操作で先頭の PR 行へ入り `openUrls` 相当（`normalizePrUrl` 一致のタブ）が選ばれる。**各手のあいだに `until(activeTabKey === 期待値)`**。
  行数の期待値は `readExpanded` と同じ作法（読む直前に開き直す）で取る。**PR の URL は実 github.com で `NEMO_GITHUB_TEST_ENDPOINT` の差し替え対象外**なので、
  節の末尾で開いた PR タブを `closeTab` する（既存の ③ と同じ。残すと後続の行数・`ROWS` の期待値がずれる）
- [x] 実装前に `mise run verify:only pins split live-folder` を回し、**新しい検査だけが FAIL する件数**を控える（他は PASS のまま）
- [x] 実装後に同じ 3 つを回し、**総件数の `N 件 → M 件`** と PASS を報告に出す。`mise run verify:only pins` を配線が効いている証拠として単独でも 1 回回す

### Phase 4: ドキュメント [AI🤖]

- [x] `DESIGN.md`: サイドバー（3層の並び）の近くに「⌘⌥↑↓ の規則」を 1 節（並び・スキップ・閉じた定義は開く・両方向循環・分割は 2 ステップ・現在位置が無いときの扱い・
  Peek は親に付いたまま裏に回る・サイドバー非表示でも効く・連打は直前に指した行から進む）。
  分割「ほかの決めごと」の「⌃Tab / ⌃M は 2 つのタブのまま数える」に ⌘⌥↑↓ も並記
- [x] `docs/operations.md`: `## サイドバーの3層` の末尾にコマンド ID と既定キーを 1 行（ショートカットの節も `keybindings` の項も無いのでここに決め打ち）
- [x] `VERIFY.md`: pins / split / live-folder の各節に追加した検査項目を 1 行ずつ。split 節の「キー操作は撃てない」注意は既存の言い分け
  （撃てないのはキーそのもの、コマンドは `runCommandForVerify` で撃てる）に合わせて ⌘⌥↑↓ を添える。人手確認のキー一覧（⌘W / ⌃Tab / ⌘1〜9 が並ぶ箇所）に ⌘⌥↑↓ を足す
- [x] `docs/CHANGELOG.md` `[Unreleased]` の `### 追加` に 1 行（体言止め）

### 動作確認 [人間👨‍💻]

- [ ] `mise run dev` で起動し、実キーで ⌘⌥↓ / ⌘⌥↑ が効くこと（メニュー accelerator は自走検証では撃てない）
- [ ] Live Folder の小見出しを開いた状態で PR 行に入れること、畳むと飛ばされること
- [ ] ページ側にフォーカスがあるとき（テキスト入力中）にも効くこと（accelerator なので効くはず）

## ログ

### 試したこと・わかったこと

- 実装前に `mise run verify:only pins split live-folder` を回し、新しい検査だけが FAIL することを確認: pins 15 件・split 4 件・live-folder 4 件
  （pins の「最下段で ↓ → 先頭へ回る」「連射でもタブは増えない」の 2 件は起点に留まったままでも通るので実装前でも PASS。隣の検査と組で見る）
- live-folder 節の前提 check が `pinned: 1` で落ちた（前に回る split スイートが「ピン留めで解ける」の検査で残したピン）。
  前提を「あること」の check にせず、節の頭でピン / Favorites を消してから check する形にした
- 実装後: pins 143 → 158 件・split 100 → 104 件・live-folder 77 → 81 件、すべて PASS（`mise run verify:only pins split live-folder`、exit 0）。
  ユニットテストは 407 件 PASS（`sidebar-rows.test.mjs` 10 件・`keybindings.test.mjs` に 1 件追加）

### 方針変更

- `currentRow` は「rows の並び順で先勝ち」でなく**照合の段階ごとに rows 全体を見る**（key → ephemeralId → pinnedId → favoriteId → URL）。
  並び順の先勝ちだと Live 行が最上段にあるぶん「分割の相方が PR の URL」で URL 一致が勝ち、ユニットテストで落ちた。
  plan の「先勝ち」は段階の先勝ちの意味に読み替える（2026-09-04）
- `LiveFolder.tsx` に `visibleLiveRows(state, collapsed)` を置いた（`liveFolderView` が `list` のときだけ、開いている小見出しの項目を
  review → mine で返す）。plan では Sidebar 側で組み立てるとしていたが、`liveFolderView` の分岐と同じファイルに置くほうが食い違いにくい
- トレイルは **1 手目に起点の行も一緒に積む**（決定表は「自分が指した行」だけを書いている）。行き先だけだと、反映待ちの間に届く
  title / favicon / loading の push で `activeTabKey` がまだ起点のままなのを掃除の effect が「別経路の移動」と見てトレイルを捨て、
  連打の出だしで 1 手落ちる（実装レビュー 1 回目）。副作用として「行き先が反映される前の数十 ms にクリックで起点へ戻る」と
  反映待ちと区別できず次の一手が 1 行飛ぶが、窓が短く実害が小さいので invoke の在庫で持つ作りには変えていない（同 2 回目で見送り）
