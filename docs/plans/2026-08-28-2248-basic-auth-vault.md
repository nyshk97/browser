# Basic 認証の持ち出し（保管庫）

## 概要・やりたいこと

HTTP Basic 認証のルールを**別の Mac へ運べるようにする**。新しい Mac を買ったときに、
ピン留め・お気に入り（セーブスロット）に続いて認証も設定画面だけで移行が完結する状態にする。

- 設定の「ブックマークのセーブスロット」の**下に「Basic 認証」セクション**を置く
- 中身は**枠 1 つの保管庫**（カード 1 枚）。スロットのような 3 枠にはしない
- 保存先は**セーブスロットと同じ iCloud のフォルダ**（`Nemo/slots/basic-auth.json`）
- パスワードは `safeStorage`（端末鍵）のままでは運べないので、**パスフレーズで再暗号化**する
- **読み込みは差分の選択式**。「この Mac に無いもの / 内容が違うもの / 既にあるもの」の
  3 グループに分けて出し、**必要なものだけチェックして入れる**

### なぜ 3 枠のスロットにしないか

ピン留めは「メイン環境 / 実験用」と使い分けるが、**Basic 認証は使い分けるものではなく
積み上げるもの**。枠を複数にすると「どの枠が最新か」を人間が覚える羽目になり、
パスワードを変更したときに古い枠が害になる。枠が 1 つでも、今回決めた
「差分マージ + 選択取り込み」の操作は何も困らない。

### なぜ既存のカードに相乗りさせないか

`Slots.tsx` は枠の状態を `empty` / `ok` / `unreadable` の 3 つで持ち、
「空きならボタンは保存」と決めている。ここに認証を相乗りさせると
**「本体は空きだが認証だけ入っている枠」**が生まれてこの 3 状態が破れる。
さらに本体は上書き禁止・認証は上書き可なので、**1 枚のカードの中に規則の違う保存が 2 つ並ぶ**。

## 前提・わかっていること

### 会話で決めたこと

| 論点 | 決定 |
| --- | --- |
| 入れ物の形 | **枠 1 つの保管庫**。カード 1 枚。スロットの語は使わない |
| UI の位置 | **`<Slots />` の直下に新セクション**（`Settings.tsx`）。「別の Mac へ移すもの」を 1 か所に集める |
| 見出し | **「Basic 認証」** |
| ボタンの文言 | **「保存」** / **「読み込む」**（セーブスロットと同じ語彙に揃える） |
| 置き場所 | **`slotsDir()` と同じフォルダ**の `basic-auth.json`。パス解決・env の口・「保存先」表示・フォルダを開く導線を二重に持たない |
| パスワードの運び方 | **パスフレーズで再暗号化**（scrypt + AES-256-GCM） |
| 暗号の範囲 | **パターンもユーザー名も暗号の中**。平文で外に出すのは件数・保存日時・端末名・アプリ版だけ |
| パスフレーズの記憶 | **`secret-backend.ts` に相乗りしてこの Mac に覚える**（既定 ON）。保存先は `userData/` で **iCloud には置かない** |
| パスフレーズ欄 | ダイアログの 1 段目に置き、**記憶があれば 1 段目を飛ばす**。**欄に実際の値は入れない**（renderer にパスフレーズを渡さない） |
| パスフレーズの記憶の取り消し | **導線を作らない**。記憶を消したいときは保管庫ごと削除する（削除で記憶も一緒に消える）。記憶だけを消す IPC も**置かない**（呼び手が無いまま残るだけ） |
| パスフレーズの変更 | **今回の範囲に入れない**。保存の preview は古いパスフレーズ、書き込みは新しいパスフレーズが要るので欄 1 つでは成立しない。画面に「変更するには保管庫を削除して作り直してください」を出す |
| 初回の設定 | **2 回入力を求める**。`locked` からの回復が「削除して作り直し」しかないので入口で防ぐ |
| 保存の規則 | **この Mac の全件で置き換え**。確認ダイアログで「保管庫にしか無い N 件が消えます」を実名付きで出す |
| 保存の対象 | **有効なルールだけ**（`enabled === true` かつ `disabledReason` なし）。無効なものは保管庫に入れない |
| この Mac に読めないルールがある | 保存から**除外**し、「N 件を除外しました」と結果に出す。**自動無効化はしない**（後述）。保存自体は続行する |
| 読み込みの規則 | **差分の選択式**。3 グループに分け、チェックしたものだけ入れる |
| 差分の判定軸 | **`pattern` の完全一致**（`importMultipass` の既存の前例と同じ） |
| 無効ルールとの突き合わせ | **差分判定に無効ルールも含める**（「無いもの」に落とさない）。`same` / `differing` のどちらでも「この Mac では無効です」と添える。意図して外したルールが読み込みで黙って復活しない |
| 差分の表示 | ユーザー名は両方出す（`admin → admin2`）。パスワードは **「パスワードが違います」とだけ**出し、値は出さない |
| 既定のチェック | 「無いもの」は全 ON、「内容が違うもの」は全 OFF、「既にあるもの」は表示のみ |
| どちらが新しいか | **`StoredRule` に `updatedAt` を足す**。**両方に値があるときだけ**「保管庫の方が新しい（8/25 → 8/27）」を添える。片方が unknown なら何も出さない |
| 保管庫が読めない | 保存を**止める**。**カードの状態ではなく preview の結果で判定する**（後述）。パスフレーズ違い（`locked`）は**やり直しだけ**、壊れている場合だけ「削除して作り直す」を出す |
| 件数上限（200） | **今は何もしない**（既知の穴。後述） |
| dev 版 | `slotsDir()` が channel ごとに分かれているので**自動的に分かれる** |
| undo | **作らない**（セーブスロットと同じ） |

