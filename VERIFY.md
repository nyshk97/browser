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
mise run verify:only phase1 pins  # そのうち指定したものだけ回す（1回あたり数十秒）
mise run verify:changed     # 作業ツリーの変更から回すものを自動で選ぶ（ふだんの往復はこれ）
mise run verify:switcher    # タブスイッチャー（⌃M）だけを個別に回す
mise run verify:ext         # 拡張互換 smoke（自作テスト拡張・資格情報なし・CI 必須と同じもの）
mise run verify:ext-idle    # 上に service worker の idle 停止をまたぐ確認を足す（+2分ほど）
mise run package            # パッケージして成果物を検査（fuses・ネイティブモジュール・notice）
mise run verify:packaged    # パッケージした .app を起動して smoke test
mise run verify:ext-update  # 版を上げ下げしても拡張の設定が残ることを実物で検証
```

**ふだんの往復は `mise run verify:changed`、コミット前に 1 回だけ `mise run verify`**。
フルは 12 本すべてを回すので 1 回 6 分ほどかかる（実測 372 秒）。
`verify:changed` は作業ツリーの差分（未 commit + staged + untracked）から回すものを
自動で選ぶ（例: `SplitRow.tsx` だけ → `split` + `restart` の 50 秒ほど）。
どれを回すか自分で分かっているときは `verify:only` で直接指定してもよい。

`verify:changed` の決め方（逆引きは `scripts/lib/verify-targets.mjs`。ユニットテストつき）:

- **担当が確定しないファイルはフルに倒す**。`src/main/registry.ts` のように複数スイートが
  依存するものは意図的に対応表へ載せていない。対応表に無いパスも同じくフル
- **「検証に影響しないと分かっている」パス**（`docs/**` / `*.md` / `.github/**` など）だけの
  変更なら**何も回さずに正常終了する**。`docs/plans/` を毎ループ触るので、これが無いと
  最頻ケースでフルと同義になる
- **変更が一切ないときも同じ結論**（回さずに正常終了）。理由だけ `（変更なし）` /
  `（無関係パスのみ: …）` と出し分ける
- 決めた集合と、フルに倒れたときの引き金は必ず標準出力に出る
- `--only` と `--changed` の同時指定はエラー

**「回すもの無し」で終わった exit 0 をコミット可否の判断に使ってはいけない**。
それは「この差分は検証の対象外」と言っているだけで、フルが通った証明ではない。
コミット前のフル（`mise run verify`）は別に 1 回通す。

**`restart` は随伴する**。`split` / `call` / `live-folder` / `http-auth` / `spike` / `phase1` / `pins` を
選ぶと `restart` も自動で付く（片方だけだと `--restart-write` / `--restart-read` が
丸ごと落ちたまま PASS するため）。逆に `restart` の中身も `--only` / `--changed` で絞られるので、
`verify:only split restart` では spike / phase1 / pins の write+read は走らない。

指定できるのは `spike` / `phase1` / `phase2` / `pins` / `switcher` / `peek` / `split` / `call` /
`live-folder` / `http-auth` / `vim-scroll` / `restart` / `migration` / `db` / `slots`。

**`vim-scroll`（ページの `gg` / `G`）はフルの既定から外れている**（`verify-targets.mjs` の
`OPT_IN_ONLY`）。回るのは 3 経路 —— `mise run verify:only vim-scroll` で名指ししたとき、
`src/shared/vim-scroll.js` などを触って `--changed` が担当スイートとして選んだとき、
**`--changed` が絞れずフルに倒れたとき**（`registry.ts` のような `OWNERS` 外を触った場合。
その機能の配線を直したときこそ回ってほしいので素通しにしている。+10s 乗るのはこの経路）。フルに常設しないのは、縮めたフルの時間を無言で戻さないため
（増分は実測 +10s 程度）。**代償として「CDP の合成キーが後続スイートを壊す回帰」を
フルで拾えない**ので、撃つスイートを増やすときは `OPT_IN_ONLY` から一時的に外して
フルを 1 回通すこと（実行順は `http-auth` の後・`restart` の前）。

**`slots`（ブックマークのセーブスロット）も同じ理由でフルの既定から外れている。**
回る 3 経路は `vim-scroll` と同じ。外している理由はキーではなく**起動回数** ——
このスイートは使い捨てプロファイルで**アプリを 4 回起動し直す**ので、フルに +1〜2 分乗る。
`store/slots.ts` / `slots-schema.js` / `slot-apply.js` / `Slots.tsx` / `verify-slots.mjs` は
`OWNERS` に載っているので、スロットを触ったときは `--changed` が必ず選ぶ（実行順は最後、`db` の後）。

**待ち時間は `NEMO_VERIFY_TIMINGS` で縮めている**。`verify-all.mjs` が「見に行く周期 / デバウンス」の
検証値（`sleepSweepMs` など）を決めて、**アプリと検証スクリプトの両方**に同じ JSON を env で渡す。
本番既定値は `src/shared/timings.js` が唯一の置き場で、検証スクリプトは
`scripts/lib/timings.mjs` で env を**読み戻して**待ちを組む。

- **各スクリプトを単独で回す経路（`mise run verify:switcher` など）も壊れない**。
  そのときアプリは env を受け取らず本番値で動き、verify 側も同じ本番値にフォールバックする
- 知らないキー・数値でない値は**アプリ側も verify 側も即エラー**（黙って本番値に倒すと
  「アプリは本番値・verify は縮めたつもり」のズレが静かに生まれる）
- 実効値は起動ログの `timings.resolved` に 1 行出る（`effective` に JSON 文字列）。
  `mise run dev` で `overridden:false` かつ本番既定値になっていることを見れば、既定値の書き間違いに気づける
- **パッケージ版では効かない**（ゲートは `!app.isPackaged`）。`verify-packaged.mjs` が
  わざと env を渡したうえで実効値が本番既定値のままであることを見る
- 縮めてよいのは**「いつ判定するか」だけを変えるもの**に限る。載せてあるのは
  `sleepSweepMs` / `sessionSaveDebounceMs` / `sessionStoreDebounceMs` /
  `liveFolderPollMs` / `liveFolderTickMs` / `liveFolderBackoffMinMs`。
  `PEEK_PLACEHOLDER_TIMEOUT`（縮めると正常系が保険経路にすり替わる）は**載せない**
- **`liveFolderPollMs` と `liveFolderTickMs` の比（本番 1:12）は保つこと**。
  tick と同オーダーにすると「取得中に起きたタイマーの要求を捨てる」の検証が撃てなくなる

- 知らない名前はエラーにする（typo で「何も回さずに PASS」にしない）
- 回さなかったものは実行中と最後のサマリの両方に出る（フルで通ったと読み違えないため）
- `migration` / `db` は自分でアプリを起動するので、それだけ指定したときはアプリを立てない
- **検証どうしの前段依存に注意**。絞って回すと、前の検証が作ったタブや履歴が無いぶん
  候補や件数が足りずに落ちることがある。落ちたら「絞ったせい」で済ませず、
  **その検証が自分で前提を作るように直す**（コマンドバーの上下移動がこれで落ちた実例あり。
  候補を 3 件以上作ってから撃つように直した）

**待ちを縮める変更をしたら安全弁を通す**。「待ちが短すぎて検査が空振りしたまま PASS」は
実行しても気づけないので、**壊してから FAIL することを先に見る**。

```bash
# 例: sweep 周期を縮めたとき。sweepSleep と sweepArchive を「別々に」殺す
#     （registry.ts の関数先頭に `if (true) return` を入れてビルドし直す）
mise run verify:only split
```

- `sweepSleep` を殺す → `sleep: 対照タブ（見えていない非分割）は寝ている` に至る待ちが FAIL
- `sweepArchive` を殺す → sleep 側は PASS のまま
  `archive: 対照タブ（見えていない非分割）は閉じられている` だけが FAIL
- **閾値そのものを縮めたときは、前提チェックの「余裕」を実測で見る**。
  `sleep: 検査の前提…（下限 4500ms / 余裕 511ms）` の余裕が実測のばらつき（10ms 前後）に
  近づいたら縮め過ぎ。閾値 1/2 で余裕も 1/2 になる
- Live Folder の取得間隔を縮めたとき → `live-folders/index.ts` の `requestAutomatic()` にある
  `now >= nextAutomaticAttemptAt` のゲートを殺す。
  `⑲ バックオフ中はタイマーが起きても投げない` を筆頭に 4 件が FAIL する
- セッション保存のデバウンスを縮めたとき → `store/session.ts` の `saveSession` を空にする。
  `session.json が実際に書かれている（否定形の検査が空振りしていない証拠）`（peek）と
  `再起動前: session.json に分割が 2 組書かれている`（split）が FAIL する。
  **`--session-read` / `--lazy-read` は FAIL しない** —— 復元は定期保存ではなく
  終了時の `markCleanExit()` が担保しているため

**どれを回すか**:

| 触ったもの | 回すもの |
|---|---|
| ナビゲーション判定・設定スキーマ・キーバインド・ログ | `mise run check` |
| **タブスイッチャー（⌃M）**・MRU の並び・オーバーレイの割り込み | `mise run verify:switcher` |
| **ページの `gg` / `G`**（縦の端へ飛ぶ）・スクロール対象の選択・入力欄の除外 | `mise run verify:only vim-scroll` + 下の「ページの gg / G（実機）」 |
| **Peek（ウィンドウ内ポップアップ）・小窓（Little Nemo）**・popup の受け皿・⌘O の昇格 | `mise run verify`（`verify-peek.mjs` が含まれる）+ 下の「Peek と小窓（実機）」 |
| **分割ビュー（2 ペイン）**・ペインのレイアウト・結合行・sleep / アーカイブの除外 | `mise run verify:only split restart` + 下の「分割ビュー」 |
| タブ / ウィンドウ・サイドバー・**ツールバー（アドレスバー）**・コマンドバー・ダウンロード・権限 | `mise run verify` |
| **空状態（タブが 1 つも無いときの画面）** | `mise run verify:only phase1`（1-10。View 単位でスクショも撮れる） |
| **会議の小窓（Meet の通話コントロール）**・`meet-adapter.ts`・sleep の除外 | `mise run verify:only call restart` + 下の「会議の小窓（実機）」 |
| **Live Folder（GitHub の PR）**・取得のバックオフ・トークン | `mise run verify:only live-folder restart` + 下の「Live Folder（GitHub の PR）」 |
| **拡張アイコンの popup の位置**（ツールバーの View オフセット） | `mise run verify:ext` |
| 拡張まわり・Electron のバージョン | `mise run verify:ext`（+ 実機で Bitwarden） |
| パッケージング・ネイティブ依存・fuses | `mise run package` → `mise run verify:packaged` |
| 履歴 / アーカイブ・シークレット・設定画面・既定ブラウザ | `mise run verify`（`verify-phase2.mjs` が含まれる） |
| **履歴 DB のスキーマ**（列追加・インデックス） | `mise run verify:db-migration` |
| 設定同期・Arc 移行・拡張の版確認 | `mise run check`（ユニットテスト）→ 下の「設定同期」「Arc からの移行」 |

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
- `window.open` が Nemo のタブ / Peek になること（**サイズ指定つきの popup も Peek**。ウィンドウは増えない）
- **`chrome.tabs.create` / `chrome.windows.create` が Nemo のモデルに乗ること**
  （`active: false` でアクティブタブが変わらないこと・View が表示されないこと・`windowId` の対応・`remove` での後始末）
- 拡張から渡された URL がナビゲーション検証を通ること（`file:` は拒否 / 自分の拡張ページは許可）
- **拡張のインライン UI（`web_accessible_resources` の iframe）がページ内で動くこと**
  （`verify:ext`）。Bitwarden のオートフィル候補がこの経路。次の 5 つを**組で**見る:
  - 公開したページが iframe の中で走る（`load` ではなく **nonce の postMessage** で判定する。
    `load` はエラードキュメントでも発火するので証明にならない）
  - **公開していないページは Chromium に拒否される**（`net::ERR_BLOCKED_BY_CLIENT`）。
    サブフレームをホスト照合なしで通す判断は**この Chromium の強制に依存している**ので、
    ここが緩んだら検知できないと困る
  - iframe のホストが拡張 ID と**異なる**こと（`use_dynamic_url` の経路を踏んでいる証明。
    ホストで allowlist する実装に戻ると成立しなくなる）
  - トップレベル遷移（`location.href`）は拒否され、
    **`will-frame-navigate` の `isMainFrame: true` で**止まること
    （`will-frame-navigate` は `will-navigate` より先に発火するので、
    フレームの区別を誤っても後段で止まって PASS してしまう）
  - **サーバ側 302 で拡張ページへ飛ばす経路**（`/__nemo_redirect__?to=`）も拒否され、
    **`will-redirect` の `isMainFrame: true` で**止まること。
    `location.href` の遷移は `will-frame-navigate` しか踏まないので、
    `will-redirect` のトップフレーム側はこの経路でしか検証できない。
    **判定は遷移結果の URL ではなく診断ログで行う**——
    Nemo のガードが緩んでも Chromium が拒否してページは `chrome-error://chromewebdata/` に
    落ちるので、URL だけ見ると「遷移していない」と読めて素通りする
    （バグ版を入れて実測した。ログを見る検査だけが FAIL した）
- 拡張の service worker が動いていること・再起動要求が通ること
- 使えない `chrome.*` API の列挙（現状 `declarativeNetRequest` と `sidePanel.setOptions`）
- **拡張アイコンの popup がツールバーのアイコンの真下に出ること**（`verify:ext`）。
  ライブラリは popup の位置を「アンカーの**View 内座標** + ウィンドウの左上」で決めるので、
  足し戻しを外すとサイドバー幅ぶん左（サイドバーの上）に出る
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
- **候補の上下移動**（↑↓ と ⌃P / ⌃N。⌃ 付きは `defaultPrevented` まで見る ——
  macOS の入力欄は ⌃P / ⌃N を行移動として食うので、止め忘れるとキャレットだけ動く）
- **コマンドバーの縦位置**（箱の中心が画面中心より上・候補が満杯でも下がはみ出さない）。
  実ウィンドウをリサイズする API は無いので `Emulation.setDeviceMetricsOverride` で
  ビューポートだけ差し替え、既定（860px）と最小（480px）の両端で見る。
  **候補は kind ごとに 4 件で頭打ち**なので履歴を積んでも満杯にならない。
  高さの上限を見るときは行を複製して 12 件に膨らませる
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
- サイドバーの並び（一時タブに見出しを出さず、「New Tab」行がその先頭にあること）
- **サイドバーの寸法**（行の高さ 40px・閉じる × の当たり判定 26×26）
- **ツールバー**（高さ 40px・サイドバーの右を埋める・**ページがツールバーぶん下がる**・
  アドレスバーが現在のページを出す・サイドバー側にアドレスバーとナビ行が無いこと）。
  main の bounds は CDP から直接見られないので、**View ごとの `innerWidth` / `innerHeight` の関係**で見る
- **フォルダのダブルクリックでリネームに入らないこと**（開閉の状態も元のまま。
  リネームは右クリックの「名前を変更」だけ）
- **main プロセスの例外が診断ログに1件も無いこと**


`mise run verify` が見ている Peek / 小窓の項目（`scripts/verify-peek.mjs`）:

- **`<form method="POST" target="_blank">` の body が Peek 側に届く**こと
  （popup を「deny して URL だけ作り直す」実装に戻ると空になる）
- **`window.opener.postMessage` が親に届く**こと・**`window.close()` で Peek が閉じる**こと
- Peek が**サイドバーの一覧に出ない**こと・`getVisibleTabKeys()` が親と Peek の2つを返すこと
- **拡張から見た active が Peek を指す**こと（`tab.foreground` のログで見る）。
  別タブへ行って**戻ったあとも**指すこと（1回撃つだけの実装だとここで落ちる）。
  切り替えを繰り返しても同期が有限回で収まること（無限再入していない）
- **⌘O の昇格でページを読み直さない**こと（WebContents の id が変わらない）・
  昇格したタブが**配列の末尾**に来ること
- **昇格したタブは元の親タブを閉じても残る**こと（`outlivesOpener`）。
  昇格していない Peek は親と一緒に閉じ、**WebContents が残らない**こと
- **Peek の中の popup**で Peek が通常タブへ昇格し、孫が昇格後タブの Peek になること
  （古いほうを閉じると `window.opener` が死んで OAuth の戻りを受け取れない）
- **Peek を持つ親タブを別ウィンドウへ移すと Peek も付いてくる**こと
- Peek を持つ親タブが `tabSleepMinutes` を過ぎても寝ないこと
- **Peek を閉じたら暗幕の View も隠れる**こと（残ると最前面の透明 View が
  ページのクリックを丸ごと遮る）。**暗幕にフォーカスがあっても ⌃M が確定できる**こと
- 小窓: 外部 URL（**2つ目のインスタンスの argv**＝実際に踏む経路）で1枚できること /
  原則4枚で最古が閉じること / **セッションに保存されない**こと /
  ⌘W でウィンドウごと閉じて空の小窓が残らないこと / ⌘O で通常ウィンドウのタブになり
  **読み直さない**こと
- 小窓の中の popup が**もう1枚の小窓**になり、1枚目（= 子の opener）が生きていること
- **5段ネストさせると上限4枚を一時的に超える**こと（既存がすべて opener なので閉じる候補が無い）。
  **たった今開いた5枚目が victim に選ばれない**こと。末端を閉じたら4枚まで詰まること

`mise run verify` が見ているピン留め / Favorites の項目（`scripts/verify-pins.mjs`）:

- **リネーム**（定義 / 一時タブ / 専用タブ経由・`null` で解除して既定名に戻る・
  既定名 `title` はリネームしても残る）
- **リネーム済みの一時タブをピン留め / Favorites へ移しても名前が残る**
- **フォルダは1階層**（フォルダをフォルダの中へは動かせない）
- **Favorites が専用枠**（`openFavorite` で作ったタブが `favoriteId` を持ち `pinnedId` は null /
  1 ウィンドウ 1 定義 1 タブ / 閉じてもアーカイブに載らず定義も消えない）
- **降格しても名前が残る**（ピン留めを解除 / Favorites から外す / フォルダごと削除の巻き添え /
  変換で同じ窓の先客タブが降格する、の各経路）
- **変換（ピン ⇄ Favorites）**（操作中のタブが変換先に属し、元の定義が消えること）
- **ピンの URL は固定**（遷移しても変わらない / 「このページに更新」で差し替わる /
  **別のピンが既に持つ URL への更新は拒否される**）
- **シークレットで開いたページのタイトルを `pins.json` に書かない**
- UI 操作（合成イベント）:
  - **閉じているピン行をダブルクリックしてもタブが増えず、編集だけが始まる**
    （単クリックの遅延が効いているかの決定打。`click` → `click` → `dblclick` の順で撃ち、
    遅延を超えて待ってからタブ数を見る）
  - **既に開いている専用タブの選択は遅延しない**
  - 右クリックメニューが出る / **閉じているピン行に「このページに更新」を出さない** /
    「名前を変更」で編集に入る / Esc で取り消すと名前が変わらない
  - **一時タブを Favorites グリッドへドロップして追加**（**空のときと既に何件かあるときの両方**。
    空のときは受け皿そのものが別の要素）
  - ピン行をフォルダ行へドロップして中に入る / **フォルダをフォルダへのドロップは弾かれる**
  - Favorites のセルに状態（アクティブ / 閉じている）が出る

`mise run verify` が見ているタブスイッチャーの項目（`scripts/verify-switcher.mjs`）:

- 帯が **MRU 順**（先頭が今のタブ）で出て、最初のハイライトが**直前のタブ**であること
- 押すたびに1つ進み、**末尾まで行ったら先頭へ戻る**こと
- **押しているだけではタブが変わらない**こと
- **修飾キーを離した瞬間に確定する**こと。ここは IPC ではなく
  `Input.dispatchKeyEvent` で **本物の `keyUp` を撃って**確かめる
  （main の `before-input-event` を通る経路そのものを見ないと意味がない）
- 確定したタブが次から MRU の先頭に来る＝**1回押して離せば直前のタブと行き来できる**こと
- Esc・背景クリックで取消（タブが変わらない）/ カードのクリックでそのタブへ行くこと
- **押しっぱなしのまま6秒待っても、時間では切り替わらない**こと
- **帯の表示が古くなっても、押したカードのタブへ行く**こと
  （帯を出したままタブを閉じて「ずれる条件」を実際に作ってから見る）
- **既に閉じたタブのカードを押しても投げない**こと（投げると renderer 側で
  unhandled rejection になり、帯が出たまま残る）
- **見えているハイライトと、⌃ を離したときの切替先が一致する**こと
  （オーバーレイを読み直す経路 `getOverlayState` でも、閉じたタブを落とした配列と
  落とす前の位置が混ざらないこと）
- **ほかのオーバーレイが出ている間は割り込まない**こと・**タブ1枚では何も起きない**こと

自走検証では見られないので**実機で確かめる**:

- **⌃M のキー入力そのもの**。メニューのアクセラレータは AppKit が NSEvent の段階で
  処理するため、CDP から撃った合成キーでは発火しない。検証の入口は `switchTab()` を使い、
  割り当ての妥当性・重複は `scripts/keybindings.test.mjs` で見ている
- **ウィンドウが背面へ回ったときの取消**（CDP からフォーカスを外す手段が無い）。
  ⌃M で帯を出したまま ⌘Tab で別アプリへ移り、戻ったときに帯が消えていてタブが
  変わっていないことを見る

再起動をまたぐぶん（`--lazy-write` → 再起動 → `--lazy-read`）:

- **再起動後、ピン / Favorites のタブ実体が1つも無い**（遅延ロード。定義は残る）
- **枠をクリックすると初めてタブが生まれ、登録 URL が開く**
- **一時タブに付けた名前が再起動をまたいで残る**

旧版データからの移行（`mise run verify:migration` / `scripts/verify-session-migration.mjs`）:

- 版 2 の `session.json` から起動して、**旧ピンタブが一時タブとして復活しない**こと
- **移行後も元のアクティブタブが選ばれたまま**であること（先頭・中間のピンタブが落ちてもずれない）
- 版 1 の `pins.json` が読めること / **2階層目のフォルダが中身を親へ平坦化して読める**こと

履歴 DB の列追加（`mise run verify:db-migration` / `scripts/verify-db-migration.mjs`）:

- **旧スキーマの `history.db`（`favicon_url` の無い `pages`）を置いてから起動する**。
  `mise run verify` は毎回まっさらな userData を作る（`mkdtempSync`）ので、
  **既存テーブルへの `ALTER TABLE` を一度も通らない**。列を足す変更はここで見る
- 列が**1つだけ**足されること / 既存行の `title`・`visit_count`・`last_visited_at` が保たれること
- `pages_fts` が壊れていないこと（**日本語タイトルの部分一致**が引けること。trigram が効いている証拠）
- **2回目の起動でも列が増えず、未捕捉例外も出ない**こと（冪等）
- `history.db` を**読み取り専用にして起動しても履歴候補が返る**こと。
  列を足せない環境では `NULL AS favicon_url` に落ちる作りなので、ここが崩れると
  SELECT が例外 → `catch` で空配列となり、**履歴機能が黙って死ぬ**

> 合成ドラッグは **dragstart と drop の間を空ける**。ピン留めツリーは「何を掴んでいるか」を
> React の state に持つので、続けて撃つと drop の時点でまだ state が入っておらず、
> **実装が壊れていても PASS してしまう**。
>
> 行を名指しするときは `renameTab` で一意な名前を付けてから `.row[title="..."]` で引く。
> 「サイドバーの先頭の行」を掴むと、前の検証で残ったタブがいると対象がずれる。

> 検証スクリプトは `window.nemo.getAppStatus()` の `ready` を待ってから読み始める。
> UI の target が出た時点ではまだ起動時のタブが作られていない。
- セッション復元（前回のタブが戻る / 復元直後は sleep / 選ぶと読み直す）

個別に回すときは Nemo を起動した状態で `pnpm verify:spike`。

## ページの gg / G（実機）

自走検証（`mise run verify:only vim-scroll`）が**大半を見る**。
`gg` で最上部・`G` で最下部・猶予切れで飛ばない・内側スクローラ・入力欄の除外まで通す。

**自走では撃てないので実機で見るもの**:

- **実サイトでスクロール対象が当たるか** — Gmail / Slack / Notion（ルートが動かず内側の div が
  スクローラ）で効くこと。記事ページ（Wikipedia 等）でルートが動くこと
- **ページ側の `g` プレフィックスが無傷か** — GitHub で `g` `c`（コードへ）・`g` `i`（Issues へ）。
  Nemo は `preventDefault` しないので、これが壊れていたら設計が崩れている
- **入力欄に文字が入るか** — Gmail の検索ボックスや GitHub のコメント欄で `G` を打つ
- **なめらかさの手触り** — 長大なページで待たされすぎないか
  （気になるなら `behavior` を `'auto'` に倒す。倒すと自走検証の到達 polling も一緒に変わる）
- **Peek・小窓・分割ビュー**の各ペインで効くこと（分割は**フォーカスのある側だけ**が動く）
- **サイドバー・コマンドバーにフォーカスがあるときは効かない**こと
  （注入はページ側だけなので効かないのが正しい）
- **戻る / 進むでページに戻った後も効く**こと（bfcache から復元されると `dom-ready` が
  出ないため、`did-navigate` にも張ってある。片方だけだと一度戻ったあと二度と効かない）
- **iframe をクリックした後は効かない**こと（メインフレームにしか注入しない。
  ページの余白をクリックすれば戻る）

## 分割ビュー（2 ペイン）

```bash
mise run verify:split                 # 単体（アプリの起動ごと面倒を見る）
mise run verify:only split restart    # 再起動をまたぐ復元も含める
NEMO_VERIFY_SHOTS=<dir> mise run verify:only split   # 目視用の PNG を出す
```

- **D&D は合成イベントで撃つ**。`dragstart` → `dragover` → `drop` を、
  `dataTransfer` を差し込んだ `Event` で順に投げる（`verify-split.mjs` の `dragScript`）。
  **`dragover` に渡す `dataTransfer` は `getData` が空を返すものにする** ——
  HTML5 では `dragover` の時点で値が読めないので、そこを再現しないと
  「`types` だけ見て素通りする」誤実装が通ってしまう。行は `data-key` で引ける
- **キー操作（⌘W / ⌘数字 / ⌃Tab / ⌘F / ⌘⇧N）は撃てない**。メニューのアクセラレータは
  AppKit が NSEvent の段階で食う。`window.nemo.runCommandForVerify('close-tab')` から撃つ
  （`NEMO_VERIFY_DIAGNOSTICS=1` かつ未パッケージのときだけ生える口。
  `verify-all.mjs` の `startApp()` が渡している）
- **View の bounds は `window.nemo.splitDiagnostics()`** で読む。CDP からは測れない。
  角丸だけはここに出ないので、`NEMO_VERIFY_SHOTS` で撮った PNG を人が見る
- **スクリーンショットは `screencapture -l`**（`scripts/lib/window-shot.mjs`）。
  `Page.captureScreenshot` は**その WebContents しか撮らない**ので、
  フォーカス枠（素の `View`）も隔間も 1 枚も写らない

### 人が見る分

- タブ行を別のタブ行へドラッグして分割になるか（当たり判定が狭すぎないか）
- 分割中に Bitwarden の自動入力が両ペインで効くか
- **キーを実際に押す**（⌘W・⌘数字・⌃Tab・⌘F・⌘⇧N を分割中に）。
  自動検証はコマンドの口から撃っていて、**実キー入力からアクセラレータへの接続は通っていない**

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

**CDP で自走検証を書くときの罠が2つある。**

- **`window.open` は素の `Runtime.evaluate` では popup ブロッカーに弾かれる**。
  `userGesture: true` を付ける。付け忘れると「popup が開かない」のではなく**何も起きない**ので、
  実装のバグと見分けが付かない
- **自分が繋いでいる WebContents ごと消える操作**（小窓を閉じる ⌘W / ⌘O など）を `ev` で撃つと、
  **応答が返らず永久に待つ**。撃ちっぱなしにして時間で切り上げる
  （`Promise.race([session.ev(...), sleep(2500)])`）。ここでハングすると以降の検査が丸ごと飛ぶ
- **`createWindow()` した直後のウィンドウは、まだタブが 0 本**。`connectUi` が待つ
  `getAppStatus().ready` は**アプリ全体**の初期化であって、そのウィンドウの初期タブ生成ではない。
  待たずに「全タブを閉じる」と、閉じる対象が 0 件のまま **`tabs.length === 0` を満たしてしまい**、
  その後に初期タブが生えて検査が空振りする（空状態の検証で踏んだ）。
  `waitFor(side, '… s.tabs.length > 0 …')` を先に入れる

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

### React が持っている入力欄に値を入れる

`el.value = x` では React の state が変わらない（送信すると空のまま飛ぶ）。
native setter を呼んでから `input` を bubbles で撃つ。

```js
const el = document.querySelector('input[autocomplete="username"]')
const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, 'admin')
el.dispatchEvent(new Event('input', { bubbles: true }))
```

チェックボックスは `el.click()`。`<form>` の中の `button.primary` も `click()` で submit が走る。

### マイク / カメラ / 画面共有

テストページ `http://127.0.0.1:8787/media.html` のボタンを押して、
取得できたトラックの種類とデバイス名が出れば pass（結果は `window.__mediaResult` にも入る）。

**`mise run dev` で起動した Nemo では macOS の許可ダイアログが出ない**。
TCC は「責任プロセス」（プロセスツリーを遡って最初の非 Apple バイナリ = ターミナルや
Claude Code）にダイアログを紐づけるので、bundle でない親から起動すると
`askForMediaAccess()` が**ダイアログを出さないまま即 false を返す**
（ログの `media.os_access` が `status:"not-determined", granted:false` になる）。
**アプリとして起動し直す**と出る:

```bash
pnpm exec electron-vite build
node scripts/test-server.mjs &
open -n --env NEMO_REMOTE_DEBUGGING_PORT=9334 node_modules/electron/dist/Electron.app \
  --args "$PWD/out/main/index.js"
```

出た TCC ダイアログは AXPress で答えられる:

```bash
osascript -e 'tell application "System Events" to tell process "UserNotificationCenter" \
  to click button "許可" of window 1'
```

macOS 側で拒否されている状態は、TCC を直接見れば分かる（`auth_value` 2 = 許可）:

```bash
sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service,client,auth_value from access where client like '%nemo%';"
```

画面共有は **macOS のネイティブ共有ピッカー**（`useSystemPicker`）に出る。
画面上部に「ウインドウまたは画面全体を共有」のバーが出れば経路は通っている
（`screencapture -x` で確認できる）。選ばずに放置すると
ページ側は `AbortError: Timeout starting video source` になる。

### スクリーンショット

```bash
osascript -e 'tell application "System Events" to tell process "Electron"
  set p to position of window 1
  set s to size of window 1
  return ((item 1 of p) as string) & "," & ((item 2 of p) as string) & "," & ((item 1 of s) as string) & "," & ((item 2 of s) as string)
end tell'
screencapture -x -R<x,y,w,h> /path/to/out.png
```

**AI が自走で見た目を確かめるときは、View 単位で撮るほうが速い**。上の手順は
ウィンドウ全体を撮るためにウィンドウ位置を要求するが、サイドバーとツールバーは
**別の WebContentsView** なので、CDP の `Page.captureScreenshot` を View ごとに撮れば
位置を知らなくても済む（`osascript` の System Events が Claude Code の Bash から
通るかは未確認。上のブロックは人が手で叩く用と考える）。
常用の Nemo を止めずに済むよう、**使い捨ての userData** で開発版を起動する。

```bash
TMP=$(mktemp -d)
NEMO_USER_DATA_DIR="$TMP" node scripts/dev.mjs --built &   # CDP は 9333
# scripts/lib/cdp.mjs の connectUi(cdp, 'sidebar' | `toolbar&window=<id>`) で繋いで
#   await session.send('Page.enable')
#   const r = await session.send('Page.captureScreenshot', { format: 'png' })
# を撮る
pkill -f "$TMP"; rm -rf "$TMP"
```

- `connectUi(cdp, 'toolbar')` と**ウィンドウを指定せずに繋がない**。破棄したウィンドウの
  UI ターゲットもしばらく `/json/list` に残るので、死んだ View に繋がって
  IPC が `unknown_sender` で弾かれる。`toolbar&window=<windowId>` まで指定する
- CDP を使う使い捨てスクリプトは**最後に `process.exit(0)`** を置く。
  WebSocket が開いたままだと node が終了せず、タイムアウトまで待たされる
  （`node ... | tail` のようにパイプで受けていると、原因が「アプリが応答しない」に見える）
- `window.screenX` は**その View のオフセットを含まない**（ウィンドウのスクリーン位置が返る。
  サイドバーの View とツールバーの View で同じ値になる）。View 内の要素のスクリーン座標が
  要るときは、サイドバー幅などを自分で足す —— 足し忘れると 260px ずれた値を「正解」として
  比べることになる

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
2. **サイドバーとツールバーの見た目**（DESIGN.md との一致・favicon・未読ドット・sleep の薄さ・
   信号機とアドレスバーが同じ行に並ぶこと・**サイドバーを隠したときに信号機とボタンが重ならないこと**）
3. **ドラッグ & ドロップ**（ピン留めの並べ替え・フォルダへの出し入れ・Favorites の並べ替え・
   **一時タブの行をピン留めへ落とす** / **Favorites グリッドへ落とす**）
4. **ダブルクリックでのリネーム**（実マウスでの手触り・**IME の変換確定 Enter で編集が閉じないこと**。
   合成イベントでは `isComposing` の経路を通せない）
5. **⌘⇧T**（メニューのアクセラレータは CDP から合成できないので実キーで。①同じ枠のタブが開いて
   いれば増えずに選択されるだけ ②枠を消した後なら一時タブとして戻る。判定そのものは
   `scripts/tab-ownership.test.mjs` でユニットテスト済み）
4. **トラックパッドの2本指スワイプ**（自走検証は合成イベントなので、実際の指では別途見る）
   - 指を右へ払って戻る / 左へ払って進む
   - **戻った勢い（慣性）でもう1ページ戻らないこと**
   - 横スクロールできるページ（幅の広い表など）で、端に着くまでは履歴が動かず、
     **端に着いたらそのまま払い続けて戻れること**
   - ページを読んでいる最中の斜めスクロールで飛ばないこと
5. **動画サイトの全画面**（ページからの全画面要求）
6. **実 Vault の Bitwarden で自動入力が動くこと**（`mise run dev:nodebug` で起動する）
7. **拡張を更新した後も実 Vault で自動入力が動くこと**

## Live Folder（GitHub の PR）

自走検証（`mise run verify:only live-folder restart`）が**大半を見る**。
**GitHub には実際に繋がない** —— `NEMO_GITHUB_TEST_ENDPOINT` でローカルの HTTP サーバへ向け、
返す中身を切り替えて挙動を確かめる（`scripts/verify-live-folder.mjs`）。

自走検証が見るもの: 未設定 / `auth` / `rate-limit` / `transient` の出し分け・
打ち切りの表示・未読の立ち方と落ち方・single-flight・
`rate-limit` が手動を上書きできないこと・トークン変更の 1 回だけの例外・
壊れたキャッシュからの起動・シークレットでの非表示。

**小見出し（`REVIEW REQUESTED` / `CREATED`）は初期折りたたみ**で、行は開くまで DOM に無い。
表示行を前提とする既存検査は `readExpanded`（直前に `expandAll` で全部開く）で読み、
折りたたみ状態そのものの検査は raw の `ui.ev` で読む（`readExpanded` を通すと再展開されて検査にならない）。
開閉は React の state で、初回マウントと再マウント（設定の再有効化・再起動）で畳まれる（通常の再描画では保つ）。
どの検査が再マウントの後に来るかを追わずに済むよう「読むたびに開き直す」。

見た目の自己確認は `NEMO_VERIFY_SHOTS=<dir> mise run verify:only live-folder` で
「両方閉 / review だけ開 / 両方開」の PNG が `<dir>/live-folder-<場面>.png` に出る（判定には使わない）。

**認証は `NEMO_GITHUB_TEST_AUTH=stored-only` で回す**（PAT の保存 / 削除で
「未設定 → 取得 → 未設定」を同一プロセスで踏める唯一の値）。
差し替え中は**実ストア（`safeStorage`）に一切触らない** —— 触ると macOS の
Keychain 許可ダイアログ（`SecurityAgent`）が出て**検証が永久に止まる**（実際に踏んだ）。

### 人が見る分

自走検証では原理的に見られないもの。

1. **実アカウントで一覧が出るか**（設定 → GitHub の Pull Request で PAT を貼るか、
   `gh auth login` 済みならそのまま。社内 PR のタイトルが読めること）
2. **`github-token.json` に平文の PAT が無いこと**。
   自走検証は実ストアに触らないので、ここだけは手で見る:

   ```bash
   # PAT を設定画面から貼ってから
   cat "$HOME/Library/Application Support/Nemo-dev/github-token.json"
   # → {"encrypted":"..."} だけ。貼った文字列が現れないこと
   ```

3. **PAT が `gh` より優先されること**（設定画面の表示が「設定した PAT を使っている」になる）
4. **packaged 版を Finder から起動して、`gh` が見つかること**。
   ターミナルから起動すると `PATH` を継承してしまうので、**必ず Finder（または `open -a`）から**:

   ```bash
   open -a "Nemo Dev"
   # 設定 → GitHub の Pull Request が「gh auth token を使っている」になること
   ```

5. **PR をマージして 60 秒以内にサイドバーから消えるか**
6. **誰かにレビュー依頼を出してもらい、勝手に増えるか**
7. **サイドバーが縦に長くなりすぎないか**（ピン留めが押し出される感覚）
8. **`rateLimit.cost` を実データで確かめる**（100 件並ぶアカウントでも 1〜2 で収まるか）:

   ```bash
   grep '"event":"live_folder.fetched"' "$HOME/Library/Application Support/Nemo-dev/logs/"*.jsonl | tail -3
   # → "cost":1 / "remaining":4999 のように出る
   ```

## HTTP Basic 認証の自動入力

自走検証（`mise run verify:only http-auth restart`）が**大半を見る**。
401 を返す経路は `scripts/test-server.mjs` に入っていて、
クロスオリジンの検査用に `scripts/verify-http-auth.mjs` が**2 つ目のテストサーバを自分で立てる**
（`localhost` と `127.0.0.1` で分ける手は使えない。macOS の `localhost` は ::1 を先に引く）。

自走検証が見るもの: ルール無し / 有りの出し分け・誤パスワードの 2 回目でダイアログ・
protection space 単位の直列化（誤パスワードの送信は 1 回だけ）・ダイアログのグループ集約・
prefill と自己修復・拒否後のリロードで再送しないこと・
勝つルールが違う URL の並列・302 で別オリジンへ飛んだ先・遷移中断後の pending・
URL 長超過 / クロスオリジン / シークレット / `canSave: false` の直接投げ・
**敵対的な正規表現でも UI が固まらず、そのルールだけ無効化されること**・
テスターでは無効化されないこと・書き込み失敗 / キャッシュ消去失敗 / 同時保存・
復号失敗が再起動後も残ること・Settings の一覧 / インポート / テスター / 再マスク 3 経路。

**暗号化は `NEMO_HTTP_AUTH_TEST_CRYPTO=memory` に差し替えて回す**。
実 `safeStorage` に触ると macOS の Keychain 許可ダイアログ（`SecurityAgent`）が出て
**検証が永久に止まる**（PAT のときに実際に踏んだ）。
差し替え backend は**固定ヘッダ + checksum** で、暗号文を 1 バイト変えれば必ず復号エラーになる
（base64 や XOR だと壊しても例外にならず「1 件だけ無効化」の検査が空振りで PASS する）。

**「自動入力されない」を調べるときは `auth.not_autofilled` を見る**:

```bash
grep '"event":"auth.not_autofilled"' "$HOME/Library/Application Support/Nemo-dev/logs/"*.jsonl | tail
# → "reason":"cross-origin" / "scheme" / "private" / "not-a-tab" / "url-too-long" /
#    "no-match" / "pattern-timeout" / "decrypt-failed" / "rejected" のどれかが出る
```

**マーカーファイルで失敗経路を差し込む**（どちらも `!app.isPackaged` かつ差し替え中だけ有効）:

- `<userData>/.nemo-fail-auth-cache-clear` … `clearAuthCache()` だけを失敗させる
- `<userData>/.nemo-crypto-unavailable` … 「この端末では暗号化できない」に倒す

env にしない理由は、**起動から終了まで効きっぱなしになって他の検査を巻き添えにする**から。

### 人が見る分

自走検証は実 `safeStorage` に触らないので、**本番の暗号化経路はここでしか通らない**。

1. 実際に使っている Basic 認証のサイトで、ダイアログ → チェック → 次回自動入力。
   **保存したあと Nemo を完全に終了して起動し直してから**アクセスする ——
   同じセッションのままだと HttpAuthCache が答えてしまい、保存したルールも復号も一度も通らない
2. `http-auth.json` に平文のパスワードが無いこと:

   ```bash
   cat "$HOME/Library/Application Support/Nemo-dev/http-auth.json"
   # → password は base64 の暗号文だけ。入力した文字列が現れないこと
   ```

3. MultiPass のエクスポート JSON を取り込み、**変換後のパターンが意図どおりか一覧で確認**
   （黙って変換する方針なので、ここが唯一の確認機会）
4. **パッケージ済みの dev 版**で、通常の照合が効くこと・敵対的パターンでタイムアウト →
   ワーカー再生成が起きることを 1 回ずつ確認する
   （照合ワーカーは `{ eval: true }` でソースを文字列から起こすので asar のパス解決には依存しないが、
   `worker_threads` そのものが動くかは配布形態でしか確かめられない）

## ブックマークのセーブスロット

```bash
mise run verify:only slots      # 保存 / 読み込み / 削除 / 移行の通し（自分で起動する）
```

**フルの既定からは外れている**（`OPT_IN_ONLY`）。`pnpm verify` を素で回しても走らないので、
スロットまわりを触ったら上のコマンドか `mise run verify:changed` を使う。

**`NEMO_SLOTS_DIR` を必ず渡す**（スクリプトが渡している）。渡し忘れると**実 iCloud の
常用スロットに書く**ので、最初の検査が「保存先が env で解決されているか」になっている。

自走検証が見るもの:

- 保存 → `slot-1.json` が `{ version, data }` で書かれる / 埋まっている枠には書かない
- **同じ枠を読み込む → 降格 0 件**（ID が一致するので定義もタブもそのまま）。
  あわせて `pins.json` がスロットと一致することも見る
  （降格 0 件だけだと、読み込みが丸ごと no-op でも PASS する）
- **別 Mac 相当（ID を振り直した fixture）→ 所属タブが全部「今日のタブ」に降り、
  定義に付けていた名前を保つ**。降格前に名前を付けてから読み込む
  （付けずに見ると URL を見ているだけの検査になる）
- 読めない枠（`chmod 000`）は**「空き」ではなく `unreadable`**で、保存もできない
- **壊れた version の枠は退避され、カードの「再試行」で「空き」に戻る**。
  未来の版（`version: 99`）は**退避せず** unreadable のまま
  （新しい Nemo が書いたものを古い Nemo が捨てない）
- 2 階層フォルダ・不正 URL 混じりの fixture を読み込んでも平坦化・除去が効き、
  **2 回読み込んで結果が同じ**（冪等）

人が見る分:

- **常用機で初めて読み込む前に、必ず空き枠へ今の状態を保存する**（undo は無い）
- 2 台目で iCloud 経由のスロットが見えること。
  初回に「Nemo が iCloud Drive 内のファイルへのアクセスを求めています」が出ることがある
- 読み込み後のサイドバーで、降格したタブが 1 本も消えていないこと

## Basic 認証の保管庫（別の Mac への持ち出し）

```bash
mise run verify:only auth-vault   # 保存 / 差分 / 選択取り込みの通し（自分で起動する）
```

**フルの既定からは外れている**（`OPT_IN_ONLY`）。`pnpm verify` を素で回しても走らないので、
保管庫まわりを触ったら上のコマンドか `mise run verify:changed` を使う。

**`NEMO_SLOTS_DIR` と `NEMO_HTTP_AUTH_TEST_CRYPTO=memory` を必ず渡す**（スクリプトが渡している）。
前者を渡し忘れると**実 iCloud の常用の保管庫に書く**ので、最初の検査が
「保存先が env で解決されているか」になっている。後者を渡し忘れると実 `safeStorage` に触って
**macOS が `SecurityAgent` を上げ、検証が永久に止まる**。

**「別の Mac」は `NEMO_USER_DATA_DIR` を分けたうえで `NEMO_SLOTS_DIR` を共有して模す。**
`NEMO_SLOTS_DIR` だけ差し替えると同じプロファイルを使い回すことになり、
パスフレーズの記憶が引き継がれる経路をそのまま PASS させる。

自走検証が見るもの:

- 保存 → `basic-auth.json` が `{ version, data }` で書かれ、**ファイル全体に平文が現れない**
  （パスワード・パターン・ユーザー名のどれも。「暗号文が入っている」だけ見ると、
  平文が別のキーに残っていても PASS する）
- **無効なルールは保管庫に入らない**（保存は有効なものだけ）
- 別プロファイルで差分が 3 グループに分かれ、内容が違うものは**両側のユーザー名**が出る
- **チェックしたものだけ入る**。入ったことに加えて、
  **チェックしていないものが上書きされていない**ことも見る（片方だけだと全部入れても PASS する）
- 取り込んだルールの `updatedAt` が**保管庫の値を引き継ぐ**（読み込んだ時刻に化けない）
- パスフレーズ違いは `bad-passphrase`（**`tampered` に畳まれない**）。
  畳むと打ち間違いに「削除して作り直せ」と出すことになる
- 上書き保存の「消えるもの」が正しい向きで出る
  （向きを取り違えると「これから追加されるもの」を「消えます」と出す）
- 削除するとパスフレーズの記憶も消える
- **未来の版（`version: 99`）は退避せず** unreadable のまま。保管庫は全ての Mac が
  1 ファイルを共有するので、古い Nemo が退避すると**新しい方からも丸ごと消える**
- 壊れたファイルは退避され、次に開くと「空き」に戻る
- **設定画面に実際にカードが描かれ、件数が出る**（IPC だけ見ていると
  `AuthVault.tsx` の描画例外＝設定画面が丸ごと落ちるのを素通りする）

人が見る分:

- **実 `safeStorage` を使う経路**（パスフレーズの記憶）。自走検証は差し替え backend なので、
  Keychain に実際に入るのはここでしか見られない
- 2 台目で iCloud 経由の保管庫が見え、パスフレーズを入れて読み込めること
- 読み込んだルールで実際に Basic 認証が自動入力されること
- パスフレーズを打ち間違えたときに「削除して作り直す」ではなく
  **やり直しだけ**が出ること

## Arc からの移行（Phase 2-2）

```bash
mise run arc:import --dry-run   # 取り込む中身を全部表示する（書かない）
```

確認する点:

- **Arc を終了してから**実行する（起動中なら警告が出る）
- `取り込まず` の件数が多すぎないこと（`arc://` のような内部ページだけが落ちる想定）
- 使い捨てのデータディレクトリに 2 回流して、**結果が同じ**であること（冪等）:

  ```bash
  TMP=$(mktemp -d)
  NEMO_USER_DATA_DIR="$TMP/ud" NEMO_SYNC_HOME="$TMP/sync" mise run arc:import dev
  shasum "$TMP/ud/pins.json"
  NEMO_USER_DATA_DIR="$TMP/ud" NEMO_SYNC_HOME="$TMP/sync" mise run arc:import dev
  shasum "$TMP/ud/pins.json"   # 同じ hash になること
  ```

## 拡張の版確認（Phase 2-3）

```bash
mise run ext:outdated     # 新しい版が出ているかだけ見る。**何も書き換えない**
```

- lock の版と一致していれば「（最新）」と出る
- 確認できなかったとき（API 制限・ネットワーク）は**終了コード 1**。黙って見落とさない

## Phase 2 で人が見る分

自走検証（`verify-phase2.mjs`）が機械で見るのは
「履歴の全文検索 / アーカイブ / 自動アーカイブの条件 / シークレットに残らないこと /
オーバーレイの開閉 / 開発起動では既定ブラウザにできないこと」まで。残りは手で見る。

1. **ライブラリ（⌘Y）の見た目**。履歴とアーカイブの切り替え、行のダブルクリックで開けること、
   × で1件消せること、🗑 で全消しできること
2. **設定画面（⌘,）**。数値を打っている途中で確定されないこと（`3` の入力中に 0 に落ちない）、
   検索エンジンに `http://` を入れると採用されず既定に戻ること
3. **シークレットウィンドウ（⌘⇧P）**。サイドバーが紫になり、注意書きが出て、
   **拡張のアイコンが出ない**こと。
   - **閉じたら消えること**（自走検証はウィンドウを閉じられないので、ここは人が見る）。
     シークレット窓を**全部閉じて**から ⌘⇧P で開き直し、次を確かめる:
     - ログイン状態（cookie）が残っていないこと
     - **Basic 認証が残っていないこと**（`clearStorageData` では消えない。別途 `clearAuthCache` で消している）
     - シークレットで落としたファイルが**ダウンロード一覧（⌘⇧J）から消えている**こと
       （**保存したファイル自体は残る**。消えるのは一覧のファイル名と保存先）。
       なお開いている間も、シークレットのダウンロードは**通常ウィンドウの一覧には出ない**
     - 診断ログに `window.private_session_cleared` と `download.scope_forgotten` が出ること
   - 2枚目のシークレット窓は**同じセッション**（Chrome と同じ）。
     1枚目でログインした状態が2枚目でも生きていること。
     ⌘⇧N でシークレットのタブを新規ウィンドウへ移せること（移動先もシークレットになる）
4. **既定ブラウザ**（パッケージ版でのみ）:

   ```bash
   mise run package                 # dev 版でも確かめられる（既定にはしなくてよい）
   # 設定（⌘,）→「Nemo を既定のブラウザにする」→ 「既定のブラウザになっている」に変わること

   APP="$PWD/dist/dev/mac-arm64/Nemo Dev.app"
   TMP=$(mktemp -d)
   launchctl setenv NEMO_USER_DATA_DIR "$TMP"   # open は env を渡せないのでこれで渡す

   open -a "$APP" 'https://example.com/cold'    # 未起動経路（起動と同時に URL が来る）
   sleep 12
   open -a "$APP" 'https://example.com/running' # 起動済み経路
   sleep 4
   grep -h "open_url\|tab.create" "$TMP"/logs/*.log

   osascript -e 'quit app "Nemo Dev"'
   launchctl unsetenv NEMO_USER_DATA_DIR        # **必ず消す**（他の起動にも効いてしまう）
   ```

   - **`open -a` は LaunchServices 経由でしか届かない**。バイナリを直接 spawn した
     インスタンスに URL を渡そうとすると `_LSOpenURLsWithCompletionHandler() failed ... error -600`
     になる（アプリは動いているのに届かないので原因が分かりにくい）。アプリ側も `open` で起動する
   - 古い `Nemo Dev` が残っていると単一インスタンス制御で新しい方が即終了し、
     やはり -600 になる。先に `pkill -f "dist/dev/mac-arm64/Nemo Dev"` で掃除する
   - **未起動から開いたときも URL を取りこぼさない**こと（空のウィンドウで立ち上がらない）。
     ログに `open_url.queued` → `open_url.flushing` → `tab.create` が並ぶ
   - 起動済みなら `open_url.handled` → `tab.create` が並ぶ
   - Slack やメールからリンクを踏んで Nemo で開くこと（既定ブラウザにした後）

5. **一時タブの自動アーカイブ**を実運用の設定（24 時間）で確認するのは現実的でないので、
   設定画面で 1 時間などに落として翌日見る。**ピン留めしたタブが消えていないこと**を必ず見る

## 会議の小窓（Meet の通話コントロール）

自走検証は `mise run verify:only call restart`。**`restart` も一緒に回す**
（位置の復元は再起動をまたぐので、`call` だけだと `--position-read` が走らない）。

`verify-call.mjs` が見ているもの:

- 会議タブから離れると出る / 戻ると **hide だけ**（破棄しない）。**✕ は置いていない**
- 小窓のマイク・カメラが**ページ側の `data-is-muted` を実際に変える**（押した結果をページで裏取り）。
  逆にページ側でミュートすると小窓が追従する
- 縮退（プローブが読めない）→ 戻るボタンだけ・経過時間を出さない → **復帰しても経過時間が 0 に戻らない**。
  再参加のときだけ 0 から数え直す
- 複数 Meet / retarget / 古いプローブ応答で復活しない
- **会議中のタブが寝ない**（縮退中も）。会議が終わったら寝るようになる
- **背面のまま**マイクを押しても反映される（Chromium の rAF スロットリングを外している）
- 開閉 10 回でページ target 数がベースへ戻る（`webContents` の閉じ漏れ）
- 小窓以外の sender から `call:*` を撃つと弾かれる

**偽 Meet は `test-pages/meet-fake.html`**。本物と同じ目印（`[data-is-muted]` の 2 ボタン・
Material Icons の合字・参加中だけ現れる `[data-participant-id]`）を持たせてある。
判定 URL の差し替えは **`NEMO_MEET_TEST_URL_PREFIX`（URL の prefix 単位）**で、
`verify-all.mjs` の `startApp()` が採番済みポートから組んで渡す。
**origin 単位にしない** —— `test-pages/` は単一ポートから配信しているので、
`index.html` まで会議候補になってフル検証中ずっと縮退した小窓が出る。

裏口が塞がっていることは `mise run package` → `mise run verify:packaged` で見る。
**環境変数を実際に渡して**偽 Meet の URL を開き、小窓が出ないことまで確かめる
（渡さずに起動して出なかった、では証明にならない）。

### 実機で人が見る分

自走検証では **Space・フォーカス・⌘H** が原理的に見られないので、ここは人が見る。

1. 実際の Meet の会議に参加し、**他アプリへ移ると小窓が出る**こと。Nemo で別タブを
   見ているときも出ること。会議タブへ戻ると引っ込むこと
2. **他アプリをフルスクリーンにしても小窓が浮いている**こと（R2。`type: 'panel'` +
   `setAlwaysOnTop(true, 'floating')` で成立しているか）
3. **⌘H すると小窓も一緒に隠れる**（R1 の結論。Electron に `canHide` 相当の API が無い）。
   ⌘Tab で戻せば再び出る
4. マイク・カメラを押すと**その場ですぐ切り替わる**こと。
   **会議タブへ戻らないと反映されない、になっていないこと**（背面スロットリングを外している）。
   Meet 側の表示と一致すること（反転していないと「ミュートしたつもりで喋り続ける」）
5. ドメイン名を押すと会議タブに 1 クリックで移動できること（別ウィンドウ・別 Space でも）
6. **バーの余白を掴んで動かせる**こと。次に出たとき同じ位置に出ること
7. 会議を抜けると小窓が消えること。会議を数回やっても Nemo のメモリが増えていかないこと
   （`WebContentsView` 1 枚で約 89MB。閉じ漏れると会議のたびに漏れる）
8. **Dock アイコンが消えたりちらついたりしない**こと（`setVisibleOnAllWorkspaces` を
   使っていないことの確認。小窓と同じ）

## Peek と小窓（実機で人が見る分）

自走検証（`verify-peek.mjs`）が機械で見るのは
「popup の受け皿・opener と POST の維持・昇格・上限・セッション除外」まで。
**Space とフォーカスは原理的に見られない**ので、ここは人が見る。

1. **ターミナルをフルスクリーンにして、出力された URL をクリックする**
   - **Space が切り替わらない**こと（ターミナルが見えたまま）
   - 小窓がターミナルの上に出ること
   - 小窓に**キーボードフォーカスが来ている**こと（そのままスクロールできる・⌘W が効く）
   - **Nemo のメインウィンドウが前面に出てこない**こと
2. 小窓を出したまま**別の Space へ移る**と、小窓が付いてくること
   （NSPanel なので全 Space 追従になる。「出した Space に固定」はできない —— Phase 0 で実測）
3. 続けてもう1本 URL を踏み、2枚目が少しずれて出ること。5本目で最古が閉じること
4. 小窓で ⌘O を押し、メインウィンドウが前面に出て（**ここでは Space が切り替わってよい**）
   タブになること
5. **Nemo を終了した状態から URL を踏み、小窓だけが出ること**（メインは背面で復元）。
   ログに `session.restoring ... "hidden":true` と `mini.open` が並ぶ
6. **Dock アイコンが消えたりちらついたりしない**こと
   （`setVisibleOnAllWorkspaces` を使うと process type の変換で消える。使っていないことの確認）
7. **実 Vault の Bitwarden**（`mise run dev:nodebug`）で、**Peek のログイン画面**と小窓で
   自動入力が効くこと（＝拡張から見た active が Peek を指せていること）
8. 実際の **OAuth ポップアップ**（`window.open` にサイズ指定があるもの）が Peek で開き、
   認証後に `window.close()` で閉じて親に結果が返ること
9. **⌘クリック（背面タブ）**。`disposition: 'background-tab'` は修飾キー込みの実クリックでしか
   作れず（メニューのアクセラレータと同じで CDP からは撃てない）、自走検証では見られない。
   - 通常ウィンドウで ⌘クリック → **Peek にならず背面タブに積まれる**こと
   - **小窓の中で ⌘クリック → もう1枚の小窓が開く**こと（小窓はタブを増やせないので、
     背面タブへ流すと黙って捨てられる。前面・背面を問わず小窓にする）
10. **Peek のプレースホルダーの見え方**。自走検証（`verify-peek.mjs`）が見るのは
    「暗幕 View の中に正しい矩形・色・角丸で描かれているか」と「中身が来るまで本体の View を出さないか」まで。
    **合成後の見え方は機械では見られない**（`screencapture` はウィンドウが別 Space にあると
    古い絵を返す）ので、ここは人が見る。
    - `mise run test:pages` を立て、`http://127.0.0.1:8787/__nemo_gate__?id=x` を
      `target=_blank` で開くと**応答を握ったまま止まる**。窓の形（角丸の暗い面）がすぐ出ること
    - `curl "http://127.0.0.1:8787/__nemo_gate_release__?id=x"` で解放すると、
      プレースホルダーから中身へ**位置が飛ばずに**切り替わること
    - 白地のページを Peek で開いたとき、暗い面 → 白ページの切り替わりが不快でないこと
    - 解放せず 8 秒待つと、保険のタイムアウトで本体の View が出ること（永久に出ないままにならない）

技術スパイク（`scripts/spike-mini-window.mjs`）を使うと、Nemo 本体に触らずに
Space とフォーカスだけを測り直せる。**別プロセスでフルスクリーンの「おとり」を立てて
各段階を `screencapture` で撮る**ので、Space が動いたかを目視でなく画像で判定できる。

```bash
node scripts/spike-mini-window.mjs --role decoy &        # おとりのフルスクリーン
node scripts/spike-mini-window.mjs --mode focus-only --panel --no-all-workspaces \
  --probe-accelerator --probe-other-space --shots /tmp/shots --report /tmp/spike.json
```
