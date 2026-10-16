review session: a4bdaf73-b57a-44a3-8c81-274718a303ed

## 1回目

````text
## P0
- 実装計画 > Phase 4 > 2 — 決定表の条件3（直近5秒に実入力がある）を、`execCommand`の経路ではChromiumのtransient activationで代わりに満たすと読める / transient activationはCDPの`Input.dispatchMouseEvent`（Claudeのクリック）でも立ちます。Claudeがボタンを押してすぐ`request_user_action`を呼ぶと、その後5秒以内にページのタイマーが呼ぶ`execCommand('copy')`は条件1・2・4を満たし、条件3もactivationで通ってしまいます。決定表が条件3で防ぐと書いている「ページのタイマーからのコピー」がそのまま通ります / 許可フラグは、mainが実入力（`cdpMouseInFlight === 0`の`mouseDown`、`before-input-event`の`keyDown`）のときに立て、Phase 2と同じ定数の時間がたったら下ろす形にすると明記してください。Chromiumのactivationは追加の条件として残すだけにします。Phase 1 > 4（`mouseDown`で立てたフラグが同じクリックのコピーに間に合うか）はこの立て方を前提にした実測になります

## P1
- 実装計画 > Phase 4 > 2 — `javascript_tool`の実行で「下ろす」タイミングと範囲が決まっていない / 実行の後に下ろすと、その間に仕込んだJSがコピーできてしまいます。`markScriptExposure`はopenerでつながったページにも記録を付けますが、フラグの扱いは自分のページの分しか書いてありません / フラグは`markScriptExposure`の中で、実行の**前に**下ろすと書いてください。openerでつながったページも同時に下ろし、下ろせなかったページは`exposed`と同じく拒否側に倒します。あわせて、フラグの値はイベントごとに別に組み立てず、Phase 2の`clipboardWriteRefusal(wc)`の結果をそのまま入れ直すと書いておくと、条件が2か所に分かれずに済みます
- 実装計画 > Phase 4 > 3 — 「プロセスごとの乱数のイベント名」でも、mainが`Runtime.evaluate`を使ってmain worldからdispatchすると、ページは`EventTarget.prototype.dispatchEvent`や`CustomEvent`を差し替えてイベント名を拾えます。拾った名前はそのプロセスの間ずっと使い回せます / 悪意のあるページが自分でフラグを立てる経路が残ります / dispatchはisolated world（`AGENT_WORLD_ID`。prototypeが別）から行うことを明記します。ガードはdocument開始時に`addEventListener`を手元に取っておき、`detail`はプリミティブだけ受け取ります。isolated worldからのイベントがmain worldのlistenerに届くかはPhase 1の実測に1行足してください
- 実装計画 > Phase 5 > 3 ② — 「実クリック相当」を撃つ検証用の口が作業項目にない / いまある`nemo:press-key-for-verify`はEscapeキーだけで、マウスを送る口はありません。`ipc.ts`の`focus-for-verify`には「合成マウスは使わない（ユーザーの操作を奪う）」という方針も書かれています / Phase 5に、`NEMO_VERIFY_DIAGNOSTICS=1`のときだけ使える`sendInputEvent`のmouseDown / mouseUpの口を足すと書いてください（送れる種類は列挙したものだけ）。Phase 1 > 3で`makeWindowFocusable`が前面を奪うと分かった場合の代わりの手段（例: 検証の間だけ`userMouseDown`のフォーカス処理を止める）も決めておきます
- 実装計画 > Phase 5 > 2 — 実クリップボードを退避して戻す手順が、検証中にユーザーが自分でコピーした場合と、途中で落ちた場合を考えていない / 戻すときに、ユーザーが新しくコピーした中身を上書きしてしまいます。落ちた場合は番兵の値が残ります / 戻す前に「中身がまだ検証の書いた値（番兵か期待値）か」を確かめ、違えば戻さないようにします（kyprの`clipboardGeneration`と同じ考え方）。`finally`に加えて、プロセス終了時にも戻すようにしてください。macOSのpasteboardの4形式以外の型（ファイルURLなど）は戻せないことをVERIFY.mdに書きます
- 実装計画 > Phase 5 > 3 — ③のタイマーの検査が`writeText`だけで、P0の経路が検査されない / `execCommand`側で条件3が抜けても検査が落ちません / 「Claudeがクリック → すぐ`request_user_action` → 窓の時間内にタイマーで`execCommand('copy')` → 変わらない」を足してください（`execCommand`の窓はPhase 2のenvで縮められるようにしておく）
- 動作確認 > 2 / 実装計画 > Phase 2 > 2 — 「自走検証ではkeyを作れない」と書いてあるが、`nemo:agent-key-for-verify`（`setAgentKeyForVerify` → `forcedKey`）はすでにある / 条件1を`isWindowKey`で組むと`forcedKey`が効かず、窓がkeyの経路を誰も自動で確かめられません / 条件1は`agentFillHooks.userAtWindow`（`isWindowKey || forcedKey`）とユーザーの番で組み、Phase 5に「`agent-key-for-verify`でkeyにして実クリック → 変わる」を足してください。動作確認のこの項目は、本物のkeyで1回見るだけに減らせます
- 実装計画 > Phase 1 > 3 — 候補の`Emulation.setFocusEmulationEnabled`は、`AgentPage.withAgentActive` / `settleAfterAgent`がツールの前後で自分でオン・オフしている / 検証側で立てた値が、Claudeのツールが終わるたびに消されたり、混ざったりするおそれがあります / 検証側のCDPセッションの値が、`AgentPage`の`enabled: false`の影響を受けないかを実測項目に加えてください
- 実装計画 > Phase 1（項目の追加） — `AGENT_MAIN_WORLD_GUARD`はページのtargetに`Page.addScriptToEvaluateOnNewDocument`で入れているだけで、agent側には`Target.setAutoAttach`がない。そのため別プロセスのiframe（OOPIF）にはガードが入っていない可能性がある / そうだとすると、iframe内のボタンをClaudeがクリックしたときの`execCommand('copy')`はいまでも通っていて、Claude側の拒否を確かめる①がメインフレームでしかPASSしません / Phase 1でcross-originのiframeの`execCommand('copy')`を測ってください。穴があれば直すか、範囲外として「方針変更」に書き、①のfixtureにもiframeのケースを入れます
- 実装計画 > Phase 6 > 2 — 条件4に当たったときの案内が「新しいタブで開き直す」になっている / 概要に書かれているとおり、APIキーは発行直後のダイアログでしかもらえず、開き直すと作り直しになります。issueの場面でそのまま役に立ちません / 案内の第一は「文字列を選んで⌘C」にします（ただし動作確認 > 3で通ると確かめてから）。Claudeに向けては「引き継ぐページでは事前に`javascript_tool`を使わない」をツールの説明か`request_user_action`の文面に入れることを検討してください

