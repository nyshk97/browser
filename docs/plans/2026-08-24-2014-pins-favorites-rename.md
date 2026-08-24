# ピン留め・Favorites の作り直し（リネーム / 遅延ロード / フォルダ1階層 / Favorites 専用枠）

## 概要・やりたいこと

サイドバーの3層（Favorites / ピン留め / 一時タブ）を Arc 相当の使い勝手にする。

1. **タブ名のリネーム**: ピン留め・フォルダ・Favorites・一時タブのどれでも、行をダブルクリックしてその場で名前を書き換えられる
2. **遅延ロード**: 起動時にピン留め / Favorites のタブ実体を**一切作らない**。サイドバーには枠（定義）だけが並び、初めてクリックした時点でタブが生まれて読み込みが走る。ピンが 30 個あっても起動コストが増えない
3. **フォルダは1階層**: ピン留めをフォルダでまとめられる（今も入れ子は可能だが無制限なので、1階層に制限する）
4. **Favorites を専用枠にする**: 現状は「押すと一時タブが開くだけのブックマーク」。ピン留めと同じ扱い（タブが Favorites グリッドに属し、下の一時タブ一覧には出ない）にする

## 前提・わかっていること

### 現状のコード（調査済み）

| 項目 | 現状 |
|---|---|
| Favorites | `pins.json` に永続化済み。サイドバー上部のグリッド（`Sidebar.tsx` の `FavoriteGrid`）。**押すと URL 一致の一時タブを探し、無ければ一時タブを新規作成**（`ipc.ts` の `nemo:open-favorite`）。右クリックで即削除 |
| フォルダ | 実装済み（`createFolder` / `movePinned`）。入れ子は `MAX_PIN_DEPTH = 8` まで可能 |
| リネーム | `renameNode`（`store/pins.ts`）と IPC `nemo:rename-node` は実装済みだが **renderer に UI が無い**。一時タブのリネームは `TabState` にカスタム名フィールドが無く未対応 |
| 起動時の読み込み | セッション復元は `asleep: true` でタブを作る（`index.ts:159`）。WebContents は作らないので**読み込みは走らない**が、**ピンの数だけタブ実体ができる** |
| ピン留めの URL | 遷移してもピン定義の `url` は書き換わらない（既にそうなっている） |

### `/dig-lite` で決めたこと

- **Favorites はピン留めと同じ専用枠**にする。タブに `favoriteId` を持たせ、開いても下の一時タブ一覧には出さない。閉じてもグリッドから消えない。遅延ロード・リネームもピン留めと同じ規則
- **遅延ロードは「定義だけ復元し、常にピンの URL に戻す」**。起動時にタブ実体を作らない。前回そのピンで見ていた URL は覚えない（初クリックでは必ず登録 URL を開く）
- **ピンの URL は固定**。使用中に別ページへ遷移してもピン定義は書き換わらない。URL の更新はコンテキストメニューの「このページに更新」から明示的に行う
- **リネームは永続**。ページ遷移してもタイトルは変わらない。ピン / フォルダ / Favorites は `pins.json`、一時タブはセッションに保存して再起動後も維持。編集を**空にすると解除**して実タイトルに戻る

### 設計上の決めごと（この計画で採用する）

- 定義（ピン / Favorite）は `title`（既定名 = ピン時のページタイトル。読み込み時に更新する）と `customTitle`（ユーザーが付けた名前。`null` なら未設定）を**分けて持つ**。表示は `customTitle ?? title`。分けないと「リネームを解除したときに戻る先」が無い
- **既定名の自動更新はシークレットウィンドウでは行わない**。`pins.json` は永続なので、シークレットで開いたページのタイトルが書き込まれると「閉じたら跡形もなく消える」という約束が破れる
- タブ実体は `pinnedId` / `favoriteId` の**どちらか一方**にだけ属する（両方 non-null にはしない）。さらに **1 ウィンドウにつき 1 定義 1 タブ**（同じ `pinnedId` のタブが同一ウィンドウに2つある状態を作らない）。この2つは `createTab` の中で保証する（今も `pinnedId` の存在検査はそこでやっている: `registry.ts:1095`）
- **ピン留めと Favorites の排他は「定義ごと移す」**。⌘D でピン留めしたら、そのタブが属していた Favorite **定義を削除**してグリッドからも消す。Favorites に追加したら同じく**ピン定義を削除**する。所属だけ付け替えると同じ URL が両方の枠に残り、どちらから開いたかで別タブになる
- **変換時のタブの写像**（全ウィンドウを1度に走査して、この4つだけを適用する）

  | 対象 | 変換後 |
  |---|---|
  | 操作中のタブ | 変換元 ID → **変換先 ID** |
  | 同じウィンドウで先に開いていた変換先のタブ | 変換先 ID → **null**（一時タブへ降格） |
  | その他のウィンドウの変換元のタブ | 変換元 ID → **null** |
  | その他のウィンドウの変換先のタブ | **変更なし** |

  `unpinEverywhere` / `removeFavoriteEverywhere` は**通常の削除（解除）専用**で、変換の経路からは呼ばない（呼ぶと写像の1行目まで null に倒れる）
