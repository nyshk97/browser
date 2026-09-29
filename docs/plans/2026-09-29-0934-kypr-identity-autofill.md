# kypr に「個人情報」を足し、フォーム自動入力の値の元にする

## 概要・やりたいこと

フォーム自動入力（右クリック →「フォーム自動入力」。`docs/plans/2026-09-27-2042-form-autofill-jev-impl.md`）の値は、
今は iCloud に置いた別の保管庫（`autofill.json`。パスフレーズで暗号化）に入っている。これを **kypr の新しい種類「個人情報」
（`type: "identity"`）に移し**、あわせて**パスポート・運転免許証・健康保険証の番号と有効期限**も入れられるようにする。

- 解除が kypr の Touch ID 1 回で済み、別のパスフレーズが無くなる。同期も kypr の仕組みで全 Mac に届く
- 身分証の番号・期限も、今の自動入力と同じく「フォーム自動入力」でまとめて埋める（欄を選んで入れるメニューは作らない）
- 作成・編集は Nemo のポップアップと kypr Web の両方でできるようにする。iOS は後回し（それまでは読み取り専用で表示される）

作業は 2 つのリポジトリにまたがる（kypr: 仕様・`packages/crypto`・Web ／ Nemo: ポップアップ・自動入力）。コミットはリポジトリごとに分ける。

## 前提・わかっていること

### 決定事項（/dig-lite で確定）

| 論点 | 決定 |
|---|---|
| 置き場所 | kypr の新しい種類「個人情報」（`type: "identity"`, `schema: 1`）。棚の名前は「個人情報」 |
| 件数 | 複数件持てる（自分・会社・家族など）。フォーム自動入力は**既定の 1 件**を使う（サブメニューで選ばせない） |
| 既定の 1 件の置き場所 | **Nemo の設定（Mac ごと）**に kypr のアイテム ID を持つ。自動入力するのは Nemo だけなので kypr の仕様には入れない。未設定・既定のアイテムが消えた（ゴミ箱を含む）ときは**一番古い 1 件**を使う |
| 保存の形 | 「項目名: 値」を平らに並べ、キーに書類名を付けて区別する（入れ子にしない）。画面ではグループに分けて見せる。日付の項目は生年月日と同じ扱い（`YYYY-MM-DD`） |
| 書類名の無い「有効期限」の欄 | Jev には汎用の `document_expiry` を選ばせ、**どの書類の期限かはコードが決める**: **前の欄へさかのぼるが、飛ばしてよいのは Jev が決めなかった日付の欄（発行日・交付日。年月日のグループは 1 欄と数える）だけ**。最初に当たった欄が身分証の番号ならその書類、それ以外（カード番号・ほかの項目・日付でない未決定の欄）なら止めて空欄。その書類に期限の項目が無いときも空欄（1 回目のレビューで「身分証の番号までどこまでもさかのぼる」をやめ（レンタカー予約のカードの期限に免許証の期限が入る）、2 回目で「番号 → 発行日 → 有効期限」の並びに対応させた）。**発行日は保存せず、選択肢の説明に「発行日・交付日ではない」と書く**。「パスポートの有効期限」のように書類名まで書いてある欄は Jev に `passport_expiry` を直接選ばせる |
| 身分証の足切り | 身分証の項目（番号・期限・`document_expiry`）は choice の確からしさ **0.8 前後**（Phase 1 で決める）。ほかの項目は今の 0.5 のまま |
| 入れない例 | 会員番号・予約番号・社員番号・マイナンバー・クレジットカード番号は、身分証の候補の説明に「これは違う」と書く。**マイナンバーは保存もしない** |
| 右クリック | 「フォーム自動入力」の 1 つだけ。kypr がロック中なら Touch ID で解除して続ける |
| 対応するアプリ | Nemo と kypr Web を同時に作る。iOS は後回し（kypr の CLAUDE.md の「保留していること」に書く） |
| 今の保管庫 | **移行処理は作らない**。`autofill-vault.ts`・設定画面の保管庫の部分を消し、値は kypr に手で入れ直す。**値を入れ直すのは Phase 4 より前**（常用の v1.3.1 の設定画面で見ながら）。**`autofill.json` を消すのは、リリースして全 Mac を更新した後**（先に消すと v1.3.1 の自動入力が止まる）。パスフレーズ暗号の部品（`auth-vault-crypto.js`）は Basic 認証の保管庫が使うので残す |
| Jev の API キー | **Mac ごとの safeStorage**（既存の `src/main/store/jev-key.ts`。今は「古い置き場所」扱いなので、正の置き場所に戻す）。設定画面で保存・削除（値は表示しない） |