## P2
- 実装計画 > Phase 2 > 2 — 条件1の判定がすでに3か所（`connection.ts`の`userPresent`・`navigationBlocked`、`index.ts:46`）にコピーされている / 4か所目を足すことになります / `AgentPage`内なら`host.userPresent()`を使い、P1の`forcedKey`の扱いとあわせて口を1つにまとめます
- 実装計画 > Phase 4 > 2 — 新しいdocumentのフラグは初期値false で、mainが入れ直すまでの間がある / 読み込み直後に押したボタンが黙って失敗します / P0の形（実入力の`mouseDown`のときに立てる）にすれば、ほぼ問題なくなります。「方針変更」に一言残す程度で十分です
- 実装計画 > Phase 3 > 2 — 拒否の理由が「条件の番号」だけ / あとでログを読むときに番号の意味を引き直すことになります / `user-absent` / `agent-input` / `no-recent-input` / `agent-script`のような固定の短い名前にします（ページ由来の値を含まないのは同じ）

## Q
- 前提・わかっていること > 決定事項 > 条件4 — `scriptRan`はdocument単位なので、console.x.aiのようなSPAで、Claudeが手前の画面で一度でも`javascript_tool`を実行すると、同じdocumentのまま開いたキー発行ダイアログのコピーボタンも拒否されます。この場合、ユーザーには今と同じ「黙って何も入らない」に見えます / これを受け入れるのか、拒否したときにユーザーへ知らせるのか（例:「Claudeがこのページでスクリプトを実行したため、コピーボタンは使えません。選択して⌘Cでコピーしてください」と窓に出す）を決めないと、issue #5の場面が条件によっては直らないまま閉じることになります

