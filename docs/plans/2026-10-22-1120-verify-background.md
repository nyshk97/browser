# 自走検証をバックグラウンドで回す（フォーカスを奪わない）

## 概要・やりたいこと

`mise run verify`（と各 `verify:*`）は Electron を子プロセスとして起動し、通常ウィンドウを `show: true` で出す。
Electron の `show()` は `activateIgnoringOtherApps:YES` を撃つので、**検証のたびに Nemo（検証用の 2 つ目）が前面に来て、
ユーザーの打鍵が検証ウィンドウに吸われる**。フル検証は数分かかるので、その間は別の作業ができない。

検証用に起動したアプリは**前面を奪わず、Dock にも出ず、見える位置に留まる**（スクショは撮れる）ようにする。
エージェント窓（Claude in Nemo）で実証済みの出し方（`show: false` → `showInactive()`。`app.focus({ steal: true })` を撃たない）を
検証用の起動全体に広げる。

背景: Nemo をベースに IDE 機能を足す fork（別計画）を作る前に、検証の往復回数が増える部分を先に直しておく。
fork は Nemo から一方向に merge する運用なので、Nemo 側で直せば fork にも届く。

## 前提・わかっていること

### 前面を奪う経路（main）

- **起動時**: `index.ts` の `whenReady` → `createWindow()` → `NemoWindow` の通常ウィンドウは `show: !hidden`。
  `hidden: true` のときだけ `whenUiReady` で `showInactive()` する経路が既にある（外部 URL で叩き起こされたときの背面復元。計画 R6）。
  `second-instance` と `activate` の `createWindow()` も同じ関数を通る
- **`app.focus({ steal: true })`**: `registry.ts` の小窓の ⌘O 昇格（`target.baseWindow.show()` → `focus()` → steal）と
  `focusEphemeralInstance`（`show()` → `focus()` → steal）、`call-coordinator.ts:447`。
  小窓（`presentMiniWindow`）とエージェント窓・会議の小窓は**撃たない**設計で、`showInactive()` + `focus()` だけ
- Electron の実装: `show()` = `activateIgnoringOtherApps:YES` + `makeKeyAndOrderFront`（前面を奪う）。
  `focus()` = `activateIgnoringOtherApps:NO`（他アプリが active なら奪わない）+ `makeKeyAndOrderFront`。
  `showInactive()` = `orderFrontRegardless`（他アプリの窓の上に重なるが key も前面も動かない。エージェント窓で実測）
- `app.setActivationPolicy('accessory')`（macOS 専用。`electron.d.ts:1642`）で Dock に出ず、起動時に自動でアクティブ化されない。
  `app.on('did-become-active')` でアプリがアクティブになった回数を数えられる（= 奪った回数の実測値）

### 検証側の前提

- アプリの起動は `verify-all.mjs` の `startApp()` が 1 回（`restart` で再起動）。`verify-agent` / `verify-autofill` / `verify-kypr` /
  `verify-auth-vault` / `verify-slots` / `verify-ext-smoke` / `verify-local-file` / `verify-shared-tabs` / `verify-session-cookies` /
  `verify-metrics` / `verify-db-migration` / `verify-session-migration` / `verify-packaged` は**自分で起動する**。
  いずれも `env: { ...process.env, NEMO_REMOTE_DEBUGGING_PORT: ... }` なので、**verify-all の `process.env` に載せれば子にも届く**
  （`runVerify` も `...process.env`）
- 単体実行の mise タスク（`verify:switcher` / `verify:migration` / `verify:db-migration` / `verify:ext` / `verify:packaged` 等）は
  verify-all を通らないので、タスクの `env` で渡す
- 検証用の裏口は **`!app.isPackaged`** でゲートする流儀（`NEMO_VERIFY_DIAGNOSTICS` / `NEMO_VERIFY_TIMINGS`。`ipc.ts:505`、`timings.ts:11`）
- CDP の入力は「一度も描画していない窓」で捨てられる（エージェント計画の実測）。`showInactive()` で出した窓は描画されるので当たらない見込み。
  key でない窓でも `document.activeElement` は動く。`document.hasFocus()`（`verify-agent.mjs:156`）と
  `Emulation.setFocusEmulationEnabled`（`verify-agent.mjs:1270, 1368` で既に使っている）は要注意
- `screencapture -l <CGWindowID>`（`scripts/lib/window-shot.mjs`）は**遮蔽されていても撮れる**（`hide()` / 最小化は撮れない。実測）。
  `showInactive()` で出した窓は遮蔽されるだけなので撮れる
