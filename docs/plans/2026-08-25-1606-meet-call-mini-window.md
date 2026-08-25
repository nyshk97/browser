# 会議の小窓（Meet の通話コントロール）

## 概要・やりたいこと

Google Meet の会議タブから離れているあいだ、**他アプリの上に浮く小さなバー**を出す。
そこから「会議タブへ戻る」「マイクの ON/OFF」「カメラの ON/OFF」ができるようにする。

今の困りごとは、会議中に他のアプリ（エディタ・Slack・資料）へ移ったあと、
**ミュートしたいだけなのに Nemo を前面に出してタブを探す**ことになる点。
Arc には同じものがあり、乗り換えの障害になっている。

Arc の実物（ユーザー提供のスクショ）は **Meet 自身の Document Picture-in-Picture** で、
Arc はそこへ自前のバー（戻る / チャット / Close）を被せている。
**この方式は Electron では成立しない**ことが実測で判明したので（後述 R0）、
自前の小窓 + Meet アダプタで作る。

## 前提・わかっていること

### Document PiP は Electron では使えない（実測済み・R0）

Electron 41.10.6 で確認した。**再調査は不要**。

```
HANDLER_REGISTERED true
OPEN_HANDLER other about:blank        ← setWindowOpenHandler には来る
MANUAL_RESULT {"ok":true,"inner":[0,0],"hasDoc":true}   ← document は出来るがサイズ 0
PIP_STATE  {"inner":[0,0],"closed":true,"cur":false}    ← 800ms 後には勝手に閉じている
PIP_WIN_CREATED false                 ← createWindow コールバックは呼ばれない
NO_GESTURE_RESULT {"ok":false,"err":"NotAllowedError: ... requires user activation"}
```

blink 側の API は生えているが Electron に PiP ウィンドウの実装が無いため、
**枠が作られず即終了する**。Peek / 小窓で使っている `createWindow` での横取りも効かない。
加えて user activation 必須なので「タブを離れたら自動で出す」も同じ経路では撃てない。

### コストの実測（Electron 41・同一 origin 条件）

| 測ったもの | 結果 |
|---|---|
| 小窓の `WebContentsView` 1 枚 | **+89MB**（レンダラプロセス +1） |
| panel ウィンドウ自体（View なし） | **+0.8MB**（誤差） |
| プローブ JS 1 回のメインプロセス CPU | **0.035ms** |
| → 1 秒ごとにポーリングした場合 | **CPU 0.0035%** |
| 正しく閉じたあと | ベース +3.6MB まで戻る |

```
BASE(3 UI views)       ws_mb   657.2 procs 7 {"Browser":1,"GPU":1,"Utility":1,"Tab":4}
+1 UI view (same win)  ws_mb   746.4 procs 8 → delta 89.2MB
+panel win (no view)   ws_mb   747.2 procs 8 → delta  0.8MB   ← ウィンドウは無料
+view in panel         ws_mb   835.9 procs 9 → delta 88.8MB
AFTER proper close     ws_mb   750.0 procs 8 → ベース+3.6MB
```

- `nemo://ui/` の**同一 origin にしてもプロセスは分かれる**。Electron は
  `WebContentsView` ごとに必ずレンダラを立てるので、89MB は別ウィンドウの避けられない値段
- **`win.destroy()` だけでは中の `webContents` が破棄されず 89MB が残る**（実測）。
  既存コード `registry.ts:1529` は `removeChildView` → `webContents.close()` の順で
  正しく処理しているので、**同じ作法に揃える**

**ポーリングが走る条件（当初の記述を訂正・R9）**。

「会議していない間はゼロ」と書いていたが、これは **Meet を開いていない間**の話で不正確だった。
Meet は**同じ URL・同じ document のまま**待機画面から会議へ移るので、
ナビゲーションイベントだけでは参加の開始を拾えない。**参加を検知する入口はプローブしか無い**。
`MutationObserver` を isolated world へ注入する手もある。
**注入そのものは方針に反しない**（既存のスワイプ判定が `executeJavaScriptInIsolatedWorld`
で同じことをしている。`registry.ts:834`）。採らない理由は別で、
**注入したコードには `ipcRenderer` が無く、変化を main へ push できない**こと。
スワイプが main へ通知せずページ内の `history.back()` で完結し、
Nemo 側は既存の `did-navigate` で拾っているのはこのためである。
push 経路を作るにはページ側 preload が要り、そこで初めて方針に触る。
観測結果を変数へ溜めてポーリングで回収する形は可能だが、
**取りに行く頻度は変わらないまま、注入の寿命管理（遷移・再読み込みでの貼り直し）だけが増える**。

正確には次の 3 段階になる。

| 状態 | プローブの頻度 | 実測 CPU |
|---|---|---|
| Meet のタブが 1 つも無い | **走らせない（ゼロ）** | 0% |
| Meet のタブはあるが参加していない | **5 秒ごと**（開始の検知だけが目的なので粗くてよい） | 0.0007% |
| 参加中 | **2 秒ごと** | 0.0018% |

いずれも実測 0.035ms/回 からの換算で、**測定限界以下**であることは変わらない。

### 現状のコード（調査済み）

