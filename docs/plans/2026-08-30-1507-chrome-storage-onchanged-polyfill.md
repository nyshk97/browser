# 拡張の `chrome.storage.*.onChanged` を preload で補完する（Bitwarden の解除が SW に伝わらない問題）

## 概要・やりたいこと

Bitwarden で Vault を解除しても、**ツールバーのアイコンがロックのまま**になり、
ログイン欄のインラインメニューも「Unlock your account」のまま出る。しばらく（SW が idle 停止して
再起動するまで）置くと直る。popup から fill すれば入る。

原因は Electron 側: **service worker では `chrome.storage.local.onChanged` / `chrome.storage.session.onChanged`
（および `chrome.storage.onChanged`）が発火しない**（popup などの frame 側で受けるぶんは発火する。
`test-extension/popup.js` の `storageChanged` = 「SW の `local.set` → popup の `onChanged`」は CI で通っている）。Bitwarden の状態管理は
`ChromeStorageApiService.updates$ = fromEvent(storageArea.onChanged)` で「他コンテキストでの変更」を
知る作りなので、popup が `chrome.storage.session` に書いたユーザー鍵の存在を SW が知る手段が無く、
SW は自分が再起動して読み直すまで「ロック中」のままになる。

Nemo の拡張コンテキスト用 preload（frame / service-worker）で `onChanged` を**仕様どおりに補完**する。
Bitwarden 専用のコードにはしない（`chrome.storage` の挙動を埋めるだけ。他の拡張にもそのまま効く）。

あわせて、今回の調査で入れた **dev 用の拡張コンソール取り込み（`NEMO_EXT_CONSOLE=1`）** をコミットし、
Bitwarden の初回既定値（`inlineMenuVisibility`）の仕込みは任意フェーズとして置く。

### スコープ外

- content script 内の `chrome.storage.onChanged`（preload はページに配られないので、**受信も送信側の通知も**補えない。
  content script が書いた変更は他コンテキストに通知されない。Bitwarden の content script は `chrome.storage` を使っていない。
  「他の拡張にもそのまま効く」はこの但し書き付き）
- Electron 本体への報告・修正待ち（やるならこの plan とは別に）

## 前提・わかっていること

### 実測（2026-08-30、使い捨てプロファイル + 実 artifact の Bitwarden 2026.8.0、Electron 41.10.6）

| 見たもの | 結果 |
|---|---|
| SW 自身が `storage.session.set` / `storage.local.set` → **SW** の `chrome.storage.onChanged` / `session.onChanged` / `local.onChanged` | **0 件** |
| popup が `storage.session.set` / `local.set` → **SW** の同上 | **0 件**（値の `get` はできる） |
| SW が `local.set` → **popup** の `chrome.storage.onChanged` | **届く**（既存 smoke `storageChanged`、CI で常時 PASS） |
| popup → popup、popup が `session` に書いたものを frame で受ける、`runtime.sendMessage` が content script に届くか | **未測定**（Phase 1 で表を埋める。content script 発の変更はスコープ外なので測らない） |
| `chrome.storage.session` の値が SW 再起動をまたいで残るか | 残る |
| popup → SW のメモリ状態共有 port（`name: "session"`、`senderIsInternal` = origin 一致 & frameId 0） | 通っている |
| content script → SW の `sender.tab` / `sender.frameId`、`tabs.sendMessage(…, {frameId:0})`、拡張 iframe（`use_dynamic_url`）の読み込み | すべて OK |
| SW から per-tab `chrome.action.setIcon` → ツールバー描画 | OK（ロック⇄解除の絵が切り替わる） |
| SW idle 停止（37〜50 秒）後のタブ切替で Bitwarden が per-tab アイコンを再設定するか | 0.4 秒以内に再設定される |

dev 版（`NEMO_EXT_CONSOLE=1 mise run dev:nodebug`、実 Vault）で「解除済みなのに Unlock 表示 →
時間を置くと候補が出る」を目視で再現。SW の console にエラーは無い。

### Bitwarden 側の作り（`extensions/nngc…/2026.8.0_0/background.js` / `popup/main.js`）

