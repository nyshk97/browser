review session: b0b891aa-5a0a-412a-b612-f63b9b422672

## 1回目

````text
計画とコードを突き合わせて確認しました（`pins.ts` / `ipc.ts` / `preload/ui.ts` / `keybindings.js` / `verify-targets.mjs` を実読）。

## P0
- `Phase 1 > ステップ3` — `page-favicon-updated` から定義に書く処理を `remember` の外に置くと、シークレットウィンドウで Favorite / ピンのタブを開いただけで永続の `pins.json` が書き換わる / 直上の `page-title-updated`（`registry.ts:707-712`）が「pins.json は永続なので**シークレットでは書かない**」を明示的な不変条件にしており、favicon だけ破ると同じ穴が開く / `setFaviconForDefinition` の呼び出しを `remember(() => ...)` の中に入れる、とステップに書く（値が同じなら commit しないの dedup はその内側）
- `Phase 1 > ステップ2` / `Phase 2 > ステップ4` — `moveFavorite(id, index)` は `favorites` フラット配列の**絶対 index**（`pins.ts:387`, `ipc.ts:500`, `preload/ui.ts:72`）。セクション分割後にグリッドが渡すのは**セクション内の相対 index** なので、そのままだと Tools のドロップ位置が Messages 側にずれ、⌘N の通し番号も崩れる / 実装後にドラッグの並び替えが全部やり直しになる / API を `moveFavorite(id, section, index)` の 1 本に統合し、main 側で「同 section の n 番目」→ フラット配列位置に解決する。`moveFavoriteSection(id, section)` との二本立てにしない（右クリックメニューは index 省略＝末尾でこれを呼ぶ）
- `Phase 4 > ステップ3` — 「`OWNERS` の `types.ts` / `pins.ts` / `Sidebar.tsx` / `PinnedTree.tsx` / `keybindings.js` / `menu.ts` / `arc-import.js` のエントリを広げる」は前提が誤り。これらのエントリは `verify-targets.mjs` の `OWNERS` に**存在しない**（現状は slots 系と leaf コンポーネントのみ）/ 新規に載せると、複数スイートが読むファイルを触っても `--changed` がフルからサブセットに落ちて検証が弱くなる。`OWNERS` のコメント（「載せてよいのは『そのスイートしか見ていない』と確かめたものだけ。迷ったら載せない＝フルに倒れる」）に正面から反するのでレビューで戻る / 実際に必要なのは `src/shared/slots-schema.js` を `['slots']` → `['slots','pins']` に広げることだけ。他は載せない（＝フルに倒す）とステップに書き換える。`verify-targets.test.mjs` の更新も併記
- `Phase 3 > ステップ5` — レンダラ側の受け口が計画に無い。`nemo:modifier` は `preload/ui.ts` の購読ラッパ（`ui.ts:205` の `on`/`removeListener` 形）と `window.nemo` の型追加が要る。同様に section 付き `moveFavorite` / セクション移動も `ipc.ts` のハンドラ引数検証・`preload/ui.ts` の signature・型定義の 3 点セットが要る / preload 層が抜けたまま Phase 2・3 を書くと renderer が呼べずに止まる / 各 Phase に「main ハンドラ → preload → 型」の配線ステップを明記する

