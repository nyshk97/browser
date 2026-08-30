review session: f2c59ef6-dc2e-4246-9581-9d57a045063c

## 1回目

````text
plan と実コードを突き合わせました（`verify-ext-smoke.mjs` / `test-extension/popup.js` / `verify-targets.mjs` / ece の `chrome-extension-api.preload.js`）。

## P0
- **前提・わかっていること > 実測（表の1〜2行目）／概要** — 「`onChanged` が**一切**発火しない」は実測とずれている。表の行はすべて**受け側が SW**。一方 `test-extension/popup.js` の `storageChanged`（6651b41, 2026-08-23）は「SW の `local.set` → **popup** の `chrome.storage.onChanged`」を検査していて、これは `ci.yml:47` の必須チェックで回っている。/ frame 側のネイティブが生きているなら、frame にも polyfill を配ると**ネイティブ + polyfill で二重発火**する（Bitwarden の `updates$` は 1 キーのイベントを 2 回受ける）。前提が間違ったまま Phase 3 を書くと配信範囲の設計をやり直すことになる。/ Phase 1 の最初に「frame 受信 / SW 受信」「local / session」を**別々に**測って表を書き直す。壊れているのが SW 受信だけなら、`installStorageOnChangedPolyfill()` は「配信するかを area × コンテキストごとに起動時の自己テストで決める」形にする（後述のガードもここに畳む）。
- **設計の決定 > 将来 Electron が直ったときのガード** — 「ネイティブにも登録しつつ配るのは自前」＋「ネイティブが 1 回発火したら止める」だと、ネイティブが生きている経路で**必ず 1 発目が二重になる**（拡張のリスナーがネイティブに登録されているので、ガードが立つ前に両方から呼ばれる）。/ 二重発火は Bitwarden の状態機械には無害でも、他拡張のカウンタ系ロジックを壊す。/ 拡張のリスナーはネイティブに登録せず、polyfill 自身の**検出用リスナー 1 本だけ**をネイティブに登録し、それが鳴った area は自前配信を止める（かつ検出は起動直後に自分で 1 回書いて確かめる）。
- **設計の決定 > 配送の形** — `chrome.runtime.sendMessage` の失敗処理が書かれていない。受け手が 1 つも無いとき Chrome は `lastError`（Promise 版は reject）で返す。SW が書く時点で拡張ページが 1 つも開いていない状態は**常態**。/ ラップした `set` の中で await / 未処理のまま置くと、拡張自身の `set` の Promise が reject するか unhandled rejection がログを埋める（Bitwarden の書き込みが失敗扱いになる）。/ 配送は callback 形式で投げて `void chrome.runtime.lastError` を必ず読む、Promise 版なら `.catch(() => {})`、かつ**元の `set` の完了を配送で待たせない**ことを明記する。
- **Phase 1 > 3 / Phase 3 > 5・7 / Phase 0 > 3** — `mise run verify:only ext-smoke` と `verify:only packaged` は動かない。`KNOWN_TARGETS`（`scripts/lib/verify-targets.mjs:26-46`）に `ext-smoke` / `packaged` は無く、`--only` は未知名を**エラーにする**。`OWNERS` の値も KNOWN_TARGETS 前提（`verify-targets.test.mjs` が固定）なので `['ext-smoke']` は載せられない。/ 手順どおりに叩くと即失敗し、OWNERS の追加はテストを落とす。/ コマンドは `mise run verify:ext`（idle 込みなら `verify:ext-idle`）と `mise run verify:packaged` に直す。`OWNERS` への追加は**不要**（ext-smoke は `mise run verify` の外。未登録＝フル扱いで安全側。`extension-shim.ts` / `extensions.ts` が載っていないのも同じ理由）。Phase 3 > 6 の「既存エントリを広げる」も削る。

