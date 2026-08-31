review session: b36f0b56-8222-4c0e-9ea2-21db1c242ab0

# polish-plan review log: arc-style-shared-tabs

## 1回目

````text
`docs/plans/2026-08-31-1241-arc-style-shared-tabs.md` をコードと突き合わせてレビューしました（file:line 参照はすべて実在を確認済み。`registry.ts:1147/1893/3354/3190/3486`、`Sidebar.tsx:41-56/78-89`、`ipc.ts:341`、`preload/ui.ts:49` はいずれも記述どおり）。

## P0
- **Phase 2 > 6（removeEphemeralEverywhere）** — ウィンドウを閉じる `destroy()`（`registry.ts:1978-2020`）は全タブを close する。閉じる経路が「定義削除」に合流していると、ウィンドウ A を閉じただけで B のタブが全滅する / 共有モデルの根幹が壊れ、Phase 3・4 の後に発覚すると全経路の見直しになる / 「実体のデタッチ」と「定義の削除」を別関数に分け、定義を消すのは `removeTab`（⌘W・×）と `sweepArchive` だけ、`destroy()` / `closeTemporaryWindow` / `moveTabToWindow` はデタッチのみ、と計画に明記する。
- **Phase 2 > 3（createTab で定義を作る）** — 定義の url は `normalizeStoredUrl`（`settings-schema.js:316`）で http/https のみ。⌘T の `about:blank`（`navigation-policy.js:30`）や拡張ページのタブは定義を持てない / Phase 4 でサイドバーの一時タブ一覧を共有定義に差し替えた瞬間、新規空タブが**自分のウィンドウのサイドバーからも消える** / 定義ストア側は about:blank を許す（保存時だけ落とす）か、renderer が「定義なしのローカルタブ」も併記するフォールバックを持つか、どちらかを Phase 1 の正規化仕様として決めて書く。
- **Phase 2 > 3（同上・createTab 以外の生成経路）** — 実体は `createTab` だけでは作られない。`openPeek`（`registry.ts:2554`）で作った Peek を ⌘O で昇格する `promotePeek`（`:2580-2598`）は `win.tabs` を並べ替えるだけで `createTab` を通らない / 昇格した Peek が定義なしのまま一時タブになり、どのサイドバーにも出ない不可視タブになる（mini 昇格と同じ罠を Peek 側で踏む） / Phase 2 に `promotePeek` での定義作成を項目として足す（mini と同じく現在の url/title/favicon を写す）。
- **Phase 2 > 1（3 者排他）／Phase 2 全体** — ピン↔一時タブの**転換**が計画に一つも無い。`unpinEverywhere` → `demoteEverywhere`（`:3190`）は N ウィンドウの実体を同時に降格させる / そこで実体ごとに定義を作ると、2 ウィンドウで開いていたピンを外した瞬間に同じ URL の行が 2 本並ぶ。逆に `togglePin` / `assignDefinition`（`:3170`）で一時タブを昇格させたとき、ephemeral 定義を消さないと同じタブが 2 層に出る / 「降格は定義を **1 本だけ** 作って全ウィンドウの実体をそこへ束ねる」「昇格は ephemeral 定義を削除（波及なし）」を Phase 2 の独立ステップにする。`applyConversion`・Live Folder 降格も同じ経路に通す。
- **Phase 2 > 8（sweepArchive を定義基準へ）** — 「どのウィンドウの実体も lastActiveAt が閾値超えのときだけ」は、実体が 1 つも無い定義に対して**空虚に真**になる / 未実体化の共有定義（＝復元直後はほぼ全部）が最初の sweep で一斉に消える。現行 `sweepArchive`（`:3565`）の除外（`visibleTabKeys` / `isCurrentlyAudible` / `isSleepExempt`）も全ウィンドウで OR を取らないと、B で見ているタブが A 基準で消える / 定義側 `lastActiveAt` を正とし（実体があればその最大値で更新）、除外は全ウィンドウ横断で OR、と書き直す。
- **Phase 3 > 1／> 2（スキーマ変更とマイグレーション）** — `initSession`（`store/session.ts`）は読み込み直後に `store.update(cleanExit:false)` で**正規化後の値を書き戻す**。`normalizeSession` から `tabs` を外すと、移行コードが走る前に旧タブが session.json から消える / 一度きりの移行が空振りし、ユーザーの野良タブが全消失する（やり直し不可） / 移行は `normalizeSession` の中で版 4 以下の `tabs` を `legacyTabs` として保持する形にし、共有ストアへ移した後に落とす。冪等性は「ephemeral ストアが既に初期化済みか」ではなく session の版番号で判定する。
- **Phase 4 > 3（Sidebar のソース差し替え）** — シークレットウィンドウも同じ `Sidebar.tsx` を使い、一時タブ一覧を `state.tabs` から描いている（`Sidebar.tsx:78-89`、private 分岐は注記の表示だけ `:114`）。Phase 4 > 1 で private に `ephemeralTabs` を渡さない決定と衝突 / シークレット窓のタブ一覧が空になる / 一覧のソースを「`shared.ephemeralTabs` があればそれ、無ければ `state.tabs` 由来」の 1 本の `useMemo` に畳む前提で書く（mini は別 UI なので対象外）。
- **Phase 4 > 3／> 4（行の操作）** — `TabRow` / `SplitRow` / `RowMenu` は `tab.key` 前提（選択・×・rename・分割・D&D・copy-url）。未実体化の定義行には key が無い / 「装飾にのみ使う」で済まず、行コンポーネントのプロパティ設計ごと変わる。ここを曖昧にしたまま Phase 4 に入ると Sidebar 以外に波及して手戻りする / 未実体化行で許す操作を「クリック（openEphemeral）・×（close-ephemeral）・並べ替え」の 3 つに限定し、他は実体化後にのみ出す、と計画に明記する。