### /plot で決めたこと（/dig-lite の後に見直した点を含む）

- **Jev に出す候補は、値の有無にかかわらず全部出す**（/dig-lite の途中で「値が入っている項目だけ」と書いたのを取り消す）。
  候補から外すと、その欄に**一番近い別の候補**が選ばれてしまう（会社名が未登録で `organization` を外すと、「会社名」の欄が
  `full_name` に化けうる）。値が空の項目は、今と同じく流し込む段階で入れない（`autofill-values.js` は空の項目から値を作らない）。
  身分証の 8 項目 + `document_expiry` を足すと、欄 1 つあたりの入力トークンが 2 割ほど増える見込み（40 欄で分割する上限は Phase 1 で測り直す）
- kypr の平文のキーは kypr の流儀（camelCase。`cardholderName` `expMonth` と同じ）にし、Nemo 側の選択肢の名前（snake_case。Jev・`autocomplete` の対応表と同じ名前空間）とは
  `autofill-schema.js` の表で対応させる
- 身分証の番号（パスポート・免許証・保険証の各番号）は、カード番号と同じく**詳細画面では伏せて表示し、表示・コピーの操作で出す**
- `isIdentityItem`（復号時の検査）は**各キーが string かどうか（無ければ空文字として読む）だけ**を見る。日付・性別の形はエディタと自動入力の側で見る（形まで見ると、Web の不具合 1 つでアイテム全体が開けなくなる。項目を足すたびに schema を上げずに済む）（1 回目のレビューで決定）
- 本人性の判定（`OWN_CRITERIA`）の true 側に身分証を足し、false 側の「IDs」を会員番号・予約番号などに限定する（今のままだと身分証の欄が本人性で落ちる）（1 回目のレビューで決定）

### 個人情報の項目

基本の項目は今のプロフィール（`src/shared/autofill-schema.js` の `PROFILE_FIELDS`）と同じ。身分証を足す。

| グループ | Nemo の選択肢のキー | 型 |
|---|---|---|
| 氏名 | `family_name` `given_name` `family_name_kana` `given_name_kana` `family_name_roman` `given_name_roman` | 文字列 |
| 連絡先 | `email` `tel` | 文字列 |
| 住所 | `postal_code` `address_level1` `address_level2` `address_line1` `address_line2` | 文字列 |
| その他 | `birthday`（日付） `gender` | |
| 勤務先 | `organization` `department` `job_title` `organization_url` | 文字列 |
| パスポート | `passport_number` / `passport_expiry`（日付） | |
| 運転免許証 | `license_number` / `license_expiry`（日付） | |
| 健康保険証 | `insurance_symbol`（記号） `insurance_number`（番号） `insurance_branch`（枝番） `insurer_number`（保険者番号） | 文字列 |

Jev の選択肢に足すもの: 上の身分証の 8 個 + `document_expiry`。
日付の分割（年 / 月 / 日の欄・select）は `birthday` 専用の処理を**日付型の項目全般**に広げる。**和暦**（「令和 11」「R11」「平成」など。免許証は和暦表記）の select・入力にも照合を広げる（`birthday` にも効く）。

### コードベース

