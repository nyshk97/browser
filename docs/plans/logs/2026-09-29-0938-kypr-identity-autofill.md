review session: 0ce5f77d-c0e0-4ec5-b5c9-cf4c6f0e3fa9

## 1回目

````text
## P0
- Phase 1 > 1（あわせて Phase 4 > 2）— 身分証の欄が、本人性の判定（`own` の noul）で落とされる。 / `autofill-match.js` の `OWN_CRITERIA` では、true 側に身分証が入っていない。false 側には「not personal information at all (… passwords, IDs)」とあるので、パスポート番号や免許証番号の欄は本人性が 0.5 未満になる見込みが高い。その場合、choice を正しく当てても `OWN_THRESHOLD` で全部捨てられる。plan は choice の足切りだけを上げる話になっていて、本人性の説明を直す手順がない。 / 試し撃ちで本人性の noul も一緒に投げて、身分証の欄で何点になるかを記録する。`OWN_CRITERIA.true` に「filler's own passport / driver's license / health insurance card numbers and expiry dates」を足し、false 側の「IDs」は「会員番号・予約番号などの IDs」と限定する。Phase 4 にも `OWN_CRITERIA` を直す手順を足す。同行者のパスポート欄が本人性で落ちることも Phase 1 と test-pages で確かめる。
- Phase 4 > 3 — `document_expiry` の書類を「直前にある、身分証の番号で埋まった欄」で決めると、カードの有効期限にパスポートや免許証の期限が入る。 / Jev の選択肢にはカードの項目がない。そのため「カード番号の直後の有効期限」も Jev は `document_expiry` と答えやすい。後ろへさかのぼって身分証の番号を探すと、フォームの上の方にある免許証番号まで届いてしまう。レンタカー予約（免許証とカード払いが同じフォーム）でそのまま起きるし、Phase 5 の test-pages の「カード払いの有効期限」でも落ちる。 / 探すのは**すぐ前の欄 1 つだけ**にする（`collected.fields[index-1]`。分割された年月日のグループは 1 欄として数える）。その欄が身分証の番号に決まっているときだけ書類を決め、それ以外（Jev が決めなかった欄・カード番号を含む）なら捨てる。`document_expiry` の説明にも「credit card expiry ではない」と書く。
- Phase 4 > 8 と「動作確認前の準備 [人間👨‍💻]」> 1 — 今の値を kypr に入れ直す前に、元の保管庫が消える。 / 手順の並びが「Phase 4 で `autofill.json` を消す（開発版では設定画面も消える）→ 人間があとで今のプロフィールの値を入れる」になっている。この時点で値を見られる場所がない。しかもリリース前に iCloud のファイルを消すので、インストール済みの v1.3.1 の自動入力が全 Mac で先に止まる。 / ファイルの削除は Phase 4 から外す。「動作確認 [人間👨‍💻]」の後に、人間が確認してから消す手順として置く。値を kypr に移すのは Phase 4 より前の人間の手順にする（まだ動いている v1.3.1 の設定画面で見ながら入れる）。

