review session: 19b5642d-a166-4577-bee1-cfc889b6bd54

## 1回目

````text
`docs/plans/2026-08-29-1615-resource-metrics-log.md` を、実コード（`log-redact.js` / `log.ts` / `ipc.ts` / `registry.ts` / `verify-targets.mjs`）と突き合わせてレビューしました。

## P0
- **Phase 3 > 4** — 「`sanitizeDetail` が stack 中の URL を落とす」は事実と違う / `looksLikeUrl` は**文字列の先頭が scheme のときだけ**判定し（`/^[a-zA-Z][...]*:\/\//`）、`at foo (https://…/path?token=…)` のような行途中の URL は素通りする。さらに `MAX_STRING = 200` で文字列は 200 文字に切られるので「stack を先頭 20 行に切る」は空振り（実質 2〜3 行しか残らない）。このまま書くとテストが通らず、通そうとして redact の前提を緩める手戻りになる / 送信側（preload か ipc の受け口）で stack を行配列にし、各行の URL を `redactUrl` で置換してから `frames: string[]`（10 行程度、1 行 200 文字未満）で渡す。テストは「行途中の URL が落ちる」新しい純粋関数に対して書く
- **`metrics.sample` の形 > `top`／Phase 1 > 3** — pid とタブは 1:1 ではない / Chromium は同一サイトのタブを 1 renderer にまとめるので、`Map<number, {key, origin, asleep}>` では同居しているタブが 1 つを残して消え、そのメモリが 1 タブに誤配分される。ログの schema と集計スクリプトが固まってから直すと両方やり直し / `Map<number, TabRef[]>` にし、`top` の要素を `{ key, origin, shared: n }`（または `keys`/`origins` 配列）にして「この pid に何タブ乗っているか」を残す
- **`metrics.sample` の形 > タブの識別子／Phase 1 > 3** — シークレットウィンドウのタブの origin がログに残る / `collectSession()` は「シークレットウィンドウはディスクに残さない」を明示の方針にしているのに、5 分ごとの `top` は同じ origin をディスクへ書き、20 世代残る。方針の矛盾に後で気づくと schema 変更になる / `win.isPrivate` のタブは `origin: null`（必要なら `private: true` だけ）にし、その扱いを `metrics-summary.js` のユニットテストで固定する

## P1
- **Phase 3 > 1,3** — `ipcRenderer.send` は main 側に**このリポジトリ初の `ipcMain.on`** を作る / `ipc.ts` は 93 個すべて `ipcMain.handle` で、再利用したい `requireWindow` / `senderFrameUrl` は `IpcMainInvokeEvent` 型。「既存の `ipc.rejected` と同じ検査」をそのままは使えず、型の一般化かガードの複製が要る / `invoke` にして戻り値を捨てる（renderer 側で `.catch(() => {})`）。既存ガードを 1 行も触らずに済む
- **Phase 5 > 2** — `NEEDS_APP` 登録と「自分で `NEMO_METRICS_INTERVAL_MS=2000` で起動する」が両立しない / 共有アプリの env は `verify-all.mjs` が固定で渡すので短縮が効かず、検査 (e) の `app.quit` も共有アプリでは終了させられない / `slots` / `auth-vault` と同じ扱いにする（`NEEDS_APP` に入れない・`OPT_IN_ONLY` に入れる・`RESTART_COMPANIONS` は無関係なので入れない）
- **Phase 5 > 2** — `OWNERS` はグロブではなく完全一致の `Map` / `scripts/metrics-*.mjs` という書き方では 1 件も登録されない。加えて新規の `scripts/verify-metrics.mjs` は `OWNERS` か `UNMAPPED_VERIFY_SCRIPTS` のどちらかに載せないと `verify-targets.test.mjs` が落ちる / `scripts/verify-metrics.mjs` / `scripts/metrics-report.mjs` / `scripts/metrics-report.test.mjs` / `scripts/metrics-summary.test.mjs` を実名で列挙する
- **Phase 5 > 1 (b)** — 「2 行目以降の `total.cpu` が数値」は 0 でも通る / 初回空撃ちが効いていなくても PASS するので、検査したい性質を検査していない / `total.cpu > 0` かつ `byType` に 1 つ以上の型が入っていること、を見る
- **`metrics.sample` の形 > `memMb`** — 「workingSetSize がアクティビティモニタのメモリ列（physical footprint）にほぼ相当」は言い過ぎ / macOS の「メモリ」列は圧縮分を含む phys_footprint で、resident な workingSetSize とは常時ズレる。数字が合わないことに後で気づくと指標の選び直しになる / plan に「絶対値の一致は狙わず、同じ指標の時系列比較に使う」と書き、`README`/`VERIFY.md` の説明もその文言に揃える
- **前提 > 既存の基盤（ローテーション）** — 20 世代は**件数のみ**なので、起動回数が多い週は数日でデータが消える / 「日別 × チャンネル別」の集計が、何日分を見ているのか出力から分からないまま数字だけ出る / `metrics-report` の出力先頭に「読めた期間・セッション数・サンプル数」を必ず出す（保持を伸ばすかは Q）
- **Phase 1 > 3** — `tabByOsPid()` の戻り値に `asleep` を含めるのは意味がない / 休眠タブは renderer を持たず pid も無いので、この Map には最初から現れない。残すと「asleep のタブが `top` に出ないのはバグでは」と読める / 戻り値からは外し、休眠はトップレベルの `asleep` 件数だけで表す

