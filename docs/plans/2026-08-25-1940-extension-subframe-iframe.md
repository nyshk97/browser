# 拡張の web_accessible_resources な iframe をページ内に通す（Bitwarden のインライン候補）

## 概要・やりたいこと

ログイン画面の input にフォーカスしたとき、**入力欄の下に出るログイン候補**（Bitwarden の
インラインオートフィルメニュー）が Nemo では出ない。Chrome / Arc では出ていたもの。

原因は Nemo 側にある。ページ側 WebContents の `will-frame-navigate` ガードが
`chrome-extension://` を**一律で拒否している**ため、Bitwarden がページに挿し込む
メニューの iframe が読み込めない。

**サブフレームに限って `chrome-extension:` を通す**ようにして、この経路を開ける。
トップレベル遷移（Web ページ → 拡張ページ）の封鎖は今のまま維持する。

### スコープ外（今回はやらない）

同じ調査で見つかった次の 2 つは**別 plan にする**（このファイルでは扱わない）:

- ツールバーのアイコンにパスワード件数のバッジが出ない
- 拡張アイコンを押してから popup が出るまで数秒かかる

どちらも **service worker が 45〜50 秒で idle 停止し、イベントのたびに
Bitwarden がフル初期化をやり直している**ことに起因する。バッジの表示経路
（`setBadgeText` の tabId 付き・タブ切替の追従）は実測で正常だったため、
Nemo 側のバグとしてはまだ確定していない。**先にこの plan を入れてから、
実 vault で再確認して切り分ける**。

## 前提・わかっていること

### 何が落ちているか（実測・2026-08-25）

一時プロファイルに実 Bitwarden 2026.8.0 をロードして CDP で観測した。

| 見たもの | 結果 |
|---|---|
| content script の注入 | **入っている**（ページの実行コンテキストに `Bitwarden Password Manager` の isolated world がある） |
| `chrome.runtime.sendMessage`（content script → SW） | **届く**（`triggerAutofillScriptInjection` を SW 側で受信） |
| `chrome.scripting.executeScript`（files / world: ISOLATED） | **通る**（`bootstrap-autofill-overlay.js` の注入が成功する） |
| ページに `chrome-extension://` の iframe を挿す | **読み込まれない**（dynamic URL / 静的 ID の両方が timeout） |

Nemo の診断ログにブロックが残っていた:

```
{"event":"navigation.blocked","phase":"will-frame-navigate",
 "target":"chrome-extension://0b7c6bfb-c70e-456f-983f-46249db7a010"}
{"event":"navigation.blocked","phase":"will-frame-navigate",
 "target":"chrome-extension://nngceckbapebfimnlniiiahkandclblb"}
```

**注入までは全部通っていて、最後の iframe だけが落ちている**。

### Bitwarden のインラインメニューは iframe で出来ている

`manifest.json` の `web_accessible_resources`:

```json
{ "resources": ["overlay/menu-button.html", "overlay/menu-list.html", ...],
  "matches": ["<all_urls>"], "use_dynamic_url": true }
```

content script がページに `menu-button.html` / `menu-list.html` を iframe として挿し、
その中に候補リストを描く。**iframe が読めない限り候補は絶対に出ない**。

### ホスト名では照合できない（`use_dynamic_url: true`）

`chrome.runtime.getURL('overlay/menu-button.html')` が返すのは

```
chrome-extension://0b7c6bfb-c70e-456f-983f-46249db7a010/overlay/menu-button.html
```

で、**ホストが拡張 ID ではなくセッションごとに変わる UUID** になる
（`use_dynamic_url: true` の resource は Chromium がこの形にする）。
UUID から拡張 ID を引く Electron 側の API は無いので、
`loadedExtensionIds.has(hostname)` 方式の照合は**構造上できない**。

→ サブフレームについては**ホスト照合をせずに `chrome-extension:` を通す**。

### なぜ通してよいか

