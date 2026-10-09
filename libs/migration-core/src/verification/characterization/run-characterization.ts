import { checkEligibility } from './eligibility.js';
import { generateBoundaryValueRows } from './boundary-values.js';
import { runInSandbox } from './sandbox-run.js';
import { outcomeKey, UncomparableValueError } from './diff.js';
import type { CharacterizationResult, CharacterizationTarget, SandboxOutcome } from '../types.js';

function dedupeRows(rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();
  for (const row of rows) seen.set(JSON.stringify(row), row);
  return [...seen.values()];
}

/** `outcomeKey`, or the reason this outcome can't be compared at all. */
function comparable(side: string, outcome: SandboxOutcome): { readonly key: string } | { readonly reason: string } {
  if (outcome.type === 'unrunnable') return { reason: `${side} function could not run standalone (${outcome.message})` };
  try {
    return { key: outcomeKey(outcome) };
  } catch (error) {
    if (!(error instanceof UncomparableValueError)) throw error;
    return { reason: `${side} function returned ${error.message}, which cannot be compared structurally` };
  }
}

/**
 * Stage 4 clause 3 (docs/product-spec.md §6.5): golden-master diff of
 * the original function against the migrated one.
 *
 * `eligible: false` means "this pair cannot be verified this way", and
 * the gate tiers it LOW. Besides the static check on the original, that
 * covers everything that would make a "match" meaningless (ADR-057):
 * either side unrunnable in isolation, a return value with no faithful
 * structural form (a function, a promise, a class instance), the
 * original disagreeing with itself across two runs, or no input on
 * which the original returned rather than threw.
 *
 * `matched: false` is reserved for a real behavioural difference on a
 * comparable input — the only result here the gate turns into REJECTED.
 */
export function runCharacterization(target: CharacterizationTarget): CharacterizationResult {
  const eligibility = checkEligibility(target.originalFunctionSource);
  if (!eligibility.eligible) return { eligible: false, reason: eligibility.reason };

  const inferredTypesExist = (target.parameterTypes ?? []).some((t) => t !== undefined);
  if (dedupeRows(target.callSiteArgLiterals).length < 2 && !inferredTypesExist) {
    return {
      eligible: false,
      reason: 'fewer than two distinct call-site examples and no inferable parameter types (§6.5)',
    };
  }

  const boundaryRows = target.parameterTypes ? generateBoundaryValueRows(target.parameterTypes) : [];
  const inputs = dedupeRows([...target.callSiteArgLiterals, ...boundaryRows]);

  let returned = 0;
  for (const input of inputs) {
    const originalOutcome = runInSandbox(target.originalFunctionSource, input);
    const original = comparable('original', originalOutcome);
    if ('reason' in original) return { eligible: false, reason: original.reason };
    // Backstop only: eligibility already rejects every non-deterministic source it can see, so no test can
    // reach this today (a mutation removing it survives the suite). It exists for the day eligibility loosens.
    const rerun = comparable('original', runInSandbox(target.originalFunctionSource, input));
    if (!('key' in rerun) || rerun.key !== original.key) {
      return { eligible: false, reason: 'original function is non-deterministic — two runs on the same input disagree' };
    }

    const migratedOutcome = runInSandbox(target.migratedFunctionSource, input);
    const migrated = comparable('migrated', migratedOutcome);
    if ('reason' in migrated) return { eligible: false, reason: migrated.reason };

    if (original.key !== migrated.key) {
      return { eligible: true, matched: false, mismatch: { input, original: originalOutcome, migrated: migratedOutcome } };
    }
    if (originalOutcome.type === 'return') returned += 1;
  }

  if (returned === 0) {
    return { eligible: false, reason: 'original function threw on every generated input — no return value to compare' };
  }
  return { eligible: true, matched: true, casesRun: inputs.length };
}
