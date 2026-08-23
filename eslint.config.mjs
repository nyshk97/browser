import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/**
 * Nemo の lint 設定。
 *
 * - `src/**` の TypeScript は**型情報つき**で見る
 *   （`no-floating-promises` は型が無いと効かない。拡張のロード失敗や
 *   ナビゲーション拒否を握りつぶす経路がここで見つかる）
 * - `scripts/**` と `src/shared/**.js` は素の Node スクリプトなので型情報を使わない
 */
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'extensions/**',
      '.ext-cache/**',
      'node_modules/**',
      'test-pages/**',
      '*.tsbuildinfo'
    ]
  },

  js.configs.recommended,

  /* ---- src の TypeScript（型情報つき） ---- */
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Electron の型は any が混ざるので、実害の少ないものだけ緩める
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // electron-chrome-extensions の impl は async シグネチャを要求するので、
      // 中身に await が無くても async のままにする必要がある
      '@typescript-eslint/require-await': 'off'
    }
  },

  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },

  /* ---- 検証スクリプトと shared の素の JS ---- */
  {
    files: ['scripts/**/*.mjs', 'src/shared/**/*.js', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },

  {
    // CI 用テスト拡張。ブラウザ + WebExtension の環境で動く素の JS
    files: ['test-extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions }
    }
  },

  prettier
)
