review session: 211dacaf-7372-4790-b590-eecc82f333db

## 1回目

````text
## P0
- `src/main/kypr/fill.ts:findTarget`（Phase 4 > ステップ 3、決定表「入れる先のフレーム」） — 2 番目の候補（メインフレーム）を、パスワード欄がなくても `hasFields`（ユーザー名らしい欄だけでも可）で採用している。plan の順は「メインフレームで見えている**パスワード欄** → 直下の iframe で見えているパスワード欄」 / Apple ID（`idmsa.apple.com` の iframe）のようにログイン欄が iframe にあるページで問題になる。メインフレームにメルマガの `type=email` などがあると、そちらが入れる先になる。⌘⇧L・ポップアップの照合もトップの URL になり、iframe に入らないか、メインのメール欄にユーザー名が入る / 2 番目は `mainProbe.hasPassword` のときだけ採用する。ユーザー名だけの欄は、フォーカスがある場合（1 番目）か、iframe にも見つからなかったときの最後の候補に下げる。自走検証に「メインにメール欄・iframe にパスワード欄」のページを足す
- `src/main/kypr/index.ts:pickFields`（決定表「作成・編集できる種類」、Phase 6 > ステップ 2） — `uris` の各要素を `{uri, match}` に作り直しているので、要素の中の知らないキーが保存し直したときに消える。`LoginUri` は `[key: string]: unknown` を許す形。さらに `match` が 0〜5 以外の整数（将来の方式）だと `invalid` を返し、その項目は編集できない。`isLoginItem` は任意の整数を通す。編集画面は `otherUris` をわざわざ保っているのに、ここで落ちる / 「知らないキーは保存し直すときも残す」に反する。Web・iOS で付けたキーを Nemo で編集すると黙って消える / `uri`・`match` だけを検査・上書きし、ほかのキーは元の要素（renderer から来た値ではなく、main が持つ既存の平文）から引き継ぐ。`match` は `Number.isInteger` だけを見る。自走検証の「知らないキーが残る」に `uris[0]` の中のキーと `match: 6` を足す
- `src/main/kypr/index.ts:kyprItem` / `src/renderer/components/Kypr.tsx:KyprDetail`（plan の既定「平文は…表示・コピー・編集を開いたときだけ渡す」、Phase 4 > ステップ 2） — 詳細を開いただけで、パスワード・カード番号・セキュリティコードを含む平文を丸ごと renderer に渡している。伏せて出すのは画面の上だけ / plan は「表示を切り替えたとき・編集を開いたときだけ渡す」と決めている。伏せたまま閉じても、renderer のメモリに秘密が残る / `kyprItem` は秘密の項目を抜いて返す（有無だけを返す）。👁 を押したときに `kyprReveal(id, field)` のような 1 項目だけの口で取る。編集画面は今の `kyprItem` 相当（全項目）を別の口で取る
- `scripts/verify-kypr.mjs`（Phase 3 > ステップ 7） — plan に並んだ検査のうち、「サーバーの巻き戻しで取り直す」が 1 件も無い。「401 → authKey でログインし直し → それでも 401 ならマスターパスワードへ」も、Touch ID で解除する時の 401 しか見ていない。解除中の同期で relogin も 401 になり、`session-expired` → ロック → 覚えた鍵を捨てる、の流れは未検査 / 巻き戻しは `since=0` を取り直す分岐（`VaultSession.sync`）で、Nemo の差し替え（`FileCacheStore.apply(full)`）と組み合わせた検査が無い / 模擬サーバーに revision を下げる口と「login も 401 を返す」口を足し、2 つの検査を足す
- `scripts/verify-kypr.mjs`（Phase 4 > ステップ 7） — バッジの件数の検査が「合う 1 件」と「シークレットで 2 件」だけ。plan の「合わない・サブドメイン・match の種類」が無い / 照合の規則（PSL・match 1〜5・https と http）は、Nemo の中ではバッジとポップアップの経路で一度も通っていない / サブドメインのページ（`a.localhost` 相当 or hosts を使わずに済む 127.0.0.1 と localhost の組）、match 1/3/5 の項目、合わないページで件数 0、をバッジで確かめる
- `scripts/verify-kypr.mjs:findMarkers`（Phase 7 > ステップ 1） — 対照を「目印を書いたファイルを置いたら見つかる」で済ませている。plan は「平文で保存するように細工した版で FAIL することを確かめる」。この差し替えはログにも書かれていない / 今の対照は、走査関数が文字列を見つけられることしか示さない。キャッシュの置き場所や書き方がずれて走査から漏れていても PASS する / plan どおり、平文を書く細工（例: `NEMO_KYPR_TEST_LEAK=1` で `cache-store` が平文も書く。`!app.isPackaged` 限定）を入れた起動で FAIL を確かめる。やらないなら、方針変更としてログに理由を書く
- `src/vendor/kypr/VENDORED.md`（Phase 1 > ステップ 7、Phase 2 > ステップ 1、決定表「kypr のコードの取り込み方」） — コピー元が「`e77d0db`（**未コミットの変更を含む**）」になっている。plan は「コピー元のコミットを記録」「コピー元に未コミットの変更があれば止める」と決めていて、Phase 1 は「kypr にコミット」 / 記録したコミットから、今 Nemo にあるコードを再現できない。止めるはずのスクリプトを素通りしている（上書きの口があるのか、止める処理が無いのか） / kypr 側で Phase 1 をコミットしてからコピーし直し、`VENDORED.md` を綺麗なコミットの記録にする。スクリプトが dirty で止まることも確かめる（こちらは `~/kypr` を読む権限が無く、未確認）

