# フォーム自動入力（右クリック → Jev で欄を判定）: 実装

Phase 0（Jev API の確認）は済み。その結果はログ「試したこと」の先頭にある。

## 概要・やりたいこと

ページ内のフォームを右クリックして「フォーム自動入力」を選ぶと、**埋められる欄だけ**を自分のプロフィールで埋める。
日本の問い合わせ・申込フォームは `autocomplete` 属性が無いことが多く Chrome の自動入力が効かないので、
**ルールで決まらない欄の意味を Jev（TypeSafe AI の判定特化モデル）に choice で選ばせる**。値は Nemo の外に出さない。

## 前提・わかっていること

### 決定事項

| 論点 | 決定 |
|---|---|
| 入力データ | iCloud Drive のスロットのフォルダに `autofill.json` を**パスフレーズ暗号**で置く（Basic 認証の保管庫と同じ仕組み）。**このファイルが正**で、使うたびに読み直す。パスフレーズは userData に safeStorage で記憶 |
| Jev に送るもの | 欄の手がかり（label / name / id / placeholder / aria-label / 短い近傍テキスト / type）と項目名・説明だけ。**値は送らない** |
| 判定の分担 | `autocomplete` 属性・`type` で決まる欄はローカル。残りを Jev に聞く。**入れるのは choice が `none` 以外・`confidence >= 0.5`・本人性 noul `>= 0.5` の欄だけ**。失敗なら空欄のまま（Phase 1 で決定） |
| Jev の API キー | **保管庫の中**（プロフィールと一緒にパスフレーズで暗号化。中身は `{ profile, jevKey }`）。別の Mac でもパスフレーズを入れるだけで使える。保存・削除はパスフレーズを覚えている Mac でだけできる |
| Jev の呼び方 | SDK なしの `fetch`。`model: "jev-1.13.0"` 固定。429 / 529 は `retry-after` を見て 1 回だけ再試行。全体のタイムアウト 3s |
| 質問の書き方 | 質問文・選択肢の説明は**英語**、説明に日本語の言い回しの例を添える。欄の手がかりは原文のまま |
| 対象の欄 | 右クリックした欄を含むフォーム（`form` が無ければページ全体）の、**可視**・有効・空の `input`（text/email/tel/number/date/url/無指定）/ `select` / `textarea`。password・hidden・file・値のある欄は触らない |
| 対象のフレーム | 右クリックしたフレーム。**メインフレーム直下の iframe まで対象**（入れ子は対象外でメニューも出さない）。CDP で iframe に isolated world を作る（`src/main/autofill/frame-runner.ts`）。**親ページで iframe の要素が見えているか**（透明・極小・切り取り・縮小）を確かめ、見えなければやめる。中をスクロールできない iframe は見えている範囲の外の欄を集めない。同じ URL の iframe がフォーカスで 1 つに決まらなければやめる |
| 分割された欄 | 同じ label で並ぶ欄（電話 3 分割・郵便番号の前後・生年月日の年月日）は**収集側で 1 グループにまとめて Jev に 1 問だけ聞き**、各欄への割り当ては並び順でコードが決める（Phase 1 で決定） |

### /dig-lite での決定の理由
- 入力データを me.md に置かない: me.md には電話番号・番地・メールが無い（「書かないもの」ルール）。me リポジトリは AI から読まれる前提なので平文の個人情報を足さない。保管庫なら iCloud 経由で全 Mac に届く
- 値を Jev に送らない: Jev は米国ホストで、リクエストは保持されうる。選ばせるだけなら値は不要
- ルール → 残りを Jev: 確実な欄に API を使わない。Jev 不通でも半分は埋まる

### Jev のリクエストの形（Phase 1 で確定）

```json
{
  "model": "jev-1.13.0",
  "state": { "page_title": "お問い合わせ | …", "form_labels": ["お名前（姓）", "フリガナ（セイ）", "電話番号", "…"] },
  "questions": {
    "f0": {
      "type": "choice",
      "instructions": {
        "field": { "label": "フリガナ（セイ）", "name": "kana1", "placeholder": "ヤマダ", "type": "text" },
        "question": "Which profile item should be entered into this form `field`?"
      },
      "criteria": {
        "family_name_kana": "Family name reading only, in katakana or hiragana. Japanese labels: セイ, せい, 姓（フリガナ）",
        "…": "…",
        "none": "None of the profile items fits: free text such as inquiry body, subject, age, number of employees, how you found us, coupon codes, passwords, or anything else"
      }
    },
    "own0": {
      "type": "noul",
      "instructions": { "field": { "…": "f0 と同じ" }, "question": "Does this form `field` ask for the form filler's OWN personal or own-company information?" },
      "criteria": {
        "true": "The filler's own name, contact, address, birthday, gender, or the filler's own company / department / title / website",
        "false": "Information about someone or something else (a referrer, child, family member, emergency contact, workplace or delivery address that differs from home), or not personal information at all (inquiry text, budget, passwords, IDs)"
      }
    }
  }
}
```

