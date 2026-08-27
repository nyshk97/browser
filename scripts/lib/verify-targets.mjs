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
  'restart', // 再起動をまたぐ永続性（spike / phase1 / pins / split / call / live-folder の write → read）
  'migration', // 旧版セッションからの移行
  'db' // 旧スキーマの履歴 DB からの移行
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
  'restart'
]

/**
 * `restart` に相乗りしているスイート。**選んだら `restart` を随伴させる**。
 *
 * `restart` ブロックの中は `want('split')` のように入れ子で分岐しているので、
 * `split` だけを選ぶと `--restart-write` / `--restart-read` が丸ごと落ちたまま PASS する。
 */
export const RESTART_COMPANIONS = [
  'spike',
  'phase1',
  'pins',
  'split',
  'call',
  'live-folder',
  'http-auth'
]

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
  ['scripts/verify-session-migration.mjs', ['migration']],
  ['scripts/verify-db-migration.mjs', ['db']],
  // 単一の画面にしか出ないリーフのコンポーネント（親は 1 か所からしか import していない）
  ['src/renderer/components/SplitRow.tsx', ['split']],
  ['src/renderer/components/Peek.tsx', ['peek']],
  ['src/renderer/components/MiniBar.tsx', ['peek']],
  ['src/renderer/components/CallBar.tsx', ['call']],
  // HTTP 認証だけが読む main のモジュール（他のスイートは触らない）
  ['src/main/http-auth.ts', ['http-auth']],
  ['src/main/http-auth-matcher.ts', ['http-auth']],
  ['src/main/http-auth-reset.ts', ['http-auth']],
  ['src/main/store/http-auth.ts', ['http-auth']],
  ['src/shared/http-auth-rules.js', ['http-auth']],
  ['src/shared/http-auth-worker-source.js', ['http-auth']],
  ['scripts/http-auth-rules.test.mjs', ['http-auth']]
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
