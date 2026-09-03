# 野良タブのウィンドウ横断共有（Arc 風）

## 概要・やりたいこと

Arc の「サイドバーは共有データ、ウィンドウはそのビュー」を Nemo に導入する。
複数ウィンドウ（外部ディスプレイ 2 枚など）で作業するとき、ピン留め・Favorite だけでなく
**野良タブ（一時タブ）も全ウィンドウのサイドバーに同じ一覧として出す**。

- どのウィンドウで開いたタブも、他の通常ウィンドウのサイドバーに即座に現れる
- **アクティブタブの選択・ページ実体（WebContents）はウィンドウごとに独立**のまま
  （同じタブを両方で開けば別インスタンス。Arc と同じ割り切り）
- Arc の調査結果: 公式ヘルプ・Browser Company の設計メモで「共有定義 + ウィンドウごと実体化 +
  閉じたら全ウィンドウから消える」というモデルが確認済み（会話ログ参照）

## 前提・わかっていること

### 決定事項（/dig-lite）

| 論点 | 決定 |
|---|---|
| タブを閉じる（⌘W・×） | **定義ごと削除 = 全ウィンドウから消える**（Arc と同じ）。ページ自身の `window.close()` と拡張の `chrome.tabs.remove` も「タブを閉じる」の一種として同じ扱い（スクリプトが閉じられるのは自分で開いた window だけで、それは定義を持たない Peek / 小窓。実質的に踏むのは拡張のタブ削除 = ⌘W 相当。impl レビュー 1 回目で決定） |
| ウィンドウを閉じる | **定義は残す（実体のデタッチのみ）**。ウィンドウは共有サイドバーのビューにすぎず、Arc の「Never lose a tab」と同じ。一覧の伸びは定義基準の自動アーカイブが受け持つ（1回目レビューの Q で決定） |
| 同じ定義を複数ウィンドウで実体化 | **許容する**（復元時も含む）。まさにユーザーが Arc で気に入った挙動（2 枚のディスプレイで同じタブを開き、片方は非アクティブ表示）。重複回避ロジックは書かない（1回目レビューの Q で決定） |
| 共有の除外 | シークレット・mini（小窓）は不参加。mini は ⌘O 合流時点で共有入り（現行の昇格挙動のまま） |
| 通話タブ | **ガードする**。別ウィンドウで参加中（call-coordinator が joined 判定）のタブを選択したら実体化せず、そのウィンドウへフォーカスを移す。プローブが読めない縮退中も `joinedAt` が残る限りガードは**諦めない**（sleep 除外が縮退中も守り続けるのと同じ保守側の方針。逃げ道は参加中ウィンドウでの操作。impl レビュー 1 回目で決定） |
| 「タブを新規ウィンドウへ」 | メニュー・⌘⇧N を廃止（導線はメニューバーのみで renderer からの呼び出しはゼロ）。Blank Window 相当は作らない。内部関数 `moveTabToWindow` は mini の ⌘O 昇格用に残す |
| 定義への書き戻し | ナビゲート・タイトル変化のたびに定義の url/title を上書き（最後に触った実体が勝ち）。実体化済みの他ウィンドウは**選択時に定義の現在 URL へ追随**する（2026-09-03 の plan「共有タブの選択時追随」で「乖離を許容」から変更。以下の追随の行を参照）。**既知の競合**: 実体化（`openEphemeral` → `createTab`）の初回コミットも書き戻すので、その数十 ms の間に他ウィンドウが進めた新しい URL を巻き戻しうる。追随と組むと、進めた側が次にその行を選んだ瞬間に古い URL へ引かれる（復旧は「戻る」のみ）。人間のクリックでは踏めないが、自走検証では実体化後に読み込み完了を待つ（`openEphemeralIn`）。塞ぐなら `materialize` が読んだ URL の初回コミットだけ url の書き戻しをスキップする |
| 追随の発火タイミング | **`selectTab` の 1 点のみ**（既にアクティブな行の再クリックを含む）。ライブ追随・ウィンドウフォーカス時の追随はしない。両ディスプレイ同時表示中の乖離は行の再クリックで解消する |
| 追随の発火経路 | `selectTab` を通る**全経路**で有効（サイドバー・スイッチャー・ペインクリック・タブを閉じた後の次タブ選択・`moveTabToWindow`・セッション復元・`focusEphemeralInstance`）。経路別の抑止フラグは作らず、抑止はすべて追随述語の条件で表現する |
| 追随条件 | `tab.ephemeralId` あり、かつ `normalizeStoredUrl(tab.url)` が定義の現在 URL と**不一致**（`null` なら追随しない）。定義側は `normalizeStoredUrl` を通った値なので、実体側も同じ正規化を通してから比較する（生比較だと表記割れ・4096 文字超で毎回不一致になる）。`null` ガードが file: 等の非 http/https 除外を兼ねる |
| 追随と通話ガード | `callWatcher.isJoined(tab)` の実体は追随しない。追随は「参加中の実体を別 URL へ飛ばす新経路」であり、既存ガード（二重実体化防止）が防いでいた通話切断をすり抜ける。ガード自身の `focusEphemeralInstance` も `selectTab` を呼ぶので必須 |
| 追随と beforeunload | 追随起点の遷移では離脱確認ダイアログを**出さず**、ページが止めたら乖離のまま静かに残す（次の選択でまた試みる） |
| 追随と sleep 復帰 | `materialize()` の読み込み URL は「ephemeralId 持ちで、手元の URL（`pendingUrl ?? this.url`）が `normalizeStoredUrl` を通る（`null` でない）ときだけ定義の現在 URL 優先」。述語は追随側と同じ 1 つ。file: を見たまま寝たタブは手元の URL を優先する。定義 URL を採用したら `this.url` にも反映し、直後の `selectTab` の追随判定を不一致にしない（二重ロード防止） |
| 追随と履歴・「戻る」 | 追随はリロードでなく通常の遷移として履歴に積む（「戻る」で乖離側のページに戻れる）。乖離側への逃げ道は「戻る」のみで追加 UI は作らない。追随後の「戻る」も通常の遷移として定義へ書き戻す（定義は戻った側の URL になり、他ウィンドウは次の選択でそちらへ追随する。書き戻さないと戻った直後の選び直しで再追随が起き、戻る操作が即座に取り消される） |
| 追随の適用範囲 | ephemeral のみ。pinned / favorite は対象外（ナビゲーションで定義 URL を更新しないので「追随先の現在 URL」が無い） |
| 並び順 | 共有定義側で 1 本持ち、全ウィンドウ同一。**順序は定義の追加順（新規・昇格は末尾）で、並べ替え UI は今回作らない**（現行の一時タブ一覧にも並べ替えは無い。2回目レビューで決定） |
| 分割・Peek・アクティブ選択・MRU | ウィンドウローカルのまま（変更しない） |
| マイグレーション | 初回起動で既存 `session.json` の全ウィンドウの野良タブを結合して共有ストアへ |