- 変換では **`title` と `customTitle` を引き継ぐ**（削除 → 新規追加で作ると付けた名前が消える）。移動先に**同じ URL の定義が既にある場合はそれを再利用し、名前は既存側を優先**する（明示的に付けた名前を、変換のついでに上書きしない）
- **変換は「定義の付け替え」と「全ウィンドウの所属更新」を1つの経路で行う**。`store/pins.ts` 側の変換 API は*名前を読む → 移動先を作る/再利用する → 元定義を消す*までを一括で行い、**消えた ID の一覧と移動先の定義を返す**。registry 側はその戻り値を受けて全ウィンドウのタブを付け替える。`removeFavoriteEverywhere` / `unpinEverywhere` を先に呼ぶと名前を読む前に定義が消え、変換 API に先に消させると `unpinEverywhere` が「削除 0 件」になって他ウィンドウの所属が外れない（呼び順のどちらでも壊れるので、経路を分けない）
- 変換先の定義に属するタブが**同じウィンドウで既に開いている**場合は、**操作中のタブを所属させ、元から開いていたタブは所属を外して一時タブに降格**させる（1 ウィンドウ 1 定義 1 タブを保つ。降格はログに残す）
- **専用タブが一時タブへ降格する経路では、所属していた定義の `customTitle` をタブへ写してから所属を外す**。ID だけ外すと、定義に付けていた名前がその瞬間に消える。対象は**降格が起きる全経路**（変換の写像で null に倒れる2種類 / `unpinEverywhere` / `removeFavoriteEverywhere` / フォルダ削除による子ピンの巻き添え解除）
- 降格時は**定義の値を、`null` も含めて常に代入する**（タブ側に残っている値を優先しない）。専用タブの表示名は定義が唯一の正なので、タブ側を優先すると「A でピン留め → B にリネーム → 解除」で古い A に戻る、リネームを解除したのに古い名前が復活する、といった食い違いが出る
- そのため**変換 API も削除 API も、消えた ID だけでなく「その定義の名前」まで返す**（`unpin` は今 `string[]` を返すので `{ id, title, customTitle }[]` に変える）。変換 API は **`{ removedDefinitions: { id, title, customTitle }[], target }`** を返し、降格するタブは ID で引いた定義を渡す。なお変換で降格する「同じ窓の先客タブ」が属していた**変換先の定義は消えない**ので、こちらは `target` の値を渡す（経路は同じヘルパ1本）
- **一時タブに付けた名前は、ピン留め / Favorites へ移すときも引き継ぐ**。新しい定義を作る際に `customTitle` としてタブの名前を渡す（既存定義を再利用する場合は既存優先の規則が勝つ）。逆に**専用タブを閉じるとき（`closedTabs`）は所属定義から実効 `customTitle` を読んで保存する**。タブ側のフィールドだけ見ると、定義を消した後の ⌘⇧T で名前が失われる
- セッションには**一時タブだけ**を保存する。ピン / Favorites のタブは保存しない（= 起動時に復元されない）。**旧版（v2）のセッションを読むときは、`pinnedId` が文字列のレコードごと落とす**。フィールドだけ捨てると、旧データのピンタブが一時タブとして復活する
- **⌘⇧T（閉じたタブを開き直す）は「閉じた瞬間の状態」を戻す**。つまり現在 URL・`customTitle`・`pinnedId` / `favoriteId` をそのまま復元する。「登録 URL に戻る」のはサイドバーの枠をクリックしたときの規則で、⌘⇧T とは別物。ただし上の不変条件が優先で、次の2つの例外を置く
  - **同じ定義のタブが復元先ウィンドウに既に開いている**（閉じた後にサイドバーから開き直した場合）→ **新しく作らず既存のタブを選択する**だけ（スタックからは取り出して消費する）。作ると同じ枠に2つのタブがぶら下がる
  - **定義が既に消えている**（閉じた後に解除した場合）→ 所属を外して**一時タブとして復元**する（URL と `customTitle` は保つ）。消えた ID のまま復元すると、どの層にも出ない不可視タブになる
