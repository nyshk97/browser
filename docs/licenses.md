# ライセンス整合（Phase 0-6）

## 結論

**Nemo 本体は GPL-3.0-only で配布する。リポジトリは public にする。**

理由: `electron-chrome-extensions` は GPL-3.0 と Patron License のデュアルライセンスで、
Patron License を買わない以上 GPL-3.0 を選ぶことになる。GPL-3.0 のライブラリを
リンクしたバイナリを GitHub Release で配布すると、対応するソースの提供義務が生じる。
本体 repo を public にしてソースと Release を同じ場所に置くことで、この義務を自明に満たす。

コード上でも `ElectronChromeExtensions` の `license` オプションに `'GPL-3.0'` を明示している
（`src/main/extensions.ts`）。

## 実施済み

- `LICENSE` に GPL-3.0 の全文を配置した
- `package.json` の `license` を `GPL-3.0-only` にした
- 依存ライブラリのライセンスを棚卸しした（下記）

## 依存ライブラリの棚卸し

`mise run licenses` が `node_modules` を走査して集計する（手で数えない）。
互換リストにも例外リストにも無いライセンスが現れたら**非ゼロで終わる**ので、
依存を足したときに気づける。

2026-08-23 時点（Phase 1 完了時）の内訳:

| ライセンス | 件数 |
|---|---|
| MIT | 318 |
| ISC | 39 |
| Apache-2.0 | 20 |
| BSD-2-Clause | 12 |
| BSD-3-Clause | 11 |
| BlueOak-1.0.0 | 11 |
| 0BSD / Python-2.0 / CC-BY-4.0 / WTFPL | 各 1 |

個別に確認して受け入れたもの:

| パッケージ | ライセンス | 判断 |
|---|---|---|
| `electron-chrome-extensions` | GPL-3.0 / Patron License のデュアル | **GPL-3.0 を選ぶ**。Nemo 本体を GPL-3.0-only で public 配布する理由そのもの |
| `sanitize-filename` | WTFPL OR ISC | ISC を選ぶ |
| `type-fest` | MIT OR CC0-1.0 | MIT を選ぶ |
| `utf8-byte-length` | WTFPL OR MIT | MIT を選ぶ |

GPL-3.0 と衝突するライセンス（AGPL・独自の商用ライセンス専用など）は 1 件も無い。

## Phase 1-1 に残す作業

- 依存ライブラリの notice を成果物に同梱する（`electron-builder` の `extraResources` 等）
- README にソース入手方法（この repo）を明記する
- 個人情報・シークレットは public repo に入れない運用を `.gitignore` と README に落とす
