# Claudeのウィンドウで、ユーザーが押したコピーボタンを効かせる

## 概要・やりたいこと

issue #5。Claude in NemoのClaudeのウィンドウ（`persist:nemo-agent`）では、**ユーザーの番に自分で押したコピーボタンでも
クリップボードに何も入らない**（Nemo v1.10.18、console.x.aiのAPIキー発行ダイアログで実例）。APIトークンの発行画面は
NemoがClaudeの操作を断る＝ユーザーに渡す前提の画面なので、そこで定番のコピーボタンが効かないと引き継ぎの型が止まる。
キーはそのダイアログでしか出ないので、閉じたら作り直しになる。

ユーザーの実際の操作から起きたコピーは通し、Claudeの操作（とClaudeが仕込んだJS）から起きたコピーは今までどおり拒否する。

## 前提・わかっていること

### 原因（コードで確認済み。2026-10-16）

- `src/main/security.ts:153` `applySessionSecurityDefaults`: `label === 'agent'`のセッションは`'ui'`と同じ分岐で、
  権限の要求・確認を**タブの状態を見ずに全部拒否**する。`navigator.clipboard.writeText` / `write`の`clipboard-sanitized-write`もここ
- `src/shared/agent-page-source.js:482` `AGENT_MAIN_WORLD_GUARD`: `Document.prototype.execCommand`を差し替え、copy / cut / pasteを常に`false`で返す
  （`execCommand('copy')`はpermission handlerを通らない。planの実測）
- **planとの食い違い**: `docs/plans/2026-09-28-1126-claude-in-nemo.md:165`は「`execCommand('copy')`を無効化する。**フラグで手動時は元に戻す**」だったが、
  実装にフラグが無い。仕様判断ではなく実装漏れ
- 遷移の制限は既に「ユーザーの番か、ユーザーがウィンドウにいる（`isUserTurn || isWindowKey`）なら止めない」
  （`src/main/agent/connection.ts:71` `navigationBlocked`。同じ判定が`userPresent`として`AgentPage`に渡っている）

### 関係する既存の仕組み

- ユーザーの番・ウィンドウがkeyの間、Claudeの入力系ツールと`javascript_tool`は`assertCanInput`（`src/main/agent/tools.ts:53`）で断られる
- 実マウスの見分け: `before-mouse-event`の`mouseDown`で`cdpMouseInFlight === 0`（`src/main/agent/page.ts:161`）。CDPのマウスも
  `before-mouse-event`を発火させるので送出中フラグで除く。CDPのキーは`before-input-event`を発火させない（planの実測）
- Nemo自身がページに`sendInputEvent`を撃つのは検証専用の`pressKeyForVerify`（`src/main/ipc.ts:513`）だけ（`git grep sendInputEvent`で確認）
- 「このdocumentでClaudeが`javascript_tool`を実行した」の記録はisolated worldの`scriptRan`。判定は`src/main/agent/fill-gate.ts`の
  `refusal`（openerでつながったページもさかのぼる）。kyprの入力拒否が既に使っている
- `src/main/agent/contents.ts`は「registryをimportできない側からagentの判定を呼ぶ口」。フックが差し込まれていなければ拒否側に倒す（fail-closed）。
  `security.ts`は既にここから`isAgentContents`をimportしている
- 手で選んで⌘C: メニューの`role: 'copy'`（`src/main/menu.ts:394`）はページのJSも権限ハンドラも通らないので、コード上はコピーできるはず（**未実測**）
- Claudeのキーのcmd+c / x / vと`commands: copy/cut/paste`は`src/main/agent/keys.ts`が拒否している（今回は触らない）
- **検証スイートに「クリップボードが変わらない」の検査は無い**（issueの記述は誤り）。planの257行目で自走検証の対象外と明記してあり、
  `scripts/verify-agent.mjs:436`はcmd+vのキーを断る検査だけ。Claude側の拒否のケースも新しく足す
- `VERIFY.md`のkypr節は「実クリップボードには触らない」（`NEMO_KYPR_TEST_CLIPBOARD=memory`）。ページからのコピーはChromiumが
  システムのクリップボードに直接書くのでメモリに差し替えられない

### 決定事項（2026-10-16）

