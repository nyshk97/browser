// @ts-check
/**
 * 「作業ツリーの変更 → 回す検証」の逆引き（`verify-all.mjs --changed`）。
 *
 * Electron に依存しない純粋な関数だけを置き、`scripts/verify-targets.test.mjs` から直接テストする。
 *
 * 設計の要点は**倒す向き**:
 * - マッピングに載っていないファイルは「知らない」= **フル扱い**（安全側）。
 * - 「検証に影響しないと**分かっている**パス」だけを別に持ち、それだけの変更なら回さない。
 *   このリポジトリは `docs/plans/` を毎ループ触るので、これが無いと最頻ケースでフルに化ける。
 *
 * マッピングはスイートやファイルが増えるたびに腐るが、**腐っても症状は「速く PASS する」**ので
 * 気づけない。だから対応表に載せたパスが実在することと、`scripts/verify-*.mjs` が
 * 漏れなく分類されていることをユニットテストで固定する。
 *
 * **ここに登録しただけでは 1 件も回らない。** `verify-all.mjs` の `if (want('<名前>'))` の
 * 配線が別に要る（抜けていると `--only <名前>` が何も検査せず exit 0 になり、
 * 下のテストは登録しか見ないので気づけない）。スイートを足すときは
 * `KNOWN_TARGETS` / `NEEDS_APP` / `OWNERS` + `verify-all.mjs` で 1 セット。
 */

/**
 * 回せる検証の名前。`--only` はここに無い名前を**エラーにする**
 * （typo を黙って無視すると「何も回さずに PASS」になる）。
 */
export const KNOWN_TARGETS = [
  'spike', // Phase 0: 拡張
  'phase1', // ブラウザ本体
  'phase2', // ライブラリ・アーカイブ・シークレット
  'pins', // ピン留め / Favorites
  'switcher', // タブスイッチャー（⌃M）
  'peek', // Peek と小窓
  'split', // 分割ビュー（2 ペイン）
  'call', // 会議の小窓（Meet の通話コントロール）
  'live-folder', // Live Folder（GitHub の PR）
  'http-auth', // HTTP Basic 認証の自動入力
  'vim-scroll', // ページの gg / G（フル既定からは外れている。OPT_IN_ONLY を見る）
  'restart', // 再起動をまたぐ永続性（spike / phase1 / pins / split / call / live-folder の write → read）
  'migration', // 旧版セッションからの移行
  'db', // 旧スキーマの履歴 DB からの移行
  'slots', // セーブスロット（保存 / 読み込み / 移行。自分で起動する。OPT_IN_ONLY を見る）
  'auth-vault', // Basic 認証の保管庫（持ち出し。自分で起動する。OPT_IN_ONLY を見る）
  'metrics' // メモリ・CPU の定期記録と UI 例外（自分で起動する。OPT_IN_ONLY を見る）
]

/** アプリとページサーバを立てる必要があるもの（migration / db は自分で起動する）。 */
export const NEEDS_APP = [
  'spike',
  'phase1',
  'phase2',
  'pins',
  'switcher',
  'peek',
  'split',
  'call',
  'live-folder',
  'http-auth',
  'vim-scroll',
  'restart'
]

/**
 * **フル実行の既定からは外す**スイート。`--only` / `--changed` で名指ししたときだけ回る。
 *
 * フルは 529s → 372s に縮めたばかりで、ここに常設すると縮めた分を無言で戻すことになる。
 * 回るのは 3 経路: **`--only` で名指し**・**担当スイートとして `--changed` に選ばれる**・
 * **`--changed` が絞れずフルに倒れた**とき（`registry.ts` のような `OWNERS` 外を触った場合。
 * その機能の配線を直したときこそ回ってほしいので素通しにする）。
 * `verify-all.mjs` の `want()` が「`only` が空で、かつフル落ちでもないときはこれを除く」形で見る。
 *
 * **代償は「CDP の合成キーが後続スイートを壊す回帰を CI で拾えない」こと。**
 * 実行順の最後に置いてあるので後続は `restart` だけだが、
 * 撃つスイートを増やすときはここから外してフルで一度見ること。
 *
 * `slots` はキーを撃たないが、**アプリを 4 回起動し直す**のでフルが 1〜2 分伸びる。
 * `OWNERS` でスロット関連のファイルを全部拾っているので、触ったときは `--changed` で必ず回る。
 * `auth-vault` も同じ（アプリを 4 回起動し直す。**`NEEDS_APP` には入れない** ——
 * 入れると共有のアプリとページサーバまで立ち上がって、使わない起動が 1 つ増える）。
 */