- **欄の手がかりは質問の `instructions.field` に直接入れる**。state は `fields[i]` で指される配列にしない（番号で指すと後ろの欄ほど崩れた）。state はページタイトルとフォーム全体の label 一覧だけ
- 欄 1 つにつき choice 1 問 + noul 1 問。**入力トークンは欄 1 つあたり約 1.15k**（選択肢の説明が質問ごとに繰り返されるため）。
  上限 64k / リクエストなので、**40 欄を超えたら分割して並列に投げる**
- 選択肢の説明の最終版（Phase 1 で 33/37 を出した形）。criteria の値は `"<説明>. Japanese labels: <日本語例>"`（日本語例が無いものは説明だけ）

| 選択肢 | 説明（英語） | 日本語例 |
|---|---|---|
| `full_name` | Full name (family name and given name together) in kanji | 氏名, お名前, 名前, ご担当者名 |
| `family_name` | Family name only (surname) in kanji | 姓, 氏, 苗字 |
| `given_name` | Given name only (first name) in kanji | 名, 下の名前 |
| `full_name_kana` | Full name reading in katakana or hiragana, family and given together | フリガナ, ふりがな, カナ氏名, お名前（カナ） |
| `family_name_kana` | Family name reading only, in katakana or hiragana | セイ, せい, 姓（フリガナ） |
| `given_name_kana` | Given name reading only, in katakana or hiragana | メイ, めい, 名（フリガナ） |
| `full_name_roman` | Full name in Latin alphabet (romaji) | ローマ字, 英字氏名, Name |
| `email` | Email address (also use for a "confirm email" field) | メールアドレス, E-mail, メール（確認用） |
| `tel` | Phone number (the whole number, even if the form splits it into several boxes) | 電話番号, TEL, 携帯電話, 連絡先電話番号 |
| `postal_code` | Postal code (the whole code, even if the form splits it into several boxes) | 郵便番号, 〒 |
| `address_level1` | Prefecture only | 都道府県 |
| `address_level2` | City, ward, town or village only | 市区町村 |
| `address_line1` | Street address after the city: town name, block and house number | 番地, 町名番地, 丁目・番地 |
| `address_line2` | Building name, floor and room number | 建物名, マンション名, 部屋番号, ビル名 |
| `address_full` | Whole address after the postal code in one field (prefecture to building) | 住所, ご住所, 所在地 |
| `birthday` | Date of birth (the whole date, even if the form splits it into year / month / day) | 生年月日 |
| `gender` | Gender / sex | 性別 |
| `organization` | Company or organization name | 会社名, 貴社名, 法人名, 団体名, 屋号 |
| `department` | Department or division within the company | 部署名, 所属 |
| `job_title` | Job title or position | 役職 |
| `organization_url` | Company website URL | 会社URL, ホームページ, WebサイトURL |
| `none` | None of the profile items fits: free text such as inquiry body, subject, age, number of employees, how you found us, coupon codes, passwords, or anything else |  |

### プロフィールの項目（保管庫に持つ値）

`family_name` / `given_name` / `family_name_kana`（カタカナで保存し、ひらがなは導出） / `given_name_kana` /
`family_name_roman` / `given_name_roman` / `email` / `tel` / `postal_code` / `address_level1`（都道府県） /
`address_level2`（市区町村） / `address_line1`（番地） / `address_line2`（建物名） / `birthday`（YYYY-MM-DD） / `gender` /
`organization` / `department` / `job_title` / `organization_url`

Jev の選択肢には**導出形**も並べる: 氏名一括（`full_name`）・かな一括（`full_name_kana`）・ローマ字一括（`full_name_roman`）・住所一括（`address_full`）。
**分割系（電話 3 分割・郵便番号の前後・生年月日の年月日）は選択肢に入れない**（グループで `tel` / `postal_code` / `birthday` を聞き、割り当てはコード）。導出はコード側（Jev は計算・生成が苦手）。

