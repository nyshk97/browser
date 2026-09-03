review session: 56e7b79a-72b2-4d4e-b5d6-42557ff33619

# polish-plan review log: shared-tab-follow-on-select

## 1回目

````text
docs/plans/2026-09-03-1000-shared-tab-follow-on-select.md をコードと突き合わせて確認しました。

## P0
- `Phase 2 > 2` — 起床直後の二重ロード。`materialize()` は `this.url` を更新しない（`registry.ts:638-656`。`sleep()` は `pendingUrl = this.url` で `url` を残す）ので、`applyVisibility()` が起こした直後に `def.url !== tab.url` を見ると**必ず不一致**になり、定義 URL を読み始めた実体にもう一度 `loadURL` が飛ぶ。「二重ロードしないことを確認する」ではなく、起床側で明示的に潰す設計にする（materialize が定義 URL を採用したら `this.url` にも入れる／起こしたキーを覚えて selectTab 側でスキップ）。
- `Phase 2 > 3` — 「`ephemeralId` 持ちなら定義の現在 URL 優先」を無条件でやると、`file:` を見たまま寝たタブが起床時に古い http へ飛ぶ。`canSyncDefinitionFromPage` で書き戻しを止めている以上、asleep の `pendingUrl` は `file://…` のまま定義は古い http を指しており、6de068b（ローカルファイル対応）の逆行になる。materialize 側にも追随と同じ述語を通し、書き戻せない URL のときは `pendingUrl` を優先する。
- `Phase 2 > 4` — beforeunload 抑止フラグの畳み方が無い。`will-prevent-unload` は beforeunload を持つページでしか飛ばないので、「ハンドラが見たら畳む」だと**大半のケースでフラグが立ちっぱなし**になり、次のユーザー起点の遷移が無言でキャンセルされる（`810f8b4` で直したバグの再発）。`did-start-navigation` / `did-navigate` / `did-fail-load` ＋保険のタイムアウトで必ず落とす（`loadURL` の同期区間で畳むのは不可。beforeunload は非同期で走る）。
- `Phase 2 > 4` — 追随の `loadURL` が reject する経路が未処理。beforeunload で止められると `ERR_ABORTED` で reject し、`src/main/index.ts:76` の `unhandledRejection` が `app.unhandled_rejection` を吐く → `harness.mjs` の `findUncaughtExceptions` が拾って verify-shared-tabs 全体が FAIL する。`materialize` の `void wc.loadURL(...)` を真似ず `.catch()` を付ける。
- `Phase 2 > 4` / `Phase 3 > 4` — 追随フラグの判定位置が `NEMO_VERIFY_UNLOAD_CHOICE` より後だと検査が成立しない。verify-shared-tabs は自分でアプリを起動し `...process.env` を渡す（`scripts/verify-shared-tabs.mjs:49-55`）ため、verify-all 経由では `leave` が入って `event.preventDefault()` → URL が変わり検査は FAIL、単体実行では env 無しで**本物のネイティブ modal** が開いて main が同期で固まりハングする。フラグ判定を `will-prevent-unload` ハンドラの先頭（verifyChoice / dialog より前）に置くことを Phase 2 の項目として明記する。
- `前提・わかっていること > 現行モデル` / `Phase 2 > 6` — 「通話ガードは本タスクと独立」は成立しない。追随は**参加中の実体を別 URL へ飛ばす新経路**で、両ウィンドウで実体化済み → 片方が Meet に参加 → もう片方で遷移 → 参加側でその行を選ぶ、で通話が切れる（ガードが防いでいた事象そのもの）。しかもガード自身の `focusEphemeralInstance` が `selectTab`（`registry.ts:3701`）を呼ぶので、ガード経路が追随を撃つ。`callWatcher.isJoined(tab)` なら追随しない、を決定表・実装・人間の動作確認に足す。

