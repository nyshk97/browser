review session: 98853607-9de5-4bf1-a9be-a0e21f3ca4d2

## 1回目

````text
レビューにあたりファイルは全部読みましたが、`pnpm typecheck` / `node --test` / `verify:only auth-vault` の実行は許可が下りず動かせていません（以下は静的読解のみ）。

## P0
- `scripts/verify-auth-vault.mjs`（plan `Phase 7 > ステップ 1`） — 検査項目「`locked`（違うパスフレーズで書かれた保管庫）で保存がブロックされること」が無い。あるのは `authVaultPreviewLoad("wrong-passphrase-x")` だけで、**保存側は `PASSPHRASE` と `null` しか通していない** / 保存は「全件置き換え」で undo が無く、パスフレーズ違いのまま保存を通すのが最悪の事故なのに、そこだけ自走検証が素通りする。`preview-save` が `openVault` を呼ばなくなる回帰を誰も止められない / 2 台目のブロックで `window.nemo.authVaultPreviewSave("wrong-passphrase-x")` が `ok === false && reason === 'bad-passphrase'` になることを 1 件足す（`tampered` に畳まれていないことも同時に固定できる）
- `src/renderer/components/AuthVault.tsx:VaultCard`（plan `Phase 6 > ステップ 1`、`画面の形`） — 計画は「『···』は hover で現れ、メニューは『削除』（danger 色）の 1 項目」だが、実装は `ok` 状態のカードで 保存 / 読み込む と同じ行に **常時見える danger ボタンの「削除」**を並べている / 保管庫の削除は全 Mac から見えなくなるうえ記憶しているパスフレーズも道連れで、undo が無い。計画が hover メニューに隠したのはこの誤爆を避けるためで、常時表示は「読み込む」の隣に不可逆操作を置くことになる / `Slots.tsx` の `slot-menu` / `slot-menu-btn`（`data-testid="slot-menu-N"`）をそのまま流用し、`ok` カードの削除をメニュー配下に移す

