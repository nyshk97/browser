# Claude のウィンドウで kypr を使えるようにする

## 概要・やりたいこと

Claude in Nemo のウィンドウ（`persist:nemo-agent`）では、kypr を**意図的に止めている**（Claude in Nemo の plan
`2026-09-28-1126-claude-in-nemo.md`・kypr の plan `2026-09-28-2232-kypr-integration.md` の「エージェント用のウィンドウでは使えない」）。
このため引き継ぎ（`request_user_action`）でログインを頼まれるたびに、パスワード・2FA コード・住所などを手で打っている。

Claude in Nemo の plan の Phase 6 で「パスワードを入れる口」（`noteCredentialsEntered`）だけ用意して呼び出し元なしにしてあったので、
ここに kypr を差し込み、**ユーザーの操作で**ログイン・ワンタイムコード・個人情報の自動入力（Jev）を Claude のウィンドウでも使えるようにする。

## 前提・わかっていること

### 決定事項（/dig-lite。2026-09-30）

| 論点 | 決定 |
| --- | --- |
| 入力を起こせるのは誰か | **ユーザーだけ**。ツールバーのアイコン（ポップアップ）・⌘⇧L・欄の下の候補・右クリックの「フォーム自動入力」。**Claude から起こす MCP ツールは足さない** |
| 「ユーザーの操作」の判定 | Nemo の UI（ポップアップ・候補の View）は CDP から届かないのでそれ自体がユーザー起点。ページ起点の入口（右クリック・欄の下の候補・⌘⇧L）は **窓が key のとき（`isWindowKey`。Claude の入力が断られている間）だけ**受ける。Claude の CDP の右クリック・クリックでメニュー・候補が出ないようにする |
| `javascript_tool` を実行したページ | **入れない**。その document で Claude が `javascript_tool` を 1 回でも実行していたら、ログイン・コード・個人情報のどれも入れず、ポップアップ等に「新しいタブで開き直してから」と出す。本当のナビゲーション（新しい document）で解ける。グローバル CLAUDE.md の「JS を入れていない新しいタブでログインを頼む」運用を Nemo 側で強制する形 |
| 範囲 | ログイン（ポップアップ・⌘⇧L・欄の下の候補）・ワンタイムコード（入力・コピー・ログイン後の自動コピー）・ポップアップからの作成 / 編集 / QR 読み取り・**個人情報の自動入力（Jev）**。**Web 版 kypr の Touch ID（`web-authenticator.ts`）は対象外のまま**（Claude のウィンドウで kypr の Web 版を開く理由が無い） |
| 伏せる値 | パスワード・ワンタイムコード・**身分証の番号**（`src/shared/autofill-schema.js` の `ProfileField.secret` の項目 = 旅券・免許証・保険証の記号・番号。kypr の `identity.ts` と揃っていることは既存のテストが見る）を `rememberAgentSecrets`（`agent/contents.ts`。旧 `noteCredentialsEntered`）に渡して read_page / get_page_text / スクショから伏せる（ページは taint され `javascript_tool` を断る）。**氏名・住所・電話・メール等は伏せない**（Claude がその先を進めるのに要る。見えることは受け入れる） |
| 伏せる順番 | **流し込む前に**伏せる値を登録し、登録に失敗したら入れない（fail-closed）。入れてから登録すると、その間の read_page・スクショで読まれうる（1 回目で決定） |
| 4 文字未満の値 | `rememberSecrets` は 4 文字未満を捨てる（ページ中の短い文字列まで塗りつぶさないため）。保険証の記号など短い身分証の値は**伏せずに入れる**ことを受け入れる（単独では価値が低い。1 回目で決定） |
| コピーで渡るコード | ログイン後の自動コピー・入力に失敗したときのコピーで、ユーザーが自分で貼ったコードは Nemo が入れていないので伏せない（使い終わった 30 秒のコード。`autocomplete=one-time-code` の欄なら既存の伏せ字が効く）。受け入れる（1 回目で決定） |
| iframe | read_page / get_page_text はメインフレームしか読まないが、スクショには iframe が写り、`maskSecrets` はメインフレームの要素しか塗らない。agent 窓では **iframe にはパスワード（`type=password` は伏せ字で描かれる）だけ入れ、コードと身分証の番号は iframe に入れない**（コードはコピーに回す。自動入力は身分証の番号の欄だけ残す）（1 回目で決定） |

