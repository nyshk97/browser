# ブックマークのセーブスロット（ピン留め / お気に入りの保存と読み込み）

## 概要・やりたいこと

ピン留めとお気に入りを**ゲームのセーブデータのように 3 枠へ保存**し、別の Mac で読み込めるようにする。
新しい Mac を買ったときに、アプリの設定画面だけで移行が完結する状態にするのが目的。

- 設定の「ブックマークのセーブスロット」に **SLOT 1〜3 のカード**が並ぶ
- 埋まっているカードは「読み込む」、空きカードは「保存」の 1 ボタン
- 保存先は **iCloud Drive に決め打ち**。2 台目でアプリを開くと、同じ 3 枠がそのまま見えている
- 読み込むと、そのマシンのピン留めとお気に入りが**まるごと入れ替わる**（マージしない）
- 今まで CLI でやっていた設定同期（`mise run config:push` / `config:pull`）は**廃止**して、これに一本化する

見た目の確定に使ったモック: `<scratchpad>/slots-mock.html`
（案A 横 3 カード + 「···」メニュー、で確定）

## 前提・わかっていること

### 会話で決めたこと

| 論点                     | 決定                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| 置き場所                 | **iCloud Drive に固定**。`~/Library/Mobile Documents/com~apple~CloudDocs/Nemo/slots/`         |
| dev 版                   | `Nemo-dev/slots/` に**分ける**（dev の実験が常用版のスロットを壊さないため）                  |
| スロット数               | **3 枠**。増減の UI は作らない                                                               |
| スロットの中身           | **ピン留め + お気に入りだけ**。`settings.json`（キーバインド含む）は入れない                  |
| 読み書きのタイミング     | **ボタンを押したときだけ**。自動保存・自動適用・定期同期はしない                              |
| 読み込みの粒度           | **丸ごと置き換え**。マージしない                                                             |
| 読み込み後のタブ         | **読み込んだスロットに無い定義**に紐づくタブは一時タブへ降格。名前は旧定義から写す。ページは閉じない |
| undo                     | **作らない**（「ひとつ前の状態」の枠は入れない）。確認ダイアログ 1 回だけで実行する            |
| 上書き保存               | **UI から消す**。上書きしたいときは「削除」してから同じ枠に「保存」する                        |
| 削除                     | カードの「···」メニューから。**確認ダイアログを 1 回**挟む                                    |
| 名前                     | **自由入力**。カードの名前をクリックでその場編集（Enter / blur で確定、Esc で取消）           |
| カードに出す情報         | 名前 / 保存日時 / 端末名 / ピン N 件・お気に入り M 件 / アイコン 6 個 + `+N`                   |
| ファイル書き出し / 読み込み | **作らない**（iCloud 固定なので運搬手段が要らない）                                        |
| 保存先の表示             | パスを読み取り専用で出す + 「フォルダを開く」ボタン                                           |
| ボタンの文言             | 埋まっている枠は「**読み込む**」、空き枠は「**保存**」、読めない枠は「**再試行**」              |
| 文体                     | スロットの UI は**ですます調**。「降格する」のような内部用語は出さない（「今日のタブに移ります」）。**既存セクションの文言は今回書き換えない**（config-sync の説明文を除く） |
| 既存の config-sync       | **廃止**（CLI・mise タスク・`sync-schema.js`・VERIFY の節ごと）                               |
| `settings.json` の移行   | **手段を作らない**。今の `settings.json` は完全にデフォルト（キーバインドの上書きも無し）で移す中身が無い。将来カスタマイズしたら手で入れ直す。GitHub PAT は元々 `SYNCED_FILES` に無く、config-sync でも移していない |
| iCloud の競合コピー      | **検出して警告を出すだけ**（`slot-N.json` 以外のファイルがあればカードに 1 行 + フォルダを開く導線）。勝手にリネームも削除もしない |
| 初回の実データ読み込み   | **常用機で読む前に、必ず空き枠へ今の状態を保存する**（読み込みダイアログの警告文が案内している手順そのもの）。dev から常用スロットを読む経路は作らない |

### 画面の形（モックで確定した並び）

