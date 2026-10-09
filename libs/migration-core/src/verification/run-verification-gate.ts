import { runCompileCheck } from './check-compiles.js';
import { runExistingTestSuite } from './run-existing-tests.js';
import { runCharacterization } from './characterization/run-characterization.js';
import type { VerificationEvidence, VerificationInput, VerificationResult } from './types.js';

/**
 * The tiering policy, and the only place it lives (docs/product-spec.md
 * §6.5, docs/decisions.md ADR-059/060). Pure: every caller — the
 * single-patch gate below, or a pipeline that compiles once for many
 * files — reaches a tier through this function.
 *
 * - compile failed, supplied spec failed, or characterization diff
 *   mismatched → REJECTED, with which check failed.
 * - compiled, characterization matched → MEDIUM.
 * - compiled, nothing could verify behaviour → LOW. Never MEDIUM by
 *   default, never REJECTED for lack of evidence.
 */
export function decideTier(evidence: VerificationEvidence): VerificationResult {
  const { artifactType, compile, tests, characterization } = evidence;
  const compileLog = compile.log;

  if (!compile.passed) {
    const reason =
      compile.failure === 'diagnostics'
        ? `Angular compiler reported ${compile.diagnostics.length} error(s)`
        : 'Angular compiler could not run to completion';
    return { tier: 'REJECTED', artifactType, failedCheck: 'compile', reason, compileLog };
  }

  const testLog = tests?.log;
  if (tests && !tests.passed) {
    return { tier: 'REJECTED', artifactType, failedCheck: 'tests', reason: 'supplied spec failed', compileLog, testLog };
  }

  if (!characterization) {
    return { tier: 'LOW', artifactType, reason: 'no characterization target', compileLog, testLog };
  }
  if (!characterization.eligible) {
    return {
      tier: 'LOW',
      artifactType,
      reason: `characterization ineligible: ${characterization.reason}`,
      compileLog,
      testLog,
    };
  }
  if (!characterization.matched) {
    return {
      tier: 'REJECTED',
      artifactType,
      failedCheck: 'characterization',
      reason: 'characterization diff mismatch',
      compileLog,
      characterization,
    };
  }
  return { tier: 'MEDIUM', artifactType, compileLog, testLog, characterization };
}

/**
 * Stage 4 for one patch already applied to `workspaceDir`: gathers the
 * evidence in order — compile, then the supplied spec if any, then
 * characterization — stopping at the first hard failure, and hands it
 * to `decideTier`.
 */
export async function runVerificationGate(input: VerificationInput): Promise<VerificationResult> {
  const { artifactType } = input;
  const compile = await runCompileCheck(input.workspaceDir, input.appTsConfigPath);
  if (!compile.passed) return decideTier({ artifactType, compile });

  const tests = input.migratedSpecPath
    ? await runExistingTestSuite(input.workspaceDir, input.migratedSpecPath)
    : undefined;
  if (tests && !tests.passed) return decideTier({ artifactType, compile, tests });

  const characterization = input.characterization ? runCharacterization(input.characterization) : undefined;
  return decideTier({ artifactType, compile, tests, characterization });
}
