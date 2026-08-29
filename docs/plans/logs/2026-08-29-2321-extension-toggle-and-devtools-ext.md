review session: 671742c4-cb18-4813-a404-163717664fe0

## 1回目

````text
## P0
- Phase 1 > 2（`extensions.ts` / 無効なものも一覧に含める） — `loadLockedExtensions` の戻り配列は `setLoadedExtensionIds`（`extensions.ts:177` = `chrome-extension://` ナビゲーションの allowlist）と `setExtensionCount`（`index.ts:209`）と `nemo:get-extensions` の **3 か所に同じものが流れている** / OFF の拡張を配列に足すと、ロードしていない拡張のページへの遷移が許可され、起動ステータスの `extensions` 件数も嘘になる（allowlist を「実際にロードできたものだけ」に絞ってあるという既存の保証が崩れる） / 「UI 用の一覧（disabled 込み）」と「allowlist 用の ID（enabled のみ）」を別の値として返し、`setExtensionCount` も enabled 数にする
- Phase 1 > 3（IPC） — トグル後の反映経路が書かれていない。`ipc.ts:139` の `loadedExtensions` は起動時に一度 `setLoadedExtensions` されるだけのスナップショットで、`Settings.tsx:32` / `Sidebar.tsx:22` はどちらも mount 時に 1 回 `getExtensions()` するだけ / `setExtensionEnabled` が成功しても IPC のスナップショットと allowlist は起動時のまま、サイドバーのフッターは OFF にした拡張を出し続け、そのボタンを押すと外した拡張の options を開こうとする / `setExtensionEnabled` の中で一覧を作り直して `setLoadedExtensions` + `setLoadedExtensionIds` を更新し、UI へは `registry.ts:1882` の `nemo:shared-state` と同じ形の push を 1 本足す（invoke の戻り値だけだと他ウィンドウのサイドバーが直らない）
- Phase 1 > 6（`verify-targets.mjs` の OWNERS） — `ext` という検証名は `KNOWN_TARGETS` に存在せず、`verify-ext-smoke.mjs` は `UNMAPPED_VERIFY_SCRIPTS` に載った「`mise run verify` の外」のスクリプト（CI は `ci.yml:47` の別ジョブ）。さらに `OWNERS` は登録ではなく**絞り込み**（`OWNERS` に無いファイルを触るとフルに倒れる仕掛け） / このまま書くと `verify-targets.test.mjs:29`「対応表の名前はすべて KNOWN_TARGETS にある」で落ちる。仮に名前を合わせても、`extensions.ts` / `Settings.tsx` / `settings-schema.js` を OWNERS に載せた瞬間、今フル実行に倒れているこれらの変更が 1 スイートに縮む（`Settings.tsx` は `verify-slots` が設定画面の描画まで見ている） / この手順は丸ごと落とし、OWNERS は触らない（フル据え置き）。新テストは既存の ext-smoke ジョブに足すだけにする。「配線を外して 0 件を見る」も verify-all の外なので成立しない
- Phase 2 > 3（`registerPreloadScript` で shim を配る） — DevTools のパネル（`chrome-extension://` の iframe）が pageSession の `{ type: 'frame' }` preload を通るかが未確認。前提に書かれた実測は「スタブ注入後に描画 OK」であって、preload 経由で届いたことの確認ではない / 届かなければ shim・vite 設定・パッケージ検査・検証まで作った後で配送方式ごとやり直しになる / 実装前に使い捨てインスタンスで「DevTools パネルの frame で preload が走るか」だけを 1 本のプローブで確かめる。通らないなら devtools 側の webContents にフックする案へ先に切り替える

## P1
- Phase 1 > 2（無効なものも `treeSha256` を照合する） — OFF の拡張のために起動のたびにツリー全体を hash する（Bitwarden は大きい） / 「重い・怪しい拡張を止める」という OFF の目的と逆に、止めた分のコストが起動時に残る / OFF の間は照合せず、ON に戻す `setExtensionEnabled` の中でだけ検証する
- Phase 1 > 2（`LoadedExtensionInfo` に無効分を混ぜる） — OFF の行の `name` / `version` / `optionsUrl` / `matchesLock` の出どころが未定。ロードしていないと `Electron.Extension` が無く、`optionsPageUrl` が作れない / 型は同じなのに中身の意味が行ごとに変わり、Settings と Sidebar で別々の場当たり対応になる / lock の `name` / `version` を使い、OFF の行は `optionsUrl: null`（＝「設定を開く」は ON のときだけ）と明示する
- Phase 2 > 2（shim の中身） — `globalThis.chrome` が未定義だったときの扱いが未定義。ece 側は `const chrome = globalThis.chrome || {}`（`chrome-extension-api.preload.js:104`）で**作ったオブジェクトを globalThis に戻さない** / shim が `chrome` を作るか作らないかで、ece の注入先が別オブジェクトになりうる（拡張から見て `chrome.tabs` が丸ごと消える事故になる） / 「`chrome` が無ければ `globalThis.chrome = {}` を作ってから `defineProperty`」まで書き、検証で `chrome.debugger` と同時に `chrome.runtime.id` が生きていることも見る
- Phase 1 > 1（設定スキーマ） — 拡張 ID の判定を `settings-schema.js` に新しく書く / 同じ正規表現が `src/shared/ext-lock.js` の `EXTENSION_ID_RE` にすでにある（二重管理） / それを import して使う。あわせて「lock から消えた ID が `disabled` に残り続ける」掃除方針（放置でよいか、起動時に間引くか）を 1 行決めておく
- Phase 1 > 5（検証） — 「OFF にすると SW target が消える」を即時 assert する読み方になっている / `removeExtension` 直後に service worker が止まっている保証はなく、間欠 FAIL になりやすい（`extensions.ts:143-169` で同種の遅延を既に踏んでいる） / `waitFor` でポーリングして消失を待つ

