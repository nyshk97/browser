review session: d174db24-c8a6-4494-8fa1-a2aea8d9f8e6

## 1回目

````text
レビュー結果です（差分の全ファイルと plan を突き合わせ。lint / typecheck / テストはこの環境では実行できなかったので静的レビューのみ）。

## P0
- `src/main/http-auth.ts:runDialogRounds`（plan: Phase 3 >「ダイアログは『照合結果のグループ』ごとに 1 つ」/ Phase 4 >「`rejected` なら、採用されたルールの username / password を更新する」） — ダイアログの代表を `space.waiters[0]` で決めているが、保護サブリソースが複数あるページでは先頭が「まだ拒否されていない `autofill` 待ちの waiter」になる（URL1 が autofill → URL2/URL3 が `waiters` に積まれる → URL1 の 2 回目で `failAutofill`）。この waiter は `rejected: false` / `prefill: null` / `rejectedRule: null` なので、**prefill も「拒否されました」の表示も出ず、保存チェックを付けても `saveFromDialog` が `patternFromUrl(URL2)` で新規ルールを作る** / ワイルドカードやインポート済みのルールを直しても元ルールが残り、別 URL では再び誤った資格情報が飛ぶ（#6 の自己修復が成立しない）。単発リソース（検査⑤）では先頭が rejected になるので現行の自走検証では出ない / グループを決めたあと、代表は `group.find((w) => w.rejected) ?? group[0]` のように **rejected を持つ waiter を優先**して選び、その `rejectedRule` / `prefill` で `askAuth` と `saveFromDialog` を回す。あわせて `checkSerializedSubresources` に prefill の有無と「ルールが増えていないこと」を足す。
- `src/main/http-auth-matcher.ts:testPattern`（plan: Phase 1 >「ジョブはルール 1 件単位」「`runtime` と `tester` を区別する」「タイムアウトしたら…その ID のルールを自動的に無効化」） — タイムアウト時の `disposeWorker('timeout')` が `settleAll('timeout')` で**pending を全部 `timeout` にして返す**ので、同時に走っている別の照合（並列 401 の別リクエスト、あるいは Settings のテスター）が、自分の見ていたルールを `timedOutIds` に積む / `resolveCredential` がそれを `disableHttpAuthRule(id, 'pattern-timeout')` に渡すため、**敵対的パターンと無関係な正常ルールが巻き添えで無効化される**。tester 側の timeout でも runtime の pending が `timeout` になるので「未保存の下書きで保存済みルールが無効化される」経路も残っている（検査⑭⑮はどちらも照合が 1 本しか走らないので通過する） / タイムアウトした job の id だけを `'timeout'` で解決し、巻き添えの pending は `'error'`（＝無効化しない不一致）で解決する。`settleAll(outcome, exceptId)` のように分ける。