### 調べてわかったこと（Nemo のコード）

- agent を弾いている箇所（外す / 条件を変える対象）:
  - `src/main/kypr/fill.ts`: `kyprTargetUrl` / `fillKyprLogin` / `fillKyprTotp` / `kyprTotpDraftFrom` / `kyprTotpFromPageQr` / `quickFillKypr` / `kyprDraftFrom` が `isAgentContents` で弾く
  - `src/main/kypr/inline.ts:58`: 欄の下の候補（`found.win.isAgent`）
  - `src/main/page-shim.ts` `registerKyprPagePreload`: **エージェント用のセッションには preload を配っていない**（欄のフォーカスの知らせが来ない）
  - `src/main/ipc.ts:838`: `kind === 'kypr' && win.isAgent` でポップアップを断る。ほかに kypr の IPC（`kyprStatus` 等）も agent 窓からは断っている（`verify-agent.mjs:270` が検査している）
  - `src/main/registry.ts:2364`: agent 窓の状態の `kypr` を null にしている（ツールバーのアイコンは `state.kypr` があれば出る）。**`Toolbar.tsx:309` の `isAgent` は拡張の `<browser-action-list>` の分岐なので触らない**（外すと通常セッションの拡張アイコンが Claude の窓に出る）
  - `src/main/menu.ts:99-101`: `AGENT_BLOCKED_COMMANDS` に `kypr-fill`（⌘⇧L）
  - `src/main/autofill/index.ts:58`: `runAutofill` が agent を `reason: 'agent'` で拒否
  - `src/main/registry.ts:1131`: agent 窓には `attachContextMenu` を付けない（CDP の右クリックでもネイティブメニューが出て残るため）
  - `src/main/kypr/web-authenticator.ts`: 対象外なのでそのまま
- `noteCredentialsEntered(wc, values)`（`src/main/agent/index.ts:166`）→ ページの isolated world の `rememberSecrets`（`src/shared/agent-page-source.js:423`）: 4 文字以上の値を覚えて伏せ、`tainted = true`。**メインフレームの `__nemoAgent` にしか届かない**（iframe の扱いは決定表）
- `isWindowKey(win)`（`src/main/agent/connection.ts:90`）: 窓が key（ユーザーが操作中）か。agent 窓は既定 `focusable: false` で、実クリックでだけ key になる
- **iframe への入力は CDP を使う**（`autofill/frame-runner.ts` の `subFrameRunner`。kypr のログイン入力 `fill.ts:7` も同じ。ポップアップを開くたびに `kyprTargetUrl` → `findTarget` でも走る）。agent 窓では agent の debugger と相乗りになり、コードから確定する問題が 2 つある:
  - agent は `ensureDebugger` で遅れて attach するので、外れている間に `subFrameRunner` が先に attach すると、`dispose` の `detach()` で agent の debugger（ダイアログの横取り・ガード）ごと外れる
  - agent の `debugger.on('message')` は `sessionId` を見ないので、auto-attach した iframe の子セッションのイベントがメインのものとして処理される
- `javascript_tool` は `src/main/agent/tools.ts:556`（`javascriptTool`）。document ごとの「実行した」記録は今は無い（taint は「ユーザーが秘密を入れた」の印で別物）
- Jev に送るのは欄の手がかりだけで値は送らない（`buildJevRequests`）。agent 窓でも普段と変わらない

### 参照

- `docs/plans/2026-09-28-1126-claude-in-nemo.md`（taint・伏せ字・「パスワードを入れる口」・debugger の方針）
- `docs/plans/2026-09-28-2232-kypr-integration.md` / `2026-09-29-0934-kypr-identity-autofill.md` / `2026-09-29-1559-kypr-totp.md`
- このリポジトリの CLAUDE.md「自走検証を足すとき」（登録と配線・`OWNERS` の広げ方・件数の報告）
- `~/Library/CloudStorage/Dropbox/dotfiles/.claude/references/secrets-in-apps.md`

## 実装計画