- ピン定義の URL 更新（コンテキストメニュー）は**タブの key だけを受け取り、`pinnedId` は main 側で導出する**。無関係なタブで他人の定義を書き換えられる口を作らない。更新先 URL が**別のピンに既にある場合は更新しない**（現状 `findPinnedByUrl` で保っている「同じ URL を二重にピン留めしない」不変を壊さないため）。したがって**「このページに更新」は、そのピンが開いているときだけ出す**（閉じている行では対象タブが無いので項目自体を出さない）
- フォルダの中にフォルダは作れない。既存データや Arc インポートで2階層以上が来たら**中身を親に平坦化**する

## 実装計画

### Phase 1: データモデルとスキーマ [AI🤖]

- [x] `src/shared/types.ts`
  - [x] `FavoriteItem` / `PinnedLink` / `PinnedFolder` に `customTitle: string | null` を足す
  - [x] `TabState` に `favoriteId: string | null` と `customTitle: string | null` を足す
  - [x] `NemoUiApi` に `renameTab(key, title: string | null)` / `updatePinnedUrl(key)` を宣言し、`renameNode` の第2引数を `string | null` に変える
- [x] `src/shared/settings-schema.js`
  - [x] `PINS_VERSION` を 2 に上げ、`normalizePins` で `customTitle` を読む（無ければ `null`）
  - [x] `MAX_PIN_DEPTH` を 1 にし、`normalizePinnedList` で **depth 1 以上のフォルダは中身を親へ平坦化**する（捨てない）
  - [x] `SESSION_VERSION` を 3 に上げ、`SavedTab` に `customTitle` を足し、`pinnedId` を落とす
  - [x] **v2 のデータを読むときは `pinnedId` が文字列のレコードごと除外する**（フィールドだけ消すと旧ピンタブが一時タブとして復活する）。除外の結果タブが 0 になったウィンドウは、既存の `tabs.length === 0` の分岐でそのまま捨てられる
  - [x] **`activeIndex` を除外後の配列で計算し直す**。今の実装は元の値を新しい長さに clamp するだけ（`settings-schema.js:299`）なので、先頭や中間のピンタブが落ちると**別の一時タブが選択される**。元のアクティブタブが残っていればそのタブの新しい位置に、落ちていれば 0 に倒す
- [x] `src/shared/arc-import.js`: `walk` の結果を1階層に平坦化する（2階層目以降のフォルダは中身だけを親フォルダへ入れる）。生成する定義に `customTitle: null` を入れる
- [x] **定義を作る関数は `customTitle` を任意引数で受け取る**（`pinUrl(url, title, customTitle?)` / `addFavorite(url, title, customTitle?)` / `createFolder(title, customTitle?)`）。**未指定のときだけ `null`** に倒す。常に `null` を入れる作りにすると、リネーム済みの一時タブをピン留め / Favorites へ移したときに名前が消える。Arc インポータの生成分は `null`
- [x] ユニットテスト
  - [x] `scripts/settings-schema.test.mjs`: 版 1 の pins.json が読めること / 2階層以上のフォルダが平坦化されること / `customTitle` の往復
  - [x] `scripts/settings-schema.test.mjs`: **v2 セッションの移行** — `pinnedId` を持つタブが除外され、一時タブだけが残ること / それでタブが空になったウィンドウが落ちること / `customTitle` が往復すること
  - [x] `scripts/settings-schema.test.mjs`: **移行後の `activeIndex`** — 先頭がピンタブ / 中間がピンタブ / アクティブだったタブ自体がピンタブ、の3ケースで選択が意図どおりに残ること
  - [x] `scripts/arc-import.test.mjs`: 深い階層の Arc データが1階層に落ちること
- [x] `mise run test` が通ること

### Phase 2: main（定義ストアとタブ実体） [AI🤖]

- [x] `src/main/store/pins.ts`
  - [x] `renameNode(id, title: string | null)`: `null` / 空文字で `customTitle` を解除。ピン・フォルダ・Favorite を同じ経路で扱う
  - [x] `setPinnedTitle(id, title)`: ページタイトルが取れたときに**既定名だけ**更新する（`customTitle` は触らない）
  - [x] `updatePinnedUrl(id, url)`: ピン定義の URL を差し替える。**別のピンが既にその URL を持っていたら何もしない**（`findPinnedByUrl` で見て、拒否をログに残す）
  - [x] `createFolder` は root 直下のみ。`movePinned` は `parentId !== null` かつ移動対象が folder なら拒否（ログを残す）
  - [x] `unpin` / `removeFavorite` の戻り値を**消えた定義の一覧（`{ id, title, customTitle }[]`）**に変える（今は `unpin` が `string[]`）。呼び出し側が降格するタブへ名前を写せるようにするため。フォルダ削除で巻き添えになる子ピンも同じ形で返す