### 画面の形

```
ブックマークのセーブスロット
┌ SLOT 1 ┐ ┌ SLOT 2 ┐ ┌ SLOT 3 ┐
└────────┘ └────────┘ └────────┘

Basic 認証
┌──────────────────────────────────┐
│ 12 件                             │
│ 2026-08-25 14:32                 │
│  ・ TsubasanoMacBook-Pro      ··· │
│                                  │
│ [   保存   ]  [   読み込む   ]    │
└──────────────────────────────────┘
この Mac には 15 件あります。
```

- 「···」は hover で現れ、メニューは「**削除**」（danger 色）の 1 項目
- 空のときは破線の枠に「まだ保存されていません」、ボタンは「保存」だけ
- 保存先のパスは**セーブスロットのものを再利用**して二重に出さない

**保存・読み込みのダイアログはどちらも 2 段**。`locked` の判定を preview に移した以上、
**パスフレーズを受け取るまで中身は何も出せない**（記憶していない Mac ＝ 新しい Mac という
本命の用途では、開いた直後に出せる情報が無い）。記憶があるときだけ 1 段目を自動で通過する。

```
① 保管庫を読み込む

   パスフレーズ [••••••••]

                                    [キャンセル] [次へ]
```

```
② 保管庫を読み込む

この Mac に無いもの (2)
  ☑ ^https://stg\.a\.com/        admin
  ☑ ^https://dev\.b\.jp/         tsubasa

内容が違うもの (1)
  ☐ ^https://c\.co\.jp/          admin → admin2（ユーザー名が違います）
                                 パスワードが違います
                                 保管庫の方が新しい（8/25 → 8/27）

既にあるもの (4)
  ・ ^https://d\.example/  ほか 3 件

                                    [キャンセル] [読み込む]
```

### コードベースの現状

- **`importHttpAuthRules(entries: ImportEntry[])` が既にある**（`store/http-auth.ts:278`）。
  `ImportEntry` は `{ id, pattern, username, password（平文）, importedFrom }` で、
  **平文を受けてストアが暗号化する**。取り込みロジックは新規に書かなくてよく、
  **entries を絞り込むだけ**で選択取り込みになる
- `importMultipass` が既に `existing: { id, pattern }[]` を受け、
  **同じ `pattern` は既存 ID に紐づけ、無ければ `id: null` で新規採番**する
  （`http-auth-rules.js:465`）。**「あるもの / 無いもの」の判定軸は `pattern` 完全一致**という
  前例がリポジトリに既にある
- **取り込み後の後始末は `httpAuthCredentialsChanged(reason)` に集約済み**
  （`http-auth-reset.ts:27`）。`clearAuthCache()` と `attempts` リセットの両方を
  `finally` で必ず通す。**呼ぶだけでよい**
- `HttpAuthRule`（`types.ts:472`）は **パスワードを含まない**。
  値が要るときだけ `revealHttpAuthPassword` で 1 件取る
- **`getHttpAuthCredential` は復号失敗で `disableHttpAuthRule` を呼ぶ副作用がある**
  （`store/http-auth.ts:134`）。保存のために全件 reveal すると
  **「保存を押しただけでルールが無効化される」**が起きる
