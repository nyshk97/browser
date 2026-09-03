# Nemo 運用メモ

README から退避した開発・リリース・運用の手順。自分用。


Arc の代替として作っている自作ブラウザ。Electron + `BaseWindow` + タブごとの `WebContentsView` +
`electron-chrome-extensions` で、Chrome 拡張（Bitwarden 等）が動く。

現在は **Phase 2（常用移行）** まで実装済み。
サイドバー3層・コマンドバー・ダウンロード・セッション復元・権限ダイアログ・パッケージングに加えて、
履歴 / アーカイブのライブラリ・一時タブの自動アーカイブ・シークレットウィンドウ・設定画面・
既定ブラウザ対応・ブックマークのセーブスロット・Arc からの移行が入っている。計画は `docs/plans/` を参照。

## サイドバーの3層

上から Favorites（4列アイコングリッド）→ ピン留め → 一時タブ。

- **Favorites とピン留めは「枠」**。枠は永続で、**タブは押した時点で生まれる**。
  起動時にはピン / Favorites のタブ実体を1つも作らないので、枠が何十個あっても起動が重くならない
- 枠を押すと**必ず登録した URL** が開く（前回そこで見ていた URL は覚えない）。
  遷移しても定義の URL は書き換わらない。変えたいときは右クリックの「このページに更新」
  （今見ているページにする）か「URLを変更…」（URL を直接書く。タブが閉じていても使える。
  Google カレンダーを `?authuser=` 形式に差し替える、のような用途）
- 枠に属するタブは**一時タブの一覧には出ない**。閉じても枠は消えない
- **フォルダは1階層**（フォルダの中にフォルダは作れない）。既存データや Arc の取り込みで
  2階層以上が来たら、中身を親へ平坦化して読む
- 同じ URL が Favorites とピン留めの両方に並ぶことはない。⌘D でピン留めしたら
  その URL の Favorite 定義は消えてピン留めに移る（逆も同じ）
- **ピン留め行・一時タブ行はダブルクリックで名前を変えられる**（右クリック → 「名前を変更」も同じ）。
  **フォルダと Favorites は右クリック → 「名前を変更」だけ**（Favorites の枠は押した瞬間に開く。
  ダブルクリックしても開くだけで編集には入らない）。
  Enter / フォーカスを外して確定、Esc で取消、**空にすると解除**して実タイトルに戻る。
  付けた名前はページ遷移でも再起動でも消えない

### 一時タブはウィンドウ横断で共有される（Arc 風）

一時タブも Favorites / ピン留めと同じ「定義（共有・永続）とタブ実体（ウィンドウごと）」の
二層で、**一覧は全ウィンドウで同じ**。ウィンドウは共有サイドバーのビューにすぎない。

- どのウィンドウで開いたタブも、他の通常ウィンドウの一覧に即座に出る。
  このウィンドウに実体が無い行は薄く表示され、クリックした時点でこのウィンドウに実体化する
- **アクティブ選択とページ実体はウィンドウごとに独立**。同じ行を 2 枚のウィンドウで
  開けば別インスタンス（スクロール位置・フォームは共有されない。Arc と同じ割り切り）
- 一覧の URL / タイトル / 名前は実体のナビゲーションやリネームに追随する（最後に触った実体が勝ち）。
  実体化済みの他ウィンドウは**その行を選んだ瞬間**に定義の現在 URL を読み直す（別ウィンドウで進んだ
  ページの続きが出る。1 ウィンドウで使う限り実体と定義は常に一致するので何も起きない）。
  読み直しは通常の遷移なので「戻る」で元のページに戻れる。会議（Meet）に参加中の実体と
  ローカルファイル（`file:`）を見ている実体は読み直さない。ページの離脱確認（beforeunload）に
  止められたときは確認を出さず、そのまま残す（次に選んだときにまた試みる）
- **タブを閉じる（⌘W・×）と全ウィンドウから消える**。掘り返すのは ⌘⇧T かライブラリ
- **ウィンドウを閉じても一時タブは消えない**（実体が閉じるだけで、定義は一覧に残る）。
  一覧の伸びは定義基準の自動アーカイブ（どのウィンドウでも触っていないものを片付ける）が受け持つ
