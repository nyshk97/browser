# 自走検証（verify）の所要時間を削る

## 概要・やりたいこと

このリポジトリでの実装・レビューの往復が、他プロジェクト（`~/daw` / `~/ide`）より体感で数段遅い。
セッションログ 34 本を実測して原因を特定したので、**待ち時間の本体である verify を削る**。

計測でわかった要点は3つ。

1. **規模のせいではない**。tracked 行数は browser 54,214 < ide 73,188 < daw 173,735。一番小さい
2. **モデルの応答も遅くない**。ツール結果 → 次の応答までの生成時間は中央値 5.2s（daw 6.5s / ide 4.1s）、
   実効 101 tok/s（daw 99 / ide 79）。**daw より速い**
3. **Bash の待ち時間だけが突出**している。呼び出し回数はほぼ同じなのに 1 回あたりが 3.4 倍

| | Bash 回数 | 合計待ち | 1回あたり |
| --- | --- | --- | --- |
| browser | 791 | **223 min** | **17.2 s** |
| daw | 859 | 71 min | 5.0 s |
| ide | 58 | 1 min | 1.1 s |

待ち時間の **96% が「30秒超のコマンド 66 回」**に集中していて、その中身が verify（と、直近だけ codex）。

やることは2つ。

- **案A**: `--only` を自動で選ぶ。全12スイートを毎回回すのをやめる
- **案B**: アプリ側の「見に行く周期」を検証時だけ縮める。**安全なところに限定する**

## 前提・わかっていること

### codex は原因ではない（検証済み・却下した仮説）

当初 `codex exec` の同期レビューループ（57回 / 117分）を主因と見たが、時系列で見ると
**08-26 21:58 以降のセッションにしか現れない**。それ以前から遅い。

```
08-23 12:41  codex  0m  verify 46m
08-25 12:55  codex  0m  verify 35m
08-25 16:36  codex  0m  verify 50m
08-27 10:53  codex 53m  verify 75m   ← ここで初めて両方
```

codex ループは「これまで手動でやっていたレビュー→修正→レビューをスキル化しただけ」で、
このリポジトリでしか使っていないだけ。**今回のスコープ外**。

### 参照はシンボル名で書く

作業ツリーが変更中で行番号がずれるので、この plan では
`SLEEP_SWEEP_MS` / `scheduleSessionSave` / `PEEK_PLACEHOLDER_TIMEOUT` のように
**シンボル名か、スクリプト内の目印コメント**で位置を指す。

### 案A: `--only` は実装済みで、使われていないだけ

- `scripts/verify-all.mjs` に `KNOWN_TARGETS`（12スイート）、`--only` のパース、`want()` がある。
  typo をエラーにする作りまで入っている
- `.mise.toml` に `verify:only` タスクもある
- それでも**フル実行 91 回に対し `--only` は 9 回**。ほぼ毎回12スイート全部回している
- アプリ起動自体は `startApp()` の 2 回だけに抑えられていて、ここは既に良い設計。重いのは各スイートの中身

### 案A: スイートは独立していない（`restart` の随伴）

`want('restart')` のブロックの中に `want('split')` / `want('call')` / `want('live-folder')` の
分岐が入れ子になっている。つまり **`restart` と `split` の両方を選ばないと、split の
`--restart-write` / `--restart-read` は走らない**。VERIFY.md も `verify:only split restart` を
セットで書いている。`--changed` が `split` だけを選ぶと**復元系が丸ごと落ちたまま PASS** する。

さらに `restart` ブロックは spike / phase1 / pins の write+read を **`want()` と無関係に無条件で**
走らせている。だから `restart` を随伴させると、再起動 1 回とこの 3 スイート分が
`--changed` の下限コストとして毎回かかる。

**決定（人間判断・2026-08-27）**: 随伴は維持したうえで、**この無条件実行も `want()` で絞れるようにする**。
永続性の検証を落とさずに下限コストを下げるため。随伴を外して「永続性はコミット前のフルに任せる」案は、
復元まわりの退行がコミット直前まで見つからないので採らない。

### 案B: 待ちの正体は「設定値」ではなく「見に行く周期」（ただし例外あり）

`verify-split.mjs` は設定を既に極小にしているのに 7 秒待っている。

```js
await updateSetting({ tabSleepMinutes: 0.05 })   // = 3秒
await sleep(7000)                                 // なのに7秒
```

判定側が原因。

```ts
// src/main/registry.ts
const SLEEP_SWEEP_MS = 5_000   // 5秒ごとに「寝かせるべきタブ」を掃く
```

条件は 3 秒で成立しているが、次の掃除まで最大 5 秒待たされる。だから 3+5 に余裕で 7 秒。

**ただし「周期を縮めれば全部減る」ではない**。同じ split のブロックには
`sleep(THRESHOLD_MS - 2000)` = 10s や `sleep(AGE_MS + 2000)` = 14s のように
**閾値そのものが支配する待ち**があり、周期短縮では 1ms も減らない（下表の ④）。

### 案B: 4種類あり、安全性が違う（この分類が今回の肝）

