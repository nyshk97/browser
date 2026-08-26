# GitHub Pull Requests の Live Folder（サイドバーの自動更新セクション）

## 概要・やりたいこと

サイドバーに **自分に関係する Pull Request が勝手に並び、勝手に消える**セクションを作る。
中身は「自分にレビュー依頼が来ている PR」と「自分が作った未マージの PR」の2つ。

Arc の Live Folder に相当する機能で、乗り換えの障害になっている。
今は PR を追うために GitHub のタブを開きっぱなしにするか、通知メールを見るしかない。

**期間で絞らず、放置している古い PR も出す**のが今回の方針（後述）。
件数は各検索の**先頭 100 件まで**出し、それを超えたぶんは黙って落とさず明示する。

## 前提・わかっていること

### Arc の実装（バイナリ調査で確定）— **これは採らない**

`/Applications/Arc.app/Contents/MacOS/Arc` の `strings` にソースパスごと残っていた。
`Frameworks/ARCClients/Sources/GitHubClient/GitHubClient+PullRequestsParsing.swift` など。

**Arc は GitHub API を使っていない。** `api.github.com` の文字列が 0 件で、代わりに
**ログイン済み Cookie を持ったブラウザで github.com の HTML を読み、パースしている**。

- 入口は `https://github.com/pulls?q=<検索クエリ>`。クエリ文字列がそのまま埋まっている:
  `is:pr updated:>=… sort:updated-desc` に `review-requested:@me` /
  `user-review-requested:@me involves:@me` / `author:@me involves:@me` /
  `review:approved involves:@me` / `review:changes_requested involves:@me` を組み合わせる
- **一覧のパーサが2系統ある**。新 UI は `<script type="application/json">` の
  `pullsDashboardSurfaceLayoutRoute` / `pullsDashboardSurfaceContentRoute` を JSON として読み、
  旧 UI は XPath（`.js-active-navigation-container`、`a[data-hovercard-type='pull_request']`）で
  DOM から拾う。`prefersJSONByContext` で「どっちが取れたか」を文脈ごとに記憶している
- **PR 個別の詳細は、裏で PR ページを開いて JS を注入**して取る。その IIFE がバイナリに丸ごと入っており、
  `section[aria-label="Conflicts"]` や
  `.js-resolvable-timeline-thread-container[data-resolved="false"]` を見て
  `data-pr-has-conflicts` / `data-pr-has-unresolved-conversations` という span を合成し、
  必要な要素だけの小さな HTML を返す → Swift 側の Fuzi（libxml2）でパースする
- CI は `page_data/status_checks`、著者は hovercard エンドポイント。
  独自ヘッダ `GitHub-Verified-Fetch` / `X-Requested-With` を付けている
- エラーモデルがスクレイプ前提そのもの: `unexpectedPageStructure` / `unableToGrabHTML` /
  `needsSingleSignOn`（`[data-testid='global-sso-banner']` を検出）/ `rateLimitExceeded` /
  `requestedTooSoon` / `missingWebContentForPullRequest`
- 保存先は `~/Library/Application Support/Arc/StorableLiveData.json`

**採らない理由**: GitHub の DOM が変わるたび壊れる。Arc 自身が新旧2系統のパーサと
「どちらが取れたか」の記憶を抱えているのが、その維持コストの証拠。
「セットアップ不要」と引き換えに、GitHub Enterprise 非対応・SSO で停止という制約も付く。

### Arc の更新頻度（20分の実測。`StorableLiveData.json` の mtime）

```
19:04:48 → 19:05:48 → 19:06:50   (約60秒間隔)
19:06:50 → 19:10:58              (4分の空白)
19:12:59 → 19:18:45              (6分の空白)
19:18:45 → 19:19:00 → 19:20:19 → 19:20:45 → 19:21:26 → 19:22:45 → 19:23:42
                                 (15〜80秒でばらつく)
```

固定間隔ではない。密集と空白が交互に来るのは、**一覧の取得が分オーダーで、そのあと
PR 1件ごとの詳細スクレイプが終わるたびに書き足している**ため。
Nemo は GraphQL 1発で詳細まで揃うので、この小刻みな書き込みは起きない。

### GraphQL で完全に代替できる（実測済み・再調査不要）

`gh api graphql` で実行。**1リクエスト・コスト 1**（この形のまま実測。`remaining` 4999/5000）。

```graphql
query {
  viewer { login }
  reviewRequested: search(query: "is:open is:pr review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 100) {
    issueCount  nodes { ...pr }
  }
  mine: search(query: "is:open is:pr author:@me archived:false sort:updated-desc", type: ISSUE, first: 100) {
    issueCount  nodes { ...pr }
  }
  rateLimit { cost remaining resetAt }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt reviewDecision
  author { login }
  repository { nameWithOwner }
}
```

**両方のクエリに `sort:updated-desc` を入れる。** これが無いと GitHub の既定順（best-match）で
返るので、**100 件で切られたときに「どの 100 件が残るか」が不定**になる。
取得後に `updatedAt` で並べ替えても、**取得されなかった PR は救えない**。
切り捨てる対象を「更新が古いもの」に決め打ちするために、検索側で並べる必要がある。

**`commits.statusCheckRollup` は取らない。** CI の状態は表示しない仕様（状態バッジは
approved / changes-requested / draft / waiting の4種）なので、使わないものを取っても
レスポンスが重くなるだけ。

**`first` は `search` の上限である 100 にする**（当初 20 で試したが、
「全部出す」方針と矛盾するので上げる）。**ページングはしない**。
自分に関係する open PR が 100 件を超えるのは平常時ではありえず、
仮に超えてもサイドバーに 100 行出ている時点で一覧として機能していないため。

ただし **黙って切らない**。`issueCount` を必ず取り、`issueCount > nodes.length` のときは明示する。

**打ち切りは検索ごとに別々に起きる。** `reviewRequested` と `mine` はそれぞれ 100 件で切られ、
両方が超えることもある。しかも重複 PR を `review` 側へ寄せるので、
**表示全体の合計に対して「100 / 137」と言うことはできない**。
→ `truncation: { review: {returned,total} | null, mine: {…} | null }` として**検索単位で持つ**。

**数え方が3つあるので、混ぜずに別々に持つ。** これは指摘が3巡続いたところなので、
表示の書き方をいじるのをやめて**データの側で分ける**。

| 名前 | 意味 |
|---|---|
| `rendered` | そのグループで**実際に描画する行数**（`mine` は重複除外後なので 95 になりうる） |
| `search.returned` | その検索が返した件数（100） |
| `search.total` | その検索の総ヒット数（`issueCount`。137） |

`95 of 137` は**この3つのうち2つを混ぜた表記**で、95 は重複除外後・137 は重複込みの
検索ヒット数なので、「137 件中 95 件を表示」は成り立たない。

- **小見出しの右には `rendered` だけ**を出す（`CREATED   95`）。
  ここは常に「下に何行あるか」を意味する。他の意味を持たせない
- 打ち切りは**末尾の状態行の下に別の1行**として出す:
  `First 100 of 137 fetched for CREATED`。両方切られていれば2行出す。
  検索の話は検索の言葉（fetched）で書き、表示行数とは別の場所に置く

GraphQL は 1 リクエストのまま。**コストは「この形のクエリで 1」を実測済み**
（`first: 100` ×2・`sort` 付き・`rollup` 無しで `rateLimit.cost` が 1、`remaining` 4999）。

ただし**実際に 100 件返る状況では未実測**（手元の実データは各 5 件）。
GitHub のコストはノード数で増えうるので、100 件が並ぶアカウントでは 2 程度になる可能性がある。
仮に 2 でも 60秒間隔で 120pt/h、上限 5000pt/h の 2.4% で問題にならない。
**実装後に `rateLimit.cost` をログへ出して、実データで確かめる**。

取得結果は Arc のサイドバーのスクショと**著者名・Approved バッジまで一致した**
（MOY-964 #17679 draft / MOY-733 #17650 APPROVED / MOY-1037 #11698 APPROVED）。
60秒ポーリングでも 60 req/h。コスト 1〜2 なので上限 5000pt/h の 1.2〜2.4%。

**期間フィルタは入れない。** Arc は `updated:>=` で絞っているが、Nemo では絞らない。
実測で 2024-11 と 2025-10 の放置 draft が2件ヒットする。
これは**忘れている PR が可視化される**ということなので、意図的に出す
（対応漏れを減らす目的。既存の古い PR を整理すること自体は今回のスコープ外）。

### 決めたこと — 見た目

モックで確定: `scratchpad/live-folder-mock-2.html` の**案2（全部出す・親見出しなし）**。

- **位置は Favorites の直下・ピン留めより上**。DESIGN.md の3層に4層目として割り込む
  （`Sidebar.tsx:89` の `.scroll` 先頭、`.label`（ピン留めの見出し）の前）
- 親見出し（"PULL REQUESTS"）は置かず、**小見出し2つだけ**にして階層を1つ減らす。
  区切り線に挟まれた一塊として読ませる
  - 小見出しは既存と同じ作法（10px・大文字・letter-spacing .09em・`--nemo-ink-dim`）。
    語は **`REVIEW REQUESTED`** と **`CREATED`**（大文字は `text-transform` で作る）。
    右端は**描画行数だけ**（打ち切りの表示はここではなく末尾に出す。理由は上記）
  - グループが 0 件ならその小見出しごと出さない。
    両方 0 件のときは `No open pull requests` の1行にする（後述の表示の優先順位）
- **行は 24px の丸アイコン + 2行テキスト**（モック案A のアイコン）
  - アイコンは GitHub マーク。**右下に状態バッジ**（緑✓ = Approved / 黄・ = 要修正 /
    グレー鉛筆 = Draft / **バッジ無し = レビュー待ち**）。バッジの縁は地の色で 2px 抜く
  - 1行目 = PR タイトル（1行で省略）
  - **2行目は文脈で変える**。「レビュー依頼」は**著者名**、「自分の PR」は**リポジトリ名**
    （自分の PR に自分の名前を9回出しても情報がない）
  - 右端に「済」などのチップは**置かない**（状態はバッジだけで出す）
  - 未読ドットは既存タブと同じ `--nemo-accent`
