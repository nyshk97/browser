# 未読ドット（青い点）の撤去

## 概要・やりたいこと
サイドバーのタブ行の右端に出る青い点（未読ドット）を表示しないようにする。
設定で切り替えるのではなく、**未読という概念ごと撤去**する（main 側の状態管理・型・描画・CSS・Live Folder の未読・検証スクリプトの該当ケースをすべて削除）。

背景: 見えていないタブの読み込みが終わるたびに点が付くが、ユーザーには不要な情報でノイズになっている。

## 前提・わかっていること

### 発生源（main）
- `src/main/registry.ts:537` `unread = false`（タブの状態フィールド）
- `src/main/registry.ts:738` `did-stop-loading` で **見えていないタブなら `unread = true`**
- `src/main/registry.ts:676` `toState()` で `unread` を renderer に渡す
- `src/main/registry.ts:1779-1782` 表示されたタブの `unread = false` と `markLiveFolderRead(tab.url)`

### Live Folder（GitHub PR 一覧）の未読
- `src/main/live-folders/index.ts:182` `markLiveFolderRead`、`:500` `withUnread`（新着 PR に `unread: true`、既知は引き継ぎ）
- `src/shared/live-folder-schema.js:108` キャッシュ読み込み時に `unread` を復元 → **ディスク上のキャッシュに `unread` が残っている**。読み込み側でキーを無視すれば互換は壊れない（未知キーは捨てるだけ）
- `src/shared/github-pr.js:310` PR 取得結果に `unread: false` を付けている

### 型
- `src/shared/types.ts:330`（`TabState.unread`）と `:430`（`LivePullRequest.unread`）

### 描画（5 箇所）+ CSS
- `src/renderer/components/TabRow.tsx:227` `.dot`
- `src/renderer/components/SplitRow.tsx:136` `.dot`
- `src/renderer/components/PinnedTree.tsx:251` `.dot`
- `src/renderer/components/Sidebar.tsx:328` `.fav-dot`（お気に入り）
- `src/renderer/components/LiveFolder.tsx:232,306-333,373` 見出しの `.dot` + `aria-label` の「未読あり」+ 行の `.dot`
- CSS: `styles.css` の `.fav .fav-dot`(316) / `.row .dot`(523) / `.split-row .chip .dot`(628) / `.lf-sub .dot`(736-743)。`.dot` が他用途（読み込み中スピナー等）で使われていないかは削除前に確認する

### 検証・テストの依存
- `scripts/verify-split.mjs:896-912` 「分割を表示している間は相方に未読が付かない」ケース → 削除
- `scripts/verify-live-folder.mjs:317, 629-646, 715-716, 782-861` 未読ドット・既読化・`未読あり` ラベルのケース → 削除
- `scripts/live-folder.test.mjs:441,457` キャッシュ往復で `unread` を見ている → 削除
- `scripts/lib/verify-targets.mjs` の `OWNERS`: `SplitRow.tsx`→`split`、`verify-live-folder.mjs`→`live-folder`。`registry.ts` は OWNERS 外なのでフルに倒れる

### 作業ツリーの注意
- 別件「拡張リスト非表示」の未コミット変更（`Sidebar.tsx` / `styles.css` 等）が残っている。**混ぜずに別コミット**にする（`Sidebar.tsx` と `styles.css` は両方触るので、コミット時はグローバル CLAUDE.md の「1 ファイルを 2 コミットに割る」手順で分ける）

## 実装計画

### 事前準備 [人間👨‍💻]
- なし

### Phase 1: main と型から撤去 [AI🤖]
- [x] `src/shared/types.ts` から `TabState.unread` / `LivePullRequest.unread` を削除
- [x] `src/main/registry.ts` の `unread` フィールド・`did-stop-loading` の代入・`toState()` の出力・`selectTab` 内の `unread = false` と `markLiveFolderRead` 呼び出し（import 含む）を削除。コメントも「未読」に触れている箇所を整理
- [x] `src/main/live-folders/index.ts` の `markLiveFolderRead` / `withUnread`（と `host.activeUrls()` が未読判定にしか使われていなければ host の該当 API も）を削除
- [x] `src/shared/live-folder-schema.js` / `src/shared/github-pr.js` から `unread` を削除
- [x] `npx tsc --noEmit`（または `mise run typecheck` 相当）で型エラーが残っていないことを確認

### Phase 2: renderer の描画と CSS [AI🤖]
- [x] 5 コンポーネントの `.dot` / `.fav-dot` 描画と `LiveFolder.tsx` の `unread` prop・`aria-label` の「未読あり」を削除
- [x] `styles.css` の 4 ルールを削除（`.dot` 系が他で参照されていないことを `git grep` で確認してから）
- [x] コメント中の「未読」言及（`PinnedTree.tsx:41`, `Sidebar.tsx:195`, `SplitRow.tsx:71` 等）を整理

### Phase 3: テスト・検証スクリプト [AI🤖]
- [x] `scripts/live-folder.test.mjs` の `unread` アサーションを削除し、`node --test` で通す
- [x] `scripts/verify-split.mjs` の未読ケース、`scripts/verify-live-folder.mjs` の未読関連ケースを削除
- [ ] `mise run verify:only split` と `mise run verify:only live-folder` を回し、**検査件数**を報告に出す（減った件数 = 削除したケース数になっているか）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に記載

### 動作確認 [人間👨‍💻]
- [ ] 常用 Nemo を更新後、バックグラウンドのタブが読み込みを終えても点が出ないことを確認

## ログ
### 試したこと・わかったこと
- 2026-08-30: `LiveFolderHost.activeUrls` は未読判定にしか使われていなかったので、`initLiveFolders()` の引数ごと撤去した
- 2026-08-30: `verify-live-folder.mjs` の ⑪ 節は「バックグラウンドのタブに未読が立つ」検査と ③（一時タブの出入り）の検査が同じ前提（PR タブを background で開く）を共有していたので、⑪ / ⑩ の check だけ抜いて ③ の check は残した
- 2026-08-30: `mise run verify:only split live-folder` は dev 版 Nemo（`electron .`、pid 32209）が起動中だったため実行拒否。ユーザー側で閉じてから再実行が必要

### 方針変更
（実装中に随時追記）
