# 共有タブの選択時追随（別ウィンドウで進んだページの続きを読む）

## 概要・やりたいこと

複数ウィンドウで同じ共有タブ（一時タブ定義）を開くと、ページ実体（WebContents）はウィンドウごとに独立なので、片方で遷移してももう片方は古いページのまま残る（現行仕様は「乖離を許容」）。サイドバーの行タイトルは定義に追随して新しくなるのに、クリックして出てくる中身が古い、という見え方になり「タブが古い表示のまま動かない」と感じる。

これを Arc 的な「続きを読む」体験にする: **タブがアクティブに選ばれた瞬間、実体の URL が定義の現在 URL と食い違っていたら定義側を読み直す**。

- 1 ウィンドウで普通に使う限り、実体のナビゲーションは毎回定義へ書き戻される（`syncEphemeralDefinition`）ので両者は常に一致し、選択時には**何も起きない**（従来どおり `setVisible` だけ。リロードは発生しない）
- 追随が走るのは実質「別ウィンドウの実体が先へ進んでいた」ときだけ

## 前提・わかっていること

### 現行モデル（`docs/plans/2026-08-31-1241-arc-style-shared-tabs.md`）
- サイドバーの行 = 全ウィンドウ共有の**定義**、ページ実体はウィンドウごとに別 WebContents
- 定義への書き戻しは「最後に触った実体が勝ち」で、**実体化済みの他ウィンドウは追随せず乖離を許容**が現行の決定 → 本タスクでこの決定表の行を書き換える
- 通話ガード（Meet 参加中の二重実体化防止）は現行のまま残す。ただし本タスクと独立ではない: 追随は「参加中の実体を別 URL へ飛ばす」新経路になり得るので、追随側にも `isJoined` の除外が要る（決定事項参照）

### コード調査で確認済みの事実
- `selectTab`（`registry.ts:2429`）は **already（既にアクティブ）でも早期 return せず `applyVisibility()` → `layout()` まで走る** → 同じ行の再クリックでも追随を撃てる。追随処理はここに置ける
- `openEphemeral` のサイドバークリック経路（既存実体 → `selectTab`）・タブスイッチャー等、選択の全経路が `selectTab` に合流する
- `canSyncDefinitionFromPage(tab)`（`registry.ts:3653`、2026-09-02 のローカルファイル対応 `6de068b` で新設）: **http/https でないタブは定義へ書き戻さない** → `file:` タブは同一ウィンドウ内でも恒久乖離する。追随側も非 http/https をガードしないと、ローカルファイルを見ているタブを選ぶたびに古い http ページへ引き戻される（ガードは `normalizeStoredUrl(tab.url)` の `null` 判定が兼ねる。決定事項参照）
- `materialize()` の `pendingUrl ?? this.url` の `loadURL` は `allowFile: true` 付きで、**「ここに入る値の系統」が注釈で棚卸しされている**（`registry.ts:641-647`）。sleep 復帰を定義 URL 優先に変えると第 3 の系統（ephemeral-tabs ストア由来）が増えるので注釈更新が必要。定義の URL は `normalizeStoredUrl`（`settings-schema.js:316`）で http/https に閉じているので `allowFile` の穴にはならない
- `810f8b4` で `will-prevent-unload` に Chrome 同等の離脱確認ダイアログが付いた → 追随の `loadURL` が beforeunload に当たるとダイアログが出てしまう。追随起点の遷移では抑止する
- pinned / favorite の定義はナビゲーションで URL を更新しない（`syncEphemeralDefinition` が早期 return）ので「追随先の現在 URL」が存在しない → **対象は ephemeral のみ**
- 自走検証は `scripts/verify-shared-tabs.mjs` が既存（自分で起動・2 枚目ウィンドウ対応。登録 `shared-tabs` / 配線とも既存）。追随の検査はここに足す