### Phase 1: 下地（判定と記録） [AI🤖]
- [x] 「この document で `javascript_tool` を実行した」の記録を**ページの isolated world**（`agent-page-source.js`。taint・`secrets` と同じ場所）に持ち、`state()` で返す。document が替われば自然に消えるので、main 側でナビゲーションを見張らない。main からの問い合わせ口は `agent/index.ts` に置く（registry を import できない側からも呼べるように）
- [x] kypr / 自動入力の入口で使う判定を 1 つにまとめる（例: `agentFillGate(wc, { fromPage })` → `ok` / `'agent-script'`（JS 実行済み）/ `'agent-not-key'`（ページ起点なのに窓が key でない））。**呼び出し側にフラグを散らさない**。`git grep isAgentContents` で kypr・autofill の呼び出し元を全部挙げ、下の表のどれに当たるかを書いてから差し替える
- [x] agent 窓では、記録のある document が開いたタブ（`window.open` 等）にも記録を引き継ぐ（同じオリジンなら開いた側から DOM を触れるため。polish-plan の後で決定）
- [x] 伏せる値: ログイン → パスワード、コード → コード、個人情報 → `autofill-schema.js` の `secret` の項目に当たる**実際に流し込む値**（分割欄・整形後の値）

  | 入口 | 呼び出し元 | ページ起点（key が要る） | JS 実行済みで断る | 伏せる値 |
  | --- | --- | --- | --- | --- |
  | ポップアップのログイン | `fillKyprLogin` | いいえ | はい | パスワード |
  | ⌘⇧L | `quickFillKypr`（menu.ts） | はい（キーはページに届くので） | はい | パスワード |
  | 欄の下の候補 | `inline.ts` → `fillKyprLogin(mainOnly)` | 候補を**出す**ときに key を見る | はい | パスワード |
  | コード | `fillKyprTotp` | いいえ | はい | コード |
  | ログイン後の自動コピー | `fillKyprLogin` の中 | いいえ | はい（`fillKyprLogin` の判定に含まれる） | —（決定表「コピーで渡るコード」） |
  | 右クリックの自動入力 | `context-menu.ts` → `runAutofill` | はい | はい | 身分証の番号 |
  | 作成の下書き・QR・照合 URL | `kyprDraftFrom` / `kyprTotpFromPageQr` / `kyprTargetUrl` / `kyprTotpDraftFrom` | いいえ | いいえ（読むだけ） | — |

### Phase 2: ログイン・コード [AI🤖]
- [x] `fill.ts` の `isAgentContents` の拒否を Phase 1 の判定に置き換え、**入れる先のフレームを決めて URL を照合し直したあと、流し込む直前に** `noteCredentialsEntered` で伏せる値を登録する（登録は taint を立てるので、`no-target` / `url-mismatch` で終わる前には呼ばない）。`noteCredentialsEntered` は成否を返すように変え（今は `Promise<void>` でタブが見つからなくても黙って戻る）、失敗したら入れない。iframe はパスワードだけ、コードは iframe ならコピーに回す（決定表）
- [x] ポップアップ・ツールバー: `ipc.ts:838` と kypr の IPC の agent 拒否を外す（`web-authenticator` 系は残す）。`registry.ts:2364` で agent 窓にも `kyprBadge` を渡す（`Toolbar.tsx` は触らない）
- [x] ポップアップに「このページでは Claude がスクリプトを実行したため入力できません。新しいタブで開き直してください」の表示（理由 `agent-script`）。文言は DESIGN.md の既存の kypr の文言に揃える
- [x] ⌘⇧L: `AGENT_BLOCKED_COMMANDS` から `kypr-fill` を外し、key でないときは何もしない。**Claude の `computer` の `key`（CDP）で ⌘⇧L を撃っても入らないこと**を確かめる
- [x] 欄の下の候補: `registerKyprPagePreload` を agent のセッションにも配る。`inline.ts` は窓が key のときだけ出す（Claude のクリックで候補が出ない）。候補の View がスクショ（CDP の撮影）に写らないことを確かめる
- [x] debugger の相乗り（「調べてわかったこと」の 2 つ）: agent 窓では `subFrameRunner` の前に agent の debugger を付けておき（`frame-runner` に detach させない）、agent の CDP の受け口は `sessionId` 付きのイベントを捨てる

### Phase 3: 個人情報の自動入力（Jev） [AI🤖]
- [x] `runAutofill` の agent 拒否を Phase 1 の判定に置き換え、`buildFillPlan` の結果のうち `secret` の項目に当たる値を**流し込む前に** `noteCredentialsEntered` で登録する（失敗したら入れない）。iframe では身分証の番号の欄を外して入れる（`result.documents` は件数で値を持たないので使わない）
- [x] agent 窓に右クリックのメニューを付ける。**項目は「フォーム自動入力」だけ**、窓が key でフォームの欄のときだけ出す（それ以外は空のメニューを出さない。CDP の右クリックでもメニューを出さない = 今の「ネイティブメニューが画面に残る」問題を起こさない）。「Claude のウィンドウで開く」等のほかの項目は出さない
- [x] 自動入力の結果が `kypr-locked` 等でポップアップを開く経路が agent 窓でも動くこと