- [x] `src/main/registry.ts`
  - [x] `NemoTab` に `favoriteId: string | null` と `customTitle: string | null` を足し、`toState()` に載せる
  - [x] `openFavorite(win, favoriteId)` を registry 側に作る（`favoriteId` 一致のタブがあれば選択、無ければ作って紐付ける）。`ipc.ts` の URL 一致ロジックは捨てる
  - [x] `removeFavoriteEverywhere(favoriteId)`: `unpinEverywhere` と対称に、全ウィンドウのタブから `favoriteId` を外す
  - [x] **降格を1つのヘルパに寄せる**（`demoteTab(tab, definition)`）: 所属を外す前に、その定義の `customTitle` を `tab.customTitle` へ**`null` も含めて常に代入する**（タブ側の値を優先しない）。`unpinEverywhere` / `removeFavoriteEverywhere` / フォルダ削除の巻き添え / 変換の写像で null に倒れる2種類——**降格が起きる全経路をこのヘルパ経由にする**（経路ごとに書くと必ずどれかで名前が消える）
  - [x] `CreateTabOptions` に `favoriteId` / `customTitle` を足し、**所属の不変条件を `createTab` の中で保証する**
    - [x] 存在する定義の ID だけ受理する（`favoriteId` も `pinnedId` と同じく `findFavorite` で検査。消えた ID は null に倒す）
    - [x] `pinnedId` と `favoriteId` が同時に渡ったら**片方（`pinnedId`）を優先して他方を落とす**＋ログ
    - [x] **同じウィンドウに同じ定義のタブが既にある場合は所属を付けない**（呼び出し側の取りこぼしをここで止める）
  - [x] 変換を**1本の経路にまとめる**
    - [x] `store/pins.ts`: `convertPinToFavorite(id)` / `convertFavoriteToPin(id)` が「名前を読む → 移動先を作る or 同じ URL の既存定義を再利用 → 元定義を削除」までを一括で行い、**`{ removedDefinitions: { id, title, customTitle }[], target }` を返す**（ID だけでは降格するタブへ名前を渡せない）
    - [x] `registry.ts`: 戻り値を受けて**全ウィンドウのタブの所属を1度に付け替える**単一メソッドを置く。適用する写像は前提セクションの表のとおり（操作中のタブだけが変換先 ID を持ち、同じ窓の先客と他ウィンドウの変換元は null に倒す）
    - [x] `removeFavoriteEverywhere` / `unpinEverywhere` は**この経路から呼ばない**（削除専用。呼ぶと操作中のタブの所属まで外れる）
    - [x] `togglePin` / `pinTabInto` / `addFavoriteFromTab` はこの経路を呼ぶだけにする
  - [x] **一時タブの `customTitle` を新しい定義へ渡す**（リネーム済みの一時タブをピン留め / Favorites へ移しても名前が残るように）。既存定義を再利用する場合は既存側の名前を優先する
  - [x] `renameTab(tab, title | null)`: 定義に属するタブなら `renameNode`、一時タブなら `tab.customTitle` を更新
  - [x] ページタイトル確定時（`attachTabEvents`）に、ピン / Favorite に属するタブなら `setPinnedTitle` で既定名を更新する。ただし **`win().isPrivate` なら更新しない**（永続ファイルにシークレットの閲覧内容を書かない）
  - [x] `removeTab` の手動クローズ時アーカイブ条件を `tab.pinnedId === null && tab.favoriteId === null` にする（今は `pinnedId` しか見ておらず、Favorite タブを閉じるとアーカイブに残る）
  - [x] `closedTabs`（⌘⇧T）のエントリに `favoriteId` と `customTitle` を足し、`reopenClosedTab` で復元する。**専用タブの `customTitle` は所属定義から実効値を読んで保存する**（タブ側のフィールドだけ見ると、定義を消した後の復元で名前が消える）。**⌘⇧T は閉じた瞬間の URL / 名前 / 所属をそのまま戻す**（「登録 URL に戻る」のは枠をクリックしたときの規則で、ここでは適用しない）
  - [x] `reopenClosedTab` の例外2つを実装する: **同じ定義のタブが既に開いていれば新規に作らず選択するだけ** / **定義が消えていれば所属を外して一時タブとして復元**（URL と `customTitle` は保つ）。前者を落とすと同じ枠に2つのタブがぶら下がり、後者を落とすとどの層にも出ない不可視タブになる
  - [x] `toSaved()`（`registry.ts:920` あたり）を**一時タブだけ**にし（`pinnedId === null && favoriteId === null`）、`customTitle` を含める。`activeIndex` の算出も同じ絞り込みを通した配列で行う（フィルタ条件がズレると別のタブが選択される）
  - [x] 自動アーカイブ（`sweepArchive`）の対象外に `favoriteId !== null` を追加（ピン留めと同じ扱い）
