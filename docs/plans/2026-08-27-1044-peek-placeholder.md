# Peek を開いた瞬間にプレースホルダーを出す

## 概要・やりたいこと

`target="_blank"` / `window.open` のリンクを踏むと Peek（ウィンドウ内ポップアップ）が開くが、
**暗幕（黒 30% + blur 3px）だけが先に出て、肝心の「窓」が数百 ms〜数秒あらわれない**。
リンクを踏んだ手応えが「画面が暗くなっただけ」になり、操作が効いたのか分からない。

Peek 本体の矩形（ページ領域の 91%・角丸 16px）を、ページが最初のペイントを返す前から
**無地の面で埋めておく**ことで、踏んだ瞬間に「窓が出た」と分かるようにする。

## 前提・わかっていること

### 現状の作り

- popup は `registry.ts:1862 openPeek()` が受け、Electron が用意した子 `WebContents` を
  `new WebContentsView({ webContents })` で**採用**する（`NemoTab.materialize({ adopt })`、`registry.ts:467-483`）
- 暗幕と ✕ / ⌘O ボタンは **Peek 専用の UI View**（`peekChromeView`、`ui-view.ts` の `view === 'peek'`）が描く。
  React の state 更新だけで出るので**速い**
- z 順は `layout()` が毎回組み直す（`registry.ts:1263`）。下から
  **ページ → Peek の暗幕 → Peek 本体 → オーバーレイ**
- 角丸は `layout()` の中で `view.setBorderRadius(PEEK_RADIUS)`（`registry.ts:1274`）

### 原因

`materialize()` が作る**ページ用の `WebContentsView` には `setBackgroundColor` が一切指定されていない**。
UI View 側は透明色を明示している（`ui-view.ts:106`）が、ページ用 View は既定のまま。
そのため最初のペイントが来るまで Peek 本体の矩形は透け、下の暗幕がそのまま見える
＝「ぼかしだけ入って窓が出ない」。

### /dig-lite で決めたこと

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 中身 | **無地の角丸サーフェスだけ**（ホスト名・スピナー・枠は出さない） | 「placeholder 的なやつだけでも」という要望。要素を足すと本表示との二段階変化が目立つ |
| 色 | **`#1b1b20`**（`--nemo-sidebar` と同じ暗い面） | アプリの UI トーンに揃える |
| 範囲 | **Peek のみ** | 小窓は `BaseWindow` に `backgroundColor: '#16161a'` が既にあり（`registry.ts:1020`）窓の形は即出る。通常タブは影響範囲が広い |

### 方式（Phase 1 の実測を経て確定）

プレースホルダーは **Peek の暗幕を描いている UI View（`view=peek`）の中に、CSS の矩形として描く**。
Peek 本体の View は**ドキュメントが届く（`dom-ready`）まで出さない**。

- 当初案（Peek の View に `setBackgroundColor`）は**採用済み `WebContents` に効かない**ため破棄した（ログ参照）
- 空の View が上に乗ったままだと、その下のプレースホルダーの見え方を信用できない。
  View 自体を後から出すことで、待ち時間中に見えるものを暗幕とプレースホルダーだけに絞る
- 矩形は暗幕 View がページ領域そのものなので **CSS の割合で表せる**
  （幅 91%、高さ `min(91%, 100% - 84px)`、中央）。main の `peekBounds()` と同じ値になる

### 残っている注意点

1. **矩形の値が main（`PEEK_RATIO` / `PEEK_TOOL_BAND`）と CSS の2か所に出る**。
   DESIGN.md の「Peek」の表を唯一の出どころにして、両方からそこを指すコメントを書く
2. **`dom-ready` が来ないページ**（204・ダウンロード・即 `window.close()`）で View が出ないままにならないこと。
   保険のタイムアウトを必ず置く
3. **隠している間も拡張から見た active は Peek のまま**（`syncForegroundTab` は View の可視性を見ていない）。
   Bitwarden の自動入力が Peek を指す既存の性質を壊さないこと

## 実装計画

### Phase 1: 挙動の実測 [AI🤖]

- [x] `scripts/test-server.mjs` に**応答を止められるエンドポイント**を足す
      （`__nemo_gate__` / `__nemo_gate_state__` / `__nemo_gate_release__`）
- [x] 使い捨て userData（`NEMO_USER_DATA_DIR=$(mktemp -d)`）で dev 版を起動する
- [x] `setBackgroundColor('#ff00ff')` が採用済み View に効くか実測する → **効かない**
- [x] 自前生成の View にも同じ色を当てて差を確かめる → **そちらは効く**（切り分け完了）
- [x] `setBorderRadius` は採用済み View でも効くことを確認する
- [x] 実測結果を「ログ > 試したこと・わかったこと」に記録し、代替案へ切り替える

### Phase 2: 実装 [AI🤖]

- [x] **Peek の View を `dom-ready` まで出さない**。`NemoTab` に「まだドキュメントが来ていない」印を持たせ、
      `visibleTabKeys` から外す。`dom-ready` / 読み込み失敗 / 保険のタイムアウトのいずれかで印を落として
      表示に切り替える（**印を落とす経路は1か所にまとめる**。取りこぼすと Peek が永久に出ない）
- [x] 暗幕の UI View（`Peek.tsx`）に、印が立っている間だけプレースホルダーの矩形を描く。
      判定は既存の `TabState.visible`（新しい状態は増やさない）
