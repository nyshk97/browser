review session: 7e96a5b3-d075-420a-9b47-fba8bd433811

## 1回目

````text
`docs/plans/2026-08-30-2026-favorite-custom-icon.md` をコードと突き合わせてレビューしました。

## P0
- **Phase 2: IPC と renderer > 1** — `nemo:set-custom-icon` を既存ハンドラの型どおりに書くと `requireString`（`src/main/ipc.ts:226`、長さ ≤ 4096）/ `optionalTitle`（同 246、≤ 4096）に当たる / 決定表の上限は 16KB なので、**画像アイコンは 100% `invalid icon` で throw** して Phase 3 ③ 以外の全ケースが落ちる / `MAX_CUSTOM_ICON_LENGTH` を上限にした専用ガード（例 `optionalIcon`）を ipc.ts に足し、`requireString` は id にだけ使う
- **Phase 1: スキーマとストア > 4** — `setCustomIcon(id, icon)` の `null` が「既定に戻す（意図した解除）」と「不正値の正規化結果」の両方を意味する / 上限超えや壊れた値が来たときに**既存のアイコンを黙って消す**挙動になり、Phase 3 ③「IPC で拒否される」も観測できない（消えたのか拒否したのか区別が付かない） / `setCustomIcon` は `boolean` を返し、明示 `null` のときだけ解除・不正値は書かずに `false` + ログ、と決めてから実装する
- **Phase 1: スキーマとストア > 4** — `convertPinToFavorite` / `convertFavoriteToPin`（`src/main/store/pins.ts:587,616`）への `customIcon` 引き継ぎが計画に無い / この 2 つは `target` を手で組み立てており、`faviconUrl` には「null で埋めると頭文字に戻る」という注記付きの明示コピーがある。追随しないと**ピン⇄Favorite 変換でユーザーが設定したアイコンだけが消える** / 両関数の `target` 生成に `customIcon` を足し、verify-pins の既存の変換検査（`pin.converted_to_favorite` 周辺）にアイコン保持の check を 1 つ足す
- **Phase 3: 自走検証 > 2** — `scripts/lib/verify-targets.mjs` の `OWNERS` 更新が計画に無い / 触るファイルのうち `src/renderer/components/Sidebar.tsx` / `PinnedTree.tsx` / `src/main/store/pins.ts` / `src/shared/settings-schema.js` / `favorites.js` / `ipc.ts` / `preload/ui.ts` のエントリが古いままだと `--changed` で pins が回らない。CLAUDE.md が「既存エントリの広げ忘れは落とせない（腐っても症状は速く PASS）」と名指ししている罠 / 各エントリに `'pins'` が入っているかを実装前に確認し、足りないものを広げる工程を Phase 3 に入れる
- **Phase 2: IPC と renderer > 6** — PinnedTree の行にアイコン編集の入力先が無い / `.fav-edit` は Sidebar のグリッド下に出す Favorites 専用の枠で、PinnedTree は行内 `InlineRename`（`src/renderer/components/PinnedTree.tsx:242` 前後）。「右クリック項目を足す」だけでは押した先が存在せず、実装時に設計をやり直すことになる / 絵文字入力＋「画像を選ぶ…」＋「既定に戻す」を `IconEdit` コンポーネントとして切り出し、Sidebar は `.fav-edit` 内、PinnedTree は対象行の直下に同じものを出す、と先に決める

