review session: d5fce06b-e4a4-4ff1-b935-f112f651d249

## 1回目

````text
実装を読みました。plan・決定表・既存実装と突き合わせた結果です。

## P0

## P1
- `src/renderer/components/Sidebar.tsx:moveRow` — トレイルに**起点の行を積んでいない**（`trail.current = [...trail.current, target]` で行き先だけ積む）/ トレイルが空の 1 手目は `trail=[target]` になるので、反映待ちの間に届く `activeTabKey` がまだ起点のままの state push（タイトル・favicon・読み込みの push は頻繁に来る）が掃除の effect で「別経路の移動」と判定されトレイルが捨てられる。次の一手は再び `currentRow(rows, activeTab)`=起点から解いて同じ行を撃つので、連打・キーリピートの**出だしで 1 手落ちる**（閉じた枠を開く手は実体化まで時間がかかるぶん踏みやすい。2 手目以降は起点が末尾に残るので起きない＝ verify の「1 つの `ev` で 3 連射」では露見しない）/ トレイルが空のときは `from`（非 null なら）も一緒に積んで `trail.current = trail.current.length ? [...trail.current, target] : [from, target].filter(Boolean)` の形にする
- `VERIFY.md:Live Folder（GitHub の PR）` / `scripts/verify-live-folder.mjs:小見出しの開閉` — 「開閉は React の state で、初回マウントと**再マウント（設定の再有効化**・再起動）で畳まれる」という記述が実装と食い違う / `collapsed` を Sidebar へ持ち上げた結果、`liveFolderEnabled` を false → true しても Sidebar は unmount しないので畳み直らない（`Sidebar.tsx` の `liveCollapsed` のコメントには「今は畳み直す契機は起動だけ」と正しく書いてあるが、VERIFY.md とスクリプト冒頭は前の説明のまま。この文言は前回のレビューで一度直された箇所）/ 両方から「設定の再有効化」を外し、「畳み直る契機は起動（＝ Sidebar の初回マウント）だけ」に揃える

## P2
- `src/renderer/components/Sidebar.tsx:scrollRowIntoView` — `CSS.escape`（識別子用のエスケープ）の結果を**引用符付き属性値**の中に埋めている / いまは `\:` `\/` 等が CSS 文字列内でも同じ文字に解決されるので結果的に動くが、意味の違う 2 つのエスケープ規則を混ぜている / 引用符付きにするなら `JSON.stringify(value)`、`CSS.escape` を使うなら引用符無しに揃える
- `scripts/verify-pins.mjs:runCommand` / `scripts/verify-live-folder.mjs:runCommand` — `runCommandForVerify` の戻り（`'ok' | 'no'`）を捨てている / コマンド ID の綴り違いや `MINI_BLOCKED_COMMANDS` への誤登録で `false` が返っても、FAIL は「4 秒待っても `activeTabKey` が変わらない」という遠い場所に出る / 節の最初の 1 発だけでも `'ok'` を check すると配線の切り分けが即座に付く
- `scripts/verify-pins.mjs:settleUi` — モジュール先頭の `settle`（同じ `sleep(250)`）と重複している / 同じ待ちが 2 つの名前で存在する / `settle` を使う
- `scripts/verify-live-folder.mjs:⌘⌥↑↓ の節` — 節の頭で**全ピン・全 Favorites・全タブを消す**破壊的な前処理を入れている / 後続の節（⑦ 打ち切り）は自前で状態を作るので今は通るが、この節を移動・削除すると前後が黙って壊れる関係ができる / 前提を作るのはよいが「消したものは節の末尾で戻さない」ことを節のコメントに明示しておくと、次に触る人が順序依存に気づける
- `src/renderer/components/LiveFolder.tsx:LiveFolder` — `const toggleBucket = onToggle` の別名が残っている / 持ち上げ前の差分を小さくするためだけの中継 / `onToggle` を直接呼ぶ
- `docs/plans/2026-09-04-1239-sidebar-row-navigation-cmd-opt-arrows.md:動作確認 [人間👨‍💻]` — 実キー（accelerator → `sendToUi` → renderer）の疎通は自走検証では踏めず未チェックのまま / DESIGN に書いた「ページ側にフォーカスがあっても効く」「サイドバーを隠していても効く」は現状どのテストも固定していない / コミット前に `mise run dev` で 3 項目を潰す

