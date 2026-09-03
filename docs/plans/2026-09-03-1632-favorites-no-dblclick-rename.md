# Favorites（messages / tools）のダブルクリックで名前変更に入らないようにする

## 概要・やりたいこと

サイドバー上部の Favorites グリッド（`messages` / `tools` の 2 セクション）は、セルをダブルクリックすると
グリッドの下に名前の入力欄が出て表示名の変更に入る。枠を押して開くつもりでうっかり 2 回押すと
編集モードに入ってしまい、意図しない導線になっている。

**Favorites のダブルクリックでは名前変更に入らない**ようにする。名前変更は右クリック →「名前を変更」だけにする。
あわせて、ダブルクリック判定のためだけに存在していた「閉じている Favorite の単クリックの 250ms 遅延」も外し、
押した瞬間に開くようにする。

ピン留め行・一時タブ行のダブルクリックリネームは今までどおり残す（対象外）。

## 前提・わかっていること

### コード調査で確認済みの事実
- 直接の導線は `src/renderer/components/Sidebar.tsx` の Favorites セル（`<button className="fav">`）の
  `onDoubleClick`（`cancel()` → `editName(favorite.id)`）。同じセルの `onClick` は
  「閉じている枠だけ `schedule(...)` で 250ms 遅らせて開く」作りで、これは `dblclick` と取り合わないためだけの遅延
- 遅延の実装は `src/renderer/components/InlineRename.tsx` の `useDelayedClick`（`CLICK_DELAY_MS = 250`）。
  `PinnedTree.tsx` でも使っているので**フックそのものは残す**（Sidebar 側の利用だけ外す）
- `openFavorite`（`src/main/registry.ts:3648`）は既にそのウィンドウに実体があれば `selectTab` するだけで冪等。
  遅延を外してダブルクリックで 2 回飛んでも「開く → 選択」になり、タブは 1 つしか増えない
  （IPC は main で直列に処理され、`createTab` は同期なので 2 発目は必ず既存を見つける）
- 右クリックメニューの「名前を変更」（`editName`）と、その下に出る `fav-edit` の入力欄はそのまま使う
- ピン留め行（`PinnedTree.tsx`）・一時タブ行（`TabRow.tsx`）・分割行（`SplitRow.tsx`）のダブルクリックは
  別コンポーネントで独立しており、今回触らない
- 自走検証 `scripts/verify-pins.mjs` の Favorites 節に、**今回消す挙動を固定している検査が既にある**:
  「閉じている Favorite のダブルクリックで編集に入る」「そのときタブは増えない（Favorites 側でも単クリックの遅延が効いている）」の 2 件。
  続く「Favorites のインライン編集が定義に反映される」は dblclick で開いた `.fav-edit .rename` に値を流し込む作りなので、
  入力欄が無くなると `setter.call(null, …)` で例外になりスイートがそこで止まる（以降の検査が走らない）。
  Phase 1 を入れた時点でこのブロックは**書き換え必須**
- 同ファイルの「フォルダのダブルクリックでは編集に入らない」ブロック（`.row.folder` に `window.__nemoVerify.doubleClick` を撃って
  `.rename` が無いことと状態が元のままなことを見る）が反転後の雛形になる
- `verify-pins.mjs` の `settle()` は 250ms で `CLICK_DELAY_MS` と同値、`state()` の CDP 往復も乗るので、
  「クリック後に settle して見る」では旧実装（遅延あり）でもタブができていて PASS してしまう。遅延撤去の検査は経過時間で見る必要がある
- Favorites 節は定義が 2 件あり、1 回目のダブルクリックで先頭セルが開いて `.closed` が外れる。`.fav.closed` で拾い続けると後続の検査が別セルに当たる
- `Sidebar.tsx` は `OWNERS` に未登録（`kind: 'full'` に倒れる安全側）。**新たに載せない**（CLAUDE.md の規則）
- ドキュメントの記述: `docs/operations.md:29`「**どの行もダブルクリックで名前を変えられる**」、
  `VERIFY.md` の pins 節（`閉じているピン行をダブルクリック…` の隣）