- [x] `styles.css` に `.peek-placeholder` を足す。幅 91%・高さ `min(91%, 100% - 84px)`・中央・
      角丸 16px・面 `#1b1b20`。**DESIGN.md の「Peek」の表を指すコメント**を添える
- [x] 暗幕のフェードイン（`peek-fade` 0.16s）とプレースホルダーの見え方を揃える

### Phase 3: 検証 [AI🤖]

- [x] `scripts/verify-peek.mjs` に検査を足す。ゲートで止めた Peek について:
  - **プレースホルダーが描かれている**こと。暗幕 UI View に CDP でつなぎ
    `Page.captureScreenshot` を撮り、中央・面の内側・角丸の外側の3種を判定する
    （**OS のウィンドウキャプチャは使わない**。別 Space だと古い絵が返る。ログ参照）
  - **Peek の View がまだ出ていない**こと（`TabState.visible === false`）
  - 解放後に **View が出て、プレースホルダーが消える**こと
- [x] **修正前のコードで FAIL すること**を確認して出力を控える（`git stash` で Phase 2 の変更だけ戻す）
- [x] `mise run verify:only peek` を通し、既存の Peek 検証（opener・POST・昇格・上限）を壊していないこと
- [x] `dom-ready` が来ない経路（即 `window.close()` する子）で Peek が出ないままにならないこと

### Phase 4: ドキュメント [AI🤖]

- [x] `DESIGN.md` の「Peek」の表にプレースホルダーの行を足す（面 `#1b1b20`・`dom-ready` まで）
- [x] `VERIFY.md` に人が見る手順を追記する（合成後の見た目は機械では見られないため）。
      既存の「Peek と小窓（実機で人が見る分）」の粒度に合わせる
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に `### 修正` として1行

### 動作確認 [人間👨‍💻]

- [ ] 実際に重いサイト（ニュースサイトの外部リンクなど）で `target="_blank"` を踏み、
      踏んだ瞬間に窓の形が出ることを体感で確認する
- [ ] 白地のページを開いたとき、暗い面 → 白ページの切り替わりが不快でないこと
- [ ] OAuth のポップアップ（`window.open` にサイズ指定があるもの）でも同じく違和感が無いこと

## ログ

### 試したこと・わかったこと

**Phase 1 の実測（2026-08-27）**

`setBackgroundColor` は **採用済み `WebContents`（`new WebContentsView({ webContents })`）には効かない**。
同じビルドで、自前生成の View（通常タブ）に同じ色を当てると即座に出る。

| 当てた先 | 結果 |
| --- | --- |
| 自前生成の View（通常タブ、`__nemo_gate__` で描画前に止めたもの） | `#ff00ff` が出る |
| 採用済みの View（Peek） | 変化なし。生成直後でも 800ms 後に付け替えても効かない |
| `overrideBrowserWindowOptions.backgroundColor` で子に渡す | 効かない |

`setBorderRadius` は採用済み View でも効く（解放後のスクショで角丸を確認）。

**保険のタイムアウトは実測で効いている**。ゲートを解放せずに待つと、8 秒後に
`peek.revealed` が `reason=timeout` で出て View が表示に切り替わる（永久に出ないままにならない）。

**`verify-peek.mjs` の既存3件（暗幕の View / ⌃M）は間欠的に落ちる**。変更前のコード（`verify-peek.mjs` も
元に戻した状態）でも同じ3件が落ち、変更後の再実行では 71 件すべて PASS した。今回の変更とは無関係。

**スクリーンショットによる検証には制約がある**。`screencapture -o -l <windowID>` は
別 Space のウィンドウも影なし・原点ぴったり（Retina は物理 2 倍）で撮れるが、
**撮れる内容が古いことがある**（ウィンドウが別 Space にあると Chromium がページを描き直さず、
サイドバーが数タブ前の状態のまま写る）。ウィンドウが `kCGWindowIsOnscreen` でないときの
ピクセル判定は当てにならない。ウィンドウ ID は JXA から取れる
（`osascript -l JavaScript` + `ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0)))`。
`objectForKey` の戻り値をそのまま触ると `Ref has no type` で落ちる）。

### 方針変更

**プレースホルダーは暗幕 UI View 側に描く（Phase 1 の実測を受けて）**

`setBackgroundColor` が採用済み View に効かないため、当初案（Peek の View に背景色を敷く）は破棄。
plan にあらかじめ書いておいた代替案に切り替える。あわせて、**ドキュメントが届くまで
Peek の View を出さない**（`dom-ready` まで隠す）ことにした。空の View が上に乗っていると
下のプレースホルダーの見え方をそのまま信用できないため、View 自体を後から出す。

これに伴い、昇格時の背景色の解除（当初の P0）は**不要になった**。背景色を一切当てないため。

**ピクセル判定は OS のウィンドウキャプチャをやめ、UI View の CDP スクショで行う**

上記のとおり OS のウィンドウキャプチャは別 Space で古い絵を返すため、判定に使えない。
代わりに、プレースホルダーを描いているのが暗幕 UI View（レンダラ）であることを利用して
**CDP の `Page.captureScreenshot` でその View だけを撮る**。Space に依存しない。
撮った PNG は `sips` で BMP に変換して読む（PNG デコーダを持ち込まないため）。
View の出し分け（`dom-ready` まで隠す）は `TabState.visible` で検査する。
**合成後（ページの上に重なった状態）の見た目だけは機械では見られない**ので、
VERIFY.md の人間の手順に残す。