## P1
- `src/main/store/http-auth.ts:getHttpAuthCredential` — 端末鍵が使えない状態で照合が当たると `decrypt()` が必ず throw し、**マッチしたルールが次々 `decrypt-failed` で恒久的に無効化される**（`validateStoredCredentials` は `isAvailable()` で守っているのに、こちらは守っていない） / この状態では password の再保存も `no-encryption` で断られるため、理由を消す手段がなく回復できない。検査㉑はルールを消してから撃つので踏まない / 先頭で `getSecretBackend().isAvailable()` を見て、false なら**無効化せずに** null を返す（＝今回だけ自動入力しない）。
- `src/main/store/http-auth.ts:importHttpAuthRules`（plan: Phase 1 >「件数…の上限を全保存入口で共通に適用」/ Phase 5 >「取り込み結果と警告を返す」） — 件数上限の判定が `importMultipass` 側の「取り込む件数だけ」で、既存件数との合算を見ていない。既存 100 件 + 取り込み 150 件のとき `commitRules` → `normalizeRules` が末尾（＝取り込んだ分）を黙って 200 件で切るのに、IPC は `imported: 150` を返す / 「取り込んだと表示されたのに存在しないルール」ができ、拒否理由も出ない / `importMultipass` に既存件数を渡して超過分を `rejected: 'too-many'` に回すか、`importHttpAuthRules` が commit 後の実件数を返して IPC の `imported` に反映する。
- `src/main/ipc.ts:registerIpcHandlers`（`nemo:save-http-auth-rule` の `credential()`、plan: Phase 1 >「件数と username / password / pattern の長さ上限を…全保存入口と `normalizeRules` で共通に適用する」） — `credential(value, max)` は `slice` で**黙って切り詰める**ので、上限超過の pattern / username / password が「拒否」ではなく「別の値として保存」になる。切り詰め後は `saveHttpAuthRule` の長さチェックが決して真にならず、store 側の `too-long` は事実上デッドコード / plan が名指ししている「入力した値と実際に保存される値が食い違う」状態そのもの（`normalizeRules` は超過を落とす、renderer は `maxLength` で拒む、IPC だけ切り詰める、と入口ごとに挙動が割れている） / この 3 つは `credential()` ではなく長さ超過で `{ saved: false, reason: 'too-long' }` を返す形にし、上限ちょうど / 超過を IPC 経由でも撃つ。
- `src/main/store/http-auth.ts:importHttpAuthRules` — `backend.encrypt()` を try で包んでいない（`saveHttpAuthRule` は包んでいる）。実 backend で暗号化が途中で失敗すると IPC が reject し、`Settings.tsx:HttpAuthRules` の `runImport` は `.catch` を持たないので**未処理の rejection になって画面に何も出ない** / `saveHttpAuthRule` と同じく try で受けて `{ failed: true }` に倒す。

## P2
- `src/main/http-auth.ts:failAutofill` — watchdog 満了でも `denied.add(space.key)` している。応答が 10 秒を超えただけの遅いサーバーでは資格情報が正しくても、その protection space はタブを閉じるか資格情報を変えるまで自動入力されなくなる。watchdog 経路は「今回はダイアログに倒す」だけにして `denied` に入れない選択肢がある。
- `src/renderer/components/Settings.tsx:HttpAuthRules` — 保存成功時の `setDrafts((current) => ({ ...current, [rule.id]: undefined as never }))` がキーを残したまま `undefined` を入れている。`draftOf` の `??` で救われているが、型を偽っているので `delete` するヘルパに寄せたい。
- `src/renderer/components/Settings.tsx:HttpAuthRules`（`runTest`） — 下書きは最初に見つかった 1 件しか送らず、その行の**保存済みパターンも同時に照合対象に残る**ので、両方マッチしたときに「勝者」が下書きではなく保存済みの方になり得る。編集中の行は保存済みパターンを除外して照合すると意図が伝わりやすい。
- `scripts/http-auth-rules.test.mjs:normalizeRules: 上限ちょうどの username / pattern は残る` — pattern が `MAX_PATTERN - 1` 文字（`'^https://' + 'a'.repeat(MAX-9)` = 199）で、名前どおりの「ちょうど」になっていない。`validateHttpAuthPattern` 側には上限ちょうどのテストがあるので実害は小さい。

## Q
- `src/main/http-auth-reset.ts:httpAuthCredentialsChanged` × `src/main/http-auth.ts:saveFromDialog` — ダイアログで保存すると `denied` / `attempts` が全消しされるため、**入力した資格情報も間違っていた場合、その protection space に同じ誤パスワードがもう 1 回自動送信される**（手入力の 1 回 + 直後の autofill の 1 回）。#19 の「変更したら全消し」と #11 の「アカウントロック回避」がここで衝突している。ロックの厳しいサイトを考えて「ダイアログ保存の直後だけは `denied` を残す」に倒すか、現状（自己修復を優先）のままにするかを決める必要がある。決めないと、パスワードを 1 回打ち間違えるたびに失敗試行が 2 回計上される。
- `src/main/http-auth.ts:resolveCredential`（`isPrivate: ctx.isPrivate || !ctx.isTab`） — タブとして解決できない WebContents（拡張の popup、Peek など）をシークレット扱いにまとめている。挙動（自動入力しない）は plan どおりだが、`evaluateEligibility` の `reason` が `'private'` になるためログから「シークレットだったのか、タブでなかったのか」が区別できない。理由を分ける価値があるかは運用上の判断。

````