| 種類 | 対象 | 判断 |
| --- | --- | --- |
| ① 見に行く周期 | `registry.ts` `SLEEP_SWEEP_MS` = 5000 | **採用**（Phase 2）。「いつ判定するか」だけを変え、判定ロジックは不変 |
| ② デバウンス | `registry.ts` `scheduleSessionSave` = 2000<br>`store/session.ts` の `JsonStore` 第4引数 = 1000 | **採用**（Phase 3）。書かれる中身は変わらない。**2段ある**ので両方 |
| ③ 保険タイムアウト | `registry.ts` `PEEK_PLACEHOLDER_TIMEOUT` = 8000 | **見送り**。正常系が保険経路にすり替わる（下記） |
| ④ 閾値そのもの | `tabSleepMinutes` / `tabArchiveHours` の検証時の値 | **採用**（Phase 5）。マージンが比例して痩せるので **1/2 まで**に留める |
| ⑤ プローブ周期 | `call-coordinator.ts` `PROBE_INTERVAL_JOINED` / `_CANDIDATE` | **見送り**（2026-08-27 決定）。測り直したら固有の効果は約 6s しか無かった |

① が安全な根拠は既存コメント自身にある。

> 設定より短い周期で見に行かないと「30分後に寝る」が最大1分ずれる。
> 5秒なら短い設定（自走検証で使う 0.05 分など）でも実際に効く。
> — `src/main/registry.ts` の `SLEEP_SWEEP_MS` 直上

5000 はもともと本番の「30分」に合わせた値。検証時に縮めても `sweepSleep()` / `sweepArchive()` の
判定内容は一切変わらない。

**③ を見送る理由**（`PEEK_PLACEHOLDER_TIMEOUT` 直上のコメント）:
これは「dom-ready が来ないページ（204 / ダウンロードに化ける / 即 `window.close()`）」のための保険。
8000 → 500 にすると**正常なページまで保険経路（`reveal('timeout')`）で表示される**ようになり、
正常系が保険の検証にすり替わる。10 秒を払う価値がある。

**`live-folders/index.ts` の `TICK_MS` は対象外**。live-folder の長い待ちは
`nextAutomaticAttemptAt` / バックオフ由来で、TICK を縮めても減らないと見込まれるため。

### 案B: `sleep(12000)` は sweep 由来（プローブ由来ではない）

`verify-call.mjs` の「R3: sleep の除外」ブロックにある 3 本の `sleep(12000)` は、
直前のコメントが根拠を明示している。

```js
// 0.05 分 = 3 秒。sweep は 5 秒ごとなので 12 秒待てば必ず 1 回は通る
```

つまり **Phase 2（`SLEEP_SWEEP_MS`）だけで取れる**。⑤ プローブ周期の効果として数えてはいけない。
ただし `bf.act('break')` 直後の 1 本だけは縮退検知にプローブ周期も効くので、
待ちは `max(閾値+sweep, プローブ周期×N)` で導く。

### 案B: デバウンスは2段（合計 3000ms）

`scheduleSessionSave` の 2000ms のあと、`saveSession` → `JsonStore.scheduleSave` があり、
セッションストアは `store/session.ts` で `JsonStore` の第4引数に **1000** を渡している
（`JsonStore` の既定 400 ではない）。合計 3000ms で、既存の `sleep(3000)` は**境界ちょうど**。

片方だけ縮めても下限が 1000ms に張り付く。**両方を `timings` 経由にする**。

### 案B: 値は1箇所に集約する。verify 側は env を読み戻す

定数が複数ファイルに散っていて、かつ**verify 側も同じ値を知る必要がある**（待ちを比例計算するため）。
片方だけ縮めると「無駄に遅い」か、より悪く「**検証が空振りしたまま PASS**」になる。

ここで**検証スクリプトの単独起動を壊さないこと**が制約になる。単独起動は公式にサポートされていて
（各スクリプト冒頭の Usage、`.mise.toml` の `verify:switcher` の説明「Nemo を起動してから回す」）、
そのときアプリは `NEMO_VERIFY_TIMINGS` を受け取らず**本番値で動く**。
verify 側が検証値を決め打ちで持っていると、この経路で待ちが本番値より短くなり、
flaky FAIL か、否定形の検査の空振り PASS を生む。

本番既定値は **main（TS）と scripts（mjs）の両方から見える場所**に置く必要がある。
二重に持つとズレたときに「verify は既定値 A で式を組み、アプリは既定値 B で動く」が黙って起き、
単独起動の経路で塞いだ穴が別の形で開く。

このリポジトリには前例がある。`src/shared/*.js` は plain .js で置かれていて、
`src/main/store/session.ts` も `scripts/arc-import.mjs` も同じ
`src/shared/settings-schema.js` を import している。同じ形にする。

- **`src/shared/timings.js`（plain .js）が本番既定値の唯一の置き場**
- **`src/main/timings.ts`** は `src/shared/timings.js` を読み、`NEMO_VERIFY_TIMINGS` で上書きし、
  `!app.isPackaged` でガードする
- **`scripts/lib/timings.mjs`** は `NEMO_VERIFY_TIMINGS` を読み戻し、無ければ
  `src/shared/timings.js` にフォールバックする。こうすると `verify-all` 経由でも単独起動でも、
  verify とアプリが必ず同じ値を見る
