import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the negative-control integration spec
 * (verification/__fixtures__/negative-controls/negative-controls.integration.spec.ts).
 *
 * Needed because Vitest applies `include`/`exclude` even to an explicitly
 * named file on the CLI — there is no CLI flag that overrides a config's
 * `exclude`, and the fixture lives outside `{src,tests}` (vitest.config.mts's
 * `include` root) precisely so the default fast suite never walks into it.
 * A single shared config therefore can't both keep the default suite fast
 * (vitest.config.mts's job) and make this one file explicitly runnable
 * (this config's job) — hence the split, not a bigger workspace/projects
 * setup this repo doesn't otherwise need.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/migration-core',
  test: {
    name: 'migration-core-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['verification/**/*.integration.spec.ts'],
    reporters: ['default'],
  },
}));
