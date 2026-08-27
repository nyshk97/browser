# タブを左右に並べる（分割ビュー・2ペイン）

## 概要・やりたいこと

一時タブ 2 本を左右に並べて同時に見られるようにする。Arc の Split View に寄せる。

- サイドバーのタブ行を別のタブ行へドラッグ & ドロップすると分割になる
- 分割中はペインごとにツールバー（アドレスバー・戻る / 進む・リロード・✕）が付く
- サイドバーでは 2 本が **1 行に 2 チップの結合行**になる（Arc と同じ）
- 結合行のチップを右クリック →「分割を解除」で 2 行に戻る（**左だったタブが上・右だったタブが下**）
- 3 つ以上並べる機能は作らない

## 前提・わかっていること

### `/dig` で決めたこと

| 論点                     | 決定                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| 対象                     | **野良の一時タブ同士だけ**。ピン留め・Favorites・Live Folder の行は対象外                   |
| 作る導線                 | **D&D だけ**。サイドバーのタブ行を別のタブ行の**中央帯**へドロップ                          |
| 左右                     | **ドロップ先が左・ドラッグしてきたタブが右**                                                |
| 作った直後               | すぐ分割を表示し、**右（持ってきたタブ）にフォーカス**                                      |
| 3 つ目のドロップ         | **受け付けない**（先に解除させる）                                                          |
| サイドバー表現           | **Arc 流の結合行**（1 行に 2 チップ）。左タブがいた位置に出る                                |
| 結合行のスタイル         | **案A**（器の中に小面 2 つ・40px のまま）                                                   |
| ツールバー               | **ペインごとに 1 本**                                                                       |
| フォーカスの見せ方       | ペインの外周に **2px `--nemo-accent`**。結合行のフォーカス側チップは面を明るく + 左 2px バー |
| ペインの縁               | **分割中だけ**角丸 + 隔間（隔間 8 / 外周余白 8 / 角丸 10）。単独表示は今までどおりベタ塗り  |
| 角丸が作れないとき     | **角丸を捨てて隔間だけ**にする（`SPLIT_RADIUS = 0`）。継ぎ目にえぐれを出してまで角丸を取らない |
| 分割中のタブが PR になったら | **結合行を優先**し、Live Folder の除外から外す（分割は勝手に解けない）              |
| ペインの ✕・チップの ×   | そのペインのタブを閉じ、残った方が全画面                                                     |
| ⌘W                       | **Peek が出ていれば Peek**（既存の規則を残す）。出ていなければフォーカス中ペインのタブ       |
| ⌘D・チップをピン留めへ D&D | **分割を解除してから**ピン留め                                                            |
| 別タブを選んだとき       | 分割は保たれ、両ペインとも隠れる。戻ると復帰（＝ 1 ウィンドウに分割ペアが複数ありうる）      |
| セッション復元           | **する**（`SESSION_VERSION` を 4 へ）                                                       |
| ⌘1〜9 / ⌃Tab / ⌃M       | **2 つのタブのまま数える**（ペイン間のフォーカス移動にも使える）                             |
| 狭いウィンドウ           | 何もしない（そのまま半分に割る）                                                            |
| Peek                     | そのペインの中に収める                                                                      |
| Peek で覗いた PR の未読  | **既読にする**（見えているものは既読、で統一。`visibleTabKeys` 基準の副作用をそのまま採る）  |

見た目の確定に使ったモック: `<scratchpad>/split-mock.html`（案A + 隔間 8 / 余白 8 / 角丸 10 で確定）

### コードベースの現状

- レイアウトは `NemoWindow.layout()`（`src/main/registry.ts:1202`）1 か所。ページ領域を 1 枚の矩形として
  **全タブに bounds を配り**、`setVisible` で出し入れする
- 「見えるタブ」は `NemoWindow.visibleTabKeys`（`registry.ts:1362`）の **1 つの述語**に閉じている。
  今は「選択中の通常タブ + あればその Peek」。ただし**この述語を実際の View に反映しているのは
  `selectTab` の中だけ**（`materialize` / `setVisible` / `lastActiveAt` がそこに直書きされている）。
  `layout()` は bounds を配るだけで可視状態を触らない
- `removeTab`（`registry.ts:2099`）はアクティブタブを閉じたとき **`normalTabs[Math.min(index, len-1)]`**
  を次に選ぶ。ペアの右を閉じると、左ではなく**ペアの後ろにいたタブ**が選ばれる
- ⌘W（`menu.ts:117`）は **Peek が出ていれば Peek を閉じる**（親タブは消さない）。この規則は残す
- HTML5 の D&D は `dragover` の時点で `DataTransfer.getData()` が読めない。既存コードは
  `types.includes(TAB_DRAG_TYPE)` で「タブを掴んでいるか」だけを見て、key は `drop` で読んでいる
- ツールバーはウィンドウ生成時に 1 枚だけ作る（`registry.ts:1029`、`?view=toolbar`）。
  `Toolbar.tsx` は `state.activeTabKey` からタブを引いている
- `NemoTab`（`registry.ts:416`）は `peek` / `peekOf` で親子を持つ。**親子を解くのは `removeTab` の 1 か所**
  （`registry.ts:2001` のコメント）。分割の解除も同じ場所へ寄せる
- 一時タブ行（`TabRow.tsx`）には**ドロップの受け口が無い**（`draggable` で掴めるだけ）。
  ピン留めツリー・Favorites グリッド側だけが `TAB_DRAG_TYPE` を受けている
- 右クリックメニューは DOM 実装の `RowMenu`（`RowMenu.tsx`）。**ページ上の右クリックメニューは存在しない**
- `sweepSleep` / `sweepArchive`（`registry.ts:2719` / `2760`）はどちらも
  `tab.key === win.activeTabKey` だけを除外している。**分割の相方は見えているのに寝る / 消える**
- `toSaved()`（`registry.ts:1473`）は一時タブだけを順に保存し、`activeIndex` を同じ配列から出している
- 自走検証は CDP 経由（`scripts/verify-*.mjs` + `scripts/lib/cdp.mjs` の `connectUi`）。
  `verify-all.mjs` の `ONLY` 一覧と `NEEDS_APP` に名前を足すと `mise run verify:only <名前>` で回せる

### 実装前に潰す技術的な未確認事項

1. **角丸ペインの継ぎ目**。`View.setBorderRadius(radius)` は四隅一律で、per-corner の API が無い。
   ツールバー View とページ View を別々に丸めると継ぎ目に不自然なくびれが出る。
   **子 View が親の角丸でクリップされるか**を先に確かめる（クリップされるなら器 View を丸めるだけで済む）。
   **今のページ View は全部 `BaseWindow.contentView` の直下**で、`sleep` / `removeTab` / `moveTabToWindow` も
   その前提で書かれている。器を挟むなら付け替えの手順まで決めないと壊れる
2. **ドロップの当たり判定**。行の中央帯だけを分割にする判定が、既存のピン留めツリー・Favorites への
   ドロップと取り合いにならないか（サイドバーは 1 枚の View なので `dragover` / `drop` は伝播する）
3. **ペインのフォーカス検出**。ページをクリックしたときに `webContents` の `focus` イベントが飛ぶか

## 実装計画

### Phase 0: スパイク（3 つの未確認事項を潰す） [AI🤖]

- [x] **合成後のウィンドウを撮る手段を先に用意する**。`Page.captureScreenshot` は
      **その WebContents 自身しか撮らない**ので、親 View のクリップも背後のフォーカス枠も写らず、
      角丸と枠の判定が偽陰性になる。`BaseWindow.getMediaSourceId()` から CGWindowID を取り出して
      `screencapture -l <id> -x` で撮る小さなヘルパを `scripts/lib/` に置く。
      スパイクは main を自分で持っているので直接呼べる。**Phase 7 では同じヘルパを、
      Phase 5 の診断 IPC 越しに取った media source ID と組み合わせて使う**
      （検証スクリプトからは main の API を直接呼べない）
