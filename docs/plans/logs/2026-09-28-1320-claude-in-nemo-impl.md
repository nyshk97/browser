review session: 33c1e5ac-ae52-4ea6-be3d-a19df4695558

# polish-impl

## 1回目

````text
## P0
- `src/main/agent/tools.ts:computer` / `src/main/agent/page.ts:withAgentActive`（Phase 6 > ステップ 1）— **問題**: 読み取りのアクション（`wait` / `screenshot` / `zoom`）も `withAgentActive` の中で動いています。その間はページ側の `agentActive` が true なので、ユーザーの番でも同じです。 / **なぜ問題か**: ユーザーのログイン中に Claude が `wait` や `screenshot` で様子を見るのは、よくある動きです。その最中にユーザーが打ったパスワードは `onUserValue` で捨てられ、taint も伏せ字の値も記録されません。その結果、resume の後に `javascript_tool` で `pw.value` を読めてしまいます。 / **どう直すか**: 読み取りのアクションでは `setActive(true)` を呼ばないようにします（フォーカスのエミュレーションだけ入れる）。ユーザーの番のタブでは、どのツールでも `setActive(true)` を呼ばないようにします。受け皿として、main の `before-input-event`（実キー）でもパスワード欄の taint を立ててください。
- `src/main/agent/page.ts:withAgentActive` / `installDialogOverride`（Phase 4 > ステップ 3、Phase 6 > ステップ 1）— **問題**: ツールの途中でダイアログが出ると、`finally` の中の `!this.dialog` の条件で後片付けが丸ごと飛ばされます。ダイアログに答えた後も、`agentActive=true` とフォーカスのエミュレーションが残ります。 / **なぜ問題か**: 流れはこうです。クリックで confirm が出る → handle_dialog で答える → request_user_action → ユーザーがパスワードを入れる。この順だと taint が立たず、上と同じ漏れになります。隠れた窓が 60fps で描き続けるので、CPU も食います。 / **どう直すか**: ダイアログの `answer` と `-cancel-dialogs` の中で、`activeRefs === 0` ならエミュレーションを切り、`setActive(false)` を呼んでください。
- `src/main/agent/page.ts:screenshot`（Phase 4 > ステップ 3）— **問題**: ダイアログを保留している間は `capturePageJpeg` に直行します。ここでは伏せ字の塗りがかかりません。 / **なぜ問題か**: plan は「撮る手段（CDP / `capturePage`）によらず塗る」としています。「パスワードを表示」を押した後に confirm が出ると、スクショにパスワードが写ります。 / **どう直すか**: 塗る矩形か「秘密あり」の印を、ツールを呼ぶたびに main 側へ写しておきます。保留中はその矩形を `toBitmap` した画像の上で塗ってください。塗れない場合は、スクショを断ります。
- `src/main/agent/tools.ts:readConsole`（Phase 6 > ステップ 1）— **問題**: taint が立っている間は返さないだけで、その document で溜まったエントリは `page.console` に残ります。 / **なぜ問題か**: ページを移動すると taint が解けます。すると、パスワード入力中にページが出したログ（フォームの値のデバッグ出力など）がそのまま返ります。plan の仕様は「その document の記録を捨てる」です。 / **どう直すか**: エントリに document の通し番号（`did-navigate` で増やす）を付けます。taint を見つけたら、その番号のエントリを捨ててください。前の document の taint が分からないまま cross-document の遷移をした場合も、その番号のエントリは捨てる側に倒します。
- `src/main/security.ts:installCertificateHandler`（Phase 2 > ステップ 4）— **問題**: agent のタブで証明書エラーが出ると、エージェント窓で `ask()` の確認を出してしまいます。 / **なぜ問題か**: plan は「証明書エラーも拒否」です。Claude はこの確認に答えられず、navigate は 30 秒待って終わります。背面の窓に確認が残り、あとでユーザーが手動の番の流れで通してしまうこともありえます。 / **どう直すか**: `isAgentContents(contents)` なら、聞かずに `callback(false)` を返してください。
- `src/main/agent/tools.ts:computer`（Phase 4 > ステップ 3）— **問題**: plan にある「クリックの前に `DOM.getNodeForLocation` で拡張の iframe を弾く」と「キーの前に `webContents.focusedFrame` を確かめる」が、どちらも入っていません。「見送り」にも書かれていません。 / **なぜ問題か**: 着手済みのステップに未実装が残っています。パスワードマネージャーを後から差し込む前提の防御でもあります。 / **どう直すか**: 実装して `ALLOWED_CDP` に `DOM.getNodeForLocation` を足すか、今は拡張を載せないので不要だという理由を「見送り」に書いてください。
- `src/main/agent/server.ts:startAgentServer`（Phase 3 > ステップ 1）— **問題**: 古い socket を消す条件が、ECONNREFUSED ではなく「どんなエラーでも」になっています。 / **なぜ問題か**: plan の仕様から外れています（ディレクトリが 0700 なので、実害はほぼありません）。 / **どう直すか**: `probe` で `error.code === 'ECONNREFUSED'` のときだけ `'stale'` を返してください。
- `src/main/downloads.ts:installDownloadHandler` / `src/shared/log-redact.js:sanitizeDetail`（Phase 6 > ステップ 8）— **問題**: `agent.download` のイベントがありません。「`[deep]` / `[redacted]` / `…` が出ない」ことを固定するユニットテストもありません。 / **なぜ問題か**: 着手済みのステップに未実装が残っています。 / **どう直すか**: 保存が終わったら `agent.download`（conn / bytes / ok）を出してください。agent.* の各 detail を `sanitizeDetail` に通すと値が変わらないことを確かめる `scripts/*.test.mjs` を足してください。
- `scripts/verify-agent.mjs:（スイート全体）`（Phase 4 > ステップ 6・7、Phase 5 > ステップ 8、Phase 6 > ステップ 2・9）— **問題**: チェック済みのステップにある次の検証がありません。「見送り」にも書かれていません。
  - Phase 4 > ステップ 6: CDP の許可リスト（`Target.*` / cookie / `Storage.*` 等に届かないこと。修正前 FAIL を含む）
  - Phase 4 > ステップ 7: 2 接続で窓が 2 枚になること、SIGKILL で切れたときに窓とタブの wc が消えること
  - Phase 5 > ステップ 8: 最小化から戻すとき前面を奪わないこと、CDP の入力でユーザーの番にならないこと
  - Phase 6 > ステップ 2: パスワードを入れる口に CDP から届かないこと
  - Phase 6 > ステップ 9: スクショでの伏せ字、クリップボードが変わらないこと

  **なぜ問題か**: 着手済みのステップに未実装が残っています。上の伏せ字漏れも、これらの検証があれば捕まっていました。 / **どう直すか**: 検証を足すか、「見送り」に理由を書いてください。

