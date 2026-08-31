# ピン留め・Favorite の URL 明示的上書き（Arc「Edit Pinned URL」相当）

## 概要・やりたいこと

ピン留め・Favorite アイテムの「クリックしたとき開く URL」を、右クリックメニューから明示的に編集できるようにする。

- 典型ユースケース: Google カレンダーを `https://calendar.google.com/calendar/u/3/r` でなく
  `https://calendar.google.com/calendar?authuser=tsubasa_nabatame@linc-well.com` の形に書き換える
  （u/N のインデックスはログイン順で変わるが authuser 指定なら安定するため）
- Arc の「Edit Pinned Page → Edit…」相当。ついでに Arc の「Replace Pinned URL with Current」
  相当である既存の「このページに更新」を Favorite にも展開する

## 前提・わかっていること

### 決定事項（/dig-lite）

- **対象範囲**: ピン留め + Favorite 両方。「このページに更新」も Favorite に追加する
- **UI**: 行下の編集枠（`IconEdit.tsx` パターンを流用）。モーダルにしない。
  名前編集・アイコン編集と **3者排他** にする
- **バリデーション**: `normalizeStoredUrl`（`src/shared/settings-schema.js:316`、http/https のみ・
  4096 字上限）を必ず通す。重複 URL は拒否して枠内にエラー表示
- **favicon**: URL 編集で host が変わったら `faviconUrl` を `null` に落とす（次回オープンで再取得）。
  `setFaviconForDefinition` の host ガードにより自動では直らないため
- **開いているタブ**: 触らない（定義とタブ実体の分離という既存設計どおり。
  次に閉じて開き直したときから新 URL）
- **IPC**: 「定義 ID + URL」を受ける新チャンネルを追加。既存の
  「renderer から定義 ID を渡させない」方針（`ipc.ts:524` 付近のコメント、
  `docs/plans/2026-08-24-2014-pins-favorites-rename.md:58`）を明示的に緩めるので、コメントも更新する
- **重複時の扱い**: 既存の `updatePinnedUrl` と同じく拒否。ピン内の重複に加え、
  ピン ↔ Favorite 間の「同じ URL が並ばない」不変も守る

### 調査で判明している現状

- **「このページに更新」はピン留めには既にある**:
  `PinnedTree.tsx:246-249` → preload `ui.ts:69` → `ipc.ts:526`（`nemo:update-pinned-url`、引数はタブ key のみ）
  → `registry.ts:3391 updatePinnedUrlFromTab` → `pins.ts:330 updatePinnedUrl(id, url): boolean`
- `updatePinnedUrl(id, url)` は既に任意 URL を受け取れる形:
  `normalizeStoredUrl` 不通過 / フォルダ / 他ピンとの重複（`findPinnedByUrl` :86）で `false`、
  重複時は `log('pin.url_update_rejected', { reason: 'duplicate_url' })`、成功時 `log('pin.url_updated', { id })`
- **Favorite には URL 更新関数が一切ない**（`addFavorite` / `removeFavorite` / `moveFavorite` /
  `findFavorite` / `inheritSections` のみ）
- ピン ↔ Favorite 間の URL 重複は `registry.ts:3311, 3327`（`findFavoriteByUrl` / `findPinnedByUrl`）が守っている
- 定義の url はタブから **自動では絶対に書き戻らない**（書き戻るのは title / faviconUrl のみ。
  `docs/operations.md:20-21` に明文化あり）
- コンテキストメニューは DOM 自前実装（`RowMenu.tsx`。自走検証で contextmenu を dispatch できるようにするため）
  - ピン留めリンク行: `PinnedTree.tsx:229-252`（名前を変更 / アイコンを変更… / このページに更新 / ピン留めを解除）
  - Favorite セル: `Sidebar.tsx:419-440`（名前を変更 / アイコンを変更… / セクション移動 / Favorites から外す）
- 行下の編集枠パターン: `IconEdit.tsx`（プレビュー + 入力欄 + ボタン + エラー表示。
  `onSubmit: (v) => Promise<boolean>` で main 拒否時に枠内エラー。Esc / 枠外 mousedown で閉じる。
  設置場所はピンが行直下 `PinnedTree.tsx:285-296`、Favorite がグリッド下 `Sidebar.tsx:464-477`）
- 名前編集とアイコン編集は既に排他（`Sidebar.tsx:286-294`、`PinnedTree.tsx:231-245`）
- `settings-schema.js` は `ext-lock.js` → `node:fs` に触るため renderer から import 不可。
  renderer 側で事前バリデーションが欲しければ `src/shared/favorites.js` 系の分離モジュールに置く
  （ただし main の boolean 返しでエラー表示する IconEdit パターンなら renderer 側検証は必須ではない）
- 新フィールドは足さない（既存の `url` を書き換えるだけ）ので `SETTINGS_VERSION` / `PINS_VERSION` は据え置き
- 検証スイートは `pins`（`scripts/verify-pins.mjs`、配線済み・フル実行で常に回る・`restart` 随伴）。
  既存の URL 更新テスト :530-573、コンテキストメニュー UI テスト :749-775 が拡張の型になる。
  今回触るファイルはほぼ OWNERS 外なので `--changed` はフルに倒れる → 開発中は
  `mise run verify:only pins`（restart 随伴）で絞る