- [x] `src/main/index.ts`: 復元ループの `createTab` から `pinnedId` を落とし、**`customTitle: tab.customTitle` を渡す**（保存側が一時タブだけになるのでピン / Favorites のタブは自然に作られなくなるが、渡し忘れると一時タブのリネームが再起動で消える）
- [x] `src/main/menu.ts`: `add-favorite` を `addFavoriteFromTab` 経由にする（排他の規則を1か所に寄せる）
- [x] `mise run typecheck`

### Phase 3: IPC と preload [AI🤖]

- [x] `src/main/ipc.ts`
  - [x] `nemo:rename-node` を `title: string | null` 受け入れに変更
  - [x] `nemo:rename-tab` を追加
  - [x] `nemo:update-pinned-url` を追加。**引数はタブの `key` だけ**にし、`pinnedId` は `requireTab` で得たタブから main 側で導出する（renderer から任意の定義 ID を指定させない）
  - [x] `nemo:open-favorite` を registry の `openFavorite` に差し替え
  - [x] `nemo:add-favorite` を `addFavoriteFromTab` に差し替え
  - [x] `nemo:remove-favorite` を `removeFavoriteEverywhere` に差し替え
- [x] `src/preload/ui.ts` に `renameTab` / `updatePinnedUrl` を足す
- [x] `src/main/suggest.ts`: 候補のタイトルを `customTitle ?? title` にする（リネームした名前で引けないと意味が無い）

### Phase 4: レンダラー UI [AI🤖]

- [x] `src/renderer/components/InlineRename.tsx`（新規）: ダブルクリックで編集に入る共通コンポーネント
  - [x] Enter / blur で確定、Esc で取消、**空で確定したら解除**（`null` を送る）
  - [x] **単クリックの発火を遅らせ、`dblclick` が来たら取り消す**（既定 250ms 程度）。ブラウザは `click` → `click` → `dblclick` の順で撃つので、「編集開始時にクリックを止める」だけでは間に合わない
  - [x] **遅延させるのは「閉じているピン / Favorite を新しく読み込むクリック」だけ**にする。ここを遅らせないと、リネームしようとしただけでタブが生まれて読み込みが走る（＝遅延ロードの意味が消える）
    - [x] **既に開いている専用タブ・一時タブの選択は即時**。選択済みになってもダブルクリック編集は妨げられないので、遅らせると通常操作が常に重くなるだけ
    - [x] **フォルダの開閉も即時でよい**（2回のクリックで開閉が2回起きて元の状態に戻る）。開閉のちらつきが目に付くようなら、そのときだけ遅延に変える
    - [x] × ボタンやメニューは当然即時
  - [x] 編集中は行のクリック（= タブ選択 / フォルダ開閉）を止める
- [x] `src/renderer/components/RowMenu.tsx`（新規）: サイドバー内に収まる軽量コンテキストメニュー
  - [x] ピン留め行: 名前を変更 / このページに更新（**そのピンが開いているときだけ出す**。閉じていれば対象タブが無い）/ ピン留めを解除
  - [x] フォルダ行: 名前を変更 / フォルダを削除
  - [x] Favorites: 名前を変更 / Favorites から外す（**右クリックで即削除する今の挙動をやめる**）
  - [x] 一時タブ行: 名前を変更 / ピン留め / Favorites に追加 / 閉じる
- [x] `PinnedTree.tsx`: 行に `InlineRename` と `RowMenu` を組み込む。フォルダの上にフォルダを落とすドロップを弾く（main 側でも弾くが、ドロップ線を出さない）
- [x] `TabRow.tsx`: `label` の代わりに `InlineRename` を使い、`customTitle ?? title` を表示
- [x] `Sidebar.tsx`
  - [x] `FavoriteGrid` を専用枠として描く: `favoriteId` 一致のタブがあれば loading / audible / unread / active を重ねる（ピン留め行と同じ規則）
  - [x] 一時タブの抽出条件を `pinnedId === null && favoriteId === null` に変える
  - [x] **一時タブを Favorites グリッドへドロップして追加できるようにする**。今の `onDrop` は Favorite 同士の並べ替えしか見ていない（`Sidebar.tsx:258`）ので、`PinnedTree` と同じく `TAB_DRAG_TYPE` を判別して `addFavorite(tabKey)` を呼ぶ分岐を足す
  - [x] Favorites が**空のときもドロップ受け皿を出す**（今は `favorites.length === 0` で `null` を返して何も描かないため、最初の1件を D&D で作れない）
- [x] `styles.css`: インライン編集の入力欄・コンテキストメニュー・Favorites の状態表示（読み込み中 / 未読 / アクティブ）
- [x] `mise run check`（lint → typecheck → test）

