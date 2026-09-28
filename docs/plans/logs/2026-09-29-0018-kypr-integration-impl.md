review session: 3889d8e4-d7aa-425a-86aa-6c5040529550

## 1回目

````text
## P0
- `packages/client/src/url-match.ts:loginMatchesPage`（Phase 1 > ステップ 3） — ステップ 3 では「ゴミ箱と隔離が出ない」をテストすると決めているが、実装もテストも無い。`loginMatchesPage` は `uris` しか受け取らず、`deletedAt`・`tampered`/`malformed`（`EntryState` の `error`）で弾く処理は packages のどこにも無い。/ 仕様書（crypto-spec「URL の照合」の最後の行）には書いたのに共通の実装が無いので、Nemo 側がそれぞれ自前で弾くことになる。弾き忘れるとゴミ箱の中のログインが候補やバッジに出る。/ `VaultEntry` の集まりとページの URL を受け取って「`kind === "login"` かつ `deletedAt === null`」だけを照合する関数（例: `matchingLogins(entries, pageUrl)`）を `url-match.ts` に足し、ゴミ箱・`error`・note/card が出ないテストを `url-match.test.ts` に足す。Nemo はそれを使うようにする。
- `scripts/export-nemo.ts:（トップレベルの dirty の検査と VENDORED.md の書き出し）`（Phase 1 > ステップ 7・決定表「kypr のコードの取り込み方」） — `packages/client` は kypr のどのコミットにもまだ入っていない（HEAD は e77d0db で、`packages/client` はすべて `??`）。それなのに plan では Phase 2 の取り込みが済んだことになっている。つまり Nemo の `src/vendor/kypr/` は `--allow-dirty` で作ったコピーで、`VENDORED.md` の「コピー元のコミット」には中身を含まない e77d0db が書かれているはず。/ 決定表の「コピー元の kypr のコミットを記録する」を満たさず、このまま Nemo にコミットすると、どの版をコピーしたのか後から追えない。/ kypr 側を先にコミットし、`mise run export-nemo`（`--allow-dirty` を付けずに）で Nemo にコピーし直す。差分が無いことと `VENDORED.md` に「未コミットの変更を含む」が付いていないことを確かめてから、Nemo をコミットする。

## P1
- `apps/ios/KyprCore/URLMatcher.swift:URLMatcher.matches` — 今回書いた crypto-spec「URL の照合」は「Web・iOS・Nemo で揃える」と言い切っているが、iOS の実装とは次の 4 点で違う。①知らない `match`（6 以上）を iOS は `default` でドメイン一致にする（仕様は一致しない）②match 0/1 で http(s) 以外のスキームを `matches` の中で弾いていない（`identityDomain` でだけ弾いている）③`https` の URI を `http` のページにも一致させる ④match 1 で `https://example.com:443` のように既定のポートを明示した URI は、iOS では `port=443`、TS では URL が既定ポートを消して `""` になるので、結果が割れる。/ 仕様書と VERIFY.md は「揃っている」前提で書かれているのに、揃えることを記録した場所がどこにも無い。このままだと iOS だけ http のページに https のパスワードを出し続ける。/ iOS 側を直すか、少なくとも iOS の plan（または CLAUDE.md の「保留していること」）に 4 点を書いて残す。④は仕様書に「既定のポートは書かないのと同じ」と一文足してから、両方をそれに合わせる。
- `packages/client/src/session.ts:VaultSession.#call` — 410（purged）を扱っていない。今は `ApiError` のまま上に投げるだけで、手元の `entries` とキャッシュには消えたアイテムが残る。/ 決定表の「同期の規則を 1 か所に保つ」の趣旨からいうと、410 の扱いを Nemo（Phase 6）と Web が別々に持つことになる（Web は今も扱っていない）。/ 409 と同じく `#call` の中で 410 を受けたら、その id を `#apply(null, [{ ...purged の形 }])` で手元から消し、型の付いたエラー（`PurgedError` など）を投げる。`fake-server.ts` はもう 410 を返すので、`session.test.ts` にテストを 1 件足す。
- `apps/ios/KyprCore/PasswordGenerator.swift:（先頭のコメントとカードの節のコメント）` — 「Web の `apps/web/src/lib/generator.ts` と同じ」「`apps/web/src/lib/card.ts` と同じ」と書いてあるが、どちらのファイルも今回の差分で消えた。/ iOS と TS の実装を揃えておくための手がかりが切れた場所を指しているので、どちらかを変えたときに相手を直し忘れやすい。/ `packages/client/src/generator.ts`・`packages/client/src/card.ts` に書き換える。

