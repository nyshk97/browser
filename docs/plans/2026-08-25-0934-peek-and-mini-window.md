# Peek（ウィンドウ内ポップアップ）と小窓（Little Nemo）

## 概要・やりたいこと

リンクを「別タブで開く」ときの挙動を Arc に寄せる。作るのは2つ。

**A. Peek** — ページ内のリンク（`target=_blank` / `window.open`）を、いきなりタブとして
積むのではなく、**今見ているページの上に浮かぶポップアップ**で開く。ざっと見て閉じるか、
⌘O で通常のタブに昇格させるかを後から選べる。

**B. 小窓（Little Nemo）** — ターミナルや Slack から踏んだリンクを、**メインウィンドウを
前面に出さずに**、今いる画面の上へ小さなウィンドウで開く。⌘O でメインウィンドウのタブへ移す。

今の Nemo の困りごとは B。ターミナルで出力された URL を「ちょっとだけ確認したい」だけなのに、
`app.focus({ steal: true })` でフルスクリーンの Nemo に画面ごと持っていかれ、作業が中断する。
「確認する」と「腰を据えて読む」を **⌘O という1操作で分ける**のが目的。

## 前提・わかっていること

### 現状のコード（調査済み）

| 項目 | 現状 |
|---|---|
| 外部 URL の受け口 | `main/open-url.ts`。`app.ready` 前に購読して queue し、`flushOpenUrls` で流す |
| 外部 URL の処理 | `main/index.ts:196` の `openExternalUrl`。`createTab` → `win.baseWindow.focus()` → `app.focus({ steal: true })` で**フォーカスを完全に奪う** |
| popup の処理 | `main/registry.ts:558` の `setWindowOpenHandler`。**`deny` した上で URL だけを取り出して作り直す** |
| ウィンドウ | `NemoWindow`（`registry.ts:721`）。`BaseWindow` + サイドバー用 `chromeView` + 透明な `overlayView` + タブごとの `WebContentsView` |
| オーバーレイ | `overlayView` は**1枚だけ**。`OverlayKind` を出し分ける。`layout()` で毎回最前面に付け替える |
| タブの実体化 | `NemoTab.materialize()`（`registry.ts:364`）が `new WebContentsView` → `loadURL` までやる |
| タブの所有権移動 | `moveTabToWindow`（`registry.ts:1358`）。View を作り直さず移し、拡張の tab→window 対応も貼り替える |
| 閉じたタブ | `closedTabs`（`registry.ts:1246`）に積み、`reopenClosedTab` で戻す |
| 自動 sleep / archive | `sweepSleep`（`registry.ts:1678`）/ `sweepArchive`（`registry.ts:1709`）。5秒ごとに全ウィンドウの `win.tabs` を舐める |
| キーバインド | `shared/keybindings.js` の `COMMANDS`。**⌘O は未使用**（衝突しない） |
| Electron | 41.10.6。`WebContentsView.setBorderRadius()` / `BaseWindow.setVisibleOnAllWorkspaces(visible, { visibleOnFullScreenWindow })` / `showInactive()` が使える |

### `/dig` で決めたこと

#### A. Peek（ウィンドウ内ポップアップ）

| 項目 | 決定 |
|---|---|
| 契機 | `target=_blank` / `window.open`（**サイズ指定つきの OAuth・決済ポップアップも含む**）/ ⌘⇧クリック。つまり**前面に出そうとする要求すべて** |
| 例外 | **⌘クリック（`disposition === 'background-tab'`）は従来どおり背面タブ**。検索結果から何本も背面に溜める操作を殺さない |
| 枚数 | **1タブにつき最大1枚** |
| 範囲 | **ページ領域だけ**を覆う。サイドバーは覆わず、Peek を開いたままタブを切り替えられる |
| 寸法 | ページ領域の **90%強・固定**。周囲は暗幕。リサイズ不可 |
| 寿命 | **タブに紐づく**。別タブへ行くと隠れ、戻ると再表示される |
| 閉じる | **✕ / Esc / ⌘W** の3つ。**暗幕クリックでは閉じない**（テキスト選択のドラッグがはみ出したときの誤爆を避ける） |
| 昇格 | ⌘O または展開ボタン → **同じウィンドウの一時タブ（末尾）**になりアクティブに。ページは読み直さない |
| ✕ / 展開ボタン | Arc と同じく Peek の**外側**（暗幕の上、ページ領域の右上）に置く |

#### B. 小窓（Little Nemo）

| 項目 | 決定 |
|---|---|
| 契機 | 外部アプリからの URL（`open-url` / argv / second-instance）。**Nemo が前面にいても常に小窓** |
| フォーカス | **小窓には渡す**（⌘O・⌘W・スクロールが即効く）。ただし**メインウィンドウは前面に出さず、Space も動かさない** |
| Space | フルスクリーンのターミナルの上に出す。**出した Space に固定**するのを狙う。実機で無理なら全 Space 追従に倒す |
| 位置・寸法 | **常に同じ**（記憶しない）。2枚目以降は少しずらす |
| 枚数 | **原則4枚**。超えたら一番古いものを自動で閉じる。ただし**opener チェーンを守っている間だけ一時超過**し、子が閉じた時点で4枚まで戻す（R10） |
| バー | 戻る / 進む / リロード + URL（**表示のみ**。クリックでコピー）+ ⌘O + ✕。サイドバー無し |
| 昇格 | ⌘O → **直近に使っていた通常ウィンドウ**の一時タブ（末尾）へ。読み直さない。小窓は閉じ、メインウィンドウが前面に出る（ここでは Space が切り替わってよい） |
| 未起動時 | 小窓だけ出す。通常ウィンドウは**背面で**セッション復元する |

#### 両方に共通

- 拡張（Bitwarden 等）は**通常タブと同じく動く**。`chrome.tabs` に登録し、content script も入る
- **履歴に残り、⌘⇧T で戻せる**。戻すときは Peek / 小窓ではなく**普通のタブ**として開く
- **再起動では復元しない**
- セッション（シークレット継承）は開き元に従う。**外部 URL の小窓は常に通常セッション**
- サイト側が `window.close()` したら Peek / 小窓も閉じる

### レビューで判明した罠（ここを外すと静かに壊れる）

初稿のレビューで7点の欠陥が出た。**どれも「動くように見えて壊れる」類**なので、対策を
仕様として先に書いておく。

#### R1. popup は `deny` + URL 作り直しでは壊れる → `action: 'allow'` + `createWindow` を使う

現状の `setWindowOpenHandler`（`registry.ts:558`）は `deny` して URL だけを取り出して
作り直している。Peek をこの方式で作ると、**新しい browsing context に付随するものが全部落ちる**:

- `<form target="_blank">` の **POST body**
- `window.opener` と `postMessage`
- referrer / window name
- 「スクリプトが開いた子だけが `window.close()` できる」という関係（**OAuth の戻りが閉じない**）

Electron 41 の `WindowOpenHandlerResponse` には
`createWindow?: (options: BrowserWindowConstructorOptions) => WebContents` があり
（`electron.d.ts:19855`）、`action: 'allow'` と併せて返すと **`new BrowserWindow` の代わりに
自前の WebContents を子として使わせられる**。「`allow` を返すと BaseWindow 外の BrowserWindow が
できてしまう」という現状のコメントは `createWindow` を渡さない場合の話で、渡せば起きない。

- Peek 用の `WebContentsView` を**同期で**作り、その `webContents` を返す
- **`outlivesOpener: true` を必ず付ける**（R11。付け忘れると昇格したタブが道連れで消える）
- `loadURL` は**呼ばない**（Electron が子として読み込む）。`materialize()` に
  「View と WebContents だけ作って読み込みは任せる」経路を足す
- `background-tab`（⌘クリック）は**現状のまま** `deny` + `createTab`。既存挙動なので今回は触らない

**`options.webPreferences` は引き継がず、`materialize()` と同じ設定を自前で組む**
（レビューでは「引き継いだ上でセキュリティ項目を上書きせよ」という案が出たが、採らない）:

- `options.webPreferences` は `window.open` の**feature string をパースしたもの**、
  つまり**ページが制御できる値**
- Electron が「embedder より緩くできない」と保証しているのは
  `contextIsolation` / `javascript` / `nodeIntegration` / `nodeIntegrationInWorker` /
  `sandbox` / `nodeIntegrationInSubFrames` / `enableWebSQL` の**7つだけ**
  （`electron.d.ts:19845-19850`）。**`webviewTag` / `experimentalFeatures` /
  `allowRunningInsecureContent` は入っていない**
- しかもそのガードは Electron 自身が子を作る経路のもので、`createWindow` callback の中で
  自分で `new WebContentsView` する場合は走らない。spread して個別に潰す形は
  「潰し忘れた項目が素通りする」ブラックリストになる
- `security.ts` の既存方針（許可を列挙する）とも揃わない
- `options` のサイズ・位置は Peek / mini が固定寸法なのでそもそも使わない

**この判断はコードコメントに残す**。「Electron の doc は options を使えと書いているのに
無視している」ように見えて、後から善意で戻されるのを防ぐ。

#### R2. `selectTab` が Peek を問答無用で隠す → active を2つに分ける

`selectTab`（`registry.ts:1212`）は
`for (const other of win.tabs) other.view?.setVisible(other.key === key)` をやる。
このままだと **Peek は一度も表示されない**。

さらに `extensions.addTab()` / `extensions.selectTab()` は chrome 側の active を動かすので、
「Nemo のサイドバーで選ばれているタブ」と「chrome から見た active タブ」を**意図的に分ける**:

| 状態 | 意味 | 用途 |
|---|---|---|
| `win.activeTabKey` | **サイドバーで選択されている通常タブ**。Peek は絶対に入らない | サイドバー・⌘1〜9・次前のタブ・セッションの `activeIndex` |
| `win.visibleTabKeys` | 実際に表示している View の集合（= 選択中の通常タブ ＋ そのタブの Peek） | `selectTab` の `setVisible` 判定・`layout()` |
| chrome の active | **Peek があるなら Peek**。無ければ通常タブ | Bitwarden が「今いるページ」を正しく掴むため |

- `selectTab` の可視判定を `visibleTabKeys` の集合に変える
- `getVisibleTabKeys()` の契約（`shared/types.ts:377` の「正常なら activeTabKey ただ1つ」）を
  「選択中の通常タブと、あればその Peek」に書き換える

**chrome の active は「開いた瞬間に1回撃つ」ではなく `syncForegroundTab(win)` で毎回再計算する。**
1回撃つだけだと、次の経路で静かにズレる:

| 経路 | 何が起きるか |
|---|---|
| 別タブへ行って親へ戻る | `selectTab(parent)` が chrome active を**親に**戻してしまう（Peek は表示されているのに） |
| `extensions.ts:355` の `selectTab` callback | 拡張側から `selectTab(peek)` が呼び返される |
| 拡張が自分で Peek を active にする | `activeTabKey` に **Peek が入る**恐れがある |

- `syncForegroundTab(win)` = 「選択中の通常タブに Peek があれば chrome active は Peek、
  無ければその通常タブ」を毎回計算して `extensions.selectTab` に反映する
- `selectTab`・Peek の開閉・`moveTabToWindow` の後で必ず通す
- **`selectTab` に Peek の key が渡されたら、その親を選択したものとして扱う**
  （`activeTabKey` に Peek を入れない。拡張からの呼び返しがここに来る）

**`syncForegroundTab` は必ず冪等にする。** そうしないと `selectTab` が持っている
再入ガード（`registry.ts:1223` の「既に active なら通知しない」）を素通りして、
次の循環が復活する:

```
syncForegroundTab → extensions.selectTab(peek) → extensions.ts:355 の callback
  → selectTab(peek) → 親へ読み替え → syncForegroundTab → extensions.selectTab(peek) → …
```

- **最後に同期した WebContents id を覚え、同じなら何もしない**
- 加えて `syncingExtensionSelection` の再入ガードを置く（読み替えの途中で再入しても止まる）
- ウィンドウ破棄時に覚えている id を捨てる（id が再利用されたときに誤って握り潰さない）

#### R3. `normalTabs` に寄せる箇所は「一覧・選択対象」だけ。監視対象は全タブのまま

Peek を `win.tabs` に入れる以上、`win.tabs` を舐めている既存処理が Peek を拾う。
ただし**全部を `normalTabs` にすると別のバグが出る**ので、述語を2つに分ける。

`normalTabs`（= `tabs.filter((t) => t.peekOf === null)`）に向けるもの:

| 場所 | 内容 |
|---|---|
| `registry.ts:993` | セッション保存（`toSaved`） |
| `registry.ts:1292` | **`removeTab` の次タブ選択**（初稿で漏れていた。別の親の Peek を選びかねない） |
| `registry.ts:1397` | **`moveTabToWindow` の次タブ選択**（同上） |
| `registry.ts:1596,1608` | ピン留め / Favorite の既存タブ探索 |
| `registry.ts:1687` | `sweepSleep` |
| `registry.ts:1719` | `sweepArchive` |
| `menu.ts:146-154` | 次 / 前のタブ・新規ウィンドウへ移動 |
| `menu.ts:277` | ⌘1〜9 |
| `tab-switcher.ts:65` | MRU の並び |
| `ipc.ts:202` | `move-tab-to-new-window` の下限判定 |