## P1
- **Phase 2 > 5（書き戻し）** — `renameTab`（`registry.ts:3391`）は一時タブだと `tab.customTitle` を書いてウィンドウローカルに閉じる / 共有一覧の名前が他ウィンドウに出ず、再起動でも消える（CLAUDE.md の「割り当て時点の値も写す」と同じ罠） / `renameTab` を「`ephemeralId` があれば定義側へ」に回す項目を Phase 2 に追加。⌘⇧T 用の `effectiveCustomTitle`（`:2665` 付近）も定義から読むよう合わせる。
- **Phase 2 > 6（閉じる波及）と Phase 5 > 1（通話ガード）** — ガードが `openEphemeral` だけにかかっている / 別ウィンドウで Meet に参加中の定義を、未実体化のウィンドウから × 一発で切れる（ガードの目的と矛盾） / 削除側にも同じ判定を入れ、joined の実体があるときは削除を拒否してそのウィンドウへフォーカスを移す。
- **Phase 5 > 1（call-coordinator 参照）** — registry から通話状態を見る口は `CallWatcher.isSleepExempt` だけ（`call-coordinator.ts:484`、`getCallState()` は単一ターゲット用） / タブ単位の joined 判定がそのままでは取れず、実装時に interface 拡張という追加作業が出る / `CallWatcher` に `isJoined(tab)` を足す（`isShowable` を使う）ことを Phase 5 のステップとして書く。
- **Phase 3 > 1（アクティブ表現）** — 「または pinned/favorite のアクティブ表現」と保留になっているが、現行は `toSaved()` が一時タブしか保存せず `Math.max(findIndex, 0)` で先頭に倒しているだけ / 保留のままだと Phase 3 で実装者が判断を迫られる / `activeEphemeralId` のみ（ピン/Favorite がアクティブだった場合は先頭定義へ倒す）で現行同等、と決めて書く。
- **Phase 4 > 3（Live Folder 除外と分割行）** — 現行の一時タブ一覧は Live Folder の URL 一致を `normalizePrUrl` で除外し、分割中は除外より結合行を優先している（`Sidebar.tsx:80-88`）。共有定義ソースでもこの 2 つの規則を再現する必要がある / 落とすと PR タブがサイドバーに二重に並び、分割の解除導線が消える（コメントに明記された既知の事故） / Phase 4 > 3 に「URL 一致の Live Folder 除外」と「分割の結合行はウィンドウローカルの `state.tabs` から重ねる」を条件として書き足す。
- **Phase 順序（Phase 3 と Phase 4）** — Phase 3 でセッションを反転した時点では renderer がまだ `state.tabs` 由来 / その中間コミットで「再起動するとサイドバーからタブが消える」状態になり、途中の自走検証が使えない / Phase 4 を Phase 3 の前に置くか、3+4 を 1 コミットで落とすと明記する。
- **Phase 6 > 3（移行 fixture 検査）** — 既に `scripts/verify-session-migration.mjs`（版 2 fixture で実起動する専用スイート）がある / 別建てを新設すると同種のスイートが 2 本になり、`OWNERS` / `KNOWN_TARGETS`（`scripts/lib/verify-targets.mjs:115`）の対応もぶれる / 既存の `verify-session-migration` に版 4 fixture のケースを足す方針に変える。

