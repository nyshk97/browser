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
- 常用版 `~/Library/Application Support/Nemo/logs/stable-*.log`、dev 版 `.../Nemo-dev/logs/dev-*.log`
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
  休眠タブ（`tab.asleep`）は renderer を持たないので `asleep: true` だけ出す
- 起点は 1 → 3 → 2 の順（メトリクス → 起動終了 → UI 例外）。集計スクリプトは最後
- グラフ・外部送信（Sentry 等）・電力・OS 側サンプラーは**やらない**

### `metrics.sample` の形

```jsonc
{ "t": "...", "level": "info", "event": "metrics.sample",
  "uptimeMs": 123456,
  "windows": 2, "tabs": 14, "asleep": 9,
  "total":   { "cpu": 3.2, "memMb": 1840, "processes": 11 },
  "byType":  { "Browser": {"cpu":0.4,"memMb":210,"n":1}, "Tab": {...}, "GPU": {...}, "Utility": {...} },
  "top":     [ { "key": "t-12", "origin": "https://github.com", "cpu": 1.8, "memMb": 420 }, ... ] }
```

- `memMb` は `ProcessMetric.memory.workingSetSize`（KB）を MB に丸めたもの。
  macOS ではこれがアクティビティモニタの「メモリ」列（physical footprint）にほぼ相当する。
  `privateBytes` は macOS で取れないので使わない
- `cpu` は `ProcessMetric.cpu.percentCPUUsage`（前回 `getAppMetrics()` 呼び出しからの平均。
  1 コア = 100）。**初回呼び出しは 0 が返る**ので、`startBackgroundWork()` で一度空撃ちしておく
- `top` は renderer をメモリ降順で **上位 5 件**に絞る（1 行の肥大化を防ぐ。5 分おき 1 行 ≒ 1 日 300 行なので
  1 行 1KB なら 1 日 300KB）
- タブとの紐づけは `webContents.getOSProcessId()` と `ProcessMetric.pid` の突き合わせ。
  分割ビュー・Peek・小窓の renderer も `Tab` 種別で来るので、**タブに紐づかない renderer は
  `origin` 無しで `key: null`** として `top` に混ぜられるようにする（UI の view も同じ扱い）

## 実装計画

### 事前準備 [人間👨‍💻]
- なし（依存の追加・鍵・アカウント不要）

### Phase 1: `metrics.sample` [AI🤖]
- [ ] `src/main/metrics.ts` を新設: `sampleMetrics()`（`getAppMetrics()` → 上の形に整形。純粋関数部分は
      `src/shared/metrics-summary.js` に切り出して `scripts/metrics-summary.test.mjs` でユニットテスト）
      と `startMetricsSampling()` / `stopMetricsSampling()`（`setInterval`、初回空撃ち、
      `NEMO_METRICS_INTERVAL_MS` の扱い）
- [ ] `startBackgroundWork()` / `stopBackgroundWork()` から呼ぶ（`registry.ts` に直接書かず import）
- [ ] タブ ↔ pid の対応表は registry 側に `tabByOsPid(): Map<number, {key, origin, asleep}>` 相当の
      小さな export を足して `metrics.ts` から使う（registry の内部構造を外に漏らさない）
- [ ] `NEMO_METRICS_INTERVAL_MS` はパッケージ版では無視して `console.error`（既存の型どおり）

### Phase 2: 起動・終了スナップショット [AI🤖]
- [ ] `app.ready` に `readyMs`（`process.uptime()` ベースで ms）・`restoredTabs`・`extensions`
      （`session.getAllExtensions().length`）を追記
- [ ] `app.quit` に `uptimeMs` と `sampleMetrics()` の結果（`metrics.sample` と同じキー）を追記。
      `stopBackgroundWork()` より前に取る（止めてから取ると `getAppMetrics` は動くが意図が読みにくい）

### Phase 3: `ui.error` [AI🤖]
- [ ] `src/preload/ui.ts` に `reportError({message, stack, view})` を公開（`ipcRenderer.send('nemo:ui-error')`。
      stack は先頭 20 行に切る）
- [ ] `src/renderer/main.tsx` で `window.addEventListener('error' | 'unhandledrejection')` → `reportError`。
      同じ message の連投は 1 分 1 回に間引く（無限ループの例外でログを埋めない）
- [ ] `src/main/ipc.ts` で受けて `logError('ui.error', ...)`。**送信元が Nemo の UI view であることを
      既存の `ipc.rejected` と同じ検査で確かめる**（ページの renderer から偽装して撃てない）
- [ ] `sanitizeDetail` が stack 中の URL を落とすことを `scripts/log-redact.test.mjs` に 1 ケース足して確認

### Phase 4: 集計スクリプト [AI🤖]
- [ ] `scripts/metrics-report.mjs`: 引数なしで常用版・dev 版両方の `logs/` を読み、
      日別 × チャンネル別に `memMb` 中央値 / p95・`cpu` 平均・`tabs` 中央値・サンプル数を表で出す。
      `--dir <logs>` で任意ディレクトリ、`--json` で機械可読
- [ ] `.mise.toml` に `[tasks."metrics:report"]`（日本語 `description`）
- [ ] 集計の中身は `scripts/metrics-report.test.mjs` で固定の jsonl から検証（p95 の境界を含む）

### Phase 5: 自走検証と登録 [AI🤖]
- [ ] `scripts/verify-metrics.mjs`: `NEMO_METRICS_INTERVAL_MS=2000` で使い捨てプロファイルの
      Nemo を立て、(a) `metrics.sample` が 2 行以上出る（**件数を出力に出す**） (b) 2 行目以降の
      `total.cpu` が数値（初回空撃ちが効いている） (c) タブを 2 つ開いて `top` に `origin` 付きの
      行が出る (d) UI で `window.nemo.reportError` を撃って `ui.error` が 1 行出る
      (e) 終了後の `app.quit` に `uptimeMs` と `total` がある
- [ ] `KNOWN_TARGETS` / `NEEDS_APP` / `RESTART_COMPANIONS`（必要なら）/ `OWNERS` に登録し、
      `verify-all.mjs` に `if (want('metrics'))` を配線。**配線を外した状態で 1 回回して検査 0 件を見てから戻す**
      （CLAUDE.md）。`OWNERS` は `src/main/metrics.ts` / `src/shared/metrics-summary.js` /
      `scripts/metrics-*.mjs` だけ（`index.ts` / `registry.ts` / `ipc.ts` / `main.tsx` は載せない）
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
