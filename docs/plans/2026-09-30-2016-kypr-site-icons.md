# kypr のサイトのアイコン（favicon）を Nemo で書き、隠す

## 概要・やりたいこと

Nemo は v1.10.2 から、kypr のログインのアイコンに履歴の favicon を出している（`300f0f9`）。Web と iOS にも同じ favicon を出すため、kypr に**サイトのアイコン**（`type: "icon"`。ホストごとの独立したアイテム・64px 以下の PNG の data: URI）を足した。書くのは Nemo だけ（kypr 側の plan: `~/kypr/docs/plans/2026-09-30-1932-site-icons.md`。仕様は `~/kypr/docs/crypto-spec.md`「サイトのアイコン」）。

この plan は Nemo 側で、①アイコンの行を一覧に出さない版を先に出し（4a）、②全部の Mac を上げてから、履歴の favicon をアイコンとして書く（4b）。

## 前提・わかっていること

- kypr の `VaultSession` は、アイコンの行を `entries` に入れず別に持つ（`iconFor(host)`・`iconId(host)`）。Nemo は一覧・候補・件数・パスキーのどれも `session.entries` から作っているので、**vendoring を更新するだけで隠れる**（2026-09-30 に `src/main/kypr/` を確認。ロック中の `cache.itemCount()` は設定画面で解除中にしか出さない）
- Web・iOS は 2026-09-30 に対応済み（Web は本番にデプロイ・iPhone は Release を入れた）
- 4b の決めごと（kypr の plan の決定表）: 書くのは保管庫のログインのホストのうち履歴に favicon があるものだけ・一辺 64px までの正方形の PNG に描き直す（引き伸ばさない。8KB を超えたら 32px、それでも超えたら書かない）・1 回 20 件まで・まとめて 409 / 410 なら同期して 1 件ずつ・410 の id は手元に覚えて作らない・書き直しは中身が違って `updatedAt` から 30 日以上のときだけ・ゴミ箱にも完全削除にも入れない

## 実装計画

### Phase 4a: 隠す [AI🤖]
- [x] `~/kypr` で `mise run export-nemo` → typecheck・`node --test scripts/kypr-vendor.test.mjs`
- [x] `scripts/verify-kypr.mjs` の保管庫にアイコンの行を 1 件入れ、今の件数（9 件）の検査がそのまま通ること（隠れていなければ 10 件になる）
- [x] `mise run verify:only kypr`

### Phase 4b 前の準備 [人間👨‍💻]
- [ ] 4a をリリースし、使っている全部の Mac の常用版を上げる

### Phase 4b: 書く [AI🤖]
- [ ] kypr の `VaultSession` に、ホストから行の情報（id・revision・updatedAt・使えるか）を返すメソッドを足して export し直す（`baseRevision` と 30 日の判定に要る）
- [ ] favicon を PNG に描き直す処理
- [ ] 解除中の同期の後にアイコンを作る・書き直す（上の決めごと）
- [ ] 表示: 履歴に無いホストは保管庫のアイコンを使う
- [ ] `scripts/verify-kypr.mjs` に、書いたアイコンの形・2 回目で書かないこと・一覧に出ないことを足す

## ログ
### 試したこと・わかったこと
- 2026-09-30: export-nemo（kypr `346f1e8`）→ typecheck 通過・`kypr-vendor.test.mjs` 5 件 PASS。`verify:only kypr` は、別の Claude Code のセッションが検証用の Nemo（`scripts/dev.mjs --built`）を起動中だったので、終わるのを待ってから回した
- `verify:only kypr`: アイコンの行を入れると 3 件 FAIL（巻き戻しの件数・ロック中の件数・キャッシュの行数）。どれもサーバー・キャッシュの**行数**と一覧の件数を比べる検査で、アイコンの行はサーバーとキャッシュにあるが一覧に出ない（仕様どおり）ため 1 ずれた。検査のほうを直した（ロック中の `itemCount` はキャッシュの行数で、画面には解除中の件数しか出さないので製品は変えない）→ 153 件 PASS。解除後の件数は 9 のまま（隠れていなければ 10）。`pnpm test` 569 件 PASS・lint 通過

### 方針変更
