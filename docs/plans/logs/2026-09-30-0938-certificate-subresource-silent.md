review session: 863276e5-982b-465a-9dfb-5c405cfb85f5

## 1回目

````text
## P0
- 実装計画 > Phase 1 > 3（`!isMainFrame` なら黙って拒否） — メインフレームで「このまま続行」を押したあと、同じホストから読む CSS・JS・画像（`isMainFrame: false`）が全部黙って拒否されるおそれがある / 今のハンドラは記憶しない（「毎回聞く」）。Electron が Chrome の `SSLHostStateDelegate` 相当を持たないなら、続行後も同じホストのサブリソースごとに `certificate-error` がまた来る。今はそのたびにダイアログが出るので、押し続ければ読み込める。この修正の後は全部落ちるので、「続行」を押しても骨だけのページになり、続行ボタンが実質使えなくなる。計画の検査 B は「戻る」しか押さず、人間の確認も「確認が出る」までしか見ないので、この退行を拾えない / 実装の前に実測する。自己署名のページに同じホストの `<img>` を置き、メインで続行したあと `certificate.error` が `isMainFrame: false` でまた来るかを見る。来るなら、続行したホストと証明書（fingerprint + error）をメモリに持ち、同じ組み合わせのサブリソースは聞かずに通す。検査 C「メインで続行 → 同じホストのサブリソースが読み込め、ダイアログは 1 回だけ」を Phase 2 に足す

## P1
- 実装計画 > Phase 2 > 2（検査 A） — 「既存の HTTP サーバーのページに `<img src="https://…">` を置く」とあるが、その HTML を返す手段が無い / `scripts/test-server.mjs` には任意の HTML を返すエンドポイントが無い。`__nemo_auth_page__` は Basic 認証の fetch 専用。実装者がその場で方式を決めることになり、test-server を変えるかどうかでブレる / 方式を計画に書く。おすすめは、既存のページ（例: `__nemo_test_pages__`）を開いてから CDP の `Runtime.evaluate` で `img` を差し込み、`onerror`・`naturalWidth` をその場で待つ形。これなら test-server を変えずに済む
- 実装計画 > Phase 2 > 3（検査 B「後続の検査に確認ダイアログを残さない」） — `drainDialogs()` は `prompt-notice` 以外を全部 `cancelAuth()`（`[data-testid="prompt-auth"]` のボタン）で閉じようとするので、`prompt-certificate` を閉じられない / 残った証明書ダイアログは 12 回試したあとも残り、後続の検査の `waitDialog` や `stayQuiet` を偽 PASS・偽 FAIL にする。特に「修正前の FAIL を見る」手順では、旧コードの検査 A が証明書ダイアログを出したまま残す。検査 B はそのダイアログを見て即 PASS し、その後の認証の検査も全部汚れる / `drainDialogs()` に `prompt-certificate` の分岐を足し、「戻る」を押すようにする。計画の手順として明記する
- 実装計画 > Phase 2 > 1（HTTPS サーバー） — 自前で立てる `https.createServer` の後片付けが書かれていない / 既存の `cleanup()` は子プロセス（`spawned`）しか止めない。サーバーや一時ディレクトリ（鍵）が残ると、検証プロセスが終わらないか、`/tmp` に鍵が溜まる / `finally` の `cleanup()` で `server.close()` と一時ディレクトリの `fs.rmSync(..., { recursive: true })` を呼ぶ、と書く
- 実装計画 > Phase 2 > 4（修正前の FAIL を見る） — 旧コードだと「`certificate.error` に `isMainFrame: false` がある」も FAIL になる（旧コードはこのキーを出さない）。どの check が FAIL したのかが混ざる / 「確認が出たから FAIL した」ことを見たいのに、ログ形式の差でも落ちるため、判定が曖昧になる / 検査 A の「到達した」判定は `certificate.error` の件数（target が HTTPS サーバーのもの）で数え、`isMainFrame` の値は別の check に分ける。修正前の実行では「ダイアログが出ない」の check が FAIL したことを見る、と書く

