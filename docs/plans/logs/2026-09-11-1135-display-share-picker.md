
## 1回目

````text
## P0
- Phase 3 > 2 — 実装前にまず確かめる必要がある。`getMediaAccessStatus('screen')` は、一度も聞かれていない状態でも `denied` を返すはずで、`not-determined` は返らない（Chromium 側が `CGPreflightScreenCaptureAccess` の真偽値から「許可/拒否」の二択にしているため）。未実測なので、まず確かめる。 / この前提だと、初回の共有は `getSources` を呼ぶ前に `os_denied` で必ず拒否される。OS の許可ダイアログが一度も出ず、TCC に項目もできないので、システム設定の画面収録の一覧にも Nemo が出てこない。つまり永久に共有できない。自走検証でも、ターミナルに画面収録の許可が無い環境ではここで拒否され、ディスプレイ選択の検査が skip ではなく FAIL になる。 / 実装前に `tccutil reset ScreenCapture com.github.Electron` の後で `open -n` で起動し、状態の値を実測して plan のログに残す。順番は「`decidePermission` → ディスプレイ選択 → `getSources`（初回はここで OS のダイアログが出る）→ その後で `granted` でなければ拒否 + `system-media`(screen) を出す」に並べ替える。
- Phase 5 > 2 — `NEMO_VERIFY_FAKE_DISPLAYS=1` を verify-all のアプリ起動時の env に足すと書かれている。しかし `startApp()` は全スイートで 1 回しか起動しないので、phase1 の「1 枚の節」の時点ですでにディスプレイが 2 枚に見えている。 / 1 枚の節の 3.（`prompt-display-choice` が出ない）は必ず FAIL する。 / 起動 env はやめる。`pressKeyForVerify` と同じ条件（`NEMO_VERIFY_DIAGNOSTICS=1 && !app.isPackaged`）でだけ使える診断 IPC `setFakeDisplaysForVerify(n)` を足し、偽ディスプレイの節の頭で 1、節の終わりで 0 に戻す。verify-all には触らないで済む。
- Phase 4 > 1 — `PromptAnswer` に `display-choice` を足すのに、`src/main/ipc.ts` の `validateAnswer` が手順に入っていない。 / ここは知らない `kind` を受けると `throw new Error('invalid answer')` を投げる。するとダイアログは閉じず、`getDisplayMedia` も返らないまま止まる。 / 手順に `validateAnswer` の `case 'display-choice'` を足す（`displayId` は数値か null だけ通す）。main 側でも、答えの `displayId` が出した一覧に入っているかを確かめ、入っていなければ拒否する。
- Phase 5 > 1 > 2 — `PermissionPrompt` の「今後も同じ扱い」は既定でオン（`useState(true)`）なので、そのまま「許可しない」を押すと `display-capture` の拒否が記憶される。 / 3. でもう一度押しても権限ダイアログは出ず、`NotAllowedError` で終わる。「許可する（記憶あり）」の操作ができず、3. 以降が全部崩れる。 / 2. ではチェックを外してから「許可しない」を押す。3. には「`prompt-permission` がもう一度出る」の検査を先に入れる。