## P1
- **設計の決定 > 配送の形（キーごとに 1 イベント）／Phase 1 > 2 の 2 番目** — Chrome は `set({a,b})` で **1 イベント（changes に 2 キー）**を配る。キーごとに割るのは Bitwarden の `filter(([c]) => Object.keys(c).length === 1)` に合わせた仕様逸脱で、「Bitwarden 専用にしない」という方針と矛盾する。/ 逸脱を smoke に焼くと後から直すとき polyfill と検査の両方をやり直す。Bitwarden は元々 1 キーずつ書くので、仕様どおり束ねても解除は伝わる。/ `set` 1 回につき 1 イベント（`changes` に全キー）に直し、Phase 1 の検査文言も「1 イベントに 2 キー」にする。
- **Phase 3 > 2（同値の書き込みは通知しない）／Phase 3 > 3 のテスト項目** — Chrome は同じ値を書いても `onChanged` を発火する。/ Bitwarden の `updates$` は「保存された」の合図として使うので、同値の再保存を握り潰すと SW の状態更新が落ちる。/ 同値でも通知する。あわせて、旧値取得のための `get` は `remove` / `clear` のときだけにできる（`oldValue` の厳密さは要らないと自分で書いている）。毎回の `set` の前に `get` を挟むと Bitwarden の書き込み頻度では素の `set` の 2 倍の往復になり、`clear()` は `get(null)` で全件読みになる。
- **前提・わかっていること > Nemo / ece 側** — ece の preload は `chrome.storage` と `chrome.runtime` を `{...base, …}` で**別オブジェクトに差し替える**うえ、`sync` と `managed` は `local` と**同一オブジェクト**（`chrome-extension-api.preload.js` の `apiDefinitions.storage`）。/ area 名をキーに二重ラップ防止すると local / sync / managed を 3 回ラップして 1 回の書き込みで 3 イベント出る。また差し替え前に `chrome.storage.onChanged` を別オブジェクトへ置き換えるとスプレッドの取り回し次第で参照がずれる。/ 二重ラップの印は **area 名でなくオブジェクト自身**に付け（`__nemoStorageWrapped`）、area 名は最初にラップしたときの名前で固定する。この ece の挙動を「前提」節に 1 行足す。
- **Phase 3 > 3（差分計算の純粋関数を切り出してテスト）** — `src/shared/chrome-debugger-stub.js` の制約どおり、`installStorageOnChangedPolyfill()` は**文字列化して送るので外の関数を参照できない**。切り出した純粋関数を import して呼ぶ実装は成立しない。/ 実装とテスト対象が別物になり、テストが嘘になる。/ 差分計算は関数内に置いたまま、`CHROME_STORAGE_ONCHANGED_SOURCE` のように文字列を export して node --test 側で評価して叩くか、`installX()` が内部関数を返す形にして「返り値経由でテストする」と決める。
- **Phase 1 > 1** — SW 側の記録を `chrome.storage.local` に書いて読む設計は、**その書き込み自体が polyfill の配信を誘発する**（自家中毒でイベント数が合わなくなる）。/ 検査が不安定になり、FAIL→PASS の比較が読めなくなる。/ smoke は既に SW を直接評価できる（`verify-ext-smoke.mjs` の `sw.ev(...)`）ので、SW のグローバル配列に貯めて `sw.ev` で JSON を読む。
- **Phase 3 > 2 の 4 番目（onMessage の先頭で拾って拡張には流さない）** — 見出しが「拡張のハンドラには流さない」なのに、括弧の中で「全リスナーに配られるので流れてしまう」と自分で否定していて、実装者がどちらを作るか分からない。content script にも配られる点も書かれていない。/ 文言を「流れる前提。`{ __nemo: 'storage-changed', … }` は `type` / `command` を持たない素のオブジェクトにする」に統一し、test-extension 側に「未知メッセージを受けても既存の検査が壊れない」ケースを 1 本足す。

## P2
- **Phase 4 > 2** — 既定値を frame shim（popup を開いたとき）で書くと、popup を一度も開かないユーザーには効かない。SW shim の起動時に「無ければ書く」ほうが `runtime.onInstalled` の代替として素直。
- **Phase 3 > 5 / 設計の決定 > ガード** — `verify:ext` の「onChanged が届く」検査はネイティブでも polyfill でも通るので、polyfill が丸ごと外れた回帰を拾えない。SW 受信のように**今ネイティブで落ちている経路**を 1 本、別の check 名で持つと腐りにくい。
- **スコープ外** — content script は受信だけでなく**書き込み側も**補えない（preload が届かない）。「他の拡張にもそのまま効く」の但し書きとして 1 行足すと、後で lock に拡張を足す人が誤解しない。

