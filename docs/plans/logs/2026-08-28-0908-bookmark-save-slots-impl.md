review session: 1d281bd0-1444-4ba0-b4f2-81a5532eff6c

# 実装レビューログ: ブックマークのセーブスロット

## 1回目

````text
## P0
- `scripts/verify-all.mjs:want`（Phase 6 > ステップ 2） — `slots` を `KNOWN_TARGETS` / `OWNERS` に登録しただけで、`verify-all.mjs` に `if (want('slots'))` のブロックが無く `scripts/verify-slots.mjs` を誰も起動しない / `mise run verify:only slots`（VERIFY.md が指しているコマンド）が **1 件も検査せず exit 0** になり、フルの `pnpm verify` でもスロットは一度も回らない。`verify-targets.test.mjs` は登録の有無しか見ないので、この腐り方は「速く PASS」して気づけない（`verify-targets.mjs` 冒頭の警告そのもの） / `migration` / `db` と同じ形で `await stopAll()` → `runToCompletion(process.execPath, ['scripts/verify-slots.mjs'])` のブロックを足す。`.mise.toml` の `verify:only` の usage 文字列にも `slots` を入れる。
- `src/renderer/components/Slots.tsx:SlotCard`（Phase 4 > ステップ 1 / 決定表「カードに出す情報」） — アイコンの `+N` が出ていない（`slot-icons` は最大 6 個を並べて終わり） / モックで確定した「アイコン 6 個 + `+N`」に反する。6 件で打ち切っていることが画面から分からず、「アイコンがこれだけしか無い枠」に見える / `slot.pins + slot.favs - slot.icons.length` が正なら `<span className="slot-icons-more">+{n}</span>` を並べる（`styles.css` にもトークンでスタイルを足す）。

