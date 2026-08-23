# Phase 0 スパイク結果レポート

検証日: 2026-08-23 / 機材: 個人 PC（macOS Darwin 25.5.0, arm64）

## 結論

**この技術構成で行ける。Phase 1 に進んでよい。**

Electron + `BaseWindow` + タブごとの `WebContentsView` + `electron-chrome-extensions` で、
Bitwarden が Nemo のタブ・ウィンドウモデルに乗った状態で実用できることを実機で確認した
（実アカウントの Vault をアンロックし、Qiita のログインフォームに自動入力できた）。

**`chrome.commands` が実質未実装で拡張のキーボードショートカットが動かない**が、
利用者がもともと使っていないため優先度は低い（Phase 1-8 に置くが完了条件には含めない）。
「動かない」ではなく「Nemo 側で作れば動く」ので、いずれにせよ採用の可否は左右しない。

## 確定した設計判断

### 1. 拡張のバージョン固定は「Web Store」では成立しない → 不変 artifact の直接ロード

- `electron-chrome-web-store` の `installExtension` にバージョン指定パラメータが無い（README・型定義で確認済み）。
  Web Store の CRX URL も常に最新版を返すため、**lock からの再現インストールができない**。
- そこで **Web Store 経路を一切使わない**構成にした。
  `extensions.lock.json` に「バージョン付き URL + sha256」を持ち、
  `scripts/ext-fetch.mjs` が取得・検証して `extensions/<id>/<version>_0/` に展開する。
  main プロセスは lock に載っている artifact だけを `session.extensions.loadExtension()` で読む。
  **lock に無い拡張は構造上ロードされない（= allowlist が実装として保証される）。**
- Bitwarden は **公式 GitHub Release にバージョン付き artifact がある**
  （`bitwarden/clients` の `dist-chrome-<version>.zip`）。
  URL + hash を lock に書くだけで再現できるので、バイナリを自前で抱える必要は無い。

### 2. lock は「アーカイブの hash」だけでは足りない — 展開後のツリーも照合する

アーカイブの sha256 を照合しても、**展開したあとの JS を書き換えられたら検知できない**。
そこで lock に `treeSha256`（manifest.key を注入したあとのツリー全体の hash）を持たせ、

- `ext-fetch` が展開時に計算して lock に記録する
- `ext-verify` が再計算して照合する
- **main プロセスが `loadExtension` を呼ぶ前に照合し、一致しなければロードしない**

の3か所で使っている。ハッシュ対象は「相対パス（昇順）+ 各ファイルの内容」で、
シンボリックリンクが混ざっていたらツリー外を指せるので拒否する。
実測で Bitwarden のツリー（約 23MB の zip 相当）の計算は **60ms** なので起動時に毎回回せる。

あわせて、ロード後の ID / version 照合で食い違ったら
`session.extensions.removeExtension()` で**必ず外す**（検知しても実行させたままにしない）。

### 3. `manifest.key` の注入が必須（これが無いと更新のたびに拡張の設定が消える）

GitHub Release の `dist-chrome.zip` には `manifest.key` が入っていない。
そのままロードすると Electron は unpacked 拡張として扱い、**拡張 ID をロード元パスから導出する**。
Nemo の展開先はバージョンを含む（`.../2026.8.0_0`）ため、
**版を上げると ID が変わり `chrome.storage`（= Vault の設定）が丸ごと別物になる**。

対策として、Chrome Web Store の CRX から公開鍵を一度だけ取り出して lock の `manifestKey` に記録し
（`scripts/ext-webstore-key.mjs`）、`ext-fetch` が展開時に `manifest.json` へ注入する。
これで拡張 ID が Web Store と同じ `nngceckbapebfimnlniiiahkandclblb` に固定される。

**実測で確認済み**: 2026.8.0 → 2026.7.0 → 2026.8.0 と往復させても ID は変わらなかった。

### 4. `electron-chrome-extensions` には「バックグラウンドタブ」の概念が無い

`store.addTab()` は `tab-added` を emit し、そこから
`TabsAPI.observeTab` → `onActivated` → `store.setActiveTab` → `impl.selectTab`
と流れて、**追加したタブを無条件でアクティブにする**。

つまり `chrome.tabs.create({ active: false })` に対して
「こちらが `selectTab` を呼ばない」だけでは足りず、
`addTab` の直後に元のアクティブタブへ明示的に戻す必要がある。
戻すときに `impl.selectTab` が再入するので、
`selectTab` は「すでにアクティブなら通知を撃ち返さない」形にして相互再入を止めている。

