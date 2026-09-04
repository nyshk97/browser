review session: da84053b-615c-4bb3-a997-efafe9bb5f62

## 1回目

````text
plan と実コード（`Sidebar.tsx` / `LiveFolder.tsx` / `menu.ts` / `keybindings.js` / verify 各スイート）を突き合わせて読みました。

## P0
- `Phase 2 > 2` / `Phase 1 > 1`（カーソルの置き場） — 行き先を毎回 `currentRowIndex(rows, activeTab)` から解くと、`selectTab` / `openPinned` / `liveFolderOpen` はすべて invoke の往復＋`pushState` 経由なので、**押した時点の `state` はまだ 1 手前**。⌘⌥↓ を連打・キーリピートすると同じ index から同じ行へ再実行し、進まない／飛ぶ。同じ症状が「1 タブに 2 行が対応する」場合にも出る（分割に入った PR URL のタブは Live 行と結合行の両方に対応し、照合の先勝ちで結合行側に付くので、Live 行へ入った次の一手が一気に下へ飛ぶ）。→ 行き先を `useRef` に持ち、「ref の行が今の `activeTabKey` と整合していればそこから、していなければ `currentRowIndex` から」進める形にして、撃つたびに ref を更新・行クリック等で active が別経路で変わったら捨てる。`stepRow` の引数を index ではなく「前回指した行 + rows」で受ける設計にしておかないと後から入れ替えになる。検査は「await せずに 2 連射して 2 行進む」を 1 件足す。
- `Phase 1 > 1`（`sidebarRows` の Live 入力） — 入力が `liveItems` / `liveOpenBuckets` だけだと、**描画されていない PR 行が並びに入る**。`liveFolderView` は `failure.kind === 'auth'` を `items` より先に見るので、キャッシュが残ったままトークンが切れると `reconnect`（行 0 本）なのに `state.items` は非空。この状態で ⌘⌥↓ すると見えない行へ飛び、`isLiveFolderUrl` が通ってタブまで開く（`connect` も同様）。→ `liveFolderView(state).kind === 'list'` を引数に足す（または Sidebar 側で `groups` を組み立てて渡す）。`Phase 1 > 3` のテストに「`list` 以外は Live 行 0 本」「`liveFolder === null`」「`items` が review/mine 混在でも review → mine に並ぶ」を追加する。

## P1
- `Phase 2 > 3`（scrollIntoView の手がかり） — `.lf-row` は `<button className="row lf-row">` で、**URL を引ける属性が無い**（`data-key` / `data-pin` / `data-id` / `data-def-id` はある）。Live 行だけ追従スクロールできず、自走検証も行を名指しできない。→ `PrRow` に `data-url={item.url}` を足す（`PinnedTree` の `data-pin` と同じ「検証が引くための手がかり」コメント付きで）。
- `決定事項 > 現在位置が行に無いとき` / `前提・わかっていること > 9`（Peek） — 前提が誤り。`selectTab` は `tab.peekOf` を親に倒し、`menu.ts` も `tab.peek` を見るので、**Peek 前面でも `activeTabKey` は親タブ＝行がある**。`-1` になるのは「Live Folder 由来のタブで小見出しが畳まれている」場合だけで、Peek を根拠に書くと存在しない経路の検査を書くことになる。→ 根拠から Peek を外し、代わりに「Peek が出ている間に行を移ると Peek は親に付いたまま裏に回る（⌃Tab と同じ）」を DESIGN に 1 行書いて、`Phase 3` のどこかで 1 件だけ固定する。
- `Phase 3 > 1`（1 手ずつの check） — `runCommandForVerify` の解決は main の処理完了までで、**renderer が `rows` を組み直すところまでは待たない**。次の一手を続けて撃つと P0 の競合そのものを踏み、実装が正しくても run ごとに揺れる。→ 各手のあいだに `until(() => state().activeTabKey === 期待値)` を挟み、「連射でも進む」検査だけを意図的に await 無しで撃つ、と役割を分ける。
- `Phase 3 > 3`（live-folder の節） — PR の URL は `https://github.com/<repo>/pull/N` で `NEMO_GITHUB_TEST_ENDPOINT` の差し替え対象外なので、行に入ると**実 github.com を読むタブが 1 枚残る**（既存の ③ も同じことをして最後に `closeTab` している）。片付けないと後続の一時タブ行数・`ROWS` の期待値がずれる。→ 節の末尾で開いたタブを閉じることをステップに明記し、`expandAll` 後の行数期待値は `readExpanded` と同じ作法で取る。
- `Phase 4 > 2`（operations.md） — 「ショートカットの説明がある箇所」も「`settings.json` の `keybindings` の項」も **operations.md には無い**（`keybindings` の語は VERIFY.md と plan 群にしか出てこない）。書き先が決まっていないと Phase 4 で止まる。→ `## サイドバーの3層` に 1 行足す形に決め打ちし、あわせて VERIFY.md の人手確認のキー一覧（⌘W / ⌃Tab / ⌘1〜9 が並んでいる箇所）にも ⌘⌥↑↓ を足す。

