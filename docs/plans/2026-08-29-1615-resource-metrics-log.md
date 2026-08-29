# メモリ・CPU の定期記録と UI 例外・起動終了のスナップショットを診断ログへ

## 概要・やりたいこと

Arc（メイン）や Chrome と比べて Nemo の負荷がどう違うかを、**アクティビティモニタを見に行かずに**
後から見返して「なんとなく分かる」状態にしたい。

他ブラウザとの横並び比較は OS 側のサンプラー（別件・今回は作らない）の仕事なので、
今回は **Nemo 自身が持っている値を、既存の診断ログ（`src/main/log.ts`）に安定したイベント名で
残す**ところまでをやる。依存の追加なし・設定項目の追加なし。

| 足すもの | イベント | 中身 |
|---|---|---|
| 定期メトリクス | `metrics.sample` | `app.getAppMetrics()` のプロセス種別ごとの合計と、renderer をタブに紐づけた内訳。タブ数・休眠数・ウィンドウ数を添える |
| UI 側の例外 | `ui.error` | renderer の `window.onerror` / `unhandledrejection` を main のログへ |
| 起動スナップショット | `app.ready` に追記 | ready までの ms・復元タブ数・ロード済み拡張数 |
| 終了スナップショット | `app.quit` に追記 | 稼働時間（ms）とその時点の `metrics.sample` 相当 |
| 集計 | `scripts/metrics-report.mjs` / `mise run metrics:report` | 日別 × チャンネル別の メモリ中央値 / p95・CPU 平均・タブ数 |

## 前提・わかっていること

### 既存の基盤

- `src/main/log.ts`: JSON Lines、セッション単位 1 ファイル、20 世代ローテーション（件数のみ。サイズ上限なし）。
  出口で `sanitizeDetail` が通り、URL はパス以降が落ちる（`src/shared/log-redact.js`）
- 常用版 `~/Library/Application Support/Nemo/logs/stable-*.log`、dev 版 `.../Nemo-dev/logs/dev-*.log`。
  ローテーションは**件数のみ**なので、起動回数が多い週は数日分しか残らない。集計はこの制約を
  出力の先頭（読めた期間・セッション数・サンプル数）で必ず明示する
- `sanitizeDetail` は**文字列の先頭が scheme のときだけ** URL と見なす（`looksLikeUrl`）。
  `at foo (https://…)` のような行途中の URL は素通りし、文字列は 200 文字で切られる（`MAX_STRING`）。
  スタックトレースはこの関数に任せず、送る前に行単位で `redactUrl` をかける（Phase 3）
- `src/main/ipc.ts` は全部 `ipcMain.handle`（`invoke`）で、`requireWindow` / `senderFrameUrl` の
  ガードは `IpcMainInvokeEvent` 前提。`ui.error` も `invoke` にして戻り値を捨てる（`ipcMain.on` を新設しない）
- `logError(event, error, detail)` はメッセージを **`error` キー**に入れる（`message` ではない）。
  検証の grep もそれに合わせる
- `collectSession()` はシークレットウィンドウをディスクに残さない方針。メトリクスも同じ扱いにする
- Chromium は同一サイトのタブを 1 つの renderer に同居させるので、**pid とタブは 1:1 ではない**
- `sanitizeValue` は **`MAX_DEPTH = 4` を超えたオブジェクトを `"[deep]"` に潰す**（detail → 配列 → 要素 → 配列 → 要素 で 4）。
  `metrics.sample` の `top` はオブジェクトの入れ子を 1 段に抑える（文字列配列なら深さ 4 でも通る）
- 拡張は `pageSession` にロードされ、数は `app.ready` 直前の `loaded`（`setExtensionCount(loaded.length)` の引数）が持っている
- 会議の小窓（`?view=call`）は `windowsById` に居ないので `requireWindow` が throw する。`ipc.ts` は
  `requireCallWindow` を続けて試す二段の検査を使っている
- 異常系はすでに拾えている: `uncaughtException` / `unhandledRejection`（`src/main/index.ts:62`）、
  `render-process-gone` → `tab.crashed`、`unresponsive`（`src/main/registry.ts:768,785`）
- 定期処理の型: `startBackgroundWork()`（`src/main/registry.ts:3371`）が `setInterval` を張り、
  `before-quit` の `stopBackgroundWork()` で止める。今回のサンプラーもここに同居させる
- `app.ready` / `app.quit` の行はすでにある（`src/main/index.ts:301,339`）。追記するだけ
- 検証ハーネスに `readLogLines` / `countLogEvents` / `waitForLogEvent`（`scripts/lib/harness.mjs:258-286`）がある

### `/dig-lite` で確定した決定

- **サンプル間隔は 5 分固定**。設定項目にしない。
  未パッケージのときだけ `NEMO_METRICS_INTERVAL_MS` で短縮できる（`NEMO_GITHUB_TEST_ENDPOINT` と同じ
  「パッケージ版では無視して `console.error`」の型）。自走検証はこれで数秒間隔にして行が出るのを待つ
