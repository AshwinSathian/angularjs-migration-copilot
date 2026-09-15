import { runCommand } from './run-command.js';
import { commandSucceeded } from './types.js';
import type { BuildVerificationResult } from './types.js';

/**
 * Runs `ng build` inside an already-scaffolded workspace and reports its
 * real exit code. This is the check `docs/milestones/m0.5-scaffold.md`'s
 * definition of done requires — a generated workspace's build is confirmed
 * by actually running it, not assumed from `scaffoldTargetWorkspace`'s own
 * exit code.
 */
export async function verifyWorkspaceBuilds(workspaceDir: string): Promise<BuildVerificationResult> {
  const result = await runCommand('npx', ['ng', 'build'], { cwd: workspaceDir });
  return { ...result, success: commandSucceeded(result) };
}