## P1
- `Phase 3 > ステップ1` — 「設定に残った `select-tab-N` は無視（ログに 1 回だけ出す）」は既存実装で済んでいる。`select-tab-N` は `COMMANDS` に載っていないので `resolveKeybindings`（`keybindings.js:178`）が `unknown_command` として弾き `problems` に積む / 不要な実装を足すぶんの手戻り / ステップから落とし、「⌘1〜9 は従来どおりユーザー再割り当て不可（コマンド表に載せない）」だけ書く
- `Phase 3 > ステップ2` — 小窓の扱いが未記載。既存 `selectTabByIndexIn` は `canHostAdditionalTabs(win)` で早期 return している（`menu.ts:333`）が、`openFavorite` はタブが無ければ `createTab` する / Peek / mini window で ⌘1 を押すと「タブ 1 本」の不変条件を壊し、`createTab` が throw する経路にも入る / `selectFavoriteByIndexIn` の先頭でも同じ早期 return を入れる、と明記
- `Phase 3 > ステップ3` — `previousActiveKey` の更新条件が未定義。`selectTab` は同じキーに対しても呼ばれる（タイルクリック、タブ行クリック）/ 同キー選択で `previousActiveKey` が自分自身になると 2 度押しの「戻る」が無反応になる / 「`key === win.activeTabKey` のときは更新しない」を明記。無効化はタブ close だけでなく `moveTabToNewWindow`（別ウィンドウへ移送）でも行う。あわせて `createTab` 内のローカル変数（`registry.ts:2179`）と名前が衝突するので、フィールド名は別名にする
- `Phase 3 > ステップ5` — 仕様が計画内で食い違い、かつ取りこぼし対策が blur だけ。概要は「⌘ を押している間だけ」、動作確認は「⌘ 長押し」/ 即時表示だと ⌘L・⌘T・⌘W のたびにバッジが一瞬光る。また keyUp は「ネイティブメニューが開いた」「listener の無い webContents（拡張ポップアップ・DevTools）へフォーカスが移った」「⌘⇥ でアプリ切替」で落ちるので、同一ウィンドウ内でフォーカスが動くケースは `browser-window-blur` で拾えず出っぱなしになる / ホールド閾値（300〜400ms 目安）を決めて概要と動作確認の文言を揃え、表示後 N 秒の自動解除か `webContents` フォーカス変更での強制解除を安全弁として足す
- `Phase 1 > ステップ4` — 穴埋めクエリの前提が未記載。`url LIKE 'https://host/%'` は host に `_` / `%` が入ると誤マッチする（`ESCAPE` 句が要る）。`hasFaviconColumn()` が false の環境では `recordFavicon`（`history.ts:68`）と同様に即 return / 列が無い Mac で無駄な起動時クエリを撃つ・ホスト誤マッチで別サイトのアイコンが定義に焼き付く / `ESCAPE` 付き LIKE・列なし時の早期 return・取得値を https / data: に正規化してから書く、をステップに書く
- `Phase 1 > ステップ6` — 「`slot-apply.js` の差分 kind に `section` は含めない」は現状の `kind` の意味とずれている。`kind` は `'favorite' | 'pinned-link' | 'pinned-folder'` の種別で（`slot-apply.js:24`, `:98` で `kind` + `url` の一致だけを見ている）、並び順や section はそもそも差分要素になっていない / 書き手の意図（section 違いを差分に出さない）が実装者に伝わらず、`kind` を触る誤実装を誘う / 「`section` は差分の同一判定に使わない（`kind` + `url` が同じなら同一物）」と書き直し、適用時に section をどう扱うかは下記 Q の決定を反映する

## P2
- `Phase 2 > ステップ2` — `bookmarks` の文字ラベルにすると `Sidebar.tsx` の `PinIcon`（「文字より視線の邪魔にならず、Favorites との層の区別も付く」というコメント付き）が未使用になる / 削除するのかラベル左に残すのかをステップに書く（未使用なら DESIGN の該当記述も一緒に落とす）
- `Phase 2 > ステップ3` — Messages と Tools の両方に空表示を出すと、初回起動時に上段が「ラベル＋空箱」2 セットで重くなる / Tools が空になるのは実質初回だけなので、空表示は Messages 側だけ、Tools は 0 件ならラベルごと畳む案も検討に値する

## Q
- `Phase 3 > ステップ6` — ⌘数字を Favorites に付け替えると、分割ペイン間のフォーカス移動をキーボードで行う手段が無くなる（`COMMANDS` にペインフォーカス系のコマンドは無く、`verify-split.mjs:1195-1220` はまさにその経路を検査している）。代替キー（⌘⌥←/→ 等）を新設するか、キーボードでのペイン移動は諦めるか / 決めないと検査を消した時点で機能が黙って落ち、DESIGN.md の記述とも食い違ったままになる
- `Phase 1 > ステップ6` — 別の Mac で保存したスロットを適用したとき、`section` は「適用先の現在の振り分けを残す」か「スロット側で上書きする」か / 決めないとスロット同期のたびに手で振り分けた Messages が黙って Tools に戻る（またはその逆）ことが起き、どちらが正しいか実装後に判定できない