- `class UL { constructor(area) { this.updates$ = fromEvent(area.onChanged).pipe(filter(([c]) => Object.keys(c).length === 1), …) } }`
  → **1 キーだけのイベントしか見ない**。Bitwarden 自身は 1 キーずつ書くので、仕様どおり `set` 1 回 = 1 イベントで配れば足りる
- 使うのは `key` と `"newValue" in change ? "save" : "remove"` だけ。`oldValue` の厳密さは要らない
- popup は `chrome.storage.session` を直接叩くクラス（`xFe extends PFe(chrome.storage.session)`）と
  port 経由のプロキシ（`QFe`）の両方を持つ。解除の鍵は直接書き込み側を通る（実測の挙動と一致）
- `inlineMenuVisibility` の既定値は未設定なら 0（Off）。Chrome では `runtime.onInstalled(install)` →
  `checkOnInstalled()` が 2（フィールドフォーカス時）を書くが、Nemo ではこの初回処理が走っていない
  （ウェルカムページも開かない）。設定画面から ON にすれば書かれる。設定変更も onChanged で SW に伝わるので、
  この polyfill が入れば再起動なしで効くようになる

### Nemo / ece 側

- Nemo の frame 用 preload: `src/preload/extension-shim.ts` → `src/shared/chrome-debugger-stub.js` の
  `installChromeDebuggerStub()` を `contextBridge.executeInMainWorld` で流し込む。
  **この関数は文字列化して送るので外の変数を参照しない**という制約がある
- 登録順: `registerExtensionShim(pageSession)` を `createExtensions()` より**前**に呼ぶ
  （ece の preload が最後に `Object.freeze(chrome)` する）。`verify-ext-smoke.mjs:598` が順序を固定している
- ece は `registerPreloadScript({ id: 'crx-mv3-preload', type: 'service-worker' })` で SW にも preload を
  配っている（`index.mjs:2747-2756`）。Nemo も同じ `type: 'service-worker'` で登録できる
- ece の preload は `chrome.storage` / `chrome.runtime` を `{...base, …}` で**別オブジェクトに差し替える**。
  `storage.sync` と `storage.managed` は `storage.local` と**同一オブジェクト**（`chrome-extension-api.preload.js` の
  `apiDefinitions.storage`）。二重ラップ防止の印は area 名でなく**オブジェクト自身**に付け（`__nemoStorageWrapped`）、
  area 名は最初にラップしたときの名前で固定する
- 検証スイートの名前: `verify:ext` は `mise run verify` の外で、`KNOWN_TARGETS` / `OWNERS`（`scripts/lib/verify-targets.mjs`）には
  **載っていない**（未登録＝フル扱い）。叩くのは `mise run verify:ext`（idle 込みなら `verify:ext-idle`）と `mise run verify:packaged`
- **SW preload の中で `chrome` の main world にどう触るかは未確認**（frame は `contextBridge.executeInMainWorld`。
  SW preload で同じ API が使えるか、`globalThis.chrome` に直接触れるかは Phase 2 のスパイクで確かめる。
  ece の preload が SW でどうやっているかを `chrome-extension-api.preload.js` で読む）
- preload の bundle は `electron.vite.config.ts` の `preload.build.rollupOptions.input` に足す（CJS で出る）。
  同梱漏れは `registerExtensionShim` の `exists: false` ログと `verify-packaged` が見る
- 診断ログ: `src/main/extension-console.ts`（新規・未コミット）。`NEMO_EXT_CONSOLE=1` のときだけ
  SW / content script の warning・error を `extension.sw_console` / `extension.page_console` に残す
  （URL はオリジンまで伏せる）。`index.ts` と `registry.ts` に配線済み。typecheck / lint / build は通っている

### 設計の決定