export const OPT_IN_ONLY = ['vim-scroll', 'slots', 'auth-vault', 'metrics']

/**
 * `restart` に相乗りしているスイート。**選んだら `restart` を随伴させる**。
 *
 * `restart` ブロックの中は `want('split')` のように入れ子で分岐しているので、
 * `split` だけを選ぶと `--restart-write` / `--restart-read` が丸ごと落ちたまま PASS する。
 */
export const RESTART_COMPANIONS = ['spike', 'phase1', 'pins', 'split', 'call', 'live-folder', 'http-auth']

/**
 * 検証に影響しないと**分かっている**パス。
 *
 * 「無関係と分かっている」と「知らない」は別扱いにする。ここに載らないものは後者で、フルのまま。
 * @param {string} file
 */
function isIrrelevant(file) {
  if (file.startsWith('docs/')) return true
  if (file.startsWith('.github/')) return true
  if (file.startsWith('.vscode/')) return true
  if (file.endsWith('.md')) return true
  return file === 'LICENSE' || file === 'renovate.json' || file === '.gitignore'
}

/**
 * ファイル → 担当スイート。
 *
 * **載せてよいのは「そのスイートしか見ていない」と確かめたものだけ**。
 * 迷ったら載せない（＝フルに倒れる）。`src/main/registry.ts` のように複数スイートが
 * 依存する巨大ファイルは意図的に載せていない。
 *
 * 検証スクリプト自体を直す往復が `--changed` の主戦場なので、`scripts/verify-<名前>.mjs` は
 * 明示的に全部載せる（ここがフルに倒れると、効いてほしい場面で効かない）。
 * @type {Map<string, string[]>}
 */
export const OWNERS = new Map([
  ['scripts/verify-spike.mjs', ['spike']],
  ['scripts/verify-phase1.mjs', ['phase1']],
  ['scripts/verify-phase2.mjs', ['phase2']],
  ['scripts/verify-pins.mjs', ['pins']],
  ['scripts/verify-switcher.mjs', ['switcher']],
  ['scripts/verify-peek.mjs', ['peek']],
  ['scripts/verify-split.mjs', ['split']],
  ['scripts/verify-call.mjs', ['call']],
  ['scripts/verify-live-folder.mjs', ['live-folder']],
  ['scripts/verify-http-auth.mjs', ['http-auth']],
  ['scripts/verify-vim-scroll.mjs', ['vim-scroll']],
  ['scripts/verify-session-migration.mjs', ['migration']],
  ['scripts/verify-db-migration.mjs', ['db']],
  ['scripts/verify-slots.mjs', ['slots']],
  ['scripts/verify-auth-vault.mjs', ['auth-vault']],
  ['scripts/verify-metrics.mjs', ['metrics']],
  // セーブスロットだけが読むモジュール（他のスイートは触らない）。
  // `Slots.tsx` は `verify-slots.mjs` が設定画面を開いてカードの描画まで見ている
  // （IPC だけの検証だと描画例外を素通りするので、この割り当てが嘘になる）
  ['src/main/store/slots.ts', ['slots']],
  // `slots-schema.js` は `normalizeFaviconUrl` を `settings-schema.js` へ、`slotHasSections` を適用経路へ
  // 出しており、Favorites の section / favicon（`pins`）にも効く
  ['src/shared/slots-schema.js', ['slots', 'pins']],
  ['src/shared/slot-apply.js', ['slots']],
  ['src/renderer/components/Slots.tsx', ['slots']],
  // 単一の画面にしか出ないリーフのコンポーネント（親は 1 か所からしか import していない）
  ['src/renderer/components/SplitRow.tsx', ['split']],
  ['src/renderer/components/Peek.tsx', ['peek']],
  ['src/renderer/components/MiniBar.tsx', ['peek']],
  ['src/renderer/components/CallBar.tsx', ['call']],
  // HTTP 認証だけが読む main のモジュール（他のスイートは触らない）
  ['src/main/http-auth.ts', ['http-auth']],
  ['src/main/http-auth-matcher.ts', ['http-auth']],
  ['src/main/http-auth-reset.ts', ['http-auth']],
  // 保管庫が `updatedAt` / `readAllCredentials` を足したので**両方のスイートが持ち主**。
  // 広げないと、この 2 ファイルを直しても `--changed` で `auth-vault` が回らない
  ['src/main/store/http-auth.ts', ['http-auth', 'auth-vault']],
  ['src/shared/http-auth-rules.js', ['http-auth', 'auth-vault']],
  ['src/shared/http-auth-worker-source.js', ['http-auth']],
  ['scripts/http-auth-rules.test.mjs', ['http-auth', 'auth-vault']],
  // Basic 認証の保管庫だけが読むモジュール（他のスイートは触らない）
  ['src/shared/auth-vault-schema.js', ['auth-vault']],
  ['src/shared/auth-vault-crypto.js', ['auth-vault']],
  ['src/shared/auth-vault-diff.js', ['auth-vault']],
  ['src/main/store/auth-vault.ts', ['auth-vault']],
  ['src/renderer/components/AuthVault.tsx', ['auth-vault']],
  ['scripts/auth-vault-schema.test.mjs', ['auth-vault']],
  ['scripts/auth-vault-crypto.test.mjs', ['auth-vault']],
  ['scripts/auth-vault-diff.test.mjs', ['auth-vault']],
  // メモリ・CPU の定期記録と UI 例外だけが読むモジュール（他のスイートは触らない）。
  // `index.ts` / `registry.ts` / `ipc.ts` / `main.tsx` に入れた配線はここに載せない（フルに倒す）
  ['src/main/metrics.ts', ['metrics']],
  ['src/shared/metrics-summary.js', ['metrics']],
  // preload バンドルに載るが、`metrics` スイートがアプリを起動して `window.nemo` を触るので全損は拾える
  ['src/shared/ui-error.js', ['metrics']],
  ['scripts/metrics-summary.test.mjs', ['metrics']],
  ['scripts/ui-error.test.mjs', ['metrics']],
  ['scripts/metrics-report.mjs', ['metrics']],
  ['scripts/lib/metrics-aggregate.mjs', ['metrics']],
  ['scripts/metrics-report.test.mjs', ['metrics']],
  // gg / G だけが読む shared のモジュール（他のスイートは触らない）
  ['src/shared/vim-scroll.js', ['vim-scroll']],
  ['scripts/vim-scroll.test.mjs', ['vim-scroll']]
])