1. **どの拡張ページを iframe にできるかは Chromium が強制している**。
   `web_accessible_resources` に列挙されていない resource は、Nemo が通しても
   Chromium 側で `net::ERR_BLOCKED_BY_CLIENT` になる。Nemo のガードは
   その手前で二重に閉じているだけで、閉じ方が粗い

   **この修正の安全性はここに全面的に依存する**（Nemo 側は、拡張が 1 つでもロードされていれば
   ホストもパスも問わず `chrome-extension:` のサブフレームを通すようになる）。
   Electron / Chromium 側の挙動が変わって popup・options・内部ページまで
   埋め込めるようになっても気づけない検査では困るので、
   **公開していないページが読めないことも CI で固定する**（Phase 1）
2. **Nemo は lock された artifact しかロードしない**（`extensions.lock.json` が allowlist）。
   任意の拡張が入ってくる余地が構造上ない
3. 緩めるのは**サブフレームだけ**。`will-navigate` はメインフレーム専用なので触らない。
   `will-frame-navigate` も `isMainFrame === true` のときは今の判定のまま

### ブラウザ UI（`ui-view.ts`）は緩めない

`src/main/ui-view.ts:66` にも同じガードがあるが、こちらは `nemo://ui/` を載せる
UI View 用。UI のセッション（`persist:nemo-ui`）には content script も入らないので、
**拡張の iframe を UI に入れる必要がそもそも無い**。`window.nemo` が同居する面なので
ここは閉じたままにする。

### 触る場所

| ファイル | 何をするか |
|---|---|
| `src/shared/navigation-policy.js` | `isNavigableUrl` のポリシー（JSDoc の typedef）に「サブフレーム」を足す |
| `src/main/security.ts:56` `interface NavigationPolicy` | **TypeScript 側にも同名の別定義がある**。ここにも足さないと型検査で落ちる |
| `src/main/security.ts:369` `applyWebContentsSecurityDefaults` | `will-frame-navigate` と **`will-redirect`** の両方で `isMainFrame` を見る |
| `src/main/ui-view.ts` | **触らない**（UI View は今のまま） |

`WebContentsWillFrameNavigateEventParams` に `isMainFrame: boolean` があることは
Electron 41 の型定義で確認済み（`electron.d.ts:23776`）。

**`will-redirect` も要る**（実装中に判明・ログ参照）。`use_dynamic_url: true` の resource は
UUID の URL から**静的 ID の URL へリダイレクトして解決される**ため、
`will-frame-navigate` だけ通しても `will-redirect` で切られて `net::ERR_ABORTED` になる。
`will-redirect` も `will-frame-navigate` と同じく**イベント本体の `event.url` /
`event.isMainFrame`** を読む（`WebContentsWillRedirectEventParams`。
位置引数の `(event, url, isInPlace, isMainFrame, ...)` でも同じ値は取れるが
型定義で `@deprecated` なので使わない）。

### 検査を作るときに踏む罠（レビューで判明）

#### 既存の「content script が iframe にも入る」検査を巻き添えにする

`scripts/verify-ext-smoke.mjs:154` は `/iframe.html` の**直下の iframe を全部**見て、
印がすべて `frame` であることを要求している。test-extension の content script は
`all_frames: true` なので、**ページに無条件で拡張 iframe を挿すと `cross-origin` が混ざって
既存検査が FAIL する**（この plan の修正が入ったあとも落ち続ける）。

→ 拡張 iframe を挿すのは**専用のテストページ（`/war-frame.html`）でトップフレームのときだけ**にする。
あわせて既存検査の対象を `/login.html` の iframe に限定して、将来の巻き添えも塞ぐ。

#### `load` イベントは「読めたこと」の証明にならない

親ページは同一生成元制約で拡張 iframe の中を読めない。しかも **iframe の `load` は
エラードキュメントでも発火しうる**ので、`load` を見ても素通ししたのか中身が動いたのか区別が付かない
（今回の実測ではブロック時は `timeout` だったが、ブロックの仕方が変われば `load` に化ける）。