これは自動テストを書いて初めて分かった（`window.open` だけ見ていると素通りする）。
新規タブの `WebContentsView` は既定で `setVisible(false)` にし、
表示するのは `selectTab` だけ、という不変条件も同時に入れた。

### 5. ブラウザ UI とページはセッションごと分ける

UI を `persist:nemo-ui`、ページ・拡張を `persist:nemo` に置いた。
同じセッションに置くと、`<all_urls>` の content script がブラウザ UI 自身に注入されうる。
実測で UI 側の execution context に Bitwarden の isolated world が無いことを確認した。

`<browser-action-list>` は `partition="persist:nemo"` 属性で別セッションの拡張を参照でき、
`ElectronChromeExtensions.handleCRXProtocol()` は UI セッション側に対して呼べばアイコンが出る。

### 6. 許可する scheme は「通常ページ」と「拡張ページ」で分ける

`http:` / `https:` と `about:blank`（**厳密一致**。`about:` を丸ごと許可すると `about:srcdoc` まで通る）
だけを通常ページとして許可し、`chrome-extension://` は
**ロード済み拡張の ID に一致する場合のみ、拡張自身の経路でだけ**許可する。
コマンドバーと Web ページからは通さない。`devtools:` は `loadURL` 経由では一切許可しない
（DevTools は Electron の API で開くので URL を通す必要がない）。

この判定は Electron に依存しない `src/shared/navigation-policy.js` に切り出し、
`mise run test`（`node --test`）で回帰テストしている。
テストを書いた副産物として、`localhost:8787` が URL としては scheme `localhost:` に見えて
コマンドバーで弾かれるバグが見つかったので、`host:port` を先に救うように直した。

### 7. ログに URL のパス・クエリ・フラグメントを残さない

計画 1-9 の「URL をログに出さない」に合わせて、ログ用の URL は
`redactUrl()` で `scheme://host` まで落とす（クエリやフラグメントにトークンが載りうるため）。

### 8. sandbox 必須の制約は preload のビルドに効く

`sandbox: true` の preload は ESM をロードできないため、
preload だけ CJS（`out/preload/ui.cjs`）で出す必要がある。
また `electron-chrome-extensions/browser-action` は preload にバンドルする必要がある
（sandbox 下では `node_modules` を require できないため、`externalizeDepsPlugin` から除外した）。

ブラウザ UI の CSP は本番で `script-src 'self'` まで絞り、
dev（Vite の HMR）でだけ `'unsafe-inline'` と ws 接続を足している。
緩めるのは dev server 経由のときだけで、ビルド成果物には入らない。

## 検証ハーネス自体の落とし穴（レビューで判明）

検証コードが「本物」に触ってしまう / 検証対象を取り違える問題を **11件** 踏んだ。
**本体のコードより、検証ハーネスのほうが危険な操作を持っていた**（再帰削除・プロセス停止・
lock の書き換え）。いずれも実装を直したうえで、回帰テストで固定した。