- **`importHttpAuthRules` は `enabled: true` を固定している**（`store/http-auth.ts:290`）。
  今回は「有効なものだけ保存する」ので**`enabled` については固定のままでよい**
  （`ImportEntry` に `enabled` は足さない。ただし `updatedAt` は足す。Phase 3 を見よ）
- `slotsDir()` は **`NEMO_SLOTS_DIR` → iCloud → `userData/slots/`** の順で解決し、
  `kind` を返す（`store/slots.ts:43`）。UI はこの `kind` を見て fallback の注記を出す
- **`findConflictCopies` は `^slot-(\d+) [^.]*\.json$` の厳密なパターン**（`slots.ts:93`）。
  同じフォルダに `basic-auth.json` を置いても**誤爆しない**（確認済み）
- `JsonStore` は固定パス 1 ファイル向けで、`commit()` が「保存できたか」を返す
- **`scripts/*.test.mjs` は `src/shared/*` と `scripts/*` しか import していない**。
  `electron` を読める node:test 環境が無いので、`store/*.ts` は直接テストできない
- **`src/shared/tree-hash.js` が既に `node:crypto` を import している**。
  renderer が読まないファイルなら `src/shared/` に node 組み込みを持ち込んでよい、という前例
- `HTTP_AUTH_LIMITS.MAX_RULES = 200`。`normalizeRules` は超えた分を**黙って末尾から落とす**
- 検証は `scripts/lib/verify-targets.mjs` の `KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS` への**登録**と
  `verify-all.mjs` の `if (want('...'))` の**配線**で 1 セット。
  **登録だけして配線を忘れると検査 0 件で「すべて PASS」する**（`CLAUDE.md`）
- `slots` は `OPT_IN_ONLY` に入っている（アプリを 4 回起動し直すのでフルが伸びる）

### 設計上の判断

- **パスワードを renderer に渡さない。** 復号は main で行い、renderer に返すのは
  `pattern` / 両側の**ユーザー名**（画面に `admin → admin2` と出すため）/
  「パスワードが違う」の boolean / `toEnabled` / `newer` まで。**パスワードそのものは返さない**。
  既存の `HttpAuthRule` が「パスワードは含まない」形なのと揃える。
  差分計算も main 側で完結させる
- **暗号と差分計算を `src/shared/` の純関数に切り出す。** `store/*.ts` は `electron` を引くので
  `node:test` から触れない。`tab-ownership.js` / `slots-schema.js` と同じ流儀で、
  暗号のラウンドトリップと差分の分類をテストで固定する。
  ただし **`node:crypto` を引くのは `auth-vault-crypto.js` だけ**にし、
  renderer も読む定数・検証（`auth-vault-schema.js`）とは**ファイルを分ける**
- **判定は 1 本にする。** 保存側の「消えます」警告も読み込み側の 3 グループも
  **同じ向きで（第 1 引数は常に `vault`）、第 2 引数だけ `local` / `localEnabled` に変えて呼ぶ**。
  2 か所に分けると規則が食い違う
- **`unreadable` と `locked` のどちらも `empty` に倒さない。** 空に見えるとボタンが「保存」になり、
  押した瞬間に**中身を見ないまま他の Mac のルールを潰す**。
  `slots.ts` が `unreadable` を空きに倒さないのと同じ理由。
  ただし**この 2 つは別の層で判定する** —— `unreadable` は封筒（カードの状態）、
  `locked` はパスフレーズ（preview の結果）
- **保存のための復号に副作用を持たせない。** 「保存」は読み取り操作なので、
  この Mac のルールの状態を変えてはいけない。`getHttpAuthCredential` とは別に
  **副作用の無い読み取り専用の経路**を作る
- **平文メタの写しを暗号の中に入れ、復号後に突き合わせる。** 件数・保存日時・端末名を
  暗号の外に出す以上、改竄されたときに気づけるようにする。
  **AAD にはしない** —— AAD だと改竄でも認証タグが落ちるだけで、
  「パスフレーズが違う」と**原理的に区別できない**（GCM は失敗の理由を返さない）。
  区別できないと、打ち間違いに対して「削除して作り直す」を提示することになる
- **scrypt は非同期版を使う。** `scryptSync` だと main プロセスが固まって全ウィンドウが止まる。
  `N = 2 ** 16` は既定の `maxmem`（32MB）を超えるので**明示する**