## P1
- `決定事項 > 追随条件` / `Phase 2 > 1` — 比較を `def.url !== tab.url` の生比較にすると、定義側は `normalizeStoredUrl`（`new URL().toString()`、4096 文字上限、`settings-schema.js:316`）を通った値なのに実体側は `wc.getURL()` 生値で、表記が割れる URL・4096 文字超の URL では**書き戻しが弾かれたまま毎回不一致**になり、1 ウィンドウ運用でも選択のたびに追随が撃たれる（本 plan が「何も起きない」と約束した所）。述語を `normalizeStoredUrl(tab.url) !== def.url`（null なら追随しない）にすれば `file:` ガードも兼ねられる。
- `Phase 2 > 2` — 呼ぶ位置は「`applyVisibility()` の後」では足りない。`selectTab` は `already` のとき `registry.ts:2448` で早期 return するので、`if (already)` より前に置かないと決定事項の「再クリックで乖離を解消する」が成立しない。plan に位置を明記する。
- `Phase 2 > 2` — `selectTab` の呼び出し元は人間の選択だけではない。`moveTabToWindow`（`registry.ts:3023`。ドラッグでウィンドウ移動した瞬間に別 URL へ飛ぶ）・タブを閉じた後の次タブ選択・`focusEphemeralInstance`（`:3701`）・ペインクリックの `input-event`（`:1903`）・タブスイッチャー・セッション復元が全部通る。どの経路で追随してよいかを一覧にして決めてから実装する。
- `Phase 3 > 4` — beforeunload の検査ページを test-pages に足すだけでは空振りする。Chromium は sticky user activation が無いと beforeunload のキャンセル自体を無視する（`verify-phase1.mjs:1171-1188` に実測メモあり）ので、ダイアログも `tab.follow_blocked` も出ないまま PASS しうる。CDP で listener を仕込み、実クリック相当を撃ってから追随を起こす verify-phase1 方式を踏襲する。新規ページを足す場合は `scripts/lib/verify-targets.mjs` の OWNERS 登録（`test-pages/local-*.html` と同じ行）も忘れない。
- `Phase 3 > 2` — 「`did-navigate` が発生しない」の計測手段が未定。診断ログにナビゲーション相当のイベントは無い（あるのは `tab.select` / `tab.foreground`）ので、ページ側マーカー（`window.__nemoFollowProbe`）が残っていることを見る形に決めておく。`tab.followed` の不在だけだと「追随以外の理由で読み直された」を見逃す。

## P2
- `Phase 2 > 5` — ログに URL を入れるなら、既存の main 側ログは `redactUrl(tab.url)` を通している（`registry.ts:3881`）。「先頭 scheme の形」ではなくその既存関数に合わせる。
- `Phase 2 > 1` — 戻り値 `boolean` は呼び出し側で使わないなら `void` でよい（「呼び出し側に条件分岐を書かない」という方針と整合する）。
- `動作確認` — 分割ビューの相方ペインは選択されないので追随しない（決定どおり）。実機確認に 1 行入れておくと、後から「片側だけ古い」を仕様と読み違えずに済む。

## Q
- `決定事項 > 履歴` — 追随で消える「そのウィンドウで見ていたページ」に逃げ道を用意するか。beforeunload の無いページ（大半）では未送信の入力・スクロール位置が無警告で失われる。決めないと、実装後に「戻るで戻れるからよい」で体験が固定される。
- `決定事項 > 履歴` — 追随後に「戻る」を押すと `did-navigate` → `syncEphemeralDefinition` で定義が古い URL に巻き戻り、次に別ウィンドウでその行を選ぶと今度は向こうが引き戻される（往復）。これを「最後に触った実体が勝つ」の当然の帰結として許すのか、追随起点の戻るだけ書き戻さないのかを決める必要がある。決めないと Phase 3 の「戻れる」検査の後段が定義を汚し、検査順で結果が変わる。
````

**対応**: P0 は全反映 — 二重ロード（materialize が定義 URL 採用時に this.url へ反映）、file: 寝起きの引き戻し（手元 URL が http/https のときだけ定義優先）、beforeunload フラグの畳み方（did-start-navigation/did-navigate/did-fail-load＋タイムアウト、判定はハンドラ先頭）、loadURL の .catch、通話ガード（isJoined 除外を決定表・Phase 2・人間の動作確認に追加）。P1 も全反映 — 比較を normalizeStoredUrl(tab.url) に変更（file: ガードを兼ねる）、selectTab の呼び位置（already 早期 return より前）を明記、発火経路は「全経路で有効・経路別フラグは作らない」を決定表に追加、beforeunload 検査は verify-phase1 方式（sticky activation）＋OWNERS 登録を明記、「追随しない」検査はページ側マーカー方式に変更。P2: redactUrl に修正・boolean 戻り値の細部を削除は反映、分割ビューの実機確認 1 行の追加は見送り（検査項目の追加はループ中は足さない → 終了報告へ）。Q は両方自分で決定 — 逃げ道は「戻る」のみで追加 UI は範囲外（/dig-lite の決定の帰結）、追随後の「戻る」は通常の書き戻し（書き戻さないと戻った直後の選び直しで再追随が起き戻る操作が取り消されるため）。いずれも決定表に追記済み。

## 2回目