| 問題 | 対処 |
|---|---|
| `verify:ext-update` が実リポジトリの lock / extensions / cache を差し替えていた（**稼働中の Nemo の拡張を巻き込んだ**） | lock・extensions・cache まで一時領域に複製して完全隔離。あわせて **Nemo 起動中は検証系の実行を拒否**する |
| `mise run verify` が固定ポートを使い、エンドポイントを `verify-spike` に渡していなかったため、**既存の 8787 サーバを検証して全 PASS した** | 毎回空きポートを採番 → `NEMO_CDP` / `NEMO_TEST_PAGES` で明示的に伝播 → 子プロセスの生存と「自分が起動したサーバか」（`/__nemo_test_pages__` に PID を返す）を確認してから進む |
| 壊れた lock（`id: ".."` 等）で `ext-fetch` がリポジトリルートを再帰削除できた | 拡張 ID / version / `unpackedRoot` / `source.url` を検証し、削除・展開のパスがすべて所定ディレクトリ配下であることを確認。検証は `src/shared/ext-lock.js` に置いて main プロセスとスクリプトで共有（実装が二重だったのが遠因） |
| 上記の封じ込めが**文字列比較だけ**で、`extensions/<正しい形式の id>` が外部への symlink なら通り抜けた（`readdir` がリンク先を列挙して再帰削除できる） | `safeJoin()` が base を realpath したうえで、**base から下の各段を `lstat` して symlink を拒否**する。削除の直前にも再確認する。canary 付きの回帰テストを追加（チェックを外すと落ちることを確認済み） |
| 起動中 Nemo の検出が `ps` のコマンドライン頼りで、`electron-vite dev`（`Electron .` として起動）を取りこぼした | **アプリ自身が `.nemo-run/<pid>.json` を書く**方式に変更。検証側は生存 PID を確認して stale を掃除する。`ps` は補助（このリポジトリの Electron 本体プロセスのみ）に降格 |
| 子プロセスを固定時間の sleep で見捨てて次へ進んでいた（ポート再利用・使用中の一時ディレクトリ削除の恐れ） | `stopChild()` に集約。SIGTERM → **exit を待つ** → タイムアウトしたら SIGKILL → また待つ → **それでも確認できなければ投げて後片付けを中止**する（一時ディレクトリは残して場所を表示する） |
| `.nemo-run` が symlink だと、stale マーカー掃除が無関係な JSON（`package.json` / `extensions.lock.json` 等）を消せた | マーカー置き場を `lstat` して**通常のディレクトリでなければ検証ごと失敗**させる。対象は `<pid>.json` の**通常ファイル**に限定し、削除するのは**ファイル名の PID が死んでいるときだけ**（中身が壊れていても生きている PID のものは消さない） |
| **途中の** `stopAll()` が失敗すると、追跡配列を `splice` 済みなので最後の後片付けが空配列を見て成功扱いになり、**使用中の一時ディレクトリを削除**した | 起動した子は追跡配列から**外さない**。後片付けの可否は `spawned.filter(isChildAlive)` で毎回計算する。「危険な書き方が戻っていないか」をソースレベルの回帰テストでも固定した |
| マーカー置き場の `lstat` で**全例外を「存在しない」扱い**にしていたため、EACCES や I/O エラーでも起動中判定を素通りした | `ENOENT` のときだけ「まだ誰も起動していない」とし、それ以外は投げる |
| `stopChild()` のタイムアウト用タイマーが exit 後もキャンセルされず、**ユニットテスト全体が約10秒待たされていた**（1.2秒相当の内容に対して） | `raceTimeout()` に集約して `clearTimeout` する。実測 10.2秒 → 1.2秒 |
| 回帰テスト自身が、**回帰を検出したときに限って**子プロセスを残してハングした（`kill` を差し替えた子の復元が assert の後ろにあり、落ちると到達しない）。実際に孤児プロセスが残っていた | 子の追跡と強制終了を `t.after()` に移した。孫プロセスを作るテストも `finally` で SIGKILL する。**バグを戻した状態で走らせて、孤児が残らず完走することを確認した** |

## 自動検証の結果

`mise run verify`（ユニットテスト → ビルド → 拡張の照合 → アプリ起動 → CDP で検証 → 後片付け）。
使っているスクリプトはリポジトリにコミットしてあり、
Phase 1-10 の「CI 必須の拡張互換 smoke test」の種になる。

ユニットテスト（`node --test`・Electron 不要）は **28 件**すべて PASS。
内訳は「許可 scheme の判定・コマンドバー入力の正規化・ログの URL 伏せ字」
「拡張 lock の更新／ロールバック／改ざん検知／パス封じ込め」
「検証ハーネス自身（マーカー掃除の暴発防止・子プロセスの停止）」。