- [x] `scripts/spike-split-chrome.mjs` を作る（`spike-mini-window.mjs` に倣う。**使い捨てではなくコミットする**）。
      BaseWindow に「器 `View`（`setBorderRadius(10)` + 背景色）」を作り、その子として
      `WebContentsView`（ページ）を器いっぱいに置く。上のヘルパで撮って
      **子が親の角丸でクリップされるか**を目視で確かめる（PNG を Read して判定し、絶対パスを報告に出す）
  - クリップされる → 器 View を 1 枚丸めるだけで済む。ページ・ツールバーには `setBorderRadius` を掛けない
  - クリップされない → **角丸は諦めて隔間だけにする**（`SPLIT_RADIUS = 0`）。
    ページ View だけを丸めるとツールバーとの継ぎ目に 10px のえぐれが出るので、
    その見た目を取るくらいなら角丸を捨てる、という決定（人間が判断済み）。
    ツールバーの透明化も不要になる
- [x] 同じスパイクで、フォーカス枠を「ページより上下左右 2px 大きい `View`（背景 `--nemo-accent`・
      `setBorderRadius`）を後ろに敷く」方式で描き、枠が意図どおり 2px で出ることを撮って確かめる
- [x] 同じスパイクで、ページの WebContents に `Input.dispatchMouseEvent` でクリックを撃ち、
      `webContents.on('focus')` が飛ぶことをログで確かめる。**飛ばない場合**は代替
      （`before-input-event` / ページ側の `blur`・`focus` を main で拾う）をここで決め、ログに残す。
      **ここで決めたイベントを Phase 1 の配線ステップで実際に繋ぐ**（調べただけで終わらせない）
- [x] `pnpm verify:spike` と同じ要領で単独実行できるようにする（**`.mise.toml` に `verify:spike` は無く、
      実在するのは package.json の scripts のほう**。同じ場所に `spike:split` を足す）。
      結果（3 つの判定）をログセクションに追記する。
      **クリップの可否がそのまま `SPLIT_RADIUS` の値になる**（効けば 10・効かなければ 0）。
      判断は済んでいるので、スパイクの結果が出たらそのまま Phase 2 へ進んでよい

### Phase 1: 分割のモデルと述語（main） [AI🤖]

- [x] `src/main/registry.ts` に分割の実体を足す。**左右を別フィールドで持たない**
      （2 つのフィールドが食い違う余地を作らない）:

  ```ts
  /** 左右に並べた 2 本。**両方のタブが同じインスタンスを指す**（side は導出する）。 */
  class SplitPair {
    constructor(
      readonly left: NemoTab,
      readonly right: NemoTab
    ) {}
    sideOf(tab: NemoTab): 'left' | 'right' | null {
      return tab === this.left ? 'left' : tab === this.right ? 'right' : null
    }
    partnerOf(tab: NemoTab): NemoTab | null {
      return tab === this.left ? this.right : tab === this.right ? this.left : null
    }
  }
  ```

  `NemoTab` に `split: SplitPair | null = null` を追加する
- [x] `NemoWindow.visibleTabKeys`（`registry.ts:1362`）を**唯一の述語**として拡張する。
      「選択中タブ + **その分割の相方** + フォーカス中タブの Peek」。
      **相方の Peek は出さない**（Peek の暗幕はウィンドウに 1 枚しかないので、
      フォーカスを移したときに出る）。JSDoc にこの規則を書く。
      **最大は 2 件から 3 件に増える**（分割の 2 本 + フォーカス中タブの Peek）。
      `NemoWindow` 側だけでなく **`NemoUiApi.getVisibleTabKeys()` と `TabState.visible` の JSDoc**
      （「最大2つ」と書いてある）も直し、2 件上限を前提にしている呼び出しが無いか
      `git grep` で洗い出す
- [x] **述語を View に反映する処理を `NemoWindow.applyVisibility()` に切り出す**。今は `selectTab` の中に
      直書きされていて、`selectTab` を通らない経路（分割の生成・解除・`removeTab` の Peek だけ閉じる経路）で
      可視状態が更新されない。1 つのメソッドがやること:
  - `visibleTabKeys` に入っていて **`asleep` のタブを materialize する**（相方が寝ていると
    左ペインが真っ白になる。復元直後・sleep 明けで必ず踏む）
  - 全タブに `setVisible(visibleTabKeys.has(key))`
  - **`lastActiveAt` はフォーカス中のタブだけ更新する**。両方に同じ値を書くと
    `⌃M` の MRU 順（`lastActiveAt` の降順）で左右が同着になり、
    「右ペインから別タブへ行って ⌃M」で**左に戻ってしまう**。
    相方が archive sweep で落ちる問題は、下の sweep 側で**ペアの新しい方の時刻を使う**ことで塞ぐ
  - **見えているタブ全部の未読を落とす**（`unread = false` と `markLiveFolderRead(url)`)。
    今はどちらも `activeTabKey` 起点なので、**見えているのに未読ドットが付いたままの相方**ができる
  - `selectTab` は「`activeTabKey` を決める → `applyVisibility()` → `layout()`」に組み替える
- [x] 未読を**付ける**側も可視性基準に直す。読み込み完了時の未読判定（`win().activeTabKey !== tab.key`）と
      Live Folder の `activeUrls`（`getActiveTab()` の URL だけを返している）を
      **`visibleTabKeys` 基準**に置き換える。片方だけ直すと、落としたそばから付け直される
- [x] `splitTabs(win, leftKey, rightKey)` を追加:
  - 受け付けない条件で早期 return し、それぞれ `log('split.rejected', { reason })` を出す
    （同じタブ / 別ウィンドウ / 一方が Peek / 一方が `pinnedId` か `favoriteId` を持つ /
    **一方の URL がいま Live Folder の一覧に載っている** / どちらかが既に `split` を持つ /
    ウィンドウが `mini`）。renderer 側でも受け皿を出さないが、**IPC を直接叩かれても通さない**
    （`liveFolderOpen` が「いま一覧に載っている URL か」を main で照合しているのと同じ作法）
  - **右のタブを `win.tabs` の中で左の直後へ移す**。これで `⌘1〜9` / `⌃Tab` / セッション保存の
    並びが、サイドバーの見た目（左が上・右が下）と自動的に一致する。解除時に並べ替え処理が要らなくなる
  - **関係の構築（`SplitPair` の生成・代入・並べ替え）は内部関数に切り出す**。セッション復元は
    そこだけを使う（選択も materialize もしない。Phase 6 参照）
  - `splitTabs` はその内部関数のあと `selectTab(win, rightKey)`（**右にフォーカス**。
    `applyVisibility()` が両方を materialize して見せる）→ `win.pushState()` → `log('split.created', …)`
- [x] `separateSplit(win, key)` を追加。ペアを両タブから外し、**`applyVisibility()`** →
      `win.layout()` / `pushState()` / `log`。可視の再適用を省くと、**解除前に見えていた 2 枚が
      同じ全画面 bounds のまま重なって残る**。**タブの並びは触らない**（既に左→右の順に並んでいる）
- [x] `removeTab`（`registry.ts:2099`）の中、Peek の親子を解いている**すぐ隣**でペアも解く。
      「解くのはここ 1 か所」の規則を分割にも適用し、コメントでそう書く
- [x] 同じ `removeTab` の「次に選ぶタブ」を直す。今は `normalTabs[Math.min(index, len-1)]` なので、
      **ペアの右を閉じるとペアの後ろにいたタブが選ばれ、左ではない別のタブが全画面になる**。
      ペアを解く**前に相方を控えておき**、閉じたのが分割中のアクティブタブなら相方を明示的に選ぶ。
      控えが無いときだけ従来の規則に落ちる
- [x] ページのクリックでフォーカスが移るよう配線する。Phase 0 で確定したイベント
      （既定は `webContents.on('focus')`）をタブのイベント登録箇所に足し、
      **そのタブが「いま見えている分割の相方」なら `selectTab` する**。
      見えていないタブからのイベントは無視する（背面タブのフォーカスで勝手に切り替わらないように）
- [x] `moveTabToWindow`（ウィンドウ間の移動）でも先にペアを解く。
      **解く前に相方を控え、移動が済んだら元のウィンドウでその相方を選ぶ**
      （`removeTab` と同じ罠。控えないと、右ペインを移したときに元ウィンドウで
      ペアの後ろにいた無関係なタブが全画面になる）