## P2
- **Phase 3 > 2（結合して移行）** — 全ウィンドウの野良タブを 1 本に結合すると、移行直後の各サイドバーは従来の N 倍の行数になる / 体感の劣化が移行初回に集中する / 移行時に定義の `lastActiveAt` をそのまま持ち込み、初回 sweep の自動アーカイブに素直に任せる（＝間引きを別途書かない）方針を一行残しておくと判断が再現できる。
- **Phase 1 > 2（ストア名）** — `ephemeral-tabs.ts` と本文の「野良タブ」「一時タブ」が混在 / 後から grep しづらい / `docs/operations.md` 追記（Phase 6 > 6）の時点で用語を 1 つに固定する。

## Q
- **Phase 2 > 6 / Phase 3 > 3** — ウィンドウを閉じたとき、そのウィンドウでしか実体化していなかった定義を共有一覧に**残すか消すか**が決定表に無い（決定表は「タブを閉じる」しか扱っていない） / 残す＝Arc 的だが、ウィンドウを閉じてタブを片付ける習慣だと共有一覧が延々と伸びる。消す＝ウィンドウを閉じた瞬間に他ウィンドウの一覧からも行が消える。どちらを選ぶかで P0 一点目の「デタッチのみ」の書き方が変わるので、実装前に決める必要がある。
- **Phase 6 > 動作確認 / Phase 3 > 3** — 復元時に「アクティブ定義と分割の構成員だけ実体化」した結果、全ウィンドウが**同じ**定義を実体化するのか（各ウィンドウが自分の `activeEphemeralId` を持つので普通は別）、2 枚のディスプレイで同じタブが両方に出る状態を許容するのか / 許容しないなら復元時に定義の重複回避ロジックが要り、Phase 3 の作業量が変わる。
````

**対応**: P0 は全 8 件反映。(1) デタッチと定義削除を別関数に分離し、定義削除は removeTab と自動アーカイブだけに限定・destroy()/moveTabToWindow はデタッチのみと明記 (2) 定義は http/https のみ、about:blank 等はローカルタブとして Phase 4 で併記＋最初のナビゲーションで定義化 (3) promotePeek での定義作成を追加 (4) ピン↔一時の転換（降格は定義1本に束ねる・昇格は定義削除のみ）を独立ステップ化 (5) sweepArchive は定義 lastActiveAt を正・除外は全ウィンドウ OR・空虚に真の全称条件を禁止 (6) 移行は normalizeSession が legacyTabs を保持・冪等判定は版番号 (7) Sidebar は shared＋ローカル併記の1本の useMemo に畳みシークレットは自然にフォールバック (8) 未実体化行の操作をクリック・×・並べ替えに限定。P1 も全件反映（renameTab の customTitle 書き戻し・通話ガードの閉じる側・activeEphemeralId のみ・Live Folder 除外と分割結合行・Phase 3+4 を1コミット・移行検査は既存 verify-session-migration へ）。P1 の CallWatcher interface 設計は「実装時に足す」の1行に留めた（設計を plan に書かない方針）。P2 も反映（lastActiveAt 持ち込み＋sweep 任せの1行・用語は operations.md 時点で「一時タブ」に統一）。Q は2件とも自分で決定: ウィンドウを閉じても定義は残す（Arc の Never lose a tab・ウィンドウはビューという採用モデルそのもの。伸びは自動アーカイブが受け持つ）／同じ定義の複数ウィンドウ実体化は許容（ユーザーが Arc で気に入った挙動そのもの）。いずれも決定表に追記済み。