## P1
- Phase 1 > 1 / Phase 1 > 4 — `effectivePermission` を `media-access.ts` か `security.ts` に置くと書かれているが、どちらも `electron` を import している。 / `node --test` の `display-share.test.mjs` からは import できず、テストが動かない。 / `src/shared/display-share.js` に置き、Phase 2 の関数と同じファイルにまとめる。
- Phase 1 > 3 — 一時セット（記憶しない許可のとき、二度目のダイアログを出さない仕組み）を通る検査が Phase 5 に無い。Phase 5 は「記憶あり」の許可しか踏まない。 / 今回まとめて直すはずの「確認が 2 回出る」が戻っても誰も気づかない。 / Phase 5 に「チェックを外して許可 → `prompt-permission` はその 1 回だけ（その後 1 秒ポーリングして 2 回目が出ない）→ ログの `display_capture.request` に進んでいる」の検査を足す。
- Phase 3 > 2 の 6. — 2 枚以上で突き合わせに失敗したときも `sources[0]` に落ちる作りになっている。 / ユーザーが Studio Display を選んだのに、黙って主ディスプレイ（Meet やチャットが出ている画面）が共有される。選んでいない画面が映るので、単なる不具合ではなく漏洩になる。 / `fallback_first` は 1 枚のときだけにする。2 枚以上で見つからなければ拒否してログに `reason: 'no_matching_source'` を出す。偽ディスプレイのときは、診断 IPC 側で「偽の id → `sources[0]`」を明示的に対応させる。
- Phase 5 > 2 — 動機の中心である「10 秒で落ちる」が直ったことを確かめる検査が無い（plan 自身も「どのタイマーかは特定していない」と書いている）。 / Nemo のダイアログで 10 秒以上迷ったら落ちる、というタイマーが要求側に残っていても気づけない。 / 偽ディスプレイの節で `prompt-display-choice` を 11 秒放置してから先頭を選び、`#result` に `Timeout` が出ないことを見る（トラックが取れるかどうかとは関係なく判定できる）。
- Phase 4 > 3 — plan は「既存に揃える（Enter で先頭 / Esc でキャンセル）」と書いているが、既存の `PermissionPrompt` にはキー処理も autoFocus も無い。そのうえ `Overlay.tsx` はダイアログが出ている間 Esc を意図的に無視している（`!prompt`）。 / 手本にするものが無いので、実装がぶれる。さらに Esc を処理しないと、v1.2.13/14 と同じ経路（処理されなかったキーが NSWindow の responder chain に流れる）でメインウィンドウのフルスクリーンが解けるおそれがある。 / `DisplayChoicePrompt` の中で keydown を受け、Esc は `preventDefault` してキャンセルにする（修飾キー付きは素通し）。Enter は、先頭のボタンを autoFocus したときのボタン標準の動きに任せる。そう明記する。
- Phase 4 > 2 — ダイアログの overlay は高さ 220px 固定になっている（`registry.ts` の `overlayBounds` の `case 'prompt'`）。 / タイトルとディスプレイのボタン 2〜3 個とキャンセルを縦に積むと、3 枚のときにはみ出して、ボタンが切れたり押せなくなったりする。 / ディスプレイのボタンは横並びにするか、1 行を低くして 3 枚まで 220px に収まることを確かめる。偽ディスプレイを 3 にしてスクリーンショットで見る検査を 1 件足す。
- Phase 5 > 1 > 5 — ログの `allowed: true` が 1 件、という検査に TCC の条件が付いていない。 / P0 の並べ替えをすると画面収録が `granted` でない環境では拒否で終わるので、この検査は環境しだいで FAIL する。 / 4. と同じ条件（`granted` のときだけ判定し、それ以外は skip に数える）にそろえる。
- Phase 5 > 1 > 1 — `#screen` をどう押すかが決まっていない。既存の `ev` は `Runtime.evaluate` を `userGesture` なしで呼んでいる。 / Chromium は `getDisplayMedia` に直前のユーザー操作を求めることがあり、その場合は `InvalidStateError` でダイアログまで行かず、原因の分かりにくい FAIL になる。 / `Input.dispatchMouseEvent` でボタンの座標をクリックするか、`userGesture: true` で評価する、と書いておく。
- 動作確認 > 1 / Phase 4 > 2 — 画面収録は、許可した後に macOS がアプリの再起動を求める。初回の共有は許可しても失敗する見込みが高い。 / 人間の確認手順の「許可 → 共有が始まる」がその通りにならず、不具合と取り違える。`system-media` の案内文（「ページを読み込み直してください」）も screen には当てはまらない。 / 手順を「許可 → Nemo を再起動 → もう一度共有」にする。`kind === 'screen'` のときの案内文は「Nemo を再起動してください」に変える。