## P1
- Phase 4 > 6 — Jev キーを safeStorage に**書く**関数がない。 / `jev-key.ts` にあるのは `readJevKey` / `clearJevKey` / `hasJevKey` だけ。`nemo:jev-key-save` / `nemo:jev-key-clear`（`ipc.ts`）は保管庫を書き直す作りになっている。Phase 4 > 7 の「関連する IPC / preload を消す」で、この 2 つまで消されるおそれもある。 / `writeJevKey()` を足すこと、2 つの IPC を safeStorage の読み書きに作り直して残すこと、を手順に書く。`verify-autofill.mjs` の「古い置き場所のキーは保管庫へ移って消える」「2 台目: 古い置き場所にキーを作らない」の検査は、逆向きの検査に直すと明記する。
- Phase 4 > 2 — 候補の説明を書く先が違う。 / 選択肢と説明（`JEV_OPTIONS`）・`CHOICE_QUESTION`・`OWN_CRITERIA` は `src/shared/autofill-match.js` にある。`jev.ts` は fetch するだけ。 / 手順の対象を `autofill-match.js` の `JEV_OPTIONS` / `OWN_CRITERIA` に直す。`none` の説明にも「membership / reservation / employee numbers, My Number, credit card number and expiry」を足す。
- Phase 4 > 3 — `document_expiry` をいつ具体的な項目に置き換えるかが書かれていない。 / `resolveConflicts` は同じ項目を 1 か所に絞る。「有効期限」だけの欄がパスポートと免許証で 2 つあると、`document_expiry` のままでは片方が消える。書類名つきで `passport_expiry` と決まった欄とも取り合いになる。 / 「`readJevAnswers` の後、`resolveConflicts` の前に `document_expiry` を `passport_expiry` / `license_expiry` に置き換える」と順番を書き、ユニットテストの場合分けに入れる。
- Phase 4 > 4 — 日付を分割する処理は `autofill-values.js` だけでは広がらない。 / 3 つの欄への割り当ては `autofill-match.js` の `expandGroup`（`birthday` で 3 つのときだけ）にある。`PART_TO_WHOLE` も `birthday_*` だけ。`deriveValues` は入れるキーを列挙していて、身分証のキーも `*_year/_month/_day` の導出も出てこない。直さないと、年月日の 3 つに分かれた期限欄は空欄のまま残る。 / 手順に、`expandGroup` / `PART_TO_WHOLE` を日付の項目全般に広げることと、`deriveValues` に身分証の 8 キーと期限の年月日を足すことを加える。kypr の平文 → profile の変換は `normalizeProfile` を通す（日付の妥当性・200 字の上限）ことも書く。
- Phase 2 > 2 — `packages/client` の型が手順から抜けている。 / `session.ts` の `EntryState` は login / note / card / unknown / error を自前で並べている。`decryptItem` が `identity` を返すと、ここと `VaultItem` を使う `create` / `update` の型が合わなくなる。Nemo 側の `src/shared/types.ts`（`KyprItemKind`、`KyprItemInput['type']`）と、`saveKyprItem` / `pickFields` の type のリストも同じ。 / Phase 2 に `packages/client/src/session.ts` を、Phase 3 に `src/shared/types.ts`・`saveKyprItem` / `pickFields`・`SECRET_FIELDS` / `COPYABLE` を明記する。
- Phase 2 > 1 — kypr の平文の実際のキー名と、検査の厳しさが決まっていない。 / iOS もあとで読む、リポジトリをまたぐ取り決めなのに、plan には snake_case しか書いていない。`isCardItem` と同じく「全キーが string」を必須にすると、あとで項目を足すたびに schema を上げることになる。日付の形まで `isIdentityItem` で見ると、Web の不具合 1 つでアイテム全体が `malformed`（開けない）になる。 / 仕様の節に camelCase のキーの一覧（`familyName` `postalCode` `addressLevel1` `passportNumber` `passportExpiry` `insurerNumber` …）を書く。「キーが無ければ空文字として読む」「日付・性別（`""/male/female/other`）の形はエディタと自動入力の側で見て、復号では string かどうかだけ見る」も決めて書く。
- Phase 4 > 7（あわせて Phase 4 > 5）— `context-menu.ts` の分岐は「消す」のではなく「差し替える」。 / 今の分岐は `no-vault` などで設定画面を開くもの。新しい作りでは、ロック中で Touch ID が通らない・未ログイン・個人情報が 0 件のときに kypr のポップアップを開く必要がある。消すだけだと何も起きなくなる。 / `AutofillRunResult.reason` に `kypr-locked` / `kypr-signed-out` / `no-identity` を足し、`context-menu.ts` でそれを受けてウィンドウの kypr のポップアップ（`setOverlay('kypr')`）を開く、と書く。
- Phase 1 > 1 — 試し撃ちのスクリプトと、今の答えが落ちないか見るための 37 欄が手元にない。 / `jev-spike/spike-final.mjs` は前のセッションの scratchpad にしかなく、git にも入っていない。 / 使い捨てスクリプトは本体の `buildJevRequests`（最終形の body を作る）を import して作ると書く。今の正答が落ちないかは `test-pages/autofill*.html` を `autofill-survey.mjs` と同じ手順で集めて見る、に替える。