## P1
- `src/main/store/slots.ts:readSummary`（Phase 1 > ステップ 3） — `readVersioned` が null を返す理由を「未来の版」に決め打ちしている。`readVersioned` は **`version` が無い / 整数でない / 1 未満**でも null を返す / 手で編集された・途中まで同期された `slot-N.json` が「新しい版の Nemo で保存されています」と表示され、しかも壊れているのに `.broken-<時刻>` へ退避されないので、その枠は永久に `unreadable` のまま保存もできない（plan の「壊れていたものは退避する」が効かない） / `parsed.version` を自分で見て「> `SLOTS_VERSION` なら未来の版（退避しない）」「それ以外は壊れ扱いで `quarantine` + 理由を『中身が壊れていました』」に分ける。
- `src/main/store/slots.ts:readWithTimeout` — `AbortSignal` は**進行中の read を切れない**（Node は chunk の切れ目でしか signal を見ない）。evicted な iCloud ファイルで最初の読み取りが止まると 4 秒では戻らない / plan の「時間内に読めない枠は `unreadable` で返す」が成立せず、`listSlots` の `Promise.all` が 1 枠のせいで返らない（＝設定画面が永久に空のまま） / `Promise.race([readFile, タイムアウトで reject])` にして、枠ごとに必ず期限内に決着させる（abort は後片付けとして残す）。
- `src/renderer/components/Slots.tsx:Slots` — `listSlots().then(setList)` と `run()` に `catch` が無く、`list` が null のときの表示も無い / IPC が reject / 遅延すると、カードが 0 枚のセクションが黙って出るだけ（`run` の場合は `busy` が true のまま戻らず、ダイアログのボタンが押せなくなる）。原因の手掛かりが画面にもログにも残らない / `catch` で `setError('スロットを読めませんでした')` + `setBusy(false)` を必ず通し、`list === null` の間は「読み込み中…」を出す。
- `src/renderer/components/Slots.tsx:ConfirmDialog`（および `SlotCard` のメニュー / `SlotName`）（Phase 4 > ステップ 1・2） — Esc の `keydown` を `document` / React ハンドラで受けるだけで `stopPropagation()` していない。`Overlay.tsx` が `window` で Esc を拾って `setOverlay(null)` する / 確認ダイアログを Esc で取り消す・メニューを Esc で閉じる・名前編集を Esc で取り消す、のいずれでも**設定パネルごと閉じる**。plan の「Esc で閉じる / 取消」の意図（1 段だけ戻る）にならない / 3 か所の Esc 分岐で `event.stopPropagation()` を呼ぶ（`document` リスナーは `window` より先に走るので、これで Overlay 側には届かない）。
- `src/shared/slots-schema.js:collectIcons` — お気に入りとピン留めを連結するだけで URL を重複排除していない / 同じ URL をお気に入りにもピン留めにもしている（普通にありうる）と `icons` に同じ URL が 2 件入り、`SlotCard` の `<Favicon key={icon.url}>` で **React の key が衝突**する。6 枠のうち 1 つを重複で潰しもする / `urls` を組み立てたあと `[...new Set(urls)]` してから `slice(0, MAX_SLOT_ICONS)` する。
- `src/main/registry.ts:applySlot`（Phase 2 > ステップ 3） — ログが plan の `slot.applied`（index / 降格したタブ数 / 差し替えた定義数）と食い違う。`index` が無く、`demoted: removed.length` は**降格したタブ数ではなく消えた定義数** / 「タブが 3 本降りたはず」を後からログで追えず、名前を信じると誤診する。`index` が無いのでどの枠を読んだかも分からない / `demoteEverywhere` に降格した数を返させて `demoted` に入れ、`removed.length` は `definitions` として別に出す。`applySlot(index, data)` にして index も載せる。
- `scripts/lib/nemo-data.mjs:matchesUserDataArg` / `backupLiveData`（Phase 5 > ステップ 1・2） — `config-sync.test.mjs` を消したことで、移設したこのコードのテスト（`--user-data-dir` を引数まるごと一致させる / Nemo Dev だけ起動中でも stable を止めない / バックアップは channel と用途で分かれる）が全部消えた。しかも `backupLiveData` は `files` 必須の新シグネチャに変わり、`arc-import.test.mjs` は `scripts/arc-import.mjs` を import しないので新しい呼び出しを一度も通らない / 守っているのは「起動中の Nemo を書き潰さない」という、この計画のログで実際に事故った経路そのもの。無検証のまま残ると次に壊れたとき何も鳴らない / `scripts/nemo-data.test.mjs` を作り、`matchesUserDataArg` の前方一致ケースと `backupLiveData(dir, stamp, { channel, kind, files })`（`files` 未指定で throw / 無いファイルは `existed: false`）を移植する。
- `scripts/lib/verify-targets.mjs:OWNERS` — `src/renderer/components/Slots.tsx` を `['slots']` だけに割り当てているが、`verify-slots.mjs` は IPC しか叩かず**設定パネルを一度も開かない** / Slots.tsx だけを直したときに回るのが「UI を見ない検証」だけになる。設定オーバーレイを描画する検証は `http-auth` と `phase2` にあるので、Slots.tsx の描画例外（＝設定画面全体が落ちる）が `--changed` をすり抜ける / `verify-slots.mjs` に `setOverlay('settings')` → `[data-testid="slots"]` と `slot-0` の存在確認を足すか、`OWNERS` から Slots.tsx を外してフルに倒す（`OWNERS` は「そのスイートしか見ていないと確かめたものだけ」という前提に反している）。

