review session: 2dd5a100-4d9a-4e10-bffa-183b558a2782

## 1回目

````text
## P0
- `src/shared/chrome-storage-onchanged.js:ledgerTake`（Phase 3 > ステップ 3「ネイティブ転送 + ブロードキャストの重複排除」） — `source` が違いさえすれば消すので、**self と broadcast が突き合ってしまう**。SW は native が鳴かないので、自分の書き込みが積んだ `self` 項目は誰にも消化されず 1.5 秒残り、その間に popup が同じキーを書くと broadcast がその項目を消して**配信されない**（逆に、broadcast を受けた直後の SW 自身の同キー書き込みも飲まれる）。これは今回直したかった「popup の解除が SW に伝わらない」の再発そのもの。自分の broadcast は自分に返ってこない（popup→popup が 1 件で収まっている実測がその証拠）ので、突き合わせるのは **native ↔ self / native ↔ broadcast の組だけ**にし、self ↔ broadcast は決して消さない。既存のユニットテストはそのまま通り、「SW（native 無し）で self の直後に同内容の broadcast が来たら 2 回配る」を 1 本足せば固定できる。
- `src/shared/chrome-storage-onchanged.js:area.remove` / `area.clear`（Phase 3 > ステップ 2「`set` / `remove` / `clear` をラップ」） — 事前の `get` を **await してから** `originalRemove` / `originalClear` を呼ぶので、実際の削除が IPC 1 往復ぶん後ろにずれる。`remove('a')` の直後に `set({a: 1})` を呼ぶと set が先に処理されて削除が後から効き、**書いた値が消える**（Chrome は同一 area の操作順を保証するので拡張はこの順序に依存してよい）。`get` を投げるところまでは同じにして、**await せずに同じターンで `originalRemove` を呼ぶ**（`const snapshot = getAsync(...)` → `wrapCall(originalRemove, …, () => void snapshot.then((existing) => afterWrite(…)))`）。storage は FIFO なので snapshot は削除前の状態を返し、順序も保たれる。

## P1
- `scripts/verify-ext-smoke.mjs:5c ブロック（extension.sw_console の検査）` / `test-extension/background.js:onMessage（console-error 分岐）`（Phase 0 > ステップ 3） — SW 自身が `chrome.runtime.sendMessage({type:'console-error'})` を投げているが、**送信元コンテキストには配られない**うえ popup はこの時点で閉じているので、この分岐は一度も走らない（走ったら `message.value` が `undefined` で `nemo ci error undefined` という URL を含まない行が増え、`swConsole.every((l) => l.includes('https://example.com'))` が **FAIL** する）。plan が求めた「メッセージで起こして console.error を吐く仕掛け」は事実上デッドコードで、実際に検査を通しているのは直後の `sw.ev(console.error(...))` の方。sendMessage と background 側の分岐を消して直接 `console.error` だけにする（残すなら popup を閉じる前に popup から送り、`value` を渡し、フィルタを URL 付きの行に絞る）。この 5c ブロックは plan どおり未実行のままで、`node --test` もこの環境では実行承認が下りなかったため、指摘は静的レビューによる。
- `src/shared/chrome-storage-onchanged.js:installStorageOnChangedPolyfill`（Phase 3 > ステップ 1） — 二重 install の印 `__nemoOnChangedPolyfill` は非列挙で `storage` オブジェクト自身に付けているため、ece の `{...base}` を通った後の `chrome.storage` からは見えない（plan のログにも記載）。そのため同一コンテキストで 2 回呼ばれると前段の `return` が効かず、しかも area 側は `__nemoStorageWrapped` で `continue` するので **`areaListeners[name]` が未作成のまま**になり、`chrome.storage.<area>.onChanged` は旧インスタンスの Set を指したまま新インスタンスからは一生 dispatch されない（さらに onMessage リスナーが 2 本になり broadcast が二重配信になる）。印を area 側と同じく生き残る場所（例: `chrome.storage.local` = 最初にラップした area オブジェクト）に置くか、ループ前に「どれかの area が既にラップ済みなら return」する。
- `src/shared/chrome-storage-onchanged.js:wrapCall`（Phase 3 > ステップ 2） — callback 形式では `done()` を無条件に呼ぶので、`chrome.runtime.lastError`（quota 超過など）で**書けていないのに onChanged を配って broadcast まで飛ばす**。Promise 形式は reject 時に配らないので経路間で挙動も食い違う。callback 版でも `chrome.runtime.lastError` を見て、立っていれば `done()` を飛ばす。