- **配送の形**: 書き込み側が `set` / `remove` / `clear` をラップし、完了後に (1) 自コンテキストの polyfill リスナーへ、
  (2) `chrome.runtime.sendMessage({ __nemo: 'storage-changed', area, keys: [...], type: 'save' | 'remove' })` で他コンテキストへ配る。
  **値は載せない**（2回目で決定）: 受け側が自分で `get` し直して `changes` を組み立てる。`storage.session` の中身
  （Bitwarden のユーザー鍵）を読めないはずのコンテキストへ polyfill が運ばない。連続書き込みの中間値は落ちて最後の値だけになるが、
  Bitwarden は key と save/remove しか使わないので飲む。
  **Chrome の仕様どおり `set` 1 回につき 1 イベント（`changes` に全キー）**。キーごとに割らない
  （Bitwarden は元々 1 キーずつ書くので束ねても解除は伝わる。Bitwarden の都合で仕様から外れない）。
  **同じ値を書いても通知する**（Chrome も発火する。Bitwarden は「保存された」の合図として使う）。
  **既知の仕様差分**: `oldValue` は付けない（`set` の前に `get` を挟まない。Bitwarden は使わない）。
  `remove(keys)` は `get(keys)` を**投げてから待たずに**削除を出し、snapshot で**実在するキーだけ**を `keys` にする
  （5回目で決定、実装レビュー 1 回目で「待たない」に修正。Chrome も存在しないキーの remove では鳴らないし、台帳の照合キーが
  native と揃う。storage は FIFO なので snapshot は削除前の状態。await すると `remove` 直後の `set` に追い越される）。
  `clear()` は実行前に `get(null)` でキー一覧を取り、`type: 'remove'` + そのキー一覧で配る。
  native イベントを台帳に積むときの正規化: `keys = Object.keys(changes)`、`type` は `"newValue" in change`。
  native 転送は `changes` をそのまま使う（`get` し直さない）が、**`oldValue` は落として経路間で形を揃える**。
  受け側の `changes` は**必ず `get` の結果から作る**（`type` は `get` を省ける場合のヒントにしか使わない。
  `save` なのに `get` が `undefined` なら remove 扱い）
- **配送の失敗処理**: 受け手が 1 つも無い（拡張ページが開いていない）のは常態なので、`sendMessage` は
  callback 形式で投げて `chrome.runtime.lastError` を必ず読む（Promise 版なら `.catch(() => {})`）。
  **元の `set` の完了を配送で待たせない**（拡張の `set` が reject したり unhandled rejection を出したりしない）
- **受け側**: polyfill 自身が `chrome.runtime.onMessage` に最初にリスナーを登録して拾い、`return false`。
  Chromium は同じコンテキストの全リスナーに配るので**拡張のハンドラにも届く前提**にし、メッセージは
  `type` / `command` を持たない素のオブジェクトにする（拡張側が未知メッセージで例外を出さないことを smoke で見る）。
  Chrome の仕様では `runtime.sendMessage` は content script には配られない（Electron でも同じかは Phase 1 で測る）