## P2
- **`metrics.sample` の形 > `windows`** — `windowsById` 由来なら設定・ピン・会議の小窓が数に入らない。どちらの意味かを plan に書く（`BrowserWindow.getAllWindows().length` にするなら `tabs` との対応が崩れる点も）
- **Phase 1 > 1** — `sleepTimer` は `unref?.()` を付けている。メトリクスの `setInterval` も既存パターンに揃える
- **Phase 3 > 3** — `logError(event, error, detail)` は message を **`error` キー**に入れる。ログ上のキー名が `message` でないことを plan に書いておくと、検証の grep 文字列がぶれない
- **Phase 4 > 1** — セッションをまたいで中央値を取ると、タブ数の違うセッションが同じ日に混ざる。`--json` にセッション別の行も残しておくと原因を追える

## Q
- **概要・やりたいこと** — 「Arc / Chrome と比べてどう違うか」を判断する基準（何 MB・何 % を超えたら何をするか）が未定 / 決めないと Phase 4 の表は出るが次の一手に繋がらず、集計の切り口（p95 でよいか・タブ数で正規化するか）も選べない
- **前提 > 既存の基盤（ローテーション）** — どれだけ遡って見たいか（1 週間 / 1 か月 / それ以上） / ここが決まらないと、20 世代のままでよいか・`KEEP_SESSIONS` を上げるか・metrics だけ別ファイルに追記するか（「同じログに書く」決定の見直し）が選べない

````

**対応**: P0 3 件すべて反映（stack は送信前に行単位で `redactUrl`・`sanitizeDetail` に頼らない / `top` を pid 単位にし同居タブを `tabs[]` で全部並べる / private タブは `origin: null, private: true`）。P1 全件反映（`invoke` で受けて `ipcMain.on` を作らない / `OPT_IN_ONLY` で自分で起動・`NEEDS_APP` と `RESTART_COMPANIONS` に入れない / `OWNERS` を実名列挙 / (b) は `total.cpu > 0` かつ `byType` 非空 / workingSetSize は phys_footprint と常時ズレる・時系列比較専用と明記 / 集計の先頭に読めた期間・セッション数・サンプル数 / `tabByOsPid` から `asleep` を外す）。P2 は書き換えで済むので全部反映（`windows` の意味 / `unref` / `error` キー / `--json` にセッション別行）。Q は両方自分で閉じた: 判断基準は決めない（ユーザーの要望は「なんとなく分かる」まで。集計は中央値・p95・タブ数並記） / 保持期間は 20 セッションのまま、集計が期間を出すので足りなければその時に決める（今回の範囲外）。

## 2回目

````text
`docs/plans/2026-08-29-1615-resource-metrics-log.md` を再読し、前回指摘の反映と、新しい形（pid 単位の `top`・`invoke` 化・拡張数）を実コードに突き合わせました。前回の P0/P1/P2 はいずれも反映を確認。以下は今回の形で新たに出たものだけです。