## P2
- `src/shared/chrome-storage-onchanged.js:installStorageOnChangedPolyfill` — `area.set = function …` は代入なので、注入経路（`(${fn})();` の sloppy mode）では対象プロパティが非書き込み可だと**黙って失敗**する。`onChanged` と同じく `Object.defineProperty` に揃えるか、関数先頭に `'use strict'` を置いて失敗を可視化する（ユニットテストは ESM=strict で走るので、この差はテストでは出ない）。
- `src/main/extension-console.ts:redactLines` — `slice(0, 600)` は後段の `sanitizeDetail`（`MAX_STRING = 200`）で必ず上書きされるので実質デッド。200 に揃えるか、切り詰めは sanitize に任せてここでは行を絞るだけにする。
- `src/main/extensions.ts:registerExtensionShim`（Phase 3 > ステップ 4） — 「SW shim の同梱漏れを見逃さないために 2 本出す」という plan の理由は、方針変更で **同じ 1 ファイルを 2 回登録する**形になった時点で成立していない（`fs.existsSync` を同じパスに 2 回かけているだけ）。`exists` は 1 回だけ判定してログの `id` だけ 2 本にする、もしくはコメントを現状に合わせる。
- `src/shared/chrome-storage-onchanged.js:broadcast` — 書き込み 1 回ごとに `sendMessage` が飛び、受け側は毎回 `get` を 1 往復する。Bitwarden のように state を細かく永続化する拡張では IPC が数倍に増え、SW も書き込みのたびに起床する。実測で問題が出たら「同一 area・同一ターンの書き込みをマイクロタスクでまとめる」等の余地を残しておく。

## Q
- `src/shared/chrome-storage-onchanged.js:WINDOW_MS` — 窓を 1500ms に置いたが、plan は「IPC 往復の実測値の数倍」としか決めていない。長いほど遅れて来た native を拾える一方、誤って消す窓も広がる（P0 を直した後も native ↔ broadcast の誤消しは残る）。実測の往復値を基準に何 ms まで詰めるかは、取りこぼしと二重配信のどちらを嫌うかの判断が要る。決めないと、実機で「たまに 1 回鳴らない／たまに 2 回鳴る」が出たときに原因の切り分け基準が無い。

````

**対応**: P0 2 件反映: 台帳の突き合わせを「native と組になる項目だけ（native↔self / native↔broadcast）」に変更し、self↔broadcast を消さないユニットテストを追加／`remove` / `clear` は `get` を投げてから待たずに元の削除を出す形に変更（remove 直後の set が消えないテストを追加）。P1 3 件反映: smoke の console-error メッセージ経路と background の分岐を削除し CDP から直接 `console.error` する形に（plan の Phase 0 文言も更新）／二重 install の印を area オブジェクト（`local`）側に移動／callback 形式で `lastError` が立っていたら配らない（テスト追加）。P2: `'use strict'` を関数先頭に追加／`redactLines` の切り詰めを 200 に／`registerExtensionShim` は `exists` を 1 回だけ判定しコメントを現状に合わせた／broadcast のまとめ（batching）は「足す修正」なので見送り（終了報告に回す）。Q: `WINDOW_MS` は 1500ms のまま採用と決定（根拠: IPC 往復は実測数 ms〜数十 ms、誤消しは native↔broadcast で別コンテキストが 1.5 秒内に同内容を書き native が遅延するケースに限られ、二重配信より取りこぼしを避ける側に倒す）。plan の「唯一のディスパッチャ」節に記載。