### Phase 5: 自走検証とドキュメント [AI🤖]

- [x] `scripts/verify-phase1.mjs` に追記（CDP 経由・UI 操作なしで通せる範囲）
  - [x] `renameNode(id, '名前')` → `getSharedState()` の `customTitle` が入る / `renameNode(id, null)` で戻る
  - [x] `renameTab(key, '名前')` → `getWindowState()` のタブに乗る
  - [x] `movePinned(folderA, folderB, 0)` が**拒否される**（1階層の保証）
  - [x] `openFavorite` で作ったタブが `favoriteId` を持ち、`pinnedId` が null であること
  - [x] `updatePinnedUrl(key)` でピンの URL が差し替わること / **別のピンが既に持つ URL への更新が拒否される**こと
  - [x] 変換（ピン ⇄ Favorite）: 元の定義が消えること / `customTitle` が残ること / 他ウィンドウの同じ定義に属していたタブの所属も外れること / 移動先の定義のタブが同じ窓に開いていたら元のタブが一時タブへ降格すること
  - [x] リネーム済みの一時タブをピン留め / Favorites へ移しても名前が残ること
  - [x] **降格しても名前が残ること**を経路ごとに: ピン留め解除 / Favorites から外す / フォルダごと削除して子ピンが巻き添えになる / 変換で他ウィンドウの変換元タブが降格する / 変換で同じ窓の先客タブが降格する——いずれも降格後のタブの `customTitle` が定義に付けていた名前になっていること
  - [x] Favorite タブを閉じてもアーカイブに載らないこと（`queryArchive` に出ない）
  - [x] シークレットウィンドウでピンを開いて遷移しても `getSharedState().pinned` の `title` が変わらないこと
- [x] **所属の正規化を純粋関数に切り出してユニットテストする**（`CreateTabOptions` は preload に公開されていないので CDP からは叩けない: `types.ts:303`）
  - [x] `resolveTabOwnership({ pinnedId, favoriteId }, { definitionExists, windowTabs })` 相当を `src/shared/` に置き、`createTab` から呼ぶ
  - [x] `scripts/` にテストを足す: 消えた ID は落ちる / 両 ID 同時指定は片方だけ残る / 同じ定義のタブが窓に既にあれば所属を付けない
- [x] **UI の自走検証**（着手前に `~/Library/CloudStorage/Dropbox/dotfiles/.claude/references/mac-app-verification.md` を読む）
  - [x] `mise run dev` で起動し、UI の webContents に CDP で繋いでサイドバーを直接操作する（`dblclick` を dispatch → 入力欄に値を入れて Enter → `getSharedState()` に反映されるか）
  - [x] 右クリック（`contextmenu` の dispatch）でメニューが出て、各項目が対応する API を呼ぶこと
  - [x] ピン留め行 / Favorites グリッド / 一時タブ行の D&D を `dragstart` → `dragover` → `drop` の合成イベントで通し、`movePinned` / `moveFavorite` の結果が定義に反映されること
  - [x] 一時タブを Favorites グリッドへドロップして追加できること。**グリッドが空のときと、既に何件かあるときの両方**で確認する（空のときは受け皿そのものが別の要素）
  - [x] 閉じているピン行のコンテキストメニューに「このページに更新」が**出ない**こと
  - [x] **閉じているピン / Favorite をダブルクリックしても、タブ数が増えず編集だけが始まる**こと（単クリックの遅延が効いているかの決定打。`getWindowState().tabs.length` を前後で比較する）
    - [x] `dblclick` を1発 dispatch するだけでは**キャンセル経路を通らない**。実際と同じ `click` → `click` → `dblclick` の順で送り、**遅延（250ms）を超えて待ってから**タブ数を見る
    - [x] 逆に、一時タブと既に開いている専用タブは**遅延なしで即座に選択される**こと（`activeTabKey` がクリック直後に変わる）
  - [x] **⌘⇧T の例外2つ**（`reopenClosedTab` は `window.nemo` に無く、メニューのアクセラレータ経由でしか叩けない）: `Input.dispatchKeyEvent` で ⌘⇧T を送り、①同じ定義のタブが開いている状態では**タブが増えず選択されるだけ** ②定義を消してから戻すと**一時タブとして**復活すること。合成キーでメニューが発火しない場合は、`menu.ts` の `runCommand` を検証から叩ける口（既存の command 経路）に寄せてから確認する
  - [x] スクリーンショットを撮り、**Favorites の状態表示**（読み込み中スピナー・未読ドット・アクティブ枠）とインライン編集中の見た目を目視で確認する
