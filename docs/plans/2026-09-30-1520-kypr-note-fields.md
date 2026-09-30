# kypr のセキュアメモの項目・テンプレートと、個人情報の新しい項目を Nemo で扱う

## 概要・やりたいこと

kypr のセキュアメモに「項目」（ラベル・値・伏せ字・複数行）と「テンプレート」（銀行口座・Wi-Fi など 7 種）が付き、個人情報に 12 項目（免許の暗証番号 1・2、基礎年金番号、マイナンバーカードの 7 項目、パスポートの発行日・免許の交付日）が増えた（kypr 側の plan: `~/kypr/docs/plans/2026-09-30-1447-note-fields-templates.md`。仕様は `~/kypr/docs/crypto-spec.md`「セキュアメモ」「項目（`fields`）」「セキュアメモのテンプレート」「個人情報」）。
kypr の仕様・`packages/crypto`・`packages/client`・Web・iOS は 2026-09-30 に実装した。**この plan は Nemo 側**で、vendoring を更新し、ポップアップの詳細でメモの項目を見られるようにする。

**項目は消えないが、伏せ字の値が漏れている**: 今の Nemo でも、項目付きのメモや新しい項目の入った個人情報を編集して**項目が消えることはない**（`saveKyprItem` が既存の平文に `{ ...s.item, ...fields }` で重ね、`pickFields` の `IDENTITY_KEYS` はまだ古いため。2026-09-30 に kypr 側で確かめた）。ただし `kyprItem` は `structuredClone(s.item)` を返し、メモの `SECRET_FIELDS` は `[]` なので、**メモの伏せ字の項目の値が、詳細・編集を開くたびに renderer に渡っている**（「秘密は表示・コピーのときだけ渡す」に反する。1 回目のレビューで判明）。これを最初に塞ぐ。

## 前提・わかっていること

### kypr で決まったこと（Nemo に関わるもの）

| 論点 | 決定 |
| --- | --- |
| メモの平文 | `template`（string。`""` はテンプレートなし。無ければ `""`。知らない値は普通のメモとして出す）と `fields`（`{ key, label, value, secret, multiline }` の配列。無ければ `[]`。要素の知らないキーは残す）。`schema` は 1 のまま |
| 項目の見せ方 | 値のある項目だけ出す。伏せ字の項目は「表示」を押すまで伏せる。項目ごとにコピー。一覧の 2 行目はテンプレート名（本文も項目の値も出さない） |
| 検索 | メモは名前・本文・**伏せ字でない**項目の値・テンプレート名で探す（`noteSearchText` / `noteTemplate`）。伏せ字の値では引かない |
| テンプレートの専用の機能 | Wi-Fi の QR（`wifiQrText`。押したときだけ出す）・銀行口座の振込先のまとめコピー（`bankTransferText`）。Nemo で出すかは下の論点。テンプレートは 7 個（マイナンバーカードは個人情報へ移した） |
| 個人情報の新しい項目 | `licensePin1` / `licensePin2`（伏せ字・**自動入力に出さない**。`IDENTITY_FIELDS` の `noAutofill: true`）・`pensionNumber`（伏せ字・自動入力に出してよい。グループ「年金」）・マイナンバーカードの 7 項目（下の行）・`passportIssueDate`（パスポートの発行日）/ `licenseIssueDate`（免許の交付日。どちらも日付で、自動入力に出してよい） |
| マイナンバー | **個人情報に入れる**（2026-09-30 に変えた。本人の希望で身分証を 1 か所にまとめる）。グループ「マイナンバーカード」に `myNumber` / `myNumberCardExpiry` / `myNumberCertExpiry`（日付）/ `myNumberSignPassword` / `myNumberAuthPin` / `myNumberResidentPin` / `myNumberInfoPin`。**全部 `noAutofill`**（自動入力の候補にしない）。Nemo の `2026-09-29-0934-kypr-identity-autofill.md` の「マイナンバーは保存もしない」は、「保存はするが自動入力の候補には一切しない（入れない例の説明はそのまま）」に読み替える |

### kypr 側にあるもの（vendoring でコピーされる）

- `crypto/item.ts`: `NoteItem` に `template` / `fields`、`NoteField`・`normalizeNoteItem`。`IDENTITY_KEYS` に 12 個増えた
- `client/note-templates.ts`（新規）: `NOTE_TEMPLATES` / `noteTemplate` / `templateFields` / `customField` / `fieldValue` / `noteSummary` / `noteSearchText` / `wifiQrText` / `bankTransferText`
- `client/identity.ts`: 12 項目（マイナンバーカードの 7 項目と発行日・交付日を含む）と `noAutofill` の印
- テストベクタ（`test-vectors/v1.json`）: `noteItem`（項目付き）・`noteItemSparse`・`noteItemMalformed`・`noteTemplates`・`wifiQr`・`bankTransfer`

### 調べてわかったこと（Nemo のコード。2026-09-30）

- `mise run export-nemo` を 2026-09-30 に試したところ、**`scripts/kypr-identity.test.mjs` が落ちる**（`PROFILE_FIELDS` と kypr の `IDENTITY_FIELDS` を突き合わせていて、足した項目が `PROFILE_FIELDS` に無い）。typecheck は通った。Nemo の作業ツリーを汚さないよう、コピーは戻してある
- 秘密の項目は `src/main/kypr/index.ts` の `SECRET_FIELDS` で「詳細では渡さず、表示・コピーのときだけ渡す」にしている（`note: []`）。メモの項目の伏せ字は**キーではなく要素ごと**なので、この表では表せない
- ポップアップの詳細は `src/renderer/components/Kypr.tsx`（`visibleFields`。L1400 付近）、編集の検査は `pickFields`（メモは `['name', 'notes']` だけを取り出す）

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] なし（kypr の変更はコミット済み。マイナンバーカードを個人情報へ移したのはその後のコミット）