### Phase 4: 検証・ドキュメント [AI🤖]
- [x] `verify-agent.mjs` の「エージェント窓には kypr を出さない」を置き換える（kypr の模擬サーバー・`NEMO_KYPR_TEST_*` を付けて起動する）:
  - ポップアップからログインを入れると入り、read_page / get_page_text / スクショにパスワードが出ない
  - `javascript_tool` を実行した document では `agent-script` で入らない。ナビゲーション後は入る
  - 窓が key でないときは ⌘⇧L・候補・右クリックが効かない（key を作れないなら `NEMO_VERIFY_DIAGNOSTICS` のときだけの口を足す）。CDP の ⌘⇧L で入らない
  - コードを入れると伏せられる
  - 自動入力で身分証の番号が伏せられ、氏名・住所は read_page に出る
  - Web 版の Touch ID は agent 窓では引き続き出ない
  - 記録のある document が `window.open` で開いたタブでも入らない
  - iframe のコードの欄ではコードを入れずにコピーに回る
  - 自動入力は iframe の中の身分証の番号の欄を空のまま残す
  - iframe に入れたあとも agent の debugger が付いたまま（ダイアログの横取りが効く）で、`sessionId` 付きのイベントを処理しない
- [x] 修正前の FAIL を確かめる（`noteCredentialsEntered` の呼び出しを外すと、**既存の伏せ字では拾えない値**（`autocomplete` の無い `type=text` の欄に入れたコード・自動入力で入れた身分証の番号）が get_page_text 等に出て FAIL。パスワードは既存の `onUserValue` / `isPasswordish` で伏せられるので対照にならない。JS 実行の判定を外すと「入らない」が FAIL）。配線を外すと検査 0 件になることも見る。件数を報告する
- [x] `OWNERS`: 既存エントリの `src/main/kypr/fill.ts`・`kypr/inline.ts`・`autofill/index.ts`・`autofill/frame-runner.ts` に `agent` を足す。`context-menu.ts`（意図してフルに倒している）・`page-shim.ts`（未登録）は載せない
- [x] `docs/operations.md`（「普段のログイン・拡張・kypr・履歴は見えない」→ kypr は使える・JS 実行後は入らない・伏せる範囲）、DESIGN.md（agent 窓のツールバー）、VERIFY.md（kypr / Claude in Nemo の節）、`docs/CHANGELOG.md` の `[Unreleased]`
- [x] Claude in Nemo の plan の「初版は呼び出し元なし」「パスワードマネージャーを agent 窓に載せるときに入れる」（`DOM.getNodeForLocation` の拡張 iframe 判定）を見直す（kypr は拡張ではなく Nemo の View なので不要のはず。ログに理由を書く）

### 動作確認 [人間👨‍💻]
- [ ] 常用版に入れ、Claude に実サイトのログインを頼む → 引き継ぎで Claude のウィンドウのツールバーの kypr（または欄の下の候補）から入れる → done → Claude が続きを進められ、Claude の返答・read_page にパスワードが出ていない
- [ ] 2FA のあるサイトで、ログイン後のコードの自動コピー / ポップアップからのコード入力が Claude のウィンドウで効く
- [ ] Claude に `javascript_tool` を使わせたページで kypr を押すと「開き直して」が出る
- [ ] Claude の番のあと、最初の実クリックで欄の下に候補が出る・右クリックで「フォーム自動入力」が出る（key の判定が間に合う）
- [ ] 会員登録などのフォームで右クリックの「フォーム自動入力」が効き、Claude がその先を進められる
- [ ] グローバル CLAUDE.md の「引き継ぎの型」を kypr 前提に書き換えるか決める（「ログインは kypr で」「JS 実行後は Nemo が断る」）