- `document.visibilityState` は遮蔽で `hidden` になる（CLAUDE.md「renderer の visibilityState を PASS 条件に使わない」）。
  背面で回すと**常に遮蔽されうる**ので、残っている箇所（`verify-phase1.mjs:1852-1878`）は洗い直す
- Dock バッジ（`agent/connection.ts:535` の `app.dock.setBadge`）は accessory でも例外にならない見込み（Dock タイルが無いだけ）。
  `verify-agent` はバッジを読んでいない（`grep -n dock` が 0 件）
- 全画面に入る検査は `scripts/check-session-fullscreen.mjs`（手動の確認用）だけ。`verify-*.mjs` には無い。
  全画面は Space が切り替わって前面を奪うので、背面モードでは**入らない**（入る検査が出てきたら foreground 側へ）

### 決定

- 環境変数は `NEMO_VERIFY_BACKGROUND=1`。**verify-all が既定で立てる**（`--foreground` で外す）。ゲートは `!app.isPackaged`
- main 側は 1 モジュール（`src/main/foreground.ts`）に寄せる: `isVerifyBackground()` と、
  「前面に出す」3 行（`show()` → `focus()` → `app.focus({ steal: true })`）を 1 関数 `bringToFront(win)` にまとめ、
  背面モードでは `showInactive()` だけにして `foreground.suppressed` をログに残す。呼び出し元の分岐は残さない
- 起動時: `createWindow` で `hidden` を背面モードなら強制 true（既存の `showInactive()` 経路に乗せる）
- 奪った回数は `did-become-active` を `app.did_become_active` としてログに書き、**verify-all が最後に件数を読んで 0 でなければ FAIL**
  （「奪っていない」を実測で示す。奪われたかは目視では分からない）
- 前面が本当に要る検査は**検査単位で skip**（スイート単位で外さない）。skip は `SKIP (needs foreground)` として件数を出し、
  `mise run verify:foreground` で全部回せるようにする。どれが該当するかは Phase 2 の実測で決める（先に決めない）

## 実装計画

### Phase 1: main 側のフラグと前面抑止 [AI🤖]

- [x] `src/main/foreground.ts` を新設: `isVerifyBackground()`（`NEMO_VERIFY_BACKGROUND === '1' && !app.isPackaged`）、
      `bringToFront(win: BaseWindow)`（通常: `show()` → `focus()` → `app.focus({ steal: true })`。背面: `showInactive()` + ログ）
- [x] `index.ts`: `applyUserDataDir()` の直後、背面モードなら `app.setActivationPolicy('accessory')`。
      `did-become-active` を購読して `log('app.did_become_active', {})`（背面モードのときだけ。常用のログを汚さない）
- [x] `registry.ts`: 小窓の ⌘O 昇格と `focusEphemeralInstance` の 3 行を `bringToFront()` に置換。
      `call-coordinator.ts:447` の `app.focus({ steal: true })` も同じ関数へ（`git grep 'steal: true'` で呼び出し元を全部挙げてから）
- [x] `createWindow`: `hidden = options.hidden === true || isVerifyBackground()`（通常窓のみ。小窓・エージェント窓は元から `show: false`）
- [x] `mise run typecheck` / `mise run lint` / `mise run test`

### Phase 2: 背面モードでフル検証を回して棚卸し [AI🤖]

- [x] `verify-all.mjs`: 冒頭で `process.env.NEMO_VERIFY_BACKGROUND = '1'`（`--foreground` 指定時は立てない）。
      最後に `countLogEvents(userDataDir, 'app.did_become_active')` を出し、背面モードで 1 以上なら FAIL
- [x] `mise run verify` をフルで回す（**この run 中は別の作業をして、打鍵が吸われないことを体感でも見る**）。
      記録するもの: 全体の所要時間 / FAIL したスイートと検査名 / `app.did_become_active` の件数 / `foreground.suppressed` の件数
- [x] FAIL を 3 種に分ける: (a) 入力が届かない（focus emulation で直る見込み）/ (b) key・前面・Space に本質的に依存（skip 候補）/
      (c) `visibilityState` 等の遮蔽依存（main の実状態を見る形に直す）
- [x] 分類と件数をこの plan のログに書く

### Phase 3: 検証側の追従 [AI🤖]

- [x] (a) があれば `scripts/lib/cdp.mjs` の `connect()` に、背面モードのときだけ `Emulation.setFocusEmulationEnabled(true)` を
      送るオプションを足す（ページ target のみ。UI View に入れて挙動が変わるなら対象を絞る）