### 決定事項（/dig-lite で確定、polish-plan 1回目で追記）
| 論点 | 決定 |
| --- | --- |
| 発火タイミング | **`selectTab` の 1 点のみ**（既にアクティブな行の再クリックを含む）。ライブ追随・ウィンドウフォーカス時の追随はしない。両ディスプレイ同時表示中の乖離は行の再クリックで解消する |
| 発火経路 | `selectTab` を通る**全経路**で有効（サイドバー・スイッチャー・ペインクリック・タブを閉じた後の次タブ選択・`moveTabToWindow`・セッション復元・`focusEphemeralInstance`）。経路別の抑止フラグは作らず、抑止はすべて追随述語の条件で表現する（経路ごとのフラグは漏れの温床。1回目で決定） |
| 追随条件 | `tab.ephemeralId` あり、かつ `normalizeStoredUrl(tab.url)` が定義の現在 URL と**不一致**（`null` なら追随しない）。定義側は `normalizeStoredUrl` を通った値なので、実体側も同じ正規化を通してから比較する（生比較だと表記割れ・4096 文字超で毎回不一致になり、1 ウィンドウ運用でも選択のたびに追随が撃たれる）。`null` ガードが file: 等の非 http/https 除外を兼ねる（1回目で決定。従来の `canSyncDefinitionFromPage` 案を置き換え） |
| 通話ガード | `callWatcher.isJoined(tab)` の実体は追随しない。追随は「参加中の実体を別 URL へ飛ばす新経路」であり、既存ガード（二重実体化防止）が防いでいた通話切断をすり抜ける。ガード自身の `focusEphemeralInstance` も `selectTab` を呼ぶ（`registry.ts:3701`）ので必須（1回目で決定） |
| beforeunload | 追随起点の遷移では離脱確認ダイアログを**出さず**、ページが止めたら乖離のまま静かに残す（次の選択でまた試みる） |
| sleep 復帰 | `materialize()` の読み込み URL を「ephemeralId 持ちで、手元の URL（`pendingUrl ?? this.url`）が `normalizeStoredUrl` を通る（`null` でない）ときだけ定義の現在 URL 優先」に変更。**述語は追随側と同じ 1 つに揃える**（「http/https か」の生判定だと 4096 文字超の URL で追随側とずれ、寝て起きただけで古い定義 URL に引き戻される）。file: を見たまま寝たタブは手元の URL を優先する（定義優先だと古い http へ引き戻され、6de068b のローカルファイル対応に逆行する）。定義 URL を採用したら `this.url` にも反映し、直後の `selectTab` の追随判定を不一致にしない（二重ロード防止。1回目で決定） |
| 履歴 | 追随はリロードでなく通常の遷移として履歴に積む（「戻る」で乖離側のページに戻れる）。乖離側のページへの逃げ道は「戻る」のみで、追加の UI（通知・確認）は今回の範囲に入れない（1回目で決定） |
| 追随後の「戻る」 | 通常の遷移として扱い、定義への書き戻しも従来どおり行う（「最後に触った実体が勝つ」の帰結として、定義は戻った側の URL になり、他ウィンドウは次の選択でそちらへ追随する）。「追随起点の戻るだけ書き戻さない」は採らない — 書き戻さないと戻った直後の選び直しで再追随が起き、戻る操作が即座に取り消される（1回目で決定） |
| 適用範囲 | ephemeral のみ。pinned / favorite は対象外 |

## 実装計画

### Phase 1: 既存 plan の決定表を更新 [AI🤖]
- [x] `docs/plans/2026-08-31-1241-arc-style-shared-tabs.md` の決定表「定義への書き戻し」行を「書き戻しは従来どおり。実体化済みの他ウィンドウは**選択時に定義の現在 URL へ追随**」に書き換える
- [x] 本 plan の「決定事項」の表（追随条件・発火経路・通話ガード・beforeunload・sleep 復帰・履歴/追随後の戻る）を**そのまま**親 plan の決定表に反映する（旧版の条件で書かない。恒久ドキュメント側に古い決定が残ると次に触る人がそちらを正とする）
- [x] 同 plan の「ログ > 方針変更」に本タスクへの参照を 1 行追記