### Phase 0: メモの伏せ字の値を renderer に渡さない [AI🤖]
- [x] main: メモの詳細・編集を渡すとき、**伏せ字の項目の値は空にして渡す**（`SECRET_FIELDS` と同じ考え。要素ごとなので別の関数にする）。値を空にしても伏せ字の項目が詳細から消えないよう、値があることは別に渡す。編集の口（メモの編集画面は `fields` を使わない）も同じにする（保存は `{ ...s.item, ...fields }` で重ねるので消えない）

### Phase 1: vendoring と個人情報 [AI🤖]
- [x] `~/kypr` で `mise run export-nemo`（`VENDORED.md` のコミットを更新）→ Nemo で typecheck と test
- [x] `src/shared/autofill-schema.js` の `PROFILE_FIELDS` に 12 項目（免許の暗証番号 2・基礎年金番号・マイナンバーカード 7・パスポートの発行日・免許の交付日）を足す。**上の vendoring と同じコミットにする**（vendoring で `pickFields` の `IDENTITY_KEYS` が増える一方、編集画面の `EDIT_FIELDS.identity` は `PROFILE_FIELDS` から作るので、片方だけだと Nemo で個人情報を編集したときに新しい項目が `''` で上書きされる）。`noAutofill` の 9 項目は自動入力に一切出さない: 源流（`kyprIdentityForFill` か `profileFromKypr`）で値を渡さず、`PROFILE_FIELDS` の `type: 'date'` から自動で作られる `DATE_KEYS`（`autofill-values.js`）からも除く（マイナンバーカードの期限 2 つが入り込むため）。`kypr-identity.test.mjs` の突き合わせに `noAutofill` も入れる
- [x] 発行日・交付日を自動入力の候補にする（`JEV_OPTIONS` の身分証の候補に足す。年月日に分けた欄は有効期限と同じ導出を使う）。`src/shared/autofill-match.js` の書類まわりを揃えて直す（**そのままだと「番号 → 発行日 → 有効期限」の書類名の無い有効期限が空欄になる**: `resolveDocumentExpiry` は決まらなかった日付の欄だけを飛ばしてさかのぼるので、発行日が決まるとそこで止まる）: ① `DOCUMENT_EXPIRY` に発行日 → その書類の期限を足す ② `DOCUMENT_OPTIONS` に 2 つを足す（足切り 0.8） ③ `none` の説明から「issue dates of documents」を消し、`OWN_CRITERIA.true` に発行日を足す ④ 書類名の無い「発行日」は入れない（空欄のまま）と説明に書く
- [x] ~~`pensionNumber` を自動入力の候補にするか決める~~ → 今回の範囲に入れない（1 回目で決定。kypr 側は「出してよい」としただけで、入れると `deriveValues` の値のリスト・足切り・`OWN_CRITERIA` まで手が要る。欲しくなったら別の plan で）

### Phase 2: ポップアップでメモの項目を見る [AI🤖]
- [x] main: 「表示」「コピー」で伏せ字の項目を 1 つずつ渡す。今の `kyprReveal` / `kyprCopy(id, field)` とは別の口にする（上の段のキーと取り違えない。トーストは項目のラベルを出す）。**項目は位置で指し、main でその位置の項目の `key`・ラベルが詳細で渡したものと同じときだけ返す**（ずれていたら null。`key` だけでは指せない: 自分で足した項目の `key` は全部 `""`（kypr の `crypto-spec.md`「項目（`fields`）」）。位置だけだと、詳細を開いてから同期で並びが変わったときに隣の項目の値を出す）
- [x] renderer: 詳細にテンプレート名・値のある項目（ラベル・値・コピー・伏せ字は「表示」）を出す。一覧の 2 行目をテンプレート名にする（main の `summaryOf` で `subtitle` に入れる）
- [x] 検索の対象を kypr と揃える。**検索は main で `noteSearchText` を使って行い、一致した ID だけを返す**（renderer でやると、ポップアップを開くだけで全メモの本文・項目の値が renderer に載る。今の一覧は本文すら渡していない）
- 決めたこと（1 回目で決定）: 編集では項目を扱わない（Web / iOS で編集する）。Wi-Fi の QR と振込先のまとめコピーは今回の範囲に入れない（QR はライブラリの選定・ライセンス確認が要る。まとめコピーは項目ごとのコピーで代えられる）

### 動作確認 [人間👨‍💻]
- [ ] 常用版の Nemo のポップアップで、kypr で作った銀行口座・Wi-Fi のメモの項目が見え、コピーできること。伏せ字の項目が「表示」まで出ないこと

## ログ
### 試したこと・わかったこと
- 2026-09-30 実装: vendoring は kypr `756e741`。`noAutofill` の 9 項目は `AUTOFILL_FIELDS`（`PROFILE_FIELDS` から `noAutofill` を除いたもの）で自動入力のプロフィール・`DATE_KEYS` から外し、`kyprIdentityForFill` でも渡さない。メモの項目は `KyprItemDetail.noteFields`（伏せ字の値は空・`hasValue`）で渡し、「表示」・コピーは `kyprRevealNoteField` / `kyprCopyNoteField`（位置・`key`・ラベルが揃ったときだけ）、検索は `kyprSearchNotes`（main）
- 確認: ユニットテスト 547 件 PASS・`mise run verify:only kypr autofill` 全件 PASS（kypr 126・自動入力 149）。伏せ字を空にする処理とラベルの照合を外すと kypr の 2 件が FAIL することを確認済み

### 方針変更
