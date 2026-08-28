review session: 995aa4df-1f07-46ba-aafd-db4de7c47bd9

## 1回目

````text
計画と実際のコードを突き合わせました（`store/http-auth.ts`、`shared/http-auth-rules.js`、`store/slots.ts`、`store/secret-backend.ts`、`renderer/components/Slots.tsx`、`scripts/verify-slots.mjs`、`scripts/lib/verify-targets.mjs`）。

## P0
- `Phase 1 > 1` — `auth-vault-crypto.js` は「renderer から import しない」と決めているのに、同じファイルに `MIN_PASSPHRASE` / `validatePassphrase` を置いて「UI と main の両方が同じ値を使う」と書いている。両立しない（`node:crypto` が web バンドルに入る） / この矛盾は Phase 1 の最初のファイルなので、気づくのが Phase 6 だと定数の二重定義かモジュール分割のやり直しになる。renderer は現に `shared/http-auth-rules.js` を import している（`Settings.tsx:2` / `PromptDialog.tsx:2`）ので、node 組み込み無しの側に置けば共有できる / `src/shared/auth-vault-schema.js`（`slots-schema.js` と同じ位置づけ）に `AUTH_VAULT_VERSION` / `MIN_PASSPHRASE` / `validatePassphrase` / `normalizeVaultFile` を出し、`auth-vault-crypto.js` は暗号だけに閉じる。テストも 2 本に分ける
- `Phase 2 > 1` — 保存側の「消えるもの」を `diffAuthRules(local, vault).missing` と書いているが向きが逆 / `missing` の定義が「第 2 引数に無い第 1 引数のもの」なので、この呼び方だと「保管庫に無い＝これから**追加される**件」を「消えます」として実名で出すことになる。Phase 2 > 2 のテストも同じ向きで書くと誤りが固定される / 消えるものは `diffAuthRules(vault, localEnabled).missing`。これは読み込み側の「この Mac に無いもの」と**同じ呼び出し**で、「判定は 1 本」がそのまま成立する。引数名を `diffAuthRules(from, to)` にして両方の呼び出し式を計画に書く
- `Phase 4 > 1` / `Phase 6 > 1` — カードの状態に `locked`（パスフレーズ依存）を混ぜている / (a) 設定パネルを開くたびに scrypt を回すことになる、(b) パスフレーズを記憶していない Mac では常に `locked` に落ち、「`locked` のときは保存を無効化」の規則で**保存の入口が永久に塞がる**。「覚える」を OFF にした人と、読み込み直後の新しい Mac がまさにこれに当たる / `vaultStatus()` は封筒だけで決まる `empty` / `ok` / `unreadable` の 3 状態にし（平文メタはここで返せる）、`locked` は `preview-save` / `preview-load` の戻り値にする。保存のブロックは preview の結果で行う
- `会話で決めたこと > パスフレーズ欄` / `Phase 5 > 1` — 「欄を書き換えればパスフレーズ変更」としているが、保存は先に**古いパスフレーズで保管庫を復号して「消えます」の差分を出す**必要がある / 単一の欄・単一の値だと、新パスフレーズを入れた時点で preview が `bad-passphrase` になり保存が止まる。専用の変更導線を作らないと決めた結果、変更手段が「削除して作り直す」しか無くなり、決定同士が食い違う / 保存ダイアログを「現行パスフレーズ（preview 用・記憶があれば自動）」＋「変更する場合の新パスフレーズ（2 回入力）」の 2 値にする。範囲に入れないなら Q の判断を先にする