- **保管庫を `JsonStore` にしない。** `slots.ts` と同じ理由で、
  iCloud 経由で別の Mac が書き換えるものをメモリにキャッシュしない。開くたびに読み直す

### 既知の穴（今回は塞がない）

- **件数上限。** 取り込みで既存との合算が 200 件（`MAX_RULES`）を超えると、
  `normalizeRules` が末尾を黙って落とす。「取り込んだと表示されたのに存在しないルール」ができる。
  実運用では 200 件に遠いので今回は何もしない
- **初回移行では `updatedAt` が両側とも無い**ので「どちらが新しいか」は出せない。
  効いてくるのは 2 回目以降、片方で編集したルールだけ
- **パスフレーズを忘れたら回復手段は無い。** 保管庫を削除して作り直すしかない
- **一時的に無効にしたルールは、別の Mac が保存し直した時点で保管庫から消える**
  （保存は「有効なものだけ・全件置き換え」なので）。元の Mac が読み込んでも戻らない

## 実装計画

### Phase 1: スキーマと暗号（`src/shared/`） [AI🤖]

**node 組み込みを引く側と引かない側で 2 ファイルに割る。** renderer は現に
`shared/http-auth-rules.js` を import している（`Settings.tsx` / `PromptDialog.tsx`）ので、
定数と検証を crypto と同じファイルに置くと **`node:crypto` が web バンドルに入る**。

- [x] `src/shared/auth-vault-schema.js`（**node 組み込みを引かない**。renderer も読む）
  - `AUTH_VAULT_VERSION = 1`、`MIN_PASSPHRASE = 8`、`validatePassphrase(value)`
  - `normalizeVaultFile(raw)` … 封筒（meta / kdf / iv / ciphertext / tag）を検査する。
    **`version` は `readVersioned` が剥がしたあとの `data` を受ける**（version はここで見ない）
  - `normalizeVaultPayload(raw)` … **復号後の中身も検査し、落とした件数を返す**。
    これが無いと `commitRules` 内の `normalizeRules` が `validateHttpAuthPattern` 不通過・
    長さ超過・200 件超を**黙って落とし**、「N 件読み込みました」と実際の件数が食い違う
  - **payload の 1 件は `{ pattern, username, password（平文）, updatedAt? }`**。
    `updatedAt` は正の整数だけ通す。**これを載せないと `newer` が永久に `null` になり、
    Phase 3 の `StoredRule` / `ImportEntry` への追加が丸ごと無駄になる**
- [x] `src/shared/auth-vault-crypto.js`（**renderer から import しない**。暗号だけに閉じる）
  - KDF は scrypt。**`N = 2 ** 16`**（2^17 は 1 回の派生が数百 ms〜1s かかり、
    ダイアログの往復ごとに待たされる）。`maxmem` は選んだ `N` に合わせて明示する
  - `encryptVault(rules, passphrase, meta)` … salt / iv を採番し AES-256-GCM で暗号化。
    **`meta`（`count` / `savedAt` / `host` / `appVersion`）の写しを暗号の中にも入れる**
    （AAD にしない理由は「設計上の判断」を見よ）。`crypto.scrypt` の**非同期版**を使う
  - `decryptVault(file, passphrase)` … 復号して payload を返す。
    **失敗は理由を分けて返す**（`bad-passphrase` / `tampered` / `malformed`）。
    GCM の認証タグ失敗とパースの失敗を一緒くたにしない
- [x] `scripts/auth-vault-schema.test.mjs`
  - 壊れた JSON / 未来の版 / kdf が欠けたファイルが弾かれる
  - 短いパスフレーズが `validatePassphrase` で弾かれる
  - `normalizeVaultPayload` が不正なパターン・長さ超過・件数超過を落とし、**その件数を返す**
- [x] `scripts/auth-vault-crypto.test.mjs`
  - ラウンドトリップ（暗号化 → 復号で元に戻る）
  - **パスフレーズ違いで `bad-passphrase`**（`decryptVault` が成功してはいけない）
  - **改竄検知**: 暗号文はそのままに外側の `meta.count` を書き換えると `tampered` になる
    （`bad-passphrase` に落ちてはいけない）

### Phase 2: 差分の分類（`src/shared/`） [AI🤖]