| 項目 | 現状 |
|---|---|
| 小窓（Little Nemo） | `WindowKind = 'normal' \| 'mini'`。`registry.ts:2345` `openMiniWindow` 一式 |
| 小窓のウィンドウ | `type: 'panel'`（`registry.ts:1029`）。**`setVisibleOnAllWorkspaces` は呼ばない**（呼ぶと Dock アイコンが消える。全 Space 追従は panel の性質で付いてくる） |
| 小窓の提示 | `presentMiniWindow`（`registry.ts:2400`）。`showInactive()` → `focus()`。**`app.focus({ steal: true })` は絶対に撃たない** |
| UI View | `UiViewKind = 'sidebar' \| 'toolbar' \| 'overlay' \| 'peek' \| 'empty' \| 'mini'`。`createUiView`（`registry.ts:1081`）。`nemo://ui/` から配信（`protocol.ts`） |
| **UI View の生成とナビゲーション防御** | `createUiView` も `lockUiNavigation` も **`NemoWindow` のプライベートメソッド**。小窓から使うには切り出しが要る（R8） |
| **IPC の送信元検査** | `requireWindow`（`ipc.ts:70`）が `findWindowByUiWebContents`（`registry.ts:1556`）で**「`windowsById` に居るウィンドウが所有する UI か」を必須にしている**。独立した小窓から呼ぶと **`unknown_sender` で必ず弾かれる**（R8）。加えて `isUiUrl(senderFrameUrl(event))` で origin も二重に見ている |
| View の後始末 | `registry.ts:1529-1530` が `removeChildView(view)` → `view.webContents.close()` |
| sleep 判定 | `sweepSleep`（`registry.ts:2649`）。除外は「アクティブ」「Peek 持ち」「`isCurrentlyAudible()`」のみ |
| メディア権限 | `media-access.ts`。OS の TCC を `askForMediaAccess` で自分から取りに行く |
| ページの webPreferences | `PAGE_WEB_PREFERENCES`（`registry.ts:122`）。**ページ側 preload には特権 API を一切載せない** |
| 見た目の決めごと | `DESIGN.md`。ダーク固定・`--nemo-danger` `#ff6b6b` 等のトークンあり |
| 規模 | `src/**` で 11,307 行。`registry.ts` が約 2,800 行と最大 |

### `/dig` で決めたこと

| 項目 | 決定 |
|---|---|
| 方式 | 自前の小窓 + Meet アダプタ（Document PiP は使えないため） |
| 小窓の中身 | **コントロールのみの横長バー。映像は出さない** |
| 対応サービス | **Google Meet だけ**（他は後から足す） |
| 出る条件 | **会議タブが見えていないとき常に**（他アプリ作業中も、Nemo で別タブを見ている間も） |
| 位置 | 初回は画面右下。ドラッグ可・**動かした位置を覚える** |
| 重なり | **常に最前面**。他アプリのフルスクリーンの上にも出す |
| ⌘H したとき | **一緒に隠れる**（Electron に `canHide` 相当の API が無い。R1 の結論） |
| ボタン | **戻る / マイク / カメラ + ✕ の 4 つだけ**。**退出は置かない**（誤爆で会議を抜ける事故を原理的に消す） |
| テキスト | ドメイン名 + 経過時間（**参加を検知した時刻**からの経過。復元をまたぐと 0 に戻る） |
| 見た目 | 高さ 52px・ボタン 38px・ドメインと経過時間は **2 段**。切れているときは**面を沈めたままアイコンだけ `--nemo-danger` + 斜線**（DESIGN.md「会議の小窓」） |
| 状態の取得 | isolated world でプローブ JS を評価し `{参加中, マイク, カメラ}` を 1 本で取る（頻度は**未参加 5 秒 / 参加中 2 秒**。R9） |
| 操作 | Meet の `data-is-muted` を持つボタンを `click()`（言語非依存） |
| 縮退 | プローブが効かなければ **URL 判定に落ち、戻るボタンだけの小窓**になる + ログに残す |
| ✕ の後 | **会議タブに一度戻るまで出さない** |
| Meet タブが複数 | **小窓は 1 枚だけ**、直近の会議 |
| 設定項目 | **持たない**（設定を増やさない。逃げ道は ✕ で足りるとした） |
| 検証 | `test-pages` に偽 Meet を置いて自走検証に載せる |
| 実物の DOM | **検証用プロファイルで会議を立ててもらい**、CDP でダンプして解析する |

### 状態機械（coordinator）— R10

小窓は**アプリ全体で 1 つ**。ただし **coordinator が持つ状態は候補タブごと**にする。

**1 件だけ持つ設計にしてはいけない**。「`lastActiveAt` が最大のものを選ぶ」には
どのタブが参加中かを知っている必要があるが、対象 1 件しかプローブしないと
**「直近の Meet は未参加、古い Meet が参加中」のときに参加中の会議を見失う**。

```
candidates: Map<tabKey, CandidateState>
```

