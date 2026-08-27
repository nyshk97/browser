#!/usr/bin/env node
/**
 * 「変更ファイル → 回す検証」の逆引きのテスト。
 *
 * マッピングが腐ったときの症状は **「速く PASS する」** なので、実行しても気づけない。
 * だからここで腐りそのものを落とす:
 *   - 対応表に書いたパスが実在すること（リネームで黙って外れない）
 *   - `scripts/verify-*.mjs` が漏れなく「担当あり」か「意図的にフル」に分類されていること
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KNOWN_TARGETS,
  NEEDS_APP,
  OPT_IN_ONLY,
  OWNERS,
  RESTART_COMPANIONS,
  UNMAPPED_VERIFY_SCRIPTS,
  selectVerifyTargets
} from './lib/verify-targets.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('対応表の名前はすべて KNOWN_TARGETS にある', () => {
  for (const [file, targets] of OWNERS) {
    for (const target of targets) {
      assert.ok(KNOWN_TARGETS.includes(target), `${file} → 知らない検証名 ${target}`)
    }
  }
  for (const name of [...NEEDS_APP, ...RESTART_COMPANIONS, ...OPT_IN_ONLY]) {
    assert.ok(KNOWN_TARGETS.includes(name), `知らない検証名 ${name}`)
  }
})

test('対応表に書いたパスは実在する（リネームで黙って外れない）', () => {
  for (const file of [...OWNERS.keys(), ...UNMAPPED_VERIFY_SCRIPTS]) {
    assert.ok(fs.existsSync(path.join(projectRoot, file)), `対応表にあるのに実在しない: ${file}`)
  }
})

test('scripts/verify-*.mjs はすべて分類されている（足しただけで放置できない）', () => {
  const scripts = fs
    .readdirSync(path.join(projectRoot, 'scripts'))
    .filter((name) => name.startsWith('verify-') && name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => `scripts/${name}`)
  for (const file of scripts) {
    assert.ok(
      OWNERS.has(file) || UNMAPPED_VERIFY_SCRIPTS.includes(file),
      `${file} を verify-targets.mjs の OWNERS か UNMAPPED_VERIFY_SCRIPTS に載せる`
    )
  }
})

test('`mise run verify` が回すスイートには担当スクリプトがある', () => {
  // restart は専用スクリプトを持たない（他スイートの --restart-write / --read の入れ物）
  const owned = new Set([...OWNERS.values()].flat())
  for (const name of KNOWN_TARGETS) {
    if (name === 'restart') continue
    assert.ok(owned.has(name), `${name} を担当するファイルが対応表に無い`)
  }
})

test('変更が無ければ回さない', () => {
  const result = selectVerifyTargets([])
  assert.equal(result.kind, 'none')
  assert.match(result.reason, /変更なし/)
})

test('無関係パスだけなら回さない', () => {
  const result = selectVerifyTargets([
    'docs/plans/2026-08-27-1800-verify-speedup.md',
    'README.md',
    '.github/workflows/ci.yml'
  ])
  assert.equal(result.kind, 'none')
  assert.match(result.reason, /無関係パスのみ/)
})

test('SplitRow.tsx だけなら split と restart を選ぶ', () => {
  const result = selectVerifyTargets(['src/renderer/components/SplitRow.tsx'])
  assert.equal(result.kind, 'subset')
  assert.deepEqual(result.targets, ['split', 'restart'])
})

test('無関係パスは混ざっていても結果を変えない', () => {
  const result = selectVerifyTargets(['docs/plans/x.md', 'src/renderer/components/SplitRow.tsx'])
  assert.equal(result.kind, 'subset')
  assert.deepEqual(result.targets, ['split', 'restart'])
})

test('restart に相乗りしないスイートは restart を連れて来ない', () => {
  const result = selectVerifyTargets(['scripts/verify-switcher.mjs', 'scripts/verify-phase2.mjs'])
  assert.equal(result.kind, 'subset')
  assert.deepEqual(result.targets, ['phase2', 'switcher'])
})

test('知らないファイルはフルに倒れ、引き金が分かる', () => {
  const result = selectVerifyTargets(['src/main/registry.ts', 'scripts/verify-split.mjs'])
  assert.equal(result.kind, 'full')
  assert.deepEqual(result.triggers, ['src/main/registry.ts'])
})

test('scripts/lib と verify-all はフルに倒れる', () => {
  for (const file of ['scripts/lib/cdp.mjs', 'scripts/verify-all.mjs', 'scripts/lib/verify-targets.mjs']) {
    assert.equal(selectVerifyTargets([file]).kind, 'full', file)
  }
})

test('検証名は KNOWN_TARGETS の並び順で返る', () => {
  const result = selectVerifyTargets(['scripts/verify-call.mjs', 'scripts/verify-spike.mjs'])
  assert.deepEqual(result.targets, ['spike', 'call', 'restart'])
})