## P2
- `前提・わかっていること > 3` — `copy-url` は `UI_COMMANDS` に**入っていない**（`runCommand` の switch 内で `foreground` の存在チェックをしてから `sendToUi`）。前例の引き方が事実と違うだけで、`Phase 1 > 6` の「`UI_COMMANDS` に足して switch には書かない」は動作としては正しい。前提の記述を直す。
- `Phase 1 > 1` — Favorites の並び（tools → messages）は `FAVORITE_SECTIONS`（`shared/favorites.js`、既に `tsconfig.web.json` に入っている）が唯一の定義なので、`sidebarRows` でも import して使う。順序を書き写すと `FavoriteSections` と二重定義になる。
- `Phase 2 > 1` — `collapsed` を Sidebar へ上げると、`liveFolderEnabled` を false→true したときに `LiveFolder` の unmount で畳み直る現在の副作用が消える（＝以前の開閉が残る）。既存の verify-live-folder は `readExpanded` が毎回開き直すので落ちないが、「起動時は両方畳む」以外の畳み直し契機が変わることをコメントに残す。
- `Phase 3 > 2` — verify-split は冒頭の docstring で「キー操作は撃てない」と書きつつ、既に `runCommand`（`window.nemo.runCommandForVerify`）ヘルパを持っている。`Phase 4 > 3` の VERIFY.md 追記は「撃てないのはキーそのもの、コマンドは撃てる」の既存の言い分けに合わせる。

## Q
- `決定事項 > 閉じた定義の行` — 押しっぱなし（メニューのアクセラレータは macOS でもリピートする）を許すか。閉じたピンが 10 行並んでいる列を押し切ると 10 枚の実タブが読み込みごと立ち上がる。間引く（リピート中は実体化を遅らせる／`holdModifiersFor` 系の確定まで待つ）なら Phase 1 の関数の形が変わるので先に決めたい。
- `Phase 1 > 6` — サイドバーを隠しているとき（⌘S、`chromeView.setVisible(false)`。renderer は生きているのでコマンドは届く）に効かせるか。効かせるなら「見えないまま選択とタブ生成が進む」ことを許容する、塞ぐなら `MINI_BLOCKED_COMMANDS` とは別に `sidebarVisible` の分岐が 1 本要る。

````

**対応**: P0 2 件を反映（連打対策: 直前に指した行を ref で持ち `stepRow(rows, from, delta)` は行で受ける形に変更・整合判定の述語 `rowMatchesTab` を追加・「2 連射で 2 行進む」検査を Phase 3 に追加 / Live の入力は `liveFolderView(state).kind === 'list'` のときだけ Sidebar が組み立てて渡す形に変更、テスト項目を追加）。P1 は全部反映（`PrRow` に `data-url` を足すステップを Phase 2 に追加 / Peek の誤った前提を削除して「Peek 前面でも activeTabKey は親」に書き換え、決定表に「Peek は親に付いたまま裏に回る」を追加。Peek 用の検査 1 件は「足す修正」なので見送り / 各手のあいだに `until` を挟む・連打検査だけ await 無し、に書き換え / live-folder 節の末尾で PR タブを `closeTab`・行数は `readExpanded` の作法、を追記 / operations.md は `## サイドバーの3層` の末尾に決め打ち、VERIFY.md の人手確認のキー一覧にも足す）。P2 は 4 件とも反映（copy-url の前提を訂正 / `FAVORITE_SECTIONS` を import / collapsed 持ち上げの副作用をコメントに残す / VERIFY.md の言い分けを既存に合わせる）。Q は 2 件とも自分で決めて決定表に追記: 押しっぱなしの通過は間引かない（/dig-lite の「その場で開く」と一貫。Arc も同じ）/ サイドバー非表示中も効かせる（⌃Tab と同じ扱い。分岐を足さない）。

## 2回目

````text
plan を読み直し、前回の修正点（`stepRow(rows, from, delta)` / `rowMatchesTab` / Live は `kind === 'list'` のときだけ組み立て / `data-url` / Peek の前提訂正 / `until` / 後始末 / 決定表の追記）が実コードと噛み合うかを中心に見ました。