### Phase 2: 追随の実装 [AI🤖]
- [x] 追随判定＋実行を 1 関数に切り出す: `ephemeralId` → `findEphemeralTab` → `normalizeStoredUrl(tab.url)` が `def.url` と不一致（`null` なら追随しない）かつ `callWatcher?.isJoined(tab)` でないなら追随。読み込む URL は `resolveNavigationTarget(def.url, {}, 'follow')` を通す（`allowFile` は付けない。null なら追随しない。`security.ts` の「`loadURL` に生の文字列を渡さない」不変条件を守る）。判定はこの 1 箇所に寄せ、呼び出し側に条件分岐を書かない
- [x] `selectTab` から呼ぶ。位置は `applyVisibility()` の後（sleep 復帰で WebContents が立った後）**かつ `already` の早期 return（`registry.ts:2448`）より前**（再クリックで乖離を解消する決定が成立する位置）
- [x] `materialize()`: 読み込み URL の解決を「`ephemeralId` 持ちで `normalizeStoredUrl(pendingUrl ?? this.url)` が `null` でないときだけ定義の現在 URL を優先、それ以外は従来どおり」にする（述語は追随側と同じ関数に寄せる）。**定義 URL を採用したら `this.url` にも入れる**（`materialize` は `this.url` を更新しないため、直後の `selectTab` の追随判定が必ず不一致になり二重ロードする）。`allowFile: true` の値系統の棚卸しコメントに第 3 系統（ephemeral 定義由来・`normalizeStoredUrl` で http/https に閉じている）を追記
- [x] beforeunload 抑止: 追随起点の `loadURL` 中は WebContents 単位のフラグを立て、`will-prevent-unload` ハンドラ（`810f8b4`）の**先頭（`NEMO_VERIFY_UNLOAD_CHOICE` 判定・ダイアログ表示より前）**で見てダイアログを出さずに遷移キャンセルする。フラグの解除は**イベント順序に依存しない 3 点**で行う: (a) `will-prevent-unload` ハンドラ内（キャンセル確定の瞬間。畳まないとタイムアウトまでの間のユーザー起点の遷移が無言でキャンセルされる）、(b) **main frame の** `did-navigate` / `did-navigate-in-page` / `did-fail-load`、(c) 保険のタイムアウト。`did-start-navigation` は使わない（`will-prevent-unload` との先後が Chromium の内部順序依存で、先に飛ぶと抑止前にフラグが落ちる。サブフレームでも飛ぶ）。beforeunload を持たない大半のページでは (b) が畳む（立ちっぱなしのフラグは次のユーザー起点の遷移を無言でキャンセルする = 810f8b4 の再発）。log にイベント（例 `tab.follow_blocked`）を残す
- [x] 追随の `loadURL` は reject する（beforeunload で止められると `ERR_ABORTED`）ので `.catch()` を付ける（`materialize` の `void wc.loadURL(...)` を真似ない。unhandledRejection → `app.unhandled_rejection` → `findUncaughtExceptions` で verify 全体が FAIL する）
- [x] 追随実行時も log を残す（例 `tab.followed`）。URL は既存の main 側ログに合わせて `redactUrl` を通す。detail は `sanitizeDetail` の罠に注意（フラットに）
- [x] 相互作用の確認: Peek（`peekOf` 持ちは ephemeralId を持たない想定）・分割ビュー（両ペインとも `visibleTabKeys` 経由）・シークレット（定義に参加しないので自然に対象外）・通話ガード経路（`focusEphemeralInstance` → `selectTab` が `isJoined` 除外で追随しないこと）を実装中にコードで確かめ、必要なら早期 return を足す

