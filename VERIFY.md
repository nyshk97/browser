# Nemo の動作確認手順

修正内容に関係する手順だけ選んで実行する（全項目を毎回実行しない）。

## 起動する

```bash
mise run setup     # 初回のみ（依存 + 拡張 artifact）
mise run dev       # 開発版 Nemo を起動（HMR あり）
```

`mise run dev` は「拡張の照合 → テストページのサーバ → Nemo 起動（remote debugging 9333）」まで面倒を見る。
本番に近い経路（バンドル済み・HMR なし）で見たいときは `mise run dev:build`。

## まとめて検証する

```bash
mise run check              # lint → typecheck → ユニットテスト（Electron 不要・数秒）
mise run verify             # 自走検証（ビルド→起動→CDP で検証→後片付け）。終了コードが合否
mise run verify:ext         # 拡張互換 smoke（自作テスト拡張・資格情報なし・CI 必須と同じもの）
mise run verify:ext-idle    # 上に service worker の idle 停止をまたぐ確認を足す（+2分ほど）
mise run package            # パッケージして成果物を検査（fuses・ネイティブモジュール・notice）
mise run verify:packaged    # パッケージした .app を起動して smoke test
mise run verify:ext-update  # 版を上げ下げしても拡張の設定が残ることを実物で検証
```

**どれを回すか**:

| 触ったもの | 回すもの |
|---|---|
| ナビゲーション判定・設定スキーマ・キーバインド・ログ | `mise run check` |
| タブ / ウィンドウ・サイドバー・コマンドバー・ダウンロード・権限 | `mise run verify` |
| 拡張まわり・Electron のバージョン | `mise run verify:ext`（+ 実機で Bitwarden） |
| パッケージング・ネイティブ依存・fuses | `mise run package` → `mise run verify:packaged` |

**検証系は Nemo が起動していると実行を拒否する**（拡張や lock を触るため）。
先に Nemo を終了する。起動中かどうかはアプリが書く `.nemo-run/<pid>.json` で判定する
（`ps` のコマンドラインは dev モードだと `Electron .` になって当てにならない）。ポートは毎回空きを採番し、データディレクトリ・lock・拡張は
すべて一時領域に隔離されるので、常用中のプロファイルには触らない。

`mise run verify` が見ている項目:

- **ユニットテスト**: 許可 scheme の判定・コマンドバー入力の正規化・ログの URL 伏せ字 /
  拡張 lock の更新・ロールバック・改ざん検知・パス封じ込め /
  検証ハーネス自身（マーカー掃除の暴発防止・子プロセスの停止）
- registry の初期状態 / ナビゲーション / scheme allowlist（`file:` `javascript:` `data:` の拒否）
- ページ側に `require` / `process` / `window.nemo` が漏れていないこと
- 拡張の content script がトップフレームと iframe に入ること
- **ブラウザ UI には content script が入らないこと**（セッション分離が効いていること）
- `window.open` が Nemo のタブ / ウィンドウになること
- **`chrome.tabs.create` / `chrome.windows.create` が Nemo のモデルに乗ること**
  （`active: false` でアクティブタブが変わらないこと・View が表示されないこと・`windowId` の対応・`remove` での後始末）
- 拡張から渡された URL がナビゲーション検証を通ること（`file:` は拒否 / 自分の拡張ページは許可）
- 拡張の service worker が動いていること・再起動要求が通ること
- 使えない `chrome.*` API の列挙（現状 `declarativeNetRequest` と `sidePanel.setOptions`）
- タブを閉じたときの registry の後始末 / IPC が未所有のタブを拒否すること
- `chrome.storage.local` が再起動をまたいで残ること

`mise run verify` が見ている Phase 1 の項目（`scripts/verify-phase1.mjs`）:

- ブラウザ UI が `nemo://ui/` から配信されていること（`file://` を使っていないこと）
- 許可外 scheme（`file:` `javascript:` `data:` `chrome:` `nemo:`）を拒否すること
- 他ウィンドウのタブを IPC で操作できないこと
- 作ったタブがアクティブになり、**表示されている View がただ1つ**であること
- 背景タブがアクティブを奪わないこと
- ⌘D 相当のピン留め / **閉じても定義が残る** / クリックで開き直せる
- ピン留めをフォルダに入れられる / **自分自身の中へは動かせない**
- Favorites の追加・削除
- コマンドバーが開いているタブを候補に出す / URL でない入力は検索に回る
- **コマンドバーの決定先**（⌘T / ＋ は新規タブ・⌘L は現在のタブ・⇧Enter はその逆）
- ページ内検索がヒット数を返す・終了できる
- zoom の変更と上限
- ダウンロードが完了として記録され、消せること
- 外部 protocol が**確認ダイアログを出す**（無条件に OS へ渡さない）
- 権限要求が**ダイアログを出す**（自動許可しない）・答えたら閉じる
- 非アクティブタブが sleep すること
- **別ウィンドウへ移しても WebContents を作り直さない**こと
- 設定が検証されてから採用されること（https 以外の検索テンプレートを拒否）
- **ブラウザ UI が外部ページへ遷移できないこと**（遷移できると `window.nemo` が外部ページに渡る）
- **ピン留めを解除すると、フォルダの子孫も全ウィンドウのタブも紐付けが外れること**
  （外れないとサイドバーのどの層にも出ないタブになる）
- **オーバーレイを読み直しても、答え待ちのダイアログが戻ること**
  （戻らないと権限・認証の callback が未解決のまま残る）
- **初期化完了の合図が「起動時のタブが揃ってから」立つこと**
  （逆転すると、外から見て registry が空の瞬間ができ、検証が間欠的に落ちる）
- **2本指スワイプで戻る / 進む**（判定はページから見えない隔離ワールドに入っていること・
  縦に流れるジェスチャでは動かないこと・**iframe の中でも効くこと**）
- **キャッシュ無視の再読み込み**（普通の再読み込みではキャッシュ済みのサブリソースを取り直さず、
  キャッシュ無視なら取り直すこと）
- **タブをピン留めへドラッグ**（落とした位置に入ること・すでにピン留め済みのタブを
  落とし直しても定義を作り直さないこと）
- **落とし先が掴んだ場所で前後しないこと**（同じ階層で上へ動かしても下へ動かしても、
  落とした行の手前に入る）
- サイドバーの並び（一時タブに見出しを出さず、「新しいタブ」行がその先頭にあること）
- **main プロセスの例外が診断ログに1件も無いこと**

> 検証スクリプトは `window.nemo.getAppStatus()` の `ready` を待ってから読み始める。
> UI の target が出た時点ではまだ起動時のタブが作られていない。
- セッション復元（前回のタブが戻る / 復元直後は sleep / 選ぶと読み直す）

個別に回すときは Nemo を起動した状態で `pnpm verify:spike`。

## 手で CDP を叩く

```bash
node -e "fetch('http://127.0.0.1:9333/json/list').then(r=>r.json()).then(t=>t.forEach(x=>console.log(x.type,x.url.slice(0,80))))"
```

UI の webContents に接続して `window.nemo.*` を呼べば、UI 操作なしでタブを作れる。

**CDP につなぐ前に、古いインスタンスが残っていないか必ず確認する。**
残ったインスタンスが同じポートを掴んでいると、**そちらに繋がって古い状態を検証してしまう**
（dev server が死んだ古いインスタンスに繋がり、502 の原因を1時間追った実例がある）。

```bash
node -e "import('./scripts/lib/harness.mjs').then(m=>console.log(m.findRunningNemo()))"
```

`mise run dev` は同じ remote debugging ポートを掴んでいる Nemo があれば起動を拒否する。
`mise run verify:packaged` も同じ `.app` が起動したままなら拒否する
（残っていると新しいプロセスが立たず、CDP を待ち続けて失敗する）。
`pkill -f "scripts/dev.mjs"` だけでは **孫プロセスの Electron が残る**ので、
残っていたら `pkill -f "MacOS/Electron"`（パッケージ版は `pkill -f "Nemo Dev"`）まで実行する。