```
ブックマークのセーブスロット
┌─ SLOT 1 ──────────┐  ┌─ SLOT 2 ──────────┐  ┌─ SLOT 3 ─────────┐
│ メイン環境      ··· │  │ 実験用（拡張の検証）··· │  │                  │
│ 2026-08-25 14:32  │  │ 2026-07-02 09:11  │  │       空き       │
│  ・ TsubasanoMac… │  │  ・ Tsubasa-Mac-… │  │  （破線の枠）     │
│ ピン 18 件・お気に入り 8 件 │ ピン 6 件・お気に入り 3 件 │ │                  │
│ ■■■■■■ +4         │  │ ■■■■              │  │                  │
│ [    読み込む    ] │  │ [    読み込む    ] │  │ [     保存     ] │
└───────────────────┘  └───────────────────┘  └──────────────────┘

保存先  ~/Library/Mobile Documents/com~apple~CloudDocs/Nemo/slots/   [フォルダを開く]
```

- 「···」は hover で現れる。メニューは「**名前を変更…**」「（区切り線）」「**削除**（danger 色）」の 2 項目
- 空きカードには「···」を出さない
- メニューはカード内に right 揃えで置き、**パネル下端に収まらなければ上向きに出す**

### コードベースの現状

- **定義とタブ実体は別 ID**（`registry.ts:84`）。定義は `pins.json`（`store/pins.ts`）、
  タブは `NemoTab.pinnedId` / `favoriteId` で紐づく。同じ ID にすると
  「ピン留めタブを閉じた瞬間に定義まで消える」
- `pins.ts` は **`JsonStore<PinsData>` を 1 つ持ち、`commit()` で `listeners` を叩く**
  （`onPinsChanged`）。この listener が全ウィンドウの `pushState()` を呼んでいる
- 読み込みは**必ず `normalizePins` を通す**（`settings-schema.js:159`）。
  URL は http / https のみ、ID 重複は落とす、フォルダは 1 階層（`MAX_PIN_DEPTH = 1`）で
  超えた分は**中身を親へ平坦化**する
- **降格は `demoteTab` / `demoteEverywhere` に集約済み**（`registry.ts:3089`〜）。
  `RemovedDefinition[]`（id / title / customTitle）を渡すと、全ウィンドウのタブから
  紐付けを外し、**定義に付いていた名前をタブへ写す**。今回もこの経路を使う
- 所属の不変条件は `shared/tab-ownership.js` の `resolveTabOwnership` 1 本
  （排他 / 実在する ID だけ / 1 ウィンドウ 1 定義 1 タブ）。Electron 非依存で
  `scripts/tab-ownership.test.mjs` から直接テストできる
- **`scripts/*.test.mjs` は `src/shared/*` と `scripts/*` しか import していない**（17 本すべて）。
  `electron` を読める node:test 環境が無いので、`store/*.ts` / `registry.ts` は直接テストできない
- `JsonStore`（`store/json-store.ts`）は**固定パス 1 ファイル向け**。`set()` は 400ms デバウンスで
  `saveNow()` は失敗を握り潰す。「保存できたか」を返す必要があるものは `commit()` を使う
  （`store/http-auth.ts` が先例）。
  **`commit()` と `store/http-auth.ts` は HTTP 認証の作業（`2026-08-27-1256-http-basic-auth-autofill.md`）
  由来でまだコミットされていない。** 着手時に無ければ先に `JsonStore.commit()` を足す
- 設定画面は `Settings.tsx`。最後の「データ」セクションに **config-sync の案内文**が書いてある。
  パネルの幅は最大 920px（`registry.ts` の `overlayBounds`）
- **favicon の描画は `Sidebar.tsx` の `Favicon` に既にある**（`url` / `title` / `src` を受け、
  `src` が無ければホスト名の頭文字で描く）。保存時の一括取得は `store/history.ts` の `getFavicons`
- ダイアログは `data-testid`（`prompt-permission` など）を持ち、**CDP から答えられる形**になっている
  （`PromptDialog.tsx`）