## P1
- `src/main/agent/connection.ts:ensureWindow` — **問題**: `this.window` を代入するのは await より前です。そのため、同時に来た 2 本目の呼び出し（サブエージェント）は、初期タブができる前の窓を受け取ります。 / **なぜ問題か**: `tabs_context` が空のタブ一覧を返したり、`tabs_create` が UI の準備前に `createTab` したりします。 / **どう直すか**: 窓の用意を Promise として持ち、2 本目以降はその Promise を待たせてください。
- `src/main/agent/connection.ts:giveTurnToUser`（Phase 5 > ステップ 3）— **問題**: 帯に出す `requestOrigin` は引き継いだ瞬間の値のままです。 / **なぜ問題か**: SSO や別ドメインへリダイレクトされても、帯は元の origin を「Nemo が確かめたサイト」として出し続けます。事実と依頼文を分けて見せる意味がなくなります。 / **どう直すか**: `syncWindowState` で、そのタブの今の `getURL()` から毎回計算してください。ユーザーの番のタブで `did-navigate` が起きたら、`syncWindowState` を呼び直します。
- `src/main/agent/page.ts:showDialogToUser`（Phase 5 > ステップ 1）— **問題**: シートを出すのは、ダイアログが来た時点でユーザーがいた場合と、`giveTurnToUser` のときだけです。 / **なぜ問題か**: Claude の番に出たダイアログは、後からユーザーが窓をクリックしても現れません。ページは固まって見えます。Claude が先に答えた場合はシートが残り、`request_user_action` を 2 回呼ぶとシートが 2 枚出ます。 / **どう直すか**: `makeWindowFocusable` の中でも、保留中のダイアログを出します。シートは 1 枚だけにし、答えが来たら閉じてください（`AbortSignal`）。
- `src/main/agent/tools.ts:computer` — **問題**: 読み取りのアクションでも `selectTab(win, tab.key)` を呼んでいます。 / **なぜ問題か**: ユーザーの番やユーザーが窓を操作している最中に、別のタブへスクショを撮ると、ユーザーの見ているログイン画面が裏へ切り替わります。 / **どう直すか**: ユーザーの番、または `isWindowKey` のときは前面を切り替えないでください。非表示タブのスクショは、エミュレーションで撮るか断ります。
- `src/main/agent/tools.ts:navigate` / `src/main/registry.ts:adoptAgentTab`（Phase 7 > ステップ 4）— **問題**: ブロックリストの判定を、back / forward の後と、popup の最初の読み込みで通していません（`will-navigate` はどちらでも発火しません）。 / **なぜ問題か**: ブロックリストに入れたホストへ、履歴や `window.open` から入れてしまいます。 / **どう直すか**: back / forward の前に行き先のエントリを判定してください。`did-start-navigation`（メインフレーム）で Claude の番なら止めます。
- `src/main/agent/tools.ts:javascriptTool`（Phase 7 > ステップ 3）— **問題**: 危ないページの判定は、main frame の URL だけで行っています。 / **なぜ問題か**: 同じ origin の別ページで `javascript_tool` を使えば、`fetch('/settings/tokens', {method:'POST'})` のような形でトークンを作れます。遷移も入力も通らない経路です。 / **どう直すか**: agent の session の `webRequest.onBeforeRequest` で、`sensitivePageKind` に当たるリクエストを Claude の番のときだけ止めてください（resourceType は問いません）。
- `src/shared/agent-page-source.js:AGENT_MAIN_WORLD_GUARD` / `AGENT_PAGE_SOURCE`（Phase 4 > ステップ 5、Phase 6 > ステップ 1）— **問題**: `addScriptToEvaluateOnNewDocument` も `executeJavaScriptInIsolatedWorld` も、別プロセスの iframe（OOPIF）には届きません。 / **なぜ問題か**: クロスオリジンの iframe では、`print()` / `showPicker` / `execCommand('copy')` が生きたままです。iframe に埋め込まれたログイン欄やカード欄（Stripe など）では、taint も塗りもかかりません。 / **どう直すか**: `frame-created` / `did-frame-navigate` で `WebFrameMain.executeJavaScript` を使って各フレームに注入してください。または `Target.setAutoAttach`（flatten）を許可リストに入れて、子のセッションにも入れます。
- `src/bridge/nemo-mcp-bridge.mjs:connectToNemo`（Phase 3 > ステップ 3）— **問題**: Nemo が再起動中で、SingletonLock はあるが socket はまだ listen していない、という状態があります。このとき待たずに、すぐ「許可されていません」を投げます。 / **なぜ問題か**: アップデートで再起動した直後の呼び出し（動作確認 5 の場面）で、間違ったエラーが出ます。 / **どう直すか**: 期限まで繋ぎ直しを続け、期限が切れた時点でまだ起動中なら「許可されていません」を返してください。
- `src/main/agent/server.ts:startAgentServer` — **問題**: `starting` の最中（`probe` を await している間）に設定を OFF にすると、`stopAgentServer` は何もせず戻ります。その後、listen が終わって `server` が入ります。 / **なぜ問題か**: 設定が OFF なのに socket が開いたままになります。 / **どう直すか**: listen の後に `getSettings().agentEnabled` を見直し、false なら閉じてください。
- `src/shared/agent-page-source.js:tree` / `pageText` — **問題**: `max_chars` の既定値が 40000 文字です。 / **なぜ問題か**: 日本語のページではおよそ 1 文字 1 トークンなので、`MAX_MCP_OUTPUT_TOKENS` の 25000 を超えます（調査の前提にある値です）。 / **どう直すか**: 既定値を 20000 前後に下げてください。
- `scripts/verify-agent.mjs:「screenshot は JPEG で返る（長辺 1568 以下）」` — **問題**: 検査名は長辺の上限を言っていますが、見ているのは JPEG の先頭バイトだけです。 / **なぜ問題か**: 名前どおりの確認になっていません。 / **どう直すか**: JPEG の SOF から幅と高さを読んで比べてください。
- `electron-builder.yml:extraResources`（Phase 3 > ステップ 3）— **問題**: plan は「tools/list はビルドで生成」ですが、実装は `agent-tools.js` を同梱して、実行時に import しています。 / **なぜ問題か**: 正本を 1 か所に置くという目的は満たしていますが、方針変更に書かれていません。 / **どう直すか**: 「方針変更」に一行足してください。

