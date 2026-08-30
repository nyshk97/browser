# Favorites / ピン留めにカスタムアイコン（絵文字・画像）を付ける

## 概要・やりたいこと

サイドバーの Favorites グリッドで同じサービス（Slack のワークスペース 3 つなど）が並ぶと favicon が同一で区別できない。
`customTitle` と同じく**ユーザーが上書きする層**として `customIcon` を定義に持たせ、絵文字 1 文字または画像で置き換えられるようにする。

- 対象は Favorite と ピン留め（`PinnedLink`）の両方。同じ需要がすぐ出るので最初から同じフィールドで持つ
- 既定 favicon（`faviconUrl`、タブから自動で写る）は今のまま。`customIcon` があればそれが勝つ

## 前提・わかっていること

- 定義の正規化は `src/shared/settings-schema.js` の `normalizeFavorite` / `normalizePinnedList`。**ここに無いフィールドは次回起動で消える**（CLAUDE.md）。スロットも同関数を通るので slots-schema には書かない
- 既定 favicon は `normalizeDefinitionFaviconUrl`（data: ≤ 2KB / https ≤ 4096）。2KB の理由は「全件に付く・pins.json 全体書き直し」。`customIcon` は数件しか付かないので別上限を持つ
- UI の CSP は `img-src 'self' crx: data: https:`
- 上書きの型は `renameNode`（`src/main/store/pins.ts:236`）が手本: favorites と pinned ツリーの両方を走査して `{ ...node, customTitle }`、`commit` + `log('definition.renamed')`
- グリッドセルは `src/renderer/components/Sidebar.tsx:339-405`。描画は `<Favicon url title src={tab?.faviconUrl ?? favorite.faviconUrl} />`。名前の編集は「グリッドの下に `.fav-edit` を出す」方式、右クリックは `RowMenu`
- セルの `onDrop` は既にタブ / Favorite の並べ替えを受けている（`dropTab` → `moveFavorite`）
- セーブスロット（`normalizeSlot`）は `normalizePins` を呼んで `favorites` / `pinned` をそのまま持つので、customIcon はスロットの保存・復元では**自動的に残る**。範囲外なのはカードの `icons`（URL 単位の別系統）だけ
- `OWNERS` に今回触るファイル（`Sidebar.tsx` / `PinnedTree.tsx` / `pins.ts` / `settings-schema.js` / `favorites.js` / `ipc.ts` / `preload/ui.ts`）は**載っていない**＝未登録はフルに倒れる安全側。載せると pins だけに絞られる改悪になるので変更しない
- 自走検証は `scripts/verify-pins.mjs`（`verify-all.mjs` の `if (want('pins'))` に配線済み）。検査を足したら**実行件数**を報告する

### 決定表