### コードベース
- 右クリック: `src/main/context-menu.ts` の `buildContextMenuTemplate`（純粋関数に近い形。項目を足すとテストしやすい）
- パスフレーズ暗号: `src/shared/auth-vault-crypto.js` の `encryptVault(rules, passphrase, meta)` / `decryptVault` は**中身が `rules` に固定**されている。
  自動入力でも使えるよう**中身を任意の payload にする汎用関数を切り出し**、auth-vault はそれを呼ぶ形にする（既存のユニットテストで挙動を固定したまま）
- 保管庫の I/O: `src/main/store/auth-vault.ts`（状態・競合コピー・壊れたファイルの退避・未来版の保護・パスフレーズの記憶）。同じ形で `autofill-vault.ts` を作る
- API キー: `src/main/store/github-token.ts` の形（userData・safeStorage・renderer に値を返さない）
- 設定画面: `src/renderer/components/Settings.tsx` に `<AuthVault />` と同じ並びで `<Autofill />` を置く。IPC は `src/preload/ui.ts` / `src/main/ipc.ts`
- ページ側 preload に特権 API を載せない方針なので、欄の収集・流し込みは main から `frame.executeJavaScriptInIsolatedWorld`
- 検証: 実 `safeStorage` に触らない（`secret-backend.ts` の差し替え）。新スイートは登録と配線の両方。OWNERS は既存エントリの広げ忘れに注意（CLAUDE.md）
- 秘密の扱いは着手前に `~/Library/CloudStorage/Dropbox/dotfiles/.claude/references/secrets-in-apps.md` を読む

## 実装計画

### 事前準備 [人間👨‍💻]
- [x] console.typesafe.ai で API キー「Nemo autofill」を発行（クレジットを購入済み）。
      値はセッションの scratchpad の `typesafe-key`（600、Git 管理外）に保存。**セッションが消えたら読めなくなる**ので、そのときは設定画面から入れる値をコンソールで作り直す

### Phase 1: 実キーでの試し撃ち [AI🤖]
- [x] scratchpad の使い捨てスクリプト（キーは scratchpad の `typesafe-key` から読み、出力・引数に載せない）で、上の形のリクエストを投げる。
      実在しそうな日本語フォームの欄 27 個 → 紛らわしい欄 14 個を足して 37 個（グループ化後）
- [x] 見るもの: 正答数・`none` の欄で `none` になるか・confidence の分布・実測レイテンシ。
      結果から **confidence の閾値の初期値**を決め、この plan のログに記録する（→ choice 0.5 / 本人性 0.5）
- [x] 精度が低い組があれば、説明の書き方（英語の定義 + 日本語例）を直して撃ち直す。説明の最終版を Phase 5 の実装の元にする

### Phase 2: 暗号の汎用化と保管庫 [AI🤖]
- [x] `auth-vault-crypto.js` から payload 汎用の暗号関数を切り出し、auth-vault はそれを呼ぶ形に直す。`scripts/auth-vault-crypto.test.mjs` がそのまま通ること
- [x] `src/shared/autofill-schema.js`: 版・正規化（未知フィールドは捨てる・文字列だけ受ける・`birthday` の形式検査）。renderer も読むので Node 非依存にする（CLAUDE.md の `tsconfig.web.json` の注意）
- [x] `src/main/store/autofill-vault.ts`: 状態（empty / ok / unreadable / 未来版 / 競合コピー）・読み込み・保存・削除・パスフレーズの記憶。
      **復号した中身をメモリにだけキャッシュ**し（鍵ではなく中身。方針変更を参照）、ファイルの mtime・サイズが変わったら読み直す（iCloud 経由の別 Mac の更新を拾う）
- [x] ユニットテスト: スキーマの正規化、暗号の往復、パスフレーズ違いと改竄の区別（auth-vault と同じ観点）

### Phase 3: 値の導出 [AI🤖]
- [x] `src/shared/autofill-values.js`: プロフィール → 選択肢ごとの値（氏名一括・ひらがな・電話 3 分割・郵便番号の前後・住所一括・年 / 月 / 日）。空の項目から導く値は出さない
- [x] `select` の照合: option の text / value と値を突き合わせる（都道府県・性別・年 / 月 / 日。`"9"` と `"09"`・`"神奈川県"` と `"神奈川"` の揺れ）
- [x] ユニットテスト（電話番号の区切りの揺れ・郵便番号のハイフン有無を含む）