- **polyfill が唯一のディスパッチャ**（2回目で決定。「オン／オフの判定」はしない）: `chrome.storage.onChanged` /
  `chrome.storage.<area>.onChanged` の `addListener` / `removeListener` / `hasListener` を横取りして自前の Set に持ち、
  **拡張のリスナーはネイティブに登録しない**。ネイティブには polyfill の**転送用リスナー 1 本だけ**を登録し、
  受けたネイティブイベントも**そのまま自前リスナーへ転送**する。転送用に登録するのは
  **`chrome.storage.onChanged` の 1 本だけ**（area は引数で来る。area 別の `onChanged` にはネイティブ登録しない。
  1 変更で両方が鳴るので両方に付けると 2 件に数えてしまう）。
  ブロードキャスト由来との重複排除は**「内容一致で捨てる」ではなく件数を突き合わせる台帳**（3回目で決定）:
  **自己配信（書き込み側の (1)）・native 転送・ブロードキャストの 3 経路すべてが台帳を通る**（4回目で決定）。
  どの経路でも**先に来たものを配り**、`{area, keys, type, 時刻}` を台帳に 1 件積む。**台帳への登録はイベントを受け取った
  同期の時点で行い、配信はそのあと**（`get` を伴う経路では `get` 完了後。`get` が失敗したらそのイベントは落とし、
  台帳の項目は窓超過で消える）。
  後から来た同一内容のものは台帳の**未消化 1 件だけを消して捨てる**（窓を過ぎた項目は捨てる）。
  同値の N 連続書き込みは N 回配られ（「同じ値でも通知する」と両立）、native が鳴かない SW 受信でも窓ぶんの遅延は乗らない。
  台帳の単位は「変更イベント 1 件」で、`chrome.storage.onChanged` と area 別の両方へ配ることは 2 件に数えない。
  台帳で突き合わせるのは **native と組になる項目だけ**（native ↔ self、native ↔ broadcast）。self ↔ broadcast は消さない
  （自分の broadcast は自分に返ってこないので、同じ内容が並ぶのは別コンテキストが同じキーを書いたとき。実装レビュー 1 回目で決定）。
  窓は 1500ms・掃除は台帳に触るたび（実装レビュー 1 回目で決定。IPC 往復は実測で数 ms〜数十 ms。誤消しが起きうるのは
  「別コンテキストが 1.5 秒以内に同じキーへ同じ種別の書き込みをし、かつ native が遅れて届く」ときだけ。取りこぼしより
  二重配信を嫌う側に倒した。実機で「たまに 1 回鳴らない」が出たらここを疑う）。
  こうすると送り手 × 受け手の生死表に実装が依存せず、起動直後の自己テストも要らない（Phase 1 の表は「どこが落ちているか」の
  記録として残す）。将来 Electron がネイティブで鳴らすようになっても台帳で 1 回に収まる
- **ネイティブの `sendMessage` に乗せる理由**: SW が停止中でも受け側で起こせる。起きた SW は storage を
  読み直すので、その通知自体は取りこぼしてよい
- 既定値の仕込み（`inlineMenuVisibility`）は Bitwarden の内部キーに依存するので**別フェーズ・任意**。
  やる場合は lock の版に紐づけ、`ext:update` の検証項目に足す
- content script 発の変更が通知されない穴は**仕様として受け入れる**（1回目で決定。Bitwarden は content script で
  `chrome.storage` を使わず、lock に入れる拡張は自分で選ぶ。関数は `chrome-debugger-stub.js` と同じ「文字列化して送れる」形なので、
  必要になれば `devtools-shim.ts` と同じ CDP 注入で content script にも配れる。今回はやらない）
- Phase 4 は**今回の範囲に入れるが最後・任意**（1回目で決定。人間の動作確認 3 点目は「設定画面で ON にした状態で、
  設定の切り替えが再起動なしで効く」ことを見る項目なので、Phase 4 が無くても成立する）

## 実装計画

### Phase 0: 診断ログ取りをコミットする [AI🤖]
- [x] `src/main/extension-console.ts` / `index.ts` / `registry.ts` の変更を `mise run check` 相当で確認してコミット（コミットは `/act` の規則で保留。typecheck / lint / test は通過）
- [x] `VERIFY.md` の「実 Vault を入れるなら `mise run dev:nodebug`」の節に `NEMO_EXT_CONSOLE=1` の使い方を追記
- [x] `scripts/verify-ext-smoke.mjs` に「`NEMO_EXT_CONSOLE=1` で起動すると `extension.console_watch_enabled` が出て、
      SW の `console.error` が `extension.sw_console` に URL 伏せ字で載る」検査を 1 本足す
      （SW の `console.error` は smoke が CDP から直接吐かせる。拡張自身の `sendMessage` は送信元に配られないので
      「メッセージで起こす」形は取らない。`verify:ext` は `OWNERS` の外なので登録は不要）

### Phase 1: 先に検査で現象を捕まえる [AI🤖]
- [x] まず**どの経路が壊れているかの表を埋める**: 送り手 {SW, popup} × area {local, session} × 受け手 {SW, popup} を
      別々に測り、「前提」の実測表を書き直す（受け手が SW のときだけ落ちているのか、popup→popup も落ちるのか）