- IPC は `ipcMain.handle('nemo:...')` + `preload/ui.ts` の `invoke`。renderer は `window.nemo.*`
- favicon は **`history.db` の `pages.favicon_url`**（端末ローカル）にしかない。
  `PinnedLink` / `FavoriteItem` は favicon を持たない
- **`scripts/arc-import.mjs` が廃止対象を import している**:
  `sync-schema.js` の `stringify` と `lib/config-sync.mjs` の
  `assertNotRunning` / `backupLiveData` / `timestamp` / `userDataDirFor`
- `verify-*.mjs` は `scripts/lib/verify-targets.mjs` の `KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS` に
  登録する決まりで、**登録漏れは `verify-targets.test.mjs` が落とす**

### 設計上の判断

- **スロットに `JsonStore` を使わない。** `JsonStore` は値をメモリに載せてデバウンス保存する常駐向けで、
  スロットは「押したときだけ読み書きする」上に **iCloud 経由で別のマシンが書き換える**。
  キャッシュを持つと「別 Mac が保存したのに古い一覧が出る」になるので、
  **一覧を開くたびにディスクから読み直す**。書き込みは tmp + rename を自前で行う
- **読めない枠を「空き」に倒さない。** iCloud では読めない理由が壊れ以外にもある
  （TCC 拒否・未ダウンロードの dataless ファイル・同期途中）。空きに見えると
  ボタンが「保存」になり、押した瞬間に**別 Mac のスロットを黙って潰す**（undo が無い）。
  枠の状態は **`empty` / `ok` / `unreadable` の 3 つ**にし、`unreadable` は理由を出して
  保存・読み込みの両方を無効にする
- **読み込みは main プロセスをブロックさせない。** evicted なファイルの読み取りは
  ダウンロードを伴うので、同期 `readFileSync` だと全ウィンドウが固まる。
  非同期 + タイムアウトにし、時間内に読めない枠は `unreadable` で返す
- **降格させるのは「旧 ID − 新 ID」の差分だけ。** 自分の Mac で保存した枠を読み込むと
  ID がそのまま一致するので、全部降格させると**定義はサイドバーに残ったまま同じ URL の
  一時タブが並ぶ**（ピンを押すと 2 個目のタブが開く）。「マージしない」決定とは矛盾しない
- **降格対象の算出は `src/shared/` の純関数に切り出す。** `store/pins.ts` も `registry.ts` も
  `electron` を引くので `node:test` から触れない。`tab-ownership.js` と同じ流儀で
  「旧定義 + 新定義 → 降格すべき `RemovedDefinition[]`」を純関数にし、そこをテストで固定する
- **favicon はスロットに焼き込む。** 保存時に `history.db` から引いた `favicon_url` を
  表示用に**最大 6 件だけ**メタとして持つ。別の Mac には履歴が無いので、
  焼き込まないとカードのアイコンが出ない。**ホストも一緒に持ち**、favicon が無いものは
  既存の `Favicon` に渡して頭文字で描かせる（色の決め方をサイドバーとズラさない）
- **iCloud Drive が無い環境**（`com~apple~CloudDocs` が存在しない）では
  `userData/slots/` にフォールバックする。**黙って別の場所に書かない**ため、
  画面に出している保存先のパスは実際に使っているパスにする

## 実装計画

### Phase 1: スロットのスキーマとストア [AI🤖]

- [x] `src/shared/slots-schema.js` を作る（Electron 非依存）
  - `SLOTS_VERSION = 1`、`SLOT_COUNT = 3`
  - `normalizeSlot(raw)` … `{ name, savedAt, host, appVersion, icons, favorites, pinned }`
    を検査する。`favorites` / `pinned` は**既存の `normalizePins` をそのまま呼ぶ**
    （ピン留めの不変条件を二重に書かない）
  - `name` は 1〜60 文字に丸め、空なら「名称未設定」
  - `buildSlot(payload)` … 保存する中身を組み立てる（ファイルには書かない）。
    `host` は**引数で受ける**。`src/shared/*` は renderer からも import されるので `node:os` を持ち込まない
  - `icons` は最大 6 件の `{ url, faviconUrl }`。`faviconUrl` は https と data: を許し
    （UI の CSP に合わせる）、**サイズ上限を超えるものは落とす**。落ちても `url` は残す
