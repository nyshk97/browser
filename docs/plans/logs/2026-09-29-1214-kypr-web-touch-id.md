review session: 74d715d3-bedd-4777-9490-ce8d1de78549

## 1回目

````text
## P0

## P1
- 決定事項 > 要求を受ける条件（Phase 1 > 3）
  - **何が問題か**: 「前面のウィンドウで表示中」の意味が決まっていません。どの IPC にこの条件を掛けるかも書かれていません。
  - **なぜ問題か**:
    - OS のフォーカス（`isFocused()`）を条件にすると、ターミナルを前面にしたまま回す自走検証では、kypr の origin の検査が全部 NotAllowedError になります。CLAUDE.md が警告している、画面の遮蔽で結果が揺れる件と同じ種類の問題です。分割ビューの 2 枚目、Peek、小窓をどう扱うかも決まっていません。
    - 「この frame は対象か」の問い合わせにも掛けると、裏で開いたタブや起動時に復元した kypr のタブには認証器が入りません。そのタブはリロードするまで指紋のボタンが出ません。`forget`（`signalUnknownCredential`）も、裏のタブから呼ばれることがあります。
  - **どう直すか**: 条件は main の状態で判定します。「そのタブがウィンドウ内で表示中（アクティブタブ・分割の片側・Peek）で、ウィンドウが表示されていて最小化されていない」とし、OS のフォーカスは求めません。この条件は `create` / `get` だけに掛けます。対象かどうかの判定と `forget` は、メインフレーム・origin・セッションだけで判定します。
- Phase 2 > 1（Phase 1 > 1）
  - **何が問題か**: 「kypr の形の要求か」の判定が 2 か所に書かれます。ページ側の shim（文字列化して送るので import できない）と、main 側の `kypr-webauthn.js` です。
  - **なぜ問題か**: 2 つの判定はいずれずれます。単体テストも main 側しか見ません。
  - **どう直すか**: shim は「`publicKey.extensions.prf` がある」程度のゆるい条件で橋渡しに回し、厳密な判定は main だけで行います。main が「kypr の形ではない」と返したら、shim は包む前の関数に渡します。その先では、今までどおり `webauthn-shim` が拒否します。
- Phase 1 > 2
  - **何が問題か**: main world に入れる shim の単体テストがありません。
  - **なぜ問題か**: `scripts/webauthn-shim.test.mjs` の冒頭に「切り出した関数だけをテストすると、出荷されないコードを検証することになる」とあり、このリポジトリはインストーラー 1 本を偽の `globalThis` に当てる方針です。
  - **どう直すか**: `scripts/kypr-webauthn-shim.test.mjs` を足します。同じ偽の環境に `installWebAuthnShim`、kypr の shim の順で入れ、次を確かめます。これも OWNERS の `['kypr']` に載せます。
    - kypr の形の要求は橋渡しに回り、それ以外は内側に回って NotAllowedError になる
    - isUVPAA と `getClientCapabilities` を上書きしても、native の他のキーが残る
    - abort すると AbortError になる
    - オフセット付きの TypedArray の salt が、正しいバイト列で渡る
    - `func.toString()` を vm で評価しても動く（外側の変数を参照していない）
- Phase 2 > 2
  - **何が問題か**: `sendSync` が、すべての http(s) のメインフレームの読み込みごとに走ります。src には `sendSync` を使っている箇所がまだありません。
  - **なぜ問題か**: main が詰まっている間、全サイトの preload が止まり、その後のページの最初のスクリプトも待たされます。
  - **どう直すか**: 候補の origin のときだけ main に聞きます。候補は `location.origin === KYPR_PRODUCTION_SERVER`（`kypr-config.js` は import の無い純粋なモジュール）か、hostname が `127.0.0.1` / `localhost` のときです（`resolveKyprServer` と同じ制限）。最終的な判定は、今の計画どおり main が行います。
- 決定事項 > 答える要求（Phase 1 > 3）
  - **何が問題か**: `get` と `forget` の照合がクレデンシャル ID だけです。保存した行の `origin` / `rpId` を、送り手の `senderFrame.origin` や要求の `rpId`（`rp.id`）と突き合わせることが書かれていません。
  - **なぜ問題か**: ページが申告した rpId をそのまま保存・照合することになります。そうすると、`rpId` を保存している意味がありません。
  - **どう直すか**: main で rpId を「送り手の origin の host」に決めます。要求の `rp.id` / `rpId` がそれと違えば拒否します。`get` / `forget` は、origin が一致する行だけを対象にします。
- Phase 3 > 2（ファイルに secret が平文で無い）
  - **何が問題か**: テストからは secret が見えません。ページが受け取るのは PRF の出力だけです。
  - **なぜ問題か**: この検査は書けないか、何も見ずに PASS します。
  - **どう直すか**: 次の 2 つを見ます。
    - `encrypted` が memory backend の `NEMOTEST1:` の形式で、行に想定外のキーが無い
    - ページで得た PRF の出力と credentialId が、hex / base64 / base64url のどの形でも、userData の全ファイルとログに出ない
