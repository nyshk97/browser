# Nemo

Arc の代替として自分用に作ったブラウザ。**2026-08 から常用している。**
Electron + `BaseWindow` + タブごとの `WebContentsView` で、Chrome 拡張（Bitwarden 等）がそのまま動く。

![Nemo](docs/images/readme.png)

Arc のサイドバー（Favorites / ピン留め / 一時タブ）・コマンドバー・Peek・Split View・Live Folder・
シークレットウィンドウ・既定ブラウザ対応・アプリ内自動更新まで、乗り換えに必要なものは一通り揃えた。

## Highlights

- **Chrome 拡張（Manifest V3）がそのまま動く。** `electron-chrome-extensions` に足りない API
  （`chrome.storage.onChanged` 等）を polyfill し、service worker が idle で止まった後も Bitwarden の
  自動入力が壊れないことを、実物の拡張を入れた CI で毎回確かめている
- **枠が何十個あっても起動が重くならない。** Favorites / ピン留めは「枠」で、タブは押した瞬間に生まれる。
  起動時にタブ実体を 1 つも作らない
- **「ちょっと見る」と「腰を据えて読む」を ⌘O ひとつで分ける。** リンクは今のページの上に浮かぶ Peek で開き、
  ターミナルや Slack から踏んだ URL はメインウィンドウを奪わず小窓（Little Nemo）で出る。どちらも ⌘O でタブに昇格
- **GitHub の PR がサイドバーに勝手に並び、勝手に消える。** レビュー依頼と自分の未マージ PR を Live Folder として表示。
  Arc のバイナリを `strings` で読んで実装を確かめたうえで、別の方式を採った
- **別の Mac への移行が設定画面で完結する。** ピン留め / Favorites は iCloud 上のセーブスロットに保存して読み込む。
  Basic 認証のパスワードは端末固有の鍵（`safeStorage`）で暗号化されていて他の Mac では復号できないため、
  持ち出すときはパスフレーズで暗号化し直す
- **検証はブラウザ自身が回す。** `mise run verify` がビルド → 起動 → CDP で実ブラウザを操作 → 後片付けまで行う
  （17 スイート・ユニットテスト 342 件）。変更ファイルから必要なスイートだけを選んで走らせる
- **常用しながら開発できる。** dev 版は表示名・bundle id・アイコン・データディレクトリが常用版と別

## スタンス

- **個人用**。販売・配布・サポートの予定はない。Release のバイナリと Homebrew tap も自分のためのもので、他の環境で動く保証はしない
- **Issue / Pull Request は受け付けない**。自分の好みで好き勝手に変えていくので、要望や修正を取り込む前提がない
- **フォークして自分用に改造するのは自由**。ライセンスは GPL-3.0-only（依存の `electron-chrome-extensions` が GPL のため）。改造版を配布するならソース公開が条件

> **Note (English):** Personal project. No support, no issues, no pull requests.
> Fork it and make it yours — it's GPL-3.0-only.

## 使い方

```bash
mise run setup   # 依存 + 拡張 artifact を揃える
mise run dev     # 開発版を起動
```

タスク一覧は `mise tasks`。リリース・拡張・ブックマークのセーブスロットなどの運用手順は
[docs/operations.md](docs/operations.md)、設計は [docs/plans/](docs/plans/)、ライセンスの経緯は
[docs/licenses.md](docs/licenses.md) を参照。
