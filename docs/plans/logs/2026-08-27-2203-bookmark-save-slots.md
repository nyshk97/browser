review session: 05d8a5f2-854f-4562-a9f7-bc8b66a40dc1

# レビューログ: ブックマークのセーブスロット


## 1回目

````text
コードベースを確認した上でのレビューです。

## P0
- `Phase 5 > 1` — `scripts/arc-import.mjs` が `src/shared/sync-schema.js`（`stringify`）と `scripts/lib/config-sync.mjs`（`assertNotRunning` / `backupLiveData` / `timestamp` / `userDataDirFor`）を import している。この 2 つを消すと `mise run arc:import`（`.mise.toml:198`、README にも掲載）が import エラーで即死する / Arc 取り込みは今回の廃止対象ではないのに巻き添えで壊れ、Phase 5 の途中で「どこまで残すか」を再設計することになる / 削除前に arc-import が使っている関数の行き先を決める（`scripts/lib/arc-import-fs.mjs` へ移すか、`arc-import.mjs` 内にインライン化する）ステップを Phase 5 の先頭に足す。`src/shared/sync-schema.js` の `stringify` も同様。
- `Phase 2 > 3` — `scripts/slot-apply.test.mjs` は `store/pins.ts`（→ `paths.ts` → `electron`）と `registry.ts` を読むことになるが、`scripts/*.test.mjs` は 17 本すべて `src/shared/*` か `scripts/*` しか import していない（`electron` を読める node:test 環境が無い）/ 書いた瞬間に import で落ち、テストを verify 側へ移す作り直しになる / 「旧定義スナップショット → 降格対象の算出」を `src/shared/` の純関数（`tab-ownership.js` の流儀）に切り出し、そこを `slot-apply.test.mjs` で固定する。`pins.ts` / `registry.ts` はその関数を呼ぶだけにする。
- `Phase 6 > 1` — 新設する `scripts/verify-slots.mjs` を `scripts/lib/verify-targets.mjs` の `KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS`（+ `verify-all.mjs` の分岐、必要なら `RESTART_COMPANIONS`）へ登録するステップが無い / `verify-targets.test.mjs` の「`scripts/verify-*.mjs` はすべて分類されている」が FAIL し、Phase 6 最後の `pnpm test` で止まる / Phase 6 に登録ステップを明記し、`src/main/store/slots.ts` / `src/shared/slots-schema.js` を `OWNERS` に載せる（載せるなら「このスイートしか見ていない」ことを確認する）。
- `Phase 1 > 3` — `listSlots()` が「壊れていたら空きとして返す」しか決めていない。iCloud では**読めない理由が壊れ以外にもある**（TCC 拒否の EPERM、未ダウンロードの dataless ファイル、同期途中）/ 読めない枠が「空き」に見えると、ボタンが「保存」になり、押した瞬間に tmp+rename で**別 Mac のスロットを黙って潰す**（上書き保存 UI を消した前提が崩れ、undo も無い）/ 「ファイルが `ENOENT`」のときだけ空き、それ以外の失敗は `unreadable` 状態にしてカードを「読み込めません（理由）」+ 保存/読込ボタン無効にする。保存時も rename 直前に存在確認（または `wx` で書いてから rename）を入れる。
- `Phase 1 > 3` / `Phase 6 > 1` — Phase 6 は `NEMO_SLOTS_DIR` を使う前提だが、Phase 1 の `slotsDir()` は「iCloud → `userData/slots/`」しか書いていない / env override を実装し忘れたまま Phase 6 を回すと、検証が**実 iCloud の `Nemo-dev/slots/`（常用機の iCloud 領域）に書く** / `slotsDir()` の解決順を「`NEMO_SLOTS_DIR` → iCloud → `userData/slots/`」と Phase 1 に明記し、override 時はその旨をログと画面のパス表示にも出す。
- `Phase 2 > 2` — 保存した本人の Mac で同じ枠を読み込むと、旧定義と新定義の**ID が一致する**のに `replaceAll` の戻り値（旧定義全部）を `demoteEverywhere` に渡すため、開いていたピン留めタブが全部降格する / 定義はサイドバーに残ったまま同じ URL の一時タブが並び、ピンをクリックすると 2 個目のタブが開く。しかも Phase 6 の「保存 → 読み込み」検証はこの状態を PASS と読む / 降格対象を「旧 ID − 新 ID」の差分にする（`replaceAll` が消えた定義だけを返す）。「マージしない」決定とは矛盾しない。

