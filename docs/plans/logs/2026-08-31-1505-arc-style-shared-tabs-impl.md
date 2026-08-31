review session: 9d053194-6494-4dca-9a3d-c7b6979c59f2
# polish-impl review log: arc-style-shared-tabs

## 1回目

````text
未コミット差分（27 ファイル / +1204 -227）と plan を突き合わせて読みました。以下、指摘です。なおサンドボックスの制約で `pnpm typecheck` / `node --test` / verify 系は実行できていないので、plan の「834 件 PASS」等は再現確認していません（静的レビューのみ）。

## P0
- `src/main/index.ts:whenUiReady（セッション復元のコールバック）`（plan `Phase 3 > ステップ1` / `ステップ3`） — `activeEphemeralId` が null のとき `wanted` が空になり、`chosen = active ?? win.normalTabs[0]` も空配列なので**タブを 1 本も実体化しないまま復元が終わる** / plan は「アクティブがピン / Favorite だった場合は保存しない（**復元は先頭定義へ倒す**。現行の `Math.max(findIndex, 0)` と同等）」と明記しており、Arc 風の使い方だとアクティブがピン / Favorite のウィンドウは日常的にあるため、再起動でそのウィンドウが空（emptyView）で立ち上がる。今の `verify-shared-tabs` の再起動検査は `beforeRestart.active` が非 null の前提なのでこの経路を踏まない / `activeEphemeralId` が null（または定義が消えている）ときは `getEphemeralTabs()[0]` を `wanted` に足して実体化し、それを選ぶ。あわせて「先頭定義へ倒す」ケースの検査を `verify-shared-tabs` の再起動セクションに足す
- `src/main/registry.ts:rebindEphemeralEverywhere`（plan `方針変更`「昇格時、他ウィンドウの実体は新定義へ付け替える」） — 他ウィンドウの実体に `pinnedId` / `favoriteId` を直接代入していて、**その実体が分割に入っていても `separateSplit` を通していない** / 「ピン留め / Favorites は分割に入れない」は `togglePin` :3420 と `addFavoriteFromTab` :3444 が昇格の手前で解いて守っている不変条件で、ここだけ抜けている。破れると `Sidebar.tsx:ephemeralRows` が `pinnedId !== null` の行を一覧から落とすため、**画面には分割が出ているのに解除する導線が無いウィンドウ**ができる（`Sidebar.tsx` のコメントに既知の事故として書かれている状態そのもの） / 付け替える前に `separateSplit(win, tab.key)` を通す（rival でローカルに倒す枝でも同じ）。「2 ウィンドウで開いた定義の片方を分割に入れ、もう片方で ⌘D」を `verify-shared-tabs` に足す
- `scripts/verify-session-migration.mjs:V2_SESSION`（plan `Phase 3 > ステップ7`） — plan が要求する「**複数ウィンドウ・野良タブ入り**の旧版 fixture」が無い。既存の 3 つの fixture は「1 ウィンドウ + 野良タブ」「1 ウィンドウ + splits」「2 ウィンドウだが 2 枚目はピン留めタブだけ（丸ごと落ちる）」で、`migrateLegacyWindows` が 2 件以上の legacy ウィンドウを処理する経路が一度も走らない / 「全ウィンドウの野良タブを出現順に結合」「ウィンドウごとに `activeEphemeralId` を割り当てる」が移行の中核仕様なのに未検証で、`defIds[win.activeIndex]` の取り違えや結合順の崩れが検知できない（版 4 の 4 本検査は 1 ウィンドウぶんしか見ていない） / 2 ウィンドウそれぞれに野良タブを持つ旧版 fixture を足し、`ephemeralTabs` の URL 列が出現順に結合されること・各ウィンドウのアクティブが自分のタブを指すこと・2 回目起動で件数が増えないことを見る