**`win.tabs`（全タブ）のままにするもの**:

- `tab-switcher.ts:139` の `attachInput` — これは**全 WebContents への入力監視**。
  Peek にフォーカスがあるときの keyUp / Esc も拾う必要があるので、絞ると ⌃M が壊れる
- `layout()` / `destroy()` / `findTab()` — 実在する View 全部を相手にする場所

#### R4. mini の「常に1タブ」はメニューを塞ぐだけでは守れない

初稿はコマンドを塞ぐとしか書いていなかったが、次の経路でも mini にタブが増える:

- `extensions.ts:336` の `chrome.tabs.create` — `focusedOrFirstWindow()` が**フォーカス中の mini を返す**
- mini の中の `target=_blank` / ⌘クリック
- mini での ⌘⇧T（`reopenClosedTab`）
- IPC の `nemo:create-tab`

**`canHostAdditionalTabs(win)` を registry に置き、menu / IPC / extensions / popup の
全経路をそこへ寄せる**。mini が弾かれたときの行き先も決める:

- `chrome.tabs.create` / ⌘⇧T → **通常ウィンドウの MRU 先頭**へ（R7 の解決順に従う）
- **mini の中の新規 browsing context 要求（前面・背面を問わず）→ もう1枚の mini を開く**
  （R8。中身の差し替えは opener を殺すので採らない）

#### R5. mini / Peek の終了経路が `closedTabs` に残らない

`NemoWindow.destroy()`（`registry.ts:1010`）は `removeTab` を通らず `wc.close()` するだけ。
このままだと mini の ✕ / ⌘W / 5枚目での自動終了 / `window.close()` が
**⌘⇧T にもアーカイブにも残らない**。

**さらに、終了 API を用意しただけでは迂回される経路が2つある**:

| 経路 | 現状 | 問題 |
|---|---|---|
| ⌘⇧W（`close-window`） | `menu.ts:90` が `removeWindow()` を直接呼ぶ | 終了 API を通らない |
| macOS ネイティブの赤い閉じるボタン | `registry.ts:768` の `baseWindow.on('close', () => this.destroy())` | 同上。`titleBarStyle: 'hiddenInset'` なので**必ず表示されている** |
| ⌘W（`close-tab`） | `menu.ts:86` が `removeTab()` を呼ぶ | mini はタブが1つなので、**空の mini ウィンドウが残る** |

**`BaseWindow` の `close` を終了 API の唯一の入口にする**（ネイティブボタンを隠すより、
どの経路でも同じ場所を通るほうが漏れない）:

- `baseWindow.on('close')` → 終了 API → `closedTabs` に積む → `destroy()`
- `removeWindow()` は `destroy()` → `baseWindow.close()` の順なので、**終了 API から
  再び `close` が飛ぶ**。**再入ガードを置く**（積むのは1回だけ）
- **`app-quit` 中は積まない**。`before-quit`（`index.ts:237`）で立てるフラグが**今は無い**ので足す
- mini の `close-tab`（⌘W）は `removeTab` ではなく**終了 API に向ける**（`canHostAdditionalTabs`
  が false のウィンドウは「タブを1つ閉じる」＝「ウィンドウを閉じる」と読み替える）

- **「一時ビューをユーザー操作で終了する」API を1本**用意し、`closedTabs` に積んでから
  ウィンドウを破棄する
- 終了理由（`user` / `app-quit` / `replaced`）を持たせ、**アプリ終了時は積まない**

セッション除外も `toSaved()` を空にするだけでは足りない。`collectSession()`（`registry.ts:1756`）が
**全非 private ウィンドウを `SavedWindow` に変換する**ので、空の通常ウィンドウとして復元される。
`collectSession` 側で `win.kind === 'normal'` に絞る。

#### R6. 未起動時は起動順そのものを変える必要がある

`index.ts:154` で通常ウィンドウを作り**終えてから** `index.ts:194` で外部 URL を流している。
`openExternalUrl` だけ直しても「未起動時は小窓だけ、通常ウィンドウは背面」にはならない。

- 起動時に **pending URL の有無を先に判定する**（`open-url.ts` に問い合わせ関数を足す）
- pending があるなら通常ウィンドウを **`show: false` で復元する起動モード**にする
  （`whenUiReady` は `did-finish-load` 依存なので非表示でも成立する）

#### R7. UI View と「直近の通常ウィンドウ」の配線が足りない

`peekChromeView` を足すなら `lockUiNavigation` だけでは動かない:

- `ownsUiContents()`（`registry.ts:974`）— ここに足さないと **✕・展開ボタンの IPC が拒否される**
- `pushState()` / `pushShared()` の送信先
- `destroy()` の View 破棄ループ（`chromeView` と `overlayView` しか見ていない）

「直近に使った通常ウィンドウ」の MRU は**今は存在しない**。`focusedOrFirstWindow()`
（`registry.ts:1107`）は **mini がフォーカス中なら mini を返す**ので昇格先に使えない。
通常ウィンドウの `focus` イベントだけを記録する MRU を足す。

**ただし MRU だけでは足りない。`mostRecentNormalWindow(partition)` にして解決順を決める**:

1. **同じ partition** の MRU 先頭
2. 同じ partition の既存の通常ウィンドウ（MRU に入っていないものも含む）
3. 新規ウィンドウ

2 が要る理由が2つある:

- **直近がシークレットウィンドウだと partition 違いで `moveTabToWindow` が拒否される**
  （外部 URL の mini は常に通常セッションなので、シークレットへは移せない）
- **コールドスタートで `show: false` 復元した通常ウィンドウは `focus` イベントが来ないので
  MRU に入らない**。1 だけだと空とみなして新規ウィンドウを作り、
  **背面に復元済みのウィンドウがあるのにもう1枚増える**

さらに **`moveTabToWindow` は現在 `void` で、拒否されても呼び出し側から分からない**
（`registry.ts:1363` で partition 違いを黙って return する）。
**成否を返すように変え、成功したときだけ mini を閉じる**。
失敗したまま mini を閉じるとページごと消える。

また **Peek の昇格で親子参照を外すだけでは「末尾」にならない**。Peek を開いた後に
背面タブが増えている場合があるので、昇格時に配列末尾へ移す。

#### R8. 入れ子の popup で opener を殺してはいけない

R1 で `createWindow` に変えても、**「新しい子を作って古いほうを閉じる」と結局 opener が死ぬ**。
古い WebContents こそが新しい子の `window.opener` なので:

- `window.opener.closed === true` になる
- `window.opener.postMessage(...)` が届かない
- **OAuth の結果を受け取れない**（一番踏みたくないやつ）

これは「Peek の中の popup」「mini の中の popup」の**2段目**で起きる。
1段目（通常タブ → Peek）は親タブが生きているので問題ない。

**解決 — どちらも「古いほうを生かしたまま、器を1つ増やす」**:

| どこで | 新規 browsing context 要求が来たら |
|---|---|
| Peek の中 | **その Peek を昇格させて通常タブにし**、新しい子を**その昇格したタブの Peek** にする |
| mini の中 | **もう1枚の mini** を開く（カスケード） |

Peek 側は「1ページにつき Peek 1枚」を保ったまま（昇格したタブは別ページなので Peek を持てる）、
opener が通常タブとして生き続ける。見た目も「覗いていたものがタブになり、その上に新しい
Peek が浮かぶ」で連続している。OAuth が `window.close()` したら Peek が消え、
ログインし終えたページがタブとして残る（Chrome と同じ）。

mini 側は上限4枚に当たるが、**自動終了はほかの生きたウィンドウの opener になっているものを飛ばす**
（opener を閉じたら同じ問題が起きる）。

そのため「Peek の中でそのまま遷移」は**同一 browsing context のリンククリックだけ**に限る。
これは `/dig` の決定の実質を保っている（ざっと見る体験は変わらない）。

**opener 関係は自前で持たない。** `webContents.opener`（`WebFrameMain | null`、
`electron.d.ts:18335`）と `WebContents.fromFrame()`（`electron.d.ts:15676`）で
**Electron に聞けば分かる**。`openerMini` / `openedChildren` のようなマップを自分で持つと
破棄時の解除漏れが必ず出るので持たない。opener の WebContents が死んでいれば
`fromFrame` が `undefined` を返す = もう守る相手がいない、で判定としても正しい。

#### R9. Peek を持つ親タブのウィンドウ移動が未定義

通常タブは Peek を持ったまま ⌘⇧N（新規ウィンドウへ移動）できてしまうが、
`moveTabToWindow`（`registry.ts:1358`）は**指定された1タブしか移さない**。このままだと:

- 親だけが移動先へ行き、**Peek は移動元の `win.tabs` に残る**
- `peekOf.window` と実際の所属ウィンドウが食い違う
- View と拡張の window 対応が分裂する

**親と Peek を1操作でまとめて移す**（拒否はしない。Peek は「タブに紐づく」と決めた以上、
ウィンドウ移動で切れるのは筋が通らない。タブ ID がウィンドウ移動をまたいで不変、という
`registry.ts:66-71` の設計とも揃う）。

- **`moveTabToWindow` の中で完結させる**。呼び出し側に「Peek も忘れずに」と書かせない
  （呼び出し口が複数あるので必ずどれかで漏れる）
- partition の検査は**先に1回**やり、通ったら親と Peek を続けて移す
- 拡張の window 対応は**両方の WebContents**で貼り替える（`transferringWebContents` も両方）
- 移動後に **source と target の両方**で `syncForegroundTab()` を通す

#### R10. mini の上限4枚と opener 保護は、5段ネストで両立しなくなる

R8 で「自動終了は生きた mini の opener を飛ばす」としたが、**popup が5段ネストすると
既存4枚すべてが次の mini の opener**になり、閉じられる候補が無くなる。

**opener 保護が勝つ。上限を一時的に超えることを許す**（上限の目的は「散らからない」で、
popup チェーンは散らかりではなく1つの流れ。opener を切って OAuth を壊すほうが重い）。

- 上限に当たっても、閉じられる候補が無ければ**そのまま開く**
- **子が閉じたときに改めて4枚まで trim する**（超過を放置しない）
- ログに `mini.cap_exceeded` を出す（気づけるようにする）

#### R11. 昇格しても Electron 内部の opener 関係は切れない → `outlivesOpener: true`

**Electron は既定で「opener が閉じたら child も閉じる」**（`electron.d.ts:19871`）。
昇格でアプリ側の `peekOf` を外して View を移しても、**Electron から見れば依然として
「opener が開いた child WebContents」のまま**。`moveTabToWindow` は WebContents を
作り直さないので、ウィンドウを移してもこの関係は残る。

そのまま作ると:

- Peek を ⌘O で通常タブへ昇格 → **元の親タブを閉じると、昇格済みのタブまで閉じられる**
- mini A が popup として mini B を開く → B を昇格 → **A を閉じる（上限 trim を含む）と B も消える**

R8 の「Peek を昇格させて子を昇格後タブの Peek にする」も同じ穴を踏む
（昇格したタブ自身が元の親タブの child なので、元の親を閉じると一式が消える）。

**`setWindowOpenHandler` の応答に `outlivesOpener: true` を付け、寿命は Nemo が持つ。**

```js
return { action: 'allow', outlivesOpener: true, createWindow: () => peek.webContents }
```

こうすると:

| 状況 | 結果 |
|---|---|
| Peek のまま親タブを閉じる | **Nemo が親子関係を見て明示的に Peek を閉じる**（Phase 3 の既存ステップ） |
| Peek を昇格したあと元の親タブを閉じる | 昇格済みタブは**残る**（アプリ側の親子は解除済み） |
| mini から昇格した通常タブ | 元 mini の終了に**巻き込まれない** |
| ウィンドウごと閉じる | `destroy()` が `win.tabs` を全部閉じるので Peek も閉じる |

**R10 の opener 保護とは向きが違うので混同しない**:

- **R10** = 子が `window.opener.postMessage` を撃つ先を生かす（**opener を勝手に閉じない**）
- **R11** = opener が閉じたときに子を道連れにしない（**子を勝手に閉じさせない**）

両方要る。そして `outlivesOpener` を付けた以上、**Peek / mini を閉じる責任は完全に Nemo 側**に
移る。閉じ忘れると見えない WebContents が残るので、**R5 の「一時ビュー終了 API」を
唯一の経路にする**ことがここでも効いてくる。

### 未確定（技術スパイクで先に潰す）

- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindow: true })` → 表示 → `false` に戻す、で
  「出した Space に固定」できるか
- macOS でアプリが非アクティブなとき、`win.focus()` だけでキーフォーカスが来るか。
  来ないなら `app.focus({ steal: true })` が要るが、それがメインウィンドウの Space への
  切り替えを誘発しないか

**この2つがこの計画の一番の技術的リスクなので、Peek / mini を作る前に最小の `BaseWindow`
だけで実測する**（Phase 0）。ここが崩れると B の価値がほぼ無くなるため、
実装を積み上げてから確かめるのは順序として危ない。

## 実装計画

### 事前準備 [人間👨‍💻]

- [x] 常用の Nemo（dev 版）を終了する。**検証系は Nemo が起動していると実行を拒否する**
- [x] ターミナルをフルスクリーンにした状態を用意しておく（Phase 0 / Phase 8 で使う）

### Phase 0: 技術スパイク — Space とフォーカス [AI🤖]

**Nemo 本体には手を入れない。** `scripts/spike-mini-window.mjs` として
最小の `BaseWindow` を出すだけの使い捨て Electron スクリプトを書き、実測する。

**Space の判定は人の目に頼らない。** `--role decoy` で**別プロセスの
フルスクリーンウィンドウ**（ユーザーのフルスクリーンのターミナル役）を先に立て、
各段階で `screencapture` を撮る。`screencapture` は今アクティブな Space しか撮れないので、
撮れた絵が「おとりのフルスクリーン」なら Space は動いていない、
「デスクトップ＋通常ウィンドウ」なら切り替わった、と機械的に判定できる。

- [x] フルスクリーンの Space の上にウィンドウを出せるか
      → **出せる**。しかも `setVisibleOnAllWorkspaces` は要らず、`type: 'panel'`（NSPanel）だけで出る
- [x] そのウィンドウ**だけ**にキーフォーカスを渡せるか
      → **`type: 'panel'` なら渡せる**（`win.focus()` + `view.webContents.focus()` で
      `document.hasFocus()` が true）。**通常ウィンドウでは渡せない**（`focus()` だけでは来ない）
- [x] 既存の通常ウィンドウが前面に出ないか
      → `show: false` → `showInactive()` なら **Space は動かない**。
      ただし **`app.focus({ steal: true })` を撃つと通常ウィンドウの Space へ切り替わる**（実測）
- [x] `setVisibleOnAllWorkspaces(false)` に戻したあと、どの Space に属するか
      → **元の Space には残らない**（通常ウィンドウの Space へ戻る）。
      NSPanel の場合は解除後もフルスクリーンの上に残るが、別 Space へ移ると**付いてくる**
- [x] `setVisibleOnAllWorkspaces` の副作用が Dock アイコンに出ないか
      → **出る**。`dockVisible` が false になる（process type の変換）。
      `skipTransformProcessType: true` で消えなくなるが、**panel なら呼ぶ必要自体が無い**
- [x] メニューのアクセラレータが小窓に届くか（**追加で測った**。アプリが前面に出ないなら
      メニューバーは前面のアプリのままで、⌘O / ⌘W が届かない恐れがある）
      → **届く**。⌘J を合成したら panel 側の `keydown` と `Menu` の `click` の両方が発火した

### Phase 0 の確認 [人間👨‍💻]

- [x] スパイクを実際に触って、結果を確定させる
      → **スクリーンショット判定に置き換えて AI 側で確定させた**（別プロセスのフルスクリーンを
      おとりに立てる方式）。実機のターミナルでの最終確認は Phase 8 に残す
- [x] Space 固定が無理なら「全 Space 追従」に倒す判断をする
      → **全 Space 追従に倒す**（ログ > 方針変更 に記載）

### Phase 1: 見た目を決める [AI🤖]

- [x] scratchpad に**単一 HTML のモック**を作り、`open` して見せる（返答に絶対パスを必ず明記する）
  - Peek: 暗幕の濃さ / 角丸 / 影 / ✕ と展開ボタンの形と位置（ページ領域右上）
  - 小窓: 上部バー（戻る・進む・リロード / URL / `⌘O メインウィンドウで開く` / ✕）の並びと高さ
  - 擬似データで「Peek が出る → ⌘O で消える」のアニメーションも見られるようにする
- [x] 決まった内容を **DESIGN.md** に節として追記する（`## オーバーレイ` の隣に `## Peek` と `## 小窓`）

### Phase 1 の確認 [人間👨‍💻]

- [x] モックを見て案を選ぶ / 直しを指示する

### Phase 2: データモデルと述語の整理 [AI🤖]

**先にここを通しておかないと、Peek を足した瞬間に既存機能が静かに壊れる。**

- [x] `NemoTab` に `peek: NemoTab | null` / `peekOf: NemoTab | null` を足す
- [x] `NemoWindow` に `kind: 'normal' | 'mini'` を足す（既定 `'normal'`）
- [x] `NemoWindow.normalTabs` ゲッターを足し、**R3 の表の10箇所**をそれに向ける
- [x] `tab-switcher.ts:139` の `attachInput` は **`win.tabs` のまま**にする（コメントで理由を残す）
- [x] `NemoWindow.visibleTabKeys` を足し、`selectTab` の `setVisible` 判定をそれに変える（R2）
- [x] `getVisibleTabKeys()` の JSDoc と `shared/types.ts:377` の契約を書き換える
- [x] `syncForegroundTab(win)` を足し、`selectTab` の末尾から呼ぶ（R2）。
      この時点では Peek が無いので挙動は変わらない
  - [x] **冪等にする**（最後に同期した WebContents id を覚える + 再入ガード）。
        ここを省くと拡張との無限再入が復活する
  - [x] ウィンドウ破棄時に覚えている id を捨てる
- [x] **`selectTab` に Peek の key が渡されたら親を選択したものとして扱う**分岐を入れる（R2）
- [x] `canHostAdditionalTabs(win)` を registry に足す（R4）。この時点では全ウィンドウ true
- [x] 通常ウィンドウの MRU を足す（`focus` イベントを記録。mini は記録しない）と、
      **`mostRecentNormalWindow(partition)`**（同 partition の MRU 先頭 → 同 partition の既存
      通常ウィンドウ → 新規 の3段）を公開する（R7）
- [x] **`moveTabToWindow` の戻り値を `boolean` に変える**（partition 違いで拒否したことを
      呼び出し側が知れるように。R7）。既存の呼び出し2箇所は戻り値を無視してよい
- [x] `TabState` に `peekParentKey: string | null` を、`WindowState` に `kind` を足す
- [x] `Sidebar.tsx:66` の一時タブ抽出から Peek を除外する
- [x] `mise run check` が通ること。**この時点で `mise run verify` が今までどおり通ること**
      （挙動を変えていないので、ここで落ちたら寄せ方を間違えている）

### Phase 3: Peek を作る [AI🤖]

- [x] `NemoTab.materialize()` に「View と WebContents だけ作り、読み込みは呼び出し側に任せる」
      経路を足す（`createWindow` callback から同期で使うため。R1）