## 2回目

````text
再レビューしました。前回の P0/P1/P2 は該当箇所を確認し、いずれも反映されています（デタッチ/削除の分離、http/https 限定＋ローカル併記、`promotePeek`、転換ステップ、空虚に真の禁止、`legacyTabs`、Sidebar の 1 本化、未実体化行の操作限定）。以下は今回の記述をコードに当てて新たに出たものだけです。

## P0
- **Phase 4 > 5（並び替え D&D を定義ストアの reorder に接続）** — 接続先が存在しない。一時タブ行の D&D は `TabRow.tsx` の `onDragOver` / `onDrop` が `dropZoneOf(...) === 'split'` のときだけ `preventDefault` する作りで、`'before'` / `'after'` は素通り（ピン留めツリー用）。今日の一時タブ一覧に並べ替えは無く、順序は `win.tabs` 順そのもの / 「接続」1 行の下に、上下帯の新規実装・既存の分割ドロップ帯との共存・自走検証の合成 D&D が丸ごと隠れている。決定表「並び順は共有側で 1 本」と Phase 1 のストア `reorder`・Phase 4 の `nemo:reorder-ephemeral` がここにぶら下がっているので、放置すると Phase 4 が膨らむか、誰も呼ばない API が残る / 推奨は**今回は並べ替えを作らない**（順序＝定義の追加順、新規は末尾）と決めて `reorder` とその IPC を計画から落とすこと。作るなら独立ステップとして帯の設計を書く。あわせて、順序の正が `win.tabs` から定義配列へ移る以上、`promotePeek` の「末尾へ動かす」（`win.tabs.splice`→`push`）も定義配列側で行う必要があることを Phase 2 に書き足す。
- **Phase 2 > 7（デタッチと定義削除の分離）** — 波及 close の中身が未定。`removeEphemeralEverywhere` が各ウィンドウの実体を `removeTab` で閉じる素直な実装だと、その `removeTab` がまた `ephemeralId` を見て定義削除へ回り再入する。さらに `rememberClosedTab`（`registry.ts:2652` 付近）は閉じた実体ごとに `closedTabs` へ push し `archiveTab` を呼ぶので、2 ウィンドウで開いていたタブを閉じると **⌘⇧T スタックに 2 件・ライブラリに同じ行が 2 つ**積まれる / 再入は無限ループ、重複記録は静かに壊れて「⌘⇧T を 2 回押さないと次のタブに行けない」になる。検査項目にも無いので気づかない / 「定義削除は 1 回、実体 close は N 回」を明記し、波及 close は `demoteEverywhere(removed, skip)` と同型の内部フラグ（`{ cascade: true }` 等）で `rememberClosedTab` を 1 回だけ通す。Phase 6 > 2 に「2 ウィンドウで開いた共有タブを閉じ、⌘⇧T **1 回**で戻る／アーカイブが 1 行」を足す。
- **Phase 3 > 2（冪等判定は版番号で）** — `JsonStore.load()` は `readVersioned` が返した `version` を捨てて `this.normalize(versioned.data)` しか呼ばない（`store/json-store.ts`）。`normalizeSession` は自分が読んでいるデータの版を知り得ないので、この判定は現行の契約では書けない。加えて移行結果の書き戻しは `JsonStore` のデバウンス（既定 400ms／session は `sessionStoreDebounceMs`）なので、移行直後に落ちると次回起動で再移行＝定義の二重登録 / Phase 3 の要である「やり直し不可の移行」の安全側が、実装不能な前提と書き込み遅延の上に立っている / `normalize(raw, version)` に版を渡すよう `JsonStore` を広げるか、判定を `legacyTabs` の有無に倒すかを決めたうえで、**移行完了直後に `saveNow()` で確定させる**（`markCleanExit` の前例）ことを明記する。Phase 3 > 5 の「2 回起動して冪等」に加えて「移行後の初回書き込み前に落ちた場合」も fixture で見られると尚よい。

