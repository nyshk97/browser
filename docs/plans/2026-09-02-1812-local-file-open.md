# ローカルファイル（`file://`）を人間の操作からだけ開けるようにする

## 概要・やりたいこと

scratchpad に置いた HTML モック（`/private/tmp/claude-501/.../peek-loading-mock.html`）を Nemo で見たいのに、
`open <path>` / Finder のダブルクリック / アドレスバーへのパス入力のどれでも開けない。

3 つの操作はそれぞれ別の理由で失敗している（2026-09-02 調査）:

1. **`open <path>` / Finder**: `.html` の既定アプリは Nemo（`duti -x html` → `/Applications/Nemo.app`。
   `electron-builder.yml:95` の `CFBundleDocumentTypes` で HTML 書類を宣言している）。macOS はファイルを
   `open-url` ではなく **`open-file` イベント**で渡すが、Nemo は `open-url` しか購読していない
   （`src/main/open-url.ts:62`）。Electron は未購読なら何もしないので、アプリが前面に出るだけで終わる。
   常用 Nemo のログにも `navigation.blocked` / `open_url.*` が 1 件も無い（届いたが誰も受け取っていない）
2. **アドレスバーに `/private/tmp/...`**: `normalizeNavigationInput`（`src/shared/navigation-policy.js:141`）は
   scheme 無しの入力を「ドメインらしければ URL、そうでなければ検索」に振る。`/` 始まりはドメイン判定に落ちて Google 検索になる
3. **アドレスバーに `file:///...`**: `DENIED_SCHEMES`（同 21 行目）で明示的に拒否。IPC が例外を投げるが
   （`src/main/ipc.ts:296`）Toolbar は `void window.nemo.navigate(...)` で結果を捨てる（`Toolbar.tsx:118`）ので**無言**

やること: **`file:` を全面解禁せず、「人間が明示的に開いた経路」からだけ通す**。
Web ページ・拡張が起点の `file:` は今までどおり拒否する。

## 前提・わかっていること

### なぜ限定解禁か（全面解禁との差）

- Chromium 自身が `webSecurity` 有効のまま塞いでいるもの: renderer 発の http(s) → `file:` ナビゲーション
  ("Not allowed to load local resource")、`file:` ページからの fetch / XHR、各ファイルは別々の opaque origin
- **Nemo の allowlist だけが守っているもの**: main プロセス発の `loadURL` は browser-initiated 扱いで
  レンダラの file アクセス権チェックを受けない。Nemo は外から受けた URL を main で `loadURL` する入口を複数持つ
  （`setWindowOpenHandler` `registry.ts:914`、`chrome.tabs.create` / `chrome.windows.create` `extensions.ts:522, 547`、
  `createTab` `registry.ts:2303`、スリープ復帰 `materialize` `registry.ts:642`）。全面解禁すると
  **Web ページが `window.open('file:///...')` 一発でローカルファイルをタブとして開ける**（Chrome が拒否する経路）
- 限定解禁のコストは「ポリシーにフラグ 1 つ ＋ 立てる呼び出し 2 箇所」なので、層を残す

### 決定表