## P2
- 決定表の下の段落 / Phase 4 > 2 — 印の文言が「（Meet を開いている画面）」と「（このタブを開いている画面）」で食い違っている。 / Meet 以外のサイトにも出るし、検証が照合する文字列もぶれる。 / 「（このタブを開いている画面）」にそろえる。
- Phase 3 > 3 — `MediaKind` に `'screen'` を足して `ensureSystemMediaAccess` に分岐を入れる案になっているが、plan の中にそれを `'screen'` で呼ぶ箇所が無い。 / 使われない分岐が増え、`askForMediaAccess(kind)` の型エラーを避けるためだけの分岐になる。 / `MediaKind` はマイクとカメラのまま残し、`system-media` のプロンプトと `SETTINGS_URL` だけ `MediaKind | 'screen'` に広げる。
- Phase 3 > 2 の 4. — `windowsById` は `registry.ts` ですでに export されている。 / 「無ければ getter を足す」は要らない。 / `windowsById.get(windowId)?.baseWindow` を使う、と書いてしまう。
- Phase 5 > 3 — 修正前の FAIL を見るには `security.ts` だけ HEAD に戻せば 1.（文言）が落ちる。 / `PromptDialog.tsx` まで戻すと型がずれるうえ、HEAD の `useSystemPicker` で macOS のネイティブのピッカーがスイートの途中に出て、後続の検査に影響しうる。 / 戻すのは `security.ts` だけにし、確認は 1. の件で止める。

## Q
- 前提 > Electron の流れ — Meet などで以前「今後も同じ扱い」で許可した `media` の記憶は、画面共有から来たものかマイク・カメラから来たものか見分けられないので、残すか消すかが決まっていない。 / 消さなければ、その origin では今後も確認なしでマイク・カメラが通る。そのままだと CHANGELOG の「修正」の書き方が事実とずれる。私のおすすめは「消さずに残し、CHANGELOG に『既存の記憶は設定から消せる』と添える」（Meet はマイクを使うのでどのみち許可する）。

````

**対応**: P0 4 件をすべて反映。(1) `getMediaAccessStatus('screen')` を `getSources` の前に見ない順に並べ替え、着手前に `tccutil reset` → `open -n` で実測するステップを Phase 3 に足した。(2) 偽ディスプレイは起動 env をやめて診断 IPC で節の中から枚数を切り替える形にした（設計は書かず存在と目的だけ）。(3) Phase 4 に `validateAnswer` の `case 'display-choice'` を足し、main 側で `displayId` が出した一覧に無ければ拒否するを Phase 3 の 4. に書いた。(4) Phase 5 の 2. でチェックを外してから「許可しない」、3. に「`prompt-permission` がもう一度出る」を先に入れた。
P1 の書き換えで済むもの: `effectivePermission` を `src/shared/display-share.js` に置く / 2 枚以上で source が無ければ `no_matching_source` で拒否（決定表にも行を足した）/ Esc は `DisplayChoicePrompt` の keydown で `preventDefault`、Enter は autoFocus に任せる、と明記 / ボタンは横並びで 220px に収める / ログの `allowed: true` の検査を TCC 条件つきに / `#screen` は `userGesture: true` か `Input.dispatchMouseEvent` / 許可後に Nemo の再起動が要る（案内文・人間の確認手順・CHANGELOG）。
P1 で見送り（検査の追加。終了報告に回す）: 一時セットの経路（記憶しない許可で 2 回目のダイアログが出ない）の検査 / 10 秒放置して `Timeout` が出ない検査 / 偽ディスプレイ 3 枚のスクリーンショット検査。
P2 はすべて反映: 印の文言を「（このタブを開いている画面）」に統一 / `MediaKind` は残して `system-media` と `SETTINGS_URL` だけ広げる / `windowsById` を直接使う / 修正前の FAIL 確認は `security.ts` だけ戻す。
Q: 既存の `media` の記憶は消さずに残す、で決定（根拠: `permissions.json` に消す UI は無く、Meet はどのみちマイクを許可する）。決定表の下と CHANGELOG の記述に反映。