## Q
- **スコープ外 > content script** — 「preload の届かないコンテキストからの書き込みは onChanged を出さない」という穴を仕様として受け入れるか、将来 content script 側も CDP 注入で埋める前提にするか。/ 決めないと Phase 3 の関数の置き場所（shared のまま / CDP 注入用の source export を最初から持つか）と `verify:ext` の検査範囲が後で作り直しになる。
- **Phase 4（任意）** — 今回やるか、Bitwarden の内部キー（`global_autofillSettingsLocal_inlineMenuVisibility`）を lock に持って `ext:update` ごとに存在確認する運用コストを背負うか。/ 未決のまま Phase 3 を終えると「解除は即伝わるがインラインメニューは Off のまま」で人間の動作確認 3 点目が落ちる（設定画面で ON にすれば回避できる、という扱いでよいかの判断）。

````

**対応**: P0 4 件すべて反映。(1) 前提を「SW 受信だけ落ちる／frame 受信はネイティブで動く」に書き直し、Phase 1 の先頭に送り手×area×受け手の表を埋めるステップを置いた。(2) ガードを「拡張リスナーはネイティブに登録しない。検出用 1 本だけ登録し、起動直後の自己テストで area×コンテキストごとに配信要否を決める」に変更。(3) sendMessage の失敗処理（lastError を読む・元の set を待たせない）を設計に追加。(4) `verify:only ext-smoke` / `verify:only packaged` を `verify:ext` / `verify:packaged` に直し、OWNERS への追加・既存エントリ拡張の記述を削除。P1: 「キーごと 1 イベント」を仕様どおり「set 1 回 = 1 イベント（全キー）」に変更し検査文言も修正／同値でも通知・get は remove/clear のときだけに変更／ece の storage オブジェクト差し替えと sync=managed=local 同一の前提を追記し、ラップ印はオブジェクト自身に／テストは「内部関数を返り値経由で叩く」に変更／SW 側の記録を storage でなくグローバル配列に／受け側の文言を「拡張にも content script にも届く前提」に統一し smoke に未知メッセージ耐性ケースを追加。P2: Phase 4 の既定値書き込みを SW shim 起動時に変更／SW 受信の check に区別できる名前を付ける旨を追記／content script は送信側も補えない但し書きを追記。Q: content script の穴は「仕様として受け入れる」で決定（Bitwarden は content script で storage を使わない。関数は CDP 注入できる形で置く）／Phase 4 は「範囲内・最後・任意」で決定し、人間の動作確認 3 点目を「設定 ON 済みの前提」に書き換えた。

## 2回目

````text
plan を読み直し、コード側（`verify-packaged.mjs` の `checkExtensionShim`、`verify-ext-smoke.mjs` の `appEnv()`、`extensions.ts` の `registerExtensionShim`）と突き合わせました。前回の 4 件は反映を確認。新たに 2 件の P0 が出ています。

## P0
- **設計の決定 > 配信するかの判定と将来のガード** — 「拡張のリスナーはネイティブに登録しない」と「ネイティブが鳴った area × コンテキストでは**自前配信を止める**」が両立しない。ネイティブが生きている frame では、拡張のリスナーはどこにも登録されていないのに polyfill が配信を止めるので、**誰も配らなくなる**（既存 CI の `storageChanged` が FAIL する）。加えて probe は「自分で書いて自分で受ける」経路しか測れず、SW→popup のような**送り手が別コンテキストの経路の生死は判定できない**（実測表でもこの 2 つは別の行）。/ 判定軸が足りないまま実装すると、frame の onChanged を殺すか二重配信するかのどちらかになり、polyfill の中枢を作り直すことになる。/ 「オン／オフの判定」をやめ、**polyfill が唯一のディスパッチャ**にする: 検出用リスナーで受けたネイティブイベントも**そのまま自前リスナーへ転送**し、ブロードキャスト由来のイベントと**内容 + 短い時間窓で重複排除**する。こうすると送り手 × 受け手の生死表に実装が依存せず、probe も起動直後の判定待ちも不要になる（Phase 1 の表は「どこが落ちているか」の記録として残す）。
- **設計の決定 > 配送の形** — `sendMessage` の payload に `changes`（= `newValue` の実体）を載せている。plan 自身が「拡張のハンドラにも **content script にも届く前提**」と書いており、Bitwarden が `chrome.storage.session` に置く**ユーザー鍵がページ上の content script まで流れる**。Chrome の `runtime.sendMessage` は content script には配らず、`storage.session` は既定で content script から読めない（access level）。つまりこの設計は **session の隔離を polyfill が壊す**。/ 解除用の鍵が想定外のコンテキストに出る。実装後に気づくと配送フォーマットと受け側を作り直しになる。/ 配送は**値を載せず** `{ __nemo: 'storage-changed', area, keys: [...], type: 'save' | 'remove' }` だけにし、**受け側が自分で `get` し直して** `changes` を組み立てる（読めないコンテキストでは `get` が空になり、Chrome と同じ見え方に落ちる）。ついでに `runtime.sendMessage` が content script に届くかどうかの実測を Phase 1 の表に 1 行足す（plan の「届く前提」が Chrome 仕様と食い違っている）。