````text
plan を読み直し、コード（`registry.ts` / `security.ts` / `json-store.ts` / `lib/cdp.mjs` / `call-coordinator.ts`）と突き合わせました。前回の P0/P1 は反映を確認できています。以下は今回の版で新たに見えたもの。

## P0
- `Phase 2 > 4` — フラグの解除に `did-start-navigation` を採っている。`loadURL`（browser-initiated）で `did-start-navigation` と `will-prevent-unload` のどちらが先に来るかは Chromium の内部順序に依存し、start が先に飛ぶ実装では**フラグが beforeunload 前に落ちてダイアログが出る**（抑止が黙って効かず、`NEMO_VERIFY_UNLOAD_CHOICE=leave` 下では URL まで変わって Phase 3 が落ちる）。加えて `did-start-navigation` はサブフレームでも飛ぶ（`http-auth.ts:136-141` が `details.isMainFrame` で弾いているのと同じ性質）ので、iframe を持つページでは main frame の beforeunload 前に解除されうる。順序に依存しない構成にする: 解除は (a) `will-prevent-unload` ハンドラ内（= キャンセル確定の瞬間。ここで畳まないと、抑止された直後のタイムアウトまでの間にユーザーが撃った遷移が無言でキャンセルされる）、(b) **main frame の** `did-navigate` / `did-navigate-in-page` / `did-fail-load`、(c) 保険のタイムアウト、の 3 つにして `did-start-navigation` は使わない。

## P1
- `Phase 1 > 2` — 親 plan に書き込む条件が旧版のまま（「file: ガード・完全一致比較・sleep 復帰も定義優先」）。決定事項は `normalizeStoredUrl` 経由の比較＋`null` ガード、sleep 復帰は「手元が http/https のときだけ定義優先」に変わっており、通話ガード・発火経路の行も無い。恒久ドキュメント側に古い決定が残ると、次に触る人がそちらを正とする。Phase 1 の書き込み内容を現行の決定表 7 行に合わせる。
- `Phase 2 > 1` — 追随の `wc.loadURL(def.url)` が `resolveNavigationTarget` を通っていない。`security.ts:99-102` は「呼び出し側は `loadURL` に生の文字列を渡さず、必ずこれを通す」を明文の不変条件にしており、`materialize` / popup / `createTab` はすべて通している。今は `def.url` が `normalizeStoredUrl` で http/https に閉じているので実害は無いが、ここだけ例外にすると定義 URL の出所が増えたとき（移行・同期・拡張経由）に穴になる。`resolveNavigationTarget(def.url, {}, 'follow')`（`allowFile` は付けない。null なら追随しない）を挟む。
- `Phase 3 > 2` / `Phase 3 > 4` — `connectTo`（`lib/cdp.mjs:88-96`）は URL の部分一致で**最初に見つかった target** を返す。同じ定義を 2 ウィンドウで実体化した直後は両者が同じ URL なので、マーカーや beforeunload リスナを A 側の実体に仕込んでしまう可能性がある。その場合「B を選んでもマーカーが残る」は当然成立し、**空振りのまま PASS** する。仕込む瞬間に両ウィンドウが同じ URL に居ない順序を決めておく（一致時の検査は実体を 1 ウィンドウだけにする／beforeunload は B だけ先に実体化して仕込んでから A を出す、など）。
- `Phase 3 > 5` — sleep のさせ方が未記載。`tabSleepMinutes` は設定なので `window.nemo.updateSettings` で縮める手筋（`verify-split.mjs` / `verify-peek.mjs`）になるが、**全ウィンドウの非表示タブが一斉に寝る**ため、仕込み中は `0` で sweep を止め、撃つ直前だけ短くし、終わったら元に戻す形にする。戻し忘れると後続の検査と「戻れる」検査の状態が寝落ちで揺れる。
- `Phase 3` — 通話ガード（`isJoined` 除外）が人間の動作確認だけになっている。決定表では追随を止める唯一の安全弁で、静かに壊れても誰も気づかない。verify-shared-tabs は自分でアプリを起動する（`appEnv` を組み立てている）ので、`NEMO_MEET_TEST_URL_PREFIX: ${PAGES}/meet-fake.html` を足せば `verify-call.mjs` と同じ手で参加状態を作れる。自走に載せるか、載せない判断ならその理由を plan に 1 行残す。

## P2
- `Phase 2 > 1` — `callWatcher` は注入前は null なので `callWatcher?.isJoined(tab)` で書く（既存の `isSleepExempt` 呼び出しと同じ形）。
- `Phase 2 > 3` — `this.url` に定義 URL を先に入れると、読み込みが失敗したときサイドバーは「行けなかった URL」を出す（既存の `pendingUrl` 経路と同性質なので許容でよい）。`tab.followed` / materialize 側の log に「どちらの URL を採用したか」を残しておくと事故調査が楽になる。