## P2
- Phase 1 > 4（設定画面） — OFF にした拡張のページ（options タブなど）を開いたままだと、死んだ `chrome-extension://` タブが残る。閉じるか放置かは後回しでよいが、放置と決めたことは書いておく
- Phase 2 > 3（登録順） — `registerPreloadScript` の実行順が登録順であることに依存している。ece の登録は `createExtensions()` の同期部分（`dist/cjs/index.js:2781-2795`）なので前に置けば足りるはずだが Electron 側の明示的な保証は薄い。計画どおり検証で固定したうえで、その理由をコードのコメントに残す
- Phase 1 > 1 — `settings-schema.js:53` のコメント「版を上げると同期先の古い Nemo が拒否する」は端末間同期を廃止した現状と食い違う。同じ場所を触るのでついでに直す

## Q
- Phase 1 > 4（設定画面 / Sidebar） — OFF の拡張をサイドバーのフッターにも出すか（薄く出す / まったく出さない） / 決めないと `getExtensions` の戻りの意味（「ロード済み」か「lock にある全部」か）が定まらず、フッターと設定で API を割るかどうかも決まらない
- Phase 2 > 2（スタブの適用範囲） — `chrome.debugger` スタブを全拡張ページに配るか、GraphQL Network Inspector の ID だけに絞るか / 決めないと shim の条件式と `compat.md` の書きぶりが決まらない（絞ると拡張を足すたびに手当てが要る、配ると「Nemo が嘘の API を全拡張に見せる」ことになる）

````

**対応**:
- P0 Phase1>2: UI 用一覧（OFF 込み）と allowlist 用 ID（ON のみ）を別の値で返し、`setLoadedExtensionIds` / `setExtensionCount` には ON 分だけ流すと明記。検証に「OFF 中の chrome-extension:// ナビ拒否」を追加
- P0 Phase1>3: トグル後に一覧を作り直して `setLoadedExtensions` / `setLoadedExtensionIds` を更新し、全ウィンドウへ push する経路を追記
- P0 Phase1>6: OWNERS ステップを取り消し線で削除。「前提 > 検証ハーネス」を実態（`UNMAPPED_VERIFY_SCRIPTS`、verify-all の外）に書き換え
- P0 Phase2>3: shim 実装前の「DevTools パネル frame で preload が走るか」プローブ手順を追加。走らなければ配送方式を変える
- P1 Phase1>2(hash): OFF の間は treeSha256 照合しない（ON に戻すときだけ）に修正
- P1 Phase1>2(info): OFF 行は lock の name/version、`optionsUrl: null` と明記
- P1 Phase2>2: `globalThis.chrome` が無ければ作ってから defineProperty、検証で `chrome.runtime.id` も見る
- P1 Phase1>1: `EXTENSION_ID_RE` を import。disabled に残った消えた ID は放置と決定
- P1 Phase1>5: SW 消失は `waitFor` でポーリング
- P2: 死んだタブは放置と明記 / 登録順依存のコメントを残す / settings-schema の同期コメント修正、いずれも反映
- Q Sidebar: フッターは ON だけ出す（`getExtensions` は lock 全件 + `enabled`、フッター側で絞る）と決定。根拠: Sidebar.tsx が mismatch 警告用に一覧を使っており OFF を出す意味がない
- Q スタブ範囲: 全 `chrome-extension://` ページに配ると決定。根拠: plan 既存の「`chrome.debugger` が無いときだけ生やす」方針＝ID で絞らない設計

## 2回目

````text
## P0

