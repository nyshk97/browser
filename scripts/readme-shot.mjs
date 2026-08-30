#!/usr/bin/env node
/**
 * README 用のスクリーンショットを撮る。
 *
 * **常用データには一切触らない。** 使い捨ての `NEMO_USER_DATA_DIR` に見せ用のピン留め /
 * Favorites / 一時タブを仕込み、GitHub の Live Folder は `verify-live-folder.mjs` と同じ
 * ローカルの差し替えサーバで架空の PR を返す（実トークンは読まれない）。
 *
 * 使い方（先に `mise run build` で out/ を作っておく）:
 *   node scripts/readme-shot.mjs            … docs/images/readme.png に保存
 *   node scripts/readme-shot.mjs --keep     … 撮った後もアプリを止めない（手で眺めたいとき）
 *
 * 画面収録の許可が要る（`screencapture -l` で撮るため）。許可が無いと失敗として終わる。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { connectUi, sleep, waitFor } from './lib/cdp.mjs'
import { getFreePort, projectRoot, stopChild, waitForHttp } from './lib/harness.mjs'
import { captureWindow } from './lib/window-shot.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const OUT = path.join(projectRoot, 'docs', 'images', 'readme.png')
const keep = process.argv.includes('--keep')

/* ------------------------------------------------------------------ *
 * 見せ用データ
 * ------------------------------------------------------------------ */

/** Favorites（4 列グリッド）。section は `messages` / `tools`。 */
const FAVORITES = [
  { url: 'https://mail.google.com/', section: 'messages', icon: null },
  { url: 'https://calendar.google.com/', section: 'messages', icon: null },
  { url: 'https://slack.com/', section: 'messages', icon: null },
  { url: 'https://www.notion.so/', section: 'messages', icon: null },
  { url: 'https://github.com/', section: 'tools', icon: null },
  { url: 'https://www.figma.com/', section: 'tools', icon: null },
  { url: 'https://vercel.com/', section: 'tools', icon: null },
  { url: 'https://dash.cloudflare.com/', section: 'tools', icon: null }
]

/** ピン留め。folder を持つものはそのフォルダの中へ。 */
const PINS = [
  { url: 'https://github.com/nyshk97/browser', folder: 'Nemo' },
  { url: 'https://www.electronjs.org/docs/latest/', folder: 'Nemo' },
  { url: 'https://developer.chrome.com/docs/extensions', folder: 'Nemo' },
  { url: 'https://developer.mozilla.org/', folder: null },
  { url: 'https://zenn.dev/', folder: null },
  { url: 'https://news.ycombinator.com/', folder: null }
]

/** 一時タブ（今日のタブ）。最後のものをアクティブにする。 */
const EPHEMERAL = [
  'https://www.electronjs.org/blog',
  'https://developer.mozilla.org/en-US/docs/Web/API/Intl/Segmenter'
]

/** 最後に表示しておくページ（ピン留めの中から）。 */
const ACTIVE_URL = 'https://github.com/nyshk97/browser'

/** Live Folder に出す架空の PR。 */
const PRS = {
  review: [
    {
      repo: 'acme/web',
      number: 1284,
      title: 'Migrate checkout to server actions',
      author: 'kaori',
      decision: null
    },
    {
      repo: 'acme/web',
      number: 1279,
      title: 'Fix flaky cart test on Safari',
      author: 'tomo',
      decision: 'CHANGES_REQUESTED'
    },
    {
      repo: 'acme/infra',
      number: 402,
      title: 'Rotate CDN tokens automatically',
      author: 'yuki',
      decision: null
    }
  ],
  mine: [
    {
      repo: 'acme/web',
      number: 1290,
      title: 'Sidebar: keyboard navigation for folders',
      author: 'me',
      decision: 'APPROVED'
    },
    {
      repo: 'acme/design-system',
      number: 88,
      title: 'Add Peek component',
      author: 'me',
      draft: true,
      decision: null
    }
  ]
}