| 起点 | `file:` | 根拠 |
|---|---|---|
| `open-file` イベント（Finder / `open <path>`） | **許可** | 人間が OS で開いた。`open-url` と同じ queue に載せ、**小窓で開く**（外部アプリ由来の URL の既存規約に合わせる。⌘O で昇格できる） |
| argv の `file://` URL（`open --args` / 検証スイート） | **許可** | プロセスを起動した者しか渡せない。`urlsFromArgv` を `file://` も拾うよう広げる |
| アドレスバー / コマンドバー入力（`nemo:navigate` / Toolbar の `createTab` / ⌘L の候補「そのまま実行」行 `suggest.ts`） | **許可** | 人間の入力。`file://` URL のほか、`/` 始まり・`~/` 始まりは**実在するパスのときだけ** `file://` に変換する（実在しなければ今までどおり検索へ。「`/` で始まる検索語」を壊さない） |
| `file:` ページ内のトップレベル遷移で別の `file:` へ（`will-navigate` / `will-redirect`） | **許可** | Chrome と同じ（現在のページが `file:` なら file→file を通す）。http(s) → `file:` は今までどおり拒否。**サブフレーム（`<iframe src="./x.html">`）は拒否のまま**（2026-08-25 の決定。ローカル HTML の iframe は空になる。CHANGELOG に 1 行残す） |
| スリープ復帰（`materialize`） | **許可** | `tab.url` は一度ゲートを通った値しか入らない |
| 再起動後の復元・ウィンドウ間の共有（一時タブ定義 `ephemeral-tabs.json`） | **載せない** | `file:` タブはウィンドウローカルのまま。他ウィンドウに共有されず、再起動で消える（1回目で決定。根拠: 版 5 のセッションはタブ URL を持たず、復元は定義側が担う。定義の入口 `normalizeStoredUrl` は Favorites / ピンと共通なので `file:` を通すと 223 行の意図が崩れる。モック閲覧は一時的で、履歴に残さない判断とも揃う）。**定義を持つタブが `file:` へ遷移したときは定義に何も書かない**（url が弾かれるのに title だけ書くと「ローカルファイルの題名 ＋ 古い http の URL」の行になる） |
| `open-url` イベントの `file://` 文字列 | 拒否のまま | LaunchServices はファイルを `open-file` で渡す。`open-url` に `file:` が来る正規経路は無い |
| Web ページの `window.open` / `<a target=_blank>` | 拒否のまま | Chrome が拒否する経路 |
| 拡張の `chrome.tabs.create` / `windows.create` | 拒否のまま | 同上 |
| Favorites / ピン留め / 一時タブ定義の URL | http/https のまま | `settings-schema.js:223`「設定ファイル経由で `file:` が開ける」を維持 |
| 履歴 | 記録しない（`history.ts:24` のまま） | コマンドバーにローカルパスが並ぶ意味が薄い。必要になったら別件 |
| `file:` ページからの permission 要求 | 拒否のまま（`normalizeOrigin` が null を返す） | 全ローカルファイルが 1 origin を共有するので「今後も同じ扱い」が危ない。必要になったら別件 |

### 実装上の前提

- `normalizeNavigationInput` / `isNavigableUrl` は Node 非依存の純粋関数（`scripts/navigation-policy.test.mjs` で直接テスト）。
  **パス → URL の変換（`pathToFileURL`、`~` の展開）は main 側（`ipc.ts` の `resolveInput`）でやり**、
  純粋関数には `allowFile` 相当のオプションだけ足す
- `open-file` は `open-url` と同じく **`app.ready` より前に購読**しないと起動時の分を取りこぼす（`open-url.ts` 冒頭のコメント参照）。
  `hasPendingOpenUrls` が起動ウィンドウの判断に使われているので同じ queue に入れる
- `open-file` → `openMiniWindow(url)` → `fillMiniWindow` → `new NemoTab(win, url)` → `materialize` の
  `resolveNavigationTarget(..., 'materialize')`（`registry.ts:642`）を通る。ここに `allowFile` を渡す
- `redactUrl('file:///...')` は `'file:'` になる（パスはログに出ない）。そのまま使える
- 検証スイートは**登録**（`scripts/lib/verify-targets.mjs`）と**配線**（`scripts/verify-all.mjs` の `if (want(...))`）が別。
  登録だけだと「速く PASS」する（CLAUDE.md）。新スイートは配線を外して 0 件になるのを見てから戻す
- `src/main/open-url.ts` / `src/shared/navigation-policy.js` / `src/main/security.ts` は `OWNERS` 未登録（触るとフルに倒れる）。
  **未登録のファイルを新たに載せない**（CLAUDE.md）
- 検証で `open-file` を撃つには実バンドルに `open -a` するしかない。verify-all が起動する dev の Electron は
  `node_modules/electron/dist/Electron.app` なので、`open -a <そのパス> <file>` で起動中のインスタンスに届くはず
  （届かなければ人間の確認に落とす）。**常用 Nemo（`/Applications/Nemo.app`）には絶対に渡さない**