### Phase 4: 欄の収集・ルール判定・流し込み [AI🤖]
- [x] isolated world で走らせる収集スクリプト: 右クリックした座標の要素 → 最寄りの `form`（無ければ~~欄を 2 個以上含む最も近い祖先~~ページ全体）→ 対象の欄。
      **可視判定**: サイズ 0・`opacity: 0`・`visibility: hidden`・`display: none` の祖先・画面外・祖先の clip / overflow で隠れた欄は外す
- [x] 手がかりの抽出: label（`for` / 包含 / `aria-labelledby` / 直前のテキスト / 表形式の `th`・`dt`）・name・id・placeholder・aria-label。
      近傍テキストは 40 文字程度で切る（context rot 対策）。~~抽出は DOM を受け取る純粋関数にしてユニットテストする~~ → 自走検証（実ページ）で見る（方針変更を参照）
      `select` ~~/ radio~~ は option の見本（先頭数個。「選択してください」は除く）も手がかりに含める（Phase 1 で見本の無い生年月日の confidence が 0.50 まで落ちた）
- [x] 分割グループの検出: 同じ label（または label を共有する隣接した欄）で 2〜3 個並ぶ text / select を 1 グループにし、`split_into_boxes: n` を付けて 1 欄として扱う。
      割り当て: 電話 3 分割 → 並び順に `tel_part1..3`、郵便番号 2 分割 → 前 3 / 後 4、生年月日 3 分割 → 年 / 月 / 日（`maxlength` と select の選択肢の範囲で年 / 月 / 日を確かめる）
- [x] ルール判定: `autocomplete` トークン → 項目の対応表、`type=email` → `email`、`type=tel` → `tel`（分割グループの中の欄はグループとして扱う）
- [x] 流し込み: ネイティブの value setter で代入し `input` / `change` を発火（React / Vue の制御コンポーネント向け）。`select` は Phase 3 の照合を使う
- [x] 収集スクリプトは欄に一時 ID（`data-*` ではなく isolated world 側の WeakMap / 配列の添字）を付け、流し込みで同じ欄を指す。**ページの DOM に痕跡を残さない**

### Phase 5: Jev クライアントと組み立て [AI🤖]
- [x] `src/main/store/jev-key.ts`（`github-token.ts` と同じ形）
- [x] `src/main/autofill/jev.ts`: リクエストの組み立て（Phase 1 で確定した形: 欄ごとに choice + 本人性 noul、手がかりは `instructions.field`、40 欄ごとに分割して並列）・`fetch`・タイムアウト・429 / 529 の再試行・レスポンスの検証。
      エンドポイントは `NEMO_JEV_TEST_ENDPOINT` で差し替え可（**パッケージ版では env を無視**。`resolveSecretBackendMode` と同じ作法）
- [x] **送る body に値が入らないことを型とユニットテストで固定**（body を組み立てる関数はプロフィールの値を引数に取らない）
- [x] 割り当ての解決: `none` / `confidence < 0.5` / 本人性 `< 0.5` を足切り → 同じ項目を複数の欄が選んだら、1 回しか入らない項目は confidence の高い欄に。
      ただし `email` は「確認用」もあるので重複可にするなど、**重複を許す項目を表で決めて**コードに持つ
- [x] `src/main/autofill/index.ts`: 収集 → ルール → Jev → 解決 → 流し込み を束ねる。Jev が失敗してもルールで決まった分は流し込む
- [x] ログ `autofill.run`: 欄の数・ルールで埋めた数・Jev で埋めた数・残した数・Jev の所要時間・失敗の種別（HTTP ステータス / timeout）。
      **値・label の文字列・URL は載せない**。`sanitizeDetail` を通しても `[deep]` が出ない形（フラット）にし、ユニットテストで見る

### Phase 6: 右クリックメニューと設定画面 [AI🤖]
- [x] `context-menu.ts`: `params.formControlType` が入力欄（text 系・select・textarea）のとき「フォーム自動入力」を出す。
      保管庫が空 / パスフレーズ未記憶~~/ API キー未設定~~なら、押したときに設定画面を開く~~いてその節へ誘導する~~（項目は消さない。方針変更を参照）
- [x] 設定画面の「フォーム自動入力」節（`src/renderer/components/Autofill.tsx`）: 保管庫の状態・保存先・パスフレーズ入力と記憶・
      プロフィールの編集フォーム・Jev API キーの保存 / 削除（値は表示しない）・競合コピー / 未来版 / 読めないときの表示