````

**対応**: P0 4 件をすべて反映（favicon 書き込みを `remember` 内に / `moveFavorite(id, section, index)` に統合し `moveFavoriteSection` を廃止 / `OWNERS` は `slots-schema.js` の拡張だけに修正 / preload・型の配線を Phase 1・3 に明記）。P1 は 6 件すべて書き換えで反映（`select-tab-N` の無視処理を削除、小窓の早期 return、直前タブの更新条件と移送時の無効化、バッジのホールド閾値 350ms と解除の安全弁、穴埋めの ESCAPE・列なし早期 return・正規化、`kind` の記述修正）。P2 2 件も反映（`PinIcon` 削除、Tools は 0 件なら畳む）。Q は 2 件とも自分で決定: ペイン移動は ⌃Tab / ⌃M で可能（DESIGN.md:395）なので専用キーを新設しない / スロット適用の section はスロット側優先・旧形式は同 url を引き継ぎ・無ければ tools。

## 2回目

````text
計画を読み直し、前回の対応箇所とその周辺コード（`settings-schema.js` の正規化、`slots-schema.js`、`slots.ts` の版判定、`DESIGN.md:395`、`VERIFY.md:400`）を実読して確認しました。前回の P0/P1/P2 は反映を確認、Q 2 件の決定（⌃Tab / ⌃M でペイン移動可・スロットの section 優先順）はコードと DESIGN の記述と一致しています。

## P0
- `Phase 1 > ステップ2` — 「`pins.ts`: 読み込み時の正規化」は場所が違う。pins.json の正規化は `pins.ts` ではなく `settings-schema.js` の `normalizePins` → `normalizeFavorite` / `normalizePinnedList`（`initPins` が `JsonStore(..., PINS_VERSION, normalizePins)` で渡している）/ これらは受け取った raw から**新しいオブジェクトを組み直す**ので、`section` / `faviconUrl` をそこに足さない限り、書けても次回起動で毎回黙って消える。しかも `normalizeSlot` は `normalizePins(input)` を呼んでいるため、スロットの保存・読み込みでも同じく落ちる / 変更先を `settings-schema.js` の `normalizeFavorite`（`section` / `faviconUrl`）と `normalizePinnedList` の link 分岐（`faviconUrl`）に書き換える。`slots-schema.js` 側は `normalizeSlot` 経由で自動的に通るので**足さない**（「ピン留めの不変条件は `normalizePins` が持つので書き直さない」という既存方針どおり）。`normalizeFaviconUrl` の置き場も `settings-schema.js` にして `slots-schema.js` から import する（逆向きは循環）。ユニットテストの追加先に `scripts/settings-schema.test.mjs` を入れる
- `Phase 1 > ステップ6` — 決定事項の「旧形式で `section` が無いエントリは適用先の同 `url` から引き継ぐ」が、上記の正規化を通した後では実装できない。`normalizeFavorite` が欠損を `tools` に倒すため、適用ロジックからは「明示的に tools」と「そもそも無かった」が区別できない / 旧スロットを適用すると手作業の振り分けが黙って Tools に戻る（この決定がまさに防ごうとした事象）/ 判定をエントリ単位ではなく**スロット単位**にする。`readSlot`（`slots.ts` の `versioned.data`）は raw を持っているので、正規化前に「favorites のどれかに `section` キーがあるか」を見て「section 情報を持つスロットか」のフラグを立て、適用側へ渡す。`SLOTS_VERSION` を上げる方法もあるが、`slots.ts` は未来の版を `bad_version` として読めない扱いにするので、旧バージョンの Mac でスロットが読めなくなる。raw 判定を推す

