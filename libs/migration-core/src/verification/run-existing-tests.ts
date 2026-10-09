import { runCommand } from '../scaffold/index.js';
import type { TestSuiteCheckResult } from './types.js';

/**
 * Runs the one migrated spec file — via `ng test --include`, not the
 * whole workspace's suite — inside a real M0.5-scaffolded workspace.
 * Stage 4 clause 2 (docs/product-spec.md §6.5) — an extra hard gate only;
 * a pass does not raise the tier (ADR-060). `--include` accepts a
 * bare file path (not just a glob), confirmed against a real scaffolded
 * workspace. `--watch=false` is required: `ng test`'s own default is
 * `true` in a TTY, which would hang this call forever.
 *
 * Confirmed the real exit code on failure by direct execution (initial
 * probe piped through `tail` and silently observed `tail`'s own exit
 * code instead — re-run without the pipe): a failing spec exits `1`,
 * not `0`, so a plain non-zero check is correct here. A path matching no
 * spec also exits `1` ("No tests found"), so a typo fails closed.
 */
export async function runExistingTestSuite(
  workspaceDir: string,
  specPath: string
): Promise<TestSuiteCheckResult> {
  const result = await runCommand(
    'npx',
    ['ng', 'test', '--watch=false', '--include', specPath],
    { cwd: workspaceDir }
  );
  return {
    passed: result.exitCode === 0,
    log: `${result.stdout}${result.stderr}`,
  };
}
