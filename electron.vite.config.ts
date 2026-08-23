import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * ブラウザ UI の CSP。
 * 本番は `script-src 'self'` まで絞る。
 * dev は Vite の HMR（inline preamble と ws 接続）が必要なぶんだけ緩める。
 * **緩めるのは dev server で配信するときだけで、ビルド成果物には入らない。**
 */
const PROD_CSP = [
  "default-src 'self'",
  "img-src 'self' crx: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "img-src 'self' crx: data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*"
].join('; ')

function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'nemo-csp',
    transformIndexHtml(html) {
      return html.replace('%NEMO_CSP%', isDev ? DEV_CSP : PROD_CSP)
    }
  }
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: { index: resolve('src/main/index.ts') }
        }
      }
    },
    preload: {
      // electron-chrome-extensions/browser-action は preload 内で実行される
      // ブラウザ側コードなので、externalize せずバンドルする
      // （sandbox: true の preload では node_modules を require できない）
      plugins: [externalizeDepsPlugin({ exclude: ['electron-chrome-extensions'] })],
      build: {
        rollupOptions: {
          input: { ui: resolve('src/preload/ui.ts') },
          output: {
            // sandbox: true の preload は ESM をロードできないため CJS で出す
            format: 'cjs',
            entryFileNames: '[name].cjs'
          }
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      plugins: [react(), cspPlugin(isDev)],
      build: {
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      }
    }
  }
})