→ 拡張側の `frame.html` から**外部スクリプト**（`frame.js`。拡張ページの CSP で inline は不可）で
`parent.postMessage` を返し、**nonce の一致**で「拡張ページのスクリプトが実際に走った」ことを示す。

#### 検査拡張も `use_dynamic_url: true` にする

今回の中心は**ホストが拡張 ID ではなく UUID になること**。テスト拡張が静的 ID のままだと、
実装がホスト allowlist 方式に戻っても検査が通ってしまう。

→ test-extension の `web_accessible_resources` にも `use_dynamic_url: true` を付け、
**iframe のホストが lock の `id` と異なる**ことを実測値として出す。

#### トップレベル拒否検査だけでは `isMainFrame` の配線ミスを検出できない

`will-frame-navigate` は `will-navigate` より**先に**発火する。仮に全フレームを
subframe 扱いする配線ミスをしても、トップレベル遷移は後段の `will-navigate` が拒否するので
「拒否された」検査は PASS してしまう。

→ ブロックのログに `isMainFrame` を載せ、**`phase: will-frame-navigate` かつ
`isMainFrame: true` で拒否された記録があること**まで見る。

## 実装計画

### Phase 1: 先に検査で現象を捕まえる [AI🤖]

**修正前に FAIL することを確認してから直す**（通ることしか見ていない検査を作らない）。

- [x] ブロックのログに `isMainFrame` を載せる（`src/main/security.ts` の `guard`）。
      **これは検査の前提**なので Phase 2 ではなくここでやる
- [x] `test-pages/war-frame.html` を足す（拡張 iframe を挿す**専用ページ**。
      既存の `/iframe.html` の検査を巻き添えにしないため）
- [x] `test-extension/frame.html` と `test-extension/frame.js` を作る（**公開する側**）
  - [x] `frame.js` は `location.search` の `nonce` を読み、
        `parent.postMessage({ nemoWar: nonce }, '*')` を返すだけ
  - [x] 拡張ページの CSP で inline script は使えないので**必ず外部ファイル**にする
- [x] `test-extension/private-frame.html` と `test-extension/private-frame.js` を作る
      （**公開しない側**。中身は上と同じ handshake。`web_accessible_resources` に**列挙しない**）
- [x] `test-extension/manifest.json` に `web_accessible_resources` を足す
  - [x] `resources: ["frame.html", "frame.js"]` — **`private-frame.*` は入れない**
  - [x] `matches: ["http://127.0.0.1/*", "http://localhost/*"]`
  - [x] **`use_dynamic_url: true`**（ホストが UUID になる経路を CI でも踏む）
- [x] `test-extension/content.js` に、**トップフレームかつ `/war-frame.html` のときだけ**
      走る処理を足す
  - [x] 公開側 / 非公開側の**両方**を、別々の nonce で iframe として挿す
  - [x] `message` を受けて nonce が一致したら該当側の属性に `ok` を立てる
        （`data-nemo-ci-war` / `data-nemo-ci-war-private`）
  - [x] 公開側 iframe の実ホスト（UUID かどうかを見るため）を `data-nemo-ci-war-host` に残す
  - [x] 一定時間で返らなければ `timeout` にする（**両方を並行して待つ**。
        非公開側の待ちで公開側の判定を遅らせない）
- [x] `scripts/verify-ext-smoke.mjs` に検査を足す
  - [x] **公開した拡張ページのスクリプトが実際に走る**こと（`data-nemo-ci-war === 'ok'`。
        `load` イベントでは判定しない）
  - [x] **公開していない拡張ページは読めない**こと（`data-nemo-ci-war-private === 'timeout'`。
        可能なら CDP の `Network.loadingFailed` で `ERR_BLOCKED_BY_CLIENT` まで裏取りする）
  - [x] **iframe のホストが lock の `id` と異なる**こと（UUID 経路を踏んでいる実測値として出す）
  - [x] **ページから拡張ページへのトップレベル遷移は拒否される**こと
  - [x] そのとき **`phase: will-frame-navigate` かつ `isMainFrame: true` の拒否ログが残る**こと
        （`will-navigate` だけで止まっていると配線ミスを見逃す）
  - [x] 既存の「content script が iframe にも入る」検査の対象を
        `/login.html` の iframe に限定する（将来の巻き添えを塞ぐ）