- [x] `scripts/slots-schema.test.mjs` … 壊れた JSON / 未来の版 / 深すぎるフォルダ /
      不正 URL / 名前の長さ / icons の上限とサイズ超過 を通す
- [x] `src/main/store/slots.ts` を作る
  - `slotsDir()` … **`NEMO_SLOTS_DIR` → iCloud → `userData/slots/`** の順で解決する。
    ログには**フルパスを出さず** `{ kind: 'env' | 'icloud' | 'fallback' }` を残す
    （既存の store は `path.basename` しか載せていない）
  - `listSlots()` … 3 枠ぶんを**毎回・非同期で**読む。`ENOENT` だけが `empty`、
    それ以外の失敗（EPERM / タイムアウト / 壊れ）は **`unreadable` + 理由**で返す。
    壊れていたものは `.broken-<時刻>` に退避する（`JsonStore.quarantine` と同じ流儀）
  - `saveSlot(index, payload)` / `deleteSlot(index)` / `renameSlot(index, name)` / `readSlot(index)`。
    **中身は引数で受ける**（`slots.ts` をファイル I/O だけに閉じ、`pins.ts` / `history.ts` を引かせない。
    検証の fixture 生成にも同じ関数を使える）
  - **保存時の初期名は「〈端末名〉 YYYY-MM-DD」**（空欄で作ると毎回リネームすることになる）
  - 書き込みは **tmp + rename**。`{ version, data }` 形式（`writeVersioned` を使う）。
    **rename の直前に既存ファイルの有無を確かめ**、空きだと思って上書きする事故を止める
  - 空きスロットは**ファイルが無い**状態で表す（空ファイルを置かない）
  - **`slot-N.json` 以外のファイル**（iCloud の競合コピー `slot-1 2.json` の類）があれば
    その事実だけを返す。**リネームも削除もしない**
  - ファイル名は `slot-1.json`〜`slot-3.json`、IPC の `index` は 0〜2。**変換はこの層で閉じる**

### Phase 2: 読み込み（定義の差し替えとタブの降格） [AI🤖]

- [x] `src/shared/slot-apply.js`（Electron 非依存）に降格対象の算出を切り出す
  - 旧定義（favorites + pinned・フォルダの子孫も含む）と新定義を受け、
    **新定義に「同じ ID・同じ種別（pinned / favorite・link / folder）・同じ URL」で残っていないもの**を
    `RemovedDefinition[]` で返す純関数。ID の一致だけで見ると、種別が移った / URL が差し替わった
    定義を取りこぼし、**サイドバーの行と開いているページが食い違う**
- [x] `scripts/slot-apply.test.mjs`
  - 「同じ内容を読み込んだら降格対象が 0 件」（ID が一致するケース）
  - 「別 Mac のスロット（ID が総入れ替え）なら全件が対象」
  - 「フォルダごと消える定義は**子孫も含めて**対象になり、名前を保つ」
  - 「同じ ID がピン留め ⇄ お気に入りに移った」「同じ ID で URL が変わった」
    「link が folder になった」の 3 つが**対象になる**
  - **修正前のコードで FAIL すること**を `git stash` で確認してから直す
- [x] `store/pins.ts` に `replaceAll(next)` を足す
  - **`JsonStore.commit()` を使い、書けたときだけメモリへ反映**して成否を返す
    （`set()` だと IPC が成功を返したあとに書き込みが失敗しうる）
  - **`commit()` が true を返したときだけ `listeners` を叩く。** `pins.ts` のローカル `commit()` を
    通らないので、忘れると `onPinsChanged` が発火せず、**差し替えたのにサイドバーが古いまま残る**
    （`demoteEverywhere` はタブが変わったウィンドウしか `pushState()` しない）
  - 旧定義のスナップショットは **`commit(mutate)` の中で取る**。`commit()` はキューで直列化され
    常に直前の commit 済み値から次を作るので、外で読んでから渡すと間に入った更新を取りこぼす