## 2回目

````text
## P0
- Phase 5 > 1 の 3. / Phase 5 > 2 の 1.・4. — 画面収録が `granted` でない検証環境では、1 枚の節の 3. で許可した直後に Phase 3 > 3 の 6. が走り、`promptSystemMediaSettings` で `prompt-system-media` を出す。plan にはこれを閉じる手順が無い。 / ダイアログはウィンドウごとのキューで先頭しか見えない。そのため、偽ディスプレイの節の 1. が待つ `[data-testid]` は `prompt-system-media` を拾い、`prompt-display-choice` はその後ろに並んだまま出てこない。4. の「`allowed: true`」も、この環境では `os_denied` になる。plan は `granted` でない環境を「skip で通す」前提なのに、実際には FAIL の連鎖になる。 / `granted` でない分岐を skip ではなく実際の検査にする。3. の後で「`prompt-system-media` が出る（screen 用の文言）→『閉じる』を押す」を判定する。偽ディスプレイの節の 4. も同じ条件で分け、`granted` でなければ「`reason: 'os_denied'` のログが出る + 案内を閉じる」を見る。

## P1
- Phase 6 > 1 — VERIFY.md に書く内容が「`NEMO_VERIFY_FAKE_DISPLAYS` で 2 枚を模す」のまま残っている。 / 起動 env はやめて診断 IPC に変えたので、存在しない方法をドキュメントに書くことになる。 / 「診断 IPC（`NEMO_VERIFY_DIAGNOSTICS=1` かつ未パッケージのときだけ使える）で節の中から枚数を切り替える」に書き換え、実装で決めた IPC 名を入れる。
- Phase 3 > 2 — 実測の手順が `open -n` だけで、どのプロファイルで起動するかと、値をどこで読むかが書かれていない。VERIFY.md の例は `NEMO_USER_DATA_DIR` を渡していない。 / そのままだと dev チャンネルの既定プロファイルで起動し、動いている dev Nemo とプロファイルがぶつかる（常用インスタンスには触らない方針にも反する）。`getMediaAccessStatus('screen')` の値を読む口も無いので、実測が 1 回で終わらない。 / `open -n --env NEMO_USER_DATA_DIR="$(mktemp -d)" --env NEMO_REMOTE_DEBUGGING_PORT=…` と書き、値は CDP で読むか、起動時に一時ログを出すかを明記する。「OS のダイアログが出ている間に `getSources` が返るのか、答えるまで待つのか」も測る項目に入れる（次の項目の文言がこれで決まる）。
- Phase 3 > 3 の 6. / Phase 4 > 3 — 初回は OS の画面収録ダイアログが出た状態のまま、6. が `granted` でないと判定して `system-media` の案内も出す見込みが高い。その見出しは「macOS の設定で Nemo の画面収録の使用が**拒否されています**」のまま（plan が変えるのは説明文だけ）。 / まだ拒否していない初回に、OS の「許可しますか」と Nemo の「拒否されています」が同時に並び、どちらに従えばいいか分からなくなる。 / `kind === 'screen'` のときは見出しも変え、「Nemo に画面収録の許可が必要です。許可したら Nemo を再起動してください」のように、初回と拒否済みのどちらでも正しい文にする。

## P2
- Phase 5 > 4 — 括弧の中の理由が合っていない。`useSystemPicker` は `security.ts` にあるので、`security.ts` を HEAD に戻したらピッカーも戻ってくる（`PromptDialog.tsx` は関係ない）。 / 「`security.ts` だけ戻せばピッカーは出ない」と読めてしまい、3. まで流すと macOS のピッカーが出て 10 秒止まる。 / 理由を「型がずれるから」だけにし、「1. の判定を見たら 2. に進まずに止める」と書く。
- Phase 4 > 4 — `DisplayChoicePrompt` の Esc（`preventDefault` してキャンセル）を確かめる検査が無い。 / フルスクリーンが解けるのを防ぐ要の部分なのに、壊れても気づけない。 / Esc はブラウザ側の前処理を通らない renderer の keydown で受けるので、overlay に CDP でキーを送れば届く。偽ディスプレイの節に「Esc → `reason: 'cancelled'`」を 1 件足す。