**コピーを通すのは、次の4つを全部満たすときだけ**:

| # | 条件 | 防ぐもの |
| --- | --- | --- |
| 1 | ユーザーの番か、ユーザーがウィンドウにいる（`navigationBlocked`と同じ判定。検証では`forcedKey`もウィンドウにいるとみなす） | Claudeの番のコピー全般 |
| 2 | Claudeのマウス・キーを送っている最中ではない（`cdpMouseInFlight === 0`かつ入力系ツールの実行中でない） | ユーザーがツールの途中でウィンドウに来たときの競合 |
| 3 | 直近5秒以内に、そのページに実入力がある（実マウスの`mouseDown`・実キーの`keyDown`） | ページのタイマーからのコピー（`writeText`はフォーカスさえあればクリック無しでも呼べる）。5秒はChromiumのtransient activationに合わせる |
| 4 | そのdocument（とopenerでつながったページ）でClaudeが`javascript_tool`を実行していない | 引き継ぐ前にClaudeが仕込んだタイマーで、ユーザーの番にクリップボードをすり替える経路 |

判定を当てる経路（共通の判定を足すので、呼び出し元を全部ここに書いてから実装する）:

| 経路 | 扱い |
| --- | --- |
| 権限の要求ハンドラ（`writeText` / `write`） | 4条件で判定。`clipboard-sanitized-write`以外は今までどおり拒否 |
| 権限の確認ハンドラ（`navigator.permissions.query`） | `false`のまま（確認がfalseでも`writeText`は要求ハンドラで許可できる。2026-10-16に実測。同期では条件4を判定しきれない） |
| `execCommand('copy' / 'cut')`（main worldのガード） | mainが切り替える許可フラグで通す（Phase 4）。iframe（別プロセスを含む）では常に断る（別プロセスのiframeは読み込み後に入れるので、iframeのページ自身には先回りされうる） |
| `execCommand('paste')`・`clipboard-read` | 今までどおり常に拒否 |
| Claudeのキーのcmd+c / x / v | 今までどおり拒否（`keys.ts`） |
| メニューの⌘C（手で選んでコピー） | 触らない（もともと通る見込み。人が確かめる） |

- タブに載っていないpopupの子（OAuthの小さいウィンドウ等）: 条件1を引けないので断る（安全側）。実装中に必要が分かればopenerのタブの状態を見る形に変え、「方針変更」に書く（2回目で決定）
- 条件4に当たったときの知らせ: 今回は出さない。拒否はログに理由を残し、案内はドキュメント（⌘C・前もって`javascript_tool`を使わない）で行う。SPAでは手前の画面で実行しただけで、同じdocumentのまま開いたダイアログのコピーも断られるが、受け入れる。実例が出たらウィンドウに知らせを足す（1回目で決定）

**見送った案**:
- issueの案のまま（条件1だけ）: 条件4の経路（仕込んだタイマー）が開く
- 直さずに「新しいタブで開き直して」と運用で案内する: APIキーは発行直後のダイアログでしか出ないので、開き直すと作り直しになる
- Claudeのウィンドウでもクリップボードを全面的に許す: Claudeの番のコピーボタンでターミナルに貼る中身をすり替えられる

### 参照

- issue #5（https://github.com/nyshk97/browser/issues/5）
- `docs/plans/2026-09-28-1126-claude-in-nemo.md`（調査メモ「ネイティブUI」「CDPと安全」・165行目・257行目）
- `docs/plans/2026-09-30-1323-kypr-in-claude-window.md`（`scriptRan`・`fill-gate.ts`・`contents.ts`の口の置き方）
- このリポジトリのCLAUDE.md「自走検証を足すとき」（件数の報告・`OWNERS`の広げ方）

## 実装計画