- [x] `peekChromeView`（透明 UI View、`?view=peek`）を遅延生成する
  - [x] `lockUiNavigation` に許可を足す
  - [x] **`ownsUiContents()` に足す**（忘れるとボタンの IPC が拒否される。R7）
  - [x] `pushState()` / `pushShared()` の送信先に足す
  - [x] `destroy()` の View 破棄ループに足す
- [x] `renderer` に Peek 用のビューを足す（暗幕 + ✕ + 展開ボタン。ボタンは Peek 矩形の外側右上）
- [x] `layout()` に Peek の bounds 計算を足す（ページ領域の 90%強・中央）。`setBorderRadius` で角丸
- [x] z 順（親ページ → peekChromeView → Peek の View → overlayView）を `layout()` で毎回保証する
- [x] `setWindowOpenHandler` を **`action: 'allow'` + `createWindow`** に変える（R1）
  - `background-tab` → **今までどおり** `deny` + `createTab(background: true)`
  - それ以外（`foreground-tab` / `new-window` / サイズ指定つき popup）→ Peek の WebContents を返す
  - **通常タブから**の要求で既に Peek があるなら、返す前に古いほうを `closedTabs` に積んで閉じる
  - **Peek 自身からの要求なら、その Peek を先に昇格させ、新しい子を昇格後のタブの Peek にする**
    （R8。古いほうを閉じると opener が死ぬ）
  - **`outlivesOpener: true` を必ず付ける**（R11）。寿命は Nemo が持つ
  - **`options.webPreferences` は引き継がない**。R1 の理由をコードコメントに残す
- [x] `syncForegroundTab(win)` を Peek の開閉でも通す（R2。開いた瞬間に1回撃つだけにしない）
- [x] **`moveTabToWindow` が対象タブの Peek も一緒に運ぶ**ようにする（R9）
  - [x] partition の検査は先に1回。拡張の window 対応は両方の WebContents で貼り替える
  - [x] 移動後に source / target の**両方**で `syncForegroundTab()` を通す
- [x] 親タブを閉じたら Peek も閉じる。Peek を持つ親は sleep / archive の対象外にする
- [x] タブ切り替えで Peek を `setVisible` で出し入れする（破棄しない）
- [x] `window.close()` で Peek が閉じること（`wc.on('destroyed')` で親子を解く）
- [x] `close-tab`（⌘W）と Esc を Peek が開いている間は Peek に向ける
- [x] 閉じた Peek を `closedTabs` に積む（⌘⇧T では**普通のタブとして**戻す）
- [x] `mise run check` が通ること

### Phase 4: 小窓（mini window）を作る [AI🤖]

- [x] `createWindow` に `kind: 'mini'` を通す。`BaseWindow` 生成を分岐
      （固定サイズ・`minWidth/minHeight` を小さく・`titleBarStyle: 'hiddenInset'`）
- [x] `chromeView` を上部に水平配置する（`?view=mini`、高さは Phase 1 で決めた値）
- [x] `renderer` に小窓のツールバーを足す（戻る / 進む / リロード / URL 表示 / ⌘O / ✕）
      - URL クリックでコピー。**⌘L は無効**（アドレスバーを持たない）
- [x] `canHostAdditionalTabs` を mini で false にし、**全経路をそこへ寄せる**（R4）
  - [x] `menu.ts`（`command-bar` / ⌘1〜9 / 次前のタブ / `move-tab-to-new-window` / `toggle-sidebar`）
  - [x] `ipc.ts` の `nemo:create-tab`
  - [x] `extensions.ts:336` の `chrome.tabs.create` → 通常ウィンドウの MRU 先頭へ回す
  - [x] `reopenClosedTab`（⌘⇧T）→ 同上
  - [x] mini 内の popup → **もう1枚の mini を開く**（R8。差し替えると opener が死ぬ）。
        ここでも `outlivesOpener: true`（R11）
- [x] **一時ビュー終了 API** を用意し、**`BaseWindow` の `close` を唯一の入口にする**（R5）
  - [x] `registry.ts:768` の `baseWindow.on('close', () => this.destroy())` を終了 API 経由にする
  - [x] `menu.ts:90` の `close-window`（⌘⇧W）も同じ経路に乗る（`removeWindow` 側で吸収する）
  - [x] mini の `close-tab`（⌘W）は `removeTab` ではなく終了 API へ向ける
        （`canHostAdditionalTabs` が false のウィンドウでは「タブを閉じる」＝「ウィンドウを閉じる」）
  - [x] **再入ガード**を置く（`removeWindow` は `destroy()` → `baseWindow.close()` の順なので
        終了 API から `close` が撃ち返される。積むのは1回だけ）
  - [x] **`app-quit` 中は積まない**。`index.ts:237` の `before-quit` で立てるフラグを足す
        （今は無い）
- [x] **`collectSession()` を `win.kind === 'normal'` に絞る**（R5。`toSaved()` だけでは不十分）
- [x] 上限4枚。超えたら最古の小窓を（終了 API 経由で）閉じる
  - [x] **生きた mini の opener になっているものは飛ばす**（R8）。
        判定は `webContents.opener` + `WebContents.fromFrame()` で Electron に聞く（自前のマップは持たない）
  - [x] 閉じられる候補が無ければ**上限を超えて開く**。`mini.cap_exceeded` をログに出す（R10）
  - [x] **子が閉じたときに改めて4枚まで trim する**（超過を放置しない）
- [x] 2枚目以降は位置をずらす（カスケード）
- [x] `mise run check` が通ること

### Phase 5: 外部 URL の経路を差し替える [AI🤖]

- [x] `open-url.ts` に「pending URL があるか」を返す関数を足す（R6）
- [x] `index.ts` の起動シーケンスを組み替える
  - pending があるなら、通常ウィンドウを **`show: false` で復元**する
  - 復元し終える前に小窓を出せるようにする（順序の入れ替え）
- [x] `openExternalUrl` を `createWindow(url, { kind: 'mini' })` に変え、
      **`app.focus({ steal: true })` をやめる**（Phase 0 で「Space ごと持っていかれる」と確定）
- [x] Phase 0 で確定した形にする: mini の `BaseWindow` を **`type: 'panel'`** で作り、
      `showInactive()` → `win.focus()` → `view.webContents.focus()` の順で出す。
      **`setVisibleOnAllWorkspaces` は呼ばない**（Dock アイコンが消えるうえ、panel には不要）
- [x] `mise run check` が通ること

### Phase 6: 昇格（⌘O） [AI🤖]