## P1
- `Phase 2 > 1` — `localEnabled` を `same` にしか持たせていない / ローカルで無効なルールの内容が保管庫と違う場合は `differing` に入る。`importHttpAuthRules` は `enabled: true` 固定で `disabledReason` も落とす（`store/http-auth.ts:285`）ので、チェックすると**意図して外したルールが有効に戻る**。差分表示にも無効である旨が出ないので、決定事項「黙って復活しない」が `same` でしか守られていない / `differing` にも `localEnabled` / `localDisabledReason` を持たせ、UI に「この Mac では無効です（読み込むと有効に戻ります）」を添える
- `Phase 3 > 2` — `importHttpAuthRules` が `updatedAt: Date.now()` を入れる、としている / `ImportEntry` に `updatedAt` が無いため、読み込んだルールの更新時刻が「読み込んだ時刻」に化け、保管庫が運んできた編集時刻が消える。3 台目や 2 巡目で「保管庫の方が新しい」が嘘をつく / `ImportEntry` に `updatedAt?: number` を足して保管庫の値を引き継ぐ（無ければ `Date.now()`）。「`ImportEntry` を広げない」は `enabled` についての判断であって `updatedAt` には及ばない
- `Phase 1 > 1` — scrypt `N = 2 ** 17` / `128 * N * r` ≒ 134MB、1 回あたり数百 ms〜1s かかる。preview と実行で 2 回、読み込みでさらに 2 回派生するので、ダイアログの往復ごとに待たされる（自走検証も同じだけ伸びる） / `N` を `2 ** 15`〜`2 ** 16` に落とし、かつ**1 フローで 1 回しか派生しない**形にする（preview で導出した**鍵**を preview〜実行の間だけ main に持つ。平文パスフレーズを持たない方針とは両立する）。`maxmem` は選んだ `N` に合わせて明示
- `Phase 5 > 1` — 選択を `pattern` の配列で受けて実行する、で止まっている / preview と実行の間に保管庫（別の Mac）や手元のルールが変わりうる。再分類しないと、preview で見ていない中身がそのまま入る。`id` の解決規則（同じ pattern の既存ルール ID を使う／無ければ null）も未記載 / 実行時に保管庫を読み直して選択された pattern を再分類し、`missing` / `differing` に残っているものだけ entries に組む。消えていたものは結果に「保管庫が更新されていたため N 件を取り込みませんでした」と出す
- `Phase 4 > 1` — `writeVault` が tmp + rename だけ / `saveSlot` は rename の直前に `fs.existsSync` で他の Mac の上書きを防いでいる（`slots.ts:268`）が、保管庫は上書き前提なのでこの守りが無い。preview を出している間に別の Mac が保存した内容を無言で潰す（undo 無し） / preview 時に読んだファイルの mtime + サイズ（かハッシュ）を返し、書き込み直前に一致を確かめる。違えば「保管庫が更新されています」でやり直させる
- `Phase 1 > 1` / `Phase 5 > 1` — `normalizeVaultFile` が封筒（version / meta / kdf / iv / ciphertext / tag）しか検査しない / 復号後の payload の各ルールを検査しないと、`commitRules` 内の `normalizeRules` が `validateHttpAuthPattern` 不通過・長さ超過・200 件超を**黙って落とす**（`http-auth-rules.js:373`）。UI の「N 件取り込みました」と実際の件数が食い違う / `normalizeVaultPayload` を `auth-vault-schema.js` に置いて落とした件数を返し、取り込み結果の件数は commit 後に数え直して出す
- `Phase 7 > 1` — `NEMO_SLOTS_DIR` しか書いていない / パスフレーズの記憶は `userData/auth-vault-key.json` なので、「別の Mac」を模すには **`NEMO_USER_DATA_DIR` を分けたうえで `NEMO_SLOTS_DIR` を共有する**のが肝。片方だけだと同じプロファイルを使い回して「記憶が引き継がれてしまう」経路をそのまま PASS させる / `scripts/verify-slots.mjs:64` が既に両方を渡しているので同じ形にし、「2 つ目のプロファイルではパスフレーズを覚えていないこと」も検査に足す

## P2
- `設計上の判断 > パスワードを renderer に渡さない` — 「renderer には boolean と pattern のリストだけ返す」と書いているが、画面の形ではユーザー名（`admin → admin2`）を出している / 返す形に `localUsername` / `vaultUsername` を含めると明記して、実装時に迷わないようにする
- `会話で決めたこと > 復号できないルール` / `> 復号できない状態での保存` — 前者は「除外して続行」、後者は「止める」。表で隣り合っているので矛盾に見える / 「この Mac に読めないルールがある」と「保管庫が読めない（`locked`）」で語を分ける
- `Phase 5 > 1` — `importHttpAuthRules` は取り込んだルールを配列の**末尾**に置く（`store/http-auth.ts:307`）。`rankRules` の同点は登録順なので、同じ長さのパターンが複数あると読み込みで優先順が変わりうる / 実害は小さいので塞がなくてよいが、「既知の穴」に 1 行足しておく
- `Phase 6 > 1` — カードの「削除」で `userData/auth-vault-key.json` の記憶まで消すかが未記載 / 消さないと、次に別のパスフレーズで作り直したときに古い記憶が初期値として出る。削除時に `forgetPassphrase()` も呼ぶ、と書く