| 項目 | 決定 |
|---|---|
| フィールド名 | `customIcon: string \| null`（Favorite / PinnedLink 共通。フォルダには付けない） |
| 絵文字の形式 | `trim()` 後に `Intl.Segmenter('und', { granularity: 'grapheme' })` で **1 grapheme** かつ長さ ≤ 32（👨🏻‍❤️‍💋‍👨🏻 は UTF-16 で 15 単位）。空・`\p{White_Space}`・`\p{Cc}` を含むものは null（空白 1 文字が「消えたように見えるアイコン」として保存されるのを防ぐ）。`\p{Cf}`（ZWJ U+200D）は 1 grapheme に収まる限り通す（通さないと 👨‍👩‍👧 / 🏳️‍🌈 が落ちる。VS16 U+FE0F は Mn なので元から対象外）。2〜3 文字のテキストは今回やらない（1回目で決定。緩めるなら描画の font-size 設計ごと見直す）。**1 文字のテキスト（`W` / `#`）は通す**（実装レビュー 1 回目で決定: grapheme 判定のままで済み、後から絞ると既存の設定値が黙って消える） |
| 画像の形式 | `data:image/png;base64,` 前置きのみ（renderer が必ず PNG に変換して送るので受け口を広げない）。https は許さない（外れると頭文字に戻り、上書きしたのに消える体験になる） |
| 画像の上限 | `MAX_CUSTOM_ICON_LENGTH = 16 * 1024`。renderer で canvas 64×64 に縮小 → PNG（透過保持）。超えたら 48 → 32 と段階的に縮めて最初に収まったものを送り、それでも超えたらエラー表示 |
| 描画優先順 | `customIcon` → `tab.faviconUrl` → `faviconUrl` → 頭文字。**出す場所は Favorites グリッドとピン留め行のみ**。スイッチャー / TabRow / SplitRow とセーブスロットのカード（`slots-schema.js` の `icons`）は今回の範囲に入れない（1回目で決定。スロットは URL 単位の別系統で、定義の上書きを写す設計が別途要る） |
| 絵文字の描画 | セル中央に `font-size` をアイコンサイズに合わせたテキスト（画像と同じ矩形に収める）。バッジ重ねは**やらない** |
| 入力導線 | ① 右クリック「アイコンを変更…」→ 1 行の枠 `[今のアイコン（設定済みなら角に ×）] [絵文字の狭い入力欄（placeholder 😀）] [🖼 画像…]`。絵文字は欄に 1 個入れて Enter（IME の変換確定 Enter は無視）。× で favicon に戻す。閉じるのは Esc / 枠外クリック ② セルへ画像ファイルをドロップ（`dataTransfer.files` があるときだけ分岐） |
| IPC | `nemo:set-custom-icon (id, icon: string \| null)`。ipc.ts のガードは**型と暴走止めだけ**（`string | null` 以外、および `MAX_CUSTOM_ICON_LENGTH` の数倍を超える文字列は throw。正規の renderer は段階縮小で到達しない。`requireString` / `optionalTitle` は ≤ 4096 で throw するので使わない）。長さ・形式の判定は `normalizeCustomIcon` に集約し、`setCustomIcon` が `false` を返す。`NemoApi.setCustomIcon(id, icon): Promise<boolean>`。**明示 `null` だけが解除**。不正値は既存のアイコンを消さずに拒否（`false`）し、「消えた」と「拒否した」を区別できるようにする。画像選択は renderer の `<input type="file">` で読み、data URL にして同 IPC に渡す（main 側にダイアログを足さない） |
| ログ | 成功: `definition.icon_changed` `{ id, kind: 'emoji' \| 'image' \| null }`、拒否: `definition.icon_rejected` `{ id, reason: 'too_long' \| 'invalid' }`（既存の snake_case に揃える。data URL は detail に入れない） |

## 実装計画

### Phase 1: スキーマとストア [AI🤖]
- [x] `src/shared/favorites.js`（Node 非依存）に `MAX_CUSTOM_ICON_LENGTH` と `normalizeCustomIcon(value)`（絵文字判定 / data:image 判定）を置き、`settings-schema.js` から re-export
- [x] `normalizeFavorite` / `normalizePinnedList`（link のみ）に `customIcon` を足す。`PINS_VERSION` は上げない（欠損は null に倒すだけ）。doc コメントの「版を上げずに足した」列挙に customIcon を追記
- [x] `src/shared/types.ts` の `FavoriteItem` / `PinnedLink` に `customIcon: string | null`
- [x] `src/main/store/pins.ts` に `setCustomIcon(id, icon): boolean`（`renameNode` と同型。`pinUrl` / `addFavorite` の新規作成時は null）
- [x] `convertPinToFavorite` / `convertFavoriteToPin` の `target` 生成に `customIcon` を引き継ぐ（`faviconUrl` と同じく手で組み立てているので、足さないと変換でユーザーのアイコンだけ消える）
- [x] `settings-schema` のユニットテストに「絵文字 1 個は通る / ZWJ 絵文字（家族・虹旗）と国旗（regional indicator ×2）は通る / 2 個は落ちる / 空白 1 文字は落ちる / 上限超え data は落ちる / https・PNG 以外の data は落ちる / 旧データ（フィールド欠損）は null / `normalizePins(normalizePins(x))` が等価（冪等）」を足す

### Phase 2: IPC と renderer [AI🤖]
- [x] `src/main/ipc.ts` に `nemo:set-custom-icon`、`src/preload/ui.ts` と `types.ts` の `NemoApi` に `setCustomIcon`
- [x] `Sidebar.tsx` のセル描画を分岐: 絵文字は `<span className="fav-emoji">`、それ以外は `<Favicon src={customIcon ?? tab?.faviconUrl ?? faviconUrl}>` と 1 本に畳む（`Favicon` は読み込み失敗で頭文字に落ちるので、別々に渡すと壊れた customIcon が中間段を飛ばす）
- [x] 絵文字入力（Enter で確定）+ 「画像を選ぶ…」+ 「既定に戻す」を `IconEdit` コンポーネントに切り出す。Sidebar は右クリック「アイコンを変更…」→ `.fav-edit` 内に出す（名前 / アイコンの 2 モード）。入力欄の初期値は customIcon が絵文字のときだけそれ、画像のときは空（data URL を欄に入れない）にし、画像が入っていることはサムネイル＋「既定に戻す」で示す
- [x] 画像は renderer で `FileReader.readAsDataURL` → `<img src={dataUrl}>` → `img.decode()` → canvas → `toDataURL('image/png')`（`createImageBitmap` は SVG を扱えず、CSP に `blob:` が無いので object URL も使えない）。決定表の段階縮小で収まらなければ送らずにエラー表示。IPC が `false` を返したときも同じエラー表示
- [x] セルの `onDrop` で `event.dataTransfer.files[0]` が画像なら customIcon に設定して return（既存の並べ替え経路より前に判定）。`acceptsDrag` に `items[0].type` が `image/` 前置きのファイルドラッグを足し（PDF 等でハイライトしない）、グリッド / 空グリッド側の `onDrop` でもファイルを飲み込む（受けないなら return。隙間に落として `will-navigate` に弾かれるのを防ぐ）
- [x] `PinnedTree.tsx` の**リンク行**にも同じ描画分岐と右クリック項目を足し、`IconEdit` を対象行の直下に出す（行内 `InlineRename` とは別枠）
- [x] `styles.css` に `.fav-emoji` と `.fav-edit` のアイコンモード分