- [x] 遅延ロードの検証（再起動をまたぐので `scripts/verify-*.mjs` に独立した手順として足す）
  - [x] ピンと Favorite を作り、それぞれ開いた状態で正常終了 → 再起動 → `getWindowState().tabs` に `pinnedId` / `favoriteId` を持つタブが**1つも無い**こと
  - [x] `openPinned` で初めてタブが生まれ、開く URL が**登録 URL**であること（遷移後に閉じても登録 URL に戻る）
  - [x] **一時タブのリネームが再起動をまたいで残ること**（`--session-write` でリネーム → 再起動 → `--session-read` で `customTitle` を確認する。既存の `verify-all.mjs:160` の流れに乗せる）
  - [x] v2 のセッションファイルを置いた状態から起動し、旧ピンタブが**一時タブとして復活しない**こと・選択タブがずれないこと
- [x] Phase 5 の変更後に `mise run check`（lint → typecheck → test）と `mise run verify` を通し、**出力を plan のログに残す**
- [x] `VERIFY.md` に「ピン留め / Favorites の遅延ロード」節を追記（再利用可能な手順だけ）
- [x] `DESIGN.md` / `README.md` のサイドバー説明を、Favorites 専用枠・フォルダ1階層・リネームに合わせて更新
- [x] `docs/plans/2026-08-23-0115-nemo-browser.md` の該当仕様（3層の並び・ピン留め）に追記して食い違いを消す

### 動作確認 [人間👨‍💻]

AI 側で通した検証（Phase 5）の後に、**AI では判断しきれない分だけ**人が見る。

- [ ] 実際のマウス操作でダブルクリック → リネーム → Enter / Esc の手触りが破綻していないこと（合成イベントでは拾えない IME の変換確定まわりを含む）
- [ ] ピンを 20〜30 個持った実プロファイルでアプリを再起動し、**アクティビティモニタでメモリとプロセス数が増えていない**こと。クリックした1つだけが読み込まれること
- [ ] Arc から実データをインポートし、2階層以上のフォルダが平坦化されて壊れていないこと（件数と並びが妥当か）
- [ ] 数日使ってみて、ピンの URL 固定（遷移しても登録 URL に戻る）が煩わしくないこと

## ログ

### 試したこと・わかったこと

- **合成ドラッグは dragstart と drop の間を空けないと、実装が壊れていても PASS する**。
  ピン留めツリーは「何を掴んでいるか」を React の state（`dragId`）に持つので、
  続けて撃つと drop の時点でまだ state が入らず、ドロップが黙って無視される。
  最初に書いた「フォルダ同士のドロップは弾かれる」は、実は**掴んだものが伝わっていなかった**
  だけで PASS していた。ヘルパを async にして 150ms 待つようにしてから、初めて本当の判定になった
- **検証用ヘルパの「タブを全部閉じる」はスナップショットの長さを見てはいけない**。
  `for (const tab of s.tabs) { if (s.tabs.length <= 1) break }` は snapshot の長さが変わらないので
  「1個だけ残す」つもりが「全部閉じる or 何も閉じない」になる。1個残った状態で
  「サイドバーの先頭の行」を掴む検証を書いたため、前の検証のタブを掴んで 4 件 FAIL した。
  **掴む行は `renameTab` で一意な名前を付けてから `.row[title="..."]` で名指しする**ようにした
- **アーカイブに載らないことの検証は、そのセクション専用の URL でやる**。
  先行する verify-phase1 / phase2 が同じ URL（`/index.html`）をアーカイブに残していて誤検知した
- **`createTab` 直後に `navigate` すると ERR_ABORTED で投げる**（初回ロードが中断される）。
  検証では `!t.loading && t.url.includes(...)` を待ってから遷移させる
- **メニューのアクセラレータ（⌘⇧T）は CDP から合成できない**。macOS のネイティブメニューは
  AppKit が先に食うので、`Input.dispatchKeyEvent` は renderer に直接入って menu を発火させない。
  そこで `reopenClosedTab` の**判定だけを純粋関数 `resolveReopen` に切り出して**
  `scripts/tab-ownership.test.mjs` でユニットテストし、キー入力そのものは人間の確認に回した
- 自走検証の結果: `mise run check`（lint → typecheck → **139 tests**）と
  `mise run verify`（**205 PASS / exit 0**、うち verify-pins が 56 件）が通っている。
  旧版データからの移行は `mise run verify:migration` で別プロファイルを立てて 7 件 PASS

#### レビュー（2026-08-24）で直したこと

- **専用タブの候補名がリネーム後も古いままだった**（`suggest.ts`）。`tab.customTitle` を直接
  読んでいたが、専用タブのリネームは**定義だけ**を書き換える。名前を読む口を
  `effectiveCustomTitle` / `tabDisplayName` に寄せ、コマンドバーはそこを通すようにした