### アーキテクチャ方針

**ピン留め / Favorite で既に 2 回実装済みの「共有定義層 + ウィンドウごと実体化」を、
野良タブへ 3 回目として適用する。** 本質的な変更は 1 点だけ:
**野良タブの「正」が `NemoWindow.tabs` から共有ストアへ反転**し、
各ウィンドウの `tabs` はそのウィンドウでの実体化キャッシュになる。

- 「1 つの WebContentsView を 2 ウィンドウに同時表示」は Electron の View 親子モデル上
  **不可能**なのでやらない。同じ定義を 2 ウィンドウで開けば WebContents が 2 つできる
- ウィンドウ／View レイアウト層（`layout()` / `applyVisibility()` / z 順）には手を入れない

### 調査で判明している現状（Explore 調査、ファイル:行つき）

- タブ実体はウィンドウ所有: `NemoWindow.tabs: NemoTab[]`（`registry.ts:1147`）、
  「タブは必ず 1 ウィンドウに所属」が土台の不変条件（`registry.ts:94-106`）。
  グローバルなタブレジストリは無く、全タブ走査は `windowsById` の二重ループ
- `NemoTab.key = randomUUID()`（`registry.ts:504`）、`view: WebContentsView | null`（null = sleep）
- アクティブ選択は完全にウィンドウごと: `activeTabKey`（`registry.ts:1148`）、
  可視は `visibleTabKeys`（アクティブ + 分割相方 + Peek、`registry.ts:1747`）→ **ここは変更不要**