- 検証値そのもの（どこまで縮めるか）は `scripts/verify-all.mjs` が決めて env に載せる
- **パース失敗と未知のキーは両側とも即エラー**にする（`--only` が typo をエラーにしているのと同じ流儀）。
  黙ってフォールバックする経路を作ると、キーの書き違い1つで「アプリは本番値・verify は縮めたつもり」の
  ズレが静かに生まれ、この節が塞ごうとしている失敗モードそのものになる

前例は `NEMO_VERIFY_DIAGNOSTICS`（`src/main/ipc.ts` で
`process.env['NEMO_VERIFY_DIAGNOSTICS'] === '1' && !app.isPackaged` をガード、
`scripts/verify-all.mjs` で env に載せている）。あれは boolean なので、数値版を新設する。

**env は `startApp()` と `runVerify()` の両方に載せる。** 検証スクリプトは `runVerify` が組む
別の env で起動されるので、`startApp` にだけ載せても verify 側に届かない。
かつ `NEMO_VERIFY_DIAGNOSTICS` と同じく **`--only` に依存させず無条件**で渡す
（条件分岐にすると「フルでは通るのに絞ると落ちる」を作る）。

### 効果の見込み

長い sleep（1500ms 以上）は 83 箇所・241 秒。以下は**検証時の sweep 周期を仮に 500ms
（本番 5000ms の 1/10）とした場合**の見込み。実際の値は Phase 2 で決めて計測と突き合わせる。

- **Phase 2**（`SLEEP_SWEEP_MS`）
  - split の 7000×2 + 8000×2 = 30s。ただし「左だけ期限切れ・右は期限内」系の 2 本は
    **閾値を据え置く限り縮められる幅が小さい**（左の齢が閾値を超える必要があるため、
    この待ち自体に下限がある）。大きく縮むのは残り 2 本
  - call の 12000×3 = 36s
  - peek の 9000（`tabSleepMinutes: 0.02` 直後）= 9s
  - 合計 75s → **-45s 規模**
- **Phase 3**（デバウンス2段）: phase1 と pins の 3000×2 + peek の 2600 = 8.6s → **-7s 規模**
- **Phase 4**（④ 閾値 / ⑤ プローブ）: 効果を測り直してから判断

これはフル 1 回あたりの削減。案A（回すスイートを絞る）と合わせれば体感は大きく変わる。

## 実装計画

### Phase 1: 案A — `--only` の自動選択 [AI🤖]

- [x] **固定費と `restart` を分けて実測する** — 固定費（ユニットテスト + `electron-vite build` +
      `ext-verify` + `startApp()`×2）と、`restart` 単体。`restart` は随伴ルールにより事実上ほぼ毎回
      選ばれ、その中で `want()` と無関係に spike / phase1 / pins の write+read と再起動 1 回を走らせる。
      **`--changed` の実質的な下限は「固定費 + restart」**であって固定費だけではない
  - **決定（人間判断・2026-08-27）**: この実測は**打ち切り判断には使わない**。固定費が支配的でも
    Phase 1 は完遂する（`--only` は実装済みで工数が小さく、絞り込み自体に害がない）。
    実測は「**次に何を削るか**」——ビルドのキャッシュ、アプリ起動の使い回し——を決める材料として使う
- [x] `scripts/verify-all.mjs` の `KNOWN_TARGETS` の隣に、**スイート → 担当ソース**のマッピングを定義する
  - `scripts/verify-<name>.mjs → <name>` を明示的に載せる（**検証スクリプト自体を直す往復が
    `--changed` の主戦場**なので、ここがフルに倒れると効いてほしい場面で効かない）
  - `scripts/lib/*.mjs` と `scripts/verify-all.mjs` はフル扱い
  - `src/main/registry.ts` のように複数スイートが依存する巨大ファイル（3,434行）も
    **安全側に倒してフル扱い**。マッピングに載らないファイルもフル扱い
  - ただし**「検証に影響しないと分かっているパス」の明示リスト**（`docs/**`、`*.md`、`.github/**` 等）
    を別に持ち、それだけの変更は「回すもの無し」で終わらせる。このリポジトリは `docs/plans/` を
    毎ループ触るので、これが無いと**最頻ケースで `verify:changed` がフルと同義に化けて案A の効果が消える**。
    「無関係と分かっている」と「知らない」を別扱いにするのが要点で、後者はフルのままでよい
  - **`restart` を随伴させる**（`split → {split, restart}` など）。前提に書いたとおり、
    片方だけでは永続性の検証が丸ごと落ちる
- [x] **`restart` ブロック内の無条件実行を `want()` で絞れるようにする** — 現状 spike / phase1 / pins の
      write+read が `want()` と無関係に走っており、これが `--changed` の下限コストになっている。
      随伴を維持したまま下限を下げるための改修。**再起動そのもの（`stopAll()` → `startApp()`）は
      1 回に保つ**（write と read を分ける構造は崩さない）
