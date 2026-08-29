review session: a24e05ce-cddb-4a4e-ad61-3d365d72f938

## 1回目

````text
レビューしました。plan とコードを突き合わせ、`log-redact.js` / `verify-targets.mjs` / `ipc.ts` の既存規約と照合しています。`tsc` / `eslint` / `node --test` は承認が要るため実行しておらず、以下は静的レビューの結果です。

## P0

## P1
- `src/main/index.ts:before-quit ハンドラ` — `sampleMetrics()` が try で包まれずに `stopBackgroundWork()` / `destroyCallWindow` / `closeDb()` / `closeLogFile()` の**手前**に置かれている / ここが投げると終了処理の残り全部が飛び、DB とログストリームが閉じないまま落ちる（`markCleanExit` は既に済んでいるので「正常終了したのに後始末していない」状態になる）。`collectTabsByOsPid` は `getOSProcessId()` を包んでいるが `app.getAppMetrics()` は裸 / `let lastSample = null; try { lastSample = sampleMetrics() } catch { /* 記録できなくても終了処理は続ける */ }` にして、`log('app.quit', lastSample ? {source:'quit', ...lastSample} : {})` にする。診断のための行が終了処理を人質に取らない形にする
- `src/renderer/main.tsx:reportUiError` — 間引きが**完全一致の message をキーにした Map** だけで、上限も総量のキャップも無い / plan の狙いは「無限ループの例外でログを埋めない」だが、`Cannot read x (id=1234)` のように可変部分を持つメッセージが回ると 1 件も間引かれず、`reportedAt` も無限に伸びる。`src/main/log.ts` のローテーションは**件数のみでサイズ上限が無い**（plan 冒頭に明記）ので、1 ファイルが青天井に膨らむ / message キーの間引きは残したまま、`reportedAt` に上限（超えたら古い順に捨てる）と、view ごとの**総件数キャップ**（例: 1 セッション 50 件で打ち止め、打ち止めを 1 行だけ記録）を足す
- `src/main/ipc.ts:registerIpcHandlers` — `nemo:report-ui-error` を `/* ---- 状態 ---- */` と「起動時のタブは UI のロード完了後に作られるので…」のコメント直後に差し込んだため、そのコメントが `report-ui-error` を説明しているように読める / あのコメントは `nemo:get-app-status` の待ち合わせ規約を説明したもので、コメントが load-bearing なこのリポジトリでは嘘のドキュメントになる。`ui.error` は「状態」の節でもない / ハンドラを `/* ---- 状態 ---- */` より前（または独立した `/* ---- 診断 ---- */` 節）に移し、既存コメントを `get-app-status` に接し直す

## P2
- `src/main/metrics.ts:resolveInterval` — `NEMO_METRICS_INTERVAL_MS=abc` のような不正値は `Number.isFinite` に落ちて**無言で 5 分**に戻る（`metrics.interval_override` も出ない） / 検証や手動デバッグで「行が出ない」だけが見え、原因に辿り着けない。不正値のときは `console.error` を出す。あわせて `metrics.interval_override` は plan にも README / VERIFY.md にも無い新しいイベント名なので、VERIFY.md の一覧に添える（自走検証がこの名前を検査条件にしている）
- `scripts/lib/metrics-aggregate.mjs:aggregate` — `summary.sessions` が**サンプルを 1 件でも含むセッションだけ**を数える / この見出しの目的は「20 世代しか残らないので、読めた範囲を明示する」こと。5 分未満で終わったセッションが 15 個あっても見えず、母集団の薄さが伝わらない。読んだファイル総数と、そのうちサンプル有りの数を並記する
- `scripts/metrics-report.mjs:(トップレベルの引数パース)` — `--dir` を値なしで渡すと `args[++i]` が `undefined` になり `fs.existsSync(undefined)` が TypeError で落ちる / 引数ミスがスタックトレースで出る。`--dir` の次が無い / `--` で始まるときは `console.error` + `exit 2`（他の不明引数と同じ扱い）にする
- `scripts/lib/verify-targets.mjs:OWNERS` — `src/shared/ui-error.js` を `metrics` 単独の担当にしているが、これは `src/preload/ui.ts` 経由で**全スイートが読む preload バンドル**に入る / このファイルの変更で preload が壊れると全スイートが倒れるのに `--changed` は `metrics` しか回さない。`metrics` スイートがアプリを起動して `window.nemo` を触るので全損は拾えるが、`slot-apply.js` などと違い「そのスイートしか見ていない」とは言い切れない。担当から外して（＝フルに倒す）か、コメントで「preload に載るが metrics の起動検証で全損は拾える」根拠を書き残す
- `scripts/verify-metrics.mjs:(d) の検査` — `uiErrors.length === 1` と `frames.length === 2` の完全一致 / 起動中に本物の UI 例外が 1 件でも出ると、`ui.error` の配線が正しくても FAIL する（しかも「2 件」としか出ないので原因が読めない）。撃った `verify boom` を message で絞り込んでから件数を見る

## Q
- `src/main/ipc.ts:isUiSender` / `src/shared/ui-error.js:buildUiErrorDetail` — UI 例外の `message` を**そのまま**ログに残す前提でよいか / `log-redact.js` の規約は「URL（パス以降）・**フォーム入力値**・Vault 情報を出さない」で、キー名ベースの秘匿（`title` / `input` / `value` / `query` などを `[redacted]`）で構造的に守ってきた。`ui.error` はこの仕組みを迂回する初めての経路で、renderer 由来の任意文字列が `error` キー 1 本に入る。`throw new Error(\`invalid: ${入力値}\`)` のような UI 側のコードがあれば入力値がそのままディスクに残る。「そのまま残す（デバッグ優先）」と「`message` は落として `frames` だけ残す（規約優先）」で成果物が変わるので、人の判断が要る

````

**対応**: P0 なし → 収束。P1 3 件反映（`before-quit` の `sampleMetrics()` を try/catch で包み、失敗時は `app.quit` を空 detail で出す / renderer の間引きに 1 セッション 50 件の総量キャップを足し、到達時に 1 行だけ記録 / `nemo:report-ui-error` を独立の `/* ---- 診断 ---- */` 節へ移し、`get-app-status` のコメントを元の位置に戻す）。P2 5 件反映（不正な `NEMO_METRICS_INTERVAL_MS` は `console.error` / VERIFY.md に `metrics.interval_override` を追記 / 集計の見出しに読んだログ総数 `files` を並記 / `--dir` 値なしは exit 2 / `OWNERS` の `ui-error.js` に根拠コメント / 検査 (d) は `verify boom` で絞る）。Q（`message` をそのまま残すか）は自分で決めた: そのまま残す。根拠: plan の `ui.error` の形が `error` キーに message を入れると決めている・`sanitizeDetail` がトークンは潰す・UI 側で入力値を `Error` の message に載せるコードは無い（`git grep "new Error(\`" src/renderer` で確認）。