### 決定事項（/dig-lite で確定）
| 論点 | 決定 |
| --- | --- |
| 対象範囲 | **Favorites（messages / tools のグリッド）だけ**。ピン留め行・一時タブ行のダブルクリックリネームは残す |
| 名前変更の導線 | 右クリック →「名前を変更」のみ |
| 単クリックの遅延 | **外す**。閉じている枠も押した瞬間に開く。ダブルクリックしても `openFavorite` が冪等なので開くだけ |
| ダブルクリック時の挙動 | 何も特別扱いしない（`onDoubleClick` ハンドラ自体を消す。2 回の click がそれぞれ `openFavorite` を呼ぶだけ） |
| リネーム導線の 2 系統化 | 今回で「フォルダ・Favorites ＝ 右クリックのみ / ピン留め行・一時タブ行 ＝ ダブルクリック可」に割れるが、これを**現状の規則としてそのまま書く**（暫定扱いにしない）。ピン留め行・一時タブ行を右クリックのみへ揃えることや、ピン留め行に残る 250ms 遅延の扱いは**今回の範囲に入れない**（/dig-lite で「Favorites だけ」を明示的に選んでいる。1回目で決定） |

## 実装計画

### Phase 1: Sidebar の Favorites セルから導線と遅延を外す [AI🤖]
- [x] `src/renderer/components/Sidebar.tsx`
  - [x] Favorites セルの `onDoubleClick` を削除
  - [x] `onClick` を「開いていても閉じていても即 `openFavorite`」にし、`schedule` を使わない
  - [x] `onContextMenu` 内の `cancel()` を外す（待たせているクリックが無くなるため）
  - [x] `useDelayedClick` の import と `const { schedule, cancel } = useDelayedClick()` を撤去
    （`git grep useDelayedClick` で `PinnedTree.tsx` 側の利用が残ることを確認し、フック本体は消さない）
  - [x] `onClick` の「閉じている枠のクリックだけ遅らせる」コメントを、なぜ開閉で分岐しないか（`openFavorite` が開く / 選ぶを吸収する・ダブルクリック導線が無いので遅延も不要）に書き換える
- [x] `InlineRename.tsx` の `useDelayedClick` の doc コメント（「閉じているピン / Favorite」）から Favorite の記述を外す
- [x] `npm run typecheck` / lint（プロジェクトの `mise` タスクに従う）

### Phase 2: 自走検証を書き換える [AI🤖]
- [x] `scripts/verify-pins.mjs` の Favorites 節にある既存ブロック（「閉じている Favorite のセルも、ダブルクリックでタブを増やさずに編集へ入る」）を**書き換える**（新規追加ではない）
  - [x] 対象セルは `shared().favorites[0].id` を取って `.fav[data-id="…"]` で固定する（`.fav.closed` で拾い続けない）
  - [x] ダブルクリックの 2 件を反転: 撃ってから `CLICK_DELAY_WAIT_MS` 待ったうえで、`.fav-edit .rename` が**出ていない** / タブが**ちょうど 1 つ**増える（`前 -> 後` を詳細に出す。0 なら開いていない、2 なら冪等が壊れている）。待ちを外すと遅れて出る入力欄の退行を見逃し、タブ数も反映前に数えて偽 FAIL する
  - [x] 遅延撤去の決定打: `shared().favorites[1].id` で固定した別の閉じているセルに `click` を 1 回撃ち、eval が返った直後を `t0` にして `waitFor`（`interval` 30ms 程度・`timeoutMs` 3000ms）でタブ増加を待ち、
    経過時間 `elapsed < CLICK_DELAY_MS` を check する（detail に `${elapsed}ms`。旧実装なら 250ms 超で FAIL）。`waitFor` が時間切れになったら `catch` して check の FAIL に落とす（throw させるとスイートが止まり、修正前の FAIL 3 件を観測できない）。`settle()` 待ちでは旧実装でも PASS してしまうので使わない
  - [x] 「Favorites のインライン編集が定義に反映される」は、右クリック →「名前を変更」で `.fav-edit .rename` を開いてから値を入れる形に付け替える（フォルダ検査の右クリック手順が雛形）
  - [x] ブロック冒頭の「ピン行と同じ規則がグリッド側にも効いているか」のコメントを、グリッドはダブルクリックでリネームしない規則に書き換える
  - [x] ブロック末尾で開いたタブを閉じる（`closeEphemeralTabs()` か `closeTab`）。`resetDefinitions()` だけだと定義を失ったタブが一時タブとして残り、次ブロックの先頭行がずれる