- kypr の平文の型: kypr `packages/crypto/src/item.ts`（Nemo には `src/vendor/kypr/crypto/item.ts` としてコピーされる。**手で編集しない**。kypr で `mise run export-nemo`）。仕様は kypr `docs/crypto-spec.md`（カードの節の形に合わせる。「知らないキーは保存し直すときも残す」「知らない type は読み取り専用」）。形式を足したら kypr で `mise run gen-vectors`
- kypr Web: `apps/web/src/components/ItemEditor.tsx` / `ItemDetail.tsx` / `VaultScreen.tsx`（種類の絞り込み）。確認は kypr の `mise run check` / `mise run verify`、iOS が新しいベクタで壊れないかは `mise run ios-test`
- Nemo の kypr: `src/main/kypr/index.ts`（`kyprSummaries` / `kyprItem` / `revealKyprField` / `copyKyprField` / `saveKyprItem`）、ポップアップ `src/renderer/components/Kypr.tsx`（`type: 'login' | 'card' | 'note'` が各所にある）、ロック解除 `unlockKyprWithTouchId`
- 自動入力: `src/main/autofill/index.ts`（`openAutofillVault` → `opened.profile` / `opened.jevKey` を、kypr の既定の個人情報 / `readJevKey()` に差し替える）、
  `src/shared/autofill-match.js`（候補と本人性の説明 `JEV_OPTIONS` / `OWN_CRITERIA`・`CHOICE_THRESHOLD` / `readJevAnswers` / `resolveConflicts`）、`src/shared/autofill-values.js`（導出・select の照合）、`src/main/autofill/jev.ts`（fetch）、
  `src/main/context-menu.ts`（失敗時の誘導先。kypr のポップアップへ差し替える）、設定画面 `src/renderer/components/Autofill.tsx`
- 設定の正規化: Nemo の設定に項目を足すなら `src/shared/settings-schema.js` の正規化に入れる（入れないと次回起動で消える）
- 自走検証: `scripts/verify-autofill.mjs`（今は保管庫の fixture）、`scripts/verify-kypr.mjs` と `scripts/lib/kypr-mock-server.mjs`（kypr の模擬サーバー）。
  登録（`scripts/lib/verify-targets.mjs`）と配線（`scripts/verify-all.mjs`）。**既存 OWNERS エントリを広げる**・未登録ファイルを新たに載せない（CLAUDE.md）
- 今の保管庫のファイル: `~/Library/Mobile Documents/com~apple~CloudDocs/Nemo/slots/autofill.json`（Nemo-dev にもある）。パスフレーズの記憶は各 Mac の userData

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] console.typesafe.ai で Jev の API キーを発行し直す（今のキーは消す保管庫の中にある）。値はこのセッションの scratchpad に `typesafe-key`（600）で置く（Phase 1 の試し撃ちに使う。**Git・返答・コマンド引数に載せない**）

### Phase 1: 身分証の欄の試し撃ち [AI🤖]
- [ ] scratchpad の使い捨てスクリプトで、本体の `buildJevRequests`（最終形の body）を import し、身分証の候補 9 個と `OWN_CRITERIA` の修正を入れたリクエストを投げる（前回の `jev-spike/` は残っていない）
- [ ] 欄のセット: パスポート番号・旅券番号・パスポートの有効期限・免許証番号・運転免許証の有効期限・保険証の記号 / 番号 / 枝番 / 保険者番号・「有効期限」だけの欄（身分証の直後・カード番号の直後の両方）と、
      入れない例（会員番号・予約番号・社員番号・マイナンバー・カード番号・「番号」だけの欄）・同行者のパスポート番号の欄・「記号 [ ] - [ ] 番号」の 2 つの箱・発行日 / 交付日・発行国・免許の色（「番号 → 発行日 → 有効期限」の並びで、発行日に期限が入らないか）。
      今の正答が落ちないかは `test-pages/autofill*.html` の欄を集めて見る
- [ ] 見るもの: 正答数・**本人性の noul（身分証の欄で 0.5 を超えるか。同行者の欄は下回るか）**・入れない例が `none` か低い確からしさになるか・記号 / 番号 / 枝番の取り違え・入力トークン・レイテンシ。
      結果から**身分証の足切りの値**と 1 リクエストあたりの欄の上限を決め、この plan のログに書く。外れが多ければ説明文を直して撃ち直す

