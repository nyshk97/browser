# 証明書エラーの確認をメインフレームだけにする

## 概要・やりたいこと

ページに埋め込まれた他社の計測タグ（メールの開封ピクセル・広告計測）の証明書エラーで、
「〈計測ホスト〉の証明書に問題があります」のダイアログが出る。アドレスバーのサイト自体は正常なので、
利用者には「ちゃんとしたサイトなのに時々警告が出る」に見え、判断の材料も無い。

Chrome と同じく、**ページそのもの（メインフレームのナビゲーション）の証明書エラーだけ確認を出し、
サブリソース・iframe のエラーは聞かずに拒否してログにだけ残す**。

目的は 2 つ:
- 判断できない確認を出さない
- 無意味な確認で「とりあえず続行」を押す癖を付けさせない（本物の中間者攻撃のときの警告を効かせる）

## 前提・わかっていること

- ハンドラは `src/main/security.ts:698` の `installCertificateHandler`（`app.on('certificate-error')`）。
  呼び出し元は `src/main/index.ts:219` の 1 箇所だけ。今の動きは「エージェントのウィンドウ・ウィンドウ未解決は
  聞かずに拒否、それ以外は全部 `ask()`」で、記憶はしない
- Electron 41.10.6 の `certificate-error` は 7 番目の引数に `isMainFrame: boolean` を持つ
  （`node_modules/electron/electron.d.ts:224` 付近）。今のハンドラは受け取っていない
- `event.preventDefault()` を呼ばなければ Electron が拒否する。拒否の側に倒すので、セキュリティは下がらない
- 実ログ（常用版 `~/Library/Application Support/Nemo/logs`、09-15〜09-30）で出た 7 回は全部計測系:
  - `bx01.optimix.cn`（広告計測）
  - `tracksp.cloudflare.com`（`CNAME spgo.io` = SparkPost）
  - `url536.ml.kuronekoyamato.co.jp`（`CNAME sendgrid.net` = SendGrid。`*.sendgrid.net` の証明書が返り
    `ERR_CERT_COMMON_NAME_INVALID`）
- iframe のナビゲーションも `isMainFrame: false` になる。Chrome は iframe の中に警告を出すが、
  Nemo では黙って拒否（iframe はエラーページ）でよい。iframe の中身の証明書を利用者が判断する場面は無い
- ダイアログは `src/renderer/components/PromptDialog.tsx` の `data-testid="prompt-certificate"`。
  ログは `certificate.error`（target / code）と `certificate.decision`（proceed）
- `src/main/security.ts` は `scripts/lib/verify-targets.mjs` の `OWNERS` に載っていない → `--changed` はフルに倒れる。
  **新しく `OWNERS` に載せない**（CLAUDE.md: 未登録を載せるとフルが 1 スイートに絞られる改悪になる）
- 検査を置く場所は既存の `http-auth` スイート（`scripts/verify-http-auth.mjs`）:
  - `NEEDS_APP` でフルの既定に入っている（`OPT_IN_ONLY` ではない）
  - 自前のページサーバーと、確認ダイアログを待つ仕組み（`waitDialog(kind)`・診断ログの `prompt.opened` 数え）がある
  - 「セキュリティまわりの確認ダイアログ」の検査がまとまっている
  - 新しいスイートを作ると、登録・配線・`OWNERS` の 3 点が要るわりに得るものが無い

## 実装計画

### Phase 1: ハンドラの修正 [AI🤖]

- [x] **先に実測（根拠として残すだけ。結果で方針は変えない）**: 今のコードで、自己署名のページに同じホストの `<img>` を置き、
  メインフレームで「続行」したあと `certificate-error` がサブリソースでまた来るかを見る。HTTPS サーバーは `Connection: close` を返し、
  接続の再利用で「来ない」に見えないようにする（09-16 の `tracksp.cloudflare.com` は 6ms 差で 2 回来ている）。結果をログ > 試したこと に書く
- [x] `installCertificateHandler` のリスナーで 7 番目の引数 `isMainFrame` を受ける
- [x] `certificate.error` のログの detail に `isMainFrame` を足す（フラットな boolean なので `sanitizeDetail` の罠には当たらない）
- [x] 順序は「`log('certificate.error')` → `isMainFrame` の判定 → `windowId` の解決」。`!isMainFrame` なら `callback(false)` して return（`ask()` しない）。
  ただし下の「続行の記憶」に一致するサブリソースは `event.preventDefault()` → 印付きの `certificate.decision` → `callback(true)` の順で通す
  （`preventDefault()` が無いと Electron の既定で拒否される）
- [x] 続行の記憶（**常に入れる**。実際のページは同じホストに並列・張り直しで接続するので、実測の結果に関係なく要る。2回目で決定）:
  メインフレームで続行したら、その WebContents について「ホスト名 + ポート（`URL.host`）+ 証明書の fingerprint + エラーコード」を**メモリだけ**に持ち、
  同じ組み合わせのサブリソースは聞かずに通す。記録は `callback(true)` より前に行う（先に届いたサブリソースを取りこぼさない）。
  WebContents に紐づけて持ち、破棄で自然に消える形にする。メインフレームのナビゲーションには使わない（今までどおり毎回聞く）
  - 記憶で通したときは `certificate.decision` に「記憶で通した」ことが分かる印を付けて出す（検査 C の到達確認に使う）
  - 範囲: WebContents 単位・3 つ組の完全一致（1 回目で決定。広げると一度続行したホストで別の証明書を素通しし、
    狭めると続行したページが骨だけになる。Chrome はホスト + 証明書で覚えるが、Nemo の「記憶しない」方針に寄せてタブに閉じる）