## P1
- **Phase 3: 自走検証 > 1（①）** — 「再起動 → 残っている」を verify-pins の既定モードに書くことはできない / 再起動を跨ぐ検査は `--lazy-write` / `--lazy-read`（`scripts/verify-pins.mjs:107,139`）に分かれており、走るのは `verify-all.mjs` の `if (want('restart'))` ブロック内で `want('pins')` も真のときだけ / 絵文字の設定を `--lazy-write` に、残存確認を `--lazy-read` に置き、報告では `--only restart pins` で実際に走らせた件数を出す
- **Phase 3: 自走検証 > 1（②）** — 「同じ fixture でもう 1 回起動」の fixture が verify-pins に存在しない（`resetDefinitions()` で作る方式） / 書けないか、実質 ① の二度打ちになって冪等を見たことにならない / 冪等は `normalizePins(normalizePins(x))` の等価性として `scripts/settings-schema.test.mjs` 側で見る（アプリ起動が要らず、壊れたときの原因も一意）
- **Phase 2: IPC と renderer > 4** — `createImageBitmap` で SVG を読む前提 / Chromium の `createImageBitmap(Blob)` は SVG を扱えず、動作確認の「画像ドロップ（PNG / SVG）」が落ちる。かつ UI の CSP に `blob:` が無いので `URL.createObjectURL` 経由の `<img>` 退避も使えない / `FileReader.readAsDataURL` → `<img src={dataUrl}>` → `await img.decode()` → canvas、に置き換える（data: は CSP で許可済み）
- **Phase 2: IPC と renderer > 4** — 64×64 PNG で 16KB に収まる前提 / 写真やグラデーションのある画像は 64×64 PNG でも base64 で 16KB を超えることがあり、「ドロップしたのにエラー」が普通に起きる / 64→48→32 と段階的に縮めて最初に上限に収まったものを送る（それでも超えたらエラー表示）
- **Phase 1: スキーマとストア > 1** — `normalizeCustomIcon` の grapheme 判定だけでは空文字・空白・制御文字が抜ける / 半角/全角スペース 1 個は「1 grapheme」で通り、保存はされるのにセルが空白になって「アイコンが消えた」ように見える（しかも `faviconUrl` へのフォールバックも起きない） / 先に `trim()`、空なら `null`、`\p{White_Space}` と `\p{C}` を含むものは `null`。ユニットテストに空白 1 文字のケースを足す
- **Phase 3: 自走検証 > 2** — 「配線を外して 0 件」は新規スイート登録時の手順で、今回は既存の `pins` に check を足すだけ / そのまま実施しても意味のある 0 件にならず、確認したつもりになる / 代わりに追加前後で `mise run verify:only pins`（および `restart pins`）の検査件数を取り、差分が追加した check 数と一致することを報告に出す

## P2
- **決定表 > ログ** — `definition.icon-changed` のハイフン / 既存は `definition.renamed` / `pin.url_update_rejected` / `favorite.converted_to_pin` と、ドット以降は snake_case で揃っている / `definition.icon_changed` にする
- **決定表 > 画像の形式** — main が `data:image/` 全般を受ける / renderer は必ず PNG に変換して送るので、受け口を広く開けておく理由が無い（`data:image/svg+xml` も通る） / `data:image/png;base64,` 前置き一致まで絞る
- **Phase 1: スキーマとストア > 1** — `src/shared/favorites.js` の置き場は妥当（`tsconfig.web.json` の `include` に既にある）だが、モジュール冒頭の doc が「セクションまわりの純粋関数」と宣言している / 次に読む人が置き場のルールを誤解する / doc を「定義の表示まわり（セクション・カスタムアイコン）」に広げる
- **決定表 > 画像の上限** — sharedState は `getFavorites()` をそのまま載せて変更のたびに全ウィンドウへ配る（`src/main/registry.ts:1883`） / 16KB × 件数が毎回シリアライズされる。数件なら無視できるが、上限を上げるならここが効く / いまは対応不要、CHANGELOG かコメントに「上限を上げるときは broadcast サイズも見る」とだけ残す

## Q
- **決定表 > 絵文字の形式** — 「1 grapheme」で足りるか（Slack ×3 の区別は実運用だと `W1` / `#a` のような 2〜3 文字が欲しくなる可能性がある） / ここは `normalizeCustomIcon` の判定そのもので、後から緩める分には安全だが、緩めた瞬間に「セル中央にテキスト」の描画（font-size 固定）を作り直すことになる
- **決定表 > 描画優先順** — customIcon を ⌃M スイッチャー / TabRow / SplitRow（`Favicon` の他の呼び出し元）にも出すか / 出さない場合、⌘1〜9 のグリッドでは 3 つの Slack を区別できるのにタブ切り替え UI では同じ favicon のまま、という非対称が残る（customTitle は既に名前で区別できている分、余計に目立つ）
- **決定表 > フィールド名 / Phase 1** — セーブスロットのカード（`slots-schema.js` の `icons`、URL ごとの favicon を焼き込む別系統）に customIcon を反映するか / 反映しないと、スロット一覧のカードだけ設定前の favicon が残る。今回スコープ外にするなら plan に明記しておかないと次に見たとき「漏れ」に見える