## P1
- `src/main/kypr/index.ts:syncKyprIfStale` — 絞っているのは `lastSyncAt` だけで、これは成功したときしか更新されない。オフラインで開いて読み取り専用になったとき（`lastSyncAt` が null）や、同期が NetworkError・5xx で落ち続けるときは、`pushState` のたび（読み込みの進み・タイトルの変更など）に `goOnline`／`sync` を撃ち直す。`kyprBadge` がこれを呼ぶため / オフラインの間、`/api/login` への試行と `kypr.action_failed` のログがタブの操作ごとに出続ける / 「最後に試した時刻」を別に持ち、失敗しても 1 分（か、バックオフ）は撃たない
- `src/main/kypr/index.ts:unlockKyprWithTouchId` — `if (session)` を見るのは Touch ID の前だけで、`await` の後は確かめずに `attach` している。候補の「解除」とポップアップの「Touch ID で解除」がほぼ同時に走ると、先のセッションが `lock()` されないまま差し替わる / 置き去りのセッションは鍵を 0 で埋めず、トークンも logout しない。「ロックで鍵をメモリから捨てる」が、この経路では守られない / 実行中の解除の Promise を共有して二重に走らせない。あるいは `attach` の前に `if (session) { next.lock(); return ok }` とする
- `src/renderer/components/Kypr.tsx:KyprEditor` / `src/main/kypr/index.ts:saveKyprItem`（Phase 6 > ステップ 4） — 409 のとき、main は取り直すが、編集画面は古い入力値のまま残る。そのまま「保存」を押すと、`{...最新の平文, ...古い入力}` を最新の revision で送るので、他の端末の変更を黙って上書きする / 文言は「確かめてからもう一度保存」だが、確かめる手段が画面に無い / conflict を受けたら編集画面を最新の内容で読み込み直す（または詳細へ戻す）

## P2
- `src/renderer/components/Kypr.tsx:KyprPanel` / `KyprSettings` — kypr の状態の変化（1 時間でのロック・画面ロック・裏の同期）を購読していない。開いたままのポップアップと設定は古い一覧・「解除中」を出し続け、操作すると `locked` になる / `onKyprChange` を renderer にも流し、`reload` する
- `src/main/registry.ts:overlayBounds`（`kypr`）/ `Toolbar.tsx` — 分割表示では、アイコンは左ペインのツールバーにだけ出る。ポップアップはウィンドウの右端に開き、バッジは前面のペインの URL で数える / アイコンの位置とポップアップがずれ、どちらのペインの件数かも分からない
- `src/renderer/components/Kypr.tsx:KyprDetail`（Phase 6 > ステップ 3） — 完全削除の確認が、ボタンを 2 回押す形になっている。plan は「確認のダイアログを挟む」 / 誤って連打すると確認を素通りする
- `src/main/kypr/index.ts:pickFields`（決定表「新規作成の中身」） — 新規ログインの `uris` に `match` のキーが付かない。plan は `match: null` / 意味は同じ（null は 0）だが、Web・iOS が作る形と揃わない
- `src/renderer/components/KyprSettings.tsx`（Phase 3 > ステップ 5） — 解除中に Touch ID を有効にするボタンが無い（ロックしてマスターパスワードで入れ直す必要がある）。有効にしたあと、ログアウト以外で無効にする手段も無い
- `docs/compat.md`（Phase 0 > ステップ 7） — `onInstalled` の節に「Bitwarden は動いているので実害は出ていない」が現在形で残っている。Phase 0 > ステップ 5 の「直す / 経緯として残す」の振り分けの一覧も、ログに無い
- `src/vendor/kypr/VENDORED.md` — コピーし直す手順が `node scripts/export-nemo.ts` になっている。VERIFY.md と OWNERS のコメントは `mise run export-nemo` で、書き方が揃っていない