## Q
- `会話で決めたこと > パスフレーズ欄` — パスフレーズの**変更**を今回の範囲に入れるか。入れるなら保存ダイアログは 2 値（現行 + 新規 2 回）、入れないなら「変更するには保管庫を削除して作り直してください」を画面に出す / 決まらないと Phase 5 の IPC 引数と Phase 6 のダイアログの形が決まらず、後から足すと両方に手が入る
- `会話で決めたこと > 保存の対象` — 保管庫に入れるのは「有効なルールだけ」で確定か。保存は全件置き換えなので、Mac A で一時的に無効にしたルールは、Mac B が保存し直した時点で**保管庫から消える**（A が読み込んでも戻らない）。無効なルールも `enabled: false` 付きで運ぶ選択肢がある / 決まらないと「消えます」警告の対象範囲と、差分の `same`（無効）の意味づけが揺れる

````

**対応**: P0 のうち 3 件を反映 —— (1) `auth-vault-schema.js`（node 非依存・renderer も読む）と `auth-vault-crypto.js`（暗号だけ）に 2 分割し、テストも 2 本に。(2) 差分の呼び出し向きを `diffAuthRules(from, to)` に統一し、保存の「消えるもの」＝ `diffAuthRules(vault, localEnabled).missing` を明記（元の記述は向きが逆で「追加されるもの」を「消えます」と出していた）。(3) `vaultStatus()` を封筒だけの 3 状態にし、`locked` は preview の戻り値へ移動（カードで判定するとパスフレーズ未記憶の Mac で保存が永久に塞がる）。P1 は 5 件反映 —— `differing` にも `toEnabled` を持たせ UI に無効の旨を出す / `ImportEntry` に `updatedAt` を足して引き継ぐ / scrypt を `N = 2 ** 16` に / 実行時に読み直して再分類し件数は commit 後に数え直す / 検証は `NEMO_USER_DATA_DIR` も分ける。P2 は 2 件とも反映（返す形にユーザー名を含めると明記、「読めないルール」と「読めない保管庫」で語を分離）。

見送り: P1 `Phase 4 > 1`（`writeVault` の上書き競合検出）—— 仕組みの追加なのでループ中は入れず終了報告に回す。

保留: P0 `会話で決めたこと > パスフレーズ欄` / `Phase 5 > 1`（単一のパスフレーズ欄では変更が成立しない）—— Q「パスフレーズの変更を今回の範囲に入れるか」待ち。

## 2回目

````text
再読して差分を確認しました。反映は概ね正確です（`diffAuthRules(from, to)` の向き固定、3 状態の `vaultStatus()`、2 ファイル分割、`ImportEntry.updatedAt`、検証の 2 プロファイル化）。一方で、**修正が `実装計画` にだけ入り `設計上の判断` が古いまま**の箇所と、修正の結果あらためて成立しなくなった箇所があります。

## P0
- `Phase 6 > 1`（`画面の形` の読み込み／保存ダイアログ） — `locked` を preview へ移した結果、**preview はパスフレーズを受け取るまで走らない**のに、両ダイアログは「開いた瞬間に 3 グループ／消える N 件が出ている」形のまま（モック図も 1 画面） / パスフレーズを記憶していない Mac＝**新しい Mac という本命の用途**では、開いた直後に出せる情報が何も無い。1 画面前提で組んでから気づくと、ダイアログの状態機械・`data-testid`・Phase 7 の CDP 手順まで作り直しになる / 両ダイアログを「パスフレーズ入力 →（preview）→ 内容表示」の 2 段にし、記憶があるときだけ 1 段目を自動で通過する、と明記する。モック図も 2 段に直し、`data-testid` を段ごとに用意する