```js
// Runtime.evaluate で実行する
await window.nemo.getWindowState()
await window.nemo.getVisibleTabKeys()  // activeTabKey とズレていたらバックグラウンドタブが前面に出ている
await window.nemo.navigate(tabKey, 'http://127.0.0.1:8787/login.html?site=a')
await window.nemo.createTab('http://127.0.0.1:8787/iframe.html')
await window.nemo.createWindow()
await window.nemo.setOverlay('command-bar')   // コマンドバーを出す
await window.nemo.suggest('git')              // 補完候補を見る
await window.nemo.reload(tabKey, { ignoreCache: true })  // スーパーリロード（再読み込みボタンの右クリック）
await window.nemo.pinTabAt(tabKey, null, 0)   // タブをピン留めの先頭へ（サイドバーの D&D と同じ経路）
await window.nemo.restartServiceWorkers()
```

> タブの ID は **`key`（UUID 文字列）**。`webContentsId` は `chrome.tabs` との対応を見るための
> 参考値で、sleep 中は `null` になる。

確認すべき代表的な項目:

| 確認したいこと | 見るもの |
|---|---|
| content script が入っているか | `Runtime.enable` してから `Page.reload` し、`Runtime.executionContextCreated` に拡張名の world が出るか |
| バックグラウンドタブが前面に出ていないか | `getVisibleTabKeys()` が `activeTabKey` ただ1つを返すこと |
| scheme allowlist | `window.nemo.navigate(tabKey, 'file:///etc/passwd')` が `navigation rejected` で reject されること |
| popup がタブモデルに乗るか | ページ側で `window.open(...)` → UI 側の `getWindowState()` のタブが増えること |
| ウィンドウを閉じたときの後始末 | ウィンドウを閉じた後に `/json/list` の `page` が減ること（子 `WebContents` が残っていないこと） |
| ページ側の隔離 | ページで `typeof require` / `typeof process` / `typeof window.nemo` がすべて `undefined` |

### ダイアログ（権限 / 認証 / 証明書 / 外部 protocol）を試す

ダイアログはネイティブではなく**オーバーレイの WebContentsView に出る**ので、CDP から答えられる。

```js
// overlay の target（`view=overlay`）につないで
document.querySelector('[data-testid]')?.getAttribute('data-testid')  // prompt-permission など
;[...document.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === '許可しない').click()
```

権限要求は**アクティブなタブから**でないと Chromium 側で保留され、ダイアログまで届かない。

### スクリーンショット

```bash
osascript -e 'tell application "System Events" to tell process "Electron"
  set p to position of window 1
  set s to size of window 1
  return ((item 1 of p) as string) & "," & ((item 2 of p) as string) & "," & ((item 1 of s) as string) & "," & ((item 2 of s) as string)
end tell'
screencapture -x -R<x,y,w,h> /path/to/out.png
```

## 拡張の lock まわり

```bash
mise run ext:fetch              # lock どおりに展開する
mise run ext:verify             # ツリー hash / version / manifest.key / アーカイブ sha256 を照合する
mise run verify:ext-update      # 版を上げ下げしても chrome.storage が残ることを実物で自動検証する（一時領域で完結）
mise run ext:update 2026.7.0    # 別バージョンへ張り替える（こちらはリポジトリの lock を書き換える）
mise run ext:rollback           # lock を git の状態に戻して再展開（要コミット済み。キャッシュから復元するのでオフラインでも戻せる）
mise run ext:update 2026.8.0    # git を使わずに戻すならこちら
```

確認ポイント:

- 更新の前後で**拡張 ID が変わらない**こと（`grep extension.loaded` でログを見る）。
  変わっていたら `manifest.key` の注入が効いていない = 拡張の設定が失われる
- lock の `sha256` を書き換えると `ext:fetch` が exit 1 で止まること
- **展開後のファイルを書き換えると `ext:verify` が落ち、起動しても拡張がロードされないこと**
  （ログに `extension.integrity_failed` が出て、`/json/list` に service_worker が現れない）

## パッケージ成果物を確認する

