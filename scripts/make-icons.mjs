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

// 見た目はモック（scratchpad の nemo-icon-v10）で詰めた値。
// 変えたら build/icon.png を目で見て確かめる。
const FISH = {
  sway: 5, // 背骨の振り。0 にすると泳がずに「置いてある」ように見える
  girth: 12, // 体の太さ
  segments: 5,
  length: 52,
  headY: 16,
  tailLen: 15,
  tailSpread: 16,
  rot: -34, // 左上へ泳ぐ
  dx: 6,
  dy: -6,
  fill: 0.67, // 枠に対する大きさ
  round: 6, // 頂点の丸め。輪郭だけ柔らかくして、面の折れは残す
  bubbles: 4,
  bubbleSize: 5
}
const INK = { h: 16, s: 88, l: 60 } // サンゴ
const SEA = ['#2fb0cf', '#0d5f86']
const LIGHT = 13 // 光は左上から固定（魚を傾けても陰影は回らない）
const RELIEF = 0.34 // 面ごとの明暗（形由来）の効き

/** 決定的な擬似乱数（海のゆらぎと面のムラに使う。毎回同じ絵を出すため） */
function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hsl = (h, s, l) => `hsl(${h} ${s}% ${Math.max(3, Math.min(97, l))}%)`
const poly = (pts) => `M ${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`

/**
 * 背骨に沿って身を付けた魚（真上から見た姿）を 100×100 の座標系で組む。
 *
 * 頭を丸く・尾柄をくびれさせ・尾を扇にするのは、これを外すと途端にロケットに見えるため。
 */
function fishFaces(o) {
  const n = o.segments
  const spine = []
  const half = []
  for (let i = 0; i <= n; i += 1) {
    const u = i / n
    spine.push([50 + o.sway * Math.sin(u * Math.PI * 1.15), o.headY + u * o.length])
    half.push(o.girth * Math.sin(Math.PI * (0.3 + 0.62 * u)))
  }
  const normal = (i) => {
    const a = spine[Math.max(0, i - 1)]
    const b = spine[Math.min(n, i + 1)]
    const vx = b[0] - a[0]
    const vy = b[1] - a[1]
    const len = Math.hypot(vx, vy) || 1
    return [-vy / len, vx / len]
  }
  const L = []
  const R = []
  for (let i = 0; i <= n; i += 1) {
    const [nx, ny] = normal(i)
    L.push([spine[i][0] - nx * half[i], spine[i][1] - ny * half[i]])
    R.push([spine[i][0] + nx * half[i], spine[i][1] + ny * half[i]])
  }
  const faces = []
  // 頭の先（これが無いと頭が直線で切り落とされて見える）
  const [hx, hy] = spine[0]
  const [qx, qy] = spine[1]
  const al = Math.hypot(hx - qx, hy - qy) || 1
  const head = [hx + ((hx - qx) / al) * half[0] * 0.8, hy + ((hy - qy) / al) * half[0] * 0.8]
  faces.push({ p: [L[0], head, spine[0]], d: 10 }, { p: [head, R[0], spine[0]], d: 2 })
  // 尾（体より先に描いて奥に置く）
  const [tx, ty] = spine[n]
  const [px, py] = spine[n - 1]
  const dl = Math.hypot(tx - px, ty - py) || 1
  const ux = (tx - px) / dl
  const uy = (ty - py) / dl
  const tip = (s) => [
    tx + ux * o.tailLen - uy * s * o.tailSpread,
    ty + uy * o.tailLen + ux * s * o.tailSpread
  ]
  const notch = [tx + ux * o.tailLen * 0.5, ty + uy * o.tailLen * 0.5]
  faces.push(
    { p: [L[n], tip(-1), notch], d: -6 },
    { p: [R[n], tip(1), notch], d: -14 },
    { p: [L[n], notch, R[n]], d: -10 }
  )
  // 胴（中央の稜線で左右に割る）
  for (let i = 0; i < n; i += 1) {
    faces.push(
      { p: [L[i], spine[i], spine[i + 1]], d: 8 - i * 1.2 },
      { p: [L[i], spine[i + 1], L[i + 1]], d: 5 - i * 1.2 },
      { p: [R[i], spine[i + 1], spine[i]], d: -4 - i * 1.2 },
      { p: [R[i], R[i + 1], spine[i + 1]], d: -7 - i * 1.2 }
    )
  }
  const a = (o.rot * Math.PI) / 180
  const move = ([x, y]) => [
    50 + (x - 50) * Math.cos(a) - (y - 50) * Math.sin(a) + o.dx,
    50 + (x - 50) * Math.sin(a) + (y - 50) * Math.cos(a) + o.dy
  ]
  return {
    faces: faces.map((f) => ({ ...f, p: f.p.map(move) })),
    tail: move(spine[n]),
    dir: [Math.sin(a), -Math.cos(a)] // 進行方向（泡を後ろに流すのに使う）
  }
}