## P1
- Phase 1 > 4（`Settings.tsx` / `Sidebar.tsx`） — フッターの「拡張なし」判定（`extensions.length === 0`）と「lock 不一致」バッジ（`extensions.filter((e) => !e.matchesLock)`）は**配列全体**で計算していて、`enabled` での絞り込みを描画部分だけに入れると両方が嘘になる。加えて OFF 行の `matchesLock` に何を入れるかが未定 / 全部 OFF の端末でボタンも「拡張なし」も出ない空フッターになり、OFF 行を `matchesLock: false` にすると出したことのない警告が常時点く / フッターは先に `enabled` で絞った配列を作り、件数も不一致判定もその配列で出す。`LoadedExtensionInfo.matchesLock` は「OFF の行は照合していないので `true`（＝警告を出さない）」と型のコメントで決めておく（Settings の行の警告表示も同じ根拠で揃う）
- Phase 1 > 3（トグル後の push） — 新チャンネルを足す前提で書かれているが、`SharedState` に載せる方が安い / `Sidebar.tsx` は既に `useSharedState()` を読んでおり、全ウィンドウへ配る契機も `onPinsChanged` / `onDownloadsChanged` / `onLiveFolderChanged` と同じ形（`for (const win of windowsById.values()) win.pushShared()`）で揃っている。新チャンネルだと ipc・preload の `subscribe`・型・購読解除を新規に 4 か所足したうえ、mount 時 1 回取得との二重経路が残る / `SharedState` に `extensions` を足し、`onExtensionsChanged` を 1 本生やして `pushShared()` に相乗りする。`Settings.tsx` / `Sidebar.tsx` の mount 時 `getExtensions()` もそこへ寄せる
- Phase 1 > 2（`setExtensionEnabled` の ON 経路） — 「lock のエントリを再検証して `loadExtension`」までしか書かれておらず、`loadLockedExtensions` が持っている service worker 起動（`startWorkerForScope` + 遅延リトライ、`extensions.ts:142-170`）が抜ける / 「OFF→ON を拡張の再起動ボタンに使う」という目的（概要 1）と、検証の「ON に戻すと SW target が戻る」が両方満たせない。起動時経路とトグル経路で挙動が分岐したまま育つ / 1 エントリぶんの「整合性照合 → `loadExtension` → id/version 照合 → SW 起動 → `LoadedExtensionInfo` を返す」を関数に切り出し、起動時とトグルの両方が同じものを通す
- Phase 2 > 5（検証） — smoke が見るのはテスト拡張の popup / options ページで、**実際に効かせたい DevTools パネルの frame は実機確認だけ** / Electron や ece を上げてパネルへの preload 配送が壊れたとき、CI は緑のまま「パネルが真っ白」に戻る（Electron を上げる PR の判断材料にする、というこの smoke の目的から外れる） / `test-extension`（自作なので安い）に `devtools_page` を 1 枚足し、DevTools を開いてパネル frame で `chrome.debugger` が生えていることまで smoke で見る

## P2
- Phase 1 > 1（設定スキーマ） — `NemoSettings.extensions.disabled` はネストなので、`updateSettings` の浅いマージ（`store/settings.ts:26`）では `extensions` オブジェクトごと置き換わる。今はキーが 1 つなので害は無いが、後で `extensions.*` を増やしたときに黙って消える。`normalizeSettings` 側で `extensions` を毎回組み立て直す（未指定キーは既定で埋める）ことを 1 行書いておく
- Phase 2 > 4（lock への追加） — `validateEntry` は `sha256` / `treeSha256` の未記入を許すので、`id` / `name` / `version` / `source.url` だけ書いて `ext:fetch` に埋めさせる手順になる。Store の配信版が `2.26.1` でなければ materialize が版違いで止まるので、そのときは `ext-fetch.mjs --update <version> --id <id>` を使う、と手順に添えておくと詰まらない

## Q

````

**対応**: 収束（P0 なし）。反映した P1/P2:
- P1 Phase1>4: フッターは enabled で絞った配列で件数・不一致判定も出す。OFF 行は `matchesLock: true` と明記
- P1 Phase1>3: 新チャンネルでなく `SharedState.extensions` + `pushShared()` に相乗り、mount 時取得も `useSharedState` に寄せる
- P1 Phase1>2: 1 エントリぶんのロード（SW 起動込み）を関数に切り出し、起動時とトグルで共有
- P2 Phase1>1: `normalizeSettings` で `extensions` を毎回組み立て直す
- P2 Phase2>4: lock 追記の手順（hash は ext:fetch に任せる、版違い時の `--update`）
- 見送り: P1 Phase2>5（test-extension に devtools_page を足して smoke で DevTools パネル frame を見る）— 仕組み・fixture の追加なのでループ中は見送り、終了報告へ

**ユーザー決定（2回目の見送り分）**: Phase 2 > 5 は A を採用。`test-extension` に `devtools_page` を足し、smoke でパネル frame の `chrome.debugger` を見る。plan の Phase 2 検証に反映済み