## 実装計画

### 事前準備 [人間👨‍💻]
- なし

### Phase 1: ポリシー（純粋関数）と単体テスト [AI🤖]
- [x] `src/shared/navigation-policy.js`
  - [x] `NavigationPolicy` に `allowFile?: boolean`（起点が人間の入力・OS・argv のときだけ true）と
        `fromFile?: boolean`（現在のページが `file:`。file→file だけ通す）を足す。
        **`src/main/security.ts` の `NavigationPolicy` は shared の typedef と別実体の TS interface**なので同時に広げる
        （ここが抜けると `open-url.ts` からの `{ allowFile: true }` が typecheck で落ちる）
  - [x] `isNavigableUrl`: `file:` は `allowFile || fromFile` のときだけ通す。`subframe` では通さない
        （`2026-08-25` の「`file:` はサブフレームでも拒否」を維持）
  - [x] `normalizeNavigationInput(input, template, { allowFile })`: `allowFile` のとき `file://` URL を通す。
        フラグ無しは今までどおり `scheme_not_allowed:file:`
  - [x] `urlsFromArgv`: `file://` も拾う（拾った後の判定は呼び出し側の `isNavigableUrl` が `allowFile: true` で行う）
  - [x] `DENIED_SCHEMES` のコメントを「既定は拒否。人間の入力・OS・argv 起点だけ `allowFile` で通す」に直す
- [x] `scripts/navigation-policy.test.mjs`
  - [x] フラグ無しで `file:///etc/passwd` が拒否される既存ケースは**そのまま残す**
  - [x] `allowFile: true` で `file:///...` が通る / `fromFile: true` で通る / `fromFile` でも `subframe` は拒否
  - [x] `allowFile: true` でも `javascript:` / `data:` / `nemo://ui/` は拒否（緩みの巻き添え防止）
  - [x] `urlsFromArgv(['file:///x.html', 'javascript:...'])` → `['file:///x.html']`
- [x] `mise run test` が通る

### Phase 2: main の入口 [AI🤖]
- [x] `src/main/open-url.ts`
  - [x] `app.on('open-file', (event, path) => { event.preventDefault(); accept(pathToFileURL(path).href, 'open-file', { allowFile: true }) })`
        を `installOpenUrlHandler` に足す（`open-url` と同じく ready 前）
  - [x] `accept` に `allowFile` を通す。argv 経路（`installOpenUrlHandler` / `handleSecondInstance`）は
        `urlsFromArgv` が `file://` を拾うので `{ allowFile: true }` で判定する。`open-url` イベントはフラグ無しのまま
  - [x] ログ `open_url.handled` / `open_url.queued` の `source` に `'open-file'` が出る
- [x] `src/main/ipc.ts` の `resolveInput`
  - [x] `/` 始まり・`~/` 始まり（`os.homedir()` で展開）は **`fs.existsSync` で実在するときだけ** `pathToFileURL(...).href` に変換。
        実在しなければ従来どおり `normalizeNavigationInput` へ渡す（検索に落ちる）
  - [x] `normalizeNavigationInput(input, template, { allowFile: true })` で判定
  - [x] `nemo:navigate` / `nemo:create-tab`（Toolbar の `createTab(input)`）の両方がここを通ることを確認