## P1
- `Phase 4 > ステップ1`（バッジの検査）— `nemo:modifier` をサイドバーへ直接撃つ検査だと、main 側の 350ms ホールド閾値と 3 つの解除条件（keyUp / `browser-window-blur` / webContents フォーカス移動 / 5 秒）が丸ごと無検査になる。ハーネスは `VERIFY.md:400` のとおりキーを撃てないので、`before-input-event` 経路も自然には発火しない / 一番壊れやすく、一番手で確かめにくい部分（＝自走検証で固定したい部分）が抜ける / `NEMO_VERIFY_DIAGNOSTICS` 下の診断 IPC で main の Meta down / up ハンドラ（状態機械）を直接叩く口を作り、「350ms 未満では出ない」「keyUp で消える」「blur で消える」「表示から 5 秒で自動解除」まで検査する、とステップに書く
- `Phase 4 > ステップ1`（シークレットの不変条件）— `Phase 1 > ステップ3` で入れる「private では pins.json を書かない」を検査で固定していない / いま同じ不変条件を守っているのは `page-title-updated` の**コメントだけ**で、favicon 経路も同じく次の変更で静かに戻る / シークレットウィンドウで Favorite を開き favicon が届いても pins.json が変わらない、という check を 1 本足す
- `Phase 1 > ステップ2`（favicon の長さ上限）— `normalizeFaviconUrl` の `MAX_FAVICON_LENGTH = 8192` は「カードに焼き込むのは 6 件だけ」を前提に決めた値（`MAX_SLOT_ICONS` のコメントに「`data:` は数十 KB になることがあり、6 件ぶんがそのままスロットの容量になる」と明記）。定義側では Favorites 全件＋入れ子のピン全件に付く / pins.json はタイトル更新のたびに全体を書き直すストアなので、8KB × 数十〜数百件で書き込みコストとスロット容量が桁で増える / 定義用は別の上限を持つ（`data:` は 2KB 程度、`https:` はそのまま）方針を決めてステップに書き、`MAX_FAVICON_LENGTH` 側のコメントにも「定義側は別上限」と追記する

## P2
- `Phase 1 > ステップ2` — `setFaviconForDefinition(id, url)` はピン留めのフォルダの中まで辿らないと、入れ子のブックマークにアイコンが入らない / `slots-schema.js` の `iconCandidates` の `walk` と同じ再帰が要る旨をステップに一言入れておくと実装漏れが減る
- `Phase 2 > ステップ4` — 決定事項の「Arc 移行・既存・新規追加はすべて `Tools`」と、このステップの「落とした側の section に入れる」が字面で衝突する / 「明示的なドロップ先がある場合だけそちらが勝つ（それ以外の追加経路は `tools`）」と決定事項側に一言足す
- `Phase 3 > ステップ6` — ⌘1〜9 への言及は `DESIGN.md` だけでなく `registry.ts:2387` のコメント（右タブを左の直後へ移す理由として「⌘1〜9 / ⌃Tab / セッション保存の並びが揃う」）にも残る / DESIGN.md だけ直すとコード側のコメントが古くなる

## Q

````

**対応**: P0 2 件を反映（正規化の変更先を `settings-schema.js` の `normalizeFavorite` / `normalizePinnedList` に書き換え、`slots-schema.js` 側の正規化追加を削除、`normalizeFaviconUrl` の置き場を settings-schema に / 旧形式スロットの判定をスロット単位の raw 判定に変更し `SLOTS_VERSION` は上げないと決定）。P1 3 件も反映（バッジの検査を診断 IPC で main の状態機械を叩く形に書き換え、シークレットで pins.json が変わらない check を追記、定義側の favicon 上限を `data:` 2KB / `https:` 制限なしと決定）。P2 3 件も文言で反映（フォルダ内の再帰、ドロップ先が勝つ旨、`registry.ts:2387` のコメント）。

## 3回目

````text
計画を読み直し、新規の決定（raw 判定・favicon 上限・診断 IPC 検査）が実コードで成立するかを `pins.ts` / `slots.ts` / `settings-schema.js` で確認しました。前回の P0 2 件・P1 3 件・P2 3 件はいずれも反映を確認。残りは以下です。

## P0