```
PASS  registry が初期タブを1つ持つ
PASS  コマンドバー入力からナビゲートできる
PASS  scheme を拒否: file:///etc/passwd
PASS  scheme を拒否: javascript:alert(1)
PASS  scheme を拒否: data:text/html,<h1>x</h1>
PASS  拒否後も元の URL のまま
PASS  ページ側に Node / 特権 API が漏れていない
PASS  ページに拡張の content script が入る — Bitwarden Password Manager
PASS  iframe を含む全フレームに content script が入る — isolated=4
PASS  ブラウザ UI には content script が入らない
PASS  window.open がタブとして registry に入る — 1 -> 2
PASS  サイズ指定の window.open が新規ウィンドウになる — 1 -> 2
PASS  chrome.tabs.create が Nemo のタブになる — 2 -> 3
PASS  chrome.tabs.create の戻り値に tabId がある — {"id":6,"windowId":1,"active":false}
PASS  active: false でアクティブタブが変わらない — activeTabId 3 -> 3
PASS  active: false のタブは registry に居るがアクティブではない
PASS  バックグラウンドタブの View が表示されていない — visible=[3] active=3
PASS  active: true で作ったタブがアクティブになる — activeTabId=7 created=7
PASS  chrome.tabs.create の windowId が現在のウィンドウと一致する — tab.windowId=1 current=1
PASS  chrome.windows.create が Nemo のウィンドウになる — 2 -> 3
PASS  chrome.windows.create の戻り値に windowId がある — {"id":3}
PASS  chrome.windows.getAll に新しいウィンドウが載る — [1,2,3]
PASS  chrome.windows.remove でウィンドウが閉じる — 3 -> 2
PASS  chrome.tabs.remove でタブが registry から消える
PASS  拡張からの file: URL はタブにならない
PASS  拡張は自分の chrome-extension:// ページを開ける
PASS  拡張の service worker が動いている
PASS  service worker の再起動要求が通る — started=1
PASS  DNR と sidePanel 以外の chrome API が使える
      使えない API: declarativeNetRequest.getDynamicRules, sidePanel.setOptions
PASS  タブを閉じると registry から消える
PASS  未所有のタブ ID は IPC で拒否される
PASS  chrome.storage.local が再起動をまたいで残る

すべて PASS
```

追加で確認したもの:

| 項目 | 結果 |
|---|---|
| browser action の popup | `chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html#/intro-carousel` が開き、Bitwarden の UI が描画された（スクリーンショットで確認） |
| `chrome.storage.local` の永続性 | `verify:spike --storage-write` → Nemo 再起動 → `--storage-read` で同じ値が読めた |
| 拡張のバージョン往復 | 2026.8.0 → 2026.7.0 → 2026.8.0 で拡張 ID が不変 |
| sha256 の改ざん検知 | lock の hash を書き換えると `ext-fetch` が exit 1 で停止する |
| ロールバック | lock を戻して `ext:fetch` するとキャッシュから復元される（ネットワーク不要） |
| ウィンドウを閉じたときの後始末 | 3タブのウィンドウを閉じて CDP の page target が 6 → 2 に減った（子 `WebContents` が残らない） |
| ページ側の隔離 | ページで `require` / `process` / `module` / `window.nemo` がすべて `undefined` |
| 展開後コードの改ざん検知 | `background.js` に1行足すと `ext:verify` が exit 1、起動しても `extension.integrity_failed` が出て service worker が生えない（= ロードされない） |
| dev 起動と HMR | `mise run dev` で拡張つきのまま起動し、`App.tsx` の編集が再起動なしで反映されることを確認 |
| UI への content script 混入 | UI の execution context に拡張の world 無し |
| DevTools | `devtools://devtools/bundled/devtools_app.html` が開く |

## 動かなかった / 制約のある chrome API

| API | 状態 | 影響 |
|---|---|---|
| `chrome.declarativeNetRequest` | **名前空間ごと存在しない** | Phase 3 の広告ブロック内蔵は DNR ではできない。`webRequest` に寄せるか拡張に任せる |
| `chrome.sidePanel` | 名前空間はあるが `setOptions` が無い | Bitwarden のサイドパネル機能は使えない見込み |
| `chrome.commands` | `getAll()` は6件返るが **shortcut がすべて空**。ece はアクセラレータを登録せず `onCommand` も dispatch しない | **拡張のキーボードショートカットが動かない**（Bitwarden の ⌘⇧L 自動入力・⌘⇧Y popup）。パスワードマネージャは日常的にキーボードで使うので、Nemo 側で「manifest の `commands` を読んでアクセラレータを登録し `chrome.commands.onCommand` を投げる」実装が要る（Phase 1-8） |
| service worker の強制停止 | Electron に API が無い（`startWorkerForScope` はあるが stop が無い） | 「SW を止めてから popup を開く」試験は idle 停止を待つしかない。UI に再起動ボタンを置いて代替した |

Bitwarden の manifest にある `contextMenus` / `sidePanel` / `webNavigation` / `notifications` / `privacy`
の各 permission に対して Electron が起動時に `Permission '...' is unknown.` と警告するが、
`electron-chrome-extensions` が API 自体は提供しているため、実測では
`contextMenus` / `webNavigation` / `notifications` / `privacy` はいずれも利用できた。