## P1
- **Phase 1 > 2（`onChanged`）／Phase 2 > 6（書き戻し）** — `pins.ts` の `commit()` は差分を見ずに `store.set()` 後 listeners を同期で叩き、受け側は全ウィンドウ `pushShared()` ＝ `SharedState` 丸ごと（favorites / pinned ツリー / downloads / liveFolder / extensions ＋ 全一時タブ定義）を再送する。ピン定義は「ユーザー操作でしか変わらない」からこれで足りているが、一時タブの書き戻しは `did-navigate` / `did-navigate-in-page` / `page-title-updated` / `page-favicon-updated` ごとで、対象は全ウィンドウの全一時タブ / 1 ページ読み込むたびに全ウィンドウへ共有ブロブが数回〜十数回飛び、サイドバー全体が再レンダリングされる（今日は該当ウィンドウの `pushState()` だけ） / `ephemeral-tabs.ts` の `commit` に**値が変わったときだけ通知**の判定を入れ、通知はマイクロタスクかデバウンスで合流させる（`scheduleSessionSave` の 2 段デバウンスが前例）。この方針を Phase 1 のストア仕様に書く。
- **Phase 1 > 3（`index.ts` の初期化）／Phase 3 > 2（移行）** — 起動シーケンスの順序が書かれていない。`initEphemeralTabs` → `initSession` → 移行 → ウィンドウ復元、の 4 つに依存関係がある / 移行が復元より後に走ると初回起動でサイドバーが空のまま立ち上がり、その状態が保存される / Phase 3 > 2 に「復元より前に移行を終える」ことと `index.ts` での呼び出し順を 1 行で明記する。
- **Phase 2 > 5（転換ステップ）** — 降格経路として `Live Folder 降格` を `demoteEverywhere` と並べているが、Live Folder のタブは**ただの一時タブ**で、main 側に降格処理は存在しない。`Sidebar.tsx` が URL 一致で一覧から隠しているだけで、PR がマージされて一覧から消えると自然に今日のタブに現れる（`Sidebar.tsx:60-66` のコメントがまさにそう書いている） / 存在しない経路を探しに行かせるうえ、共有定義に移した後は「元から定義を持っている」ので**何もしなくてよい**という結論が見えなくなる / 転換ステップから Live Folder を外し、代わりに Phase 4 > 3 の URL 一致除外だけで足りることを一言添える。
- **Phase 6 > 2（検査項目）** — 今回新しく決めた 2 件に対応する検査が無い:「ウィンドウを閉じても定義は残る（A を閉じても B の一覧に残り、A を開き直すと出る）」「`about:blank` のローカル行は他ウィンドウに出ず、最初の http ナビゲーションで共有一覧に現れる」。P0 二点目の「ピン解除で行が 1 本だけ増える」も同様 / 決定表に書いたのに自走検証が無いと、後の変更で静かに戻る（この計画は「0 件検査の空振り防止」まで気にしているので、ここだけ抜けるのは惜しい） / 3 件を検査項目に追加する。

## P2
- **Phase 4 > 3（ローカルタブの併記）** — 併記の挿入位置が未定 / `about:blank` の行がローカル位置に出た後、最初のナビゲーションで共有一覧の末尾へ移動して行が飛ぶ / 「ローカルタブは常に一覧の末尾、定義化後もそのまま末尾」と 1 行決めておけば見た目が動かない。
- **Phase 5 > 1（閉じる側のガード）** — 拒否したときの見え方が未定 / × を押したのに何も起きないと壊れて見える（ログは残るがユーザーには届かない） / 開く側と同じくフォーカス移動を伴わせるか、拒否理由を短く見せる。
- **Phase 4 > 4（IPC）** — `nemo:close-ephemeral` はシークレット窓の renderer からも叩ける（`ephemeralTabs` を渡さないので ID は知らないはずだが口は開く） / 共有の除外という不変条件が IPC 層に無い / `requireTab` 相当の位置で `win.isPrivate` を弾く 1 行を足す。