````

**対応**:
- P0 全件反映: IPC の専用ガード（決定表 IPC）/ `setCustomIcon` は boolean・明示 null だけ解除（決定表 IPC・Phase 1-4）/ convert 2 関数への引き継ぎ（Phase 1 に追加）/ OWNERS 確認工程（Phase 3）/ `IconEdit` を切り出して PinnedTree は行直下（Phase 2-3, 2-6）
- P1 反映: lazy-write/read 分割・冪等はユニットテストへ・FileReader 経路・段階縮小・空白/制御文字の除外・検査件数の差分報告
- P2 反映: `definition.icon_changed`・PNG 前置きのみ。見送り: favorites.js の doc 文言（実装時に直す細部）、broadcast サイズの注記（今は不要と指摘自身が言っている）
- Q 決定: 絵文字は 1 grapheme のまま（根拠: 会話の要望は「絵文字」。緩めると描画設計ごと変わる）/ 他の Favicon 呼び出し元とスロットカードは今回の範囲外と明記（根拠: スロットは URL 単位の別系統で設計が別途要る）。いずれも決定表に反映

## 2回目

````text
計画を読み直し、OWNERS・正規化・IPC 契約を実コードで確認しました。前回の P0/P1/P2 はおおむね正しく反映されています。新たに 3 件の P0 があり、うち 1 件は前回私が誤った前提で出した指摘（OWNERS）の訂正です。

## P0
- **決定表 > 絵文字の形式** — `\p{C}` を含むものを null にすると **ZWJ 絵文字が全滅する**。U+200D ZERO WIDTH JOINER は General_Category=Cf で `\p{C}` に含まれるため、👨‍👩‍👧 / 🏳️‍🌈 / 🧑‍💻 のような「1 grapheme だが内部に ZWJ を持つ」列がすべて拒否される / 目的そのもの（絵文字で区別する）が代表的な絵文字で動かず、しかも症状は「入力しても何も起きない」なので実装中に気づきにくい / 除外は `\p{White_Space}` と `\p{Cc}` に絞り、`\p{Cf}` は 1 grapheme に収まっている限り通す。あわせて長さ上限 16 は 👨🏻‍❤️‍💋‍👨🏻（UTF-16 で 15 単位）でぎりぎりなので 32 にする。Phase 1 > 6 のテスト一覧に「ZWJ 絵文字（家族・虹旗）が通る」「国旗（regional indicator 2 個で 1 grapheme）が通る」を足す
- **Phase 3: 自走検証 > 2** — 前提が実物と違う。`Sidebar.tsx` / `PinnedTree.tsx` / `store/pins.ts` / `settings-schema.js` / `favorites.js` / `ipc.ts` / `preload/ui.ts` は **どれも `OWNERS` に載っていない**（載っているのは `slots-schema.js → ['slots','pins']` のような別ファイル）。前回私が「エントリを広げる」と書いたのは誤りでした / 未登録のファイルは `selectVerifyTargets` が `triggers` に入れて `kind: 'full'` に倒す安全側の挙動。ここに `['src/main/ipc.ts', ['pins']]` などを足すと、今フルで回っているものが **pins だけに絞られる改悪**になる（`OWNERS` の doc も「迷ったら載せない（＝フルに倒れる）」「registry.ts のような複数スイートが依存する巨大ファイルは意図的に載せていない」と明記） / この工程を「7 ファイルが未登録＝フルに倒れることを確認するだけ。`OWNERS` は変更しない。新規 `IconEdit.tsx` も同じ理由で載せない」に書き換える
- **決定表 > IPC / Phase 3: 自走検証 > 1（②）** — 「`MAX_CUSTOM_ICON_LENGTH` を上限にした専用ガード」と「上限超えは `false` を返す」が両立しない / `ipc.ts` の既存ガード（`requireString` / `optionalTitle`）はすべて throw する型なので、同じ形で長さガードを書くと上限超えは invoke の reject になり、②の「`false` を返し、既存のアイコンが残っている」は永久に成立しない（検査を書いてから作り直しになる） / ガードは**型だけ**（`string | null` 以外は throw）にし、長さ・形式の判定は `normalizeCustomIcon` に集約して `setCustomIcon` が `false` を返す、と決める。renderer は段階縮小しても収まらない画像を送り得るので、上限超えはプロトコル違反ではなくユーザー操作の結果として扱うほうが筋が通る