### Phase 2: kypr 側（仕様・暗号・Web） [AI🤖]
- [x] `docs/crypto-spec.md` に「平文（`type: "identity"`, `schema: 1`）— 個人情報」の節を足す（キーの表・日付の形・知らないキーを残す規則は共通の節のまま）
- [x] `packages/crypto/src/item.ts`: `IdentityItem` / `isIdentityItem` / `newIdentityItem` / 復号の分岐。`packages/client/src/session.ts` の `EntryState` と create / update の型も。`mise run gen-vectors` で `identityItem` のベクタを足す
- [x] Web: 絞り込みに「個人情報」、編集画面（グループごとの入力欄。日付は `YYYY-MM-DD`）、詳細画面（身分証の番号は伏せて表示・コピー）
- [x] `mise run check` / `mise run verify` / `mise run ios-test`（iOS が新しいベクタで壊れないこと）
- [x] kypr の CLAUDE.md「保留していること」に「iOS の個人情報の表示・編集」を書く
- [x] kypr でコミット → `mise run export-nemo` で Nemo にコピー（`scripts/kypr-vendor.test.mjs` が通ること）

### Phase 3: Nemo の kypr ポップアップ [AI🤖]
- [x] `src/main/kypr/index.ts`（`saveKyprItem` / `pickFields` / `SECRET_FIELDS` / `COPYABLE`）と `src/shared/types.ts`（`KyprItemKind` / `KyprItemInput['type']`）: 個人情報の一覧・詳細・保存・伏せた項目の表示 / コピー
- [x] `Kypr.tsx`: 絞り込み「個人情報」・新規作成・編集画面（グループ分け）・詳細画面。詳細に「フォーム自動入力に使う」の切り替え（既定の 1 件。今の既定には印を付ける）
- [x] 既定の 1 件: Nemo の設定に kypr のアイテム ID を持つ（`settings-schema.js` の正規化に足す）。解決の関数（既定 → 無ければ一番古い 1 件（`createdAt` の昇順。ゴミ箱の中・読めないアイテムは除く） → 0 件なら null）を純粋関数にしてユニットテスト

### Phase 4 前の準備 [人間👨‍💻]
- [ ] Phase 3 の dev 版のポップアップで個人情報を 1 件作り、常用の v1.3.1 の設定画面で今のプロフィールを見ながら値を入れ直す。身分証も入れる

### Phase 4: 自動入力の値の元を kypr に替える [AI🤖]
- [x] `autofill-schema.js`: 身分証の項目とグループを足し、kypr の平文のキー（camelCase）→ 選択肢のキー（snake_case）の対応表を持つ
- [x] `autofill-match.js` の `JEV_OPTIONS`: 身分証の候補 9 個の説明（Phase 1 の最終版）。`none` と期限の候補の説明に入れない例（会員番号・予約番号・社員番号・マイナンバー・カード番号と期限・発行日 / 交付日）を書く。`OWN_CRITERIA` を直す
- [x] `autofill-match.js`: 身分証の項目だけ足切りを上げる（Phase 1 で決めた値）。`document_expiry` の書類をコードで決める（決定表の規則: 未決定の日付の欄だけ飛ばしてさかのぼり、最初に当たった欄が身分証の番号ならその書類の期限。それ以外は捨てる）。「日付の欄」の判定は 1 つの純粋関数にする（`type=date`・年月日のグループ・見出しが発行 / 交付 / 年月日 など。発行国の select のような日付でない欄は飛ばさない）。**`readJevAnswers` の後・`resolveConflicts` の前**に `passport_expiry` / `license_expiry` へ置き換える（`document_expiry` のままだと重複の解消で片方が消える）
- [x] 日付の分割を `birthday` 専用から日付型の項目全般に広げる: `autofill-match.js` の `expandGroup` / `PART_TO_WHOLE`、`autofill-values.js` の `deriveValues`（身分証の 8 キーと期限の年 / 月 / 日を足す）と select の照合。和暦（令和 / 平成 / 昭和、R / H / S、「2029（令和11）」の併記）の照合
- [x] `autofill/index.ts`: 保管庫の代わりに kypr の既定の個人情報を読む（`normalizeProfile` を通す。読んだら `touchKypr()`）。ロック中は Touch ID で解除してから続け、通らなければ（キャンセル・Touch ID が使えない）ポップアップを開いて止める。未ログイン・個人情報が 0 件ならポップアップを開く
- [x] Jev のキーは `jev-key.ts`（safeStorage）を正にする: 書き込みの関数を足し、`nemo:jev-key-save` / `nemo:jev-key-clear` は safeStorage の読み書きに作り直して残す。コメントを「正の置き場所」に直す
- [x] 消すもの: `src/main/store/autofill-vault.ts`・`Autofill.tsx` の保管庫とプロフィール編集の部分（Jev キーの保存 / 削除だけ残す）・保管庫の IPC / preload（Jev キーの 2 つは残す）。`context-menu.ts` の保管庫が無いときの分岐は**差し替える**（ロック中で Touch ID が通らない・未ログイン・個人情報が 0 件なら kypr のポップアップを開く）。
      起動時に userData に残ったパスフレーズの記憶ファイルを消す（ほかの Mac の分もそれぞれの起動で消える）
