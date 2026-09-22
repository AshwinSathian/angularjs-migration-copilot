import { runCompileCheck } from './check-compiles.js';
import { runExistingTestSuite } from './run-existing-tests.js';
import { runCharacterization } from './characterization/run-characterization.js';
import type { VerificationInput, VerificationResult } from './types.js';

/**
 * Stage 4 (docs/product-spec.md §6.5): clears in order — (1) compile,
 * (2) the migrated spec if one was supplied, (3) characterization
 * testing otherwise. A hard fail at (1) or (2) is an immediate REJECTED;
 * neither later clause runs once an earlier one has failed.
 *
 * **Design decision made in this plan, not lifted verbatim from the
 * spec text — flagged for the user's line-by-line review**: when
 * neither a migrated spec nor a characterization target is available at
 * all (or the one given is ineligible), this resolves to REJECTED, not
 * a silent pass. Grounded in §6.5's own stated principle ("never accept
 * an AI-generated change without independent verification") — a patch
 * with zero verification evidence available can't be accepted by that
 * principle's own logic, but this is this plan's inference from that
 * principle, not something §6.5 states in those exact words.
 */
export async function runVerificationGate(input: VerificationInput): Promise<VerificationResult> {
  const compile = await runCompileCheck(input.workspaceDir, input.appTsConfigPath);
  if (!compile.passed) {
    return { tier: 'REJECTED', artifactType: input.artifactType, reason: 'tsc --noEmit failed', compileLog: compile.log };
  }

  if (input.migratedSpecPath) {
    const testResult = await runExistingTestSuite(input.workspaceDir, input.migratedSpecPath);
    if (!testResult.passed) {
      return {
        tier: 'REJECTED',
        artifactType: input.artifactType,
        reason: 'existing migrated test suite failed',
        compileLog: compile.log,
        testLog: testResult.log,
      };
    }
    return { tier: 'HIGH', artifactType: input.artifactType, compileLog: compile.log, testLog: testResult.log };
  }

  if (!input.characterization) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: 'no migrated spec and no characterization target — nothing to verify against',
      compileLog: compile.log,
    };
  }

  const characterization = runCharacterization(input.characterization);
  if (!characterization.eligible) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: `characterization ineligible: ${characterization.reason}`,
      compileLog: compile.log,
      characterization,
    };
  }
  if (!characterization.matched) {
    return {
      tier: 'REJECTED',
      artifactType: input.artifactType,
      reason: 'characterization diff mismatch',
      compileLog: compile.log,
      characterization,
    };
  }

  return { tier: 'MEDIUM', artifactType: input.artifactType, compileLog: compile.log, characterization };
}