## P2
- Phase 3 > 3 — 「一番古い 1 件」の決め方が書かれていない。 / どの時刻で比べるかと、何を除くかが決まっていない。 / `createdAt` の昇順で比べ、ゴミ箱の中・`unknown` / `error` の状態のアイテムは除く、と書いて、ユニットテストの場合分けに入れる。
- Phase 4 > 5 — 自動入力で kypr を使ったときに `touchKypr()` を呼ぶと書かれていない。 / 呼ばないと、自動入力だけ使う人は 1 時間ごとに Touch ID を求められる。 / 個人情報を読んだときに `touchKypr()` を呼ぶと書く。
- Phase 5 > 4 — OWNERS の直す範囲がはっきりしない。 / `src/main/kypr/index.ts`・`src/vendor/kypr/crypto/item.ts`・`client/session.ts` は今は `kypr` だけの持ち物。逆に `slots.ts`・`auth-vault-*.js` は保管庫を消すと `autofill` と関係がなくなる。 / `autofill` を足すファイルと外すファイルを並べて書く。
- 個人情報の項目 — 保険証の「記号 [ ] - [ ] 番号」のような 2 つの箱が 1 グループにまとめられた場合の扱いがない。 / 収集側は区切り 1 文字で箱をまとめるが、それに対応する選択肢も `expandGroup` もない。 / Phase 1 の欄のセットに入れて、どうなるかだけ見ておく。

## Q

````

**対応**: P0 3件すべて反映（①`OWN_CRITERIA` の true 側に身分証を足し false 側の IDs を限定する決定を追記、Phase 1 で本人性の noul と同行者の欄を測る ②`document_expiry` はすぐ前の欄 1 つだけを見る形に決定表・Phase 4 を変更、説明に入れない例を書く ③値の入れ直しを「Phase 4 前の準備 [人間]」に移し、`autofill.json` の削除を Phase 4 から外して「リリース後の片付け [人間]」へ）。P1 は全部反映（Jev キーの書き込み関数と IPC を作り直して残す・verify の検査を逆向きに／候補の説明の対象を `autofill-match.js` の `JEV_OPTIONS` に訂正／`document_expiry` の置き換えを `readJevAnswers` の後・`resolveConflicts` の前に／日付の分割は `expandGroup`・`PART_TO_WHOLE`・`deriveValues` も対象に、`normalizeProfile` を通す／`packages/client` の `EntryState` と Nemo の `types.ts`・`saveKyprItem` 等を明記／`isIdentityItem` は string かどうかだけ見る決定を追記（キー名の一覧は実装時に仕様へ書くので plan には足さない）／`context-menu.ts` は消さず差し替え／試し撃ちは `buildJevRequests` を import、正答の確認は test-pages で）。P2: 一番古い 1 件の決め方・`touchKypr()`・保険証の 2 つの箱（Phase 1 の欄のセットへ）を反映。OWNERS に足す / 外すファイルの列挙は実装時に決める細部なので見送り。

## 2回目

````text
## P0
- Phase 1 > 2（あわせて 決定表「書類名の無い『有効期限』の欄」と Phase 4 > 3）— 発行日・交付日の欄が試し撃ちの欄のセットに入っていない。「すぐ前の欄 1 つだけ」の決め方も、よくある並びでは空欄になる。 / パスポートや免許証の欄は「番号 → 発行日（交付日）→ 有効期限」と並ぶことが多い。今の決め方だと、有効期限のすぐ前は発行日なので、書類名の無い「有効期限」はまず埋まらない。さらに選択肢に発行日が無いので、Jev は発行日の欄に一番近い `passport_expiry` / `document_expiry` を選びやすい。その場合、発行日の欄に有効期限が入る。1 回目のレビューで「すぐ前の 1 欄」を勧めたのは私なので、この点はその指摘の詰めが甘かった。 / 欄のセットに「発行日・交付日・発行国・免許の色」を足す。`none` と期限の候補の説明に「発行日・交付日ではない」と書く。すぐ前の欄を見るときは、発行日・交付日の欄（Jev が決めなかった日付の欄やグループ）だけ飛ばしてさかのぼる。カード番号を含むそれ以外の欄に当たったら止まる。この形に決定表と Phase 4 > 3 を直し、Phase 5 > 1 のユニットテストにも「発行日を挟む」「カード番号の直後」の場合を足す。

