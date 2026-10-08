# kypr の URL の無いワンタイムコードを「このページを URL に足して入れる」で紐づける

## 概要・やりたいこと

Nemo で kypr の 6 桁のコード（TOTP）がページに入らず、毎回コピーして手で貼っている。
会社貸与 PC の診断ログ（9/28〜10/8）では `kypr.fill_totp` が 3 回とも `url-mismatch`、ログイン直後の自動コピー（`after-login`）は 0 回。
iPhone の QR 読み取りや Google Authenticator からの移行で入れたコードは URL が空になり、照合（URL が合うページにだけ入れる）に一度も合わないのが原因と推定した。

照合はフィッシング対策としてわざと入れた決めごとなので残し、**ポップアップから URL の無い（合わない）コードを押したときに
「このページ（<ホスト>）をこのコードの URL に足して入れる」を出し、ユーザーが押したら URL を保存してから入れる**。
一度足せば次からはそのページで入り、ログイン直後の自動コピーも動く。

## 前提・わかっていること

### 決定事項（会社貸与 PC のセッションの調査で確定。2026-10-08）

| 論点 | 決定 |
| --- | --- |
| 照合 | **残す**。照合をやめてもログイン直後の自動コピーは「どのコードか」が決まらず動かない |
| URL の無い（合わない）コードを押したとき | **黙ってコピーに回さない**。「<ホスト> をこのコードの URL に足して入力」と「コピーだけ」を出す。今は失敗しても URL が無いせいだと分かる手がかりが無く、コードを足すたびに同じことが起きる。自分で選んだコードをそのページで確かめて紐づけるので、照合の決めごとは崩れない |
| 足す URL | **入れる先のフレームのオリジン**。`match` は null（登録可能なドメイン単位。`kyprTotpDraftFrom` と同じ形）。既存の URL の後ろに足す |
| コピーだけ | 選べるようにして、今のコピーの経路（`kyprCopyTotp`）を残す |
| 保存 | `saveKyprItem`（TOTP の編集。既存の平文に重ねるので知らないキーは残る）を通す。足す関数は main に置き、renderer に秘密鍵を渡さない |

### 決定事項（この plan で決めたこと）

| 論点 | 決定 |
| --- | --- |
| UI の形 | ポップアップの下に出る**確認の帯**（`kypr-offer`。トーストと同じ位置に、文言・「<ホスト> を URL に足して入力」・「コピーだけ」・閉じる）。一覧（「このページ」・「コード」）と詳細のどちらから押しても同じ帯を出す（コードの押し口はパネルの `fillTotp` 1 つなので、帯もパネルに 1 つ置く）。画面を移る・別のコードを押すと消える |
| ページが変わったとき | 帯に出したオリジンを renderer から返してもらい、**main が入れる直前のフレームのオリジンと一致するときだけ足す**。違えば足さず、新しいオリジンで帯を出し直す（確かめたページと別のページに紐づけない） |
| Claude のウィンドウ | **足さない（今どおりコピー）**。帯も出さない。Claude が開いたページに URL を紐づける入口を増やさない安全側（必要になったら行を変える） |
| 別のサイト用の URL が付いたコード | 帯は出すが、**今付いている URL のホストを見せて**「このコードは <今のホスト> 用です。<ホスト> にも足しますか？」と聞き、**主ボタンを「コピーだけ」**にする（「<ホスト> にも足して入力」は脇のボタン）。フィッシングのページで押して紐づけない・見覚えのないドメインに気づけるように（polish-impl の後でユーザーが決定） |
| 同じオリジンがもう URL にある（照合の方式が違って合わない） | 足しても同じなので帯を出さずにコピー（polish-impl の 1 回目で決定） |
| URL の保存に失敗（競合・オフライン等） | 入れずにコピーに回す（ユーザーは何も編集していないので保存の失敗の文言は出さない。polish-impl の 1 回目で決定） |
| 読み取り専用（オフライン） | 足せないので今どおりコピー |
| 足したあと欄が無かった | URL は足したまま、コピーに回す（`copied: true` と `urlAdded: true`） |
| 1 桁ずつの欄 | 今回はやらない（Heroku は 1 つの欄。原因ではない） |

### 経路ごとの挙動（決定表）

| 経路 | 呼び出し元 | 照合に合う | 合わない・普段のウィンドウ（書ける） | 合わない・読み取り専用 | 合わない・Claude のウィンドウ |
| --- | --- | --- | --- | --- | --- |
| ポップアップのコード（一覧・このページ・詳細） | `Kypr.tsx` `fillTotp` → `nemo:kypr-fill-totp` → `fillKyprTotp(wc, id)` | 入れる | **入れず・コピーもせず** `{ ok: false, reason: 'url-mismatch', addUrl: { origin, host, existing } }` → 帯（`existing` があれば「コピーだけ」が主） | コピー（今どおり） | コピー（今どおり） |
| 帯の「URL に足して入力」 | `fillTotp(id, origin)` → `fillKyprTotp(wc, id, { addUrlFor: origin })` | 入れる（足さない） | オリジンが一致すれば `addKyprTotpUri` → 入れる。不一致なら帯を出し直す | — | 足さずにコピー |
| 帯の「コピーだけ」 | `copyTotp` → `nemo:kypr-copy-totp`（既存） | — | コピー | — | — |
| iframe（フォーカスのある直下の iframe） | `fillKyprTotp` | 入れる | **その iframe のオリジン**で帯を出す（帯に出すホストは足すものそのもの） | コピー | コピー（今どおり。iframe にはコードを入れない） |
| ページが無い（`foregroundContents` が null） | `ipc.ts` | — | コピー（今どおり） | — | — |
| http(s) でないフレーム | `fillKyprTotp` | — | コピー（今どおり。`parsePage` で読めない） | — | — |
| ログイン直後の自動コピー | `fillKyprLogin` → `kyprTotpMatches` | 1 件ならコピー | 変更なし（足したあとは合うようになる） | — | — |