- 表示上の上限や「あと N 件」は設けない。取れたぶんは全部出してスクロールさせる
  （取得側の 100 件上限と、それを超えたときの表示は上記のとおり）
- **セクションの末尾に状態行を置く**（`live-folder-mock-3.html` の案3で確定）。
  10px・`--nemo-ink-dim` の1行で、左に `Updated 3m ago`、右に回転矢印 + `Refresh`。
  **文言は英語で揃える**（小見出しに合わせる。サイドバー内の日本語はタブのタイトルだけになる）
  - 取得中は `Refreshing…` ＋矢印を回す
  - **`transient` のときは `--nemo-danger` で `Couldn't refresh · showing 19:12`** と出し、
    右を `Retry` にして、PR の行を `opacity: .55` に落として古さを示す。
    失敗しても一覧は空にしない方針なので、**この行が無いと古い一覧を最新だと誤読する**
  - **`rate-limit` のときは `Rate limited · retrying in 12m`**。
    行は同じく薄くするが、**`Retry` は出さない**（押しても投げない仕様なので、
    出すと「押せば直る」という嘘になる）。残り時間は `resetAt` から1分ごとに詰める
  - `auth` のときはこの行ではなく `Reconnect GitHub` の1行に置き換わる（表示の優先順位の表）
  - 更新ボタンはセクション全体で1つだけ。小見出し側には置かない
  - `⌘R` はページ再読み込みで埋まっているので、キーボードは割り当てない
  - 右クリックメニューの「いま更新する」も別途入れる

### 決めたこと — 挙動

- **取得は GitHub GraphQL API**。Cookie スクレイプは採らない
- **トークンの優先順位は「設定した PAT」→「`gh auth token`」**。
  明示的に設定したものが必ず勝つ（暗黙の gh が優先すると、PAT を貼っても効かない事故になる）
  - `gh auth token --hostname github.com` で**ホストを固定**する。
    gh に GHE のログインが混ざっていると、既定のアクティブアカウントが GHE 側になりうる
  - gh の現在の scope は `repo` / `read:org` / `gist` / `admin:public_key` で足りる
- **PAT は `settings.json` に置かない。** `SYNCED_FILES`（`sync-schema.js:38`）に
  `settings.json` が入っており、**git で他端末へ同期される**。
  `safeStorage` は端末鍵なので、同期先では復号できない暗号文が配られるだけになる。
  → **同期対象外の専用ストア `github-token.json`** に分ける
  - `safeStorage.isEncryptionAvailable()` が false なら**保存を断る**（平文では置かない）
  - 復号に失敗したら**その場で捨てて「未設定」に戻す**（壊れた暗号文を握り続けない）
  - renderer へは**トークンを返さない**。専用 IPC は
    「保存する」「消す」「いま何が使われているか（`'pat' | 'gh' | 'none'`）」だけを扱う
- **更新は 60秒ポーリング + ウィンドウのフォーカス時に即時 + 手動更新**。
  全ウィンドウが隠れている / スリープ中は止める
- オフラインや失敗のときは**前回の内容を出したまま**静かに再試行する（空にしない）
- **シークレットウィンドウでは出さない。** GitHub の Cookie が無いので、行を押しても
  private な PR はログイン画面になる。`SharedState` を組み立てる時点で
  `isPrivate` なウィンドウには `liveFolder: null` を渡す（データごと渡さない）

### セクションの表示の優先順位

「0 件なら出さない」と「失敗したら出す」が衝突するので、上から順に1つだけ選ぶ。

| 条件 | 出すもの |
|---|---|
| シークレットウィンドウ | 何も出さない |
| 設定で無効（`liveFolderEnabled: false`） | 何も出さない |
| トークン未設定 | `Connect GitHub` の1行だけ |
| `failure.kind === 'auth'` | `Reconnect GitHub` の1行だけ（設定画面へ） |
| `rate-limit`・キャッシュあり | 一覧（薄く） + `Rate limited · retrying in 12m` |
| `rate-limit`・キャッシュなし | 末尾の状態行だけ（`Rate limited · retrying in 12m`） |
| `transient`・キャッシュあり | 一覧（薄く） + `Couldn't refresh · showing 19:12 · Retry` |
| `transient`・キャッシュなし | 末尾の状態行だけ（`Couldn't refresh · Retry`） |
| 成功・0 件 | `No open pull requests` の1行 + 末尾の状態行 |
| 成功・1 件以上 | 一覧 + 末尾の状態行 |

**`kind` を見て分岐し、UI で HTTP ステータスを見ない**（Phase 1 の `classifyFailure()` の結果をそのまま使う）。
`rate-limit` のときは `Retry` を出さない（押しても投げないため。後述）。

**0 件でもセクションごと消さない**（消すと手動更新の導線まで消える）。
消えるのは「シークレット」と「設定で無効」のときだけ。

### タブとの紐づけ — **URL 一致にする**（会話中の想定から変更）

会話では「専用タブとして紐づける（`pinnedId` と同じ仕組み）」と話していたが、実装方針を変える。

**PR は URL が自然キー**（`https://github.com/<owner>/<repo>/pull/<n>`）なので、
定義側の ID を発行せず、**開いているタブの URL が一致するかどうか**で紐づける。

- 行を押す → URL 一致のタブがあればそれをアクティブ化、無ければ開く
- 一時タブの一覧からは、**URL が Live Folder に載っているタブを除外**して二重に出さない
- PR がマージされて一覧から消える → その URL は Live Folder に載らなくなる →
  **開いていたタブは自動的に「今日のタブ」に現れる**。降格処理を書かなくても降格と同じ結果になる
- タブを別 URL へ遷移させた場合も、その瞬間に枠から外れて「今日のタブ」に出る。これは望ましい挙動

`TabState` に `liveId` を足す案は採らない。`pinnedId` / `favoriteId` の
「排他」の不変条件が3値になり、`registry.ts:2419` の `demoteEverywhere` も
Live Folder 専用の分岐を抱えることになる。得るものが無い。

### 既存コードで乗るところ

| 使うもの | 場所 |
|---|---|
| 共有データの配信 | `ipc.ts:176` の `sharedState()` に1フィールド足す |
| 永続化 | `store/json-store.ts` の `JsonStore`（原子的書き込み・normalize・デバウンス込み） |
| スキーマ検証 | `shared/settings-schema.js` の `readVersioned` / `normalize*` に倣う |
| ログの秘匿 | `shared/log-redact.js` |
| サイドバーの層 | `Sidebar.tsx:89` の `.scroll`、`PinnedTree.tsx` の行の作法 |

## 実装計画

### Phase 1: GitHub クライアント（取得と正規化）[AI🤖]

- [x] `src/shared/live-folder-schema.js` — 保存する JSON の normalize と version。
      **キャッシュは手で編集できるファイルなので、読むときに必ず落とす**
  - PR は**最大 200 件**で切る（100 × 2 バケットの上限。これを超える JSON は壊れている）
  - `url` は **`https://github.com/<owner>/<repo>/pull/<番号>` の形だけ**を通す。
    ホストが github.com でないもの、`javascript:` などは捨てる
    （この URL は**そのままタブで開かれる**ので、ここが最後の防波堤になる）
  - `title` / `repo` / `author` は長さで切る（既存の `MAX_STRING` に合わせる）
  - `state` は 4 値、`bucket` は 2 値のいずれでもなければその項目ごと捨てる
  - `updatedAt` は ISO8601 として `Date.parse` できなければ捨てる
  - `credentialKey` は `[0-9a-f]{16}` だけを通す
  - fixture: **巨大配列（1000件）・非 GitHub の URL・`javascript:` URL・
    不正な `state`・壊れた日時**を入れて、どれも落ちることを見る
- [x] `src/shared/types.ts` に `LivePullRequest` / `LiveFolderState` を追加
      （`SharedState` への追加は Phase 3）
