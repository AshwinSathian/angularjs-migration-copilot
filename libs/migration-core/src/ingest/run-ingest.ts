import { detectAngularVersion } from './detect-angular-version.js';
import { detectBuildTooling } from './detect-build-tooling.js';
import { detectTestRunner } from './detect-test-runner.js';
import { scanRepoForSecrets } from './scan-repo-for-secrets.js';
import type { IngestReport } from './types.js';

/**
 * Stage 0 — ingest. Detects what's in the repo; makes no changes to it.
 * See docs/product-spec.md §6.1 and docs/milestones/m0-inventory.md.
 */
export async function runIngest(repoRoot: string): Promise<IngestReport> {
  const [angularVersion, buildTool, testRunner, secretsFound] = await Promise.all([
    detectAngularVersion(repoRoot),
    detectBuildTooling(repoRoot),
    detectTestRunner(repoRoot),
    scanRepoForSecrets(repoRoot),
  ]);

  return { angularVersion, buildTool, testRunner, secretsFound };
}