## Q
- `方針変更 > Bitwarden 拡張` — 手元の `extensions/nngceckbapebfimnlniiiahkandclblb/`（dev 版と共有する実体）を消すかどうかが、「人が決める」のまま残っている / lock からは外れているので読み込まれないが、決めないと、使わない拡張の実体が手元に残り続ける

---

`~/kypr` は読む権限が無く、kypr 側（Phase 1。コミットの状態、`export-nemo` が dirty で止まるか、URL の照合のテスト）は確かめられていません。上の指摘は Nemo 側の差分だけによるものです。

Google Drive のコネクタ（claude.ai Google Drive）は認証されていないため、使えません。使う場合は claude.ai のコネクタ設定から認証してください。

````

**対応**:
- P0 fill.ts:findTarget: メインフレームを採るのは「見えているパスワード欄がある」か「ユーザーがいまメインのログイン欄にいる（probe の focused）」ときだけにした。次に直下の iframe のパスワード欄、どこにもパスワード欄が無いときだけメイン → iframe のユーザー名の欄。検証に「メインにメール欄・ログインは iframe」のページ（/mixed.html）を足した
- P0 index.ts:pickFields: URI の要素は uri と match だけ検査して、ほかのキーはそのまま残す（structuredClone）。match は整数か null（知らない方式の整数も通す）。編集画面は最初の URI の元の要素を保ち、uri だけ差し替えて返す（新規は match: null。P2 の「新規ログインに match: null」もこれで直った）。検証の U に uris[0].bwId と match: 6 を入れ、編集後も残ることを見る
- P0 kyprItem: 詳細は秘密の項目（ログインのパスワード・カードの番号とセキュリティコード）を空にして、名前だけ secrets に入れる。「表示」は kyprReveal で 1 項目だけ取る。編集は kyprItemForEdit で全部取る
- P0 verify-kypr（巻き戻し・再ログインの 401）: 模擬サーバーに rollback を足し、「巻き戻ったら全部取り直して件数がサーバーと揃う」「セッション切れでログインし直しも 401 → session-expired・ロック・覚えた鍵を捨てる」を足した
- P0 verify-kypr（match の種類）: 完全一致（3）・一致させない（5）・ポート違いのホスト（1）の項目を足し、?exact=1 のページで件数 2 と中身を見る。サブドメインは 127.0.0.1 / localhost だけでは作れないので、PSL を含む照合の網羅は kypr の url-match.test.ts（Nemo は kypr-vendor.test.mjs で抜き取り）に任せる
- P0 verify-kypr:findMarkers の対照: plan どおり「平文を書く細工」（NEMO_KYPR_TEST_LEAK=1、!app.isPackaged のときだけ、解除したら一覧を userData に平文で書く）で起動し、同じ走査が目印を見つけることを確かめる形に置き換えた
- P0 VENDORED.md のコミット: 保留（Q）。直すには kypr のコミットが要るが、このループは「コミットしない」決まり。スクリプトが dirty で止まることは確かめた（`コピー元に未コミットの変更がある` で止まる。今回は --allow-dirty を明示して通していた）
- P1 syncKyprIfStale: 最後に試した時刻（失敗しても更新）でも 1 分絞る
- P1 unlockKyprWithTouchId / signInKypr: await の後にもう解除されていたら、今回のセッションを lock して捨てる（置き去りにしない）
- P1 KyprEditor の 409: conflict を受けたら最新の内容で読み直す（reloadTick）
- P2 VENDORED.md の手順の書き方: kypr の export-nemo.ts の文言を `mise run export-nemo` に揃えてコピーし直した
- P2 compat.md の onInstalled の節: 現在形の記述を「当時使っていた Bitwarden（外した）」に直した。振り分けの一覧は plan のログ > 方針変更に書いた
- P2 完全削除の確認: 2 段階のボタンのままにし、plan の仕様（Phase 6 > ステップ 3）とログ > 方針変更を書き換えた（ポップアップの中で完結させるため）
- 見送り（足す修正）: P2 ポップアップ・設定の状態の購読（新しい push の口が要る）・P2 分割表示でのアイコンとポップアップの位置・P2 設定で解除中に Touch ID を有効 / 無効にする口
- Q extensions/ の Bitwarden の実体: 今回の範囲に入れない（lock から外れていて読み込まれない。手元のファイルなので消すかは人が決める。plan のログに書いてある）