- [x] `src/main/registry.ts`
  - [x] `materialize`（642 行付近）: `resolveNavigationTarget(target, { allowExtensionPages, allowFile: true }, 'materialize')`
        （`this.url` / `pendingUrl` への代入は宣言・`materialize` の後始末・`sleep` の 3 箇所だけで、ゲート済みの値しか入らない。
        この事実をコメントに残す。将来ここに外部由来の値を入れる経路が増えたら `allowFile` を見直す）。
        **外部 URL の小窓（`fillMiniWindow` → `new NemoTab` → `materialize`）はこの 1 箇所で足りる**（`createTab` を通らない）
  - [x] `createTab`（2303 行付近）: `CreateTabOptions` に `allowFile` を足し、**唯一の呼び元は IPC の `nemo:create-tab`**。
        `setWindowOpenHandler`（914）・拡張（`extensions.ts`）は触らない
  - [x] **タブの現 URL が http/https でなければ、ページ由来の値（url / title / favicon）を一時タブ定義に書かない**共通ガードを置く。
        対象は `page-title-updated`（750 付近）/ `page-favicon-updated`（767 付近）/ `syncEphemeralDefinition`（3636 付近）の 3 箇所。
        `syncEphemeralDefinition` だけ塞ぐと**題名と favicon は古い http 定義に書き込まれ続ける**
        （`updateEphemeralFromTab` は url だけ弾いて title を書く）。
        **`renameTab`（3772 付近）は対象外**（ユーザーが明示的に打った名前は従来どおり定義へ書く。ガードを掛けると
        `ephemeralId` ありの early return で定義にも `customTitle` にも書かれず黙って何も起きない）。
        `ensureEphemeralDefinition` 側は `addEphemeralTab` が `normalizeStoredUrl` で弾くので `file:` タブは定義化されない
        （そのままでよいことを確認）
- [x] `src/main/security.ts` の `applyWebContentsSecurityDefaults` の中の `policyForCurrentPage` / `guard`
  - [x] `policyForCurrentPage` に `fromFile: contents.getURL().startsWith('file:')` を足す
  - [x] `will-navigate` / `will-redirect` は `subframe` の扱いを今のまま維持
- [x] `settings-schema.js` / `normalizeSession` / `normalizeStoredUrl` は**触らない**（決定表「載せない」）
- [x] **既存検査の書き換え**（`resolveInput` に `allowFile` を入れた瞬間に赤になる）
  - [x] `scripts/verify-phase1.mjs:211` / `scripts/verify-spike.mjs:220` の `window.nemo.navigate(key, 'file:///etc/passwd')` の
        reject を PASS 条件にしている箇所を「人間の入力からは通る（URL が `file:` になる）/ 拡張・ページからは拒否」に書き換える。
        拒否側の代表は `javascript:` / `data:` / `nemo://ui/` に寄せる
  - [x] `VERIFY.md:165 / 205 / 512` の「`file:` を拒否」の文言を同じ趣旨に直す。**`172`（拡張から渡された `file:` は拒否）と
        `204`（UI は `file://` で配信しない）は今回も真なので据え置く**
- [x] `mise run typecheck` / `mise run lint` / `mise run test` が通る

### Phase 3: アドレスバーの無言を直す [AI🤖]
- [x] `nemo:navigate` / `nemo:create-tab` の**ポリシー拒否（`resolveInput`）だけ**を機械可読な理由で Toolbar に返す。
      `loadURL` 側の失敗（`ERR_FILE_NOT_FOUND` / `ERR_ABORTED`）は赤枠にしない（この機能では「存在しないパスを打った」が
      最頻の失敗で、Chromium のエラーページが出る。拒否と混ぜない）
- [x] 拒否されたら入力欄に文字列を戻し（`setDraft(input)`）、赤枠＋ `title` で理由を出す。
      Toolbar View は高さ 40px なのでインライン文言は出さない（ログ `navigation.blocked` は今までどおり残る）
- [x] 数秒で赤枠を消す

### Phase 4: 自走検証 [AI🤖]
- [x] `test-pages/local-a.html` / `local-b.html`（a から b へ `<a href="local-b.html">`、a に `window.open('file:///...')` を
      試すボタン）を置く。既存の `test-pages/` は http 配信もされるので、http 側からの `file:` 遷移の検査にも使う
