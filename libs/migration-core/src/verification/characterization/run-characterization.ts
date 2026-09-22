import { checkEligibility } from './eligibility.js';
import { generateBoundaryValueRows } from './boundary-values.js';
import { runInSandbox } from './sandbox-run.js';
import { outcomesMatch } from './diff.js';
import type { CharacterizationResult, CharacterizationTarget } from '../types.js';

function dedupeRows(rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();
  for (const row of rows) seen.set(JSON.stringify(row), row);
  return [...seen.values()];
}

/**
 * Stage 4 clause 3 (docs/product-spec.md §6.5): the characterization-test
 * branch, taken only when clause 2 (run-verification-gate.ts) found no
 * migrated spec to run.
 *
 * Ineligibility resolves this function's own result to
 * `{ eligible: false }`; it is `run-verification-gate.ts` (Task 9), not
 * this function, that turns that into a REJECTED tier — this function
 * stays a pure decision, not a tiering policy.
 */
export function runCharacterization(target: CharacterizationTarget): CharacterizationResult {
  const eligibility = checkEligibility(target.originalFunctionSource);
  if (!eligibility.eligible) return { eligible: false, reason: eligibility.reason };

  const inferredTypesExist = (target.parameterTypes ?? []).some((t) => t !== undefined);
  if (target.callSiteArgLiterals.length < 2 && !inferredTypesExist) {
    return {
      eligible: false,
      reason: 'fewer than two distinct call-site examples and no inferable parameter types (§6.5)',
    };
  }

  const boundaryRows = target.parameterTypes ? generateBoundaryValueRows(target.parameterTypes) : [];
  const inputs = dedupeRows([...target.callSiteArgLiterals, ...boundaryRows]);

  for (const input of inputs) {
    const originalOutcome = runInSandbox(target.originalFunctionSource, input);
    const migratedOutcome = runInSandbox(target.migratedFunctionSource, input);
    if (!outcomesMatch(originalOutcome, migratedOutcome)) {
      return {
        eligible: true,
        matched: false,
        mismatch: { input, original: originalOutcome, migrated: migratedOutcome },
      };
    }
  }

  return { eligible: true, matched: true, casesRun: inputs.length };
}