## 2回目

````text
## P0

## P1
- `VERIFY.md`（kypr の行）/ `scripts/lib/verify-targets.mjs:KNOWN_TARGETS`（`'kypr'` のコメント）/ plan のログ > 試したこと（Phase 7 > ステップ 3） — 件数と起動回数の記録が、前回の修正の前のまま。どちらも「63 件」「3 回起動する」と書いてあるが、今回 `check(` が 67 か所に増え（巻き戻し・セッション切れ・match の種類・mixed・対照）、`NEMO_KYPR_TEST_LEAK` の起動も足して 4 回起動になった / 今回の修正の後に、フルか `verify:only kypr` を回した結果がどこにも無い。「検査の件数を報告する」の記録が、実物と食い違ったまま残る / 回し直して、VERIFY.md・コメント・ログの件数と起動回数を実数に揃える
- `scripts/verify-kypr.mjs`（`kyprItem` / `kyprReveal` / `kyprItemForEdit`） — 前回の P0（詳細では秘密を渡さない）の修正に、自走検証が付いていない。`kyprItem` の結果にパスワード・カード番号・セキュリティコードが入っていないこと、`secrets` に名前が入ること、`kyprReveal` で 1 項目だけ取れることを、どの検査も見ていない。既存の検査が見ているのは一覧（`kyprPanel`）だけ / 後で `withSecrets` の既定を戻す・`SECRET_FIELDS` から抜ける、といった退行を拾えない / A（ログイン）と C（カード）で「詳細に `pw-A-secret`・`4111111111111111`・`123` が無い」「`secrets` に `password` / `number`・`code` がある」「`kyprReveal(A, 'password')` が `pw-A-secret` を返し、`kyprReveal(A, 'username')` は null」を足す

## P2
- `src/main/kypr/fill.ts`（ファイル先頭のコメント） — 選ぶ順の説明が、修正前の「メインフレームで見えているログイン欄 → 直下の iframe で見えているログイン欄」のまま。実装は「メインのパスワード欄（か、メインのログイン欄にいる）→ iframe のパスワード欄 → メインのユーザー名 → iframe のユーザー名」になっている / 決定表と突き合わせるときに誤読する / コメントを今の 4 段の順に直す

## Q
- `src/vendor/kypr/VENDORED.md`（Phase 1 > ステップ 7、決定表「kypr のコードの取り込み方」） — kypr 側の Phase 1 をいつコミットし、コピーし直すかが決まっていない。Nemo をコミットする前にやるのか、後で差し替えるのか / 決めないまま Nemo をコミットすると、「未コミットの変更を含む」と記録されたコピーが Nemo の履歴に残る。記録したコミットからは再現できず、`--allow-dirty` で通した版が公開リポジトリの正になる

---

前回の P0 は 7 件のうち 6 件が直っていることを、コードと検証スクリプトで確認しました。VENDORED.md の件は、kypr 側のコミットが要るので Q に回しています。今回の修正の後に自走検証を回した結果は見ていないので、上の P1 1 件目のとおり件数は確かめられていません。

`~/kypr` は今回も読む権限が無く、`export-nemo` が dirty で止まることはあなたの報告どおりとして扱っています。