- [x] `test-extension` に、popup / SW の両方から `chrome.storage.{local,session}` を書く仕掛けと、
      受け側の `onChanged` で受けた `{area, changes}` を**コンテキスト内のグローバル配列**に貯める仕掛けを足す
      （SW 側は `sw.ev(...)` で読む。`chrome.storage.local` に記録すると、その書き込み自体が配信を誘発して件数が合わなくなる）
- [x] `scripts/verify-ext-smoke.mjs` に検査を足す（**受け手が SW のもの**は今ネイティブで落ちている経路なので、
      check 名にそれと分かる名前を付けて、polyfill が丸ごと外れた回帰を拾えるようにする）
  - [x] popup で `session.set({k: 1})` → SW の `chrome.storage.session.onChanged` に届く
  - [x] popup で `local.set({a: 1, b: 2})` → SW に **1 イベント（`changes` に 2 キー）**、`chrome.storage.onChanged` にも area 付きで届く
  - [x] SW で `local.remove('a')` → popup に `"newValue" in change === false` のイベントが届く（ネイティブ経路。二重にならないこと＝**ちょうど 1 回**）
  - [x] SW 自身の書き込みが SW 自身のリスナーに**ちょうど 1 回**届く。popup 自身の書き込みも popup で**ちょうど 1 回**
  - [x] 同じ値を 2 回続けて書くと受け側で 2 回鳴る（台帳と「同値でも通知」の両立。SW 受信と popup 受信を別の check 名にする）
  - [x] 存在しないキーを混ぜた `remove` が **popup 受信**でちょうど 1 回、そのキーを含まない（native も鳴る側で台帳の照合を見る）
  - [x] test-extension の `onMessage` ハンドラが `{ __nemo: 'storage-changed', … }` を受けても既存の検査が壊れない
        （Phase 1 では polyfill が無く配送メッセージが飛ばないので、smoke から手で 1 回 `sendMessage` して確かめる）
  - [ ] （手元専用・自動化しない）実 Bitwarden を積んだ使い捨てプロファイルで、popup の `session.set` が
        SW の `session.onChanged` に届く（今回の調査の probe13 をそのまま再利用。CI には実 artifact をロードする経路が無い）
- [x] `mise run verify:ext` を回し、**SW 受信の検査が FAIL することを確認**して出力をログに貼る（修正前の FAIL は smoke が走らない環境だったため、同じ検査内容を使い捨て環境の実 Bitwarden で実測して代替。修正後は smoke で 78 件 PASS。ログ参照）
      （`verify-ext-smoke.mjs` は CI の必須チェックなので、**この検査追加は Phase 3 の polyfill と同じコミットにまとめる**。
      FAIL の記録は plan のログに貼るだけでコミットしない）
- [ ] 実測表の「`runtime.sendMessage` が content script に届くか」の行を埋める（未測定。値を載せない設計にしたので結果に依存しない）（Chrome では届かない。Electron で届くなら
      配送メッセージが content script にも見える前提で受け側を書く。値を載せないので漏れはない）

### Phase 2: SW preload の経路を確かめる（スパイク） [AI🤖]
- [x] ece の `chrome-extension-api.preload.js` を読み、SW で `chrome` にどう触っているか
      （`contextBridge.executeInMainWorld` か `globalThis.chrome` 直か）を確認する
- [x] ~~`src/preload/extension-sw-shim.ts` を最小（`console.log` 1 行）で作り、~~ → 別ファイルにせず `extension-shim.ts` を両方に登録（方針変更参照）。
      `electron.vite.config.ts` の input に足し、`registerExtensionShim` で
      `registerPreloadScript({ id: 'nemo-extension-sw-shim', type: 'service-worker', … })` を
      **ece より前**に登録して、SW の起動時に走ることを smoke で見る。確認項目:
  - [x] `chrome.storage` の各 area に触れる（ラップできる）
  - [x] `chrome.runtime.onMessage.addListener` が SW preload の時点で呼べ、ece の差し替え後も生きている
  - [x] `chrome.runtime.sendMessage` が SW から出せる
  - [ ] main 側から値を渡す手（frame の `executeInMainWorld({ func, args })` の `args` 相当）が SW でも使えるか（Phase 4 で lock の既定値を渡すのに要る）