## P2
- `src/main/store/slots.ts:saveSlot`（Phase 1 > ステップ 3） — `existsSync` が tmp を書く**前**にある。plan は「rename の直前に確かめる」。窓は広がるだけで実害は小さいが、`writeFile` の所要時間ぶん他 Mac の保存を潰す余地が残る / `rename` の直前へ移すか、`fsp.rename` の代わりに `fsp.link` + `unlink`（既存があれば EEXIST）で原子的に排他する。
- `src/renderer/components/Slots.tsx:SlotCard` — `onRename` が `renameSlot` の戻り値を捨てている。読み書きに失敗しても表示だけ元に戻り、理由が出ない / 保存・削除と同じく `run()` を通して失敗を出す。
- `src/main/store/slots.ts:slotsDir` — iCloud が TCC 拒否などで `existsSync` false のとき、黙って `userData/slots/` に倒れる。パスは出るが `kind` は画面に出ていないので、「iCloud に保存したつもりでローカルに保存」が起きても気づきにくい / `kind === 'fallback'` のときだけ「iCloud Drive が見つからないので、この Mac の中に保存します」の 1 行を保存先の隣に出す。
- `src/main/store/pins.ts:replaceAll` → `src/main/registry.ts:applySlot` — `listeners`（`pushShared`）が `demoteEverywhere`（`pushState`）より先に走るので、定義が新しく・タブの `pinnedId` が古い状態が 1 メッセージぶん露出する / 実害は描画のちらつきだけだが、順序を入れ替えるなら `applySlot` 側で demote 後に `pushShared` を撃つ形にできる。
- `scripts/lib/nemo-data.mjs:restoreBackup` — `config:restore` を消したので呼び出し元が無い死んだコード / 使われないまま残ると「戻す手段がある」と誤読される。消すか、README / VERIFY に手動での戻し方として書く。
- `src/main/store/slots.ts:findConflictCopies` — 正規表現 `^slot-(\d+)[^.]+\.json$` は `slot-12.json` を「slot-1 の競合コピー」として拾う（バックトラックで `\d+`=1、`[^.]+`=2）/ 実在しないファイル名なので実害はないが、`^slot-([1-3]) [^.]*\.json$` のように空白始まりに寄せると意図が明確になる。
- `src/main/ipc.ts:registerIpcHandlers` — `isSlotIndex` の定義と `nemo:list-slots` の間に空行が 2 つ入っている / prettier をかけると差分が出る（直近のコミットで整形を別立てにしているので、ここで潰しておくと楽）。

## Q
- `docs/plans/2026-08-27-2158-bookmark-save-slots.md:決定表（スロットの中身）` — config-sync 廃止後、`settings.json`（キーバインド）と GitHub PAT を 2 台目へ移す手段が無いままになっている / 冒頭の目的「新しい Mac は設定画面だけで移行が完結する」が満たせない。今は移す中身が無いという前提なので、カスタマイズを始めた時点で判断が要る。
- `docs/plans/2026-08-27-2158-bookmark-save-slots.md:決定表（dev 版）` — dev と stable でスロットを分けたため、実データでの読み込みが常用機での本番実行が初回になる（自走検証は使い捨てディレクトリ）/ undo が無い操作の初回が本番。dev から常用スロットを**読み取り専用で一覧だけする**経路を許すか、人間の動作確認の手順（先に空き枠へ保存する以外の保険）を決めるかの判断が要る。
- `src/renderer/components/Slots.tsx:SlotCard`（unreadable の枠） — 読めない枠の再試行手段が「設定パネルを開き直す」しか無い / iCloud のダウンロード待ちは数秒で解けることが多いので、カードに「再試行」を置くかどうかは UI を増やす判断になる（計画のレビューでもループ中は見送りとして持ち越されている）。

````

