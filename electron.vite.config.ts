import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * ブラウザ UI の CSP。
 *
 * UI は `nemo://ui/` から配信する（`file://` を使わない）。
 * 本番は `script-src 'self'` まで絞る。
 * dev は Vite の HMR（inline preamble と ws 接続）が必要なぶんだけ緩める。
 * **緩めるのは dev server 経由で配信するときだけで、ビルド成果物には入らない。**
 */
const PROD_CSP = [
  "default-src 'self'",
  "img-src 'self' crx: data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "img-src 'self' crx: data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'nemo-csp',
    transformIndexHtml(html) {
      return html.replace('%NEMO_CSP%', isDev ? DEV_CSP : PROD_CSP)
    }
  }
}

/**
 * ビルド種別。
 * `NEMO_BUILD_CHANNEL=stable` を指定したときだけ常用版になる。
 * 指定なしのビルドは dev 版（データディレクトリも bundle id も別）。
 */
const buildChannel = process.env['NEMO_BUILD_CHANNEL'] === 'stable' ? 'stable' : 'dev'

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __NEMO_CHANNEL__: JSON.stringify(buildChannel)
      },
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
          input: {
            ui: resolve('src/preload/ui.ts'),
            // 拡張ページ向けの chrome.* 補完（`src/main/index.ts` が pageSession に登録する）
            // frame と service worker の両方に同じファイルを配る（分けると共有 chunk を require できない）
            'extension-shim': resolve('src/preload/extension-shim.ts')
          },
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
      server: {
        // dev でも UI の origin は nemo://ui のままにする（main が中継する）。
        // HMR の ws だけは dev server へ直接つなぐので、宛先を明示する。
        hmr: { protocol: 'ws', host: '127.0.0.1' }
      },
      build: {
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      }
    }
  }
})