- [x] 専用枠へ移す 3 経路（main 側の実体は **`togglePin`**（⌘D / 右クリック）・
      **`pinTabInto`**（ピン留めツリーへの D&D）・**`addFavoriteFromTab`**（Favorites への D&D））で、
      対象タブに `split` があれば**先に `separateSplit` を呼ぶ**。
      `unpin` や Favorite 化からの降格は分割と無関係なので触らない
- [x] `sweepSleep` / `sweepArchive` の除外条件を、`tab.key === win.activeTabKey` から
      **`win.visibleTabKeys.has(tab.key)`** に置き換える（相方が見えているのに寝る / 消えるのを塞ぐ）。
      両方のコメントを「見えているタブは触らない」に直す。
      加えて、**分割に入っているタブの寿命はペア単位で見る**（自分と相方の `lastActiveAt` の
      新しい方を使う）。片方だけ古くて先に閉じられ、見ていない間にペアが解けるのを防ぐ。
      **タブごとの `lastActiveAt` そのものは書き換えない**（`⌃M` の MRU 順が壊れるため）
- [x] `src/shared/types.ts` の `TabState` に 2 フィールド追加:

  ```ts
  /** 分割の相方のタブ key。分割していなければ null。 */
  splitPartnerKey: string | null
  /** 分割の中での位置。分割していなければ null。**結合行を出す側（left）を決めるのに使う**。 */
  splitSide: 'left' | 'right' | null
  ```

  `NemoTab.toState()` で埋める

### Phase 2: レイアウト（ペイン・ツールバー・フォーカス枠） [AI🤖]

- [x] `registry.ts` に定数を足し、DESIGN.md と同じ値にする:
      `SPLIT_GAP = 8` / `SPLIT_INSET = 8` / `SPLIT_RADIUS = 10` / `SPLIT_FOCUS_RING = 2`
- [x] **矩形の出し方を今の構造から作り替える**。今の `pageBounds` は「共有ツールバーより下」なので、
      これを左右に割ってもツールバー込みのペインにならない（左のツールバーが全幅のまま残り、
      外周余白・角丸・フォーカス枠がページ部分にしか掛からない）。
      **サイドバーの右側の全領域（ツールバーの行を含む）から先にペインの外枠を 2 つ出し、
      各外枠の中でツールバー 40px とページを積む**という順に直す。純関数 `paneOuterBounds(area, side)` +
      `paneInnerBounds(outer)`（→ `{ toolbar, page }`）に切り出す。
      **分割していないときは今までどおり**（余白も隔間も角丸も無く、ツールバーが全幅・ページがその下）
- [x] 幅の割り振りは**左を `floor((area.width - inset*2 - gap) / 2)`・右は残り全部**にする
      （割り切れないときの 1px を必ず右へ寄せる。丸め方を決めておかないと 1px の隙間や重なりが出る）
- [x] **拡張 popup の位置補正を追従させる**。`extensions.ts` の `popupAnchorOffset()` は
      `win.sidebarWidth` を返しているが、分割中は左ツールバーが `sidebarWidth + SPLIT_INSET` から始まる。
      直さないと Bitwarden の popup が分割中だけ 8px ずれる。**左ツールバーの実際の絶対 x** を
      返すように直し（非分割なら今までどおり `sidebarWidth`）、`verify:ext` の popup 位置検証に
      分割中の場面を足す
- [x] 右ペイン用のツールバーを**遅延生成**する `ensureSplitToolbar()`（`ensurePeekChrome` / `ensureEmptyView` と
      同じ作法）。`createUiView('toolbar')` に `?pane=right` が乗るよう `CreateUiViewOptions` に
      `pane?: 'right'` を足す。一度作ったら捨てず、分割していない間は `setVisible(false)`
  - `uiContents` に含める（**忘れると右ペインのボタンの IPC が拒否される**。Peek の暗幕で踏んだのと同じ罠）
  - **`destroy()` の破棄対象にも足して参照を null に戻す**。`destroy()` は UI View を明示的に列挙して
    `disposeUiView` に渡しているので、足さないと**ウィンドウを閉じてもレンダラプロセスが残る**
    （1 枚 89MB）。フォーカス枠と器の `View` も同じ列挙に足す（こちらは `WebContents` を持たないので
    `removeChildView` だけでよい）
- [x] フォーカス枠を遅延生成する `ensureFocusRing()`（`new View()` + `setBackgroundColor('--nemo-accent' の実値)`
      + `setBorderRadius(SPLIT_RADIUS + SPLIT_FOCUS_RING)`。器と同じ半径にすると角だけ枠が太って見える）。`layout()` で **フォーカス中ペインの矩形を上下左右 2px 広げた位置**へ置き、
      ペインより先に `addChildView` する（z 順は毎回組み直す既存の方針に合わせる）
- [x] **非分割へ戻すときの後始末を 1 か所に決める**。器とフォーカス枠は遅延生成して使い回すので、
      分割をやめた / 別のタブを選んだときに**必ず隠す**（背景色を持つ空の器や古い枠が
      ページの上に残るとクリックを遮る。空状態の View や Peek の暗幕で踏んだのと同じ罠）。
      `layout()` の中で「分割中でなければ両方の器と枠を `setVisible(false)`」と書き、
      Phase 7 で解除後・別タブ選択後の可視状態を機械検証する
- [x] Phase 0 の結論に応じてペインの角丸を実装する
  - **器 View がクリップする場合**: 器に入れるのは**ページ View だけでなく、そのペインの
    ツールバー View も**（ツールバーを器の外に置くと上 2 隅が丸まらず、「器 1 枚を丸める」方式が
    そもそも成立しない）。器を挟むと**View の親が変わる**。今は全部 `BaseWindow.contentView` の直下で、
    `sleep()` / `removeTab()` / `moveTabToWindow()` / `layout()` の `removeChildView` → `addChildView` が
    その前提で書かれている。**付け替えを 1 か所（`applyVisibility()` か `layout()`）に閉じ**、
    「分割中はペインの器の子・それ以外は `contentView` の直下」を毎回そこで組み直す。
    `removeChildView` の呼び先は**今その View が実際にぶら下がっている親**にする必要があるが、
    **Electron の `View` に親を返す API は無い**（`children` はあるが `parent` は無い）。
    間違った親に対する `removeChildView` は**エラーにならず no-op** なので、黙って壊れる。
    `WeakMap<View, View>` で親を覚える **attach / detach のヘルパ**を作り、
    **初回の追加（`materialize()` でのページ追加・ツールバーの生成時追加）も含めて
    すべての `addChildView` / `removeChildView` をそこに通す**
    （初回が map を通らないと、最初の付け替えの時点で親が分からず方式が成立しない）。
    ウィンドウ移動では移動元から外して移動先で登録し直す。
    **`View.setBounds()` は親からの相対座標**なので、器は絶対座標で置き、
    **器の子（ツールバー・ページ）は `{ x: 0, y: 0 }` 起点**にする（絶対座標を渡すと
    `outer.x` が二重に足されて右ペインが画面外へ飛ぶ）。`paneInnerBounds()` がどちらの座標系を
    返すのかを JSDoc に明記する
  - **クリップしない場合**: **`SPLIT_RADIUS = 0`（角丸なし・隔間と外周余白だけ）**にする。
    親子構造も今のまま（付け替え不要）で、ツールバーの透明化も要らない。
    DESIGN.md の角丸の行に「クリップが効かない環境ではこの値が 0 になる」と理由ごと書く
- [x] `layout()` の z 順の組み直しに、分割ぶんを足す。**Phase 0 の分岐ごとに書き分ける**:
  - 器を使う場合（下から）: フォーカス枠 → **左右の器**（各器の中はツールバー → ページ）→
    Peek の暗幕 → Peek 本体 → オーバーレイ。**ツールバーを器の外に出さない**（出すと上 2 隅が丸まらない）
  - 器を使わない場合（下から）: フォーカス枠 → ページ → 左右のツールバー → Peek の暗幕 →
    Peek 本体 → オーバーレイ（全部 `contentView` の兄弟）