- **フォルダを「フォルダの中のリンク行」へ重ねるとドロップ線が出ていた**（落としても main が
  弾くので何も起きない）。ドロップ線と実際のドロップで**同じ述語 `canDrop`** を使うようにし、
  「掴んでいるのがフォルダなら、フォルダの中に落ちる位置には置けない」を1か所で表現した
- **タブ行を掴んだドラッグの `dragend` を落とす側が拾えず、ドロップ線が出たまま残っていた**
  （`dragend` は掴んだ側の要素でしか起きない）。`useDragEnd` で window から拾って戻す。
  **この不具合は追加した検証が見つけた**（ドロップ線を数える検証を書いたら、前のドラッグの
  線が残っていて 1 個数えられた）
- 検証の穴を塞いだ: **別ウィンドウをまたぐ変換・解除**（写像の3行目。1枚では検証できない）と、
  **閉じている Favorite のダブルクリック**（ピン行と別コンポーネントなので別に見る必要がある）

#### 実機で見つかった不具合（2026-08-24）

- **Favorites グリッドが巨大化して3個目がはみ出していた**。原因は favicon の CSS が
  `.row .fi` に閉じていたこと。Favorites のセルは `.row` の外なので、
  `<img class="fi">` が**ページの実寸のまま**（zenn の 256px favicon）描かれ、
  `1fr`（= `minmax(auto, 1fr)`）が min-content で列ごと押し広げていた。
  1個でも大きく、増えるほど広がり、3個目が画面外に出るのはすべてこれ1つの結果
  - `.fi` を**行の外でも効く単独クラス**に格上げした（ライブラリの favicon にも効く）
  - グリッドを `repeat(N, minmax(0, 1fr))` にして、**何が入っても列がはみ出さない**ようにした
  - 回帰検証を足した: `test-pages/index.html` に**わざと 256x256 の favicon** を出させ、
    描画後の実寸（アイコン 18px / グリッド幅 ≤ サイドバー幅 / セルが正方形）を測る
- **タイルは4列 56px → 5列 43px に変更**（実物のスクショを3案並べてユーザーが選定）。
  DESIGN.md のサイズ表も更新した

##### さらに踏んだ罠

- **ブラウザ UI の CSP は `img-src 'self' crx: data: https:`**。http のテストサーバから
  favicon を配ると**弾かれて検証にならない**（実機の https では出るので、
  「手元では再現しない」形の穴になる）。fixture は data URI で埋めた
- **ユーザーが Nemo Dev を起動していると `mise run verify` は走らない**（安全ガード）。
  バグ報告の直後はまさにその状態なので、**そのインスタンスは触らず**、
  使い捨てプロファイルで `verify-pins` だけ回す小さなランナーを scratchpad に置いて確認した

- **ドロップ線が「出ない」ことの検証は、必ず出る側の対照を隣に置く**。
  0 個という結果は「正しく弾いた」とも「dragover がそもそも届いていない」とも読めるため
- **`HELPERS` のテンプレートリテラルの中にバッククォートを書くと、そこで文字列が終わる**。
  日本語コメントで `` `dragend` `` と書いて `verify-pins.mjs` が SyntaxError になった。
  このとき `mise run check` は `[lint] ERROR task failed` を出していたのに、
  **同時に起きていた `config-sync.test.mjs` の負荷依存 flake の方だと誤読して見落とした**。
  失敗したタスク名は必ず確かめる

### 方針変更

- **ピン留め / Favorites の自走検証は `verify-phase1.mjs` に足さず、`scripts/verify-pins.mjs` を新設した**。
  計画では phase1 への追記としていたが、リネーム・変換・降格の5経路・遅延ロード・UI の D&D と
  合わせて 44 件になり、既に 777 行ある phase1 に混ぜると読めなくなるため。
  `verify-all.mjs` に段として組み込み、遅延ロードは既存の再起動に相乗りさせた（`--lazy-write` / `--lazy-read`）
- **旧版セッションからの起動確認は独立したスクリプト（`scripts/verify-session-migration.mjs`）にした**。
  別プロファイルにデータを置いて起動し直す必要があり、`verify-all` の本流に混ぜられないため。
  `mise run verify:migration` で単体でも回せる。版 1 の `pins.json`（フォルダ2階層）も同時に確かめる
- **⌘⇧T の end-to-end 確認は人間の確認へ回した**（上記の理由）。
  代わりに判定を純粋関数へ切り出し、例外2つ（既に開いていれば選ぶだけ / 定義が消えていれば
  一時タブとして戻す）をユニットテストで固めた
- **Favorites のリネームはグリッドのセル内ではなく、グリッド直下に入力欄を出す**。
  セルは正方形のアイコンで、中にテキスト入力を置いても読めないため