| `CandidateState` | 意味 |
|---|---|
| `generation` | そのタブが遷移する / 破棄されるたびに **+1**。プローブ応答の照合に使う |
| `inFlight` | プローブが走っているか（**single-flight**。同じタブへ同時に 2 本投げない） |
| `state` | `candidate`（Meet だが未参加）/ `joined` / `unknown`（プローブが読めない） |
| `joinedAt` | 参加を検知した時刻（経過時間の基点）。**一時的な `unknown` では消さない**（下記） |
| `degraded` | そのタブでプローブが読めず URL 判定に落ちているか |
| `dismissed` | そのタブについて ✕ で閉じられたか |

**候補の出入り**: Meet の URL になったタブを候補に加え、Meet でなくなる / タブが破棄されると外す。
候補が 1 つも無ければプローブは走らない。

**表示可能な候補**（`showable`）を先に定義する。以降「対象」はこの集合から選ぶ。

```
showable = 候補のうち、dismissed でなく、かつ次のどちらか
  (a) state === 'joined'
  (b) state === 'unknown'（縮退）かつ URL が Meet かつ
      「一度アクティブになった」**または**「参加中だと観測したことがある（joinedAt が残っている）」
```

**(b) の後半（`joinedAt` が残っている）を落としてはいけない**（実装中に自走検証が捕まえた）。
「一度アクティブになった」だけを条件にすると、**背面で参加した会議のプローブが
一時的に読めなくなった瞬間に除外が外れ、会議タブが寝て通話が切れる**。
前半（アクティブ経験）は R5 の誤爆よけ、後半は R3 の切断よけで、**目的が別**。

**表示対象**は `showable` のうち **`lastActiveAt` が最大のもの**。
対象が `showable` から外れたら（参加をやめた / タブが閉じた / ✕）、**残りから同じ規則で選び直す**。

**`joinedAt` は内部状態と UI 出力を分ける**。同じにすると
`joined` → `unknown` → `joined` の**一時的な失敗から復帰したときに、
同じ会議なのに経過時間が 0 へ戻る**（DOM の読み込み途中で普通に起きる）。

| | 規則 |
|---|---|
| 内部の `joinedAt` を**立てる** | `inCall: true` を初めて観測したとき |
| 内部の `joinedAt` を**保つ** | **`unknown`（プローブが読めない）の間はそのまま**。消さない |
| 内部の `joinedAt` を**消す** | `inCall: false` を観測 / URL が変わった / 候補から外れた の 3 つだけ |
| 再参加 | `inCall` が `false` → `true` になったら**新しい時刻を立て直す** |
| UI へ出す `CallState.joinedAt` | **縮退中（`degraded`）は `null` にマスクする**（内部は保ったまま） |
| 正常復帰したとき | **保っていた時刻をそのまま使う**（経過時間が続く。0 に戻らない） |

`CallState.joinedAt` は **nullable** で、**`null` のときは経過時間を出さない**（ドメイン名だけにする）。
縮退時は戻るボタンだけの見た目なので、経過時間も出さないほうが一貫する。
「0:00 のまま止まって見える」という誤解も生まない。

**`dismissed` はタブ単位**で持つ。対象が別のタブへ移ったら、
移った先の `dismissed` を見る（＝**前の会議で閉じたことが次の会議に持ち越されない**）。
「会議タブに一度戻る」で、そのタブの `dismissed` を解除する。

**競合の防ぎ方**（プローブの往復中に対象が閉じる・遷移する・別の Meet が選ばれる）:

- 撃つ前に `generation` を控え、**結果を反映する前に照合する**。ずれていたら**捨てる**
- タブの破棄 / URL 変更 / ウィンドウ破棄で `generation` を上げ、走っている応答を無効化する
- 候補から外れたタブの応答は、届いても**捨てる**

**89MB をいつ返すか**:

**破棄の条件は「対象が終わったとき」ではなく「`showable` が 0 件になったとき」**。
対象が終わっても別の候補が残っていれば、**同じ小窓を retarget する**（作り直さない）。

| 遷移 | 小窓 |
|---|---|
| 対象タブが見える → 見えない | **表示**（無ければ生成） |
| 見えない → 見える（戻った） | **hide のみ**（破棄しない。会議中は行き来が頻繁で、毎回 89MB を作り直すと出るのが遅れる） |
| ✕ で閉じた | **hide**（そのタブを `dismissed` にする）。**他に `showable` があればそちらへ retarget して出し直す** |
| 対象が `showable` から外れた・**他に候補あり** | **retarget**（同じ小窓のまま対象を差し替え、`CallState` を push し直す。**経過時間は移った先の候補が持っている `joinedAt` を出す**＝0 に戻さない） |
| **`showable` が 0 件になった** | **destroy**（`removeChildView` → `webContents.close()` → `win.destroy()`） |
| アプリ終了 | destroy |

### IPC 契約 — R8

既存の `requireWindow` は通せない（小窓は `windowsById` に居ない）。
**`windowsById` に無理に登録しない**（`sweepSleep` など既存の全ループがタブ前提で舐めており、
タブを持たないウィンドウを混ぜると壊れる）。専用の口を作る。

- `ipc.ts` に **`requireCallWindow(event)`** を足す。検査は `requireWindow` と**同じ二段**にする
  1. 送信元が **coordinator が持っている小窓の UI WebContents 自身**であること
  2. `isUiUrl(senderFrameUrl(event))` で origin を見ること（`senderFrameUrl` / `isUiUrl` は共有する）