- 共有定義のお手本（そのまま流用できる型）:
  - ストア: `store/pins.ts` の `JsonStore` + `onPinsChanged`（`pins.ts:48-56`）
  - 全ウィンドウ配信: `onPinsChanged(() => 全 win.pushShared())`（`registry.ts:3486-3503`）
  - 実体化: `openPinned(win, id)`「そのウィンドウに既にあれば選択、無ければ作る」（`registry.ts:3354-3375`）
  - 定義削除の全ウィンドウ波及: `demoteEverywhere()`（`registry.ts:3190-3210`）
  - renderer 側は共有一覧を描画し、`state.tabs` から「このウィンドウで開いているか」を導出
    （`Sidebar.tsx:41-56` の `openPinnedIds` パターン）
- 所属の正規化は `resolveTabOwnership`（`src/shared/tab-ownership.js:44`、純関数）を
  `createTab` が必ず 1 回通す（`registry.ts:2229-2243`）
- 野良タブの永続化は現在**ウィンドウ単位**: `toSaved()`（`registry.ts:1938-1976`、
  `pinnedId === null && favoriteId === null` のタブのみ）→ `collectSession()`（`:3623`）→
  `store/session.ts`（`session.json`）。復元は `index.ts:258-296`（`asleep: true` で枠だけ作る）
- ウィンドウを閉じると `destroy()` が全タブを close（`registry.ts:1978-2020`）。
  ⌘⇧T スタックはグローバル 1 本（`registry.ts:2643-2650`）、`resolveReopen`（`tab-ownership.js:118`）
- 自動 sleep / 自動アーカイブはウィンドウ単位ループ: `sweepSleep()`（`:3526`）/ `sweepArchive()`（`:3565`）
- IPC はタブ操作を「送信元ウィンドウ所有か」で検証: `requireTab()`（`ipc.ts:219-227`）→
  実体操作はこのまま。定義 ID を受ける口は `nemo:open-pinned` と同じ形で足す
- 通話状態はタブ単位で全ウィンドウ横断把握済み: call-coordinator の `CandidateState.state`
  （'candidate' | 'joined'、`call-coordinator.ts`）
- mini の昇格: `promoteForegroundView`（`registry.ts:2609`）→ `mostRecentNormalWindow` → `moveTabToWindow`
- 「タブを新規ウィンドウへ」の導線: `keybindings.js:79-84`（⌘⇧N）と `menu.ts:207` のみ。
  preload の `moveTabToNewWindow`（`ui.ts:49`）は renderer から未使用
- mini では `MINI_BLOCKED_COMMANDS`（`menu.ts:56-69`）が該当コマンドを遮断

### プロジェクト固有の注意（CLAUDE.md より）

- 新スキーマの正規化は `src/shared/settings-schema.js` に置く（`JsonStore(..., normalize)` の型）。
  renderer からは import できない（`ext-lock.js` → `node:fs`）が、一時タブ定義は
  `SharedState` 経由で届くので renderer 側 import は不要の見込み
- 定義へタブ状態を写すときは、イベント時だけでなく**割り当て時点でタブが既に持っている
  title / favicon も写す**（mini 昇格・⌘D の既知の罠）
- `log()` の detail はフラットに（`MAX_DEPTH=4`）、URL は先頭 scheme のみ伏せ字
- 検証スイートは**登録**（`verify-targets.mjs`）と**配線**（`verify-all.mjs`）の両方。
  配線を外して 0 件になることを見てから戻す。実行件数を報告に出す。
  既存モジュール（`registry.ts` / `ipc.ts` / `session.ts` 等）を触るので **OWNERS の既存エントリを広げる**
- 移行の検証は**旧フォーマットの fixture を置いてから起動する別建て**にする
  （まっさら検証では移行経路を一度も通らない）。同じ fixture で 2 回起動して冪等性まで見る

## 実装計画

### Phase 1: 共有定義ストアとスキーマ [AI🤖]

- [x] `src/shared/settings-schema.js` に一時タブ定義の正規化を追加
  （`EphemeralTabDef { id, url, title, customTitle, faviconUrl, lastActiveAt }` + 並び順は配列順。
  既存の `normalizePins` と同じ流儀。url は `normalizeStoredUrl` を通す）
  - **定義を持てるのは http/https のタブだけ**。`about:blank`（⌘T 直後）や拡張ページは
    定義を作らず**ウィンドウローカルのタブ**のまま扱い、サイドバーには Phase 4 の
    ローカル併記で出す。最初の http/https ナビゲーションの時点で定義化する