- [x] **逆引きを純関数として `scripts/lib/` に切り出し、`scripts/*.test.mjs` に単体テストを置く**
      （`scripts/lib/harness.mjs` ↔ `scripts/harness.test.mjs` と同じ対応）。
      マッピングはスイートやファイルが増えるたびに腐るが、**腐っても症状は「速く PASS する」**ので
      気づけない。verify は先頭で `node --test scripts/*.test.mjs` を回しているので追加コストはゼロ
- [x] `scripts/verify-all.mjs` に `--changed` を追加する（逆引きは上の純関数を import する）
  - 決めた集合を**必ず標準出力に出す**（既存の「回さない」表示と同じ流儀）。
    黙って絞ると「速いけど何も見ていない」に化ける
  - フル扱いに倒れたときはその理由（どのファイルが引き金か）も出す
  - **「回すものが無い」は1つの結論に統一する** — 変更が一切ない場合（main 直コミット運用なので
    コミット直後に起きる）も、無関係パスだけの場合も、**回さずに正常終了**。
    理由だけ `（変更なし）` / `（無関係パスのみ: docs/…）` と出し分ける。
    分けて「変更ゼロ → フル、docs を1行足す → 何も回さない」にすると**変更量に対して非単調**になり、
    結果を信用しにくくなる。変更ゼロは検証すべき差分が無い状態であってフルの根拠にはならない。
    フルが要るのはコミット前で、それは `mise run verify` が担う。
    この経路では**前段（ユニットテスト + `electron-vite build` + 拡張の照合）も飛ばす**。
    絞り込みが効いたとき（例: `split` + `restart`）は前段は従来どおり走る
  - 比較対象は**作業ツリー差分**（`git diff` + `--cached` + untracked）。main 直コミット運用なので
    コミット直後は必ず空になるが、それは上の「回すものが無い → 回さずに正常終了（理由: 変更なし）」で受ける
  - `--only` と `--changed` の同時指定は**エラー**にする
- [x] `.mise.toml` の `verify:only` の隣に `verify:changed` タスクを追加する
- [x] `VERIFY.md` に運用を明記する — 「まず `verify:changed`、フルはコミット前だけ」。
      あわせて**「回すもの無し」で終わった exit 0 をコミット可否の判断に使ってよいか**を1行書く
- [x] 検証: 以下を確認する。マッピングの取りこぼしは「フルに倒れる」＝安全側だが、
      新設分岐の失敗モードは**「黙って何も回さずに 0 で終わる」＝危険側**なので、そちらを厚く見る
  - `src/renderer/components/SplitRow.tsx` だけ → **`split` と `restart`** を選び、
    `restart` の中で **split の write/read だけが走り、spike / phase1 / pins は走らない**
  - `src/main/registry.ts` / `scripts/lib/cdp.mjs` → フルに倒れる
  - `docs/**` だけ → 回さずに正常終了し、理由が出る
  - 変更が一切ない → 回さずに正常終了し、理由が出る
  - `--only` と `--changed` の同時指定 → エラー

### Phase 2: 案B の基盤 + sweep 周期の短縮 [AI🤖]

- [x] `src/shared/timings.js`（plain .js）を新設する — **本番既定値の唯一の置き場**。
      `src/shared/settings-schema.js` と同じく main と scripts の両方から import する
- [x] `src/main/timings.ts` を新設する
  - `src/shared/timings.js` を読み、`NEMO_VERIFY_TIMINGS`（JSON）で上書き
  - **`!app.isPackaged` でガード**（`ipc.ts` の `NEMO_VERIFY_DIAGNOSTICS` と同じ流儀）
  - 解決は**プロセス起動時に1回**（`startBackgroundWork()` が `setInterval` を1回張るだけなので
    実行中に変えられるものではない）。参照のたびに再解決する作りにしない
  - 解決した実効値を起動時に1行ログに出す（`log('timings.resolved', {...})`）
- [x] `scripts/lib/timings.mjs` を新設する — **`NEMO_VERIFY_TIMINGS` を読み戻し、
      無ければ `src/shared/timings.js` にフォールバック**する。値を決め打ちで持たない
      （単独起動でアプリが本番値で動くときに、verify だけ短い値を使わないため）
- [x] `src/main/registry.ts` の `SLEEP_SWEEP_MS` を `timings` 経由の参照にする
- [x] `scripts/verify-all.mjs` の **`startApp()` と `runVerify()` の両方**で
      `NEMO_VERIFY_TIMINGS` を env に載せる（無条件・`--only` 非依存）
- [x] sweep 由来の sleep を `scripts/lib/timings.mjs` 由来の式にする
  - `verify-split.mjs` の 4 本 — **呼び出し地点ごとに式を導出する**。
    「左だけ期限切れ・右は期限内」の差分検証は直後に前提チェック
    （`gap >= THRESHOLD_MS - 3000` 相当）があり、一律置換するとマージンが黙って痩せて
    フル検証でだけ落ちる flaky になる（同ブロックのコメントに実例あり）。
    **前提チェックのマージンを式の中に明示する**。あわせて**実測 `gap` を FAIL 時だけでなく
    常に1行出す**（flaky が出たとき「マージン不足」か「別要因」かが1回の実行で切り分けられる）
  - `verify-call.mjs` の 12000×3 — `bf.act('break')` 直後と `bf.act('leave')` 直後の 2 本は
    `max(閾値+sweep, プローブ周期×N)`。どちらも状態変化が `isSleepExempt` に反映されるのは
    coordinator が次のプローブを撃ってからなので、プローブ周期が効く
  - `verify-peek.mjs` の 9000（`tabSleepMinutes: 0.02` 直後）