- **シークレットと小窓は共有に参加しない**。小窓は ⌘O でメインウィンドウへ合流した時点で一覧に入る
- 別ウィンドウで**会議（Meet）に参加中**のタブは、他のウィンドウから開いても二重に実体化せず
  そのウィンドウへフォーカスが移る（未実体化のウィンドウから × で閉じるのも同様に拒否する）
- `about:blank`（⌘T 直後）や拡張ページはウィンドウローカルのタブで、一覧の末尾に出る。
  最初の http/https ナビゲーションで共有の定義になる
- 「タブを新規ウィンドウへ」（⌘⇧N）は廃止（新規ウィンドウにも全タブが出るので不要）

## ライセンス

**GPL-3.0-only**。`electron-chrome-extensions` が GPL-3.0 と Patron License のデュアルで、
Patron License を購入しない以上 GPL-3.0 に準拠する必要がある。詳細は `docs/licenses.md`。

## public repo である前提

このリポジトリは public。**個人情報・シークレット・ブックマーク・履歴を絶対にコミットしない。**
それらは別の private repo（`nemo-config`）と `~/Library/Application Support/Nemo/` に置く。

`.gitignore` で `extensions/`（拡張の実体）・`.ext-cache/`・`.env` 系を除外している。

## セットアップ・起動

```bash
mise run setup     # 依存 + 拡張 artifact を揃える（初回）
mise run dev       # 開発版 Nemo を起動（HMR あり・拡張つき）
```

`mise run dev` は次を一度にやる:

- 拡張が lock と一致しているか検証（ズレたまま起動しない）
- 受け入れテスト用のページサーバを起動（http://127.0.0.1:8787/）
- remote debugging を 9333 で開けて Nemo を起動（**dev のときだけ**）

> CDP に到達できるものは拡張の service worker で任意の JS を実行できる。
> 実アカウントの Bitwarden を入れるときは `mise run dev:nodebug` を使う。

主なタスク（`mise tasks` で一覧）:

| タスク | 内容 |
|---|---|
| `mise run dev` | 開発版を起動（HMR あり） |
| `mise run dev:nodebug` | remote debugging を開けずに起動（実 Vault の Bitwarden を入れて触るとき） |
| `mise run dev:popup` | 拡張 popup の DevTools を自動で開いて起動（popup の不具合を追うとき。CDP は開かない） |
| `mise run dev:build` | ビルドしてから起動（本番に近い経路で確認したいとき） |
| `mise run check` | lint → typecheck → ユニットテスト（コミット前） |
| `mise run test` | ユニットテスト（Electron 不要） |
| `mise run verify` | 自走検証を通す（ビルド→起動→CDP で検証→後片付け） |
| `mise run verify:ext` | 拡張互換の smoke test（自作テスト拡張・資格情報なし・**CI 必須**） |
| `mise run verify:ext-idle` | 上記 + service worker の idle 停止をまたぐ確認（遅い） |
| `mise run package` / `package:stable` | パッケージして成果物を検査（fuses・ネイティブモジュール・notice） |
| `mise run verify:packaged` | パッケージした `.app` を起動して smoke test |
| `mise run icons` | アプリアイコン（常用版 / dev 版）を生成 |
| `mise run licenses` | 依存ライブラリのライセンス棚卸し |
| `mise run release [patch\|minor\|major\|x.y.z]` | 常用版をリリース（署名 → notarize → GitHub Release） |
| `mise run ext:fetch` / `ext:verify` / `ext:update <version>` / `ext:rollback` | 拡張の取得・検証・更新・巻き戻し |
| `mise run verify:ext-update <version>` | 版を上げ下げしても拡張の設定（`chrome.storage`）が残ることを実物で検証 |
| `mise run arc:import [stable\|dev] [--dry-run] [--replace]` | Arc のピン留め・Favorites を取り込む（冪等） |
| `mise run ext:outdated` | 拡張に新しい版が出ていないか確認（何も書き換えない） |
| `mise run test:pages` | テストページのサーバだけ起動 |

## リリース