## P2
- `src/main/agent/tools.ts:fileUpload` — ファイル名が同じものを複数渡すと上書きされます。クラッシュすると `agent-upload/` が残ります。 / 別のファイルが添付されたり、ゴミが溜まったりします。 / 連番を付けてください。`startAgent` で `agent-upload/` を消してください。
- `src/bridge/nemo-mcp-bridge.mjs:request` — 応答を待つ時間に上限がありません。 / Nemo が固まると、Claude Code の idle タイムアウト（30 分）まで返りません。 / 60 秒程度で打ち切ってください。
- `src/main/agent/sites.ts:clearAgentSite` / `listAgentSites` — 一覧は cookie のあるサイトだけで、消す対象も cookie のあった host の origin だけです。 / localStorage にトークンを持つ SPA のログインが、一覧に出ず、消しても残ります。 / 将来、`clearData` の対象をサブドメインへ広げるか、storage の一覧も出すようにしてください。
- `src/main/agent/page.ts:onCdpEvent` — `read_network_requests` の URL は伏せ字にしていません。 / GET の送信やマジックリンクで、クエリに入った秘密が出ます。 / クエリの値を伏せる選択肢を足してください。
- `scripts/lib/verify-targets.mjs:OPT_IN_ONLY` — `agent` はフル実行から外れています。そのため、`registry.ts` などの配線（OWNERS に載っていない = フル）を触っても回りません。 / agent 窓の除外（履歴・セッション保存など）が壊れても気づけません。 / `registry.ts` の OWNERS に `agent` を足してください。

