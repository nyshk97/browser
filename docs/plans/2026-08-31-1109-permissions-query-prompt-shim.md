# permissions.query に「未決定 = prompt」を返すシム（Meet 初回詰みの恒久修正）

## 概要・やりたいこと

まっさらな権限状態（新規プロファイル・別 PC への新規インストール・シークレットウィンドウ）で
Google Meet が「マイクが見つかりません」表示になり、getUserMedia を一度も呼ばずに詰む問題を直す。

機序（2026-08-31 に別 PC で実地調査して確定）:

- Nemo は Electron の permission check（boolean のみ・「prompt」を表現できない）の制約から、
  未決定の `permissions.query({name:'microphone'})` に **`granted`** と答えている
  （v1.0.1 の「denied に倒すと Meet がブロック表示で詰む」修正の仕様。`src/main/security.ts` の
  `isPermissionsQueryCheck`）
- 一方 `enumerateDevices()` は未決定では label / deviceId を伏せる（デバイス名漏洩の防止。維持する）
- Meet は「query = granted なのに label が全部空」という実 Chrome ではあり得ない組み合わせを
  「デバイスが存在しない」と解釈し、getUserMedia を呼ばずに「マイクが見つかりません」で止まる
- ログ上の証拠: `permission.request` に media が一度も来ない・`media.os_access` が 0 行
- devtools から `getUserMedia({audio:true})` を手で撃つと Nemo → macOS のダイアログが正常に出て
  復旧する＝要求経路は健全で、壊れているのは query の読み替えだけ

**修正方針: page の main world に `navigator.permissions.query` のラッパーを注入し、
「実結果が granted かつ該当 kind の label が全部空」なら `'prompt'` に読み替える。**
あわせて `getUserMedia` もラップして許可後の状態遷移（prompt → granted の change 発火）を成立させる。
この矛盾自体が「Nemo 未決定」の証明なので、IPC・特権 API なしでページ内完結する。

## 前提・わかっていること

- **注入経路は確立済み**: page セッションには `registerExtensionShim`（`src/main/extensions.ts`）で
  `src/preload/extension-shim.ts` が全ページに配られており、
  `contextBridge.executeInMainWorld({ func })` で main world に関数を注入するパターンがある
  （`chrome.debugger` スタブと同型）。**func は直列化されるので自己完結の関数にする**
  （`src/shared/chrome-debugger-stub.js` と同じく shared の純 JS に置く）
- **シークレットセッションには preload が未登録**: `ensurePrivateSession`（`src/main/registry.ts`）は
  `registerExtensionShim` を呼んでいない。シム登録をシークレット側にも足す必要がある
- **判定はページ内ヒューリスティックで完結させる**（/dig-lite で決定）:
  - microphone → audioinput、camera → videoinput の label を見る
  - 実 query が `granted` かつ該当 kind の label が全部空 → `'prompt'` に読み替え
  - `denied`（ユーザーの明示拒否・OS 拒否）はそのまま通す
  - IPC で decision を引く案は「ページ側 preload に特権 API を載せない」方針
    （`src/main/registry.ts` の方針コメント）に反するので却下
- **適用範囲は全 http/https ページ**（/dig-lite で決定。サイト個別ハックにしない）
- 許容する端ケース（fail-safe 側に倒れる）:
  - デバイスが物理的に 0 台のマシンでは「許可済みでも 'prompt'」→ サイトは getUserMedia を呼んで
    NotFoundError を受けるだけで無害
  - preload はトップフレームのみ → iframe 内に埋まった Meet は対象外
  - Worker（`WorkerNavigator.permissions`）には main world 注入が届かない → 対象外（既知の穴として記録）
- 読み替え時に返すオブジェクトは実 PermissionStatus のファサードにする。**実 status は
  granted→granted で変わらず change を発火しない**ので、ファサードは自前で change を発火する
  （`devicechange` と、下記 getUserMedia 成功時に再評価）。作りは**実 status を包む Proxy**
  （`state` と change 経路だけ差し込み、他は実物に bind して返す。素の object literal だと
  `addEventListener` の this が外れて Illegal invocation になる）
- **「今後も同じ扱いにする」を外して許可した場合、decision は null のままなので label は空のまま
  ＝読み替えが自然には外れない**（1回目レビューで発覚）。シムは `getUserMedia` もラップし、
  kind ごとの成功をページ内（メモリ）で覚えて以後は実 state を素通しする。
  ラップの仕様: `mediaDevices` 不在なら包まない / reject は透過し記憶しない /
  **記憶する kind は返った MediaStream の track.kind から導く**（constraints からの推測は
  片方しか取れないケースで外れる）。
  なお label 露出は Chromium 一般でなく Nemo の check handler を通る（未決定なら false）ので、
  **アクティブキャプチャ中でも label は空のままに倒れる公算が大きく、その場合この記憶が
  唯一の経路になる**（Phase 1 で実測して確かめる）