### Phase 1: 実装前の実測 [AI🤖]
- [x] 使い捨てのuserData（VERIFY.md）の素のElectronで、`writeText`が権限の要求ハンドラだけで決まるか（確認ハンドラがtrueのとき要求ハンドラを飛ばすか）を測る → 確認ハンドラの扱いを決定表に書く
- [x] 検証専用の口（`sendInputEvent`でマウスを送る。今はEscapeキーの口しか無いので足す。`NEMO_VERIFY_DIAGNOSTICS=1`のときだけ）から撃ったとき、`before-mouse-event`が`cdpMouseInFlight === 0`で飛ぶか（実クリックとして扱えるか）を測る
- [x] 検証の中で、ウィンドウの前面を奪わずにページのフォーカス（`writeText`の「Document is not focused」）を満たせる手段を決める（候補: 検証側のCDPから`Emulation.setFocusEmulationEnabled`）。`userMouseDown` → `makeWindowFocusable`がウィンドウにfocusを当てて、検証中にユーザーの作業を奪わないか、検証側で入れたフォーカスのエミュレーションが`AgentPage`のツール前後の入れ切りで消されないかも見る
- [x] `execCommand('copy')`の許可フラグを実クリックの`mouseDown`・実キーの`keyDown`（フォーカスしたボタンをEnter）で立てたとき、同じ操作のコピーに間に合うかを測る（判定は非同期）。キーで間に合わなければ、キーの経路は`writeText`だけで扱うと決定表に書く。isolated worldから送った知らせがmain worldのガードに届くかも見る（Phase 4の立て方を決める）
- [x] cross-originのiframe（別プロセスのiframe）に`AGENT_MAIN_WORLD_GUARD`が入っているか、Claudeのクリックでiframe内の`execCommand('copy')`が通るかを測る。穴があれば今回直すか範囲外として「方針変更」に書き、①のfixtureにiframeのケースを入れる

### Phase 2: 判定を1つにまとめる [AI🤖]
- [x] `AgentPage`に「最後の実入力の時刻」を持たせる（実マウスの`mouseDown`＝`cdpMouseInFlight === 0`の`before-mouse-event`、実キーの`keyDown`＝`before-input-event`）
- [x] 4条件の判定を1つの関数にする（例: `fill-gate.ts`に`clipboardWriteRefusal(wc)`）。条件1は既存の判定（ユーザーの番か`userAtWindow`＝`isWindowKey`か検証用の`forcedKey`）を使い、新しく複製しない。条件4は既存の`refusal`を使う。呼び出し側に条件を散らさない
- [x] `contents.ts`に口を足す（例: `agentClipboardWriteAllowed(wc): Promise<boolean>`。フックが無ければfalse）。`startAgent`が実体を差し込む
- [x] 5秒は定数にし、検証だけenvで縮められるようにする（`!app.isPackaged`のときだけ効く。`NEMO_KYPR_TEST_CLIPBOARD_MS`と同じ型）

### Phase 3: 権限ハンドラ [AI🤖]
- [x] `security.ts`で`'agent'`を`'ui'`の分岐から分け、`clipboard-sanitized-write`だけ`contents.ts`の口で判定する。ほかの権限・デバイスは今までどおり拒否
- [x] `permission.request`のログに`allowed`と拒否の理由（どの条件で断ったかを固定の短い名前で。ページ由来の値は出さない）を出す
- [x] 確認ハンドラはPhase 1の結果に従う

### Phase 4: `execCommand`のガード [AI🤖]
- [x] `AGENT_MAIN_WORLD_GUARD`でcopy / cutを許可フラグが立っているときだけ元の`execCommand`に通す。pasteは常に拒否
- [x] フラグはmainが立て下ろしする。**立てるのはページへの実入力（実マウスの`mouseDown`・実キーの`keyDown`）のときだけ**で、入れる値はPhase 2の判定の結果をそのまま使う（条件を2か所に分けない）。Phase 2と同じ時間がたつか、ユーザーがいなくなったら下ろす。`javascript_tool`は実行の**前に**、openerでつながったページも含めて下ろす。Chromiumがcopyに求めるtransient activationは追加の条件として残るだけで、条件3の代わりにしない（activationはClaudeのCDPのクリックでも立つので、Claudeが押した直後に`request_user_action`すると、遅れて走るページのcopyが通ってしまう）
- [x] フラグの通り道はページから見つけて立てられない形にする。mainからの知らせはisolated worldから送り（ページが差し替えたprototypeを通らない）、ガードは受け口をdocumentの開始時に手元に取っておく。知らせの名前はプロセスごとの乱数にし、受け口の登録にだけ使う（ページが触れる関数の本体に書かない。`toString()`で読める）。悪意のあるページが自分でフラグを立て、Claudeのクリックでコピーさせる経路を作らない

