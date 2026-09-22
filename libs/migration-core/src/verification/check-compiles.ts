import { runCommand } from '../scaffold/index.js';
import type { CompileCheckResult } from './types.js';

const DEFAULT_APP_TSCONFIG = 'tsconfig.app.json';

/**
 * Runs `tsc -p <appTsConfigPath> --noEmit` inside `workspaceDir` — a
 * real, M0.5-scaffolded Angular workspace, never the source repo. This
 * is Stage 4 clause 1 (docs/product-spec.md §6.5): a hard fail here is
 * an immediate REJECTED, no need to run clauses 2/3.
 *
 * Deliberately `tsc`, not `ng build`: §6.5 names `tsc --noEmit`
 * specifically, distinct from M0.5's own `ng build`-based
 * `verifyWorkspaceBuilds` (which confirms the *whole scaffolded
 * workspace* builds once, at scaffold time) — this check runs once per
 * migrated file/patch, and `tsc --noEmit` is faster than a full build
 * while still exercising real Angular decorator/template type-checking
 * via `tsconfig.app.json`'s `angularCompilerOptions` — confirmed by
 * actually running it against a real scaffolded workspace, both clean
 * (exit 0) and with an injected type error (exit 2, diagnostic on
 * stdout).
 */
export async function runCompileCheck(
  workspaceDir: string,
  appTsConfigPath: string = DEFAULT_APP_TSCONFIG
): Promise<CompileCheckResult> {
  const result = await runCommand('npx', ['tsc', '-p', appTsConfigPath, '--noEmit'], { cwd: workspaceDir });
  return {
    passed: result.exitCode === 0,
    log: `${result.stdout}${result.stderr}`,
  };
}