- [x] `src/main/live-folders/github-pr.ts` — 上記の GraphQL を1本投げて正規化して返す
  - `net.fetch` を使う（Electron の net。プロキシ設定を尊重する）
  - `reviewDecision` / `isDraft` から**状態を1つの述語に寄せる**
    （`prState(pr): 'approved' | 'changes-requested' | 'draft' | 'waiting'`）。
    呼び出し側に `isDraft` と `reviewDecision` の分岐を散らさない
  - **競合するので優先順位を決める。** 一度 approve された PR を draft に戻すと、
    `isDraft: true` と `reviewDecision: 'APPROVED'` が**同時に立つ**

    | `isDraft` | `reviewDecision` | `prState` |
    |---|---|---|
    | true | 何であっても | `draft` |
    | false | `APPROVED` | `approved` |
    | false | `CHANGES_REQUESTED` | `changes-requested` |
    | false | `REVIEW_REQUIRED` / null | `waiting` |

    **`isDraft` が最優先**。draft はレビューを受け付けない状態なので、
    そこに古い approval のチェックを出すと「もう通っている」と誤読される
  - 並びは `updatedAt` 降順。グループ分けは `bucket: 'review' | 'mine'`
    （両方に入る PR は `review` を優先。自分の PR に自分でレビュー依頼が来る場合がある）
  - **レスポンスの検証を必ず通す**。GraphQL は **HTTP 200 でも `errors` を返す**ので、
    ステータスコードだけ見ると「空の一覧を取得成功した」と誤読して**全件消える**。
    `errors` があれば失敗として扱い、前回のキャッシュを維持する
  - **失敗は3つに分類して返す**（UI が出し分けるので、ここで決めないと UI 側で
    HTTP ステータスを再解釈することになる）:

    | 種別 | 判定 | UI |
    |---|---|---|
    | `auth` | HTTP 401 / 200 で `viewer` が null / 認証系の `errors[].type` / **権限不足**（下記） | `Reconnect GitHub` |
    | `rate-limit` | 下の順序で判定（primary / secondary の両方） | 前回の内容 + 再開まで待つ |
    | `transient` | それ以外（ネットワーク断・5xx・タイムアウト・パース失敗） | 前回の内容 + `Couldn't refresh` |

    **`rate-limit` は上から順に見る**（`primary` だけ見ると secondary を取りこぼす）:

    | # | 条件 | `resetAt` |
    |---|---|---|
    | 1 | **403 / 429 で** `retry-after` ヘッダがある | `now + retry-after 秒` |
    | 2 | `x-ratelimit-remaining: 0` | `x-ratelimit-reset` |
    | 3 | `errors[].type === 'RATE_LIMITED'` | `rateLimit.resetAt`、無ければ `now + 60s` |
    | 4 | **ステータスに関係なく**本文が secondary limit を示す（`errors[].message` に `secondary rate limit`） | `retry-after` があればそれ、無ければ `now + 60s`。継続するなら倍々（最大 15分） |

    - **403 を一律 `auth` にしない。** GitHub は secondary rate limit でも 403 を返す
    - **`remaining` が 0 でなくても secondary limit は起きる**（公式ドキュメントの規定）。
      `remaining: 0` だけを条件にすると、
      「403・`remaining` あり・`retry-after` あり」を `transient` に落として
      **手動 Retry を許してしまう**（＝制限中に投げ続ける）
    - **本文の判定をステータスで絞らない。** GraphQL の secondary limit は
      **HTTP 200 でも返る**。しかも `errors[].type` が付かず
      `errors[].message` にだけ出ることがあるので、
      `type === 'RATE_LIMITED'`（#3）だけ見ていると 200 の secondary limit を丸ごと見逃す。
      **#4 は 200 にも 403 にも同じように当てる**
    - 成功時の `resetAt` は `rateLimit.resetAt`
    - 分類は述語1つ（`classifyFailure(res, body)`）に閉じ、呼び出し側で
      ステータスコードを見ない
    - **`retry-after` 単独で `rate-limit` と断定しない。** `Retry-After` は
      **503 でも正当に使われる**（RFC 9110 §10.2.3）ので、
      単独判定にすると「5xx は `transient`」と衝突する。
      #1 は **403 / 429 のときだけ**に絞る
    - ただし **`transient` でも `retry-after` は待機時刻として尊重する**。
      503 + `Retry-After: 120` なら、分類は `transient` のまま
      `nextAutomaticAttemptAt = now + 120s` にする（サーバの申告を無視して 60 秒で叩かない）
    - **`Retry-After` は秒数とは限らない。** RFC 9110 は
      **delay-seconds と HTTP-date の両方**を許している
      （`Retry-After: Wed, 26 Aug 2026 10:30:00 GMT`）。
      解釈は `parseRetryAfter(value)` の1関数に閉じる:
      ①整数として読めれば秒数 ②読めなければ HTTP-date として `Date.parse`
      ③どちらも不正なら **null を返して通常のバックオフに落とす**
      （変な値のせいで永遠に待つ、を作らない）。
      過去の日時なら 0 として扱う（＝すぐ次を試す）

    **権限不足は `auth` に入れる。** fine-grained PAT で対象 org や権限が足りないと、
    GraphQL は 403 で `Resource not accessible by personal access token`
    （または `Resource not accessible by integration`）を返す。
    これは #1〜#4 のどれにも当たらず 401 でもないので、
    **放っておくと永遠に `Couldn't refresh` を出しながら再試行し続ける**。
    直す方法は「トークンを直す」ことなので、`Reconnect GitHub` を出すのが正しい

    - 参考:
      <https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api>
      / <https://docs.github.com/en/graphql/guides/introduction-to-graphql>
      / <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3>
  - テストの fixture: 401 / 200 で `viewer: null` / 500 / 200+`errors` に加えて、
    **rate-limit の各経路**:
    - `retry-after` 付きの 403
    - `remaining: 0` の 403
    - `errors[].type === 'RATE_LIMITED'` の 200
    - **`remaining` が残っている secondary limit の 403**
    - **HTTP 200・`errors[].type` なし・`errors[].message` に `secondary rate limit`**
      を `retry-after` あり / なしの2本
    - **403・`Resource not accessible by personal access token`**（→ `auth` になること）
    - **503 + `Retry-After: 120`**（→ `transient` のまま、待機だけ 120 秒になること）
    - **503 + `Retry-After: <HTTP-date>`**（→ その時刻まで待つこと）
    - **503 + `Retry-After: garbage`**（→ 通常のバックオフに落ちること）

    後半5つの分類が狙いどおりであることを必ず見る
    （secondary が `transient` に落ちると制限中に手動 Retry が通り、
    権限不足が `transient` に落ちると永遠に再試行し続ける）
  - 打ち切りは **検索単位**で
    `truncation: { review: {returned,total} | null, mine: {…} | null }` として返す
    （`issueCount > nodes.length` のときだけ非 null。描画行数はここに入れない）
- [x] `scripts/live-folder.test.mjs` — **実 API を叩かない**
  - fixture は `scripts/fixtures/github-prs.json` を**合成で作る**
    （実レスポンスの置換ではなく手で書く）。実レスポンスには社内のリポジトリ名・owner・
    PR の URL・author login が全部入っており、タイトルだけ差し替えても消し残る。
    形さえ合っていればテストの目的は達せられる
  - 検査項目: 状態の判定4種 / 並び順 / 両バケツに入る PR の扱い /
    `author` が null（削除済みユーザー）でも落ちない / `nodes` が空でも落ちない /
    **HTTP 200 + `errors` を失敗として扱う** /
    **`issueCount` が 137 で `nodes` が 100 のとき `truncation.review` だけが立ち、
    `truncation.mine` は null のまま**（片側だけ超えるケースを踏む）

### Phase 2: トークン [AI🤖]

- [x] `src/main/store/github-token.ts` — **`settings.json` とは別のストア**
      （`userDataPath('github-token.json')`）。`SYNCED_FILES` には**足さない**
  - `save(pat)` / `clear()` / `read()`。保存前に `safeStorage.isEncryptionAvailable()` を見て、
    false なら**保存せずエラーを返す**（平文で置かない）
  - `decryptString` が投げたら**ファイルごと捨てて `null`**（壊れた暗号文を握り続けない）
- [x] `src/main/live-folders/token.ts`
  - **PAT →ｇh の順**（明示設定が勝つ）
  - gh は `execFile(<解決した絶対パス>, ['auth', 'token', '--hostname', 'github.com'])`
    （タイムアウト 3秒）。gh が無い / 未ログインは失敗ではなく `null`
  - **`'gh'` をそのまま渡さない。** Finder から起動した macOS アプリの PATH には
    Homebrew の `/opt/homebrew/bin`（Apple Silicon）や `/usr/local/bin`（Intel）が
    **入っていないことがある**。ターミナルから `pnpm dev` で動かしているあいだは通るので、
    **packaged 版で初めて「gh が無い」ことになる**
    - 手元の実測: `gh` は `/opt/homebrew/bin/gh`
      （実体 `/opt/homebrew/Cellar/gh/2.97.0/bin/gh`）。`/usr/local/bin/gh` は無い
    - 解決の順序: ①継承した `PATH` から探す
      ②`/opt/homebrew/bin/gh` ③`/usr/local/bin/gh` の順に
      `fs.accessSync(path, X_OK)` で存在と実行権を見る ④どれも無ければ `null`
    - main 側に `execFile` の前例が無いので、この解決は
      `src/main/live-folders/gh-path.ts` に**単独で置く**（他から使うときに拾える）
  - どちらも無ければ `null`（Phase 5 の「未設定」表示へ）
  - `source(): 'pat' | 'gh' | 'none'` を公開する（設定画面に出すのはこれだけ）
- [x] IPC は `nemo:github-token-save` / `-clear` / `-source` の3つ。
      **トークンそのものを renderer へ返す IPC は作らない**
- [x] `log-redact.js` にトークンのパターンを追加
  - `gh[pousr]_[A-Za-z0-9]{36,}` に加えて **`github_pat_[A-Za-z0-9_]{22,}`**
    （fine-grained PAT。現行案のパターンでは消えない）
  - `sanitizeValue` の**文字列パス**（`log-redact.js:82` 付近。今は URL 以外を素通り）と、
    **`value instanceof Error` のパス**（`log-redact.js:88`。今は `message` をそのまま返す）の
    **両方**に通す。GitHub のエラーはトークンを含む URL やヘッダを message に載せることがある
- [x] **修正前に FAIL することを確認**: redact 追加前のコードで
      ①素の文字列 ②`new Error(\`... ${token} ...\`)` の2経路を通し、
      **どちらも素通りすること**を出力付きで確認してから追加する

### Phase 3: ポーリング・永続化・配信 [AI🤖]