```bash
mise run package            # ビルド → notice 生成 → electron-builder → ad-hoc 署名 → 検査
mise run verify:packaged    # 使い捨てプロファイルで .app を起動し、拡張・SQLite・ログを見る
```

`mise run package` が見ている項目:

- bundle id / 表示名が channel（dev / stable）と一致していること
- `better-sqlite3` が asar の**外**に出ていること
- 拡張 artifact が asar の**外**にあり、asar の中に二重に入っていないこと
- `electron-chrome-extensions` の preload・ブラウザ UI・UI の preload が同梱されていること
- GPL-3.0 の `LICENSE` と第三者 notice が同梱されていること
- Electron fuses（`runAsNode` 等）が意図どおりであること

dev 版と常用版は**表示名・bundle id・アイコン・データディレクトリ**が分かれる。
`dist/dev/mac-arm64/Nemo Dev.app` と `dist/stable/mac-arm64/Nemo.app` を
同時に置いても取り違えないよう、dev 版のアイコンには DEV リボンが入る。

### 配布用の署名まわりを触ったとき

notarize まで行かずに「署名が壊れていないか」だけ確かめられる（数分待たずに済む）:

```bash
NEMO_SIGN=1 node scripts/package.mjs stable   # Developer ID で署名（notarize はしない）
node scripts/verify-packaged.mjs stable       # 署名済み .app を起動して初期化まで進むか見る
```

`NEMO_SIGN=1` のときだけ増える検査:

- ad-hoc 署名でないこと / Developer ID Application で署名されていること
- `codesign --verify --strict --deep` が通ること
- （`NEMO_NOTARIZE=1` も付けたときだけ）公証のチケットが staple されていること

**常用版は remote debugging を開かない**（開けると拡張の service worker 経由で
アンロック済み Vault に手が届く）。そのため `verify:packaged stable` は CDP ではなく
**診断ログ**で起動を確かめる。機能の細かい検証は dev 版の経路で行う。

### 更新 feed が dev に混ざっていないこと

electron-builder は `publish` を書かなくても **git remote から推測して**
`app-update.yml` を埋め込む。これが dev に入ると、dev で更新チェックが走った瞬間に
常用版のビルドで dev が置き換わる。`scripts/after-pack.mjs` が消し、
`check-package` が成果物に対して検査する:

```bash
mise run package && ls "dist/dev/mac-arm64/Nemo Dev.app/Contents/Resources/app-update.yml"
# → No such file or directory になるのが正しい
mise run package:stable && cat "dist/stable/mac-arm64/Nemo.app/Contents/Resources/app-update.yml"
# → provider: github / owner: nyshk97 / repo: nemo
```

## リリースと自動更新

リリースは `mise run release` の1コマンドだけ（手順を分けない）。詳細は README「リリース」。

```bash
node scripts/changelog.mjs check     # [Unreleased] が空でないか（release の preflight と同じ）
mise run release 0.2.0               # preflight → bump → 署名 → notarize → GitHub Release
```

リリース後に確かめること:

```bash
gh release view v0.2.0 --repo nyshk97/nemo --json assets --jq '.assets[].name'
# → 今回の版の dmg / zip / *.blockmap と latest-mac.yml **だけ**が並ぶこと
#   （zip と latest-mac.yml が無いとアプリ内更新が動かない。
#     古い版の成果物が混ざっていたら dist/ の掃除が漏れている）

# **配ったものに対して**公証を見る。dmg と .app の両方を見ること
# （.app だけ公証しても dmg には署名もチケットも無い、という状態を実際に踏んだ）
gh release download v0.2.0 --repo nyshk97/nemo --pattern '*.dmg' --dir /tmp
spctl -a -t open --context context:primary-signature -vv /tmp/Nemo-0.2.0-arm64.dmg
xcrun stapler validate /tmp/Nemo-0.2.0-arm64.dmg
# → accepted / source=Notarized Developer ID
```

### アプリ内更新の通し確認

**1つ前の版を `/Applications` に入れた状態から**やる（ダウンロードフォルダから直接起動すると
App Translocation で更新が当たらない）。**メニュー操作は要らない**: 起動 30 秒後に自動チェックが走る。