## P1
- `設計上の判断` — 3 か所が Phase 1 / 2 の修正前のまま残っている。① scrypt が `N = 2^17`（Phase 1 は `N = 2 ** 16`）、② 「これらは renderer から import しない」が `auth-vault-schema.js`（node 非依存・renderer も読む）と矛盾、③ 「同じ差分関数を**向きを変えて**呼ぶ」が Phase 2 の「両方 `diffAuthRules(vault, …)` で向きは同じ・第 2 引数だけ違う」と食い違う / 総論と各論で数値と規則が割れており、③ は前回の向き取り違えを生んだ表現そのもの。総論を先に読んだ実装が 2^17 を書き、向きを逆に取る / 3 行を Phase 1 / 2 の記述に合わせて書き換える（③ は「**同じ向きで、第 2 引数だけ `local` / `localEnabled` に変えて呼ぶ**」）
- `Phase 3 > 4` / `Phase 1 > 1` — `updatedAt` が**保管庫の payload に載る**とはどこにも書いていない。`readAllCredentials()` の戻り `rules` に含めること、`normalizeVaultPayload` が `updatedAt` を検査（正の整数以外は落とす）することも未記載 / payload に載らなければ `newer` は永久に `null` で、Phase 3 の `StoredRule` / `ImportEntry` への追加が丸ごと無駄になる。気づくのは Phase 5 以降 / payload の形を Phase 1 に `{ pattern, username, password, updatedAt? }` と明記し、`normalizeVaultPayload` の検査項目と `readAllCredentials()` の戻り値に加える
- `Phase 5 > 1`（`preview-load` / `preview-save`） — `decryptVault` は `bad-passphrase` / `tampered` / `malformed` を区別して返すのに、preview はすべて `locked` に畳んでおり、`Phase 6 > 1` は `locked` に対して「復号できません」＋**削除の導線**を出す / パスフレーズの打ち間違いに対して「保管庫を削除して作り直す」を提示することになる。undo が無い機能で、最も起きやすい操作ミスに最も戻れない選択肢を出す / preview は `bad-passphrase`（「パスフレーズが違います」＋やり直しのみ）と `tampered` / `malformed`（「保管庫が壊れています」＋削除の導線）を分けて返す。`locked` の語は前者に限る
- `Phase 7 > 2` — 登録先に `NEEDS_APP` を挙げている / このスイートは自分で 2 プロファイルを起動する。同じく自分で起動する `slots` は `NEEDS_APP` に入っていない（`scripts/lib/verify-targets.mjs:47-59`）。入れると `needsApp = NEEDS_APP.some(want)`（`scripts/verify-all.mjs:126`）で共有のアプリとページサーバまで立ち上がり、使わない起動が 1 つ増える / 登録先は `KNOWN_TARGETS` / `OWNERS` / `OPT_IN_ONLY` の 3 つ。`NEEDS_APP` には入れない、と書く
- `Phase 7 > 2` — `OWNERS` の**既存エントリの更新**が抜けている。Phase 3 が触る `src/shared/http-auth-rules.js` と `src/main/store/http-auth.ts` は現在 `['http-auth']` 単独（`verify-targets.mjs:142-143`） / `updatedAt` / `readAllCredentials` を足したあと、その 2 ファイルを直しても `--changed` で `auth-vault` が回らない。腐っても症状は「速く PASS する」ので気づけない / 両エントリを `['http-auth', 'auth-vault']` に広げ、新規ファイル（`auth-vault-schema.js` / `auth-vault-crypto.js` / `auth-vault-diff.js` / `store/auth-vault.ts` / `AuthVault.tsx` / `scripts/verify-auth-vault.mjs` / 新しい 3 本の `*.test.mjs`）も登録する

## P2
- `会話で決めたこと > 無効ルールとの突き合わせ` — 「無効ルールは『既にある』扱い」と書いてあるが、Phase 2 では無効かつ内容が違うルールは `differing` に入る（`toEnabled: false` 付き） / 表の行を「差分判定には無効ルールも含め、`same` / `differing` のどちらでも『この Mac では無効』と添える」に直す
- `既知の穴` — 「保存は有効なルールだけ・全件置き換え」の帰結が記録されていない。Mac A で一時的に無効にしたルールは、Mac B が保存し直した時点で保管庫から消え、A が読み込んでも戻らない / 1 行足しておく（塞がなくてよいが、後から「消えた」と言われたときに辿れる）
- `Phase 5 > 1` — `nemo:auth-vault-delete` のときに `forgetPassphrase()` も呼ぶかが未記載のまま / 消さないと、別のパスフレーズで作り直したときに古い記憶が初期値として出る
- `Phase 7 > 1` — `updatedAt` の引き継ぎ（`Phase 3 > 3`）を見る検査が無い / 「保存 → 別プロファイルで読み込み → 再保存で更新時刻が保管庫の値のまま」を 1 件足すと、`Date.now()` への化けを固定できる