- [x] `registry.ts` に `applySlot(index)` を足す
  - 純関数の戻り値を **`demoteEverywhere` にそのまま渡す**（新しい降格経路を作らない）
  - 書き込みに失敗したら**何も変更せずエラーを返す**
  - ログに `slot.applied`（index / 降格したタブ数 / 差し替えた定義数）を残す

### Phase 3: IPC と preload [AI🤖]

- [x] `ipc.ts` に追加
  - `nemo:list-slots` / `nemo:save-slot` / `nemo:delete-slot` / `nemo:rename-slot` /
    `nemo:apply-slot` / `nemo:open-slots-folder`
  - `nemo:list-slots` の戻りは **`{ dir, kind, slots }`**。UI の保存先表示も検証の事前確認も
    この値を見る（ログにはフルパスを出さないので、他に受け取る口が無い）
  - `index` は **0〜2 の整数だけ**受ける（範囲外は弾く）。`name` は schema 側で丸める
  - 保存時の favicon は main 側で `store/history.ts` の `getFavicons` を使う（再実装しない）
  - **保存 / 読み込み / 削除は成否を返す**（UI が失敗を出せるように）
- [x] `preload/ui.ts` に `listSlots` / `saveSlot` / `deleteSlot` / `renameSlot` /
      `applySlot` / `openSlotsFolder` を公開する
- [x] `shared/types.ts` に `SlotSummary` を足す
  - `{ index, state: 'empty' | 'ok' | 'unreadable', reason?, name, savedAt, host, pins, favs,
    icons: { url: string, faviconUrl: string | null }[] }`

### Phase 4: 設定画面の UI [AI🤖]

- [x] `Settings.tsx` に「ブックマークのセーブスロット」セクションを足す（「データ」の**手前**）
  - 3 カード + 保存先のパス + 「フォルダを開く」。パスは `slotsDir()` の実際の解決結果を出す
  - `unreadable` の枠は理由を出し、**保存・読み込みの両方を無効**にする。
    ボタンの位置には**「再試行」**（＝一覧の取り直し）を置く。
    「···」は**「削除」だけ**出す（`renameSlot` は read-modify-write なので実行できない）
  - 競合コピーがあれば**その枠に 1 行出す**（「同じ枠に別の Mac からも保存されています」+
    「フォルダを開く」へ誘導）。放置すると「保存したのに 2 台目で見えない」の原因に辿り着けない
  - 名前のその場編集（Enter / blur で確定、Esc で取消、空なら「名称未設定」）
  - 「···」メニュー（名前を変更… / 削除）。**hover で出す**。カード外クリックと Esc で閉じる
  - パネル下端に収まらないときはメニューを上向きに出す
- [x] 確認ダイアログ（モックの文面のまま）
  - 保存: 「現在のピン留めとお気に入りを、このスロットに保存します。」
  - 読み込み: 「『〈名前〉』の内容で、現在のピン留めとお気に入りを**まるごと置き換えます**。」
    + 差分（現在 / 読み込み後）+ 警告（**元に戻せません** / タブは「今日のタブ」へ移る）
  - 削除: 「〈名前〉（ピン N 件・お気に入り M 件）を削除します。元には戻せません。削除しますか？」
    + 「現在開いているピン留めとお気に入りには影響しません。」
  - **`data-testid` を付けて自走検証から押せる形にする**（`PromptDialog.tsx` と同じ流儀）
- [x] `styles.css` にカード / メニュー / ダイアログのスタイルを足す
  - **値は直書きせずトークンを使う**（DESIGN.md の決めごと）
  - 「···」は**インライン SVG**にする（絵文字・アイコンフォントは使わない）
- [x] アイコンは **`Sidebar.tsx` の `Favicon` を再利用**する（`url` と `src` を渡す）。
      二重実装すると同じサイトの頭文字の色がサイドバーとズレる

### Phase 5: config-sync の廃止 [AI🤖]