- [x] `src/shared/auth-vault-diff.js` を作る
  - `diffAuthRules(from, to)` … 双方 `{ pattern, username, password, updatedAt? }` の配列を受け、
    **`pattern` の完全一致**で突き合わせて `{ missing[], differing[], same[] }` を返す。
    `enabled` / `disabledReason` は **`to` 側だけが持つ**（保管庫は有効なものしか入れないので
    `from` 側には無い）
  - `missing` … **`from` にあって `to` に無いもの**
  - `differing` … pattern は一致するが `username` か `password` が違うもの。
    `{ pattern, fromUsername, toUsername, usernameDiffers, passwordDiffers, newer }`。
    `newer` は**両方に `updatedAt` があるときだけ** `'from' | 'to'`、無ければ `null`
  - `same` … 完全に一致するもの
  - **`to` 側の無効ルールも突き合わせの対象にする**（`missing` に落とさない）。
    落とすと「意図して外したルールが読み込みで黙って復活する」。
    **`same` にも `differing` にも `toEnabled` / `toDisabledReason` を持たせる**
    （`differing` に持たせないと、無効なルールをチェックしたときに
    `importHttpAuthRules` の `enabled: true` 固定で黙って有効に戻る）
- [x] **2 つの呼び出し向きを計画で固定する**（判定を 1 本に保つ）
  - 読み込みの 3 グループ … `diffAuthRules(vault, local)`
  - 保存の「消えるもの」 … **`diffAuthRules(vault, localEnabled).missing`**
    （保管庫にあって、この Mac の有効なルールに無いもの＝置き換えで失われるもの。
    **向きを逆にすると「これから追加されるもの」を「消えます」と出す**）
- [x] `scripts/auth-vault-diff.test.mjs`
  - 3 グループの振り分け
  - **`to` 側で無効なルールが `missing` ではなく `same` / `differing` に入り、`toEnabled: false` が付く**
  - ユーザー名だけ違う / パスワードだけ違う / 両方違う
  - `updatedAt` が片方だけのとき `newer` が `null` になる
  - **保存側の「消えるもの」が上の呼び出し式で得られること**（向きの取り違えを固定する）

### Phase 3: 既存の HTTP 認証ストアへの手入れ [AI🤖]

- [x] `StoredRule` に `updatedAt?: number` を足す（`http-auth-rules.js` の typedef と `normalizeRules`）
  - `normalizeRules` は**正の整数だけ**通す。無ければフィールドごと落とす（`undefined` のまま）
  - `scripts/http-auth-rules.test.mjs` に「不正な `updatedAt` が落ちる / 既存ルールが通る」を足す
- [x] `saveHttpAuthRule` が `updatedAt: Date.now()` を入れる
  - **`setHttpAuthRuleEnabled` / `disableHttpAuthRule` では更新しない**（内容が変わっていない）
- [x] **`ImportEntry` に `updatedAt?: number` を足し、`importHttpAuthRules` が引き継ぐ**
  （無ければ `Date.now()`）
  - 引き継がないと読み込んだルールの更新時刻が**「読み込んだ時刻」に化け**、
    保管庫が運んできた編集時刻が消える。3 台目や 2 巡目で「保管庫の方が新しい」が嘘をつく
  - MultiPass 経路は `updatedAt` を持たないので今まで通り `Date.now()` になる
- [x] `store/http-auth.ts` に**副作用の無い読み取り専用の経路**を足す
  - `readAllCredentials()` … 有効（`enabled === true` かつ `disabledReason` なし）なルールを
    全件復号し、`{ rules, skipped }` を返す。**`rules` の 1 件に `updatedAt` を含める**
    （保管庫の payload に載せるため）。
    **復号に失敗しても `disableHttpAuthRule` を呼ばない**（`skipped` に積むだけ）
  - `getHttpAuthCredential` の既存の副作用は**そのまま残す**（自動入力の経路では正しい挙動）
  - 差分の突き合わせ用に `readAllForDiff()` も足す（**無効なものも含む全件**。
    落とすと保管庫の同じパターンが「この Mac に無いもの」に現れ、読み込みで黙って有効に戻る）

### Phase 4: 保管庫のストア [AI🤖]

