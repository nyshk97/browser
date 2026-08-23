# Nemo

Arc の代替として作っている自作ブラウザ。Electron + `BaseWindow` + タブごとの `WebContentsView` +
`electron-chrome-extensions` で、Chrome 拡張（Bitwarden 等）が動く。

現在は **Phase 2（常用移行）** まで実装済み。
サイドバー3層・コマンドバー・ダウンロード・セッション復元・権限ダイアログ・パッケージングに加えて、
履歴 / アーカイブのライブラリ・一時タブの自動アーカイブ・シークレットウィンドウ・設定画面・
既定ブラウザ対応・設定同期・Arc からの移行が入っている。計画は `docs/plans/` を参照。

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
| `mise run config:init` / `config:status` / `config:push` / `config:pull` / `config:restore` | 設定・ピン留めの同期（`nemo-config`） |
| `mise run arc:import [stable\|dev] [--dry-run] [--replace]` | Arc のピン留め・Favorites を取り込む（冪等） |
| `mise run ext:outdated` | 拡張に新しい版が出ていないか確認（何も書き換えない） |
| `mise run test:pages` | テストページのサーバだけ起動 |

## リリース

配布物は [GitHub Release](https://github.com/nyshk97/nemo/releases) に置き、
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

`Nemo-<version>-arm64.dmg` を開いて `/Applications` に入れる。dev 版（`Nemo Dev`）とは
bundle id もデータディレクトリも別なので**同時に入れて同時に動かせる**。
以後の更新はアプリが自動で取得し、サイドバー左下のバージョン表示から適用できる。

### 新しい Mac で用意するもの

- Developer ID Application 証明書（keychain）
- notarytool のプロファイル（`xcrun notarytool store-credentials`）
- `.release.local.json`（**gitignore**。public repo に Team ID を書かないため）

  ```json
  { "teamId": "XXXXXXXXXX", "notaryProfile": "..." }
  ```

  環境変数 `NEMO_TEAM_ID` / `NEMO_NOTARY_PROFILE` でも渡せる。
  証明書が1つしか無いマシンなら `teamId` は省略できる。

## 設定同期（2台目を揃える）

設定とピン留め / Favorites は private repo（`nemo-config`）経由で同期する。
**アプリが読むのは常に `Application Support` の JSON だけ**で、git の作業コピー（staging）は
別の場所（`~/Library/Application Support/NemoConfigSync/repo`）に置く。
コンフリクトマーカーの入った JSON をアプリに読ませないための分離。

```bash
mise run config:init            # 同期リポジトリを clone（初回のみ）
mise run config:status          # 常用データと staging の差分・競合状態を見る
mise run config:push            # 常用データ → 同期リポジトリ
mise run config:pull            # 同期リポジトリ → 常用データ（Nemo を終了してから）
mise run config:restore         # 直前の pull の前に戻す
```

- **pull は起動中の Nemo があると実行できない**（起動中だと次の保存で黙って上書きされる）
- pull は「競合なし・スキーマ正常」を検証してから、バックアップを取って原子的に import する
- **origin が進んでいたら push は止まる**。先に `config:pull` する。
  ここを通すと、別の Mac の変更を「無競合の正常なコミット」として消してしまう
- **origin を取得できないときは pull を中止する**（古い追跡情報で「最新」と判断しない）。
  ネットワークが無いと分かっていて手元の staging を使うときだけ `--offline`
- staging に**同期が管理していないファイル**の変更があると push は止まる（巻き込んで commit しない）
- 競合中は push も pull も止まる。staging で `git` を使って解決する
- 履歴・アーカイブ・セッション・権限の記憶は**端末ローカル**で同期しない
- 拡張の lock は**写しだけ**置く（source of truth はアプリに同梱された `extensions.lock.json`）。
  `config:status` が2台で版が揃っているかを突き合わせる

### 新しい Mac で環境を揃える

```bash
git clone git@github.com:nyshk97/nemo.git ~/browser && cd ~/browser
mise run setup                  # 依存 + 拡張 artifact
mise run config:init            # 同期リポジトリを clone
mise run config:pull            # 設定・ピン留めを取り込む（Nemo は終了しておく）
```

常用版そのものは [GitHub Release](https://github.com/nyshk97/nemo/releases) の dmg を入れる
（リポジトリは同期と開発のために要る）。

## Arc からの移行

```bash
mise run arc:import --dry-run   # 何が入るかだけ見る
mise run arc:import             # 常用版（stable）へ取り込む
mise run arc:import dev         # dev 版へ
mise run arc:import --replace   # 既存のピン留めを捨てて Arc の内容にする
```

- **Arc を完全に終了してから**実行する（起動中は `StorableSidebar.json` が最新でないことがある）
- スペースは無視してフラット化する。分割ビューと深すぎるフォルダは切り捨てずに親へ展開する
- Arc のアイテム ID をそのまま使うので**冪等**。何度実行しても増えない
- 既定は既存のピン留めを残したまま重ねる。取り込んだ内容を同期にも乗せるなら `mise run config:push`

## 既定ブラウザにする

設定画面（⌘,）の「Nemo を既定のブラウザにする」から。**パッケージ版でのみ設定できる**
（開発起動で登録すると Electron 本体が既定ブラウザになってしまうため、
`src/main/default-browser.ts` で弾いている）。

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
| `session.json` | セッション復元用のタブ一覧 |
| `history.db` | 履歴（SQLite） |
| `logs/` | 診断ログ（セッション単位・20 世代でローテーション） |

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
- **ブラウザ UI は `file://` ではなく `nemo://ui/` で配信する**（`standard` / `secure` / `bypassCSP: false`）。
  配信するのは `out/renderer/` の中だけで、`..` も symlink も外へ出られない
- UI に厳格な CSP を掛ける（本番は `script-src 'self'`。緩めるのは dev server 経由のときだけ）
- **権限要求は origin 単位でユーザーに聞く**。「今後も同じ扱いにする」を選んだときだけ記憶する
- 外部 protocol（`mailto:` など）は allowlist に載っていても**初回は必ず確認する**
- 証明書エラーは既定で拒否。続行はその場限りで、記憶しない
- パッケージ成果物は Electron fuses（`runAsNode` 等）を `mise run package` が毎回検査する
- main プロセスの例外でブラウザごと止めない（診断ログに `app.uncaught_exception` として残す）。
  握ったまま気づかないことがないよう、自走検証は毎回**ログに例外が1件も無いこと**を確認する
