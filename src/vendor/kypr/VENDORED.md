# kypr（vendored）

このディレクトリは kypr（private リポジトリ `nyshk97/kypr`）の暗号・同期のコードのコピー。**手で編集しない**。
直すときは kypr 側を直し、kypr で `mise run export-nemo` を実行してコピーし直す。

- コピー元のコミット: `756e7419f56c3a468ad6b552ee81399078b227bc`
- 中身: `crypto/`（packages/crypto/src。CLI は除く）・`client/`（packages/client/src）・`test-vectors/`
- `"@kypr/crypto"` の import は相対パス（`../crypto/index.ts`）に書き換えてある
- 仕様: kypr の `docs/crypto-spec.md`

## ライセンス

- kypr のコード（`crypto/`・`client/`・`test-vectors/`）: Nemo と同じ GPL-3.0-only（作者が同じ）
- `client/psl-data.ts`: Public Suffix List（https://publicsuffix.org/）から生成したデータ。Mozilla Public License 2.0