- [x] `src/main/store/ephemeral-tabs.ts` を新設（`pins.ts` のサブセット:
  `JsonStore` + `onChanged` リスナ + add / remove / updateFromTab（url・title・favicon の書き戻し）。
  並べ替え API は作らない — 決定表参照）
  - 書き戻しはナビゲーションごとに飛んでくるので、`commit` は**値が変わったときだけ**通知し、
    通知はデバウンスで合流させる（ピン定義の「ユーザー操作でしか変わらない」前提と違い、
    素通しだと 1 ページ読み込むたびに全ウィンドウへ `SharedState` 丸ごとが数回飛ぶ）
- [x] `index.ts` の初期化・終了処理に組み込み（`initPins` / `closePins` と並べる。
  `JsonStore` はデバウンス保存なので `before-quit` で flush）
- [x] 正規化のユニットテスト（既存の schema テストの型に合わせる。
  `sanitizeDetail` を通しても壊れないログ detail のケースを含める）

### Phase 2: registry の統合（定義 ↔ 実体の接続） [AI🤖]

- [x] `NemoTab` に `ephemeralId: string | null` を追加、`toState()` にも出す
  （`pinnedId` / `favoriteId` / `ephemeralId` の 3 者排他）
- [x] `resolveTabOwnership` に第 3 の ID として組み込み（純関数テストも拡張）
- [x] `createTab`: 通常ウィンドウで所属なしの http/https タブを作ったら**その場で定義も作る**
  （タブが既に持つ title / favicon を写す）。about:blank 等は定義なしで作り、
  **最初の http/https ナビゲーションで定義化**する。シークレット・mini では定義を作らない
- [x] `promotePeek`（Peek の ⌘O 昇格、`registry.ts:2580-2598`）でも定義を作る
  （`createTab` を通らず `win.tabs` の並べ替えだけの経路。現在の url / title / favicon を写す。
  漏らすとどのサイドバーにも出ない不可視タブになる）。
  順序の正が定義配列へ移るので、「末尾へ動かす」も定義配列側で行う（新規追加 = 末尾で自然に満たせる）
- [x] ピン留め / Favorite との**転換**を定義層に接続:
  - 降格（`demoteEverywhere` :3190、ピン解除・Favorite 解除・`applyConversion`）:
    定義を **1 本だけ**作り、全ウィンドウの降格実体をその 1 本に束ねる
    （実体ごとに作ると同じ URL の行が N 本並ぶ）
  - 昇格（`assignDefinition` :3170、⌘D / ピン留め）: ephemeral 定義を削除する。
    **実体は閉じない**（波及なし。同じタブが 2 層に出るのを防ぐだけ）
  - Live Folder に降格処理は無い（PR タブはただの一時タブで、`Sidebar.tsx` の URL 一致で
    隠れているだけ）。共有定義に移った後も **Phase 4 の URL 一致除外だけで足り、何もしない**
- [x] `openEphemeral(win, defId)`: そのウィンドウに実体があれば `selectTab`、
  無ければ定義の url から `createTab(win, url, { ephemeralId })`（`openPinned` :3354 のコピー）
- [x] 書き戻し: ナビゲーション・タイトル変化・favicon 更新・**名前変更（`renameTab` :3391 の
  `customTitle`）**のイベントで `ephemeralId` 持ちタブから定義を上書き
  （既存の title / favicon 書き戻し経路に相乗り。customTitle を定義に移さないと
  他ウィンドウに出ず再起動でも消える）
- [x] **「実体のデタッチ」と「定義の削除」を別関数に分ける**:
  - 定義を消すのは `removeTab`（⌘W・タブ行の×・close-ephemeral IPC）と
    定義基準の自動アーカイブ**だけ**。削除は `removeEphemeralEverywhere(defId)`
    （`demoteEverywhere` :3190 の型。全ウィンドウの該当実体を close してから定義を消す）
  - **「定義削除は 1 回、実体 close は N 回」**。波及 close 中の `removeTab` が
    `ephemeralId` を見て再び定義削除へ回る**再入**を内部フラグで止め、
    `rememberClosedTab`（⌘⇧T スタック・アーカイブ記録）も **1 回だけ**通す
    （素通しだと 2 ウィンドウで開いていたタブを閉じたとき ⌘⇧T に 2 件・ライブラリに同じ行が 2 つ積まれる）
  - `destroy()`（ウィンドウを閉じる）・`moveTabToWindow`（mini 昇格）は**デタッチのみ**。
    ここが定義削除に合流すると「ウィンドウ A を閉じたら B のタブが全滅」になる（決定表参照）
