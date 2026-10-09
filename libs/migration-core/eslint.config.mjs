import baseConfig, { frameworkFreeLib } from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  frameworkFreeLib,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    // Planted, deliberately-broken gate controls — not project source.
    ignores: ['**/out-tsc', 'verification/__fixtures__/**/0*/**'],
  },
];
