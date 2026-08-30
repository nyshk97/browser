#!/usr/bin/env node
/**
 * CHANGELOG パーサの回帰テスト。
 *
 * 一番の要点は **``` フェンスの中の見出しを拾わないこと**。
 * CHANGELOG には「書き方」の説明として `## [Unreleased]` を含むコード例が置いてあり、
 * これを拾うと**書き方の説明文がそのままリリースノートとして公開される**。
 *
 *   node --test scripts/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { changelogPath, findSection, parseSections, releaseSection } from './changelog.mjs'

const SAMPLE = [
  '# Changelog',
  '',
  '## 書き方',
  '',
  '```markdown',
  '## [Unreleased]',
  '',
  '### 追加',
  '',
  '- 説明用のダミー行',
  '```',
  '',
  '## [Unreleased]',
  '',
  '### 追加',
  '',
  '- 本物の行',
  '',
  '## [0.1.0] - 2026-08-01',
  '',
  '### 追加',
  '',
  '- 最初のリリース',
  ''
].join('\n')

test('フェンスの中の見出しをセクションとして拾わない', () => {
  const versions = parseSections(SAMPLE).map((section) => section.version)
  assert.deepEqual(versions, ['Unreleased', '0.1.0'])
})

test('セクションの本文は次の見出しの手前まで', () => {
  assert.equal(findSection(SAMPLE, 'Unreleased').body, '### 追加\n\n- 本物の行')
  assert.equal(findSection(SAMPLE, '0.1.0').body, '### 追加\n\n- 最初のリリース')
  assert.equal(findSection(SAMPLE, '0.1.0').date, '2026-08-01')
})

test('release は [Unreleased] を確定して空の枠を積む', () => {
  const next = releaseSection(SAMPLE, '0.2.0', '2026-08-23')
  const sections = parseSections(next)
  assert.deepEqual(
    sections.map((s) => s.version),
    ['Unreleased', '0.2.0', '0.1.0']
  )
  // 確定した版に元の本文が移り、新しい [Unreleased] は空になる
  assert.equal(findSection(next, '0.2.0').body, '### 追加\n\n- 本物の行')
  assert.equal(findSection(next, 'Unreleased').body, '')
  // 「書き方」のコード例は書き換えない
  assert.ok(next.includes('- 説明用のダミー行'))
})

test('release は空の [Unreleased] と重複した版を拒む', () => {
  const emptied = releaseSection(SAMPLE, '0.2.0', '2026-08-23')
  assert.throws(() => releaseSection(emptied, '0.3.0', '2026-08-23'), /空/)
  assert.throws(() => releaseSection(SAMPLE, '0.1.0', '2026-08-23'), /既に/)
})

test('実物の CHANGELOG に [Unreleased] があり、書き方のコード例を拾っていない', () => {
  const text = fs.readFileSync(changelogPath, 'utf8')
  const unreleased = findSection(text, 'Unreleased')
  assert.ok(unreleased, '[Unreleased] セクションが無い')
  assert.ok(!unreleased.body.includes('```'), 'フェンスを本文として取り込んでいる')
})

/* ------------------------------------------------------------------ *
 * リリースの資産選び
 * ------------------------------------------------------------------ */

test('配る資産は今回のバージョンのものだけ', async () => {
  const { selectAssets } = await import('./release.mjs')
  const names = [
    'Nemo-0.1.0-arm64.dmg',
    'Nemo-0.1.0-arm64.dmg.blockmap',
    'Nemo-0.1.0-arm64-mac.zip',
    'Nemo-0.1.0-arm64-mac.zip.blockmap',
    'latest-mac.yml',
    'mac-arm64',
    'builder-debug.yml'
  ]
  assert.deepEqual(selectAssets(names, '0.1.0'), [
    'Nemo-0.1.0-arm64-mac.zip',
    'Nemo-0.1.0-arm64-mac.zip.blockmap',
    'Nemo-0.1.0-arm64.dmg',
    'Nemo-0.1.0-arm64.dmg.blockmap',
    'latest-mac.yml'
  ])
})

test('前回のビルドが残っていたら配らずに落とす', async () => {
  const { selectAssets } = await import('./release.mjs')
  // 実際に 0.0.0 の dmg が 0.1.0 の Release に並んだ（掃除の漏れを配る前に捕まえる）
  assert.throws(() => selectAssets(['Nemo-0.0.0-arm64.dmg', 'Nemo-0.1.0-arm64.dmg'], '0.1.0'), /0\.0\.0/)
})

test('cask は配る dmg の URL と sha256 を指す', async () => {
  const { renderCask } = await import('./release.mjs')
  const sha = 'a'.repeat(64)
  const cask = renderCask('0.8.1', sha)
  assert.match(cask, /^cask "nemo" do$/m)
  assert.match(cask, /version "0\.8\.1"/)
  assert.match(cask, new RegExp(`sha256 "${sha}"`))
  // selectAssets が配る dmg の実ファイル名（Nemo-<version>-arm64.dmg）と一致していること
  assert.match(cask, /releases\/download\/v#\{version\}\/Nemo-#\{version\}-arm64\.dmg/)
  assert.match(cask, /auto_updates true/)
  assert.match(cask, /uninstall quit: "local\.nyshk97\.nemo"/)
})

test('cask に書けない値は落とす', async () => {
  const { renderCask } = await import('./release.mjs')
  assert.throws(() => renderCask('0.8', 'a'.repeat(64)), /バージョン/)
  assert.throws(() => renderCask('0.8.1', 'xyz'), /sha256/)
})