- [x] `src/main/store/auth-vault.ts` を作る
  - `vaultPath()` … `slotsDir()` の `dir` に `basic-auth.json` を足す（**解決ロジックは再利用**）
  - `readVaultFile()` … `slots.ts` と同じ流儀で**毎回・非同期・タイムアウト付き**で読む。
    `ENOENT` だけが `empty`、それ以外は `unreadable` + 理由。壊れていたら `.broken-<時刻>` に退避
  - **未来の版は退避しない**（`unreadable` +「新しい版の Nemo で保存されています」）。
    `readVersioned` は「未来の版」も「version が壊れている」も同じく `null` を返すので、
    `slots.ts` と同じく**自分で見分ける**。保管庫は**1 ファイルを全ての Mac が共有する**ので、
    片方を先に更新すると**古い方の Nemo が設定画面を開いた瞬間に退避し、
    新しい方からも保管庫が丸ごと消える**（スロットは枠 1 つの被害で済むが、ここは全件）
  - `vaultStatus()` … **封筒だけで決まる `empty` / `ok` / `unreadable` の 3 状態**を返す。
    平文メタ（件数・保存日時・端末名）は復号せずに返せる。
    **`locked`（復号できない）をここに混ぜない** —— カードを出すたびに scrypt を回すことになり、
    さらに**パスフレーズを記憶していない Mac では常に `locked`** に落ちて
    「`locked` なら保存を無効化」の規則で**保存の入口が永久に塞がる**
    （「覚える」を OFF にした人と、読み込み直後の新しい Mac がまさにこれに当たる）。
    `locked` は preview の戻り値として返す
  - `writeVault(payload, passphrase, meta)` … tmp + rename。`{ version, data }` は
    既存の `writeVersioned` を使う
  - `deleteVault()`
  - **iCloud の競合コピー**（`basic-auth 2.json`）を `slots.ts` と同じ流儀で検出して返す。
    勝手にリネームも削除もしない
  - この層は**ファイル I/O と暗号だけに閉じる**（`store/http-auth.ts` を引かない）
- [x] パスフレーズの記憶を作る
  - `userData/auth-vault-key.json`（**iCloud ではない**）に `getSecretBackend()` で暗号化して置く
  - `rememberPassphrase(value)` / `recallPassphrase()` / `forgetPassphrase()`
  - **端末鍵が使えないときは黙って平文で書かない**。記憶を諦めて毎回入力に倒す

### Phase 5: IPC と preload [AI🤖]

- [x] `ipc.ts` に足す（すべて `requireWindow(event)` を通す）
  - `nemo:auth-vault-status` … カードに出す情報 + この Mac の件数 + `slotsDir()` の `kind`
  - `nemo:auth-vault-preview-save` … 保存前の差分（**消える N 件**）と、
    保存から除外される件数。復号できない場合は
    **`bad-passphrase` と `tampered` / `malformed` を分けて返す**
    （`decryptVault` は既に区別している。畳むと**打ち間違いに対して「削除して作り直す」を
    提示する**ことになる。undo が無い機能で、最も起きやすいミスに最も戻れない選択肢を出す）
  - `nemo:auth-vault-save` … 実行
  - `nemo:auth-vault-preview-load` … 読み込み前の 3 グループ
  - `nemo:auth-vault-load` … **選ばれた `pattern` の配列**を受ける。
    **保管庫を読み直して選択された pattern を分類し直し、`missing` / `differing` に
    残っているものだけ** entries に組む（preview と実行の間に別の Mac が保管庫を書き換えたり、
    手元のルールが変わったりしうる。再分類しないと**preview で見ていない中身がそのまま入る**）。
    消えていたものは結果に「保管庫が更新されていたため N 件を取り込みませんでした」と出す。
    `id` は同じ pattern の既存ルールがあればその ID、無ければ `null`（新規採番）。
    そのあと `importHttpAuthRules` → `httpAuthCredentialsChanged('vault-loaded')`。
    **取り込んだ件数は commit 後に数え直して返す**（`normalizeRules` が黙って落とす分と食い違わせない）
  - `nemo:auth-vault-delete` … **記憶しているパスフレーズも一緒に忘れる**
    （残すと、別のパスフレーズで作り直したときに古い記憶が初期値として出る）
  - `nemo:forget-auth-vault-passphrase`
  - **パスフレーズは preview と実行の両方で受ける**（main に平文をキャッシュしない）。
    覚えている場合は renderer が `null` を渡し、main が保存済みを使う
  - **パスワードは戻り値に含めない**。`log-redact.js` の `sanitizeDetail` が
    `password` キーを落とすことは確認済みだが、そもそも出口に載せない
- [x] `preload/ui.ts` と `types.ts` の `window.nemo` に対応する型を足す

### Phase 6: UI [AI🤖]