## Q
- `src/main/agent/tools.ts:javascriptTool` — 引き継ぎの前に `javascript_tool` でページに仕込んだコードをどう扱うかが決まっていません。たとえば、input を拾って値を変換（base64 など）してから DOM や title に書く、あるいは外へ送るコードです。taint は「引き継ぎ後に JS を断る」だけなので、この経路は塞げません。 / 決めないと、プロンプトインジェクションでパスワードが持ち出される経路が残ったままになります。取れる道は 3 つです: 「残るリスク」に明記して受け入れる / `request_user_action` のときにそのタブを再読み込みして仕込みを消す / パスワード欄のある origin では `javascript_tool` を断る。

````

**対応**:
- P0 読み取りアクションで setActive(true): 入力系ツールだけ `withAgentActive(fn, {input: true})` で agentActive を立てる形にした（wait / screenshot / zoom / read 系はエミュレーションだけ）。ユーザーの番に打った値は onUserValue が必ず記録する
- P0 ダイアログ中の後片付け漏れ: ダイアログへの答え・キャンセルの後に `settleAfterAgent`（入力中でなければ setActive(false)、エミュレーション解除）
- P0 ダイアログ保留中のスクショ: ツールのたびに「秘密あり」を main に写し（pageHadSecrets）、保留中にそのページに秘密があればスクショを断る
- P0 readConsole: taint を見つけたら記録を捨てる。cross-document の did-navigate でも記録を捨てる（前の document の分を次で返さない）
- P0 証明書エラー: agent の webContents は聞かずに拒否
- P0 DOM.getNodeForLocation / focusedFrame: 見送り（agent partition は拡張を読まず chrome-extension のサブフレームも弾いているので当たる相手がない。PM を載せるときに入れる）→ plan「見送り」に記載
- P0 server probe: ECONNREFUSED のときだけ stale
- P0 agent.download: downloads.ts で出す。agent.* の detail が sanitizeDetail で変わらないことを scripts/agent-log.test.mjs（18 件）で固定し、OWNERS に登録
- P0 verify-agent の未実装検証: 足す修正なので見送り。plan「見送り」に列挙して理由を記載
- P1 ensureWindow: 窓の用意を Promise（windowReady）で持ち、2 本目以降は待たせる
- P1 帯の origin: syncWindowState でタブの今の URL から毎回計算、ユーザーの番のタブの did-navigate で呼び直す
- P1 シート: makeWindowFocusable で保留中のダイアログを出す。シートは 1 枚、答えが来たら AbortSignal で閉じる
- P1 読み取りでのタブ切り替え: ユーザーの番・窓が key のときは前面を切り替えない
- P1 ブリッジの再起動中: 期限まで繋ぎ直しを続け、期限でまだ起動中なら「許可されていません」
- P1 server の OFF 競合: listen 後に agentEnabled を見直して閉じる
- P1 max_chars 既定: 20000 に
- P1 スクショ検査名: JPEG の SOF から幅・高さを読んで長辺 ≤1568 を検査
- P1 tools/list の生成: 方針変更に「agent-tools.js を同梱して実行時 import」と記載
- P1 ブロックリストの back/forward・popup、javascript_tool の fetch、OOPIF 注入: 足す仕組みが大きいので見送り（plan「見送り」に理由）
- P1 before-input-event の taint 受け皿: onUserValue がユーザーの番に必ず記録する形にしたので見送り
- P2 fileUpload: 1 ファイルずつ別の置き場（連番ディレクトリ）に置いて同名の上書きを防ぐ（ファイル名はサイトに見えるので変えない）。startAgent で agent-upload/ を消す
- P2 ブリッジの応答待ち: 120 秒で打ち切り（ページの読み込み待ちが 30 秒×数回ありうるので 60 秒より長め）
- P2 sites の localStorage・network URL のクエリ伏せ: 見送り（困ってから）
- P2 registry.ts を OWNERS に: 却下（未登録ファイルを載せるとフルから 1 スイートに絞られる。リポジトリ CLAUDE.md の決まり）
- Q 引き継ぎ前に仕込んだ JS: 決定「残るリスクに明記して受け入れる」/ 根拠: 再読み込み案はフォームの途中状態を消す、origin で JS を断る案は大半のログイン済みサイトで javascript_tool が使えなくなる / 反映先: plan「残るリスク」