- [x] mini ⌘O 昇格（`promoteForegroundView`）: 合流先が通常ウィンドウなので、
  移動完了時に定義を作る（このときもタブの現在 url / title / favicon を写す）
- [x] 自動 sleep はウィンドウ単位のまま（実体の話なので変更不要）。
  自動アーカイブ（`sweepArchive` :3565）は**定義基準**へ:
  - 定義の `lastActiveAt` を正とする（実体があれば全実体の最大値で更新。
    実体が 1 つも無い定義は自身の `lastActiveAt` で普通に老化する —
    「全実体が閾値超え」のような全称条件は**実体ゼロで空虚に真**になるので使わない）
  - 除外条件（`visibleTabKeys` / `isCurrentlyAudible` / `isSleepExempt`）は
    **全ウィンドウ横断の OR** で取る（B で見ているタブを A 基準で消さない）
  - **実体ゼロの定義にもアーカイブ経路を作る**: 現行は `removeTab` 内の
    `rememberClosedTab` / `archiveTab` が `NemoTab` を要求するため、未実体化の定義は
    そのままだと**記録を残さず黙って消える**（自動アーカイブの約束「閉じるが
    ライブラリから掘り返せる」が破れる）。定義の url / title から直接アーカイブへ記録し、
    ⌘⇧T スタックにも現行の自動アーカイブと同様に積む。
    既存の「アーカイブは `removeTab` に任せる（経路を 1 本に）」という不変条件が
    変わるので、コメントも更新する
- [x] `createTab` の定義作成は「呼び出し側が `ephemeralId` を**渡していないときだけ**」に限定する。
  渡したのに `resolveTabOwnership` が落とした（duplicate 等）場合は**新しい定義を作らず**
  理由をログに残す（黙って「所属なし」に流れると同じ URL の定義が増殖する）
- [x] ⌘⇧T: 閉じた定義（url / title / customTitle）をスタックへ。
  `resolveReopen` は「定義を作り直して現在のウィンドウで実体化」に再定義（純関数テスト更新）

### Phase 3: セッション保存・復元の反転とマイグレーション [AI🤖]

- [x] `session.json` スキーマ変更（`normalizeSession`）: `SavedWindow` から `tabs` を外し、
  `activeEphemeralId`・`bounds`・`splits`（定義 ID の組）だけ残す。バージョンを上げる。
  アクティブがピン / Favorite だった場合は保存しない（復元は先頭定義へ倒す。現行の
  `Math.max(findIndex, 0)` と同等）
  - **実体を持たないウィンドウも bounds があれば全部復元する**（現行 `normalizeSession` の
    「タブ 0 のウィンドウを捨てる」間引きは落とす。新モデルでは実体ゼロのウィンドウは
    共有一覧のビューとして正常な状態。決定表「ウィンドウを閉じても定義は残す」と筋が通る）
- [x] マイグレーション: 旧版の `SavedWindow.tabs` は **`normalizeSession` が `legacyTabs` として
  保持して返す**（外してしまうと、`initSession` が読み込み直後に正規化後の値を書き戻すため、
  移行コードが走る前に旧タブが session.json から消えて**やり直し不可の全消失**になる）。
  共有ストアへ移し終えてから落とす。冪等判定は **`legacyTabs` の有無**で行う
  （旧版を読んだときだけ付くフィールドなので版番号の代わりになる。`JsonStore.load()` は
  `normalize` に版番号を渡さない契約なので、版番号での判定は現行契約では書けない）。
  移行を終えたら**その場で `saveNow()` で確定させる**（`markCleanExit` の前例。
  デバウンス保存任せだと移行直後に落ちたとき次回起動で再移行 = 定義の二重登録になる）
  - 全ウィンドウの野良タブを**出現順に結合**して移す（重複 URL もそのまま。
    タブは URL の実体なので重複排除しない）。`lastActiveAt` もそのまま持ち込み、
    移行直後の行数の伸びは定義基準の自動アーカイブに素直に任せる（間引きは書かない）
  - **移行はウィンドウ復元より前に終える**（`index.ts` の呼び出し順:
    ephemeral ストア初期化 → `initSession`（移行込み） → 復元。
    後だと初回起動でサイドバーが空のまま立ち上がり、その状態が保存される）