- [x] **先に `scripts/arc-import.mjs` の依存を切る**（ここを飛ばすと `mise run arc:import` が即死する）
  - `sync-schema.js` の `stringify` と `lib/config-sync.mjs` の
    `assertNotRunning` / `backupLiveData` / `timestamp` / `userDataDirFor` の行き先を決めて移す
  - 移したあと **import が解決すること**を確かめてから次へ進む（Arc のデータが無い環境でも見られる形で。
    `arc-import.test.mjs` の fixture 経路でもよい）
- [x] 消す: `scripts/config-sync.mjs` / `scripts/lib/config-sync.mjs` /
      `scripts/config-sync.test.mjs` / `src/shared/sync-schema.js`
- [x] `.mise.toml` の `config:init` / `config:status` / `config:push` / `config:pull` / `config:restore` を消す
- [x] `Settings.tsx` の「データ」セクションの説明文を書き換える
      （`mise run config:push` の案内 → 「履歴とアーカイブは端末ごとに持つので、スロットには含まれません。」）
- [x] `VERIFY.md` の「設定同期（Phase 2-1）」の節を**セーブスロットの節に差し替える**
- [x] `git grep config-sync`（`src/` も含む）で参照が残っていないか確認する。
      **`docs/CHANGELOG.md` の過去の記述は書き換えない**

### Phase 6: 自走検証 [AI🤖]

- [x] `NEMO_USER_DATA_DIR` と `NEMO_SLOTS_DIR` を使い捨てディレクトリに向けて回す
      ※ **常用の Nemo は絶対に触らない**（起動中のインスタンスは常用機）。
      `NEMO_SLOTS_DIR` を渡し忘れると**実 iCloud の常用スロットに書く**ので、
      検証スクリプトの先頭で解決先が `env` であることを確かめる
- [x] `scripts/verify-slots.mjs` として作り、`scripts/lib/verify-targets.mjs` の
      `KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS`（`store/slots.ts` / `slots-schema.js` / `slot-apply.js`）に
      登録し、**`verify-all.mjs` に `if (want('slots'))` の配線も足す**
      （登録だけでは 1 件も回らない。しかも「速く PASS」するので気づけない）。
      **`OPT_IN_ONLY` に入れてフルの既定からは外す**（アプリを 4 回起動し直すのでフルが 1〜2 分伸びる）。
      VERIFY.md の節はこのコマンドを指す
- [x] 通しの確認
  - 保存 → `slots/slot-1.json` ができ、`{ version, data }` 形式で中身が読める
  - **同じ枠を読み込む → 降格が 0 件**（ID が一致するので定義もタブもそのまま）。
    あわせて**読み込み後の `pins.json` がスロットの中身と一致する**ことも見る
    （降格 0 件だけだと、読み込みが丸ごと no-op でも PASS する）
  - **別 Mac 相当のスロット（ID を振り直した fixture）を読み込む → 全件が「今日のタブ」に出る**
  - 別 Mac 相当を読み込んだ後、**新定義に無い ID** を持ったままのタブが 1 つも無い
  - 削除 → ファイルが消え、カードが「空き」に戻る
  - 名前変更 → ファイルの `name` だけが変わり、`favorites` / `pinned` は変わらない
  - 読めない枠（権限を落としたファイル）→ 「空き」ではなく `unreadable` になり、保存ボタンが無効
  - 壊れた version の枠 → 退避されたうえで、「再試行」で**空きに戻る**。
    未来の版の枠は**退避されず** unreadable のまま
- [x] **移行の検証は別建てにする**（使い捨てディレクトリでは移行経路を一度も通らない）
  - 旧フォーマットの fixture（version 違い / 2 階層フォルダ / 不正 URL 混じり）を
    `slots/` に置いてから起動し、**平坦化・除去が効くこと**を見る
  - **同じ fixture で 2 回読み込んで結果が同じ**こと（冪等性）
- [x] `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm verify`

### 動作確認 [人間👨‍💻]

- [ ] **常用機で初めて読み込む前に、必ず空き枠へ今の状態を保存する**。
      undo が無いので、これが唯一の戻し手段になる（自走検証は使い捨てディレクトリなので、
      **実データを読むのはこれが初めて**になる）
- [ ] 2 台目の Mac で、iCloud 経由でスロットが見えること
      （**初回アクセスで「Nemo が iCloud Drive 内のファイルへのアクセスを求めています」が出る可能性がある**）