## P1
- `src/main/store/auth-vault.ts:readMeta`（plan `Phase 4 > ステップ 1`） — 封筒の検査に `normalizeVaultFile` を使わず、meta だけを見る緩い自前実装になっている（`kdf` / `iv` / `ciphertext` / `tag` を一切見ない。`count` の整数性・負値も見ず、`host` を `MAX_META_TEXT` で切らない） / `auth-vault-schema.js` の冒頭が「二重に書くと片方だけ直したときに静かに食い違う」と書いている当のものが二重になっている。実害として、kdf が欠けた壊れたファイルがカード上は `ok`「N 件」に見え（実際は `decryptVault` が必ず `malformed`）、任意長の `host` がそのままカードに描かれる / `readVaultFile` の `readMeta(versioned.data)` を `normalizeVaultFile(versioned.data)` に置き換え、`null` は既存の `bad_envelope` 経路（退避 + `unreadable`）に落とす
- `src/main/store/http-auth.ts:saveHttpAuthRule`（plan `Phase 3 > ステップ 2`） — `updatedAt: Date.now()` を無条件で入れているため、**有効トグルでも更新時刻が動く**。設定画面のトグルは `setHttpAuthRuleEnabled` ではなく `saveHttpAuthRule({ id, username, enabled })` を呼ぶ（`Settings.tsx:525` 付近。plan のログにも記録済み） / 計画は「内容が変わっていないので更新しない」と決めている。Mac A が中身を編集（t1）→ Mac B がチェックを外しただけ（t2 > t1）で、差分の `newer` が「この Mac の方が新しい」と嘘をつく。`newer` を足した目的そのものが崩れる / `existing` と `pattern` / `username` / `password`（`changesPassword`）を比べ、どれも変わらなければ `existing.updatedAt` を引き継ぐ
- `src/main/ipc.ts:nemo:auth-vault-save` — 下見と書き込みの間に保管庫が変わっていないかを確かめずに rename している。読み込み側は `openVault` で読み直して再分類しているのに、保存側だけ守りが無い / 別の Mac が下見中に保存した内容を無言で全件潰す。ユーザーが見た「消えます N 件」も古い。undo が無いのでファイルを手で戻す以外に回復できない（plan レビュー 1 回目の P1「`writeVault` の上書き競合検出」が「終了報告に回す」で見送られたまま） / `preview-save` の戻りに下見時の `mtimeMs` + `size` を載せ、`saveVault` の rename 直前に `fsp.stat` で一致を確かめる。違えば `write-failed` とは別の理由で返して「保管庫が更新されています」とやり直させる
- `src/main/ipc.ts:nemo:auth-vault-save` / `src/renderer/components/AuthVault.tsx:VaultDialog`（plan `Phase 5 > ステップ 1`） — 「この Mac に覚える」を OFF にしても既存の記憶が消えない（`rememberPassphrase` は `remember === true` のときだけ呼ばれ、`forgetPassphrase` は保管庫の削除時しか走らない）。`forgetAuthVaultPassphrase` は preload・型・IPC まで通っているが **renderer のどこからも呼ばれていない dead endpoint** / チェックを外した人は「この Mac は覚えていない」と思うのに記憶は残り、次に開くと 1 段目が自動通過する。記憶を消したい人の唯一の手段が「保管庫ごと削除」になる / 保存・読み込みの成功時に `remember !== true && resolved.entered` なら `forgetPassphrase()` を呼び、記憶がある状態でも「この Mac に覚える」を出して外せるようにする（これで `forgetAuthVaultPassphrase` にも呼び手が付く）
- `src/renderer/components/AuthVault.tsx:VaultCard` — `unreadable` カードが理由によらず「削除」を出すので、**「新しい版の Nemo で保存されています」の保管庫をワンクリックで消せる** / `readVaultFile` が未来の版を退避しないのは「古い Nemo が新しい方の保管庫を全件消すのを防ぐ」ためなのに、UI が同じ結果への近道を出している。押した側は自分の Mac の話だと思っている / `status.reason` が未来の版のときは削除を出さず、`再試行` と「Nemo を更新してください」だけにする（判定用に `status` へ `reason` の種別を 1 つ足すのが確実。文字列一致に頼らない）
- `src/shared/auth-vault-schema.js:VaultFile` — typedef のコメントが「`meta` … 平文のメタ。**AAD に入れる**ので改竄すると復号が失敗する」のまま。実装は AAD を使わず暗号内の写しと突き合わせている / plan で「AAD だと改竄とパスフレーズ違いを原理的に区別できない」と実測して撤回した、まさにその決定に反する記述。読んだ人が「実装が計画どおりでない」と見て AAD 化しに行く / 「写しを暗号の中に入れて復号後に突き合わせる（AAD にしない理由は `auth-vault-crypto.js` の冒頭）」に直す

## P2
- `src/renderer/components/AuthVault.tsx:LoadBody` — `{toUsername} → {fromUsername}` にどちらが保管庫か示すラベルが無い / 「この Mac → 保管庫」なのか逆なのか、画面だけでは判別できない / 「この Mac: admin → 保管庫: admin2」の形にするか、グループ見出しに向きの凡例を出す
- `src/renderer/components/AuthVault.tsx:messageFor` — `openVault` が返す `detail`（「新しい版の Nemo で保存されています」等）を捨てて、`unreadable` を一律「保管庫を読めませんでした。」にしている / IPC まで運んだ理由が画面に出ない / `detail` があればそれを優先して出す
- `scripts/auth-vault-crypto.test.mjs`（「封筒に書かれた KDF パラメータで復号する（既定値を決め打ちにしない）」） — 渡している file の kdf は `KDF_PARAMS` そのものなので、`decryptVault` が既定値を決め打ちしても PASS する / テスト名が約束していることを検査していない / 別の `N` で作った fixture（`scrypt` を直に呼んで組む）で復号するか、名前を「封筒に kdf が載っている」に落とす
- `src/main/ipc.ts:nemo:auth-vault-load` — `wanted.size === 0` のとき何もせずに `authCacheCleared: true` を返す / 実際にはキャッシュを消していない。UI 側で 0 件は押せないので今は表に出ないが、戻り値としては嘘 / `false` を返すか、この分岐でも `httpAuthCredentialsChanged` を通す
- `src/main/ipc.ts:nemo:auth-vault-load` — `stale` が `wanted.size - entries.length` なので、`same` のパターンを渡された場合や、下見のあとに**手元が保管庫と同じ内容に変わった**場合まで「保管庫が更新されていたため」に数える / 件数の説明文と原因がずれる / 再分類時に「保管庫から消えた」と「手元が追いついた」を分けて数える

