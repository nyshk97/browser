# Nemo

Arc の代替として作っている自作ブラウザ。Electron + `BaseWindow` + タブごとの `WebContentsView` +
`electron-chrome-extensions` で、Chrome 拡張（Bitwarden 等）が動く。

現在は **Phase 1（素のブラウザ）** まで実装済み。
サイドバー3層・コマンドバー・ダウンロード・セッション復元・権限ダイアログ・
パッケージングまで入っていて、dev 版だけで一日ブラウジングできる状態を目指している。
設定同期・Arc からの移行・既定ブラウザ化は Phase 2。計画は `docs/plans/` を参照。

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
| `mise run verify:ext-update` | 版を上げ下げしても拡張の設定（`chrome.storage`）が残ることを実物で検証 |
| `mise run package` / `package:stable` | パッケージして成果物を検査（fuses・ネイティブモジュール・notice） |
| `mise run verify:packaged` | パッケージした `.app` を起動して smoke test |
| `mise run icons` | アプリアイコン（常用版 / dev 版）を生成 |
| `mise run licenses` | 依存ライブラリのライセンス棚卸し |
| `mise run ext:fetch` / `ext:verify` / `ext:update <version>` / `ext:rollback` | 拡張の取得・検証・更新・巻き戻し |
| `mise run test:pages` | テストページのサーバだけ起動 |

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
