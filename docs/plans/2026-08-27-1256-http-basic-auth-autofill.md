# HTTP Basic 認証の自動入力（MultiPass 相当）

## 概要・やりたいこと

Basic 認証のダイアログを毎回手で埋めるのをやめる。**URL のパターンに資格情報を紐づけておき、
マッチしたら Nemo が裏で答える**。Chrome 拡張の
[MultiPass](https://github.com/krtek4/MultiPass)（Web Store で 9,000 ユーザー・★5.0）
と同じ体験を Nemo に内蔵する。

MultiPass を Nemo に拡張として入れる案は**技術的に不可能**なことが確定しているので（後述）、
自前で作る。ただし Nemo は Electron なので、拡張より条件が良い:

- 認証フックが main プロセスにある（MV3 Service Worker の寿命問題が構造的に起きない）
- `safeStorage` が使える（MultiPass はパスワードを平文で `chrome.storage` に置いている）
- **自前の認証ダイアログを既に持っている**（`PromptDialog` の `auth`）。
  だから「ダイアログにチェックを1つ足せば登録できる」導線が取れて、
  MultiPass の「全部 Settings で手登録」より入力の手間が少ない

現在 MultiPass を実運用しているので、**そのエクスポート JSON を取り込む**導線も作る。

## 前提・わかっていること

### MultiPass の実装（clone して全ソース確認済み）

核心は 1 箇所だけ。`js/extension.js:83` と `:56`:

```js
chrome.webRequest.onAuthRequired.addListener(retrieveCredentials, {urls: ['<all_urls>']}, ['blocking']);

return credentials.length == 0 || statuses[tabId].count > max_try
  ? {}                                              // → ブラウザ標準のダイアログにフォールバック
  : { authCredentials: { username, password } };    // → ブラウザが 401 チャレンジに自動応答
```

- MV3 で blocking webRequest は原則禁止だが、**`onAuthRequired` だけは例外**で、
  `webRequestAuthProvider` 権限があれば blocking で張れる。この拡張が MV3 に生き残れた理由
- マッチは `new RegExp(rule.url).test(details.url)` の**リクエスト URL の正規表現一本**。
  `realm` / `challenger` / `isProxy` / `scheme` は一切使っていない
- リトライ抑止（`js/extension.js:43-54`）: 同一 `requestId` で 5 回超えたら `{}` を返して諦める。
  これが無いと 401 のループが止まらない（CHANGELOG 0.3.0 "Avoid error loop"）
- 保存は `chrome.storage` に平文。`sync` を使う意図のコードはあるが
  `detectStorageNamespace` が Service Worker に無い `window[ns]` を触って例外→catch するため
  **実際は常に `local`**（同期は事実上死んでいる）
- MV3 移行の取り残しが 2 つある: `js/credentials.js:198` の
  `chrome.extension.getBackgroundPage()`（MV3 に存在しない API）と、
  Service Worker のメモリ上 state と `Storage.get` の非同期ロードの競合

### MultiPass を Nemo に拡張として入れる案は不可能（確定）

Electron のドキュメントは「`chrome.webRequest` は全機能サポート」と書いているが、実体が無い。

```
$ grep -n "onAuthRequired\|authCredentials" node_modules/electron/electron.d.ts
（0 件）
```

Electron 41.10.6 の `session.webRequest` が持つのは
`onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` / `onSendHeaders` /
`onResponseStarted` / `onBeforeRedirect` / `onCompleted` / `onErrorOccurred` の **8 つだけ**。
`chrome.webRequest` シムはこのモジュールの上に実装されているので、
**MultiPass が使う唯一の API が Electron の表面全体に存在しない**。
`webRequestAuthProvider` 権限も Electron は知らない。

### Nemo 側のフックは既にある

`src/main/security.ts:533` の `installAuthHandler` が `chrome.webRequest.onAuthRequired` と
同じ位置。今は必ず人間に聞いている。ここに「ルールを引く」を挟む。

```ts
app.on('login', (event, contents, _details, authInfo, callback) => { ... })
```

`_details` は `{ url }`。**今は捨てているが、URL 正規表現マッチにはこれを使う。**

### Electron 固有の制約（設計の肝）

**① `requestId` が無い。** `login` イベントの引数に MultiPass のリトライ検出に使える ID がない。
代替キーは **`webContents.id + authInfo.scheme + details.url`**。
`host:port + realm` だけにすると、同じページ内で並列に飛ぶ 401（画像・API の同時取得）が
「2 回目＝拒否された」と数えられてしまう。

**② `contents.getURL()` だけで同一オリジン判定を書くと必ず壊れる。**
`login` が飛ぶ時点でナビゲーションが未 commit なので、`getURL()` は**古いページ**
（新規タブなら `about:blank`）を返す。つまり「アドレスバーに URL を打って 401」という
**一番使う経路で判定が必ず false になる**。

対処は `did-start-navigation`（`isMainFrame && !isSameDocument`）で
pending な遷移先 URL を webContents ごとに覚えること。
`will-navigate` では代用できない（`loadURL()` では発火しないのでアドレスバー経由を拾えない）。
**このフックはリトライ回数のリセット契機としても兼用する。**

**③ 「標準ダイアログにフォールバック」は存在しない。**
`preventDefault()` しなければ Electron の既定は**認証キャンセル**。
諦め方は「Nemo のダイアログを出す」の一択。

**④ Chromium の HttpAuthCache。** 一度通るとセッション内は `login` が飛ばなくなる。
つまり自動入力が効くのは実質「セッション内の初回」だけ。
逆に**ルールを消してもセッション中はログインしたまま**になるので、
削除時に `session.clearAuthCache()` を呼ぶ（Electron 41 に存在。ただし**オリジン指定不可で
そのセッションの全認証キャッシュが消える**。ルールが残っているサイトは自動入力で即座に戻るので実害は小さい）。

### 既存コードで再利用できるもの

| 使うもの | 場所 | 用途 |
|---|---|---|
| `normalizeOrigin` | `security.ts:353` | 同一オリジン判定 |
| `JsonStore` | `store/json-store.ts` | 原子的書き込み・破損時の隔離・デバウンス保存 |
| `safeStorage` の型 | `store/github-token.ts` | 暗号化の作法（保存を断る / 復号失敗は捨てる） |
| `ask` / `answerPrompt` | `prompts.ts` | 認証ダイアログ |
| `sanitizeDetail` | `shared/log-redact.js` | `password` / `username` キーは出口で `[redacted]` に落ちる |
| `requireWindow` | `ipc.ts:85` | WebContents 同一性 + UI origin の二重検証 |

### 設定同期には載せない

`src/shared/sync-schema.js` の `SYNCED_FILES` は `settings.json` と `pins.json` のみ。
`github-token.ts` が明記しているとおり、**端末鍵の `safeStorage` 暗号文を git で他端末に配っても
復号できない**ので、`http-auth.json` は同期対象外にする。

### 「どのルールの順序が変わるか」は特定しない

インポート時に「MultiPass の priority 順と Nemo の長さ順で選ばれるルールが変わる組」を
洗い出したいところだが、**任意の JavaScript 正規表現が重なるかの判定は実装方法が定義できない**
（backreference や lookaround を含めば尚更）。

なので:

- **インポート時**は、priority が一様でないファイルなら
  「MultiPass の優先度は取り込まれません。Nemo はパターンが長いほうを使います」と**一括で**警告する
- **Settings** の複数マッチ表示は、**テスターに入れた実際の URL に対して照合**して
  「この URL には複数マッチします。X が使われます」と出す。
  ルール同士を静的に突き合わせることはしない

### 自走検証は `safeStorage` に触ってはいけない（このリポジトリで既に踏んだ事故）

`VERIFY.md:695` と `docs/plans/2026-08-25-1924-github-pr-live-folder.md:730` に記録がある:

> 自走検証が PAT を保存した瞬間に `SecurityAgent` が上がり、**検証が永久に止まった**

macOS の `safeStorage` は Keychain の許可ダイアログを出す。
PAT のときは `NEMO_GITHUB_TEST_AUTH=stored-only` で実ストアを迂回して回避している
（`src/main/live-folders/token.ts:73`、`scripts/verify-all.mjs:174`）。

**今回も同じ作法を採る。** 自走検証では**暗号化・復号そのものをテスト用 backend に差し替え**、
実 `safeStorage` との結合は人間の動作確認に分ける。
暗号化経路が自走検証で通らないのは PAT と同じトレードオフで、
`VERIFY.md` も「平文の PAT が無いことだけは手で見る」としている。

### 純粋ロジックの置き場所（既存の慣習）

`src/shared/*.js`（`// @ts-check` + JSDoc）に置き、`scripts/*.test.mjs` から
`node --test` で直接叩く。`settings-schema.js` / `navigation-policy.js` / `log-redact.js` と同じ形。
Electron を起動せずに回せるので CI の必須チェックに置ける。

### /dig で確定した仕様

| # | 論点 | 決定 |
|---|---|---|
| 1 | 導線 | 認証ダイアログの「次回から自動で入力する」が主。Settings は管理画面 |
| 2 | マッチモデル | URL 正規表現1本。ダイアログ保存時に自動生成 |
| 3 | 自動生成の粒度 | オリジン全体を固定 `^https://host:port/`。**スキームを固定**して https で登録した資格情報が http に平文で飛ぶ事故を防ぐ |
| 4 | 拒否されたとき | **同じ (タブ, scheme, リクエスト URL)** で 2 回目の login が来たら即ダイアログ。加えて**一度でも拒否されたら、その (タブ, ルール, オリジン, realm) では以後自動入力しない**——`attempts` がリクエスト URL 単位なので、これが無いと保護されたサブリソースの数だけ同じ誤パスワードを送ることになる。ルールは残す。同じ間違ったパスワードを何度送っても無駄なので MultiPass の 5 回は採らない |
| 5 | ワイルドカード | 要る。Settings でパターン編集 + 正規表現テスターを作る |
| 6 | typo 保存 | 楽観的に保存。拒否されたらダイアログを保存値で prefill し、直して再保存＝上書き（自己修復） |
| 7 | シークレット | **一切使わない**（読み取り・保存・prefill すべてしない）。`permissions.ts` のような scope 分岐は不要 |
| 8 | プロキシ認証 | **対象外**。`details.url` はアクセス先であってプロキシではないので、正規表現モデルが合わない（MultiPass はここを区別しておらずバグ）。あわせて **`authInfo.scheme === 'basic'` のときだけ**自動入力する（Digest 等は従来どおりダイアログ。機能名と適用範囲を一致させる） |
| 9 | 保存先 | `http-auth.json` を新設・同期対象外。pattern / username は平文、password のみ `safeStorage` |
| 10 | 適用範囲 | **タブの現在（または遷移中の）URL と同一オリジンのリクエストのみ**。クロスオリジンのサブリソースはダイアログ。無いと `<img src="https://router.local/reboot">` を置くだけで、訪問してもいないホストに認証付きリクエストを飛ばせる |
| 11 | 複数マッチ | 最優先の 1 つだけ試す。拒否されても次は試さない（アカウントロック回避） |
| 12 | 優先順 | **パターンが長いほど優先**（同点は登録順）。数値フィールドは持たない |
| 13 | 暗号化不可の環境 | 保存を断る（`github-token.ts` と揃える） |
| 14 | フィードバック | バッジ等は作らない。ダイアログが出ないこと自体がフィードバック。ただし**自動入力しなかったときは理由を診断ログに 1 行残す**（`auth.not_autofilled`。列挙値だけで URL も資格情報も載せない）。残さないと「効かない」を切り分ける手段が無い |
| 15 | パスワード表示 | 作る。ただし一覧には載せず「表示」を押したときだけ 1 件取得（`github-token.ts` の「返す口は作らない」とは意図的に分ける。PAT は広いスコープの bearer token、こちらはサイト個別のパスワードで「あのサイトのパスワード何だっけ」を引ける価値が上回る） |
| 16 | MultiPass 移行 | インポートのみ。エクスポートは作らない（平文パスワードをディスクに書くことになり `safeStorage` で守る意味を削ぐ） |
| 17 | インポート変換 | **裸のホスト名（+ 任意ポート）だけ**を `^https://([^/]+\.)?example\.com/` へ自動変換。**http は含めない**（#3 と同じ理由。裸のホスト名から `https?` を作ると、https で使っていた資格情報が http に平文で飛ぶ）。http が要るルールは Settings で明示的に編集する。scheme 付き・パス付き・IP・メタ文字入りは**素通し**。プレビューは出さない |
| 18 | priority | 捨てる。**priority が一様でないファイルなら一括で警告**する（どのルールの順序が変わるかは特定しない。後述） |
| 19 | 資格情報が変わったとき | 削除・無効化・pattern / username / password の編集の**すべて**で、`session.fromPartition(PAGE_PARTITION).clearAuthCache()` と **`attempts` / `denied` / `inflight` の全消し**を**両方**行う。`inflight` は**未解決の callback を残さず終了させてから**消す。**ただしダイアログで保存したときは、配った URL の `attempts` だけ 1 に戻す**（全消しの直後に配るので、打ち直しも間違っていると同じ値が「手入力」と「直後の自動入力」で 2 回飛び、#11 のアカウントロック回避に反する。抑止は URL 単位で、`denied` は消したままにする） |
| 20 | Phase | 分けずに一気に実装 |
| 21 | 検証 | 単体テスト（純粋関数）+ E2E の両方。実装前に FAIL を確認 |
| 22 | インポートの原子性 | **通ったものだけ取り込み、拒否分は件数・パターン・理由を報告**する。1 件のせいで移行が丸ごと止まらないようにする（拒否分は画面にパターンが残るので、見ながら手で登録し直せる） |
| 23 | パスワードの再マスク | Settings を閉じたとき / 別のルールを表示したとき / **表示から 30 秒**。タイマーの長さは検証から短縮できるようにする |

### 細部の決定

- ダイアログの保存チェックは**既定 OFF**（`permissions.ts` の「今後も許可」は既定 ON だが、
  パスワードは取り消しコストが違う）
- 同じパターンのルールが既にあれば**上書き**（#6 の自己修復に必要）
- ルールに `enabled` トグルを持つ（削除せず一時停止できる）
- インポート時、変換元の MultiPass パターンを `importedFrom` として保持する
  （黙って変換する分、後から何がどう変わったか追えるようにする）
- インポートの入力は**テキスト貼り付け**（textarea）。ファイル選択は
  `dialog.showOpenDialog` を main に足すことになるので見送る

## 実装計画

### 事前準備 [人間👨‍💻]
- [ ] MultiPass のオプション画面 → Export → `multipass-credentials.json` をダウンロードしておく
      （Phase 6 のインポート検証で実データを使う。**パスワードが平文で入っているので
      リポジトリには絶対に置かない**。検証時はダミーに差し替えた写しを使う）

### Phase 1: 純粋ロジック + 単体テスト [AI🤖]

**先にテストを書き、実装前に FAIL することを確認してから実装する。**

- [x] `src/shared/http-auth-rules.js` を新設（`// @ts-check` + JSDoc）
  - [x] `validateHttpAuthPattern(pattern)` — **危険な正規表現を弾く唯一の関門**。
        ユーザーが書いた正規表現を main で実行するので、catastrophic backtracking を踏むと
        Settings ではなく**ブラウザ全体が固まる**（拡張と違って別プロセスに隔離されていない）
    - [x] 長さ上限に加え、**量化されたグループの中の量化子・alternation・lookaround、
          および後方参照を拒否**する。`(a+)+$` も `^(a|aa)+$` も 10 文字未満なので
          **長さ上限だけでは防げない**
    - [x] ただし**外側の量化子が最大 1 回（`?` / `{0,1}`）なら対象外**。
          組合せ爆発を起こさないうえ、これを禁じると
          `convertMultipassPattern` が生成する `^https://([^/]+\.)?example\.com/` 自身が
          弾かれ、**変換したルールが全部落ちる**
    - [x] 許容する構文を validator の側で明文化し、**拒否例と許可例をテストで固定**する
    - [x] **構文検査は第一の関門であって保証ではない**（列挙した条件の外にも高コストな
          パターンはあり、実測テストは「未知のパターンで固まらない」ことを保証しない）。
          **照合そのものを main スレッドから隔離する**（次項）
    - [x] **照合する URL の長さにも上限**を設け、超えたら照合しない
    - [x] **編集 / インポート / `normalizeRules` / テスターの全入口でこれを通す。**
          どれか 1 つでも迂回できると、Settings が拒否したパターンが
          再起動後の認証照合で main を固める
  - [x] **件数と username / password / pattern の長さ上限を `shared` の名前付き定数にし、
        全保存入口（ダイアログ・Settings・インポート）と `normalizeRules` で共通に適用する。**
        インポートだけに適用すると、入口によって拒否・無制限保存・IPC 側の黙示的な
        切り詰めに分かれ、**入力した値と実際に送信・保存される値が食い違う**。
        renderer の入力欄にも同じ `maxLength` を入れ、**上限ちょうど / 超過を各入口でテストする**
  - [x] `normalizeRules(raw)` — 保存 JSON の正規化（`validateHttpAuthPattern` と
        上限を通らないルールは落とす）
  - [x] `patternFromUrl(url)` — `https://staging.example.com:8443/a/b` → `^https://staging\.example\.com:8443/`
        （**既定ポートは URL に出ないので付けない**。`URL.origin` をエスケープして `/` を足す）
  - [x] `matchRules(rules, url)` — 有効なルールを正規表現で照合し、
        **パターン長の降順 → 登録順**で並べて返す。壊れた正規表現は握り潰してスキップ
    - [x] **この関数の実行は main スレッドで行わない。**
          ユーザーの正規表現を main で走らせると、catastrophic backtracking で
          **ブラウザ全体が固まる**（拡張と違って別プロセスに隔離されていない）。
          `worker_threads` の常駐ワーカーで動かし、**タイムアウト付きで呼ぶ**
    - [x] **ジョブはルール 1 件単位**にする（`matchRules` 全体を 1 ジョブにすると、
          応答しないワーカーから「どのルールが原因か」を取り出せず、
          **「そのルールだけ無効化」が実装できない**）
    - [x] **ジョブは `runtime`（実際の認証での照合）と `tester`（Settings のテスター）を
          区別する。** 自動無効化は **`runtime` のタイムアウトだけ**に適用する。
          区別しないと、**未保存の下書きを試しただけで有効な保存済みルールが無効化される**。
          `tester` のタイムアウトは画面にエラーを出すだけ
    - [x] **タイムアウトしたら「不一致」として扱う**（自動入力せずダイアログ）。
          `runtime` ならあわせて**その ID のルールを自動的に無効化し、理由を保存する**
          （毎回タイムアウト待ちにならないように）
    - [x] `StoredRule` と一覧型に `disabledReason?`（`'pattern-timeout'` /
          `'decrypt-failed'`）を持たせ、**Settings で理由を表示**する
          （黙って無効化されると原因が追えない）
    - [x] **request ID を持つ仲介層を 1 つ置く。** ワーカーの `error` / `exit` /
          タイムアウトのいずれでも**pending をすべて明示的に解決する**（不一致 or エラー）。
          放置すると別タブの認証や Settings のテスターの Promise が永久に残る
    - [x] ワーカーは terminate して作り直す。アプリ終了時にも terminate する
    - [x] 関数自体は同期の純粋関数のまま `shared` に置き、
          ワーカーはそれを読み込むだけにする（単体テストは同期で回す）
    - [x] **Settings のテスターも同じワーカー経由**にする（正規表現を走らせる口を 1 つにする）
  - [x] `evaluateEligibility({ isProxy, scheme, isPrivate, isSameOrigin, canEncrypt, isUrlTooLong })` —
        **自動入力の可否と `canSave` を決める唯一の述語**。
        `resolveCredential` とダイアログ生成の両方がこの戻り値を使う
        （両者が別々に条件を書くと、片方だけがテストされる状態に戻る）
    - [x] **URL 長の上限超過も `canSave` を false にする。**
          自動入力側だけで弾くと、**保存はできるのに次回も使われないルール**ができる
  - [x] `isSameOrigin(requestUrl, pageUrl)` — `normalizeOrigin` 相当の比較
        （`security.ts` の実装と重複させず、`shared` 側に持って `security.ts` から使う形にするか、
        `security.ts` の `normalizeOrigin` を `shared` へ移すかは実装時に判断してログに残す）
  - [x] `convertMultipassPattern(pattern)` — **裸のホスト名（+ 任意ポート）の形にだけ**当てる。
        `^https://([^/]+\.)?<エスケープ>/` に変換して `{ pattern, converted: true }` を返す。
        **`https?` にはしない**（#17）
    - [x] 変換対象は `label(.label)+`（+ 任意の `:port`）に厳密一致するものだけ。
          **scheme を含む / `/` を含む / IP アドレス / `.` 以外のメタ文字を含む**ものは
          すべて**素通し**（`converted: false`）。ここを緩くすると
          `https://example.com/` や `example.com/admin` を壊れたパターンに変換してしまう
  - [x] `importMultipass(json, existing)` — 変換 + 重複パターンの上書き +
        **priority が一様でなければ一括警告**を返す（どのルールが影響を受けるかは特定しない）
    - [x] **受け付ける形を決める**: MultiPass の実際のエクスポートは
          `JSON.stringify(credentials)` で**ハッシュをキーにしたオブジェクト**、
          ドキュメントの例は**配列**（`parse_json` が `for...in` なので両方通る）。
          **Nemo も両方受ける**
    - [x] `url` / `username` / `password` が文字列であることを必須にし、
          欠損・型違いの要素は落として件数を報告する
    - [x] **拒否があっても中止しない。** 通ったものだけ取り込み、
          `{ imported: n, rejected: [{ pattern, reason }] }` の形で返す
    - [x] priority の「一様」判定は **`Number(priority ?? 1)` の実効値で比較**する
          （欠損・数値 `1`・文字列 `"1"` が混ざっても不要な警告を出さない）
- [x] `scripts/http-auth-rules.test.mjs` を新設
  - [x] `patternFromUrl`: 既定ポート / 非既定ポート / パスあり / http / 日本語ドメイン
  - [x] `matchRules`: 長いパターンが勝つ / 同点は登録順 / `enabled: false` は除外 /
        壊れた正規表現があっても他のルールは生きる
  - [x] `convertMultipassPattern`: `example.com` / `example.com:8443` → 変換される。
        **`https://example.com/` / `example.com/admin` / `192.168.1.1` /
        `^https://x\.com/` / `.*\.example\.com` はすべて素通し**
        （素通しになるケースこそ本命の回帰テスト）
  - [x] **変換の意味が保たれること**: 変換後のパターンが `https://www.example.com/` に
        マッチし、`https://notexample.com/` と **`http://www.example.com/`**（#17 のスキーム固定）
        にはマッチしない
  - [x] `importMultipass`: **拒否が混ざっていても通った分は取り込まれ、
        拒否分がパターンと理由付きで返る** / **オブジェクト形式と配列形式の両方**が読める /
        priority が捨てられる / priority が一様でなければ警告が返る /
        **欠損・数値 `1`・文字列 `"1"` が混在しても警告は出ない** /
        同じパターンは上書きされる / 構文エラー・欠損・型違い・上限超過の扱い
  - [x] `validateHttpAuthPattern`: `(a+)+$` / `^(a|aa)+$` / 後方参照 / 長すぎるもの が拒否され、
        自動生成パターンとよくあるワイルドカード（`^https://.*\.example\.com/`）は通ること
  - [x] **結合テスト**: 裸のホスト名を `convertMultipassPattern` → `validateHttpAuthPattern`
        → `importMultipass` → `normalizeRules` と通しても**落ちずに残り**、
        元の URL にマッチし続けること（validator と変換器が互いを弾き合わないことの回帰）
  - [x] **保存適格判定と自動入力可否を表形式で固定する**:
        暗号化不可 / シークレット / プロキシ / 非 Basic / クロスオリジン / 正常系 の各行について
        `canSave` と「自動入力するか」の期待値を並べる
        （1 つでも漏れると「保存できるのに使われないルール」が復活する）

### Phase 2: ストア [AI🤖]

- [x] `src/main/store/http-auth.ts` を新設
  - [x] ファイルは `userDataPath('http-auth.json')`、`JsonStore` + `HTTP_AUTH_VERSION = 1`
  - [x] **`JsonStore` に「書き切ってから commit する」API を足す。** 現状の `scheduleSave()` は
        400ms デバウンス、`saveNow()` は書き込み失敗を `logError` で握り潰して `void` を返す
        （`store/json-store.ts:95-109`）。このままだと
        **IPC が成功を返したあとに書き込みが失敗する**構造が残る
    - [x] **次の値を先にディスクへ書き切り、成功したときだけメモリへ commit する**
          （`set` してから flush する形にすると、**失敗したのにメモリには新しい値が残り、
          次の別の更新が成功したときに一緒に永続化される**）
    - [x] **トランザクションは `JsonStore` 内でキューイングして直列化し、
          常に直前の commit 済み値から次の値を作る。**
          複数タブの保存や複数ルールの自動無効化が並ぶと、
          同じ旧値から作った更新が互いを上書きして**片方が消える**
    - [x] 資格情報の作成・編集・削除ではこの API を **await して成否を IPC に反映する**
          （既存の呼び出し側の挙動は変えない）
  - [x] `StoredRule = { id, pattern, username, password（base64 の暗号文）, enabled,
        importedFrom?, disabledReason? }`。`disabledReason` は
        `'pattern-timeout'` / `'decrypt-failed'`（Phase 1 のワーカー隔離と下の復号失敗で立つ）
  - [x] `isEncryptionAvailable()` が false なら**保存を断る**（`github-token.ts` と同じ）
  - [x] 復号に失敗したルールは**そのルールだけ無効化して残りは生かす**
        （PAT と違い 1 件壊れても他が使えるべき）。`disabledReason: 'decrypt-failed'` を立てる
  - [x] **`disabledReason` がある間は `enabled` に関わらず実効無効**とし、
        **有効トグルを禁止する**（両者が独立していると、理由が残ったまま ON にできて
        `decrypt-failed` のルールを読みに行く実装と読みに行かない実装に分かれる）
  - [x] **`disabledReason` を消す規則**: 原因に対応するフィールドが変更されたときに消して
        再び有効にできるようにする（`pattern-timeout` は pattern の変更、
        `decrypt-failed` は password の再保存）。**それ以外の編集では消さない**
        （消すと同じ原因で毎回無効化され直す）
  - [x] `listRules()` は**パスワードを含まない**形
        （`{ id, pattern, username, enabled, importedFrom?, disabledReason? }`）を返す。
        `importedFrom` は機密ではないので一覧に載せる（載せないと保持する意味がない）
  - [x] `revealPassword(id)` を別に立てる
  - [x] **「資格情報が変わった」ときの後始末を 1 か所に集約する**（`attempts` を持つ
        `http-auth.ts` と永続化の `store/http-auth.ts` が相互に import しないよう、
        **両者の外側に置いて両方を呼ぶ**）。削除だけでなく
        **無効化・pattern / username / password の編集**でも、次の 2 つを必ず**両方**行う
    - [x] `session.fromPartition(PAGE_PARTITION).clearAuthCache()` を await する
          （`defaultSession` を消しても常用タブの `persist:` セッションには効かない）
    - [x] **`attempts` / `denied` / `inflight` を全消しする。** 片方だけだと、一度成功した URL の
          `attempts` が残ったまま認証キャッシュだけ消え、
          **次の 401 が「2 回目＝拒否された」と判定されて新しい資格情報が使われない**
    - [x] **全消しは `finally` で行う。** `clearAuthCache()` が reject したときに
          直列実装だと消去が丸ごと飛び、「両方必ず行う」が破れる。
          キャッシュ消去に失敗しても**保存は成立している**ので IPC はエラーにせず、
          `{ saved: true, authCacheCleared: false }` のように**判別できる成功結果**を返す
          （エラーにすると renderer が「保存も失敗した」と誤って表示を巻き戻す）。
          IPC がエラーになるのは**永続化そのものが失敗したとき**だけ。
          `authCacheCleared: false` のときは「反映には再起動が必要」を出す（自動リトライはしない）
  - [x] `SYNCED_FILES` には**追加しない**（`sync-schema.js` は触らない）
  - [x] **暗号化・復号・利用可否判定を 1 か所（小さな backend）に閉じ、
        dev ビルド限定で env から差し替えられるようにする。**
        自走検証が実 `safeStorage` に触ると `SecurityAgent` が上がって**検証が永久に止まる**
        （このリポジトリで既に踏んだ。前提セクション参照）。
        `live-folders/token.ts` の `NEMO_GITHUB_TEST_AUTH` と同じ作法にする
    - [x] 差し替え backend は「Keychain に触らない」変換と「利用不可」を模す 2 通りを持つ
    - [x] **`!app.isPackaged` を必須ゲートにする。** このリポジトリは
          パッケージ済みの dev 版も配っているので、env だけを条件にすると
          **実運用のパスワードが Keychain を使わない形式で保存されうる**。
          パッケージ版では env を無視することをテストで固定する
    - [x] テスト backend の形式は**固定ヘッダ + checksum を持ち、改変されたら必ず復号エラー**になる
          決定的な形にする（base64 や XOR だと暗号文を壊しても例外にならず、
          「1 件だけ無効化」の検査が空振りで PASS する）
- [x] `src/main/index.ts` に配線する（既存ストアの作法に合わせる）
  - [x] `initHttpAuthStore()` を認証ハンドラ・IPC 登録より**前**に呼ぶ
  - [x] `closeHttpAuthStore()` を終了処理に足す（`JsonStore` はデバウンス保存なので、
        flush しないと直前の変更が落ちる）
- [x] `src/shared/types.ts` に `HttpAuthRule`（パスワード抜き）を追加

### Phase 3: main の認証ハンドラ [AI🤖]

- [x] `src/main/http-auth.ts` を新設（Electron 依存の薄い層）
  - [x] `pendingNavigation: WeakMap<WebContents, string>`
    - [x] `did-start-navigation`（`isMainFrame && !isSameDocument`）で立てる
    - [x] **メインフレームの `did-redirect-navigation` でも遷移先 URL に更新する。**
          サーバー側 302 は `did-start-navigation` では通知されないので、
          `http://x` → `https://x` → 401 のような経路で pending が旧オリジンのまま残り、
          **自動入力も保存も拒否される**（`http` → `https` の 301 は日常的に踏む）
    - [x] **`did-navigate` / メインフレームの `did-fail-load` / 破棄 で消す。**
          消し忘れると、B への遷移が失敗して A に留まったあと、
          A のページが出す B のサブリソース認証を「遷移中の B」と誤認し、
          同一オリジン制約をすり抜ける
    - [x] ただし**イベントの URL が現在記録している pending と一致するときだけ**消す。
          無条件に消すと、B を開いた直後に C へ遷移したときに
          B の失敗イベントが C の pending を消し、正しい自動入力がダイアログに退行する
  - [x] `attempts: Map<string, number>`
    - [x] キーは `${wc.id}|${scheme}|${details.url}`。**`details.url` を含めるのが要点**で、
          `host:port + realm` だけにすると**同じページ内で並列に飛ぶ 401
          （画像・API を同時取得）が「2 回目＝拒否された」と数えられて**
          正しい資格情報でもダイアログに落ちる
    - [x] `did-start-navigation` と webContents の破棄でその webContents 分を掃除する
  - [x] **protection space（`wc.id` + `scheme` + origin + realm）単位の直列化。**
        **キーに `ruleId` を含めない** —— HTTP の protection space はルール単位ではないので、
        含めると**同じ origin / realm でも勝つルールが違う URL が別キューになり、
        並列に送信されてアカウントロック回避を迂回する**。
        採用した rule ID はキーではなく `inflight` の値として持つ。
        `attempts` はリクエスト URL 単位なので、これだけだと
        **並列に飛ぶ初回 401 の数（＝保護サブリソースの数）だけ同じ誤パスワードを送る**。
        アカウントロック回避が成立しない
    - [x] `inflight: Map<key, Deferred>` — その protection space で自動入力を送るのは
          **同時に 1 件だけ**。後続の `login` は `callback` を保留してキューに積む
    - [x] **キューの各要素は自分自身の照合結果（勝った rule ID）を持つ。**
          解放時に配るのは**先頭と同じ rule ID が勝った要求にだけ**。
          別のルールが勝った要求と `no-rule` の要求は**自動入力せず手動ダイアログへ回す**。
          キーだけで一律に配ると、**ルール A にマッチしない URL B へ A の資格情報を送る**
          ことになり、パターンによる適用範囲そのものが壊れる
    - [x] **成功の判定はタイマーではなく実際の応答で行う。**
          `webRequest.onResponseStarted`（対象 WebContents のセッション）で
          その URL が 401 以外で返ったことを確認してから解放する。
          時間経過は成功の証拠にならず、応答の遅いサーバーでは
          **タイマー満了後に失敗が届き、待機中の全員へ誤資格情報を送る**
    - [x] 拒否（同じ URL で 2 回目の `login`）なら `denied` に入れてキューを解く
    - [x] **ダイアログは「照合結果のグループ」ごとに 1 つ。**
          待機中の callback を*勝った rule ID*（`no-rule` は 1 グループ）でまとめ、
          **グループ内は 1 ダイアログに集約し、回答はそのグループにだけ配る**。
          protection space 全体で 1 つにすると、先頭ルールが拒否されたときに
          **その手入力を別ルール・`no-rule` の URL にも送ってしまう**。
          逆に集約しないと、既存の `ask` は要求ごとに直列表示するので
          **保護リソースの数だけ同じダイアログが出て**、
          1 件目で直しても残りが消えず #6 の自己修復が壊れる
    - [x] **回答を受けたら、まず callback 群を `inflight` からローカルへ切り離す。**
          そのあとの保存は #19 の「資格情報変更 → `inflight` 全消し」を呼ぶので、
          切り離していないと**配る相手を自分で消してしまう**
    - [x] **配布は `finally` で行い、保存の成否に依存させない。**
          即時 flush が失敗しても、入力された資格情報（またはキャンセル）は必ず全員に配る。
          保存失敗が**ページの認証そのものを失敗させてはいけない**
    - [x] watchdog（応答も 2 回目の `login` も来ないまま一定時間経過）は
          **成功に倒さず、ダイアログに倒す**（前提の「諦め方は Nemo のダイアログの一択」に揃える。
          無言キャンセルにはしない）。
          **待ち時間は名前付き定数にし、検証から短縮できるようにする**
    - [x] `denied: Set<string>` — 拒否が確定した protection space（**キーは `inflight` と同じ**）。
          **以後そのタブではそこへ自動入力しない。`did-start-navigation` では消さない**
          （消すとリロードのたびに誤パスワードが再送される）。
          消えるのは**資格情報の変更**と**WebContents の破棄**のときだけ
    - [x] `attempts` は従来どおり `did-start-navigation` と破棄で掃除する
    - [x] **WebContents の `destroyed` で、その wc のキューを明示的にキャンセルする。**
          保留 callback を解決し、watchdog タイマーと資格情報への参照を破棄する。
          やらないと**閉じたタブ由来のダイアログ**をタイマー満了時に出しに行く
  - [x] `resolveCredential({ contents, url, authInfo, isPrivate })` —
        **結果を判別可能な union で返す**（全部 `null` にすると後段が
        `rejected` / prefill / `canSave` を作り分けられず、
        シークレットで保存済みルールを読み直す実装にもなりうる）
    - [x] `autofill` … 自動入力する
    - [x] `rejected` … 適格だが、そのリクエストで 2 回目、または `denied` に入っている。
          **prefill はここにだけ載せる**
    - [x] `no-rule` … 適格だがマッチするルールが無い
    - [x] `ineligible` … `evaluateEligibility` が落とした（プロキシ / 非 Basic /
          シークレット / クロスオリジン）。**ルールを読みにも行かない**
- [x] `src/main/security.ts` の `installAuthHandler` を改修
  - [x] `_details` → `details` にして `details.url` を使う
  - [x] **タブの厳密解決に `findTabByWebContents`（`registry.ts:1821`）を使う。**
        今 `installAuthHandler` に渡している `findWindowIdForPageContents` は
        タブでない WebContents を**フォーカス中のウィンドウにフォールバック**するので
        （`registry.ts:1817`）、シークレット判定を取り違える。
        **タブとして解決できない WebContents では自動入力しない**（従来どおりダイアログ）
  - [x] **宛先の解決は二段にする。** 自動入力の可否判定には strict な
        `findTabByWebContents` を使い、**手動ダイアログの宛先には従来どおり
        `findWindowIdForPageContents`** を使う。strict 版の `null` をそのまま返すと
        既存の `if (windowId === null) return` に落ちて**認証キャンセルになりダイアログが出ない**
  - [x] ルールが引けたら `callback(username, password)` して `log('auth.autofilled', {...})`
  - [x] 引けなければ従来どおり `ask(...)`。**保存済みルールがあれば prefill 用の情報を渡す**
- [x] `src/main/index.ts` で `installAuthHandler` の呼び出しを新しいシグネチャに合わせる
- [x] `did-start-navigation` のリスナーを webContents 生成時に張る
      （`registry.ts` の既存の `wc.on('did-navigate', ...)` の並びに置く）

### Phase 4: ダイアログ（保存と prefill） [AI🤖]

- [x] `src/shared/types.ts` の `AuthPrompt` を拡張
  - [x] `canSave: boolean` — **`resolveCredential` の除外条件と同じ判定を共有する**
        （暗号化可 / 通常タブ / 非プロキシ / Basic / 同一オリジン）。**リトライ回数だけは見ない**。
        ここを暗号化とシークレットだけにすると、プロキシ・非 Basic・クロスオリジンでも
        保存チェックが出て、**保存しても次回自動入力されないルール**ができる
  - [x] `prefill?: { username: string; password: string }`（拒否された保存済みルールがある場合）
  - [x] `rejected: boolean`（文言の出し分け用）
- [x] `PromptAnswer` の `{ kind: 'auth' }` に `save: boolean` を足す
- [x] `src/renderer/components/PromptDialog.tsx` の `AuthPrompt` を改修
  - [x] 「次回から自動で入力する」チェックボックス（**既定 OFF**）。`canSave` が false なら出さない
  - [x] `prefill` があれば入力欄を埋め、
        「保存されている資格情報が拒否されました」と出す
  - [x] **`prompt.id` を key にして再マウントする。** 認証ダイアログが連続すると
        React が同じコンポーネントを使い回し、前のホストの入力値とチェック状態が
        次のホストに残る
- [x] `security.ts` 側で `save: true` を受けたときの保存先
  - [x] **`rejected` なら、採用されたルールの username / password を更新する。**
        `rejected` に rule ID を載せて渡す。ここで `patternFromUrl` から新規作成すると、
        ワイルドカードやインポート済みのルールを直しても**元ルールが残り、
        別 URL では再び誤った資格情報が飛ぶ**（#6 の自己修復が成立しない）
  - [x] **`no-rule` のときだけ** `patternFromUrl(details.url)` で新規作成する
        （同じパターンがあれば上書き）
  - [x] **保存に失敗したら Nemo の UI で知らせる。** この時点では callback に
        資格情報を渡しただけで**認証成功はまだ確定していない**ので、文言は
        **「保存できませんでした（認証は続行中）」**にする。
        「認証は通ったが保存できなかった」と出すと、誤った資格情報のときに
        直後の拒否ダイアログと矛盾する。
        黙って落とすと、チェックを付けた本人は保存済みだと思ったまま
        再起動後に同じ入力を求められる
    - [x] **新しい通知基盤は作らない。** 既存の `ask` / `PromptDialog` に
          **情報表示だけの prompt 種別を 1 つ足して**出す
          （`PromptAnswer` は確認のみ。renderer 側の追加は `PromptDialog.tsx` に閉じる）
  - [x] **保存条件は main が保持する `eligibility.canSave && answer.save`。**
        `answer.save` だけを信じると、renderer の不具合や改変された IPC から
        プロキシ・シークレット・クロスオリジンの資格情報も保存できてしまう。
        チェックボックスを出さないことは認可にならない

### Phase 5: Settings の管理 UI [AI🤖]

- [x] `src/main/ipc.ts` に IPC を追加（すべて `requireWindow` を通す）
  - [x] `nemo:list-http-auth-rules` — パスワードを含まず、
        **`safeStorage` の利用可否も一緒に返す**（renderer が保存を試す前に案内を出せるように）
  - [x] `nemo:reveal-http-auth-password`（1 件だけ。`log('auth_rule.revealed', { id })`）
  - [x] `nemo:save-http-auth-rule` / `nemo:delete-http-auth-rule`
    - [x] **password を省略したら既存の暗号文を保持する** patch semantics にする。
          一覧は password を持たないので、これが無いと
          「pattern だけ編集したら空パスワードで上書き」か
          「編集のために renderer へ平文を返す」のどちらかになる
  - [x] `nemo:import-multipass`（JSON テキストを受け、取り込み結果と警告を返す）
    - [x] **取り込み全体を 1 回のトランザクションで永続化し、そのあと #19 の共通後始末を通す。**
          通さないと、同じパターンを上書きしても HttpAuthCache が古い資格情報を送り続け、
          **インポート結果が同一セッションに反映されない**。後始末の結果も IPC で返す
  - [x] `nemo:test-http-auth-pattern` — **URL 群を受け、保存済みルール全体に `matchRules` を当てて
        URL ごとの「マッチした ID 群」と「勝者」を返す**（編集中の未保存パターンも足して照合できる形）。
        優先順位のロジックを renderer に再実装させないための形。正規表現の実行は main に閉じる
  - [x] 保存・テストの入口で `validateHttpAuthPattern`（Phase 1）を通す
- [x] `src/preload/ui.ts` と `types.ts` の `NemoApi` に追加
- [x] `src/renderer/components/Settings.tsx` に `<h3>HTTP 認証</h3>` を追加
      （既存の「GitHub の Pull Request」「拡張」の並びに置く）
  - [x] 一覧: パターン / ユーザー名 / パスワード（`***` + 「表示」ボタン）/ 有効トグル / 削除
  - [x] **自動無効化されたルールは理由を表示する**（`disabledReason`）。
        原因のフィールド（pattern / password）を直せば理由が消えて再び有効にできることを
        画面上でも分かる形にする
  - [x] 自動変換されたルールには**変換元（`importedFrom`）を表示する**
        （黙って変換する方針なので、ここが唯一の追跡手段）
  - [x] **複数マッチの表示はテスターの中で行う**: 入力した URL に複数のルールがマッチしたら
        「この URL には X が使われます」と出す（ルール同士の静的な突き合わせはしない）
  - [x] パターンの編集（保存時に `new RegExp` で検証し、壊れていれば弾く）
  - [x] **ユーザー名の編集**と、それとは独立した**「パスワードを変更」状態**を持つ
    - [x] 通常は password を**送らない**（IPC の patch semantics で既存の暗号文を保持）
    - [x] 「パスワードを変更」を押したときだけ入力欄を出し、**その値を送る**
    - [x] **空文字は有効な新パスワード**として扱う。
          単なる空欄で「未変更」と「空に変更」を区別しようとすると必ず取り違える
  - [x] 正規表現テスター（パターン + URL 群 → マッチをハイライト）
  - [x] MultiPass の JSON を貼り付けるインポート欄
        （取り込み件数 / 拒否されたパターンと理由 / priority の一括警告を表示）。
        **成功したら textarea を直ちに空にする**（全資格情報の平文が貼られたまま残らないように）。
        Settings を閉じるときにも破棄する
  - [x] 「表示」したパスワードは、**Settings を閉じたとき / 別のルールを表示したとき /
        表示から 30 秒**で再マスクする。**再マスクは表示の切り替えではなく
        renderer の平文 state 自体を消す**（CSS で隠すだけだと取得済みの平文が残る）。
        **タイマーの長さは検証から短縮できるようにする**（E2E で実時間 30 秒を待たない）
  - [x] `safeStorage` が使えない環境では「この環境では保存できません」を出す

### Phase 6: 検証 [AI🤖]

**まず「実装前のコードで FAIL すること」を `git stash` で確認してから通す。**

- [x] `scripts/test-server.mjs` に 401 を返す経路を追加
  - [x] `/__nemo_basic_auth__?user=<u>&pass=<p>` — `Authorization` が一致しなければ
        `401` + `WWW-Authenticate: Basic realm="Nemo Test"`、一致すれば `200` に固定文字列
  - [x] サブリソース版（画像を 401 で返す `<img>` を含むページ）も置く（#10 の検証用）
- [x] `scripts/verify-http-auth.mjs` を新設（使い捨ての `NEMO_USER_DATA_DIR` で起動する）
  - [x] **ルール無し** → `prompt-auth` が出ること
  - [x] **ルール有り** → ダイアログが出ずに 200 が描画されること
  - [x] **間違ったパスワードのルール** → **2 回目でダイアログに落ちること**。
        実際の試行回数をアサーションの詳細に出す（回数を素通りして PASS しないように）
  - [x] **誤パスワードのルールで、保護されたサブリソースを複数持つページを開いても
        資格情報の送信は 1 回だけであること**（直列化の検査。
        サーバー側で受けた `Authorization` の回数をアサーションの詳細に出す。
        並列数が 1 だと空振りするので**リソース数が 2 以上であることも示す**）
  - [x] **拒否されたあとリロードしても再送されないこと**（`denied` を
        `did-start-navigation` で消していないことの検査。ここを消す実装だと
        リロードのたびに誤パスワードが飛ぶ）
  - [x] ダイアログが prefill され、直して再保存すると次回から通ること
  - [x] **異なるホストの認証ダイアログを連続で出し、2 件目に 1 件目の入力値と
        保存チェックの状態が残らないこと**（`prompt.id` を key にした再マウントの検査。
        「ダイアログ無し → 拒否ダイアログ」の経路だけでは通らない）
  - [x] **Settings を実操作する検査**（ダミーの MultiPass JSON を使う）:
        一覧表示 / インポート結果と priority 警告 / validator に弾かれる
        パターンのエラー表示 / テスターの勝者表示 / `importedFrom` の表示 /
        パスワードの「表示」と、**3 つの再マスク経路すべて**
        （閉じたとき / 別のルールを表示したとき / タイマー。
        タイマーは短縮した長さで撃つ）
  - [x] **編集の 3 経路**: ユーザー名だけ編集して**パスワードが消えないこと** /
        「パスワードを変更」で**空文字に変更**できること / 通常の変更が次回の認証に効くこと
        （いずれも編集後に実際に認証を通して確かめる）
  - [x] **敵対的な正規表現をルールとして登録しても UI が固まらないこと**:
        照合がタイムアウトしてダイアログに落ち、**そのルールだけ**が無効化され
        Settings に理由が出ること（ワーカー隔離の検査。main で走らせる実装なら
        ここでハングする。**正常なルールが巻き添えで消えていないことも示す**）
  - [x] **ワーカーが落ちても pending が残らないこと**: タイムアウト直後に
        認証と Settings のテスターを同時に走らせ、どちらも応答が返ること
  - [x] **テスターで敵対的パターンを試しても、保存済みルールが無効化されないこと**
        （`runtime` / `tester` の区別の検査）
  - [x] **同じ origin / realm で勝つルールが異なる URL を並列に踏んでも、
        資格情報の送信は 1 回だけであること**（直列化キーに `ruleId` を入れた実装なら
        2 回飛んで FAIL する）。あわせて **URL B にルール A の資格情報が
        送られていないこと**をサーバー側で受けた `Authorization` の中身で確かめる
        （送信回数だけを見る検査では、宛先違いを見逃す）
  - [x] **先頭ルールが拒否されたあと、ダイアログに手入力した資格情報が
        別ルール・`no-rule` の URL へ配られないこと**（グループ分離の検査）
  - [x] **認証ダイアログが出ている最中にタブを閉じても、
        あとからダイアログが出てこないこと**（watchdog の残留検出）
  - [x] **誤パスワードで拒否されたとき、認証ダイアログが 1 つだけ出ること**
        （保護サブリソースが複数あるページで。ダイアログ集約の検査。
        出た件数をアサーションの詳細に出す）
  - [x] **URL 長の上限を超えるリクエストでは自動入力されず、保存チェックも出ない**こと
  - [x] **クロスオリジンのサブリソース 401 では自動入力されない**こと
  - [x] **`canSave: false` の状況で `save: true` を送ってもルールが作られないこと**
        （renderer を経由せず `answerPrompt` の IPC に直接投げる。
        チェックボックスを隠すだけの実装ならここで FAIL する）
  - [x] **同一オリジンの 401 が並列に複数飛んでも**すべて自動入力されること。
        **リクエスト URL は互いに異なるものにする** —— 試行キーが
        `(wc.id, scheme, details.url)` なので、*同一 URL* への並列リクエストは
        仕様どおり 2 回目でダイアログに落ちる（アカウントロック回避を優先した結果）
  - [x] **サーバー側 302 で別オリジンへ飛んだ先の 401** がダイアログなしで通ること
        （`did-redirect-navigation` の付け忘れ・メインフレーム判定ミスは
        これが無いと既存の検査を全部通過してしまう）
  - [x] **クロスオリジンへの遷移が失敗した直後**、元ページのサブリソース 401 で
        遷移先のルールが使われないこと（`pendingNavigation` の消し忘れ検出）
  - [x] シークレットウィンドウでは自動入力されないこと
  - [x] キャッシュ消去に失敗させても**保存は成立し、`authCacheCleared: false` が返る**こと
  - [x] **書き込みに失敗させたら IPC がエラーを返すこと**（保存先を書けない状態にして撃つ。
        デバウンスのまま `void` を返す実装ならここで「成功」が返って FAIL する）
  - [x] **その直後の一覧に失敗した変更が現れず、書けるように戻して別のルールを保存しても
        失敗分が混入しないこと**（メモリへ先に commit する実装ならここで FAIL する）
  - [x] **その保存失敗時でもページの認証は完了し、かつ保存失敗が UI に出ること**
        （ダイアログの回答は待機中の callback に配られる。保存と配布を直列にした
        実装ならここでハングし、通知が無い実装なら保存失敗が黙殺される）
  - [x] **複数のルールを同時に保存しても両方残ること**（トランザクションを
        直列化していない実装なら片方が消えて FAIL する）
  - [x] **自動無効化の理由が再起動後も表示されること**、
        **理由がある間は有効トグルが効かないこと**、および
        **pattern / password を直すと理由が消えて再び有効にできること**（両方の理由で）
  - [x] **削除だけでなく、有効トグルと資格情報の編集でも**認証キャッシュが破棄され、
        同じセッションで再チャレンジが起きること
        （**いずれも操作前に 1 回認証を通しておく**。共通処理の呼び忘れはここでしか出ない）
  - [x] 資格情報を編集したあとの再チャレンジは、**リロードせず同じ document から
        `fetch` を撃って**起こす。リロードすると `did-start-navigation` が
        `attempts` を消してしまい、**集約が片方しか実装されていなくても PASS する**
- [x] ストアの失敗経路を検証する（**まっさらな状態からの検証では一度も通らない経路**）。
      **実 `safeStorage` には触らず、Phase 2 の差し替え backend で回す**
      （触ると `SecurityAgent` が上がって検証が永久に止まる。前提セクション参照）
  - [x] **fixture は静的に置かず、その実行の中で作る**（2 件保存 → 1 件だけ暗号文を壊す）
  - [x] 壊した 1 件だけが無効化され、**もう 1 件は生きている**こと
        （壊す前に 2 件読めていたことも示す。最初から 0 件では空振りで PASS する）
  - [x] 一覧を返す IPC のペイロードに **password が一切含まれない**こと
  - [x] 再起動後も読み直せること
  - [x] 「利用不可」backend では保存を断り、平文が書かれないこと
- [x] `scripts/verify-all.mjs` に `verify-http-auth.mjs` を登録
- [x] `scripts/log-redact.test.mjs` に、ルール形の detail を渡してパスワードが
      `[redacted]` になる回帰テストを足す
- [x] `npm run lint` / `npm run typecheck` / `npm test`

### 動作確認 [人間👨‍💻]
- [ ] 実際に使っている Basic 認証のサイトで、ダイアログ → チェック → 次回自動入力を確認。
      **保存したあと Nemo を完全に終了して起動し直してから**アクセスする ——
      同じセッションのままだと HttpAuthCache が答えてしまい、
      **保存したルールも実 `safeStorage` の復号も一度も通らない**
      （自走検証はテスト backend で回すので、本番の暗号化経路はここでしか通らない）
- [ ] MultiPass のエクスポート JSON をインポートし、**変換後のパターンが意図どおりか
      Settings の一覧で確認**（黙って変換する方針なので、ここが唯一の確認機会）
- [ ] ワイルドカードが要るルールを Settings で広げ、テスターで確認してから実際に踏む
- [ ] **パッケージ済みの dev 版**で、通常の照合が効くこと・敵対的パターンで
      タイムアウト → ワーカー再生成が起きることを 1 回ずつ確認する。
      ~~electron-vite の worker artifact のパス解決は開発起動では通って
      **asar から起動できずに全ルールが不一致になる**ことがある~~
      → **ワーカーは `{ eval: true }` でソース文字列から起こす**ことにしたので
      パス解決の経路そのものが無い（ログ > 方針変更）。それでも
      `worker_threads` が配布形態で動くかは実物でしか確かめられないので、この確認は残す
- [ ] **`http-auth.json` に平文のパスワードが無いこと**を目で見る。
      自走検証は実 `safeStorage` に触らないので、実際の暗号化経路はここでしか確認できない
      （`VERIFY.md` の PAT と同じ作法）

      ```bash
      cat "$HOME/Library/Application Support/Nemo-dev/http-auth.json"
      # → password は base64 の暗号文だけ。入力した文字列が現れないこと
      ```

## ログ
### 試したこと・わかったこと

- **Chromium はクロスオリジンのサブリソースに認証チャレンジを出さない。**
  `login` イベント自体が飛ばないので、「クロスオリジンではダイアログになる」を
  検査しようとすると `waitDialog()` が永久に成立しない。検査は
  **「資格情報が送られていないこと」だけ**に絞った（同一オリジン制約は二重の守り）。
- **204 でのナビゲーション中断は `did-fail-load` を出さない。**
  Electron の `loadURL` も `did-stop-loading` 経由で `ERR_FAILED` を返してくる。
  イベントだけで `pendingNavigation` を消す実装では消し残り、
  元ページに留まったあと**同一オリジンのサブリソースがクロスオリジン扱いになって
  正しい自動入力がダイアログに退行する**（自走検証が実際にこれを捕まえた）。
  → `contents.isLoadingMainFrame()` を条件に加え、読み込みが止まっていれば
  常に `getURL()` を使う形にした。
- **接続断（`res.destroy()`）ではエラーページが commit されるので「元のページに留まる」を作れない。**
  検証用の中断は 204（`/__nemo_no_content__`）を使う。
- **`HttpAuthCache` は Basic をディレクトリ単位で先読み送信する。**
  検証のリソースを `/__nemo_basic_auth__/<グループ>/<名前>` と掘っていないと、
  一度通した資格情報が次の検査のリクエストに勝手に付いて「401 が来ない」になる。
- **フル検証の switcher / call が 1 回だけ 6 件 FAIL したが再現しなかった。**
  同条件の `--only switcher call restart` は変更ありでも 0 FAIL、
  変更を stash したフルも 0 FAIL、もう一度フルを回して 709 PASS / 0 FAIL。
  この間、別セッションがこのリポジトリの `docs/plans/` を触っていた（`git stash pop` が
  「上書きされる」と言って気づいた）ので、外からの干渉の可能性が高い。
  **1 回の FAIL で原因を決め打ちせず、ベースラインと絞り込みの両方を取ってから判断した。**
- **1 つの検査で複数のダイアログが出るのは正しい挙動**（別ルール・別 URL には別々に聞く）。
  片付けずに次へ進むと次の `waitDialog()` が**前のダイアログを見て即 PASS する**。
  `drainDialogs()` を各検査の前後に挟んで初めて 4 件の偽 PASS / 偽 FAIL が表に出た。

### 方針変更

- **ダイアログ保存の直後だけ、配った URL の `attempts` を 1 に戻す**（#19 の但し書き）。
  `httpAuthCredentialsChanged()` の全消しと `deliver` が連続するため、
  打ち直したパスワードも間違っていると**同じ値が 2 回飛ぶ**。
  自走検証で実測してから直した（修正前: `["u:wrong1","u:wrong2","u:wrong2"]` →
  修正後: `["u:wrong1","u:wrong2"]`）。
  **`denied` を残す案は採らない** —— protection space 単位なので、正しく直したあとも
  同じタブの別パス階層で 401 が出るたびにダイアログが出続ける
  （Chromium の認証キャッシュはパス接頭辞単位なので実際に起こる）。
- **`evaluateEligibility` に `isTab` を足し、`not-a-tab` を独立した理由にした**（#14 の但し書き）。
  当初は `isPrivate: ctx.isPrivate || !ctx.isTab` と畳んでいたが、
  理由を診断ログに出すことにしたので、ログが「シークレットだった」と嘘をつく形になる。
  挙動（どちらも自動入力しない）は変えていない。

- **照合ワーカーは別ファイルではなく `{ eval: true }` のソース文字列から起こす。**
  計画は electron-vite の worker artifact を想定していたが、
  「asar からワーカーを読めずに全ルールが不一致になる配布版」というリスクを
  **読み込み経路ごと無くす**方が確実。ソースは
  `src/shared/http-auth-worker-source.js` に文字列で置き、
  `matchRules`（同期の純粋関数）と判定が食い違わないことを
  **実際にワーカーを起動する単体テスト**で固定した。
- **ダイアログのグループ分けは `ruleId` ではなく `groupId` で行う。**
  拒否された要求を `no-rule` グループに落とすと、
  同じルールで拒否された仲間と別のダイアログになり、
  保護リソースの数だけダイアログが出る（#6 の自己修復が壊れる）。
  自動入力の成功時の配布は従来どおり `ruleId` で分ける（2 つを別フィールドにした）。
- **`isSameOrigin` は `security.ts` の `normalizeOrigin` を移さず、
  `shared/http-auth-rules.js` に `normalizeHttpOrigin` / `isSameHttpOrigin` を新設した。**
  `normalizeOrigin` は permission の記憶（`permissions.json` のキー）に使われていて、
  移すと権限まわりの回帰面が広がる。実装は同じ 6 行で、
  こちらは「about:blank を同一オリジンにしない」ことを単体テストで固定している。
- **失敗経路の差し込みは env ではなくマーカーファイル**
  （`.nemo-fail-auth-cache-clear` / `.nemo-crypto-unavailable`）。
  env だと起動から終了まで効きっぱなしで、同じ起動で回している他の検査を巻き添えにする
  （＝それらが偽 PASS になる）。
- **照合のタイムアウト（250ms）は `NEMO_VERIFY_TIMINGS` に載せない。**
  縮めると「どのルールがタイムアウトするか」＝判定の中身が変わる。
  代わりに検証は**既定値のまま超える敵対的パターン**（連続する量化子）を撃つ。
  再マスク（`httpAuthRevealMs`）と直列化の watchdog（`httpAuthWatchdogMs`）は載せた。
- **`resolveSecretBackendMode` を `shared/http-auth-rules.js` に置いた。**
  置き場所としてはやや異物だが、「パッケージ版では env を無視する」を
  `node --test` で固定できるのはここだけ（main の TS は直接叩けない）。
- **`nemo:save-http-auth-rule` は採番した `id` を返す。**
  返さないと renderer も検証も「今保存したルール」を指せず、
  自動無効化の理由や patch semantics の検査が書けない。