## P1
- `Phase 3 > 3` — `SlotSummary.icons` が「アイコン URL の配列」だと、favicon が取れなかった項目でホスト名の頭文字フォールバック（`Phase 4 > 4`）が描けない（元ページのホストが失われる）/ 別 Mac ほど favicon が欠けるのに、そこでこそ代替が出ない / `icons: { url: string; faviconUrl: string | null }[]` にして、`slots-schema.js` の `normalizeSlot` でもこの形で丸める。
- `Phase 4 > 4` — 頭文字 + ホスト由来の色のフォールバックは `Sidebar.tsx:380` の `Favicon` に既にある / 二重実装すると色の決め方がズレて、サイドバーとスロットで同じサイトが別の色になる / 「`Favicon` を再利用する」と明記する（`url` と `src` を渡す形なので上の `icons` 型変更とセット）。
- `Phase 2 > 1` — `pins.ts` の `commit()` は `JsonStore.set()` = 400ms デバウンス + 失敗を握り潰す `saveNow()` / スロット読み込みは「元に戻せません」と言って実行する破壊的操作なのに、IPC が成功を返したあとに `pins.json` の書き込みが失敗しうる（`github-token.ts` で `JsonStore.commit()` を導入したのと同じ構造）/ `replaceAll` は `JsonStore.commit()` を使って書けたときだけメモリ反映し、成否を `applySlot` → IPC → UI まで返す。
- `Phase 1 > 3` — 「一覧を開くたびにディスクから読み直す」を同期 `readFileSync` で main で行う設計になっている / iCloud の evicted（dataless）ファイルは読み取りでダウンロードが走り、オフライン/低速時に**main プロセスごと固まる**（全ウィンドウが止まる）/ `fs.promises` + タイムアウトにし、時間内に読めない枠は上の `unreadable` 状態（「iCloud から取得中」）で返す。
- `Phase 4 > 2` — 確認ダイアログを `Settings.tsx` のローカル state で自作すると、`prompts.ts` が明文化している「ダイアログは CDP から答えられる形にする」流儀の外に出る / Phase 6 の自走検証が保存/読み込み/削除の確認を押せず、通しの確認が組めない / 既存の `PromptDialog` に種別を足すか、少なくとも `data-testid`（例 `slot-confirm-apply`）とボタンの識別子を計画時点で決めて Phase 4 に書く。

## P2
- `Phase 6 > 2` — ファイル名 `slot-1.json`（1 始まり）と IPC の `index` 0〜2 が食い違っている / どちらかに寄せるか、変換をどこで行うかを `Phase 1 > 3` に 1 行入れる。
- `Phase 1 > 1` — `icons` を https のみに絞ると、`pages.favicon_url` に入っている `http:` / `data:` の favicon が落ちる。UI の CSP は `img-src 'self' crx: data: https:` なので `data:` は表示できる（ただしファイル肥大の上限は要る）。
- `Phase 4 > 1` — 設定画面の既存文言は常体（「同期できる」「端末ローカルで」）。スロットだけですます調にすると 1 画面に 2 つの文体が並ぶ。ダイアログはですます調、パネル内の説明は既存に合わせる等の切り分けを決める。
- `Phase 1 > 3` — 「解決結果をログに残す」でフルパスを出すとホームディレクトリとユーザー名が診断ログに載る。既存の store は `path.basename` だけを載せている。`{ kind: 'icloud' | 'fallback' | 'env' }` に落とす。
- `Phase 5 > 5` — `git grep config-sync` の対象に `src/` も含める（`src/main/store/github-token.ts` の `SYNCED_FILES` 参照コメントなど、消えるファイルを指すコメントが残る）。`docs/CHANGELOG.md` の履歴記述は書き換えない、も明記しておくと迷わない。

## Q
- `前提・わかっていること > 決定表` — config-sync 廃止後、`settings.json`（キーバインド）と GitHub PAT の 2 台目への移し方が無い（スロットはピン留め + お気に入りだけ）。冒頭の目的「新しい Mac を買ったときに設定画面だけで移行が完結する」と矛盾する / 決めないと、新 Mac でキーバインドを手写しすることになるか、廃止のタイミングを後ろ倒しにする判断が実装後に必要になる。
- `前提・わかっていること > 決定表（dev 版）` — dev と stable でスロットのフォルダを分けると、dev ビルドからは常用スロットを一切読めない。Phase 6 も使い捨てディレクトリなので、**実データでの読み込みは常用版に入るまで一度も通らない** / 決めないと、初めて実データを読むのが常用機での本番実行になる（undo 無し）。「dev から stable のスロットを読み取り専用で一覧できる」を許すか、人間の動作確認をどう安全に行うかを決める必要がある。
- `Phase 1 > 3` — 2 台で同じ枠に保存したときの iCloud のコンフリクトコピー（`slot-1 2.json` の類）をどう扱うか（拾って見せる / 無視する / `.broken` と同様に退避）/ 決めないと、片方の保存が UI からは消えたように見えて、フォルダにだけ残る。
````

