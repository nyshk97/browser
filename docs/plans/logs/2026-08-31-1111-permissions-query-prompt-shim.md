review session: 8bd83e02-ea08-4b8b-b705-e1444e96818b

# permissions-query-prompt-shim plan レビューログ

## 1回目

````text
plan と実コード（`src/main/security.ts`、`src/preload/extension-shim.ts`、`src/main/extensions.ts`、`src/main/registry.ts`、`scripts/verify-phase1.mjs`、`scripts/chrome-storage-onchanged.test.mjs`）を突き合わせてレビューしました。

## P0
- `前提・わかっていること > 5`（ファサード／「許可後は読み替えが自然に外れる」） — 許可ダイアログの「このサイトでは今後も同じ扱いにする」を**外して**許可すると `decidePermission`（security.ts:263）が `rememberDecision` を呼ばないので `getDecision` は null のまま。つまり許可後も check は「未決定」枝を通って granted を返し、label は空のまま／ **shim は通話中ずっと `'prompt'` を返し続ける**。「読み替えが自然に外れる」という前提が成り立たないので、Meet は許可済みなのに未許可 UI を出し続ける（今回の詰みの別バージョンを作る）。shim 側に「自分がラップした `getUserMedia` がその kind で成功したら、以後そのページでは実 state を素通しする」というセッション内の記憶を持たせるか、ダイアログ側で remember を必須にするか、どちらかを Phase 1 の仕様に含める。
- `Phase 1 > 1`（純粋関数と installer を分ける／installer は自己完結） — この 2 つは両立しない。`executeInMainWorld({func})` は関数を直列化するので、main world 側から shared の純粋関数を参照すると ReferenceError になる。分けたままだと判定ロジックが installer 内に二重化し、**ユニットテストが出荷されないコードを検証する**（false green）。`scripts/chrome-storage-onchanged.test.mjs` と同じく installer 1 本を export し、偽の `globalThis.navigator`（`permissions.query` / `mediaDevices.enumerateDevices` のスタブ）に対して直接叩く形にする。`Phase 1 > 4` のケース列挙も installer 単位に書き直す。
- `Phase 1 > 2`（http/https 全ページへの注入） — 素の http は secure context でないので `navigator.mediaDevices` が undefined。ラッパーが無条件に enumerateDevices を触ると、そのページの `permissions.query` が **notifications / geolocation を含む全 name で壊れる**（Meet と無関係なサイトの回帰）。仕様として ①name が microphone/camera 以外は実 query を即素通し ②`mediaDevices` 不在・`enumerateDevices` reject・その他例外はすべて実結果をそのまま返す、を明記し、`Phase 1 > 4` のテストにこの 3 ケースを足す。

## P1
- `前提・わかっていること > 5`（onchange を実物へ委譲） — 実 `PermissionStatus` の state は「granted → granted」で変わらないため、**実効状態が prompt → granted に変わっても change イベントが一度も飛ばない**。`status.onchange` で UI を更新するサイトはリロードするまで未許可表示のままになる。ファサードに自前の EventTarget を持たせ、`devicechange` と（P0-1 の対処で入れる）getUserMedia 成功時に再評価して change を発火する設計にする。
- `Phase 2 > 2`（シークレット相当の検査） — `verify-phase1.mjs` には private ウィンドウを開く配線が一切ない（前例は `verify-http-auth.mjs:808` の `private=1` ターゲット掴み）。手順を書かないと、private ウィンドウを開いた後に既存の `connectTo(CDP,'probe=...')` や overlay 取得が private 側を掴んで後続検査が不安定になる。「createPrivateWindow → `private=1` の ui/overlay を名指しで掴む → 検査後に必ず閉じる」までステップに落とす。
- `Phase 2 > 1`（既存検査の強化） — `state !== 'denied'` を `state === 'prompt'` に替えるだけだと、「shim が配られていない（granted のまま）」と「shim が例外を投げて素通しした」の区別が付かない。CDP の isolated world で評価すると main world の monkeypatch は見えないので、**素の query 値（granted）と shim 後の値（prompt）を両方取って差分で断言**すると、注入漏れとハンドラ回帰を切り分けられる。
- `Phase 1 > 3`（シークレットへの登録を「実装時に判断」） — 保留にすると Phase 2 の検査名とログ名が揺れる。`registerExtensionShim` をそのまま呼ぶと private セッションにも `nemo-extension-sw-shim`（service-worker 用）が登録され `extension.shim_registered` が出る。実害はないが実態とずれるので、page シム専用の登録関数に切るかどうかを計画段階で決めておく。
- `動作確認 > 1`（リリース後に実 Meet 確認） — 前提に「シークレットウィンドウは毎回未決定」と書いてある以上、ローカルの dev ビルド＋シークレットウィンドウでリリース前に確認できる。唯一の実 Meet 検証がリリース後だと、直っていない版がそのまま配布される。リリース前工程に移す。