- [x] Peek の矩形を `peekBounds(pageBounds)` から **`peekBounds(paneInnerBounds(outer).page)`** に変える
      （**外枠ではなくページの内枠**。外枠を使うと暗幕がツールバーまで覆い、
      「ページ領域にだけ重ねる」という既存の挙動が変わる）。暗幕（`peekChromeView`）も同じ内枠に合わせる。
      **`paneInnerBounds()` はウィンドウ座標を返す**と契約を固定し、器の子として置くときだけ
      `outer` を引いてローカル座標へ変換する（Peek と暗幕は `contentView` 直下のままなので、
      同じ矩形をそのまま渡す）。この契約を JSDoc に書く。
      **出すのはフォーカス中タブの Peek だけ**（`visibleTabKeys` の規則と揃える）
- [x] 空状態（`emptyView`）は今までどおりページ領域いっぱい（分割中にタブが 0 本になることは無い）
- [x] `overlayBounds()` の第 4 引数は名前こそ `toolbarHeight` だが**実質は「ページの上端」**で、
      非モーダルのオーバーレイをそこに合わせている。分割中は外周余白のぶんページ上端が下がるので、
      **引数を `pageTop` に改名し、分割中はペインの `page.y` を渡す**
      （直さないと検索バー・ダイアログ・ダウンロードが 8px 上へずれてツールバーに掛かる）。
      オーバーレイ自体はページ領域の右上のままで、対象はフォーカス中ペイン。
      Phase 7 で分割中の検索バーの bounds を診断 IPC で確かめる

### Phase 3: ツールバー（renderer） [AI🤖]

- [x] `src/renderer/main.tsx` の分岐で `?pane` を読み、`<Toolbar pane={...} />` に渡す
- [x] `Toolbar.tsx` が担当タブを決める規則を **1 つの関数**にまとめる。
      **基準は必ず `activeTabKey` のタブ**（1 ウィンドウに分割ペアが複数ありうるので、
      「`splitSide === 'right'` の最初のタブ」のような探し方をすると、いま見えていない別のペアの
      ツールバーが出る）:
  - アクティブタブが分割に入っていない → 右ツールバーは**担当タブ無し**（`layout()` が隠す）、
    左は `activeTabKey` のタブ
  - 入っている → `splitSide` と `splitPartnerKey` から左右を導き、`pane` に応じて割り当てる
- [x] **ペイン固有の操作はフォーカスも移す**。戻る / 進む / リロード / アドレスバーの編集・確定・
      ✕ を押したときは、先に `selectTab(担当タブ)` を通す。通さないと「左のアドレスバーを触ったのに
      フォーカス枠・⌘W・⌘F・拡張の対象は右のまま」になる。
      **ウィンドウ共通の操作**（サイドバー開閉・拡張・ダウンロード・履歴・＋）は
      フォーカスを動かさない
- [x] 右ペインのツールバーは **戻る / 進む / リロード + アドレスバー + ✕** だけにする。
      サイドバー開閉・拡張（`<browser-action-list>`）・ダウンロード・履歴・＋ は**左（既存の View）だけ**に置く。
      理由をコメントに残す（拡張 popup の位置合わせは View ごとにオフセットを足し戻す必要があり、
      同じ partition の `<browser-action-list>` を 2 枚出すと popup の帰属が曖昧になる）
- [x] サイドバー非表示のときの `.inset`（信号機ぶんの左余白 82px）は**左のツールバーだけ**に付ける。
      右にも付くと、画面の真ん中に理由の無い余白ができる
- [x] 左のツールバーにも ✕（このペインを閉じる）を足す。**分割中だけ出す**
- [x] ✕ は `window.nemo.closeTab(担当タブの key)`。**⌘W とは別**にする。
      ⌘W は「Peek が出ていれば Peek を閉じる」という既存の規則を持っていて（`menu.ts:117`）、
      その規則は残す。✕ は担当ペインのタブを閉じる（浮いている Peek は `removeTab` が
      親と一緒に閉じるので、書き足す処理は無い）。**この違いを DESIGN.md にも 1 行書く**

### Phase 4: サイドバー（結合行・D&D・右クリック） [AI🤖]

- [x] **分割に入っているタブは、Live Folder の除外より結合行を優先する**。`ephemeral` は
      「PR の URL を持つタブを一覧から外す」フィルタを掛けているが、**分割中のタブはその除外から外す**。
      掛けたままだと、分割したページが PR の URL へ遷移した瞬間に結合行ごと消え、
      「画面には分割が出ているのにサイドバーから解除できない」状態になる。
      Live Folder 側の行は従来どおり出て「開いている」表示になる（人間が判断済み）
- [x] `Sidebar.tsx` の `ephemeral` を描くところで、`splitSide === 'right'` かつ相方が同じ配列にいるタブを
      **飛ばす**（左が結合行として両方を描く）。相方が見つからないときは通常の行として描く（保険）
- [x] `SplitRow.tsx` を新設（`TabRow.tsx` の隣）。モックの**案A**をそのまま写す:
  - 器: `height: var(--nemo-row-h)` / `padding: 3px` / `gap: 3px` / `border-radius: var(--nemo-radius)` /
    背景 `--nemo-surface-hi`・文字 `#fff`（**分割ペアが見えているかに関わらず常にアクティブ表示**ではなく、
    「そのペアが表示中か」で出し分ける。表示中でなければ通常行と同じ地）
  - チップ: `flex: 1 1 0` / `min-width: 0` / `border-radius: 5px` / 背景 `rgba(255,255,255,.05)`。
    中身は favicon 16px → タイトル 12px（省略）→ 未読ドット / ♪ → × 20px
  - フォーカス側チップ: 背景 `rgba(255,255,255,.10)` + `box-shadow: inset 2px 0 0 var(--nemo-accent)`
  - チップのクリック → `selectTab(そのタブ)`（フォーカス移動）。ダブルクリック → その場でリネーム
  - チップの × → `closeTab(そのタブ)`
  - 器ごと `draggable`ではなく**チップ単位で `draggable`**（`TAB_DRAG_TYPE` にそのタブの key を載せる）。
    ピン留めツリー / Favorites へのドロップは既存経路のまま効き、main 側で先に分割が解ける
- [x] チップの右クリックメニュー（`RowMenu`）: 名前を変更 / ピン留め / Favorites に追加 / **分割を解除** / 閉じる。
      「分割を解除」は `window.nemo.separateSplit(そのタブの key)`
- [x] **ドラッグ中のタブ key をサイドバー内の共有 state に持つ**。`dragover` の時点では
      `DataTransfer.getData()` が読めない（HTML5 の仕様）ので、`types` の判定だけでは
      「ドラッグ元が分割に入っているか」「自分自身か」を判定できない。
      `TabRow` / `SplitRow` の `dragStart` で共有 state に key を入れ、`dragend` で消す
      （既存の `useDragEnd` に相乗りする）。`drop` 側は今までどおり `getData` を正とする
- [x] `TabRow.tsx` にドロップの受け口を足す。判定は **1 つのヘルパ** `dropZoneOf(event, element)` に閉じ、
      `'before' | 'split' | 'after'` を返す（上端 8px / 下端 8px / それ以外が中央帯）。
      いまは `before` / `after` に受け皿が無いので**何もしない**（将来の並べ替え用の死に帯として空けておく）
  - **`dragover` で `preventDefault` するのは「中央帯 かつ `canSplitWith` が真」のときだけ**。
    上下端では `preventDefault` しない（＝ドロップ不可のまま）。ここを全域で
    `preventDefault` すると、上下端に落として何も起きない「無反応なドロップ」ができる
  - 受け付けるときだけ `.drop-split`（`inset 0 0 0 2px var(--nemo-accent)` + 薄いアクセント地）を付ける
  - **受け付けない相手**: 自分自身 / 既に分割に入っている行 / ドラッグ元が分割に入っている行 /
    ピン留め行 / Favorites セル / Live Folder 行。判定は `TabState` の
    `pinnedId` / `favoriteId` / `splitSide` で行い、**行の側で分岐を持たず 1 つの述語**
    `canSplitWith(draggedKey, target)` に寄せる
  - `drop` で `window.nemo.splitTabs(ドロップ先の key, ドラッグ元の key)`（**先が左・元が右**）
  - `useDragEnd` で受け皿の表示と共有 state を必ず戻す（既存の罠。`dragend` は掴んだ側でしか起きない）