- **シムの安全ガード**: name が microphone / camera 以外は実 query を即素通し。
  `navigator.mediaDevices` 不在（素の http は secure context でないため undefined）・
  `enumerateDevices` の reject・その他の例外時はすべて実結果をそのまま返す
  （Meet と無関係なサイトの `permissions.query` を壊さない）
- 既存の見張り（`scripts/verify-phase1.mjs` 839 行付近）: 「未決定が denied にならない」
  「label が漏れない」の両方向。**この 2 つは維持したまま** 'prompt' の断言を足す
- 実 Meet はログインが要るので自動化しない（/dig-lite で決定）。**手動確認はリリース前に行う**
  （シークレットウィンドウは毎回未決定になるので、dev ビルドでリリース前に再現・解消を確認できる。
  リリース後の別 PC 確認は任意の追試とする。1回目レビューで決定）

### レビューでの決定

- remember なし許可への対処: シム側で getUserMedia の成功を覚える案を採用
  （許可ダイアログから「一度だけ許可」を奪う案は却下。1回目で決定）
- シークレットセッションへの登録: `registerExtensionShim` の再利用ではなく **page シム専用の
  登録関数に切る**（service-worker 用の登録と `extension.shim_registered` ログを private 側に
  増やさない。1回目で決定）
- 実 Meet の合格判定: 本 PC の dev ビルド＋シークレットウィンドウでの再現・解消で足りるとする
  （機序はプロファイル状態依存でありマシン依存ではない。別 PC の新規インストール確認は必須にしない。
  1回目で決定）

## 実装計画

### Phase 0: 再現確認（修正前 FAIL の記録） [AI🤖]

- [x] 使い捨てプロファイル（`NEMO_USER_DATA_DIR`）で起動し、
      `permissions.query({name:'microphone'})` が **`granted`** を返すことを実測して記録する
      （修正後に `'prompt'` へ変わるのが本修正の核。常用インスタンスには触らない）。
      撃ち方は Phase 2 と同じ probe ページ＋`connectTo` にして、そのまま差分断言に流用できる形にする
- [x] シークレットウィンドウでも同じ状態になる（毎回未決定 → granted + label 空）ことを確認する
      ※ 通常プロファイル側で許可済みでもシークレットは未決定になる、の裏取り

### Phase 1: シム実装 [AI🤖]

- [x] `src/shared/permissions-query-shim.js` を新規作成（Node 非依存の純 JS）。
      **installer 関数 1 本を export する**（`executeInMainWorld({func})` は直列化されるため
      自己完結必須。判定ロジックを別関数に切って importすると main world で ReferenceError になり、
      切り離した純粋関数だけテストすると出荷されないコードを検証する false green になる）
- [x] installer のユニットテスト（`scripts/permissions-query-shim.test.mjs`）:
      偽の `navigator`（`permissions.query` / `mediaDevices.enumerateDevices` /
      `getUserMedia` のスタブ）に installer ごと当てて検証する
      （`scripts/chrome-storage-onchanged.test.mjs` と同型）。ケース:
      granted+label 空→prompt / granted+label あり→granted / denied 素通し / prompt 素通し /
      デバイス 0 台→prompt / mic・camera 以外の name 素通し / `mediaDevices` 不在で実結果素通し /
      `enumerateDevices` reject で実結果素通し / getUserMedia 成功後は素通し＋change 発火 /
      `devicechange` で再評価して change が飛ぶ / change 後の `state` が新しい値 /
      `addEventListener`・`removeEventListener`・`onchange` が実 status 側にも届く
- [x] `src/preload/extension-shim.ts` に http/https ページ向けの分岐を追加し、
      `contextBridge.executeInMainWorld` で installer を注入する。
      冒頭 doc の「それ以外では何もしない」の記述を実態（ページシム同居）に合わせて書き換える
- [x] `ensurePrivateSession`（`src/main/registry.ts`）でシークレットセッションにも
      preload を登録する（レビューでの決定どおり page シム専用の登録関数に切る）。
      登録関数は独立モジュール（例 `src/main/page-shim.ts`）に置く
      （`extensions.ts` は `registry.ts` を import しているので、registry → extensions の呼び出しを
      足すと新規の循環 import になる。`index.ts` と `registry.ts` の両方が独立モジュールを見る）