- [x] **修正前の FAIL を確認**: `git show HEAD:src/renderer/components/Sidebar.tsx > src/renderer/components/Sidebar.tsx` で
  Sidebar だけ HEAD に戻して `mise run verify:only pins` を回す。**期待する FAIL は 3 件**（反転した 2 件＋遅延の決定打 1 件）。
  件数が合うことを見てから自分の版に戻す（`cp` で退避 → 書き戻し → `cp` で復帰。stash は使わない）
- [x] 修正後に `mise run verify:only pins` を回し、**実行した検査の件数**（書き換え前後の総件数 `N 件 → M 件` を併記。列挙だけでは検査が減っているのを捕まえられない）と PASS を報告に出す
- [x] 既存の「閉じているピン行のダブルクリックで編集に入る」「既に開いている専用タブの選択は遅延しない」「フォルダのダブルクリックでは編集に入らない」が変わらず PASS すること

### Phase 3: ドキュメント [AI🤖]
- [x] `docs/operations.md:29` の「どの行もダブルクリックで名前を変えられる」を、
  「ピン留め行・一時タブ行はダブルクリックで名前を変えられる。**フォルダと Favorites は右クリック →「名前を変更」だけ**（Favorites の枠は押した瞬間に開く）」に書き換え
  （フォルダは 2026-08-24 の変更で既に右クリックのみ。現行の文はフォルダについても誤っている）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` → `### 変更` に 1 行（体言止め。ダブルクリックでは名前変更に入らなくなった・閉じている枠も押した瞬間に開く・名前変更は右クリックから）
- [x] `VERIFY.md` の pins 節「UI 操作（合成イベント）」に Favorites のダブルクリックの項目を追記
  （閉じている Favorite をダブルクリックしても編集に入らず、タブは 1 つだけ増える / 単クリックは遅延しない / 右クリックからは名前を変えられる）。
  同じ節に phase1 の項目リストに紛れている「フォルダのダブルクリックでリネームに入らないこと」（実体は `verify-pins.mjs`）も移す
- [x] `VERIFY.md` の手動確認「4. ダブルクリックでのリネーム」に「Favorites は対象外（右クリックから）」を足す
  （書かないと人間が Favorites をダブルクリックして「リネームが壊れた」と報告する）
- [x] `DESIGN.md` の「名前を変える」節を直す（ダブルクリックで変えられるのはピン留め・一時タブだけ / フォルダと Favorites は右クリックのみ / 250ms の遅延は閉じているピンだけで Favorites は即開く）
- [x] `docs/plans/2026-08-24-2014-pins-favorites-rename.md` の「どれでも行をダブルクリックして…」は当時の記録として触らない

### 動作確認 [人間👨‍💻]
- [ ] dev 版（`mise run dev`）で messages / tools のセルを実マウスでダブルクリックし、名前の入力欄が出ず、そのページが開くだけであること
- [ ] 閉じている枠を単クリックしたとき、以前より体感で即座に開くこと
- [ ] 右クリック →「名前を変更」で入力欄が出て、Enter で確定・Esc で取消できること（導線が残っていること）
- [ ] ピン留め行のダブルクリックリネームが今までどおり動くこと（巻き込みが無いこと）

## ログ
### 試したこと・わかったこと
- 修正前の FAIL 確認（Sidebar.tsx だけ HEAD に戻して `mise run verify:only pins`）: 期待どおり 3 件 FAIL
  （ダブルクリックで編集に入る / タブが `0 -> 0` / 単クリック 267ms > 250ms）。修正後は 138 件すべて PASS
  （単クリック 4ms・タブ `0 -> 1`）。スイートの検査件数は HEAD 版の 136 件 → 138 件（ブロック内 3 件 → 5 件）
- polish-impl 1 回目で `DESIGN.md`「名前を変える」節が旧仕様のまま残っていた指摘を受けて修正。plan の Phase 3 に列挙し損ねていた（UI 規則を変えるときは DESIGN.md も計画に入れる）

### 方針変更
（実装中に随時追記）