**対応**: P0 2件とも反映。① `verify-all.mjs` に `want('slots')` ブロックを追加（`stopAll()` → `verify-slots.mjs`）、`.mise.toml` の `verify:only` usage にも `slots` / `http-auth` / `vim-scroll` を追記。② `SlotCard` に `+N`（`pins + favs - icons.length`）と `.slot-icons-more` のスタイルを追加。
P1 は全件反映。`readSummary` で「未来の版」と「version が壊れ」を自分で見分けて後者は quarantine / `readWithTimeout` を `Promise.race` に変更（AbortSignal では進行中の read を切れない）/ `Slots.tsx` の `refresh` と `run` に失敗経路（catch + busy 復帰 + `list === null` の「読み込み中…」）/ Esc の `stopPropagation` を3か所（メニュー・名前編集・確認ダイアログ）/ `collectIcons` と `normalizeIcons` で URL を重複排除 / `applySlot(index, data)` にして `demoteEverywhere` に降格タブ数を返させ、ログを `demoted`（タブ数）と `definitions`（定義数）に分離 / `scripts/nemo-data.test.mjs` を新設（`matchesUserDataArg`・マーカーでの channel 判定・`backupLiveData` の channel/kind 分離と `files` 必須・`existed:false` の戻し）/ `verify-slots.mjs` に設定画面を開いてカード3枚と SLOT 1 の中身を見る検査を追加（`evalInUi` に `view` 引数）。これで `OWNERS` の `Slots.tsx → slots` が嘘でなくなる。
P2 は書き換え・削除で済むものを反映: `saveSlot` の存在確認を rename の直前へ移動 / `findConflictCopies` の正規表現を `^slot-(\d+) [^.]*\.json$` に（`slot-12.json` の誤検出） / `onRename` を `run()` 経由にして失敗を出す / `slotsDir` が fallback のとき設定画面に注記を出す / `restoreBackup` は死んだコードではなく最後の手段として残す旨を jsdoc に明記 / `ipc.ts` の二重空行を削除。
見送り: `pushShared` と `pushState` の順序（P2）—— 実害が描画のちらつきだけで、直すには `replaceAll` の listener 発火を呼び出し側へ引き出す必要があり、指摘の範囲を超えて `pins.ts` の契約を変えることになる。
Q はいずれも未着手ステップ（人間の確認）と設計判断なので手を付けず、終了報告に回す。
検査: `pnpm typecheck` / `pnpm lint` / `pnpm test`（256 pass）を通した。

## 2回目

````text
再レビューしました。前回の P0 2 件・P1 8 件は現物で確認でき、いずれも意図どおり入っています（`want('slots')` ブロック、`+N`、version 壊れの分離と quarantine、`Promise.race` のタイムアウト、UI の失敗経路、Esc の `stopPropagation` 3 か所、URL の重複排除、`applySlot(index, data)` とログの分離、`nemo-data.test.mjs`、`verify-slots.mjs` の設定画面チェック）。

## P0
- `scripts/verify-slots.mjs:evalInUi`（Phase 6 > ステップ 3・4） — Phase 6 の「`pnpm verify`」は `[x]` のままだが、**このスイートは今回の差分で初めて回る経路になった**（前回まで `verify-all.mjs` から呼ばれていなかった）。報告された検査は typecheck / lint / test だけで、`verify-all` 経由の実行も、今回足した `view=overlay` のカード描画チェックも一度も動いていない / 検証コードは動かすまで正しさが分からない。特に描画チェックは `catch { cards = 0 }` で例外を飲むので、target の選び方（1 ウィンドウ前提の `find(view=overlay)`）や `innerText` のタイミングがズレていても「15 秒待って FAIL」としか出ず、原因が見えない。ここが通らないまま `OWNERS` に `Slots.tsx → ['slots']` を書いてあるので、UI 回帰の網が張れている「つもり」になる / `mise run verify:only slots`（できれば `pnpm verify` も）を一度通し、結果を plan のログに残してから Phase 6 を閉じる。

## P1
- `src/renderer/components/Slots.tsx:Slots`（`refresh` の失敗経路） — `listSlots()` が reject したとき `setList({ dir: '', kind: 'fallback', slots: [], current: … })` と**偽のリストを作っている**。`kind: 'fallback'` は JSX の「iCloud Drive が見つからないので、この Mac の中に保存します。ほかの Mac からは見えません。」を出す条件そのもの / IPC が落ちただけなのに、**保存先について事実でない案内**が出る（保存先の `code` は空欄）。ユーザーは「iCloud が使えなくなった」と誤診し、実際にはまだ iCloud にある枠を空きだと思って触りに行く / 失敗は `list` に混ぜず `const [failed, setFailed] = useState(false)` のような別状態で持ち、失敗時は「読み込み中…」も fallback の注記も出さずエラー行だけ出す。