## 2回目

````text
変更後のファイル（polyfill 本体・テスト・smoke・extension-console・plan）を読み直しました。前回の P0 2 件・P1 3 件・P2 4 件はいずれも意図どおり反映されていて、台帳の突き合わせは `native ↔ self` / `native ↔ broadcast` に限定（frame 側でも「自分の書き込み中に他コンテキストが同じキーを書く」ケースが消えなくなり改善）、`remove` / `clear` は `get` を投げてから同ターンで元の削除を出す形になっています。plan の「唯一のディスパッチャ」節・Phase 0 の文言も実装に追従済みです。

## P0

## P1
- `src/shared/chrome-storage-onchanged.js:installStorageOnChangedPolyfill`（Phase 3 > ステップ 1） — `'use strict'` を足したことで、area ループ内の `area.set = …` / `remove` / `clear` の代入や `Object.defineProperty(area, 'onChanged')` が失敗したときに**黙って no-op ではなく throw する**ようになった。ところが `chrome.runtime.onMessage.addListener(onBroadcast)` はループの**後**にあるので、どれか 1 area で throw すると preload の catch まで飛び、**`storage.onChanged` は自前イベントに差し替わったまま・broadcast の受け口だけ無い**という中途半端な状態で止まる（SW は何も受け取れず、元の「解除が伝わらない」に戻る。しかも症状は拡張の console に 1 行出るだけ）。壊れたときに影響を最小にするため、`onMessage` の登録を area ループより**前**に移し、ループ本体（area 1 つぶん）を try/catch で包んで 1 area の失敗が残りを巻き込まないようにする。`'use strict'` 化後の実機経路（`verify:ext` / 実 Bitwarden）はまだ通していないので、ここは実行前提を置かずに守りを入れておく価値がある。

## P2
- `src/shared/chrome-storage-onchanged.js:installStorageOnChangedPolyfill`（ファイル冒頭コメントの「配る経路は 3 つ」） — 「拡張の service worker: `src/preload/extension-sw-shim.ts`」という**存在しないファイル**を指したままになっている（方針変更で `extension-shim.ts` 1 本に統合済み）。読んだ人が探して見つからないだけの害だが、`src/preload/extension-shim.ts` に直す。
- `scripts/chrome-storage-onchanged.test.mjs:fakeArea` — `remove` / `clear` の修正が依拠する「先に投げた `get` は削除前の状態を返す（storage は FIFO）」という前提は、fake の `get` が**同期でコールバックを呼ぶ**ためユニットテストでは検証できていない（`remove 直後の set が消えない` テストが見ているのは発行順序だけ）。実際に前提を突くのは smoke の `[popup受信] 存在しないキーを混ぜた SW の remove が popup に 1 回、実在キーだけで届く`（前提が崩れると `existing` が空になり 0 件で FAIL する）で、これは plan どおり未実行。常用 Nemo を止めて `verify:ext` を通すときに、この check を FIFO 前提の検証として明示的に見ておくとよい（なお今回のレビューでも `node --test` の実行承認が下りなかったため、追加 3 テストの実行結果は未確認・静的レビューのみ）。

## Q

````

**対応**: 収束（P0 なし）。P1 反映: `runtime.onMessage` の受け口登録を area ループの前に移し、area ごとのラップを try/catch で包んだ。P2 反映: 冒頭コメントの存在しないファイル名を修正。fake の get が同期な件は「smoke の該当 check を FIFO 前提の検証として見る」に留め、テストの追加はしない。