- **renderer には tab key を持たせない**。`call:*` の IPC は**引数を取らず**、
  main 側の coordinator が現在の対象を解決する（renderer から任意のタブを触れる経路を作らない）

| チャンネル | 向き | 中身 |
|---|---|---|
| `call:getState` | R→M | `CallState` を返す |
| `call:state`（push） | M→R | `{ host, joinedAt: number \| null, micEnabled: boolean \| null, camEnabled: boolean \| null, degraded }`。**変化したときだけ**送る。**縮退時は 3 つとも `null`**（`null` = 不明。`false` と混同しない） |
| `call:focusTab` | R→M | 対象タブへ戻る |
| `call:toggleMic` / `call:toggleCam` | R→M | トグル。**結果は push を待つ**（楽観更新しない。Meet 側で弾かれることがある） |
| `call:dismiss` | R→M | ✕ |

**経過時間は renderer 側で数える**（`joinedAt` から）。1 秒ごとに IPC を撃たない。

`joinedAt` は**その候補が参加を検知した時刻**であって、小窓が出た時刻ではない。
**対象の切り替え（retarget）ではリセットしない**。候補ごとに持っている値を
そのまま出すだけなので、A → B へ移れば **B が参加した時刻**からの経過が出る。
0 から数え直すのは **`inCall` が `false` → `true` になった再参加のときだけ**。

**真偽の向きは `*Enabled` に統一する**（`micEnabled: true` = マイクが**生きている**＝ UI の「ON」）。
Meet の DOM は `data-is-muted="true"` が「切れている」で**向きが逆**なので、
**反転はアダプタの中の 1 か所だけ**で行い、そこから外へは `*Enabled` しか出さない。
`mic` のような向きの分からない名前は使わない（反転事故が起きて、しかも見た目では気づけない）。

### 位置の記憶

- 保存単位は **`{ x, y, displayId }`**。サイズは固定なので保存しない
- 保存の契機は **`moved` の終了時**（ドラッグ中に書き続けない）
- 初回・保存が無いときは **対象タブがあるウィンドウが載っている display の `workArea` 右下**
- 復元時、保存座標が**どの display の `workArea` にも収まらなければ**（モニタ切断・解像度変更）
  上の既定位置へ戻す。**画面外に出したまま復元しない**
- ストアは `json-store` を使い、**init / close を持つ**（他のストアと作法を揃える）
- バーの地は `-webkit-app-region: drag`、**各ボタンは `no-drag`**（押せなくなるため）

### 未解決の技術リスク

| # | リスク | 潰し方 |
|---|---|---|
| R1 | ~~**⌘H で panel を残せるか**~~ → **結論: 一緒に隠れる**。Electron の `BaseWindow` に `canHide` 相当の API が無い（`electron.d.ts` にあるのは `setHiddenInMissionControl` だけ）。仕様セクションを書き換えた |
| R2 | **panel + 常に最前面 + フルスクリーン追従の同居**。`setVisibleOnAllWorkspaces` は Dock アイコンが消えるので使えない | Phase 3 で `type: 'panel'` + `setAlwaysOnTop(true, 'floating')` を実測。フルスクリーンの他アプリの上に本当に出るかを目視で確認 |
| R3 | **会議タブが寝る**。`sweepSleep` は `isCurrentlyAudible()` しか見ないので、全員ミュートの静かな瞬間に会議タブが sleep する | Phase 3 で sleep / archive の除外条件に足す。対象は **`joined` または縮退条件を満たす `unknown`**（＝ `showable` の判定から `dismissed` を除いたもの）。**`dismissed` は関係させない**（✕ で小窓を閉じても会議は続いているので、寝かせたら会議が切れる）。**候補から外れたら除外も外す**（永久に寝ないタブを作らない） |
| R4 | **小窓の実装形態**。`NemoWindow` はタブを持つ前提で、会議小窓はタブを持たない | Phase 3 冒頭で判断。`registry.ts` に押し込まず **`call-window.ts` に切り出す**のを既定とする |
| R5 | **復元直後の誤爆**。縮退時（URL 判定のみ）、セッション復元された Meet タブで小窓が出てしまう | 「一度でもアクティブになったタブ」を条件に足す |
| R6 | **判定ホストの差し替え口**。自走検証に要るが、本番に裏口を残さない | **`NEMO_MEET_TEST_URL_PREFIX`（URL 単位）**にする。ゲートは **`!app.isPackaged`**。`isDevChannel` では**塞げない**（`paths.ts:18` は `app.isPackaged ? BUILD_CHANNEL : 'dev'` なので、**dev パッケージでも `isDevChannel === true`** になる） |
| R7 | **89MB のリーク**。開閉のたびに `webContents` が残ると会議のたびに漏れる | 閉じる経路を 1 本にまとめ、`removeChildView` → `webContents.close()` を必ず通す。検証で開閉 10 回してプロセス数が戻ることを見る |
| R8 | **小窓から IPC が通らない**。`requireWindow` が `windowsById` 所属を必須にしており `unknown_sender` になる。`createUiView` / `lockUiNavigation` も `NemoWindow` の内側 | 上の「IPC 契約」のとおり `requireCallWindow` を足す。**`windowsById` には登録しない**。View 生成とナビゲーション防御は**共通 factory に切り出して両者で使う**（防御を書き写さない） |
| R9 | **参加開始の検知経路がプローブしかない**。Meet は同じ URL・同じ document のまま待機画面から会議へ移る | 「Meet のタブがある間だけ」低頻度（未参加 5 秒 / 参加中 2 秒）でプローブする。停止条件: **タブが sleep / 破棄 / Meet 以外へ遷移したら止める**。開始・候補更新の契機は **`dom-ready` / `did-navigate` / `did-navigate-in-page` の 3 つ**（**`did-navigate` を必ず入れる**。bfcache 復帰では `dom-ready` が出ない。`registry.ts:867`） |
| R10 | **非同期プローブの競合**。1〜2 秒の往復中に対象が閉じる・遷移する・別の Meet が選ばれると、古い応答で小窓が復活する | 上の「状態機械」のとおり `generation` を照合し、ずれた応答は捨てる。プローブは single-flight |
| R11 | **テスト origin が既存検証を巻き込む**。`test-server.mjs` は `test-pages/` 全体を**単一ポート**から配信しているので、origin 単位で Meet 扱いにすると `index.html` や `login.html` まで候補になり、**フル検証中ずっと縮退小窓が出て他の検証に干渉する** | 差し替えを **URL の prefix 単位**にする（`${pages}/meet-fake.html`）。**「同じ origin の `index.html` は候補にならない」ことを検査に入れる**（prefix 判定が前方一致で緩んでいないかを見る） |