- [x] `mise run verify:ext` を回し、**公開側の検査が FAIL することを確認する**。
      FAIL の出力（`navigation.blocked` のログ込み）をこの plan のログに貼る

  この時点では**非公開側の検査は PASS するが、それは何も証明していない**。
  修正前は Nemo のガードが公開・非公開を問わず止めるので、
  一時公開しても timeout のままで区別が付かない。
  **非公開側の妥当性確認は Phase 3 に置く**（修正後でないと成立しない）。

### Phase 2: サブフレームだけ通す [AI🤖]

- [x] `src/shared/navigation-policy.js`
  - [x] `NavigationPolicy`（JSDoc typedef）に `subframe?: boolean` を足す
  - [x] `isNavigableUrl` で「`subframe` かつ `chrome-extension:` かつ
        **拡張が 1 つ以上ロードされている**」なら許可する。
        ロード済みが 0 件のときは今までどおり拒否する（保険）
  - [x] なぜホスト照合をしないのかを、上の「なぜ通してよいか」の要約としてコメントに残す
- [x] `src/main/security.ts:56` の `interface NavigationPolicy` にも `subframe?: boolean` を足す
      （**JS 側の typedef と二重定義になっている**。片方だけだと型検査で落ちる）
- [x] `scripts/navigation-policy.test.mjs` にユニットテストを足す
  - [x] サブフレームなら未知のホスト（UUID）の `chrome-extension:` を許可する
  - [x] **メインフレームでは今までどおり拒否する**
  - [x] 拡張が 1 つもロードされていなければサブフレームでも拒否する
  - [x] `javascript:` / `file:` / `data:` はサブフレームでも拒否する（緩みの巻き添え防止）
- [x] `src/main/security.ts` の `applyWebContentsSecurityDefaults`
  - [x] `will-frame-navigate` のハンドラで `event.isMainFrame` を見て
        `subframe: !event.isMainFrame` を policy に渡す
  - [x] **`will-redirect` にも同じサブフレーム判定を渡す**（当初は「変更しない」としていた。
        `use_dynamic_url` はリダイレクトを挟むので、ここを落とすと iframe が `ERR_ABORTED` になる）。
        `will-frame-navigate` と同じく**イベント本体の `event.url` / `event.isMainFrame`** を読む
        （位置引数は Electron 側で `@deprecated`）
  - [x] `will-navigate` は変更しない（メインフレーム専用なので `subframe` は常に false）
- [x] `scripts/test-server.mjs` に **302 リダイレクトの endpoint**（`/__nemo_redirect__?to=`）を足す
      （`location.href` の遷移は `will-frame-navigate` しか踏まないので、
      `will-redirect` のトップフレーム側はこれでしか検証できない）
- [x] `scripts/verify-ext-smoke.mjs` に、その 302 で拡張ページへ飛ばす経路が
      **`phase: will-redirect` かつ `isMainFrame: true` で止まる**ことの検査を足す

### Phase 3: 検証 [AI🤖]

- [x] `mise run check`（lint → typecheck → ユニットテスト）
- [x] `mise run verify:ext` — Phase 1 で足した公開側の検査が **PASS に変わる**こと。
      修正前 FAIL / 修正後 PASS の出力を並べてログに残す
- [x] 同じ実行で、**非公開側は修正後も読めないまま**であること
      （ここが PASS から FAIL に変われば、緩めすぎている）