- [x] remember なし許可の挙動を実測: アクティブなキャプチャ中に label が出るか確認する
      （Nemo の check handler を通るため空のままの公算が大きい。その場合 getUserMedia ラップの
      記憶が唯一の経路である旨、出るならフォールバックである旨をコードコメントに残す）

### Phase 2: 自走検証の配線 [AI🤖]

- [x] `scripts/verify-phase1.mjs` の既存メディア検査（839 行付近）を強化:
  - 未決定の query が **`'prompt'`** であることを断言（現状 `granted` で FAIL するのを確認してから直す）。
    **素の query 値と main world のシム後の値を両方取り、granted→prompt の差分で断言する**
    （CDP の isolated world から評価すると monkeypatch が見えないため。差分にすることで
    「シムが配られていない」と「シムが例外で素通しした」を切り分けられる）。
    isolated world 評価のヘルパを `scripts/lib/cdp.mjs` に足す（既定の `ev` は main world 固定で、
    全 verify スクリプトが共有しているため挙動は変えない）
  - Meet の判定ロジック再現: 「query granted + label 全空 → デバイス無し扱い」の組み合わせが
    発生しないこと（query が prompt なら Meet は getUserMedia に進める）
  - 既存の「denied にならない」「label が漏れない」は維持
- [x] シークレット相当（`PRIVATE_PARTITION`）でも query が `'prompt'` になる検査を足す
      （preload 登録漏れの再発防止。今回まさに未登録だった）。private ウィンドウの掴み方は
      `verify-http-auth.mjs` の `private=1` ターゲットの前例に従い、
      **開く → private 側の target を名指しで掴む → 検査後に必ず閉じる**まで含める
      （閉じ忘れると後続検査の `connectTo` が private 側を掴んで不安定になる）
- [x] `scripts/lib/verify-targets.mjs` の `OWNERS` を確認:
      触った既存ファイル（`src/preload/extension-shim.ts` 等）が既に載っているなら
      エントリを広げる。**未登録のファイルを新たに載せない**（full に倒す安全側を維持）
- [x] 報告に実行件数を出す（配線を外して 0 件になることを見てから戻す、のプロジェクト規約に従う）

### Phase 3: ドキュメント [AI🤖]

- [x] `docs/CHANGELOG.md` の `[Unreleased]` に追記（ファイル冒頭の「書き方」節に従う）
- [x] `VERIFY.md` の「マイク / カメラ / 画面共有」節に、まっさら状態での query 期待値
      （`'prompt'`）と Meet 初回詰みの手動確認手順を追記

### 動作確認（リリース前） [人間👨‍💻]

- [ ] **リリース前に** dev ビルドのシークレットウィンドウで Meet の会議 URL を開き、
      「マイクが見つかりません」ではなく**マイク・カメラの許可フロー（Nemo → macOS ダイアログ）に
      進める**ことを目視確認（シークレットは毎回未決定になるので初回状態を何度でも再現できる）
- [ ] （任意の追試）リリース後、別 PC のシークレットウィンドウでも同様に確認

## ログ

### 試したこと・わかったこと

- **修正前 FAIL の記録**（2026-08-31、使い捨てプロファイル）: シム読み替え「素 granted / シム後 granted」・
  カメラ「granted」・Meet 判定再現「query granted / label 付き 0 件」・シークレット「granted」の 4 件が FAIL。
  修正後は phase1 の全 105 検査 PASS（同 4 件は「素 granted / シム後 prompt」等で PASS）
- **シークレットは毎回未決定 → granted + label 空**を実測で確認（Phase 0 の裏取り。preload 未登録も実地どおり）
- **remember なし許可の実測**（bundle 起動・remember チェックを外して許可）: getUserMedia は成功するが
  **アクティブキャプチャ中でも label は全部空**（露出は Nemo の check handler を通るため）。
  getUserMedia ラップの記憶が読み替えを外す**唯一の経路**であることを実証（shimmed query が granted に遷移）。
  コードコメントに反映済み
- 検証スクリプトの罠を 2 つ踏んだ: ① private ウィンドウを `runCommandForVerify('close-window')` の
  invoke **応答待ち**で閉じると、renderer ごと破棄されて応答が返らずハングする（20 分タイムアウトの原因。
  応答を待たない形＋ target 消滅待ちに変更） ② spawn 直の起動では TCC の責任プロセスが terminal になり
  `askForMediaAccess` が即 false（VERIFY.md 記載どおり。実測は `open -n` の bundle 起動で行った）
- OWNERS は変更不要と確認: 触った既存ファイルのうち `verify-phase1.mjs` は登録済み（phase1）、
  `extension-shim.ts` / `registry.ts` / `cdp.mjs` / 新規ファイルは未登録 = フル扱いの安全側

### 方針変更