/* ------------------------------------------------------------------ *
 * 差し替え先の GitHub（`verify-live-folder.mjs` と同じ形）
 * ------------------------------------------------------------------ */

function prNode(spec) {
  return {
    number: spec.number,
    title: spec.title,
    url: `https://github.com/${spec.repo}/pull/${spec.number}`,
    isDraft: spec.draft === true,
    updatedAt: '2026-08-30T09:00:00Z',
    reviewDecision: spec.decision ?? null,
    author: { login: spec.author },
    repository: { nameWithOwner: spec.repo }
  }
}

function startGithubMock(port) {
  const body = JSON.stringify({
    data: {
      viewer: { login: 'me' },
      reviewRequested: { issueCount: PRS.review.length, nodes: PRS.review.map(prNode) },
      mine: { issueCount: PRS.mine.length, nodes: PRS.mine.map(prNode) },
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-08-31T00:00:00Z' }
    }
  })
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/* ------------------------------------------------------------------ *
 * 本体
 * ------------------------------------------------------------------ */

const state = (ui) => ui.ev('window.nemo.getWindowState().then(s => JSON.stringify(s))').then(JSON.parse)
const shared = (ui) => ui.ev('window.nemo.getSharedState().then(s => JSON.stringify(s))').then(JSON.parse)
const json = (v) => JSON.stringify(v)

/** タブを開いて、読み込みと favicon が揃うまで待つ（揃わなくても進む）。 */
async function openAndSettle(ui, url, { timeoutMs = 15000 } = {}) {
  const key = await ui.ev(`window.nemo.createTab(${json(url)})`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tab = (await state(ui)).tabs.find((t) => t.key === key)
    if (tab && !tab.loading && tab.faviconUrl) break
    await sleep(300)
  }
  return key
}

async function main() {
  if (!fs.existsSync(path.join(projectRoot, 'out', 'main', 'index.js'))) {
    console.error('[readme-shot] out/ が無い。先に `mise run build` を回す')
    process.exit(2)
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-readme-'))
  const cdpPort = await getFreePort()
  const ghPort = await getFreePort()
  const cdp = `http://127.0.0.1:${cdpPort}`
  const gh = await startGithubMock(ghPort)

  // ウィンドウの大きさはセッション復元でしか決められないので、起動前に 1 タブぶんを仕込む
  // （`{ version, data }` の形は `JsonStore` と同じ。SESSION_VERSION は settings-schema.js）
  fs.writeFileSync(
    path.join(userDataDir, 'session.json'),
    JSON.stringify({
      version: 4,
      data: {
        windows: [
          {
            bounds: { x: 40, y: 40, width: 1400, height: 1040 },
            tabs: [{ url: 'https://example.com/', title: '', customTitle: null, lastActiveAt: Date.now() }],
            activeIndex: 0,
            splits: []
          }
        ],
        cleanExit: true,
        savedAt: Date.now()
      }
    })
  )

  const child = spawn(electronPath, ['out/main/index.js'], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      NEMO_USER_DATA_DIR: userDataDir,
      NEMO_REMOTE_DEBUGGING_PORT: String(cdpPort),
      NEMO_GITHUB_TEST_ENDPOINT: `http://127.0.0.1:${ghPort}/graphql`,
      NEMO_GITHUB_TEST_AUTH: 'dummy',
      // Keychain に触らない（許可ダイアログで止まる）
      NEMO_HTTP_AUTH_TEST_CRYPTO: 'memory',
      // `getMediaSourceId()` をもらう口
      NEMO_VERIFY_DIAGNOSTICS: '1'
    }
  })

  const cleanup = async () => {
    if (keep) {
      console.log(`[readme-shot] --keep: アプリは止めない。profile=${userDataDir} cdp=${cdp}`)
      return
    }
    await stopChild(child)
    gh.close()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }

  try {
    await waitForHttp(`${cdp}/json/list`, { child })
    const ui = await connectUi(cdp)
    await ui.ev('window.nemo.updateSettings({ liveFolderEnabled: true }).then(() => "ok")')

    // 起動時のタブは邪魔なので閉じる（あとで開くものが一覧の主役になる）
    for (const tab of (await state(ui)).tabs) await ui.ev(`window.nemo.closeTab(${json(tab.key)})`)

    // Favorites
    for (const fav of FAVORITES) {
      const key = await openAndSettle(ui, fav.url)
      await ui.ev(`window.nemo.addFavorite(${json(key)}, ${json(fav.section)})`)
      if (fav.icon) {
        const item = (await shared(ui)).favorites.find((f) => f.url === fav.url)
        if (item) await ui.ev(`window.nemo.setCustomIcon(${json(item.id)}, ${json(fav.icon)})`)
      }
      await ui.ev(`window.nemo.closeTab(${json(key)})`)
    }

    // ピン留め（フォルダは 1 つ作って、そこへ pinTabAt）
    const folderNames = [...new Set(PINS.map((p) => p.folder).filter(Boolean))]
    const folderIds = new Map()
    for (const name of folderNames) {
      await ui.ev(`window.nemo.createFolder(${json(name)})`)
      const folder = (await shared(ui)).pinned.find((n) => n.kind === 'folder' && n.title === name)
      folderIds.set(name, folder.id)
    }
    const pinKeys = new Map()
    for (const pin of PINS) {
      const key = await openAndSettle(ui, pin.url)
      if (pin.folder) {
        const id = folderIds.get(pin.folder)
        const count = (await shared(ui)).pinned.find((n) => n.id === id)?.children.length ?? 0
        await ui.ev(`window.nemo.pinTabAt(${json(key)}, ${json(id)}, ${count})`)
      } else {
        await ui.ev(`window.nemo.pinTab(${json(key)})`)
      }
      pinKeys.set(pin.url, key)
      if (pin.url !== ACTIVE_URL) await ui.ev(`window.nemo.closeTab(${json(key)})`)
    }

    // 一時タブ
    for (const url of EPHEMERAL) await openAndSettle(ui, url)

    // 最後に見せるページへ
    await ui.ev(`window.nemo.selectTab(${json(pinKeys.get(ACTIVE_URL))})`)

    // Live Folder の小見出しは折りたたみから始まるので開く
    await waitFor(ui, "document.querySelectorAll('.lf-sub').length > 0 ? 'ok' : ''", { timeoutMs: 15000 })
    await ui.ev(`document.querySelectorAll('.lf-sub[aria-expanded="false"]').forEach((b) => b.click())`)
    await waitFor(ui, "document.querySelectorAll('.lf-row').length > 0 ? 'ok' : ''")

    // hover を外して描画が落ち着くのを待ってから撮る
    await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -50, y: -50, button: 'none' })
    await sleep(2500)
    const diag = await ui.ev('window.nemo.splitDiagnostics().then((d) => JSON.stringify(d))').then(JSON.parse)
    if (!diag?.mediaSourceId)
      throw new Error('mediaSourceId が取れない（NEMO_VERIFY_DIAGNOSTICS が効いていない）')
    const file = captureWindow(diag.mediaSourceId, OUT)
    if (!file) throw new Error('撮影に失敗（画面収録の許可を確認する）')

    const sh = await shared(ui)
    const st = await state(ui)
    console.log(
      `[readme-shot] 保存: ${file}\n` +
        `  favorites=${sh.favorites.length} pinned=${sh.pinned.length}(folders=${folderNames.length}) ` +
        `tabs=${st.tabs.length} liveFolder=${sh.liveFolder?.items?.length ?? 0} 件`
    )
  } finally {
    await cleanup()
  }
}

main().catch(async (error) => {
  console.error(`[readme-shot] ${error?.stack ?? error}`)
  process.exit(1)
})