### Phase 5: 自走検証 [AI🤖]
- [x] `scripts/verify-agent.mjs`にfixture `/copy`を足す: `writeText`のボタン・`execCommand('copy')`のボタン・遅れてタイマーで`writeText`するボタン・遅れてタイマーで`execCommand('copy')`するボタン（遅れはChromiumのactivationの5秒より十分短くし、呼んだ時点の`navigator.userActivation.isActive`も記録する。「activationが生きていたのに拒否された」を確かめるため）。各ボタンは結果（成功 / エラー名 / `execCommand`の戻り値）をページ内に記録する
- [x] 実クリップボードを形式ごと（text / html / rtf / image）退避して、検査の後に戻す（検証専用の口。`NEMO_VERIFY_DIAGNOSTICS=1`のときだけ）。戻すのは中身がまだ検証の書いた値のときだけにし（途中でユーザーがコピーしたものを上書きしない）、検査が失敗・例外で抜けても戻す（kill・クラッシュでは戻らない）。VERIFY.mdのkypr節の「実クリップボードには触らない」と食い違うので、Claude in Nemo節に例外として書き、戻せない形式（ファイルのURL等）があることも書く
- [x] 検査を足す（「変わらない」は、ページの記録でボタンが実際に走って拒否されたことも添える。走っていないPASSにしない）:
  - ① Claudeの番に`computer`のクリックで両方のボタン → クリップボードは番兵のまま
  - ② ユーザーの番（`request_user_action`）に実クリック相当で両方のボタン → 変わる。`agent-key-for-verify`でウィンドウにいるとみなした状態でも同じ
  - ③ ユーザーの番でも、実入力から窓（envで縮めた値）を過ぎたタイマーの`writeText` → 変わらない。Claudeがボタンを押した直後に`request_user_action`し、窓の中でタイマーが走る`execCommand('copy')` → 変わらない
  - ④ `javascript_tool`を実行したdocumentでは、ユーザーの番の実クリックでも → 変わらない
  - ⑤ ユーザーの番でも`execCommand('paste')`は`false`
  - ⑥ ページが`document.execCommand.toString()`を読んでも知らせの名前が出てこない
- [x] 修正前のFAILを確認する: ②は今のmainでFAIL。①③④は条件を1つずつ外した版でFAILすることを見る。報告に修正前のFAILと修正後のPASSを並べる
- [x] `mise run verify:only agent`を回し、実行した検査の件数を報告する。`security.ts`は`OWNERS`に未登録（＝フルで回る）なので新たに載せない

### Phase 6: ドキュメント [AI🤖]
- [x] `docs/CHANGELOG.md`の`[Unreleased]`の「修正」に1行
- [x] `docs/operations.md`の「Claude Codeから操作する」: ユーザーの番はページのコピーボタンが使える。Claudeが`javascript_tool`を実行したページ（SPAでは同じdocumentのまま進んだ後の画面も）では使えないので、文字列を選んで⌘Cでコピーする（動作確認 > 3で通ると確かめてから書く）。引き継ぐページでは、前もって`javascript_tool`を使わない
- [x] `VERIFY.md`のClaude in Nemo節: 足した検査と、人が見る分
- [ ] PRでissue #5を閉じる

### 動作確認 [人間👨‍💻]
- [ ] リリース後の常用版で、Claudeのウィンドウを`request_user_action`でユーザーの番にして、GitHubのコードブロックのコピーボタン → ターミナルに貼れる
- [ ] ユーザーの番でなく、Claudeのウィンドウを自分でクリックして操作しているときもコピーボタンが効く（本物のkeyで1回。自走検証は`forcedKey`で代わりに見る）。Claudeの番の後、**最初のクリックで`execCommand`方式のボタン**（GitHubの古いコピーボタン等）も試す（`mouseDown`の時点でまだ窓がkeyでないと開かない可能性がある）
- [ ] 文字列を選んで⌘Cでコピーできる（issueの未確認の項目）