- [x] (b) は検査単位で `skipNeedsForeground(name)` のような共通ヘルパーを `scripts/lib/harness.mjs` に置いて skip し、
      件数を `SKIP (needs foreground)` として標準出力に出す。**スイート丸ごと外さない**
- [x] (c) は main の実状態（`getVisible()` 由来）を診断 IPC から返す形に直す（`verify-peek` の `peekScrim` と同じ型）
- [x] 再度フルで回し、`app.did_become_active` が 0 件・FAIL 0・skip 件数を記録

### Phase 4: mise タスクと文書 [AI🤖]

- [x] `.mise.toml`: `verify` 系の各タスクに `env = { NEMO_VERIFY_BACKGROUND = "1" }`（verify-all を通らない単体タスクのため）。
      `verify:foreground` を足す（`--foreground`。前面が要る検査を含めて全部回す。リリース前に 1 回）
- [x] `docs/operations.md` の「dev 版と常用版」の表に背面モードの行を足す。`VERIFY.md` に「背面で回る。skip される検査と
      `verify:foreground` の使いどき」を書く。CLAUDE.md の「自走検証を足すとき」に「前面が要る検査は `skipNeedsForeground` で
      印を付ける」を 1 行足す
- [x] `docs/CHANGELOG.md` には書かない（開発者向けの変更）

### 動作確認 [人間👨‍💻]

- [ ] `mise run verify` を流しながら別ウィンドウで文字を打ち続け、検証ウィンドウに文字が入らない・Space が動かないこと
- [ ] Dock に検証用の Nemo が出ないこと
- [ ] 常用の Nemo（`/Applications/Nemo.app`）の挙動が変わっていないこと（`mise run dev` の起動は従来どおり前面に出る）

## ログ
### 試したこと・わかったこと

- 2026-10-22 1 回目（Phase 1 の main 側 + verify-all の既定背面化だけ）: フル 9 分、PASS 1925 行、FAIL は `call` の
  「会議タブを見ている間は小窓が出ない」1 件（verify-call はこの検査が落ちると以降を打ち切る設計）。
  `app.did_become_active` は本体 6 回（+ 各スイートが起動した Nemo で 6 回）。6 回の直前はすべて `tab.select` か `peek.open` で、
  原因は `webContents.focus()`（Electron の `WebContents.focus()` は macOS で所属窓の `Focus(true)` を伴う）。
  `accessory` + `showInactive()` だけでは起動時の奪取しか防げない。`.focus()` の呼び出し元は main に 10 箇所
  （`baseWindow.focus()` 4・`webContents.focus()` 6）
- `verify-call` の「見えているか」は `call-coordinator.ts:106-107` で `isVisible && !isMinimized && isFocused` と定義されている。
  他アプリ作業中に小窓を出すための機能なので、key に依るのは仕様。位置の検査（`--position-plant` / `--position-read`）は
  key に依らず 1 回目でも PASS した

- 2026-10-22 2 回目（`focusContents` / `focusWindow` 導入後）: フル 8 分、PASS 1920 行。**本体のアクティブ化 0 回**（6 → 0）。
  残り 1 回は `verify-local-file` の `open -a <Electron.app> <file>`（LaunchServices が配送先を前面に出す）→ `open -g` で止める。
  新たに落ちたのは 5 件: (1) peek 2 件「Peek を開いた直後 / 閉じた後にキーフォーカスが…」は `getFocusedWebContents()` が
  背面では常に null → 背面モードでは main が `focusContents` で入れようとした先（意図）を診断に返す。
  (2) kypr 2 件「ページをクリックすると閉じる / ツールバーのアイコンを押すと閉じる」は `focusForVerify` が
  `webContents.focus()` を撃たなくなり `focus` イベント経由の `onViewFocused` が走らない → 検証用の口から直接呼ぶ。
  (3) phase1 1 件「Tab の検査のため 1 つ下の候補へ降りた — 3」（1 回目は 1）。候補行は `onMouseEnter` で選択が動く
  （`Overlay.tsx:311`）ので、`showInactive()` で**前面に被った**検証ウィンドウにユーザーの実マウスが乗ったものと判断
  → 窓は最背面（`blur()`）+ `setIgnoreMouseEvents(true)`、遮蔽で止まらないよう `setBackgroundThrottling(false)`