````

**対応**:
- P0 Phase 4 > 2: フラグは実入力のときだけ立て、値はPhase 2の判定の結果をそのまま使い、同じ時間かユーザー不在で下ろす形に書き換えた。transient activationは条件3の代わりにしないと明記
- P1 Phase 4 > 2（javascript_tool）: 実行の前に、openerでつながったページも含めて下ろすと書き換えた（判定の結果をそのまま使うので条件は1か所）
- P1 Phase 4 > 3: 知らせはisolated worldから送り、ガードは受け口をdocument開始時に取っておく、に書き換えた。届くかの実測はPhase 1 > 4に1句足した
- P1 Phase 5 > 3 ②（マウスの口）: Phase 1 > 2に「今はEscapeキーの口しか無いので足す」を書き換えで入れた。前面を奪うときの代わりはPhase 1 > 3で決める（既存の項目）
- P1 Phase 5 > 2: 戻すのは中身がまだ検証の書いた値のときだけ・落ちても戻す・戻せない形式をVERIFY.mdに書く、に書き換えた
- P1 Phase 5 > 3（execCommandの経路）: ③に「Claudeが押した直後にrequest_user_action → タイマーのexecCommand → 変わらない」を併記した
- P1 動作確認 > 2 / Phase 2 > 2（forcedKey）: 条件1をユーザーの番か`userAtWindow`（`forcedKey`込み）で組むと書き換え、②に`agent-key-for-verify`の状態を併記、動作確認は本物のkeyで1回に減らした
- P1 Phase 1 > 3（フォーカスのエミュレーション）: 同じ項目に「AgentPageの入れ切りで消されないか」を足した
- P1 Phase 6 > 2: 案内を「文字列を選んで⌘C（動作確認で確かめてから書く）」と「前もってjavascript_toolを使わない」に書き換えた
- 見送り P1 Phase 1（OOPIFにガードが入っていない可能性）: 測定項目とfixtureの追加になるので、ループ中は足さず終了報告に回す
- 見送り P1 Phase 6 > 2の後半（ツールの説明・request_user_actionの文面に入れる）: 仕組みの追加なので終了報告に回す
- P2 Phase 2 > 2（条件1の複製）: 既存の判定を使い複製しないと書き換えた（P1と合わせて反映）
- P2 Phase 4 > 2（新しいdocumentの初期値）: P0の書き換え（実入力で立てる）で解消したので別途書かない
- P2 Phase 3 > 2: 拒否の理由を「固定の短い名前」に書き換えた
- Q 条件4のSPA: 決定事項に「知らせは今回出さない。理由はログ、案内はドキュメント。実例が出たら足す」を書いた / 根拠: kyprの前例はNemoのUI起点で出す場所があったが、ページのコピーには出す場所が無く新しいUIが要る。実装は止めない

## 2回目

````text
## P0