## P1
- **Phase 3 > 4 / Phase 3 > 5** — `registerExtensionShim` は今 `log('extension.shim_registered', { exists })` を **1 本しか出さない**。`verify-packaged.mjs` の `checkExtensionShim` は `events.every((l) => l.exists === true)` なので、SW shim の同梱漏れがあっても frame 側の 1 本だけで PASS する。/ Phase 3 > 5 の「`verify:packaged` で SW shim の同梱を見る」が無検査になる（腐っても速く PASS する側に倒れる）。/ 登録ごとに `id`（`nemo-extension-shim` / `nemo-extension-sw-shim`）付きで 2 本ログを出す、と Phase 3 > 4 に書く。
- **Phase 2 > 2** — 確認するのが `chrome.storage` に触れるかだけになっている。配送の要は `chrome.runtime.onMessage` / `sendMessage` のほうで、SW preload の時点でこれらが存在し、ece の差し替えより先にリスナーを登録できるかは別問題。/ storage だけ触れても配送が成立せず、Phase 3 の途中で経路の作り直しになる。/ スパイクの確認項目に「`chrome.runtime.onMessage.addListener` が SW preload の時点で呼べ、ece 差し替え後も生きている」「`sendMessage` が SW から出せる」を足す。
- **Phase 4 > 2** — SW shim（静的な preload ファイル）から `extensions.lock.json` の `storageDefaults` をどう読むかの経路が無い。preload は文字列化して送る関数で、外の変数も lock も参照できない。/ Phase 4 に入った時点で「渡し方が無い」で止まる。/ main 側から `contextBridge.executeInMainWorld({ func, args })` の `args` で渡す（frame）／SW 側は同じ手が使えるかを Phase 2 のスパイクで一緒に見る、と書いておく。
- **設計の決定 > 配信するかの判定と将来のガード（probe を残す場合）** — `__nemo_probe__` の書き込み自体がラップされた `set` を通るので、他コンテキストへブロードキャストされ、拡張のリスナーに未知キーの変更が `set` / `remove` の 2 回届く（Bitwarden の `UL` は 1 キー変更を state 更新に流す）。判定が決まるまでに来た書き込みの扱いも未定義で、SW 起動直後（Bitwarden が最も書く時間帯）に取りこぼす。/ 上の P0 の dedupe 設計にすれば probe ごと消えるが、残すなら「probe は配送・自前配信の対象外」「判定確定までのイベントはキューに積んで確定後に流す」を明記する。

## P2
- **前提・わかっていること > Nemo / ece 側（SW preload の項）** — 「Phase 1 の最初で確かめる」とあるが、実装計画では Phase 2 のスパイク。文言を Phase 2 に揃える。
- **Phase 1 > 3 の最終項目** — 「実 Bitwarden をロードする既存の経路があれば相乗り」とあるが、`verify-ext-smoke.mjs` / `verify-ext-update.mjs` / `ci.yml` のどこにも実 artifact をロードする経路は無い（自作テスト拡張のみ）。項目を落として「動作確認 [人間👨‍💻]」に寄せるか、手元専用の手順として書く。
- **Phase 0 > 3** — `verify-ext-smoke.mjs` の `appEnv()` に `NEMO_EXT_CONSOLE: '1'` を足すだけで足りるが、**test-extension の SW が `console.error` を出さない**ので検査の対象が無い。SW 側に意図的に 1 回 error を吐く仕掛け（メッセージで起こす等）を足す旨を書く。
- **設計の決定 > 配送の形** — `set` 前の `get` をやめた結果、配る `changes` に `oldValue` が付かない（Chrome は付ける）。「仕様どおりに補完」と書いている以上、既知の仕様差分として 1 行明記しておく（Bitwarden は使わない、で足りる）。
- **Phase 4 > 3** — 書き込み主体を SW shim 起動時に変えたのに、smoke の文言が「popup を開いた後に SW から読める」のまま。「SW を起こした後に読める」に直す。
- **前提・わかっていること > 実測（4 行目）** — content script 発の行が「Phase 1 で表を埋める」に入っているが、content script は「仕様として受け入れる」と決定済みなので測る必要が無い。行の扱いを「測らない（スコープ外）」にする。