## P0
- `Phase 1 > 1` / `Phase 2 > 3` — 「同じ行」の識別子が一時タブで**化ける**。`ephemeralRows` は `defs.map(def => ({ def, tab: byDef.get(def.id) ?? null }))` なので、閉じた共有定義の行を通過して実体化した瞬間、位置はそのままに行が `{ kind: 'def', id }` → `{ kind: 'tab', key }` へ変わる（逆に、ローカルの `about:blank` 行が定義を得ると `tab` 行のまま `defId` が付く）。`stepRow` は `from` を「rows の中の同じ行」で探す設計なので、**決定表の主経路（閉じた定義の行はその場で開く）を 1 回通るたびに `from` が見つからず、次の一手で先頭 / 末尾へ飛ぶ**。しかも `currentRowIndex` の照合表は `key → pinnedId → favoriteId → url` で `ephemeralId` を見ないので、`rowMatchesTab` も def 行を照合できない。→ 一時タブ由来の行には `key`（あれば）と `defId`（あれば）を両方持たせ、`sameRow` / `rowMatchesTab` は「どちらか一致で同一行」にする。照合表に `tab.ephemeralId` を足す。`Phase 1 > 3` に「def 行が実体化しても `from` が追随する」「ローカル行が定義を得ても追随する」の 2 件を足す（今ある「`from` が rows から消えたとき」とは別のケース）。

## P1
- `Phase 2 > 3` — ref を捨てる規則が 2 手ぶんしか覚えず、キーリピートで破れる。「ref とも 1 手前とも違う行になったら捨てる」は 3 連射以上だと、2 手前ぶんの遅れた `pushState` が「どちらとも違う」に見えて ref を捨て、次の一手が先頭へ飛ぶ（P0 と同じ症状が別経路で出る）。「これから active になる行なら ref を信じる」も未来を見る規定で実装に落ちない。→ 「最後に確定してから自分が指した行のトレイル（配列）」を持ち、届いた `activeTabKey` がトレイルのどれかに一致する限り pending 扱い・一致しなければ捨てる、と書き下す。あわせて `Phase 3 > 1` の連打検査を 2 連射から 3〜4 連射にし、**1 つの `ev` の式の中でまとめて撃つ**（`ev` を分けると間に React の再描画が挟まり、ref が無い実装でも通って「実装前 FAIL」が見られない）。
- `Phase 3 > 3` — 期待値「最下段の一時タブから ↓ で Favorites / ピンの先頭に行き」が成立しない見込み。verify-pins は各節の `resetDefinitions()` で**全 Favorite・全ピンを消す**ので、同じアプリで後から回る live-folder の時点では両方 0 件の公算が高く、`collapseAll` 後の並びは一時タブだけになる。→ 前提 check（`shared.favorites` / `shared.pinned` が 0 件、`.lf-row` が 0 本）を置いたうえで、期待値を「↓ で並びの先頭＝最上段の一時タブへ回る」と「PR タブが増えない（`activeTabKey` の URL が `normalizePrUrl` で null）」に置き換える。
- `Phase 3 > 2` / `Phase 3 > 3` — 「各手のあいだに `until(activeTabKey === 期待値)`」が pins 節にしか書かれていない。split / live-folder の新しい節も同じ理由（`runCommandForVerify` は renderer の反映を待たない）で揺れる。→ 3 つの節すべてに明記する。

## P2
- `Phase 1 > 1` — 「無い」の表現が `currentRowIndex` の `-1` と `stepRow` の `null` の 2 系統に分かれている。`currentRow(rows, tab) → row | null` に揃えると Sidebar 側は「ref → だめなら currentRow → stepRow」の 1 本になり、index への添字も消える。
- `Phase 3 > 1` — Live Folder の前提 check「`shared.liveFolder` が null か `connect` 表示」は、「pins が live-folder より先に回る＝まだ PAT が無く `source === 'none'`」という暗黙の順序に依存する（成立はする）。`.lf-row` が 0 本であることを DOM で見れば view の種類が変わっても壊れない。
- `Phase 2 > 4` — `.lf-row[data-url="…"]` は URL をセレクタ文字列に埋めるので、`CSS.escape` を使うか `querySelectorAll('.lf-row')` + `find` で引く。

## Q

````