## P2
- `Phase 1 > 2`（extension-shim.ts に枝を足す） — 冒頭 doc の「**それ以外では何もしない**（素のページに `chrome.debugger` を漏らさない）」が実態と食い違う。ファイルを分けると冒頭コメントが警告している chunk 分割問題を踏むので、同一ファイルに載せたうえで doc とファイル名の説明（拡張専用 → ページシム同居）を書き換える。
- `Phase 1 > 1`（判定のたびに enumerateDevices） — Meet は query をポーリングするので毎回デバイス列挙が走る。`devicechange` で無効化する短期キャッシュを入れる余地を残しておく。
- `前提・わかっていること > 7`（端ケース） — `WorkerNavigator.permissions` は main world 注入では届かない。iframe と並べて「既知の穴」として明記しておくと、後で同種の報告が来たときに切り分けが早い。

## Q
- `前提・わかっていること > 5` — P0-1 の塞ぎ方を、(a) shim 内で `getUserMedia` もラップしてセッション内の許可を覚える か (b) 許可ダイアログの「今後も同じ扱いにする」を常時 ON／必須にする のどちらにするか。(a) はページ内 API の差し替え面積が `permissions.query` から `getUserMedia` まで広がる、(b) は「一度だけ許可」をユーザーから奪う。どちらもプロダクト仕様の判断。/ 決めないと Phase 1 の shim 仕様が確定せず、実装後に設計からやり直しになる。
- `動作確認 > 1` — 実 Meet の合格判定を「本 PC のシークレットウィンドウで再現・解消」で足りるとするか、「別 PC への新規インストール」を必須にするか。/ 決めないとリリース判定が止まる（前者なら P1 のとおりリリース前工程に組み込める）。

````

**対応**: P0-1 採用（シムで getUserMedia もラップしページ内で kind ごとの成功を記憶→以後素通し＋change 発火。Q-1 は案(a)で自分で決定: 「一度だけ許可」のユーザー機能を奪わず、IPC 不要のページ内完結を維持できるため。Chromium のアクティブキャプチャ中 label 露出の実測ステップも追加）。P0-2 採用（installer 1本 export・偽 navigator に installer ごと当てるテストへ書き換え、テストケースも installer 単位に再列挙）。P0-3 採用（name 素通し・mediaDevices 不在・reject・例外素通しの安全ガードを前提とテストに明記）。P1-1 採用（ファサード自前 change 発火、P0-1 と一体で仕様化）。P1-2 採用（private=1 前例に従う掴み方・閉じるまでをステップに明記）。P1-3 採用（素の値とシム後の値の差分断言に変更）。P1-4 採用（page シム専用の登録関数に決定、「実装時に判断」を削除）。P1-5 採用（動作確認をリリース前工程に移動。Q-2 は「本 PC の dev ビルド＋シークレットで合格」と自分で決定: 機序はプロファイル状態依存でマシン依存ではない。別 PC は任意の追試に降格）。P2-1 採用（冒頭 doc の書き換えをステップに追記）。P2-2 見送り（キャッシュは仕組みの追加でありループ中は足さない。必要なら実装時に判断）。P2-3 採用（Worker の穴を端ケースに明記）。

## 2回目

````text
plan を読み直し、前回指摘の反映を確認しました。P0 は 3 件とも仕様として潰れており、新たな致命はありません。残りは実装着手時に確実に引っかかる具体点です。

## P0