動作確認 fail: `mise run verify:ext` で「[popup受信] popup 自身の session.set が popup に 1 回届く」だけ 0 件（全記録に popup.js 初期化時の `__nemo_ci_popup_opened__` / `__nemo_ci_touch__` が入っていた＝target 直後に繋いだため popup.js がまだ走っておらず、最初の書き込み時にリスナーが無かった）→ smoke 側で popup.js の初期化完了（`#messaging`）を待ってから記録を空にするよう修正。件数不一致時に受け手の全記録を出す detail も追加。再実行で 78 件すべて PASS。

## 3回目

````text
plan（本体・ログ）と全変更ファイルを読み直しました。前回の P1（`onMessage` の受け口を area ループ前へ / area ごとの try/catch）と P2（存在しないファイル名）は反映済みで、polyfill 側は今回新たな指摘なしです。`verify:ext` が 78 件 PASS したことで、これまで前提のままだった「`get` を先に投げれば削除前の状態が返る（FIFO）」「self ↔ broadcast は突き合わせない」「callback 形式の `lastError`」がすべて実機で裏取りできています。

## P0

## P1
- `docs/plans/2026-08-30-1507-chrome-storage-onchanged-polyfill.md:Phase 1 > 最終ステップ` / `Phase 3 > ステップ 5`（`mise run verify:ext`） — 実際には smoke を通して 78 件 PASS したのに、plan のチェックボックスは未チェックのまま「**未実施**: 常用 Nemo を止めてから回す」と書かれており、「ログ > 試したこと・わかったこと」にも今回の実行結果が無い。plan は次に触る人（と自分）の唯一の記録なので、「smoke は一度も走っていない」という誤った状態が残ると、コミット前チェックの棚卸しでもう一度同じ確認をやり直すことになる。さらに今回いちばん価値のある知見——**popup の target ができた直後に繋ぐと popup.js がまだ走っておらず、リスナー登録前の書き込みが記録されない**（`__nemo_ci_popup_opened__` / `__nemo_ci_touch__` だけが残る）——が残らないと、他の popup 検査を足す人が同じ罠を踏む。2 つのステップを `[x]` にし、初回 FAIL 1 件 → 原因 → 修正 → 78 件 PASS をログに 1 段落で残す。
- `scripts/verify-ext-smoke.mjs:5c ブロック（popup 初期化待ち）`（Phase 1 > ステップ 3） — 初期化待ちが `waitFor(...).catch(() => {})` で、**タイムアウトしても何も報告せずに先へ進む**。そのまま `reset()` すると今回直したのと同じ状態（リスナー登録前の書き込みが記録されない／初期化イベントが混ざる）に戻り、症状は「storage 系の check が 7 本まとめて件数不一致」という読みにくい形で出る。しかも待ち時間 20 秒に対し popup.js の probe は `within(3000, …)` × 7 本で**最悪 21 秒**かかりうるので、遅い CI では現実にタイムアウトしうる。`waitFor` の結果を受けて `check('[storage] popup の初期化（#messaging）が終わった', ready === 'ready')` を 1 本置き、タイムアウトを 25 秒に上げる（原因が 1 本の FAIL で分かるようになり、後続の 7 本を読まなくて済む）。

## P2
- `scripts/verify-ext-smoke.mjs:exactly` — 全記録（`lastRaw`）を detail に足す条件が `events.length === n` だけなので、**件数は合っているが `extra` の述語で落ちた**とき（キー数や `saved` の食い違い）は絞る前の記録が出ない。`extra` 失敗こそ「別の area / via に紛れていないか」を見たいケースなので、条件を `events.length === n && events.every(extra)` に揃える。

## Q

````

**対応**: 収束（P0 なし）。P1 反映: plan の Phase 1 / Phase 3 の smoke ステップを [x] にし、ログに初回 FAIL→原因→修正→78 件 PASS を記録／popup の初期化待ちを check にしてタイムアウトを 25 秒に。P2 反映: 全記録を出す条件を `extra` 失敗時にも広げた。