配布物は [GitHub Release](https://github.com/nyshk97/browser/releases) に置き、
アプリ内自動更新（electron-updater）で配る。

**リリースの経路は `mise run release` ただ1つ**。ここに手順を書き写さない
（別経路を作ると、そちらを辿ったときに未署名のまま公開される）。

```bash
# 1. docs/CHANGELOG.md の [Unreleased] に今回の変更を書いてコミットする
# 2. リリースする（既定は patch）
mise run release
mise run release minor
mise run release 0.2.0
```

`mise run release` は次を順にやる。**preflight で全部検査してから**壊し始める:

1. preflight — clean worktree（未追跡込み）/ `HEAD == origin/main` / `[Unreleased]` が空でない /
   拡張が lock と一致 / 署名と公証の資格情報 / **タグと Release がリモートに無いこと**（ローカルのタグは見ない）
2. バージョンを bump して commit（**ビルドの前**。後だと成果物が dirty な作業ツリーから作られる）
3. ビルド → Developer ID 署名 → notarize → staple → 成果物の検査（`check-package`）
4. push → **draft** の Release に資産を上げてから公開（draft の間はタグが実体化しないので、
   途中で落ちても「リリース物のないタグ」が残らない）

push 前に失敗したら bump commit は自動で巻き戻る。何度でも叩き直してよい。

### 常用版の入れ方

Homebrew の自作 tap（`nyshk97/tap/nemo`）から入れる。Brewfile に載せてあるので
`brew bundle` で他の自作アプリと一緒に入る（単体なら `brew install --cask nyshk97/tap/nemo`）。
cask は `mise run release` が Release の公開直後に自動で更新する。

dmg（`Nemo-<version>-arm64.dmg`）を開いて `/Applications` に入れても動くが、
その後 `brew bundle` が「既に App がある」で落ちるので、常用は cask に統一する。
dev 版（`Nemo Dev`）とは bundle id もデータディレクトリも別なので**同時に入れて同時に動かせる**。
以後の更新はアプリが自動で取得し、サイドバー左下のバージョン表示から適用できる
（`auto_updates true` なので `brew upgrade` は触らない）。

### 新しい Mac で用意するもの

- Developer ID Application 証明書（keychain）
- notarytool のプロファイル（`xcrun notarytool store-credentials`）
- `.release.local.json`（**gitignore**。public repo に Team ID を書かないため）

  ```json
  { "teamId": "XXXXXXXXXX", "notaryProfile": "..." }
  ```

  環境変数 `NEMO_TEAM_ID` / `NEMO_NOTARY_PROFILE` でも渡せる。
  証明書が1つしか無いマシンなら `teamId` は省略できる。

## ブックマークのセーブスロット（2台目を揃える）

ピン留めと Favorites を**ゲームのセーブデータのように3枠へ保存**して、別の Mac で読み込む。
設定画面（⌘,）の「ブックマークのセーブスロット」から操作する。**CLI は無い**。

- 保存先は **iCloud Drive**（`~/Library/Mobile Documents/com~apple~CloudDocs/Nemo/slots/`）。
  dev 版は `Nemo-dev/slots/` に分かれる
- **読み書きするのはボタンを押したときだけ**。自動保存も定期同期もしない
- 読み込むと現在のピン留めと Favorites を**まるごと置き換える**（マージしない）。
  **undo は無い**ので、残したいときは先に空き枠へ保存する
- 読み込みで消える定義に紐づいていたタブは、名前を保ったまま「今日のタブ」へ移る（ページは閉じない）
- 上書きの導線は置かない。上書きしたいときは「削除 → 保存」の2手
- 読めない枠（権限・iCloud の未ダウンロード・壊れ）は**「空き」に倒さない**。
  空きに見えると保存ボタンが出て、押した瞬間に別の Mac のスロットを潰すため
- 設定（`settings.json`）と GitHub PAT はスロットに載せない。履歴・アーカイブ・セッション・
  権限の記憶も端末ローカル

### 新しい Mac で環境を揃える

```bash
git clone git@github.com:nyshk97/browser.git ~/browser && cd ~/browser
mise run setup                  # 依存 + 拡張 artifact
```

常用版そのものは `brew bundle`（`cask 'nyshk97/tap/nemo'`）で入れる。**使うだけなら
リポジトリの clone は要らない**（開発するときだけ）。ブックマークは、アプリを起動して
設定 › ブックマークのセーブスロットから読み込む。

## Arc からの移行

```bash
mise run arc:import --dry-run   # 何が入るかだけ見る
mise run arc:import             # 常用版（stable）へ取り込む
mise run arc:import dev         # dev 版へ
mise run arc:import --replace   # 既存のピン留めを捨てて Arc の内容にする
```

- **Arc を完全に終了してから**実行する（起動中は `StorableSidebar.json` が最新でないことがある）
- スペースは無視してフラット化する。分割ビューと**2階層以上のフォルダ**は切り捨てずに親へ展開する
  （Nemo のフォルダは1階層まで）
- Arc のアイテム ID をそのまま使うので**冪等**。何度実行しても増えない
- 既定は既存のピン留めを残したまま重ねる

## 既定ブラウザにする

macOS のシステム設定 → デスクトップとDock → デフォルトのWebブラウザ で Nemo を選ぶ。
アプリ側には設定 UI を置かない（`electron-builder.yml` の `protocols` で http / https の
ハンドラを宣言しているので、**パッケージ版**なら候補に出る。開発起動の Electron 本体は出ない）。

外部アプリから渡された URL は `app.ready` より**前**に購読して queue し、
起動時のウィンドウが揃ってから開く。未起動から開かれたときの URL を取りこぼさないため。

## 拡張の扱い

Chrome Web Store からはインストールしない。**`extensions.lock.json` に書いた
「バージョン付き URL + sha256 + 公開鍵」だけをロードする**。

- Web Store の `installExtension` はバージョン指定ができず、lock からの再現ができない
- GitHub Release の zip には `manifest.key` が無く、そのままだと拡張 ID がロード元パスから
  決まってしまい、版を上げるたびに ID が変わって拡張の設定が失われる
  → Web Store の CRX から取った公開鍵を lock に持ち、展開時に `manifest.json` へ注入して
    ID を固定している
- lock には**展開・key 注入まで済んだツリー全体の sha256（`treeSha256`）**も持つ。
  アーカイブの hash だけでは展開後の JS を書き換えられても検知できないため。
  **main プロセスは起動時にこれを照合し、一致しない拡張はロードしない**

```bash
mise run ext:fetch                      # lock どおりに展開
mise run ext:verify                     # ツリー hash まで含めて照合
mise run ext:update 2026.7.0            # 対象版へ lock を張り替える
mise run ext:rollback                   # lock を git の状態に戻して再展開（要コミット済み）
node scripts/ext-webstore-key.mjs <id>  # Web Store の CRX から公開鍵を取り出す（初回のみ）
```

## dev 版と常用版

**表示名・bundle id・アイコン・データディレクトリをすべて分ける。**
同時に Dock に置いても取り違えないようにするため、dev 版のアイコンには DEV リボンが入る。

| | dev 版 | 常用版 |
|---|---|---|
| 表示名 | `Nemo Dev` | `Nemo` |
| bundle id | `local.nyshk97.nemo.dev` | `local.nyshk97.nemo` |
| データ | `~/Library/Application Support/Nemo-dev/` | `.../Nemo/` |
| remote debugging | 開ける（`NEMO_REMOTE_DEBUGGING_PORT`） | **絶対に開かない** |
| ビルド | `mise run package` | `NEMO_BUILD_CHANNEL=stable mise run package:stable` |

未パッケージの開発起動は**常に dev 版**として動く（常用データを触らないため）。

`NEMO_USER_DATA_DIR` でデータディレクトリを上書きできる。
**CDP を開ける検証は必ず使い捨てのディレクトリで回す**（`mise run verify` は自動でそうしている）。

保存するもの:

| ファイル | 内容 |
|---|---|
| `settings.json` | 設定（スキーマ版つき） |
| `pins.json` | Favorites / ピン留めの定義 |
| `permissions.json` | origin 単位の権限と外部 protocol の許可 |
| `session.json` | セッション復元用のタブ一覧（**一時タブだけ**。ピン / Favorites は枠から作り直す） |
| `history.db` | 履歴（SQLite） |
| `logs/` | 診断ログ（セッション単位・20 世代でローテーション）。5 分おきの `metrics.sample`（メモリ・CPU。`mise run metrics:report` で集計）と UI の例外 `ui.error` もここ |

## ディレクトリ

| パス | 内容 |
|---|---|
| `src/main/` | main プロセス（registry / security / protocol / extensions / ipc / menu / downloads / prompts） |
| `src/main/store/` | 永続化（設定・ピン留め・権限・セッション・履歴） |
| `src/preload/ui.ts` | ブラウザ UI 専用の preload。公開する API を個別に列挙する |
| `src/renderer/` | ブラウザ UI（React） |
| `src/shared/` | main と UI で共有する型 |
| `scripts/` | 拡張の取得・検証、テストページのサーバ、ユニットテスト、CDP 経由の自走検証 |
| `test-pages/` | 受け入れテスト用のページ |
| `test-extension/` | CI 用の自作テスト拡張（資格情報なしで拡張互換を検証する） |
| `build/` | アイコン・entitlements・パッケージング用のリソース |
| `DESIGN.md` | ブラウザ UI の見た目の決めごと |
| `docs/compat.md` | Electron × 拡張ライブラリの last-known-good |
| `docs/phase0-report.md` | Phase 0 の検証結果 |
| `.mise.toml` | 起動・検証のタスク定義（`mise tasks` で一覧） |
| `VERIFY.md` | 動作確認の手順 |

## セキュリティの既定

- ブラウザ UI（`persist:nemo-ui`）とページ・拡張（`persist:nemo`）を**別セッション**にしている
  （同居させると content script が UI に注入されうる）
- ページ側 `WebContents` は `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false` / `webSecurity: true`
- ナビゲーションは `http:` / `https:` と `about:blank`（厳密一致）のみ許可。
  リダイレクト後の scheme も検査する
- permission は既定で拒否（allowlist）
- IPC は送信元が登録済み UI WebContents か、**その WebContents が今も `nemo://ui` にいるか**、
  対象タブがそのウィンドウのものかを毎回検証する
- **ブラウザ UI の WebContents は `nemo://ui/` から出さない**（`will-navigate` / `will-redirect` /
  `will-frame-navigate` / `setWindowOpenHandler` で拒否）。UI の preload は `window.nemo` を公開しているので、
  外部ページへ遷移できると**そのページに特権 API が渡る**（リンクをサイドバーにドロップすると起こりうる）
- `chrome-extension://` は「ロード済み拡張が自分のページを開く」経路だけ許可する。
  コマンドバー・Web ページからは通さない
- ログに URL のパス・クエリ・フラグメントを出さない（`redactUrl` で scheme + host まで落とす）
- 許可判定は `src/shared/navigation-policy.js` に切り出し、`mise run test` で回帰テストしている
- **`file:` は人間の操作が起点のときだけ通す**（`allowFile`）: OS の `open-file`（Finder / `open <path>`）・argv の `file://`・
  アドレスバー / コマンドバーの入力、および `file:` ページからの file → file のトップレベル遷移（`fromFile`）。
  Web ページの `window.open` / `location.href`・拡張の `tabs.create`・サブフレームからは通さない
  （main の `loadURL` は browser-initiated で Chromium の renderer 側の file アクセス制限を受けないので、
  この allowlist が唯一のゲート）。`file:` タブは一時タブ定義・履歴に載せず、permission 要求も通さない
  （`docs/plans/2026-09-02-1812-local-file-open.md`）
- **ブラウザ UI は `file://` ではなく `nemo://ui/` で配信する**（`standard` / `secure` / `bypassCSP: false`）。
  配信するのは `out/renderer/` の中だけで、`..` も symlink も外へ出られない
- UI に厳格な CSP を掛ける（本番は `script-src 'self'`。緩めるのは dev server 経由のときだけ）
- **権限要求は origin 単位でユーザーに聞く**。「今後も同じ扱いにする」を選んだときだけ記憶する
- 外部 protocol（`mailto:` など）は allowlist に載っていても**初回は必ず確認する**
- 証明書エラーは既定で拒否。続行はその場限りで、記憶しない
- パッケージ成果物は Electron fuses（`runAsNode` 等）を `mise run package` が毎回検査する
- main プロセスの例外でブラウザごと止めない（診断ログに `app.uncaught_exception` として残す）。
  握ったまま気づかないことがないよう、自走検証は毎回**ログに例外が1件も無いこと**を確認する