- [x] 復元（`index.ts:258-296`）: ウィンドウ生成後、**アクティブ定義と分割の構成員だけ**
  `asleep: true` で実体化する（全定義を全ウィンドウに実体化しない）。
  複数ウィンドウが同じ定義をアクティブにしていた場合はそのまま両方で実体化する（決定表参照）。
  それ以外の定義はサイドバーに出るだけで、クリック時に `openEphemeral` で実体化
- [x] `toSaved()` / `collectSession()` から野良タブ本体の収集を外す
- [x] `scripts/settings-schema.test.mjs` の `normalizeSession` ケースを更新
  （版 2 / 旧版の両方から `legacyTabs` が出ること、移行後の再読み込みでは付かないこと。
  移行の唯一の純関数テストなので、既存ケースを削って通さない）
- [x] **Phase 3 の反転は Phase 4 と同じ区切り（1 コミット）で落とす**。
  反転だけ先に入れると「renderer がまだ `state.tabs` 由来」の中間状態で
  再起動するとサイドバーからタブが消え、途中の自走検証が使えない
- [x] 移行検証: 既存の `scripts/verify-session-migration.mjs`（旧版 fixture で実起動する
  専用スイート）に今回の旧版 fixture のケースを足した:
  版 4（分割）に加え、**版 4 複数ウィンドウ**（全ウィンドウの野良タブの結合順・
  ウィンドウごとの activeEphemeralId・2 回目起動の冪等）。
  **同じ fixture で 2 回起動して冪等**（定義が二重登録されない）まで見る

### Phase 4: 配信と renderer [AI🤖]

- [x] `SharedState`（`types.ts:386-405`）に `ephemeralTabs` を追加、
  `sharedState()`（`registry.ts:1893`）で詰める。シークレットウィンドウには渡さない
  （`liveFolder` を private に渡さない既存パターン :1899）
- [x] ストア変更 → 全ウィンドウ `pushShared()` の配線（`registry.ts:3486-3503` に 1 行追加）
- [x] `Sidebar.tsx`: 一時タブ一覧を **1 本の `useMemo`** に畳む:
  `shared.ephemeralTabs` があればそれを正とし、**`ephemeralId` を持たない
  ウィンドウローカルのタブ（about:blank・拡張ページ）を常に一覧の末尾に併記**する
  （定義化後も末尾 = 新規追加の位置なので行が飛ばない）。
  シークレットは `ephemeralTabs` が来ないので従来どおり `state.tabs` 由来に倒れる
  （private 専用分岐を別に書かない）。`state.tabs` は「このウィンドウで実体化済みか /
  アクティブか」の装飾に使う（`openPinnedIds` :41-56 と同型）。
  **別ウィンドウで開いている定義は Arc 風に非アクティブの見た目**で出す
  - 現行の 2 規則を共有ソースでも再現する（`Sidebar.tsx:80-88` のコメントに明記された既知の事故）:
    **Live Folder の URL 一致除外**（`normalizePrUrl`）と、
    **分割中の結合行はウィンドウローカルの `state.tabs` から重ねて優先**
- [x] 未実体化の定義行（このウィンドウに `tab.key` が無い行）で許す操作は
  **クリック（open）・×（close）** の 2 つに限定し、
  他（rename・分割・copy-url 等）は実体化後にのみ出す
  （`TabRow` / `RowMenu` は `tab.key` 前提なので、ここを曖昧にすると行コンポーネント全体に波及する）
- [x] IPC: `nemo:open-ephemeral`（defId）/ `nemo:close-ephemeral`（defId）を追加
  （`nemo:open-pinned` の形）。**シークレットウィンドウからの呼び出しは弾く**
  （共有の除外という不変条件を IPC 層にも置く）。preload `ui.ts` と `NemoUiApi` に追加。
  既存のタブ行操作（実体があるときの選択・×）は `requireTab` 経路のまま