- [x] 関数の JSDoc に「メインフレームだけ聞く。サブリソース・iframe は Chrome と同じく黙って拒否（続行したタブの同じ証明書だけ通す）」とその理由（計測タグの実例）を書く
- [x] `docs/CHANGELOG.md` の `[Unreleased]` → `### 変更` に 1 行:
  「**ページに埋め込まれた画像・計測タグの証明書エラーで確認を出さないようにした**。確認はページそのものの証明書エラーのときだけ出す」

### Phase 2: 自走検証 [AI🤖]

- [x] `verify-http-auth.mjs` に「証明書」の節を足す。自己署名証明書の HTTPS サーバーを `127.0.0.1` の空きポートで立てる
  - 証明書は実行時に `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=nemo-verify -days 1` で一時ディレクトリに作る
    （リポジトリに鍵を置かない・期限切れで腐らない）。mac（ローカル・CI の `macos-15` とも）に `openssl` がある前提。
    無ければ FAIL にする（黙って飛ばすと「検査 0 件で PASS」になる）
  - HTTPS サーバーは `Connection: close` を返す（接続の再利用で証明書の検査を飛ばさせない。検査 A / B / C 共通）
  - HTTPS サーバーと一時ディレクトリ（鍵）は既存の `cleanup()` で閉じる・消す
  - 既存の `drainDialogs()` は `prompt-certificate` を閉じられない（認証ダイアログのボタンしか押さない）ので、証明書ダイアログは「戻る」で閉じる分岐を足す
    （修正前の実行で残ったダイアログが後続の検査を汚さないように）
- [x] 検査 A（サブリソース）: test-server は変えず、既存のページを開いてから CDP で `<img src="https://127.0.0.1:<port>/pixel.png">` を差し込む
  - **エラーが実際に起きたこと**: 診断ログに target が HTTPS サーバーの `certificate.error` が 1 件以上ある
    （境界に到達したことの実測。0 件なら検査の空振りとして FAIL）。`isMainFrame: false` が載っていることは別の check にする
  - img の `onerror` が発火している（`naturalWidth === 0`）
  - 数秒待っても `prompt-certificate` が出ない。`prompt.opened` の certificate が増えていない
- [x] 検査 B（メインフレーム）: タブで `https://127.0.0.1:<port>/` を開く
  - `waitDialog('prompt-certificate')` で確認が出る
  - 「戻る」を押して閉じ、`certificate.decision` が `proceed: false`
  - 後続の検査に確認ダイアログを残さない
- [x] 検査 C（続行の記憶。常に回す）: 同じホストの `<img>` を持つページをメインフレームで開いて「続行」→ 画像が読み込め、
  確認は 1 回だけ。**到達確認**として、「記憶で通した」印の付いた `certificate.decision` が検査 C の開始前より 1 件以上増えていること
  （ログの target はオリジンまで伏せられるので URL では絞れない。印が付くのはサブリソースだけなのでこれで足りる）。
  別のタブで同じページの画像だけ差し込むと拒否される（記憶がタブに閉じている）
- [x] **修正前の FAIL を見る**: `src/main/security.ts` だけ `cp` で退避 → `git show HEAD:src/main/security.ts > src/main/security.ts`
  で書き戻して `mise run verify:only http-auth` → 検査 A の「確認が出ない」の check が FAIL することを出力で確かめてから自分の版に戻す
  （`isMainFrame` のログの check は旧コードでは形式の差で落ちるだけなので、判定に使わない）
- [x] 修正後に `mise run verify:only http-auth` が PASS。証明書の節の実行件数（A / B / C の check 数）を報告に出す
- [x] `mise run typecheck`・`mise run lint`・`mise run test` を通す
- [x] VERIFY.md に「証明書エラーの確認（サブリソースは聞かない・メインフレームは聞く）は http-auth スイートの証明書の節で見る」を追記
  （既存の構造に合わせる。重複があれば足さない）。`verify-http-auth.mjs` の冒頭コメントと `verify-targets.mjs` の `'http-auth'` のコメントにも「証明書エラーの確認」を足す

### 動作確認 [人間👨‍💻]

- [ ] リリース後の常用版で dmail からヤマトのメールを開き、ダイアログが出ないこと
- [ ] 余力があれば `https://self-signed.badssl.com/` などをアドレスバーから開き、確認が今までどおり出ること。続行したらページの画像・CSS まで読み込めること

## ログ

### 試したこと・わかったこと

- 実測（修正前のコード・`Connection: close`）: メインフレームで続行したあとも、同じホストのサブリソースで `certificate-error` が
  毎回来た（ページの画像・差し込んだ画像・別タブの画像で計 3 回、どれも確認ダイアログ）。Electron は続行を覚えないので、続行の記憶は必要
- 修正前の `verify:only http-auth`: 証明書の検査で 8 件 FAIL（検査 A の「確認を出さない」が `prompt.opened 1 件` で FAIL）。修正後は 88 件すべて PASS
- 続行したページの `/favicon.ico` と思われるサブリソースが 1 件、記憶に当たらず拒否された（ページの画像 2 件は `remembered` で通過）。
  favicon の読み込みはタブと別の WebContents から来ているとみられる。続行したページでファビコンが出ないだけなので追わない
- 検査の道具を `const` で書くと、ファイル上部のトップレベル `await runAll()` から呼ばれて TDZ で落ちた → 関数宣言にした

### 方針変更