## P1
- Phase 2 > 6 — kypr Web を本番に出す手順が無い。 / 決定表では「Nemo と kypr Web を同時に作る」ことになっている。ところが Phase 2 はコミットまでで、動作確認にも Web の項目が無い。本番の Web が古いままだと、Phase 4 前の準備で作った個人情報は Web で「読み取り専用」と表示され、そのことに誰も気づかない。 / Phase 2 の最後に Web のデプロイ（人間の手順ならそう書く）を足す。動作確認にも「Web で個人情報を開いて編集・保存し、Nemo 側に反映される」を足す。

## P2
- 前提・わかっていること > コードベース — 直す前の記述が残っている。 / `src/main/autofill/jev.ts`（候補の説明）と `context-menu.ts`（保管庫が無いときに設定画面を開く分岐）の書き方が、直した後の Phase 4（説明は `autofill-match.js` の `JEV_OPTIONS`、context-menu は kypr のポップアップへ差し替え）と食い違っている。 / 「候補の説明と本人性の説明は `autofill-match.js`」「`context-menu.ts`（失敗時の誘導先。kypr のポップアップへ差し替える）」に直す。

## Q

````

**対応**: P0 反映（`document_expiry` の決め方を「Jev が決めなかった日付の欄（発行日・交付日）だけ飛ばしてさかのぼり、最初に当たった欄が身分証の番号ならその書類、それ以外は止めて空欄」に決定表・Phase 4 を変更。発行日は保存せず説明に「発行日・交付日ではない」と書く。Phase 1 の欄のセットに発行日 / 交付日・発行国・免許の色を、ユニットテストに「発行日を挟む」「カード番号の直後」を足した）。P2（コードベースの節の古い記述）を直した。P1（kypr Web の本番デプロイと Web での動作確認）はステップの追加なのでループ中は見送り、終了報告に回す。

## 3回目

````text
## P0

## P1
- Phase 4 > 3 — 「Jev が決めなかった日付の欄」を、コードで何を見て日付の欄と判断するかが書かれていない。 / この判断で、飛ばしてよい欄かどうかが決まる。広く取りすぎると、日付でない未決定の欄（発行国の select など）も飛ばしてしまい、1 回目に直した「さかのぼりすぎて別の書類の期限を入れる」問題が戻ってくる。狭すぎると「番号 → 発行日 → 有効期限」の並びで期限が空欄になる。 / 判定を 1 つの純粋関数にまとめ、条件を plan に書く。例: `type=date`、年月日に分かれたグループ（select の選択肢の見本が年・月・日）、見出しが `/発行|交付|年月日|date/i` に当たる、のどれか。Phase 5 > 1 のユニットテストに「発行国の select を挟むと止まる」を足す。
- Phase 5 > 2 — test-pages の身分証のフォームに、発行日・交付日と発行国の欄が入っていない。 / 2 回目で足した「番号 → 発行日 → 有効期限」の規則は、ユニットテストでしか確かめられない。Jev のモックを通した E2E で「発行日の欄が空のまま・期限は正しく入る」を確かめる手段がない。 / 身分証のフォームに「旅券番号 → 発行日（年月日の select）→ 有効期限」と「免許証番号 → 交付日 → 有効期限 → 免許の色」の並びを置く。`verify-autofill.mjs` で、発行日の欄が空のまま残ることを確かめる。

## P2

## Q

````

**対応**: P0 なしで収束。P1 2件を反映（Phase 4 > 3 に「日付の欄」の判定を 1 つの純粋関数にし、条件の例と「発行国の select は飛ばさない」を書いた。ユニットテストに「発行国の select を挟むと止まる」を足した／Phase 5 の test-pages に「番号 → 発行日 → 有効期限」「免許証番号 → 交付日 → 有効期限 → 免許の色」の並びを入れ、発行日・交付日の欄が空のまま残ることを verify-autofill で見る、とした）。