## 2回目

````text
## P0

## P1
- `src/main/agent/page.ts:screenshot` / `withAgentActive`（Phase 4 > ステップ 3）— **何が問題か**: `pageHadSecrets` は、ダイアログが出ていないときの Claude のツール呼び出しでしか更新されません。そのため、次の順で古い値が残ります。①ユーザーの番の間に Claude が一度スクショを撮る（その時点では秘密なし）②ユーザーがパスワードを入れて「表示」を押す ③送信で confirm が出る ④Claude が様子見のスクショを撮る。④では `pageHadSecrets=false` のまま `capturePage` で撮られ、伏せ字なしの画像が返ります。 / **なぜ問題か**: plan の「撮る手段によらず伏せる」の代わりに入れた「秘密があったページでは撮らない」が、ユーザーの番に様子を見る場面（よくある場面）で効きません。 / **どう直すか**: 最後に確かめた後にユーザーがいた場合は、「秘密あり」とみなします。具体的には、`giveTurnToUser` と `makeWindowFocusable`（実クリック）で `pageHadSecrets = true` にしておきます。false に戻すのは、`did-navigate` と、ダイアログが無いときに `state` を読み直して秘密が無いと分かったときだけにしてください。
- `docs/plans/2026-09-28-1126-claude-in-nemo.md:残るリスク（受け入れる）`（Phase 7 > ステップ 3）— **何が問題か**: 2 項目目がまだ「既知の危ないページでは Nemo が書いた文面でユーザー確認を挟む」のままです。方針変更（断って `request_user_action` で頼ませる）と食い違っています。さらに、今回見送った次の 2 つが受け入れるリスクとして書かれていません。
  - `javascript_tool` の同一 origin の `fetch` で、危ないページを通らずにトークンを作れる
  - OOPIF では taint・塗り・print / copy の塞ぎが効かない

  / **なぜ問題か**: 「見送り」には書いてありますが、何を受け入れたのかを読む人が、網の位置づけ（取りこぼさない側の網であって、迂回は防がない）を誤解します。 / **どう直すか**: 2 項目目を今の方式に書き直し、上の 2 つを受け入れるリスクとして並べてください。

## P2
- `src/bridge/nemo-mcp-bridge.mjs:connectToNemo` — **何が問題か**: 起動中なのに socket が無い状態でも、待つのは `CONNECT_RETRY_MS`（3 秒）までです。 / **なぜ問題か**: アップデート後のコールドスタートでセッション復元が重いと、listen までに 3 秒を超えることがあり、そのとき「許可されていません」という間違ったエラーが出ます。 / **どう直すか**: `isRunning` が true の間だけ、待つ期限を 10 秒程度に延ばしてください。
- `scripts/agent-log.test.mjs:DETAILS` — **何が問題か**: 並べるイベントは手で書いた一覧です。 / **なぜ問題か**: 新しい `agent.*` のイベントを足したときに漏れても、テストは落ちません（今でも `agent.listen_cancelled` と `agent.window_key_restored` が入っていません）。 / **どう直すか**: `src/main` から `log('agent.` を grep してイベント名を集め、`DETAILS` に全部あることを表明するテストを足してください。