- [x] `src/main/live-folders/index.ts`
  - `JsonStore<LiveFolderData>('live-folders.json')` に前回の結果を保存し、**起動直後は
    それを即座に出す**（ネットワークを待たない）
  - **キャッシュは「誰のものか」を持つ。** これが無いと、
    **別アカウントの PAT に貼り替えて取得が失敗したとき、
    前のアカウントの PR が「前回の内容」として出続ける**
    - 照合に使うのは **トークンの非可逆 fingerprint**。
      `sha256(token)` の先頭 16 文字を `credentialKey` としてキャッシュに保存する
    - **メモリ上の連番（generation）にはしない。** 再起動すると連番が振り直され、
      正しいキャッシュまで弾かれる（あるいは偶然一致してしまう）
    - **`viewer.login` は API が成功しないと分からない**ので、事前の照合には使えない。
      fingerprint なら**起動直後・取得前に照合できる**。
      外部で `gh` のアカウントが切り替わっていた場合も、
      トークン文字列が変わるので起動時点で弾ける
    - `login` はキャッシュに持つが、用途は**表示**（設定画面の「@nyshk97 として接続中」）と
      成功後の追加確認だけにする
    - fingerprint が一致しないキャッシュは**表示せず、破棄する**。
      次の取得が成功するまでは「読み込み中」として扱い、古い一覧は出さない
    - PAT の保存・削除でも同じ経路を通る（トークンが変われば fingerprint が変わる）
    - **fingerprint をログに出さない**（`log-redact` の秘匿キーに載せる）
  - **次に投げてよい時刻を `nextAutomaticAttemptAt`（epoch ms）1つに寄せる。**
    タイマー・focus・resume が**それぞれ別のゲートを持つと、必ず食い違う**
    （60秒タイマーと 60秒 focus ゲートは、transient 失敗後の 15分バックオフを両方とも迂回する）

    | 何が起きたか | `nextAutomaticAttemptAt` |
    |---|---|
    | 成功 | `now + 60s` |
    | `transient` 失敗 | `now + backoff`（60s から倍々で最大 15分） |
    | `rate-limit` | `resetAt` |
    | `auth` 失敗 | `now + 15分`（資格情報を直すまで投げても無駄） |

    - **タイマー・focus・resume は全部「`now >= nextAutomaticAttemptAt` か」だけを見る**。
      タイマーは 60 秒ごとに起きて条件を確認するだけの存在にする
      （＝タイマー自身が取得間隔を決めない）
    - **手動（`Refresh`）だけは `transient` のバックオフを上書きできる**（押した人の意図が勝つ）
    - **`rate-limit` は手動でも上書きできない。** ここを破れると、
      制限中に押し続けて復帰をさらに遅らせる。
      末尾の状態行に残り時間を出して、押しても何も起きない理由が分かるようにする
    - `auth` も手動では上書きできる（トークンを直した直後に押すのが自然なので）
  - 全ウィンドウが hidden なら止める。`powerMonitor` の `suspend` / `resume` で止める / 再開する
  - 前回の結果と URL の集合を比べ、**新しく現れた PR に `unread` を立てる**。
    **`updatedAt` が変わっただけでは未読にしない**（自分がコメントしただけで未読が立つと、
    未読ドットが「見ていないもの」を指さなくなる）。
    ただし**取得の時点でその PR がどこかの通常ウィンドウでアクティブなタブなら未読にしない**
    - 「タブが存在する」では広すぎる。バックグラウンドで開きっぱなしのタブまで既読になり、
      更新に気づけなくなる。**既読の判定は「見ている」＝アクティブであること**に限る
    - シークレットウィンドウは Live Folder を持たないので、判定からも外す
  - **未読は全ウィンドウ共有**（`SharedState` に載る）。ウィンドウ別には持たない。
    定義が全ウィンドウ共有である既存のピン留めと同じ扱いで、
    「片方のウィンドウで開いたのに、もう片方では未読のまま」を作らない
  - **取得は single-flight。** タイマー・focus・resume・手動更新の4経路から要求が来るので:
    1. **実行中に来た自動の要求（タイマー / focus / resume）は、
       世代番号に触れずその場で捨てる**（`return`）
    2. ここまで来た要求だけが**世代番号を1つ進める**
    3. 実行中なら、**予約を1つ立てるだけ**（何回要求が来ても予約は1件に畳む）。
       ここに来られるのは**「手動」と「設定・トークンの変更」だけ**
    4. 完了時、**自分の世代が最新でなければ「一覧の置き換え」だけを捨てる**
    5. 実行が終わったら、予約があれば続けて1回だけ実行する

    **世代番号が制御するのは「一覧を置き換えてよいか」だけ。**
    失敗の分類・`nextAutomaticAttemptAt`・レート制限を観測したという事実は、
    **世代が古くても必ず記録する**。これは「誰が投げたか」に関係なく真だから

    そのうえで、**`rate-limit` を観測したら、同じ資格情報の予約はキャンセルする**。
    そうしないとこの順序で「`rate-limit` は手動でも上書き不可」が破れる:

    1. 自動取得 A が走る
    2. 完了前に手動 `Refresh` が押され、世代が進んで予約が立つ
    3. A が `rate-limit` を返す
    4. A は古い世代なので**結果をまるごと捨てる**（＝レート制限も記録されない）
    5. 予約ぶんが**即座に送信される**（制限中なのに投げる）

    - キャンセルするのは**同じ資格情報の予約だけ**。
      **トークン変更で立った予約は 1 回だけ実行してよい**。判定は `credentialKey` の一致で行う
    - ただし **`credentialKey` が違えば制限も別、ではない。**
      GraphQL の primary rate limit は**トークン単位ではなくユーザー単位**なので、
      **同じアカウントの別 PAT に貼り替えても制限は共有される**。
      それでも 1 回投げるのは、**新しいトークンが誰のものかは取得するまで分からない**から
      （別アカウントなら投げる価値があり、同一アカウントでも代償は 1 リクエスト）
    - **その 1 回も `rate-limit` を返したら、以後は `resetAt` まで手動・自動とも投げない**。
      「トークンを変えれば通る」と考えて投げ続けない

    **1 を 2 より先に置くのが肝心。** 順序が逆だと、
    捨てるはずの自動要求が**世代番号だけ進めてしまい**、
    いま走っている取得が完了時に「自分の世代は最新でない」と判定されて
    **正常な結果まで捨てられる**。focus を撃つたびに結果が適用されなくなり、
    一覧が永久に更新されない

    **1 が無いと focus 連打が抑えられない。** `nextAutomaticAttemptAt` は
    **取得が完了するまで更新されない**ので、1回目の focus 取得中に来た2回目の focus は
    古い期限を通過してしまい、予約が立って続けてもう1回走る。
    「4回 focus しても1リクエスト」（検証⑮）はこれで初めて成立する。
    自動の要求は「いま走っているならもう用は足りている」ので捨ててよい。
    手動と設定変更だけは、押した人・変えた人の意図があるので予約する
- [x] **共有状態の組み立てを一本化する。** 現在 `SharedState` は
      `ipc.ts:176` の `sharedState()` と `registry.ts:1401` の `pushShared()` の
      **2箇所で別々に組み立てられている**。`liveFolder` を片方に足しても push 側に乗らない
  - `sharedState(win)` を1つに寄せ、`pushShared()` はそれを呼ぶだけにする
  - **`win.isPrivate` なら `liveFolder: null`**（シークレットには渡さない）
- [x] **再配信のトリガーを追加する。** `startBackgroundWork()`（`registry.ts:2604` 付近）の
      購読は現在 `onPinsChanged` / `onDownloadsChanged` / `onUpdateChanged` の3つだけ。
      同じ作法で `onLiveFolderChanged` を足し、全ウィンドウへ `pushShared()` する
- [x] **設定とトークンの変更も即時に反映する。** push の契機が `onLiveFolderChanged` だけだと、
      PAT を貼っても最大 60 秒何も起きない（＝壊れているように見える）
  - `liveFolderEnabled` を **false にしたら push だけ**（取得はしない・タイマーも止める）
  - `liveFolderEnabled` を **true に戻したら push + 即時に1回取得**
    （push だけだとセクションが空のまま出てくる）
  - **PAT を保存したら**、資格情報の種別を取り直して**即時に取得を1回走らせる**
  - **PAT を消したら**、`gh` があればそちらへフォールバックして即時取得、
    無ければ `Connect GitHub` へ**即時に**切り替える
  - トークン側の変更は、`liveFolderEnabled` が false のときは取得しない（push もしない）
- [x] IPC: `nemo:live-folder-refresh`（手動更新）、`nemo:live-folder-open`（行を押す）
  - **`live-folder-open` は renderer から渡された URL をそのまま開かない。**
    **いま Live Folder に載っている項目の URL と一致するものだけ**開く
    （一致しなければ何もしない）。renderer の入力を信じて任意 URL を開く口にしない

### Phase 4: サイドバー UI [AI🤖]

- [x] `src/renderer/components/LiveFolder.tsx` — モック案2 のとおり
- [x] `Sidebar.tsx` の `.scroll` 先頭へ差し込む（ピン留めの見出しより上）
- [x] `styles.css` に行・小見出し・バッジのスタイル。**色は DESIGN.md のトークンから引く**。
      状態色（`--ok` / `--warn`）は新規なので DESIGN.md の表にも追記する
- [x] 一時タブの一覧から、URL が Live Folder に載っているタブを除外（`Sidebar.tsx:52` の条件に足す）
- [x] 行のクリック → URL 一致のタブがあればアクティブ化、無ければ開く
- [x] **未読の解除は main 側のタブ選択の共通経路に寄せる。**
      行のクリックだけで消すと、コマンドバー・履歴・⌘数字・タブ切替から同じ URL を開いても
      未読が残る。既存タブの未読は `registry.ts:1804` の `tab.unread = false` で
      一元的に消えているので、**そこで「アクティブになったタブの URL に一致する
      Live Folder の項目も未読を落とす」**。UI 側では消さない
- [x] **末尾の状態行**（`Updated 3m ago · Refresh` / `Refreshing…` /
      `Couldn't refresh · showing 19:12 · Retry`）。
      相対時刻は 1分未満 `just now` → `3m ago` → `2h ago`。**1分ごとに再描画する**
      （開きっぱなしで `3m ago` のまま止まると、その表示自体が嘘になる）。
      末尾行そのものに件数は出さない（打ち切りは次項の別行で出す）
- [x] 小見出しの右は**常に描画行数だけ**
- [x] 打ち切りがあれば、末尾の状態行の下に `First 100 of 137 fetched for CREATED`
      を検索ごとに1行ずつ出す（描画行数と検索ヒット数は別の母集団なので同じ表記に混ぜない）
- [x] 前掲の**表示の優先順位の表**をそのまま実装する（分岐を UI の各所に散らさず、
      `liveFolderView(shared, win)` のような**述語1つ**に寄せて上から順に1つ選ぶ）