## Q

````

**対応**: P0 を反映: Phase 5 の 1 枚の節の 4.・5. を「`granted` なら OK / それ以外は `prompt-system-media`（screen 用の見出し）が出る → 閉じる → 残っていない、ログは `os_denied`」の実検査に変え、偽ディスプレイの節の 1.・4. も同じ分岐にした（skip をやめた）。
P1 はすべて反映（書き換え）: VERIFY.md の記述を診断 IPC に直した / 実測手順に `NEMO_USER_DATA_DIR="$(mktemp -d)"` と `NEMO_REMOTE_DEBUGGING_PORT`、値の読み方、「ダイアログ中に `getSources` が返るか待つか」の測定項目を足した / `kind === 'screen'` の `system-media` は見出しも「Nemo に画面収録の許可が必要です」に変える。
P2: 修正前 FAIL 確認の括弧の理由を直し「1. の判定を見たら 2. に進まずに止める」を明記（反映）。Esc → `cancelled` の検査は検査の追加なので見送り、終了報告に回す。

## 3回目

````text
## P0

## P1
- Phase 3 > 2 — 「着手前に実測」と書かれているが、HEAD のままでは `getSources` がどこからも呼ばれない。`useSystemPicker: true` が付いているので、ハンドラ本体まで処理が届かない。値を読むのに使う診断 IPC も、Phase 5 > 1 の 4. でやっと足すものなので、この時点ではまだ無い。さらに起動コマンドに `--env NEMO_VERIFY_DIAGNOSTICS=1` が入っていないので、口を足したとしても生えない。 / 3 つの測定項目のうち「`getSources` で OS のダイアログが出るか」と「ダイアログ中に返るか待つか」の 2 つは、書かれた手順では測れない。実装者はその場で段取りを考え直すことになる。 / 実測は Phase 3 > 1（`useSystemPicker` を外す）だけを入れた後に回す。手順は `pnpm exec electron-vite build` → `node scripts/test-server.mjs &` → `open -n` に `--env NEMO_VERIFY_DIAGNOSTICS=1` を足して起動 → `media.html` の「画面共有」を押す。HEAD のハンドラは `decidePermission` の後に `getSources` を呼ぶので、これで測れる。値は、`getSources` の前後で状態と経過時間を出す一時ログで読む、と書き換える。

## P2
- Phase 5 > 1 の 3. — 1 秒ポーリングで何を見るかが書かれていない。画面収録が `granted` でない環境では、このポーリングの最中に `prompt-system-media` が出てくる。 / 「`[data-testid]` が何も出ない」で書くと、ここで FAIL する。 / `prompt-display-choice` を名指しで「出ない」と判定する、と明記する。
- Phase 5 > 2 — 偽ディスプレイの節の後始末が「枚数を 0 に戻す」だけになっている。 / `granted` の環境では 4. で取った画面収録のトラックが止まらないまま、同じアプリで後続の節や他スイートが走る（メニューバーの収録インジケータが点いたままになり、CPU も食う）。 / 節の終わりで `#stop` を押すか `media.html` のタブを閉じる。

## Q

````

**対応**: P0 なし（収束）。P1 反映: 実測を「`useSystemPicker` を外すステップだけ入れた後」に回す手順に書き換え、`--env NEMO_VERIFY_DIAGNOSTICS=1`・ビルド・テストサーバー起動・`media.html` の操作・一時ログで読む、を明記。P2 反映: 3. のポーリングは `prompt-display-choice` を名指しで判定する / 偽ディスプレイの節の終わりで `#stop` を押す（またはタブを閉じる）。