## 実装計画

### 事前準備 [人間👨‍💻]

- [ ] 検証用プロファイル（`NEMO_USER_DATA_DIR` を切った使い捨てでない方）で **Google にログイン**しておく
  - **常用インスタンスには触らない**（検証で常用を操作しない取り決め）

### Phase 1: 見た目を決める [AI🤖]

- [x] 単一 HTML のモックを scratchpad に作り、`open` で見せる（**返答に絶対パスを明記する**）
  - 案を数個並べる: ボタンの並び / ミュート中の表現（赤で塗る・斜線・アイコン差し替え）/ 高さ・幅 / 経過時間の置き場所
  - **縮退時の見た目**（戻るボタンだけになった状態）も並べて見せる
  - `DESIGN.md` のトークン（`--nemo-sidebar` `--nemo-danger` 等）と既存 `MiniBar` のトーンに合わせる
- [x] 決まった内容を `DESIGN.md` に「会議の小窓」節として追記する

### Phase 2 前の準備 [人間👨‍💻]

- [ ] 検証用プロファイルの Nemo で **Meet のテスト会議を立てて参加**しておく（自分ひとりでよい）
- [ ] そのまま放置して声をかける（以降 AI が CDP で読み取る。**操作はしない**）

### Phase 2: Meet の DOM を調べてアダプタを書く [AI🤖]

- [ ] CDP で会議タブに繋ぎ、DOM をダンプして次を特定する（**未実施**。既知の目印で先に実装した）
  - 「参加中」を表す、**言語に依存しない**目印
  - マイク / カメラのボタンと、その ON/OFF を表す属性（`data-is-muted` を第一候補とする）
  - マイクとカメラの**見分け方**（`data-tooltip-id` 等。`aria-label` は言語依存なので避ける）
- [ ] ミュート ON/OFF を実際に切り替えて、**属性が変わる様子を差分で確認**する（**未実施**）
- [x] `src/main/meet-adapter.ts`（仮）に、プローブ式と click 式を**リテラルの文字列 1 か所**にまとめて置く
  - Meet の UI が変わったときに**直す場所がここ 1 か所**になるようにする
  - プローブは **`{ inCall, micEnabled, camEnabled }`** を返し、**読めなかったら `null`** を返す（縮退の合図）
  - **`data-is-muted` の反転はこの中だけ**で行う（外へ出すのは `*Enabled` だけ。向きの事故を 1 か所に閉じる）
- [ ] 調べた DOM の実物（属性名と値の例）を plan のログに残す（**未実施**）

### Phase 3: 小窓の骨組み [AI🤖]

- [x] **R1 / R2 を先に実測する**（ここで仕様が変わりうるので最初に潰す）
  - `type: 'panel'` + `setAlwaysOnTop(true, 'floating')` でフルスクリーンの他アプリの上に出るか
  - `canHide = false` 相当が Electron から触れるか。無理なら仕様セクションを書き換える
- [x] **UI View の生成とナビゲーション防御を共通 factory に切り出す**（R8）
  - `createUiView` / `lockUiNavigation` を `NemoWindow` の外から使える形にし、**既存の呼び出しもそこへ寄せる**
  - **防御を書き写さない**（小窓側だけ緩い、という食い違いを作らない）
  - `UiViewKind` に `call` を足す