- [x] 右クリックメニュー: 「GitHub で開く」「いま更新する」「このセクションを隠す」
  - **`rate-limit` 中は「いま更新する」を disabled にする**。
    末尾行の `Refresh` を消しているのに、ここだけ押せると挙動が食い違う
    （押しても投げないので、押せること自体が嘘になる）
  - 「隠す」は設定 `liveFolderEnabled` を false にするだけ。**復帰は設定画面のトグル**
    （隠したきり戻せないと詰む）

### Phase 5: 未設定・エラーの見せ方 + 設定 [AI🤖]

- [x] トークン未設定 → `Connect GitHub` の1行だけ（空の見出しを出さない）
- [x] `auth` → `Reconnect GitHub` の1行 + 設定画面への導線
- [x] `rate-limit` → 前回の内容を出したまま、`resetAt` まで待つ（末尾行に待ち時間を出す）
- [x] `transient` → 前回の内容 + `Couldn't refresh`。
      **Phase 1 の分類をそのまま使い、UI で HTTP ステータスを見ない**
- [x] **設定スキーマに `liveFolderEnabled` を足す**（既存の作法どおり**フラットなキー**にする。
      `DEFAULT_SETTINGS` はネストを持たない）
  - `settings-schema.js` の `DEFAULT_SETTINGS`（既定 `true`）と `normalizeSettings`
    （`typeof === 'boolean'` でなければ既定値に落とす、既存の `sidebarVisible` と同じ形）
  - `types.ts` の `NemoSettings`
  - `scripts/settings-schema.test.mjs` に**壊れた値・欠けた値**のケースを追加
    （`"yes"` / `null` / キー無しの3つが既定 `true` に落ちること）
  - `SETTINGS_VERSION` は上げない。**キーの追加は `normalizeSettings` が既定値で埋める**ので、
    既存の `settings.json` をそのまま読める（版を上げると同期先の古い Nemo が拒否する）
- [x] `Settings.tsx`
  - PAT の入力欄（貼ると専用ストアへ暗号化保存）と「消す」ボタン
  - **いま何が使われているか**（`PAT` / `gh` / 未設定）の表示。値は出さない
  - `safeStorage.isEncryptionAvailable()` が false のときは、貼っても保存されない旨を出す
  - **Live Folder の表示トグル**（右クリックの「隠す」からの復帰経路）
- [x] DESIGN.md に Live Folder の節を追記（層の順番・行の仕様・状態バッジの規則・
      新規の状態色 `--ok` / `--warn`）

### Phase 6: 自走検証 [AI🤖]

- [x] **API の差し替え口を安全に作る。** 単体テスト（`live-folder.test.mjs`）は
      `github-pr.ts` に **fetch 関数を引数で注入**する形にして、環境変数を使わない
- [x] UI まで見る自走検証だけは endpoint を差し替える。作法は既存の
      `NEMO_MEET_TEST_URL_PREFIX`（`index.ts:154` / `meet-adapter.ts:35`）に揃える
  - ゲートは **`!app.isPackaged`**（`isDevChannel` では塞げない。
    `paths.ts:18` が `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので、
    **dev パッケージでも `isDevChannel === true`** になり裏口が残る）
  - **差し替えが有効なあいだは、トークンを一切読まない**。
    PAT も `gh auth token` も参照しない。
    これをやらないと「環境変数1つで本物の PAT を任意のホストへ送れる」経路になる
  - **そのうえで認証状態も注入できるようにする**
    （`NEMO_GITHUB_TEST_AUTH=dummy|none|stored-only`）。
    差し替え中を常に「トークンあり」に固定すると、
    **`Connect GitHub`（検証④）に到達する経路が無くなる**
    - `dummy` … 固定のダミー文字列を送る（＝トークンありの経路）
    - `none` … トークン無しとして振る舞う（＝未設定の経路）
    - `stored-only` … **差し替え中だけの PAT 置き場（プロセス内のメモリ）を読む**。
      保存されていなければ「未設定」。**`gh auth token` は呼ばない**。
      **実ストア（`safeStorage`）にも触らない** —— 触ると macOS の Keychain 許可ダイアログ
      （`SecurityAgent`）が出て検証が永久に止まる（実装中に踏んだ）
    - **どの値でも `gh auth token` は絶対に呼ばない**。この3値以外は `dummy` に倒す

    `stored-only` が要る理由: `dummy` 固定だと
    「PAT を保存 → 取得が走る → 消す → `Connect GitHub` に戻る」（検証⑫）を
    **同一プロセスで再現できない**（保存も削除も結果が変わらないため）。
    自走検証は使い捨ての `NEMO_USER_DATA_DIR` で動くので、
    ここで読むストアも実ユーザーのものではない
  - パッケージ版で環境変数が来ていたら、既存と同じく無視してその旨を出す
- [x] `scripts/verify-live-folder.mjs` — `verify-call.mjs` の作法に倣う
  - **GitHub には実際に繋がない**。上記の差し替え口でローカル HTTP サーバへ向ける
    （`scripts/test-server.mjs` があるので同じ作法で）
  - 検査: ①起動直後にキャッシュが出る ②取得後に行が置き換わる
    ③PR を1件消したレスポンスを返すと行が消え、**開いていたタブが「今日のタブ」に現れる**
    ④トークン無しなら `Connect GitHub` の1行だけが出る
    ⑤**サーバを 500 に切り替えても行が消えず**、末尾行が失敗表示に変わり、
      行の `opacity` が落ちる（＝古い内容だと分かる）
    ⑥**HTTP 200 + `{"errors":[…]}` でも行が消えない**（⑤とは別経路。
      ステータスだけ見ていると全件消えるので、この2つは必ず両方撃つ）
    ⑦**片方の検索だけ 101 件以上**の fixture で、
      **小見出しは描画行数のまま**（`137` や `100` を名乗らない）、
      **末尾に `First 100 of 137 fetched for CREATED` が1行だけ**出る
      （切られていない側の行は出ない）。
      **アサーションには「サーバが返した件数」「描画された行数」「末尾行の文言」の
      3つを出す**（9 件の fixture では境界を素通りして PASS してしまう）
    ⑧**シークレットウィンドウにはセクションが出ない**
    ⑨**取得の直列化**。サーバ側で在庫中のリクエスト数を数えさせ、
      短い間隔で要求を4回撃っても **同時実行が常に 1 本**であること、
      **最後の要求の内容が最終状態になる**こと、
      **途中の古い応答が最終状態を上書きしないこと**を見る
      （single-flight なので「2本を重ねる」は成立しない。数えるのは在庫と最終状態）
    ⑩行をクリックせず**コマンドバーから同じ URL を開いても未読が落ちる**
    ⑫**PAT を保存した直後に取得が走る**（60秒待たずに一覧が入れ替わる）。
      消したときも即時に `Connect GitHub` へ変わる
    ⑬**設定で無効にした瞬間**にセクションが消え、戻した瞬間に出る（どちらも 60秒待たない）
    ⑮**実行中に来た自動の要求が捨てられる**（サーバ側のリクエスト数で数える）。
      **OS のウィンドウフォーカスは CDP から確実に撃てない**（`Page.bringToFront` では
      `browser-window-focus` が飛ばない）ので、**同じ経路を通るタイマー**で撃つ
      （focus・タイマー・resume はどれも `requestAutomatic` → `requestFetch('auto')`）。
      **同時に、その1回のレスポンスが最終状態として適用されている**ことも見る
      （世代番号を進める順序を間違えると、リクエスト数は1でも
      結果が捨てられて一覧が空のままになる）。
      **手動の `Refresh` は、前回の取得が完了してから1回ずつ押せば毎回走る**
      （実行中の連打は single-flight が予約1件に畳むので、そこは数に入れない）
    ⑯**`rate-limit` 中は手動を押しても投げない**（サーバのリクエスト数が増えない）。
      **`transient` のバックオフ中は手動で投げられる**ことも同時に見る（上書きの可否が逆）
    ㉖**遅い取得の実行中に手動 `Refresh` を押し、その取得が `rate-limit` を返す**と、
      **リクエスト総数が 1 のまま**（予約ぶんが送られない）で、
      **UI が `rate-limit` になる**。
      古い世代の結果を丸ごと捨てると、レート制限が記録されないまま予約が即送信される
    ㉗**トークン変更の予約は `rate-limit` 中でも 1 回だけ実行され、それ以上は投げない**。
      手順は「古い資格情報の応答で `rate-limit` を観測 → トークンを変更 →
      **リクエストが 1 回だけ飛ぶ** → その応答も `rate-limit` →
      **以後は手動を押しても自動が来ても `resetAt` まで 1 回も飛ばない**」
    ⑲**`transient` 失敗後のバックオフを、タイマーも focus も迂回しない**。
      初回のバックオフは 60 秒なので「失敗から 60 秒後の focus」は**走るのが正しい**。
      **2回失敗させて 120 秒バックオフに入れてから**、
      失敗の 60〜120 秒後に focus を撃ってリクエストが増えないことを見る
      （タイマーの 60 秒でも増えないこと）
    ㉑**`remaining` が残っている secondary limit の 403 が `rate-limit` になる**、
      および **HTTP 200・`type` なし・本文に `secondary rate limit` の応答**も
      `rate-limit` になる（どちらも `transient` に落ちて手動 Retry が通らない）
    ㉒**壊れたキャッシュを置いても起動する**（1000件・`javascript:` URL・不正な `state`）。
      **`javascript:` の項目が1つも描画されない**ことを見る
    ㉓**`live-folder-open` に一覧に無い URL を渡しても何も開かない**
    ㉔**403 の権限不足（`Resource not accessible by personal access token`）で
      `Reconnect GitHub` になる**（`Couldn't refresh` を出して再試行し続けない）
    ㉕**503 + `Retry-After: 120` は `transient` のまま、次の試行が 120 秒後になる**
      （60 秒で叩きに行かない）
    ⑳**再起動しても正しいキャッシュが表示される**（fingerprint が同じなら残る）。
      **トークンを別のものに差し替えて再起動したら、取得前に古い一覧が出ない**
    ⑰**PAT を別アカウントのものに替えて取得が失敗したとき、前のアカウントの一覧が出ない**
      （キャッシュが捨てられ、古い PR が「前回の内容」として残らない）
    ⑱**`github-token.json` に平文の PAT が含まれない** →
      **自走検証では見られない**（差し替え中は実ストアに触らないのでファイルが無い）。
      **人間の確認へ移した**（`VERIFY.md`）
    ⑭**401 / `remaining:0` の 403 / 500 の3つで出し分かる**
      （`Reconnect GitHub` / 前回の内容のまま待つ / `Couldn't refresh`）。
      **`remaining:0` の rate-limit 403 が `Reconnect GitHub` にならないこと**を必ず見る
      （403 全般ではない。㉔の権限不足 403 は `Reconnect GitHub` になるのが正しい）
    ⑪**バックグラウンドで開きっぱなしのタブは既読扱いにしない**。
      仕様は「新しく現れた PR に未読を立てる」なので、更新では撃てない。手順は
      「1回目のレスポンスにその PR を含めない・同じ URL のタブを**非アクティブで開いておく**
      → 2回目のレスポンスで初めてその PR が現れる」→ **未読が立つ**こと。
      同じ手順でタブを**アクティブ**にしておけば未読が立たないことも合わせて見る
  - **③⑨⑩⑪は修正前に FAIL することを確認する**
    - ③ 除外条件を外した状態で走らせ、タブが二重に出る／消えないことを見てから実装する
    - ⑨ 直列化を入れる前に走らせ、在庫が 2 以上になることを出力で見る
    - ⑩ UI 側だけで未読を消す実装にして走らせ、未読が残ることを見る
    - ⑪ 判定を「タブが存在する」にした状態で走らせ、非アクティブでも未読が立たないことを見る
    - ⑮ ゲートを入れる前に走らせ、focus 4回でリクエストが 4 回飛ぶことを見る
    - ⑰ fingerprint の照合を入れる前に走らせ、別アカウントの一覧が残ることを見る
    - ⑲ `nextAutomaticAttemptAt` に寄せる前（タイマー 60 秒固定）に走らせ、
      120 秒バックオフ中でも 60 秒でリクエストが飛ぶことを見る
    - ⑮ 「実行中の自動要求を捨てる」を入れる前に走らせ、
      focus 4回で 2 リクエスト以上飛ぶことを見る
    - ㉖ 「古い世代でも失敗は記録する」を入れる前に走らせ、
      リクエストが 2 回飛ぶ（制限中に投げてしまう）ことを見る
  - **⑦は「101 件を用意した」だけでなく、実際に 100 行で止まった実測値を出す**
  - **件数のアサーションには実測値を出す**（「9件出た」ではなく取得件数と描画行数を両方出す）