## Q
- `会話で決めたこと > パスフレーズ欄` / `Phase 5 > 1` — 前回から保留中。パスフレーズの**変更**を今回の範囲に入れるか（preview は古いパスフレーズ、書き込みは新しいパスフレーズが要るので、欄 1 つでは成立しない） / 決まらないと Phase 5 の引数と Phase 6 の保存ダイアログの形が決まらない。上の P0（ダイアログの 2 段化）と同じ箇所に手が入るので、**2 段化に着手する前に決める**のが安い

````

**対応**: P0 1 件を反映 —— 保存・読み込みのダイアログを「パスフレーズ →（preview）→ 内容」の 2 段にし、モック図も 2 段に直した（記憶があるときだけ 1 段目を自動通過。`data-testid` も段ごと）。P1 は 5 件すべて反映 —— `設計上の判断` の 3 か所を Phase 1 / 2 に合わせて更新（scrypt `N = 2 ** 16`、crypto を引くのは `auth-vault-crypto.js` だけ、差分は「同じ向きで第 2 引数だけ変える」）/ payload の 1 件の形と `updatedAt` を Phase 1 に明記し `readAllCredentials()` の戻り値にも追加 / preview は `bad-passphrase` と `tampered` / `malformed` を分けて返し、打ち間違いに削除の導線を出さない / `NEEDS_APP` には入れない（自分で起動するスイート）/ `OWNERS` の既存 2 エントリ（`http-auth-rules.js` / `store/http-auth.ts`）を `auth-vault` にも広げる。P2 は 3 件反映（決定表の「無効ルール」の文言、既知の穴に「別 Mac の保存で無効ルールが消える」を 1 行、delete 時にパスフレーズの記憶も忘れる）。

見送り: P2 `Phase 7 > 1`（`updatedAt` の引き継ぎを見る検査を 1 件足す）—— 検査項目の追加なのでループ中は入れず終了報告に回す。

保留: P0 相当の Q「パスフレーズの変更を今回の範囲に入れるか」は 2 回目も未決のまま（2 段化の骨格は Q に依存しないので先に入れた。欄が 1 つか 2 つかだけが Q 待ち）。

## 3回目

````text
再読しました。前回の指摘は 6 件すべて反映されています（2 段ダイアログとモック図、`設計上の判断` の 3 か所、payload の形と `updatedAt`、preview の失敗理由の分離、`NEEDS_APP` 除外と `OWNERS` の拡張）。残りは、2 段化で新たに整合が崩れた箇所と、`slots.ts` から引き継げていない前例が中心です。

## P0