## Q

````

**対応**: P0 なしで収束。採用した P1/P2:
- P1 page.ts:screenshot — 最後に確かめた後にユーザーが来た（引き継ぎ・実クリック。`noteUserPresent`）ら、ダイアログ保留中のスクショは断る。印は Claude のツールで state を読み直したときだけ消し、遷移では消さない
- P1 plan「残るリスク」— 危ないページの項目を今の方式（断って request_user_action）に書き直し、javascript_tool の同一 origin fetch と OOPIF を受け入れるリスクとして並べた
- P2 bridge connectToNemo — 起動中で socket が無いときは 10 秒まで待つ（無いときは従来どおり 3 秒）
- 見送り: P2 agent-log.test の網羅性テスト（足す修正なので終了報告に回す）
- 動作確認 fail: verify-agent の「screenshot は長辺 1568 以下」（1 回目で SOF の実寸を見る形にした検査）が Retina で 2040x1640 を検出。CDP の `clip.scale` は device px に掛かるため、画像が Claude に伝えた 1020x820 の 2 倍になっていた（座標の換算もずれる）→ `viewport()` で `visualViewport / cssVisualViewport` の比（device px 倍率）を取り、`clip.scale` をそれで割る形に修正。修正後 65/65 PASS

## 3回目

````text
## P0

## P1
- `src/main/agent/page.ts:withAgentActive` / `screenshot`（Phase 4 > ステップ 3）— **何が問題か**: `userSinceLastCheck` は、Claude のツールが `state` を読み直すと、ユーザーがまだいる間でも false に戻ります。そのため、次の順で漏れます。
  1. ユーザーの番に、ユーザーがパスワード欄をクリックする（印が立つ）
  2. Claude が様子見のスクショを撮る（まだ入力前なので、秘密なし・印は消える）
  3. ユーザーが続けて打ち、「表示」を押す（欄はフォーカス済みなので、クリックは起きない）
  4. 送信で confirm が出る
  5. Claude がスクショを撮る → `capturePage` で伏せ字なしの画像が返る

  / **なぜ問題か**: 前回の穴が「ユーザーがクリックしてから打つまでの間に Claude が 1 回確かめた」場合に狭まっただけで、残っています。ユーザーの番に Claude が様子を見るのは想定どおりの動きです。 / **どう直すか**: 印を消す 2 か所（`withAgentActive` と `screenshot`）を `if (!this.host.userPresent())` で囲み、ユーザーの番や窓が key の間は消さないようにしてください。

## P2
- `src/main/agent/page.ts:viewport` — **何が問題か**: device px の倍率を、CDP で deprecated の `visualViewport` から取っています。無ければ 1 に倒します。 / **なぜ問題か**: Electron を上げてこの値が消えると、Retina で黙って 2 倍の画像に戻ります。そのうえ Claude に伝える寸法（`clip.width * scale`）と実際の画像がずれ、座標の換算も狂います。検査は verify-agent（OPT_IN_ONLY）にしか無いので、気づくのが遅れます。 / **どう直すか**: 無いときの代わりに、`wc.getZoomFactor() × screen.getDisplayMatching(...).scaleFactor` を使ってください。
- `src/bridge/nemo-mcp-bridge.mjs:connectToNemo` — **何が問題か**: 「起動しているのに socket が無い」ときは一律 10 秒待ちます。 / **なぜ問題か**: 設定が OFF のまま、というよくある状態でも、「許可されていません」が返るまでツール呼び出しのたびに 10 秒かかります。 / **どう直すか**: SingletonLock の pid のプロセスが起動してからの経過時間（または lock の mtime）を見て、起動直後（例: 30 秒以内）のときだけ長く待ってください。

## Q

````

**対応**: P0 なしで収束。採用した P1/P2:
- P1 page.ts:withAgentActive / screenshot — `userSinceLastCheck` を消すのはユーザーがいないとき（`host.userPresent()` が false）だけにした
- P2 bridge connectToNemo — SingletonLock の mtime から起動後の経過を取り（`runningFor`）、起動後 30 秒以内のときだけ 10 秒待つ。それ以外（設定 OFF のまま）は 3 秒で「許可されていません」。一時ディレクトリの lock で null / 経過 ms / 死んだ pid → null を確認
- 見送り: P2 viewport の deprecated `visualViewport` の代替（今の Electron では値が取れていて検査が捕まえる。代替の算出は窓のディスプレイを引く仕組みが要るので、無くなったときに入れる）