## ログ
### 試したこと・わかったこと
- 自走検証 `verify:only agent`: 92 件すべて PASS（opener の記録を足した後は 94 件。記録を外すと足した 2 件が FAIL することを見てから戻した）（kypr の検査は 21 件。うち前提 1 件）。修正前の FAIL の確認として、`contents.ts` の `rememberAgentSecrets` を素通し・`agentFillRefusal` を常に null にすると 5 件 FAIL（コード `911731` と旅券番号 `TK7654321` が read_page にそのまま出た・JS を実行したページ / そこから開いたタブ / 自動入力で入った）、`agentUserAtWindow` を常に true にすると 2 件 FAIL（key でないのに ⌘⇧L と Claude の CDP の ⌘⇧L で入り、候補も出た）ことを見てから戻した。`verify:only kypr autofill` も 106 / 149 件すべて PASS
- 「iframe に入った後も agent の debugger が外れない」は、最初ログ全体の `agent.debugger_detached` を数えて 2 件で FAIL した。iframe の前後で数え直すと 0 件（2 件はそれより前にタブを閉じたときのもの）
- 検証でページに CDP のマウスを撃つと実マウス扱い（`before-mouse-event`）で窓が本当に key になり、以降の Claude の入力が断られる。key の側は `agentKeyForVerify`（検証モードだけ）で差し替え、ページのクリックは Claude のツール経由で撃つ
- `sessionId` 付きのイベントを捨てる処理は、agent が子セッションで `Runtime.enable` しないので自走検証では撃てない（コードで担保。検査は「iframe の後も debugger が外れない・スクショが撮れる」まで）
- 候補の View がスクショに写らないこと: スクショはページの WebContents の `Page.captureScreenshot` / `capturePage` で、候補は別の WebContentsView なので構造上写らない（検査は置いていない）
- Claude in Nemo の plan の見直し: 「パスワードマネージャーを agent 窓に載せるときに入れる」とした `DOM.getNodeForLocation` の拡張 iframe 判定は不要（kypr は拡張ではなく Nemo の View で、ページの中に iframe を差し込まない）。「agent の webContents には agent モジュールしか debugger を attach しない」は崩した（kypr・自動入力の iframe が相乗りする。先に agent が付け、相乗り側は detach しない）

### 方針変更
- `noteCredentialsEntered`（agent/index.ts）は消し、`contents.ts` の `rememberAgentSecrets`（成否を返す）に置き換えた。kypr・自動入力・右クリックは registry → context-menu → autofill の import の下にいて agent の本体を import すると循環するので、判定と伏せ字の口は `contents.ts` に置き、実体（`agent/fill-gate.ts`）を `startAgent` が差し込む（差し込まれていなければ入れない）
- 「ページ起点なら key を見る」は入口ごとに見る形にした（判定関数にフラグで持たせない）: 欄の下の候補は出すとき（`inline.ts`）、右クリックはメニューを出すとき（`context-menu.ts`）、⌘⇧L は `menu.ts`。入れる関数（`fillKyprLogin` / `runAutofill`）は JS 実行の判定だけを持つ（ポップアップ・メニュー項目は CDP から押せないので、そこまで来たらユーザーの操作）
- `window.open` の扱い: 実行したときに opener でつながったページ全部に記録を付け、入れるときは opener をさかのぼって確かめる。記録を付けられなかったページ（ダイアログ待ち等）は WebContents ごと入れない
- 「JS を実行したか」の確認と taint を isolated world の中で排他にした（/polish-impl 1 回目）: `rememberSecrets` は scriptRan なら断り、`markScriptRan` は実行する document が taint なら断る。入口で見てから流し込むまでに Touch ID・Jev の待ちが挟まり、その間の javascript_tool の割り込みを見落とすため。伏せる値が無い入力は流し込む直前に確かめ直す
- opener は生まれた時点で記録する（`fill-gate.ts` の `noteAgentContentsCreated`。/polish-impl の後で決定）: 生の `wc.opener` だけだと、Claude の JS が `w.opener = null` で切る・開いた側が移動して記録が消える、の 2 つで「JS を実行したページが開いたタブ」に入ってしまう。生まれた時点で開いた側が JS 実行済みなら、子は WebContents ごと入れない。欄の下の候補は、判定を待つ間に欄から外れたら出さない（タブごとの通し番号）
- 自動入力の結果の型に `withheld`（iframe で入れなかった身分証の番号の要素数）を足した
- 将来課題: Claude の JS が Service Worker を登録していると、ナビゲーションをまたいで残るので「本当のナビゲーションで解ける」は成り立たない（ログインの POST を読める）。今の手入力の運用でも同じ穴なので今回は扱わない（polish-plan 1 回目の P2）