## P1
- `Phase 4 > 1`（`readVaultFile()`） — 「壊れていたら `.broken-<時刻>` に退避」しか書いておらず、**未来の版**の扱いが無い。`readVersioned` は「未来の版」も「version が壊れている」も同じく `null` を返すので、見分けないと未来の版まで退避される（`slots.ts` は `slots.ts:203-220` で自分で見分け、**未来の版は退避しない**と明記している） / 保管庫は**1 ファイルを全ての Mac が共有する**。片方の Mac を先に更新すると、古い方の Nemo が設定画面を開いた瞬間にリネームして退避し、**新しい方からも保管庫が消える**（`.broken-<時刻>` を手で戻すしかなく、undo も無い）。スロットは枠 1 つの被害で済むが、ここは全件 / `readVaultFile()` に「未来の版は退避せず `unreadable` +『新しい版の Nemo で保存されています』」を明記する。`Phase 1 > 3` のテストは「未来の版が弾かれる」だけなので、**退避されない**ことを Phase 1 か Phase 7 のどちらかで固定する
- `画面の形` / `Phase 6 > 1` — カードは `ok` と `empty` しか描いていない。`unreadable` のカードと、`Phase 4 > 1` で検出すると決めた**競合コピー（`basic-auth 2.json`）の注記**の置き場所が無い / `設計上の判断` で「`unreadable` を `empty` に倒さない」と決めた以上、この状態の見た目は必ず必要になる。`Slots.tsx` には `slot-reason-*` / `slot-retry-*` / `slot-conflict` の実装が既にあるので、無ければ実装時に発明することになり、作法が揃わない / `unreadable` のカード（理由 + 再試行 + 削除、保存は出さない）と競合コピーの 1 行を `画面の形` に足し、`nemo:auth-vault-status` の戻り値に競合コピーの有無を含める
- `会話で決めたこと > パスフレーズ欄` — 「**常に出す**（覚えていれば初期値が入っている）」が、`Phase 6 > 1` の「記憶があるときだけ 1 段目を**自動で通過する**」と矛盾する（自動通過するなら欄は出ない） / 決定表と実装計画で欄の有無が逆。しかも `Phase 5 > 1` は「覚えている場合は renderer が `null` を渡す」なので、そもそも**実際の値を初期値として入れることはできない** / 決定表の行を 2 段化に合わせて書き直す（「記憶があれば 1 段目を飛ばす。欄に実際の値は入れない」）。「書き換えれば変更」の可否は Q 待ちなのでそこだけ保留と明記する
- `Phase 6 > 1` — 1 段目を自動通過したあとに preview が `bad-passphrase` を返す経路（別の Mac で保管庫を作り直した／パスフレーズを変えた）で、**1 段目に戻す**とは書かれていない / 記憶した値が古いときが該当し、実運用で最も起きやすい。戻せないと「パスフレーズが違います」と出たまま入力欄が無い行き止まりになる / 「自動通過は preview が `bad-passphrase` を返したら 1 段目を表示してやり直す」を明記し、`data-testid` もその状態に付ける

## P2
- `Phase 1 > 1` / `Phase 4 > 1` — `normalizeVaultFile(raw)` が「version を含む封筒」を受けるのか、`writeVersioned` / `readVersioned` で剥がした `data` を受けるのかが読み取れない（Phase 4 は `writeVersioned` を使うと書いている） / どちらかに決めて引数の形を 1 行で書く
- `Phase 2 > 1` — `diffAuthRules(from, to)` の引数を「双方 `{ pattern, username, password, enabled, updatedAt }`」としているが、`Phase 1 > 1` の payload に `enabled` は無い（有効なものだけ保存するため） / `enabled` / `disabledReason` は `to` 側だけが持つ、と書き添える
- `Phase 7 > 1` — 今回分けた `bad-passphrase` と `tampered` / `malformed` の区別を見る検査が無い / 「打ち間違いでは削除の導線が出ないこと」を 1 件足すと、畳み戻しの回帰を止められる

## Q
- `会話で決めたこと > パスフレーズ欄` / `Phase 5 > 1` — 3 回目の保留。パスフレーズの**変更**を今回の範囲に入れるか / 2 段化の骨格は先に入ったので残る影響は「保存ダイアログ 1 段目の欄が 1 つか 2 つか」と「2 段目に『パスフレーズを変更』の入口を置くか」だけ。ただし上の P1（決定表の書き直し）の文面がこの答えに依存するので、**Phase 6 に着手する前**には要る

````

**対応**: P0 が空になり収束。収束回に反映した P1/P2 —— (P1) `readVaultFile()` に「未来の版は退避しない」を明記（保管庫は全 Mac が 1 ファイルを共有するので、古い Nemo が設定を開いた瞬間に全件退避してしまう）/ 決定表の「パスフレーズ欄」を 2 段化に合わせて書き直し（記憶があれば 1 段目を飛ばす・欄に実際の値は入れない・変更の可否は Q 待ち）/ 自動通過後に `bad-passphrase` が返ったら 1 段目に戻す（行き止まりの回避）。(P2) `normalizeVaultFile` は `readVersioned` が剥がした `data` を受けると明記 / `diffAuthRules` の引数から `enabled` を外し「`to` 側だけが持つ」と書き添え。

見送り: P1 `画面の形` / `Phase 6 > 1`（`unreadable` のカードと競合コピーの注記を画面の形に足す）、P1 `Phase 1 > 3`（未来の版が退避されないことの検査）、P2 `Phase 7 > 1`（`bad-passphrase` と `tampered` の区別を見る検査）—— いずれも画面・検査項目の追加なので終了報告に回す。

保留: Q「パスフレーズの変更を今回の範囲に入れるか」は 3 回目も未決。