- [x] **非公開側の検査が空振りしていないことを確かめる**（negative control）。
      Nemo のガードが開いた**この状態でしか成立しない**ので、必ず Phase 2 の後にやる:
  - [x] 通常の状態で非公開側が `timeout` で PASS すること
  - [x] `private-frame.*` を**一時的に `web_accessible_resources` へ足す**と
        handshake が届き、**その検査が FAIL に変わる**こと（FAIL 出力をログに残す）
  - [x] 一時変更を戻し、再び PASS すること
- [x] `mise run verify` — 回帰（`file:` / `javascript:` / `data:` の拒否、
      ブラウザ UI が外部ページへ遷移できないこと、が落ちていないか）
- [x] 実 Bitwarden を載せた一時プロファイルで、ページに挿した
      `chrome.runtime.getURL('overlay/menu-button.html')` の iframe が
      **読み込まれる**ことを確認する（修正前は timeout だった）

### 動作確認 [人間👨‍💻]

`mise run dev:nodebug` で実 Vault の Bitwarden を入れて確認する。

- [ ] ログイン済みのサイトのログイン画面を開き、**ユーザー名の入力欄にフォーカス**したとき
      入力欄の下に候補が出ること
- [ ] 候補をクリックして**実際に自動入力される**こと
- [ ] パスワード欄でも同じように出ること
- [ ] 候補が出ない場合は診断ログを見る。`navigation.blocked` が
      `phase: will-frame-navigate` で残っていなければ**この plan の範囲は効いている**
      （残っていなければ原因は別。スコープ外の service worker 側の話に移る）

### Phase 4: 記録 [AI🤖]

- [x] `docs/compat.md` に追記
  - [x] Bitwarden のインラインメニューは `web_accessible_resources` の iframe で出来ていること
  - [x] `use_dynamic_url: true` の resource はホストが UUID になり、拡張 ID で照合できないこと
  - [x] **`web_accessible_resources` に無い拡張ページは、Nemo が通しても Chromium が拒否する**こと
        （サブフレームを緩めてよい根拠。CI がこれを固定していることも書く）
  - [x] service worker が **45〜50 秒で idle 停止**し、`startWorkerForScope` を
        running 中に呼んでも **idle タイマーはリセットされない**こと（別 plan の前提になる実測）
  - [x] `chrome.storage.session` は SW の再起動をまたいで残ること
  - [x] `webNavigation.onCommitted` の `transitionType` が**空文字**で返ること
        （Bitwarden の「リロード検知」がこれで効かない）
- [x] `VERIFY.md` に「拡張の iframe（web_accessible_resources）」の確認手順を足す

## ログ

### 試したこと・わかったこと

**Phase 1: 修正前は狙いどおり FAIL した**（既存検査の巻き添えも無し）

```
PASS  content script が iframe にも入る — ["frame"]
FAIL  公開した拡張ページが iframe の中で走る（web_accessible_resources）
      — {"open":"timeout","hidden":"timeout","host":"253900e5-44b1-4250-8e9e-9adfeb207dc1"}
PASS  iframe のホストが拡張 ID と異なる（use_dynamic_url）
      — host=253900e5-… / id=pppmclidjlmhjjejjpggekoiicnkdlde
PASS  メインフレームの拡張ページ遷移が will-frame-navigate で止まっている — 該当ログ 1 件
```

**Phase 3: negative control が成立した**（非公開側の検査は空振りしていない）

`private-frame.*` を一時的に `web_accessible_resources` へ足すと、handshake が届いて
2 本とも FAIL に変わった。戻したら再び PASS。

```
（一時公開）FAIL  公開していない拡張ページは iframe で読めない — data-nemo-ci-war-private=ok
（一時公開）FAIL  公開していない拡張ページは Chromium に拒否される — open=ok / 0 件
（戻した）  PASS  公開していない拡張ページは iframe で読めない — data-nemo-ci-war-private=timeout
（戻した）  PASS  公開していない拡張ページは Chromium に拒否される — open=ok / 1 件
```