## Q
- **設計の決定 > 配送の形** — 上の P0 の直し（値を載せず受け側で `get` し直す）を採ると、**連続書き込みの中間値が落ちて最後の値だけが配られる**。Bitwarden の用途では問題ないが、変更履歴を積む種類の拡張では挙動が変わる。この差分を飲んで「値は載せない」で行くか、`local` だけ値を載せて `session` は載せない、のどちらを取るか。/ 決めないと配送フォーマット（`changes` を載せるか `keys` だけか）が固まらず、Phase 1 の検査文言も書けない。

````

**対応**: P0 2 件反映。(1) 「オン／オフ判定＋probe」をやめ、「polyfill が唯一のディスパッチャ。ネイティブは転送用 1 本だけ登録して自前リスナーへ転送し、ブロードキャスト由来と内容＋時間窓で重複排除」に設計を書き換え、Phase 3 の該当ステップも差し替え。(2) 配送 payload から値を外し `{area, keys, type}` に。受け側が `get` し直す。Phase 1 に「sendMessage が content script に届くか」の実測行を追加。P1: shim_registered を id 付きで 2 本出す旨を Phase 3 に追加／Phase 2 スパイクの確認項目に runtime.onMessage/sendMessage と main→SW の値渡しを追加／Phase 4 に main から既定値を渡すステップを追加／probe は設計ごと消えたので該当なし。P2: 「Phase 1 の最初で」を Phase 2 に修正／実 Bitwarden の項目を手元専用（probe13 再利用）に変更／Phase 0 に SW が error を吐く仕掛けを追記／oldValue 非対応を既知の仕様差分として明記／Phase 4 smoke 文言を「SW を起こした後」に修正／content script 発の行を「測らない」に修正。Q: 「値は載せない（keys だけ）」で決定。根拠: Bitwarden は key と save/remove しか使わない・session の隔離を壊さない方が優先。連続書き込みの中間値が落ちる差分は設計に明記。

## 3回目

````text
plan を読み直しました。前回の P0 2 件・P1 3 件・P2 6 件の反映を確認。新しい設計（唯一のディスパッチャ + 重複排除）に 1 件の P0 が残っています。

## P0
- **設計の決定 > polyfill が唯一のディスパッチャ** — 重複排除の鍵が「内容（area + keys + type）+ 短い時間窓」なので、同じ**設計の決定 > 配送の形**の「同じ値を書いても通知する」と両立しない。拡張が同じキーへ窓内に 2 回書くと、2 発目のブロードキャスト（または native）が「1 発目と同一内容」として捨てられ、**Chrome なら 2 回鳴るところが 1 回になる**。Bitwarden は `updates$` を「保存された」の合図に使うので、連続保存の 2 発目が消えると状態更新が落ちる — まさに今回直そうとしている症状と同じ形の取りこぼしが残る。/ 重複排除は polyfill の中枢で、後から方式を変えると受け側・配送・Phase 1 の検査を丸ごと書き直すことになる。/ 内容の一致で「捨てる」のをやめ、**件数を突き合わせる台帳**にする: native / ブロードキャストのどちらでも**先に来たほうを即座に配り**、`{area, keys, type, 時刻}` を台帳に 1 件積む。後から来た同一内容のものは台帳の**未消化 1 件だけを消して捨てる**（窓を過ぎた項目は捨てる）。これなら同値の N 連続書き込みは native N 件・ブロードキャスト N 件が N 回の配信になり、かつ native が鳴かない SW 受信でも**窓ぶんの遅延が乗らない**（「窓が満了してから配る」形にしないこと）。