## P2
- `src/renderer/components/Slots.tsx:SlotCard`（`+N`） — `slot.pins + slot.favs - slot.icons.length` は、`collectIcons` / `normalizeIcons` が**同じ URL と不正 URL を落とした分**まで数える。お気に入りとピン留めに同じサイトを入れていると、6 件で打ち切っていないのに `+2` が出る / 実害は表示のズレだけだが、`+N` は「隠れている数」として読まれる / `slot.icons.length === MAX_SLOT_ICONS` のときだけ出す（打ち切りが起きた場合に限る）か、`SlotData` に候補の総数を持たせて正確に出す。
- `src/renderer/components/Slots.tsx:Slots`（`slots-error` の `<p className="warn">`） — `styles.css` に**素の `.warn` 規則が無い**（あるのは `.lf-badge.warn` / `.footer .warn` / `.set-row .warn` / `.slot-blank.warn`）。設定の `<section>` 直下なのでどれにも当たらない / 失敗の通知が本文と同じ色・同じ大きさで出て見落とす / `.slots` の並びに `.slot-error`（`--nemo-danger`）を足すか、既存の `.set-row .warn` と同じ見た目のセレクタを増やす。
- `scripts/nemo-data.test.mjs:'Nemo Dev だけが動いていても stable の操作は止まらない'` — 実リポジトリの `.nemo-run/<pid>.json` を書いて消す（サンドボックス外）。復元は `finally` で行っているが、プロセスが落ちるとマーカーが残る / 残っても `process.kill(pid, 0)` で死んだ pid は読み飛ばすので実害は小さいが、他のテスト・検証と同じ実ディレクトリを共有しているのは避けたい / `findRunningForChannel` がマーカーを探す起点（いまは `projectRoot` 固定）を env で差し替えられるようにして、テストは一時ディレクトリを見る。
- `docs/plans/2026-08-27-2158-bookmark-save-slots.md:ログ` — 今回いちばん効いた学び（**`KNOWN_TARGETS` / `OWNERS` に登録しても `verify-all.mjs` に `want()` ブロックが無ければ 1 件も回らず、しかも「速く PASS」する**）がログに残っていない / 次にスイートを足すときに同じ穴に落ちる。`verify-targets.test.mjs` は登録しか見ないので、テストでは気づけない / 「試したこと・わかったこと」に 1 項目足す（ついでに `verify-targets.mjs` の冒頭コメントに「`verify-all.mjs` への配線も要る」を書くと、次は現物から気づける）。

## Q
- `scripts/lib/verify-targets.mjs:OPT_IN_ONLY` — `slots` をフル実行の既定に含めたままにするか、`vim-scroll` と同じく名指しのときだけ回すか / このスイートはアプリを 4 回起動し直すので、フルの所要時間（529s → 372s に縮めたばかり）に 1〜2 分上乗せされる。undo の無い機能なので常時回したい気持ちと、フルを短く保ちたい方針のどちらを取るかは判断が要る。

````