- Phase 3 > 2
  - **何が問題か**: 再起動をまたぐ検査がありません。Touch ID に失敗しても秘密を消さないことも見ていません。
  - **なぜ問題か**: この機能の要は、再起動後も秘密が IndexedDB の記録と対応し続けることです。
  - **どう直すか**: `verify-kypr.mjs` の既存の `NEMO_KYPR_TEST_TOUCHID: 'fail'` の起動（同じ userData）に相乗りします。1 回目の起動で作ったクレデンシャルで `get` すると NotAllowedError になり、ファイルの件数が変わらないことを見ます。起動の回数は増やしません。
- 決定事項 > 答える要求（Phase 3 > 1）
  - **何が問題か**: 形の判定とテストページの前提（`create` で `prf.eval.first` を渡す、`get` は `eval.first` を使う、`userVerification` を置く場所、`signalUnknownCredential` を呼ぶ時点）に、kypr のソースの引用がありません。今回 `~/kypr/.../device-unlock.ts` は読み取りの許可が無く、照合できていません。
  - **なぜ問題か**: 次のようにずれると、自走検証は PASS したまま、本物の kypr では何も起きません。
    - kypr が `prf: {}`（eval 無し）で `create` して、あとから `get` を呼ぶ → Touch ID が 2 回出る
    - kypr が `get` で `evalByCredential` を使う → 判定で拒否される
  - **どう直すか**: kypr が実際に渡している `create` / `get` / `signalUnknownCredential` の options を、kypr のコミットハッシュ付きで「コードベースの事実」に書き写します。判定とテストページはそれに合わせます。eval の無い `create` には `results` を返さない分岐も入れます。
- Phase 1 > 3
  - **何が問題か**: 同時に来た要求の扱いが書かれていません。
  - **なぜ問題か**: kypr のタブが 2 つあるときや連打したときに、`promptTouchID` が重なって出ます。
  - **どう直すか**: main で処理中の要求があれば、後から来た要求はすぐ NotAllowedError にします（Chrome の "A request is already pending" と同じ扱い）。

## P2
- Phase 2 > 1
  - **何が問題か**: abort されてもページに AbortError を返すだけで、main の Touch ID ダイアログは閉じられません（`promptTouchID` に取り消す手段が無い）。
  - **なぜ問題か**: 通ったあとの結果を捨てるので害はありませんが、ページとダイアログの状態が食い違います。
  - **どう直すか**: この挙動を plan に書いておきます。あわせて、橋渡しに渡すのは正規化した平たいデータ（`Uint8Array` と文字列）だけにします。options を丸ごと渡すと `signal` が contextBridge で複製できずに例外になります。
- Phase 1 > 3
  - **何が問題か**: `promptTouchId(reason)` の文言が決まっていません。
  - **なぜ問題か**: Nemo の kypr 本体の解除と見分けがつきません。
  - **どう直すか**: 文言に origin を入れます（例:「kypr.tools97.com のロックを解除」）。
- Phase 2 > 3
  - **何が問題か**: `kypr-page.ts` が全ページの読み込みに影響するようになるのに、OWNERS は `['kypr']` のままです。
  - **なぜ問題か**: `--changed` で回るのが kypr の検証だけなので、一般のページ読み込みへの悪影響を拾えません。
  - **どう直すか**: 既存のエントリを、ページを開くスイート（`phase1` など）まで広げるか検討します。
- Phase 3 > 2
  - **何が問題か**: 「kypr 以外の origin」に、別ポートの模擬サーバーを立てる前提になっています。
  - **なぜ問題か**: もっと簡単な方法で足ります。
  - **どう直すか**: kypr の origin が `127.0.0.1` なら、同じポートの `localhost` で別の origin になります。あわせて、既存の `NEMO_KYPR_TEST_SERVER: ''` の起動（kypr が無効）で isUVPAA が false のままであることも相乗りで見ます。
- Phase 4 > 1
  - **何が問題か**: `webauthn-shim.js` の冒頭コメント（配る経路・isUVPAA が true になる将来の話）が古くなります。
  - **なぜ問題か**: kypr の origin だけは外側に kypr の認証器が入る、という前提が読み取れなくなります。
  - **どう直すか**: そのことをコメントに書き足します。
- Phase 4 > 4
  - **何が問題か**: kypr 側で `device-unlock.ts` の呼び出しを変えると、Nemo が何のエラーも出さずに動かなくなります。
  - **なぜ問題か**: kypr の Web 版は Nemo の CI に無いので、自走検証では気づけません。
  - **どう直すか**: kypr の `VERIFY.md` に「options を変えたら Nemo の `kypr-webauthn` の判定も直す」と 1 行足します。

## Q

````

**対応**: P0 なしで収束。書き換えで済む P1/P2 を反映した: 要求を受ける条件（表示中の定義を main の状態に・create/get だけに掛ける）・判定を main に一本化し shim はゆるく回す・sendSync を候補 origin に限る・rpId/origin の照合・「平文で無い」検査を実際に見られる形に書き換え・kypr の options を 798c258 から「コードベースの事実」に書き写し（kypr は常に eval.first を渡すので eval 無しの分岐は足さない）・kypr-page.ts の OWNERS を広げるか実装時に見る・非 kypr origin は同ポートの localhost・webauthn-shim.js のコメント・kypr の VERIFY.md に注記。見送り（足す修正のため終了報告へ）: shim の単体テスト追加（P1）・再起動をまたぐ検査（P1）・同時要求の即拒否（P1）・abort 時のダイアログと平たいデータ（P2）・Touch ID の文言（P2）