- **同じログファイルに書く**（別ファイルにしない）。`grep '"event":"metrics.sample"'` で取り出せる
- **タブの識別子は `key` ＋ origin**（`redactUrl` を通した値。パス以降は出ない）。
  休眠タブ（`tab.asleep`）は renderer を持たず pid も無いので `top` には現れない。件数だけトップレベルの `asleep` で出す。
  **シークレットウィンドウのタブは `origins` に入れず `private` の件数に足すだけ**（origin をディスクに残さない。ユニットテストで固定）
- **判断基準（何 MB を超えたら何をするか）は決めない**。今回は「記録して見返せる」まで。
  集計は中央値と p95、タブ数は正規化せず並記する（1 回目で決定）
- **保持期間は今の 20 セッションのまま**。集計が「読めた期間」を出すので、足りないと感じたときに
  `KEEP_SESSIONS` を上げるか metrics を別ファイルにするかを決める（1 回目で決定。今回の範囲に入れない）
- 起点は 1 → 3 → 2 の順（メトリクス → 起動終了 → UI 例外）。集計スクリプトは最後
- グラフ・外部送信（Sentry 等）・電力・OS 側サンプラーは**やらない**

### `metrics.sample` の形

```jsonc
{ "t": "...", "level": "info", "event": "metrics.sample",
  "uptimeMs": 123456,
  "windows": 2, "tabs": 14, "asleep": 9,   // windows は windowsById（ブラウザウィンドウ）の数。設定・ピン・会議の小窓は含めない。tabs / asleep はシークレットのタブも数に含める（負荷の説明が合わなくなるため）
  "total":   { "cpu": 3.2, "memMb": 1840, "processes": 11 },
  "byType":  { "Browser": {"cpu":0.4,"memMb":210,"n":1}, "Tab": {...}, "GPU": {...}, "Utility": {...} },
  "top":     [ { "pid": 4321, "cpu": 1.8, "memMb": 420,
                 "keys": ["t-12","t-15"], "origins": ["https://github.com"], "private": 0 }, ... ] }
```

- `memMb` は `ProcessMetric.memory.workingSetSize`（KB）を MB に丸めたもの（resident。`privateBytes` は macOS で取れない）。
  アクティビティモニタの「メモリ」列（圧縮分を含む phys_footprint）とは**常時ズレる**。
  **絶対値の一致は狙わず、同じ指標の時系列比較に使う**。README / VERIFY.md の説明もこの文言にする
- `cpu` は `ProcessMetric.cpu.percentCPUUsage`（前回 `getAppMetrics()` 呼び出しからの平均。
  1 コア = 100）。**初回呼び出しは 0 が返る**ので、`startBackgroundWork()` で一度空撃ちしておく
- `top` は renderer **プロセス**をメモリ降順で **上位 5 件**に絞る（1 行の肥大化を防ぐ。5 分おき 1 行 ≒ 1 日 300 行なので
  1 行 1KB なら 1 日 300KB）。1 要素 = 1 pid で、`keys` / `origins`（重複除去）にそこに同居しているタブを全部並べる
  （同一サイトのタブは 1 renderer にまとまるため。1 タブに誤配分しない）。**要素の中にオブジェクトを入れない**（`[deep]` 潰れ）
- タブとの紐づけは `webContents.getOSProcessId()` と `ProcessMetric.pid` の突き合わせ。
  分割ビュー・Peek・小窓の renderer も `Tab` 種別で来るので、**タブに紐づかない renderer は
  `keys: []`** として `top` に混ぜられるようにする（UI の view も同じ扱い）
- `app.quit` に添える終了時の値は同じキーに `source: "quit"` を付けて出す。集計は `metrics.sample` と
  quit 行の両方を読み、先頭の内訳に `sample` / `quit` の件数を並べる（2 回目で決定）

## 実装計画

### 事前準備 [人間👨‍💻]
- なし（依存の追加・鍵・アカウント不要）

### Phase 1: `metrics.sample` [AI🤖]
- [ ] `src/main/metrics.ts` を新設: `sampleMetrics()`（`getAppMetrics()` → 上の形に整形。純粋関数部分は
      `src/shared/metrics-summary.js` に切り出して `scripts/metrics-summary.test.mjs` でユニットテスト。
      **整形結果を `sanitizeDetail` に通しても `[deep]` / `[redacted]` / 200 文字切りが出ないケースを必ず入れる**。
      `ui.error` の frames にも同じ検査を当てる）
      と `startMetricsSampling()` / `stopMetricsSampling()`（`setInterval`、初回空撃ち、
      `NEMO_METRICS_INTERVAL_MS` の扱い）
- [ ] `startBackgroundWork()` / `stopBackgroundWork()` から呼ぶ（`registry.ts` に直接書かず import）。
      タイマーは `sleepTimer` と同じく `unref?.()` を付ける
- [ ] タブ ↔ pid の対応表は registry 側に `Map<pid, TabRef[]>`（`{key, origin, private}`）を
      返す小さな export を足して `metrics.ts` から使う（registry の内部構造を外に漏らさない）