## P1
- **Phase 2: IPC と renderer > 1** — `setCustomIcon` の `boolean` が renderer の型と UI に届いていない / `NemoApi` が `Promise<void>` だと Phase 3 ② で戻り値を読めず、main 側の拒否がユーザーにも無反応で終わる（Phase 2 > 4 のエラー表示は renderer 側の上限超えしか拾わない） / `NemoApi.setCustomIcon(id, icon): Promise<boolean>` と明記し、`IconEdit` は `false` のときも同じエラー表示に落とす
- **決定表 > ログ** — 拒否側のイベントが未定義（`definition.icon_changed` は成功時のみ） / 「消えた」と「拒否した」を区別する、という決定がログからは追えないままになる / 既存の `pin.url_update_rejected` に倣って `definition.icon_rejected { id, reason: 'too_long' | 'invalid' }` を決定表に足す（data URL は入れない）
- **Phase 2: IPC と renderer > 5** — 画像のドロップが**セルの真上でしか成立しない** / `acceptsDrag` は `isTabDrag || dragId` で、ファイルのドラッグでは `.fav-grid` / `.fav-empty` の `onDragOver` が `preventDefault()` しない。隙間や空グリッドに落とすと drop が発火せず、既定動作のファイル遷移が `ui-view.ts` の `will-navigate` ガードに弾かれて `ui.navigation_blocked` が出るだけになる（狙いを外しやすいサイズのセルなので普通に起きる） / `acceptsDrag` に `event.dataTransfer.types.includes('Files')` を足し、グリッド側の `onDrop` でもファイルを飲み込む（受けないなら何もせず return）
- **Phase 2: IPC と renderer > 2 / 決定表 > 描画優先順** — 画像アイコンを `<Favicon src={customIcon}>` として渡すと、優先順表と実際のフォールバックがずれる / `Favicon` は `src` の読み込み失敗時に `failedSrc` を覚えて**頭文字**へ落ちるので、壊れた customIcon が入ると `tab.faviconUrl` / `faviconUrl` を飛ばして頭文字になる / 画像は `src={favorite.customIcon ?? tab?.faviconUrl ?? favorite.faviconUrl}` と 1 本に畳んで渡し、絵文字のときだけ `<span className="fav-emoji">` に分岐する

## P2
- **Phase 2: IPC と renderer > 6** — 「PinnedTree の行にも右クリック項目を足す」がフォルダ行を含むように読める / 決定表は「フォルダには付けない」で、フォルダ行は `PinnedTree.tsx` の別分岐で `openMenu` を組んでいる / リンク行の分岐にだけ足す旨を 1 語添える
- **Phase 3: 自走検証 > 1（③）** — DOM 検査の手がかりが「グリッドに絵文字で描画されている」としか書かれていない / 既存の `.row.pin` / `img.fi` を引く検査と同じ粒度で `.fav .fav-emoji` を決め打ちしておくと、実装と検査が同時に書ける
- **前提・わかっていること** — スロットの扱いが決定表の「範囲外」だけだと誤読されうる / `normalizeSlot` は `normalizePins(input)` を呼んで `favorites` / `pinned` をそのまま持つので、**customIcon はスロットの保存・復元では自動的に残る**。範囲外なのはカードの `icons`（URL 単位の別系統）だけ、と前提に 1 行足す

## Q

````

**対応**:
- P0 全件反映: `\p{C}` → `\p{Cc}` に絞り `\p{Cf}` は通す・長さ 32・ZWJ/国旗のテスト（決定表・Phase 1-6）/ OWNERS は変更しない旨に書き換え（前提・Phase 3-2）/ ipc ガードは型だけ・判定は normalizeCustomIcon に集約して `false`（決定表 IPC）
- P1 反映: `Promise<boolean>` と `false` 時のエラー表示・`definition.icon_rejected`・`acceptsDrag` に Files とグリッド側 drop・`Favicon src` を 1 本に畳む
- P2 反映: リンク行に限定・`.fav .fav-emoji` 決め打ち・スロットの保存/復元は自動で残る旨を前提に追記

## 3回目