### Phase 3: 自走検証 [AI🤖]
- [x] `scripts/verify-pins.mjs` に追加: ① 絵文字の設定を `--lazy-write` に、再起動後の残存確認を `--lazy-read` に置く（`--only restart pins` で走る） ② 上限超え / 不正値の data URL は IPC で `false` を返し、**既存のアイコンが残っている** ③ `customIcon` を持つセルがグリッドに絵文字で描画されている（`.fav .fav-emoji` を引く） ④ ピン⇄Favorite 変換でアイコンが保持される（既存の変換検査に check を足す）。冪等性は Phase 1 のユニットテストで見る
- [x] `scripts/lib/verify-targets.mjs` の `OWNERS` は変更しない（前提の節を参照。新規 `IconEdit.tsx` も載せない）。`--changed` で今回のファイルがフルに倒れることだけ確認する
- [x] 既存スイートへの追加なので「配線外しで 0 件」ではなく、追加前後で `mise run verify:only pins` / `restart pins` の検査件数を取り、差分が足した check 数と一致することを報告に出す
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に記載

### 動作確認 [人間👨‍💻]
- [ ] 常用インスタンスで Slack ×3 に絵文字を割り当て、⌘1〜9 のツールチップと見た目で区別できるか
- [ ] 画像ドロップ（PNG / SVG）で見た目が崩れないか

## ログ
### 試したこと・わかったこと
- `mise run verify:only pins` では restart（`--lazy-write` / `--lazy-read`）が回らない（随伴は `--changed` の `selectVerifyTargets` だけ）。`verify:only pins restart` と明示して 121 件 PASS。VERIFY.md の文言を直した
- 追加した check は 19 件（通常節 16・lazy-write 1・lazy-read 2）で、名前で突き合わせて 19/19 が実行されたことを確認
- `--changed` は今回の全ファイルが `OWNERS` 未登録なので `kind: 'full'` に倒れる（plan どおり OWNERS は変更していない）
- 「絵文字ピッカーが開かない」報告は、IPC を足す前の main プロセス（電源入れっぱなしの dev 版）で試していたのが原因。使い捨てプロファイルで新ビルドを立てて CDP から「😀 絵文字」を押すと `CharacterPalette` プロセスが起動し（`pgrep -x CharacterPalette`）、不可視 input への挿入を模した `onChange` で customIcon が保存されることを確認（scratchpad の `emoji-probe.mjs`）。**main を触ったら dev 版の再起動が要る**
- Claude Code の Bash tool は制御文字（U+0000 / U+0007）を含むコマンドを弾く。テストに制御文字ケースを書くときは `'\u0007'` のエスケープ表記にする

### 方針変更
- 「既定に戻す」「閉じる」ボタンを無くし、プレビューの × と Esc / 枠外クリックに置き換えた（ユーザー判断: モックの F 案）
- 一度「入力欄を見せず `app.showEmojiPanel()` で選んだ瞬間に保存」にしたが、**パネルの挙動が安定しない**（ユーザー実機）ためやめ、絵文字 1 個ぶんの狭い入力欄（placeholder 😀）+ Enter に戻した。`nemo:show-emoji-panel` の IPC も外した
- 絵文字か画像かの判定は `favorites.js` の `isImageIcon` に寄せた（3 回目レビューの P2 で見送っていたが、Sidebar / PinnedTree / IconEdit / pins.ts の 4 か所で同じ前置き判定が要ったので入れた）
- ドロップで拒否されたときのエラー表示は、対象セルの `IconEdit` を開いて枠内に出す方式にした（サイドバーに toast の仕組みが無い）