## P2
- 実装計画 > Phase 1 > 3 — 「判定の位置は `windowId` の解決より前」とあるが、`log('certificate.error')` との前後が書かれていない / 検査 A はこのログに頼っているので、ログより前に return すると検査が空振りする / 「ログ → `isMainFrame` 判定 → `windowId` 解決」の順だと明記する
- 実装計画 > Phase 2 > 2・3 — iframe（`isMainFrame: false` のナビゲーション）を黙って拒否する挙動を検査していない / 「前提」で iframe の扱いまで決めているのに実測が無い / 検査 A と同じ要領で `<iframe src="https://127.0.0.1:<port>/">` を差し込み、ダイアログが出ないことを見る check を 1 つ足す
- 実装計画 > Phase 2 > 7（VERIFY.md） — `verify-http-auth.mjs` の冒頭コメント（「HTTP Basic 認証の自動入力の自走検証」）と、`verify-targets.mjs` の `'http-auth', // HTTP Basic 認証の自動入力` が実態と合わなくなる / 次に読む人が、証明書の検査の置き場所を見つけにくい / 両方のコメントに「証明書エラーの確認」を足す
- 実装計画 > Phase 1 > 5（CHANGELOG） — 既存の行は「**太字の要点**。補足」の形で揃っている / 見た目の統一 / 「**ページに埋め込まれた画像・計測タグの証明書エラーで確認を出さないようにした**。確認はページそのものの証明書エラーのときだけ出す」のような形にする

## Q
- 実装計画 > Phase 1 > 3 — P0 の実測で「続行後もサブリソースで `certificate-error` がまた来る」となった場合に、続行をどこまで覚えるかが決まっていない。候補はタブ（WebContents）単位・ウィンドウ単位・アプリ起動中ずっと、で、ホストだけで照合するか証明書の fingerprint まで見るかも決める必要がある。また、今の「記憶はしない（毎回聞く）」方針を一部変えることになる / 決めないと実装者が勝手に範囲を選ぶ。広すぎると、一度続行したホストで別の中間者攻撃を素通しする。狭すぎると、同じサイトの別タブで壊れたページになる

````

**対応**:
- P0（続行後のサブリソースが黙って落ちる）: Phase 1 の先頭に「続行後もサブリソースで certificate-error がまた来るか」の実測を置き、来るなら続行を WebContents 単位・ホスト + fingerprint + エラーコードの完全一致でメモリだけに覚えてサブリソースを通す、と書いた。Phase 2 に検査 C（続行で画像が読める・確認は 1 回・別タブでは拒否）を足した
- Q（記憶の範囲）: 決定 = WebContents 単位・3 つ組の完全一致・メモリのみ・メインフレームには使わない / 根拠: 既存の「記憶しない（毎回聞く）」方針（security.ts の JSDoc）と、広げたときの素通しのリスク。plan の Phase 1 に「（1回目で決定）」で書いた
- P1: img は CDP で差し込む（test-server は変えない）/ drainDialogs に証明書の分岐 / HTTPS サーバーと鍵を cleanup で片付け / 修正前の FAIL は「確認が出ない」の check で見る、を全部反映した
- P2: ログ → 判定 → windowId の順を明記 / CHANGELOG を太字の形に / スイートのコメント 2 箇所の更新を VERIFY のステップに足した。iframe の検査の追加は見送り（検査を足す修正はループ中は見送る決まり。終了報告に回す）

## 2回目

````text
## P0
- 実装計画 > Phase 1 > 1・5（先に実測 → 「また来る」ときだけ続行の記憶を入れる） — 実測の結果が、TLS の接続が再利用されるかどうかで変わってしまう / 画像 1 枚で測ると、メインフレームで続行したときの接続（keep-alive）がそのまま使い回されて `certificate-error` が来ない、ということが起こりうる。そうなると「来ない → 記憶は入れない」と判断される。ところが実際のページは同じホストに並列で複数の接続を張り（09-16 の 6ms 差の 2 回がこれに当たる）、アイドルで切れたあとにも新しい接続を張り直す。そこで来たサブリソースは黙って落ち、「続行したのに骨だけのページ」が出荷される。検査 C も「入れたときだけ」なので、この退行を拾うものが何も残らない / 条件分岐をやめて、続行の記憶は常に入れる（実装は小さい）。実測は、記憶が要ることの根拠としてログに残すだけにする。測るときは HTTPS サーバーが `Connection: close` を返すようにして、リクエストごとに TLS のハンドシェイクが起きるようにする。検査 C は常に回す