- [x] IPC: `ui.ts` / `ipc.ts` に保管庫・キーの口を足す。**プロフィールの値を renderer に返すのは編集フォームを開いたときだけ**、キーは返さない

### Phase 7: 自走検証 [AI🤖]
- [x] `test-pages/autofill.html`: autocomplete あり / なし・日本語 label・表形式・姓名分割・フリガナ・電話 3 分割・郵便番号前後・都道府県 select・
      生年月日の年月日 select・React 風の制御コンポーネント・確認用メール・既に値のある欄・password 欄・**見えない罠の欄 5 種**・~~iframe 内のフォーム~~
- [x] Jev モックサーバ: 受け取った body を記録して**プロフィールの値が 1 つも含まれないこと**をアサート。欄の label から固定の答えを返し、
      401 / 429→成功 / 529 / タイムアウトの経路も作る
- [x] `scripts/verify-autofill.mjs`: 保管庫 fixture（テスト用暗号バックエンド）・キー fixture を置いて起動し、右クリック相当の経路で自動入力 →
      各欄の値を検査。Jev 失敗時もルールの分は入ること・罠の欄と既存値に触れないこと・設定画面の描画まで見る
- [x] 登録（`KNOWN_TARGETS` / `OWNERS`。自分で起動するので `NEEDS_APP` には入れない）と配線（`verify-all.mjs`）。**配線を外して検査 0 件を確認してから戻す**。
      `context-menu.ts` は OWNERS に載っていない（フルに倒れる）ので載せない。報告に検査件数を出す
- [ ] ~~移行の検証: 保管庫の fixture を旧版（版 1）で置いて起動 → 読めること（今回が初版なので、版を上げるときの足場として fixture だけ用意）~~
- [x] VERIFY.md に手順を追記

### 動作確認前の準備 [人間👨‍💻]
- [ ] 設定画面でパスフレーズを決め、プロフィール（電話・番地・メールを含む）と Jev API キーを入力する（scratchpad の `typesafe-key` が残っていればその値。無ければコンソールで作り直す）

### 動作確認 [人間👨‍💻]
- [ ] autocomplete の無い実際の日本語フォームを数件、右クリック → 自動入力して、埋まった欄・空欄のまま残った欄が妥当か見る（閾値が厳しすぎ / 緩すぎなら調整）
- [ ] もう 1 台の Mac で同じパスフレーズを入れて保管庫が読めること
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に記載する

## ログ
### 試したこと・わかったこと

**2026-09-27 Phase 1: 実キーでの試し撃ち**（`jev-1.13.0`。スクリプトは scratchpad の `jev-spike/spike-final.mjs`）

| 試したこと | 結果 | 入力トークン | 応答 |
|---|---|---|---|
| 27 欄・`fields[i]` で指す・説明=英語+日本語例 | 25/27。外れは電話 3 分割の 3 番目と生年月日の月（**並び順の判定**） | 34k | 545ms |
| 同・説明=英語だけ | 23/27（「ご担当者名」→ none など） | 21k | 409ms |
| 同・説明なし（項目名だけ） | 23/27（「従業員数」→ organization など） | 8k | 367ms |
| 分割グループを 1 欄にまとめる（23 欄） | **23/23 × 3 回** | 23k | 308〜373ms |
| 紛らわしい欄 14 個を追加（37 欄）・`fields[i]` | 31/37。**後ろに足した欄ほど崩れる**（「役職」「性別」「ホームページURL」→ full_name_roman） | 36k | 576ms |
| 同・手がかりを `instructions.field` に直接入れる | 33/37。プロフィール項目の欄は全問正解。外れは「**誰の**情報か」だけ（紹介者・子ども → full_name、緊急連絡先 → tel、勤務先住所 → address_full。いずれも confidence 0.7〜1.0 と高い） | 37k | 440〜491ms |
| 同・本人性の noul を並べる | 紹介者 0.04 / 子ども 0.05 / 緊急連絡先 0.08 で弾ける。勤務先住所は 0.63 で残る | 43k | 486〜563ms |

- 閾値の比較（最後の形、2 回とも同じ）: choice ≥ 0.5 かつ本人性 ≥ 0.5 → **正しく入る 23 / 誤って入る 1（勤務先住所）/ 入るべきなのに空欄 0**。
  本人性を 0.6 にすると placeholder だけのメール欄（本人性 0.56）が落ちるだけで誤りは減らない → **0.5 / 0.5 を初期値にする**