/**
 * `--changed` に出て来るが**どのスイートにも属さない** `scripts/verify-*.mjs`。
 *
 * ここに書いてあるものはフル扱い（= 逆引きの対象外）。
 * 新しい `verify-*.mjs` を足したのに `OWNERS` にもここにも載せていないと、
 * ユニットテストが落ちる（マッピングの腐りに気づくための仕掛け）。
 */
export const UNMAPPED_VERIFY_SCRIPTS = [
  'scripts/verify-all.mjs', // 逆引きの本体。触ったらフル
  'scripts/verify-packaged.mjs', // パッケージ版。`mise run verify` の外
  'scripts/verify-ext-smoke.mjs', // 拡張互換 smoke。`mise run verify` の外
  'scripts/verify-ext-update.mjs' // 拡張の版上げ下げ。`mise run verify` の外
]

/** `KNOWN_TARGETS` の並び順に揃える（出力を安定させる）。 */
const inKnownOrder = (names) => KNOWN_TARGETS.filter((name) => names.has(name))

/**
 * 変更ファイルから回す検証を決める。
 *
 * @param {string[]} files リポジトリルートからの相対パス（作業ツリー差分 + staged + untracked）
 * @returns {{ kind: 'none' | 'full' | 'subset', targets: string[], reason: string, triggers: string[] }}
 *   - `none`   … 回さずに正常終了してよい（`reason` に理由）
 *   - `full`   … 絞れないのでフル（`triggers` に引き金になったファイル）
 *   - `subset` … `targets` だけ回す
 */
export function selectVerifyTargets(files) {
  const unique = [...new Set(files)].filter((file) => file.length > 0).sort()
  if (unique.length === 0) {
    return { kind: 'none', targets: [], reason: '変更なし', triggers: [] }
  }

  const relevant = unique.filter((file) => !isIrrelevant(file))
  if (relevant.length === 0) {
    const shown = unique.slice(0, 3).join(', ')
    const more = unique.length > 3 ? ` ほか ${unique.length - 3} 件` : ''
    return { kind: 'none', targets: [], reason: `無関係パスのみ: ${shown}${more}`, triggers: [] }
  }

  const triggers = relevant.filter((file) => !OWNERS.has(file))
  if (triggers.length > 0) {
    return { kind: 'full', targets: [...KNOWN_TARGETS], reason: '担当スイートが確定できない', triggers }
  }

  const picked = new Set(relevant.flatMap((file) => OWNERS.get(file) ?? []))
  // 随伴。片方だけでは永続性の検証が丸ごと落ちる
  if ([...picked].some((name) => RESTART_COMPANIONS.includes(name))) picked.add('restart')
  return {
    kind: 'subset',
    targets: inKnownOrder(picked),
    reason: `変更 ${relevant.length} 件から逆引き`,
    triggers: []
  }
}