- [x] 走らない／触れない場合は、ここで plan の「方針変更」に書いてから次の手（ece の preload に相乗りする等）を決める

### Phase 3: polyfill 本体 [AI🤖]
- [x] `src/shared/chrome-storage-onchanged.js` に `installStorageOnChangedPolyfill()` を書く
      （`chrome-debugger-stub.js` と同じく**文字列化して送る前提で外を参照しない**。`// @ts-check`。
      「設計の決定」の配送・失敗処理・受け側・唯一のディスパッチャと台帳による重複排除をそのまま実装する）
  - [x] `chrome.storage.onChanged` と各 area の `onChanged` の `addListener` / `removeListener` / `hasListener` を横取り
        （ラップ済みの印はオブジェクト自身に付ける。`sync` / `managed` は `local` と同一オブジェクト）
  - [x] `set` / `remove` / `clear` をラップ（Promise 形式・callback 形式の両方を通す）
  - [x] ネイティブ転送 + ブロードキャストの重複排除（設計の「唯一のディスパッチャ」）
- [x] `scripts/chrome-storage-onchanged.test.mjs`（node --test）: 差分計算は関数の中に置いたまま、
      `installStorageOnChangedPolyfill()` が内部関数を返す形にして返り値経由でテストする（文字列化の制約で外の関数は参照できない）
      （複数キー→1 イベントに全キー、remove、clear、undefined 値、同値でも通知する。
      台帳: 先着 native → 後着ブロードキャストで 1 回、先着ブロードキャスト → 後着 native で 1 回、
      自己配信 → native で 1 回、窓を過ぎた後着は独立イベントとして配る、存在しないキーを混ぜた remove）
- [x] frame 側 `src/preload/extension-shim.ts` と SW 側 ~~`src/preload/extension-sw-shim.ts`~~（同じファイル）の両方から呼ぶ。
      DevTools 内の拡張 frame（`src/main/devtools-shim.ts`）にも同じ関数を流す
- [x] `registerExtensionShim` は登録ごとに `id` 付きで `extension.shim_registered` を 2 本出す
      （`verify-packaged.mjs` の `checkExtensionShim` は `every(exists)` なので、1 本のままだと SW shim の同梱漏れを見逃す）
- [x] `mise run verify:ext` で Phase 1 の検査が PASS することを確認（78 件すべて PASS。ログ参照）
- [ ] `mise run verify:packaged` で SW shim の同梱（`exists: true`）を見る（未実施）
- [ ] `mise run check` / `mise run verify`（typecheck / lint / test（333 件）は通過。フルの `verify` は未実施）

### Phase 4（任意）: Bitwarden の初回既定値を仕込む [AI🤖]
- [ ] `extensions.lock.json` のエントリに `storageDefaults`（`{ "global_autofillSettingsLocal_inlineMenuVisibility": 2 }` のような
      「無ければ書く」既定値）を持たせられるようにする（`ext-lock.js` の `validateEntry` で検証）
- [ ] SW shim の起動時に、その拡張の既定値のうち**未設定のものだけ** `chrome.storage.local.set` する
      （popup を一度も開かないユーザーにも効く。`runtime.onInstalled` の代替として素直）
- [ ] main 側から既定値を SW shim に渡す（Phase 2 で確かめた手を使う。preload は lock を直接読めない）
- [ ] smoke: test-extension の lock に既定値を持たせ、SW を起こした後に読めること・既存値は上書きされないこと
- [ ] `ext:update` の検証項目（VERIFY.md）に「既定値のキー名が新版でも存在するか」を足す

### 動作確認 [人間👨‍💻]
- [ ] `NEMO_EXT_CONSOLE=1 mise run dev:nodebug`（実 Vault、dev プロファイル）で:
  - [ ] popup で解除した**直後**にツールバーのアイコンが解除の絵になる
  - [ ] Qiita のログイン欄をクリックすると「Unlock」ではなく候補が出る
  - [ ] popup の Autofill 設定（「Show autofill suggestions on form fields」は ON 済みの前提）を切り替えると
        **再起動なしで**インラインメニューの出方が変わる