**対応**: P0 2件・P1 4件・P2 2件を反映。
- P0 `runDialogRounds` — グループの代表を `group.find((w) => w.rejected) ?? group[0]` に変更（順番待ちの waiter が代表になると prefill も「拒否されました」も出ず、保存が新規作成に倒れて自己修復が壊れる）
- P0 `http-auth-matcher.ts:settleAll` — `settleAll(outcome, timedOutId)` に分離。`timeout` を返すのは実際に時間切れになったジョブだけ、巻き添えの pending は `error`（＝不一致・無効化しない）で解決
- P1 `getHttpAuthCredential` — 先頭で `backend.isAvailable()` を見て、false なら無効化せず null（暗号化不可の環境で `decrypt-failed` を立てると再保存も断られて回復手段が無くなる）
- P1 `importMultipass` — 件数上限を**既存との合算**で見る（`existing.length` から数え、上書きは増分に数えない）。超過分は `rejected: 'too-many'`
- P1 `nemo:save-http-auth-rule` — pattern / username / password の上限超過を切り詰めずに `{ saved: false, reason: 'too-long' }` で拒否
- P1 `importHttpAuthRules` — `backend.encrypt()` を try で包み、失敗は `false`（＝`{ failed: true }`）に倒す
- P2 `failAutofill` — `denied.add` を削除（拒否は `resolveCredential` が既に記録しており、ここに残すと watchdog 満了＝応答が遅いだけでも「拒否された」扱いになる）
- P2 `Settings.tsx:HttpAuthRules` — `undefined as never` をやめ、キーごと消す `clearDraft` に置き換え

見送り:
- P2 `runTest`（編集中の行の保存済みパターンを照合から除く）— IPC に除外 ID を足す「何かを足す修正」なのでループ中は見送り、終了報告に回す
- P2 `normalizeRules: 上限ちょうど…` のテスト — `'^https://'` は 9 文字なので `9 + (MAX_PATTERN - 9) = 200` でちょうど上限。指摘の前提（199 文字）が誤りなので変更なし

## 2回目

````text
再レビューしました（`http-auth.ts` / `http-auth-matcher.ts` / `store/http-auth.ts` / `shared/http-auth-rules.js` / `ipc.ts` / `Settings.tsx` を読み直し、plan と突き合わせ）。前回の P0 2 件・P1 4 件・P2 2 件はいずれも意図どおり直っています。特に `settleAll(outcome, timedOutId)` の巻き添え分離と `group.find((w) => w.rejected) ?? group[0]` は、指摘した経路をちょうど塞いでいます。`failAutofill` から `denied.add` を外した点も、拒否の記録は `resolveCredential` 側（`previous > 0`）に残っているので抜けは生じていません。テストの上限ちょうどの件は私の数え間違いでした。

残りは「直したが回帰が固定されていない」という種類のものだけです。

## P0

## P1
- `scripts/verify-http-auth.mjs:checkSerializedSubresources`（plan: Phase 6 >「誤パスワードで拒否されたとき、認証ダイアログが 1 つだけ出ること」/「ダイアログが prefill され、直して再保存すると次回から通ること」） — 代表選びを直したのに、**複数 waiter がある状態で代表が rejected になることを見る検査が無い**。④ はダイアログの件数だけ、prefill を見る⑤ は単一リソース（先頭がそのまま rejected になる）なので、`group.find((w) => w.rejected)` を `group[0]` に戻しても現行スイートは全部 PASS する / 今回の P0 はこの空白があったから残った。直したこと自体が次の変更で消えても気づけない / ④ の `waitDialog()` のあとで⑤ と同じ prefill / `prompt-auth-rejected` の読み取りを行い、`answerAuth('u','p',{save:true})` のあとに **`rules.length === 1` かつ pattern が `patternFor('g4/')` のまま**（＝新規作成に倒れていない）ことを足す。
- `scripts/verify-http-auth.mjs:checkTesterDoesNotDisable`（plan: Phase 6 >「テスターで敵対的パターンを試しても、保存済みルールが無効化されないこと」） — 現行はテスターを**単独で**撃つので pending が 1 本しか無く、巻き添えが起きようがない。`settleAll` の第 2 引数を無視する実装に戻しても PASS する / 「`runtime` / `tester` の区別」が守られているかを実際に確かめられるのは**照合が重なっているとき**だけで、そこが未検査のまま / 敵対的な下書きのテスターと、正常ルールにマッチするページの認証を `Promise.all` で同時に走らせ、**正常ルールに `disabledReason` が付かないこと**と**そのページが自動入力で 200 になること**を見る。ジョブが確実に重なるよう、正常ルールを数件並べて runtime 側の照合を長くする（1 件だけだと窓が数 ms しかなく flaky になる）。
- `src/shared/http-auth-rules.js:importMultipass`（plan: Phase 1 >「`importMultipass`: …構文エラー・欠損・型違い・上限超過の扱い」） — 既存との合算・`claimed` による「上書きは増分に数えない」という**新しい分岐が入ったのに、`scripts/http-auth-rules.test.mjs` に件数上限のテストが 1 つも無い**（既存の `too-long` は username / password の長さのみ） / 純粋関数で `node --test` から決定的に撃てる箇所なのに未固定で、`grows` の条件を間違えても誰も気づかない / 既存 `MAX_RULES - 1` 件 + 取り込み 3 件で「1 件だけ入り 2 件が `too-many` で返る」、および「既存と同じパターンばかりなら上限に達していても全部通る」の 2 本を足す。