### Phase 5: 通話ガードとメニュー整理 [AI🤖]

- [x] 通話ガード: 対象定義の実体が**別ウィンドウで joined** なら、
  **開く側**（`openEphemeral`）は実体化せずそのウィンドウ・タブへフォーカスを移し、
  **閉じる側**（未実体化ウィンドウからの × / close-ephemeral）は削除を拒否して同じくフォーカスを移す
  （開くだけガードして × 一発で通話が切れるのでは目的と矛盾する。
  拒否が無反応に見えないよう、開く側と同じフォーカス移動を見え方として使う）。
  `log('call.guarded', { defId, action: 'open' | 'close' })` のフラットな detail で残す
  （開く/閉じるどちらを止めたかログで区別できるように）。
  タブ単位の joined 判定の口は実装時に call-coordinator 側へ足す
- [x] `move-tab-to-new-window` をキーバインド定義（`keybindings.js:79-84`）・
  `menu.ts` の分岐・`MINI_BLOCKED_COMMANDS`・IPC（`ipc.ts:341`）・preload から削除
  （`moveTabToWindow` 本体は mini 昇格用に残す）

### Phase 6: 自走検証・仕上げ [AI🤖]

- [x] 新スイート `verify-shared-tabs` を**登録と配線の両方**に追加。
  配線を外した状態で 1 回回して「検査 0 件」を見てから戻す
- [x] 検査項目（2 ウィンドウ立てて CDP で確認）: **34 件 PASS**
  - ウィンドウ A で開いた野良タブが B のサイドバーに出る（url / title 一致）
  - B でクリックすると B に実体化し、A の実体と独立に動く（アクティブ選択が独立）
  - A でナビゲートすると未実体化の B 側一覧の url / title が追随する
  - どちらかで閉じると**両方から消える**（直前に両方に出ていたことも検査 = 0 件検査の空振り防止）
  - 2 ウィンドウで実体化していたタブを閉じたとき、**⌘⇧T 1 回**で戻る（波及 close の重複記録検知。
    アーカイブは URL で UPSERT されるため「1 行だけ」は原理的に検査にならず、⌘⇧T 側で担保する）
  - ウィンドウ A を閉じても定義は残る（B の一覧に残り、新しいウィンドウを開くと出る）
  - `about:blank` のローカル行は他ウィンドウに出ず、最初の http ナビゲーションで共有一覧に現れる
  - 2 ウィンドウで開いていたピン留めを解除すると、共有一覧に行が **1 本だけ**増える
    （実体ごとに定義を作っていないことの検知）
  - 昇格の付け替えで他ウィンドウの実体は**分割が解かれてから**ピン定義へ付く
  - アクティブがピン留めだったウィンドウは復元で**先頭定義へ倒す**（空状態にしない）
  - シークレット・mini のタブが共有一覧に**出ない**
  - mini ⌘O 昇格で共有一覧に**入る**
  - ⌘⇧T で閉じた共有タブが定義ごと戻る
  - 再起動で共有一覧と各ウィンドウのアクティブが復元される
- [x] 移行 fixture 検査（Phase 3）は既存の `verify-session-migration` スイート側に足した（26 件 PASS。版 4 → 版 5 の移行・複数ウィンドウの結合・冪等・saveNow 確定を含む）
- [x] ~~`OWNERS` の既存エントリを広げる~~ → 今回触った既存ファイルは
  **どれも OWNERS に載っていない**（registry.ts などは意図的に未登録 = フル倒し）ため、
  広げる対象なし。新規の `scripts/verify-shared-tabs.mjs` → `['shared-tabs']` だけ登録した
- [x] 既存スイートがフルで通ることを確認: **フル自走検証 834 件 PASS / 0 FAIL（exit 0）**。ユニットテスト 378 件 PASS・typecheck / lint クリーン
- [x] `docs/operations.md` に共有モデルの節を追記（閉じる = 全ウィンドウ、ウィンドウを閉じても定義は残る、除外、通話ガード）。ドキュメント・コード内の用語は codebase に合わせ**「一時タブ」に統一**する（本 plan の「野良タブ」は会話由来の別名）
- [x] `docs/CHANGELOG.md` の `[Unreleased]` に追記