## P1
- **設計の決定 > 配送の形 / Phase 3 > 2** — 値を載せない形に直した際に、前版にあった「旧値のための `get` は `remove` / `clear` のときだけ」が本文から落ちた。結果、**`clear()` でどのキーが変わったかを知る手段が無い**（`keys` を作れない）。/ unit test の項目に `clear` があるのに実装の根拠が本文に無く、実装時に「clear は空イベント」で通してしまう。/ 「`clear()` は実行前に `get(null)` でキー一覧を取り、`type: 'remove'` + そのキー一覧で配る。`remove(keys)` は引数のキーをそのまま使う（存在しなかったキーが混じるのは許容）」と配送の形に書き足す。
- **設計の決定 > polyfill が唯一のディスパッチャ** — 「ネイティブには転送用リスナー 1 本だけ」の**登録先**が書かれていない。Chrome / Electron とも 1 回の変更で `chrome.storage.onChanged` と `chrome.storage.<area>.onChanged` の**両方**が鳴るので、両方に転送用を付けると 1 変更で native 2 件になり、台帳の件数が狂って二重配信する。/ 実装が確実に踏む（`sync` / `managed` が `local` と同一オブジェクトなのと同じ種類の罠）。/ 「転送用に登録するのは `chrome.storage.onChanged` の **1 本だけ**（area は引数で来る）。area 別の `onChanged` にはネイティブ登録しない」と明記する。
- **設計の決定 > 配送の形** — 受け側が `get` し直す形にしたので、`type: 'save'` なのに `get` が `undefined` を返す（配送中に消された）ケースの扱いが未定義。/ 実装者ごとに「`type` を信じて空の `newValue` を作る」「`get` を信じて remove 扱いにする」が分かれ、Phase 1 の `"newValue" in change === false` の検査が経路によってブレる。/ 「`changes` は必ず `get` の結果から作る（`type` は `get` を省ける場合のヒントとしてのみ使う）」に倒すと 1 本に決まる。

## P2
- **Phase 3 > 1** — 括弧内が「配送・失敗処理・受け側・リスナー保持・**判定とガード**をそのまま実装する」のままで、設計から消えた「判定」の語が残っている。「唯一のディスパッチャと重複排除」に置き換える。
- **Phase 1 > 5** — 「表に `runtime.sendMessage` が content script に届くかの行を足す」が、実測表（4 行目）に既に同じ行がある。ステップ側を消すか「その行を埋める」に直す。
- **設計の決定 > polyfill が唯一のディスパッチャ** — 台帳の突き合わせは「イベント 1 件」単位で、`chrome.storage.onChanged` と area 別の両方へ配ることを 2 件と数えない、という当たり前の但し書きを 1 行入れておくと実装のブレが減る。

## Q

````

**対応**: P0 反映: 重複排除を「内容一致で捨てる」から「件数を突き合わせる台帳（先着を即配信、後着は未消化 1 件だけ消して捨てる、窓超過は破棄）」に書き換え。P1 3 件反映: `remove` は引数キー・`clear` は事前 `get(null)` のキー一覧で配る／転送用リスナーは `chrome.storage.onChanged` の 1 本だけ／受け側の `changes` は必ず `get` の結果から作る。P2 3 件反映: Phase 3>1 の「判定とガード」を置換／Phase 1>5 を「行を埋める」に修正／台帳の単位の但し書きを追記。

## 4回目

````text
plan を読み直しました。前回の P0 1 件・P1 3 件・P2 3 件はすべて反映済みで、台帳方式の記述も筋が通っています。残りは台帳の適用範囲 1 件です。