## Q
````

**対応**: P0 は全 3 件反映。(1) 並べ替えは今回作らないと決定（決定表を更新し、ストアの reorder API と nemo:reorder-ephemeral・D&D 接続ステップを削除。promotePeek の末尾移動は定義配列側で行うと追記） (2) 「定義削除は1回・実体 close は N 回」、再入を内部フラグで止め rememberClosedTab は1回だけ、を明記し、⌘⇧T 1回・アーカイブ1行の検査を Phase 6 に追加（P0 由来なので追加を許容） (3) 冪等判定は legacyTabs の有無に倒し（JsonStore の normalize は版番号を受けない契約のため）、移行直後に saveNow() で確定と明記。「移行後の初回書き込み前に落ちた場合の fixture」は任意提案なので見送り（saveNow 化で窓が実質消えるため）。P1: ストア commit の差分判定＋デバウンス通知を Phase 1 に反映、移行を復元より前に終える呼び出し順を Phase 3 に反映、Live Folder 降格は存在しない旨に書き換え。P1 の検査 3 件追加（ウィンドウ閉→定義残存・about:blank ローカル行・ピン解除で行1本）は「足す修正はループ中見送り」の規則に従い保留（収束時に反映する）。P2 は 3 件とも反映（ローカル併記は常に末尾・閉じるガード拒否もフォーカス移動で見せる・close-ephemeral をシークレットから弾く）。未実体化行の操作は並べ替え廃止に合わせて「クリック・×」の 2 つに更新。

## 3回目

````text
再レビューしました。前回の P0 3 件は決定表・Phase 1/2/3 に反映済み、P1・P2 も該当箇所を確認しました（保留の検査 3 件は運用規則に従うものとして再指摘しません）。今回はコードに当てて新たに出たものだけです。

## P0