- [x] ログ `autofill.run` に~~値の元（`kypr`）と~~身分証で埋めた数を足す（値・label は載せない。`sanitizeDetail` で `[deep]` が出ないこと）

### Phase 5: 検証 [AI🤖]
- [x] ユニットテスト: 対応表・`document_expiry` の書類の決め方（直前が免許証 / パスポート / 保険証 / 無し・発行日を挟む・発行国の select を挟むと止まる・カード番号の直後）・足切りの差・和暦の照合・既定の 1 件の解決
- [x] `test-pages/`: 身分証のフォーム（番号・書類名つきの期限・「番号 → 発行日（年月日の select）→ 有効期限」と「免許証番号 → 交付日 → 有効期限 → 免許の色」の並び・和暦の select・保険証の 4 欄・入れない例）とカード払いの「有効期限」を置く。`verify-autofill.mjs` で発行日・交付日の欄が空のまま残ることも見る
- [x] `verify-autofill.mjs`: 保管庫の fixture をやめ、kypr の模擬サーバーに個人情報を置いて自動入力する。Jev キーの検査（「古い置き場所のキーは保管庫へ移って消える」など）は safeStorage が正の向きに直す。Jev モックには身分証の答えも持たせ、**送る body に値が 1 つも入らないこと**を引き続き見る。ロック中の経路（Touch ID の差し替えで通る / 通らない）も見る
- [x] `verify-kypr.mjs`: ポップアップで個人情報の作成・編集・詳細（伏せた表示）・既定の切り替えの描画まで見る
- [x] OWNERS の既存エントリを広げる（自動入力が kypr を読むようになった分）。消したファイルのエントリを外す。~~**配線を外して検査 0 件になることを見てから戻す**~~（新しいスイートは足していない）。報告に件数を出す
- [x] VERIFY.md の自動入力の手順を kypr 前提に直す。`docs/CHANGELOG.md` の `[Unreleased]` に書く

### 動作確認前の準備 [人間👨‍💻]
- [ ] 各 Mac の Nemo の設定画面で Jev の API キーを保存する

### 動作確認 [人間👨‍💻]
- [ ] 実際の日本語フォームで右クリック → フォーム自動入力して、今まで通り埋まること
- [ ] 身分証を求めるフォーム（レンタカー・旅行の申し込みなど）で、番号と期限が正しい欄に入り、関係ない番号の欄が空のまま残ること
- [ ] kypr をロックした状態で右クリック → Touch ID → 入力まで進むこと
- [ ] もう 1 台の Mac で、同じ個人情報で自動入力できること

### リリース後の片付け [人間👨‍💻]
- [ ] リリースして全 Mac を更新した後、今の保管庫のファイル（iCloud の `Nemo/slots/autofill.json` と `Nemo-dev/slots/autofill.json`）を消す