## P2
- `packages/client/src/session.ts:VaultSession.unlock` — `authKey` を 0 で埋めていない経路がある。login の `NetworkError` で `sameKdf` でないとき（`unlockOffline` で導出し直す）、401・429、`unwrapVaultKey` の失敗がそれにあたる。`wrapKey` は埋めている。/ 導出した鍵がメモリに残る時間が延びる。/ それぞれの `throw` / `return` の前で `authKey.fill(0)` する。
- `packages/client/src/session.ts:VaultSession（コンストラクタ・setup）` — Web でも `authKey` をセッションが生きている間ずっと持つようになった（前は login の直後に捨てていた）。Web は `reloginOnExpiry` も `goOnline` も使わない。/ 「振る舞いは変えない」移し替えなのに、Web のメモリに残る秘密が 1 つ増えた。/ `authKey` を持つのは `reloginOnExpiry` が true のときか `deviceKeys()` が要るときだけにする（`ClientDeps` にフラグを足す）。
- `packages/client/src/session.ts:VaultSession.unlockWithDeviceKeys` — 429 のときに `canOpenOffline: true` を返すが、覚えた鍵のままキャッシュから開く口が無い（`unlockOffline` はパスワードが要る）。オフラインで開く経路（`NetworkError` のとき）も、鍵がキャッシュの包んだ鍵に合うかを確かめていない。/ 呼び出し側は、429 のあと覚えた鍵で読み取り専用に開けない。鍵が合わないときは全件 `error` の保管庫が開く。/ `openCachedWithDeviceKeys` を足す。オフラインで開くときは、復号できたアイテムが 1 件以上あるかで鍵の正しさを確かめる。
- `packages/client/src/session.ts:VaultSession.deviceKeys` — `lock()` のあとに呼ぶと、0 で埋めた鍵をそのまま返す。/ 呼び出し側が誤って保存すると、Touch ID で解除できなくなる。/ ロック済みなら例外を投げる。
- `scripts/export-nemo.ts:copyTs` — 書き換えと書き換え漏れの検査が、どちらもダブルクォートの `from "@kypr/…"` しか見ない。/ シングルクォートや `import("@kypr/crypto")` の import が入ると、書き換えられず検査もすり抜ける。/ 正規表現を `["']@kypr\/` に広げる。
- `.mise.toml:tasks.test` — description が「（暗号・API・Web）」のままで、クライアントが入っていない。/ 説明が実態と合わない。/ 「暗号・クライアント・API・Web」にする。
- `apps/ios/KyprCore/URLMatcher.swift:PublicSuffixList` — コメントが存在しない `apps/ios/scripts/update-psl.sh` を指している（今回タスク名も `ios-psl` から `psl` に変わった）。/ 更新の手順が見つからない。/ `mise run psl` に直す。
- `CLAUDE.md:（計画・保留していること）` — 「計画」に Nemo 側の plan（`~/browser/docs/plans/2026-09-28-2232-kypr-integration.md`）への参照が無い。「保留していること」の 2 番目（Nemo の中で解除できるようにする）が、この plan で済んだことも書かれていない。/ 次に kypr のセッションで Nemo 連携を触るとき、経緯をたどれない。/ 参照を 1 行足す。人の動作確認が済んだら 2 番目に「済み」と書く。

## Q

---

型検査・lint・テストはこちらでは実行の許可が出なかったので、回していません（このレビューは差分を読んだだけです）。plan のログにある e2e 43 件の PASS も、こちらでは確かめていません。Nemo 側の `src/vendor/kypr/VENDORED.md` も読む許可が出なかったので、P0 の 2 件目は kypr の git の状態から推論したものです。

````

