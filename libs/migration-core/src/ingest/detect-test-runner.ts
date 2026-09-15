import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { karmaConfigUsesPhantomJs, remediateKarmaConfig } from './karma-config.js';
import { pathExists } from './path-exists.js';
import type { TestRunnerDetection } from './types.js';

const CONFIG_CANDIDATES = ['karma.conf.js', 'test/karma.conf.js', 'karma.conf.ci.js'];

/**
 * Detects a Karma config and, if its `browsers` array references
 * PhantomJS, generates the remediated version. See karma-config.ts for
 * exactly what "detects" and "generates" do and don't prove — this is
 * static analysis, not execution.
 */
export async function detectTestRunner(repoRoot: string): Promise<TestRunnerDetection> {
  for (const relativePath of CONFIG_CANDIDATES) {
    const configPath = join(repoRoot, relativePath);
    if (!(await pathExists(configPath))) continue;

    const content = await readFile(configPath, 'utf8');
    const usesPhantomJs = karmaConfigUsesPhantomJs(content);

    return {
      tool: 'karma',
      configPath,
      usesPhantomJs,
      ...(usesPhantomJs ? { remediatedConfig: remediateKarmaConfig(content).remediated } : {}),
    };
  }

  return { tool: 'none', usesPhantomJs: false };
}