## P1
- `src/main/registry.ts:assignDefinition` / `src/main/registry.ts:rebindEphemeralEverywhere` — 降格して所属を失うタブに共有定義を与えていない経路が 2 つある（同ウィンドウの先客を `demoteTab` する冒頭ループと、rival で `tab.customTitle` だけ写してローカルに倒す枝） / `demoteEverywhere` は「消えた定義 1 つにつき定義 1 本」を作って束ねているのに、この 2 経路だけ定義なしのローカル行になる。ローカル行は他ウィンドウに出ず `toSaved()` にも載らないので、**同じ URL のタブを別ウィンドウから ⌘D しただけで既存タブが再起動で消える** / 両経路とも `demoteTab` の直後に `ensureEphemeralDefinition(other)` を通す（`demoteEverywhere` と同じ扱いに寄せる）
- `src/main/registry.ts:NemoWindow.sharedState` — `ephemeralTabs` を `SharedState` に相乗りさせたため、**共有定義と無関係な通知でも全定義（各 ≤2KB の favicon 込み）が全ウィンドウへ飛ぶ** / `onDownloadsChanged` はダウンロード中 `item.on('updated')` ごとに発火し（`downloads.ts:118`）、そのたびに `pushShared()` → renderer は `setState` で新しいオブジェクトを受けるので `ephemeralRows` の `useMemo` も毎回無効化される。定義は数十〜数百まで伸びうる（伸びは自動アーカイブ任せ = plan の決定）ので、ピン留め（ユーザー操作でしか変わらない・件数も少ない）の前提のまま乗せると桁が変わる / `ephemeralTabs` だけ別チャンネル（`nemo:ephemeral-tabs`）に切るか、`pushShared` 自体を 1 tick 合流させる。少なくとも `onDownloadsChanged` 由来の push に定義を積まない形にする
- `src/main/registry.ts:removeEphemeralEverywhere` / `src/renderer/components/Sidebar.tsx:ephemeralRows` — `tab.ephemeralId` が実在しない定義を指す状態に**どちらも保険が無い**。`removeEphemeralEverywhere` は `findEphemeralTab` が null なら即 return するので `removeTab` が黙って何もせず、`ephemeralRows` は定義側にも「ローカル行」側（`ephemeralId === null` で絞っている）にも出さないので行が消える / 結果は「サイドバーに出ないのに閉じられないタブ」で、原因を追う手がかりも残らない。`addEphemeralTab` は `store` が null でも id 付きの def を返すため（`store?.set(...)` を素通り）、この状態は実際に作れる / `addEphemeralTab` は `store` が無ければ null を返す。`removeEphemeralEverywhere` は定義が見つからないとき `log` を 1 行残して通常の `removeTab` へ落とす。`ephemeralRows` の末尾併記の条件を「`ephemeralId === null` **または定義が見つからない**」にする

## P2
- `scripts/verify-shared-tabs.mjs:check`（212 / 309 / 408 行の `check(name, true)`） — 直前の `waitForDef` に判定を任せた常真の check が 3 件ある / `verify-packaged.mjs` に前例はあるが、こちらは待ちが timeout すると**その場で例外 → 以降の全セクションが走らない**ので、FAIL 1 件ではなく検査打ち切りになる。件数（32 件 PASS）も 3 件ぶん実体が無い / `waitForDef` に `{ throwOnTimeout: false }` 相当を持たせて結果を `check` に渡すか、待ちの後に「定義の url が新しい値になっている」を実データで確かめる
- `scripts/verify-shared-tabs.mjs`（アーカイブ検査） — plan `Phase 6` の「アーカイブの記録が **1 行だけ**（波及 close の重複記録検知）」に対し、実装は `JSON.parse(rows).length >= 1` で重複を検知できない / `archiveTab` は `ON CONFLICT(url) DO UPDATE`（`store/archive.ts:28`）なので同じ URL の行はそもそも 2 本にならず、この検査項目は原理的に成立しない。重複記録の実質的な検知は直後の「⌘⇧T を 2 回押しても定義 1 本」が担っている / plan のログ側を実態に合わせて訂正する（アーカイブは UPSERT なので重複検知は ⌘⇧T 側で担保、と 1 行残す）
- `scripts/verify-phase1.mjs`（セッション復元セクション） — 旧「前回のタブが戻っている」が `urls.length >= 1` に置き換わっている / 直前に共有一覧側の実質検査を足しているので穴は塞がっているが、`urls.length >= 1` は「アクティブだった定義は実体化して戻る」という名前に対して何も確かめていない（どのタブでも通る） / `urls[0]` が保存時のアクティブ定義の URL と一致することまで見る
- `src/main/ipc.ts:nemo:move-tab-to-new-window` — メニュー・キーバインドを落としてユーザー導線が消えたのに、IPC / preload / `NemoUiApi` 側には「検証機構としてだけ残している」旨の記述が無い / plan のログにしか理由が無いので、次に触る人が「使われていない口」として消し、`verify-peek` / `phase1` / `phase2` / `split` の 4 本が同時に落ちる / ハンドラの上に「ユーザー導線は廃止。自走検証が実体移送に使うので残す」と 1 行書く