- [x] **安全弁**: `sweepSleep()` と `sweepArchive()` を**別々に**壊して、それぞれ対応する検査が
      **FAIL すること**を確認する。`verify-split.mjs` のコメントが
      「`sweepArchive` は `sweepSleep` とは別関数なので、sleep だけ発火させると archive 側に
      古い判定が残っていても素通りする」と明言している。
      CLAUDE.md の「修正前の FAIL を見てから直す」の逆版。
      これを通さないと、この変更は検証を静かに無効化する変更になり得る
- [x] **`verify-packaged.mjs` に「パッケージ版では `NEMO_VERIFY_TIMINGS` が効かない」検査を足す**。
      `NEMO_MEET_TEST_URL_PREFIX` の既存検査と同じ流儀で、**わざと env を渡したうえで
      効かないことを確かめる**（同ファイルのコメント「渡さずに起動して出なかったでは
      塞がった証明にならない」）。`timings.resolved` のログが本番値のままであることを見る。
      ゲートは `!app.isPackaged` で、`isDevChannel` では塞げない（dev パッケージでも
      `isDevChannel === true`）ので、**dev 版のパッケージで確かめるのが要点**。
      timings は本番のスリープ / アーカイブの発火間隔を変えうる裏口なので、診断 IPC より検査価値が高い
- [x] **完了条件**: フル 1 回が PASS し、`split` / `call` / `peek` を 3 回連続で回して flaky が出ないこと。
      sweep 周期はプロセス全体に効くので、単体 PASS では他スイートへの干渉
      （タブが想定外に寝る・閉じる）を検出できない
- [x] 効果計測: 変更前後の所要時間を実測して記録する

### Phase 3: セッション保存デバウンス（2段） [AI🤖]

- [x] **前提確認**: 「連続変更が1回の書き込みにまとまる」こと自体を検証している箇所が無いか、
      `scheduleSessionSave` の呼び出し元と各 verify を確認する。あれば Phase 3 は見送る
  - 観点として `stopBackgroundWork()` が保留中の `sessionSaveTimer` を **flush せずに捨てる**ことも
    見ておく。デバウンスを縮めると取りこぼし窓が狭まり、「終了時に保存を落とす」バグを覆い隠す方向に働く
- [x] `registry.ts` の `scheduleSessionSave`（2000ms）を `timings` 経由にする
- [x] `store/session.ts` が `JsonStore` に渡している 1000ms を `timings` 経由にする。
      **両方やらないと下限が 1000ms に張り付く**
- [x] デバウンス由来の sleep を `timings` 由来にする — `verify-phase1.mjs` と `verify-pins.mjs` の
      `sleep(3000)`（どちらも「セッション保存はデバウンスされているので、書かれるまで待つ」のコメントつき）、
      および `verify-peek.mjs` の `sleep(2600)`（同じ根拠。現状すでに合計 3000ms を割っている）
- [x] **peek の検査に positive control を足す**。`小窓はセッションに保存されない` は完全な否定形で、
      `session.json` がまだ書かれていなくても（`fs.existsSync` が false で `'{}'` にフォールバックしても）
      PASS する。待ちが 2600ms で合計 3000ms を割っている現状、**今すでに「まだ書かれていない
      ファイルを読んでいるから通っている」可能性がある**。同じ `session.json` に必ず現れるはずの
      普通のタブ URL を同時に assert し、「書かれた後に読んでいる」を担保してから否定形の検査を置く
- [x] 安全弁: `saveSession` を壊して3スイートが FAIL することを確認する。
      **この安全弁は変更前にも1回回す** — 現状が空振りでないことを先に確定させないと、
      Phase 3 は空振りを固定化するだけになる

### Phase 4 前の判断 [人間👨‍💻]

**決定（2026-08-27）**: 続行する。⑤ は**見送りに移す**。⑥（live-folder の取得間隔）を新設して
④ より先にやる。④ は**閾値を 1/2 まで**やる。

- [x] Phase 2・3 の実測値を見て、次に進むか決める。flaky が出ていたらここで止める
  - -49.4s / FAIL 0 / 3 回連続 PASS。途中で出た間欠 FAIL は原因を特定して直した（`makeTabs`）ので続行
- [x] ④ 閾値そのものの短縮をやるか → **やる。ただし 1/2 まで**
  - 実測のマージンが 1.0s / 2.0s しか無く、1/2 で 0.5s / 1.0s になる。1/4 以上は flaky を買うだけ
  - 閾値は `timings` に載せない —— アプリ側に対応する定数が無く、検証スクリプトが
    `updateSettings()` で押し込む値なので、**アプリと verify がズレようがない**