- [x] `src/main/call-window.ts` を作る（R4。`registry.ts` に押し込まない）
  - 小窓の生成 / 表示 / 非表示 / 破棄。**タブを持たない**軽量なウィンドウ。**`windowsById` には登録しない**
  - **閉じる経路は 1 本**にまとめ、`removeChildView` → `webContents.close()` → `destroy()` を必ず通す（R7）
- [x] 位置の記憶を実装する（上の「位置の記憶」節のとおり）
  - `json-store` に init / close 込みで置く。`moved` の終了時に保存
  - **どの display の `workArea` にも収まらない座標は既定位置へ戻す**
- [x] `src/main/call-coordinator.ts` を作る（R10。上の「状態機械」節のとおり）
  - **`Map<tabKey, CandidateState>`** で候補ごとに `generation` / `inFlight` / `state` /
    `joinedAt` / `degraded` / `dismissed` を持つ（**1 件だけ持つ設計にしない**。R10）
  - 表示対象は **`showable`**（上の定義。`joined` **と縮退の `unknown` の両方**を含む）のうち
    `lastActiveAt` が最大のもの。**`joined` だけに絞らない**
  - プローブは **single-flight**、結果反映前に `generation` を照合して**ずれたら捨てる**
  - 頻度は「Meet タブなし = 走らせない / 未参加 = 5 秒 / 参加中 = 2 秒」（R9）
  - 停止条件: タブが **sleep / 破棄 / Meet 以外へ遷移**したら止める
  - 開始・候補更新の契機: **`dom-ready` / `did-navigate` / `did-navigate-in-page` の 3 つ**
    （**`did-navigate` を必ず入れる**。`registry.ts:867` に「**bfcache から復元されると
    `dom-ready` は出ない**。それだけだと一度戻ったあと二度と効かない」と検証で踏んだ記録がある）
  - 「会議タブが見えていない」の判定（他アプリにいる / Nemo で別タブを見ている の両方）
  - 縮退時は URL パターン + **一度アクティブになったこと**（R5）
  - **一時的に `null` を返しただけで縮退へ固定しない**（DOM 読み込み途中に起こる）。
    正常値が返ったら縮退から**復帰する**
  - **`joinedAt` は内部と UI 出力を分ける**（上の表のとおり）。
    `unknown` の間は内部の時刻を**保ち**、UI へは `null` をマスクして出す。
    復帰したら**保っていた時刻をそのまま使う**（経過時間を 0 に戻さない）
  - 小窓の生成 / hide / **retarget** / destroy の使い分けを上の表どおりに実装する
    （**destroy は `showable` が 0 件のときだけ**）
- [x] IPC を足す（R8。上の「IPC 契約」節のとおり）
  - `ipc.ts` に `requireCallWindow(event)`（**送信元の同一性 + origin の二段**）
  - `call:getState` / `call:state`（push・**変化時のみ**）/ `call:focusTab` / `call:toggleMic` / `call:toggleCam` / `call:dismiss`
  - **引数を取らない**（renderer に tab key を持たせない）
- [x] `CallBar.tsx` を作る（Phase 1 のモックを写す）
  - 経過時間は **renderer 側で `joinedAt` から数える**（1 秒ごとに IPC を撃たない）
  - トグルは**楽観更新しない**（push を待つ）
  - 地は `-webkit-app-region: drag`、**各ボタンは `no-drag`**
- [x] 「タブへ戻る」を実装する（ウィンドウを前面に + そのタブをアクティブに。別ウィンドウ / 別 Space も辿る）
- [x] マイク / カメラのトグルを実装する（Phase 2 のアダプタを呼ぶ）
- [x] 会議中のタブを sleep / archive の除外に足す（R3）
  - 除外の述語は **`joined` または縮退条件を満たす `unknown`**（`dismissed` は**関係させない**）
  - 縮退条件は「アクティブ経験 **または** `joinedAt` が残っている」。
    **`joinedAt` の側を落とすと、背面で参加した会議がプローブ失敗の直後に寝る**（実際に踏んだ）
  - **「参加中でなくなったら外す」と書かない**。縮退中の `unknown` まで除外解除され、
    **プローブが一時的に読めなくなった直後に会議タブが寝る**
  - 除外を外すのは**候補から外れたとき**（Meet でなくなった / タブが破棄された / `inCall: false` を観測）
- [x] プローブが読めなかったときの縮退（ボタンを隠す + `log('call.probe_failed')`）

### Phase 4: 自走検証 [AI🤖]

- [x] `test-pages` に偽 Meet（`meet-fake.html`）を置く
  - 本物と同じ属性構造を持たせ、ボタンで `data-is-muted` が変わるようにする
  - 「参加していない」状態にも切り替えられるようにする（小窓が消えることを見るため）
- [x] 判定 URL の差し替え口を作る（R6 / R11）
  - **`NEMO_MEET_TEST_URL_PREFIX`（URL 単位）**。origin 単位にしない（既存検証を巻き込む）
  - ゲートは **`!app.isPackaged`**。`isDevChannel` では塞げない（dev パッケージでも true）