## P1
- `Phase 1 > ステップ3` — ピン留め ↔ Favorites の変換（`convertPinToFavorite` / `convertFavoriteToPin`）で `faviconUrl` / `section` を引き継ぐ記述が無い。どちらも `FavoriteItem` / `PinnedLink` のリテラルを新規に組み立てている / 必須フィールドなので型エラーで気づくが、素直に `faviconUrl: null` と埋めると右クリック 1 回で favicon が消える。穴埋めは「起動時に一度」なので次の起動まで頭文字のまま戻らない / 変換元の `faviconUrl` をそのまま移す（既存を再利用する分岐では既存側を優先。名前の扱いと同じ規則）、新規 Favorite の `section` は `tools`、とステップに書く
- `Phase 1 > ステップ7` — 決定事項の「raw で `section` キーの有無を見る」旧形式判定が、`renameSlot` で壊れる。`renameSlot` は `readSlot`（＝`normalizeSlot` を通す）で読んだ結果に名前だけ差し替えて**書き戻す** read-modify-write なので、旧形式スロットの名前を変えた時点で全 favorites に `section: 'tools'` が焼き込まれ、以後は「section を持つスロット」に見える / 一度リネームした旧スロットを適用すると、手作業の振り分けが黙って Tools に戻る（この決定がまさに防ごうとした事象）/ `renameSlot` は raw JSON の `name` だけ差し替えて書き戻す（`normalizeSlot` で全体を作り直さない）ことをステップに書く。あわせて旧形式フラグの持ち方（`readSlot` の戻りを `{ data, hasSection }` にするか適用専用の関数を足すか）も決めておく（`renameSlot` が同じ `readSlot` を使っているため、戻り型を変えるなら両方直す）
- `Phase 4 > ステップ2` — verify-slots の追加が「新フィールドが残る / 旧形式は既定値になる」までで、決定事項の肝である**適用時の引き継ぎ**を検査していない / スロット適用は手作業の振り分けを壊しうる唯一の経路なのに、壊れても検査が緑のままになる / 「適用先で `messages` に振り分けた Favorite があり、旧形式スロット（`section` 無し）に同じ `url` が入っているとき、適用後も `messages` のまま」「新形式スロットなら `section` はスロット側で上書きされる」の 2 本を足す。上の `renameSlot` の経路（リネーム済み旧スロット）も同じ検査で拾える
- `Phase 4 > ステップ1` — `section` の検査が「既定・移動・描画順」までで、**セクション内相対 index からフラット配列位置への解決**を見ていない / そこが `moveFavorite(id, section, index)` に統合した一番の理由であり、ずれても「移動できた」だけの検査は通ってしまう / 「Messages 2 件・Tools 3 件の状態で Tools の 2 番目へドロップすると Tools 内で 2 番目になり、Messages の並びは動かない」「Messages → Tools の末尾へ移すと ⌘N の番号が期待どおりずれる」を足す

## P2
- `Phase 1 > ステップ2` — 定義側の上限（`data:` 2KB）を `normalizeFavorite` に入れると、スロットの favorites も同じ経路を通るので実質そちらも 2KB になる。加えて `icons` は定義の `faviconUrl` 優先になるため、`MAX_FAVICON_LENGTH`（8KB）が効くのは履歴補完で入った分だけになる / 「定義側は別上限」の追記だけだと 8KB が何のために残っているか読めなくなるので、コメントに「履歴補完で入る分の上限」と用途を書き切る
- `Phase 1 > ステップ5` — 起動時の穴埋めをブートのどこで走らせるかが未記載。履歴 DB の初期化前に走らせると `hasFaviconColumn()` が false 相当で黙って no-op になる / 「DB 初期化後・ウィンドウ復元前に 1 回」と実行位置を書いておくと、verify が落ちてから場所を探す往復が減る

## Q

````

**対応**: P0 なしで収束。P1 4 件をすべて反映（変換時の `faviconUrl` 引き継ぎ / `renameSlot` は raw の name だけ書き戻す・旧形式フラグは `readSlot` の戻りに載せる / verify-slots に適用時の引き継ぎ 2 本 / verify-pins に相対 index 解決の検査）。P2 2 件も反映（`MAX_FAVICON_LENGTH` コメントの用途明記 / 穴埋めの実行位置）。検査項目の追加はループ終了後なので今回反映した（未レビュー）。