## Q
- `src/main/menu.ts:UI_COMMANDS` — **オーバーレイ（コマンドバー / ライブラリ / 設定）が開いている間も ⌘⌥↑↓ を効かせるか**が決定表に無い / 現状は効く。`sendToUi` はサイドバーとオーバーレイの両方へ送るため、コマンドバーを開いたまま押すと (1) 見えない裏で行が移り、閉じた枠なら**タブが黙って実体化**し、(2) `Overlay.tsx:CommandBar` の `useCommand` はコマンド種別を問わず `focus()` + `select()` するので入力中のクエリが全選択に戻る。⌃Tab と揃えて「効かせる」で確定するか、オーバーレイ表示中は `MINI_BLOCKED_COMMANDS` と同様に main で弾くかを決めないと、キーリピート中にコマンドバーが開いていたときの挙動が仕様として定まらない

````

**対応**: P1 2 件を反映（`moveRow`: トレイルが空の 1 手目は起点 `from` も一緒に積む / VERIFY.md と verify-live-folder.mjs 冒頭の「再マウント（設定の再有効化）で畳まれる」を「畳み直る契機は起動（Sidebar の初回マウント）だけ」に揃えた）。P2 は 4 件反映（`scrollRowIntoView` は引用符付き属性値に `JSON.stringify` でエスケープ / verify-pins の `settleUi` を既存の `settle` に寄せた（既存 Favorites 節の同名ローカルも同じ `settle` に統一） / verify-live-folder の節に「消したものは末尾で戻さない・節を動かすときは前後の前提を見直す」を明記 / `LiveFolder` の `toggleBucket` 別名を消して `onToggle` を直接呼ぶ）。見送り: `runCommand` の戻り `ok` を check する件は検査の追加なのでループ中は入れず終了報告に回す / 人手の実キー確認は plan の「動作確認 [人間]」に既にあり、コミット前にユーザーが行う。Q（オーバーレイ表示中）は「効かせる」で決定（⌃Tab も同じ。CommandBar が任意のコマンド受信で入力欄を全選択に戻すのは既存挙動で今回の範囲外）し、plan の決定表に追記した。

## 2回目

````text
再レビューしました。前回の P1 2 件・P2 4 件はいずれも反映を確認しています（`moveRow` の起点積み・`scrollRowIntoView` の `JSON.stringify` 化・`settle` への統一・verify-live-folder の破壊的前処理の但し書き・`toggleBucket` 別名の削除、VERIFY.md と `verify-live-folder.mjs` 冒頭の「畳み直る契機は起動だけ」への言い換え）。Q の決定も plan の決定表に追記済みです。`src/shared/sidebar-rows.js` と `scripts/sidebar-rows.test.mjs` は今回の対応で触っておらず（前回レビュー時のまま）、指摘もありません。

## P0

## P1

## P2
- `src/renderer/components/Sidebar.tsx:moveRow` / `Sidebar.tsx:useEffect（トレイルの掃除）`（plan `Phase 2 > Sidebar.tsx > トレイルの掃除`） — 起点を積んだことで「反映待ち」と「別経路で起点に戻った」が区別できなくなった / トレイルが `[起点, 行き先]` の状態（＝行き先がまだ active になっていない短い窓）で、その窓の中でクリックや ⌃Tab で起点へ戻ると、掃除の effect は起点との一致を「反映待ち」と読んでトレイルを保つ。次の ⌘⌥↓ は行き先の**次**へ進み、1 行飛ばす。行き先が確定した後なら `[行き先]` に切り詰められているので起点へ戻れば正しく捨てられ、窓は数十 ms なので実害は小さいが、plan の「別経路の移動ならトレイルを捨てて `state` から解き直す」とは意味がずれている / 反映待ちを行の一致で推測せず、invoke の在庫で持つ（撃つ前に `pending += 1`、`selectTab` 等の promise の `.then` で `pending -= 1`。掃除の effect は `pending === 0` なら常にトレイルを捨てる）と、起点を積む必要自体が無くなり両立する
- `docs/plans/2026-09-04-1239-sidebar-row-navigation-cmd-opt-arrows.md:決定事項（連打・キーリピート）`（plan `ログ > 方針変更`） — 決定表は「renderer が**自分が指した行**のトレイルを持つ」と書いたままで、実装が 1 手目に起点も積むようになったことが plan に残っていない / このファイルは `currentRow` の段階照合・`visibleLiveRows` の置き場という同種の乖離を「方針変更」に記録しており、ここだけ抜けると次に読む人は「行き先だけ積む」と読んでコードのコメントと食い違う / `ログ > 方針変更` に 1 行（1 手目は起点も積む・理由は反映待ちの push でトレイルが捨てられるため）を足す

## Q

````

**対応**: P0 なしで収束。P2 の plan 追記（1 手目に起点も積む理由と、反映待ちの窓の副作用）を「ログ > 方針変更」に反映。トレイルの反映待ちを invoke の在庫（pending カウンタ）で持つ案は仕組みの追加で、窓が数十 ms と実害が小さいので見送り（終了報告に回す）。