```bash
# 1. 旧版が入っている状態で入れ直す（再起動すると自動チェックが走る）
osascript -e 'tell application "Nemo" to quit'
open -a /Applications/Nemo.app

# 2. 取得できたかをログで見る（30 秒ほどでチェック、そこから 143MB のダウンロード）
LOG=~/Library/Application\ Support/Nemo/logs
grep -h updater "$LOG/$(ls -t $LOG | head -1)"
# → updater.available → updater.downloaded の順に出る

# 3. 適用は**終了時**（autoInstallOnAppQuit）。終了して差し替わるのを待つ
osascript -e 'tell application "Nemo" to quit'
plutil -extract CFBundleShortVersionString raw /Applications/Nemo.app/Contents/Info.plist

# 4. 差し替わった .app が公証を保っていること
spctl -a -vv /Applications/Nemo.app && xcrun stapler validate /Applications/Nemo.app
```

`updater.downloaded` が出た時点で、サイドバー左下の表示が `0.2.0 に更新` のボタンに変わる。
押すと確認ダイアログを経て再起動して適用される（終了を待たずに当てたいときの導線）。

> **dev 版（Nemo Dev）では更新の導線は動かない**
> （メニューから選ぶと「この版では確認できない」と出るのが正常）。
> 常用版のログに `updater.disabled` が出ていたら、feed の埋め込みか channel の判定が壊れている。

## アイコンを変えたとき

```bash
mise run icons              # build/icon.icns / icon-dev.icns と 512px の PNG を生成
```

見た目は生成された PNG を開いて確認する（`build/icon.png` / `build/icon-dev.png`）。
**小さいサイズで潰れないかは必ず見る**（Dock で実際に出るのは 32〜128px）:

```bash
sips -Z 32 build/icon.png --out /tmp/i32.png && sips -Z 512 /tmp/i32.png --out /tmp/i32-zoom.png
open /tmp/i32-zoom.png
```

パッケージ済みの .app に反映されたかは、`mise run package` のあとに
`.app` の中の icns を PNG にして見る（`qlmanage -t` は固まることがあるので使わない）:

```bash
sips -s format png "dist/dev/mac-arm64/Nemo Dev.app/Contents/Resources/icon.icns" --out /tmp/packaged-icon.png -Z 256
open /tmp/packaged-icon.png
```

## 拡張互換 smoke（CI と同じもの）

```bash
mise run verify:ext        # 自作テスト拡張だけを使う。資格情報も外部ダウンロードも要らない
mise run verify:ext-idle   # service worker の idle 停止をまたぐ確認まで
```

見ている項目: lock どおりの ID / version でロード / オプションページの検出 /
service worker の起動 / content script（トップ + iframe）/ content script → SW のメッセージ /
`chrome.tabs.create`（`active: false` を含む）/ `chrome.windows.create` / `remove` /
popup が開いて `chrome.*` が使える / オプションページを Nemo から開ける /
再起動と idle 停止をまたいだ `chrome.storage.local`。

テスト拡張の実体は `test-extension/`。公開鍵は `test-extension.key.json` にコミットしてあり、
`scripts/make-test-extension.mjs` が manifest に注入して**拡張 ID を固定**する。

## Phase 0 受け入れテスト（人間の操作が要る分）

### 実 Vault を入れるなら `mise run dev:nodebug` を使う

`mise run dev` は remote debugging（CDP）を 9333 で開ける。
**CDP に到達できるものは拡張の service worker で任意の JS を実行でき、
アンロック済み Vault の中身に手が届く**（自走検証がまさにそれをやっている）。
実アカウントでログインするときは `mise run dev:nodebug` で起動し、CDP を閉じておく。

- `mise run verify` は使い捨てのデータディレクトリ（`/tmp/nemo-verify-*`）を毎回作って回すので、
  実 Vault の入ったプロファイルには触らない。手で CDP つきの検証をするときは
  `NEMO_USER_DATA_DIR=$(mktemp -d)` を付けて実 Vault のプロファイルから隔離する
