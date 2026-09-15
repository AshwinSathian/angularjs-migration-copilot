import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestRunnerDetection } from './types.js';

const CONFIG_CANDIDATES = ['karma.conf.js', 'test/karma.conf.js', 'karma.conf.ci.js'];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects a Karma config and flags whether it references PhantomJS —
 * unmaintained since 2018 and the most common reason a legacy AngularJS
 * test suite fails outright on a current Node version. This is static
 * detection only: it doesn't run the suite, so it can say "this config
 * looks like it'll fail," never "this suite passes." Actually running it
 * is Stage 4's job — see docs/milestones/m2-verification.md.
 */
export async function detectTestRunner(repoRoot: string): Promise<TestRunnerDetection> {
  for (const relativePath of CONFIG_CANDIDATES) {
    const configPath = join(repoRoot, relativePath);
    if (!(await exists(configPath))) continue;

    const content = await readFile(configPath, 'utf8');
    return {
      tool: 'karma',
      configPath,
      usesPhantomJs: /PhantomJS/.test(content),
    };
  }

  return { tool: 'none', usesPhantomJs: false };
}
