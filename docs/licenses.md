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

## 依存ライブラリの棚卸し（2026-08-23 時点、`node_modules` 全体）

| ライセンス | 件数 | 備考 |
|---|---|---|
| MIT | 75 | GPL-3.0 と両立する |
| ISC | 7 | 同上 |
| Apache-2.0 | 3 | GPL-3.0 とは片方向互換（Apache-2.0 のコードを GPL-3.0 の成果物に取り込める）。逆向きは不可 |
| BSD-3-Clause | 1 | 両立する |
| BSD-2-Clause | 1 | 両立する |
| CC-BY-4.0 | 1 | `caniuse-lite`（ビルド時のデータのみ） |
| デュアル（GPL-3.0 / Patron） | 1 | `electron-chrome-extensions` — **これが GPL-3.0 を選ぶ理由** |

`pnpm install --frozen-lockfile` した直後の `node_modules/.pnpm` 全体を走査した結果（dev 依存を含む）。

copyleft と衝突する依存（AGPL・SSPL 等）は無い。

## Phase 1-1 に残す作業

- 依存ライブラリの notice を成果物に同梱する（`electron-builder` の `extraResources` 等）
- README にソース入手方法（この repo）を明記する
- 個人情報・シークレットは public repo に入れない運用を `.gitignore` と README に落とす
