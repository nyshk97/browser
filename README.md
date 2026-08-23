# Nemo

Arc の代替として作っている自作ブラウザ。Electron + `BaseWindow` + タブごとの `WebContentsView` +
`electron-chrome-extensions` で、Chrome 拡張（Bitwarden 等）が動く。

現在は **Phase 0（スパイク）** の段階。本体の UI・サイドバー・同期はまだ無い。
計画は `docs/plans/` を参照。

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
| `mise run test` | ユニットテスト（Electron 不要） |
| `mise run verify` | 自走検証を通す（ビルド→起動→CDP で検証→後片付け） |
| `mise run verify:ext-update` | 版を上げ下げしても拡張の設定（`chrome.storage`）が残ることを実物で検証 |
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

## データディレクトリ

既定は `~/Library/Application Support/Nemo-spike/`（常用ブラウザとは別）。
`NEMO_USER_DATA_DIR` で上書きできる。**CDP を開ける検証は必ず使い捨てのディレクトリで回す**
（`mise run verify` は自動でそうしている）。

## ディレクトリ

| パス | 内容 |
|---|---|
| `src/main/` | main プロセス（registry / security / extensions / ipc / menu） |
| `src/preload/ui.ts` | ブラウザ UI 専用の preload。公開する API を個別に列挙する |
| `src/renderer/` | ブラウザ UI（React） |
| `src/shared/` | main と UI で共有する型 |
| `scripts/` | 拡張の取得・検証、テストページのサーバ、ユニットテスト、CDP 経由の自走検証 |
| `test-pages/` | Phase 0 受け入れテスト用のページ |
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
- IPC は送信元が登録済み UI WebContents か、対象タブがそのウィンドウのものかを毎回検証する
- `chrome-extension://` は「ロード済み拡張が自分のページを開く」経路だけ許可する。
  コマンドバー・Web ページからは通さない
- ログに URL のパス・クエリ・フラグメントを出さない（`redactUrl` で scheme + host まで落とす）
- 許可判定は `src/shared/navigation-policy.js` に切り出し、`mise run test` で回帰テストしている

Phase 1-0 でさらに custom protocol 配信・CSP・fuses 検査まで広げる。