## Q
````

**対応**: P0 反映 — フラグ解除を「will-prevent-unload ハンドラ内 / main frame の did-navigate・did-navigate-in-page・did-fail-load / タイムアウト」の 3 点に変更し、did-start-navigation は不採用（順序依存・サブフレーム）と明記。P1 全反映 — Phase 1 の親 plan への書き込みを「本 plan の決定事項の表をそのまま反映」に修正（旧条件の残骸を削除）、追随の loadURL に resolveNavigationTarget(def.url, {}, 'follow') を明記、connectTo の URL 部分一致による仕込み先取り違え対策（一意になる順序）を「追随しない」「beforeunload」両検査に追記、sleep 手筋（tabSleepMinutes を 0→短縮→戻す）を追記、通話ガードの自走検証（NEMO_MEET_TEST_URL_PREFIX）を Phase 3 に追加。P2: callWatcher?.isJoined の表記は反映。materialize 側の「どちらの URL を採用したか」ログ追加は見送り（項目の追加はループ中は足さない → 終了報告へ。実装時に log detail へ含めるだけで済む話でもある）。

## 3回目

````text
plan を読み直しました。前回の P0（フラグ解除の 3 点・`did-start-navigation` 不採用）と P1（Phase 1 の反映方法・`resolveNavigationTarget`・`connectTo` の取り違え・sleep 手筋・通話ガードの自走検証）はいずれも反映を確認しました。残りは以下。

## P0

## P1
- `決定事項 > sleep 復帰` / `Phase 2 > 3` — 追随と sleep 復帰で述語が 2 種類ある。追随側は `normalizeStoredUrl(tab.url)` の `null` 判定でガードするのに、materialize 側は「手元の URL が http/https か」の生判定になっている。両者がずれるのは 4096 文字超の URL（`normalizeStoredUrl` が長さで `null` を返す = 定義へ書き戻せていない）で、追随は正しく見送るのに **materialize は「http/https だから」と古い定義 URL を読み、寝て起きただけでページを失う**。materialize 側も `normalizeStoredUrl(pendingUrl ?? this.url) !== null` を条件にして、述語を 1 つに揃える（決定表の文言も合わせる）。
- `Phase 3 > 6` — 通話ガード検査の前提が 2 つ抜けている。①`verify-shared-tabs.mjs` は自分でアプリを起動し `appEnv` を組み立てるので、`NEMO_MEET_TEST_URL_PREFIX: ${PAGES}/meet-fake.html` を**自分で足さない**と単体実行では Meet と判定されず、参加していない扱いで追随が走って FAIL する（`verify-call.mjs` は verify-all が起こした共有アプリに相乗りしているので不要だった）。②参加成立を待たずに選択すると同じく素通りするので、`call.joined` のログ待ち（`verify-call.mjs` と同じ）を挟む。加えて手順の順序: **参加後は `openEphemeral` の既存ガードが A 側の実体化を拒む**（`call.guarded` → `focusEphemeralInstance`）ので、先に A・B 双方で実体化 → B で参加状態へ → A で別 URL へ遷移、の順でないと乖離自体を作れない。

## P2
- `Phase 3 > 3` / `Phase 3 > 6` — 「最後に置く」候補が 2 つになった（「戻れる」は定義を汚す、「通話ガード」は参加中の実体が sleep 除外・close ガードで残る）。実装前に検査順を 1 本に決めて Phase 3 に書いておくと、後半の検査が前の残骸で揺れるのを防げる。
- `決定事項 > 発火経路` — セッション復元も有効経路と決めたが、自走検査は無い（「起動したら別ウィンドウの続きが出る」は体験として大きく、`verify-shared-tabs.mjs` は再起動を扱える）。ループ中に項目を足さない方針なら、終了報告に「復元経路は人間の動作確認のみ」と残しておくと次に拾える。

## Q
````

**対応**: P0 なし → 収束。P1 は両方反映 — sleep 復帰の述語を追随側と同じ normalizeStoredUrl（null 判定）に統一（決定表・Phase 2 とも）、通話ガード検査の前提 3 点（NEMO_MEET_TEST_URL_PREFIX を自分の appEnv に足す・call.joined 待ち・実体化→参加→遷移の順序）を追記。P2: 検査順の固定（「戻れる」「通話ガード」を末尾）を Phase 3 に 1 行追加。セッション復元経路の自走検査追加は見送り（項目追加はループ中は足さない → 終了報告へ）。
