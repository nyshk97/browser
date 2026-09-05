# Nemo

## 自走検証を足すとき

**「その検査が実際に走ったか」を実行件数で確かめる。**

検証スイートは**登録**（`scripts/lib/verify-targets.mjs` の `KNOWN_TARGETS` /
`NEEDS_APP` / `OWNERS`）と**配線**（`scripts/verify-all.mjs` の `if (want('<名前>'))`）が
分かれている。**登録だけして配線を書き忘れると、`mise run verify:only <名前>` が
1 件も検査せず「すべて PASS」で exit 0 する。**
`scripts/verify-targets.test.mjs` は登録の有無しか見ないので、ユニットテストでも落ちない。
症状が「速く PASS」なので、出力を眺めているだけでは気づけない。

新しいスイートを足したら、**配線を外した状態で 1 回回して検査 0 件になることを見てから**戻す。
報告には実行した検査の件数を必ず出す。

`OWNERS` に載せてよいのは「そのスイートしか見ていない」と確かめたファイルだけ。
UI コンポーネントを載せるなら、そのスイートが**設定画面を開いて描画まで見ている**こと
（IPC を叩くだけだと描画例外を素通りする）。

**既存モジュールに手を入れたら、`OWNERS` の既存エントリも広げる。**
新機能が既存ファイル（`src/main/store/http-auth.ts` など）を触ったのに、
そのエントリが古いスイート 1 つ（`['http-auth']`）のままだと、
**そのファイルを直しても `--changed` で新しいスイートが回らない**。
新規ファイルの登録漏れは `verify-targets.test.mjs` が落とすが、
**既存エントリの広げ忘れは落とせない**（腐っても症状は「速く PASS」）。

**未登録のファイルを新たに `OWNERS` に載せない。** 未登録は `selectVerifyTargets` が `kind: 'full'` に倒す安全側で、
`['src/main/ipc.ts', ['pins']]` のように載せると**今フルで回っているものが 1 スイートに絞られる改悪**になる
（レビューでこの提案が出た実例あり）。広げてよいのは既に載っているエントリだけ。

**自分のウィンドウを閉じる・破棄するコマンドは invoke の応答を待たない。**
`close-window` / 小窓の ⌘O 昇格を `session.ev('window.nemo.xxx().then(...)')` で待つと、
応答前に WebContents ごと破棄されて**永久に解決しない**（タイムアウトも例外も出ず
スイートが黙って止まる。2 箇所で別々に踏んだ実例あり）。`verify-peek.mjs` の `evSuicidal` を
使うか、`(setTimeout(() => { void window.nemo.xxx() }, 50), 'ok')` の形で発火だけして
結果は状態のポーリングで見る。

**自分でアプリを起動するスイート（verify-all に相乗りしないもの）は Live Folder を
止めてから起動する。** 止めないと使い捨てプロファイルでも `gh` の実トークンで
実 GitHub を叩き続ける。userData に `settings.json` の fixture
（`{"version":1,"data":{"liveFolderEnabled":false}}`）を置くのが最小
（`NEMO_GITHUB_TEST_ENDPOINT` 方式はモックサーバが要る）。

**renderer の `document.visibilityState` を View の出し入れの PASS 条件に使わない。**
View の可視性だけでなく**検証ウィンドウ自体の遮蔽（別 Space・前面に他のウィンドウ）でも
hidden になる**ので、デスクトップの状態しだいで同一コードが run ごとに揺れる
（暗幕検査が 4 run 中 2 回偽 FAIL した実測あり）。View が出ているかは main の実状態
（`splitDiagnostics().peekScrim` のような `getVisible()` 由来の値）を正にし、
visibilityState は診断の詳細としてだけ出す。

**CDP の target は名指しで選ぶ。** `find(x => x.type === 'service_worker')` のような
「最初に見つかったもの」は起動順で別の拡張・別のウィンドウに繋がり、
**write と read で別対象**になる順序依存フレークを生む（フル実行でだけ storage 検査が
`{}` で落ちた実例）。拡張は ID、ウィンドウは `?window=N` で選ぶ。