## Q
- `src/main/registry.ts:attachTabEvents`（`wc.on('destroyed')` の自己 close） / `src/main/extensions.ts:removeTab` — ページ自身の `window.close()` と拡張の `chrome.tabs.remove` が `removeTab` を通り、結果として**定義ごと全ウィンドウから消える**経路になっているが、決定表がカバーしているのは「⌘W・×」だけ / ⌘W と同じ扱いでよいのか、それとも自己 close は「そのウィンドウの実体だけデタッチ」にするのかが未決。放置すると、OAuth の戻りページや「このタブを閉じる」ボタンを持つサイトで、別ディスプレイのウィンドウからもタブが黙って消える
- `src/main/call-coordinator.ts:startCallCoordinator`（`isJoined`） — プローブが読めなくなった縮退状態では `joinedAt` を保つ設計なので、`isJoined` が **true のまま固定されうる** / この状態のタブは他ウィンドウから開くことも閉じることもできず、毎回フォーカスだけが飛ぶ。逃げ道は「参加中のウィンドウから閉じる」だけ。縮退が続いたときに何分でガードを諦めるか（あるいは諦めないか）は運用の判断が要る
````

**対応**: P0 3 件反映: (1) 復元で activeEphemeralId が null / 定義消失のウィンドウは先頭定義へ倒すフォールバックを index.ts に追加し、9b 検査（アクティブがピンだったウィンドウが空にならない）を追加 (2) rebindEphemeralEverywhere で付け替え前に separateSplit を通し、5b 検査（他ウィンドウの分割が解かれてピンに付く）を追加 (3) verify-session-migration に複数ウィンドウ fixture（結合順・ウィンドウごとの active・冪等）を追加。P1: (1) assignDefinition の同ウィンドウ降格と rebind の rival 枝にも ensureEphemeralDefinition を通した (3) addEphemeralTab の store 未初期化ガード・removeTab の壊れた参照フォールバック（ログ + 通常削除へ）・Sidebar のローカル併記条件を「定義が見つからない ephemeralId も含む」に拡張。(2) SharedState 相乗り（downloads 更新のたび全定義送出）は別チャンネル化 = 仕組みの追加なのでループ中は見送り、終了報告へ。P2: 常真 check 3 件を実データ判定へ・plan のアーカイブ検査記述を UPSERT 実態に訂正・phase1 は「各ウィンドウのアクティブ定義が実体化して戻る」に（提案の URL 固定は後続スイートの write でアクティブが変わるため不可）・move-tab-to-new-window の IPC / preload に「検証機構として残す」コメント。Q 2 件は自分で決定して決定表に追記: 自己 close / chrome.tabs.remove も「タブを閉じる」の一種で定義ごと削除（スクリプトが閉じられるのは自分で開いた window = 定義を持たない Peek / 小窓のみで、実質は拡張のタブ削除 = ⌘W 相当）／縮退中も joinedAt が残る限りガードは諦めない（sleep 除外と同じ保守側）。確認: typecheck / lint クリーン、verify-shared-tabs 34 件 PASS（新検査 2 件込み）、verify-session-migration 26 件 PASS。フレーク: 修正後初回の shared-tabs が waitForDef timeout で 7 件時点中断（再実行で全 PASS・再現せず）

## 2回目

````text
前回の指摘の反映を、コードと plan を読み直して確認しました。P0 3 件（復元の先頭定義フォールバック + 9b 検査 / `separateSplit` を通した付け替え + 5b 検査 / 複数ウィンドウ移行 fixture）、P1 の (1)(3)、P2 4 件、Q 2 件の決定表反映まで、いずれも該当箇所に入っています。見送った P1(2)（`SharedState` 相乗り）は理由が妥当なので再指摘しません。検査件数も静的に数え直して整合を確認しました（shared-tabs = 34 の call site、session-migration = 20 + ヘルパ 4 回 + 2 回 = 26）。

## P0