- [ ] 常用版を更新後、同じ 3 点

## ログ
### 試したこと・わかったこと

**経路の表（2026-08-30、使い捨て環境の実 Bitwarden 2026.8.0 で実測。修正前 → 修正後）**

| 送り手 → 受け手 | area | 修正前 | 修正後 |
|---|---|---|---|
| SW → SW | session | 0 件 | 1 件（`storage.onChanged` と `session.onChanged` の両方） |
| popup → SW | session | 0 件 | 1 件 |
| popup → SW | local（2 キー） | 0 件 | 1 イベント（changes に 2 キー） |
| popup → SW | local（同キー再書き込み） | 0 件 | 1 件（合計 2 件、連続でも落ちない） |
| popup → popup | session / local | 1 件（ネイティブ） | 1 件（二重にならない） |
| SW → popup | local remove（存在しないキー混在） | 1 件（ネイティブ） | 1 件、実在キーだけ |
| SW → SW | local remove | 0 件 | 1 件 |

- 初版の台帳は「同じ内容の未消化 1 件を消す」だけだったので、native が鳴かない SW で**同値の 2 回目が消える**
  ユニットテストが落ちた（自分の書き込みが積んだ項目を次の書き込みが消す）。台帳の項目に**経路（self / native /
  broadcast）**を持たせ、**別経路の項目だけ**突き合わせるようにして解決
- ece の preload は `chrome.storage` を `{...base}` で作り直すので、`storage` オブジェクトに付けた非列挙の印
  （`__nemoOnChangedPolyfill`）は差し替え後の `chrome.storage` からは見えない。area オブジェクト（`local` 等）は
  そのまま引き継がれるので、area 側の印（`__nemoStorageWrapped`）とラップ済みの `set` は残る
- 使い捨て環境の後片付けで `pkill -f "<tmpdir>"` を打つと、**その文字列を含む自分のシェルまで殺す**（Bash tool が
  exit 143 で止まった）。`pgrep -f "user-data-dir=<tmpdir>"` の PID か `lsof -t -i :9333` で止める
- `verify:ext`（smoke）は常用 Nemo が起動していると `assertNemoNotRunning` で走らない。実測は使い捨て環境の
  実 Bitwarden に CDP でつないで行った（`scratchpad/probe15.mjs`）

**smoke（`mise run verify:ext`、常用 Nemo を止めてから）**: 初回は「[popup受信] popup 自身の session.set が popup に 1 回届く」
だけ 0 件で FAIL。受け手の全記録を出すと popup.js 初期化時の `__nemo_ci_popup_opened__` / `__nemo_ci_touch__` だけが
残っていた＝**popup の target ができた直後に繋ぐと popup.js がまだ走っておらず、リスナー登録前の書き込みは記録されない**
（polyfill の不具合ではなく検査の順序）。`#messaging`（popup.js の probe 完了）を待ってから記録を空にするよう直して
**78 件すべて PASS**。SW 受信の各 check（polyfill 前は 0 件だった経路）が 1 件ずつ、popup 受信は二重にならず 1 件で揃った。
popup を使う検査を足すときは同じ待ちを入れること。

### 方針変更

- **SW 用の preload を別ファイルにしない。** `extension-shim.ts` を `type: 'frame'` と `type: 'service-worker'` の
  両方に登録し、preload 側で `process.type === 'service-worker'` で分岐する。別ファイルにすると electron-vite が
  共有モジュール（`chrome-storage-onchanged.js`）を `chunks/` に割り、sandbox の preload は chunk を `require` できず
  `module not found: ./chunks/chrome-storage-onchanged-*.cjs` で SW の preload が丸ごと落ちた（実測）。
  ece 自身も同じ 1 ファイルを両方に配っている
- Phase 1 の「修正前に smoke で FAIL を見る」は smoke が走らない環境だったため、同じ検査内容を probe で実測して
  代替した（表のとおり修正前は SW 受信が 0 件）。smoke の FAIL→PASS は常用 Nemo を止めてから改めて回す