**popup に繋ぐ検査は popup.js の初期化完了を待ってから始める。** `connectTo(cdp, 'popup.html')` は
target ができた直後に繋がり、popup.js のトップレベル（リスナー登録・初期の storage 書き込み）がまだ走っていない。
その状態で記録を空にして書き込むと、最初の check だけ 0 件になる（原因は検査の順序なのに polyfill を疑って
1 周無駄にした実例あり）。`waitFor(popup, "document.getElementById('messaging')?.textContent ? 'ready' : ''")`
を `check` にして置く。

**履歴に載るのを待つときは `queryHistory` で行の存在を見る。`suggest()` の候補で待たない。**
`suggest()` は開いているタブも同じ URL で候補に出すので、履歴行を待つつもりの `waitFor` が
**開いているタブの候補**で即満たされ、`recordVisit`（did-navigate 契機）より前に `closeTab` して
履歴に残らない（作成から 4ms 後に閉じていた実測あり）。逆にタブを開いている間は `seen` の dedupe で
履歴の候補は出ないので、「history 種別が出るまで待つ」も永久に満たされない。

## `log()` に新しいイベントを足すとき

**detail は `sanitizeDetail`（`src/shared/log-redact.js`）を通ってから書かれる。** 型は合っていても
ログの中身だけが壊れる 2 つの罠がある:

- **`MAX_DEPTH = 4` を超えたオブジェクトは `"[deep]"` に潰れる**。detail → 配列 → 要素 → 配列 → 要素 で 4 なので、
  配列の要素にオブジェクトを入れ子にすると到達する。要素はフラットにし、複数値は文字列配列で持つ
- **URL の伏せ字は文字列の先頭が scheme のときだけ**。スタックトレースやエラーメッセージのような
  行途中の URL は素通りする。そういう値は送る側で `redactUrl` を行単位にかけてから渡す
  （`src/shared/ui-error.js` が例）

整形の純粋関数には「結果を `sanitizeDetail` に通しても `[deep]` / `[redacted]` / `…`（200 文字切り）が
出ない」ケースをユニットテストに必ず入れる（`scripts/metrics-summary.test.mjs` が例）。

## `docs/CHANGELOG.md`

`mise run release` が機械的に切り出す唯一の源。書き方はファイル冒頭の「書き方」節に従う。

## 定義（Favorite / ピン留め / 一時タブ共有定義）にフィールドを足すとき

**正規化は `src/shared/settings-schema.js` の `normalizePins`（`normalizeFavorite` / `normalizePinnedList`）に足す。**
`pins.ts` は `JsonStore(..., normalizePins)` で読むので、ここに無いフィールドは**型が通っていても次回起動で黙って消える**。
スロット（`normalizeSlot`）も同じ関数を通るので、slots-schema 側には書かない。

**一時タブの共有定義（`EphemeralTabDef`）も同じ**: 正規化は同ファイルの `normalizeEphemeralTabs`。
`ephemeral-tabs.ts` は `JsonStore(..., normalizeEphemeralTabs)` で読むので、ここに無いフィールドは次回起動で黙って消える。

**定義に属するタブの表示名は定義側が正。** `tab.customTitle` を直接読む・別の定義へ渡すと
null になる（⌘D 昇格の瞬間に付けた名前が消えた実バグあり）。読む側は必ず
`effectiveCustomTitle(tab)`（registry.ts）を通す。

**タブの状態を定義へ写す（title / favicon 等）ときは、イベント時だけでなく `assignDefinition` の時点で
タブが既に持っている値も写す。** `page-favicon-updated` は所属より前に来るのが普通（開いてから ⌘D / ドロップ）で、
イベント側だけだと「開いているのに頭文字」になる（自走検証で踏んだ）。

**renderer から shared を import するなら `tsconfig.web.json` の `include` に列挙する。** `settings-schema.js` は
`ext-lock.js` → `node:fs` に触るので入れられない。両方で使う純粋関数は Node 非依存の別ファイル
（`src/shared/favorites.js` が例）に切り出し、settings-schema から re-export する。