## P0
- **設計の決定 > 配送の形（(1) 自コンテキストの polyfill リスナーへ）／設計の決定 > polyfill が唯一のディスパッチャ** — 台帳を通るのが「native / ブロードキャストのどちらか」の 2 経路としか書かれておらず、**書き込み側が自コンテキストへ直接配る (1) が台帳の外**にいる。native が鳴くコンテキスト（frame。`popup → popup` は未測定だが Chrome では鳴る）では、1 回の `set` で「(1) の自己配信」と「転送用リスナーが受けた native イベント」の**2 回**が同じリスナーに届く。/ 二重発火はこの plan が潰しに来ている症状そのもので、Phase 1 の検査も「SW 自身の書き込みが SW 自身のリスナーにも届く」と件数を見ていないため**検査でも拾えない**。実機で popup 側の挙動がおかしくなってから台帳の設計に戻ることになる。/ 「**自己配信・native 転送・ブロードキャストの 3 経路すべてが台帳を通る**（先着を即配信し、後着は未消化 1 件を消して捨てる）」と書き換える。あわせて Phase 1 の「SW 自身の書き込みが SW 自身のリスナーにも届く」を**ちょうど 1 回**に、frame 側でも自己書き込みがちょうど 1 回であることを見る検査を足す。

## P1
- **Phase 3 > 2 / Phase 1 > 3** — 台帳（重複排除）そのものの検査が無い。unit test の項目は差分計算だけ（複数キー・remove・clear・undefined・同値）、smoke で件数を見ているのは `remove` の 1 本のみ。/ 台帳は今回いちばん壊れやすい部分で、しかも「同値でも通知する」と両立させるために件数方式を選んだのに、その両立が 1 つも検査されていない。壊れても静かに 1 回多い／少ないになるだけで気づけない。/ unit に「先着 native → 後着ブロードキャストで 1 回」「先着ブロードキャスト → 後着 native で 1 回」「窓を過ぎた後着は独立イベントとして配る」を、smoke に「**同じ値を 2 回続けて書くと受け側で 2 回鳴る**」を足す（`installStorageOnChangedPolyfill()` が内部関数を返す形なので台帳も返り値経由で叩ける）。

## P2
- **設計の決定 > polyfill が唯一のディスパッチャ** — 台帳の「窓」の長さと、未消化項目の掃除のタイミング（追加時に掃除／タイマー）が未定。既定値と根拠（IPC 往復の実測値の何倍か）を 1 行書いておくと、実装時に勘で決めずに済む。
- **Phase 1 > 3 の 5 番目** — 「test-extension の `onMessage` ハンドラが `{ __nemo: 'storage-changed', … }` を受けても既存の検査が壊れない」は、polyfill が入るまで配送メッセージ自体が飛ばないので Phase 1 では素通りする。Phase 1 では手で 1 回 `sendMessage` して確かめる、と補うか Phase 3 側へ移す。

## Q

````

**対応**: P0 反映: 自己配信・native 転送・ブロードキャストの 3 経路すべてが台帳を通ると明記し、Phase 1 の検査を「SW / popup とも自己書き込みがちょうど 1 回」に変更。P1 反映: unit test に台帳の 4 ケース、smoke に「同値 2 回で 2 回鳴る」を追加（検査文言のみ。設計は足していない）。P2 反映: 窓・掃除は実装時に決めると明記／Phase 1 の未知メッセージ検査を「手で 1 回 sendMessage して確かめる」に補足。

## 5回目

````text
## P0
- **設計の決定 > 配送の形（`remove(keys)` は引数のキーをそのまま `keys` にする）** — 台帳の照合キーが `{area, keys, type}` なのに、`remove` だけ**経路によってキー集合が変わる**。`remove(['a', 'missing'])` を native が鳴くコンテキストでやると、自己配信は `keys: ['a','missing']`、native の `changes` は実在した `a` だけなので `keys: ['a']` になり、**照合が外れて同じ変更が 2 回配られる**（Chrome も存在しないキーの remove では鳴らない）。/ 前回潰した「自己配信が台帳の外」と同じ二重発火が、`remove` の経路だけ残る。Phase 1 の検査は `local.remove('a')`（実在するキー）しか見ていないので smoke では拾えず、実機で気づいて台帳の照合ルールごと直すことになる。/ `remove(keys)` も `clear()` と同じ扱いにして、**実行前に `get(keys)` で実在するキーだけを `keys` にする**（Chrome の挙動にも寄る。remove は `set` と違って頻度が低いので `get` を挟んでよい）。あわせて「native イベントを台帳に積むときの正規化（`changes` → `keys` は `Object.keys()`、`type` は `"newValue" in change`）」を 1 行決め、Phase 1 に「存在しないキーを混ぜた `remove` がちょうど 1 回、そのキーを含まない」、Phase 3 の unit にも同じケースを足す。