- 日本語例を説明に添えると、英語だけより 2 問多く当たる（ご担当者名・生年月日）。トークンは 1.6 倍になるが費用は 37 欄で約 $0.0018 / 回
- confidence が低めに出る正解: placeholder だけの欄（0.58〜0.89）、select で選択肢の見本が無い生年月日（0.50）→ **select は option の見本（先頭数個）を手がかりに含める**
- 残る誤り「勤務先住所 → 住所一括」は許容する（本人の自宅と勤務先が同じ人もいる。気になるなら動作確認で本人性の閾値を見直す）

**2026-09-27 Phase 2〜7: 実装と自走検証**
- ユニットテスト `scripts/autofill.test.mjs` 16 件（値の導出・書式・select の照合・ルール・Jev の body・足切り・重複解決・割り当て・封筒・ログ）。
  「Jev に値を送らない」の検査は、`state` に値を 1 つ混ぜると FAIL することを確かめた
- `mise run verify:only autofill` は 58 件 PASS（全体 9 秒）。**配線を外すと自動入力の検査 0 件のまま「すべて PASS」で exit 0** になることを確かめてから戻した
- 可視判定を外すと 9 件 FAIL（罠 4 欄に値が入る・罠を Jev に送る）→ 戻すと 58 件 PASS。
  最初はモックが罠の欄に `none` を返していて「罠に入らない」検査が可視判定と無関係に PASS していたので、本物らしい項目を答える形に直した
- 「Jev に値を送っていない」検査が都道府県 select の見本（ページの中身）で誤検知した → ページ自体に書いてある文字列を外して見る形にした（見た値 21 個）
- **実 Jev** でも同じテストページで値の検査が全部 PASS（Jev 291ms。scratchpad の `real-jev.mjs`）

**2026-09-27 Phase 0: Jev API の仕様（`docs.typesafe.ai` の `.md` を curl で生取得して確認。jev-1.13 時点）**
- `POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <key>`。body は `{ state, model, questions }`。
  `questions` は自分で付けた id → 質問の map で、答えは同じ id で返る（id はモデルに渡らない）
- **1 リクエストの質問はすべて同じ `state` を見る**。欄ごとに state を分けられないので、state に欄の一覧（配列）を入れ、
  各質問の `instructions` を `{ "question": "... `fields[3]` ..." }` のようにバッククォートで state の場所を指す形にする（公式の書き方）
- choice: `criteria` は 選択肢 → 説明（文字列 / object / null）の map、最大 255 択。答えは `choice`（最大確率の選択肢）/
  `probabilities`（合計 1）/ `confidence`（0〜1、分布の尖り具合）。**「該当なし」は自分で選択肢に足す**（公式推奨）
- エラー: 401（キー）/ 422（body 不正。詳細が body に入る）/ 429（レート）/ 529（過負荷）。429 / 529 は `retry-after` を見て指数バックオフ
- モデル: `jev-latest` → `jev-1.13.0`。**alias は予告なく中身が変わる**ので、confidence の閾値を調整した後は版を固定するのが公式の推奨
- 制限: 64k トークン / リクエスト（state + 最長の質問で 32k）。1,200 req/分・250k tok/秒（変動あり）。料金は入力 $0.042 / 100 万トークン、出力無料 → 費用は無視できる
- データ: 学習には使わない。DPA の保持期間は「目的に必要な間」で、ZDR はエンタープライズのみ。**リクエスト内容はある期間保持されうる前提で設計する**
- JS SDK `@typesafe-ai/sdk`（v0.6.0、Node 20+）がある

**設計に効く既知の弱点（公式「Jev 1.13 jaggedness」）**
- **日本語（CJK）は受け付けるが精度が英語より落ちる**。→ 質問文と選択肢の説明は英語で書き、説明に日本語の言い回しの例
  （`family_name_kana: "Family name reading in katakana/hiragana. e.g. セイ, 姓（フリガナ）, せい"`）を添える。欄の手がかりは原文のまま送る