- 2026-10-22 3 回目（Peek の意図記録・kypr の `onViewFocused` 直呼び込み）: PASS 1926 行、Peek 2 件・kypr 2 件は直った。
  残り: phase1 の Tab 検査（3。前面に被った窓へのホバーと判断。4 回目で `presentInBackground` を見る）と、`verify-local-file` の
  open-file で 1 回アクティブ化。**`open -g` では止まらない**: 使い捨て userData で `open -g -a` / `open -a` / `open -g -j -a` /
  `open -g -b` の 4 通りを 1 起動ずつ測り、全部で `did_become_active` が 1 回（配送は 1 回ずつ成立）。LaunchServices の配送そのものが
  アプリをアクティブにするので、この 1 検査（`app.on('open-file')` の配線）だけ `skipNeedsForeground` で前面モードに回す。
  argv → second-instance の経路は同じ `accept()` に乗り、背面でも PASS している

- 2026-10-22 4 回目（最背面 + `setIgnoreMouseEvents(true)` + `setBackgroundThrottling(false)`）: **アクティブ化 0 回**（本体・各スイートの
  Nemo を含む stdout とも 0）、PASS 1923 行。FAIL 2 件: (1) Tab 検査は依然 3（実マウスのホバーではなかった。before/after と
  items 数を detail に出して切り分ける）。(2) 新規「タブができたら隠す — visible のまま」: `setBackgroundThrottling(false)` は
  Page Visibility API にも効き、View を `setVisible(false)` しても renderer の `visibilityState` が hidden にならない
  → 検査を main の実状態（`splitDiagnostics().emptyViewVisible`）に替えた（CLAUDE.md の「visibilityState を PASS 条件に使わない」と同じ方向）

- 2026-10-22 phase1 単体 ×3（Tab 検査の切り分け）: `before=3 after=3 hover=3`（Ctrl+N の前から 3。`:hover` が行 3 に立っている）
  → `setIgnoreMouseEvents(true)` を**表示前**に入れても同じ（hover=3）→ 実マウスの画面座標を診断に出したら、通った回だけ
  ポインタが窓の上端の 3px 外（cursor y=57 / 窓 y=60）にあった。**実ポインタのホバーで、`ignoresMouseEvents` では止まらない**。
  素の Electron で測ると: 画面外へ `setBounds` しても AppKit が左上 40×116px を画面内に残して押し戻す（hiddenInset / frameless /
  movable:false でも同じ）が、その状態でも `visibilityState` は visible・rAF 60fps・`capturePage` 2560×1656・`screencapture -l` 92KB
  で撮れた → 通常窓は全ディスプレイの右下の外へ park する（小窓は位置の検査があるので動かさない）。
  実験スクリプトは scratchpad（`hover-experiment.cjs` / `offscreen-experiment.cjs` / `clamp-experiment.cjs`）。
  素の Electron を Claude Code の Bash から起こすと 2 枚目以降の renderer が `bootstrap_look_up … Permission denied` で死ぬ
  （Nemo の verify は通る）ので、窓 1 枚で測った

- 2026-10-22 5 回目（通常窓を右下の外へ park）: **すべて PASS**（1925 行）、アクティブ化 0 回、Tab 検査は `before=0 after=1 hover=-1`
  （実マウスは (1172, 287)、窓は (1670, 991) に押し戻されていた）。フル 8 分。SKIP は call 本体と open-file の 2 つ。
  前面モード（`mise run verify:foreground`）のフルはまだ回していない（回すと 8 分間打鍵を吸うので、ユーザーの手が空いたときに 1 回）
- 2026-10-22 6 回目（全種の窓を park・不透明度 0 で出す・peek の待ちを直した版）: **すべて PASS**（1925 行）、アクティブ化 0 回、
  窓の露出の記録（`scripts/list-windows.swift`、0.2 秒刻み）7,439 サンプルで角（40×116 / 40×60）より大きく alpha > 0.01 の行は 0。
  `verify:only agent` も全 PASS（711 行）だが、エージェント窓が 23 秒間 1280×860 で画面中央に見えていた → `presentAgentWindow` が
  `showWindowInactive` の直後に撃つ `blur()`（orderBack）が park を「画面内に全部収める」クランプで戻していた。`showWindowAtBack` に寄せて
  `.blur()` の直呼びも `foreground.test.mjs` で落とす。直した版の `verify:only agent` は全 PASS・エージェント窓の露出 0
