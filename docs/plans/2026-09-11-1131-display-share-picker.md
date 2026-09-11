# 画面共有を「ディスプレイ全体の一択 + Nemo のダイアログで画面を選ぶ」に変える

## 概要・やりたいこと

Google Meet を 1 画面目（MacBook）で開き、Studio Display で作業しながら画面共有する使い方が多い。
今の画面共有は macOS のネイティブ共有ピッカー（`useSystemPicker`）に任せていて、
「このウインドウ / すべてのウインドウ / 画面全体」をバーで選ばせる。これが 2 画面だと使いづらい:

- 画面全体を共有するには、共有したい側のディスプレイのバー右上「画面全体を共有」まで
  マウスを持っていって押す必要がある（ウィンドウにホバーするとウィンドウ系の選択肢しか出ない）
- **10 秒以内に選ばないと `AbortError: Timeout starting video source` で落ちる**（実測 10002 ms）
- Meet のタブは最初のウィンドウから動かせないので、「Meet は 1 画面目に置いたまま、もう片方の
  ディスプレイを共有する」形しか成り立たない。毎回その早押しになる

やりたいこと（会話で決定）:

- macOS のピッカーはやめる。共有は**常にディスプレイ全体の一択**（ウィンドウ単位の共有は無くす）
- ディスプレイが **2 枚以上なら Nemo のダイアログで「どの画面を共有するか」を選ばせる**。
  要求元のタブが乗っているディスプレイには「Meet がある画面」と分かる印を付ける
- ディスプレイが **1 枚なら選ばせない**（同意は既存の権限ダイアログが担う）
- 同意は今までどおり Nemo の権限ダイアログ 1 回。origin 単位で記憶（シークレットはメモリ上だけ）

## 前提・わかっていること

### 今の実装（`src/main/security.ts`）

- `installDisplayMediaHandler` が `session.setDisplayMediaRequestHandler(..., { useSystemPicker: true })`。
  ピッカーが使える環境（macOS 15+）では**ハンドラ本体は呼ばれない**
- ハンドラ本体 `handleDisplayMediaRequest` はフォールバック用で、
  `decidePermission(origin, 'display-capture', ...)` → `desktopCapturer.getSources({ types: ['screen'] })` の
  `sources[0]`（主ディスプレイ）を返す。ディスプレイを選ぶ経路は無い
- 拒否は空の `Streams`（`DENY_DISPLAY_MEDIA = {}`）で、ページ側は `NotAllowedError` **と書いてあったが誤り**（実測はログ参照。`null` が正）

### Electron の `getDisplayMedia` の流れ（2026-09-11 に dev Nemo で実測）

- **`getDisplayMedia` は先に `setPermissionRequestHandler` に `permission: 'media'` として届く**。
  このとき `details.mediaTypes` は空（audio も video も無い）。ログにも `permission: "media"` で記憶されていた
- そのため今の Nemo のダイアログは **「カメラとマイク の利用を求めています」** の文言で出る
  （`PromptDialog.tsx` の `PERMISSION_LABEL.media`）。これは**元からあるバグ**で今回の機能とは独立だが、
  ピッカーをやめてハンドラが毎回走るようになると、この直後にハンドラ側の
  `decidePermission('display-capture')` で「画面の共有」の確認が**続けて 2 回出る**。同じ経路なので今回まとめて直す
- 「今後も同じ扱い」で許可すると `media` として記憶されるので、その origin の `getUserMedia`（マイク・カメラ）も
  Nemo 側の確認なしで通る（macOS 側の許可は別途出る）。記憶キーを `display-capture` に分けると直る
- 許可後にピッカーで「画面全体を共有」を押すと成功する（`video:(名前なし)` のトラック、プレビューに画面全体）。
  放置すると 10002 ms で `AbortError`。この 10 秒はピッカー待ちの間に効いているタイマーで、
  ピッカーをやめれば経路ごと無くなる（どのタイマーかは特定していない）

### macOS の「画面収録」許可（今回新たに要るコスト）

