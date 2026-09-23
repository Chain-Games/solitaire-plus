import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '.claude/**',
      '**/*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // QA tooling: Node scripts whose page-side functions run in the browser (page.evaluate).
    files: ['tools/capture/**/*.mjs', 'tools/parity/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'process',
          'console',
          'fetch',
          'URL',
          'AbortSignal',
          'Buffer',
          'setTimeout',
          'window',
          'document',
          'location',
          'getComputedStyle',
          'requestAnimationFrame',
          'scrollX',
          'scrollY',
        ].map((g) => [g, 'readonly']),
      ),
    },
  },
);