- [x] **既存のドロップ先との取り合いを潰す**。サイドバーは 1 枚の View なので `dragover` / `drop` は
      祖先へ伝播する。タブ行が受けたドロップは `stopPropagation` し、逆にタブ行が受け付けない
      （`preventDefault` しない）ときはピン留めツリー・Favorites 側の判定を邪魔しないこと、
      ピン留め行の上ではタブ行の受け皿が出ないことを、Phase 7 の検証で**実際に撃って**確かめる
- [x] `styles.css` に `.split-row` 系と `.row.drop-split` を足す。**値はモックからそのまま写す**

### Phase 5: IPC・preload・型 [AI🤖]

- [x] `NemoUiApi`（`src/shared/types.ts`）に 2 本足す:

  ```ts
  /** 2 本のタブを左右に並べる。**左 → 右の順で渡す**（ドロップ先が左）。 */
  splitTabs(leftKey: string, rightKey: string): Promise<void>
  /** そのタブが入っている分割を解除する（相方はどちらでもよい）。 */
  separateSplit(key: string): Promise<void>
  ```

- [x] `src/main/ipc.ts` に `nemo:split-tabs` / `nemo:separate-split` を足す。
      **引数は既存の作法どおり `unknown` で受けて検証**し、`requireWindow(event)` のウィンドウに属する
      key かどうかも main 側で照合する（renderer から任意の key を渡せないようにする）
- [x] `src/preload/ui.ts` に橋渡しを足す
- [x] **検証専用の診断 IPC** `nemo:split-diagnostics` を足す。**`NEMO_VERIFY_DIAGNOSTICS === '1' && !app.isPackaged`** のときだけ登録する
      （既存の `NEMO_GITHUB_TEST_ENDPOINT` / `NEMO_MEET_TEST_URL_PREFIX` と同じゲート。
      env だけだと、環境変数を付けて起動したパッケージ版にも診断 API が生える）。返すもの:
  - `BaseWindow.getMediaSourceId()`（**合成後のウィンドウを撮る唯一の経路**。
    renderer からは CGWindowID を知りようがなく、`windowId` / `chromeWindowId` は別物）
  - **ペインを配置した領域 `area`**（サイドバーの右側）と、左右のペインの
    `outer` / `toolbar` / `page` の実 bounds、フォーカス枠の bounds、
    **出ていれば Peek 本体と暗幕の bounds**、**器とフォーカス枠の可視状態**、
    **出ていればオーバーレイの bounds**。**全部ウィンドウ座標**で返す
    （`area` が無いと右端の外周余白 8px を検算できない）
  - 環境変数が無いときは**ハンドラごと登録しない**（本番の renderer から呼べる面を増やさない）
  - **`NemoUiApi` と preload にも口を足す**。UI は `sandbox: true` / `contextIsolation: true` /
    `nodeIntegration: false` なので、検証スクリプトは `window.nemo.*` 越しにしか呼べない
    （`ipcRenderer` を直接は触れない）。返り値の型も `types.ts` に置く
  - **同じゲートで「コマンドを名前で実行する口」も出す**。⌘W / ⌘数字 / ⌃Tab はキーでは撃てないので、
    検証はここを通す。ただし `menu.ts` の今の入口は**どれも `focusedOrFirstWindow()` で対象を決める**ので、
    そのまま呼ぶと**送信元ではないウィンドウを操作する**（複数ウィンドウの検査が壊れる）。
    **ウィンドウを引数で受ける形に切り出して**から呼ぶ。⌘数字は別経路（`selectTabByIndex`）なので
    それも同様に切り出す。受け付ける名前は **`COMMANDS` の ID と `select-tab-1`〜`9` だけ**に絞り、
    対象ウィンドウは `requireWindow(event)` にする

### Phase 6: セッション復元 [AI🤖]

- [x] `src/shared/settings-schema.js` の `SESSION_VERSION` を **4** に上げ、`SavedWindow` に足す:

  ```js
  /** @property {[number, number][]} splits 保存したタブ配列の添字ペア（[左, 右]） */
  ```

- [x] `normalizeSession` で `splits` を検証する。**捨てる条件**: 整数でない / 範囲外 /
      左右が同じ / 同じ添字が 2 つ以上のペアに現れる（**競合したペアは全部落とす**。
      先着を残すと結果が実装順に依存し、壊れたデータの冪等性検証の期待値が決まらない）/ タブが除外されて添字が動いた分
      （既存の `moved` マップで読み替え、読み替えられないペアは丸ごと落とす）。
      版 3 以前のデータには `splits` が無いので空配列に倒す（**移行の既定値をここに書く**）
- [x] `NemoWindow.toSaved()` で `splits` を出す。`toSaved` は既に「保存対象のタブ配列」を作っているので、
      **その配列の添字**でペアを表す（`activeIndex` と同じ配列を使う。ズレると別のタブが繋がる）。
      **左右の両方が保存対象に入っているペアだけ書き出す**。`toSaved` は `https?:` 以外を落とすので、
      片方が `about:blank` のペアをそのまま書くと `-1` を含む `splits` を自分で作ってしまう。
      **同じペアを 2 回書かない**（左右の両タブが同じ `SplitPair` を指しているので、
      素朴に走査すると同じ添字ペアが 2 つ出て、次回の起動で自分が書いた `splits` を
      「添字の重複」として捨てることになる）。`tab === tab.split.left` のときだけ出す
- [x] セッション復元は **`src/main/index.ts:216` の `win.whenUiReady()` の中**（`saved.tabs` を作って
      `saved.activeIndex` を選んでいるところ）。ここでタブを全部作り終えたあとにペアを繋ぐ
      （関係構築のヘルパ自体は `registry.ts` に置いて呼び出す）。**通常の `splitTabs` は使わない**
      （右を選択して `applyVisibility()` が走るため、ペアの数だけ materialize が起き、
      保存した `lastActiveAt` も現在時刻に上書きされて「起動時にタブ実体を作らない / 寝かせたまま」が壊れる）。
      **関係の構築だけを行う内部関数**（`SplitPair` の生成と代入・タブの並べ替えまで）を切り出し、
      復元では全ペアをそれで繋いでから、**最後に一度だけ**保存されたアクティブタブを `selectTab` する
- [x] **添字は全部まとめて先に解決してから並べ替える**。ペアを 1 組ずつ「添字を引く → 並べ替える」で
      処理すると、最初の並べ替えで**後続のペアの添字が別のタブを指す**
      （`[A,B,C,D]` に `[[0,2],[1,3]]` のような交差するペアで壊れる。`normalizeSession` は
      非隣接ペアも 1 ウィンドウ内の複数ペアも通す）。**先に全ペアをタブの実体へ解決し、
      アクティブタブも key で控えてから**、まとめて関係構築と並べ替えを行う。
      **交差するペアは通常操作では作れない**（`splitTabs` が必ず隣接させ、`toSaved()` も
      `[[0,1],[2,3]]` の隣接形で書く）ので、`--restart-write` では再現できない。
      交差 fixture は**アプリを止めた状態で版 4 の `session.json` を直接置いて起動する**
      `verify-session-migration.mjs` 側の独立検証に置く
- [x] `scripts/verify-session-migration.mjs` に足す:
  - 版 3 のデータ（`splits` 無し）を読んでも壊れない
  - 壊れた `splits`（範囲外・左右同一・添字の重複）が落ちる
  - **交差するペア**（`[[0,2],[1,3]]`）を版 4 の `session.json` として置いて起動し、
    左右の URL が意図どおりに繋がること（通常操作では作れない形なので、ここでしか踏めない）
  - **冪等性**: 同じ userData で**2 回目を起動**し、ペア・左右・アクティブタブが変わらないこと
    （1 回目の終了時に正規化済みの版 4 が書かれるので、それを読み直す経路が壊れていても
    初回起動だけの検証では気づけない）
  - **`moved` による添字の読み替えが正しい**（ペアの**前**と**間**に除外対象のタブ
    ＝ 版 2 以前のピン留めタブ・不正 URL を混ぜた fixture）。読み替え後の左右の **URL** を突き合わせる。
    ここが壊れると**有効なペアが別のタブに繋がる**（一番危険なのに、無効値の検査だけでは検知できない）

### Phase 7: 自走検証 [AI🤖]