- [x] `scripts/verify-local-file.mjs` を新設。**`verify-shared-tabs.mjs` と同じく自分でアプリとページサーバ
      （`scripts/test-server.mjs`）を起動する**（`open -a` と 2 つ目のインスタンスを自分の Electron に向けるため。
      `settings.json` fixture で Live Folder を止めてから起動）。検査:
  - [x] argv に `file://<test-pages>/local-a.html` を付けた 2 つ目のインスタンス → 小窓が 1 枚開き、タブ URL が `file://` で
        `document.title` が取れる（`verify-peek.mjs` の `openExternalUrl` と同じ手口）
  - [x] `open -a node_modules/electron/dist/Electron.app <test-pages>/local-b.html` → ログに `open_url.handled source=open-file`
        が増え、小窓がもう 1 枚開く（届かなければ **「人間の確認」に落として理由をログに残す**）
  - [x] `window.nemo.navigate(key, '/abs/path/local-a.html')` → タブ URL が `file://` になる
  - [x] `window.nemo.navigate(key, 'file:///abs/path/local-a.html')` → 同上
  - [x] `window.nemo.navigate(key, '/no/such/path')` → 検索 URL になる（実在しないパスは検索に落ちる）
  - [x] `file:` ページ内のリンククリックで `local-b.html` へ遷移できる
  - [x] http で開いた `local-a.html` から `location.href = 'file:///...'` → **URL が変わっていない**ことを主検査にする。
        Chromium が renderer 内で止めると `will-navigate` に届かないので、`navigation.blocked` の件数は補助情報として記録するだけ
  - [x] http ページの `window.open('file:///...')` → **小窓・タブが増えていない**ことを主検査にする（`navigation.blocked phase=popup` は補助）
  - [x] `file:` ページの `window.open('file:///...')` も拒否（起点が人間でない）
  - [x] `~/` 始まりの入力が `os.homedir()` 配下に解決される（`~/` から `test-pages` へ届く実在の相対パスを使う。
        `path.relative(os.homedir(), projectRoot)` が `..` を含む環境ではこの項目だけ skip と出す）
  - [x] アドレスバーで拒否された入力（`javascript:alert(1)`）で入力欄に文字列が残る（Phase 3）
- [x] `scripts/lib/verify-targets.mjs`: `KNOWN_TARGETS` / `OWNERS`（`scripts/verify-local-file.mjs`、
      `test-pages/local-a.html`、`test-pages/local-b.html` の 3 エントリ。`OWNERS` のキーは実在パスで
      `verify-targets.test.mjs` が `existsSync` で検査するのでワイルドカードは書けない。`test-pages/` の登録はこれが最初）に登録。**`NEEDS_APP` には入れない**（自分で起動するスイートを入れると
      共有アプリとページサーバが 1 つ余分に立つ。`shared-tabs` と同じ扱い）。`scripts/verify-all.mjs` では
      **`shared-tabs` の後ろに置き、`if (want('local-file'))` の中で先に `await stopAll()` を呼ぶ**
      （`open -a <Electron.app>` はバンドル単位の配送で宛先インスタンスを選べない。共有アプリが生きていると `open-file` がそちらに届く）
- [x] **配線を外した状態で `mise run verify:only local-file` を回して検査 0 件を見てから**戻す。報告に検査件数を出す
- [x] `mise run verify:only local-file` と、既存の拒否検査（`phase1` の scheme 拒否・`peek` の小窓）を回す
- [x] `VERIFY.md` に手順を追記（既存の粒度に合わせる）

### Phase 5: ドキュメント [AI🤖]
- [x] `docs/CHANGELOG.md` の `[Unreleased]` → `追加`: 「ローカルの HTML を開ける（Finder / `open` / アドレスバーにパス）。
      Web ページ・拡張からの `file:` は今までどおり開かない。ローカル HTML の中の iframe は表示されない。
      再起動では復元されない」、`修正`: 「アドレスバーで拒否された入力が無言だったのを直す」
- [x] `docs/operations.md` のセキュリティ節に決定表の要点（許可 3 経路・拒否のまま 3 経路）を 1 段落で足す
- [x] `docs/plans/2026-08-23-0115-nemo-browser.md:206` の「`file:` 既定は拒否」は真のまま（起点限定の許可）なので触らない。
      本 plan へのリンクだけ足す