## P1
- 実装計画 > Phase 2 > 4（検査 C） — 記憶の経路に本当に到達したかを確かめる check が無い / 接続が再利用されると、画像は記憶を通らずに読み込めてしまう。すると「画像が読める・確認は 1 回」が、記憶の実装が壊れていても PASS する。同じ理由で「別のタブでは拒否」も、接続の再利用しだいで結果が揺れる / 検査用の HTTPS サーバーに `Connection: close` を付ける（検査 A・B とも共通でよい）。記憶で通したときに `certificate.decision`（`proceed: true, remembered: true` のような形）をログに出すよう Phase 1 に足す。検査 C では、そのログが画像の URL で 1 件以上出ていることを「到達した」の check にする（検査 A と同じく、空振りしていないことを示すため）

## P2
- 実装計画 > Phase 1 > 5（続行の記憶） — 記憶を書き込むタイミングと、WebContents が破棄されたときの捨て方が書かれていない / `callback(true)` より後に書き込むと、先に届いたサブリソースが記憶に当たらず落ちる。破棄の検知を `destroyed` イベントで配線すると、付け忘れで記憶が漏れる / 「`callback(true)` の前に記録する」「`WeakMap<WebContents, Set<string>>` で持つ（破棄時の後始末が要らない）」と書く
- 実装計画 > Phase 2 > 1（openssl） — 「CI の Linux」とあるが、自走検証の CI（`.github/workflows/verify.yml`）は `macos-15` で動いている / 前提の説明が事実と違う / 「mac（ローカル・CI とも `macos-15`）」に直す

## Q

````

**対応**:
- P0（実測が接続の再利用で揺れ、条件付きの記憶が入らないおそれ）: 続行の記憶は常に入れる形に変え、実測は根拠として残すだけにした。実測と検査の HTTPS サーバーは `Connection: close` を返す。検査 C は常に回す
- P1（検査 C の到達確認が無い）: 記憶で通したときに `certificate.decision` に印を付けてログに出す、と Phase 1 に書き、検査 C の到達確認に使うようにした
- P2: 記録は `callback(true)` より前・WebContents に紐づけて破棄で消える形、と要点だけ書いた（WeakMap などの具体的な形は実装時に決める）。CI の OS の記述を `macos-15` に直した

## 3回目

````text
## P0

## P1
- 実装計画 > Phase 2 > 4（検査 C の到達確認「画像の URL で」） — ログからは画像の URL を区別できない / `certificate.decision` は今 `{ proceed }` しか持たない。`certificate.error` の target も `redactUrl`（`src/shared/log-redact.js`）で `https://127.0.0.1:<port>` のオリジンまで落とされる。検査 C ではページも画像も同じオリジンなので、「画像の URL で」絞り込む check は書けない。実装者がその場で条件を変えることになる / 到達確認の条件を「記憶の印（例: `remembered: true`）付きの `certificate.decision` が 1 件以上」に直す。検査 C の中でその印が付くのはサブリソースだけなので、これで足りる。ほかの検査の行と取り違えないように、検査 C の開始前の件数との差で数える、と書く
- 実装計画 > Phase 1 > 4（「一致するサブリソースは `callback(true)`」） — 通すときに `event.preventDefault()` が要ることが書かれていない / Electron は `preventDefault()` されなかった `certificate-error` を既定の動作で拒否する（「前提」にある通り）。`callback(true)` だけ書くと、記憶の経路は黙って拒否され、検査 C で原因の分かりにくい FAIL になる / 「記憶に一致したら `event.preventDefault()` → `certificate.decision`（印付き）を出す → `callback(true)`」と手順を明記する

## P2
- 実装計画 > Phase 1 > 5（続行の記憶の「ホスト」） — ホストにポートを含めるかが書かれていない / Chrome はポートを見ずにホストで覚える。今回の方針は「狭い側に寄せる」なので、ポートまで含めるのが筋。書いていないと、`new URL().hostname` と `host` のどちらを使うかが実装者任せになる / 「キーはホスト名 + ポート（`URL.host`）+ fingerprint + エラーコード」と書く

## Q

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P1: 検査 C の到達確認を「印付きの `certificate.decision` が検査 C の開始前より増えていること」に直した（ログの target はオリジンまで伏せられ、URL で絞れないため）
- P1: 記憶に一致したサブリソースは `event.preventDefault()` → 印付きのログ → `callback(true)` の順で通す、と明記した
- P2: 記憶のキーのホストを「ホスト名 + ポート（`URL.host`）」と明記した