- [x] `scripts/verify-split.mjs` を新設し、`verify-all.mjs` の `ONLY` 一覧・`NEEDS_APP`・実行順に
      `split` を足す（`peek` の後）。`.mise.toml` の `verify:split` は
      **`node scripts/verify-all.mjs --only split` を呼ぶ自己完結型**にする
      （`verify:switcher` のように素のスクリプトを呼ぶ形だと、
      診断 IPC のための環境変数を持たない通常起動の Nemo に繋いで落ちる）
- [x] **`NEMO_VERIFY_DIAGNOSTICS=1` は `verify-all.mjs` の `startApp()` の env に足す**。
      同ファイルに「**アプリ側へ渡すのがここ**。検証スクリプトにだけ渡しても届かない」と
      コメントがあるとおり、`runVerify` 側に渡しても main のハンドラは登録されない。
      `--only` の指定に依存させない（条件分岐にすると「フルでは通るのに絞ると落ちる」を作る）
- [x] **再起動区間の配線を足す**。`verify-all.mjs` の `want('restart')` ブロックは各検証の
      write / read を明示的に呼ぶ作りなので、停止前に `split(['--restart-write'])`、
      `startApp()` の後に `split(['--restart-read'])` を足さないと**指定しても走らない**。
      置く位置は「タブを作る検証はいちばん最後」の既存メモに従い、`call` の `--position-read` より前
- [x] **キー操作は合成イベントで撃てない**。メニューのアクセラレータ（⌘W / ⌘数字 / ⌃Tab / ⌘F / ⌘⇧N）は
      AppKit が NSEvent の段階で食うので、CDP の `Input.dispatchKeyEvent` では入口ごと発火しない
      （`verify-switcher.mjs` の冒頭に同じ注意があり、既存の検証はどれも `window.nemo.*` を呼んでいる）。
      キーで起きるはずの挙動は **Phase 5 の口（コマンドを名前で実行する）から撃つ**。
      **キーの割り当てそのものはユニットテスト**（`keybindings.test.mjs`）と**人間の動作確認**に分ける
- [x] 検証項目（**D&D だけは UI の合成イベントで撃つ**。IPC を直接叩くと当たり判定を通らない。
      それ以外は `window.nemo.*` かコマンドの口から撃つ）:
  - **生成**: タブを 3 本作る → 2 本目の行を 3 本目の行の**中央**へ `dragstart` → `dragover` → `drop` の
    合成イベントで落とす → `getVisibleTabKeys()` が **2 件**・結合行 `.split-row` が 1 件・
    通常行が 1 件（3 本のうち 2 本が結合行に吸われた）
  - **当たり判定**: 同じ 2 行で `clientY` を行の上端 +2px にして `dragover` → `.drop-split` が
    **付かない**こと（中央帯だけで反応する）。到達している証拠として、そのときの `dragover` が
    `preventDefault` されていない（＝ドロップ不可）ことも見る
  - **左右**: `TabState` の `splitSide` が「ドロップ先 = left」「ドラッグ元 = right」であること
  - **ペインの実寸**: Phase 5 の診断 IPC から実 bounds を取り、
    左右の幅が等しい（差 ≤ 2px）/ 左の右端 + 隔間 8 = 右の左端 / 外周余白 8 /
    各ペインの `toolbar` と `page` の幅が `outer` と一致する（＝「ツールバーが全幅のまま残る」回帰を捕まえる）/
    フォーカス枠が該当ペインの `outer` を上下左右 2px 上回ることを見る。
    **角丸だけは bounds に出ないのでスクショで目視**する
  - **フォーカス**: 作った直後は右がアクティブ（`activeTabKey === 右の key`）。
    左ペインのページに `Input.dispatchMouseEvent` でクリックを撃つと `activeTabKey` が左に移り、
    **`getVisibleTabKeys()` は 2 件のまま**であること
  - **ツールバー経由のフォーカス移動**: 右にフォーカスがある状態で**左のツールバーのリロードと
    アドレスバー**を押すと `activeTabKey` が左へ移ること（逆も同様）。
    一方で**左のツールバーの拡張・ダウンロード・履歴・＋**を押しても `activeTabKey` が動かないこと
    （ペイン固有とウィンドウ共通の切り分けが効いているか）
  - **別タブへ行って戻る**: 3 本目を選ぶと `getVisibleTabKeys()` が 1 件 → 結合行のチップを押すと
    また 2 件に戻り、`splitSide` が保たれていること
  - **⌘W**: フォーカス中ペインのタブだけ消え、残りが全画面（`getVisibleTabKeys()` が 1 件・
    `splitSide` が `null`・`.split-row` が 0 件）。**ペアの後ろに別のタブを 1 本残した状態で
    右ペインを閉じ、選ばれるのが「左」であること**（後続タブが選ばれる既存の規則を踏まないため。
    ペアが末尾にある並びだけで試すと、この不具合があっても検査が通ってしまう）
  - **相方の materialize**: 分割を作ってから別タブへ移り、`tabSleepMinutes` を極小にして
    相方が寝るのを待ってから結合行に戻る → **両ペインとも中身が描かれている**こと
    （`Runtime.evaluate` で各ページの `document.title` / `location.href` が読めること）
  - **解除**: 結合行のチップを右クリック →「分割を解除」→ 通常行が 2 行になり、
    **左だったタブが上・右だったタブが下**（`.row .tt` の並びで確かめる）
  - **3 つ目**: 分割中の行へ別のタブをドロップしても `.drop-split` が付かず、
    ドロップ後も `splitPartnerKey` が変わらないこと
  - **⌃M の順**: 右ペインにフォーカスした状態から別のタブへ移り、⌃M を撃つと
    **左ではなく右へ戻る**こと（両ペインに同じ `lastActiveAt` を書くと同着になって左へ行く）
  - **⌘数字 / ⌃Tab**: 分割の左右がタブの並びで隣接していることを使い、
    ⌘数字と ⌃Tab / ⌃⇧Tab で**左右それぞれにフォーカスできる**こと
    （並べ替えや「⌘9 は末尾」の扱いがペアを飛ばしても、他の検査では気づけない）
  - **後始末**: 分割を解除した直後・別のタブを選んだ直後に、器とフォーカス枠が
    見えていないこと（診断 IPC で確かめる）
  - **オーバーレイの位置**: 分割中に ⌘F を開き、検索バーの上端が **`ペインの page.y + 12`**
    であること（`overlayBounds` の find は既存仕様で 12px 下げて置く。
    外周余白ぶんだけ下がったことを見る）
  - **未読**: 分割を表示している間、**相方の行にも未読ドットが付かない**こと
    （相方のページで読み込みを起こしてから確かめる）
  - **main 側の拒否**: `window.nemo.splitTabs()` を直接呼んで、ピン留めのタブ / Live Folder に
    載っている URL のタブ / 既に分割に入っているタブが**拒否される**こと
    （renderer の受け皿を迂回しても通らないこと）
  - **後から Live Folder 対象になる**: 分割中の片側を PR の URL へ遷移させても
    **結合行が消えない**こと（`.split-row` が 1 件のまま）。Live Folder 側にはその行が
    「開いている」表示で出ること
  - **ピン留め**: 分割中のチップに対して `pinTab` を呼ぶと分割が解け（`.split-row` が 0 件）、
    ピン留め行が 1 件増えること
  - **sleep**: `tabSleepMinutes` を極小（0.05）にして数秒待ち、
    **分割中の 2 本とも `asleep` にならない**こと。**同時に、見えていない非分割の対照タブを 1 本置き、
    そちらは `asleep` になっていること**を見る（sweep 自体が動いていなくても
    「消えていない」だけなら通ってしまう）
  - **アーカイブ**: `tabArchiveHours` を極小にした**独立したケース**として、sweep の前に
    分割中の 2 本が在ることを確かめてから待ち、**sweep 後も 2 本残っている**こと。
    こちらも**対照タブが実際に閉じられたこと**を同時に見る
  - **ペア単位の寿命**: 上とは別に、**ペアを非表示にしたうえで左右の `lastActiveAt` に差を付け**、
    「古い側だけが期限切れ・新しい側は期限内」の時点で撃つ。
    **sleep は 2 本とも `asleep === false`・archive は 2 本とも在ること**を別々に見る
    （「2 本残っている」だけだと、古い側が寝ていても通ってしまう）。
    これを撃たないと `visibleTabKeys` の除外だけで通り、
    **ペアの新しい方の時刻を使う処理を書き忘れても全検査が PASS する**
    （`sweepSleep` と `sweepArchive` は別の関数なので、sleep だけ発火させると
    archive 側に古い `activeTabKey` 判定が残っていても素通りする）
  - **`tabSleepMinutes` / `tabArchiveHours` は元の値を控えて `try/finally` で必ず戻す**。
    `verify-all.mjs` は同じアプリを使い回すので、極小のまま抜けると
    **後続の検証のタブが勝手に寝る / 閉じてフル検証が壊れる**
  - 上の 2 つは **修正前の実装で FAIL することを確かめてから**入れる。ただし `git stash` で
    丸ごと戻すと分割機能ごと消え、「API が無い」という**別の理由**で落ちて回帰検査の証明にならない。
    **分割の実装は残したまま、sweep 側だけを一時的に戻して**撃ち、狙った理由で落ちることを確かめる。
    戻すのは **2 か所を別々に**: 除外条件（`visibleTabKeys` → `activeTabKey`）と、
    実効時刻（ペアの新しい方 → `tab.lastActiveAt`）。片方だけ戻すと、
    もう片方の検査が「たまたま通る」ままになる（FAIL の出力を報告に載せる）
  - **Peek**: 左ペインのページから `target=_blank` を開き、診断 IPC の Peek / 暗幕の bounds が
    **左ペインの `page` の内側に収まる**こと。フォーカスを右へ移すと左の Peek が隠れ、
    右で開いた Peek に入れ替わること（座標変換の誤りと `visibleTabKeys` の 3 件化が
    壊れても、既存の非分割 Peek 検証と上の分割検証は通ってしまう）
  - **⌘W と ✕ の違い**: Peek を出したまま ⌘W → **Peek だけ閉じてペアは残る**。
    同じ場面でそのペインの ✕ → **担当タブと Peek が閉じ、相方が全画面**になる
    （実装で両者が同じ経路に再統合されると、この 2 つのどちらかが崩れる）
  - **ドロップ先の取り合い**: ピン留め行の上へタブをドラッグしても `.drop-split` が付かないこと。
    タブ行の中央帯へのドロップがピン留めツリー側の処理を起こさないこと（ピン留めの件数が増えない）
  - **複数ペア**: ペアを 2 組作り、行き来する。**そのつど左右のツールバーの URL が
    アクティブなペアの 2 本に切り替わる**こと（`splitSide === 'right'` の先頭を拾う誤実装だと、
    1 組だけの検査は通ってしまう）
  - **ウィンドウ移動**: **ペアの後ろに対照タブを 1 本置いた状態で**分割中の右側を ⌘⇧N で
    新規ウィンドウへ移すと、**両側の `splitPartnerKey` が null になり**、
    元のウィンドウで選ばれるのが**後続タブではなく左**であること、移したタブが移動先で単独表示になること（器から別ウィンドウへの View の付け替えで
    親を取り違える / 片側だけ関係が残る、は他の検証では捕まらない）
  - **再起動**: `--restart-write` で**ペアを 2 組**作って保存 → `--restart-read` で立て直し、
    `splitSide` と左右の順序が両方復元されること。加えて:
    - アクティブなペアは **`getVisibleTabKeys()` が 2 件**で、左右それぞれのページから
      `location.href` と実測幅が取れること（`splitSide` だけ見ると左ペインが空でも「成功」になる）
    - **非アクティブなペアは 2 本とも `asleep` のまま**で、`lastActiveAt` が保存値から動いていないこと
      （復元で通常の `splitTabs` を呼ぶと全ペアが materialize され、遅延復元が壊れる。
      この検査が無いと、関係構築専用の関数を使う理由が守られているか分からない）