## P2
- `src/renderer/components/Settings.tsx:HttpAuthRules`（`reveal`） — `revealHttpAuthPassword` が null を返したときに必ず「パスワードを復号できなかった（ルールを無効化した）」と出すが、端末鍵が使えない環境では `getHttpAuthCredential` が**無効化せずに** null を返すようになったので、この文言は事実と違う。`encryptionAvailable === false` のときは「この端末では取り出せません」に分けると実態と合う。
- `src/shared/http-auth-rules.js:importMultipass` — 同じファイル内に同じホストが 2 回出てくる（MultiPass は url + username でキーが割れるので実際に起こる）と、2 件目を新規採番するため**同一パターンのルールが 2 件並ぶ**。`matchRules` は同点なら登録順で先勝ちなので、2 件目は一覧に出るのに永久に使われない。後勝ちで上書きするか、`rejected: 'duplicate'` として報告するほうが挙動が説明できる。

## Q
- `src/main/http-auth-reset.ts:httpAuthCredentialsChanged` × `src/main/http-auth.ts:saveFromDialog`（前回から持ち越し） — ダイアログ保存で `denied` / `attempts` を全消しするため、**入力した資格情報も間違っていた場合、その protection space に同じ誤パスワードがもう 1 回自動送信される**（手入力 1 回 + 直後の autofill 1 回）。#19「変更したら全消し」と #11「アカウントロック回避」がここで衝突している / 決めないと、パスワードを 1 回打ち間違えるたびにサイト側の失敗試行が 2 回計上される。「ダイアログ保存の直後だけ `denied` を残す」か、現状（自己修復を優先）のままにするかの判断が要る。

````

**対応**: P0 が空なので収束。P2 2件を反映し、P1 3件（いずれも検査の追加）は見送って終了報告に回す。
- P2 `importMultipass` — 同じファイル内に同じパターンが 2 回出たら**後勝ちで上書き**する（`claimed` を `seen: Map<pattern, index>` に置き換え）。従来は 2 件目を新規採番していたため、同点は登録順で先勝ちの `matchRules` により**一覧に出るのに永久に使われないルール**ができていた
- P2 `Settings.tsx:HttpAuthRules`（`reveal`）— `encryptionAvailable === false` のときの文言を「この端末では取り出せない」に分けた（暗号化不可の環境では無効化しなくなったので、従来の「ルールを無効化した」は事実と違う）

見送り（いずれも「検査項目を足す」修正なのでループ中は行わない。終了報告に載せる）:
- P1 `verify-http-auth.mjs:checkSerializedSubresources` — 複数 waiter がある状態で代表が rejected になること（prefill / ルールが増えないこと）の回帰検査
- P1 `verify-http-auth.mjs:checkTesterDoesNotDisable` — テスターと runtime の照合を重ねて巻き添え無効化が起きないことの検査
- P1 `http-auth-rules.test.mjs` — `importMultipass` の件数上限（既存との合算・上書きは増分に数えない）の単体テスト