- [ ] `NEMO_METRICS_INTERVAL_MS` はパッケージ版では無視して `console.error`（既存の型どおり）

### Phase 2: 起動・終了スナップショット [AI🤖]
- [ ] `app.ready` に `readyMs`（`process.uptime()` ベースで ms）・`restoredTabs`・`extensions`
      （直前の `loaded.length`。API 呼び出しを増やさない）を追記
- [ ] `app.quit` に `uptimeMs` と `sampleMetrics()` の結果（`metrics.sample` と同じキー ＋ `source: "quit"`）を追記。
      `stopBackgroundWork()` より前に取る（止めてから取ると `getAppMetrics` は動くが意図が読みにくい）

### Phase 3: `ui.error` [AI🤖]
- [ ] `src/preload/ui.ts` に `reportError({message, frames, view})` を公開（`ipcRenderer.invoke` に **必ず `.catch(() => {})`**。
      reject が `unhandledrejection` に戻って自分を呼び返すのを断つ。`view` は `params.get('view')` の値そのまま）。
      stack は行配列にし、**各行を `redactUrl` で置換してから** 10 行程度・1 行 200 文字未満で渡す
      （`sanitizeDetail` は行途中の URL を落とさない）。この変換は純粋関数にしてユニットテストする
- [ ] `src/renderer/main.tsx` で `window.addEventListener('error' | 'unhandledrejection')` → `reportError`。
      同じ message の連投は 1 分 1 回に間引く（無限ループの例外でログを埋めない）
- [ ] `src/main/ipc.ts` で `ipcMain.handle` として受けて `logError('ui.error', ...)`（メッセージは `error` キーに入る）。
      **送信元が Nemo の UI view であることを既存の `requireWindow` → 失敗なら `requireCallWindow` の二段で確かめる**
      （会議の小窓は `windowsById` に居ない。ページの renderer から偽装して撃てない）
- [ ] 「行途中の URL が落ちる」ことを上の純粋関数のテストで確認（`sanitizeDetail` 側には手を入れない）

### Phase 4: 集計スクリプト [AI🤖]
- [ ] `scripts/metrics-report.mjs`: 引数なしで常用版・dev 版両方の `logs/` を読み、
      **先頭に読めた期間・セッション数・サンプル数**を出してから、
      日別 × チャンネル別に `memMb` 中央値 / p95・`cpu` 平均・`tabs` 中央値・サンプル数を表で出す。
      `--dir <logs>` で任意ディレクトリ、`--json` で機械可読（`--json` にはセッション別の行も含める）
- [ ] `.mise.toml` に `[tasks."metrics:report"]`（日本語 `description`）
- [ ] 集計の中身は `scripts/metrics-report.test.mjs` で固定の jsonl から検証（p95 の境界を含む）

### Phase 5: 自走検証と登録 [AI🤖]
- [ ] `scripts/verify-metrics.mjs`: **自分で** `NEMO_METRICS_INTERVAL_MS=2000` を渡して使い捨てプロファイルの
      Nemo を立て（`slots` / `auth-vault` と同じ型。共有アプリでは env も終了も制御できない）、
      (a) `metrics.sample` が 2 行以上出る（**件数を出力に出す**） (b) 2 行目以降の
      **いずれか**で `total.cpu > 0` かつ `byType` に 1 つ以上の型がある（初回空撃ちが効いている。全行に課すと flake る） (c) タブを 2 つ開いて
      `top` に `origins` が非空の要素が出る (d) UI で `window.nemo.reportError` を撃って
      `ui.error` が 1 行出る（`error` キーと `view` を見る） (e) 終了後の `app.quit` に `uptimeMs` と `total` と `source: "quit"` がある
- [ ] `KNOWN_TARGETS` / `OPT_IN_ONLY` / `OWNERS` に登録（`NEEDS_APP` と `RESTART_COMPANIONS` には入れない）し、
      `verify-all.mjs` に `if (want('metrics'))` を配線。**配線を外した状態で 1 回回して検査 0 件を見てから戻す**
      （CLAUDE.md）。`OWNERS` は完全一致の Map なので実名で列挙する:
      `src/main/metrics.ts` / `src/shared/metrics-summary.js` / `scripts/verify-metrics.mjs` /
      `scripts/metrics-report.mjs` / `scripts/metrics-report.test.mjs` / `scripts/metrics-summary.test.mjs`
      （`index.ts` / `registry.ts` / `ipc.ts` / `main.tsx` は載せない）
- [ ] `VERIFY.md` に「メトリクスの行を見る」「集計を出す」の手順を追記、`docs/CHANGELOG.md` の
      `[Unreleased]` に記入、`README.md` の `logs/` 行にイベント名を添える

### 動作確認 [人間👨‍💻]
- [ ] 常用版を次のリリースに上げて 1 日使い、`mise run metrics:report` で表が出ることを見る
      （5 分間隔の実データは自走検証では作れない）

## ログ
### 試したこと・わかったこと
（実装中に随時追記）

### 方針変更
（実装中に随時追記）
