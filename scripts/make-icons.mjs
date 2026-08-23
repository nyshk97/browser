#!/usr/bin/env node
/**
 * アプリアイコンを生成する（`mise run icons`）。
 *
 * SVG を Electron でラスタライズして `build/icon.iconset` を作り、`iconutil` で `.icns` にする。
 * **生成物（PNG / icns）はコミットする**（ビルド機に追加のツールを要求しないため）。
 *
 * dev 版は右下に DEV リボンを入れて常用版と見分けられるようにする
 * （dev 版と常用版を同時に Dock に置くので、アイコンが同じだと必ず取り違える）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { projectRoot } from './lib/harness.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const buildDir = path.join(projectRoot, 'build')

/** 対数螺旋（オウムガイ = Nautilus）。Captain Nemo の潜水艦から。 */
function spiralPath(cx, cy, turns, startRadius, growth, thickness) {
  const steps = turns * 90
  const outer = []
  const inner = []
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * turns * Math.PI * 2
    const r = startRadius * Math.pow(growth, t / (Math.PI * 2))
    // 内側に向かって細くする
    const w = thickness * (0.25 + 0.75 * (i / steps))
    outer.push([cx + Math.cos(t) * (r + w / 2), cy + Math.sin(t) * (r + w / 2)])
    inner.push([cx + Math.cos(t) * (r - w / 2), cy + Math.sin(t) * (r - w / 2)])
  }
  const points = [...outer, ...inner.reverse()]
  return `M ${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
}

function svg({ dev }) {
  const size = 1024
  // macOS のアイコンは周囲に余白を取るのが作法（実描画は約 82%）
  const inset = 92
  const box = size - inset * 2
  const radius = box * 0.2237
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b3350"/>
      <stop offset="1" stop-color="#141726"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eaf1ff"/>
      <stop offset="1" stop-color="#5b9dff"/>
    </linearGradient>
    <clipPath id="rounded">
      <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}"/>
    </clipPath>
  </defs>
  <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}" fill="url(#bg)"/>
  <path d="${spiralPath(size / 2, size / 2 + 18, 2.6, 34, 2.35, 92)}" fill="url(#ink)"/>
  ${
    dev
      ? `<g clip-path="url(#rounded)">
    <path d="M ${size - inset - 470} ${size - inset} L ${size - inset} ${size - inset - 470} L ${size - inset} ${size - inset - 250} L ${size - inset - 250} ${size - inset} Z" fill="#ff8a3d"/>
    <text x="${size - inset - 168}" y="${size - inset - 138}" fill="#1a1205" font-family="-apple-system, Helvetica, sans-serif" font-size="132" font-weight="800" text-anchor="middle" transform="rotate(-45 ${size - inset - 168} ${size - inset - 138})">DEV</text>
  </g>`
      : ''
  }
</svg>`
}

/**
 * Electron で SVG を PNG にする（他のツールを要求しない）。
 *
 * - SVG は data: URL ではなく**ファイルから読ませる**
 *   （data: URL は長さで `ERR_FAILED` になる。1024px 版で踏んだ）
 * - **ウィンドウは1枚だけ**作り、1024px で撮ってから縮小する
 *   （offscreen なウィンドウを作り直すと2枚目以降のロードが `ERR_FAILED` になる）
 */
function rasterize(svgText, sizes, outPrefix) {
  const htmlPath = path.join(buildDir, '.icon-source.html')
  const script = path.join(buildDir, '.rasterize.cjs')
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>
${svgText}`
  )
  fs.writeFileSync(
    script,
    `const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const sizes = ${JSON.stringify(sizes)}
const outPrefix = ${JSON.stringify(outPrefix)}
const htmlPath = ${JSON.stringify(htmlPath)}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true, sandbox: true }
  })
  await win.loadFile(htmlPath)
  await new Promise((r) => setTimeout(r, 400))
  const full = await win.webContents.capturePage()
  if (full.isEmpty()) throw new Error('capturePage が空を返した')
  for (const size of sizes) {
    const image = size === 1024 ? full : full.resize({ width: size, height: size, quality: 'best' })
    fs.writeFileSync(outPrefix + size + '.png', image.toPNG())
  }
  win.destroy()
  app.quit()
}).catch((error) => {
  console.error('[rasterize]', error)
  process.exit(1)
})`
  )
  execFileSync(electronPath, [script], { stdio: 'inherit' })
  fs.rmSync(script, { force: true })
  fs.rmSync(htmlPath, { force: true })
}

const ICONSET_SIZES = [16, 32, 64, 128, 256, 512, 1024]

function buildIcns(name, dev) {
  const iconset = path.join(buildDir, `${name}.iconset`)
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })
  rasterize(svg({ dev }), ICONSET_SIZES, path.join(iconset, 'raw-'))

  // iconutil が要求する名前に並べ替える
  const rename = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png']
  ]
  for (const [size, target] of rename) {
    fs.copyFileSync(path.join(iconset, `raw-${size}.png`), path.join(iconset, target))
  }
  for (const size of ICONSET_SIZES) fs.rmSync(path.join(iconset, `raw-${size}.png`), { force: true })

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, `${name}.icns`)], {
    stdio: 'inherit'
  })
  // 中身を目で確認できるように 512px を1枚だけ残す（iconset 自体はコミットしない）
  fs.copyFileSync(path.join(iconset, 'icon_512x512.png'), path.join(buildDir, `${name}.png`))
  console.log(`[icons] ${name}.icns を作った`)
}

fs.mkdirSync(buildDir, { recursive: true })
buildIcns('icon', false)
buildIcns('icon-dev', true)