## Q
- `src/main/store/auth-vault.ts:rememberPassphrase` / `src/renderer/components/AuthVault.tsx:AuthVault` — 「この Mac に覚える」を後から取り消す導線を UI に出すか（P1 で挙げた「OFF にしても消えない」を直すだけにするか、設定に「この Mac の記憶を消す」を独立して置くか） / 決めないと `forgetAuthVaultPassphrase` は呼び手の無い IPC のまま残り、共有 Mac で記憶だけ消したい人は保管庫ごと削除するしかない

````

**対応**: P0 2 件を反映 —— (1) カードの「削除」を `Slots.tsx` と同じ「···」メニューへ移し、計画の「画面の形」に合わせた。あわせて `AuthVaultStatus.isFutureVersion` を足し、**未来の版の保管庫には削除を出さない**（文字列一致ではなくフラグで判定）。(2) 自走検証に「違うパスフレーズでは保存の下見が通らない」を追加。

P1 は 3 件反映 —— `readVaultFile` の封筒検査を自前の `readMeta` から `normalizeVaultFile` に寄せた（二重定義の解消。kdf の欠けたファイルが `ok`「N 件」に見えていた）/ `saveHttpAuthRule` で**中身が変わっていなければ `updatedAt` を据え置く**ように条件を足した / `VaultFile` の typedef から AAD の記述を消した。

P2 は 5 件すべて反映 —— 差分の矢印に「この Mac → 保管庫」のラベル / `unreadable` の `detail` を捨てず優先表示 / KDF のテスト名を実態に合わせる / 0 件取り込みで `authCacheCleared: true` と嘘をつかない / `stale` を「保管庫から消えたもの」だけに限定。

**指摘の前提が誤っていた 1 件**: P1「有効トグルでも `updatedAt` が動く」は成立しない。設定画面のトグルは `pattern` を省くので IPC が `setHttpAuthRuleEnabled` へ分岐し（`ipc.ts:1023`）、そちらは `...item` を展開して `enabled` だけ変えるため `updatedAt` は保たれる（`store/http-auth.ts:358`）。ただし「何も変えずに保存を押すと時刻が動く」という狭い版は実在したので、そこだけ直した。

見送り: P1「`writeVault` の上書き競合検出」—— 仕組みの追加なのでループ中は入れず終了報告に回す（plan レビューでも同じ理由で見送っている）。

保留: P1「『この Mac に覚える』を OFF にしても記憶が消えない / `forgetAuthVaultPassphrase` が dead endpoint」—— Q「記憶を取り消す導線を UI に出すか」待ち。記憶がある状態では 1 段目を自動通過するのでチェックボックス自体が出ず、`forgetPassphrase()` を呼ぶ 1 行だけ足しても実質発火しないため、導線の決定が要る。

## 2回目

````text
再読しました（plan の「方針変更」追記、`auth-vault.ts` / `ipc.ts` / `AuthVault.tsx` / `styles.css` / 検証スクリプト / 3 本のテスト）。P0 2 件・P1 3 件・P2 5 件はいずれも反映を確認しました。有効トグルの件はそちらが正しく、`ipc.ts` の `nemo:save-http-auth-rule` が `pattern` 省略時に `setHttpAuthRuleEnabled` へ分岐しているのを確認しました（今回入った「中身が同じなら据え置き」も妥当）。今回も `pnpm typecheck` / `node --test` / `verify:only auth-vault` は実行許可が下りず、静的読解のみです。

## P0

## P1
- `scripts/verify-auth-vault.mjs`（「壊れた保管庫 / 未来の版」ブロック） — 今回足した `AuthVaultStatus.isFutureVersion` に検査が無く、未だに `status.reason.includes('新しい版')` の文字列一致だけを見ている / UI が削除の導線を切る条件は `status.isFutureVersion` の側なので、`readVaultFile` が `future: true` を落としても **`reason` の文言さえ残っていれば検証は PASS** する。そのとき未来の版の保管庫に削除ボタンが黙って戻り、古い Nemo から新しい方の保管庫を全件消せる状態に逆戻りする（「文字列一致で判定させない」と決めた当のものが無検査） / 同ブロックに `check('未来の版はフラグでも分かる', status.isFutureVersion === true)` を足し、続く壊れたファイルの側で `broken.isFutureVersion === false` も 1 行見る