## P1
- **Phase 1 > 4 / Phase 3 > 5** — Phase 1 は「SW 受信の検査が **FAIL することを確認**する」フェーズだが、`verify-ext-smoke.mjs` は `ci.yml` の必須チェックで回る。Phase 1 だけをコミットすると **main が赤のまま Phase 2・3 を進める**ことになる。/ Phase 0 だけ「コミットする」と明示され、Phase 1〜3 のコミット単位が書かれていないので、素直に進めると赤いコミットが残る（`--sw-idle` を含め実行に数分かかるスイートなので、赤の原因を後から切り分けるのも高くつく）。/ 「Phase 1 の検査追加は Phase 3 の polyfill と**同じコミットにまとめる**（FAIL の記録は plan のログに貼るだけでコミットしない）」と Phase 1 の末尾に書く。

## P2
- **Phase 1 > 3 の 5 番目** — 「同じ値を 2 回続けて書くと受け側で 2 回鳴る」の受け手が書かれていない。SW 受信なら Phase 1 では 0 回（FAIL）、popup 受信なら PASS と挙動が真逆になるので、check 名に受け手を入れておくと FAIL→PASS の一覧が読める。
- **前提・わかっていること > 実測（4 行目）** — 「popup → popup、popup → session を frame で受ける」の 2 つ目が語落ちしている（「popup が `session` に書いたものを frame で受ける」の意）。表を書き直すときに直す。

## Q

````

**対応**: P0 反映: `remove(keys)` は実行前に `get(keys)` で実在キーだけを `keys` にする・native イベントの正規化ルールを明記・Phase 1 と unit に「存在しないキーを混ぜた remove」を追加。P1 反映: Phase 1 の検査追加は Phase 3 と同じコミットにまとめる旨を明記。P2 反映: 同値 2 回の check を受け手別に／実測表の語落ちを修正。

## 6回目

````text
## P0

## P1
- **設計の決定 > polyfill が唯一のディスパッチャ（台帳の積み方）** — 「先に来たものを**即座に配り**、台帳に 1 件積む」と配信 → 登録の順で書かれているが、ブロードキャスト受信の配信は `get` を挟むので**非同期**。台帳への登録がその後だと、`get` の解決を待つ数 ms の間に native イベントが来たときに未消化の項目が無く、native も配られて**二重になる**（native のほうが速い可能性は高い）。/ Phase 1 の「SW で `remove` → popup にちょうど 1 回」で FAIL としては拾えるが、原因が台帳の順序だと分かるまで往復する。/ 「台帳への登録は**イベントを受け取った同期の時点**で行い、配信はそのあと（`get` を伴う経路では `get` 完了後）」と 1 行足す。あわせて `get` が失敗した場合はイベントを落とす（台帳の項目は窓超過で消える）ことも書いておく。
- **設計の決定 > 配送の形（受け側の `changes` は必ず `get` の結果から作る）／同 > 唯一のディスパッチャ（native 転送）** — この規則が **native 転送にも適用されるのか**が未定義。native イベントは値つきの `changes`（`oldValue` 付き）を持っているので、そのまま転送すると「既知の仕様差分: `oldValue` は付けない」と食い違い、しかも台帳で**先に来たほうが配られる**ため、同じ変更でも経路次第で `oldValue` が付いたり付かなかったりする**非決定的な形**になる。/ `oldValue` を見る拡張から見ると「たまに無い」という最悪の壊れ方をする。仕様差分として宣言した意味も無くなる。/ 「native 転送は `changes` をそのまま使う（`get` し直さない）が、**`oldValue` は落として経路間で形を揃える**」と決めて書く。

## P2
- **Phase 1 > 3 の 6 番目** — 「存在しないキーを混ぜた `remove` がちょうど 1 回、そのキーを含まない」の受け手が書かれていない。台帳の照合が効くのは native も鳴る **popup 受信**なので、そこを check 名に含めると意図が残る（1 つ上の「同値 2 回」を受け手別に分けたのと同じ扱い）。

## Q

````

**対応**: 収束（P0 なし）。P1 2 件反映: 台帳への登録は受信の同期時点・配信はその後（get 失敗時は落とす）／native 転送は changes をそのまま使うが oldValue は落とす。P2 反映: 存在しないキー remove の check に受け手（popup）を明記。