/** 泡は尾の後ろから出す（前に出ていると泳いでいる向きと矛盾する） */
function bubbleTrail(tail, dir, count, size) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    const t = i + 1
    const off = (i % 2 ? 1 : -1) * 4.6
    out.push([
      tail[0] - dir[0] * (12 + t * 9.5) + dir[1] * off,
      tail[1] - dir[1] * (12 + t * 9.5) - dir[0] * off,
      Math.max(1.3, size - t * 1.05)
    ])
  }
  return out
}

/** 海はローポリのパッチで敷く（べた塗りより水の中に見える） */
function seaPatch(inset, box) {
  const n = 4
  const cell = box / n
  const rnd = rng(19)
  const out = []
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const x = inset + i * cell
      const y = inset + j * cell
      const q = [
        [x, y],
        [x + cell, y],
        [x + cell, y + cell],
        [x, y + cell]
      ]
      for (const t of [
        [q[0], q[1], q[2]],
        [q[0], q[2], q[3]]
      ]) {
        const l = 58 - (j / n) * 13 + rnd() * 6
        out.push(`<path d="${poly(t)}" fill="hsl(192 62% ${l.toFixed(1)}%)"/>`)
      }
    }
  }
  return out.join('')
}

function svg({ dev }) {
  const size = 1024
  // macOS のアイコンは周囲に余白を取るのが作法（実描画は約 82%）
  const inset = 92
  const box = size - inset * 2
  const radius = box * 0.2237

  const { faces, tail, dir } = fishFaces(FISH)
  const bubbles = bubbleTrail(tail, dir, FISH.bubbles, FISH.bubbleSize)

  // 魚と泡をまとめて枠に収める（泡を外すと構図が枠からはみ出す）
  const xs = [
    ...faces.flatMap((f) => f.p.map((p) => p[0])),
    ...bubbles.flatMap((b) => [b[0] - b[2], b[0] + b[2]])
  ]
  const ys = [
    ...faces.flatMap((f) => f.p.map((p) => p[1])),
    ...bubbles.flatMap((b) => [b[1] - b[2], b[1] + b[2]])
  ]
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const w = x1 - x0
  const h = y1 - y0
  const scale = (box * FISH.fill) / Math.max(w, h)
  const tf = `translate(${inset + (box - w * scale) / 2 - x0 * scale} ${
    inset + (box - h * scale) / 2 - y0 * scale
  }) scale(${scale})`

  const rnd = rng(31)
  const defs = []
  const paint = []
  faces.forEach((f, i) => {
    const cx = (f.p[0][0] + f.p[1][0] + f.p[2][0]) / 3
    const cy = (f.p[0][1] + f.p[1][1] + f.p[2][1]) / 3
    const lit = (((50 - cx) * 0.42 + (50 - cy) * 0.78) / 50) * LIGHT
    const l = INK.l + lit + f.d * RELIEF + (rnd() * 2.4 - 1.2)
    const id = `f${i}`
    defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hsl(INK.h, INK.s, l + 3)}"/>
      <stop offset="1" stop-color="${hsl(INK.h, INK.s + 3, l - 4)}"/></linearGradient>`)
    paint.push(`<path d="${poly(f.p)}" fill="url(#${id})"/>`)
  })
  // 同色の太い stroke を下に敷いて角を丸める（頂点だけ丸まり、面の折れは残る）
  const silhouette = faces.map((f) => `<path d="${poly(f.p)}"/>`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${SEA[0]}"/>
      <stop offset="1" stop-color="${SEA[1]}"/>
    </linearGradient>
    <clipPath id="rounded">
      <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}"/>
    </clipPath>
    ${defs.join('\n')}
  </defs>
  <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}" fill="url(#bg)"/>
  <g clip-path="url(#rounded)">
    ${seaPatch(inset, box)}
    <g transform="${tf}">
      <g fill="${hsl(INK.h, INK.s, INK.l)}" stroke="${hsl(INK.h, INK.s, INK.l)}" stroke-width="${FISH.round}"
         stroke-linejoin="round" stroke-linecap="round">${silhouette}</g>
      <g stroke-linejoin="round">${paint.join('')}</g>
      ${bubbles
        .map(
          ([x, y, r]) =>
            `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6"/>`
        )
        .join('')}
    </g>
  </g>
  ${
    dev
      ? `<g clip-path="url(#rounded)">
    <path d="M ${size - inset - 470} ${size - inset} L ${size - inset} ${size - inset - 470} L ${size - inset} ${size - inset - 250} L ${size - inset - 250} ${size - inset} Z" fill="#0b2f45"/>
    <text x="${size - inset - 168}" y="${size - inset - 138}" fill="#ffffff" font-family="-apple-system, Helvetica, sans-serif" font-size="132" font-weight="800" text-anchor="middle" transform="rotate(-45 ${size - inset - 168} ${size - inset - 138})">DEV</text>
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