## 実装計画

### Phase 1: store 層（main） [AI🤖]

- [x] ~~`pins.ts` に `updateFavoriteUrl(id, url): boolean` を新設~~ →
  既存 `updatePinnedUrl` をピン・Favorite 両対応の **`setDefinitionUrl(id, url)` に統合**
  （ログ > 方針変更を参照。重複チェック・favicon リセットの不変を 1 関数に寄せた）
  - `normalizeStoredUrl` 不通過で `false`、同じ URL なら `true`（no-op）
  - ピン ↔ Favorite クロス含む重複で `false` + `log('definition.url_update_rejected', { id, reason: 'duplicate_url' })`
  - 成功時 `log('definition.url_updated', { id, kind: 'pin' | 'favorite' })`
- [x] 「host が変わったら `faviconUrl = null`」を実装
- [x] ログイベントの detail が `sanitizeDetail` で壊れないことを確認
  （node ワンライナーで実測: `{"id":"abc","kind":"favorite"}` / `{"id":"abc","reason":"duplicate_url"}` がそのまま通る。
  フラット構造・URL 非含有なので専用ユニットテストは足していない）

### Phase 2: IPC・preload・registry [AI🤖]

- [x] 新 IPC: ~~`nemo:set-pinned-url` / `nemo:set-favorite-url`~~ → **`nemo:set-definition-url`（`id`, `url`）→ `boolean` の 1 本**
  - 「タブが閉じていても使う操作なのでタブから導出できない。URL は `normalizeStoredUrl` が http/https に閉じる」と
    コメントで根拠を明記
- [x] 「このページに更新」の Favorite 版: `nemo:update-favorite-url`（タブ key のみ、既存方針どおり）
  + `registry.ts` に `updateFavoriteUrlFromTab(tab)`
- [x] preload `ui.ts` と `types.ts` の `NemoUiApi` に 3 メソッド追加
  （`updateFavoriteUrl` / `setDefinitionUrl`。`updatePinnedUrl` は既存のまま）

### Phase 3: renderer UI [AI🤖]

- [x] `UrlEdit.tsx` を新設（`IconEdit.tsx` パターン流用: 入力欄 + 保存ボタン + エラー表示、
  Esc / 枠外 mousedown で閉じる）
  - エラー文言は renderer 側の http/https 事前チェックで「使えない URL」と「重複」を出し分けた
- [x] `PinnedTree.tsx`: メニューに「URLを変更…」追加、行直下に UrlEdit、名前・アイコン・URL の 3者排他
- [x] `Sidebar.tsx`: メニューに「URLを変更…」「このページに更新」（タブが開いているときのみ）、
  グリッド下に UrlEdit、3者排他
- [x] 編集枠の初期値は現在の定義 URL（全選択状態で出す）

### Phase 4: 自走検証 [AI🤖]

- [x] `verify-pins.mjs` に追加（計 17 検査 = API 7 + UI 10）:
  - メニューに「URLを変更…」が出る（ピン・Favorite 両方）
  - 編集枠から有効な URL を保存 → 定義の url が差し替わる → 閉じて開き直すと新 URL で開く
  - 不正 URL（`file:` 等）が拒否されエラー表示が出る
  - 他ピン / 他 Favorite が持つ URL への変更が拒否される（ピン→ピン、ピン↔Favorite のクロスも）
  - host が変わる編集で faviconUrl が null に落ちる（直前に favicon が入っていることも検査）
  - Favorite の「このページに更新」が効く / タブが閉じていると出ない
- [x] 実行件数を確認: スイート全体 130 PASS / 0 FAIL（従来 113 + 追加 17）。
  新検査は全ログに検査名で出ていることを確認済み
- [x] `mise run verify:only pins` 通し（exit 0）

### Phase 5: 仕上げ [AI🤖]

- [x] `docs/operations.md` のサイドバー3層の節に「URLを変更…」を追記
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に追記

### 動作確認 [人間👨‍💻]

- [ ] 常用 Nemo で Google カレンダーの Favorite の URL を
  `https://calendar.google.com/calendar?authuser=...` に書き換え、クリックで意図どおり開くこと

## ログ

### 試したこと・わかったこと
- lint の prettier 警告 3 件（verify-call.mjs / verify-spike.mjs / test-extension/manifest.json）は
  今回触っていないファイルで元から未整形。本コミットでは触らない

### 方針変更
- **store は `updateFavoriteUrl` 新設でなく、`updatePinnedUrl` を `setDefinitionUrl` に統合**。
  既存の `renameNode` / `setCustomIcon` がピン・Favorite を 1 関数で扱う型に合わせ、
  重複チェック（ピン ↔ Favorite クロス含む）と favicon リセットの不変を 1 か所に寄せた。
  「このページに更新」（ピン / Favorite）と「URLを変更…」の 4 経路すべてがここを通る。
  ログイベントは `pin.url_updated` / `pin.url_update_rejected` →
  `definition.url_updated` / `definition.url_update_rejected` に改名（他に参照箇所が無いことを grep で確認済み）
- **IPC も 2 本でなく `nemo:set-definition-url` の 1 本**（store が 1 関数になったため）