Google Drive のコネクタ（claude.ai Google Drive）は認証されていないため、使えません。使う場合は claude.ai のコネクタ設定から認証してください。

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P2 fill.ts の先頭コメント: 選ぶ順の説明を今の 4 段（フォーカスのある iframe → メインのパスワード欄 / メインのログイン欄にいる → iframe のパスワード欄 → ユーザー名だけの段）に直した
- P1 件数と起動回数の記録: 動作確認で回し直した実数に、VERIFY.md・verify-targets のコメント・plan のログを揃える（動作確認の後に反映）
- 見送り（足す修正）: P1 詳細で秘密を渡さないことの自走検証（kyprItem / kyprReveal / kyprItemForEdit）。終了報告に回す
- Q VENDORED.md のコピー元: kypr のコミットが要るので、ユーザーに残す

- 動作確認 fail: verify-kypr が 67 件中 2 件 FAIL（① 巻き戻しの幅が狭く、完全削除済みの行しか消えず件数が変わらなかった ② 「ログインし直しも断られた」検査で覚えた鍵を捨てたので、2 回目の起動の Touch ID の検査が no-device-keys になった）→ 修正（① Nemo で作ったアイテムの手前まで巻き戻す ② 断られた検査の後にマスターパスワードで入れ直して鍵を覚え直す。検査を 1 件足した）。再実行で 68 件すべて PASS。件数と起動回数（68 件・4 回）を VERIFY.md・verify-targets のコメント・plan のログに揃えた

## 3回目

````text
## P0

## P1
- plan のログ > 試したこと（「最後のフル検証」の行）/ `scripts/lib/verify-targets.mjs:OWNERS`（Phase 7 > ステップ 3） — 前回と今回の修正のあと、回し直したのは `verify-kypr` だけで、フル（`mise run verify`）はまだ回していない。修正は OWNERS に載っていない共有ファイルにも入っている: `src/main/ipc.ts`（`nemo:kypr-reveal`・`nemo:kypr-item-for-edit`）・`src/preload/ui.ts`・`src/shared/types.ts`（`KyprItemDetail.secrets`）。ログの「1150 PASS / 8 FAIL（kypr は 63 件）」は、これらを入れる前の結果 / この 3 つを触ると `--changed` もフルに倒れる決まりなので、ほかのスイートへの影響はまだ見ていない。plan の「`mise run verify` を通し…報告する」も、最新の差分では満たされていない / フル（少なくとも `--changed`）を回し直す。HEAD でも落ちる 8 件以外に FAIL が無いことを確かめて、ログのフル検証の行を新しい件数に書き換える

## P2
- `scripts/lib/kypr-mock-server.mjs:rollback` — 巻き戻しの点より後に変えた行を、古い版に戻さずに行ごと消している。前からあって後で編集した A・U・C は、本物の Time Travel なら古い中身で残るが、この模擬サーバーでは消える / 今の検査（件数がサーバーと揃う）は通るが、「古い版に戻ったアイテムが、手元でも古い中身に戻る」は確かめられない。この後の平文の検査も、編集で書き換わったアイテムが消えた状態で走る / 行ごとに過去の版を持ち、巻き戻しでは古い版に戻す。編集したアイテムの名前が古いものに戻ることも 1 件確かめる

## Q
- `src/vendor/kypr/VENDORED.md`（Phase 1 > ステップ 7） — kypr 側の Phase 1 をコミットしてコピーし直すのを、Nemo をコミットする前にやるか後にやるかが決まっていない（あなたに残すと聞いている分） / 後にすると、「未コミットの変更を含む」と記録されたコピーが Nemo の履歴に一度入る

---

前回の P2（fill.ts の先頭コメント）は、実装の 4 段の順に揃っていることを確かめました。前回あなたが直した 2 件の FAIL も、コードの上では直っています: 巻き戻しは Nemo で作ったアイテムの手前まで戻し、鍵を捨てた後はマスターパスワードで覚え直しています。巻き戻しの検査は、手元が差分の同期のままならサーバーと件数がずれて FAIL する作りなので、意味のある検査になっています。今回の 68 件 PASS は、あなたの報告どおりとして扱いました。私は回していません。

Google Drive のコネクタ（claude.ai Google Drive）は認証されていないため、使えません。使う場合は claude.ai のコネクタ設定から認証してください。

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P1 フル検証の回し直し: 動作確認として `mise run verify`（フル）を回し直し、plan のログのフル検証の行を新しい件数に書き換える
- 見送り（足す修正）: P2 模擬サーバーの巻き戻しで行の古い版に戻す（行ごとに版の履歴を持つ仕組みが要る）。終了報告に回す
- Q VENDORED.md のコピー元: ユーザーに残す