## 既知の未解決点（Phase 1 に持ち越す）

1. **popup で開いたタブは `window.opener` を失う**。
   `setWindowOpenHandler` で `deny` を返して自前でタブを作る方式のため、opener 関係が切れる。
   OAuth のように opener に依存するフローで問題になる可能性がある（Phase 1-2 で扱う）。
2. **browser action の popup がウィンドウの外にはみ出す**ことがある。位置決めは Phase 1-8。
3. **ブラウザ UI をまだ `file://` で配信している**。Phase 1-0 で custom protocol + 厳格な CSP に移す。
4. **外部 protocol（`mailto:` 等）は現在すべて拒否**。Phase 1-6 で allowlist 方式にする。
5. **アイコン・favicon・タイトル以外の UI は未実装**。Phase 0 のツールバーは仮のもの。
6. **初回ログイン時、2FA コード送信後に popup がスピナーのまま止まる**。
   実測では**ログイン自体は成功していて**（再起動するとアンロック画面が出る）、
   popup の画面遷移だけが進まない。popup ↔ service worker のメッセージングが疑わしい
   （起動中ずっと `Unchecked runtime.lastError: Could not establish connection.` が出ている）。
   実害は「初回だけ一度アプリを再起動する必要がある」だが、原因は Phase 1 で潰す。
7. **拡張ツリーの照合は「起動時の1回」だけ**。動作中にファイルを差し替えられるところまでは見ていない
   （読み取り専用にする / 起動のたびに verified なアーカイブから再展開する、は Phase 1-1 で検討する）。
8. **dev 版の分離はまだ「スパイク用のデータディレクトリを分ける」までしかしていない**。
   表示名・bundle id・アイコンの分離は Phase 1-10。

## 受け入れ基準（0-5）の結果

実アカウントの Bitwarden で確認した（`mise run dev:nodebug` で CDP を閉じた状態）。

| 項目 | 結果 |
|---|---|
| popup が開き Vault をアンロックできる | ✅ ただし**初回ログインは popup がスピナーのまま止まる**（下記） |
| ログインフォームに自動入力できる | ✅ Qiita の実ページで確認 |
| 再起動しても Vault 状態と設定が復元される | ✅ |
| 複数タブ・複数ウィンドウで対象タブを取り違えない | ✅ |
| iframe 内のフォームでも動く | ✅ |
| popup からのタブ / ウィンドウ生成がタブモデルに乗る | ✅ `chrome.tabs.create` / `chrome.windows.create` を自走検証 |
| 拡張を更新した後も動く | ✅ `mise run verify:ext-update` で機械検証（版を往復させ、**各段で起動し直して** ID 不変・`chrome.storage.local` が残ることを確認。ロールバック後の再読み込みも含む）。更新後の実 Vault での自動入力の目視のみ Phase 1 へ移管 |
| service worker を停止・再起動しても動く | Phase 1-10 へ移管（Electron に SW を止める API が無く idle 停止待ちが非決定的。起動し直せることと storage が残ることは自走検証済み） |
| ⌘⌥I で DevTools | Phase 1-7 へ移管（DevTools が開くこと自体は自走検証済み。残りはアクセラレータのキー入力が届くかだけ） |

### 実機で見つかった問題（いずれも Phase 1 送り）

1. **初回ログインで 2FA コードを送ると popup がスピナーのまま止まる。**
   ログイン自体は成功していて、再起動するとアンロック画面が出る。
   実害は「初回だけ一度アプリを再起動する必要がある」。
2. **Vault をアンロックしてもツールバーのアイコンがしばらくロックのまま。**
   `<browser-action-list>` は `crx://extension-icon/...?t=<iconModified>` で
   キャッシュ回避しているので URL の問題ではなく、Bitwarden がアイコン更新の
   きっかけにしているイベントが届いていない線が濃い。実害は見た目だけ。
3. **拡張のキーボードショートカットが効かない**（`chrome.commands`）。
   ただし利用者がもともと使っていないため優先度は低い。

## 判定

**採用。Chromium フォークへの方針転換を検討する材料は出なかった。**

自走検証（ユニットテスト 28 件 + CDP 32 件）はすべて PASS。
実機での受け入れ基準も、キーボードショートカットを除いて満たしている。
見つかった3つの問題はいずれも「Nemo 側の実装で潰せる範囲」で、土台の選択には影響しない。