## P1
- 実装計画 > Phase 4 > 3 — 書き換えで「プロセスごとの乱数のイベント名」が消え、知らせをどの名前で受けるかが書かれていない / DOMのイベントは、isolated worldから送ったものもmain worldから送ったものも見分けられません（どちらも`isTrusted === false`）。名前が固定か、ページから読める名前だと、ページが同じイベントを自分で送ってフラグを立てられます。差し替えた`execCommand`の中に名前を文字列で書くと、`document.execCommand.toString()`でも読めます / 名前はプロセスごとの乱数のまま残すと明記してください。その名前は、ページが触れる関数（差し替えた`execCommand`など）の本体には書かず、受け口の登録にだけ使います。fixtureか検査に「ページが`execCommand.toString()`を読んでも名前が出てこない」を1つ足すと確実です
- 実装計画 > Phase 4 > 2 / Phase 1 > 4 — フラグはPhase 2の判定（`refusal`がisolated worldの`state`を取りに行くので非同期）の結果を待ってから立つが、間に合うかの実測が`mouseDown`だけ / キーの場合、フォーカスしたボタンをEnterで押すとkeydownの中でclick → copyまで走るので、mainの判定が間に合わない見込みが高いです。そうなると、実キーを条件3に入れていても`execCommand`の経路ではキー操作のコピーが効きません / Phase 1 > 4に「実キーの`keyDown`（Enter）でも間に合うか」を足してください。間に合わなければ、キーの経路は`writeText`だけで扱うと決定表に書きます
- 実装計画 > Phase 5 > 1 / Phase 5 > 3 ③ — ③に足した「Claudeが押した直後に`request_user_action` → 窓の中でタイマーが`execCommand('copy')`を呼ぶ」に対応するボタンがfixtureにない（あるのは遅れて`writeText`するボタンだけ）。さらに、タイマーがChromiumのactivationの5秒（envでは縮まない）を過ぎてから走ると、Nemoの判定と関係なく拒否されてPASSしてしまいます / fixtureに「遅れてタイマーで`execCommand('copy')`するボタン」を足してください。遅れは5秒より十分短くし（例: 1秒）、呼んだ時点の`navigator.userActivation.isActive`もページ内に記録します。検査では「activationが生きていたのに`false`だった」を確かめます

## P2
- 実装計画 > Phase 2 > 2 — 条件1は`userAtWindow`もユーザーの番も`findTabByWebContents`で引くので、タブに載っていないpopupの子（`agentPageOf`が「タブに載っていない popup の子も含む」と書いている側）では必ず拒否になる / OAuthなどのpopupの中にあるコピーボタンは効きません（安全側には倒れています） / 範囲外として「方針変更」に一言残すか、openerのタブの状態を見るかを、実装中に決めれば十分です
- 実装計画 > Phase 5 > 2 — 「検証が途中で落ちても戻す」の手段が書かれていない / `finally`やexitのハンドラでは、kill・クラッシュのときに戻せません / 退避した中身を使い捨てのuserDataにファイルとして置き、次に検証を始めるときに戻す（戻すのは中身が番兵のときだけ）、程度を書き添えます

## Q

````

**対応**: 収束（P0なし）。採用したP1/P2:
- P1 Phase 4 > 3: 知らせの名前はプロセスごとの乱数にし、受け口の登録にだけ使う（ページが触れる関数の本体に書かない）と書き換えた
- P1 Phase 1 > 4: 実キーの`keyDown`（Enter）でも間に合うかを測る、間に合わなければキーの経路は`writeText`だけ、に書き換えた
- P1 Phase 5 > 1: ③が使う「遅れてタイマーで`execCommand('copy')`するボタン」をfixtureに書き、遅れは5秒より短く・activationも記録する、とした（③との食い違いの解消）
- P2 Phase 2 > 2（popupの子）: 決定事項に「断る（安全側）。必要が分かれば実装中に変える」を書いた
- P2 Phase 5 > 2: 「落ちても戻す」を「失敗・例外で抜けても戻す（kill・クラッシュでは戻らない）」に正確にした
- 見送り P1 Phase 4 > 3の検査（`execCommand.toString()`に名前が出ない）: 検査の追加なので終了報告に回す
- 見送り P2 Phase 5 > 2（kill・クラッシュ後に次の検証で戻す）: 仕組みの追加なので終了報告に回す