## P2
- `src/renderer/components/AuthVault.tsx:VaultMenu` — `Slots.tsx` の `openMenu` にある `menuUp` の測定（`rect.bottom + 120 > window.innerHeight` で `.slot-menu.up` に倒す。コメントに「設定パネルは overflow で切れる」と既踏の記録がある）が移植されていない / 保管庫のカードはスロットより下にあるぶん切れやすく、メニューの中身は「削除」1 項目しか無いので切れると何も見えない（スクロールすれば届くので実害は小さい） / `cardRef` と同じ 3 行を移して `up` を付ける
- `src/renderer/components/AuthVault.tsx:VaultMenu` — 削除の項目が `onDelete` だけを呼び、`Slots.tsx` の `setMenuOpen(false); onDelete()` と違ってメニューを閉じない / 確認ダイアログの裏に「···」メニューが開いたまま残る（scrim やキャンセルのクリックが document に届けば閉じるので、見た目だけの話） / `onClick` で `setOpen(false)` を先に呼ぶ
- `src/main/ipc.ts:nemo:auth-vault-load` — `stale` を「保管庫から消えたもの」に絞った結果、**下見のあとに手元が保管庫と同じ内容に追いついた**（`same` に落ちた）分がどこにも現れなくなった / チェックした件数と「N 件を読み込みました」が黙って食い違う。原因は「もう同じだから入れなかった」なので害は無いが、説明が無い / 必要なら `skippedSame` を別に数えて「N 件は既に同じ内容でした」を添える
- `src/shared/types.ts:AuthVaultLoadResult` / `AuthVaultSaveResult` — 失敗理由に `detail` を持たないので、実行時に `openVault` が `unreadable` を返した場合（下見のあとに別の Mac が未来の版で書き直した等）だけ「保管庫を読めませんでした。」の一般文言に落ちる。下見側は今回 `detail` を出すようにした / 同じ事象なのに下見と実行で説明の粒度が違う / 両 result にも `detail?: string` を足し、`messageFor` に渡す
- `scripts/verify-auth-vault.mjs` — 今回入れた「中身が変わっていなければ `updatedAt` を据え置く」（`store/http-auth.ts:saveHttpAuthRule`）に検査が無い / `newer` の信頼性はこの条件に乗っているのに、崩れても誰も気づかない（`store/*.ts` は node:test から触れないので自走検証でしか固定できない） / 1 台目のブロックで、同じ内容の `saveHttpAuthRule` を撃つ前後で `listHttpAuthRules` の `updatedAt` が変わらないことを 1 件見る

## Q
- `src/main/store/auth-vault.ts:rememberPassphrase` / `src/renderer/components/AuthVault.tsx:VaultDialog` — 前回からの保留。「この Mac に覚える」を後から取り消す導線を出すか（記憶がある間は 1 段目を自動通過してチェックボックス自体が出ないので、`forgetPassphrase()` を保存経路に足すだけでは発火しない。カードの「···」に「この Mac の記憶を消す」を並べるのが最小） / 決めないと `forgetAuthVaultPassphrase` は呼び手の無い IPC のまま残り、共有 Mac で記憶だけ消したい人は保管庫ごと削除するしかない

````

**対応**: P0 が空になり収束。収束回に反映したもの —— (P1) 自走検証に `isFutureVersion` の検査を 2 件追加（未来の版でフラグが立つこと / 壊れただけなら立たないこと）。文字列一致だけだと `readVaultFile` が `future: true` を落としても PASS し、未来の版の保管庫に削除ボタンが黙って戻る。UI の安全装置がこのフラグに乗っているので、無検査のままにできない。(P2) 「···」メニューの削除で `setOpen(false)` を先に呼び、確認ダイアログの裏にメニューが開いたまま残らないようにした。

見送り（いずれも「足す」修正なので終了報告に回す）: P2 `VaultMenu` の `menuUp` 測定の移植（レビュアー自身が「スクロールすれば届くので実害は小さい」と書いている）/ P2 `skippedSame` を別に数える / P2 `AuthVaultLoadResult` / `AuthVaultSaveResult` に `detail` を足す / P2 `updatedAt` 据え置きの自走検証。

保留: P1「『この Mac に覚える』を OFF にしても記憶が消えない / `forgetAuthVaultPassphrase` が dead endpoint」—— Q「記憶を取り消す導線を UI に出すか」待ち（2 回目も未決）。