- ピッカーは OS が共有ごとに同意を取るので、Nemo.app は画面収録の TCC 許可を持っていない
  （ユーザー DB の TCC には `kTCCServiceMicrophone` / `kTCCServiceCamera` しか無い。画面収録はシステム DB 側）
- `desktopCapturer.getSources` に切り替えると **Nemo.app にシステム設定 > プライバシーとセキュリティ > 画面収録 の
  許可が要る**。未決定なら初回の `getSources` で OS のダイアログが出る。
  `systemPreferences.askForMediaAccess` は `'screen'` を受けない。
  `systemPreferences.getMediaAccessStatus('screen')` は **一度も聞かれていない状態でも `denied` を返す見込み**
  （Chromium 側が `CGPreflightScreenCaptureAccess` の真偽値を許可 / 拒否の二択に潰しているため。`not-determined` は返らない）。
  未実測なので Phase 3 の頭で実測してログに残す。**この値を `getSources` の前に見て拒否してはいけない**
  （OS のダイアログが一度も出ず、システム設定の一覧にも Nemo が載らず、永久に共有できなくなる）
- **画面収録は許可した後に macOS がアプリの再起動を求める**。初回の共有は許可しても失敗する見込みが高い。
  案内文と人間の確認手順は「許可 → Nemo を再起動 → もう一度共有」にする