- [x] **`verify-all.mjs` の配線を通す**（ここが抜けると検証が一度も走らない）
  - `KNOWN_TARGETS`（`verify-all.mjs:46`）と `NEEDS_APP`（同 `:58`）に `call` を足す
  - **`startApp()`（同 `:134`）に `NEMO_MEET_TEST_URL_PREFIX` を渡す**。今は 3 変数しか渡していないので、
    ここを直さないと**アプリ側に届かない**（検証スクリプトへ渡しても意味が無い）
  - 値は**採番済みのページサーバのポートから動的に組む**（`${pages}/meet-fake.html`。固定値を書かない）
  - runner と実行順、`.mise.toml` の `verify:only` の help にも `call` を足す
- [x] `scripts/verify-call.mjs` を書く
  - 会議タブから離れると小窓が出る / 戻ると消える
  - マイク・カメラのボタンでページ側の属性が変わる（**押した結果をページ側で裏取りする**）
  - ページ側でミュートすると**小窓の表示が追従する**
  - ✕ で閉じたあと、会議タブに戻るまで再表示されない
  - 参加をやめると小窓が消える
  - **開閉を 10 回繰り返してプロセス数が元に戻る**（R7 のリーク検査）
  - プローブが `null` を返す状態にして、**戻るボタンだけに縮退する**
  - **会議タブが sleep しない**（R3。`tabSleepMinutes` を短くして確かめる）
    - **✕ で小窓を閉じたあとも寝ない**（`dismissed` を除外条件に混ぜていないこと）
    - **縮退中（`unknown`）でも寝ない**
    - **会議が終わったら寝るようになる**（除外が外れること。永久に寝ないタブを残さない）
  - **同じ origin の別ページは候補にならない**（R11。`index.html` を開いても小窓が出ないこと）
  - **競合**（R10）: プローブ中に対象タブを閉じる / 別の Meet へ切り替える → **古い応答で復活しない**
  - **複数 Meet**（R10）: 「直近の Meet は未参加・古い Meet が参加中」を作り、
    **参加中のほうが小窓に出る**こと（1 件しかプローブしない実装だとここで落ちる）
  - **`dismissed` はタブ単位**: 会議 A で ✕ → 会議 B へ移ると小窓が出る（持ち越さない）
  - **retarget**: 対象の会議が終わっても**別の会議が残っていれば小窓は消えず対象が入れ替わる**、
    かつ**そのとき経過時間が新しい会議のものになる**（`showable` が 0 件になって初めて destroy）
  - **縮退からの復帰**（一時的失敗で固定されないこと）:
    プローブが一度 `null` を返して戻るボタンだけになったあと、
    正常値へ戻ると**マイク・カメラのボタンが復活する**。
    **あわせて経過時間がリセットされていないこと**（復帰後の値が
    縮退前からの連続になっていること。0 に戻る実装だとここで落ちる）
  - **再参加では**逆に経過時間が **0 から数え直される**こと（保持と混同しない）
  - **縮退中は経過時間を出さない**（`joinedAt` が `null` のとき 0:00 を表示しない）
  - **bfcache**: Meet タブで戻る / 進むをして復帰したあとも候補として検知され続ける（`did-navigate`）
  - **位置**: ドラッグ後に保存される / 再起動で復元される / **画面外の座標を仕込むと既定位置へ戻る**
  - **`joinedAt` は候補ごとに持たれ、切り替えでリセットされない**
    - 会議 A → B へ切り替わると **B が保持していた経過時間**になる
    - B → A へ戻ると **A の経過時間が連続している**（0 に戻らない）
    - **`inCall` が `false` → `true` の再参加のときだけ** 0 から数え直す
  - **IPC の拒否**: 小窓以外の sender から `call:*` を撃つと `unknown_sender` で弾かれる（R8）
- [x] **検査が本当にバグを捕まえることを確認する（RED を採る）**
  - **素の `git stash` を使わない**。検証の配線ごと戻ってしまい、
    「検査が走らなかった」のか「検査が通った」のかが区別できなくなる
  - 手順は **「検査を先に配線して RED を採る」**か、
    **production 側の 1 行だけを明示的に戻して（`git stash push -- <対象ファイル>` 等）走らせる**
  - 少なくとも次の 3 つで RED を採り、**FAIL 出力を plan のログに貼る**
    - リーク検査 … `webContents.close()` を外すと落ちる
    - 複数 Meet … 対象を 1 件しかプローブしない実装だと落ちる
    - 向きの反転 … `data-is-muted` の反転を外すと落ちる
- [x] **`mise run package` → `mise run verify:packaged`** で裏口が塞がっていることを確認する（R6）
  - **環境変数を実際に渡して**偽 Meet の URL を開き、**小窓が出ないこと**まで見る
  - 「渡さずに起動して出なかった」では**塞がった証明にならない**
  - dev パッケージで確認すること（`isDevChannel === true` のまま `!app.isPackaged` で塞がる、が要点）
- [x] `mise run check` → `mise run verify` をフルで 1 回通す
- [x] `VERIFY.md` に手順を追記する（既存の構造・粒度に合わせる）

### 動作確認 [人間👨‍💻]