- [ ] 実機で読み込みを 1 回通し、サイドバーの見え方（降格したタブが 1 つも消えていないか）を目視で確認
- [ ] `~/Library/Application Support/NemoConfigSync/` の中身を確認して、要らなければ削除

## ログ

### 試したこと・わかったこと

- **`import('./scripts/arc-import.mjs')` で常用の `pins.json` を上書きしてしまった**（2026-08-28）。
  Phase 5 の「import が解決すること」を確かめるつもりだったが、`arc-import.mjs` は
  **トップレベルで本体を実行する**作りで、動的 import がそのまま実行になった。
  Nemo が起動していなかったので `assertNotRunning` も止めなかった。
  `backupLiveData` が控えを取っていたので全量復元済み（失ったものは無し。
  上書き前の中身は favorites 0 / フォルダ 1 個）。
  **依存の確認に `import()` を使わない**。`arc-import.test.mjs`（fixture 経路）で確かめる。
- **`KNOWN_TARGETS` / `OWNERS` に登録しただけでは検証は 1 件も回らない**（2026-08-28）。
  `verify-all.mjs` に `if (want('slots')) { … }` の配線が別に要る。抜けていると
  `mise run verify:only slots` が**何も検査せず exit 0**になり、`verify-targets.test.mjs` は
  登録の有無しか見ないので気づけない（症状が「速く PASS」なので余計に見つからない）。
  新しいスイートを足すときは **登録 3 か所 + `verify-all.mjs` の呼び出し**で 1 セット。

### 方針変更

- **`config-sync` から `scripts/lib/nemo-data.mjs` を切り出した。** `arc-import.mjs` が
  `assertNotRunning` / `backupLiveData` / `timestamp` / `userDataDirFor` / `stringify` を
  使っていたため。`backupLiveData` は `SYNCED_FILES` に依存していたので、
  **対象ファイルを引数で受ける**形に変えた（`arc-import` は `pins.json` だけ）。
  バックアップの置き場（`NemoConfigSync/backups/`）は**変えていない** ——
  変えると過去に取った控えが行方不明になる。
- **`SlotList` に `current`（いまのブラウザの件数）を持たせた。** 確認ダイアログの
  「現在 → 読み込み後」に要るが、renderer で数えると `countPinnedLinks`（フォルダを数えない）を
  二重に持つことになる。`src/shared/slots-schema.js` を web の tsconfig に入れずに済む利点もある。
- **カードの `+N` も main が数える（`SlotSummary.moreIcons`）。** 当初は renderer で
  「ピン + お気に入り − アイコン数」を出していたが、`icons` は**重複と不正 URL を落とした**あとの
  数なので、打ち切っていないのに `+N` が出る。`slots-schema.js` に `iconCandidates`
  （重複を落とす・打ち切る前）を切り出し、差を main で計算して渡す。
  `MAX_SLOT_ICONS` を renderer に import すると `slots-schema.js` を web の tsconfig に
  入れることになるので、上の `current` と同じ方針に揃えた。
- **`unreadable` の枠に「再試行」を置いた。** もとは常時 `disabled` の「読み込む」を出していたが、
  それはパネルを開き直すまで有効化されない死んだボタンだった。一覧はキャッシュを持たず
  毎回ディスクを読むので、押し直せば直る場面がある（iCloud のダウンロード待ち／
  壊れて退避済みの枠が「空き」に戻る）。ボタンの数は増えていない。
- **`slots` はフル実行の既定から外した（`OPT_IN_ONLY`）。** キーは撃たないが、使い捨て
  プロファイルで**アプリを 4 回起動し直す**のでフルが 1〜2 分伸びる。`OWNERS` にスロット関連の
  ファイルを全部載せてあるので、触ったときは `--changed` が必ず選ぶ。`vim-scroll` と同じ扱い。
- **UI は `Settings.tsx` に足さず `Slots.tsx` に分けた。** `Settings.tsx` が既に 733 行あり、
  さらに 400 行足すと1ファイルが厚くなりすぎる。