## ログ
### 試したこと・わかったこと
- **2026-09-29 kypr 側（Phase 2）**: `mise run check`（暗号 35 / クライアント 49 / API 22 / Web 17）・`mise run verify` 70 件 PASS（個人情報の作成・編集・日付の形で保存を止める・エクスポートの復号・平文がどこにも無い）・`mise run ios-test` 20 件 PASS（新しいベクタで iOS が壊れない）。Web の詳細画面で見出しが枠に重なっていた（見出しと枠を `div` で包んで親の余白が効かない）→ `Fragment` にして直した（スクショで確認）
- **Nemo（Phase 3〜5）**: ユニットテスト 511 件 PASS。`verify:only autofill` 133 件 PASS（身分証 23 項目・既定の切り替え・Touch ID の成功 / 失敗・再起動後のキー）、`verify:only kypr` 80 件 PASS（個人情報の 7 件を足した）。ポップアップの詳細・編集はスクショで目視
- 変異で検査が効くことを確かめた: `isDateLikeField` を常に true → 2 件 FAIL、身分証の足切りを通常と同じに → 1 件 FAIL、さかのぼりで未決定の欄を何でも飛ばす → 1 件 FAIL（どれも戻して PASS）
- ログの値の漏れの検査が、保険証の番号「65」・枝番「07」を時刻の中に見つけて FAIL した（偽陽性）→ 3 桁以下の数字だけの値は検査の目印から外した
- フル（`verify-all --changed`。ipc.ts などでフルに倒れた）: 自動入力 133・kypr 80・agent 73 ほか PASS。FAIL は pins 6・switcher 2・Live Folder 3・slots 1。pins / switcher は `--only` で単独なら PASS（フルの順序依存。Live Folder の 3 件は VERIFY.md の既知のもの）。slots の「設定画面の節が 8 つだけ」は **HEAD の worktree でも同じ FAIL**（v1.3.0 で kypr の節を足したときに期待値を直していない。今回の範囲外）

### 方針変更
- **Phase 1（実キーの試し撃ち）は後回しにした**（2026-09-29）。事前準備の Jev のキーがまだ無い。身分証の足切り `DOCUMENT_THRESHOLD = 0.8`・1 リクエストの欄の上限 `MAX_FIELDS_PER_REQUEST = 32`（候補を 9 個足して欄 1 つ ≒ 1.5k トークンの見込み）・候補の説明は**仮の値**で実装した。キーが用意できたら Phase 1 を回して `autofill-match.js` の値と説明を直す
- `/act`（コミットしない）で進めたので、kypr 側は**未コミット**のまま `export-nemo --allow-dirty` で Nemo にコピーした（`VENDORED.md` に「未コミットの変更を含む」と出る）。kypr でコミットしてから `mise run export-nemo` をやり直す（→ kypr `6a0ee64` でやり直した）
- ログの `autofill.run` に値の元は足さなかった（値の元は常に kypr で、区別する意味が無い）。身分証の欄の数（`documents`）だけ足した
- 個人情報の項目の表は kypr の `packages/client/src/identity.ts`（Web が使う）と Nemo の `autofill-schema.js` の `PROFILE_FIELDS`（`kypr` 列で平文のキーと対応）の 2 か所にある。Nemo の renderer は vendor の `.ts` を読めない（`tsconfig.web.json`）ので、`scripts/kypr-identity.test.mjs` で並び・見出し・伏せる項目が一致することを見る
- `verify-autofill.mjs` の「違うパスフレーズで上書きできない」「2 台目でパスフレーズだけでキーが使える」は保管庫ごと無くなったので消し、「再起動後もキーが残る」「Touch ID が通らなければ入れない」に置き換えた。実サイト調査（`autofill-survey.mjs`）も kypr の模擬サーバーに個人情報を置く形にした（`scripts/lib/kypr-fixture.mjs` を両方で使う）
- 保険証の「記号 [ ] - [ ] 番号」の 2 つの箱は、Jev が記号か番号と答えたら `insurance_symbol` / `insurance_number` に割り当てる（`expandGroup`）。Phase 1 で実際の答えを見る