- macOS 15 以降、ピッカーを使わずに画面収録するアプリには定期的に「引き続き許可しますか」のダイアログが出る。受け入れる
- 設定ペインの URL は `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
- **`mise run dev`（ターミナル起動）だと TCC のダイアログは出ない**（責任プロセスがターミナルになる。VERIFY.md の
  「マイク / カメラ / 画面共有」節）。実機確認は `open -n` でアプリとして起動するか、パッケージ版で行う

### ディスプレイの特定に使えるもの

- `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` の各 source は `display_id`（文字列）と `thumbnail` を持つ
- `screen.getAllDisplays()` の各 display は `id`（数値）・`label`（「Studio Display」「内蔵ディスプレイ」）・`bounds` を持つ。
  `String(display.id) === source.display_id` で突き合わせる
- 要求元のタブが乗っているウィンドウは `findWindowIdForPageContents(contents)`（registry.ts）→
  `windowsById.get(windowId)?.baseWindow.getBounds()`（`windowsById` は registry.ts が export 済み）。
  `screen.getDisplayMatching(bounds)` でそのディスプレイが引ける（`call-window.ts` に同じ使い方がある）
- `handleDisplayMediaRequest` は `request.frame` から `webContents.fromFrame(frame)` で WebContents を引いている（既存の `displayMediaWindowId`）

### ダイアログ基盤

- ダイアログは `src/main/prompts.ts` の `ask(windowId, prompt)` でブラウザ UI 側に出す（ネイティブダイアログは使わない。
  **自走検証で CDP から答えられる**ため）。ウィンドウごとに 1 つずつ順番に出す
- 型は `src/shared/types.ts` の `Prompt` union と `PromptAnswer` union。描画は `src/renderer/components/PromptDialog.tsx` の
  `switch (prompt.type)`。各ダイアログは `data-testid="prompt-<type>"` を持ち、自走検証はこれで種類を判定する
- 既存の `system-media` ダイアログ（OS 側で拒否されているときの案内 + システム設定への導線）は `kind: 'microphone' | 'camera'`。
  画面収録用に `'screen'` を足せる形（`SETTINGS_URL` / `SYSTEM_MEDIA_LABEL` の Record を広げる）
- ダイアログの overlay は **高さ 220px 固定**（`registry.ts` の `overlayBounds` の `case 'prompt'`）。縦に積むと 3 枚で溢れる
- 既存の `PermissionPrompt` にはキー処理も autoFocus も無く、`Overlay.tsx` はダイアログが出ている間 Esc を意図的に無視している。
  Esc を処理しないと v1.2.13/14 と同じ経路（未処理キーが NSWindow の responder chain に流れる）でフルスクリーンが解ける
- `PermissionPrompt` の「今後も同じ扱い」は既定でオン（`useState(true)`）。そのまま「許可しない」を押すと拒否が記憶される
- `PromptAnswer` は `src/main/ipc.ts` の `validateAnswer` を通る。**知らない `kind` は `throw new Error('invalid answer')`** で、
  ダイアログが閉じず `getDisplayMedia` も返らないまま止まる
- 既存の `ev`（`scripts/lib/cdp.mjs`）は `Runtime.evaluate` を `userGesture` なしで呼ぶ。Chromium は `getDisplayMedia` に
  直前のユーザー操作を求めることがあり、その場合 `InvalidStateError` でダイアログまで届かない
- 権限の記憶は `userData/permissions.json`（`JsonStore`）。消す UI は無く、ファイルを直接編集する

### 自走検証の事情

- `security.ts` / `media-access.ts` / `prompts.ts` / `PromptDialog.tsx` は `OWNERS` に**載っていない**（触ると `--changed` はフルに倒れる）。
  **今回も載せない**（CLAUDE.md: 未登録のファイルを新たに載せない）
- 権限ダイアログの検査は `scripts/verify-phase1.mjs` にある（`probe=permission` の節。overlay の `[data-testid]` を待って
  `.dialog-actions button` を押す）。同じ流儀で足す
- 検証環境ではディスプレイは 1 枚しか無い。**2 枚以上のダイアログは実ディスプレイでは作れない**ので、
  `NEMO_VERIFY_DIAGNOSTICS=1` かつ `!app.isPackaged` のときだけ生える診断 IPC で偽ディスプレイの枚数を
  節の中から切り替える（`ipc.ts` の `pressKeyForVerify` と同じゲート）。
  **起動 env では渡さない**: `verify-all.mjs` の `startApp()` は全スイートで 1 回しか起動しないので、
  env だと phase1 の「1 枚の節」の時点で 2 枚に見えてしまう
- 画面収録の TCC が dev の Electron バイナリに付いているかは環境依存。**実際にトラックが取れるかの検査は
  `getMediaAccessStatus('screen') === 'granted'` のときだけ判定し、それ以外は skip として件数に出す**
- ユニットテストは `scripts/*.test.mjs`（`node --test`）。renderer と main の両方で使う純粋関数は Node 非依存の
  `src/shared/*.js` に置く流儀（`src/shared/favorites.js` が例。`settings-schema.js` は `node:fs` に触るので renderer から import できない）

### 決定表

| ディスプレイ数 | 権限の記憶 | 出るダイアログ | 渡すもの |
| --- | --- | --- | --- |
| 1 | 無し | 権限（「画面の共有」）のみ | 唯一のディスプレイ |
| 1 | allow | 無し | 唯一のディスプレイ |
| 2+ | 無し | 権限 → ディスプレイ選択 | 選んだディスプレイ |
| 2+ | allow | ディスプレイ選択のみ | 選んだディスプレイ |
| 任意 | deny | 無し | 拒否（権限ハンドラの deny。ページ側は `NotAllowedError: Permission denied`） |
| 任意 | 任意 | 選択でキャンセル / ウィンドウが閉じた | 拒否（callback に `null`。ページ側は `AbortError: Invalid capture constraints`） |
| 任意 | 任意 | `getSources` の後で OS の画面収録が granted でない | 拒否 + `system-media`（screen）の案内 |
| 2+ | 任意 | 選んだディスプレイに一致する source が無い | 拒否（`reason: 'no_matching_source'`。**黙って別の画面を渡さない**） |

ディスプレイ選択の並び: 要求元のタブが乗っているディスプレイ**以外**を先頭に、要求元のディスプレイは末尾に
「（このタブを開いている画面）」の印を付けて出す（共有したいのはたいてい Meet が無い側）。
既定の選択（Enter）は先頭。

- 既存の `media` の記憶（Meet 等で以前「今後も同じ扱い」で許可したもの）は**消さずに残す**（1 回目で決定）。
  画面共有から来たかマイク・カメラから来たかは区別できず、Meet はどのみちマイクを許可する。
  CHANGELOG に「以前の記憶は `permissions.json` から消せる」と添える

## 実装計画

### 事前準備 [人間👨‍💻]

- [x] なし（実機確認の段階で macOS の「画面収録」の許可ダイアログに答える作業だけ発生する）

### Phase 1: `getDisplayMedia` の権限要求を「画面の共有」として扱う [AI🤖]

`setPermissionRequestHandler` に `media` + `mediaTypes` 空で届くものを `display-capture` に読み替える。

- [x] `src/shared/display-share.js`（Phase 2 と同じファイル。`electron` を import する `media-access.ts` / `security.ts` に置くと
      `node --test` から読めない）に純粋関数 `effectivePermission(permission, mediaTypes)` を足す:
      `permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0` なら `'display-capture'`、それ以外はそのまま。
      **`mediaTypes` が無い（undefined）場合も `display-capture` に倒す**のではなく、`Array.isArray` で空配列のときだけにする
      （Chromium 側で形が変わったら「カメラとマイク」の確認が出る側 = 今と同じ挙動に倒れる。デバイス名が漏れる側には倒れない）
- [x] `handlePermissionRequest` で `effectivePermission` を通した permission で `decidePermission` を呼ぶ
      （ダイアログの文言が「画面の共有」になり、記憶キーも `display-capture` になる）。
      `mediaKindsFor` は元の permission ではなく読み替え後で判定する（`display-capture` は OS のマイク・カメラを取りに行かない）
- [x] `handleDisplayMediaRequest` 側の `decidePermission('display-capture')` は**残す**が、直前の権限要求で答えた結果が
      記憶されていない（「今後も同じ扱い」を外して許可した）場合に**二度目のダイアログが出ない**ようにする:
      権限要求の allow を `contents.id` + origin で短時間（数秒）覚える一時セットを `security.ts` に持ち、
      ハンドラ側はそれがあればダイアログを飛ばす。「記憶しない許可」の粒度は「その要求 1 回」なので、
      ハンドラ側で消費（delete）する
- [x] ユニットテスト `scripts/display-share.test.mjs`（Phase 2 の純粋関数と同じファイルでよい）に
      `effectivePermission` の表: `media`+`[]` → `display-capture`、`media`+`['audio']` → `media`、`media`+`undefined` → `media`、
      `camera` → `camera`

### Phase 2: ディスプレイの選択ロジック（純粋関数） [AI🤖]

- [x] `src/shared/display-share.js`（Node 非依存）に以下を置く。型は JSDoc。
  - `orderDisplaysForShare(displays, requesterDisplayId)`: 要求元以外を先頭、要求元を末尾に `isRequester: true` を付けて返す。
    `displays` は `{ id, label, bounds }` の配列（Electron の `Display` を丸ごと渡さず、必要なフィールドだけ写す）
  - `matchSourceForDisplay(sources, displayId)`: `source.display_id === String(displayId)` の source。無ければ null
  - `needsDisplayChoice(displays)`: `displays.length >= 2`
- [x] `scripts/display-share.test.mjs`:
  - 1 枚 → `needsDisplayChoice` false
  - 2 枚で要求元が 1 枚目 → 並びは [2 枚目, 1 枚目(isRequester)]
  - 3 枚 → 要求元以外 2 枚が元の順で先頭、要求元が末尾
  - 要求元が特定できない（`requesterDisplayId` null）→ 元の順のまま、`isRequester` は全部 false
  - `matchSourceForDisplay`: 数値 id と文字列 `display_id` の突き合わせ。無いときは null
  - **`sanitizeDetail` に通しても `[deep]` / `…` が出ない**ログ detail の形（CLAUDE.md の `log()` の節）: ディスプレイ一覧を
    ログに出すなら `labels: string[]` のフラットな形にし、そのテストを入れる

### Phase 3: main 側の切り替え [AI🤖]

- [x] `installDisplayMediaHandler` から `{ useSystemPicker: true }` を外す（第 2 引数ごと消す）。
      コメントを「macOS のピッカーは使わない。理由: 2 画面で画面全体を選ぶのに 10 秒の早押しになる」に書き換える
- [x] 実測（**次の 1 つ目のステップ = `useSystemPicker` を外す、だけを入れた後に回す**。HEAD のままだとハンドラ本体に届かず
      `getSources` が呼ばれない）: `getSources` の前後で `getMediaAccessStatus('screen')` の値と経過時間を出す一時ログを入れ、
      `tccutil reset ScreenCapture com.github.Electron` → `pnpm exec electron-vite build` → `node scripts/test-server.mjs &` →
      `open -n --env NEMO_USER_DATA_DIR="$(mktemp -d)" --env NEMO_VERIFY_DIAGNOSTICS=1 --env NEMO_REMOTE_DEBUGGING_PORT=9334 node_modules/electron/dist/Electron.app --args "$PWD/out/main/index.js"`
      で起動（使い捨てプロファイル。dev の既定プロファイルや常用 Nemo に触らない）→ `media.html` の「画面共有」を押す。
      測る項目: `getMediaAccessStatus('screen')` の値（未決定でも `denied` か）/ `getSources` で OS のダイアログが出るか /
      **ダイアログが出ている間に `getSources` が返るのか、答えるまで待つのか**（`system-media` の案内文の書き方がこれで決まる）。
      結果をログの「試したこと」に残し、一時ログは消す。**この結果で 6. の並びが変わる**
- [x] `handleDisplayMediaRequest` を次の順に（OS の許可状態を `getSources` の**前**に見て拒否しない）:
  1. origin / frame / windowId を引く（既存）
  2. `decidePermission`（Phase 1 の一時セットで飛ばせる）
  3. `screen.getAllDisplays()` を `{ id, label, bounds }` に写し、要求元のウィンドウ
     （`findWindowIdForPageContents` → `windowsById.get(id)?.baseWindow`）の `getBounds()` から
     `screen.getDisplayMatching` で要求元ディスプレイ id を出す
  4. `needsDisplayChoice` なら `ask(windowId, { type: 'display-choice', origin, displays: orderDisplaysForShare(...) })` を出し、
     答えが `{ kind: 'display-choice', displayId }` 以外（キャンセル / null）なら
     `log('display_capture.request', { allowed: false, reason: 'cancelled' })` → 拒否。
     **答えの `displayId` が出した一覧に無ければ拒否**（renderer から来る値を信用しない）
  5. `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })` を取る
     （初回はここで OS の画面収録ダイアログが出る）
  6. `getSources` が空 / 例外、または macOS で `getMediaAccessStatus('screen')` が `granted` でなければ
     `log('display_capture.request', { allowed: false, reason: 'os_denied' })` → `promptSystemMediaSettings(windowId, 'screen')` を
     **待たずに**発火 → 拒否
  7. `matchSourceForDisplay` で選ぶ。**1 枚のときだけ** 見つからなければ `sources[0]`
     （`display_id` が空で返る環境の保険。ログに `reason: 'fallback_first'`）。
     **2 枚以上で見つからなければ拒否**（`reason: 'no_matching_source'`。選んでいない画面を黙って渡すと漏洩になる）
  8. `log('display_capture.request', { allowed: true, displays: displays.length, chosen: <index> })` → `{ video: source }`
- [x] **サムネイルは出さない**（`thumbnailSize` 0）。ディスプレイ名とサイズ（`bounds.width×height`）で十分で、
      サムネイルを IPC で renderer に送ると `sanitizeDetail` / ログの都合と画像の転送が増える。
      ログの detail に `labels` を出すなら Phase 2 のテストどおりフラットに
- [x] `media-access.ts`: `MediaKind`（マイク・カメラ）は**そのまま**。`system-media` のプロンプトと `SETTINGS_URL` /
      `openMediaSettings` の受け口だけ `MediaKind | 'screen'` に広げる（`SETTINGS_URL.screen` は `Privacy_ScreenCapture`）。
      `ensureSystemMediaAccess` / `mediaKindsFor` / `mediaCheckKinds` は触らない（`display-capture` は OS のマイク・カメラを取らない）
- [x] 偽ディスプレイ: `NEMO_VERIFY_DIAGNOSTICS=1 && !app.isPackaged` のときだけ生える診断 IPC で枚数を切り替える
      （主ディスプレイの複製。label は `検証用ディスプレイ n`）。偽の id は診断側で明示的に `sources[0]` に対応させる
      （7. の `no_matching_source` に落ちないように）。**パッケージ版では絶対に効かない**ことを `app.isPackaged` で塞ぐ（`timings.ts` と同じ流儀）

### Phase 4: ダイアログの型と描画 [AI🤖]

- [x] `src/shared/types.ts`:
  - `DisplayChoicePrompt { type: 'display-choice'; id; origin; displays: { id: number; label: string; width: number; height: number; isRequester: boolean }[] }` を
    `Prompt` union に足す
  - `PromptAnswer` に `{ kind: 'display-choice'; displayId: number | null }`（null = キャンセル）
  - `SystemMediaPrompt.kind` に `'screen'`
  - `PermissionKind` は既に `'display-capture'` を含む（変更なし）
- [x] `src/main/ipc.ts` の `validateAnswer` に `case 'display-choice'` を足す（`displayId` は数値か null だけ通す。
      無いと `invalid answer` で投げてダイアログが閉じない）
- [x] `src/renderer/components/PromptDialog.tsx`:
  - `case 'display-choice'` → `DisplayChoicePrompt`。`data-testid="prompt-display-choice"`。
    タイトル「{origin} と共有する画面を選んでください」。ディスプレイごとにボタン（`label` と `width×height`、
    `isRequester` なら「（このタブを開いている画面）」の添え書き）。先頭が `.primary` で autoFocus。「キャンセル」ボタン。
    **ボタンは横並び（折り返し）にして 3 枚でも overlay の 220px に収める**
  - `SYSTEM_MEDIA_LABEL.screen = '画面収録'`。`kind === 'screen'` のときは**見出しも変える**: 初回（OS の「許可しますか」が
    同時に出ている）と拒否済みのどちらでも正しい文にする。見出し「Nemo に画面収録の許可が必要です」、
    説明「システム設定 > プライバシーとセキュリティ > 画面収録 で Nemo をオンにして、Nemo を再起動してください」。
    「拒否されています」「ページを読み込み直してください」は screen では使わない
  - `PERMISSION_LABEL['display-capture']` は「画面の共有」のまま
- [x] キー操作: `DisplayChoicePrompt` の中で keydown を受け、Esc は `preventDefault` してキャンセル（修飾キー付きは素通し。
      MiniBar / Peek と同じ理由）。Enter は先頭ボタンの autoFocus によるボタン標準の動きに任せる。既存の `PermissionPrompt` は手本にならない
- [x] `DESIGN.md` にダイアログの見た目の項があれば追記（無ければ触らない）

### Phase 5: 自走検証 [AI🤖]

- [x] `scripts/verify-phase1.mjs` の権限ダイアログの節の後ろに「画面共有」の節を足す（`OWNERS` は変えない）。
      `#screen` は `userGesture: true` の `Runtime.evaluate` か `Input.dispatchMouseEvent` で押す（素の `ev` だと
      `InvalidStateError` でダイアログまで届かないことがある）:
  1. `media.html` を開いて `#screen` を押す → overlay の `[data-testid]` が `prompt-permission` で、
     `.dialog-title` の太字が **「画面の共有」**（「カメラとマイク」ではない）
  2. **「今後も同じ扱い」のチェックを外してから**「許可しない」→ ページ側が `NotAllowedError`（`#result` のテキスト。権限ハンドラの deny）。
     ダイアログが**1 つも残っていない**
  3. もう一度押す → **`prompt-permission` がもう一度出る**（2. で記憶されていない根拠）→ 「許可する」（記憶あり）→
     1 枚のときは **`prompt-display-choice` が出ない**ことを 1 秒ポーリングで確認（**`prompt-display-choice` を名指しで**判定する。
     「`[data-testid]` が何も出ない」だと `granted` でない環境で 4. の `prompt-system-media` を拾って FAIL する）
  4. `getMediaAccessStatus('screen')`（`window.nemo` の診断で読む。無ければ `NEMO_VERIFY_DIAGNOSTICS` の口に足す）で分岐し、
     **どちらの環境でも実際の検査にする**（skip にしない）:
     - `granted`: `#result` が `画面共有: OK`
     - それ以外: **`prompt-system-media` が出る**（screen 用の見出し「Nemo に画面収録の許可が必要です」）→ 「閉じる」を押す →
       ダイアログが残っていない。**閉じないとウィンドウのキューの先頭に居座り、後続の節が `[data-testid]` でこれを拾う**
  5. ログ `display_capture.request`（`countLogEvents`）: `granted` なら `allowed: true` が 1 件、それ以外は `reason: 'os_denied'` が 1 件
- [x] 偽ディスプレイの節（同じスイート内。節の頭で診断 IPC で枚数を 2 にし、節の終わりで 0 に戻して **`#stop` を押す（または
      `media.html` のタブを閉じる）**。`granted` の環境で取った画面収録のトラックを止めないと、収録インジケータが点いたまま
      後続の節と他スイートが走る。`verify-all.mjs` は触らない）:
  1. 押す → 権限は記憶済みなので `prompt-display-choice` が直接出る（直前の節で `prompt-system-media` を閉じてあることが前提）
  2. ボタンが 2 つ、先頭が「検証用ディスプレイ 1」、末尾に「（このタブを開いている画面）」の添え書き
  3. 「キャンセル」（Esc）→ ページ側は失敗（`AbortError: Invalid capture constraints`。Electron の callback(null) の挙動）、ログに `reason: 'cancelled'`
  4. もう一度押して先頭を選ぶ → 偽の id は診断側で `sources[0]` に対応させてある。判定は 1 枚の節の 4.・5. と同じ分岐:
     `granted` なら `allowed: true` とトラック取得、それ以外は `reason: 'os_denied'` と `prompt-system-media` を閉じる
- [x] **検査が実際に走った件数**を報告に出す。配線は既存の `phase1` なので新規の配線は無いが、
      節を足したあと `mise run verify:only phase1` の件数が増えていることを見る
- [x] 修正前の FAIL を見る: **`src/main/security.ts` だけ** HEAD に戻して 1.（文言）が FAIL することを確認してから戻す
      （`PromptDialog.tsx` まで戻すと型がずれる。触るファイルが多いので `git stash` は使わず、`git show HEAD:<path>` で書き戻す。
      **HEAD の `security.ts` は `useSystemPicker` なので 2. 以降に進むと macOS のピッカーが出て 10 秒止まる。
      1. の判定を見たら 2. に進まずに止める**）
- [x] `mise run test` / `typecheck` / `lint`

### Phase 6: ドキュメント [AI🤖]

- [x] `VERIFY.md` の「マイク / カメラ / 画面共有」節を書き換える: ピッカーの記述（`useSystemPicker`・バー・10 秒）を消し、
      「Nemo のダイアログで画面を選ぶ（1 枚なら出ない）」「2 枚以上は診断 IPC（`NEMO_VERIFY_DIAGNOSTICS=1` かつ未パッケージの
      ときだけ使える。実装で決めた名前を書く）で節の中から枚数を切り替えて模す」「画面収録の TCC はシステム DB 側なので
      `sqlite3` では読めない。`getMediaAccessStatus('screen')` で見る。許可後は Nemo の再起動が要る」を書く
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に:
  - 変更: 画面共有は常に画面全体。2 枚以上のディスプレイでは Nemo のダイアログでどの画面かを選ぶ。macOS の共有ピッカーは使わない
    （10 秒以内に選ばないと失敗していた）。初回に macOS の「画面収録」の許可が要り、許可後は Nemo の再起動が要る
  - 修正: 画面共有の確認ダイアログが「カメラとマイク」の文言で出ていた。許可を記憶するとマイク・カメラも確認なしになっていた。
    以前の記憶はそのまま残る（消したければ `permissions.json` から該当 origin の `media` を消す）
- [x] `CLAUDE.md`（プロジェクト）には書かない（罠の類は VERIFY.md で足りる。増えたら /retro で判断）

### 動作確認 [人間👨‍💻]

- [x] パッケージ版（または `open -n` で起動した dev ビルド）で Meet の画面共有を押す:
  - 初回に macOS の「画面収録」の許可ダイアログが出る → 許可 → **Nemo を再起動** → もう一度共有
    （許可直後の 1 回目は失敗するのが正常）
  - Studio Display を繋いだ状態: Nemo のダイアログに 2 枚が並び、Meet 側に「（このタブを開いている画面）」の印。
    Studio Display を選ぶと Meet の参加者にその画面が映る。Meet のリアクション・コメントは 1 画面目で読める
  - 外部ディスプレイなし: ダイアログは出ず、そのまま共有が始まる
- [x] 共有中に Meet の「共有を停止」で止まる。もう一度共有すると再びダイアログ（2 枚のとき）

## ログ

### 試したこと・わかったこと

- 2026-09-11 実測（`tccutil reset ScreenCapture com.github.Electron` → `open -n` の dev ビルド）:
  `getMediaAccessStatus('screen')` は未決定でも **`denied`**。`getSources` は「Failed to get sources.」で
  **即座に**失敗し（2 ms。OS ダイアログを待たない）、同時に OS の「画面収録」ダイアログ（システム設定を開く / 拒否）と
  Nemo の `system-media`（screen）が並んで出る。ユーザーがシステム設定で許可 → 再起動後は `granted` で
  `video:画面全体` のトラックが取れた
- 拒否の返し方: `callback({})` は Electron 本体で「Video was requested, but no video stream was provided」の
  **unhandled rejection** になり（verify-all の「main の例外」検査で FAIL）、ページ側も
  `AbortError: Invalid capture constraints`。本体の検証文言「streams callback must be called with **null** or a valid object」
  のとおり `null` で拒否する。`security.ts` の元コメント「空の Streams で NotAllowedError」は誤りだった
- macOS 26 は許可済みでも共有のたびに「システムプライベートウインドウピッカーをバイパスして…」の確認
  （許可 / システム設定を開く）を出すことがある。ピッカーを使わないアプリへの OS 側の確認で、「許可」で続く
- 偽ディスプレイ 3 枚 + 実 1 枚（4 ボタン）でダイアログの高さ 206px（overlay 220px）。横並びの折り返しで収まる
- `verify:only phase1`: 画面共有の節 21 件を含めて全 PASS（TCC granted の環境で回った。dev.mjs 起動でも granted だった）。
  `security.ts` だけ HEAD に戻すと「文言は『画面の共有』」が `カメラとマイク` で FAIL することを確認

- 2026-09-11 Studio Display を実際に繋いで確認（`open -n` の dev ビルド、使い捨てプロファイル）: 権限ダイアログ「画面の共有」→
  ディスプレイ選択に `Studio Display 2560×1440`（先頭・フォーカス）と `Built-in Retina Display 1710×1107（このタブを開いている画面）` が
  並び、Studio Display を選ぶと `video:画面 2`、トラックの実サイズ 5120×2880（`displaySurface: monitor`）。
  ログは `displays: 2, chosen: 0`。要求元の判定（ウィンドウは内蔵側）も合っていた

- 2026-09-11 v1.2.15 としてリリースし、Studio Display を繋いだ状態と外した状態の Meet で人間が確認して問題なし

### 方針変更

- 拒否の返し方を `{}` から **`null`** に変えた（1 回目の verify で main の unhandled rejection として FAIL。Electron 本体の検証文言が「null or a valid object」）。決定表の「拒否」の行のエラー名も実測に合わせた: 権限ハンドラの deny は `NotAllowedError`、ディスプレイ選択のキャンセルは `AbortError: Invalid capture constraints`（どちらもページ側は失敗で、`display_capture.request` のログで区別する）
- 「granted でなければ skip」（自走検証の事情）は polish-plan の 2 回目で「どちらも実検査」に変えた。実装もそのとおり（TCC の状態で分岐し、両方 check）