## P0
- **`metrics.sample` の形 > `top`／Phase 1 > 1** — `top[].tabs[]` の入れ子が `sanitizeValue` の `MAX_DEPTH = 4` に当たる / 深さは detail(0) → `top` 配列(1) → 要素オブジェクト(2) → `tabs` 配列(3) → タブオブジェクト(4) で、`depth >= MAX_DEPTH` の分岐が配列・オブジェクトの分岐より前にあるため、**タブ 1 件ずつが `"[deep]"` という文字列に潰れて記録される**（数値・文字列は深さ判定より前に返るので、潰れるのはオブジェクトだけ）。ログを出してから気づくと schema と集計スクリプトを作り直す / `top` の要素をこれ以上ネストさせない。例: `{ "pid": 4321, "cpu": 1.8, "memMb": 420, "keys": ["t-12","t-15"], "origins": ["https://github.com"], "private": 1 }`（`keys` / `origins` は文字列配列なので深さ 4 でも通る。private タブは origin を入れず件数だけ `private` に足す）。`sanitizeDetail` 側は触らない方針のままで済む

## P1
- **Phase 1 > 1** — 整形結果が `sanitizeDetail` を素通りできることを誰も検査していない / 上の `[deep]` は「実装すると型は合うがログの中身だけが壊れる」種類なので、ユニットテストが無いと再発する（`private`・`origins` を足したときにまた深くなる） / `metrics-summary.test.mjs` に「整形結果を `sanitizeDetail` に通しても `[deep]` / `[redacted]` / 200 文字切りが 1 つも出ない」ケースを入れる。同じ検査を `ui.error` の frames にも当てる
- **Phase 3 > 1,3** — `invoke` の戻り値を捨てると reject が `unhandledrejection` を焚き、`reportError` が自分を呼び返す / `main.tsx` は `?view=call` も同じ entry なので、**会議の小窓は `windowsById` に居らず `requireWindow` が必ず throw する**（`ipc.ts` のコメントどおり）。その reject が未処理 → 例外ハンドラ → また reject、で `ipc.rejected` を 1 分おきに永久に吐き、小窓の例外は 1 件も残らない / preload で `.catch(() => {})` を必ず付け、ipc 側は `requireWindow` に失敗したら `requireCallWindow` も試す（会議の小窓と同じ二段の検査）
- **Phase 2 > 1** — `session.getAllExtensions()` は今の API 形ではないうえ、対象セッションも違う / 実際は `<Session>.extensions.getAllExtensions()`（`src/main/extensions.ts`）で、拡張は `pageSession` にロードされるので defaultSession を見ると常に 0 になる / `app.ready` の直前に既にある `loaded`（`setExtensionCount(loaded.length)` に渡している値）をそのまま使う。API 呼び出しを増やさない
- **Phase 2 > 2／Phase 4 > 1** — `app.quit` の追記が集計の入力に入るのか未記載 / `metrics.sample` と同じキーを持つ行がもう 1 種類でき、短いセッションでは quit 行だけがサンプルという状況になる。読む側を決めないと「サンプル数」の意味が実装者次第になる / 推奨は取り込む側（quit 行にも `source: "quit"` を入れ、report は両方を読み、先頭の内訳に `sample` / `quit` の件数を並べる）。取り込まないなら plan にそう書く

## P2
- **Phase 5 > 1 (b)** — 「2 行目以降の `total.cpu > 0`」を全行に課すと、アイドルな 2 秒窓で 0 になったときに flake る。「2 行目以降のいずれかで > 0」にすると空撃ちの検査としては十分で安定する
- **`metrics.sample` の形 > `windows`** — `windows` の定義は書けたが、`tabs` / `asleep` がシークレットウィンドウのタブを件数に含むかが未記載。origin を出さない話とは別なので 1 行足す（推奨は含める。負荷の説明が合わなくなるため）
- **Phase 3 > 1** — `view` に入れる値を `params.get('view')`（`sidebar` / `toolbar` / `peek` / `mini` / `call`）と明記しておくと、検証 (d) の期待値がぶれない

## Q

````

**対応**: P0 反映（`top` の要素をフラットにし `keys` / `origins` / `private` の文字列配列＋件数にする。`MAX_DEPTH` の事実を前提に追記）。P1 全件反映（`sanitizeDetail` 素通り検査は P0 の修正に不可欠なので Phase 1 のテスト項目に含めた / preload に `.catch(() => {})` 必須・ipc は `requireWindow` → `requireCallWindow` の二段 / 拡張数は `loaded.length` / quit 行は `source: "quit"` を付けて集計に取り込む）。P2 全件反映（(b) は「いずれか」/ `tabs` `asleep` はシークレットを含める / `view` は `params.get('view')` の値）。