- 終わったら popup の Settings → Log out でログアウトする
- dev 版のデータを消すなら `rm -rf ~/Library/Application\ Support/Nemo-dev`
  （常用版の `Nemo/` とは別のディレクトリなので、消しても常用環境には影響しない）

### popup がおかしいとき

拡張の popup はタブではないので ⌘⌥I の対象にならず、メニューから DevTools を開こうとすると
blur で popup 自体が閉じる。`mise run dev:popup` で起動すると **popup の生成と同時に
DevTools が開く**（`PopupView` は DevTools が開いていれば閉じない）。CDP は開かないので
実 Vault のままで使える。

```bash
mise run dev:popup
```

端末には `extension.popup_load_failed` と `extension.popup_console`（error / warning の
**件数と発生箇所だけ**。本文は出さない）が流れる。**本文は DevTools のコンソールで見る**
——ログにはメールアドレスやトークンが載りうるため、意図的に出していない。

### 手順

1. `mise run dev:nodebug` で Nemo を起動する（テストページのサーバも一緒に立つ）
2. ツールバーの Bitwarden アイコンから popup を開く
3. テスト用アカウントでログインし、Vault をアンロックする
4. `http://127.0.0.1:8787/login.html?site=a` を開き、自動入力を試す
   - ページ下部の「username: 入力あり(N文字) / password: …」表示で入力の有無が分かる
5. `http://127.0.0.1:8787/iframe.html` で iframe 内のフォームに自動入力できるか見る
6. `?site=a` と `?site=b` を別タブ・別ウィンドウで開き、**対象タブを取り違えないか**見る
7. Nemo を再起動し、Vault のアンロック状態と拡張の設定が期待どおりか見る
8. 数分放置して service worker が idle 停止した後、popup と自動入力が動くか見る
   （`/json/list` に `service_worker` が出なくなったら停止している。ツールバーの `↺SW` で明示的に起こせる）
9. `mise run ext:update <別バージョン>` → 再起動 → **ログインし直しを求められないこと** → 自動入力が動くか
   → `mise run ext:update <元のバージョン>`（またはコミット済みなら `mise run ext:rollback`）で戻す
10. ⌘⌥I で DevTools が開くか

## Phase 1 で人が見る分

自走検証でカバーできないもの（見た目・キー入力・実 Vault）だけ手で見る。

1. **キーバインドが実際に届くか**（メニュー項目として登録しているので、メニューにも同じ表示が出る）
   - ⌘T コマンドバー / ⌘L アドレス編集 / ⌘S サイドバー開閉 / ⌘D ピン留め
   - ⌘F 検索 → ⌘G 次 → ⌘⇧G 前 / ⌘+ ⌘- ⌘0 zoom / ⌃⌘F フルスクリーン
   - ⌘W タブを閉じる / ⌘⇧T 開き直す / ⌃Tab タブ送り / ⌘1〜⌘9
   - ⌘⌥I ページの DevTools / ⌘⌥⇧I ブラウザ UI の DevTools
2. **サイドバーの見た目**（DESIGN.md との一致・favicon・未読ドット・sleep の薄さ）
3. **ドラッグ & ドロップ**（ピン留めの並べ替え・フォルダへの出し入れ・Favorites の並べ替え・
   **一時タブの行をピン留めへ落とす**）
4. **トラックパッドの2本指スワイプ**（自走検証は合成イベントなので、実際の指では別途見る）
   - 指を右へ払って戻る / 左へ払って進む
   - **戻った勢い（慣性）でもう1ページ戻らないこと**
   - 横スクロールできるページ（幅の広い表など）で、端に着くまでは履歴が動かず、
     **端に着いたらそのまま払い続けて戻れること**
   - ページを読んでいる最中の斜めスクロールで飛ばないこと
5. **動画サイトの全画面**（ページからの全画面要求）
6. **実 Vault の Bitwarden で自動入力が動くこと**（`mise run dev:nodebug` で起動する）
7. **拡張を更新した後も実 Vault で自動入力が動くこと**