- [x] `src/renderer/components/AuthVault.tsx` を作り、`Settings.tsx` の `<Slots />` の直下に置く
  - カード 1 枚（件数 / 保存日時 / 端末名 / 「···」→ 削除）
  - パネルを開くたびに `auth-vault-status` を引き直す（`Slots.tsx` と同じ理由）
  - **保存のブロックは preview の結果で行う**（カードの状態では判定しない）。
    `bad-passphrase` は「パスフレーズが違います」＋**やり直しだけ**（削除の導線を出さない）、
    `tampered` / `malformed` は「保管庫が壊れています」＋削除の導線
  - **どちらのダイアログも「パスフレーズ →（preview）→ 内容」の 2 段**にする。
    記憶があるときだけ 1 段目を自動で通過する。`data-testid` は**段ごとに用意する**
    （1 画面前提で組むと、状態機械も Phase 7 の CDP 手順も作り直しになる）
  - **自動通過したあと preview が `bad-passphrase` を返したら 1 段目を出してやり直させる。**
    記憶した値が古いとき（別の Mac で保管庫を作り直した / パスフレーズを変えた）に当たり、
    戻せないと**「パスフレーズが違います」と出たまま入力欄が無い行き止まり**になる
  - 保存ダイアログ … パスフレーズ欄（**初回は 2 回入力**）+ 「この Mac に覚える」チェック（既定 ON）
    →「保管庫にしか無い N 件が消えます」の実名リスト
  - 読み込みダイアログ … パスフレーズ欄 → 3 グループのチェックリスト
    （「無いもの」は既定 ON、「内容が違うもの」は既定 OFF、「既にあるもの」は表示のみ）
  - **この Mac で無効なルールには「この Mac では無効です（読み込むと有効に戻ります）」を添える**
    （`same` だけでなく `differing` にも出す。`importHttpAuthRules` は `enabled: true` 固定なので、
    黙ってチェックすると意図して外したルールが有効に戻る）
  - 文体は**ですます調**。内部用語（「降格」「マージ」等）を出さない
  - ダイアログに `data-testid` を持たせる（`Slots.tsx` / `PromptDialog.tsx` と同じ作法。
    **持たせないと CDP から通しの検証が組めない**）

### Phase 7: 自走検証 [AI🤖]

- [x] `scripts/verify-auth-vault.mjs` を作る
  - **「別の Mac」は `NEMO_USER_DATA_DIR` を分けたうえで `NEMO_SLOTS_DIR` を共有して模す**
    （`scripts/verify-slots.mjs` が既に両方を渡している）。
    `NEMO_SLOTS_DIR` だけ差し替えると同じプロファイルを使い回すことになり、
    パスフレーズの記憶が引き継がれる経路をそのまま PASS させる
  - **2 つ目のプロファイルでパスフレーズを覚えていないこと**も検査する
  - 保存 → 別プロファイルで読み込み → 3 グループの振り分けが実データで合うこと
  - **「無いもの」だけチェックして読み込むと、チェックしていないものが入らないこと**
  - `locked`（違うパスフレーズで書かれた保管庫）で保存がブロックされること
  - 無効なルールが保管庫に入らないこと
  - `safeStorage` には触らない（`secret-backend.ts` の差し替え backend を使う。
    **触ると `SecurityAgent` のダイアログで検証が永久に止まる**）
- [x] `verify-targets.mjs` に `auth-vault` を登録する
  - 登録先は **`KNOWN_TARGETS` / `OWNERS` / `OPT_IN_ONLY` の 3 つ**。
    **`NEEDS_APP` には入れない** —— このスイートは自分で 2 プロファイルを起動するので、
    入れると共有のアプリとページサーバまで立ち上がって使わない起動が 1 つ増える
    （同じく自分で起動する `slots` も `NEEDS_APP` に入っていない）
  - **`OWNERS` の既存エントリも広げる。** Phase 3 が触る `src/shared/http-auth-rules.js` と
    `src/main/store/http-auth.ts` は今 `['http-auth']` 単独なので、
    そのままだと**この 2 ファイルを直しても `--changed` で `auth-vault` が回らない**。
    腐っても症状は「速く PASS する」ので気づけない
- [x] **`verify-all.mjs` に `if (want('auth-vault'))` の配線を書く**
- [x] **配線を外した状態で 1 回回して検査 0 件になることを確認してから戻す**（`CLAUDE.md`）
- [x] 報告には**実行した検査の件数**を出す

### Phase 8: ドキュメント [AI🤖]

- [x] `docs/CHANGELOG.md` の `[Unreleased]` に追記（冒頭の「書き方」節に従う）
- [x] `VERIFY.md` に手順を追記（既存の構造・粒度に合わせ、重複を確認してから）