- [x] `NEMO_VERIFY_SHOTS=<dir>` の opt-in でスクリーンショットを撮る（`verify-live-folder.mjs` と同じ作法）。
      ただし撮影は **Phase 0 のヘルパ + Phase 5 の診断 IPC で取った media source ID** で行う
      （`Page.captureScreenshot` はその WebContents しか撮らないので、
      **フォーカス枠も隔間も器の角丸も 1 枚も写らない**）。
      場面は「分割中（左フォーカス）」「分割中（右フォーカス）」「解除後」の 3 つ。
      撮る直前に `until` でレイアウトの遷移（`border-radius` の transition）が終わるのを待ち、
      マウスをサイドバー外へ退避して `:hover` を 0 件にする
- [x] 撮れた PNG を Read して、**角丸 10 と継ぎ目の見え方**（bounds には出ない分）を目視し、
      **報告に絶対パスを載せる**。隔間・外周余白・フォーカス枠の寸法は診断 IPC で機械検証済みなので、
      ここでは見ない
- [x] `mise run check` → `mise run verify:only split restart` →
      **`NEMO_VERIFY_SHOTS=<scratchpad>/shots mise run verify:only split`**（目視用の PNG を出す。
      opt-in なので指定しないと 1 枚も撮れない）→
      **`mise run verify:ext`**（分割中の拡張 popup 位置。`verify-all.mjs` からは呼ばれないので
      別に叩かないと一度も走らない）→ 最後に `mise run verify` を 1 回通す

### Phase 8: ドキュメント [AI🤖]

- [x] `DESIGN.md` に「分割ビュー（2 ペイン）」の節を足す。位置は「Peek」の直前。書くもの:
  - 対象は一時タブだけ・3 つ以上は作らない・作る導線は D&D だけ
  - 値の表（隔間 8 / 外周余白 8 / 角丸 10 / フォーカス枠 2px / 結合行 40px・器と小面の色）
  - **分割していないときはベタ塗りのまま**（角丸と余白は分割中だけ）
  - 結合行の中身（favicon → タイトル → 未読 / ♪ → ×）とフォーカス側チップの見せ方
  - 右ペインのツールバーは最小構成（拡張・ダウンロード・履歴・＋ は左だけ）とその理由
  - 「サイドバー」節の 3 層の並びに、結合行が**一時タブの層の中**に出ることを 1 行足す
  - Live Folder の節に「**分割に入っているタブは結合行が優先**され、一時タブの層から消えない」を足す
  - 「Peek」節に「分割中はそのペインの中に収まる・出るのはフォーカス中タブのぶんだけ」を足す
- [x] `VERIFY.md` の「どれを回すか」の表に **分割ビュー → `mise run verify:only split restart`** を足し、
      合成 D&D の撃ち方（`dragstart` / `dragover` / `drop` を `DataTransfer` 付きで撃つ）を短く残す
- [x] `CHANGELOG.md` の `[Unreleased]` に追記する。**リリースコマンドは叩かない**

### 動作確認 [人間👨‍💻]

- [ ] `mise run dev` で実機を触る
  - タブ行を別のタブ行へドラッグして分割になるか（掴みにくくないか・当たり判定が狭すぎないか）
  - フォーカス枠と結合行のアクセントバーが一緒に動くか
  - ~~ペインの角丸の**継ぎ目**（ツールバーとページの境目）が気にならないか~~
    → 角丸を捨てた（`SPLIT_RADIUS = 0`）ので継ぎ目は無い。代わりに
    **隔間 8px だけで左右の切れ目が読み取れるか**（地の色が同じなので分かりにくくないか）を見る
  - 分割中に Bitwarden の自動入力が両ペインで効くか（拡張の「今いるページ」はフォーカス中ペイン）
  - 分割中にリンクを踏んで Peek がそのペインに収まるか
  - サイドバーを ⌘S で隠したときのレイアウト
  - **キーを実際に押す**（⌘W・⌘数字・⌃Tab・⌘F・⌘⇧N を分割中に）。自動検証はコマンドの口から
    撃っていて**アクセラレータの登録と実キー入力からの接続は一度も通っていない**ので、
    ここだけは人が押して、自動検証と同じ挙動になることを見る

## ログ

### 試したこと・わかったこと

**sweep の検査が「修正前の実装で FAIL する」ことの確認**

`git stash` では分割の実装ごと消えて別の理由で落ちるので、**sweep 側だけを 2 か所に分けて**
一時的に戻し、それぞれ狙った検査だけが落ちることを確かめた。