- [x] `verify-all.mjs` に登録
- [x] VERIFY.md に手順を追記

### 動作確認 [人間👨‍💻]

- [ ] 実際の GitHub アカウントで9件が出るか（社内 PR のタイトルが読めるか）
- [ ] PR をマージして 60秒以内にサイドバーから消えるか
- [ ] 誰かにレビュー依頼を出してもらい、勝手に増えるか
- [ ] サイドバーが縦に長くなりすぎないか（ピン留めが押し出される感覚の確認）
- [ ] シークレットウィンドウでセクションが出ないこと
- [ ] 設定画面で PAT を貼る → `gh` より PAT が使われること（`source` が `PAT` になる）
- [ ] **packaged 版を Finder から起動して、`source` が `gh` になること**。
      ターミナルから起動すると PATH を継承してしまうので、
      **必ず Finder（または `open -a`）から起動して確かめる**

## ログ

### 試したこと・わかったこと

- **2026-08-26 実装**: Phase 1〜6 を実装。`mise run verify:only live-folder restart` で
  **Live Folder は全 PASS / 1 SKIP**（SKIP は ⑱。理由は下記）。ユニットテストは 179 件 PASS。
- **macOS の `safeStorage` は Keychain の許可ダイアログを出す。**
  自走検証が PAT を保存した瞬間に `SecurityAgent` が上がり、**検証が永久に止まった**
  （`timeout` で殺しても Electron が孤児になってパイプを掴んだままになる）。
  → **差し替え中（`NEMO_GITHUB_TEST_ENDPOINT` が有効）は実ストアに一切触らず、
  プロセス内メモリの置き場を使う**ことにした。「差し替え中は実トークンを読まない」も
  同時に強くなる。代償として ⑱ は自走検証で見られないので人間の確認へ移した
- **`tsconfig.web.json` の include を絞った。** renderer から
  `live-folder-schema.js`（PR の URL の正準化）を使うために `allowJs` を入れたところ、
  `src/shared/**/*` に居る **node 専用の shared JS**（`ext-lock.js` / `tree-hash.js`）まで
  巻き込んで型検査が落ちた。renderer が実際に使う
  `types.ts` と `live-folder-schema.js` だけを include する形にした
- **差し替え口の設定は `startBackgroundWork()` より前に置く。**
  Live Folder は起動直後に1回取得しに行くので、後に置くと
  **その1回だけ本物の api.github.com へ実トークンで飛ぶ**
- **「資格情報が無い（null）」を「別人」と同じ扱いにしていて、起動のたびにキャッシュを捨てていた。**
  起動直後はまだトークンを解決していないので `credentialKey` が null になり、
  そこで「一致しない」と判定して**毎回まっさらから始まっていた**
  （検証 ① が 0 行で落ちて発覚）。null は「まだ分からない」なので捨てない。
  あわせて、**照合が済むまでキャッシュを表に出さない**フラグ（`cacheVerified`）を入れた。
  これが無いと、外部で `gh` のアカウントが切り替わっていた場合に
  **別アカウントの PR が一瞬出る**
- **タイマーの間隔を 15 秒 → 5 秒にした。** 取得の間隔を決めるのは
  `nextAutomaticAttemptAt` の方なので、タイマーは「条件を見るだけ」。
  短いほど制限が解けた直後の復帰が速い
- **拡張の service worker が idle 停止していて `spike --storage-write` が落ちるようになった。**
  Live Folder の検証で実行時間が 2 分半伸びた結果、再起動フェーズに入るころには
  MV3 の service worker が止まっていて「起動していない」で落ちる
  （書けていないので再起動後の読み出しも `{}` になる）。
  **`verify-spike.mjs` の `swSession()` が、止まっていたら
  `restartServiceWorkers()` で起こしてから繋ぐ**ように直した。Live Folder とは別の修正
- **フル検証には 5 件の既存 FAIL がある**（`タブが無い間は見えている` /
  `Peek が出ている間は暗幕の View が表示されている` / ⌃M の2件 /
  `会議タブを見ている間は小窓が出ない`）。**変更を `git stash` した baseline でも同じ 5 件が落ちる**
  ので、この実装とは無関係（ウィンドウが前面に無い状態で回すと落ちる類）
- **`fetchPullRequests` のタイムアウトは 15 秒**なので、
  それより長い応答を返す検証は abort されて `transient` になる（検証を書くときに踏んだ）
- `rateLimit.cost` は fixture 経由でも 1（`remaining` 4999）。
  実データでの確認は人間の確認に入れてある

### 方針変更

- **2026-08-26 レビュー14巡目（実装後）**: 1件採用。
  - **[P2] 無効化しても予約済みの取得が飛んでいた。** 取得中に手動更新 / PAT 変更が来て
    `pending` が立った直後に設定を無効にすると、`liveFolderSettingChanged(false)` が
    予約を消していなかったため、**走っていた取得が終わった瞬間に予約ぶんが送信され、
    無効にしたのに GitHub へ1回つなぎに行っていた**。
    - 無効化で `pending = null` にする
    - **「投げてよいか」の判定を `requestFetch()` の入口1か所に寄せた**
      （予約の実行経路もここを通る。呼び出し口ごとに書くと必ずどれかで漏れる）
    - `finally` でも有効かを見る（`requestFetch` が弾いたときに
      `loading` を畳み損ねて「取得中」のまま止まるのを防ぐ）
    - **送信の直前にもう一度見る**。`resolveToken()` は `gh auth token` を待つと
      最大 3 秒かかるので、そのあいだに無効化されることがある
    - 検証⑬に「遅い取得中に予約を立てる → 無効化 → 総リクエストが 1 回のまま」を追加。
      **修正前は 2 回飛ぶ**ことを確認済み。あわせて
      「戻したあと『取得中』のまま止まらない」も見る

- **2026-08-26 レビュー13巡目（実装後）**: 指摘5件とも採用。
  - **[P1] `live-folder-open` の照合が文字列の完全一致だった。** renderer は
    `normalizePrUrl` で正準化してから一時タブの除外を判定しているのに、main 側は
    `tab.url === target` で探していた。通知から開いた
    `.../pull/12?notification_referrer_id=…` のタブは
    **一時タブから隠れているのに、行を押すと正準 URL の別タブがもう1枚できる**。
    main 側も `liveFolderKeyOf(tab.url) === target` に揃えた。
    検証③に「クエリ / フラグメント付きのタブを再利用する」を追加
    （**クエリだけだと github.com 側が 404 の過程でクエリを落として空振りする**ので、
    サーバに送られないフラグメントで撃つ）
  - **[P1] 資格情報の変更の予約を手動更新が押し流していた。** `pending = kind` の単純上書きだと
    「旧 PAT で取得中 → 新 PAT を保存（credential）→ 手動更新（manual）→
    旧 PAT の応答が rate-limit」の順で **manual として扱われた予約がキャンセルされ、
    新しい資格情報で1度も取得されないまま**旧アカウントのキャッシュが `resetAt` まで残る。
    **`credential` の予約は上書きしない**ことにした。検証に㉖と㉗を組み合わせた競合検査を追加
  - **[P2] 壊れた HTTP 200 を「0 件の成功」として扱っていた。**
    `reviewRequested` / `mine` が欠けていても `readSearch()` が空配列を返すので、
    `viewer` だけ返ってくる 200 が `ok: true, items: []` になり、
    **既存のキャッシュが全消去される**。`nodes` が配列であること・`issueCount` が整数であることを
    検査し、片方でも違えば `transient` に落とすようにした
  - **[P2] `resume` だけが「全ウィンドウが隠れている」を迂回していた。**
    可視性の判定がタイマーにしか無く、隠したままスリープ復帰すると取得が走っていた。
    **判定を `requestAutomatic()` の1か所に寄せた**（呼び出し口ごとに書くと必ずどれかで漏れる）
  - **[P3] 文字列長の正規化がキャッシュ読み込み時にしか効いていなかった。**
    `JsonStore.set()` は normalize しないので、取得直後の UI と保存ファイルに
    200 文字超の値が入っていた。**取得時も `normalizeLivePullRequest` を通す**ようにして、
    API 経路とキャッシュ経路の正規化を1つに寄せた
    （合わせて `fetchPullRequests` の `normalizeUrl` 注入は不要になったので削除）
  - **どれも修正前に FAIL することを確認した**（ユニット3件 + 自走検証2件）