**対応**:
- P0 url-match.ts:loginMatchesPage（ゴミ箱・隔離が出ない）: `matchingLogins(entries, pageUrl)` を足した（deletedAt あり・state が login 以外（error / note / card / unknown）は出さない）。テストに「ゴミ箱・隔離・メモ・別ドメインが出ない」「http(s) 以外のページは空」を足した（46 件 PASS）。Nemo の kyprMatches もこれを使うように直し、コピーし直した
- P0 export-nemo / VENDORED.md のコピー元のコミット: 保留（Q）。kypr のコミットが要るが、このループは「コミットしない」決まり（Nemo のループでも同じ Q を残した）。スクリプトが dirty で止まることは確かめた
- P1 URLMatcher.swift の食い違い: iOS のコードは直さず（iOS のセッションの範囲）、kypr の CLAUDE.md の「保留していること」に 4 点を書いた。④の既定ポートは crypto-spec の match 1 の行に「既定のポートは書かないのと同じ」と書いた（TS は URL が既定ポートを消すので、既にそう動く）
- P1 PasswordGenerator.swift のコメント: 参照先を packages/client/src/generator.ts・card.ts に直した
- P2 unlock の authKey: login が NetworkError（導出し直す経路）・401・429 のときと、保管庫鍵の展開に失敗したときも 0 で埋める
- P2 deviceKeys: ロックしたあとに呼んだら例外を投げる
- P2 export-nemo.ts: 書き換えと書き換え漏れの検査を、シングルクォートの import にも効くようにした
- P2 .mise.toml:tasks.test の説明・URLMatcher.swift の PSL の更新手順のコメント（mise run psl）・CLAUDE.md の計画に Nemo 側の plan を足した
- 見送り（足す修正）: P1 #call での 410 の扱い（新しいエラーの型とテストが要る。Nemo は actionFailure で 'purged' として出している）・P2 Web で authKey を持たないフラグ・P2 覚えた鍵でキャッシュから開く口と、オフラインで鍵の正しさを確かめる処理。終了報告に回す

## 2回目

````text
## P0

## P1
- `packages/client/test/url-match.test.ts:describe("URI の照合（match）")`（Phase 1 > ステップ 3・ステップ 6） — 今回 crypto-spec の match 1 の行に「既定のポート（http の 80・https の 443）は書かないのと同じに扱う」を足したが、それを確かめるテストが無い（`:443` / `:80` を含む検査は 0 件）。/ TS がそう動くのは、WHATWG の `URL` がたまたま既定のポートを `""` にしてくれるからにすぎない。CLAUDE.md の保留④では、iOS をこの規則に揃えると決めている。揃えるときに基準にするテストが TS 側に無いので、`parseUri` を書き換えたときに黙って崩れても気づけない。/ 1 のテストに `uriMatches("https://example.com:443", 1, page("https://example.com/"))` が true、`uriMatches("http://example.com:80", 1, page("http://example.com/x"))` が true になる行を足す。

## P2
- `VERIFY.md:（まとめて回す）` — `mise run check` の件数が「クライアント 44 件」のまま。今回テストを足して 46 件になっている（上の P1 を入れると 48 件）。/ 次に数えたときに、件数が減ったのか元から古いのか見分けられない。/ 件数と日付を今の値に直す。

## Q
- `scripts/export-nemo.ts:（VENDORED.md のコピー元のコミット）`（決定表「kypr のコードの取り込み方」） — kypr の Phase 1 をいつコミットするかが決まっていない。Nemo の `VENDORED.md` に実在するコミットを書くには、kypr → `mise run export-nemo` → Nemo の順でコミットする必要がある。/ 決めずに Nemo だけ先にコミットすると、`VENDORED.md` には「e77d0db（未コミットの変更を含む）」が残る。そうなると Nemo に入っているコードが kypr のどの版なのか、後からたどれない。

---

前回の指摘のうち、P0（`matchingLogins`）・P1（iOS の食い違いを保留に記録・PasswordGenerator のコメント）・P2（`authKey` を 0 で埋める・`deviceKeys` のロック後の例外・export の書き換え・各コメントと説明）は、対応を差分で確かめました。見送った 3 件は理由が妥当なので、繰り返していません。

今回も型検査とテストはこちらでは回していないので、「46 件 PASS」は報告どおりの値として扱っています。Nemo 側（`kyprMatches` の書き換えとコピーし直した中身）は、読む許可が無いので見ていません。

````

**対応**: 収束（P0 なし）。採用した P1/P2:
- P2 VERIFY.md の件数: クライアント 46 件・2026-09-29 時点に直した
- 見送り（足す修正）: P1 既定のポート（:443 / :80）の照合のテスト。終了報告に回す
- Q VENDORED.md のコピー元のコミット: ユーザーに残す