- [x] ⑤ プローブ周期をやるか → **見送りに移す**
  - Phase 2 で sweep 由来を剥がした結果、プローブ固有に残った待ちは `verify-call.mjs` の 2 か所だけ。
    周期を 1/4 にしても**取れるのは約 6s**。`TICK_MS` との比を崩すリスクに見合わない

### Phase 4: ⑥ live-folder の取得間隔 [AI🤖]

**計画に無かったが、実測でここが最大だった**。live-folder 139.3s のうち **89s が 2 か所**
（「自動取得（60秒後）を観測」61.4s ＋「バックオフ中に何も飛ばないことを 35 秒観測」27.4s）。
当初「`TICK_MS` を縮めても減らない」として対象外にしたが、**縮めるべきは `TICK_MS` ではなく
`nextAutomaticAttemptAt` を決める間隔のほう**で、これは ①（見に行く周期）と同じ種類。

- [x] `src/shared/timings.js` に `liveFolderPollMs` / `liveFolderTickMs` / `liveFolderBackoffMinMs` を足す
- [x] `live-folders/index.ts` の `POLL_INTERVAL_MS` / `TICK_MS` / `BACKOFF_MIN_MS` を `timings` 経由にする。
      `BACKOFF_MAX_MS` と `AUTH_RETRY_MS` は初期値の 15 倍として導出（本番 60秒 → 15分 を保つ）、
      `TOKEN_RETRY_MS` は tick と同じにする
- [x] **poll と tick の比（本番 1:12）を保つ**。tick と同オーダーにすると
      「取得中に起きたタイマーの要求を捨てる」の検証が撃てなくなる
- [x] `verify-live-folder.mjs` の待ちを timings 由来にする —— ⑲ のバックオフ値（60s → 120s）、
      ⑲ の観測窓、⑮ の自動取得待ちと遅い応答の長さ
- [x] **計測の窓は「成功した取得の直後」から始める** —— 自動取得の間隔は成功のたびに引き直されるので、
      直前に 1 回成功させておけば窓のあいだは自動取得が来ない。これをやらないと
      `開閉しても再取得しない` が**たまたま自動取得を拾って落ちる**
- [x] 安全弁: `requestAutomatic()` の `now >= nextAutomaticAttemptAt` ゲートを殺して
      `⑲ バックオフ中はタイマーが起きても投げない` が FAIL することを確認する

### Phase 5: ④ 閾値そのものの短縮（1/2） [AI🤖]

- [x] `verify-split.mjs` / `verify-call.mjs` / `verify-peek.mjs` の閾値を 1/2 にする
- [x] **設定値は ms 定数から導出する**（`tabSleepMinutes: SLEEP_THRESHOLD_MS / 60_000`）。
      ms と分の両方に数字を書くと、片方だけ直してズレる
- [x] **前提チェックのマージンを閾値に対する比で書く**（`THRESHOLD_MS - 3000` →
      `THRESHOLD_MS * 3 / 4`）。素の引き算だと閾値を縮めたときにマージンだけが不釣り合いに痩せる
- [x] 同一スイートを 3 回連続で回して flaky が出ないことを確認する

### 見送り（対応しない） [—]

- [ ] ~~`registry.ts` `PEEK_PLACEHOLDER_TIMEOUT` の短縮~~
      — 正常系が保険経路にすり替わるため。`verify-peek.mjs` の 10s は払う
- [x] ~~⑤ プローブ周期（`call-coordinator.ts` の `PROBE_INTERVAL_JOINED` / `_CANDIDATE`）の短縮~~
      — Phase 2 で sweep 由来を剥がしたら、プローブ固有に残る待ちは `verify-call.mjs` の 2 か所・
      合計 **約 6s** しか無かった。当初の -27s は sweep 由来の誤算。`TICK_MS` との比を崩す
      リスクに見合わないので見送り（人間判断・2026-08-27）
- [x] ~~`live-folders/index.ts` `TICK_MS` **だけ**の短縮~~
      — 見立てどおり TICK だけでは減らない。**取得間隔（`POLL_INTERVAL_MS` / `BACKOFF_MIN_MS`）の
      ほうが本体**だったので、Phase 4 で両方まとめて `timings` 経由にした
- [ ] ~~短い sleep（300〜1500ms・147箇所・約67秒）の `waitFor` 置換~~
      — `waitFor` は既に112箇所で使用済み（`scripts/lib/cdp.mjs`）。合計では
      `verify-spike.mjs` などに数十秒あるが、**1本ずつ根拠を確かめる必要があり工数が読めない**ので後回し

### 動作確認 [人間👨‍💻]

- [x] `mise run verify` のフル実行が従来どおり PASS すること（短縮の副作用で落ちていないか）
      — **529.3s → 371.8s（-30%）で FAIL 0 件**（AI が実行済み）
- [x] `mise run dev` を起動し、`timings.resolved` のログ1行で **env 無しのとき本番値になっている**
      ことを確認する。スリープ 30 分・アーカイブ 24 時間を実時間で待つ確認は現実に実行されないので、
      既定値の書き間違いはこのログで捕まえる
      — **env 無しでパッケージ前の `out/main/index.js` を起動して確認済み**（AI が実行）:
      `{"event":"timings.resolved","effective":"{\"sleepSweepMs\":5000,\"sessionSaveDebounceMs\":2000,\"sessionStoreDebounceMs\":1000}","overridden":false}`