- **state に無関係な情報が多いと精度が落ちる**（context rot）。→ ルールで確定した欄は state から外し、近傍テキストは短く切る
- **文字どおりに読む**。→ 紛らわしい組（姓 / 名、かな / カナ / ローマ字、電話の一括 / 分割）は説明で境界を明示する
- **生成・計算は苦手**。→ 値の分割（電話 3 分割・郵便番号・生年月日）や形式の変換は予定どおりコードでやる
- **ページの文章で答えが誘導されうる**（adversarial content）。→ 値はローカルにあるので漏れはしないが、
  見えない欄（サイズ 0・透明・画面外・clip）に値を入れさせる古典的な自動入力の抜き取りを防ぐため、**可視判定を厳しくする**（Phase 2 に反映）


### 方針変更
- 2026-09-27（レビュー）: iframe の中の可視判定だけでは、親が iframe を透明・極小・縮小にする手口を防げなかった。親ページの isolated world で iframe の要素を確かめる形にした（決定表「対象のフレーム」）。入れ子の iframe は親の world を作れないので対象外
- 2026-09-27（実サイト調査）: **iframe の中のフォームにも対応した**（先の「メインフレームだけ」を取り消す）。`webContents.debugger` で iframe に付き、
  `Page.createIsolatedWorld` で isolated world を作って同じページ側スクリプトを走らせる（メインワールドは使わないので、ページに可視判定を偽られない）。
  CDP の frame は URL で突き合わせる（`WebFrameMain.frameToken` は CDP の frame ID と別物）。Brevo（irusiru）・Google フォームの埋め込みで入ることを確かめた
- 2026-09-27（実サイト調査）: 代表的な日本語フォーム 44 ページを `scripts/autofill-survey.mjs`（`mise run autofill:survey`）で回し、入らない欄の原因を潰した。
  入力できた要素は 283 → 約 300。直したもの: th の無い表は左の td を見出しにする / 区切り（年・月・日・-）が要素でも分割欄にまとめる（「姓」「名」の 1 文字は区切りにしない）/
  「〒」を見出しとして扱いルールで郵便番号 / type=tel でも見出しが郵便番号なら郵便番号 / 例がかなだけなら姓・名でもふりがな /
  3 桁・4 桁の 2 分割は郵便番号 / 確認用の欄は同じ項目を 2 か所目にも入れる / FAX は入れない（Jev にも聞かない）/
  「市区町村番地」「番地・マンション名」をまとめた選択肢を足す / 「ご住所」「建物名称」の 2 枠を割る。
  残りの取りこぼしは大半が「お問い合わせ内容」「希望日」などプロフィールに無い欄（正しく空欄）
- 2026-09-27（v1.2.17 の試用）: **2 枠以上に分かれた欄では、Jev の答えの「姓」「名」「氏名一括」（カナ・ローマ字も同じ）を同じ答えとみなして確率を合算**し、一括に寄せる。
  実在の問い合わせフォーム（th「氏名」の下に例「姓」「名」の 2 枠）で、実 Jev が 1 枠目の例に引っ張られて family_name 0.53 / full_name 0.47（確信度 0.49）と答え、
  2 枠に割る規則が無くて空欄のままだった。`test-pages/autofill-kayac.html` で再現（修正前 5 件 FAIL → 修正後 80 件 PASS）し、実ページ・実 Jev でも入ることを確かめた。
  あわせて、電話番号・郵便番号の例が「090XXXXXXXX」のように X で書かれていてもハイフンなしで入れる
- 2026-09-27（dev 版での試用）: **Jev の API キーを保管庫の中に移した**（Mac ごとに端末鍵で持つと、別の Mac で入れ直しになる）。
  古い置き場所（userData の `jev-key.json`）は読むだけ残し、プロフィールかキーを保存したときに保管庫へ移して消す。
  保管庫の中身は `{ profile, jevKey }` になり、最初の形（プロフィールそのもの）も読める（`normalizeVaultContent`）
- 2026-09-27（dev 版での試用）: **欄のすぐ前の見出し（label / span・1 文字を超える地の文）を表の見出し（th / dt）より優先**し、th / dt は `section` として Jev に別に渡す。
  分割欄にまとめるのは「続く欄が自分の見出しを持たない（label が無く、すぐ前が別の欄か 1 文字の区切り）」ときだけ。
  EFO CUBE のサンプル（th「ご住所」の中に「郵便番号」「都道府県」… が段落で並ぶ）で、th を全欄の見出しにして 3 つずつまとめてしまい、住所 6 欄が入らなかった。`test-pages/autofill-efo.html` で再現（修正前 6 件 FAIL → 修正後 67 件 PASS）