## P1
- `src/main/index.ts:whenUiReady（セッション復元のコールバック）` — 復元時の実体化ルールを変えた（`byDef.size === 0` なら先頭定義を実体化する）のに、再検証は `verify-shared-tabs` と `verify-session-migration` の 2 本だけ / この経路は `restart` ターゲットの 7 本（`spike --storage-read` / `phase1 --session-read` / `pins --lazy-read` / `live-folder --restart-read` / `split --restart-read` / `http-auth --restart-read` / `call --position-read`）が全部通る。アクティブがピン留め・ローカルタブだったウィンドウには**復元直後のタブが 1 本増える**ので、復元後の `tabs` を数えたり「タブが無い」を前提にしている検査は前提が変わる（読んだ範囲では `verify-split` の owner 判定と `verify-pins` の lazy-read は無事だが、7 本すべては追い切れない）。plan の「フル自走検証 834 件 PASS」も修正前の数字 / 少なくとも `mise run verify:only restart`、可能ならフルを回し直して、plan の件数を実測で更新する

## P2
- `src/main/registry.ts:rebindEphemeralEverywhere` — rival 枝の `ensureEphemeralDefinition` は**ウィンドウごとに新しい定義を作る**ので、2 つ以上のウィンドウが rival になると同じ URL の行が N 本並ぶ / 同じ状況を `demoteEverywhere` は `ephemeralByDefinition` で「消えた定義 1 つにつき定義 1 本」に束ねており（plan の「実体ごとに作ると同じ URL の行が N 本並ぶ」への対応）、rebind だけ規則が違う。踏むのは「同じ共有定義を 2 窓で実体化していて、その両方に昇格先の定義のタブが既にいる」という狭い条件なので実害は小さい / rebind でも定義を 1 本だけ作って全 rival を束ねる（`demoteEverywhere` と同じ型にする）
- `docs/plans/2026-08-31-1241-arc-style-shared-tabs.md:Phase 6 > ステップ2`（および `Phase 3 > ステップ7`） — 検査件数が **32 件 / 21 件** のままで実測（34 / 26）と食い違い、今回足した 5b・9b の 2 件も検査項目リストに無い。`Phase 3 > ステップ7` にも複数ウィンドウ fixture を足したことが書かれていない / VERIFY.md が「実行件数を報告に出す」「足した check が全部走ったかは **check 名で突き合わせる**」を運用規則にしているのに、plan 側の記録が実態とズレると次回の突き合わせの基準が効かない / 件数を実測へ更新し、「昇格の付け替えで他ウィンドウの分割が解ける」「アクティブがピン留めだったウィンドウは先頭定義へ倒す」「版 4 複数ウィンドウの結合順・ウィンドウごとの active・冪等」を項目に足す
- `docs/plans/2026-08-31-1241-arc-style-shared-tabs.md:方針変更（昇格時の実体の付け替え）` — 「付け替え先に先客がいるウィンドウだけ**ローカルに倒す**」という記述が実装と食い違う（今は共有定義を作り直してから倒す。`separateSplit` を通すようになったことも未記載） / この方針変更の段落が `rebindEphemeralEverywhere` を後から読むときの唯一の根拠なので、古い記述のままだと「定義なしのローカル行にするのが意図」と読めてしまい、今回直した P1 が元に戻される / 「先客がいるウィンドウは新しい共有定義を作って倒す（定義なしのローカル行は他ウィンドウに出ず再起動で消えるため）。付け替える側は分割を解いてから付ける（ピン留め / Favorites は分割に入れない）」に更新する

## Q
````

**対応**: P0 空 → 収束。収束回で反映した P1/P2: (P1) 復元経路の変更に対する再検証としてフル自走検証を回し直し、plan の件数を実測へ更新（下の動作確認参照） (P2-1) rebindEphemeralEverywhere の rival 枝を demoteEverywhere と同じ「1 回につき定義 1 本に束ねる」型へ書き換え (P2-2) plan の検査件数を 34 / 26 へ更新し、5b・9b・複数ウィンドウ fixture を検査項目リストに追記 (P2-3) 方針変更の段落を実装（separateSplit・共有定義を 1 本作って倒す）に合わせて更新。

**動作確認の追記**: フル自走検証を回し直した。verify-shared-tabs 34 件 PASS・verify-session-migration 全 PASS を含め、FAIL は Live Folder の「小見出しの右クリックはメニューを出すだけで開閉も再取得もしない」1 件のみ。フレーク: 今回の差分と無関係（Live Folder の小見出しコンテキストメニュー）で、`--only live-folder restart` の再実行で全 PASS（exit 0）→ pass 扱い。