### 動作確認 [人間👨‍💻]
- [ ] `mise run release` は会社貸与 PC なら自分の Terminal で叩く（グローバルルール）。dev 版で先に
      （**`.html` の既定アプリは常用の `/Applications/Nemo.app` なので、素のダブルクリックや `open <path>` は
      未修正の常用 Nemo に届く**。dev 版へ向けて撃つ）:
  - [ ] Finder で `.html` を右クリック →「このアプリケーションで開く」→ Nemo-dev → 小窓で開く
  - [ ] Terminal で `open -a <dev 版の .app> /private/tmp/claude-501/.../peek-loading-mock.html` → 同上
  - [ ] リリース後に常用 Nemo で素のダブルクリックと `open <path>` を確認
  - [ ] アドレスバーに `/private/tmp/...html` → そのタブで開く。`~/foo.html` も
  - [ ] アドレスバーに `javascript:alert(1)` → 入力が残って赤枠が出る
- [ ] 自走検証で `open -a` が届かなかった場合のみ: 上の Finder / `open` の 2 項目を人間が担当する

## 今回の範囲に入れないもの（将来課題）

- ローカルファイルの履歴記録（コマンドバーから「さっき見たローカルファイル」に戻る手段。今は毎回パス入力）
- `file:` ページからの permission 要求（カメラ・マイク等。全ローカルファイルが 1 origin を共有する問題を先に決める必要がある）
- `file:` タブの再起動後の復元・ウィンドウ間共有（一時タブ定義に載せる場合は `normalizeStoredUrl` の入口を分けてから）

## ログ
### 試したこと・わかったこと
- 2026-09-02: `open -a node_modules/electron/dist/Electron.app <file>` で起動中の dev Electron に `open-file` が届いた
  （`open_url.handled source=open-file` → 小窓）。人間の確認に落とす必要は無かった
- 2026-09-02: 読み込み中のタブへ `window.nemo.navigate` を撃つと `loadURL` が直前の読み込みの中断（ERR_ABORTED -3）で
  reject する。検査側の `nav()` helper が `loading === false` を待ってから撃ち、-3 だけ握り潰す
- 2026-09-02: 配線を外した状態の `mise run verify:only local-file` は検査 0 件で「すべて PASS」（CLAUDE.md の罠を再現）。
  配線後は 21 件 PASS
- 2026-09-02: http ページからの `location.href = file:` / `window.open(file:)` は Chromium が renderer 内で止め、
  main の `navigation.blocked` は 0 のまま（レビューの予想どおり）。主検査は URL / タブ数の不変で見る
- レビュー 2 回目で見送った「定義に載せない」側の検査 3 項目は実装時に Phase 4 へ入れた（21 件のうち 4 件）
- 2026-09-02: 既存スイートは `spike` / `peek` が全 PASS。`phase1` は 1 回目が「2本指スワイプ」の CDP await が宙に浮いて
  Node の exit 13（unsettled top-level await）、2 回目はスワイプが通って代わりに sticky activation / beforeunload /
  空状態の `visibilityState` の 3 件が FAIL。どれもウィンドウの前面・可視性に依存する検査（CLAUDE.md の
  「visibilityState を PASS 条件に使わない」の類）で、`file:` の変更箇所は通っている。3 回目は 108 件すべて PASS（exit 0）
- 2026-09-02 実装レビュー後: `local-file` 25 件（コマンドバーの 3 件と title の文言検査を追加）と `pins restart` がすべて PASS

### 方針変更
- 拒否時の `title` の文言: 内部識別子（`scheme_not_allowed:javascript:`）は見せず、ユーザー向けの日本語
  「このアドレスは開けません（javascript: で始まるアドレスは開けない種類です）」に落とす。識別子は main の
  `navigation.blocked` ログに残る（実装レビュー 1 回目で決定）
- 定義への書き込みガードを一時タブだけでなくピン留め / Favorites（`setPinnedTitle` / `setFaviconForDefinition`）にも掛けた。
  `pins.json` は永続で、ローカル HTML の題名で上書きされると再起動でも戻らないため（実装レビュー 1 回目）
- ⌘L のコマンドバーの「そのまま実行」行（`suggest.ts`）にも `file:` 解禁とパス変換を入れた。決定表は最初から
  「コマンドバー入力も許可」だったが、実装が `resolveInput` だけで `suggest.ts` を見落としていた（実装レビュー 1 回目）