## P1
- **Phase 2 > 自動アーカイブ（`sweepArchive` の定義基準化）** — 実体ゼロの定義をアーカイブする経路が存在しない。今日の `sweepArchive` は `removeTab(win, key, { archiveReason: 'auto' })` を呼び、`archiveTab()` と ⌘⇧T スタックへの記録は `removeTab` 内の `rememberClosedTab(win, tab, ...)` が担っていて、どちらも `NemoTab` を要求する。共有定義は「どのウィンドウにも実体が無い」状態が普通なので、その定義は `removeTab` を一度も通れない / 自動アーカイブは「閉じるが消さない（ライブラリから掘り返せる）」が約束なのに、未実体化の定義だけ**記録を残さず黙って消える**。しかも消えるのは放置された定義＝ほとんどの定義 / Phase 2 のアーカイブ項目に「実体ゼロの定義は定義の url / title から直接 `archiveTab(url, title, 'auto')` を呼ぶ」経路を書き、⌘⇧T スタックに積むか（現行は自動アーカイブでも `closedTabs` に積まれる）も同じ場所で決める。既存コメントの「アーカイブは `removeTab` に任せる（経路を1本に）」という不変条件が変わるので、その旨も残す。
- **Phase 2 > `openEphemeral` / Phase 2 > `createTab`** — 「所属なしの http/https タブを作ったらその場で定義も作る」と「`createTab(win, url, { ephemeralId })` で実体化する」が同じ関数の中で衝突する。`resolveTabOwnership` は不正な ID を**黙って null に倒す**設計（`missing_pinned` / `duplicate_pinned` と同型で `duplicate_ephemeral` が起きうる）なので、ID を要求したのに落ちた場合、そのまま「所属なし」判定に流れて**同じ URL の定義がもう 1 本**増える / 復元・⌘⇧T・別ウィンドウからの実体化が競合したときに一覧が静かに増殖し、原因が `resolveTabOwnership` のログにしか出ない / 定義の新規作成は「呼び出し側が `ephemeralId` を渡していないとき**だけ**」に限定し、渡したのに落ちた場合は作らずに `tab.ownership_dropped` へ理由を残す、と Phase 2 に一行で明記する。
- **Phase 3 > 1（`session.json` スキーマ変更）** — 空ウィンドウの扱いが未定。今の `normalizeSession` は `if (tabs.length === 0) return []` でタブ 0 のウィンドウを捨て、`index.ts` は `restored.windows.length > 0` で復元可否を決めている。`tabs` を外すとこの間引きが効かなくなる / 「実体を 1 つも持たないウィンドウ」は新モデルでは正常な状態（共有一覧のビュー）なのに、旧コードの間引きが残ると復元されず、逆に無条件に全部残すと今日の「空ウィンドウは 1 枚に倒す」挙動が変わる。どちらにせよ `normalizeSession` の書き換え時に判断を迫られる / 推奨は**bounds があるウィンドウは全部復元する**（間引きを落とす）と決めて書くこと。決定表の「ウィンドウを閉じても定義は残す」と筋が通る。
- **Phase 3 > 1／> 2（テスト更新）** — `scripts/settings-schema.test.mjs` に `normalizeSession` のケースが 10 数本あり（版 2 のピンタブ除外、`activeIndex` の付け替え、`splits` の添字検証など）、`tabs` を外して版を上げると全部が対象になる / Phase 1 のユニットテスト項目は新しい `EphemeralTabDef` の正規化だけを指していて、既存 session ケースの扱い（どれを版 2 fixture として残し、どれを `legacyTabs` の検査に置き換えるか）が計画に無い。ここは移行の唯一の純関数テストなので、削って通すのが一番危ない / Phase 3 に「`settings-schema.test.mjs` の session ケースを更新（版 2 / 版 4 の両方から `legacyTabs` が出ること、移行後の再読み込みで付かないこと）」をステップとして足す。

## P2
- **Phase 5 > 1（通話ガードのログ）** — 開く側と閉じる側で同じ `log('call.open_guarded', { defId })` を使うことになっている / 後からログを見たとき「開こうとして止めた」のか「閉じようとして止めた」のか区別できない / `call.guarded` + `action: 'open' | 'close'` のようにフラットな detail で分ける（`MAX_DEPTH` の制約にも収まる）。
- **動作確認 [人間👨‍💻]** — 並び順が「全ウィンドウ共通・定義の追加順」になると、他ウィンドウで開いたタブが**自分の一覧の末尾に割り込んでくる**（今日は自分のウィンドウで開いたタブしか増えない） / 実装上の問題ではないが、ディスプレイ 2 枚での常用でいちばん体感が変わるのはここ / 人間の動作確認項目に「他ウィンドウでタブを開いたときの割り込みが邪魔に感じないか」を 1 行足しておくと、方針変更が要るかどうかを早く判断できる。

## Q
````

**対応**: P0 が空になったので収束。収束回の P1/P2 を全件反映（再レビューなし）: (P1-1) 実体ゼロの定義のアーカイブ経路（定義の url/title から直接記録・⌘⇧T にも積む・「経路を1本に」コメントの更新）を Phase 2 に追加 (P1-2) createTab の定義作成は ephemeralId 未指定時のみ、落ちたら作らずログ、を追加 (P1-3) 実体を持たないウィンドウも bounds があれば全部復元（間引きを落とす）と決定 (P1-4) settings-schema.test.mjs の normalizeSession ケース更新ステップを Phase 3 に追加 (P2-1) 通話ガードのログを call.guarded + action で出し分け (P2-2) 人間の動作確認に「末尾割り込みの体感」を追加。前回保留していた P1 の検査 3 件（ウィンドウ閉→定義残存・about:blank ローカル行・ピン解除で行1本）も Phase 6 に反映。