## ログ

### 試したこと・わかったこと

**固定費は支配的ではなかった（Phase 1 の実測・2026-08-27）**。フル 1 回 529 秒に対し、
固定費（ユニットテスト + `electron-vite build` + `ext-verify` + ページサーバ + `startApp()`×2 + 後片付け）は
**8.3 秒**（`--only restart` の実測。中身が `want()` で空になるので固定費そのものが測れる）。
`electron-vite build` は 0.7 秒しかかかっておらず、ビルドのキャッシュ化は無意味。

フル 1 回の内訳（`base-full.log` の節見出しの時刻差）:

| スイート | 秒 | | スイート | 秒 |
| --- | ---: | --- | --- | ---: |
| 固定費 | 7.6 | | split | 72.2 |
| spike | 39.8 | | call | 81.4 |
| phase1 | 15.1 | | live-folder | **140.6** |
| phase2 | 19.6 | | restart | 11.9 |
| pins | 14.7 | | migration | 5.2 |
| switcher | 12.2 | | db | 3.4 |
| peek | **105.6** | | | |

**次に削るべきは live-folder（140.6s）と peek（105.6s）**で、ビルドでもアプリ起動でもない。

**Phase 2・3 の効果（フル 1 回・実測）**: 529.3s → **479.9s（-49.4s）**。FAIL 0 件。
検証時の値は `sleepSweepMs: 500` / `sessionSaveDebounceMs: 300` / `sessionStoreDebounceMs: 200`。

| スイート | before | after | 差 |
| --- | ---: | ---: | ---: |
| peek | 105.6 | 98.6 | -7.0 |
| split | 72.2 | 58.3 | -13.9 |
| call | 81.4 | 61.8 | -19.6 |
| restart | 11.9 | 6.8 | -5.1 |
| 他 | — | — | ほぼ変化なし |

**安全弁（Phase 2）**: `sweepSleep` と `sweepArchive` を別々に殺して、それぞれ別の検査が落ちることを確認した。

- `sweepSleep` を殺す → `verify-split.mjs:954` の「対照タブが寝るまで待つ」がタイムアウトして
  スクリプトごと FAIL（`条件が満たされなかった: … .every((t) => t.asleep)`）
- `sweepArchive` を殺す → sleep 側の検査は全部 PASS のまま
  `archive: 対照タブ（見えていない非分割）は閉じられている — control=残っている` だけが FAIL。
  コメントが言うとおり 2 つは独立に効いている

**前提チェックのマージンは痩せていない**（実測を常時出すようにした）:
`sleep: … 差=10017ms（下限 9000ms / 余裕 1017ms）` / `archive: … 差=14010ms（下限 12000ms / 余裕 2010ms）`。

**flaky 確認**: `--only split call peek restart` を 3 回連続で回して 3 回とも PASS（各 ~228s）。

**Phase 4・5 の効果（フル 1 回・実測）**: 479.9s → **371.8s**。ベースラインからは **-157.5s（-30%）**。

| スイート | baseline | Phase 2+3 | Phase 4+5 | 合計の差 |
| --- | ---: | ---: | ---: | ---: |
| live-folder | 140.6 | 139.3 | **50.8** | **-89.8** |
| split | 72.2 | 58.3 | **41.8** | **-30.4** |
| call | 81.4 | 61.8 | 60.3 | -21.1 |
| peek | 105.6 | 98.6 | 97.9 | -7.7 |
| restart | 11.9 | 6.8 | 6.8 | -5.1 |
| spike | 39.8 | 39.9 | 39.9 | ±0 |
| 固定費 / 他 | — | — | — | ±0 |
| **フル** | **529.3** | **479.9** | **371.8** | **-157.5** |

検証時の live-folder の値は `liveFolderPollMs: 12000` / `liveFolderTickMs: 1000`（比 1:12 を維持）/
`liveFolderBackoffMinMs: 6000`。閾値は split / call / peek とも 1/2。

**安全弁（Phase 4）**: `requestAutomatic()` の `now >= nextAutomaticAttemptAt` ゲートを殺すと
`⑲ バックオフ中はタイマーが起きても投げない — 5000ms で 5 回` を筆頭に 4 件が FAIL する
（`⑲ バックオフは 6000ms → 12000ms`・`⑮ 実行中に来た自動の要求は捨てられる`・`開閉しても再取得しない`）。

**マージン（Phase 5）**: 閾値を 1/2 にした後の実測は `余裕 508〜519ms` / `余裕 1009〜1011ms`
（1/2 前は 1017ms / 2010ms）。**きれいに半分**で、実測のばらつきは 10ms 前後なので
まだ 35 倍以上の余裕がある。1/4 まで行くと 250ms になるのでここで止める。

**flaky 確認（Phase 4・5 後）**: `--only split call peek live-folder restart` を
3 回連続で回して 3 回とも PASS（261.7 / 261.8 / 262.3 秒）。

