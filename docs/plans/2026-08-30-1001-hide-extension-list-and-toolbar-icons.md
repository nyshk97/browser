# サイドバー下の拡張一覧を消し、ツールバーの拡張アイコンを Bitwarden だけにする

## 概要・やりたいこと

- サイドバー左下（footer）に有効な拡張の名前が並んでいるが、設定画面（⌘,）に同じ一覧と ON/OFF があるので不要。
  footer は ⚙ とバージョン表示だけにする
- ウィンドウ右上のツールバーに有効な拡張全部のアイコンが並ぶが、クリックして使うのは Bitwarden だけ。
  Keepa / GraphQL Network Inspector のように「入っていればページ側で勝手に働く」拡張は、有効でもアイコンを出さない
- どの拡張をツールバーに出すかは `extensions.lock.json` で決める（allowlist の正が lock なので同じ場所で管理する）

## 前提・わかっていること

- footer は `src/renderer/components/Sidebar.tsx` の `ExtensionFooter`。拡張ボタン・「lock 不一致」警告・「拡張なし（シークレット）」を描いている
  - 「lock 不一致」は設定画面（`Settings.tsx:131`）にも同じ表示があるので footer からは落としてよい
  - シークレットの注意はサイドバー上部（`Sidebar.tsx:116`「拡張は動かない」）に別途あるので「拡張なし（シークレット）」も落としてよい
  - `scripts/verify-packaged.mjs:190` が `.footer .version` を読む。**バージョン表示は残す**のでそのまま通る
- ツールバーのアイコンは electron-chrome-extensions の `<browser-action-list>`（`Toolbar.tsx:193`）。
  Shadow DOM（`mode: "open"`）に `<button id="<拡張ID>" class="action" part="action">` を並べる（`node_modules/electron-chrome-extensions/dist/esm/browser-action.mjs:222-247`）。
  main 側の `getState()` は全 action を返し、絞る API は無い
  - `::part(action)` は id で絞れないので、**renderer 側で shadowRoot に `<style>` を1枚 append** して、対象外の `.action` を `display:none` にする。
    ライブラリは `.action` の追加・削除しかしないので差し込んだ style は消えない
  - popup の位置はボタンの `getBoundingClientRect` 基準（`PopupView.updatePosition`）なので、他のボタンを隠しても Bitwarden の popup 位置はずれない
- lock のエントリ型は `LockedExtension`（`src/main/extensions.ts:29`）、検証は `src/shared/ext-lock.js` の `validateEntry`（未知フィールドは弾かない）。
  `LoadedExtensionInfo`（`src/shared/types.ts:786`）が main → renderer に流れる。`disabledInfo` / `loadLockedEntry` の 2 箇所で組み立てている
- `scripts/verify-ext-smoke.mjs:418-432, 484-500` は `browser-action-list` の**最初の `.action` をクリックして popup の位置を検証する**。
  テスト拡張（`scripts/make-test-extension.mjs` が生成する lock）にフラグを付けないと、隠れたボタン（rect が 0）を拾って偽 fail になる
- 実装の決定（/dig-lite）: フラグ名は `showInToolbar`（省略時 `false`）。`extensions.lock.json` では Bitwarden だけ `true`

## 実装計画

### Phase 1: lock にフラグを足して renderer まで流す [AI🤖]
- [x] `src/shared/ext-lock.js` の `validateEntry`: `showInToolbar` は省略可、あれば boolean であることを検証（`scripts/ext-lock.test.mjs` にケース追加）
- [x] `LockedExtension` / `LoadedExtensionInfo` に `showInToolbar: boolean` を足す（`disabledInfo` と `loadLockedEntry` の両方で `entry.showInToolbar === true` を載せる）
- [x] `extensions.lock.json` の Bitwarden エントリに `"showInToolbar": true` を足す（`mise run ext:verify` で lock が通ることを確認。`ext:update` は `writeLock` が JSON を丸ごと書き戻すのでフラグは保持される）
- [x] `scripts/make-test-extension.mjs` が生成する lock のエントリに `showInToolbar: true` を足す（smoke がクリック対象を失わないため）

### Phase 2: UI [AI🤖]
- [x] `Sidebar.tsx` の `ExtensionFooter` から拡張ボタン・`mismatched`・「拡張なし」を削除し、⚙ と `VersionBadge` だけにする。不要になった `extensions` の useMemo / `isPrivate` props / `.footer .ext` `.footer .warn` の CSS を消す
- [x] `Toolbar.tsx`: `<browser-action-list>` に ref を付け、`shared.extensions` から `showInToolbar && enabled` の ID 集合を作り、shadowRoot に `.action:not(#id1):not(#id2) { display: none }` の `<style data-nemo-action-filter>` を差し込む（一覧が変わったら textContent を更新。対象が 0 件なら `.action { display: none }`）。
  shadowRoot はカスタム要素の定義後に付くので、`customElements.whenDefined('browser-action-list')` を待ってから触る
- [x] `src/shared/types.ts` の `LoadedExtensionInfo.enabled` のコメント「サイドバーのフッターは ON だけ出す」を直す

### Phase 3: 検証 [AI🤖]
- [x] `scripts/verify-ext-smoke.mjs` に「lock で `showInToolbar` の無い拡張のボタンが shadowRoot 内で `display: none` になる」検査を足す。
  テスト拡張は 1 つなので、`make-test-extension.mjs` にフラグ無しの 2 個目を足すのは重い → 起動後に `window.nemo` 経由でなく、**ツールバー側で一時的に別 id の `.action` を shadowRoot に複製して `getComputedStyle` を見る**（境界を意図的に作る）。修正前にこの検査が FAIL することを確認してから実装に進む
- [x] ~~`scripts/lib/verify-targets.mjs` の `OWNERS`~~: `Toolbar.tsx` / `Sidebar.tsx` / `main/extensions.ts` / `shared/ext-lock.js` / `make-test-extension.mjs` の既存エントリに `ext-smoke` が入っているか確認し、無ければ広げる（配線を外して 0 件になることを一度見る）
- [x] `mise run verify:only ext-smoke`、`node --test scripts/ext-lock.test.mjs`、`mise run typecheck`（相当）、`mise run verify:only packaged` の footer version 検査
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に記載

### 動作確認 [人間👨‍💻]
- [ ] 常用インスタンスを更新後、右上に Bitwarden のアイコンだけが出て、クリックで popup が正しい位置に開く
- [ ] Keepa が Amazon の商品ページで従来どおり働く（アイコンが無いだけで拡張は動いている）
- [ ] 左下が ⚙ と v0.x.x だけになっている

## ログ
### 試したこと・わかったこと
- 修正前 FAIL の確認: `Toolbar.tsx` だけ HEAD に戻して `node scripts/verify-ext-smoke.mjs` → 「showInToolbar でない拡張のボタンは隠れる」「表示フィルタの style は 1 枚だけ」の 2 件 FAIL。自分の版に戻すと全件 PASS
- `mise run lint` の prettier warn（`test-extension/manifest.json`）は HEAD 時点からあるもので今回の変更と無関係（未変更）

### 方針変更
- `OWNERS` の広げ直しは不要だった: `Sidebar.tsx` / `Toolbar.tsx` / `main/extensions.ts` は `OWNERS` 外（触るとフル扱い）で、`verify-ext-smoke.mjs` は `KNOWN_TARGETS` に無く `mise run verify` の外（`UNMAPPED_VERIFY_SCRIPTS`）。取り消し線にした