- 2026-09-27（レビュー 1 回目）: **Jev の API キーが無いときは設定画面を開かず、ルールで決まる欄だけ入れる**（キーは任意。設定画面にも「未設定（autocomplete 属性のある欄だけ入ります）」と出している）。設定画面を開くのは保管庫が無い / 開けないときだけで、節までのスクロールはしない
- 2026-09-27（レビュー 1 回目）: `type=email` / `type=tel` の欄も決定表どおり**ルールで入れ、本人性は聞かない**（紹介者のメール欄が `type=email` だと本人の値が入りうる。気になったら動作確認で見直す）
- 2026-09-27（レビュー 1〜2 回目）: **ルールの対応表（`AUTOCOMPLETE`）にある autocomplete を持つ欄だけ**分割グループにまとめない（1 行に `family-name` / `given-name` が並ぶと先頭だけで決まり、2 欄とも空になっていた）。`off` / `on` / 知らない値はまとめる（電話 3 分割によく付く。属性の有無で判定すると壊れる）
- 2026-09-27（レビュー 2 回目）: **`maxlength` に収まらない値は入れない**（代入では maxlength が効かない）。分割グループは 1 つでも収まらなければグループごと入れない（月 / 日 / 年の順のフォームで年が月の欄に入るのを防ぐ）
- 2026-09-27（レビュー 1 回目）: 同じタブで自動入力が走っている間の 2 回目は `busy` で弾く（収集した要素はページ側の 1 か所に持つので、重なると別の欄を指す）
- 2026-09-27（Phase 6）: **iframe の中では自動入力を出さない**（メインフレームだけ）。`WebFrameMain` はメインワールドの `executeJavaScript` しか持たず、
  メインワールドで走らせるとページが `getComputedStyle` 等を差し替えて**可視判定を偽り、見えない欄に値を入れさせられる**。埋め込みフォーム（HubSpot 等）は非対応
- 2026-09-27（Phase 4）: `form` が無いページは**ページ全体**を対象にする（「欄を 2 個以上含む最も近い祖先」だと 2 欄だけの行で止まって残りを落とす。関係ない欄は Jev が `none` で落とす）
- 2026-09-27（Phase 4）: **radio は非対応**（性別の radio など）。text 系・select・textarea だけ
- 2026-09-27（Phase 4）: 手がかりの抽出は DOM が要るので**ユニットテストではなく自走検証（実ページ）で見る**（jsdom を依存に足さない）
- 2026-09-27（Phase 2）: キャッシュするのは派生鍵ではなく**復号した中身**（mtime・サイズ・パスフレーズが同じときだけ使い回す）。鍵を持っても毎回の復号は要るので、中身を持つ方が単純
- 2026-09-27（Phase 7）: 移行の検証は見送った。保管庫は今回が初版で、読むべき旧版が無い（版を上げるときに fixture を作る）
- 2026-09-27（Phase 7）: `autofill` スイートは**フルの既定に入れた**（`OPT_IN_ONLY` にしない）。起動 1 回・全体 9 秒で、フルの時間をほぼ延ばさない
- 2026-09-27（Phase 1）: 欄の指し方を `state.fields[i]` から**質問ごとの `instructions.field`** に変えた（番号で指すと後ろの欄ほど崩れた）
- 2026-09-27（Phase 1）: 分割された欄（電話・郵便番号・生年月日）は**グループで 1 問**にし、`tel_part1..3` などの選択肢は廃止。割り当ては並び順でコードが決める
- 2026-09-27（Phase 1）: 「誰の情報か」を判定する**本人性の noul を欄ごとに追加**。入れる条件は choice ≥ 0.5 かつ本人性 ≥ 0.5
- 2026-09-27（Phase 1）: 1 リクエストの欄数に上限（40 欄）を設け、超えたら分割して並列に投げる（欄 1 つあたり約 1.15k トークン、上限 64k）
- 2026-09-27: API キーの置き場所を `~/.typesafe-key` から scratchpad に変えた（ホーム直下にファイルを作らない決まりのため）
- 2026-09-27（Phase 0）: Jev の呼び出しは **SDK を入れず `fetch` で直接叩く**。body が小さく固定の形で、
- 2026-09-27（Phase 0）: `model` は **`jev-1.13.0` に固定**（alias は閾値調整後に黙って中身が変わるため）。版上げは手動で閾値を見直してから
- 2026-09-27（Phase 0）: 質問・選択肢の説明は**英語**、欄の手がかりは原文のまま（日本語の精度が落ちるため）