- **2026-08-26 実装時の変更**: 3件。
  - **`stored-only` は実ストア（`safeStorage`）を読まない**ことにした（上記の Keychain の件）。
    検証 ⑱ は人間の確認へ移動
  - **検証 ⑮ は OS のウィンドウフォーカスを使わない**。`Page.bringToFront` では
    `browser-window-focus` が飛ばず SKIP になった。focus・タイマー・resume は
    どれも `requestAutomatic` → `requestFetch('auto')` の**同じ経路**なので、
    タイマーで「実行中に来た自動の要求は捨てる」を撃つ形に変えた
    （20 秒かかる自動取得の最中に 15 秒タイマーが2回起きてもリクエストが増えないこと +
    その1回の結果が最終状態として適用されること）
  - **検証 ③ と ⑩ が「壊したコードでも PASS」していた**（修正前 FAIL の確認で発覚）。
    ③ は**タブのタイトル**で判定していたが、実際のタブのタイトルは
    github.com が返す `Page not found · GitHub`（存在しない PR なので 404）で、
    PR のタイトルとは無関係だった＝**永久に落ちない検査**だった。
    → **一時タブの行数の増減**（載る前 2 行 → 載った後 1 行）で見るように直した。
    ⑩ は**前提（直前が未読だったこと）を見ていなかった**ので、
    ⑪ の不具合で未読が立っていない状態でも「未読が落ちた」で PASS していた。
    → `選ぶ前 unread=true → 選んだ後 unread=false` の**両方**をアサートに出すようにした。
    直した検査は、壊したコード（③ 除外条件を外す / ⑩ 共通経路から未読解除を外す /
    ⑪ 判定を「タブが存在する」に広げる）で**3つとも FAIL する**ことを確認済み
  - **検証 ⑳ の判定が素通りしていた**。仕込むキャッシュの `credentialKey` を
    アプリ側にしか作れない値だと思って別物にしていたが、
    それだと「PAT が無いので 0 行」でも PASS してしまう。
    **検証側でも `sha256(token)` を計算して一致する fingerprint を仕込み**、
    「一致すればキャッシュが出る（取得は 500 で失敗させたまま）→
    トークンを差し替えると捨てられる」の**両方**を見るように直した。
    1000 件が 200 件に切られることもここで実測している

- **2026-08-25 レビュー反映**: 指摘7件のうち**6件をそのまま採用**した。
  - 共有状態の組み立てが `ipc.ts:176` と `registry.ts:1401` の2箇所にあり、
    再配信トリガーも3つしか無いことを実際に確認 → Phase 3 で一本化 + `onLiveFolderChanged`
  - `settings.json` が `SYNCED_FILES`（`sync-schema.js:38`）に入っているため PAT を分離。
    `isEncryptionAvailable` / 復号失敗の破棄 / `--hostname github.com` / 優先順位を PAT 側に統一 /
    `github_pat_` パターン / `Error.message`（`log-redact.js:88`）の秘匿も追加
  - fixture は実レスポンスの置換をやめて**合成**にした（owner・URL・login まで消し残るため）
  - single-flight + 世代番号、GraphQL の 200 + `errors` 検証、
    「隠す」の復帰トグル、未読解除を `registry.ts:1804` の共通経路へ、を追加
  - **シークレットウィンドウでは非表示**（ユーザー判断）。`SharedState` の時点で渡さない
- **2026-08-26 レビュー12巡目**: 1件採用（記述の誤りの訂正）。
  - 11巡目に書いた「新しいトークンには古いトークンのレート制限は関係ない」は**誤り**。
    GraphQL の primary rate limit は**トークン単位ではなくユーザー単位**で、
    **同じアカウントの別 PAT に貼り替えても制限は共有される**。
    トークン変更の予約を 1 回だけ通す挙動自体は変えない
    （**新しいトークンが誰のものかは取得するまで分からない**ので、
    別アカウントの可能性に 1 リクエストを払う）が、理由の書き方を直した。
    **その 1 回も `rate-limit` なら以後は `resetAt` まで投げない**ことを明記し、検証㉗を追加
- **2026-08-26 レビュー11巡目**: 1件採用。
  - **世代番号が「レート制限を観測した事実」まで捨てていた。**
    自動取得の実行中に手動 `Refresh` を押すと世代が進み、
    走っていた取得が `rate-limit` を返しても**古い世代なので結果ごと破棄**され、
    レート制限が記録されないまま**予約ぶんが即送信**される
    （＝「`rate-limit` は手動でも上書き不可」が破れる）。
    **世代番号が制御するのは「一覧を置き換えてよいか」だけ**とし、
    失敗の分類・`nextAutomaticAttemptAt`・レート制限の事実は**世代が古くても記録する**ことにした。
    そのうえで `rate-limit` 観測時は**同じ `credentialKey` の予約をキャンセル**する
    （トークン変更で立った予約は別の資格情報なので、そのまま実行してよい）。
    検証㉖でこの経路を直接踏む
- **2026-08-26 レビュー10巡目**: 3件とも採用。
  - **手順の順序に実バグがあった。** 「①要求が来たら世代を進める →
    ③実行中の自動要求は捨てる」の順だと、**捨てるはずの要求が世代番号だけ進めてしまい**、
    走っている取得が完了時に「自分の世代は最新でない」と判定されて
    **正常な結果まで捨てられる**（focus を撃つたびに一覧が更新されなくなる）。
    **「実行中の自動要求は世代に触れず即 return」を先頭に置く**順序へ直した。
    検証⑮も「リクエスト数が1」だけでなく
    **「その1回の結果が最終状態として適用された」**ことを見るようにした
  - **`Retry-After` は秒数とは限らない**（RFC 9110 は HTTP-date も許す）。
    `parseRetryAfter()` に閉じて「整数 → HTTP-date → どちらも不正なら null（通常のバックオフ）」
    と決め、HTTP-date と壊れた値の fixture を追加。
    **変な値のせいで永遠に待つ**状態を作らない
  - 検証⑭の「403 が Reconnect にならない」が㉔（権限不足 403 → Reconnect）と衝突していたので、
    **「`remaining:0` の rate-limit 403 が Reconnect にならない」**に対象を限定した
- **2026-08-26 レビュー9巡目**: 4件とも採用。
  - **権限不足の PAT が `transient` に落ちていた**。fine-grained PAT で対象 org や権限が
    足りないと 403 `Resource not accessible by personal access token` が返る。
    401 でもレート制限でもないので、**永遠に `Couldn't refresh` を出して再試行し続ける**。
    直し方は「トークンを直す」なので `auth` に分類する
  - **実行中に来た自動要求を予約していたので、focus 連打が抑えられていなかった**。
    `nextAutomaticAttemptAt` は**完了するまで更新されない**ため、
    1回目の取得中に来た2回目の focus が古い期限を通過して予約を立ててしまう。
    **自動（タイマー / focus / resume）は実行中なら予約せず捨てる**、
    **予約できるのは手動と設定・トークン変更だけ**に変更。検証⑮はこれで初めて成立する
  - **検証⑲が仕様と矛盾していた**。初回バックオフは 60 秒なので
    「失敗から 60 秒後の focus」は走るのが正しい。
    2回失敗させて 120 秒バックオフに入れてから 60〜120 秒の間に撃つ手順に直した
  - **`retry-after` 単独で `rate-limit` と断定していた**。`Retry-After` は
    **503 でも正当に使われる**（RFC 9110 §10.2.3）ので「5xx は transient」と衝突する。
    #1 を 403 / 429 に限定し、**`transient` でも `retry-after` は待機時刻として尊重する**
    （503 + `Retry-After: 120` なら分類は transient のまま次の試行を 120 秒後にする）
- **2026-08-26 レビュー8巡目**: 1件採用。
  - secondary limit の**本文判定をステータスで絞っていた**（403 / 429 限定）。
    GraphQL の secondary limit は **HTTP 200 でも返り**、
    しかも `errors[].type` が付かず `message` にだけ出ることがある。
    `RATE_LIMITED` の type だけ見ていると 200 の secondary limit を丸ごと見逃すので、
    **本文判定はステータスに関係なく当てる**ことにした。
    fixture に「200・type なし・message に secondary rate limit」を
    `retry-after` あり / なしの2本追加