### 調べてわかったこと（Nemo のコード）

- 入口は `src/main/kypr/fill.ts` の `fillKyprTotp`。照合は `loginMatchesPage({ uris: totp.uris }, frame.url)`（`src/vendor/kypr/client/url-match.ts`。vendor は直接いじらない）
- IPC は `src/main/ipc.ts` の `nemo:kypr-fill-totp`。`ok && !copied` のときポップアップを閉じる
- renderer は `src/renderer/components/Kypr.tsx` の `KyprPanel` の `fillTotp`。一覧・詳細の両方に渡している。失敗の文言はパネルの `message` で、**一覧にしか出ていない**（詳細から押した失敗は今は見えない）
- `saveKyprItem` は `pickFields` で TOTP の項目（name / account / secret / algorithm / notes / digits / period / uris）を検査し、既存の平文に重ねる。uris の要素の知らないキーも残す
- 読み取り専用かどうかは `session.readOnly`（`kyprStatus().readOnly`）

## 実装計画

### Phase 1: main 側 [AI🤖]
- [x] `index.ts` に `addKyprTotpUri(id, origin)`: 今の平文から fields を作り、uris に `{ uri: origin, match: null }` を足して `saveKyprItem` を通す。書けるか（`kyprCanWrite()`）も出す
- [x] `fillKyprTotp(wc, id, { addUrlFor })`: 合わないとき、普段のウィンドウ・書ける・http(s) のフレームなら `addUrl` を返す（コピーしない）。`addUrlFor` がフレームのオリジンと一致すれば足してから照合し直して入れる
- [x] `KyprActionResult` に `addUrl` / `urlAdded` を足す。IPC・preload・`NemoApi` の型に `addUrlFor` を通す（文字列・長さを検査）

### Phase 2: ポップアップ [AI🤖]
- [x] パネルに確認の帯（`kypr-offer`）。`url-mismatch` + `addUrl` で出し、「URL に足して入力」・「コピーだけ」・閉じる。画面の移動・別のコードで消す
- [x] 足してコピーに回ったとき（欄が無い）は一覧を読み直して知らせる

### Phase 3: 検証 [AI🤖]
- [x] `scripts/verify-kypr.mjs`: 「URL の無い TOTP → 帯の結果（入れない・コピーしない）→ 足して入れる → 保存された URL（match null・既存の URL・知らないキーは残る）→ 次はログイン直後に自動コピーされる」、「確かめたオリジンと違えば足さない」。ポップアップで帯が出て押せることも見る。修正前に FAIL することを確かめる
- [x] `scripts/verify-agent.mjs`: Claude のウィンドウでは URL の合わないコードは今どおりコピーで、URL を足さない
- [x] `mise run verify:only kypr` / `mise run verify:only agent`・typecheck・test・lint

### 動作確認 [人間👨‍💻]
- [ ] Heroku でログイン → ポップアップでコードを押す → 帯の「heroku.com を URL に足して入力」で入ること
- [ ] 次のログインで、パスワードを入れた直後にコードがコピーされること（⌘V で入る）

## ログ
### 試したこと・わかったこと
- 自走検証: `verify:only kypr` 178 件中 178 件 PASS（TOTP の検査を 6 件足し、既存の「URL が合わなければコピーする」1 件を「帯の結果を返す」に置き換えた）。`verify:only agent` 97 件中 97 件 PASS（Claude のウィンドウの検査を 1 件足した）
- 修正前の src（HEAD）に新しい検査を当てると、足した kypr の 6 件が FAIL（`{"ok":true,"copied":true}` が返る・帯が出ない・URL が足されない・ログイン後の自動コピーが起きない）。agent の 1 件は「今どおりコピー」の退行を見る検査なので修正前も PASS する
- 1 回目の `verify:only kypr` は、足した検査の直後の QR の読み取り（既存）で `requestAnimationFrame` が 180 秒返らず落ちた。そのまま回し直すと PASS（検証ウィンドウが描かれていない間は rAF が止まる。デスクトップの状態による揺れと判断）。修正前の回では欄の下の候補の「少し待って押すと入り、候補は閉じる」も 1 回落ちた（TOTP と関係しない検査。修正後の回はすべて PASS）
- 帯の見た目は一時的に撮ったスクリーンショットで確かめた（380px 幅に文言・2 つのボタン・閉じるが収まる。撮る処理はコミットに入れていない）
- 帯の「画面を移ったら消す」は `useEffect` で `setOffer(null)` すると `react-hooks/set-state-in-effect` で lint が落ちるので、描画中に前の `view` と比べて消す形にした

### 方針変更
- 別のサイト用の URL が付いたコードの帯を分けた（polish-impl のレビューで「一度押しただけでフィッシングのドメインが紐づく」と指摘され、ユーザーが A 案を選んだ）。`addUrl` に今の URL（`existing`）を足し、帯は今のホストを見せて「コピーだけ」を主にする。`verify:only kypr` 179 件中 179 件 PASS（検査を 1 件足した。main で `existing` を空にした状態ではこの 1 件だけ FAIL することを確かめた）