## ログ
### 試したこと・わかったこと
- 確認ハンドラが`false`のままでも、`writeText`は要求ハンドラで許可すれば通る（②がPASS）
- 検証の`sendInputEvent`のマウスは`before-mouse-event`に`cdpMouseInFlight === 0`で届き、実クリックとして扱われる。ただし検証ではウィンドウが本当にはkeyにならず、
  フォーカスのエミュレーションが無いと`writeText`が「Document is not focused」で権限の要求まで届かず、ユーザーの番のクリックは届きもしなかった
  → 押す前に検証側のCDPで`Emulation.setFocusEmulationEnabled`を入れる（間にClaudeのツールを挟まなければ`AgentPage`の入れ切りで消されない）
- `mouseDown`で開けたガードは、80ms後の`mouseUp`のcopyに間に合う。Enter（`keyDown`→`char`→`keyUp`を続けて送る）でも間に合った（検証の`sendInputEvent`で。実キーボードは未測定）。
  isolated worldから送った`Event`はmain worldのガードの受け口に届く
- 別プロセスのiframe（`localhost`と`127.0.0.1`）には`addScriptToEvaluateOnNewDocument`のガードが入らず、Claudeのクリックで`execCommand('copy')`がクリップボードを書き換えた（修正前のmainでも同じ）
- CDPの合成クリックは、別プロセスのiframeの中では座標がdevice pxの倍率（Retinaで2倍）でずれて届く
- Electron 44では`clipboard.readText()`等が非同期で、`clipboard.read()`で全形式を取れる（検証の退避・復元はこれを使う。text / html / rtf / imageに限らない）
- 修正前のFAIL: 製品の5ファイルをHEADに戻すと②の3件（writeText・execCommand・ウィンドウにいるとき）とiframeの1件がFAIL。条件3・4を外すと③のタイマーと④がFAIL。
  権限を常に許可・ガードを常に開けると①・③のexecCommand・iframeがFAIL（①③④はHEADでも拒否の理由がログに無いためFAILするが、それは証拠にしていない）

### 方針変更
- 別プロセスのiframeの穴は今回直した: `did-frame-navigate` / `did-frame-finish-load`でiframeにもガードを入れ、iframeの`execCommand('copy')`はユーザーの番でも開けない
  （開ける知らせはmain frameにだけ送る。iframeの`writeText`は権限の判定を通るので使える）。決定表にも反映。
  ただし読み込み後に入れるので、**悪意のあるiframeは先に走るスクリプトで迂回できる**（ふつうのページのコピーボタンをClaudeが押す経路を塞ぐもの。
  document開始時に入れるには`Target.setAutoAttach`が要り、agentの許可リストとkyprのiframe入力（`frame-runner`）に関わるので今回の範囲に入れない）
- ガードを閉じる契機に「ユーザーの番を戻したとき（`takeTurnBack`）」「ユーザーの番でないタブで窓がblurしたとき」を足した（実装レビュー1回目のP0。
  閉じないと、番を戻してから最大5秒はページのタイマーの`execCommand('copy')`が通り、`writeText`と結果が食い違った）
- ガードを開ける知らせはisolated worldの中で`agentActive` / `scriptRan`と排他にし、`setActive(true)` / `markScriptRan`は同じworldの中でガードも閉じる
  （mainの判定を待つ間に`javascript_tool`やClaudeの入力が割り込むと、閉じた後に開く知らせが届きえた。実装レビュー1回目）
- ガードを開ける知らせを送る直前に、同期で判定できる条件1〜3を引き直す（`clipboardRefusalNow`。実装レビュー2回目）
- 検査に「ユーザーの番を戻した直後（`resume`）に、遅れて走るページの`execCommand('copy')`を断る」を足した。`takeTurnBack`でガードを閉じる処理を外すとFAILする（2026-10-16）
- 検証専用の`pressKeyForVerify`にEnterを足し、Phase 1 > 4の実キーの実測を②の検査として残した
- ガードのshimは`Reflect.apply`・`toLowerCase`・`performance.now`を起動時に取っておき、元の`execCommand`には1回だけ文字列にした名前を渡す（ページが後から差し替えると迂回・延長できたため）
- `docs/operations.md`の「文字列を選んで⌘C」は、動作確認 > 3で確かめるまで書かない