**対応**: P0 を反映（一時タブ由来の行を `{ kind: "ephemeral", key, defId }` の 1 種類にまとめ、`sameRow` は key / defId のどちらか一致で同一行・`rowMatchesTab` の照合表に `tab.ephemeralId` を追加・決定表に「一時タブ行の同一性」を追加・テストに「def 行が実体化しても追随」「ローカル行が定義を得ても追随」の 2 件と、verify-pins に EphemeralDefRow 通過後に先頭へ飛ばない検査を追加）。P1 は 3 件とも反映（ref を「自分が指した行のトレイル」に変え、activeTabKey が届くたびに一致するところまで切り落とし・一致しなければ空にする規則に書き下し。「未来を見る」規定は削除。連打検査は 1 つの `ev` の式の中で 3〜4 連射に変更 / live-folder 節は前提 check（Favorites / ピン 0 件・`.lf-row` 0 本）を置き、期待値を「最上段の一時タブへ回る」「PR タブが増えない」に置き換え / `until` を split・live-folder の節にも明記）。P2 も 3 件とも反映（`currentRow → row | null` に統一して index を廃止 / pins 節の Live Folder 前提 check を `.lf-row` 0 本の DOM 判定に変更 / `data-url` のセレクタは `CSS.escape` を通す）。

## 3回目

````text
plan を読み直しました。行の同一性（`{ kind: 'ephemeral', key, defId }` + `sameRow`）とトレイルの掃除規則（一致するところまで切り落とし・一致しなければ空）は、定常状態ではトレイルが 1 件に収束し、外部のクリックは必ず「一致なし → 空」に落ちるので破綻しません。残りは Phase 3 の検査が**書けるか / 何かを見ているか**の話です。

## P0

## P1
- `Phase 3 > 1`（`EphemeralDefRow` を通過する検査） — **1 ウィンドウでは def 行を作れない**。`removeTab` は `ephemeralId` を持つタブに対して `removeEphemeralEverywhere` へ委譲して**定義ごと全ウィンドウから消す**ので、「定義はあるがこのウィンドウに実体が無い」状態は他ウィンドウにだけ実体がある場合にしか生まれない。手順が書かれていないと、この検査（P0 の行の同一性を守る唯一の自走検証）が書けずに別物へすり替わる。→ ファイルに既にある `openSecondWindow()` で 2 枚目を開き、**そちらで `createTab`** して window 1 に def 行を出す、撃つのは window 1 の `ui`、後始末は既存ブロックに倣って `closeEphemeralTabs(other)` + `other.close()`（ウィンドウ自体は開いたままにする作法）— までステップに書く。前提節にも「`closeTab` は共有定義ごと消す」を 1 行足す。
- `Phase 3 > 1`（「タブがちょうど 1 枚増える」の位置） — 別の箇条書きとして後ろに置かれているが、その前の「1 手ずつ縦断」が**最初の ↓ で閉じている messages の Favorite を通過して実体化させる**（起点が tools の先頭 Favorite なので次の行がそれ）。後から測ると増分 0 で FAIL する。→ 増分は縦断の「その手」の前後で測る（独立したブロックにするなら手前で `resetDefinitions` + 状態を作り直す）と明記する。
- `Phase 3 > 3`（live-folder の循環） — 「`collapseAll` 後に最下段の一時タブから ↓ で最上段の一時タブへ回る」は、その時点の一時タブが 1 行以下だと出発点と到達点が同じ行になり、`until(activeTabKey === 期待値)` が即座に真になって**何も見ずに PASS** する（Favorites / ピンが 0 件という前提と組み合わさると起きやすい）。→ 節の頭で一時タブを 2 枚作り、前提 check を「`.lf-row` 0 本・`shared.favorites` / `shared.pinned` 0 件・一時タブが 2 行」まで広げてから撃つ。

## P2
- `Phase 2 > 3` — ephemeral 行を開く分岐（`key` があれば `selectTab(key)`、無ければ `openEphemeral(defId)`）を 1 行書いておくと迷いがない。今は行き先 API が種類ごとに並記されているだけで、1 種類にまとめた ephemeral 行だけ 2 択が残っている。
- `Phase 1 > 3` — `sameRow` に「`key` が両方 null / `defId` が両方 null を一致にしない」検査を 1 件足す。「どちらか一致」を素直に書くと `null === null` で全 def 行が同一行になる。
- `Phase 3 > 1`（連打検査） — 起点と期待到達行を明記する。閉じた定義を含む区間から 3〜4 連射するとタブが増え、前後の枚数を見る検査と干渉する。

## Q

````

**対応**: P0 なしで収束。P1 3 件を反映（EphemeralDefRow の検査は `openSecondWindow()` で 2 枚目を開いてそちらで `createTab` する手順と後始末を明記し、前提節に「closeTab は共有定義ごと消す」を追加 / 「タブが 1 枚増える」は縦断の最初の ↓ の前後で測ると明記 / live-folder 節は一時タブ 2 枚を作ってから、前提 check に「一時タブが 2 行」を追加）。P2 は 2 件反映（ephemeral 行の開き方の 2 択を 1 行で明記 / 連打検査の起点・到達行を全部開いている区間に固定）。`sameRow` の「null 同士を一致にしない」検査 1 件は「足す修正」なので見送り（実装時にテストへ入れる）。