- **2026-08-26 レビュー7巡目**: 3件 + 軽微2件とも採用。
  - **secondary rate limit を取りこぼしていた。** GitHub は
    `remaining` が残っていても secondary limit を出し、`retry-after` を返す。
    `remaining: 0` だけを条件にすると
    「403・`remaining` あり・`retry-after` あり」が `transient` に落ち、
    **制限中に手動 Retry を許してしまう**。判定を
    `retry-after` → `remaining: 0` → `RATE_LIMITED` → 本文の secondary 判定 の順に拡張し、
    fixture も4経路ぶん用意する
  - **`execFile('gh', …)` では packaged 版で gh を見つけられない。**
    Finder 起動の macOS アプリの PATH に `/opt/homebrew/bin` が無いことがあり、
    **ターミナルから `pnpm dev` している間は通るので気づけない**。
    継承 PATH → `/opt/homebrew/bin/gh` → `/usr/local/bin/gh` の順に実行権を見て
    絶対パスで解決する（手元の実測では `/opt/homebrew/bin/gh`。`/usr/local/bin/gh` は無い）。
    main 側に `execFile` の前例が無いので `gh-path.ts` に単独で置く。
    **packaged 版を Finder から起動して確かめる**手順も人間の確認に追加
  - キャッシュの normalize 規則を明文化（200 件上限・URL は
    `https://github.com/<owner>/<repo>/pull/<n>` のみ・長さ・4値/2値・日時・
    `credentialKey` の形式）。**この URL はそのままタブで開かれるので最後の防波堤になる**
  - **`live-folder-open` は renderer が渡した URL をそのまま開かない**。
    いま一覧にある項目とだけ照合する
  - `rate-limit` 中は右クリックの「いま更新する」も disabled に（末尾行と挙動を揃える）
  - `NEMO_GITHUB_TEST_AUTH` の見出しを3値に更新
- **2026-08-26 レビュー6巡目**: 5件 + 軽微1件とも採用。**plan 内部の食い違いの掃除が中心**。
  - 打ち切りの旧記述（`{shown,total}` を小見出しへ）が本文2箇所に残っていたので削除
  - 表示の優先順位の表が「401 / 403 → Reconnect」のままだったので、
    `auth` / `rate-limit` / `transient` に書き換え。`rate-limit` では `Retry` を出さない
    （押しても投げないので、出すと嘘になる）
  - **キャッシュの照合を「世代の連番」から「トークンの非可逆 fingerprint」に変更**。
    連番はメモリ上なので**再起動で振り直され**、正しいキャッシュまで弾く。
    `viewer.login` は API 成功後にしか分からず**事前照合に使えない**。
    `sha256(token)` の先頭 16 文字なら起動直後・取得前に照合でき、
    外部で gh のアカウントが変わった場合も弾ける
  - **`nextAutomaticAttemptAt` 1つに寄せた**。タイマー 60 秒と focus ゲート 60 秒が
    それぞれ独立していると、**transient 失敗後の 15 分バックオフを両方が迂回する**。
    タイマーは「起きて条件を見るだけ」にして、間隔の決定権を持たせない。
    手動は `transient` / `auth` を上書きでき、**`rate-limit` は上書き不可**
  - 再有効化の矛盾を解消（false は push のみ / true は push + 即時取得）
  - 検証⑮の「手動は1回ごとに走る」は single-flight と衝突するので、
    「前回の完了後に1回ずつ押せば毎回走る」に限定。⑲⑳を追加
- **2026-08-25 レビュー5巡目**: 4件とも採用。
  - 検証⑦が旧 UI 仕様（小見出しに `N of 137`）のままだった。
    3巡目で表示を変えたときに検証側を直し忘れていたので、新仕様に合わせた
  - テスト認証に **`stored-only`** を追加。`dummy` 固定だと
    「PAT 保存 → 取得 → 削除 → `Connect GitHub`」を同一プロセスで再現できなかった。
    どの値でも `gh auth token` は呼ばない
  - **キャッシュに `viewer.login` と資格情報の世代を持たせた**。
    別アカウントの PAT に貼り替えて取得が失敗すると、
    **前のアカウントの PR が「前回の内容」として出続ける**。
    PAT の保存・削除でキャッシュを捨て、一致しないキャッシュは表示しない。
    `github-token.json` に平文 PAT が無いことの検証も追加
  - **focus 取得にゲートを付けた**（最終試行から 60 秒）。single-flight は同時実行しか
    抑えないので、アプリを行き来するだけで 60 req/h を大きく超える。
    手動だけゲートを上書きでき、**`rate-limit` 中は手動も含め `resetAt` まで投げない**。
    `liveFolderEnabled` を false → true に戻したときは即時取得する
- **2026-08-25 レビュー4巡目**: 5件とも採用。
  - 検証⑪が仕様と食い違っていた（仕様は「新規出現で未読」、検証は「更新で未読」）。
    **仕様は変えず**（`updatedAt` 変更で未読にすると、自分がコメントしただけで未読が立つ）、
    検証を「1回目に出さない → 非アクティブなタブで開いておく → 2回目に現れる」に直した
  - **設定・トークン変更時の即時 push を追加**。契機が `onLiveFolderChanged` だけだと、
    PAT を貼っても最大 60 秒何も起きず、壊れて見える
  - **打ち切り表示は3巡目の指摘なので、表示の書き方をいじるのをやめてデータを分けた**。
    `rendered`（描画行数）/ `search.returned`（100）/ `search.total`（137）の3つを別に持ち、
    小見出しには `rendered` だけ、打ち切りは末尾に
    `First 100 of 137 fetched for CREATED` として別行で出す。
    `95 of 137` は重複除外後の数と重複込みの検索ヒット数を混ぜた表記だった
  - **失敗を `auth` / `rate-limit` / `transient` の3分類**にして Phase 1 で確定させた。
    **403 を一律 `auth` にしない**（secondary rate limit でも 403 が返る。
    `x-ratelimit-remaining` で分ける）。`resetAt` は成功時 `rateLimit.resetAt`、
    403/429 は `x-ratelimit-reset` ヘッダ。判別は `classifyFailure()` の述語1つに閉じ、
    UI 側で HTTP ステータスを見ない
  - **状態バッジの真理値表**を追加。approve 済みの PR を draft に戻すと
    `isDraft: true` と `reviewDecision: APPROVED` が同時に立つので、**`isDraft` を最優先**。
    draft に緑チェックを出すと「もう通っている」と誤読される
  - コスト比率の表記を `1.2%` → `1.2〜2.4%` に揃えた
- **2026-08-25 レビュー3巡目**: 5件とも採用。
  - **`sort:updated-desc` を両クエリに追加**。無いと best-match 順で返るため、
    100 件で切られたときにどの 100 件が残るかが不定になる。
    取得後に並べ替えても取得されなかった PR は救えない
  - 打ち切りの表示は `100 / 137` をやめ、`95 of 137`（描画行数 of 総ヒット数）に
    （**→ 4巡目でさらに変更。いまは小見出しに描画行数だけを出し、打ち切りは末尾に別行**）
  - **`NEMO_GITHUB_TEST_AUTH=dummy|none`** を追加。差し替え中を常にダミートークンにすると、
    `Connect GitHub`（検証④）へ到達できなかった。どちらの値でも実 PAT / gh は読まない
  - `liveFolderEnabled` のスキーマ追加手順（`DEFAULT_SETTINGS` / `normalizeSettings` /
    `NemoSettings` / `settings-schema.test.mjs`）を Phase 5 に明記。
    **`SETTINGS_VERSION` は上げない**（キー追加は normalize が埋める。
    版を上げると同期先の古い Nemo が拒否する）
  - **コストを実測し直した**。`first: 100` ×2・`sort` 付き・`rollup` 無しで `cost: 1`
    （`remaining` 4999）。ただし 100 件返る状況は未実測なのでその旨を明記し、
    実装後に `rateLimit.cost` をログへ出して確かめることにした。
    **`commits.statusCheckRollup` は使っていないので削除**（CI 状態は表示しない仕様）
- **2026-08-25 レビュー2巡目**: 4件とも採用。
  - single-flight と「2つの取得を重ねる」検証が矛盾していた（同時実行しないので撃てない）。
    「世代を進める → 実行中なら予約1件 → 古い世代は適用しない → 終了後に予約を実行」に整理し、
    検証も「同時実行が常に1本・最後の要求が最終状態・古い応答が上書きしない」に変えた
  - 打ち切りは**検索単位**（review と mine は別々に 100 で切られ、重複を review へ寄せるので
    合計では表現できない）。`truncation.review` / `.mine` に分け、
    表示も末尾行ではなく その小見出しの右 に置いた
    （**→ 4巡目で再変更。打ち切りは末尾の別行に戻した**）
  - 「開いている PR は未読にしない」は**アクティブなタブに限定**。
    バックグラウンドで開きっぱなしのタブまで既読になると更新に気づけない。
    未読は**全ウィンドウ共有**であることも明記した
  - endpoint 差し替えは、単体テストは**fetch 注入**、UI 検証は既存の
    `NEMO_MEET_TEST_URL_PREFIX` と同じ `!app.isPackaged` ゲートに揃え、
    **差し替え中はトークンを一切読まない**（本物の PAT を任意ホストへ送る経路を塞ぐ）
  - 冒頭の「全部出す」も「各検索の先頭 100 件まで + 超過を明示」に直した
- **2026-08-25 部分採用**: 「`first: 20` の打ち切り」への対応は**ページングを入れない**。
  `first: 100`（`search` の上限）に上げ、`issueCount` で超過を検出して
  `Showing 100 of 137` と**明示する**方式にした。open PR が 100 件を超えるのは平常時にありえず、
  100 行出た時点で一覧として機能していないため、ページングの複雑さに見合わない。
  「GraphQL 1発・コスト 1・60 req/h」の前提はこれで維持できる。
  検証は 21 件ではなく**101 件以上の fixture** で境界を踏ませる。
- **2026-08-25**: タブの紐づけを「`pinnedId` 方式の専用タブ」から「URL 一致」に変更。
  PR は URL が自然キーで、定義 ID を発行すると PR が消えるたびに降格処理が必要になる。
  URL 一致なら、一覧から消えた時点でタブが「今日のタブ」に現れる＝降格と同じ結果が
  追加の規則なしで得られる。`TabState` の `pinnedId` / `favoriteId` の排他条件も 2 値のまま保てる。