| 一時的に戻したもの | 落ちた検査 |
| --- | --- |
| 除外条件（`visibleTabKeys` → `activeTabKey`） | `sleep: 分割中の 2 本は寝ない — left=true right=false`<br>`archive: 見えている分割の 2 本は残る — left=true right=false` |
| 実効時刻（`pairLastActiveAt` → `tab.lastActiveAt`） | `sleep: ペアの新しい方の時刻を使う（古い側だけ寝ない） — left=true right=false` |

片方だけ戻すともう片方の検査は PASS のままで、2 つが別々の回帰を見ていることも確認できた。

**「絞ると通るのにフルで落ちる」を 2 件踏んだ**

`mise run verify:only split restart` では通るのに、`mise run verify` で落ちた。
どちらも**他の検証と一緒に走ると前提が崩れる**型で、絞った実行だけでは気づけない。

| 落ちた検査 | 原因 | 直し方 |
| --- | --- | --- |
| `sleep: ペアの新しい方の時刻を使う` | 左右の `lastActiveAt` の差（4 秒）が閾値（3 秒）と近すぎて、**両方とも期限切れ**になっていた。`pairLastActiveAt` が無くても 2 本とも寝るので、検査が空振りしていた | 閾値を 12 秒に上げ、右を触り直す前に 10 秒空ける。**「左だけが期限切れ」という前提が成立していること**を実測値で先に検査する |
| `再起動後: 分割が 2 組とも復元されている — pairs=0` | **復元先のウィンドウが 1 つとは限らない**（フル検証では 3 枚復元された）のに、先頭のサイドバーだけを見ていた | `verify-phase1.mjs` と同じく**全ウィンドウを走査**して分割を持つウィンドウを探す。あわせて `--restart-write` で `session.json` を読み返し、**書けていないのか読めていないのか**を切り分けられるようにした |

この 2 件目は**編集が保存されずに 2 周空回りした**。1 本の python スクリプトで 4 か所を置換し、
最後の `write_text` の**手前**の assert で落ちていたので、成功した 3 か所も書かれていなかった
（`ok` が出ないまま次の作業に進んでしまった）。**複数箇所の置換は 1 か所ずつ確定させる**。

**左のペインを閉じるとクラッシュしていた（`verify:ext` が先に踏んだ）**

ペアを解くところで `tab.split` を**消しながら読んで**いた:

```ts
tab.split.left.split = null   // 自分が左なら、この行で tab.split が null になる
tab.split.right.split = null  // → TypeError: Cannot read properties of null
```

**右を閉じるときだけ無事**（1 行目で消えるのは相方の側）なので、
「⌘W で右を閉じる」検査だけでは素通りしていた。`verify:ext` が
分割を作って `closeTab(左)` したところで初めて出た。
`removeTab` と `moveTabToWindow` の両方を「ペアを控えてから消す」に直し、
**左を閉じる経路の検査**を `verify-split.mjs` に足した
（直す前は同じ TypeError で落ちることを確認済み）。

**`--restart-write` で `resetTabs()` を呼んで phase1 の fixture を壊した**

同じ再起動に phase1（セッション復元）と pins（遅延ロード）の書き込みが相乗りしているので、
既存のタブを片付けてはいけなかった。書き込み側は**足すだけ**にする。

**Phase 0 スパイク（`scripts/spike-split-chrome.mjs`）の結果**

1. **子 View は親 View の角丸でクリップされない**。`View.setBorderRadius()` は
   その View 自身の描画にしか効かず、子の `WebContentsView` は四角いまま角を突き抜ける
   （PNG で目視確認済み）。→ 決定どおり **`SPLIT_RADIUS = 0`**（角丸なし・隔間と外周余白だけ）。
   器 View そのものが不要になったので、ページとツールバーは `contentView` の直下のまま置く
   （`WeakMap` での親の追跡も不要）
2. **フォーカス枠は出る**。素の `View` に背景色を置いて 2px 大きく敷く方式で意図どおり描かれた
3. **`webContents.on('focus')` は使えない**。`sendInputEvent` / CDP の合成クリックでは
   native のフォーカスが移らず、背面 View の `focus` が**飛ばない**
   （`webContents.focus()` の明示呼び出しでは飛ぶ）。
   → **`webContents.on('input-event')` の `mouseDown`** を使う。これは WebContents の
   入力パイプラインを通るので、実クリックでも合成クリックでも同じように飛ぶ（スパイクで確認）。
   ただし `input-event` は**マウス移動でも飛ぶ**ので、
   **「見えている分割の 2 本」にだけ付け外しする**（`applyVisibility()` で管理）

### 方針変更

- **器 View そのものを作らなかった**。角丸を捨てた（`SPLIT_RADIUS = 0`）ことで器を挟む理由が
  無くなったので、ページとツールバーは今までどおり `contentView` の直下に置いている。
  Phase 2 にあった `WeakMap` での親の追跡・reparent のヘルパは**不要になったので作っていない**
- **`SplitPair` の生成だけを行う `linkSplit` を export した**。セッション復元
  （`src/main/index.ts`）から呼ぶため。`splitTabs` は `linkSplit` + 選択という形になっている
- **行に `data-key` を出した**。自走検証が D&D を撃つ行を並び順から当てるのは壊れやすいので、
  タブ key で直接引けるようにした
- **`verify-phase1.mjs` の「復元直後のタブは sleep 状態」を更新した**。
  アクティブタブに加えて**分割の相方も起きている**のが正しいので、除外対象に足した
- **角丸をやめた**（`SPLIT_RADIUS = 0`）。Phase 0 で「子 View は親の角丸でクリップされない」と
  確定したため、決定表の「角丸が作れないとき」の分岐に入った。
  これに伴い **Phase 2 の器 View・`WeakMap` での親の追跡・reparent の手順は丸ごと不要**になった
  （ページとツールバーは今までどおり `contentView` の直下）
- **フォーカス検出を `focus` から `input-event` の `mouseDown` に変えた**。
  合成クリックで `focus` が飛ばず、自走検証で撃てないため（上のログ 3 を参照）
- **分割中の左ツールバーの信号機ぶんの余白を 82px → 74px にした**（`.inset-split`）。
  左ペインは窓の左端から `SPLIT_INSET`（8px）右に始まるので、82px のままだと
  戻る / 進むが 8px 余分に右へ寄る。DESIGN.md の該当行も直した（`/polish-impl` の指摘）
- **右ペインのツールバー View に地色（`--nemo-sidebar` の実値）を敷いた**。
  遅延生成して同じ `layout()` の中で表示するため、`loadURL()` が終わるまでの数フレームだけ
  WebContents の既定色（白）が出る。Peek のプレースホルダーと同じ穴（`/polish-impl` の指摘）
- **結合行の非表示時にフォーカス側を示さない**（`/polish-impl` の Q への回答: 見送り）。
  ペアを表示していない間は両チップとも素の面にする（`focused={visible && ...}`）。
  薄いアクセントを残すと「今フォーカスがある」と紛らわしく、
  ズレが効くのは ⌃M / ⌃Tab / ⌘数字 で戻る経路だけで、戻った瞬間に枠とチップで分かる
- **Peek で覗いた PR も Live Folder の既読にした**（`/polish-impl` の Q への回答: 「どっちでもいい。実装楽な方で」）。
  未読落としを `visibleTabKeys` 基準に変えた副作用で、フォーカス中タブの Peek の URL も
  `markLiveFolderRead()` の対象に入った。従来は `getActiveTab().url` だけだったので
  Peek で覗いても未読が残っていた。**除外する側が高くつく**（`applyVisibility` と
  `startBackgroundWork` の `activeUrls` の両方に `tab.peekOf === null` を足す必要があり、
  片方だけだと落としたそばから付け直される）ので、現状のまま「見えているものは既読」で統一する。
  決定表に行を足した
- **`NemoTab.sleep()` でも `paneFocusOff` を落とすようにした**。今は「見えていないと寝ない」ので
  寝る前の非表示化で既に外れており**この経路は踏まない**（外して検証しても PASS するのを実測）。
  `removeTab` / `moveTabToWindow` と後始末を揃えて、寝る条件を将来触ったときに
  黙って壊れないようにするための保険（`/polish-impl` の指摘）