## P1
- `Phase 2 > 1`（素の値とシム後の値の差分断言） — `scripts/lib/cdp.mjs` の `ev()` は `Runtime.evaluate` を contextId なしで撃つだけで、**main world 固定**。isolated world の値を取るには `Page.createIsolatedWorld` → `Runtime.evaluate({contextId})` が要る。手段を書いておかないと、着手時に「シムが素の関数を `window` に露出する」等の悪い近道（ページへの露出面積を増やす＝この設計の前提を壊す）に流れる。ステップに「`cdp.mjs` に isolated world 評価のヘルパを足す（既定の `ev` の挙動は変えない。全 verify スクリプトが共有しているため）」を明記する。
- `Phase 1 > 4`（page シム専用の登録関数） — 置き場所が未定。`registerExtensionShim` と `preloadDir` は `src/main/extensions.ts` にあり、**extensions.ts は registry.ts を import している**（registry.ts → extensions.ts の依存は現状ゼロ）。registry.ts から extensions.ts を呼ぶと新規の循環 import になる。独立モジュール（例 `src/main/page-shim.ts`）に切り、`index.ts` と `registry.ts` の両方がそこを見る形にすると決めておく。
- `前提・わかっていること > 6`（ファサード） — 「ファサード」の作り方が未定。素の object literal で実 status のメソッドを持ち回すと、`status.addEventListener(...)` の this がファサードになって Illegal invocation で落ちるし、`instanceof PermissionStatus` も外れる。**実 status を包む Proxy（`get` で `state` と自前の change 経路だけ差し込み、それ以外は実物に bind して返す）**と仕様に書く。
- `Phase 1 > 2`（installer のテストケース） — 前提 6 で仕様化したファサード側の検査が薄い。`devicechange` で再評価して change が飛ぶ / change 後に `state` が新しい値になっている / `addEventListener`・`removeEventListener`・`onchange` が実 status 側にも届く、が列挙に無く、自前 change 発火が無検査のまま出る。3 ケース足す。
- `Phase 1 > 1`（installer の仕様） — query 側の安全ガードは書かれたが、**getUserMedia ラップ側**が未記載。①`navigator.mediaDevices` 不在なら包まない ②reject はそのまま透過し記憶しない ③記憶する kind は**返った `MediaStream` の track.kind から導く**（`{audio:true,video:true}` で片方しか取れない場合や `{audio:{deviceId}}` 形式があり、constraints からの推測は外す）。ここを曖昧にすると camera だけ許可した状態で microphone も素通しになる。

## P2
- `概要・やりたいこと > 修正方針` — getUserMedia のラップと自前 change 発火が要約に入っておらず前提だけにある。冒頭 3 行しか読まないと「query を包むだけ」に読める。1 行足して設計の全体像を合わせる。
- `Phase 1 > 1` — installer 内でも `location.protocol` を自己チェックする（`installChromeDebuggerStub` と同型）。preload 側の分岐だけに依存しないので、将来 CDP 経由でサブフレームに配る余地が残る。
- `Phase 1 > 5`（label 露出の実測） — label の露出可否は Chromium 一般ではなく Nemo の check handler（`enumerateDevices` 経路は securityOrigin あり → 未決定なら false）を通るので、**アクティブキャプチャ中でも空のままに倒れる公算が大きい**。「その場合は getUserMedia 記憶が唯一の経路になる」と先に書いておくと、実測が空振りでも手が止まらない。
- `Phase 0 > 1` — query の撃ち方（CDP 経由か devtools 手動か）が未記載。Phase 2 と同じ probe ページ＋`connectTo` で撃つ形にしておくと、そのまま Phase 2 の差分断言に流用できる。

## Q

````

**対応**: P0 が空のため収束。収束回の P1/P2 を反映: P1-1（cdp.mjs に isolated world 評価ヘルパを足す旨を明記・既定 ev は変えない）/ P1-2（登録関数は独立モジュール src/main/page-shim.ts に置き循環 import を回避）/ P1-3（ファサードは実 status を包む Proxy と仕様化）/ P1-4（devicechange 再評価・change 後の state・実 status へのイベント委譲の 3 テストケース追加）/ P1-5（getUserMedia ラップの仕様: mediaDevices 不在なら包まない・reject 透過・kind は返った MediaStream の track.kind から導く）/ P2-1（修正方針の要約に getUserMedia ラップと change 発火を追記）/ P2-3（label 露出は Nemo の check handler を通るため空に倒れる公算大、と実測ステップに先回りで明記）/ P2-4（Phase 0 の撃ち方を Phase 2 と同じ probe＋connectTo に指定）。見送り: P2-2（installer 内の location.protocol 自己チェックは preload 側の分岐と重複する将来向けの追加であり、ループ中は足さない。実装時に必要なら判断）。
