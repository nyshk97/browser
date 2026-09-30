# kypr の「端末の登録と合言葉」に対応する

## 概要・やりたいこと

kypr（`~/kypr`）に「登録していない端末からのログインには合言葉を求める」しくみを入れた（kypr の plan `docs/plans/2026-09-30-1345-device-passphrase.md`、仕様は `docs/crypto-spec.md`「端末の登録と合言葉」）。
共通のクライアントは端末の口（`ClientDeps.device`）が無くても今までどおり動くが、**kypr で合言葉を設定すると、対応していない Nemo はログインできなくなる**。
Nemo の kypr 統合（ツールバー・ポップアップ・自動入力）を対応させ、合言葉を設定できる状態にする。

## 決定事項

| 項目 | 決定 |
| --- | --- |
| 端末トークンの置き場所 | `userData/kypr/device-token.json`。`device-keys.json` と同じく `getSecretBackend()`（`safeStorage`）で暗号化する。読めない・開けないファイルは捨てて（合言葉で入れば登録し直される）、「トークン無し」とは取り違えない（読み出しの失敗は投げる） |
| ログアウト | 端末トークンは消さない（端末の登録はアカウントと別に残す。取り消しは kypr の Web の「端末と合言葉」） |
| 端末の名前 | `Nemo（<コンピューター名>）`。Mac が複数あっても一覧で見分けられるように |
| 登録 | Nemo は自分の Mac なので常に登録する（合言葉が未設定のあいだは最初のログインで自動、設定後は合言葉で入ったときに） |
| 取り消されたとき | サーバーが device-required を返したら、共通のクライアントがキャッシュと端末トークンを消す。Nemo は Touch ID の鍵も捨て、`KyprStatus.needsPassphrase` を立ててポップアップ・設定画面の解除の画面に合言葉の欄を出す |
| 合言葉の検証値 | マスターパスワードと同じく KDF の worker（`kdf-worker.ts`）で導出する（`kind: 'passphrase'`） |

## ステップ

- [x] kypr で `mise run export-nemo`（コピー元 `fcaf445`）
- [x] 端末トークンの保存（`src/main/kypr/device-token.ts`）・合言葉の導出（`kdf.ts` / `kdf-worker.ts`）・`ClientDeps` への配線と `needsPassphrase`（`index.ts`）
- [x] IPC（`kyprSignIn` の `passphrase`）・型・解除の画面の合言葉の欄（`Kypr.tsx`）
- [x] 模擬サーバーの端末と合言葉・自走検証（`verify-kypr.mjs` の「13b」）
- [ ] リリース → 常用版で一度ログインし直して登録 → kypr で合言葉を設定

## ログ

### 方針変更

### 想定外の失敗