- 2026-10-22 `verify:only agent` に残る見える窓: 284×204 の無題の窓が約 12 秒、画面中央に出る。`screencapture -l` で撮ったら
  **About パネル**（「Nemo Dev バージョン 44.5.1」）だった。kypr の検査が Claude の `computer` の `key` で `cmd+shift+l` を送った直後に出る。
  素の Electron で再現（scratchpad `about-key-one.cjs`）: CDP の `Input.dispatchKeyEvent` を **`rawKeyDown` で text 無し**で送ると
  （Nemo の `agent/tools.ts` の `key` と同じ）、cmd+shift+l でも cmd+a でもアクセラレータに合わず About が開く（AppKit の
  `performKeyEquivalent:` が `charactersIgnoringModifiers` の空の NSEvent を、キー等価が空の先頭項目 = About に合わせる）。
  `keyDown` + `text` / `unmodifiedText` を付けると（`nativeVirtualKeyCode` は 76 のまま）アクセラレータが動き、About は開かず、
  入力欄にも文字は入らない。**背面モードとは無関係の既存のバグ**（常用でも Claude が cmd+shift+〈文字〉を送ると About が出るはず）なので、
  この計画では直さず別件にする（直すなら `keys.ts` の「text は修飾なしのときだけ」を見直し、agent スイートに「About が開かない」を足す）
- 2026-10-22 前面モードのフル（`mise run verify:foreground`）: 9 分 34 秒、PASS 1939 行。背面では飛ばしていた会議の小窓の本体と
  open-file の 2 つも PASS。落ちたのは Phase 1 の画面共有まわりの 5 件（「1 枚のときはディスプレイ選択が出ない」等）だけで、
  これは VERIFY.md に既知と書いてある「ディスプレイが 2 枚つながっていると落ちる」もの（Studio Display 接続中）。同じ 2 枚の状態で
  背面モードの `verify:only phase1` も同じ 5 件が落ちるので、前面モードとは無関係

### 方針変更

- 2026-10-22: `webContents.focus()` / `baseWindow.focus()` も `foreground.ts` に寄せた（`focusContents` / `focusWindow`。背面モードでは
  撃たない）。1 回目の実測で「起動時」より「操作中」の奪取が主だったため。直呼びは `scripts/foreground.test.mjs` で落とす
- 2026-10-22: `call` の本体（出る / 出ない）は**スイート単位で** skip にした（計画では検査単位としていた）。verify-call 自身が
  「最初の検査が落ちたら以降は全部意味を成さない」として打ち切る設計で、検査単位に割る意味が無いため。位置の検査は回す
- 2026-10-22: アクティブ化の件数は userData のログだけでなく、**子プロセスの stdout を中継しながら数える**ことにした
  （各スイートが自分で起動した Nemo も 1 つの数字に入る。スイートごとに `countLogEvents` を足す改修を 13 本に入れなくて済む）
- 2026-10-22: 画面外へ置く（park）のを通常窓だけでなく**小窓・エージェント窓・会議の小窓にも広げた**（`presentInBackground` は常に park。
  `park` オプションは消した）。5 回目のフルでアクティブ化 0 回でも、小窓 12 枚が `showInactive()` で画面上に出ていて
  「前面で回っている」ように見えたため。「小窓は位置の検査があるので動かさない」は誤りで、位置の検査（`--position-plant/read`）は
  **会議の小窓**（`call-window.ts`）のもので、しかも `call.window_created` のログの x/y（生成前に計算した位置）を見るので park に響かない。
  小窓（`kind: mini`）の位置は `miniWindowBounds()` が枚数で決めるだけで保存もしない。会議の小窓は背面モードでは `moved` の保存を
  しない（park の座標を保存位置に書かないため）。NSPanel も AppKit の押し戻しは同じ 40×116px（`clamp-panel-experiment.cjs`）。
  `showInactive()` の直呼びも `scripts/foreground.test.mjs` で落とす（`showWindowInactive` を通す）
- 2026-10-22: 「検証中に窓が一瞬出る」の正体は **`blur()`（orderOut + orderBack）の orderOut が元の位置で約 0.2 秒フェードアウトさせる**
  こと（0.2 秒刻みの窓の露出の記録 — scratchpad `tools/list-windows.swift`、CGWindowList で Electron の窓の画面内の面積と alpha を出す —
  に起動直後の通常窓が 1 回ずつ写り、素の Electron で alpha が 0.42 → 0.0007 と減るのを実測。`show-order-experiment.cjs`）。
  park を show より前に動かすと**悪化**した（hidden の窓の `setBounds` と orderBack は「画面内に全部収める」クランプで、出した瞬間に
  全部見える。710 件 PASS だが露出 1280×860 が 335 サンプル）。対策は**不透明度 0 で出して、最後に park してから 1 に戻す**
  （フェードが alpha 0 のまま進む。実測）。
  `--only peek` の FAIL（R1 の `#post-form` が null）は HEAD の版でも同じで park とは無関係。`/json/list` の url が pending 先で出るため
  about:blank の `readyState === 'complete'` を拾う競合で、`openParent` を `location.href === url` でも待つようにした