### 動作確認 [人間👨‍💻]

- [ ] 常用の Nemo で実際に保存し、iCloud に `basic-auth.json` ができること
- [ ] もう 1 台の Mac（あるいは別プロファイル）で読み込み、差分の 3 グループが期待通りに出ること
- [ ] 読み込んだルールで実際に Basic 認証が自動入力されること

## ログ

### 試したこと・わかったこと

- **AAD では「改竄」と「パスフレーズ違い」を区別できない**（実測で確認）。
  正しい鍵 + 改竄したメタ / 違う鍵 + 正しいメタ のどちらも
  `decipher.final()` が同じ例外（`code` すら無い）を投げる。
  → **メタの写しを暗号の中に入れて復号後に突き合わせる**形に変更。
  これで「鍵は正しいが中身が食い違う」＝ `tampered` だけを名指しできる
- **配線を外した状態で `--only auth-vault` を回すと、検査 0 件のまま
  「すべて PASS」で exit 0 になることを実際に確認してから配線を入れた**（`CLAUDE.md`）
- 有効トグルは `window.nemo.setHttpAuthRuleEnabled` ではなく、
  `pattern` を省いた `saveHttpAuthRule({ id, username, enabled })` が受ける
- 自走検証が **`updatedAt` が公開形に載っていない**ことを捕まえた
  （`imported=undefined` で FAIL）。`HttpAuthRule` と `toPublic` に足して PASS。
  秘密ではないメタなので、保管庫が運んだ時刻を外から確かめられる形にした

### 方針変更

- 2026-08-29 レビューの Q「『この Mac に覚える』を後から取り消す導線を出すか」に対し、
  **出さない**と決定。あわせて呼び手の無くなる `nemo:forget-auth-vault-passphrase`
  （IPC・preload・`window.nemo` の型）を**削除**した。到達しない IPC を残すと表面積が広がるだけ
- 2026-08-29 実装レビューを受けて、**カードの「削除」を「···」メニューへ移した**
  （実装が計画の「画面の形」に反して、保存 / 読み込む と同じ行に常時出していた）。
  あわせて**未来の版の保管庫には削除の導線を出さない**ことにした ——
  退避しないのは「古い Nemo が新しい方の保管庫を全件消さない」ためなのに、
  削除ボタンがあると同じ結果へのワンクリックの近道になる。
  判定は理由の文字列一致ではなく `AuthVaultStatus.isFutureVersion` で行う
- 2026-08-29 `readVaultFile` の封筒検査を**自前の `readMeta` から `normalizeVaultFile` に寄せた**。
  meta だけ見る緩い検査だと、kdf の欠けた壊れたファイルがカード上は `ok`「N 件」に見える
  （実際は `decryptVault` が必ず `malformed` を返す）

- 2026-08-28 レビューで「単一のパスフレーズ欄では変更が成立しない」（保存の preview は古い
  パスフレーズ、書き込みは新しいパスフレーズが要る）と判明。**パスフレーズの変更を今回の範囲から
  外し**、画面には「変更するには保管庫を削除して作り直してください」を出すことにした。
  dig 時点の「書き換えれば変更になるので専用の導線を作らない」は撤回する
- 2026-08-28 「保管庫に入れるのは有効なルールだけ」を確定（レビューの Q に対する回答）。
  一時的に無効にしたルールが別の Mac の保存で保管庫から消えることは「既知の穴」に記録済み
- 2026-08-28 **平文メタを AAD に入れる案を撤回**し、写しを暗号の中に入れて復号後に
  突き合わせる形にした。AAD だと改竄でも認証タグが落ちるだけで、
  「パスフレーズが違う」と原理的に区別できない（実測で確認）。
  区別できないと、打ち間違いに「削除して作り直せ」を出すことになる
- 2026-08-28 **`MIN_PASSPHRASE` を renderer が直接 import する案を撤回**。
  `tsconfig.web.json` は shared の許可リスト方式で、足すと依存する
  `settings-schema.js` まで引き込む。`CLAUDE.md` に「tsconfig を広げるより main 側へ寄せる」
  の記録があるので、**値を `authVaultStatus()` の戻りに載せて運ぶ**形にした
  （規則の出どころは `validatePassphrase` の 1 本のまま）
- 2026-08-28 `readWithTimeout`（`slots.ts` の private）を **export して保管庫と共有**した。
  同じ iCloud のフォルダを読むので、待ち方が違うと
  「スロットは諦めるのに保管庫は固まる」が起きる