**対応**: P0（検証を一度も回していない）に対応 —— `pnpm exec electron-vite build` 後に `node scripts/verify-slots.mjs`（30 件すべて PASS）と `node scripts/verify-all.mjs --only slots`（同 30 件 PASS）を通した。設定画面のカード描画チェックも実際に通っている（`SLOT 1\n名前だけ変更\n…\nピン 1 件・お気に入り 1 件` を読めている）。さらに **`want('slots')` ブロックを外した状態で `--only slots` を回して、検査 0 件のまま「すべて PASS」exit 0 になること**（＝修正前の FAIL 相当）を確認してから戻した。
P1（`refresh` の失敗経路が偽の `SlotList` を作る）を反映: `failed` state を分け、失敗時は `list` を触らない。`kind: 'fallback'` の注記が IPC 失敗で出る問題が消えた。
P2 は2件反映。① `+N` は **main が数える**（`slots-schema.js` に `iconCandidates` を切り出し、`SlotSummary.moreIcons` として渡す）。当初 renderer に `MAX_SLOT_ICONS` を import したが、**plan の方針変更に「`slots-schema.js` を web の tsconfig に入れずに済む」と明記されている**ので tsconfig ごと巻き戻し、数える側を main に寄せた。② `.warn` が効いていなかった件は `.slots-error`（`--nemo-danger`）を追加。③ plan のログに「`KNOWN_TARGETS` / `OWNERS` に登録しただけでは 1 件も回らない（`verify-all.mjs` の配線が別に要る）」を追記し、`verify-targets.mjs` の冒頭コメントにも同じことを書いた。
見送り: `nemo-data.test.mjs` がリポジトリの `.nemo-run/` を触る件（P2）—— 直すには `findRunningForChannel` のマーカー起点を env で差し替える仕組みを足すことになり、指摘の範囲（テスト）を超えて本番コードの解決順を増やす。指摘自身が「実害は小さい」としており、`finally` で復元・死んだ pid は読み飛ばす二重の保険がある。
検査: `pnpm typecheck` / `pnpm lint` / `pnpm test`（256 pass）/ `verify:only slots`（30 pass）。

## 3回目

````text
All three Esc handlers, the `failed` state, `moreIcons`, `.slots-error`, the `verify-all.mjs` wiring, and the plan/`verify-targets.mjs` notes are in place as described. The `+N` is now computed in main from `iconCandidates(favorites, pinned).length - icons.length`, so it only appears when icons were actually truncated — the dedupe/invalid-URL overcount is gone, and `slots-schema.js` stayed out of the web tsconfig.

## P0

## P1

## P2
- `src/main/ipc.ts:registerIpcHandlers`（`nemo:save-slot`） — favicon を引く URL を作るのに `collectIcons(favorites, pinned, new Map()).map((icon) => icon.url)` と**空の Map を渡して 1 回目を捨てている**。`iconCandidates` を公開した今は同じことを直接書ける / 動作は同じだが、「favicon 無しで組んでから URL だけ取り出す」という迂回が残っていて、`collectIcons` の 2 回呼び出しがツリーを 2 度歩く / `const urls = iconCandidates(favorites, pinned).slice(0, MAX_SLOT_ICONS)` にして、`collectIcons` は本番の 1 回だけにする。
- `docs/plans/2026-08-27-2158-bookmark-save-slots.md:Phase 6 > ステップ 3`（`pnpm verify`） — 今回の差分は `src/shared/types.ts` / `src/main/ipc.ts` / `src/renderer/styles.css` を触っているが、これらは `OWNERS` に無い＝リポジトリの決めごとでは**フルに倒れる**ファイル。回したのは `verify:only slots` だけ / 実害の可能性は低い（設定画面の描画は slots スイートが見ている）が、`--changed` の設計上は「知らないファイル＝フル」なので、コミット前に一度だけ `mise run verify:changed` を通しておくと Phase 6 のチェックと実績が揃う。

## Q

````

**対応**: P0 なし（収束）。収束回に P2 を 1 件反映 —— `ipc.ts:nemo:save-slot` の「空 Map で `collectIcons` を呼んで URL だけ取り出す」迂回をやめ、`iconCandidates(favorites, pinned).slice(0, MAX_SLOT_ICONS)` に変更（ツリーを 2 度歩かない）。もう 1 件の P2（フル検証を回す）は動作確認として実施した。
plan のログ > 方針変更に「`+N` も main が数える（`SlotSummary.moreIcons` / `iconCandidates`）」を追記。
検査: `pnpm typecheck` / `pnpm lint` / `pnpm test`（256 pass）/ `node scripts/verify-all.mjs --changed`（絞れずフルに倒れ、全スイート PASS）。