- [ ] 実際の Meet の会議で通しで確認する
  - 他アプリへ移ると小窓が出る / Nemo で別タブを見ているときも出る
  - **他アプリをフルスクリーンにしても小窓が浮いている**（R2）
  - ⌘H したときの挙動が仕様どおり（R1 の結論しだい）
  - マイク・カメラが実際に切り替わり、**Meet 側の表示と一致している**
  - 戻るボタンで会議タブに 1 クリックで戻れる
  - 会議を抜けると小窓が消える
  - 会議を数回やっても Nemo のメモリが増えていかない（R7）

## ログ

### 試したこと・わかったこと

**R1（⌘H で panel を残せるか）は「残せない」で確定**。Electron の `BaseWindow` に
`canHide` 相当の API が無い（`electron.d.ts` にあるのは `setHiddenInMissionControl` だけ）。
仕様を「一緒に隠れる」に落として `/dig` の表と DESIGN.md を書き換えた。

**Meet の実物 DOM はまだ突き合わせていない**（人が会議を立てる手順が未実施）。
アダプタは既知の目印で書いてある。差し替えは `meet-adapter.ts` の
`PROBE_SOURCE` / `buildToggleSource` の 2 か所だけで済む。

| 見ているもの | 使った目印 |
|---|---|
| 参加中 | `[data-participant-id]` / `[data-initial-participant-id]`（待機画面には無い） |
| マイク / カメラ | `[data-is-muted]` を持つ要素。**`true` = 切れている** |
| マイクとカメラの見分け | Material Icons の合字テキスト（`mic` / `mic_off` / `videocam` / `videocam_off`）。取れなければ DOM 順に落とす |

`aria-label` は言語依存なので使っていない。

**`registry.ts` の `destroy()` が `toolbarView` を閉じていなかった**（`chromeView` /
`overlayView` / peek / empty だけを回していた）。UI View を共通 factory へ寄せたついでに、
後始末も `disposeUiView()` の 1 経路にまとめて `toolbarView` を足した。
ウィンドウを閉じるたびにレンダラが 1 つ残っていたことになる。

**自走検証の RED を 3 つ採った**（検査がバグを本当に捕まえること）。
production の 1 か所だけを壊してフルの `verify:only call` を回している。

| 壊した場所 | 落ちた検査 |
|---|---|
| `disposeUiView()`（`webContents.close()`）を外す | `✕ で小窓が消える` ほか **11 件**。リーク検査は `base=9 after=11` |
| `tick()` を「`lastActiveAt` が最大の 1 件」しかプローブしないようにする | `未参加だった会議に参加すると検知される` / `retarget で小窓を作り直していない（destroy 3 → 4）` ほか **4 件** |
| `data-is-muted` の反転を外す（`!== 'true'` → `=== 'true'`） | `マイクもカメラも ON として出る`（`mic":"false","cam":"false"`）/ `ページ側でミュートを解除すると小窓が追従する` の **2 件** |

**自走検証がバグを 1 つ捕まえた**（下の「方針変更」に詳細）。
`call.probe_failed` の直後に `tab.slept` が出て、会議タブが寝た。

**偽 Meet のボタンは user gesture 付きで押す必要がある**。
`location.href = ...` を user activation 無しで撃つと Chromium が
**クライアントリダイレクト扱いにして履歴エントリを置き換える**ので、そのあと「戻る」が効かない。
bfcache の検査が「戻れていないだけ」で落ちて 1 往復溶かした。

**CDP の応答は時間で切り上げる**。タブが sleep すると target ごと消え、
`Runtime.evaluate` の応答が永久に返らない（検査が 1 つ落ちただけで検証全体が固まった）。

### 方針変更

**`showable` の縮退条件に「`joinedAt` が残っている」を足した**（R3 / R5）。

当初は「`state === 'unknown'` かつ**一度アクティブになったことがある**」だけだったが、
自走検証の「縮退中でも会議タブは寝ない」が FAIL した。診断ログにそのまま出ている:

```
{"event":"call.probe_failed","key":"8e84a110-…"}
{"event":"tab.slept","key":"8e84a110-…","windowId":1}
```

背面で参加した会議（＝一度もアクティブになっていないタブ）のプローブが読めなくなると、
除外条件から外れて **3 秒後に寝て通話が切れる**。R3 が「参加中でなくなったら外す、と書くな」と
警告していたのと同じ穴に、`everActive` の側から入り込んでいた。

条件を「アクティブ経験 **または** `joinedAt` が残っている」に直した。
前半は R5 の誤爆よけ（復元直後の Meet タブで小窓を出さない）、
後半は R3 の切断よけで、**目的が別**なので両方要る。仕様セクションも書き換えた。

**位置の検証は「保存」と「復元」で手段を分けた**。`moved` は CDP から合成できないので、
- 復元側 … `--position-plant`（アプリを止めてから `call-window.json` に**画面外の座標**を書く）
  → 再起動 → `--position-read` で `call.position_out_of_range` と既定位置への復帰を見る
- 判定そのもの … `fitsAnyWorkArea()` を `shared/settings-schema.js` の純粋関数に切り出し、
  収まる / はみ出す / モニタを外した / モニタが 0 枚、をユニットテストで両方向から見る

**仕込みはアプリを止めてから行う**。起動中に書くと終了時の `closeCallWindowStore()` が上書きする。