**対応**: P0 6件をすべて反映（arc-import が sync-schema / lib/config-sync を import している事実、scripts/*.test.mjs が electron を読めない事実、verify-targets の登録検査、ID 一致時の降格、unreadable 状態、NEMO_SLOTS_DIR の解決順 — いずれもコードで裏取りした）。P1 は書き換えで済むものを全部採用（icons の型を {url, faviconUrl} に、Favicon の再利用を明記、replaceAll を JsonStore.commit() に、非同期+タイムアウト、ダイアログに data-testid）。P2 も全部採用（ファイル名と index の変換をストア層に閉じる、data: の favicon を許す、文体の切り分けを決定表に明記、ログにフルパスを出さない、git grep に src/ を含め CHANGELOG は触らない）。Q 3件は未対応（終了報告へ）。

## 2回目

````text
## P0
- `Phase 2 > 3` — 現在の checkout（HEAD `8ef5104`・作業ツリーはクリーン）の `src/main/store/json-store.ts` は 116 行で、公開 API は `get` / `set` / `update` / `saveNow` / `close` だけ。`commit()` は無く、`src/main/store/http-auth.ts` というファイルも無い（`src/main/store/` は archive / call-window / db / github-token / history / json-store / permissions / pins / session / settings の 10 本）。前回私が「`JsonStore.commit()` が使える・`store/http-auth.ts:100` が先例」と伝えたのは、いま手元にあるツリーの事実ではない（その指摘は誤り。`scripts/*.test.mjs` も 17 本ではなく 16 本） / 「`JsonStore.commit()` を使う」ステップが着手した瞬間に書けず、Phase 2 の途中で `json-store.ts`（settings / pins / permissions / session / github-token が共有する）の改修に降りることになる / Phase 2 の先頭に「`JsonStore` に `commit(mutate)` を足す（先に書き切り、成功したときだけメモリへ反映、失敗は false・キューで直列化）」を独立ステップとして置く。または `replaceAll` 側で tmp + rename を自前に行って成否を返す（`slots.ts` と同じ書き込み経路になる）。「コードベースの現状」の該当行と `Settings.tsx:194`（実際は `:185` に「データ」の `h3`）も現物に合わせておく。

## P1
- `Phase 2 > 1` — 降格対象を「新定義に**無い ID**」だけで決めると、ID が残っていて中身が変わったものを取りこぼす。(a) 同じ ID がピン留め ⇄ お気に入りに移った場合（`demoteEverywhere` は `tab.pinnedId ?? tab.favoriteId` の種別を問わない flat 一致なので降格せず、タブは種別違いの定義に紐づいたまま残る。`resolveTabOwnership` は種別ごとに実在を見るので、次の再起動で初めて外れる）、(b) 同じ ID で URL が差し替わった場合（サイドバーの行と開いているページが食い違う）、(c) link が folder になった場合 / いずれも降格 0 件で通り、Phase 6 の「同じ枠を読み込む → 降格 0 件」も PASS するので気づけない / 判定を「同じ ID が**同じ種別（pinned/favorite・link/folder）・同じ URL**で存在するか」に変え、`Phase 2 > 2` のテストにこの 3 ケースを足す。
- `Phase 6 > 3` — 「読み込み後に `pinnedId` / `favoriteId` を持ったままのタブが 1 つも無い」が、2 つ上の「同じ枠を読み込む → 降格が 0 件（定義もタブもそのまま）」と矛盾している / 検証スクリプトに落とすと必ずどちらかが落ちるか、緩めて両方の意味を失う / 「別 Mac 相当 fixture を読み込んだ後、**新定義に無い ID** を持つタブが 0」に限定して書き直す。
- `Phase 6 > 2` — 「verify スイートとして作る場合は」と条件付きのままになっている / `Phase 5 > 5` で VERIFY.md の節をセーブスロットへ差し替えるのに、その節が指すコマンドが決まらない。自走検証がその場かぎりのスクリプトになると次のループで回らず、`--changed` の逆引きにも載らない / `scripts/verify-slots.mjs` を作ると決め、`KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS`（`src/main/store/slots.ts` / `src/shared/slots-schema.js` / `src/shared/slot-apply.js`）への登録までをステップにする。

## P2
- `Phase 4 > 1` — `unreadable` の枠に「···」メニューを出すかが未定。読めない枠こそ「削除」したいが、`renameSlot` は read-modify-write なので実行できない。`unreadable` は「削除」だけ出す、と決めておく。
- `Phase 3 > 1` — 保存時の favicon 取得は `src/main/store/history.ts:87` の `getFavicons(urls: string[]): Map<string, string>` がそのまま使える。名指ししておくと再実装されない。
- `Phase 1 > 1` — 保存直後のスロット名が未定。保存ダイアログに入力欄が無いので、このままだと必ず「名称未設定」で作られて毎回リネームすることになる（端末名 + 日付を初期名にする等）。
- `Phase 1 > 3` — `listSlots()` のタイムアウト値と、`unreadable` に倒れた枠の再試行手段（設定パネルを開き直す以外）が未定。iCloud のダウンロード待ちは数秒で終わることが多いので、カードに「再試行」を置くだけで実用が変わる。
- `Phase 5 > 1` — 「`mise run arc:import --dry-run` 相当が通る」は Arc のデータが無い環境では確かめられない（`~/Library/Application Support/Arc/StorableSidebar.json` を読む）。import が解決することだけを見る形（`node -e "await import('./scripts/arc-import.mjs')"`）か、`arc-import.test.mjs` の fixture 経路で確認する、と書いておく。

## Q
- `前提・わかっていること > 決定表（スロットの中身）` — config-sync 廃止後、`settings.json`（キーバインド）と GitHub PAT を 2 台目へ移す手段が無くなる / 冒頭の目的「新しい Mac を買ったときに設定画面だけで移行が完結する」が満たせず、廃止の範囲を後から狭める判断が実装後に必要になる。
- `前提・わかっていること > 決定表（dev 版）` — dev と stable でスロットのフォルダを分けると、dev ビルドから常用スロットを読む経路が無い。Phase 6 も使い捨てディレクトリなので、実データでの読み込みが常用版に入るまで一度も通らない / undo が無い機能の初回本番実行が常用機になる。dev から stable のスロットを読み取り専用で一覧できるようにするか、人間の動作確認をどう安全に行うかを決める必要がある。
- `Phase 1 > 3` — 2 台で同じ枠に保存したときの iCloud のコンフリクトコピー（`slot-1 2.json` の類）の扱いが未定（拾って見せる / 無視 / `.broken` と同様に退避）/ 片方の保存が UI からは消えたように見えて、フォルダにだけ残る。
````

**対応**: P0 は**却下**。レビュアーは前回の自分の指摘を「JsonStore.commit() は存在しない・store/http-auth.ts も無い・作業ツリーはクリーン」と撤回してきたが、現物を確認したところ json-store.ts は 167 行で :138 に commit(mutate) があり、store/http-auth.ts も存在して :100 で store.commit() を呼んでいる（テストも 17 本）。git status も 10 件以上の未コミット変更を出す。git show でコミット済みの版を読んで作業ツリーを見落としたと思われる。ただし「commit() は HTTP 認証の作業由来でまだコミットされていない」のは事実なので、その旨と「着手時に無ければ先に足す」を注記した。動きやすい行番号（Settings.tsx:194 等）も外した。
P1 は 3 件とも採用: (1) 降格判定を「同じ ID・同じ種別・同じ URL」に変え、種別が移った / URL が変わった / link→folder の 3 ケースをテストに追加。(2) Phase 6 の「pinnedId を持ったままのタブが 0」が「同じ枠なら降格 0 件」と矛盾していたので、「別 Mac 相当を読み込んだ後、新定義に無い ID を持つタブが 0」に限定。(3) verify スイートを条件付きでなく scripts/verify-slots.mjs として作ると決め、登録先も明記。
P2 は 4 件採用（unreadable の枠は「削除」だけ、getFavicons を名指し、初期名を「端末名 YYYY-MM-DD」、arc-import の確認は import が解決することを見る形に）。「unreadable に再試行ボタンを置く」は UI を足す修正なのでループ中は見送り（終了報告へ）。タイムアウト値は実装時に決める細部として書かない。Q 3件は前回と同じ内容で未対応。

## 3回目

````text
`json-store.ts:138` の `commit()` と `store/http-auth.ts:100` の `store.commit()` を作業ツリーの実ファイルで確認。前回の P0 は私の誤りで、撤回する。

## P0

## P1
- `Phase 2 > 3` — `replaceAll` を `JsonStore.commit()` 経路にすると、`pins.ts` のローカル `commit()`（`store.set()` + `listeners`）を通らないので `onPinsChanged` が発火しない。この listener は `registry.ts` で全ウィンドウの `pushShared()` を呼んでおり、ピン留めの再描画はここが唯一の経路 / `demoteEverywhere` は**タブが変わったウィンドウしか `pushState()` しない**ため、`Phase 6 > 3` の「同じ枠を読み込む → 降格 0 件」ではどのウィンドウも再描画されず、差し替わったはずのサイドバーが古いまま残る（しかも検証は「降格 0 件」を見るだけなので PASS する） / `replaceAll` は「`store.commit()` が true を返したときだけ listeners を叩く」と Phase 2 に明記する。
- `Phase 3 > 1` — 保存先のパスと解決種別（`env` / `icloud` / `fallback`）を renderer と検証が受け取る口が無い。`SlotSummary` は枠ごとの情報だけで、ログは方針どおりフルパスを出さない / `Phase 4 > 1` の「パスは `slotsDir()` の実際の解決結果を出す」と `Phase 6 > 1` の「解決先が `env` であることを確かめる」が、どちらも実行手段の無い記述になっている / `nemo:list-slots` の戻りを `{ dir, kind, slots }` にして、UI の保存先表示と検証の事前確認が同じ値を見るようにする。
- `Phase 6 > 3` — 「同じ枠を読み込む → 降格が 0 件」は、`replaceAll` が丸ごと no-op でも成立する（何も起きなければ降格も 0 件） / 「読み込みが本当に走ったか」を一度も確かめないまま、書き込み経路の不具合を通す / 同じ枠のケースにも「読み込み後の `pins.json` の中身がスロットの `favorites` / `pinned` と一致する」を足す（別 Mac 相当のケースと同じ照合をそのまま使える）。

## P2
- `Phase 2 > 3` — 旧定義のスナップショットは `commit(mutate)` の**中**で取る。`commit()` はキューで直列化され、常に直前の commit 済み値から次の値を作るので、外側で `data()` を読んでから渡すと、間に入った別の更新（ピン追加など）を降格判定が取りこぼす。
- `Phase 1 > 1` — 初期名「〈端末名〉 YYYY-MM-DD」の組み立てを `slots-schema.js` に置くと `node:os` が入る。`src/shared/*` は renderer からも import される（`Settings.tsx` → `shared/types.js`、`PromptDialog.tsx` → `shared/http-auth-rules.js`）ので、web ビルド側に持ち込まないほうがよい。`host` は `buildSlot(payload)` の引数で受け、名前の生成は `slots.ts` 側に置く。
- `Phase 1 > 3` — `saveSlot(index, name)` が中身を受け取らない形なので、`store/slots.ts` が `store/pins.ts` と `store/history.ts` を直接引くことになる。`saveSlot(index, payload)` にすると slots.ts はファイル I/O だけに閉じ、`Phase 6 > 4` の fixture 生成にも同じ関数を使える。

## Q
- `前提・わかっていること > 決定表（スロットの中身）` — config-sync 廃止後の `settings.json`（キーバインド）と GitHub PAT の移行手段 / 決めないと「新しい Mac は設定画面だけで移行が完結する」という目的が満たせず、廃止範囲を後から狭める判断が実装後に来る。
- `前提・わかっていること > 決定表（dev 版）` — dev から常用スロットを読む経路を許すか（Phase 6 は使い捨てディレクトリなので、実データでの読み込みは常用版に入るまで一度も通らない）/ undo の無い機能の初回本番実行が常用機になる。
- `Phase 1 > 3` — iCloud のコンフリクトコピー（`slot-1 2.json` の類）を拾う / 無視する / `.broken` と同様に退避する、のどれにするか / 片方の保存が UI からは消えたように見えて、フォルダにだけ残る。
````

**対応**: P0 空で収束（レビュアーが前回の誤りを実ファイルで確認して撤回）。P1 3件・P2 3件をすべて採用。P1: (1) replaceAll は store.commit() が true を返したときだけ listeners を叩く（忘れると onPinsChanged が発火せずサイドバーが古いまま残る）。(2) nemo:list-slots の戻りを { dir, kind, slots } にして、UI の保存先表示と検証の事前確認が同じ値を見るようにした。(3) 「同じ枠を読み込む → 降格 0 件」は no-op でも成立するので、読み込み後の pins.json とスロットの中身の一致も見る。P2: 旧定義のスナップショットは commit(mutate) の中で取る（キュー直列化のため外で読むと取りこぼす）、buildSlot は host を引数で受ける（src/shared は renderer からも import されるので node:os を入れない）、saveSlot(index, payload) にして slots.ts をファイル I/O に閉じる。Q 3件は 1〜3 回目とも同じ内容で未対応（終了報告へ）。