### 動作確認 [人間👨‍💻]

- [ ] 常用 Nemo（更新後）でディスプレイ 2 枚にウィンドウを並べ、
  野良タブの共有・独立アクティブ・閉じたら両方から消える、を体感で確認
- [ ] 他ウィンドウで開いたタブが自分の一覧の末尾に割り込んでくる感覚が邪魔でないか
  （全ウィンドウ共通の並び順で一番体感が変わる箇所。気になるなら方針変更を検討）
- [ ] Meet 参加中に別ウィンドウで同じタブを選択 → 二重参加せずフォーカスが移ることを確認

## ログ

### 試したこと・わかったこと

- 配線を外した状態で `verify:only shared-tabs` を回し、**検査 0 件のまま「すべて PASS」で exit 0**
  になることを確認してから配線した（CLAUDE.md の登録/配線の罠の実証）
- 自走スイートから `close-window` を**その窓の UI の invoke で await するとハングする**
  （応答が返る前に WebContents ごと破棄される）。`setTimeout` で発火だけして応答を待たない形にした
- 自走スイートは Live Folder を設定 fixture（`liveFolderEnabled: false`）で止める。
  止めないと使い捨てプロファイルでも `gh` の実トークンで実 GitHub を叩く
- spike の「chrome.storage.local が再起動をまたいで残る」がフルでだけ落ちた。原因は
  `swSession()` が「最初に見つかった SW」を拾うため、書き込みと読み出しで**別の拡張**に
  繋がる順序依存のフレーク（共有モデルで起動時の実体化が減り SW の起動順が変わって顕在化）。
  自作テスト拡張の ID で名指しするよう直した
- peek の ⌃M 検査は「通常タブ 2 本以上」が暗黙の前提で、共有モデルでは閉じる操作が
  全ウィンドウへ波及して先行セクションの残りタブが減り前提が崩れた → 検査が自分で
  2 本目を用意するよう直した（VERIFY.md の「絞ったせいで済ませず前提を自分で作る」の実践）
- フル検証で既存スイートの前提が 4 か所腐っていた（すべて「野良タブの正が
  ウィンドウ/session.json から共有ストアへ移った」ことの帰結）: pins のリネーム系
  （`TabState.customTitle` がタブ側フィールドのままで null）・peek の session.json マーカー
  （URL を持たなくなった）・split の行数期待とlastActiveAt の控え（session.json の tabs 消滅）・
  phase1 の復元チェック（全タブ実体化前提）。**pins の 1 件は実バグ**で、
  昇格時に `tab.customTitle`（null）を定義へ渡して名前が失われていた →
  `effectiveCustomTitle(tab)` を渡すよう修正し、`toState()` も共有定義の customTitle を
  実効値で返すようにした

### 方針変更

- **（2026-09-03）実体化済みの他ウィンドウは「乖離を許容」から「選択時に定義の現在 URL へ追随」に変更**。決定表の追随の行群を参照。詳細は `docs/plans/2026-09-03-1000-shared-tab-follow-on-select.md`
- **`nemo:move-tab-to-new-window` IPC と preload の `moveTabToNewWindow` は削除せず残した**。
  verify-peek / phase1 / phase2 / split の 4 スイートが「実体を別ウィンドウへ移す」シナリオの
  検証機構として使っており、消すと 4 本の書き直しになる。ユーザー導線（メニュー・⌘⇧N）だけ廃止
- **移行の冪等判定は版番号でなく `legacyWindows` の有無**（2 回目レビューの決定どおり。
  `JsonStore` は normalize に版番号を渡さない）。移行そのものは `initSession()` の中で
  同期的に行い、直後に `saveNow()` で確定する
- **昇格（⌘D / Favorites 追加）時、他ウィンドウの同じ共有定義の実体は新定義へ付け替える**
  （plan は「定義削除のみ・実体は閉じない」だったが、付け替えないと他ウィンドウの実体が
  どの層にも属さないローカル行として残る）。付け替える側は**分割を解いてから**付ける
  （ピン留め / Favorites は分割に入れない不変条件）。付け替え先に先客がいるウィンドウは
  **新しい共有定義を 1 本作って（rebind 1 回につき 1 本に束ねる）そちらへ倒す**
  —— 定義なしのローカル行は他ウィンドウに出ず再起動で消えるため