````text
3 回目のレビューです。前回の P0 3 件は実コードと突き合わせて正しく反映されており（`\p{Cc}` への絞り込み・OWNERS は変更しない・ガードは型だけで判定は `normalizeCustomIcon`）、`inheritSections` / `replaceAll` / `slot-apply` もすべてスプレッド経由なので customIcon は自動で通ります。手戻りが確定する残件はありません。

## P0

## P1
- **決定表 > 絵文字の形式** — 括弧の中が意図と逆になっている（「`\p{Cf}`（ZWJ・VS16）は 1 grapheme に収まる限り通す（👨‍👩‍👧 / 🏳️‍🌈 が落ちる）」） / 決定表はそのまま実装の仕様として読まれる行なので、「通すと落ちる」と読めると排除規則を逆に書きかねない（前回の P0 の再発経路がここに残っている） / 「通さないと 👨‍👩‍👧 / 🏳️‍🌈 が落ちる」に直す。あわせて VS16（U+FE0F）は Cf ではなく Mn なので例示から外す（どちらも許可されるので挙動は変わらないが、根拠が誤っていると次に規則を触る人が同じ穴を掘る）
- **Phase 2: IPC と renderer > 3** — `IconEdit` の入力欄の初期値が未定義 / 既存の `.fav-edit` は `initial={editing.customTitle ?? editing.title}` の形なので素直に倣うと `initial={customIcon ?? ''}` になり、**画像アイコンを設定済みの定義で「アイコンを変更…」を開くと 16KB の data URL が絵文字欄に入る**。そのまま Enter で送れば `definition.icon_rejected` が出るだけの行き止まりになる / 初期値は「customIcon が絵文字のときだけそれ、画像のときは空」とし、画像が入っていることはサムネイル＋「既定に戻す」で示す、と Phase 2 > 3 に書く
- **Phase 1: スキーマとストア > 2** — `PINS_VERSION` の扱いが計画に出てこない / その doc コメントは「**`section` / `faviconUrl` は版を上げずに足した**（欠損は既定値に倒すだけで、旧データを読む側の分岐が要らない）」と、版を上げずに足したフィールドを明示的に列挙している場所。customIcon も同じ性質なのに書き足されないと列挙が腐り、実装者が版を 3 に上げるか毎回迷う / 「版は上げない（欠損は null に倒すだけ）」と決めて、`PINS_VERSION` の doc コメントに customIcon を足す一行を Phase 1 に入れる

## P2
- **決定表 > IPC** — ガードを型だけにすると、IPC 境界に長さの歯止めが 1 つも無くなる（既存は `requireString` / `optionalTitle` が全経路 4096 で切っている） / `false` を返す契約は保ったまま、`MAX_CUSTOM_ICON_LENGTH` の数倍を超える文字列だけ throw する（正規の renderer は段階縮小で必ず上限内に収めるので到達しない）と書いておくと、両方の意図が残る
- **Phase 2: IPC と renderer > 5** — `acceptsDrag` に `types.includes('Files')` を足すと、画像以外のファイル（PDF など）をサイドバー上でドラッグしただけで `.drop` ハイライトが出て、落としても何も起きない / dragover 中は `files` を読めないが `items[0].type` は読めるので、`image/` 前置きで絞れる
- **Phase 3: 自走検証 > 1（②）** — 上限超えの data URL を `ui.ev` に渡す式が 16KB 超のリテラルになる / `'data:image/png;base64,' + 'A'.repeat(20000)` をページ内で組み立てる形にすると、式が短く保てて意図も読める
- **Phase 2: IPC と renderer > 2** — 絵文字か画像かの判定（`customIcon.startsWith('data:')`）が Sidebar / PinnedTree / IconEdit の 3 か所に散る / `favorites.js` に `isImageIcon(icon)` の 1 行の述語を置いて共有すると、`normalizeCustomIcon` と判定条件が同じファイルに並ぶ

## Q

````

**対応**: 収束（P0 なし）。採用した P1: 絵文字形式の括弧の文言修正と VS16 の除外 / IconEdit の初期値（画像は空） / `PINS_VERSION` は上げず doc に追記。採用した P2: IPC ガードに暴走止めの上限 / `acceptsDrag` を `image/` に絞る。見送り: テストのリテラル組み立て・`isImageIcon` 述語（実装時に決める細部）