- [x] `COMMANDS` に `promote-peek`（`CmdOrCtrl+O`、ラベル「メインウィンドウで開く」）を足す
- [x] Peek のとき: 親子を解き、**`win.tabs` の末尾へ移してから** `selectTab`（R7）
- [x] 小窓のとき: `mostRecentNormalWindow(win.partition)` へ `moveTabToWindow` し、
      **成功したときだけ**小窓を閉じてそのウィンドウを前面に出す（R7）
- [x] シークレットウィンドウからの Peek がシークレットセッションを継承すること
      （`moveTabToWindow` は partition 違いを拒否するので、昇格先も同じセッションに限る）
- [x] `mise run check` が通ること

### Phase 7: 自走検証を足す [AI🤖]

- [x] `test-pages` に検証用ページを足す
  - [x] `<form method="POST" target="_blank">` を投げるページと、body を echo するハンドラ
  - [x] `window.opener.postMessage` で親に返すページ
  - [x] `window.close()` を呼ぶページ
- [x] `scripts/verify-peek.mjs` を足し、`verify-all.mjs` に組み込む
  - **R1**: POST の body が Peek 側に届くこと / `window.opener.postMessage` が親に届くこと /
    `window.close()` で Peek が閉じること
  - **R8（2段目の opener）**: **Peek → 子 popup → `window.opener.postMessage` が届く**こと。
    このとき元の Peek が通常タブに昇格していること
  - **R8（mini の2段目）**: **mini → 子 popup → `window.opener.postMessage` が届く**こと。
    2枚目の mini ができ、1枚目が生きていること
  - **R8（上限の巻き添え）**: mini を5枚開いても、生きた mini の opener は自動終了で閉じないこと
  - **R10（5段チェーン）**: **独立した5枚ではなく popup を5段ネストさせて**実測枚数を出す。
    5枚残る（＝上限を超えている）こと / 末端を閉じたら4枚まで trim されること
  - **R11（道連れ）**: Peek を昇格 → **元の親タブを閉じる** → 昇格済みタブが
    **同じ WebContents id のまま残る**こと
  - **R11（mini の道連れ）**: mini B を昇格 → **opener の mini A を閉じる** → 昇格済みタブが残ること。
    上限 trim で A が閉じられた場合も同じであること
  - **R11（未昇格は従来どおり）**: 昇格していない Peek は、親タブを閉じたら**閉じる**こと
    （`outlivesOpener` を付けたぶん Nemo 側で閉じ切れているか。閉じ漏れると見えない
    WebContents が残るので、閉じたあとに生存している WebContents 数も数える）
  - **R9**: **Peek を持つ親タブを別ウィンドウへ移動**して、Peek が付いてくること。
    移動後に `chrome.tabs` の windowId が**両方とも**新しいウィンドウを指すこと。
    移動後も `chrome.tabs.query({ active: true })` が Peek を返すこと
  - **R2**: `chrome.tabs.query({ active: true })` が **Peek を返す**こと。
    Peek を閉じたら親を返すこと。`getVisibleTabKeys()` が2つ返すこと
  - **R2（再計算）**: 別タブへ切り替えて**戻ったあとも** `chrome.tabs.query({ active: true })` が
    Peek を返すこと（1回撃つだけの実装だとここで落ちる）
  - **R2（再入）**: 上の切り替えを繰り返しても**処理が完了し、main の例外ログが出ず、
    `extensions.selectTab` の呼び出し回数が有限**であること
    （冪等化を忘れると無限再入する。結果だけ見ていると気づけない）
  - `target=_blank` が Peek になること / `background-tab` は背面タブのままであること
  - Peek が親タブと**別に** `chrome.tabs` に載っていること
  - サイドバーの一覧に Peek が出ないこと（親が1つだけ）
  - タブを切り替えて戻ると Peek が復帰すること
  - ⌘O で通常タブになり、**WebContents の id が変わらない**こと（= 読み直していない）
  - **昇格後に `win.tabs` の末尾にいる**こと（Peek 後に背面タブを足したケースで確認）
  - 親タブを閉じると Peek も閉じること
  - Peek を持つ親タブが `tabSleepMinutes` を過ぎても寝ないこと
  - **⌃M（タブスイッチャー）が Peek にフォーカスがある状態でも確定できること**（R3）
  - mini: 外部 URL 相当で1枚できること / 上限4枚で最古が閉じること /
    **`collectSession()` に含まれないこと** / ✕ で閉じた後 ⌘⇧T で戻せること /
    **mini 自身が `window.close()` したときも ⌘⇧T で戻せること**（✕ と同じ経路を通っているか）/
    **mini で ⌘⇧W → 通常ウィンドウで ⌘⇧T で戻せること**（`close-window` が終了 API を迂回していないか）/
    **mini で ⌘W したらウィンドウごと閉じ、空の mini が残らないこと** /
    **アプリ終了で閉じた mini は `closedTabs` に積まれないこと** /
    mini で `chrome.tabs.create` を撃つと**通常ウィンドウ側に**タブができること /
    ⌘O でメインウィンドウに移ること
  - **昇格先の解決（R7）**: 通常ウィンドウ2枚で直近に使ったほうへ行くこと /
    **直近がシークレットウィンドウでも通常ウィンドウへ行く**こと（partition 違いで拒否されない）/
    **コールドスタートで `show: false` 復元した通常ウィンドウがある場合、新規を作らず
    そこへ行く**こと（MRU が空でも 2 段目のフォールバックが効いているか）/
    移動が拒否されたときに mini を閉じない（ページを消さない）こと
- [x] `mise run verify` を通す
- [x] `mise run verify:ext` を通す（拡張のタブモデルを触るため）
- [x] `VERIFY.md` に「Peek / 小窓」の節と、「触ったもの → 回すもの」表の行を足す

### Phase 8: 実機で確かめる [人間👨‍💻]

**自走検証では原理的に確認できないもの**（Space・フォーカス・フルスクリーン・実 Vault）だけ。

- [ ] ターミナルをフルスクリーンにして、出力された URL をクリックする
  - [ ] **Space が切り替わらない**こと
  - [ ] 小窓がターミナルの上に出ること
  - [ ] 小窓にキーボードフォーカスが来ていること（スクロール・⌘W が効く）
  - [ ] Nemo のメインウィンドウが前面に出ていないこと
- [ ] 小窓を出したまま別の Space に移り、Phase 0 で決めたとおりの追従になっていること
- [ ] 続けてもう1本 URL を踏み、2枚目が少しずれて出ること。5本目で最古が閉じること
- [ ] 小窓で ⌘O を押し、メインウィンドウが前面に出て（Space も切り替わって）タブになること
- [ ] Nemo を終了した状態から URL を踏み、**小窓だけ**が出ること（メインは背面で復元）
- [ ] 実 Vault の Bitwarden（`mise run dev:nodebug`）で、**Peek のログイン画面**と小窓で
      自動入力が効くこと（= chrome の active が Peek を指せていること）