### Phase 3: 自走検証 [AI🤖]
`scripts/verify-shared-tabs.mjs` に追随の検査を足す（登録・配線は既存。`OWNERS` は既存エントリの広げ忘れがないか実装で触ったファイルを突き合わせる）:
- [x] **追随する**: 2 ウィンドウで同じ定義を実体化 → A で別 URL へ遷移 → B で選択 → B の実体 URL が定義 URL に追随したこと
- [x] **追随しない（一致時）**: 一致状態で選択し直してもリロードされないこと。計測はページ側マーカー（読み込み時に消える `window` 変数）が**残っている**ことで見る（`tab.followed` ログの不在だけだと「追随以外の理由で読み直された」を見逃す）。「発生しない」検査なので、直前の追随ケースで同じマーカーが**消える**ことを対で示す。CDP の `connectTo` は URL 部分一致で最初の target を返すため、**2 ウィンドウが同じ URL に居る状態でマーカーを仕込まない**（一致時の検査は実体を 1 ウィンドウだけにする等、仕込む瞬間に対象が一意になる順序を決める。仕込み先の取り違えは空振りのまま PASS する）
- [x] **戻れる**: 追随後に「戻る」で乖離側のページに戻れること（`canGoBack` と戻った後の URL）。戻ると定義も戻った側の URL に書き戻される（決定事項「追随後の戻る」）ので、**この検査は定義の状態を汚す** — 後続の検査は状態を作り直すか、この検査を最後に置く
- [x] **beforeunload**: beforeunload で止めるページを**止められる側**（追随される実体）に仕込み、選択してもダイアログが出ず URL が変わらないこと（`tab.follow_blocked` のログで裏取り）。Chromium は sticky user activation が無いと beforeunload のキャンセル自体を無視する（`verify-phase1.mjs:1171-1188` に実測メモ）ので、実クリック相当を撃ってから追随を起こす verify-phase1 の方式を踏襲する。test-pages にページを足す場合は `verify-targets.mjs` の OWNERS 登録も忘れない。リスナを仕込む対象も `connectTo` の取り違えに注意（B だけ先に実体化して仕込んでから A を出す等、仕込む瞬間に一意になる順序にする）
- [x] **sleep 復帰**: B の実体を sleep させる → A で遷移 → B で選択 → 起きた実体が定義 URL を読んでいること（`pendingUrl` の古い URL でないこと）。sleep のさせ方は `window.nemo.updateSettings` で `tabSleepMinutes` を縮める手筋（`verify-split.mjs` / `verify-peek.mjs`）だが、**全ウィンドウの非表示タブが一斉に寝る**ので、仕込み中は `0` で sweep を止め、撃つ直前だけ短くし、終わったら元に戻す（戻し忘れは後続検査の状態を寝落ちで揺らす）
- [x] **通話ガード**: 参加中の実体の選択で追随が起きないこと（決定表で追随を止める唯一の安全弁なので自走に載せる）。前提 3 つ: ① `verify-shared-tabs.mjs` は自分でアプリを起動するので `NEMO_MEET_TEST_URL_PREFIX`（`${PAGES}/meet-fake.html`）を**自分の `appEnv` に足す**（verify-call は共有アプリ相乗りだったので不要だった）② 参加成立は `call.joined` のログ待ち（`verify-call.mjs` と同じ）③ 順序は**先に A・B 双方で実体化 → B で参加 → A で別 URL へ遷移**（参加後は `openEphemeral` の既存ガードが実体化自体を拒むので、後から開く順では乖離を作れない）
- [x] 検査順は 1 本に固定して書いてから実装する。少なくとも「戻れる」（定義を汚す）と「通話ガード」（参加中の実体が sleep 除外・close ガードで残る）は末尾に置く
- [x] 修正前 FAIL の確認: 追随の検査は**実装前のコードで FAIL すること**を先に見てから実装する（新規機能なので Phase 3 の「追随する」ケースだけ先に書いて回すのが手っ取り早い）。報告に FAIL → PASS を並べる
- [x] 検査件数を報告に出す（「速く PASS」の罠）

### 動作確認 [人間👨‍💻]
- [ ] 実機で 2 ウィンドウに同じタブを開き、片方で数ページ進む → もう片方でそのタブを選び直して続きが出ること
- [ ] 1 ウィンドウの通常運用でタブ切り替えが今までどおり瞬時なこと（リロードが挟まらない）
- [ ] Google Meet で通話に参加中の実体があるとき、そのタブの選択で追随（リロード）が起きないこと
- [ ] 分割ビューの相方ペインは選択されないので追随せず、片側だけ古いページが残る（仕様どおり。行を選び直せば追随する）

## ログ
### 試したこと・わかったこと
- **修正前 FAIL → 修正後 PASS**: 検査を先に書いて実装前のビルドで回すと 11 / 60 件 FAIL（追随・`tab.followed`・マーカー消失・
  `tab.follow_blocked` ×2・sleep 復帰 ×2・戻る ×3・`call.guarded`）。実装後は 60 / 60 件 PASS
- **追随が二重に撃たれていた（実装後の初回で `tab.followed` が 0 → 2）**: `selectTab` → `syncForegroundTab` →
  拡張の `onActivated` → `selectTab` と**同期的に再入**し（`already` 経路）、`did-navigate` 前の古い `tab.url` で
  もう一度不一致と判定されて同じ URL の `loadURL` が 2 発飛んでいた。追随中の WebContents（`followLoads` に
  載っている間）は撃ち直さないガードを `followEphemeralDefinition` に足して収束。plan の「二重ロード防止」は
  sleep 復帰側しか見ていなかった