**実 Bitwarden でも iframe が読めるようになった**（実 artifact のコピーで実測。素の manifest のまま）

```
（修正前）getURL: chrome-extension://f109c431-…/overlay/menu-button.html
          iframe: timeout / loadingFailed: ["net::ERR_ABORTED"]
          ログ: {"event":"navigation.blocked","phase":"will-redirect", …}
（修正後）getURL: chrome-extension://f151be5b-…/overlay/menu-button.html
          iframe: load / responseReceived: 200 chrome-extension://nngceckb…/overlay/menu-button.html
          ログ: （navigation.blocked なし）
```

**`will-redirect` のトップフレーム側も negative control を通した**（レビュー指摘で追加）

`will-redirect` だけ「常にサブフレーム扱い」にしたバグ版を入れて `verify:ext` を回した:

```
PASS  ページから拡張ページへのトップレベル遷移は拒否される
PASS  メインフレームの拡張ページ遷移が will-frame-navigate で止まっている — 該当ログ 1 件
PASS  302 で拡張ページへリダイレクトさせても遷移しない — chrome-error://chromewebdata/
FAIL  メインフレームの拡張ページへのリダイレクトが will-redirect で止まっている — 該当ログ 0 件
```

**遷移結果（URL）を見る検査ではバグを捕まえられない**ことが分かった。Nemo のガードが緩んでも
Chromium が拒否するので、ページは `chrome-error://chromewebdata/` に落ちて
「遷移していない」ように見える。**ログを見る検査だけが FAIL した**。
Nemo 側のガードが効いているかを見たいなら、結果ではなく**どの段で止めたか**を見る必要がある。

**回帰**: `mise run check` 148 件 pass / `mise run verify` すべて PASS。

（`config-sync.test.mjs` が 1 度だけ "Promise resolution is still pending" で cancel されたが、
単体では 22 件 pass し、回し直したら再現しなかった。並列実行時の flaky で今回の変更とは無関係）

（フルの `verify` で 1 度だけタブスイッチャーの 2 件
「6秒待っても帯は出たまま」「待った後でも ⌃ を離せば確定する」が FAIL したが、
`verify:only switcher` では 19 件すべて PASS、フルを回し直しても「すべて PASS」。
**6 秒の待ちを含む時間依存の検査**で、今回の変更（ナビゲーション判定）とは経路が無い。
フル実行時にだけ揺れる flaky として記録しておく）

### 方針変更

**`will-redirect` も直した**（当初は「`will-navigate` / `will-redirect` は変更しない」としていた）。

`use_dynamic_url: true` の resource は、UUID の URL から**静的 ID の URL へ
リダイレクトして解決される**ことが実測で分かった。`will-frame-navigate` だけ通しても
`will-redirect` が素通しで拒否するため、iframe は `net::ERR_ABORTED` で落ちたままだった。

切り分けの経緯: テスト拡張から `use_dynamic_url` を外すと通る（→ dynamic URL 固有の問題）が、
実 Bitwarden のブロックは `ERR_BLOCKED_BY_CLIENT` ではなく `ERR_ABORTED` で、
ログに `phase: will-redirect` が残っていた（→ Chromium の拒否ではなく Nemo のガード）。
`will-redirect` に `isMainFrame` を渡したところ、**素の Bitwarden で 200 が返るようになった**。

これにより、当初検討していた「Bitwarden の manifest から `use_dynamic_url` を剥がす」
（lock した artifact を改変する）は**不要になった**。

**検査を 1 本足した**: 非公開側を `timeout` だけで見ると弱いので、
`net::ERR_BLOCKED_BY_CLIENT` まで確認する check を追加した。
ただし非公開側は `requestWillBeSent` が飛ばないまま落ちるので requestId から URL を引けない。
挿す iframe は 2 つだけなので、**公開側が `ok` であること**と組にして判定している。