- [ ] 実際の OAuth ポップアップ（`window.open` にサイズ指定があるもの）が Peek で開き、
      認証後に `window.close()` で閉じて親に結果が返ること

### Phase 9: 仕上げ [AI🤖]

- [x] `CHANGELOG.md` の `[Unreleased]` に書く
- [x] `mise run check` → `mise run verify` を通してコミット

## ログ

### 試したこと・わかったこと

- 2026-08-25 Phase 0: **ESM を Electron の main エントリにしたまま top-level await を書くと
  `app.whenReady()` が永久に解決しない**（Electron 41 で実測。ログが1行も出ないまま固まる）。
  スパイクは `void runInElectron()` と await せずに呼ぶ形にした。
- 2026-08-25 Phase 0: **Space の検証は `screencapture` で機械判定できる**。
  今アクティブな Space しか撮れない性質を逆手に取り、別プロセスでフルスクリーンの
  「おとり」を立ててから撮る。人の目に頼らずに「Space が切り替わったか」を出せる。
- 2026-08-25 Phase 0 の実測値:

  | やったこと | 結果 |
  |---|---|
  | 通常ウィンドウを `show:false` → `showInactive()` | Space は**動かない** |
  | 通常の `BaseWindow` を `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` で表示 | フルスクリーンの上に**出る**が、`focus()` では**キーフォーカスが来ない** |
  | 同上 + `app.focus({ steal: true })` | キーフォーカスは来るが **Space が通常ウィンドウ側へ切り替わる**（致命的） |
  | `type:'panel'` + `showInactive()` + `focus()` + `webContents.focus()` | フルスクリーンの上に出て、**キーフォーカスも来て、Space は動かない** ✅ |
  | `setVisibleOnAllWorkspaces(true)` の副作用 | **Dock アイコンが消える**。`skipTransformProcessType:true` で回避可 |
  | panel を別 Space へ移って見る | **付いてくる**（全 Space 追従。固定はできない） |
  | panel にフォーカスがある状態で ⌘J を合成 | **メニューのアクセラレータが発火する**（⌘O / ⌘W が使える） |

### 方針変更

- 2026-08-25 Phase 0: **小窓は `type: 'panel'`（NSPanel）で作り、`setVisibleOnAllWorkspaces` は
  使わない**ことに決めた。当初の案（通常ウィンドウ + 全 Space 指定 + `app.focus({steal:true})`）は
  **キーフォーカスを取ろうとした瞬間に Space が切り替わる**ので、この計画の目的
  （フォーカスを奪わない）を根本から壊す。panel なら「アプリを前面に出さずにキーを受け取る」
  （nonactivating panel）が成立し、メニューのアクセラレータも届くことを実測で確認した。
- 2026-08-25 Phase 0: **「出した Space に固定」は諦めて「全 Space 追従」に倒す**。
  panel は解除しても別 Space へ付いてくる（実測）。計画で用意していた代替案のとおり。
- 2026-08-25: 初稿へのレビューで7点の欠陥（R1〜R7）が出たため、着手前に全面改訂した。
  特に **R1（`deny` + URL 作り直しでは POST / opener / `window.close()` が壊れる）** と
  **R2（`selectTab` が Peek を隠すので active を2状態に分ける必要がある）** は、
  そのまま作っていたら「動くように見えて OAuth と Bitwarden が壊れる」ところだった。
- 2026-08-25: Space / フォーカスの実測を Phase 5 から **Phase 0 の技術スパイク**へ前倒しした。
  この計画の価値の大半が「フォーカスを奪わない」に乗っているため、
  実装を積んでから確かめるのは順序として危ないと判断した。
- 2026-08-25: 「Peek の中の `target=_blank` はそのまま遷移（⌘[ で戻れる）」という
  `/dig` での決定を微修正した。同一 browsing context のリンククリックは今までどおり遷移するが、
  **新しい browsing context の要求は Peek を昇格させ、子を昇格後のタブの Peek にする**（R8）。
- 2026-08-25: 2巡目のレビューでさらに4点。うち3点（R8 の opener 問題 / R2 の chrome active を
  毎回再計算 / R7 の昇格先に partition と hidden ウィンドウのフォールバック）を反映した。
  **一度は「古い WebContents を閉じて差し替える」と書いていたが、それこそが子の
  `window.opener` なので OAuth の戻りが受け取れなくなる**。器を1つ増やす形に改めた。
- 2026-08-25: 5巡目のレビューで、終了 API の迂回経路（⌘⇧W の `close-window` と
  macOS ネイティブの閉じるボタン）を塞いだ。**`BaseWindow` の `close` を唯一の入口にする**
  形に変え、再入ガードと `app-quit` フラグ（`before-quit` に今は無いので足す）を明記した。
  併せて mini の ⌘W が空ウィンドウを残す穴も塞いだ。冒頭の仕様表の「上限4枚」を
  R10 のソフト上限（原則4枚・opener チェーン保護中だけ一時超過）に揃えた。
- 2026-08-25: 4巡目のレビューで **R11**（`outlivesOpener`）。Electron は既定で
  「opener が閉じたら child も閉じる」ため、**昇格しても Electron 内部の親子は切れておらず、
  元の親タブ / 元の mini を閉じると昇格済みのタブまで消える**。`outlivesOpener: true` を付けて
  寿命を Nemo 側に全部引き取る。R10（opener を閉じない）とは**向きが逆の保護**なので両方要る。
- 2026-08-25: 3巡目のレビューで3点。すべて反映した（R9: Peek 付き親タブのウィンドウ移動を
  `moveTabToWindow` の中で原子的に扱う / R10: opener チェーンが5段になったら mini の上限を
  一時的に超えることを許し、子が閉じたら trim する / R2 に `syncForegroundTab` の冪等化）。
  **opener 関係は自前のマップを持たず `webContents.opener` + `WebContents.fromFrame()` で
  Electron に聞く**ことにした（破棄時の解除漏れが構造的に起きない）。
- 2026-08-25: レビューの「`createWindow` の `options.webPreferences` を引き継いだ上で
  セキュリティ項目を上書きせよ」は**見送った**。Electron が緩められないと保証しているのは
  feature string 由来の7項目だけで、`webviewTag` / `experimentalFeatures` /
  `allowRunningInsecureContent` は含まれない。ページが制御できる値を spread して
  個別に潰すのはブラックリストになり、`security.ts` の既存方針とも揃わないため、
  `materialize()` と同じ設定を自前で組む形を維持する（理由はコードコメントに残す）。