**`restart` の下限コストは実際に下がった**。`--only restart spike phase1 pins`（従来の下限相当）が
84.5 秒に対し、`--only split restart` は 80.3 秒で、うち restart ブロックは **4.1 秒**
（従来はフル実行時で 11.9 秒）。spike / phase1 / pins の write+read が走っていないことは
ログの grep（`遅延ロード|storage|セッション復元` が 0 件）で確認した。

### 方針変更

**Phase 3 の安全弁の前提が誤っていた（変更前に回して判明）**。
`saveSession` を殺しても `verify-phase1` の `--session-read`・`verify-pins` の `--lazy-read`・
`verify-peek` の `小窓はセッションに保存されない` は**全部 PASS した**。理由は 2 つ:

- 復元系は**定期保存ではなく終了時の `markCleanExit()`** が担保している（`store.set()` + `saveNow()`）。
  だから `sleep(3000)` は「正常終了できなかった経路」への保険でしかない
- peek の検査は完全な否定形で、`session.json` が無くても（`'{}'` にフォールバックしても）通る

そこで計画どおり **peek に positive control を足した**
（`session-marker` 付きの普通のタブを作り、`session.json` に現れることを先に assert する）。
足したうえで `saveSession` を殺すと、**新しい検査だけが FAIL する**ことを確認した
（`session.json が実際に書かれている（否定形の検査が空振りしていない証拠） — exists=true len=96`）。
`verify-split` の `再起動前: session.json に分割が 2 組書かれている` も同時に FAIL するので、
デバウンス短縮を守る安全弁はこの 2 本で成立している。
`verify-phase1` / `verify-pins` のコメントは「実際の担保は終了時の書き切り側」と実態に直した。

**peek の sleep 除外にも positive control を足した**（`比較用の普通のタブは寝る`）。
`Peek を持つ親タブは寝ない` も否定形で、待ちを縮めた以上「sweep が一度も走らなくても PASS」に
なりうるため。`verify-call.mjs` が同じ趣旨の対照タブを既に持っていたので、それに揃えた。

**`makeTabs()` が読み込み完了を待っていなかった（間欠 FAIL の修正）**。
`--only split call peek restart` の 3 連続確認の 3 回目と、安全弁の 1 回で
`Error invoking remote method 'nemo:navigate': (-3) loading 'blank.html?lf-0'` が出て
verify-split がスクリプトごと落ちた。Electron の `loadURL` は**別 URL の `did-fail-load` でも reject する**ので、
「まだ `blank.html?lf-0` を読み込み中のタブに `navigate()` を撃つ」と、中断された元の読み込みが
`nemo:navigate` の失敗として飛ぶ。`makeTabs()` を「一覧に出るまで」から
「一覧に出て `loading` が false になるまで」に直した。修正後は 3 回連続 PASS。

**`timings.resolved` は平たく展開せず JSON 文字列で出す**。
`sessionSaveDebounceMs` のようにキー名へ `session` を含むものは `log-redact` が
`[redacted]` に落とすため（実際に最初の実装で潰れた）。redaction 側に穴を開けるのは論外なので、
`effective` に JSON 文字列で入れ、`verify-packaged.mjs` はそれを parse する。

**live-folder は「対象外」から「最大の削りどころ」に変わった**。
plan は `live-folders/index.ts` の `TICK_MS` を見て「縮めても減らない」と判断して対象外にしたが、
これは**見ている定数が違った**。実際の待ちは `POLL_INTERVAL_MS`（60秒）と `BACKOFF_MIN_MS`（60秒）で、
この 2 つが verify の 89 秒を決めていた。`TICK_MS` の見立て自体は正しい（tick は条件を見るだけ）。

`liveFolderPollMs` を縮めると**自走検証の全体で自動取得の頻度が上がる**ので、
「短い窓でリクエストが 0 件」を見る検査が**たまたま自動取得を拾って落ちる**危険がある。
実際 `開閉しても再取得しない` が該当した（安全弁の実行で再現した）。
自動取得の間隔は**成功のたびに引き直される**ので、計測の窓を「成功した取得の直後」から
始めるようにして塞いだ。他の `total === 0` は資格情報なし / rate-limit / バックオフのいずれかで
ゲートされている状態なので影響を受けない。

**④ は `timings` に載せなかった**。plan は「閾値を `timings` 経由にし」と書いていたが、
閾値に対応する定数はアプリ側に無く（アプリは `settings` を読むだけ）、検証スクリプトが
`updateSettings()` で押し込む値なので、**アプリと verify がズレようがない**。
代わりに「ms 定数から分・時間を導出する」形にして、ms と分の両方に数字を書くことをやめた。

**`verify:packaged` はこの環境で HEAD からして落ちる（この変更とは無関係）**。
足した `NEMO_VERIFY_TIMINGS` の検査を実物で確かめようとしたが、パッケージした
`Nemo Dev.app` が `app.whenReady()` に到達せず（ログディレクトリすら作られない）
`起動を待てなかった` で 300 秒タイムアウトする。**HEAD を stash して同じ手順でパッケージしても同じ症状**
なので既存の問題。したがって**追加した検査そのものは未実行**。別途 `verify:packaged` を直すときに確かめる。