- **読み込み中のタブへ `window.nemo.navigate` を撃つと `ERR_ABORTED (-3)` で IPC が reject する**: Electron の
  `loadURL` は先行ロードの中断（`did-fail-load` の -3）を自分の失敗として記録し、新しい遷移の完了時に reject する。
  検査側は `navigate` の前に `loading === false` を待つ（`waitForLoaded`）
- 相互作用の確認（コード）: Peek は `ensureEphemeralDefinition` が `peekOf` を除外するので定義を持たず、`selectTab` も
  親へ解決する / 分割の相方は選択されないので追随しない（決定どおり）/ シークレットは定義を持たない /
  セッション復元は `createTab(win, def.url, { asleep: true })` → 選択時の `materialize` で手元 URL と定義が一致し、
  起動時に追随は出ない / 通話ガードは自走検証で `call.guarded action=follow` を確認
- **フル実行（`mise run verify`）の初回は 3 件 FAIL したが、同じ 3 スイートの再実行（`verify:only shared-tabs call phase1`）では
  すべて PASS**（shared-tabs は verify-all 経由でも 60 件）。初回の内訳: shared-tabs は**既存**の「定義への書き戻し」節で
  A のナビゲート後 10 秒待っても定義 URL が更新されず 7 件で中断（追随のイベントは 1 件も出ておらず、追随の実装が触った
  経路ではない。main ログにも navigation.blocked 等は無し。原因は特定できず）/ call の「戻ったら小窓は引っ込む」は hidden の
  50ms 後に shown が出た / phase1 は sticky activation が付かなかった（CDP の合成クリック）。3 つとも追随のログ
  （`tab.followed` / `call.guarded` / `tab.follow_blocked`）は 0 件で、実装の経路が撃たれた形跡は無い。再発するなら別途追う
- **フル実行で shared-tabs が 7 件で止まった原因を特定**（polish-impl の動作確認で verify-all 経由 3 回中 2 回再現）: 既存の
  「定義への書き戻し」節で、B の実体化直後の**初回コミット（`did-navigate`）の定義への書き戻し**が、A の遷移の後に届いて
  新しい URL を古い URL に巻き戻していた（「最後に触った実体が勝つ」の競合。A の実体は新 URL に到達済みなのに定義だけ古い、
  を失敗時の診断出力で確認）。人間の操作では踏めない数十 ms の窓。検査側は実体化後に読み込み完了を待つ `openEphemeralIn` に
  寄せ、verify-all 経由で 3 回連続 60 件 PASS。製品側で「実体化の初回コミットは定義へ書き戻さない」にするかは**ユーザー判断で今回はこのまま**
  （2026-09-03。偶然でしか起きず「戻る」で戻れるため。次に共有タブか復元まわりを触るときに拾う。親 plan の決定表に既知の競合として記録済み）
- 検査の FAIL 詳細に `TabState` を丸ごと出すと favicon の data URL で 1 行が数 KB になる → `brief()` で url / asleep /
  canGoBack / loading だけに絞った

### 方針変更
- セッション復元経路の自走検査: **今回の範囲に入れない**（polish-impl 1回目で決定）。復元は `createTab(win, def.url, { asleep: true })` →
  選択時の `materialize` で手元 URL と定義が一致する経路で、追随が「起きない」ことはコードで確認済み。「起動したら別ウィンドウの続きが出る」は
  終了時に定義 URL が既に最新なので復元自体が続きを出す（追随の機能ではない）。検査の追加は次に復元まわりを触るときに拾う
- 分割ビューの相方ペインが追随しないことは人間の動作確認に 1 行足した（polish-impl 1回目で決定。仕様どおりの挙動を後からバグと読まないため）
- 追随を見送ったときのログを 1 つ追加: `call.guarded` に `action: 'follow' | 'follow_on_wake'` を足した
  （既存の `open` / `close` と同じイベント。自走検証が「ガードが効いた」を不在でなく存在で確かめるため）。
  追随の `loadURL` が reject したときは、`ERR_ABORTED`（beforeunload で止めた・先に別の遷移が走った = 仕様どおりの中止）以外だけ
  `tab.follow_failed` に残す（`code` は文字列で取れたときだけ付ける）
- 追随中の再発火ガード（上記の二重撃ちの修正）は `ephemeralFollowTarget` でなく `followEphemeralDefinition` 側に置いた。
  「追随すべきか」の判定ではなく「同じ追随が進行中か」の重複排除で、sleep 復帰側（新しい WebContents）には無関係なため
