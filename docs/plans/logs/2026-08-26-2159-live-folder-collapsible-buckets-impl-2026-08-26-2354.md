## 1回目

````text
## P0
- `scripts/verify-live-folder.mjs:main（Phase 3 > ステップ 3）` — 初回表示を確認する前に `readExpanded` で両バケットを開き、その後 `collapseAll` で人為的に畳んでいる / 初期値が展開状態へ回帰しても検査が PASS するため、plan の「展開前に初期折りたたみを検査」を満たしていない / `BASE` の小見出しが2件になるまで待った直後、最初の `readExpanded` より前に `CLOSED_SUBS`・`ROWS`・件数の可視性を raw の `ui.ev` で検査する

## P1
- `VERIFY.md:Live Folder（Phase 3 > ステップ 6）` — 「一覧の再描画のたびに畳まれる」という説明が実装と一致しない / `useState` は通常の再描画では保持されるため、開いたバケットは取得結果の更新後も開いたままになる / 「初回マウントと設定再有効化などの再マウント時に畳まれる」へ修正し、通常の再描画とは区別する

## P2

## Q
````

**対応**: P0 → 初期折りたたみと件数の可視の検査を ⑫ 直後（最初の readExpanded より前）へ移し raw の ui.ev で読む。後段の畳み直し検査は「開いた後に畳み直すと行が消える」に改名。P1 → VERIFY.md・スクリプト冒頭コメント・plan の「再描画のたびに畳まれる」を「初回マウントと再マウントで畳まれる（通常の再描画では保つ）」に修正

## 2回目

````text
## P0
- `scripts/verify-live-folder.mjs:main（Phase 3 > ステップ3）` — 件数・`aria-label` の検査が属性なしの `.lf-bucket` を列挙しており、同名の打ち切りラベルまで拾う / plan のセレクタ統一に反し、打ち切り状態で再利用すると `.lf-sub` がなく例外終了する / `.lf-bucket[data-bucket]` と `> .lf-sub` に統一する

## P1

## P2
- `docs/plans/logs/2026-08-26-2159-live-folder-collapsible-buckets-2026-08-26-2313.md:ファイル全体` — 0バイトの未追跡ログが残っている / コミットすると意味のない成果物になる / 不要なら削除する

## Q
````

**対応**: P0 → 件数・aria-label の列挙を `.lf-bucket[data-bucket]` と `:scope > .lf-sub` に統一。P2 は見送り（空ログは前回セッションの polish-plan 由来。ユーザー判断に委ねる）

## 3回目

````text
## P0

## P1

## P2

## Q
````

**対応**: 収束。動作確認 fail: 「矢印は閉で none」が collapseAll 直後の回転途中（matrix(0.968…)）を読んで FAIL → 閉時も until で 'none' まで待つよう修正（同じ回で既存 ③ の github.com タイミング依存フレークも 1 回出たが再実行で PASS。今回の変更とは無関係）

